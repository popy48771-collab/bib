import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ScoredCandidate } from './types'
import { adoptCandidate, entriesFromIsbns, resolveEntries, resolveEntry } from './pipeline/stages'
import { clearEntries, deleteEntry, forgetLegacySettings, listEntries, saveEntries } from './lib/db'
import { BookList } from './ui/BookList'
import { ExportPanel } from './ui/ExportPanel'
import { BarcodeScanner, type ScanResult } from './ui/BarcodeScanner'
import { Notice, type NoticeKind } from './ui/Notice'
import { useOnline } from './ui/useOnline'

/** 読み取り方式。いずれも同じ書誌パイプラインへ合流する */
type InputMode = 'barcode' | 'spine'

/** 衝突しないID。crypto.randomUUID が無い環境向けの退避も持つ */
function newId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) return crypto.randomUUID()
  return `id-${Date.now()}-${Math.floor(Math.random() * 1e9)}`
}

/** まだ書誌が引けていない項目。再照合の対象になる */
function isUnresolved(entry: BookEntry): boolean {
  return entry.status === 'notFound' || entry.status === 'unverified'
}

/**
 * 照合を1回試したあとの状態に整える。
 *
 * resolveEntry はどのソースが落ちていても例外を投げずに返るため、
 * 通信が切れていると unverified のまま戻ってくる。そのままだと
 * 「まだ取得していない」と区別が付かず、一覧では取得中の表示が消えない。
 * 試したうえで入らなかったものは notFound として、次の行動を示せるようにする。
 */
function settle(entry: BookEntry): BookEntry {
  if (entry.resolved?.title || entry.pinned || entry.status === 'excluded') return entry
  return { ...entry, status: 'notFound' }
}

