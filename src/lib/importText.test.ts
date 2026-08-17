import { describe, expect, it } from 'vitest'
import { asIsbn13, extractJsonBlock, parseImportedBooks } from './importText'

describe('asIsbn13', () => {
  it('978/979 の ISBN-13 を受理する', () => {
    expect(asIsbn13('9784873115658')).toBe('9784873115658')
    expect(asIsbn13('978-4-87311-565-8')).toBe('9784873115658')
    expect(asIsbn13('9798602401820')).toBe('9798602401820')
  })

  it('ISBN-10 を13桁に変換する', () => {
    expect(asIsbn13('4873115655')).toBe('9784873115658')
  })

  it('書籍バーコード下段(192...)を拒否する', () => {
    // EAN-13 としてはチェックディジットが通るが ISBN ではない
    expect(asIsbn13('1923000012004')).toBeNull()
  })

  it('チェックディジット不一致を拒否する', () => {
    expect(asIsbn13('9784873115659')).toBeNull()
    expect(asIsbn13('4873115656')).toBeNull()
  })

  it('ISBNでない文字列を拒否する', () => {
    expect(asIsbn13('吾輩は猫である')).toBeNull()
    expect(asIsbn13('')).toBeNull()
    expect(asIsbn13('12345')).toBeNull()
  })
})

describe('extractJsonBlock', () => {
  it('コードフェンスと前後の説明文から JSON を取り出す', () => {
    const text = 'はい、読み取りました。\n```json\n{"books":[{"title":"A"}]}\n```\n以上です。'
    expect(extractJsonBlock(text)).toBe('{"books":[{"title":"A"}]}')
  })

  it('文字列リテラル内の括弧を終端と誤認しない', () => {
    const text = '{"books":[{"title":"括弧} を含む題名"}]}'
    expect(extractJsonBlock(text)).toBe(text)
  })

  it('エスケープされた引用符を扱える', () => {
    const text = '{"title":"引用\\"あり"}'
    expect(extractJsonBlock(text)).toBe(text)
  })

  it('JSON が無ければ null', () => {
    expect(extractJsonBlock('本のタイトルだけの行')).toBeNull()
  })
})

describe('parseImportedBooks — JSON 経路', () => {
  it('指定どおりの JSON を読む', () => {
    const { spines } = parseImportedBooks(
      '{"books":[{"title":"リーダブルコード","authors":["Dustin Boswell"],"publisher":"オライリー","confidence":0.9}]}',
    )
    expect(spines).toHaveLength(1)
    expect(spines[0].title).toBe('リーダブルコード')
    expect(spines[0].authors).toEqual(['Dustin Boswell'])
    expect(spines[0].publisher).toBe('オライリー')
    expect(spines[0].confidence).toBe(0.9)
  })

  it('素の配列でも読む', () => {
    const { spines } = parseImportedBooks('[{"title":"A"},{"title":"B"}]')
    expect(spines.map((s) => s.title)).toEqual(['A', 'B'])
  })

  it('日本語キーでも読む', () => {
    const { spines } = parseImportedBooks('[{"タイトル":"こころ","著者":"夏目漱石"}]')
    expect(spines[0].title).toBe('こころ')
    expect(spines[0].authors).toEqual(['夏目漱石'])
  })

  it('author が文字列でも配列に均す', () => {
    const { spines } = parseImportedBooks('[{"title":"A","author":"甲, 乙"}]')
    expect(spines[0].authors).toEqual(['甲', '乙'])
  })

  it('ISBN だけの要素は ISBN として拾う', () => {
    const { isbns } = parseImportedBooks('[{"isbn":"978-4-87311-565-8"}]')
    expect(isbns).toEqual(['9784873115658'])
  })

  it('confidence が無ければ既定値を入れる', () => {
    const { spines } = parseImportedBooks('[{"title":"A"}]')
    expect(spines[0].confidence).toBeGreaterThan(0)
    expect(spines[0].confidence).toBeLessThanOrEqual(1)
  })
})

describe('parseImportedBooks — 素のテキスト経路', () => {
  it('1行1冊として読む', () => {
    const { spines } = parseImportedBooks('こころ\n吾輩は猫である\n')
    expect(spines.map((s) => s.title)).toEqual(['こころ', '吾輩は猫である'])
  })

  it('箇条書き記号と連番を落とす', () => {
    const { spines } = parseImportedBooks('- こころ\n2. 坊っちゃん\n・三四郎\n')
    expect(spines.map((s) => s.title)).toEqual(['こころ', '坊っちゃん', '三四郎'])
  })

  it('区切り記号で著者・出版社に割る', () => {
    const { spines } = parseImportedBooks('こころ / 夏目漱石 / 新潮社')
    expect(spines[0]).toMatchObject({
      title: 'こころ',
      authors: ['夏目漱石'],
      publisher: '新潮社',
    })
  })

  it('ISBN の羅列も取り込める', () => {
    const { isbns, spines } = parseImportedBooks('9784873115658\n978-4-10-101001-4\n')
    expect(isbns).toEqual(['9784873115658', '9784101010014'])
    expect(spines).toHaveLength(0)
  })

  it('書名と ISBN が混在しても振り分ける', () => {
    const { isbns, spines } = parseImportedBooks('こころ\n9784873115658\n坊っちゃん')
    expect(isbns).toEqual(['9784873115658'])
    expect(spines.map((s) => s.title)).toEqual(['こころ', '坊っちゃん'])
  })

  it('コードフェンスや見出しの残骸を捨てる', () => {
    const { spines } = parseImportedBooks('```\n# 読み取り結果\nこころ\n```')
    expect(spines.map((s) => s.title)).toEqual(['こころ'])
  })

  it('空文字は空の結果', () => {
    expect(parseImportedBooks('   \n\n')).toEqual({ spines: [], isbns: [] })
  })
})

describe('parseImportedBooks — 重複除去', () => {
  it('同じ本を二度取り込まない', () => {
    const { spines } = parseImportedBooks('こころ / 夏目漱石\nこころ / 夏目漱石')
    expect(spines).toHaveLength(1)
  })

  it('同じ ISBN を二度取り込まない', () => {
    const { isbns } = parseImportedBooks('9784873115658\n978-4-87311-565-8')
    expect(isbns).toEqual(['9784873115658'])
  })

  it('同名でも著者が違えば別の本として残す', () => {
    const { spines } = parseImportedBooks('こころ / 夏目漱石\nこころ / 別人')
    expect(spines).toHaveLength(2)
  })
})
