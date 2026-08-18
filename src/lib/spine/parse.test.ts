import { describe, expect, it } from 'vitest'
import {
  buildQueries,
  cleanFragments,
  cleanLine,
  fragmentsFromText,
  hasJapanese,
  looksLikeAuthor,
  looksLikePublisher,
  spineFromRecognition,
  spineFromText,
  spineRawText,
  stripAuthorRole,
} from './parse'
import type { SpineRecognition } from './recognizer'

function recognition(lines: [string, number][], confidence = 0.8): SpineRecognition {
  return {
    rawText: lines.map(([t]) => t).join('\n'),
    fragments: lines.map(([text, c]) => ({ text, confidence: c })),
    confidence,
    orientation: 'vertical',
  }
}

describe('hasJapanese', () => {
  it('漢字・かなを含めば true', () => {
    expect(hasJapanese('文化政策')).toBe(true)
    expect(hasJapanese('リーダブル')).toBe(true)
    expect(hasJapanese('よくわかる')).toBe(true)
  })

  it('欧文だけなら false', () => {
    expect(hasJapanese('Clean Architecture')).toBe(false)
  })
})

describe('cleanLine', () => {
  it('日本語の行から空白を落とす', () => {
    // OCR は文字と文字の間に空白を入れてくる。日本語に分かち書きは無い
    expect(cleanLine('文化 政 策の現在')).toBe('文化政策の現在')
  })

  it('欧文の語間は残す', () => {
    expect(cleanLine('Clean  Architecture')).toBe('Clean Architecture')
  })

  it('罫線や光沢を拾った記号を落とす', () => {
    expect(cleanLine('|_ 小林真理 ~')).toBe('小林真理')
    expect(cleanLine('■ ★ 〓')).toBe('')
  })

  it('半角カナを全角に畳む', () => {
    expect(cleanLine('ﾘｰﾀﾞﾌﾞﾙ ｺｰﾄﾞ')).toBe('リーダブルコード')
  })

  it('括弧で括られた書名は中身だけにする', () => {
    expect(cleanLine('「吾輩は猫である」')).toBe('吾輩は猫である')
  })

  it('書名に出てくる記号は残す', () => {
    expect(cleanLine('C++ プログラミング')).toBe('C++プログラミング')
  })
})

describe('looksLikePublisher', () => {
  it('出版社らしい語を含む短い行を拾う', () => {
    expect(looksLikePublisher('東京大学出版会')).toBe(true)
    expect(looksLikePublisher('岩波書店')).toBe(true)
    expect(looksLikePublisher('みすず書房')).toBe(true)
    expect(looksLikePublisher('有斐閣')).toBe(true)
    expect(looksLikePublisher("O'Reilly Media")).toBe(false)
  })

  it('長い行は書名の可能性が高いので出版社とみなさない', () => {
    expect(looksLikePublisher('社会学的想像力と現代日本の課題について')).toBe(false)
  })

  it('空行は false', () => {
    expect(looksLikePublisher('  ')).toBe(false)
  })
})

describe('looksLikeAuthor', () => {
  it('役割表記が付いていれば著者', () => {
    expect(looksLikeAuthor('小林真理 著')).toBe(true)
    expect(looksLikeAuthor('田中太郎／編')).toBe(true)
  })

  it('短い漢字だけの行は著者とみなす', () => {
    expect(looksLikeAuthor('夏目漱石')).toBe(true)
  })

  it('助詞を含む行は文であって人名ではない', () => {
    expect(looksLikeAuthor('猫のはなし')).toBe(false)
  })

  it('欧文は大文字始まりの語の並びを人名とみなす', () => {
    expect(looksLikeAuthor('Dustin Boswell')).toBe(true)
    expect(looksLikeAuthor('clean architecture')).toBe(false)
  })

  it('役割表記は人名から外す', () => {
    expect(stripAuthorRole('小林真理 著')).toBe('小林真理')
    expect(stripAuthorRole('田中太郎／編')).toBe('田中太郎')
  })
})

describe('cleanFragments', () => {
  it('1文字だけの断片は落とす（飾りや隣の本の端）', () => {
    const out = cleanFragments([
      { text: '文化政策の現在', confidence: 0.9 },
      { text: '|', confidence: 0.3 },
      { text: '小林真理', confidence: 0.8 },
    ])
    expect(out.map((f) => f.text)).toEqual(['文化政策の現在', '小林真理'])
  })
})

