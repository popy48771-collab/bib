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
import {
  loadSettings,
  saveSettings,
  listEntries,
  saveEntries,
  clearEntries,
  deleteEntry,
} from './lib/db'
import { SettingsPanel } from './ui/SettingsPanel'
import { BookList } from './ui/BookList'
import { ExportPanel } from './ui/ExportPanel'
import { BarcodeScanner } from './ui/BarcodeScanner'
import { ChatImportPanel } from './ui/ChatImportPanel'
import { Notice, type NoticeKind } from './ui/Notice'
import { useOnline } from './ui/useOnline'
import type { ExtractedSpine } from './sources/vlm'

/** 読み取り方式。いずれも同じ書誌パイプラインへ合流する */
type InputMode = 'barcode' | 'spine' | 'chat'

/** 画面。ヘッダーのナビゲーションと対応する */
type View = 'read' | 'library' | 'settings'

interface StageState {
  status: StageStatus
  message?: string
  done?: number
  total?: number
}

/** 段階1回分の途中失敗を集める入れ物 */
interface StageFailures {
  count: number
  first?: unknown
}

const INITIAL_STAGES: Record<StageId, StageState> = {
  extract: { status: 'idle' },
  googleBooks: { status: 'idle' },
  ndl: { status: 'idle' },
  openbd: { status: 'idle' },
}

const VIEW_LABEL: Record<View, string> = {
  read: '読み取り',
  library: '蔵書一覧',
  settings: '設定',
}

/** 読み取り方式ごとの見出しと説明。画面の先頭2行になる */
const MODE_HEADING: Record<InputMode, { title: string; lead: string }> = {
  barcode: {
    title: '本のバーコードを読み取る',
    lead: '裏表紙の、978または979から始まるバーコードをカメラに収めてください。',
  },
  chat: {
    title: 'チャットAIで読み取る',
    lead: 'お使いのチャットAIに本棚の写真を読み取らせ、その結果をこの画面に貼り付けます。',
  },
  spine: {
    title: '背表紙の写真から読み取る',
    lead: '本棚の写真を選ぶと、背表紙の書名と著者を読み取ります。APIキーの登録が必要です。',
  },
}

/** 実行中に出す文。処理の内容をそのまま述べる */
const STAGE_RUNNING_TEXT: Record<StageId, string> = {
  extract: '写真を読み取っています',
  googleBooks: '書誌情報を取得しています',
  ndl: '国立国会図書館サーチに問い合わせています',
  openbd: '出版情報を補っています',
}

/** 衝突しないID。crypto.randomUUID が無い環境向けの退避も持つ */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/**
 * 例外を利用者向けの文にする。
 * 「何が起きたか。次に何をすればよいか。」の順で組み立てる。
 */
function describeError(err: unknown, online: boolean): string {
  if (!online) {
    return 'ネットワークに接続されていません。接続を確認して、もう一度実行してください。'
  }
  const message = err instanceof Error ? err.message : ''
  const name = err instanceof Error ? err.name : ''

  // fetch はネットワーク到達不能を TypeError で投げる
  if (err instanceof TypeError || /Failed to fetch|NetworkError|load failed/i.test(message)) {
    return '書誌データベースに接続できませんでした。ネットワークの状態を確認して、もう一度実行してください。'
  }
  if (name === 'RateLimitError') {
    return '書誌データベースの利用制限に達しました。しばらく待ってから、もう一度実行してください。'
  }
  if (name === 'NdlNotConfiguredError' || name === 'VlmNotConfiguredError') {
    return `${message.replace(/。$/, '')}。`
  }
  if (message) {
    return `${message.replace(/。$/, '')}。しばらく待ってから、もう一度実行してください。`
  }
  return '処理に失敗しました。しばらく待ってから、もう一度実行してください。'
}

