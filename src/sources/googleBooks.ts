/**
 * Google Books API クライアント
 *
 * 静的サイトから直接呼べる唯一の全文検索。CORS 対応済み(実測確認)、APIキー不要。
 * したがってこれが一次照合の主軸になる。
 *
 * 制約: レート制限が IP 単位でかかる。連打すると 429 が返るため、
 * 呼び出し側でスロットリングすること (lib/throttle.ts)。
 */

import type { BibRecord } from '../types'
import { extractIsbn13, toIsbn13 } from '../lib/isbn'
import { tidy } from '../lib/normalize'

const ENDPOINT = 'https://www.googleapis.com/books/v1/volumes'

interface GoogleVolume {
  id?: string
  volumeInfo?: {
    title?: string
    subtitle?: string
    authors?: string[]
    publisher?: string
    publishedDate?: string
    description?: string
    industryIdentifiers?: { type?: string; identifier?: string }[]
    imageLinks?: { thumbnail?: string; smallThumbnail?: string }
    infoLink?: string
  }
}

/** Google Books の 1件を内部形式に変換 */
function toBibRecord(v: GoogleVolume): BibRecord | null {
  const info = v.volumeInfo
  if (!info?.title) return null

  // ISBN-13 を優先し、無ければ ISBN-10 から変換する
  let isbn13: string | null = null
  let isbnRaw: string | undefined
  for (const id of info.industryIdentifiers ?? []) {
    if (!id.identifier) continue
    if (id.type === 'ISBN_13') {
      const v13 = toIsbn13(id.identifier)
      if (v13) {
        isbn13 = v13
        isbnRaw = id.identifier
        break
      }
    }
  }
  if (!isbn13) {
    for (const id of info.industryIdentifiers ?? []) {
      if (id.type === 'ISBN_10' && id.identifier) {
        const v13 = toIsbn13(id.identifier)
        if (v13) {
          isbn13 = v13
          isbnRaw = id.identifier
          break
        }
      }
    }
  }

  // Google Books の書影は http で返ることがある。混在コンテンツを避けて https に寄せる
  const cover = info.imageLinks?.thumbnail ?? info.imageLinks?.smallThumbnail
  const coverUrl = cover ? cover.replace(/^http:\/\//, 'https://') : undefined

  return {
    title: tidy(info.title),
    subtitle: info.subtitle ? tidy(info.subtitle) : undefined,
    authors: (info.authors ?? []).map(tidy).filter(Boolean),
    publisher: info.publisher ? tidy(info.publisher) : undefined,
    published: info.publishedDate,
    isbn13: isbn13 ?? undefined,
    isbnRaw,
    coverUrl,
    description: info.description,
    source: 'googleBooks',
    sourceUrl: info.infoLink,
  }
}

export class RateLimitError extends Error {
  constructor(message = 'Google Books のレート制限に達しました') {
    super(message)
    this.name = 'RateLimitError'
  }
}

async function request(params: URLSearchParams, signal?: AbortSignal): Promise<BibRecord[]> {
  const res = await fetch(`${ENDPOINT}?${params.toString()}`, { signal })

  if (res.status === 429) throw new RateLimitError()
  if (!res.ok) throw new Error(`Google Books API エラー: ${res.status}`)

  const json = (await res.json()) as { items?: GoogleVolume[] }
  return (json.items ?? []).map(toBibRecord).filter((r): r is BibRecord => r !== null)
}

export interface SearchOptions {
  maxResults?: number
  country?: string
  signal?: AbortSignal
}

/**
 * タイトル(+著者)で検索する。
 *
 * intitle/inauthor を使うと絞り込みが厳しく、OCR 誤字があると 0 件になりやすい。
 * そこでまず絞り込み検索を試し、駄目ならフリーワード検索にフォールバックする。
 */
export async function searchByTitle(
  title: string,
  authors: string[] = [],
  opts: SearchOptions = {},
): Promise<BibRecord[]> {
  const t = tidy(title)
  if (!t) return []

  const maxResults = String(opts.maxResults ?? 10)
  const author = authors[0] ? tidy(authors[0]) : ''

  const build = (q: string) => {
    const p = new URLSearchParams({ q, maxResults, printType: 'books' })
    if (opts.country) p.set('country', opts.country)
    return p
  }

  // 1st: フィールド指定で精度重視
  const strictQuery = author ? `intitle:${t} inauthor:${author}` : `intitle:${t}`
  let results = await request(build(strictQuery), opts.signal)
  if (results.length > 0) return results

  // 2nd: 著者条件を外す
  if (author) {
    results = await request(build(`intitle:${t}`), opts.signal)
    if (results.length > 0) return results
  }

  // 3rd: フリーワード。OCR 誤字が多いときはこれしか当たらない
  return request(build(author ? `${t} ${author}` : t), opts.signal)
}

/**
 * フリーワードで引く。
 *
 * `intitle:` は書名の項目に対する検索なので、OCR が読み違えると 0 件になる。
 * こちらは全文を対象にするため当たりが広い。崩れた読み取りの受け皿。
 */
export async function searchByKeyword(
  keyword: string,
  opts: SearchOptions = {},
): Promise<BibRecord[]> {
  const k = tidy(keyword)
  if (!k) return []
  const p = new URLSearchParams({ q: k, maxResults: String(opts.maxResults ?? 10), printType: 'books' })
  if (opts.country) p.set('country', opts.country)
  return request(p, opts.signal)
}

/** ISBN で引く。バーコード経路と、他ソースで得た ISBN の確認に使う */
export async function searchByIsbn(isbn: string, opts: SearchOptions = {}): Promise<BibRecord[]> {
  const v = extractIsbn13(isbn)
  if (!v) return []
  const p = new URLSearchParams({ q: `isbn:${v}`, maxResults: '5' })
  if (opts.country) p.set('country', opts.country)
  return request(p, opts.signal)
}
