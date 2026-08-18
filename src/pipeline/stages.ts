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
  SPINE_AUTHOR_MATCH,
  SPINE_MAX_LOOKUPS,
  SPINE_MIN_QUERY_LENGTH,
  SPINE_TITLE_EXACT,
  type BibRecord,
  type BookEntry,
  type ExtractedSpine,
  type FieldConflict,
  type ScoredCandidate,
} from '../types'
import { authorSimilarity, matchScore, titleSimilarity } from '../lib/similarity'
import { normalizeForMatch } from '../lib/normalize'
import { isIsbnBarcode } from '../lib/barcode'
import {
  buildQueries,
  fragmentsFromText,
  hasJapanese,
  spineRawText,
  type SpineQuery,
} from '../lib/spine/parse'
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
    rawText: spineRawText(s),
    extracted: { title: s.title, authors: s.authors, publisher: s.publisher },
    extractConfidence: s.confidence,
    box: s.box,
    candidates: {},
    provenance: {},
    // 書誌DBで実在確認が取れるまでは確定させない。
    // 背表紙の読み取りは「それらしいが存在しない本」を出しうる
    status: 'unverified',
    pinned: false,
    inputKind: 'spine',
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
    inputKind: 'barcode' as const,
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

// ───────────────────────────────────────────────────────────
// 背表紙(書名)経路
// ───────────────────────────────────────────────────────────

/**
 * この項目から組み立てられる検索クエリ。
 *
 * 背表紙OCRは、どの行が書名でどの行が著者かを教えてくれない。
 * 1つの文字列だけで引くと、副題が別行に割れた本や、役割の推定を外した本を
 * まるごと取り逃がす。当たりやすい順に複数用意して上から試す(lib/spine/parse.ts)。
 */
export function queriesForEntry(entry: BookEntry): SpineQuery[] {
  const queries = buildQueries({
    title: entry.extracted.title,
    authors: entry.extracted.authors,
    publisher: entry.extracted.publisher,
    confidence: entry.extractConfidence ?? 0,
    fragments: fragmentsFromText(entry.rawText),
  })
  if (queries.length > 0) return queries
  // 断片が1つも残らない(手入力が空など)場合の受け皿
  return [
    {
      title: entry.extracted.title || entry.rawText,
      authors: entry.extracted.authors,
      mode: 'title' as const,
    },
  ]
}

/**
 * 同じ本を指すレコードをまとめる。
 * 複数のクエリを投げるので、同じ本が何度も返ってくる。
 */
