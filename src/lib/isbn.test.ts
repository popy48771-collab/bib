import { describe, expect, it } from 'vitest'
import {
  extractIsbn13,
  formatIsbn13,
  isbn10To13,
  isValidIsbn10,
  isValidIsbn13,
  toIsbn13,
} from './isbn'

// 実在する書籍の ISBN を使う
// 『吾輩は猫である』岩波文庫: ISBN-10 4003101014 / ISBN-13 9784003101018
const I10 = '4003101014'
const I13 = '9784003101018'

describe('isValidIsbn10', () => {
  it('正しいISBN-10を受理する', () => {
    expect(isValidIsbn10(I10)).toBe(true)
  })

  it('チェックディジット違いを弾く', () => {
    expect(isValidIsbn10('4003101015')).toBe(false)
  })

  it('末尾Xのチェックディジットを扱える', () => {
    // 043942089 のチェックディジットは 10 → 'X'
    expect(isValidIsbn10('043942089X')).toBe(true)
  })

  it('桁数違いを弾く', () => {
    expect(isValidIsbn10('400310101')).toBe(false)
  })
})

describe('isValidIsbn13', () => {
  it('正しいISBN-13を受理する', () => {
    expect(isValidIsbn13(I13)).toBe(true)
  })

  it('チェックディジット違いを弾く', () => {
    expect(isValidIsbn13('9784003101019')).toBe(false)
  })
})

describe('isbn10To13', () => {
  it('978プレフィックスで変換する', () => {
    expect(isbn10To13(I10)).toBe(I13)
  })

  it('不正な入力にはnullを返す', () => {
    expect(isbn10To13('1234567890')).toBeNull()
  })
})

describe('toIsbn13', () => {
  it('ISBN-13はそのまま返す', () => {
    expect(toIsbn13(I13)).toBe(I13)
  })

  it('ISBN-10は変換する', () => {
    expect(toIsbn13(I10)).toBe(I13)
  })

  it('ハイフン区切りを受け付ける', () => {
    expect(toIsbn13('978-4-00-310101-8')).toBe(I13)
  })

  it('チェックディジットが合わないものはnull（別の本を引かないため）', () => {
    expect(toIsbn13('9784003101019')).toBeNull()
  })

  it('undefined/空文字を安全に扱う', () => {
    expect(toIsbn13(undefined)).toBeNull()
    expect(toIsbn13('')).toBeNull()
  })
})

describe('extractIsbn13', () => {
  it('接頭辞つきの表記から拾う', () => {
    expect(extractIsbn13('ISBN978-4-00-310101-8')).toBe(I13)
  })

  it('ISBN-10混じりの文字列から拾って13に変換する', () => {
    expect(extractIsbn13('ISBN4-00-310101-4')).toBe(I13)
  })

  it('ISBNが無ければnull', () => {
    expect(extractIsbn13('岩波書店')).toBeNull()
  })

  it('チェックディジット不正な13桁は採用しない', () => {
    expect(extractIsbn13('9784003101019')).toBeNull()
  })
})

describe('formatIsbn13', () => {
  it('13桁をそのまま返す(誤ったハイフン位置を出さないため)', () => {
    expect(formatIsbn13(I13)).toBe(I13)
  })

  it('ハイフン入力は除去して13桁に揃える', () => {
    expect(formatIsbn13('978-4-00-310101-8')).toBe(I13)
  })

  it('不正な値はそのまま返す', () => {
    expect(formatIsbn13('abc')).toBe('abc')
  })
})
