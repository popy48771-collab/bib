import { describe, expect, it } from 'vitest'
import { SpineTracker } from './tracker'

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
