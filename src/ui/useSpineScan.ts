import { useCallback, useEffect, useRef, useState } from 'react'
import type { ExtractedSpine } from '../types'
import { SerialQueue } from '../lib/spine/queue'
import { SpineTracker } from '../lib/spine/tracker'
import { spineFromRecognition } from '../lib/spine/parse'
import { createTesseractRecognizer } from '../lib/spine/tesseract'
import { SpineRecognizerUnavailableError, type SpineRecognizer } from '../lib/spine/recognizer'

/** レーンから切り出した背表紙1枚 */
export interface SpineCrop {
  blob: Blob
  /** 見た目の簡易ハッシュ。連続コマ由来の重複を弾くのに使う */
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
 * 溢れたら「少しゆっくり動かしてください」と伝える。無制限に溜めると
 * 端末の記憶域を食い潰すうえ、カメラを閉じてから何分も処理が続く。
 */
const OCR_QUEUE_CAPACITY = 8

export interface SpineScanState {
  /** wasm と言語モデルを取りに行っている */
  preparing: boolean
  /** OCR を受け付けられる */
  ready: boolean
  /** OCR が使えない理由。ある場合は読み取りを続けても意味がない */
  error: string | null
  /** OCR 待ちの件数 */
  pending: number
  /** 待ち行列が満杯 */
  busy: boolean
  /** 文字が取れなかった枚数 */
  unreadable: number
}

export interface UseSpineScanOptions {
  /** カメラが動いているあいだ true。false になっても待ち行列は捌き切る */
  active: boolean
  /**
   * 1冊ぶん読めたときに呼ばれる。
   *
   * `sameAs` が入っているときは、直前に読んだのと同じ背表紙である。
   * 呼び出し側は新しい行を作らず、その行に足すこと。
   * 戻り値には、実際に使った行のID を返す(追跡に使う)。
   */
  onSpine: (spine: ExtractedSpine, crop: SpineCrop, sameAs?: string) => string | null
}

/** 追跡に使う文字列。読めた行を全部つないだもの */
function textKeyOf(spine: ExtractedSpine): string {
  const lines = spine.fragments?.map((f) => f.text) ?? [spine.title, ...spine.authors]
  return lines.join(' ')
}

/**
 * 背表紙の読み取り(OCR)を回す。
 *
 * カメラ画面(SpineScanner)からは切り離してある。カメラを閉じた時点で
 * Worker ごと落としてしまうと、待ち行列に残った本が消える。
 * ここは画面の外に置き、待ち行列を捌き終えてから Worker を破棄する。
 */
export function useSpineScan({ active, onSpine }: UseSpineScanOptions): {
  state: SpineScanState
  capture: (crop: SpineCrop) => CaptureOutcome
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

  const capture = useCallback((crop: SpineCrop): CaptureOutcome => {
    const queue = queueRef.current
    const recognizer = recognizerRef.current
    if (!queue || !recognizer) return 'unavailable'

    const tracker = trackerRef.current
    // OCR にかける前の重複抑止。同じ背表紙をレーンに置き続けても1回で済む
    if (!tracker.shouldCapture(crop.hash, crop.at)) return 'duplicate'
    if (queue.isFull) return 'busy'
    tracker.noteCapture(crop.hash, crop.at)

    const queued = queue.push(async () => {
      let spine: ExtractedSpine | null = null
      try {
        spine = spineFromRecognition(await recognizer.recognize(crop.blob))
      } catch (err) {
        // 1枚の失敗を他の本へ波及させない。使えない状態なら理由を出す
        if (err instanceof SpineRecognizerUnavailableError) setError(err.message)
        return
      }

      if (!spine) {
        setUnreadable((n) => n + 1)
        return
      }

      const key = textKeyOf(spine)
      /*
       * OCR 後の重複抑止。文字列が十分似ていれば同じ背表紙の複数観測とみなす。
       * 突き合わせる相手は「直近に読んだ何冊か」で、時間では切らない
       * (理由は lib/spine/tracker.ts の冒頭)。記録には取り込んだ時刻を渡す。
       */
      const same = tracker.findSame(key)
      const entryId = onSpineRef.current(spine, crop, same?.entryId)
      if (entryId) tracker.note(entryId, key, crop.at)
    })

    return queued ? 'queued' : 'busy'
  }, [])

  return {
    // busy は ref ではなく state から導く。ref を描画で読んでも再描画されない
    state: { preparing, ready, error, pending, busy: pending >= OCR_QUEUE_CAPACITY, unreadable },
    capture,
  }
}
