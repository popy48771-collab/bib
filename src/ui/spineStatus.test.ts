import { describe, expect, it } from 'vitest'
import { describeCloseHint, describeSpineStatus, type SpineStatusInput } from './spineStatus'

function input(over: Partial<SpineStatusInput> = {}): SpineStatusInput {
  return {
    ready: true,
    preparing: false,
    busy: false,
    ocrPending: 0,
    lookupPending: 0,
    captured: 0,
    advice: null,
    lastOutcome: null,
    ...over,
  }
}

/**
 * この画面の要は「いつ読み取りを終えてよいか」に答えること。
 * 1枚に棚一段が写り、読み取りは数秒から十数秒かかるので、
 * 撮った瞬間と読み終わった瞬間がずれる。
 */
describe('describeSpineStatus — 終えどきを伝える', () => {
  it('残りが無く、いま映っている棚も取り込み済みなら「終わった」と言う', () => {
    const s = describeSpineStatus(input({ captured: 2, lastOutcome: 'duplicate' }))
    expect(s.label).toContain('読み取り終わりました')
    expect(s.detail).toContain('読み取りを終える')
    expect(s.settled).toBe(true)
  })

  it('読み取りが残っているあいだは、残りの枚数を見せる', () => {
    const s = describeSpineStatus(input({ captured: 2, ocrPending: 3, lastOutcome: 'duplicate' }))
    expect(s.label).toContain('3 枚')
    expect(s.settled).toBe(false)
  })

  it('照合が残っているあいだも、終わったとは言わない', () => {
    // 取り込み済みの表示で覆うと、処理中なのに終わったように見える
    const s = describeSpineStatus(input({ captured: 2, lookupPending: 5, lastOutcome: 'duplicate' }))
    expect(s.label).toContain('5 件')
    expect(s.settled).toBe(false)
  })

  it('1枚も撮っていないうちは「終わった」と言わない', () => {
    expect(describeSpineStatus(input()).settled).toBe(false)
    expect(describeSpineStatus(input()).label).toContain('棚を探しています')
  })

  it('撮ったあと次の棚を向いていれば、次を促す', () => {
    const s = describeSpineStatus(input({ captured: 1 }))
    expect(s.label).toContain('次の棚')
    expect(s.settled).toBe(true)
  })
})

describe('describeSpineStatus — 使えない理由を先に出す', () => {
  it('カメラが映っていないことが最優先', () => {
    const s = describeSpineStatus(input({ ready: false, ocrPending: 3, captured: 2 }))
    expect(s.label).toContain('カメラを起動')
  })

  it('OCR の準備中は、撮れないことを言う', () => {
    expect(describeSpineStatus(input({ preparing: true })).label).toContain('準備しています')
  })

  it('追いついていないことは、残り枚数より先に出す', () => {
    const s = describeSpineStatus(input({ busy: true, ocrPending: 3, captured: 1 }))
    expect(s.label).toContain('追いついていません')
  })

  it('画質が足りない理由はそのまま出す', () => {
    const s = describeSpineStatus(input({ advice: '棚が暗すぎます。' }))
    expect(s.detail).toBe('棚が暗すぎます。')
  })

  it('取り込んだ直後は、取り込めたことを伝える', () => {
    const s = describeSpineStatus(input({ captured: 1, lastOutcome: 'queued' }))
    expect(s.kind).toBe('success')
    expect(s.label).toContain('取り込みました')
  })

  it('動きで撮れていないときは、止めるように言う', () => {
    // 黙って待たせると「かざしているのに何も起きない」ように見える
    const s = describeSpineStatus(input({ moving: true }))
    expect(s.label).toContain('動いています')
    expect(s.detail).toContain('止めてください')
  })

  it('画質が足りない理由は、動きより先に出す', () => {
    const s = describeSpineStatus(input({ moving: true, advice: '棚が暗すぎます。' }))
    expect(s.detail).toBe('棚が暗すぎます。')
  })

  it('取り込めた直後は、動いていても取り込めたことを優先する', () => {
    // 次の段へ移し始めた瞬間に「動いています」へ変わると、撮れたのか判らない
    const s = describeSpineStatus(input({ captured: 1, moving: true, lastOutcome: 'queued' }))
    expect(s.label).toContain('取り込みました')
  })
})

describe('describeCloseHint — 押していいのかに答える', () => {
  it('残りがあるなら、閉じても続くことを言う', () => {
    expect(describeCloseHint({ ocrPending: 2, lookupPending: 0, captured: 3 })).toContain(
      '最後まで続きます',
    )
  })

  it('残りが無いなら、すべて終わっていることを言う', () => {
    expect(describeCloseHint({ ocrPending: 0, lookupPending: 0, captured: 3 })).toContain(
      'すべて終わっています',
    )
  })

  it('まだ1枚も撮っていなければ何も言わない', () => {
    expect(describeCloseHint({ ocrPending: 0, lookupPending: 0, captured: 0 })).toBeNull()
  })
})
