import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ExtractedSpine, ScoredCandidate } from './types'
import {
  adoptCandidate,
  entriesFromExtraction,
  entriesFromIsbns,
  nearExactMatches,
  resolveEntries,
  resolveEntry,
} from './pipeline/stages'
import { spineFromText, spineRawText } from './lib/spine/parse'
import {
  clearAll,
  deleteEntry,
  deletePhoto,
  forgetLegacySettings,
  listEntries,
  savePhoto,
  saveEntries,
} from './lib/db'
import { BookList, needsAttention } from './ui/BookList'
import { ExportPanel } from './ui/ExportPanel'
import { BarcodeScanner, type ScanResult } from './ui/BarcodeScanner'
import { SpineScanner, type SpineResult } from './ui/SpineScanner'
import { useSpineScan } from './ui/useSpineScan'
import type { CroppedImage } from './lib/spine/capture'
import { Notice, type NoticeKind } from './ui/Notice'
import { useOnline } from './ui/useOnline'
import { isDebugEnabled } from './ui/debug'
import { spineDiagnostics } from './lib/spine/diagnostics'

/**
 * 実機診断の画面。`?debug=1` のときしか読み込まない。
 *
 * 遅延 import にしてあるので、通常の利用者には一切降ってこない。
 */
const SpineDiagnosticsPanel = lazy(() => import('./ui/SpineDiagnosticsPanel'))

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

/** 読み取り方式ごとの見出しと説明 */
const MODE_TEXT: Record<InputMode, { title: string; lead: string }> = {
  barcode: {
    title: '本のバーコードを読み取る',
    lead: '裏表紙の、978または979から始まるバーコードをカメラに収めてください。読み取った本から順に書誌情報を調べ、下の一覧に並べます。',
  },
  spine: {
    title: '本棚の背表紙を読み取る',
    lead: 'カメラを横向きにして、棚の一段が枠いっぱいに収まる距離で構え、少し止めてください。1枚から20〜30冊まとめて読み取り、書誌情報を調べて下の一覧に並べます。',
  },
}

