import { describe, expect, it } from 'vitest'
import { entriesFromIsbns, mergeIsbnResult, scoreIsbnCandidates } from './stages'
import type { BibRecord } from '../types'

const ISBN = '9784873115658'

function gbRecord(over: Partial<BibRecord> = {}): BibRecord {
  return {
    title: 'リーダブルコード',
    authors: ['Dustin Boswell', 'Trevor Foucher'],
    publisher: 'オライリージャパン',
    isbn13: ISBN,
    source: 'googleBooks',
    ...over,
  }
}

describe('entriesFromIsbns', () => {
  it('ISBN を resolved に入れ、出典を barcode として記録する', () => {
    const [e] = entriesFromIsbns([ISBN], 'scan1')
    expect(e.resolved?.isbn13).toBe(ISBN)
    expect(e.resolved?.source).toBe('barcode')
    expect(e.provenance.isbn13).toBe('barcode')
  })

  it('書名が未取得のうちは確定させない', () => {
    const [e] = entriesFromIsbns([ISBN], 'scan1')
    // ISBN は確実だが、それが何の本かはまだ書誌DBに照会していない
    expect(e.status).toBe('unverified')
    expect(e.resolved?.title).toBe('')
    expect(e.pinned).toBe(false)
  })

  it('複数件に一意なIDを振る', () => {
    const ids = entriesFromIsbns([ISBN, '9784101010014'], 'scan1').map((e) => e.id)
    expect(new Set(ids).size).toBe(2)
  })

  it('空配列なら何も作らない', () => {
    expect(entriesFromIsbns([], 'scan1')).toEqual([])
  })
})

describe('scoreIsbnCandidates', () => {
  it('ISBN が一致するものを最上位にする', () => {
    const scored = scoreIsbnCandidates(ISBN, [
      gbRecord({ title: '別の版', isbn13: '9784101010014' }),
      gbRecord(),
    ])
    expect(scored[0].record.title).toBe('リーダブルコード')
    expect(scored[0].score).toBe(1)
  })

  it('ISBN欄が空の結果も候補として残す', () => {
    // isbn: クエリの戻りなので、ISBN欄が無くてもその本ではある
    const scored = scoreIsbnCandidates(ISBN, [gbRecord({ isbn13: undefined })])
    expect(scored).toHaveLength(1)
    expect(scored[0].score).toBeLessThan(1)
    expect(scored[0].score).toBeGreaterThan(0)
  })

  it('候補が無ければ空', () => {
    expect(scoreIsbnCandidates(ISBN, [])).toEqual([])
  })
})

describe('mergeIsbnResult', () => {
  const entry = entriesFromIsbns([ISBN], 'scan1')[0]

  it('書誌が引けたら確定する（人間の確認を挟まない）', () => {
    const merged = mergeIsbnResult(entry, ISBN, scoreIsbnCandidates(ISBN, [gbRecord()]))
    // バーコードは誤読がほぼ無いので、背表紙OCR経路と違いトリアージ不要
    expect(merged.status).toBe('confirmed')
    expect(merged.resolved?.title).toBe('リーダブルコード')
  })

  it('書誌側にISBNが無くても、バーコードで読んだISBNを保持する', () => {
    const scored = scoreIsbnCandidates(ISBN, [gbRecord({ isbn13: undefined })])
    const merged = mergeIsbnResult(entry, ISBN, scored)
    expect(merged.resolved?.isbn13).toBe(ISBN)
    expect(merged.provenance.isbn13).toBe('barcode')
  })

  it('書誌側にISBNがあればその出典を尊重する', () => {
    const merged = mergeIsbnResult(entry, ISBN, scoreIsbnCandidates(ISBN, [gbRecord()]))
    expect(merged.resolved?.isbn13).toBe(ISBN)
    expect(merged.provenance.isbn13).toBe('googleBooks')
  })

  it('書誌DBで見つからなくてもISBNは捨てない', () => {
    const merged = mergeIsbnResult(entry, ISBN, [])
    expect(merged.status).toBe('notFound')
    // 読み取った ISBN は確かなので、後段(openBD/NDL)で使えるよう残す
    expect(merged.resolved?.isbn13).toBe(ISBN)
  })

  it('候補を candidates に記録する', () => {
    const scored = scoreIsbnCandidates(ISBN, [gbRecord()])
    expect(mergeIsbnResult(entry, ISBN, scored).candidates.googleBooks).toHaveLength(1)
  })

  it('同じ結果を二度統合しても壊れない（冪等）', () => {
    const scored = scoreIsbnCandidates(ISBN, [gbRecord()])
    const once = mergeIsbnResult(entry, ISBN, scored)
    const twice = mergeIsbnResult(once, ISBN, scored)
    expect(twice).toEqual(once)
  })
})
