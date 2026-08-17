/**
 * 書誌照合パイプライン
 *
 * 1冊が入ってきたら、書誌が埋まるまで自動で追いかける。以下の性質を満たす:
 *
 *  1. 冪等   … 同じ項目を再照合しても結果が壊れない
 *  2. 非破壊 … 後のソースは前のソースの候補を消さない(candidates に足すだけ)
 *  3. 隔離   … あるソースが落ちていても、他のソースの成果は残る
 *  4. 尊重   … 利用者が手で確定した項目(pinned)は自動処理で上書きしない
 *
 * かつては段階ごとにボタンを押させていたが、バーコードは誤読がほぼ無く
 * 人間のトリアージを挟む必要がない。押さなくても済む操作を残しておくと、
 * 「読んだのに一覧が空」という状態が生まれてしまうので、
 * 1冊読むたびにここまで自動で走らせる。
 */

import {
  AUTO_CONFIRM_THRESHOLD,
  CANDIDATE_FLOOR,
  GOOGLE_BOOKS_COUNTRY,
  NDL_PROXY_URL,
  type BibRecord,
  type BookEntry,
  type ExtractedSpine,
  type FieldConflict,
  type ScoredCandidate,
} from '../types'
import { matchScore } from '../lib/similarity'
import { normalizeForMatch } from '../lib/normalize'
import { isIsbnBarcode } from '../lib/barcode'
import * as googleBooks from '../sources/googleBooks'
import * as ndl from '../sources/ndl'
import * as openbd from '../sources/openbd'

/**
 * フィールドを型を保ったまま代入する。
 * keyof でループしながら書き込むには総称型の助けが要る。
 */
function assignField<K extends keyof BibRecord>(target: BibRecord, key: K, value: BibRecord[K]) {
  target[key] = value
}

/** 候補にスコアを付けて、閾値未満を捨て、降順に並べる */
export function scoreCandidates(entry: BookEntry, records: BibRecord[]): ScoredCandidate[] {
  const query = {
    title: entry.extracted.title || entry.rawText,
    authors: entry.extracted.authors,
    publisher: entry.extracted.publisher,
  }
  return records
    .map((record) => ({ record, score: matchScore(query, record) }))
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
}

/** スコアから状態を決める */
export function statusFromScore(top: ScoredCandidate | undefined): BookEntry['status'] {
  if (!top) return 'notFound'
  return top.score >= AUTO_CONFIRM_THRESHOLD ? 'confirmed' : 'needsReview'
}

/**
 * 候補を採用して resolved / provenance を更新する。
 * pinned な項目には触れない。
 */
export function adoptCandidate(entry: BookEntry, candidate: ScoredCandidate): BookEntry {
  const r = candidate.record
  const provenance: BookEntry['provenance'] = {}
  for (const key of Object.keys(r) as (keyof BibRecord)[]) {
    if (r[key] !== undefined && r[key] !== '') provenance[key] = r.source
  }
  return { ...entry, resolved: { ...r }, provenance }
}

// ───────────────────────────────────────────────────────────
// 入口: 読み取り結果 → BookEntry
// ───────────────────────────────────────────────────────────

/**
 * 背表紙の読み取り結果から BookEntry を作る。この時点では未確認。
 * 読み取り手段(写真・映像・OCR)が何であれ、ここから先は共通の照合に乗る。
 */
export function entriesFromExtraction(
  photoId: string,
  spines: ExtractedSpine[],
  idPrefix: string,
): BookEntry[] {
  return spines.map((s, i) => ({
    id: `${idPrefix}-${i}`,
    photoId,
    rawText: [s.title, ...s.authors, s.publisher ?? ''].filter(Boolean).join(' '),
    extracted: { title: s.title, authors: s.authors, publisher: s.publisher },
    extractConfidence: s.confidence,
    box: s.box,
    candidates: {},
    provenance: {},
    // 書誌DBで実在確認が取れるまでは確定させない。
    // 背表紙の読み取りは「それらしいが存在しない本」を出しうる
    status: 'unverified',
    pinned: false,
  }))
}

