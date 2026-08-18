import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtractedSpine } from '../types'
import {
  cropBoxes,
  cropStrips,
  type CroppedImage,
  type FrameQuality,
  type SpineStrip,
} from '../lib/spine/capture'
import { spineDiagnostics } from '../lib/spine/diagnostics'
import { SerialQueue } from '../lib/spine/queue'
import { toFrameColumns, type SpineBand } from '../lib/spine/segment'
import { SpineTracker, type SpineSite } from '../lib/spine/tracker'
import { columnText, spineRawText, spinesFromRecognition, worthNewEntry } from '../lib/spine/parse'
import { createTesseractRecognizer } from '../lib/spine/tesseract'
import { SpineRecognizerUnavailableError, type SpineRecognizer } from '../lib/spine/recognizer'

/** 取り込んだコマ1枚。棚一段ぶんの背表紙が写っている */
export interface FrameCapture {
  blob: Blob
  /** 見た目の簡易ハッシュ。同じ構図を何度も読み直さないために使う */
  hash: string
  width: number
  height: number
  /** 取り込んだ時刻 (ms) */
  at: number
  /**
   * 背表紙ごとの短冊（0..1 の x 範囲）。
   *
   * 取り込んだ時点で求めておく。ここで求めるのは、原寸の ImageData が
   * まだ手元にあるからで、あとから Blob を復号し直すのは無駄が大きい。
   */
  bands: SpineBand[]
  /** 取り込んだときの品質。診断でしか使わない */
  quality?: FrameQuality
}

/** 取り込みの結果。スキャナ側の状態表示に使う */
export type CaptureOutcome = 'queued' | 'duplicate' | 'busy' | 'unavailable'

/**
 * OCR の待ち行列の上限。
 *
 * 1枚に棚一段ぶんが写っており、読み取りは端末によって数秒から十数秒かかる。
 * 溜め込むと、カメラを閉じてから何分も処理が続くことになる。
 * 溢れたら「少し待ってください」と伝える。
 */
const OCR_QUEUE_CAPACITY = 3

/**
 * 短冊で読むために必要な本数。
 *
 * 1本しか取れなかったコマは、背表紙の境界が写っていない（棚を大きく外した、
 * 1冊だけ大写しになっている）ということなので、コマ全体の読み取りへ退避する。
 */
const MIN_STRIPS = 2

export interface SpineScanState {
  /** wasm と言語モデルを取りに行っている */
  preparing: boolean
  /** OCR を受け付けられる */
  ready: boolean
  /** OCR が使えない理由。ある場合は読み取りを続けても意味がない */
  error: string | null
  /** OCR 待ちのコマ数 */
  pending: number
  /** 待ち行列が満杯 */
  busy: boolean
  /** 背表紙を1本も取れなかったコマの数 */
  unreadable: number
}

export interface UseSpineScanOptions {
  /** カメラが動いているあいだ true。false になっても待ち行列は捌き切る */
  active: boolean
  /**
   * 背表紙を1冊読めたときに呼ばれる。1枚のコマから何度も呼ばれる。
   *
   * `sameAs` が入っているときは、直前に読んだのと同じ背表紙である。
   * 呼び出し側は新しい行を作らず、その行に足すこと。
   * 戻り値には、実際に使った行のID を返す(追跡に使う)。
   */
  onSpine: (spine: ExtractedSpine, crop: CroppedImage | null, sameAs?: string) => string | null
}

/**
 * 背表紙の読み取り(OCR)を回す。
 *
 * ── 短冊1本ずつ読み、読めた端から一覧へ出す ─────────────
 * 以前はコマ1枚をまるごと OCR にかけ、読み終えてから 20〜30冊ぶんを
 * 一度に渡していた。**最初の1冊が出るまで十数秒**かかり、そのあいだ
 * 画面は無言だったので、利用者には壊れているのと区別がつかなかった。
 *
 * いまは背表紙ごとの短冊に切り、1本読むごとに `onSpine` を呼ぶ。
 * 総時間は変わらないが、1冊目は 1 秒足らずで出る。
 *
 * カメラ画面(SpineScanner)からは切り離してある。カメラを閉じた時点で
 * Worker ごと落としてしまうと、待ち行列に残ったコマが消える。
 * ここは画面の外に置き、待ち行列を捌き終えてから Worker を破棄する。
 */
