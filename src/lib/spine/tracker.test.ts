import { describe, expect, it } from 'vitest'
import { SpineTracker, bandOverlap } from './tracker'
import { normalizeForMatch } from '../normalize'

/** 8x8 の平均ハッシュ。1文字変えると距離が 1〜4 動く */
const HASH_A = '0f1e2d3c4b5a6978'
const HASH_B = 'f0e1d2c3b4a59687'

describe('SpineTracker — OCR前の視覚的な重複', () => {
  it('初めて見るコマは取り込む', () => {
    const t = new SpineTracker()
    expect(t.shouldCapture(HASH_A, 1000)).toBe(true)
  })

  it('直前に取り込んだのと同じ見た目なら取り込まない', () => {
    const t = new SpineTracker()
    t.noteCapture(HASH_A, 1000)
    // レーンに同じ背表紙を置き続けている状態。1ジョブで足りる
    expect(t.shouldCapture(HASH_A, 1200)).toBe(false)
  })

  it('別の背表紙なら取り込む', () => {
    const t = new SpineTracker()
    t.noteCapture(HASH_A, 1000)
    expect(t.shouldCapture(HASH_B, 1200)).toBe(true)
  })

  it('時間が経てば同じ見た目でも取り込む（同じ本を2冊持っていることがある）', () => {
    const t = new SpineTracker({ windowMs: 1000 })
    t.noteCapture(HASH_A, 1000)
    expect(t.shouldCapture(HASH_A, 5000)).toBe(true)
  })

  it('レーンに写り続けているあいだは窓を切らさない', () => {
    // 1冊の背表紙を眺めたまま止まっていても、撮り直さない
    const t = new SpineTracker({ windowMs: 1000 })
    t.noteCapture(HASH_A, 1000)
    expect(t.shouldCapture(HASH_A, 1800)).toBe(false)
    expect(t.shouldCapture(HASH_A, 2600)).toBe(false)
    expect(t.shouldCapture(HASH_A, 3400)).toBe(false)
  })
})

describe('SpineTracker — OCR後の文字列による重複', () => {
  it('十分似た文字列は同じ背表紙の複数観測として束ねる', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在 小林真理', 1000)

    // 読み直すたびに文字は揺れる。1文字違いで別の本にはしない
    const same = t.findSame('文化政策の現在 小林真理', 1300)
    expect(same?.entryId).toBe('e1')
  })

  it('別の本は束ねない', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在', 1000)
    expect(t.findSame('ノルウェイの森 村上春樹', 1200)).toBeUndefined()
  })

  it('再観測のたびに観測回数を増やす', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在', 1000)
    const again = t.note('e1', '文化政策の現在', 1200)
    expect(again.entryId).toBe('e1')
    expect(again.count).toBe(2)
  })

  it('より長く読めた方を代表の文字列にする', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在', 1000)
    const better = t.note('e1', '文化政策の現在 小林真理', 1100)
    expect(better.key.length).toBeGreaterThan('文化政策の現在'.length)
  })

  it('何冊も先で同じ本が出たら別の本として扱う（棚の離れた場所の同じ本）', () => {
    const t = new SpineTracker({ recentCount: 3 })
    t.note('e1', '文化政策の現在', 1000)
    for (const [i, title] of ['ノルウェイの森', '吾輩は猫である', '銀河鉄道の夜'].entries()) {
      t.note(`e${i + 2}`, title, 2000 + i)
    }
    // 黙って束ねない。2冊持っている可能性がある
    expect(t.findSame('文化政策の現在')).toBeUndefined()
  })

  it('時間が空いても、直近に読んだものなら同じ本として束ねる', () => {
    // OCR は1冊あたり数秒かかる。待ち行列が伸びると、続けて撮った2枚が
    // 10秒以上離れて処理される。ここを時間で切ると同じ本が何行にも増える
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在', 1000)
    expect(t.findSame('文化政策の現在', 60000)?.entryId).toBe('e1')
  })

  it('再観測したものは直近に読んだものとして扱い直す', () => {
    const t = new SpineTracker({ recentCount: 2 })
    t.note('e1', '文化政策の現在', 1000)
    t.note('e2', 'ノルウェイの森', 1100)
    t.note('e1', '文化政策の現在', 1200)
    // e1 を読み直したので、押し出されるのは e2 の方
    t.note('e3', '吾輩は猫である', 1300)
    expect(t.findSame('文化政策の現在')?.entryId).toBe('e1')
    expect(t.findSame('ノルウェイの森')).toBeUndefined()
  })

  it('空文字は何とも一致させない', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在', 1000)
    expect(t.findSame('', 1100)).toBeUndefined()
  })
})

