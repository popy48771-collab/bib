import { describe, expect, it } from 'vitest'
import { SerialQueue } from './queue'

const tick = () => new Promise<void>((r) => setTimeout(r, 0))

describe('SerialQueue', () => {
  it('1件ずつ順に流す（同時に走らせない）', async () => {
    const q = new SerialQueue()
    const order: string[] = []
    let running = 0
    let maxConcurrent = 0

    const job = (name: string) => async () => {
      running++
      maxConcurrent = Math.max(maxConcurrent, running)
      await tick()
      order.push(name)
      running--
    }

    q.push(job('a'))
    q.push(job('b'))
    q.push(job('c'))
    await q.whenIdle()

    expect(order).toEqual(['a', 'b', 'c'])
    expect(maxConcurrent).toBe(1)
  })

  it('1件が失敗しても残りを流す（隔離）', async () => {
    const q = new SerialQueue()
    const done: string[] = []

    q.push(async () => {
      throw new Error('OCR に失敗しました')
    })
    q.push(async () => {
      done.push('b')
    })
    await q.whenIdle()

    expect(done).toEqual(['b'])
  })

  it('上限に達したら積まずに知らせる（黙って読み落とさない）', async () => {
    const q = new SerialQueue({ capacity: 2 })
    const block = new Promise<void>((r) => setTimeout(r, 5))

    expect(q.push(() => block)).toBe(true)
    expect(q.push(() => block)).toBe(true)
    expect(q.isFull).toBe(true)
    expect(q.push(() => block)).toBe(false)

    await q.whenIdle()
    expect(q.push(() => block)).toBe(true)
    await q.whenIdle()
  })

  it('待ち件数の変化を知らせる', async () => {
    const seen: number[] = []
    const q = new SerialQueue({ onChange: (n) => seen.push(n) })
    q.push(async () => {
      await tick()
    })
    await q.whenIdle()
    expect(seen[0]).toBe(1)
    expect(seen[seen.length - 1]).toBe(0)
  })

  it('空のキューを待っても止まらない', async () => {
    await expect(new SerialQueue().whenIdle()).resolves.toBeUndefined()
  })

  it('カメラを閉じたあとでも積んだぶんは最後まで流す', async () => {
    const q = new SerialQueue()
    const done: string[] = []
    q.push(async () => {
      await tick()
      done.push('a')
    })
    q.push(async () => {
      await tick()
      done.push('b')
    })

    // 呼び出し側が参照を捨てても、キュー自身は走り切る
    await q.whenIdle()
    expect(done).toEqual(['a', 'b'])
  })
})
