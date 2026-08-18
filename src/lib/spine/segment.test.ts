import { describe, expect, it } from 'vitest'
import type { GrayImage } from './capture'
import {
  MIN_BAND_WIDTH,
  columnEdgeDensity,
  columnMean,
  grayHistogram,
  invertGray,
  isLightOnDark,
  mergeStripColumns,
  normalizeProfile,
  otsuThreshold,
  padBand,
  prepareStrip,
  segmentSpines,
  smoothProfile,
  stretchContrast,
  stripScale,
  toFrameBox,
  toFrameColumns,
  readsDownward,
  columnGrooveDensity,
} from './segment'
import type { SpineColumn } from './recognizer'

function gray(width: number, height: number, at: (x: number, y: number) => number): GrayImage {
  const data = new Uint8ClampedArray(width * height)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) data[y * width + x] = at(x, y)
  }
  return { width, height, data }
}

/** 1冊ぶんの背表紙。地色と文字色を別々に持てる */
interface Spine {
  width: number
  /** 地の輝度 */
  base: number
  /** 文字の輝度。base より明るければ白抜き */
  ink: number
}

/**
 * 棚一段を模した画像を作る。
 *
 * 背表紙ごとに地色と文字色を変えられるのが要点で、**白抜き文字（暗地に
 * 明るい文字）を混ぜられる**。実機で崩れる条件はここにあり、以前の
 * 合成画像（地色が一様）では現れなかった。
 *
 * 書名は1字ずつ幅と位置を揺らして描く。実物の縦書きも字ごとに字面が違い、
 * 列の縁は揃わない。ここを真っ直ぐな帯で描くと、**文字の縁が背表紙の
 * 境界と見分けられない画像**になり、実機と違う条件で調整してしまう。
 */
function shelfWidth(spines: readonly Spine[], gap: number): number {
  return spines.reduce((n, s) => n + s.width, 0) + gap * Math.max(0, spines.length - 1)
}

function shelf(spines: readonly Spine[], height = 160, gap = 2): GrayImage {
  const width = shelfWidth(spines, gap)
  const data = new Uint8ClampedArray(width * height).fill(20)

  // 再現できる擬似乱数。テストが実行ごとに揺れないようにする
  let seed = 20240817
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }

  let x0 = 0
  for (const [index, s] of spines.entries()) {
    if (index > 0) x0 += gap
    for (let y = 0; y < height; y++) {
      for (let x = x0; x < x0 + s.width; x++) data[y * width + x] = s.base
    }

    const size = Math.max(5, Math.round(s.width * 0.55))
    for (let y = Math.round(height * 0.12); y + size < height * 0.88; y += size + 2) {
      const glyphWidth = Math.round(size * (0.65 + rnd() * 0.35))
      const center = x0 + s.width / 2 + (rnd() - 0.5) * size * 0.3
      const left = Math.round(center - glyphWidth / 2)
      for (let yy = y; yy < y + Math.round(size * 0.85); yy++) {
        for (let xx = left; xx < left + glyphWidth; xx++) {
          if (xx >= x0 && xx < x0 + s.width) data[yy * width + xx] = s.ink
        }
      }
    }
    x0 += s.width
  }
  return { width, height, data }
}

describe('columnEdgeDensity', () => {
  it('端から端まで続く段差の列で 1 に近づく', () => {
    // 左半分が黒、右半分が白。境目の列だけ段差が全行で立つ
    const g = gray(20, 30, (x) => (x < 10 ? 20 : 230))
    const e = columnEdgeDensity(g)
    expect(e[9]).toBeCloseTo(1, 5)
    expect(e[3]).toBe(0)
  })

  it('途中でしか続かない段差（文字の縦棒）は低く出る', () => {
    // 10行のうち2行だけ段差がある
    const g = gray(20, 30, (x, y) => (x >= 10 && y % 15 < 1 ? 230 : 20))
    const e = columnEdgeDensity(g)
    expect(e[9]).toBeLessThan(0.3)
  })
})

describe('columnMean', () => {
  it('列ごとの平均を返す', () => {
    const m = columnMean(gray(3, 4, (x) => x * 50))
    expect([...m]).toEqual([0, 50, 100])
  })
})

