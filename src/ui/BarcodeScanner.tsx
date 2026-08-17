import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CameraUnavailableError,
  createBarcodeReader,
  grabCenterBand,
  openRearCamera,
  pickIsbn13,
  type BarcodeReader,
} from '../lib/barcode'

interface Props {
  /** 既に一覧に入っている ISBN。重複スキャンを検知するために渡す */
  knownIsbns: ReadonlySet<string>
  /** 読み取りを終えたとき。新規の ISBN だけが渡る */
  onDone: (isbns: string[]) => void
  onCancel: () => void
}

/** 検出を試みる間隔。毎フレーム回すと wasm 経路で発熱するだけで精度は上がらない */
const SCAN_INTERVAL_MS = 140

/** 読み取り成功の合図を出す。端末が対応していないものは黙って飛ばす */
function signalHit(): void {
  try {
    navigator.vibrate?.(60)
  } catch {
    /* iOS は未対応。無視してよい */
  }
}

/**
 * ISBN バーコードの連続スキャン。
 *
 * 本を「かざすだけ」で次々に読めることを狙っている。
 * シャッターを押させると1冊ごとに手が止まり、棚卸しの速度が出ない。
 */
export function BarcodeScanner({ knownIsbns, onDone, onCancel }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** このセッションで読んだ ISBN。描画のたびに作り直さないよう ref で持つ */
  const scannedRef = useRef<Set<string>>(new Set())

  const [scanned, setScanned] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [readerKind, setReaderKind] = useState<BarcodeReader['kind'] | null>(null)
  /** 直近の読み取り結果。既出かどうかで表示を変える */
  const [flash, setFlash] = useState<{ isbn: string; dup: boolean; at: number } | null>(null)

  const handleCode = useCallback(
    (isbn: string) => {
      const dup = scannedRef.current.has(isbn) || knownIsbns.has(isbn)
      if (!dup) {
        scannedRef.current.add(isbn)
        setScanned((prev) => [...prev, isbn])
      }
      signalHit()
      setFlash({ isbn, dup, at: Date.now() })
    },
    [knownIsbns],
  )

  useEffect(() => {
    let cancelled = false
    let stream: MediaStream | null = null
    let timer: ReturnType<typeof setTimeout> | undefined

    const start = async () => {
      let reader: BarcodeReader
      try {
        // カメラ許可の確認と wasm のロードは同時に進める
        const [s, r] = await Promise.all([openRearCamera(), createBarcodeReader()])
        stream = s
        reader = r
      } catch (err) {
        if (cancelled) return
        setError(
          err instanceof CameraUnavailableError
            ? err.message
            : 'バーコード読み取りを開始できませんでした。',
        )
        return
      }

      // 待っている間にアンマウントされていたらカメラを手放す
      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop())
        return
      }

      const video = videoRef.current
      const canvas = canvasRef.current
      if (!video || !canvas) {
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

      setReaderKind(reader.kind)
      setReady(true)

      const tick = async () => {
        if (cancelled) return
        const image = grabCenterBand(video, canvas)
        if (image) {
          try {
            const isbn = pickIsbn13(await reader.detect(image))
            if (isbn && !cancelled) handleCode(isbn)
          } catch {
            // 1フレームの失敗で走査を止めない
          }
        }
        if (!cancelled) timer = setTimeout(() => void tick(), SCAN_INTERVAL_MS)
      }
      void tick()
    }

    void start()

    return () => {
      cancelled = true
      clearTimeout(timer)
      stream?.getTracks().forEach((t) => t.stop())
    }
  }, [handleCode])

  // 読み取り表示を一定時間で消す
  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(null), 1200)
    return () => clearTimeout(t)
  }, [flash])

  if (error) {
    return (
      <div className="scanner">
        <div className="notice error">{error}</div>
        <div className="scanner-actions">
          <button onClick={onCancel}>戻る</button>
        </div>
      </div>
    )
  }

  return (
    <div className="scanner">
      <div className="scanner-view">
        <video ref={videoRef} playsInline muted autoPlay />
        <div className="scanner-band" data-hit={flash ? (flash.dup ? 'dup' : 'new') : undefined} />
        {!ready && <p className="scanner-status">カメラを準備しています…</p>}
        {flash && (
          <p className="scanner-toast" data-dup={flash.dup}>
            {flash.dup ? `読み取り済み: ${flash.isbn}` : `${flash.isbn}`}
          </p>
        )}
      </div>

      <canvas ref={canvasRef} className="visually-hidden" />

      <p className="hint">
        本の裏表紙のバーコードを枠に重ねてください。上段（978で始まる方）を読みます。
        {readerKind === 'wasm' && ' ／ このブラウザでは互換モードで読み取っています。'}
      </p>

      <div className="scanner-count">
        <strong>{scanned.length}</strong> 冊読み取り
        {scanned.length > 0 && (
          <span className="scanner-recent">
            {scanned.slice(-3).reverse().join(' / ')}
            {scanned.length > 3 && ' …'}
          </span>
        )}
      </div>

      <div className="scanner-actions">
        <button
          className="primary"
          disabled={scanned.length === 0}
          onClick={() => onDone(scanned)}
        >
          読み取りを終える（{scanned.length}冊）
        </button>
        <button onClick={onCancel}>やめる</button>
      </div>
    </div>
  )
}
