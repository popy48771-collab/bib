import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CameraUnavailableError,
  createBarcodeReader,
  grabCenterBand,
  openRearCamera,
  pickIsbn13,
  type BarcodeReader,
} from '../lib/barcode'

/** 1冊ぶんの照合状況。スキャナはこれを表示するだけで、照合自体は関与しない */
export interface ScanResult {
  state: 'looking' | 'found' | 'missing'
  /** 書誌が引けたときの書名 */
  title?: string
}

interface Props {
  /** 既に一覧に入っている ISBN。重複スキャンを検知するために渡す */
  knownIsbns: ReadonlySet<string>
  /** ISBN ごとの照合状況。読み取った順に下へ表示する */
  results: ReadonlyMap<string, ScanResult>
  /** 新しい ISBN を読んだとき。1冊ごとに即座に呼ばれる */
  onIsbn: (isbn: string) => void
  /** カメラを閉じる */
  onClose: () => void
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
 *
 * 読んだ ISBN はその場で onIsbn に渡す。溜めておいて最後に一括で渡すと、
 * 「読み終えるボタンを押すまで一覧が空」という状態が生まれてしまう。
 */
export function BarcodeScanner({ knownIsbns, results, onIsbn, onClose }: Props) {
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

  /**
   * 走査ループから見た「最新の props」。
   *
   * 1冊読むたびに一覧が伸び、knownIsbns も onIsbn も作り直される。
   * これを走査の useEffect の依存に入れると、読み取るたびにカメラが
   * 開き直されてしまうので、値は ref 経由で渡す。
   */
  const liveRef = useRef({ knownIsbns, onIsbn })
  useEffect(() => {
    liveRef.current = { knownIsbns, onIsbn }
  })

  const handleCode = useCallback((isbn: string) => {
    const { knownIsbns, onIsbn } = liveRef.current
    const dup = scannedRef.current.has(isbn) || knownIsbns.has(isbn)
    if (!dup) {
      scannedRef.current.add(isbn)
      setScanned((prev) => [...prev, isbn])
      onIsbn(isbn)
    }
    signalHit()
    setFlash({ isbn, dup, at: Date.now() })
  }, [])

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
          <button onClick={onClose}>戻る</button>
        </div>
      </div>
    )
  }

  const pending = scanned.filter((i) => results.get(i)?.state === 'looking').length

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
        {pending > 0 && <span className="scanner-pending">照合中 {pending} 冊</span>}
      </div>

      {/* 読んだ端から書名が入っていく。ボタンを押さないと結果が出ないのでは
          「読めたのかどうか」が分からず、同じ本を何度もかざすことになる */}
      {scanned.length > 0 && (
        <ul className="scan-feed">
          {scanned
            .slice(-6)
            .reverse()
            .map((isbn) => {
              const r = results.get(isbn)
              return (
                <li key={isbn} data-state={r?.state ?? 'looking'}>
                  <span className="scan-feed-title">
                    {r?.title ?? (r?.state === 'missing' ? '書誌が見つかりません' : '照合中…')}
                  </span>
                  <span className="scan-feed-isbn">{isbn}</span>
                </li>
              )
            })}
        </ul>
      )}

      <div className="scanner-actions">
        <button className="primary" onClick={onClose}>
          読み取りを終える
        </button>
      </div>
    </div>
  )
}
