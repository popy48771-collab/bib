import { useCallback, useEffect, useRef, useState } from 'react'
import {
  CameraUnavailableError,
  createBarcodeReader,
  grabCenterBand,
  openRearCamera,
  pickIsbn13,
  type BarcodeReader,
} from '../lib/barcode'
import { Notice } from './Notice'

interface Props {
  /** カメラを動かすか。false のときは停止した状態の画面を出す */
  active: boolean
  /** 既に一覧に入っている ISBN。重複スキャンを検知するために渡す */
  knownIsbns: ReadonlySet<string>
  /** 一覧に登録済みの冊数。読み取り画面の末尾に出す */
  registeredCount: number
  onStart: () => void
  onStop: () => void
  /** 読み取ったものを一覧に追加する */
  onDone: (isbns: string[]) => void
  /** 蔵書一覧へ移動する */
  onOpenLibrary: () => void
  /** 他の処理が動いている間は開始させない */
  disabled?: boolean
}

/** 検出を試みる間隔。毎フレーム回すと wasm 経路で発熱するだけで精度は上がらない */
const SCAN_INTERVAL_MS = 140

/** 読み取り結果を状態表示に残す時間。過ぎたら「探索中」に戻す */
const RESULT_HOLD_MS = 2500

/** 読み取り成功の合図を出す。端末が対応していないものは黙って飛ばす */
function signalHit(): void {
  try {
    navigator.vibrate?.(60)
  } catch {
    /* iOS は未対応。無視してよい */
  }
}

/** 状態表示の内容。色ではなく文章で状態を伝える */
interface StatusView {
  kind: 'idle' | 'searching' | 'success' | 'duplicate'
  label: string
  detail?: string
}

/**
 * ISBN バーコードの連続スキャン。
 *
 * 本を「かざすだけ」で次々に読めることを狙っている。
 * シャッターを押させると1冊ごとに手が止まり、棚卸しの速度が出ない。
 *
 * 画面の並びは DESIGN_SYSTEM.md で定めた順序に従う:
 * カメラ表示領域 → 現在の状態 → 主操作ボタン → 登録済み件数と一覧へのリンク。
 * （見出しと説明文は呼び出し側が出す）
 */
export function BarcodeScanner({
  active,
  knownIsbns,
  registeredCount,
  onStart,
  onStop,
  onDone,
  onOpenLibrary,
  disabled,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  /** このセッションで読んだ ISBN。描画のたびに作り直さないよう ref で持つ */
  const scannedRef = useRef<Set<string>>(new Set())

  const [scanned, setScanned] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [readerKind, setReaderKind] = useState<BarcodeReader['kind'] | null>(null)
  /** 直近の読み取り結果。既出かどうかで表示を変える */
  const [lastRead, setLastRead] = useState<{ isbn: string; dup: boolean } | null>(null)
  /** 再読み取りのたびに増やして、カメラ起動の副作用をやり直させる */
  const [attempt, setAttempt] = useState(0)

  const handleCode = useCallback(
    (isbn: string) => {
      const dup = scannedRef.current.has(isbn) || knownIsbns.has(isbn)
      if (!dup) {
        scannedRef.current.add(isbn)
        setScanned((prev) => [...prev, isbn])
      }
      signalHit()
      setLastRead({ isbn, dup })
    },
    [knownIsbns],
  )

  useEffect(() => {
    if (!active) return

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
            : 'バーコードの読み取りを開始できませんでした。ページを再読み込みして、もう一度お試しください。',
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
      setReady(false)
    }
  }, [active, attempt, handleCode])

  // 読み取り結果の表示を一定時間で「探索中」に戻す
  useEffect(() => {
    if (!lastRead) return
    const t = setTimeout(() => setLastRead(null), RESULT_HOLD_MS)
    return () => clearTimeout(t)
  }, [lastRead])

  const retry = useCallback(() => {
    setError(null)
    setAttempt((n) => n + 1)
    if (!active) onStart()
  }, [active, onStart])

  const stop = useCallback(() => {
    setLastRead(null)
    onStop()
  }, [onStop])

  const status: StatusView = !active
    ? {
        kind: 'idle',
        label: 'カメラは停止しています',
        detail: '「カメラを開始」を押すと読み取りを始めます。',
      }
    : !ready
      ? { kind: 'idle', label: 'カメラを起動しています', detail: 'カメラの利用を許可してください。' }
      : lastRead
        ? lastRead.dup
          ? { kind: 'duplicate', label: 'このISBNは登録済みです', detail: lastRead.isbn }
          : { kind: 'success', label: 'ISBNを読み取りました', detail: lastRead.isbn }
        : {
            kind: 'searching',
            label: 'バーコードを探しています',
            detail: 'バーコードを枠の中に収めてください。',
          }

  return (
    <div className="stack">
      {/* 3. カメラ表示領域 */}
      <div className="scanner-view">
        <video ref={videoRef} playsInline muted autoPlay />
        {active && !error && <div className="scanner-guide" aria-hidden="true" />}
        {(!active || !ready) && (
          <p className="scanner-placeholder">
            {error
              ? 'カメラを利用できません'
              : active
                ? 'カメラを起動しています'
                : 'カメラは停止しています'}
          </p>
        )}
      </div>

      {/* 切り出し用。画面には出さないが、常に DOM に置いておく必要がある */}
      <canvas ref={canvasRef} className="visually-hidden" />

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

      {/* 5. 主操作ボタン */}
      {error ? (
        <div className="actions">
          <button type="button" className="button button--primary" onClick={retry}>
            再読み取り
          </button>
          <button type="button" className="button button--secondary" onClick={stop}>
            読み取りをやめる
          </button>
        </div>
      ) : active ? (
        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            disabled={scanned.length === 0}
            onClick={() => onDone(scanned)}
          >
            一覧に追加（{scanned.length}件）
          </button>
          <button type="button" className="button button--secondary" onClick={stop}>
            カメラを停止
          </button>
        </div>
      ) : (
        <div className="actions">
          <button
            type="button"
            className="button button--primary button--block"
            disabled={disabled}
            onClick={onStart}
          >
            カメラを開始
          </button>
        </div>
      )}

      {active && scanned.length > 0 && (
        <ul className="scanner-log">
          <li>このあと一覧に追加するISBN（新しいものから）</li>
          {scanned
            .slice(-3)
            .reverse()
            .map((isbn) => (
              <li key={isbn}>{isbn}</li>
            ))}
          {scanned.length > 3 && <li>ほか {scanned.length - 3} 件</li>}
        </ul>
      )}

      {readerKind === 'wasm' && (
        <p className="note">
          このブラウザは互換モードで読み取っています。読み取りに少し時間がかかります。
        </p>
      )}

      {/* 6. 登録済み件数と一覧へのリンク */}
      <p className="note">
        登録済み: {registeredCount} 件{' '}
        <button type="button" className="button button--compact" onClick={onOpenLibrary}>
          蔵書一覧を開く
        </button>
      </p>
    </div>
  )
}
