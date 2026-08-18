import { describe, expect, it } from 'vitest'
import {
  buildQueries,
  cleanFragments,
  cleanLine,
  columnText,
  fragmentsFromText,
  hasJapanese,
  looksLikeAuthor,
  looksLikePublisher,
  spineFromText,
  spineRawText,
  spinesFromRecognition,
  splitColumn,
  stripAuthorRole,
  worthNewEntry,
} from './parse'
import type { SpineColumn, SpineRecognition } from './recognizer'
import type { OcrFragment } from '../../types'

/** 文字の高さ。塊の切り分けはこれを基準に判定される */
const H = 0.03

/**
 * 縦に並んだ列を作る。塊の中は詰め、塊のあいだは大きく空ける
 * （背表紙で書名と著者のあいだに空きがあるのと同じ）。
 */
function makeColumn(segments: string[][], confidence = 0.8): SpineColumn {
  const words: OcrFragment[] = []
  let y = 0.02
  for (const [i, segment] of segments.entries()) {
    if (i > 0) y += H * 2
    for (const text of segment) {
      words.push({ text, confidence, box: { x: 0.5, y, width: 0.02, height: H } })
      y += H * 1.05
    }
  }
  return { words, box: { x: 0.5, y: 0.02, width: 0.02, height: y }, confidence }
}

function recognition(columns: SpineColumn[], confidence = 0.8): SpineRecognition {
  return { columns, confidence, orientation: 'vertical' }
}

