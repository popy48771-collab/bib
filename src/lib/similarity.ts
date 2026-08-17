/**
 * 曖昧一致スコアリング
 *
 * OCR 結果と書誌DBのレコードを突き合わせる。日本語は単語境界が無いので
 * 単語ベースではなく文字 bigram + 編集距離の組み合わせで測る。
 */

import { normalizeAuthor, normalizeForMatch, splitTitle } from './normalize'

/** レーベンシュタイン距離。2行のみ保持して O(min(n,m)) メモリ */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length
  // 短い方を内側のループに置く
  if (a.length < b.length) [a, b] = [b, a]

  let prev = new Array<number>(b.length + 1)
  let curr = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j

  for (let i = 1; i <= a.length; i++) {
    curr[0] = i
    const ca = a.charCodeAt(i - 1)
    for (let j = 1; j <= b.length; j++) {
      const cost = ca === b.charCodeAt(j - 1) ? 0 : 1
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost)
    }
    ;[prev, curr] = [curr, prev]
  }
  return prev[b.length]
}

/** 編集距離を 0..1 の類似度に変換 */
export function levenshteinRatio(a: string, b: string): number {
  const maxLen = Math.max(a.length, b.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(a, b) / maxLen
}

/** 文字 n-gram の集合を作る。1文字語にも対応するため短い場合は文字集合を返す */
export function ngrams(s: string, n = 2): string[] {
  if (s.length === 0) return []
  if (s.length < n) return [s]
  const out: string[] = []
  for (let i = 0; i <= s.length - n; i++) out.push(s.slice(i, i + n))
  return out
}

/** Dice 係数 (多重集合として扱う) */
export function diceCoefficient(a: string, b: string, n = 2): number {
  const ga = ngrams(a, n)
  const gb = ngrams(b, n)
  if (ga.length === 0 && gb.length === 0) return 1
  if (ga.length === 0 || gb.length === 0) return 0

  const counts = new Map<string, number>()
  for (const g of ga) counts.set(g, (counts.get(g) ?? 0) + 1)

  let overlap = 0
  for (const g of gb) {
    const c = counts.get(g)
    if (c && c > 0) {
      overlap++
      counts.set(g, c - 1)
    }
  }
  return (2 * overlap) / (ga.length + gb.length)
}

/**
 * 部分包含のボーナス。
 * OCR は背表紙の一部しか読めないことが多く、
 * 「読めた文字列が正解タイトルの部分文字列」というケースが頻出する。
 * これを距離ベースだけで測ると長さ差で不当に低く出るため補正する。
 */
function containmentBonus(query: string, target: string): number {
  if (!query || !target) return 0
  const [shorter, longer] = query.length <= target.length ? [query, target] : [target, query]
  if (shorter.length < 2) return 0
  if (longer.includes(shorter)) {
    // 短い方が長い方をどれだけ覆っているか。短すぎる一致は評価しない
    return Math.min(1, shorter.length / Math.max(4, longer.length))
  }
  return 0
}

/** タイトル同士の類似度 (0..1) */
export function titleSimilarity(queryTitle: string, targetTitle: string): number {
  const q = normalizeForMatch(splitTitle(queryTitle).main)
  const t = normalizeForMatch(splitTitle(targetTitle).main)
  if (!q || !t) return 0
  if (q === t) return 1

  const dice = diceCoefficient(q, t)
  const lev = levenshteinRatio(q, t)
  const contain = containmentBonus(q, t)

  // bigram を主、編集距離を従。包含は上振れ側にのみ効かせる
  const base = dice * 0.65 + lev * 0.35
  return Math.min(1, Math.max(base, contain * 0.9))
}

/** 著者リスト同士の類似度 (0..1)。どちらか空なら中立値 0.5 */
export function authorSimilarity(queryAuthors: string[], targetAuthors: string[]): number {
  const q = queryAuthors.map(normalizeAuthor).filter(Boolean)
  const t = targetAuthors.map(normalizeAuthor).filter(Boolean)
  if (q.length === 0 || t.length === 0) return 0.5

  // 片方の各要素について最も似た相手を取り、その平均
  let sum = 0
  for (const a of q) {
    let best = 0
    for (const b of t) {
      const s = Math.max(diceCoefficient(a, b), levenshteinRatio(a, b), containmentBonus(a, b))
      if (s > best) best = s
    }
    sum += best
  }
  return sum / q.length
}

export interface MatchInput {
  title: string
  authors: string[]
  publisher?: string
}

/**
 * 総合スコア。
 * タイトルが主。著者は補助だが、同名異書を切り分ける決め手になるので効かせる。
 * 出版社は弱い加点のみ(表記揺れが大きく、外すと痛いため)。
 */
export function matchScore(query: MatchInput, target: MatchInput): number {
  const ts = titleSimilarity(query.title, target.title)
  const as = authorSimilarity(query.authors, target.authors)

  // タイトルが全く似ていないなら、著者が合っていても別の本
  if (ts < 0.3) return ts * 0.5

  let score = ts * 0.75 + as * 0.25

  if (query.publisher && target.publisher) {
    const ps = diceCoefficient(normalizeForMatch(query.publisher), normalizeForMatch(target.publisher))
    if (ps > 0.6) score = Math.min(1, score + 0.05)
  }
  return Math.min(1, score)
}
