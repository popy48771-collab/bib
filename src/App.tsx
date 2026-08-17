import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ScoredCandidate, Settings, StageId, StageStatus } from './types'
import {
  adoptCandidate,
  entriesFromExtraction,
  runGoogleBooksStage,
  runNdlStage,
  runOpenBdStage,
  type StageContext,
} from './pipeline/stages'
import { entriesFromIsbns } from './pipeline/stages'
import { extractSpines, isVlmConfigured } from './sources/vlm'
import { isNdlConfigured } from './sources/ndl'
import { loadSettings, saveSettings, listEntries, saveEntries, clearEntries } from './lib/db'
import { SettingsPanel } from './ui/SettingsPanel'
import { BookList } from './ui/BookList'
import { ExportPanel } from './ui/ExportPanel'
import { BarcodeScanner } from './ui/BarcodeScanner'

/** 読み取り方式。どちらも同じ書誌パイプラインへ合流する */
type InputMode = 'barcode' | 'spine'

interface StageState {
  status: StageStatus
  message?: string
  done?: number
  total?: number
}

const INITIAL_STAGES: Record<StageId, StageState> = {
  extract: { status: 'idle' },
  googleBooks: { status: 'idle' },
  ndl: { status: 'idle' },
  openbd: { status: 'idle' },
}