/**
 * バーコードで読んだ ISBN から BookEntry を作る。
 *
 * ISBN は既に確実なので resolved に入れておく(出典は barcode)。
 * ただし書名はまだ判らないので status は unverified のまま。
 * 次段の Google Books 照合で書誌が埋まり、そこで確定する。
 */
export function entriesFromIsbns(isbns: readonly string[], idPrefix: string): BookEntry[] {
  return isbns.map((isbn13, i) => ({
    id: `${idPrefix}-${i}`,
    photoId: idPrefix,
    rawText: isbn13,
    extracted: { title: '', authors: [] },
    candidates: {},
    resolved: { title: '', authors: [], isbn13, source: 'barcode' as const },
    provenance: { isbn13: 'barcode' as const },
    status: 'unverified' as const,
    pinned: false,
  }))
}

// ───────────────────────────────────────────────────────────
// 照合の共通部品
// ───────────────────────────────────────────────────────────

export interface StageContext {
  signal?: AbortSignal
  /** 1件処理するたびに呼ばれる。UI の進捗表示用 */
  onProgress?: (done: number, total: number) => void
  /** 1件解決するたびに呼ばれる。まとめて待たずに一覧へ流し込むために使う */
  onEntry?: (entry: BookEntry) => void
}

/** レート制限対策。Google Books は IP 単位で絞られるため間隔を空ける */
function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    const t = setTimeout(resolve, ms)
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t)
        reject(new DOMException('Aborted', 'AbortError'))
      },
      { once: true },
    )
  })
}

const LOOKUP_INTERVAL_MS = 260

/** 中断だけは上へ抜かす。通信の失敗はその場で飲んで次のソースへ回す */
function rethrowAbort(err: unknown): void {
  if (err instanceof DOMException && err.name === 'AbortError') throw err
}

/**
 * この項目の ISBN。判っていれば完全一致で引ける。
 *
 * 照合が一度通ると provenance.isbn13 は書誌ソース側に移るが、
 * バーコードで読んだ値は rawText に残っているので、再照合でも見失わない。
 */
function knownIsbnOf(entry: BookEntry): string | undefined {
  if (entry.provenance.isbn13 === 'barcode') return entry.resolved?.isbn13
  return isIsbnBarcode(entry.rawText) ? entry.rawText : undefined
}

/** 自動処理の対象外(手動確定済み・除外済み) */
function isUntouchable(entry: BookEntry): boolean {
  return entry.pinned || entry.status === 'excluded'
}

/**
 * ISBN 検索の結果に点を付ける。
 * `isbn:` クエリの戻りはその ISBN の本そのものなので、類似度計算はしない。
 * ISBN が一致したものを最上位に置くだけ。
 */
export function scoreIsbnCandidates(isbn13: string, records: BibRecord[]): ScoredCandidate[] {
  return records
    .map((record) => ({ record, score: record.isbn13 === isbn13 ? 1 : 0.9 }))
    .sort((a, b) => b.score - a.score)
}

/**
 * ISBN 経路の結果を統合する。
 *
 * バーコードは誤読がほぼ無いので、書誌が引けた時点で確定してよい。
 * 背表紙OCR経路と違って人間のトリアージを挟まないのが、この経路の値打ち。
 */
export function mergeIsbnResult(
  entry: BookEntry,
  isbn13: string,
  scored: ScoredCandidate[],
  /** どのソースから来た候補か。candidates のどの欄に積むかを決める */
  from: 'googleBooks' | 'openbd' | 'ndl' = 'googleBooks',
): BookEntry {
  const next: BookEntry = { ...entry, candidates: { ...entry.candidates, [from]: scored } }
  const top = scored[0]

  // ISBN は読めたが書誌DBに無い。ISBN は確かなので捨てず、未確認として残す
  if (!top) return { ...next, status: 'notFound' }

  const adopted = adoptCandidate(next, top)
  const resolved: BibRecord = { ...adopted.resolved! }
  const provenance = { ...adopted.provenance }

  // Google Books のレコードは ISBN を持たないことがある。
  // バーコードで読んだ値の方が確実なので、欠けていれば埋め戻す
  if (!resolved.isbn13) {
    resolved.isbn13 = isbn13
    provenance.isbn13 = 'barcode'
  }

  return { ...adopted, resolved, provenance, status: 'confirmed' }
}

