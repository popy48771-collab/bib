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
  /** 一覧に登録済みの冊数。画面の末尾に出す */
  registeredCount: number
  /** 新しい ISBN を読んだとき。1冊ごとに即座に呼ばれる */
  onIsbn: (isbn: string) => void
  /** カメラを閉じる */
  onClose: () => void
  /** 書誌一覧へ移動する */
  onOpenLibrary: () => void
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

/** 照合状況の文言。記号ではなく文で書く */
const RESULT_TEXT: Record<ScanResult['state'], string> = {
  looking: '書誌情報を取得しています',
  found: '',
  missing: '書誌情報が見つかりませんでした',
}

/**
 * ISBN バーコードの連続スキャン。
 *
 * 本を「かざすだけ」で次々に読めることを狙っている。
 * シャッターを押させると1冊ごとに手が止まり、棚卸しの速度が出ない。
 *
 * 読んだ ISBN はその場で onIsbn に渡す。溜めておいて最後に一括で渡すと、
 * 「読み終えるボタンを押すまで一覧が空」という状態が生まれてしまう。
 *
 * 画面の並びは DESIGN_SYSTEM.md で定めた順序に従う:
 * カメラ表示領域 → 現在の状態 → 主操作ボタン → 登録済み件数と一覧へのリンク。
 * （見出しと説明文は呼び出し側が出す）
 */
export function BarcodeScanner({
  knownIsbns,
  results,
  registeredCount,
  onIsbn,
  onClose,
  onOpenLibrary,
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
    setLastRead({ isbn, dup })
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
    }
  }, [attempt, handleCode])

  // 読み取り結果の表示を一定時間で「探索中」に戻す
  useEffect(() => {
    if (!lastRead) return
    const t = setTimeout(() => setLastRead(null), RESULT_HOLD_MS)
    return () => clearTimeout(t)
  }, [lastRead])

  /** 権限拒否などで開けなかったとき、カメラ起動をやり直す */
  const retry = useCallback(() => {
    setError(null)
    setReady(false)
    setAttempt((n) => n + 1)
  }, [])

  const status: StatusView = !ready
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
        {!error && ready && <div className="scanner-guide" aria-hidden="true" />}
        {(!ready || error) && (
          <p className="scanner-placeholder">
            {error ? 'カメラを利用できません' : 'カメラを起動しています'}
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
      <div className="actions">
        {error ? (
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
        「読めたのかどうか」が分からず、同じ本を何度もかざすことになる
      */}
      {scanned.length > 0 && (
        <div>
          <h2 className="subheading">この読み取りで追加した本（{scanned.length} 件）</h2>
          <ul className="scan-feed">
            {scanned
              .slice(-6)
              .reverse()
              .map((isbn) => {
                const r = results.get(isbn)
                const state = r?.state ?? 'looking'
                return (
                  <li key={isbn} data-state={state}>
                    <span className="scan-feed__title">{r?.title ?? RESULT_TEXT[state]}</span>
                    <span className="scan-feed__isbn">{isbn}</span>
                  </li>
                )
              })}
            {scanned.length > 6 && <li>ほか {scanned.length - 6} 件</li>}
          </ul>
        </div>
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
          書誌一覧へ移動
        </button>
      </p>
    </div>
  )
}