export function App() {
  const [entries, setEntries] = useState<BookEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 操作の結果。取得や削除の完了を伝える */
  const [flash, setFlash] = useState<{ kind: NoticeKind; message: string } | null>(null)
  // 既定はバーコード。APIキーが要らず課金も発生しないので、初見でも必ず動く
  const [inputMode, setInputMode] = useState<InputMode>('barcode')
  const [scanning, setScanning] = useState(false)
  /** 照合待ちの件数。走査は止めずに裏で進むので、進み具合だけ見せる */
  const [pending, setPending] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  const online = useOnline()

  /**
   * entries の最新値。
   *
   * 照合は1冊ずつ非同期に返ってくるので、state のクロージャを見ると
   * 古い配列を掴んで先に返った結果を消してしまう。書き込みは必ずここを通す。
   */
  const entriesRef = useRef<BookEntry[]>([])
  /** 照合の直列キュー。同時に何本も投げると Google Books に絞られる */
  const queueRef = useRef<Promise<unknown>>(Promise.resolve())

  // 起動時に前回の続きを復元する
  useEffect(() => {
    forgetLegacySettings()
    listEntries()
      .then((loaded) => {
        if (loaded.length === 0) return
        entriesRef.current = loaded
        setEntries(loaded)
      })
      .catch(() =>
        setError(
          '保存済みのデータを読み込めませんでした。ブラウザのプライベートモードを使っている場合は、通常のウィンドウで開いてください。',
        ),
      )
  }, [])

  /** 1件を差し替える(無ければ追加)。走査中は次々に来るので保存も1件に絞る */
  const upsertEntry = useCallback((entry: BookEntry) => {
    const prev = entriesRef.current
    const next = prev.some((e) => e.id === entry.id)
      ? prev.map((e) => (e.id === entry.id ? entry : e))
      : [...prev, entry]
    entriesRef.current = next
    setEntries(next)
    saveEntries([entry]).catch(() =>
      setError('この端末に保存できませんでした。空き容量を確認して、もう一度お試しください。'),
    )
  }, [])

  /**
   * バーコードを1冊読んだときの処理。
   *
   * まず ISBN だけの行を出し、書誌照合は裏で走らせる。
   * 「読めた」ことが即座に見えないと、同じ本を何度もかざすことになる。
   */
  const onIsbn = useCallback(
    (isbn: string) => {
      const entry = entriesFromIsbns([isbn], `scan-${newId()}`)[0]
      upsertEntry(entry)
      setPending((n) => n + 1)

      queueRef.current = queueRef.current
        .then(async () => {
          // 照合を待つ間に消去・除外されているかもしれないので取り直す
          const current = entriesRef.current.find((e) => e.id === entry.id)
          if (!current) return
          const resolved = settle(await resolveEntry(current))
          if (entriesRef.current.some((e) => e.id === entry.id)) upsertEntry(resolved)
        })
        .catch(() =>
          setError(
            '書誌情報を取得できませんでした。ネットワークの状態を確認して、もう一度お試しください。',
          ),
        )
        .finally(() => setPending((n) => n - 1))
    },
    [upsertEntry],
  )

  /** ISBN ごとの照合状況。スキャナの表示用 */
  const scanResults = useMemo(() => {
    const map = new Map<string, ScanResult>()
    for (const e of entries) {
      const isbn = e.resolved?.isbn13
      if (!isbn) continue
      const title = e.resolved?.title || undefined
      map.set(isbn, {
        state: title ? 'found' : e.status === 'notFound' ? 'missing' : 'looking',
        title,
      })
    }
    return map
  }, [entries])

  const knownIsbns = useMemo(() => new Set(scanResults.keys()), [scanResults])
  const unresolved = useMemo(() => entries.filter(isUnresolved), [entries])

  /** 引けなかったものを引き直す。通信が一時的に落ちていた場合の受け皿 */
  const onRetry = useCallback(async () => {
    setError(null)
    setFlash(null)
    setRetrying(true)
    try {
      const done = await resolveEntries(entriesRef.current.filter(isUnresolved), {
        onEntry: (e) => upsertEntry(settle(e)),
      })
      const still = done.filter(isUnresolved).length
      setFlash(
        still === 0
          ? { kind: 'success', message: `${done.length} 件の書誌情報を取得しました。` }
          : {
              kind: 'info',
              message: `${done.length} 件のうち ${still} 件は書誌情報が見つかりませんでした。ISBNを確認して、もう一度読み取ってください。`,
            },
      )
    } catch {
      setError(
        '書誌情報を取得できませんでした。ネットワークの状態を確認して、もう一度お試しください。',
      )
    } finally {
      setRetrying(false)
    }
  }, [upsertEntry])

  // ── 手動操作 ────────────────────────────────────────
  const patchEntry = useCallback(
    (entryId: string, fn: (entry: BookEntry) => BookEntry) => {
      const found = entriesRef.current.find((e) => e.id === entryId)
      if (found) upsertEntry(fn(found))
    },
    [upsertEntry],
  )

  const onAdopt = useCallback(
    (entryId: string, candidate: ScoredCandidate) => {
      // 手動で選んだものは pinned にして、以降の自動処理で上書きさせない
      patchEntry(entryId, (e) => ({
        ...adoptCandidate(e, candidate),
        status: 'confirmed',
        pinned: true,
        conflicts: undefined,
      }))
    },
    [patchEntry],
  )

  const onExclude = useCallback(
    (entryId: string) => patchEntry(entryId, (e) => ({ ...e, status: 'excluded' })),
    [patchEntry],
  )

  const onRestore = useCallback(
    (entryId: string) =>
      patchEntry(entryId, (e) => ({ ...e, status: e.resolved?.title ? 'needsReview' : 'unverified' })),
    [patchEntry],
  )

  /**
   * 1件を削除する。
   * state から外すだけでは次回起動時に IndexedDB から復活するので、
   * 保存側からも消す。
   */
  const onDelete = useCallback((entryId: string) => {
    entriesRef.current = entriesRef.current.filter((e) => e.id !== entryId)
    setEntries(entriesRef.current)
    deleteEntry(entryId).catch(() =>
      setError('削除した内容を保存できませんでした。もう一度お試しください。'),
    )
    setFlash({ kind: 'success', message: '1 件を一覧から削除しました。' })
  }, [])

  const onReset = useCallback(() => {
    clearEntries().catch(() => undefined)
    entriesRef.current = []
    setEntries([])
    setError(null)
    setConfirmingClear(false)
    setFlash({ kind: 'success', message: '保存されていた蔵書データをすべて削除しました。' })
  }, [])

  /** 書誌一覧へ移動する。画面は1枚なので見出しへスクロールさせる */
  const goToLibrary = useCallback(() => {
    document.getElementById('library')?.scrollIntoView({ block: 'start' })
  }, [])

  return (
    <div className="app">
      <header className="site-header">
        <div className="container">
          {/* サービス名のみ。ロゴやキャッチコピーは置かない */}
          <p className="site-name">本棚スキャナ</p>
        </div>
      </header>

      <main className="main container">
        <div className="stack">
          {/* 1. 見出し / 2. 短い説明。以降はスキャナ側が続ける */}
          <div>
            <h1 className="page-title">
              {inputMode === 'barcode' ? '本のバーコードを読み取る' : '背表紙から読み取る'}
            </h1>
            <p className="page-lead">
              {inputMode === 'barcode'
                ? '裏表紙の、978または979から始まるバーコードをカメラに収めてください。読み取った本から順に書誌情報を調べ、下の一覧に並べます。'
                : '本棚にカメラをかざして背表紙から読み取る方式は準備中です。'}
            </p>
          </div>

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

          {inputMode === 'barcode' ? (
            scanning ? (
              <BarcodeScanner
                knownIsbns={knownIsbns}
                results={scanResults}
                registeredCount={entries.length}
                onIsbn={onIsbn}
                onClose={() => setScanning(false)}
                onOpenLibrary={goToLibrary}
              />
            ) : (
              /* 3〜6. カメラ表示領域 → 現在の状態 → 主操作 → 登録済み件数と一覧へのリンク */
              <div className="stack">
                <div className="scanner-view">
                  <p className="scanner-placeholder">カメラは停止しています</p>
                </div>

                <p className="scanner-status" role="status">
                  <span className="scanner-status__label">カメラは停止しています</span>
                  <span className="scanner-status__detail">
                    「カメラを開始」を押すと読み取りを始めます。カメラは HTTPS でのみ利用できます。
                  </span>
                </p>

                <div className="actions">
                  <button
                    type="button"
                    className="button button--primary button--block"
                    onClick={() => setScanning(true)}
                  >
                    カメラを開始
                  </button>
                </div>

                <p className="note">
                  登録済み: {entries.length} 件{' '}
                  <button type="button" className="button button--compact" onClick={goToLibrary}>
                    書誌一覧へ移動
                  </button>
                </p>
              </div>
            )
          ) : (
            <p className="note">いまはバーコードをお使いください。</p>
          )}

          {/*
            読み取り方式の切り替え。
            バーコードは1冊ずつ手に取る必要があるが課金ゼロで確実に読める。
            背表紙は棚にかざすだけで済むが、読み取りが曖昧で照合の当たり外れがある。
            どちらが良いかは状況で変わるので、利用者に選ばせる。
          */}
          <section className="section">
            <h2 className="section-title">読み取り方式を変える</h2>
            <ul className="choice-list">
              {(
                [
                  {
                    id: 'barcode' as const,
                    title: 'バーコード',
                    note: 'かざすだけで1冊ずつ読み取ります。APIキーは不要で、費用もかかりません。',
                  },
                  {
                    id: 'spine' as const,
                    title: '本棚の背表紙',
                    note: '棚ごと読み取ります。準備中です。',
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

          <section className="section" id="library">
            <h2 className="section-title">書誌一覧</h2>

            <div className="stack">
              {pending > 0 && (
                <p className="scanner-status" role="status">
                  <span className="scanner-status__label">書誌情報を取得しています</span>
                  <span className="scanner-status__detail">残り {pending} 件</span>
                </p>
              )}

              {unresolved.length > 0 && pending === 0 && (
                <Notice
                  kind="info"
                  title="書誌情報が見つかっていません"
                  actions={
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={() => void onRetry()}
                      disabled={retrying || !online}
                    >
                      {retrying ? '取得しています' : '書誌情報を取得し直す'}
                    </button>
                  }
                >
                  {unresolved.length}{' '}
                  件の書誌情報が取得できていません。通信が途切れていた場合は、取得し直すと入ることがあります。
                </Notice>
              )}

              <BookList
                entries={entries}
                onAdopt={onAdopt}
                onExclude={onExclude}
                onRestore={onRestore}
                onDelete={onDelete}
              />
            </div>
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
                      この端末に保存されている蔵書データ {entries.length}{' '}
                      件をすべて削除します。削除すると元に戻せません。必要な場合は先に書き出してください。
                    </p>
                    <div className="actions">
                      <button type="button" className="button button--danger" onClick={onReset}>
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
            読み取った蔵書データは、すべて利用者の端末内に保存されます。当サイトの提供者へ送信されることはありません。
          </p>
          <p>
            このサイトは個人が作成したもので、国立国会図書館の公式サービスではありません。行政機関が提供するサービスでもありません。
          </p>
        </div>
      </footer>
    </div>
  )
}