// ───────────────────────────────────────────────────────────
// NDL 突合
// ───────────────────────────────────────────────────────────

/** 比較対象のフィールド。表記揺れが激しいものは入れない */
const COMPARED_FIELDS: (keyof BibRecord)[] = ['title', 'authors', 'publisher', 'published', 'isbn13']

function fieldToString(value: unknown): string {
  if (Array.isArray(value)) return value.join(', ')
  return value == null ? '' : String(value)
}

/**
 * 2つのレコードを比較し、実質的に異なるフィールドを列挙する。
 * 正規化して同一とみなせるものは差分として報告しない
 * (「夏目, 漱石」と「夏目漱石」を差分にすると人間の確認作業が無意味に増える)。
 */
export function diffRecords(a: BibRecord, b: BibRecord): FieldConflict[] {
  const conflicts: FieldConflict[] = []
  for (const field of COMPARED_FIELDS) {
    const av = fieldToString(a[field])
    const bv = fieldToString(b[field])
    if (!av || !bv) continue // 片方に情報が無いのは「差分」ではなく「補完余地」

    if (field === 'isbn13') {
      // ISBN は正規化済みなので厳密比較。ここが食い違うなら別の版か別の本
      if (av !== bv) {
        conflicts.push({ field, values: [{ source: a.source, value: av }, { source: b.source, value: bv }] })
      }
      continue
    }
    if (normalizeForMatch(av) !== normalizeForMatch(bv)) {
      conflicts.push({ field, values: [{ source: a.source, value: av }, { source: b.source, value: bv }] })
    }
  }
  return conflicts
}

/**
 * NDL の結果を既存エントリに統合する。純粋関数なのでテストしやすい。
 *
 * 一次照合の結果を上書きせず、
 *  - NDL 側の候補を candidates.ndl に追加
 *  - 一次結果との差分を conflicts に記録
 *  - 一次照合で見つからなかった項目は、NDL でヒットすれば昇格させる
 *  - 一次結果に欠けているフィールド(ISBN等)は NDL の値で補完する
 * という振る舞いにする。
 */
export function mergeNdlResult(entry: BookEntry, scored: ScoredCandidate[]): BookEntry {
  const next: BookEntry = { ...entry, candidates: { ...entry.candidates, ndl: scored } }
  const top = scored[0]

  if (!top) {
    // NDL で見つからなくても、一次結果は保持したまま
    return next
  }

  // 一次照合で確定できていなかった → NDL の結果で昇格
  if (!entry.resolved || entry.status === 'notFound' || entry.status === 'unverified') {
    const adopted = adoptCandidate(next, top)
    return { ...adopted, status: statusFromScore(top) }
  }

  // 一次結果がある → 差分を記録し、欠けているフィールドだけ補完する
  const conflicts = diffRecords(entry.resolved, top.record)
  const resolved: BibRecord = { ...entry.resolved }
  const provenance = { ...entry.provenance }

  for (const field of Object.keys(top.record) as (keyof BibRecord)[]) {
    if (field === 'source' || field === 'sourceUrl') continue
    const current = resolved[field]
    const incoming = top.record[field]
    const isEmpty =
      current === undefined || current === '' || (Array.isArray(current) && current.length === 0)
    if (isEmpty && incoming !== undefined && incoming !== '') {
      assignField(resolved, field, incoming)
      provenance[field] = 'ndl'
    }
  }

  return {
    ...next,
    resolved,
    provenance,
    conflicts: conflicts.length > 0 ? conflicts : undefined,
    status: conflicts.length > 0 ? 'conflict' : entry.status,
  }
}

// ───────────────────────────────────────────────────────────
// 自動照合
// ───────────────────────────────────────────────────────────

