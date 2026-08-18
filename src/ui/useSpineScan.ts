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
import { SpineTracker } from '../lib/spine/tracker'
import { columnText, spineRawText, spinesFromRecognition } from '../lib/spine/parse'
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

    /**
     * 1冊ぶんを一覧へ渡す。
     *
     * 短冊を読むたびに呼ぶので、行は1冊ずつ増える。重複抑止（同じ背表紙を
     * 別のコマから読んだ場合）はここで通す。突き合わせる相手は
     * 「直近に読んだ何冊か」で、時間では切らない(lib/spine/tracker.ts の冒頭)。
     */
    const emit = (spine: ExtractedSpine, crop: CroppedImage | null): void => {
      const key = spineRawText(spine)
      const same = tracker.findSame(key)
      const entryId = onSpineRef.current(spine, crop, same?.entryId)
      if (entryId) tracker.note(entryId, key, frame.at)
    }

    const queued = queue.push(async () => {
      const startedAt = Date.now()
      const diagnosticId = spineDiagnostics.begin(frame)
      spineDiagnostics.update(diagnosticId, { bands: frame.bands, preview: frame.blob })
      let produced = 0

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
            produced++
            // 確認用は短冊そのもの。短冊1本が背表紙1冊にあたる
            emit(spine, strip.preview)
          }
        }
      }

      /*
       * ── 退避: コマ全体を読む ───────────────────────────
       * 短冊に切れなかった構図（棚を大きく外した、1冊だけ大写し）と、
       * 切れてはいたが1本も読めなかった場合の受け皿。
       * 極性の混在には弱いが、以前はこれだけで動いていた経路なので残す。
       */
      if (produced === 0) {
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
            produced++
            emit(spine, crops[i] ?? null)
          }
        }
      }

      spineDiagnostics.update(diagnosticId, { spines: produced, ms: Date.now() - startedAt })
      if (produced === 0) setUnreadable((n) => n + 1)
    })

    return queued ? 'queued' : 'busy'
  }, [])

  return {
    // busy は ref ではなく state から導く。ref を描画で読んでも再描画されない
    state: { preparing, ready, error, pending, busy: pending >= OCR_QUEUE_CAPACITY, unreadable },
    capture,
  }
}