describe('columnGrooveDensity', () => {
  it('左右どちらから見ても暗い列（隙間）を拾う', () => {
    const g = gray(30, 10, (x) => (x === 15 ? 20 : 200))
    const v = columnGrooveDensity(g, 3)
    expect(v[15]).toBe(1)
    expect(v[5]).toBe(0)
  })

  it('明るい地の上の暗い帯（書名）の縁は溝にしない', () => {
    // 中央 10px が暗い帯。両側より暗いのは帯の内側だけで、縁は片側しか暗くない
    const g = gray(40, 10, (x) => (x >= 15 && x < 25 ? 40 : 210))
    const v = columnGrooveDensity(g, 3)
    expect(v[14]).toBe(0)
    expect(v[25]).toBe(0)
  })

  it('一様な面には溝が無い', () => {
    const v = columnGrooveDensity(gray(30, 10, () => 20), 3)
    expect(Math.max(...v)).toBe(0)
  })
})

describe('smoothProfile / normalizeProfile', () => {
  it('移動平均で峰がならされる', () => {
    const s = smoothProfile(Float64Array.from([0, 0, 3, 0, 0]), 1)
    expect(s[2]).toBeCloseTo(1, 5)
    expect(s[1]).toBeCloseTo(1, 5)
  })

  it('差が無いものは 0 のまま（峰を作らない）', () => {
    const n = normalizeProfile(Float64Array.from([5, 5, 5, 5]))
    expect([...n]).toEqual([0, 0, 0, 0])
  })

  it('最小を 0、最大を 1 にする', () => {
    const n = normalizeProfile(Float64Array.from([2, 4, 6]))
    expect(n[0]).toBe(0)
    expect(n[2]).toBe(1)
  })
})

describe('segmentSpines', () => {
  it('地色も文字色もばらばらな棚を、1冊ずつの短冊に分ける', () => {
    // 白抜き（暗地に明るい文字）と黒文字を混ぜる。実機で崩れる条件
    const spines: Spine[] = [
      { width: 30, base: 235, ink: 30 }, // 白地に黒
      { width: 22, base: 40, ink: 225 }, // 黒地に白抜き
      { width: 45, base: 150, ink: 20 }, // 中間色
      { width: 18, base: 60, ink: 210 }, // 濃紺に白抜き
      { width: 34, base: 210, ink: 70 },
    ]
    const bands = segmentSpines(shelf(spines))

    expect(bands.length).toBe(spines.length)
    // 短冊の中心が、それぞれの背表紙の中に入っている
    const total = shelfWidth(spines, 2)
    let at = 0
    for (const [i, s] of spines.entries()) {
      if (i > 0) at += 2
      const center = (at + s.width / 2) / total
      const band = bands[i]
      expect(center).toBeGreaterThanOrEqual(band.start)
      expect(center).toBeLessThanOrEqual(band.end)
      at += s.width
    }
  })

  it('細すぎる区切りは作らない（文字の縦棒を境界にしない）', () => {
    const bands = segmentSpines(
      shelf([
        { width: 40, base: 230, ink: 20 },
        { width: 40, base: 30, ink: 220 },
      ]),
    )
    for (const b of bands) expect(b.end - b.start).toBeGreaterThanOrEqual(MIN_BAND_WIDTH * 0.99)
  })

  it('境界の無い一様な面は1本のまま返す（退避経路へ回す）', () => {
    const bands = segmentSpines(gray(200, 100, () => 180))
    expect(bands).toEqual([{ start: 0, end: 1 }])
  })

  it('短冊の数に上限がある', () => {
    const many: Spine[] = Array.from({ length: 60 }, (_, i) => ({
      width: 12,
      base: i % 2 ? 220 : 40,
      ink: i % 2 ? 30 : 230,
    }))
    const bands = segmentSpines(shelf(many, 120, 1), { maxBands: 8 })
    expect(bands.length).toBeLessThanOrEqual(8)
  })

  it('隙間なく詰まった棚でも、地色が違えば境界を見つける', () => {
    const spines: Spine[] = [
      { width: 34, base: 235, ink: 30 },
      { width: 26, base: 45, ink: 225 },
      { width: 40, base: 160, ink: 25 },
    ]
    const bands = segmentSpines(shelf(spines, 160, 0))
    expect(bands.length).toBe(3)
  })

  it('照明のムラと雑音があっても、棚一段ぶんの短冊に分かれる', () => {
    // 25冊。手前が明るく奥が暗い勾配と、±8階調の雑音を載せる
    const spines: Spine[] = Array.from({ length: 25 }, (_, i) => ({
      width: 14 + (i % 5) * 4,
      base: i % 3 === 0 ? 45 : 200 - (i % 4) * 20,
      ink: i % 3 === 0 ? 225 : 35,
    }))
    const clean = shelf(spines, 200, 1)
    let seed = 7
    const noisy = gray(clean.width, clean.height, (x, y) => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      const lighting = 1 - (x / clean.width) * 0.35
      return clean.data[y * clean.width + x] * lighting + (seed / 2147483648 - 0.5) * 16
    })

    const bands = segmentSpines(noisy)
    // 全部は取れなくてよい。取り逃がしより「混ぜて1冊にする」方が痛い
    expect(bands.length).toBeGreaterThanOrEqual(20)
    expect(bands.length).toBeLessThanOrEqual(25)
  })

  it('小さすぎる画像は扱わない', () => {
    expect(segmentSpines(gray(4, 4, () => 128))).toEqual([])
  })

  it('短冊は隙間なく並び、0..1 を覆う', () => {
    const bands = segmentSpines(
      shelf([
        { width: 30, base: 235, ink: 30 },
        { width: 30, base: 40, ink: 225 },
        { width: 30, base: 150, ink: 20 },
      ]),
    )
    expect(bands[0].start).toBe(0)
    expect(bands[bands.length - 1].end).toBe(1)
    for (let i = 1; i < bands.length; i++) expect(bands[i].start).toBe(bands[i - 1].end)
  })
})

