import { useCallback, useEffect, useRef, useState } from 'react'
import { CameraUnavailableError, openRearCamera } from '../lib/barcode'
import {
  STILL_THRESHOLD,
  assessFrame,
  canvasToBlob,
  downscale,
  drawLane,
  frameAdvice,
  frameDifference,
  isUsable,
  pickSharpest,
  toGray,
  visualHash,
  type FrameQuality,
  type GrayImage,
} from '../lib/spine/capture'
import { Notice } from './Notice'
import type { CaptureOutcome, SpineCrop } from './useSpineScan'

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
  /** OCR 待ちの件数 */
  ocrPending: number
  /** 書誌照合待ちの件数 */
  lookupPending: number
  /** OCR の待ち行列が満杯 */
  busy: boolean
  /** 文字が取れなかった枚数 */
  unreadable: number
  /** この読み取りで追加した本 */
  results: readonly SpineResult[]
  /** 一覧に登録済みの冊数 */
  registeredCount: number
  /** 背表紙を1枚切り出したとき */
  onCapture: (crop: SpineCrop) => CaptureOutcome
  onClose: () => void
  onOpenLibrary: () => void
}

/** 監視の間隔。毎コマ調べても精度は上がらず、発熱するだけ */
const MONITOR_INTERVAL_MS = 200
/** 監視用に縮小する幅。品質判定と動きの検出はこの解像度で足りる */
const MONITOR_WIDTH = 72
/** 連写の枚数と間隔。この中から最も鮮鋭な1枚だけを OCR へ回す */
const BURST_SIZE = 3
const BURST_INTERVAL_MS = 60
/** 取り込んだ直後は少し待つ。同じ背表紙で連続して撮らないため */
const COOLDOWN_MS = 500
/**
 * 止まらないまま這わせている場合の受け皿。
 *
 * 「静止したら撮る」だけにすると、棚に沿って途切れなく動かす人からは
 * 1枚も取り込めないことがある。品質が足りているコマがこの時間続いたら、
 * 完全に止まっていなくても取り込む。
 */
const MOTION_GRACE_MS = 2500

