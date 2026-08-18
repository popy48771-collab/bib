/**
 * 出力形式
 *
 * 「蔵書リストを作る」のが目的なので、ここが最終成果物。
 * 表計算・他サービスへの取り込み・再取り込みの3用途を押さえる。
 */

import type { BookEntry, BibRecord } from '../types'
import { formatIsbn13 } from './isbn'

/**
 * 出力対象。
 *
 * 既定では「書誌DBで確定したもの」だけを出す。
 *
 * バーコード経路だけだった頃は、resolved が入っていれば概ね正しかった。
 * 背表紙OCR経路ではそうはいかない。候補は出たが確信が持てないもの
 * (needsReview) や、ソース間で食い違っているもの (conflict) を既定で
 * 混ぜると、誤同定した本が黙って蔵書リストに載る。
 *
 * 蔵書リストは「後で自分が信じる台帳」なので、疑わしいものを
 * 黙って入れてはならない。要確認のものを含めたい場合は明示的に選ばせる。
 */
export function exportableEntries(entries: BookEntry[], includeUnconfirmed = false): BookEntry[] {
  return entries.filter((e) => {
    if (e.status === 'excluded') return false
    if (!e.resolved?.title) return false
    if (includeUnconfirmed) return true
    // 利用者が手で選んだものは、状態にかかわらず確定として扱う
    return e.status === 'confirmed' || e.pinned
  })
}

const CSV_HEADERS = ['タイトル', '副題', '著者', '出版社', '出版年', 'ISBN', 'シリーズ', '出典', '状態'] as const

function csvEscape(v: string): string {
  if (/[",\r\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`
  return v
}

function rowOf(e: BookEntry): string[] {
  const r = e.resolved as BibRecord
  return [
    r.title ?? '',
    r.subtitle ?? '',
    (r.authors ?? []).join('; '),
    r.publisher ?? '',
    r.published ?? '',
    r.isbn13 ? formatIsbn13(r.isbn13) : '',
    r.series ?? '',
    r.source,
    e.status,
  ]
}

/**
 * CSV。Excel が UTF-8 を正しく開けるよう BOM を付ける。
 * 改行は CRLF (RFC 4180)。
 */
export function toCsv(entries: BookEntry[], includeUnconfirmed = false): string {
  const rows = exportableEntries(entries, includeUnconfirmed).map(rowOf)
  const lines = [CSV_HEADERS.join(','), ...rows.map((r) => r.map(csvEscape).join(','))]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/**
 * 再取り込み用。生の状態をそのまま保つ。
 *
 * ここだけは全件・全状態を出す。バックアップと復元が用途であり、
 * 要確認のまま残した本まで含めて元に戻せなければ意味がないため。
 */
export function toJson(entries: BookEntry[]): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2)
}

/** Markdown 表。そのままメモやブログに貼れる */
export function toMarkdown(entries: BookEntry[], includeUnconfirmed = false): string {
  const list = exportableEntries(entries, includeUnconfirmed)
  const head = '| タイトル | 著者 | 出版社 | 出版年 | ISBN |'
  const sep = '| --- | --- | --- | --- | --- |'
  const escapePipe = (s: string) => s.replace(/\|/g, '\\|')
  const rows = list.map((e) => {
    const r = e.resolved as BibRecord
    return `| ${escapePipe(r.title)} | ${escapePipe((r.authors ?? []).join(', '))} | ${escapePipe(
      r.publisher ?? '',
    )} | ${r.published ?? ''} | ${r.isbn13 ? formatIsbn13(r.isbn13) : ''} |`
  })
  return [head, sep, ...rows].join('\n') + '\n'
}

/** BibTeX のキーに使える文字だけ残す */
function bibKey(r: BibRecord, index: number): string {
  const author = (r.authors?.[0] ?? 'unknown').replace(/[^A-Za-z0-9]/g, '')
  const year = (r.published ?? '').slice(0, 4)
  const base = `${author || 'book'}${year}`
  return base ? `${base}_${index + 1}` : `book_${index + 1}`
}

function bibEscape(s: string): string {
  return s.replace(/[{}]/g, '')
}

export function toBibtex(entries: BookEntry[], includeUnconfirmed = false): string {
  return (
    exportableEntries(entries, includeUnconfirmed)
      .map((e, i) => {
        const r = e.resolved as BibRecord
        const fields: string[] = [`  title = {${bibEscape(r.title)}}`]
        if (r.authors?.length) fields.push(`  author = {${bibEscape(r.authors.join(' and '))}}`)
        if (r.publisher) fields.push(`  publisher = {${bibEscape(r.publisher)}}`)
        if (r.published) fields.push(`  year = {${r.published.slice(0, 4)}}`)
        if (r.isbn13) fields.push(`  isbn = {${formatIsbn13(r.isbn13)}}`)
        return `@book{${bibKey(r, i)},\n${fields.join(',\n')}\n}`
      })
      .join('\n\n') + '\n'
  )
}

/** ISBN だけの一覧。カーリル等の蔵書チェックに流す用途 */
export function toIsbnList(entries: BookEntry[]): string {
  const seen = new Set<string>()
  for (const e of exportableEntries(entries, false)) {
    const isbn = e.resolved?.isbn13
    if (isbn) seen.add(isbn)
  }
  return [...seen].join('\n') + (seen.size ? '\n' : '')
}

export type ExportFormat = 'csv' | 'json' | 'markdown' | 'bibtex' | 'isbn'

export const EXPORT_META: Record<ExportFormat, { label: string; ext: string; mime: string }> = {
  csv: { label: 'CSV (Excel / スプレッドシート)', ext: 'csv', mime: 'text/csv;charset=utf-8' },
  json: { label: 'JSON (バックアップ・再取り込み)', ext: 'json', mime: 'application/json' },
  markdown: { label: 'Markdown 表', ext: 'md', mime: 'text/markdown;charset=utf-8' },
  bibtex: { label: 'BibTeX', ext: 'bib', mime: 'application/x-bibtex' },
  isbn: { label: 'ISBN 一覧', ext: 'txt', mime: 'text/plain;charset=utf-8' },
}

export function renderExport(format: ExportFormat, entries: BookEntry[], includeUnconfirmed = false): string {
  switch (format) {
    case 'csv':
      return toCsv(entries, includeUnconfirmed)
    case 'json':
      return toJson(entries)
    case 'markdown':
      return toMarkdown(entries, includeUnconfirmed)
    case 'bibtex':
      return toBibtex(entries, includeUnconfirmed)
    case 'isbn':
      return toIsbnList(entries)
  }
}