/*
 * ここから下は「1つの棚から80件が並んだ」への対処。
 *
 * 抑止を文字列(いちばん壊れているもの)だけに頼ると、読みが部分的なときに
 * 同じ本が別の断片として何行にも増える。位置で束ねられることを固定する。
 */
describe('bandOverlap', () => {
  it('重なっていない短冊は 0', () => {
    expect(bandOverlap({ start: 0.1, end: 0.2 }, { start: 0.3, end: 0.4 })).toBe(0)
  })

  it('狭い方の幅に対する割合で測る', () => {
    // 0.10..0.20 と 0.15..0.35 → 重なり 0.05 / 狭い方 0.10
    expect(bandOverlap({ start: 0.1, end: 0.2 }, { start: 0.15, end: 0.35 })).toBeCloseTo(0.5)
  })

  it('境界が数画素ずれた同じ短冊は、ほぼ全部が重なる', () => {
    expect(bandOverlap({ start: 0.1, end: 0.2 }, { start: 0.104, end: 0.204 })).toBeGreaterThan(0.9)
  })
})

describe('SpineTracker（位置での突き合わせ）', () => {
  const site = (start: number, end: number, frameId: number, shelf = 1) => ({
    band: { start, end },
    frameId,
    shelf,
  })

  it('同じ棚の別のコマで、重なる短冊は同じ本として束ねる（文字列が違っても）', () => {
    const t = new SpineTracker()
    t.note('e1', '思考の整', 1000, site(0.3, 0.36, 1))
    // 次のコマ。読めた断片は別物だが、同じ位置なので同じ本である
    expect(t.findSame('の整理学外山', 2000, site(0.302, 0.363, 2))?.entryId).toBe('e1')
  })

  it('同じコマの中の隣り合う短冊は、重なっていても別の本として扱う', () => {
    const t = new SpineTracker()
    t.note('e1', '思考の整理学', 1000, site(0.3, 0.36, 1))
    // はみ出しぶんが重なるが、同じコマなので束ねてはならない
    expect(t.findSame('人間失格', 1000, site(0.355, 0.42, 1))).toBeUndefined()
  })

  it('棚を移れば、同じ位置でも別の本として扱う', () => {
    const t = new SpineTracker()
    t.note('e1', '思考の整理学', 1000, site(0.3, 0.36, 1, 1))
    expect(t.findSame('別の棚の本', 2000, site(0.3, 0.36, 2, 2))).toBeUndefined()
  })

  it('位置が離れていれば、同じ棚でも別の本として扱う', () => {
    const t = new SpineTracker()
    t.note('e1', '思考の整理学', 1000, site(0.1, 0.16, 1))
    expect(t.findSame('人間失格', 2000, site(0.7, 0.76, 2))).toBeUndefined()
  })

  it('位置で束ねたら、その行に足す（行は増えない）', () => {
    const t = new SpineTracker()
    t.note('e1', '思考の整', 1000, site(0.3, 0.36, 1))
    const again = t.note('e2', '思考の整理学 外山滋比古', 2000, site(0.3, 0.36, 2))
    expect(again.entryId).toBe('e1')
    expect(again.count).toBe(2)
    // より長く読めた方を代表にする
    expect(again.key).toBe(normalizeForMatch('思考の整理学 外山滋比古'))
  })

  it('位置が無ければ、これまでどおり文字列で束ねる', () => {
    const t = new SpineTracker()
    t.note('e1', '文化政策の現在 小林真理', 1000)
    expect(t.findSame('文化政策の現在 小林真理')?.entryId).toBe('e1')
  })
})

describe('SpineTracker#shelfFor', () => {
  it('見た目が近いコマは同じ棚とみなす', () => {
    const t = new SpineTracker()
    const first = t.shelfFor('0000000000000000')
    // 2ビットだけ違う = 手ぶれや露出の揺れの範囲
    expect(t.shelfFor('0000000000000003')).toBe(first)
  })

  it('見た目が大きく変われば別の棚とみなす', () => {
    const t = new SpineTracker()
    const first = t.shelfFor('0000000000000000')
    expect(t.shelfFor('ffffffffffffffff')).not.toBe(first)
  })
})