/** 状態表示の文言 */
const RESULT_TEXT: Record<SpineResult['state'], string> = {
  looking: '書誌情報を取得しています',
  found: '書誌情報を取得しました',
  review: '候補を確認してください',
  missing: '書誌情報が見つかりませんでした',
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 全体の品質判定に使う縮小画像。ラプラシアンを原寸で回すと重い */
function monitorGray(image: ImageData): GrayImage {
  const gray = toGray(image)
  const width = Math.min(128, gray.width)
  return downscale(gray, width, Math.round((gray.height * width) / gray.width))
}

/**
 * 本棚の背表紙を、かざしたまま連続で読み取る。
 *
 * 画面中央に背表紙1冊ぶんの縦長の「読取レーン」を置き、棚に沿って
 * カメラを横へ流してもらう。レーンを通過した背表紙だけを取り込むので、
 * 棚全体から背表紙の境界を検出する処理が要らない(lib/spine/capture.ts)。
 *
 * OCR はこの画面では持たない。カメラを閉じた時点で Worker ごと落ちると、
 * 待ち行列に残った本が消えてしまうため、呼び出し側(useSpineScan)に置く。
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
  const cropRef = useRef<HTMLCanvasElement>(null)

  const [cameraError, setCameraError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [advice, setAdvice] = useState<string | null>(null)
  /** 直近の取り込み結果。一定時間で消す */
  const [lastOutcome, setLastOutcome] = useState<CaptureOutcome | null>(null)
  const [captured, setCaptured] = useState(0)
  const [attempt, setAttempt] = useState(0)

  /** 走査ループから見た最新の onCapture。依存に入れるとカメラが開き直る */
  const captureRef = useRef(onCapture)
  useEffect(() => {
    captureRef.current = onCapture
  })

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined
    let previous: GrayImage | null = null
    /** 品質は足りているのに静止しない状態が続いた時間 */
    let waitingSince = 0

    const schedule = (ms = MONITOR_INTERVAL_MS) => {
      if (!cancelled) timer = setTimeout(() => void tick(), ms)
    }

    /** 原寸のレーンを連写して、最も鮮鋭な1枚を切り出す */
    const grabBest = async (
      video: HTMLVideoElement,
      canvas: HTMLCanvasElement,
    ): Promise<SpineCrop | null> => {
      const frames: { image: ImageData; gray: GrayImage; quality: FrameQuality }[] = []
      for (let i = 0; i < BURST_SIZE; i++) {
        const image = drawLane(video, canvas)
        if (image) {
          const gray = monitorGray(image)
          frames.push({ image, gray, quality: assessFrame(gray) })
        }
        if (i < BURST_SIZE - 1) await sleep(BURST_INTERVAL_MS)
        if (cancelled) return null
      }

      const best = pickSharpest(frames)
      if (!best) return null

      const ctx = canvas.getContext('2d')
      if (!ctx) return null
      canvas.width = best.image.width
      canvas.height = best.image.height
      ctx.putImageData(best.image, 0, 0)

      const blob = await canvasToBlob(canvas)
      if (!blob) return null
      return {
        blob,
        hash: visualHash(best.gray),
        width: best.image.width,
        height: best.image.height,
        at: Date.now(),
      }
    }

    const tick = async () => {
      if (cancelled) return
      const video = videoRef.current
      const monitor = monitorRef.current
      const crop = cropRef.current
      if (!video || !monitor || !crop) return schedule()

      const image = drawLane(video, monitor, MONITOR_WIDTH)
      if (!image) return schedule()

      const gray = toGray(image)
      const quality = assessFrame(gray)
      const moved = previous ? frameDifference(previous, gray) : 1
      previous = gray

      if (!isUsable(quality)) {
        waitingSince = 0
        setAdvice(frameAdvice(quality))
        return schedule()
      }
      setAdvice(null)

      // 静止していれば取り込む。止まらないまま時間が経った場合も取り込む
      const now = Date.now()
      if (moved > STILL_THRESHOLD) {
        if (waitingSince === 0) waitingSince = now
        if (now - waitingSince < MOTION_GRACE_MS) return schedule()
      }
      waitingSince = 0

      const shot = await grabBest(video, crop)
      if (cancelled) return
      if (!shot) return schedule()

      const outcome = captureRef.current(shot)
      setLastOutcome(outcome)
      if (outcome === 'queued') setCaptured((n) => n + 1)

      // 取り込んだ直後の比較対象は当てにならないので作り直させる
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
    const t = setTimeout(() => setLastOutcome(null), 1800)
    return () => clearTimeout(t)
  }, [lastOutcome])

  const retry = useCallback(() => {
    setCameraError(null)
    setReady(false)
    setAttempt((n) => n + 1)
  }, [])

  const status = describeStatus({ ready, preparing, busy, advice, lastOutcome })
  const error = cameraError ?? ocrError

  return (
    <div className="stack">
      {/* 3. カメラ表示領域 */}
      <div className="scanner-view scanner-view--spine">
        <video ref={videoRef} playsInline muted autoPlay />
        {!error && ready && <div className="scanner-lane" aria-hidden="true" />}
        {(!ready || error) && (
          <p className="scanner-placeholder">
            {error ? 'カメラを利用できません' : 'カメラを起動しています'}
          </p>
        )}
      </div>

      {/* 切り出し用。画面には出さないが、常に DOM に置いておく必要がある */}
      <canvas ref={monitorRef} className="visually-hidden" />
      <canvas ref={cropRef} className="visually-hidden" />

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

      {(ocrPending > 0 || lookupPending > 0 || unreadable > 0) && (
        <ul className="status-line">
          <li>
            取り込み <b>{captured}</b> 枚
          </li>
          {ocrPending > 0 && (
            <li>
              文字の読み取り待ち <b>{ocrPending}</b> 件
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
        「読めたのかどうか」が分からず、同じ棚を何度もなぞることになる
      */}
      {results.length > 0 && (
        <div>
          <h2 className="subheading">この読み取りで追加した本（{results.length} 件）</h2>
          <ul className="scan-feed">
            {results
              .slice(-6)
              .reverse()
              .map((r) => (
                <li key={r.id} data-state={r.state}>
                  <span className="scan-feed__title">{r.title}</span>
                  <span className="scan-feed__detail">{RESULT_TEXT[r.state]}</span>
                </li>
              ))}
            {results.length > 6 && <li>ほか {results.length - 6} 件</li>}
          </ul>
        </div>
      )}

      <p className="note">
        カメラを横向きにして、棚の一段が上下に収まるように構えてください。
        中央の枠に背表紙が1冊ずつ入るよう、棚に沿ってゆっくり動かします。
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
      detail: 'カメラを動かす速さを落としてください。取り込んだぶんは順に処理します。',
    }
  }
  if (input.advice) {
    return { kind: 'idle', label: '読み取れる状態ではありません', detail: input.advice }
  }
  if (input.lastOutcome === 'queued') {
    return {
      kind: 'success',
      label: '背表紙を取り込みました',
      detail: '文字を読み取って書誌情報を調べています。',
    }
  }
  if (input.lastOutcome === 'duplicate') {
    return {
      kind: 'duplicate',
      label: 'この背表紙は取り込み済みです',
      detail: '次の本へ動かしてください。',
    }
  }
  return {
    kind: 'searching',
    label: '背表紙を探しています',
    detail: '中央の枠に背表紙を1冊ずつ収めてください。',
  }
}