export function App() {
  const [entries, setEntries] = useState<BookEntry[]>([])
  const [error, setError] = useState<string | null>(null)
  /** 操作の結果。取得や削除の完了を伝える */
  const [flash, setFlash] = useState<{ kind: NoticeKind; message: string } | null>(null)
  // 既定はバーコード。読み取りが確実で、OCR の資産を取りに行かずに済む
  const [inputMode, setInputMode] = useState<InputMode>('barcode')
  const [scanning, setScanning] = useState(false)
  /** 1回のカメラ起動。スキャナ画面が「この読み取りで追加した本」を出すのに使う */
  const [sessionId, setSessionId] = useState('')
  /** 照合待ちの件数。走査は止めずに裏で進むので、進み具合だけ見せる */
  const [pending, setPending] = useState(0)
  const [retrying, setRetrying] = useState(false)
  const [confirmingClear, setConfirmingClear] = useState(false)
  /** バーコードで確定させようとしている行。新しい行は増やさない */
  const [rescueEntryId, setRescueEntryId] = useState<string | null>(null)
  /** 一覧を「手を入れる必要がある行」だけに絞るか */
  const [onlyAttention, setOnlyAttention] = useState(false)
  /** 読み取りと照合がすべて終わったか。書誌一覧の中で伝える */
  const [finished, setFinished] = useState(false)
  const [confirmingBulk, setConfirmingBulk] = useState(false)
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
   * まとめて差し替える。棚1枚ぶんを一度に確定させるときに使う。
   * 1件ずつ upsertEntry を回すと保存の往復が件数ぶん起きる。
   */
  const upsertMany = useCallback((changed: BookEntry[]) => {
    if (changed.length === 0) return
    const byId = new Map(changed.map((e) => [e.id, e]))
    const next = entriesRef.current.map((e) => byId.get(e.id) ?? e)
    entriesRef.current = next
    setEntries(next)
    saveEntries(changed).catch(() =>
      setError('この端末に保存できませんでした。空き容量を確認して、もう一度お試しください。'),
    )
  }, [])

  /**
   * 1冊を書誌照合の待ち行列へ積む。
   *
   * バーコードも背表紙も、行を先に一覧へ出して照合は裏で進める。
   * 「読めた」ことが即座に見えないと、同じ本を何度もかざすことになる。
   * 照合は直列で流す。同時に何本も投げると Google Books に絞られる。
   */
  const enqueueResolve = useCallback(
    (entryId: string) => {
      setPending((n) => n + 1)
      queueRef.current = queueRef.current
        .then(async () => {
          // 照合を待つ間に消去・除外されているかもしれないので取り直す
          const current = entriesRef.current.find((e) => e.id === entryId)
          if (!current) return
          const resolved = settle(await resolveEntry(current))
          if (entriesRef.current.some((e) => e.id === entryId)) upsertEntry(resolved)
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

  /**
   * バーコードを1冊読んだときの処理。
   *
   * 救済中(背表紙で読めなかった行にバーコードを結び付ける)なら、
   * 新しい行を作らずその行へ ISBN を入れて引き直す。
   */
  const onIsbn = useCallback(
    (isbn: string) => {
      if (rescueEntryId) {
        const target = entriesRef.current.find((e) => e.id === rescueEntryId)
        setRescueEntryId(null)
        if (!target) return
        upsertEntry({
          ...target,
          // 読み取ったクロップと OCR の文字は残す。どの本を撮ったかの記録なので
          resolved: { title: '', authors: [], isbn13: isbn, source: 'barcode' },
          provenance: { isbn13: 'barcode' },
          // 書名検索で出た候補は別の本のものかもしれない。利用者が
          // 「この本のバーコードはこれ」と言った以上、当てにしない
          candidates: {},
          conflicts: undefined,
          status: 'unverified',
          pinned: false,
        })
        enqueueResolve(target.id)
        setFlash({ kind: 'info', message: 'ISBNを読み取りました。書誌情報を取得しています。' })
        return
      }

      const entry = entriesFromIsbns([isbn], `scan-${newId()}`)[0]
      upsertEntry({ ...entry, scanSessionId: sessionId })
      enqueueResolve(entry.id)
    },
    [enqueueResolve, rescueEntryId, sessionId, upsertEntry],
  )

  /**
   * 背表紙を1冊読んだときの処理。1枚のコマから20〜30回呼ばれる。
   *
   * sameAs が入っているときは、直前に読んだのと同じ背表紙である。
   * 行を増やさず、読みが良くなったときだけ差し替える。
   */
  const onSpine = useCallback(
    (spine: ExtractedSpine, crop: CroppedImage | null, sameAs?: string): string | null => {
      const existing = sameAs ? entriesRef.current.find((e) => e.id === sameAs) : undefined
      if (existing) {
        const observed: BookEntry = {
          ...existing,
          observationCount: (existing.observationCount ?? 1) + 1,
        }
        // 確定済み・手動確定・除外には自動処理で触らない
        const touchable =
          !existing.pinned && existing.status !== 'confirmed' && existing.status !== 'excluded'
        const better = spine.confidence > (existing.extractConfidence ?? 0)

        if (touchable && better) {
          upsertEntry({
            ...observed,
            rawText: spineRawText(spine),
            extracted: { title: spine.title, authors: spine.authors, publisher: spine.publisher },
            extractConfidence: spine.confidence,
          })
          enqueueResolve(existing.id)
        } else {
          upsertEntry(observed)
        }
        return existing.id
      }

      const photoId = `spine-${newId()}`
      const created = entriesFromExtraction(photoId, [spine], photoId)[0]
      const entry: BookEntry = { ...created, scanSessionId: sessionId, observationCount: 1 }
      upsertEntry(entry)

      // 画像は候補を選ぶときの手掛かりとして残す。
      // 容量不足などで保存できなくても、書誌一覧の作成は止めない
      if (crop) {
        savePhoto({
          id: photoId,
          blob: crop.blob,
          width: crop.width,
          height: crop.height,
          createdAt: Date.now(),
        }).catch(() => undefined)
      }

      enqueueResolve(entry.id)
      return entry.id
    },
    [enqueueResolve, sessionId, upsertEntry],
  )

  const spineScan = useSpineScan({ active: inputMode === 'spine' && scanning, onSpine })

  /*
   * 診断の記録を入れるかどうかは URL で決まる。
   * 付いていないあいだは、記録の関数がすぐ返るので実行時の費用は無い。
   */
  const debugging = useMemo(() => isDebugEnabled(), [])
  useEffect(() => {
    spineDiagnostics.setEnabled(debugging)
    return () => spineDiagnostics.setEnabled(false)
  }, [debugging])

  /** 読み取りと照合を合わせた残り。終わったことを伝えるのに使う */
  const totalPending = pending + spineScan.state.pending
  const hadPendingRef = useRef(false)

  /*
   * すべて終わったことを伝える。
   *
   * カメラを閉じても処理は続くので、黙って終わると「終わったのか、
   * 途中で止まったのか」が判らない。
   *
   * 画面上部の flash ではなく書誌一覧の中に出す。カメラを閉じた利用者は
   * 一覧を見に来ているので、上部に出しても視界に入らない。
   * 読み取り中は出さない(1枚ごとに出ると、次の棚へ動かしている最中に点滅する)。
   */
  useEffect(() => {
    if (totalPending > 0) {
      hadPendingRef.current = true
      setFinished(false)
      return
    }
    if (!hadPendingRef.current || scanning) return
    hadPendingRef.current = false
    setFinished(true)
  }, [totalPending, scanning])

  /** ISBN ごとの照合状況。バーコード画面の表示用 */
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

  /** この読み取りで追加した背表紙。スキャナ画面のフィード用 */
  const spineResults = useMemo<SpineResult[]>(
    () =>
      entries
        .filter((e) => e.inputKind === 'spine' && e.scanSessionId === sessionId)
        .map((e) => ({
          id: e.id,
          title: e.resolved?.title || e.extracted.title || '(読み取り中)',
          state:
            e.status === 'confirmed'
              ? 'found'
              : e.status === 'notFound'
                ? 'missing'
                : e.status === 'unverified'
                  ? 'looking'
                  : 'review',
        })),
    [entries, sessionId],
  )

  const knownIsbns = useMemo(() => new Set(scanResults.keys()), [scanResults])
  const unresolved = useMemo(() => entries.filter(isUnresolved), [entries])
  const attentionCount = useMemo(() => entries.filter(needsAttention).length, [entries])
  /** 書名がほぼ一致していて、まとめて確定できる件数 */
  const bulkCount = useMemo(() => nearExactMatches(entries).length, [entries])

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
              message: `${done.length} 件のうち ${still} 件は書誌情報が見つかりませんでした。読み取った内容を確認してください。`,
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

  /**
   * 書名がほぼ一致している行を、まとめて確定させる。
   *
   * 棚を1枚撮ると要確認が十数件まとめて出る。1行ずつ候補を押していくのは
   * 現実的ではないので、「書名が合っている」ものを一度に引き受けられるようにする。
   * 自動確定の条件は緩めない。これは利用者が明示的に選ぶ操作である。
   */
  const onAdoptMany = useCallback(() => {
    const targets = nearExactMatches(entriesRef.current)
    setConfirmingBulk(false)
    if (targets.length === 0) return
    upsertMany(
      targets.map(({ entry, candidate }) => ({
        ...adoptCandidate(entry, candidate),
        status: 'confirmed' as const,
        pinned: true,
        conflicts: undefined,
      })),
    )
    setFlash({ kind: 'success', message: `${targets.length} 件を確定しました。` })
  }, [upsertMany])

  /**
   * 読み取った文字を直して引き直す。
   *
   * 直した内容は「印刷されている文字」であって書誌ではないので、
   * これだけでは確定させない(pinned にしない)。書誌DBで実在確認を取り直す。
   */
  const onEditText = useCallback(
    (entryId: string, text: string) => {
      const spine = spineFromText(text)
      patchEntry(entryId, (e) => ({
        ...e,
        rawText: spine ? spineRawText(spine) : text,
        extracted: {
          title: spine?.title ?? text.trim(),
          authors: spine?.authors ?? [],
          publisher: spine?.publisher,
        },
        extractConfidence: 1,
        // 前の読みで出た候補は別の本のものかもしれないので持ち越さない
        candidates: {},
        resolved: undefined,
        provenance: {},
        conflicts: undefined,
        status: 'unverified',
      }))
      enqueueResolve(entryId)
    },
    [enqueueResolve, patchEntry],
  )

  /** バーコードで確定させる。カメラをバーコードに切り替えて1冊だけ読む */
  const onRescue = useCallback((entryId: string) => {
    setRescueEntryId(entryId)
    setInputMode('barcode')
    setScanning(true)
    setFlash(null)
    document.getElementById('scanner')?.scrollIntoView({ block: 'start' })
  }, [])

  const onCancelRescue = useCallback(() => {
    setRescueEntryId(null)
    setScanning(false)
  }, [])

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
   * 保存側からも消す。背表紙のクロップも一緒に消す（画像を端末に残さない）。
   */
  const onDelete = useCallback((entryId: string) => {
    const target = entriesRef.current.find((e) => e.id === entryId)
    entriesRef.current = entriesRef.current.filter((e) => e.id !== entryId)
    setEntries(entriesRef.current)
    deleteEntry(entryId).catch(() =>
      setError('削除した内容を保存できませんでした。もう一度お試しください。'),
    )
    if (target?.inputKind === 'spine') deletePhoto(target.photoId).catch(() => undefined)
    setFlash({ kind: 'success', message: '1 件を一覧から削除しました。' })
  }, [])

  const onReset = useCallback(() => {
    // 背表紙のクロップも一緒に消す。entries だけ消すと画像が端末に残る
    clearAll().catch(() => undefined)
    entriesRef.current = []
    setEntries([])
    setError(null)
    setConfirmingClear(false)
    setFlash({ kind: 'success', message: '保存されていた蔵書データをすべて削除しました。' })
  }, [])

  /** 読み取りを始める。1回ぶんの通し番号を振る */
  const startScanning = useCallback(() => {
    setSessionId(newId())
    setRescueEntryId(null)
    setFinished(false)
    setScanning(true)
  }, [])

  const stopScanning = useCallback(() => {
    setScanning(false)
    setRescueEntryId(null)
    /*
     * 閉じたあとに何が起きているかは一覧側に出る。そこへ送る。
     * カメラを閉じても読み取りと照合は続くので、上に取り残されると
     * 「終わったのか、止めてしまったのか」が判らない。
     */
    if (entriesRef.current.length > 0) {
      requestAnimationFrame(() =>
        document.getElementById('library')?.scrollIntoView({ block: 'start' }),
      )
    }
  }, [])

  /** 書誌一覧へ移動する。画面は1枚なので見出しへスクロールさせる */
  const goToLibrary = useCallback(() => {
    document.getElementById('library')?.scrollIntoView({ block: 'start' })
  }, [])

  const rescuing = rescueEntryId !== null

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
          <div id="scanner">
            <h1 className="page-title">
              {rescuing ? 'バーコードで確定する' : MODE_TEXT[inputMode].title}
            </h1>
            <p className="page-lead">
              {rescuing
                ? '背表紙から書誌情報を特定できなかった本です。裏表紙のバーコードをカメラに収めてください。1冊読み取ると元の画面に戻ります。'
                : MODE_TEXT[inputMode].lead}
            </p>
          </div>

          {!online && (
            <Notice kind="error" title="オフライン" live="status">
              ネットワークに接続されていません。読み取りはこのまま使えますが、書誌情報の取得は接続後に実行してください。
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

          {scanning ? (
            inputMode === 'barcode' ? (
              <BarcodeScanner
                knownIsbns={knownIsbns}
                oneShot={rescuing}
                results={scanResults}
                registeredCount={entries.length}
                onIsbn={onIsbn}
                onClose={stopScanning}
                onOpenLibrary={goToLibrary}
              />
            ) : (
              <SpineScanner
                preparing={spineScan.state.preparing}
                ocrError={spineScan.state.error}
                ocrPending={spineScan.state.pending}
                lookupPending={pending}
                busy={spineScan.state.busy}
                unreadable={spineScan.state.unreadable}
                results={spineResults}
                registeredCount={entries.length}
                onCapture={spineScan.capture}
                onClose={stopScanning}
                onOpenLibrary={goToLibrary}
              />
            )
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
                  onClick={startScanning}
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
          )}

          {/*
            読み取り方式の切り替え。
            バーコードは1冊ずつ手に取る必要があるが確実に読める。
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
                    note: 'かざすだけで1冊ずつ読み取ります。ISBNで完全に一致するため、書誌情報は確実です。',
                  },
                  {
                    id: 'spine' as const,
                    title: '本棚の背表紙',
                    note: '棚にかざすだけで、一段ぶんをまとめて読み取ります。本を手に取る必要はありませんが、読み取れない本や、候補の確認が必要な本が出ます。',
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
                      disabled={rescuing}
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
              {totalPending > 0 && (
                <p className="scanner-status" role="status">
                  <span className="scanner-status__label">読み取った本を調べています</span>
                  <span className="scanner-status__detail">
                    {spineScan.state.pending > 0 &&
                      `棚の写真 ${spineScan.state.pending} 枚を読み取っています。`}
                    {pending > 0 && `書誌情報の取得待ち ${pending} 件。`}
                    カメラを閉じても最後まで続きます。
                  </span>
                </p>
              )}

              {finished && (
                <Notice kind="success" live="status">
                  読み取りと書誌情報の取得が終わりました。
                </Notice>
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

              {bulkCount > 0 &&
                (confirmingBulk ? (
                  <div className="confirm" role="group" aria-label="まとめて確定の確認">
                    <p>
                      書名がほぼ一致している {bulkCount}{' '}
                      件を、それぞれ最有力の候補で確定します。確定したものは書き出しの対象に入ります。
                      内容が違っていた場合は、その行を削除してください。
                    </p>
                    <div className="actions">
                      <button type="button" className="button button--primary" onClick={onAdoptMany}>
                        {bulkCount} 件を確定する
                      </button>
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => setConfirmingBulk(false)}
                      >
                        確定しない
                      </button>
                    </div>
                  </div>
                ) : (
                  <Notice
                    kind="info"
                    title="まとめて確定できます"
                    actions={
                      <button
                        type="button"
                        className="button button--secondary"
                        onClick={() => setConfirmingBulk(true)}
                      >
                        {bulkCount} 件をまとめて確定
                      </button>
                    }
                  >
                    書名がほぼ一致しているのに、著者やISBNの裏付けが取れず確定できていない本が{' '}
                    {bulkCount} 件あります。1件ずつ確かめる代わりに、まとめて確定できます。
                  </Notice>
                ))}

              {attentionCount > 0 && (
                <label className="checkbox">
                  <input
                    type="checkbox"
                    checked={onlyAttention}
                    onChange={(e) => setOnlyAttention(e.target.checked)}
                  />
                  手を入れる必要がある {attentionCount} 件だけを表示する
                </label>
              )}

              <BookList
                entries={entries}
                onlyAttention={onlyAttention}
                onAdopt={onAdopt}
                onExclude={onExclude}
                onRestore={onRestore}
                onDelete={onDelete}
                onEditText={onEditText}
                onRescue={onRescue}
                rescuingId={rescueEntryId}
                onCancelRescue={onCancelRescue}
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
                      件と、読み取った背表紙の画像をすべて削除します。削除すると元に戻せません。必要な場合は先に書き出してください。
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

          {debugging && (
            <Suspense fallback={null}>
              <SpineDiagnosticsPanel />
            </Suspense>
          )}
        </div>
      </main>

      <footer className="site-footer">
        <div className="container">
          <p>書誌情報：国立国会図書館サーチ、openBD、Google Books</p>
          <p>文字の読み取り：Tesseract（端末内で処理し、画像は送信しません）</p>
          <ul>
            <li>
              <a href="https://github.com/popy48771-collab/bib#readme">利用上の注意</a>
            </li>
            <li>
              <a href="https://github.com/popy48771-collab/bib#readme">データの取り扱い</a>
            </li>
          </ul>
          <p>
            読み取った蔵書データと背表紙の画像は、すべて利用者の端末内に保存されます。当サイトの提供者へ送信されることはありません。
          </p>
          <p>
            このサイトは個人が作成したもので、国立国会図書館の公式サービスではありません。行政機関が提供するサービスでもありません。
          </p>
        </div>
      </footer>
    </div>
  )
}