export function useSpineScan({ active, onSpine }: UseSpineScanOptions): {
  state: SpineScanState
  capture: (frame: FrameCapture) => CaptureOutcome
} {
  const [preparing, setPreparing] = useState(false)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(0)
  const [unreadable, setUnreadable] = useState(0)

  const recognizerRef = useRef<SpineRecognizer | null>(null)
  const queueRef = useRef<SerialQueue | null>(null)
  const trackerRef = useRef<SpineTracker>(new SpineTracker())
  /** 取り込んだコマの通し番号。同じコマの中の短冊どうしを束ねないために要る */
  const frameSeqRef = useRef(0)

  /**
   * 走査ループから見た最新の onSpine。
   * 1冊読むたびに一覧が伸びて関数が作り直されるので、これを効果の依存に
   * 入れるとカメラと OCR が開き直される(BarcodeScanner と同じ理由)。
   */
  const onSpineRef = useRef(onSpine)
  useEffect(() => {
    onSpineRef.current = onSpine
  })

  useEffect(() => {
    if (!active) return

    const recognizer = createTesseractRecognizer()
    const queue = new SerialQueue({
      capacity: OCR_QUEUE_CAPACITY,
      onChange: (n) => setPending(n),
    })
    recognizerRef.current = recognizer
    queueRef.current = queue
    trackerRef.current = new SpineTracker()

    let cancelled = false
    setPreparing(true)
    setError(null)
    setUnreadable(0)

    // カメラの許可取得と並行して走らせる。どちらも待たされる処理なので、
    // 直列にすると「カメラは映っているのに読み取らない」時間が伸びる
    recognizer
      .prepare()
      .then(() => {
        if (cancelled) return
        setReady(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        setError(
          err instanceof SpineRecognizerUnavailableError
            ? err.message
            : '文字の読み取り機能を読み込めませんでした。ネットワークの状態を確認して、もう一度お試しください。',
        )
      })
      .finally(() => {
        if (!cancelled) setPreparing(false)
      })

    return () => {
      cancelled = true
      // 新しい取り込みは受け付けない。ただし積んであるぶんは最後まで読む
      recognizerRef.current = null
      queueRef.current = null
      setReady(false)
      void queue.whenIdle().then(() => recognizer.dispose())
    }
  }, [active])

  const capture = useCallback((frame: FrameCapture): CaptureOutcome => {
    const queue = queueRef.current
    const recognizer = recognizerRef.current
    if (!queue || !recognizer) return 'unavailable'

    const tracker = trackerRef.current
    // 同じ構図を撮り続けても、読み直しは1回で済ませる
    if (!tracker.shouldCapture(frame.hash, frame.at)) return 'duplicate'
    if (queue.isFull) return 'busy'
    tracker.noteCapture(frame.hash, frame.at)

    /*
     * このコマの身元。棚の世代は取り込んだ順に決まるので、ここ(同期側)で
     * 確定させる。待ち行列の中で決めると、処理の順に引きずられる。
     */
    const shelf = tracker.shelfFor(frame.hash)
    const frameId = ++frameSeqRef.current

    /**
     * 1冊ぶんを一覧へ渡す。読めたら true。
     *
     * 短冊を読むたびに呼ぶので、行は1冊ずつ増える。重複抑止はここで通す。
     * **位置(同じ棚・別のコマ・重なる短冊)を先に見る。** 文字列だけで
     * 束ねていたとき、読みが部分的だと同じ本が別の断片として何行にも
     * 増えた(lib/spine/tracker.ts の冒頭)。
     */
    const emit = (spine: ExtractedSpine, crop: CroppedImage | null, band?: SpineBand): boolean => {
      const key = spineRawText(spine)
      const site: SpineSite | undefined = band ? { band, frameId, shelf } : undefined
      const same = tracker.findSame(key, frame.at, site)

      /*
       * 読めた文字が短すぎるものは、それ自体では行にしない。
       *
       * 4文字に満たない読みは、当たっても確定させない決まりである(§4)。
       * 確定しえないものを行にすると、一覧は「部分的に読めた断片」で
       * 埋まる(実機で80件出た)。既にある行を補強するぶんには通す。
       * 短い書名の本を取り逃がしうるが、断片の山に紛れるよりは救いやすい。
       */
      if (!same && !worthNewEntry(key)) return false

      const entryId = onSpineRef.current(spine, crop, same?.entryId)
      if (entryId) tracker.note(entryId, key, frame.at, site)
      return true
    }

    const queued = queue.push(async () => {
      const startedAt = Date.now()
      const diagnosticId = spineDiagnostics.begin(frame)
      spineDiagnostics.update(diagnosticId, { bands: frame.bands, preview: frame.blob })
      let produced = 0
      /*
       * 読めた本数と、一覧へ出した本数は別に数える。短すぎる読みは
       * 行にしないが、**読めてはいる**ので、コマ全体への退避は起こさない。
       */
      let recognized = 0

      // ── 本筋: 背表紙ごとの短冊を1本ずつ読む ──────────────
      if (frame.bands.length >= MIN_STRIPS) {
        let strips: SpineStrip[] = []
        try {
          strips = await cropStrips(frame.blob, frame.bands)
        } catch {
          // 切り出せなければコマ全体へ退避する。読み取り自体は諦めない
        }

        for (const [index, strip] of strips.entries()) {
          const stripStartedAt = Date.now()
          let spines: ExtractedSpine[] = []
          let raw = ''
          try {
            const rec = await recognizer.recognizeColumn(strip.image, {
              width: strip.width,
              height: strip.height,
            })
            raw = rec.columns.map(columnText).join(' / ')
            // 短冊の中の位置を、コマ全体の位置へ直してから組み立てる
            spines = spinesFromRecognition({
              ...rec,
              columns: toFrameColumns(rec.columns, strip.band),
            })
          } catch (err) {
            if (err instanceof SpineRecognizerUnavailableError) {
              setError(err.message)
              return
            }
            // 1本の失敗を他の短冊へ波及させない
          }

          spineDiagnostics.addStrip(diagnosticId, {
            index,
            band: strip.band,
            text: raw,
            spines: spines.length,
            ms: Date.now() - stripStartedAt,
            image: strip.image,
          })

          for (const spine of spines) {
            recognized++
            // 確認用は短冊そのもの。短冊1本が背表紙1冊にあたる
            if (emit(spine, strip.preview, strip.band)) produced++
          }
        }
      }

      /*
       * ── 退避: コマ全体を読む ───────────────────────────
       * 短冊に切れなかった構図（棚を大きく外した、1冊だけ大写し）と、
       * 切れてはいたが1本も読めなかった場合の受け皿。
       * 極性の混在には弱いが、以前はこれだけで動いていた経路なので残す。
       */
      if (recognized === 0) {
        spineDiagnostics.update(diagnosticId, { mode: 'frame' })
        let spines: ExtractedSpine[] = []
        try {
          const rec = await recognizer.recognize(frame.blob, {
            width: frame.width,
            height: frame.height,
          })
          spines = spinesFromRecognition(rec)
        } catch (err) {
          if (err instanceof SpineRecognizerUnavailableError) setError(err.message)
          spines = []
        }

        if (spines.length > 0) {
          // 確認用の画像を1冊ずつ切り出す。失敗しても一覧の作成は止めない
          let crops: (CroppedImage | null)[] = spines.map(() => null)
          try {
            crops = await cropBoxes(
              frame.blob,
              spines.map((s) => s.box),
            )
          } catch {
            /* 画像が無くても書名は出せる */
          }
          for (const [i, spine] of spines.entries()) {
            recognized++
            if (emit(spine, crops[i] ?? null)) produced++
          }
        }
      }

      spineDiagnostics.update(diagnosticId, { spines: produced, ms: Date.now() - startedAt })
      if (recognized === 0) setUnreadable((n) => n + 1)
    })

    return queued ? 'queued' : 'busy'
  }, [])

  return {
    // busy は ref ではなく state から導く。ref を描画で読んでも再描画されない
    state: { preparing, ready, error, pending, busy: pending >= OCR_QUEUE_CAPACITY, unreadable },
    capture,
  }
}
