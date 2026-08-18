import { useCallback, useEffect, useRef, useState } from 'react'
import { CameraUnavailableError, openRearCamera } from '../lib/barcode'
import {
  STILL_THRESHOLD,
  assessFrame,
  canvasToBlob,
  downscale,
  drawFrame,
  frameAdvice,
  frameDifference,
  isUsable,
  toGray,
  visualHash,
  type GrayImage,
} from '../lib/spine/capture'
import { Notice } from './Notice'
import type { CaptureOutcome, FrameCapture } from './useSpineScan'

/** 1冊ぶんの照合状況。スキャナはこれを表示するだけで、照合自体は関与しない */
export interface SpineResult {
  id: string
  /** 読めた書名(照合が通れば正式な書名に入れ替わる) */
  title: string
  state: 'looking' | 'found' | 'review' | 'missing'
}

interface Props {
  /** OCR の準備中か */
  preparing: boolean
  /** OCR が使えない理由 */
  ocrError: string | null
  /** OCR 待ちのコマ数 */
  ocrPending: number
  /** 書誌照合待ちの件数 */
  lookupPending: number
  /** OCR の待ち行列が満杯 */
  busy: boolean
  /** 背表紙を1本も取れなかったコマ数 */
  unreadable: number
  /** この読み取りで追加した本 */
  results: readonly SpineResult[]
  /** 一覧に登録済みの冊数 */
  registeredCount: number
  /** 棚を1枚取り込んだとき */
  onCapture: (frame: FrameCapture) => CaptureOutcome
  onClose: () => void
  onOpenLibrary: () => void
}

/** 監視の間隔。毎コマ調べても精度は上がらず、発熱するだけ */
const MONITOR_INTERVAL_MS = 250
/** 監視用に縮小する幅。品質判定と動きの検出はこの解像度で足りる */
const MONITOR_WIDTH = 96
/**
 * 取り込むまでに必要な「良いコマ」の連続数。
 *
 * 1枚に棚一段ぶんが写るので、撮り直しの費用が高い。ぶれていない状態が
 * 続いたことを確かめてから撮る。約 0.75 秒ぶん。
 */
const STABLE_TICKS = 3
/** 取り込んだ直後は待つ。同じ構図で続けて撮らないため */
const COOLDOWN_MS = 1200

/** 状態表示の文言 */
const RESULT_TEXT: Record<SpineResult['state'], string> = {
  looking: '書誌情報を取得しています',
  found: '書誌情報を取得しました',
  review: '候補を確認してください',
  missing: '書誌情報が見つかりませんでした',
}

/** 全体の品質判定に使う縮小画像。ラプラシアンを原寸で回すと重い */
function monitorGray(image: ImageData): GrayImage {
  const gray = toGray(image)
  const width = Math.min(160, gray.width)
  return downscale(gray, width, Math.round((gray.height * width) / gray.width))
}

/**
 * 本棚にかざして、棚の一段ぶんをまとめて読み取る。
 *
 * ── 1枚に棚一段 ─────────────────────────────────────
 * 以前は画面中央の細い帯(読取レーン)を通った本だけを取り込んでいたが、
 * 実測するとその帯には約5冊が入っており、混ざった画像を1冊として
 * OCR にかけていた。いまはフレーム全体を渡し、Tesseract のレイアウト解析に
 * 背表紙を1冊ずつの縦列へ分けさせている(lib/spine/capture.ts の冒頭)。
 *
 * そのため操作も変わる。棚に沿って流し続けるのではなく、
 * **棚の一段を枠に収めて少し止める** → 読み取る → 次の段へ、という流れになる。
 *
 * OCR はこの画面では持たない。カメラを閉じた時点で Worker ごと落ちると、
 * 待ち行列に残ったコマが消えてしまうため、呼び出し側(useSpineScan)に置く。
 *
 * 画面の並びは DESIGN_SYSTEM.md の順序に従う:
 * カメラ表示領域 → 現在の状態 → 主操作ボタン → 登録済み件数と一覧へのリンク。
 */