describe('spineFromRecognition', () => {
  const rec = recognition([
    ['文化政策の現在', 0.9],
    ['小林真理', 0.8],
    ['東京大学出版会', 0.7],
  ])

  it('最も書名らしい行を title に置く', () => {
    expect(spineFromRecognition(rec)?.title).toBe('文化政策の現在')
  })

  it('出版社らしい行を publisher に振り分ける', () => {
    expect(spineFromRecognition(rec)?.publisher).toBe('東京大学出版会')
  })

  it('著者らしい行を authors に振り分ける', () => {
    expect(spineFromRecognition(rec)?.authors).toEqual(['小林真理'])
  })

  it('読めた行を全部 fragments に残す', () => {
    // 役割の推定は外れうる。照合側が組み直せるよう全行を保持する
    expect(spineFromRecognition(rec)?.fragments).toHaveLength(3)
  })

  it('何も読めなければ null', () => {
    expect(spineFromRecognition(recognition([['■', 0.2]]))).toBeNull()
    expect(spineFromRecognition(recognition([]))).toBeNull()
  })

  it('行情報が無くても生テキストから組み立てる', () => {
    const spine = spineFromRecognition({
      rawText: '吾輩は猫である\n夏目漱石',
      fragments: [],
      confidence: 0.7,
      orientation: 'vertical',
    })
    expect(spine?.title).toBe('吾輩は猫である')
    expect(spine?.authors).toEqual(['夏目漱石'])
  })

  it('出版社らしい行しか無くても、書名として拾う（取り逃がさない）', () => {
    const spine = spineFromRecognition(recognition([['岩波書店', 0.6]]))
    expect(spine?.title).toBe('岩波書店')
  })

  it('どの読み取り機構が出したかを記録する', () => {
    expect(spineFromRecognition(rec)?.engine).toBe('tesseract')
    expect(spineFromText('吾輩は猫である')?.engine).toBe('manual')
  })
})

describe('spineRawText', () => {
  it('読めた行を印刷どおりの並びで残す', () => {
    const spine = spineFromRecognition(
      recognition([
        ['文化政策の現在', 0.9],
        ['小林真理', 0.8],
      ]),
    )!
    expect(spineRawText(spine)).toBe('文化政策の現在\n小林真理')
  })
})

describe('buildQueries', () => {
  it('最有力行と著者の組を最初に出す', () => {
    const spine = spineFromRecognition(
      recognition([
        ['文化政策の現在', 0.9],
        ['小林真理', 0.8],
        ['東京大学出版会', 0.7],
      ]),
    )!
    const queries = buildQueries(spine)
    expect(queries[0]).toEqual({ title: '文化政策の現在', authors: ['小林真理'] })
  })

  it('出版社を除いた組合せと全文も用意する', () => {
    const spine = spineFromRecognition(
      recognition([
        ['文化政策の現在', 0.9],
        ['小林真理', 0.8],
        ['東京大学出版会', 0.7],
      ]),
    )!
    const titles = buildQueries(spine).map((q) => q.title)
    // 出版社を外した組合せ（役割の推定を外した場合の受け皿）
    expect(titles).toContain('文化政策の現在 小林真理')
    // OCR 全文（最後の総当たり）
    expect(titles).toContain('文化政策の現在 小林真理 東京大学出版会')
  })

  it('書名が2行に割れた場合の受け皿を作る', () => {
    const spine = spineFromRecognition(
      recognition([
        ['社会学的想像力と', 0.9],
        ['現代日本の課題', 0.85],
      ]),
    )!
    const titles = buildQueries(spine).map((q) => q.title)
    expect(titles.some((t) => t.includes('社会学的想像力と') && t.includes('現代日本の課題'))).toBe(true)
  })

  it('同じ文字列のクエリは1つにまとめる', () => {
    const spine = spineFromRecognition(recognition([['吾輩は猫である', 0.9]]))!
    expect(buildQueries(spine)).toHaveLength(1)
  })

  it('1行しか読めなくてもクエリは必ず1つ出す', () => {
    const spine = spineFromRecognition(recognition([['リーダブルコード', 0.9]]))!
    expect(buildQueries(spine)[0].title).toBe('リーダブルコード')
  })
})

describe('spineFromText / fragmentsFromText', () => {
  it('改行区切りの手入力を1冊ぶんとして読み直す', () => {
    const spine = spineFromText('吾輩は猫である\n夏目漱石\n岩波書店')
    expect(spine?.title).toBe('吾輩は猫である')
    expect(spine?.authors).toEqual(['夏目漱石'])
    expect(spine?.publisher).toBe('岩波書店')
  })

  it('空文字なら null', () => {
    expect(spineFromText('   ')).toBeNull()
  })

  it('空行は落とす', () => {
    expect(fragmentsFromText('a\n\nb')).toHaveLength(2)
  })
})
