import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ScoredCandidate } from './types'
import { adoptCandidate, entriesFromIsbns, resolveEntries, resolveEntry } from './pipeline/stages'
import { clearEntries, forgetLegacySettings, listEntries, saveEntries } from './lib/db'
import { BookList } from './ui/BookList'
import { ExportPanel } from './ui/ExportPanel'
import { BarcodeScanner, type ScanResult } from './ui/BarcodeScanner'

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

export function App() {
  const [entries, setEntries] = useState<BookEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  // 既定はバーコード。APIキーが要らず課金も発生しないので、初見でも必ず動く
  const [inputMode, setInputMode] = useState<InputMode>('barcode')
  const [scanning, setScanning] = useState(false)
  /** 照合待ちの件数。走査は止めずに裏で進むので、進み具合だけ見せる */
  const [pending, setPending] = useState(0)
  const [retrying, setRetrying] = useState(false)

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
      .catch(() => setError('保存済みデータの読み込みに失敗しました。'))
  }, [])

  /** 1件を差し替える(無ければ追加)。走査中は次々に来るので保存も1件に絞る */
  const upsertEntry = useCallback((entry: BookEntry) => {
    const prev = entriesRef.current
    const next = prev.some((e) => e.id === entry.id)
      ? prev.map((e) => (e.id === entry.id ? entry : e))
      : [...prev, entry]
    entriesRef.current = next
    setEntries(next)
    saveEntries([entry]).catch(() => setError('保存に失敗しました。'))
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
          const resolved = await resolveEntry(current)
          if (entriesRef.current.some((e) => e.id === entry.id)) upsertEntry(resolved)
        })
        .catch(() => setError('書誌の照合に失敗しました。通信環境をご確認ください。'))
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
    setRetrying(true)
    try {
      await resolveEntries(entriesRef.current.filter(isUnresolved), { onEntry: upsertEntry })
    } catch {
      setError('再照合に失敗しました。通信環境をご確認ください。')
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

  const onReset = useCallback(() => {
    clearEntries().catch(() => undefined)
    entriesRef.current = []
    setEntries([])
    setError(null)
  }, [])

  return (
    <div className="app">
      <header className="masthead">
        <h1>本棚スキャナ</h1>
        <p>バーコードにカメラをかざすだけで、書誌情報を調べて蔵書一覧を作ります。</p>
      </header>

      {error && <div className="notice error">{error}</div>}

      {/*
        読み取り方式の切り替え。
        バーコードは1冊ずつ手に取る必要があるが課金ゼロで確実に読める。
        背表紙は棚にかざすだけで済むが、読み取りが曖昧で照合の当たり外れがある。
        どちらが良いかは状況で変わるので、利用者に選ばせる。
      */}
      <div className="modes" role="group" aria-label="読み取り方式">
        <button
          className="mode"
          aria-pressed={inputMode === 'barcode'}
          onClick={() => setInputMode('barcode')}
        >
          <span className="mode-title">バーコード</span>
          <span className="mode-note">かざすだけ・高精度／1冊ずつ</span>
        </button>
        <button
          className="mode"
          aria-pressed={inputMode === 'spine'}
          onClick={() => setInputMode('spine')}
        >
          <span className="mode-title">本棚の背表紙</span>
          <span className="mode-note">棚ごと／準備中</span>
        </button>
      </div>

      {inputMode === 'barcode' ? (
        scanning ? (
          <BarcodeScanner
            knownIsbns={knownIsbns}
            results={scanResults}
            onIsbn={onIsbn}
            onClose={() => setScanning(false)}
          />
        ) : (
          <section className="lead">
            <p>
              カメラを起動して、本の裏表紙のバーコードにかざしてください。
              読み取った端から書誌情報を調べて、下の一覧に並べます。ボタン操作は要りません。
            </p>
            <button className="primary" onClick={() => setScanning(true)}>
              カメラを起動
            </button>
            <p className="hint">カメラは HTTPS でのみ利用できます。</p>
          </section>
        )
      ) : (
        <section className="lead">
          <p>
            本棚にカメラをかざして背表紙から読み取る方式は準備中です。
            いまはバーコードをお使いください。
          </p>
        </section>
      )}

      {pending > 0 && <div className="notice info">書誌を照合しています… 残り {pending} 冊</div>}

      <h2 style={{ fontSize: '1.05rem', marginTop: '2rem' }}>書誌一覧</h2>

      {unresolved.length > 0 && pending === 0 && (
        <p className="hint">
          {unresolved.length} 冊は書誌が引けませんでした。
          <button onClick={() => void onRetry()} disabled={retrying} style={{ marginLeft: '0.5rem' }}>
            {retrying ? '再照合中…' : '再照合する'}
          </button>
        </p>
      )}

      <BookList entries={entries} onAdopt={onAdopt} onExclude={onExclude} onRestore={onRestore} />

      {entries.length > 0 && (
        <>
          <h2 style={{ fontSize: '1.05rem', marginTop: '2rem' }}>書き出す</h2>
          <ExportPanel entries={entries} />

          <p style={{ marginTop: '2rem' }}>
            <button onClick={onReset}>すべて消去してやり直す</button>
          </p>
        </>
      )}
    </div>
  )
}
