import { useCallback, useEffect, useRef, useState } from 'react'
import { CameraUnavailableError, openRearCamera } from '../lib/barcode'
import {
  STILL_THRESHOLD,
  assessFrame,
  canvasToBlob,
  decideCapture,
  downscale,
  drawFrame,
  frameAdvice,
  frameDifference,
  isUsable,
  shouldRearm,
  toGray,
  visualHash,
  type GrayImage,
} from '../lib/spine/capture'
import { segmentSpines } from '../lib/spine/segment'
import { Notice } from './Notice'
import { signalHit } from './feedback'
import { describeCloseHint, describeSpineStatus } from './spineStatus'
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
/**
 * 監視用に縮小する幅。
 *
 * 96 では棚の背表紙の境目が数画素に潰れ、鮮鋭度が実際より低く出ていた。
 * 「かざしても何も起きない」の一因なので、判定できるところまで戻す。
 * 4回/秒で 160×90 なら発熱の心配はない。
 */
const MONITOR_WIDTH = 160
/** 取り込んだ直後は待つ。同じ構図で続けて撮らないため */
const COOLDOWN_MS = 1200
/**
 * 短冊を求めるときの幅。
 *
 * 縦の境界を探すだけなので原寸は要らない。480 あれば、文庫の背表紙
 * （画面幅の約2%）でも 10画素ぶんの幅がある。
 */
const SEGMENT_WIDTH = 480

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
  /** 品質は足りているが、まだ止まっていない */
  const [moving, setMoving] = useState(false)
  /** いま映っている棚は取り込み済みで、動かすまで撮り直さない */
  const [shelfRead, setShelfRead] = useState(false)
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
    /** 最後に取り込んだコマ。同じ棚を撮り続けないための突き合わせに使う */
    let capturedGray: GrayImage | null = null
    let capturedAt = 0
    let stable = 0
    /** この待ちが始まった時刻。救済までの経過を測るのに使う */
    let waitingSince = Date.now()
    /** 待っているあいだに見た最良の鮮鋭度 */
    let bestSharpness = 0

    const schedule = (ms = MONITOR_INTERVAL_MS) => {
      if (!cancelled) timer = setTimeout(() => void tick(), ms)
    }

    /** 次の1枚を待つ状態へ戻す */
    const restartWait = () => {
      stable = 0
      previous = null
      waitingSince = Date.now()
      bestSharpness = 0
    }

    /**
     * 原寸のフレームを1枚切り出し、背表紙ごとの短冊も求める。
     *
     * 短冊をここで求めるのは、原寸の ImageData がまだ手元にあるからである。
     * あとから Blob を復号し直すと、1枚につき数MBの往復が増える。
     */
    const grabFrame = async (
      video: HTMLVideoElement,
      canvas: HTMLCanvasElement,
      quality: ReturnType<typeof assessFrame>,
    ): Promise<FrameCapture | null> => {
      const image = drawFrame(video, canvas)
      if (!image) return null
      const blob = await canvasToBlob(canvas)
      if (!blob) return null

      const gray = toGray(image)
      const small = downscale(
        gray,
        SEGMENT_WIDTH,
        Math.round((gray.height * SEGMENT_WIDTH) / gray.width),
      )
      return {
        blob,
        hash: visualHash(monitorGray(image)),
        width: image.width,
        height: image.height,
        at: Date.now(),
        bands: segmentSpines(small),
        quality,
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
      if (quality.sharpness > bestSharpness) bestSharpness = quality.sharpness

      const decision = decideCapture({
        usable: isUsable(quality),
        moved,
        stable,
        waitedMs: Date.now() - waitingSince,
        sharpness: quality.sharpness,
        bestSharpness,
      })

      if (decision === 'reject') {
        stable = 0
        setMoving(false)
        setAdvice(frameAdvice(quality))
        return schedule()
      }
      setAdvice(null)

      if (decision === 'wait') {
        stable = moved <= STILL_THRESHOLD ? stable + 1 : 0
        /*
         * 動きで待たせているあいだ、以前は何も言っていなかった。
         * 画質は足りているので「読み取れる状態ではありません」も出ず、
         * 利用者からは「かざしているのに何も起きない」ように見える。
         */
        setMoving(true)
        return schedule()
      }
      setMoving(false)

      /*
       * 取り込んだ棚を撮り続けない。
       *
       * **ここが「行が何倍に増えるか」の分かれ目である。** 取り込みの重複判定
       * (ハッシュ)は露出の揺れで簡単にすり抜け、すり抜けるたびに棚一段ぶんの
       * 短冊が読み直されていた。実機では1つの棚に数十秒かざしただけで
       * 80件が並んだ。実際にカメラが動くまで、次は撮らない。
       */
      if (
        capturedGray &&
        !shouldRearm({
          movedFromCaptured: frameDifference(capturedGray, gray),
          sinceCaptureMs: Date.now() - capturedAt,
        })
      ) {
        setShelfRead(true)
        return schedule()
      }
      setShelfRead(false)

      // 読み取りが追いついていなければ、撮らずに待つ
      if (liveRef.current.busy) return schedule()

      const shot = await grabFrame(video, frame, quality)
      if (cancelled) return
      if (!shot) return schedule()

      const outcome = liveRef.current.onCapture(shot)
      setLastOutcome(outcome)
      if (outcome === 'queued' || outcome === 'duplicate') {
        // この構図は処理済み。動かすまで撮り直さない
        capturedGray = gray
        capturedAt = Date.now()
      }
      if (outcome === 'queued') {
        // 目は棚を見ているので、撮れたことは振動で返す
        signalHit()
        setCaptured((n) => n + 1)
      }

      restartWait()
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

  const status = describeSpineStatus({
    ready,
    preparing,
    busy,
    ocrPending,
    lookupPending,
    captured,
    advice,
    moving,
    shelfRead,
    lastOutcome,
  })
  const closeHint = describeCloseHint({ ocrPending, lookupPending, captured })
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
        押していいのかを、押す場所のすぐ下で答える。
        撮った瞬間と読み終わる瞬間がずれるので、これが無いと終えどきが判らない
      */}
      {!cameraError && closeHint && (
        <p className="note" role="status">
          {closeHint}
        </p>
      )}

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