export function SpineScanner({
  preparing,
  ocrError,
  ocrPending,
  lookupPending,
  busy,
  unreadable,
  results,
  registeredCount,
  onCapture,
  onClose,
  onOpenLibrary,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const monitorRef = useRef<HTMLCanvasElement>(null)
  const frameRef = useRef<HTMLCanvasElement>(null)

  const [cameraError, setCameraError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [advice, setAdvice] = useState<string | null>(null)
  /** 直近の取り込み結果。一定時間で消す */
  const [lastOutcome, setLastOutcome] = useState<CaptureOutcome | null>(null)
  const [captured, setCaptured] = useState(0)
  const [attempt, setAttempt] = useState(0)

  /** 走査ループから見た最新の値。依存に入れるとカメラが開き直る */
  const liveRef = useRef({ onCapture, busy })
  useEffect(() => {
    liveRef.current = { onCapture, busy }
  })

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: GrayImage | null = null
    let stable = 0

    const schedule = (ms = MONITOR_INTERVAL_MS) => {
      if (!cancelled) timer = setTimeout(() => void tick(), ms)
    }

    /** 原寸のフレームを1枚切り出す */
    const grabFrame = async (
      video: HTMLVideoElement,
      canvas: HTMLCanvasElement,
    ): Promise<FrameCapture | null> => {
      const image = drawFrame(video, canvas)
      if (!image) return null
      const blob = await canvasToBlob(canvas)
      if (!blob) return null
      return {
        blob,
        hash: visualHash(monitorGray(image)),
        width: image.width,
        height: image.height,
        at: Date.now(),
      }
    }

    const tick = async () => {
      if (cancelled) return
      const video = videoRef.current
      const monitor = monitorRef.current
      const frame = frameRef.current
      if (!video || !monitor || !frame) return schedule()

      const image = drawFrame(video, monitor, MONITOR_WIDTH)
      if (!image) return schedule()

      const gray = toGray(image)
      const quality = assessFrame(gray)
      const moved = previous ? frameDifference(previous, gray) : 1
      previous = gray

      if (!isUsable(quality)) {
        stable = 0
        setAdvice(frameAdvice(quality))
        return schedule()
      }
      setAdvice(null)

      // 動いているあいだは撮らない。棚一段ぶんの撮り直しは高くつく
      if (moved > STILL_THRESHOLD) {
        stable = 0
        return schedule()
      }
      stable += 1
      if (stable < STABLE_TICKS) return schedule()

      // 読み取りが追いついていなければ、撮らずに待つ
      if (liveRef.current.busy) return schedule()

      const shot = await grabFrame(video, frame)
      if (cancelled) return
      if (!shot) return schedule()

      const outcome = liveRef.current.onCapture(shot)
      setLastOutcome(outcome)
      if (outcome === 'queued') setCaptured((n) => n + 1)

      stable = 0
      previous = null
      return schedule(COOLDOWN_MS)
    }

    const start = async () => {
      try {
        stream = await openRearCamera()
      } catch (err) {
        if (cancelled) return
        setCameraError(
          err instanceof CameraUnavailableError
            ? err.message
            : '背表紙の読み取りを開始できませんでした。ページを再読み込みして、もう一度お試しください。',
        )
        return
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      const video = videoRef.current
      if (!video) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      video.srcObject = stream
      try {
        await video.play()
      } catch {
        // 自動再生が拒否されても playsInline なら大抵は描画される。続行する
      }
      if (cancelled) return

      setReady(true)
      void tick()
    }

    void start()

    return () => {
      cancelled = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [attempt])

  // 取り込み結果の表示を一定時間で戻す
  useEffect(() => {
    if (!lastOutcome) return
    const t = setTimeout(() => setLastOutcome(null), 2200)
    return () => clearTimeout(t)
  }, [lastOutcome])

  const retry = useCallback(() => {
    setCameraError(null)
    setReady(false)
    setAttempt((n) => n + 1)
  }, [])

  const status = describeStatus({ ready, preparing, busy, ocrPending, advice, lastOutcome })
  const error = cameraError ?? ocrError

  return (
    <div className="stack">
      {/* 3. カメラ表示領域 */}
      <div className="scanner-view scanner-view--spine">
        <video ref={videoRef} playsInline muted autoPlay />
        {!error && ready && <div className="scanner-shelf" aria-hidden="true" />}
        {(!ready || error) && (
          <p className="scanner-placeholder">
            {error ? 'カメラを利用できません' : 'カメラを起動しています'}
          </p>
        )}
      </div>

      {/* 切り出し用。画面には出さないが、常に DOM に置いておく必要がある */}
      <canvas ref={monitorRef} className="visually-hidden" />
      <canvas ref={frameRef} className="visually-hidden" />

      {/* 4. 現在の状態 */}
      {error ? (
        <Notice kind="error" live="alert">
          {error}
        </Notice>
      ) : (
        <p className="scanner-status" data-kind={status.kind} role="status">
          <span className="scanner-status__label">{status.label}</span>
          {status.detail && <span className="scanner-status__detail">{status.detail}</span>}
        </p>
      )}

      {(captured > 0 || ocrPending > 0 || lookupPending > 0 || unreadable > 0) && (
        <ul className="status-line">
          <li>
            撮った枚数 <b>{captured}</b>
          </li>
          {ocrPending > 0 && (
            <li>
              文字の読み取り待ち <b>{ocrPending}</b> 枚
            </li>
          )}
          {lookupPending > 0 && (
            <li>
              書誌情報の取得待ち <b>{lookupPending}</b> 件
            </li>
          )}
          {unreadable > 0 && (
            <li>
              読み取れず <b>{unreadable}</b> 枚
            </li>
          )}
        </ul>
      )}

      {/* 5. 主操作ボタン */}
      <div className="actions">
        {cameraError ? (
          <>
            <button type="button" className="button button--primary" onClick={retry}>
              再読み取り
            </button>
            <button type="button" className="button button--secondary" onClick={onClose}>
              読み取りをやめる
            </button>
          </>
        ) : (
          <button type="button" className="button button--primary button--block" onClick={onClose}>
            読み取りを終える
          </button>
        )}
      </div>

      {/*
        読んだ端から書名が入っていく。ボタンを押さないと結果が出ないのでは
        「読めたのかどうか」が分からず、同じ棚を何度も撮ることになる
      */}
      {results.length > 0 && (
        <div>
          <h2 className="subheading">この読み取りで追加した本（{results.length} 件）</h2>
          <ul className="scan-feed">
            {results
              .slice(-8)
              .reverse()
              .map((r) => (
                <li key={r.id} data-state={r.state}>
                  <span className="scan-feed__title">{r.title}</span>
                  <span className="scan-feed__detail">{RESULT_TEXT[r.state]}</span>
                </li>
              ))}
            {results.length > 8 && <li>ほか {results.length - 8} 件</li>}
          </ul>
        </div>
      )}

      <p className="note">
        カメラを横向きにして、<b>棚の一段が枠いっぱいに収まる距離</b>で構え、少し止めてください。
        1枚から20〜30冊まとめて読み取ります。読み取りが終わったら、次の段へ移してください。
      </p>

      {/* 6. 登録済み件数と一覧へのリンク */}
      <p className="note">
        登録済み: {registeredCount} 件{' '}
        <button type="button" className="button button--compact" onClick={onOpenLibrary}>
          書誌一覧へ移動
        </button>
      </p>
    </div>
  )
}

interface StatusView {
  kind: 'idle' | 'searching' | 'success' | 'duplicate'
  label: string
  detail?: string
}

/**
 * 現在の状態。色ではなく文で伝える。
 * 見せる順は「使えない理由 → 待たせている理由 → 進んでいること」。
 */
function describeStatus(input: {
  ready: boolean
  preparing: boolean
  busy: boolean
  ocrPending: number
  advice: string | null
  lastOutcome: CaptureOutcome | null
}): StatusView {
  if (!input.ready) {
    return {
      kind: 'idle',
      label: 'カメラを起動しています',
      detail: 'カメラの利用を許可してください。',
    }
  }
  if (input.preparing) {
    return {
      kind: 'idle',
      label: '文字の読み取りを準備しています',
      detail: '初回は読み込みに少し時間がかかります。そのままお待ちください。',
    }
  }
  if (input.busy) {
    return {
      kind: 'idle',
      label: '読み取りが追いついていません',
      detail: '読み取りが終わるまでお待ちください。撮ったぶんは順に処理します。',
    }
  }
  if (input.advice) {
    return { kind: 'idle', label: '読み取れる状態ではありません', detail: input.advice }
  }
  if (input.lastOutcome === 'queued') {
    return {
      kind: 'success',
      label: '棚を1枚取り込みました',
      detail: '文字を読み取って書誌情報を調べています。次の段へ移してください。',
    }
  }
  if (input.lastOutcome === 'duplicate') {
    return {
      kind: 'duplicate',
      label: 'この構図は取り込み済みです',
      detail: '次の段へ移すか、棚に沿って少しずらしてください。',
    }
  }
  if (input.ocrPending > 0) {
    return {
      kind: 'searching',
      label: '読み取っています',
      detail: '次の段へ移して構いません。撮ったぶんは順に処理します。',
    }
  }
  return {
    kind: 'searching',
    label: '棚を探しています',
    detail: '棚の一段を枠に収めて、少し止めてください。',
  }
}