describe('padBand', () => {
  it('左右へ広げる', () => {
    const p = padBand({ start: 0.4, end: 0.5 }, 0.1)
    expect(p.start).toBeCloseTo(0.39, 6)
    expect(p.end).toBeCloseTo(0.51, 6)
  })

  it('画像の外へはみ出さない', () => {
    const p = padBand({ start: 0, end: 1 }, 0.5)
    expect(p).toEqual({ start: 0, end: 1 })
  })
})

describe('toFrameBox / toFrameColumns', () => {
  it('短冊の中の位置をコマ全体の位置へ直す', () => {
    const box = toFrameBox({ x: 0.5, y: 0.2, width: 0.5, height: 0.6 }, { start: 0.2, end: 0.4 })
    expect(box.x).toBeCloseTo(0.3, 6)
    expect(box.width).toBeCloseTo(0.1, 6)
    // 縦は短冊と同じなので変えない
    expect(box.y).toBe(0.2)
    expect(box.height).toBe(0.6)
  })

  it('語の位置も一緒に直す', () => {
    const columns: SpineColumn[] = [
      {
        words: [{ text: 'あ', confidence: 0.9, box: { x: 0, y: 0, width: 1, height: 0.1 } }],
        box: { x: 0, y: 0, width: 1, height: 1 },
        confidence: 0.9,
      },
    ]
    const moved = toFrameColumns(columns, { start: 0.5, end: 0.6 })
    expect(moved[0].box.x).toBeCloseTo(0.5, 6)
    expect(moved[0].words[0].box?.width).toBeCloseTo(0.1, 6)
  })
})

describe('readsDownward', () => {
  const word = (y: number) => ({ box: { x: 0, y, width: 0.5, height: 0.1 } })

  it('返ってきた順に y が増えるなら、上から下', () => {
    expect(readsDownward([word(0.1), word(0.3), word(0.6)])).toBe(true)
  })

  it('返ってきた順に y が減るなら、下から上', () => {
    // 実測: 「人間失格」の3語が y = 0.85 → 0.75 → 0.54 で返ってきた
    expect(readsDownward([word(0.85), word(0.75), word(0.54)])).toBe(false)
  })

  it('判らないときは上から下とみなす', () => {
    expect(readsDownward([])).toBe(true)
    expect(readsDownward([word(0.5)])).toBe(true)
    expect(readsDownward([{}, {}])).toBe(true)
  })
})

describe('mergeStripColumns', () => {
  const column = (x: number, width: number, text: string, y = 0): SpineColumn => ({
    words: [{ text, confidence: 0.9, box: { x, y, width, height: 0.2 } }],
    box: { x, y, width, height: 0.2 },
    confidence: 0.9,
  })

  it('短冊の端で拾った細い列は捨てる', () => {
    // 実測で「11」「ェェ」として出てきた、隣の背表紙の縁や溝
    const merged = mergeStripColumns([column(0, 0.08, '11'), column(0.25, 0.5, '海辺のカフカ')])
    expect(merged).toHaveLength(1)
    expect(merged[0].words[0].text).toBe('海辺のカフカ')
  })

  it('束ねる向きは、語が返ってきた向きに合わせる', () => {
    // y が下から上へ並ぶ列。y の昇順に直すと語順が壊れる
    const merged = mergeStripColumns([column(0.2, 0.5, '人間', 0.8), column(0.2, 0.5, '失格', 0.5)])
    expect(merged[0].words.map((w) => w.text)).toEqual(['人間', '失格'])
  })

  it('横に重なる列は1冊ぶんに束ねる（書名と著者が別の列で返ることがある）', () => {
    const merged = mergeStripColumns([column(0.1, 0.6, '思考の整理学', 0.1), column(0.15, 0.5, '外山滋比古', 0.6)])
    expect(merged).toHaveLength(1)
    expect(merged[0].words.map((w) => w.text)).toEqual(['思考の整理学', '外山滋比古'])
  })

  it('横に離れた列は別のままにする（短冊に2冊入った場合）', () => {
    const merged = mergeStripColumns([column(0.05, 0.3, 'あいうえ'), column(0.6, 0.3, 'かきくけ')])
    expect(merged).toHaveLength(2)
  })

  it('上から下へ読む列は、上のものが先に来る', () => {
    const merged = mergeStripColumns([column(0.1, 0.6, 'うえ', 0.1), column(0.1, 0.6, 'した', 0.7)])
    expect(merged[0].words.map((w) => w.text)).toEqual(['うえ', 'した'])
  })

  it('1本以下なら何もしない', () => {
    expect(mergeStripColumns([])).toEqual([])
  })
})