export function App() {
  const [settings, setSettings] = useState<Settings>(() => loadSettings())
  const [entries, setEntries] = useState<BookEntry[]>([])
  const [stages, setStages] = useState<Record<StageId, StageState>>(INITIAL_STAGES)
  const [error, setError] = useState<string | null>(null)
  /** 操作の結果。成功・注意のいずれも読み上げ対象にする */
  const [flash, setFlash] = useState<{ kind: NoticeKind; message: string } | null>(null)
  const [view, setView] = useState<View>('read')
  // 既定はバーコード。APIキーが要らず課金も発生しないので、初見でも必ず動く
  const [inputMode, setInputMode] = useState<InputMode>('barcode')
  const [scanning, setScanning] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const abortRef = useRef<AbortController | null>(null)
  const online = useOnline()

  // 起動時に前回の続きを復元する。段階を分けた以上、中断からの再開は必須
  useEffect(() => {
    listEntries()
      .then((loaded) => {
        if (loaded.length > 0) setEntries(loaded)
      })
      .catch(() =>
        setError(
          '保存済みのデータを読み込めませんでした。ブラウザのプライベートモードを使っている場合は、通常のウィンドウで開いてください。',
        ),
      )
  }, [])

  const updateSettings = useCallback((next: Settings) => {
    setSettings(next)
    saveSettings(next)
  }, [])

  /** 変更を state と IndexedDB の両方に反映する */
  const commit = useCallback((next: BookEntry[]) => {
    setEntries(next)
    saveEntries(next).catch(() =>
      setError('この端末に保存できませんでした。空き容量を確認して、もう一度お試しください。'),
    )
  }, [])

  const setStage = useCallback((id: StageId, patch: Partial<StageState>) => {
    setStages((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }))
  }, [])

  const makeContext = useCallback(
    (id: StageId, controller: AbortController, failures: StageFailures): StageContext => ({
      signal: controller.signal,
      onProgress: (done, total) => setStage(id, { done, total }),
      onEntryError: (err) => {
        failures.count += 1
        if (failures.first === undefined) failures.first = err
      },
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
    async (
      id: StageId,
      fn: (ctx: StageContext) => Promise<BookEntry[]>,
      after?: (next: BookEntry[]) => void,
    ) => {
      setError(null)
      setFlash(null)
      const controller = new AbortController()
      abortRef.current = controller
      setStage(id, { status: 'running', done: 0, total: entries.length, message: undefined })
      const failures: StageFailures = { count: 0 }

      try {
        const next = await fn(makeContext(id, controller, failures))
        commit(next)
        setStage(id, { status: 'done' })
        after?.(next)
        // 段階そのものは完走しても、個別の取得に失敗していれば黙っていない
        if (failures.count > 0) {
          setError(
            `${failures.count} 件の取得に失敗しました。${describeError(failures.first, online)}`,
          )
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setStage(id, { status: 'idle', message: undefined })
          setFlash({ kind: 'info', message: '処理を中止しました。' })
          return
        }
        const message = describeError(err, online)
        setStage(id, { status: 'error', message })
        setError(message)
      } finally {
        abortRef.current = null
      }
    },
    [entries.length, makeContext, commit, setStage, online],
  )

  /** 照合後の結果を数えて、次に何をすべきかを伝える */
  const reportLookup = useCallback((next: BookEntry[]) => {
    const found = next.filter((e) => e.status === 'confirmed' || e.status === 'conflict').length
    const missing = next.filter(
      (e) => e.status === 'notFound' || e.status === 'unverified',
    ).length
    if (missing === 0) {
      setFlash({
        kind: 'success',
        message: `書誌情報を一覧に追加しました。書誌情報あり ${found} 件。`,
      })
      return
    }
    setFlash({
      kind: 'info',
      message: `書誌情報あり ${found} 件、書誌情報なし ${missing} 件。見つからなかったものは、一覧で内容を確認してください。国立国会図書館サーチと突合すると見つかる場合があります。`,
    })
  }, [])

  // ── 段階0: 写真の取り込みと読み取り ──────────────────
  const onPickPhotos = useCallback(
    async (files: FileList | null) => {
      if (!files || files.length === 0) return
      setError(null)
      setFlash(null)

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
        setFlash({
          kind: 'success',
          message: `${collected.length} 件を一覧に追加しました。続けて「書誌情報を取得」を実行してください。`,
        })
        setView('library')
      } catch (err) {
        if (err instanceof DOMException && err.name === 'AbortError') {
          setStage('extract', { status: 'idle' })
          setFlash({ kind: 'info', message: '処理を中止しました。' })
          return
        }
        const message = describeError(err, online)
        setStage('extract', { status: 'error', message })
        setError(message)
      } finally {
        abortRef.current = null
      }
    },
    [entries, settings, commit, setStage, online],
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
      setFlash({
        kind: 'success',
        message: `ISBN ${isbns.length} 件を一覧に追加しました。続けて「書誌情報を取得」を実行してください。`,
      })
      setView('library')
    },
    [entries, commit, setStage],
  )

  /**
   * チャットAIの結果を取り込む。
   * 書名は背表紙経路と同じく未確認として入れ、ISBN はバーコード経路と同じ扱いにする。
   * どちらも次段の書誌照合で実在確認される。
   */
  const onChatImport = useCallback(
    (spines: ExtractedSpine[], isbns: string[]) => {
      setError(null)
      const batchId = newId()
      const added = [
        ...entriesFromExtraction(batchId, spines, batchId),
        ...entriesFromIsbns(isbns, `${batchId}-isbn`),
      ]
      if (added.length === 0) return
      commit([...entries, ...added])
      setStage('extract', { status: 'done' })
      setStages((p) => ({
        ...p,
        googleBooks: { status: 'idle' },
        ndl: { status: 'idle' },
        openbd: { status: 'idle' },
      }))
      setFlash({
        kind: 'success',
        message: `${added.length} 件を一覧に追加しました。続けて「書誌情報を取得」を実行してください。`,
      })
      setView('library')
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

  /**
   * 1件を削除する。
   * state から外すだけでは次回起動時に IndexedDB から復活するので、
   * 保存側からも消す。
   */
  const onDelete = useCallback(
    (entryId: string) => {
      setEntries((prev) => prev.filter((e) => e.id !== entryId))
      deleteEntry(entryId).catch(() =>
        setError('削除した内容を保存できませんでした。もう一度お試しください。'),
      )
      setFlash({ kind: 'success', message: '1 件を一覧から削除しました。' })
    },
    [],
  )

  const onReset = useCallback(() => {
    clearEntries().catch(() => undefined)
    setEntries([])
    setStages(INITIAL_STAGES)
    setError(null)
    setConfirmingClear(false)
    setFlash({ kind: 'success', message: '保存されていた蔵書データをすべて削除しました。' })
  }, [])

  const busy = Object.values(stages).some((s) => s.status === 'running')
  const ndlReady = isNdlConfigured(settings.ndlProxyUrl)
  const vlmReady = isVlmConfigured(settings)
  const hasIsbn = useMemo(() => entries.some((e) => e.resolved?.isbn13), [entries])
  const runningStage = (Object.keys(stages) as StageId[]).find(
    (id) => stages[id].status === 'running',
  )

  const goTo = useCallback((next: View) => {
    setView(next)
    setFlash(null)
  }, [])

  /**
   * 全画面共通の通知。各画面の見出しの直後に置く。
   * 見出しより前に出すと、どの画面にいるのかが分からなくなる。
   */
  const notices = (
    <>
      {!online && (
        <Notice kind="error" title="オフライン" live="status">
          ネットワークに接続されていません。バーコードの読み取りはこのまま使えますが、書誌情報の取得は接続後に実行してください。
        </Notice>
      )}

      {error && (
        <Notice kind="error" live="alert">
          {error}
        </Notice>
      )}

      {flash && (
        <Notice kind={flash.kind} live="status">
          {flash.message}
        </Notice>
      )}
    </>
  )

  return (
    <div className="app">
      <header className="site-header">
        <div className="container">
          {/* サービス名のみ。ロゴやキャッチコピーは置かない */}
          <p className="site-name">本棚スキャナ</p>
        </div>
      </header>

      <nav className="site-nav" aria-label="画面の切り替え">
        <div className="container">
          <ul>
            {(Object.keys(VIEW_LABEL) as View[]).map((v) => (
              <li key={v}>
                <button
                  type="button"
                  aria-current={view === v ? 'page' : undefined}
                  onClick={() => goTo(v)}
                >
                  {VIEW_LABEL[v]}
                </button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      <main className="main container">
        <div className="stack">
          {view === 'read' && (
            <>
              {/* 1. 見出し / 2. 短い説明。以降は各方式の部品が続ける */}
              <div>
                <h1 className="page-title">{MODE_HEADING[inputMode].title}</h1>
                <p className="page-lead">{MODE_HEADING[inputMode].lead}</p>
              </div>

              {notices}

              {inputMode === 'barcode' && (
                <BarcodeScanner
                  active={scanning}
                  knownIsbns={knownIsbns}
                  registeredCount={entries.length}
                  onStart={() => setScanning(true)}
                  onStop={() => setScanning(false)}
                  onDone={onScanned}
                  onOpenLibrary={() => goTo('library')}
                  disabled={busy}
                />
              )}

              {inputMode === 'chat' && <ChatImportPanel onImport={onChatImport} disabled={busy} />}

              {inputMode === 'spine' && (
                <div className="stack">
                  {!vlmReady && (
                    <Notice kind="info" title="APIキーが未登録です">
                      この方式は画像認識APIを使うため、利用者ご自身のAPIキーが必要です。設定画面で登録するか、バーコードまたはチャットAIの方式をお使いください。
                    </Notice>
                  )}
                  <div>
                    {/* label を押すと file input が開く。見た目はボタンに揃える */}
                    <label className="button button--primary" aria-disabled={!vlmReady || busy}>
                      写真を選ぶ
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
                  </div>
                  <p className="note">
                    棚1段を画面いっぱいに写してください。棚全体を引いて撮ると、背表紙の文字が小さくなり読み取れません。
                  </p>
                </div>
              )}

              {stages.extract.status === 'running' && (
                <p className="scanner-status" role="status">
                  <span className="scanner-status__label">
                    {STAGE_RUNNING_TEXT.extract}
                    {stages.extract.total
                      ? `（${stages.extract.done ?? 0}/${stages.extract.total}枚）`
                      : ''}
                  </span>
                </p>
              )}

              <section className="section">
                <h2 className="section-title">読み取り方式を変える</h2>
                <ul className="choice-list">
                  {(
                    [
                      {
                        id: 'barcode' as const,
                        title: 'バーコード',
                        note: '1冊ずつ読み取ります。APIキーは不要で、費用もかかりません。',
                      },
                      {
                        id: 'chat' as const,
                        title: 'チャットAI',
                        note: 'お使いのチャットAIに棚ごと読み取らせます。貼り付けは手作業です。',
                      },
                      {
                        id: 'spine' as const,
                        title: '背表紙の写真',
                        note: vlmReady
                          ? '棚ごと自動で読み取ります。画像認識APIの利用料がかかります。'
                          : '棚ごと自動で読み取ります。APIキーの登録が必要です。',
                      },
                    ] satisfies { id: InputMode; title: string; note: string }[]
                  ).map((m) => (
                    <li key={m.id}>
                      <label className="choice">
                        <input
                          type="radio"
                          name="input-mode"
                          value={m.id}
                          checked={inputMode === m.id}
                          disabled={busy}
                          onChange={() => {
                            setInputMode(m.id)
                            setScanning(false)
                          }}
                        />
                        <span className="choice-body">
                          <span className="choice-title">{m.title}</span>
                          <span className="choice-note">{m.note}</span>
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
              </section>
            </>
          )}

          {view === 'library' && (
            <>
              <div>
                <h1 className="page-title">蔵書一覧</h1>
                <p className="page-lead">
                  読み取った本の一覧です。データはこの端末の中だけに保存されます。
                </p>
              </div>

              {notices}

              {entries.length > 0 && (
                <section className="section">
                  <h2 className="section-title">書誌情報の取得</h2>
                  <div className="panel stack">
                    <div className="actions">
                      <button
                        type="button"
                        className="button button--primary"
                        disabled={busy || !online}
                        onClick={() =>
                          void runStage(
                            'googleBooks',
                            (ctx) => runGoogleBooksStage(entries, ctx),
                            reportLookup,
                          )
                        }
                      >
                        書誌情報を取得
                      </button>
                      <button
                        type="button"
                        className="button button--neutral"
                        disabled={busy || !online || !ndlReady}
                        onClick={() => void runStage('ndl', (ctx) => runNdlStage(entries, ctx))}
                      >
                        国立国会図書館サーチと突合
                      </button>
                      <button
                        type="button"
                        className="button button--neutral"
                        disabled={busy || !online || !hasIsbn}
                        onClick={() =>
                          void runStage('openbd', (ctx) => runOpenBdStage(entries, ctx))
                        }
                      >
                        出版情報を補う
                      </button>
                    </div>

                    <p className="note">
                      ISBN が判っているものは openBD と Google Books で照合します。突合は一次結果を上書きせず、差分の表示と欠けた項目の補完だけを行います。
                      {!ndlReady &&
                        ' 国立国会図書館サーチとの突合には、設定画面での中継URLの登録が必要です。'}
                    </p>

                    {runningStage && (
                      <div role="status">
                        <p className="note">
                          {STAGE_RUNNING_TEXT[runningStage]}
                          {stages[runningStage].total
                            ? `（${stages[runningStage].done ?? 0}/${stages[runningStage].total}件）`
                            : ''}
                        </p>
                        <div
                          className="progress"
                          role="progressbar"
                          aria-label={STAGE_RUNNING_TEXT[runningStage]}
                          aria-valuemin={0}
                          aria-valuemax={stages[runningStage].total ?? 0}
                          aria-valuenow={stages[runningStage].done ?? 0}
                        >
                          <span
                            style={{
                              width: `${
                                stages[runningStage].total
                                  ? Math.round(
                                      ((stages[runningStage].done ?? 0) /
                                        stages[runningStage].total!) *
                                        100,
                                    )
                                  : 0
                              }%`,
                            }}
                          />
                        </div>
                        <div className="actions">
                          <button
                            type="button"
                            className="button button--compact"
                            onClick={() => abortRef.current?.abort()}
                          >
                            処理を中止
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                </section>
              )}

              <section className="section">
                <h2 className="section-title">登録された本</h2>
                <BookList
                  entries={entries}
                  onAdopt={onAdopt}
                  onExclude={onExclude}
                  onRestore={onRestore}
                  onDelete={onDelete}
                  onOpenRead={() => goTo('read')}
                />
              </section>

              {entries.length > 0 && (
                <>
                  <section className="section">
                    <h2 className="section-title">書き出し</h2>
                    <ExportPanel entries={entries} />
                  </section>

                  <section className="section">
                    <h2 className="section-title">保存データの削除</h2>
                    {confirmingClear ? (
                      <div className="confirm" role="group" aria-label="全件削除の確認">
                        <p>
                          この端末に保存されている蔵書データ {entries.length} 件をすべて削除します。削除すると元に戻せません。必要な場合は先に書き出してください。
                        </p>
                        <div className="actions">
                          <button
                            type="button"
                            className="button button--danger"
                            onClick={onReset}
                          >
                            すべて削除する
                          </button>
                          <button
                            type="button"
                            className="button button--secondary"
                            onClick={() => setConfirmingClear(false)}
                          >
                            削除しない
                          </button>
                        </div>
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="button button--danger"
                        onClick={() => setConfirmingClear(true)}
                      >
                        蔵書データをすべて削除
                      </button>
                    )}
                  </section>
                </>
              )}
            </>
          )}

          {view === 'settings' && (
            <>
              <div>
                <h1 className="page-title">設定</h1>
                <p className="page-lead">
                  入力した内容は、この端末（localStorage）にのみ保存されます。
                </p>
              </div>

              {notices}

              <SettingsPanel settings={settings} onChange={updateSettings} />
            </>
          )}
        </div>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>書誌情報：国立国会図書館サーチ、openBD、Google Books</p>
          <ul>
            <li>
              <a href="https://github.com/popy48771-collab/bib#readme">利用上の注意</a>
            </li>
            <li>
              <a href="https://github.com/popy48771-collab/bib#readme">データの取り扱い</a>
            </li>
          </ul>
          <p>
            読み取った蔵書データ・写真・APIキーは、すべて利用者の端末内に保存されます。当サイトの提供者へ送信されることはありません。
          </p>
          <p>
            このサイトは個人が作成したもので、国立国会図書館の公式サービスではありません。行政機関が提供するサービスでもありません。
          </p>
        </div>
      </footer>
    </div>
  )
}