export function dedupeRecords(records: readonly BibRecord[]): BibRecord[] {
  const seen = new Set<string>()
  const out: BibRecord[] = []
  for (const r of records) {
    const key =
      r.isbn13 ?? r.sourceUrl ?? `${normalizeForMatch(r.title)}|${r.authors.map(normalizeForMatch).join(',')}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(r)
  }
  return out
}

/**
 * 背表紙経路の候補に点を付ける。
 *
 * 最有力タイトルとの類似度だけで測ると、役割の推定を外したときに
 * 正解が閾値で切り捨てられる。組み立てた全クエリとの最大類似度で測る。
 */
export function scoreSpineCandidates(entry: BookEntry, records: readonly BibRecord[]): ScoredCandidate[] {
  const queries = queriesForEntry(entry)
  return records
    .map((record) => ({
      record,
      score: Math.max(
        ...queries.map((q) =>
          matchScore(
            {
              title: q.title,
              // クエリから著者を落としてある場合でも、著者が合っていれば加点する
              authors: q.authors.length > 0 ? q.authors : entry.extracted.authors,
              publisher: entry.extracted.publisher,
            },
            record,
          ),
        ),
      ),
    }))
    .filter((c) => c.score >= CANDIDATE_FLOOR)
    .sort((a, b) => b.score - a.score)
}

/** 背表紙経路で候補を出しうるソース */
type TitleSource = 'googleBooks' | 'ndl'

/** 確定してよいかの判断材料。OCR 自身の信頼度は根拠に入れない */
export interface SpineEvidence {
  /** 複数の書誌ソースが同じ ISBN を指した */
  isbnAgreement: boolean
  /** 正規化した書名がほぼ完全一致した */
  titleExact: boolean
  /** 著者も一致した */
  authorMatch: boolean
  /**
   * 別のコマから独立にもう一度読んで、同じ ISBN に着地した。
   *
   * 棚を少しずつずらして撮ると、同じ本が複数のコマに写る。別々の画像から
   * 別々のノイズを経て同じ書誌へ当たったなら、それは1つのDBの高得点より強い。
   * 実測では著者名が崩れやすく、著者一致だけを頼りにすると確定がほとんど
   * 出ないので、この根拠で埋める。
   */
  repeatedObservation: boolean
  /** ソースどうしが別の本(別の版)を最上位に返した */
  disagreement: boolean
  /** 照合に使えた文字数。短すぎる読みは当たっても確定させない */
  queryLength: number
}

/** そのソースの上位 n 件の ISBN */
function topIsbns(candidates: ScoredCandidate[] | undefined, n = 3): string[] {
  return (candidates ?? [])
    .slice(0, n)
    .map((c) => c.record.isbn13)
    .filter((v): v is string => !!v)
}

/**
 * 確定根拠を集める。
 *
 * OCR の自己申告信頼度は入れない。読み違えた文字列を自信満々に返すことは
 * いくらでもあり、「読めた」と「実在する本と一致した」は別のことである(§9.4)。
 */
export function collectSpineEvidence(
  entry: BookEntry,
  top: ScoredCandidate,
  bySource: Partial<Record<TitleSource, ScoredCandidate[]>>,
): SpineEvidence {
  const queries = queriesForEntry(entry)
  const titleExact = queries.some(
    (q) => titleSimilarity(q.title, top.record.title) >= SPINE_TITLE_EXACT,
  )
  const authorMatch =
    entry.extracted.authors.length > 0 &&
    top.record.authors.length > 0 &&
    authorSimilarity(entry.extracted.authors, top.record.authors) >= SPINE_AUTHOR_MATCH

  const gbTop = bySource.googleBooks?.[0]
  const ndlTop = bySource.ndl?.[0]

  // 上位候補の ISBN が、別のソースの上位にも現れているか
  const otherIsbns =
    top.record.source === 'ndl' ? topIsbns(bySource.googleBooks) : topIsbns(bySource.ndl)
  const isbnAgreement = !!top.record.isbn13 && otherIsbns.includes(top.record.isbn13)

  // 両ソースの最上位が、似た書名なのに別の ISBN を指している = 版違いの疑い
  const disagreement =
    !isbnAgreement &&
    !!gbTop?.record.isbn13 &&
    !!ndlTop?.record.isbn13 &&
    gbTop.record.isbn13 !== ndlTop.record.isbn13 &&
    titleSimilarity(gbTop.record.title, ndlTop.record.title) >= 0.8

  // 前回の観測で着地した ISBN。今回も同じところへ来たかを見る
  const priorIsbn = entry.resolved?.isbn13
  const repeatedObservation =
    (entry.observationCount ?? 1) >= 2 &&
    !!priorIsbn &&
    !!top.record.isbn13 &&
    priorIsbn === top.record.isbn13

  return {
    isbnAgreement,
    titleExact,
    authorMatch,
    repeatedObservation,
    disagreement,
    queryLength: Math.max(...queries.map((q) => normalizeForMatch(q.title).length), 0),
  }
}

/**
 * 根拠から状態を決める。
 *
 * 最優先の指標は自動確定精度である。読み落としが多少あっても、
 * 誤った本を確定一覧へ混ぜない。したがって確定は
 *   - 複数ソースが同じ ISBN を指した
 *   - 書名がほぼ完全一致し、著者も一致した
 *   - 書名がほぼ完全一致し、別のコマからも同じ ISBN に着地した
 * の3つに限り、それ以外は人間の確認へ回す。
 *
 * 3つ目はいずれも「書名がほぼ完全一致」を必須にしてある。再観測だけを
 * 根拠にすると、OCR が同じ読み違えを繰り返したときに誤りを確定させてしまう。
 */
export function statusFromEvidence(ev: SpineEvidence): BookEntry['status'] {
  if (ev.queryLength < SPINE_MIN_QUERY_LENGTH) return 'needsReview'
  if (ev.isbnAgreement) return 'confirmed'
  if (ev.disagreement) return 'conflict'
  if (ev.titleExact && ev.authorMatch) return 'confirmed'
  // 書名がほぼ完全一致していて、別のコマからも同じ本に着地した
  if (ev.titleExact && ev.repeatedObservation) return 'confirmed'
  return 'needsReview'
}

/**
 * 書名経路の結果を統合する。純粋関数なのでテストしやすい。
 *
 * 与えられたソースの候補だけを差し替え、他のソースの候補には触らない。
 * 同じ結果を二度統合しても壊れない(冪等)。
 */
export function mergeSpineResult(
  entry: BookEntry,
  bySource: Partial<Record<TitleSource, ScoredCandidate[]>>,
): BookEntry {
  const next: BookEntry = { ...entry, candidates: { ...entry.candidates, ...bySource } }

  const all = [...(next.candidates.googleBooks ?? []), ...(next.candidates.ndl ?? [])].sort(
    (a, b) => b.score - a.score,
  )
  const top = all[0]
  if (!top) return { ...next, status: 'notFound', conflicts: undefined }

  const ev = collectSpineEvidence(next, top, {
    googleBooks: next.candidates.googleBooks,
    ndl: next.candidates.ndl,
  })
  const status = statusFromEvidence(ev)

  // 候補は出しておく。確定しない場合でも、行に書名が出ていないと
  // 利用者はどの本の話なのか分からず、候補を選びようがない
  const adopted = adoptCandidate(next, top)

  const rival = all.find((c) => c.record.source !== top.record.source)
  const conflicts =
    status === 'conflict' && rival ? diffRecords(top.record, rival.record) : undefined

  return {
    ...adopted,
    status,
    conflicts: conflicts && conflicts.length > 0 ? conflicts : undefined,
  }
}

/**
 * 1つのクエリを1つのソースへ投げる。
 *
 * `any` は全項目のキーワード検索。書名の項目で引くと OCR の読み違いで
 * 0 件になるので、最後の総当たりとしてこちらへ落とす。
 */
async function runQuery(source: TitleSource, q: SpineQuery, ctx: StageContext): Promise<BibRecord[]> {
  if (source === 'ndl') {
    const opts = { proxyUrl: NDL_PROXY_URL, signal: ctx.signal }
    return q.mode === 'any'
      ? ndl.searchByKeyword(q.title, opts)
      : ndl.searchByTitle(q.title, q.authors, opts)
  }
  const opts = { country: GOOGLE_BOOKS_COUNTRY, signal: ctx.signal }
  return q.mode === 'any'
    ? googleBooks.searchByKeyword(q.title, opts)
    : googleBooks.searchByTitle(q.title, q.authors, opts)
}

/**
 * 「書名がほぼ一致しているのに確定できていない」行を集める。
 *
 * 棚を1枚撮ると20〜30冊が一度に入り、そのうち相当数が要確認で残る。
 * 中身を見ると、書名は完全に一致していて、著者が読めなかっただけ、
 * というものが多い。自動では確定させない（1ソースの高得点は根拠にならない）が、
 * 利用者がまとめて引き受けられるようにしておく。
 *
 * 判定は書名だけで行う。スコアは著者や出版社の一致でも上下するので、
 * 「書名が合っている」という利用者が確かめたい一点で選び分ける。
 */
export function nearExactMatches(
  entries: readonly BookEntry[],
): { entry: BookEntry; candidate: ScoredCandidate }[] {
  const out: { entry: BookEntry; candidate: ScoredCandidate }[] = []
  for (const entry of entries) {
    if (entry.status !== 'needsReview' || entry.pinned) continue
    const top = [...(entry.candidates.googleBooks ?? []), ...(entry.candidates.ndl ?? [])].sort(
      (a, b) => b.score - a.score,
    )[0]
    if (!top) continue

    const queries = queriesForEntry(entry)
    if (Math.max(...queries.map((q) => normalizeForMatch(q.title).length), 0) < SPINE_MIN_QUERY_LENGTH)
      continue
    if (!queries.some((q) => titleSimilarity(q.title, top.record.title) >= SPINE_TITLE_EXACT)) continue

    out.push({ entry, candidate: top })
  }
  return out
}

/**
 * 書名で照合する。
 *
 * ── 検索順を言語で変える ──────────────────────────────
 * 日本語を含むなら NDL を先に当てる。法定納本ぶん網羅性が最も高く、
 * Google Books は和書のカバレッジが弱い(CLAUDE.md §3)。
 * 欧文中心なら逆にする。
 *
 * ── 1冊あたりの通信量を抑える ────────────────────────
 * クエリは当たりやすい順に並んでいるので、当たったところで打ち切る。
 * 両ソースには必ず当てる。片方だけで高得点でも、それは「1つのDBに
 * 似た書名の本があった」に過ぎず、確定の根拠には足りないため。
 */
async function resolveByTitle(entry: BookEntry, ctx: StageContext): Promise<BookEntry> {
  const queries = queriesForEntry(entry)
  const japanese = queries.some((q) => hasJapanese(q.title)) || hasJapanese(entry.rawText)
  const order: TitleSource[] = japanese ? ['ndl', 'googleBooks'] : ['googleBooks', 'ndl']

  // 予算はソースで分け合う。先に当てた方が使い切ると、もう片方が
  // 最有力クエリしか撃てなくなり、合意の判定材料が乏しくなる
  const perSource = Math.max(1, Math.ceil(SPINE_MAX_LOOKUPS / order.length))
  const bySource: Partial<Record<TitleSource, ScoredCandidate[]>> = {}

  /*
   * 予算の最後の1回は、必ず一番当たりの広いクエリに使う。
   *
   * クエリは絞りが強い順に並んでいるので、素直に上から使うと予算が
   * 絞り込みだけで尽き、総当たりまで届かない。頭から数件と、末尾の1件を撃つ。
   */
  const attempts =
    queries.length <= perSource
      ? queries
      : [...queries.slice(0, perSource - 1), queries[queries.length - 1]]

  for (const source of order) {
    const records: BibRecord[] = []
    for (const q of attempts) {
      try {
        records.push(...(await runQuery(source, q, ctx)))
      } catch (err) {
        rethrowAbort(err)
      }
      if (records.length > 0) break
    }
    bySource[source] = scoreSpineCandidates(entry, dedupeRecords(records))
  }

  const merged = mergeSpineResult(entry, bySource)
  return enrichFromOpenBd(merged, ctx)
}

/**
 * 確定した本を openBD で補完する。
 *
 * openBD は ISBN 引き専用でタイトル検索ができないので照合には使えないが、
 * ISBN が判ったあとの書影・出版社・内容紹介の充実度は日本語書籍で最も高い。
 * 確定した本にだけ1リクエスト足す。
 */
async function enrichFromOpenBd(entry: BookEntry, ctx: StageContext): Promise<BookEntry> {
  const isbn = entry.resolved?.isbn13
  if (!isbn || entry.status !== 'confirmed') return entry
  if (entry.resolved?.coverUrl && entry.resolved?.publisher) return entry

  try {
    const hit = (await openbd.fetchByIsbns([isbn], ctx.signal)).get(isbn)
    if (!hit) return entry

    const resolved: BibRecord = { ...entry.resolved! }
    const provenance = { ...entry.provenance }
    for (const field of Object.keys(hit) as (keyof BibRecord)[]) {
      if (field === 'source' || field === 'sourceUrl') continue
      const current = resolved[field]
      const incoming = hit[field]
      const isEmpty =
        current === undefined || current === '' || (Array.isArray(current) && current.length === 0)
      if (isEmpty && incoming !== undefined && incoming !== '') {
        assignField(resolved, field, incoming)
        provenance[field] = 'openbd'
      }
    }
    return {
      ...entry,
      candidates: { ...entry.candidates, openbd: [{ record: hit, score: 1 }] },
      resolved,
      provenance,
    }
  } catch (err) {
    rethrowAbort(err)
    return entry
  }
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