/** 衝突しないID。crypto.randomUUID が無い環境向けの退避も持つ */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [entries, setEntries] = useState<BookEntry[]>([])
  const [stages, setStages] = useState<Record<StageId, StageState>>(INITIAL_STAGES)
  const [error, setError] = useState<string | null>(null)
  // 既定はバーコード。APIキーが要らず課金も発生しないので、初見でも必ず動く
  const [inputMode, setInputMode] = useState<InputMode>('barcode')
  const [scanning, setScanning] = useState(false)
  const abortRef = useRef<AbortController | null>(null)

  // 起動時に前回の続きを復元する。段階を分けた以上、中断からの再開は必須
  useEffect(() => {
    listEntries()
      .then((loaded) => {
        if (loaded.length > 0) setEntries(loaded)
      })
      .catch(() => setError('保存済みデータの読み込みに失敗しました。'))
  }, [])

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

  /** 変更を state と IndexedDB の両方に反映する */
  const commit = useCallback((next: BookEntry[]) => {
    setEntries(next)
    saveEntries(next).catch(() => setError('保存に失敗しました。'))
  }, [])

  const setStage = useCallback((id: StageId, patch: Partial<StageState>) => {
    setStages((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  const makeContext = useCallback(
    (id: StageId, controller: AbortController): StageContext => ({
      signal: controller.signal,
      onProgress: (done, total) => setStage(id, { done, total }),
      settings: {
        ndlProxyUrl: settings.ndlProxyUrl,
        googleBooksCountry: settings.googleBooksCountry,
      },
    }),
    [settings.ndlProxyUrl, settings.googleBooksCountry, setStage],
  )

  /**
   * 段階を1つ実行する共通処理。
   * 各段階は独立して起動でき、失敗しても他の段階の成果は壊さない。
   */
  const runStage = useCallback(
    async (id: StageId, fn: (ctx: StageContext) => Promise<BookEntry[]>) => {
      setError(null)
      const controller = new AbortController()
      abortRef.current = controller
      setStage(id, { status: 'running', done: 0, total: entries.length, message: undefined })

      try {
        const next = await fn(makeContext(id, controller))
        commit(next)
        setStage(id, { status: 'done' })
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setStage(id, { status: 'idle', message: '中断しました' })
          return
        }
        const message = err instanceof Error ? err.message : '不明なエラー'
        setStage(id, { status: 'error', message })
        setError(message)
      } finally {
        abortRef.current = null
      }
    },
    [entries.length, makeContext, commit, setStage],
  )

  // ── 段階0: 写真の取り込みと読み取り ──────────────────
  const onPickPhotos = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setError(null)

      const controller = new AbortController()
      abortRef.current = controller
      setStage('extract', { status: 'running', done: 0, total: files.length })

      const collected: BookEntry[] = []
      try {
        for (let i = 0; i < files.length; i++) {
          const photoId = newId()
          const spines = await extractSpines(files[i], settings, controller.signal)
          collected.push(...entriesFromExtraction(photoId, spines, photoId))
          setStage('extract', { done: i + 1, total: files.length })
        }
        // 複数枚の撮影を重ねられるよう、既存の結果に足す
        commit([...entries, ...collected])
        setStage('extract', { status: 'done' })
        // 抽出をやり直したら以降の段階は古くなる
        setStages((p) => ({
          ...p,
          googleBooks: { status: 'idle' },
          ndl: { status: 'idle' },
          openbd: { status: 'idle' },
        }))
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setStage('extract', { status: 'idle', message: '中断しました' })
          return
        }
        const message = err instanceof Error ? err.message : '不明なエラー'
        setStage('extract', { status: 'error', message })
        setError(message)
      } finally {
        abortRef.current = null
      }
    },
    [entries, settings, commit, setStage],
  )

  // ── バーコードからの取り込み ──────────────────────────
  /** 既に一覧にある ISBN。スキャナ側の重複検知に渡す */
  const knownIsbns = useMemo(
    () => new Set(entries.map((e) => e.resolved?.isbn13).filter((v): v is string => !!v)),
    [entries],
  )

  const onScanned = useCallback(
    (isbns: string[]) => {
      setScanning(false)
      if (isbns.length === 0) return
      setError(null)
      commit([...entries, ...entriesFromIsbns(isbns, newId())])
      // ISBN は手に入ったが書誌はまだ空。照合段階を促すため done にはしない
      setStage('extract', { status: 'done' })
      setStages((p) => ({
        ...p,
        googleBooks: { status: 'idle' },
        ndl: { status: 'idle' },
        openbd: { status: 'idle' },
      }))
    },
    [entries, commit, setStage],
  )

  // ── 手動操作 ────────────────────────────────────────
  const onAdopt = useCallback(
    (entryId: string, candidate: ScoredCandidate) => {
      commit(
        entries.map((e) =>
          e.id === entryId
            ? // 手動で選んだものは pinned にして、以降の自動処理で上書きさせない
              { ...adoptCandidate(e, candidate), status: 'confirmed', pinned: true, conflicts: undefined }
            : e,
        ),
      )
    },
    [entries, commit],
  )

  const onExclude = useCallback(
    (entryId: string) => {
      commit(entries.map((e) => (e.id === entryId ? { ...e, status: 'excluded' } : e)))
    },
    [entries, commit],
  )

  const onRestore = useCallback(
    (entryId: string) => {
      commit(
        entries.map((e) =>
          e.id === entryId ? { ...e, status: e.resolved ? 'needsReview' : 'unverified' } : e,
        ),
      )
    },
    [entries, commit],
  )

  const onReset = useCallback(() => {
    clearEntries().catch(() => undefined)
    setEntries([])
    setStages(INITIAL_STAGES)
    setError(null)
  }, [])

  const busy = Object.values(stages).some((s) => s.status === 'running')
  const ndlReady = isNdlConfigured(settings.ndlProxyUrl)
  const vlmReady = isVlmConfigured(settings)
  const hasIsbn = useMemo(() => entries.some((e) => e.resolved?.isbn13), [entries])

  const stageDefs: {
    id: StageId
    n: number
    title: string
    desc: string
    action: React.ReactNode
  }[] = [
    {
      id: 'extract',
      n: 1,
      title: inputMode === 'barcode' ? 'バーコードを読み取る' : '写真から背表紙を読み取る',
      desc:
        inputMode === 'barcode'
          ? 'カメラをバーコードにかざすだけで次々に読み取ります。APIキー不要・通信なし・課金なしで、誤読もほぼありません。'
          : vlmReady
            ? '本棚の写真を選ぶと、背表紙のタイトル・著者を読み取ります。1段ずつ画面いっぱいに撮ると精度が上がります。'
            : 'この方式にはAPIキーが必要です。設定を開いて登録するか、バーコード方式に切り替えてください。',
      action:
        inputMode === 'barcode' ? (
          <button className="primary" disabled={busy} onClick={() => setScanning(true)}>
            カメラを起動
          </button>
        ) : (
          <label className="primary" style={{ margin: 0 }}>
            <span
              style={{
                display: 'inline-block',
                padding: '0.45rem 0.9rem',
                borderRadius: 7,
                background: vlmReady && !busy ? 'var(--accent)' : 'var(--border)',
                color: vlmReady && !busy ? '#fff' : 'var(--muted)',
                cursor: vlmReady && !busy ? 'pointer' : 'not-allowed',
                fontSize: '0.88rem',
                fontWeight: 400,
              }}
            >
              写真を選ぶ
            </span>
            <input
              type="file"
              accept="image/*"
              multiple
              className="visually-hidden"
              disabled={!vlmReady || busy}
              onChange={(e) => {
                void onPickPhotos(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
        ),
    },
    {
      id: 'googleBooks',
      n: 2,
      title: 'Google Books で照合する',
      desc: '読み取った文字列を書誌データベースで照合し、実在が確認できたものを確定します。',
      action: (
        <button
          className="primary"
          disabled={busy || entries.length === 0}
          onClick={() => void runStage('googleBooks', (ctx) => runGoogleBooksStage(entries, ctx))}
        >
          照合する
        </button>
      ),
    },
    {
      id: 'ndl',
      n: 3,
      title: 'NDLサーチと突合する（任意）',
      desc: ndlReady
        ? '国立国会図書館サーチの結果と比較します。一次結果は上書きせず、差分の表示と欠けた項目の補完だけを行います。'
        : 'NDLサーチは CORS 非対応のため、設定でプロキシURLを登録すると使えるようになります。未設定でも他の機能は動きます。',
      action: (
        <button
          disabled={busy || !ndlReady || entries.length === 0}
          onClick={() => void runStage('ndl', (ctx) => runNdlStage(entries, ctx))}
        >
          突合する
        </button>
      ),
    },
    {
      id: 'openbd',
      n: 4,
      title: 'openBD で情報を補う（任意）',
      desc: 'ISBN が確定した本に、出版社・発売日・書影・内容紹介を補完します。',
      action: (
        <button
          disabled={busy || !hasIsbn}
          onClick={() => void runStage('openbd', (ctx) => runOpenBdStage(entries, ctx))}
        >
          補完する
        </button>
      ),
    },
  ]

  return (
    <div className="app">
      <header className="masthead">
        <h1>本棚スキャナ</h1>
        <p>本棚の写真から背表紙を読み取り、書誌情報を検索して蔵書一覧を作ります。</p>
      </header>

      <SettingsPanel settings={settings} onChange={updateSettings} />

      {error && <div className="notice error">{error}</div>}

      {/*
        読み取り方式の切り替え。
        バーコードは課金ゼロ・高精度だが1冊ずつ手に取る必要があり、
        背表紙は棚を撮るだけで済むがAPIキーと従量課金が要る。
        どちらが良いかは状況で変わるので、利用者に選ばせる。
      */}
      <div className="modes" role="group" aria-label="読み取り方式">
        <button
          className="mode"
          aria-pressed={inputMode === 'barcode'}
          disabled={busy}
          onClick={() => setInputMode('barcode')}
        >
          <span className="mode-title">バーコード</span>
          <span className="mode-note">課金なし・高精度／1冊ずつ</span>
        </button>
        <button
          className="mode"
          aria-pressed={inputMode === 'spine'}
          disabled={busy}
          onClick={() => setInputMode('spine')}
        >
          <span className="mode-title">背表紙の写真</span>
          <span className="mode-note">
            {vlmReady ? '棚ごと一度に／APIキー必要' : 'APIキー未設定'}
          </span>
        </button>
      </div>

      {scanning && (
        <BarcodeScanner
          knownIsbns={knownIsbns}
          onDone={onScanned}
          onCancel={() => setScanning(false)}
        />
      )}

      <div className="stages">
        {stageDefs.map((s) => {
          const st = stages[s.id]
          const pct = st.total ? Math.round(((st.done ?? 0) / st.total) * 100) : 0
          return (
            <section className="stage" key={s.id} data-status={st.status}>
              <span className="stage-num">{st.status === 'done' ? '✓' : s.n}</span>
              <div className="stage-body">
                <h2>{s.title}</h2>
                <p>{st.message ?? s.desc}</p>
                {st.status === 'running' && (
                  <div className="progress">
                    <span style={{ width: `${pct}%` }} />
                  </div>
                )}
              </div>
              <div className="stage-actions">{s.action}</div>
            </section>
          )
        })}
      </div>

      {busy && (
        <div className="notice info">
          実行中…{' '}
          <button onClick={() => abortRef.current?.abort()} style={{ marginLeft: '0.5rem' }}>
            中止
          </button>
        </div>
      )}

      <h2 style={{ fontSize: '1.05rem', marginTop: '2rem' }}>読み取った本</h2>
      <BookList
        entries={entries}
        onAdopt={onAdopt}
        onExclude={onExclude}
        onRestore={onRestore}
      />

      {entries.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.05rem', marginTop: '2rem' }}>書誌一覧を出力</h2>
          <ExportPanel entries={entries} />

          <p style={{ marginTop: '2rem' }}>
            <button onClick={onReset}>すべて消去してやり直す</button>
          </p>
        </>
      )}
    </div>
  )
}