describe('hasJapanese', () => {
  it('漢字・かなを含めば true', () => {
    expect(hasJapanese('文化政策')).toBe(true)
    expect(hasJapanese('リーダブル')).toBe(true)
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
    expect(looksLikePublisher('有斐閣')).toBe(true)
  })

  it('長い行は書名の可能性が高いので出版社とみなさない', () => {
    expect(looksLikePublisher('社会学的想像力と現代日本の課題について')).toBe(false)
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

/**
 * 列の切り分けは、この経路の要になる。
 * OCR は列全体を1つの塊として返してくるので（「思考の整理学外山滋比古ちくま文庫」）、
 * ここで切れないと書名で引けない。
 */
describe('splitColumn', () => {
  it('大きな縦の空きで塊を分ける', () => {
    const column = makeColumn([['日本', '文化', 'の', '歴史'], ['尾藤', '正英'], ['岩波', '新書']])
    expect(splitColumn(column.words).map((f) => f.text)).toEqual([
      '日本文化の歴史',
      '尾藤正英',
      '岩波新書',
    ])
  })

  it('詰まっている語は分けない', () => {
    const column = makeColumn([['文化', '政策', 'の', '現在']])
    expect(splitColumn(column.words).map((f) => f.text)).toEqual(['文化政策の現在'])
  })

  it('語の枠が重なっていても順序を保つ', () => {
    // Tesseract は縦書きで語の枠を重ねて返すことがある
    const words: OcrFragment[] = [
      { text: '思考', confidence: 0.9, box: { x: 0.5, y: 0.10, width: 0.02, height: 0.12 } },
      { text: 'の', confidence: 0.9, box: { x: 0.5, y: 0.14, width: 0.02, height: 0.02 } },
      { text: '整理', confidence: 0.9, box: { x: 0.5, y: 0.16, width: 0.02, height: 0.05 } },
      { text: '学', confidence: 0.9, box: { x: 0.5, y: 0.23, width: 0.02, height: 0.02 } },
    ]
    expect(splitColumn(words).map((f) => f.text)).toEqual(['思考の整理学'])
  })

  it('y が下から上へ並ぶ列でも、読み順を壊さない', () => {
    /*
     * 実測: Tesseract の縦書きは、読み順どおりに語を返しながら
     * その y が下から上へ並ぶことがある。y の昇順に直すと
     * 「人間失格」が「失格間人」になった。
     */
    const words: OcrFragment[] = [
      { text: '人', confidence: 0.9, box: { x: 0.5, y: 0.85, width: 0.02, height: 0.05 } },
      { text: '間', confidence: 0.9, box: { x: 0.5, y: 0.75, width: 0.02, height: 0.05 } },
      { text: '失格', confidence: 0.9, box: { x: 0.5, y: 0.54, width: 0.02, height: 0.1 } },
    ]
    expect(splitColumn(words).map((f) => f.text).join('')).toBe('人間失格')
  })

  it('y が下から上へ並ぶ列でも、大きな空きでは分ける', () => {
    const words: OcrFragment[] = [
      { text: '書名', confidence: 0.9, box: { x: 0.5, y: 0.8, width: 0.02, height: 0.05 } },
      { text: 'で', confidence: 0.9, box: { x: 0.5, y: 0.74, width: 0.02, height: 0.05 } },
      { text: 'す', confidence: 0.9, box: { x: 0.5, y: 0.68, width: 0.02, height: 0.05 } },
      { text: '著者', confidence: 0.9, box: { x: 0.5, y: 0.2, width: 0.02, height: 0.05 } },
    ]
    expect(splitColumn(words).map((f) => f.text)).toEqual(['書名です', '著者'])
  })

  it('位置が無ければ1つの塊にまとめる', () => {
    const out = splitColumn([
      { text: '文化政策', confidence: 0.9 },
      { text: 'の現在', confidence: 0.8 },
    ])
    expect(out).toHaveLength(1)
    expect(out[0].text).toBe('文化政策の現在')
  })

  it('語が無ければ空', () => {
    expect(splitColumn([])).toEqual([])
  })

  it('塊の位置は、含む語を囲む枠になる', () => {
    const [first] = splitColumn(makeColumn([['日本', '文化'], ['尾藤']]).words)
    expect(first.box?.y).toBeCloseTo(0.02, 5)
    expect(first.box!.height).toBeGreaterThan(H)
  })
})

describe('spinesFromRecognition', () => {
  const rec = recognition([
    makeColumn([['文化', '政策', 'の', '現在'], ['小林', '真理'], ['東京', '大学', '出版', '会']]),
    makeColumn([['思考', 'の', '整理', '学'], ['外山', '滋比古'], ['ちくま', '文庫']]),
  ])

  it('列の数だけ背表紙を返す', () => {
    // 1枚のコマから棚一段ぶんが取れる。ここが以前との最大の違い
    expect(spinesFromRecognition(rec)).toHaveLength(2)
  })

  it('最も書名らしい塊を title に置く', () => {
    expect(spinesFromRecognition(rec).map((s) => s.title)).toEqual([
      '文化政策の現在',
      '思考の整理学',
    ])
  })

  it('出版社と著者を振り分ける', () => {
    const [first] = spinesFromRecognition(rec)
    expect(first.publisher).toBe('東京大学出版会')
    expect(first.authors).toEqual(['小林真理'])
  })

  it('読めた塊を全部 fragments に残す', () => {
    // 役割の推定は外れうる。照合側が組み直せるよう全部保持する
    expect(spinesFromRecognition(rec)[0].fragments).toHaveLength(3)
  })

  it('列の位置を持ち回る（確認用の切り出しに使う）', () => {
    expect(spinesFromRecognition(rec)[0].box).toBeDefined()
  })

  it('著者名の方が長くても、上に刷られている書名を採る', () => {
    // 「罪と罰 中」と「ドストエフスキー」。長さだけで選ぶと必ず外す
    const [spine] = spinesFromRecognition(
      recognition([makeColumn([['罪と罰', '中'], ['ドスト', 'エフ', 'スキー'], ['岩波', '書店']])]),
    )
    expect(spine.title).toBe('罪と罰中')
    expect(spine.publisher).toBe('岩波書店')
  })

  it('読めなかった列は落とす', () => {
    const noisy = recognition([makeColumn([['■']]), makeColumn([['文化', '政策', 'の', '現在']])])
    expect(spinesFromRecognition(noisy).map((s) => s.title)).toEqual(['文化政策の現在'])
  })

  it('列が無ければ何も返さない', () => {
    expect(spinesFromRecognition(recognition([]))).toEqual([])
  })

  it('どの読み取り機構が出したかを記録する', () => {
    expect(spinesFromRecognition(rec)[0].engine).toBe('tesseract')
    expect(spineFromText('吾輩は猫である')?.engine).toBe('manual')
  })

  it('画像対応モデルが組み立てた背表紙は再解釈せず受け渡す', () => {
    const [spine] = spinesFromRecognition(
      {
        columns: [],
        extracted: [
          {
            title: '思考の整理学',
            authors: ['外山滋比古'],
            confidence: 0.9,
          },
        ],
        confidence: 0.9,
        orientation: 'unknown',
      },
      'remoteVision',
    )
    expect(spine).toMatchObject({
      title: '思考の整理学',
      authors: ['外山滋比古'],
      engine: 'remoteVision',
    })
  })
})

describe('columnText', () => {
  it('列の中身をつないで返す（同じ背表紙かどうかの照合に使う）', () => {
    expect(columnText(makeColumn([['文化', '政策'], ['小林']]))).toBe('文化政策小林')
  })
})

describe('spineRawText', () => {
  it('読めた塊を印刷どおりの並びで残す', () => {
    const [spine] = spinesFromRecognition(
      recognition([makeColumn([['文化', '政策', 'の', '現在'], ['小林', '真理']])]),
    )
    expect(spineRawText(spine)).toBe('文化政策の現在\n小林真理')
  })
})

describe('buildQueries', () => {
  const spine = spinesFromRecognition(
    recognition([
      makeColumn([['文化', '政策', 'の', '現在'], ['小林', '真理'], ['東京', '大学', '出版', '会']]),
    ]),
  )[0]

  it('最有力の塊と著者の組を最初に出す', () => {
    expect(buildQueries(spine)[0]).toEqual({
      title: '文化政策の現在',
      authors: ['小林真理'],
      mode: 'title',
    })
  })

  it('出版社を除いた組合せを用意する', () => {
    expect(buildQueries(spine).map((q) => q.title)).toContain('文化政策の現在 小林真理')
  })

  it('末尾を削った前方一致を用意する', () => {
    // 実測で崩れるのは末尾の1〜2文字が多い。「文化政策の現在」→「文化政策の現不」
    const titles = buildQueries(spine).map((q) => q.title)
    expect(titles).toContain('文化政策の現')
  })

  it('最後は、半分まで削った頭を全項目キーワードで引く', () => {
    // 塊の切り分けに失敗した行（書名に出版社が繋がる）の受け皿。
    // 呼び出し側はこの1件を必ず撃つので、一番広いものを末尾に置く
    const last = buildQueries(spine).at(-1)
    expect(last?.mode).toBe('any')
    expect(last?.title).toBe('文化政策')
  })

  it('書名が短いときは前方一致を作らない（当たりが広くなりすぎる）', () => {
    const short = spinesFromRecognition(recognition([makeColumn([['猫', 'の', '本']])]))[0]
    expect(buildQueries(short).every((q) => q.title !== '猫の')).toBe(true)
  })

  it('同じ文字列のクエリは1つにまとめる', () => {
    const one = spinesFromRecognition(recognition([makeColumn([['吾輩', 'は', '猫']])]))[0]
    const titles = buildQueries(one).map((q) => `${q.mode}:${q.title}`)
    expect(new Set(titles).size).toBe(titles.length)
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

describe('worthNewEntry', () => {
  it('4文字に満たない読みでは、単独で行を作らない', () => {
    expect(worthNewEntry('の整理')).toBe(false)
    expect(worthNewEntry('ェェ')).toBe(false)
    expect(worthNewEntry('')).toBe(false)
  })

  it('4文字あれば行にしてよい', () => {
    expect(worthNewEntry('思考の整理学')).toBe(true)
  })

  it('記号や空白は文字数に数えない', () => {
    expect(worthNewEntry('「 の 」')).toBe(false)
  })
})
