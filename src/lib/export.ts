/**
 * 出力形式
 *
 * 「蔵書リストを作る」のが目的なので、ここが最終成果物。
 * 表計算・他サービスへの取り込み・再取り込みの3用途を押さえる。
 */

import type { BookEntry, BibRecord } from '../types'
import { formatIsbn13 } from './isbn'

/** 出力対象。除外されたものと未確認のものは既定で落とす */
export function exportableEntries(entries: BookEntry[], includeUnverified = false): BookEntry[] {
  return entries.filter((e) => {
    if (e.status === 'excluded') return false
    if (!e.resolved) return false
    if (!includeUnverified && e.status === 'unverified') return false
    return true
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
export function toCsv(entries: BookEntry[], includeUnverified = false): string {
  const rows = exportableEntries(entries, includeUnverified).map(rowOf)
  const lines = [CSV_HEADERS.join(','), ...rows.map((r) => r.map(csvEscape).join(','))]
  return '﻿' + lines.join('\r\n') + '\r\n'
}

/** 再取り込み用。生の状態をそのまま保つ */
export function toJson(entries: BookEntry[]): string {
  return JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), entries }, null, 2)
}

/** Markdown 表。そのままメモやブログに貼れる */
export function toMarkdown(entries: BookEntry[], includeUnverified = false): string {
  const list = exportableEntries(entries, includeUnverified)
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

export function toBibtex(entries: BookEntry[], includeUnverified = false): string {
  return (
    exportableEntries(entries, includeUnverified)
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

export function renderExport(format: ExportFormat, entries: BookEntry[], includeUnverified = false): string {
  switch (format) {
    case 'csv':
      return toCsv(entries, includeUnverified)
    case 'json':
      return toJson(entries)
    case 'markdown':
      return toMarkdown(entries, includeUnverified)
    case 'bibtex':
      return toBibtex(entries, includeUnverified)
    case 'isbn':
      return toIsbnList(entries)
  }
}
