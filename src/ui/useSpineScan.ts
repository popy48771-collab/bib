import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtractedSpine } from '../types'
import { cropBoxes, type CroppedImage } from '../lib/spine/capture'
import { SerialQueue } from '../lib/spine/queue'
import { SpineTracker } from '../lib/spine/tracker'
import { spineRawText, spinesFromRecognition } from '../lib/spine/parse'
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

    const queued = queue.push(async () => {
      let spines: ExtractedSpine[]
      try {
        const rec = await recognizer.recognize(frame.blob, {
          width: frame.width,
          height: frame.height,
        })
        spines = spinesFromRecognition(rec)
      } catch (err) {
        // 1枚の失敗を他のコマへ波及させない。使えない状態なら理由を出す
        if (err instanceof SpineRecognizerUnavailableError) setError(err.message)
        return
      }

      if (spines.length === 0) {
        setUnreadable((n) => n + 1)
        return
      }

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
        /*
         * OCR 後の重複抑止。文字列が十分似ていれば同じ背表紙の複数観測とみなす。
         * 突き合わせる相手は「直近に読んだ何冊か」で、時間では切らない
         * (理由は lib/spine/tracker.ts の冒頭)。記録には取り込んだ時刻を渡す。
         */
        const key = spineRawText(spine)
        const same = tracker.findSame(key)
        const entryId = onSpineRef.current(spine, crops[i] ?? null, same?.entryId)
        if (entryId) tracker.note(entryId, key, frame.at)
      }
    })

    return queued ? 'queued' : 'busy'
  }, [])

  return {
    // busy は ref ではなく state から導く。ref を描画で読んでも再描画されない
    state: { preparing, ready, error, pending, busy: pending >= OCR_QUEUE_CAPACITY, unreadable },
    capture,
  }
}