/**
 * 1冊を書誌DBで解決する。書誌が埋まった時点で打ち切る。
 *
 * ISBN が判っている(バーコード経路)なら完全一致で引けるので
 *   openBD → Google Books → NDL
 * の順に当てる。日本語書籍は openBD が最も速くよく当たり、Google Books は
 * 和書のカバレッジが弱い一方で洋書に強く、NDL は法定納本ぶん網羅性が最も高い。
 * 「まず当たりやすいものを1リクエストで、外れたら網羅的なものへ」の並びである。
 *
 * ISBN が無い(背表紙経路)なら書名で照合する。こちらは読み取り自体が曖昧なので
 * 類似度で絞り、確信が持てなければ確定させずに人間の判断へ回す。
 *
 * どのソースが落ちていても例外は投げない。引けなかった項目は notFound の
 * まま一覧に残り、あとから再照合できる。中断(AbortError)だけは上へ抜ける。
 */
export async function resolveEntry(entry: BookEntry, ctx: StageContext = {}): Promise<BookEntry> {
  if (isUntouchable(entry)) return entry
  const isbn = knownIsbnOf(entry)
  return isbn ? resolveByIsbn(entry, isbn, ctx) : resolveByTitle(entry, ctx)
}

/** ISBN 完全一致で引く。一致するので類似度による絞り込みはしない */
async function resolveByIsbn(
  entry: BookEntry,
  isbn13: string,
  ctx: StageContext,
): Promise<BookEntry> {
  let current = entry

  try {
    const hit = (await openbd.fetchByIsbns([isbn13], ctx.signal)).get(isbn13)
    if (hit) return mergeIsbnResult(current, isbn13, [{ record: hit, score: 1 }], 'openbd')
  } catch (err) {
    rethrowAbort(err)
  }

  try {
    const records = await googleBooks.searchByIsbn(isbn13, {
      country: GOOGLE_BOOKS_COUNTRY,
      signal: ctx.signal,
    })
    const merged = mergeIsbnResult(current, isbn13, scoreIsbnCandidates(isbn13, records))
    if (merged.status === 'confirmed') return merged
    current = merged
  } catch (err) {
    rethrowAbort(err)
  }

  try {
    const records = await ndl.searchByIsbn(isbn13, { proxyUrl: NDL_PROXY_URL, signal: ctx.signal })
    const merged = mergeIsbnResult(current, isbn13, scoreIsbnCandidates(isbn13, records), 'ndl')
    if (merged.status === 'confirmed') return merged
    current = merged
  } catch (err) {
    rethrowAbort(err)
  }

  return current
}

/** 書名で照合する。読み取りが曖昧なぶん、確信が持てなければ確定させない */
async function resolveByTitle(entry: BookEntry, ctx: StageContext): Promise<BookEntry> {
  const title = entry.extracted.title || entry.rawText
  let current = entry

  try {
    const records = await googleBooks.searchByTitle(title, entry.extracted.authors, {
      country: GOOGLE_BOOKS_COUNTRY,
      signal: ctx.signal,
    })
    const scored = scoreCandidates(entry, records)
    const top = scored[0]
    let next: BookEntry = {
      ...current,
      candidates: { ...current.candidates, googleBooks: scored },
      status: statusFromScore(top),
    }
    if (top) next = { ...adoptCandidate(next, top), status: next.status }
    if (next.status === 'confirmed') return next
    current = next
  } catch (err) {
    rethrowAbort(err)
  }

  try {
    const records = await ndl.searchByTitle(title, entry.extracted.authors, {
      proxyUrl: NDL_PROXY_URL,
      signal: ctx.signal,
    })
    current = mergeNdlResult(current, scoreCandidates(entry, records))
  } catch (err) {
    rethrowAbort(err)
  }

  return current
}

/**
 * まとめて解決する。1件の失敗が他を巻き込まないよう、例外は各件で閉じる。
 * 解決したそばから onEntry で返すので、呼び出し側は全件を待たずに描ける。
 */
export async function resolveEntries(
  entries: BookEntry[],
  ctx: StageContext = {},
): Promise<BookEntry[]> {
  const out: BookEntry[] = []
  let done = 0

  for (const entry of entries) {
    if (ctx.signal?.aborted) throw new DOMException('Aborted', 'AbortError')

    const next = await resolveEntry(entry, ctx)
    out.push(next)
    ctx.onEntry?.(next)

    done++
    ctx.onProgress?.(done, entries.length)
    if (done < entries.length) await delay(LOOKUP_INTERVAL_MS, ctx.signal)
  }
  return out
}