describe('stripScale', () => {
  it('細い短冊は整数倍に拡大する', () => {
    expect(stripScale(60, 200)).toBe(3)
    expect(stripScale(90, 200)).toBe(2)
  })

  it('もともと十分広ければ拡大しない', () => {
    expect(stripScale(200, 400)).toBe(1)
  })

  it('画素数が増えすぎるときは倍率を落とす', () => {
    // 3倍にすると 2.4M 画素を超える
    expect(stripScale(80, 4000)).toBeLessThan(3)
  })
})

describe('grayHistogram / otsuThreshold', () => {
  it('分布を数える', () => {
    const h = grayHistogram(gray(4, 4, () => 100))
    expect(h[100]).toBe(16)
  })

  it('地と文字のあいだに閾値が立つ', () => {
    const t = otsuThreshold(gray(20, 20, (x) => (x < 15 ? 220 : 40)))
    expect(t).toBeGreaterThanOrEqual(40)
    expect(t).toBeLessThan(220)
  })
})

describe('isLightOnDark', () => {
  it('暗い地に明るい文字なら白抜きと判定する', () => {
    // 地(暗)が多数派、文字(明)が少数派
    const g = gray(20, 20, (x) => (x < 15 ? 35 : 225))
    expect(isLightOnDark(g)).toBe(true)
  })

  it('明るい地に暗い文字なら白抜きではない', () => {
    const g = gray(20, 20, (x) => (x < 15 ? 225 : 35))
    expect(isLightOnDark(g)).toBe(false)
  })

  it('空の画像では反転しない', () => {
    expect(isLightOnDark({ width: 0, height: 0, data: new Uint8ClampedArray(0) })).toBe(false)
  })
})

describe('stretchContrast', () => {
  it('狭い階調を 0..255 へ伸ばす', () => {
    const g = gray(20, 20, (x) => (x < 10 ? 100 : 140))
    const s = stretchContrast(g, 0)
    expect(Math.min(...s.data)).toBe(0)
    expect(Math.max(...s.data)).toBe(255)
  })

  it('階調差の無い面は伸ばさない（ノイズを増幅しない）', () => {
    const g = gray(20, 20, () => 128)
    expect(stretchContrast(g).data).toBe(g.data)
  })
})

describe('prepareStrip', () => {
  it('白抜きの背表紙は反転して「明るい地に暗い文字」へ揃える', () => {
    const g = gray(20, 40, (x) => (x < 15 ? 30 : 200))
    const p = prepareStrip(g)
    // 反転後は地(多数派)が明るく、文字が暗い
    expect(p.data[0]).toBeGreaterThan(200)
    expect(p.data[19]).toBeLessThan(60)
  })

  it('黒文字の背表紙はそのままの極性で返す', () => {
    const g = gray(20, 40, (x) => (x < 15 ? 200 : 30))
    const p = prepareStrip(g)
    expect(p.data[0]).toBeGreaterThan(200)
    expect(p.data[19]).toBeLessThan(60)
  })

  it('どちらの極性でも、地は明るく文字は暗い側に揃う', () => {
    const dark = prepareStrip(gray(20, 40, (x) => (x < 15 ? 30 : 200)))
    const light = prepareStrip(gray(20, 40, (x) => (x < 15 ? 200 : 30)))
    expect(isLightOnDark(dark)).toBe(false)
    expect(isLightOnDark(light)).toBe(false)
  })
})

describe('invertGray', () => {
  it('白黒が入れ替わる', () => {
    const g = invertGray(gray(2, 1, (x) => (x === 0 ? 0 : 255)))
    expect([...g.data]).toEqual([255, 0])
  })
})
