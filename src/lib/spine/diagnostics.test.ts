import { describe, expect, it } from 'vitest'
import { SpineDiagnosticsLog, buildReport, type FrameDiagnostic } from './diagnostics'

const frame = { width: 1920, height: 1080, at: 1_700_000_000_000 }

describe('SpineDiagnosticsLog', () => {
  it('無効なあいだは何も記録しない（通常の利用に影響させない）', () => {
    const log = new SpineDiagnosticsLog()
    expect(log.begin(frame)).toBeNull()
    log.addStrip(null, { index: 0, band: { start: 0, end: 1 }, text: 'あ', spines: 1, ms: 10 })
    expect(log.list()).toEqual([])
  })

  it('有効にすると記録し、短冊を足せる', () => {
    const log = new SpineDiagnosticsLog()
    log.setEnabled(true)
    const id = log.begin(frame)
    expect(id).not.toBeNull()

    log.addStrip(id, { index: 0, band: { start: 0, end: 0.2 }, text: '思考の整理学', spines: 1, ms: 220 })
    log.update(id, { bands: [{ start: 0, end: 0.2 }], spines: 1, ms: 400 })

    const [recorded] = log.list()
    expect(recorded.strips).toHaveLength(1)
    expect(recorded.strips[0].text).toBe('思考の整理学')
    expect(recorded.spines).toBe(1)
  })

  it('古い記録から捨てる', () => {
    const log = new SpineDiagnosticsLog(3)
    log.setEnabled(true)
    for (let i = 0; i < 5; i++) log.begin(frame)
    expect(log.list()).toHaveLength(3)
    expect(log.list()[0].id).toBe('frame-3')
  })

  it('無効に戻すと記録を捨てる', () => {
    const log = new SpineDiagnosticsLog()
    log.setEnabled(true)
    log.begin(frame)
    log.setEnabled(false)
    expect(log.list()).toEqual([])
  })

  it('内容が変わらなければ同じ配列を返す（再描画を起こさない）', () => {
    const log = new SpineDiagnosticsLog()
    log.setEnabled(true)
    log.begin(frame)
    const first = log.list()
    log.update(null, { spines: 1 })
    log.update('存在しない', { spines: 1 })
    expect(log.list()).toBe(first)
  })

  it('購読者へ変更を伝え、解除できる', () => {
    const log = new SpineDiagnosticsLog()
    log.setEnabled(true)
    let calls = 0
    const off = log.subscribe(() => {
      calls++
    })
    log.begin(frame)
    expect(calls).toBe(1)
    off()
    log.begin(frame)
    expect(calls).toBe(1)
  })
})

describe('buildReport', () => {
  const frames: FrameDiagnostic[] = [
    {
      id: 'frame-1',
      at: 1_700_000_000_000,
      width: 1920,
      height: 1080,
      quality: { brightness: 0.5, blowout: 0.01, sharpness: 0.2 },
      bands: [
        { start: 0, end: 0.5 },
        { start: 0.5, end: 1 },
      ],
      mode: 'strips',
      strips: [
        { index: 0, band: { start: 0, end: 0.5 }, text: '思考の整理学', spines: 1, ms: 210 },
        { index: 1, band: { start: 0.5, end: 1 }, text: '', spines: 0, ms: 180 },
      ],
      spines: 1,
      ms: 500,
    },
  ]

  it('短冊ごとの生テキストと所要時間を残す', () => {
    const report = buildReport(frames, 1_700_000_100_000)
    expect(report.frames).toHaveLength(1)
    expect(report.frames[0].bandCount).toBe(2)
    expect(report.frames[0].strips[0].text).toBe('思考の整理学')
    expect(report.frames[0].strips[1].spines).toBe(0)
  })

  it('JSON にできる（画像は含めない）', () => {
    const json = JSON.stringify(buildReport(frames))
    expect(json).toContain('思考の整理学')
    expect(json).not.toContain('blob')
  })

  it('時刻は読める形にする', () => {
    expect(buildReport(frames, 0).generatedAt).toBe('1970-01-01T00:00:00.000Z')
  })
})
