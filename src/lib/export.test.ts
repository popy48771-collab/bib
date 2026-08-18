import { describe, expect, it } from 'vitest'
import type { BibRecord, BookEntry, BookStatus } from '../types'
import { exportableEntries, toBibtex, toCsv, toIsbnList, toJson, toMarkdown } from './export'

function record(over: Partial<BibRecord> = {}): BibRecord {
  return {
    title: '文化政策の現在',
    authors: ['小林真理'],
    publisher: '東京大学出版会',
    published: '2018-03',
    isbn13: '9784130342230',
    source: 'ndl',
    ...over,
  }
}

function entry(status: BookStatus, over: Partial<BookEntry> = {}): BookEntry {
  return {
    id: `e-${status}-${over.id ?? ''}`,
    photoId: 'p1',
    rawText: '文化政策の現在',
    extracted: { title: '文化政策の現在', authors: ['小林真理'] },
    candidates: {},
    resolved: record(),
    provenance: {},
    status,
    pinned: false,
    ...over,
  }
}

/**
 * 背表紙OCR経路では、候補は出たが確信が持てない本が必ず出る。
 * それを黙って蔵書リストへ混ぜると、誤同定した本が台帳に載る。
 */
describe('exportableEntries — 既定は確定したものだけ', () => {
  it('確定したものは出す', () => {
    expect(exportableEntries([entry('confirmed')])).toHaveLength(1)
  })

  it('要確認・差分あり・見つからず・未確認は既定で落とす', () => {
    const list = [
      entry('needsReview', { id: '1' }),
      entry('conflict', { id: '2' }),
      entry('notFound', { id: '3' }),
      entry('unverified', { id: '4' }),
    ]
    expect(exportableEntries(list)).toHaveLength(0)
  })

  it('利用者が手で選んだものは状態にかかわらず出す', () => {
    expect(exportableEntries([entry('needsReview', { pinned: true })])).toHaveLength(1)
  })

  it('除外したものは、明示的に含めても出さない', () => {
    expect(exportableEntries([entry('excluded')], true)).toHaveLength(0)
  })

  it('書名が無いものは出さない（ISBN だけ読めて書誌が引けなかった本）', () => {
    const isbnOnly = entry('confirmed', {
      resolved: { title: '', authors: [], isbn13: '9784130342230', source: 'barcode' },
    })
    expect(exportableEntries([isbnOnly])).toHaveLength(0)
  })

  it('明示的に指定すれば要確認のものも含める', () => {
    const list = [entry('confirmed', { id: '1' }), entry('needsReview', { id: '2' })]
    expect(exportableEntries(list, true)).toHaveLength(2)
  })
})

describe('各形式が既定の絞り込みに従う', () => {
  const list = [entry('confirmed', { id: '1' }), entry('needsReview', { id: '2' })]

  it('CSV は確定したものだけ', () => {
    // ヘッダー行 + 1件
    expect(toCsv(list).trimEnd().split('\r\n')).toHaveLength(2)
  })

  it('Markdown は確定したものだけ', () => {
    // ヘッダー + 区切り + 1件
    expect(toMarkdown(list).trimEnd().split('\n')).toHaveLength(3)
  })

  it('BibTeX は確定したものだけ', () => {
    expect(toBibtex(list).match(/@book\{/g)).toHaveLength(1)
  })

  it('ISBN 一覧は確定したものだけ', () => {
    expect(toIsbnList(list).trimEnd().split('\n')).toEqual(['9784130342230'])
  })

  it('JSON だけは全状態を保つ（バックアップと復元が用途）', () => {
    const parsed = JSON.parse(toJson(list)) as { entries: BookEntry[] }
    expect(parsed.entries).toHaveLength(2)
  })
})
