import { describe, expect, it } from 'vitest'
import {
  MIN_BRIGHTNESS,
  RESCUE_AFTER_MS,
  RESCUE_FORCE_MS,
  STABLE_TICKS,
  assessFrame,
  decideCapture,
  blowoutRatio,
  brightness,
  downscale,
  frameAdvice,
  frameDifference,
  hashDistance,
  isUsable,
  boxToRect,
  looksSame,
  pickSharpest,
  sharpness,
  toGray,
  visualHash,
  type RgbaImage,
  shouldRearm,
  NEW_SHELF_DIFFERENCE,
  SHELF_RETRY_MS,
} from './capture'

/** 濃淡だけの画像を作る。RGB を同じ値にすれば輝度はそのまま v になる */
function image(width: number, height: number, at: (x: number, y: number) => number): RgbaImage {
  const data = new Uint8ClampedArray(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = at(x, y)
      const i = (y * width + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  return { width, height, data }
}

const flat = (w: number, h: number, v: number) => toGray(image(w, h, () => v))
const checker = (w: number, h: number) => toGray(image(w, h, (x, y) => ((x + y) % 2 ? 255 : 0)))
/** 緩やかな階調。輪郭が鈍っている＝ブレた状態に相当する */
const gradient = (w: number, h: number) => toGray(image(w, h, (x) => (x / w) * 255))

describe('brightness', () => {
  it('真っ黒は 0、真っ白は 1', () => {
    expect(brightness(flat(8, 8, 0))).toBe(0)
    expect(brightness(flat(8, 8, 255))).toBe(1)
  })

  it('中間の明るさはおよそ 0.5', () => {
    expect(brightness(flat(8, 8, 128))).toBeCloseTo(0.5, 1)
  })
})

describe('blowoutRatio', () => {
  it('白飛びしていなければ 0', () => {
    expect(blowoutRatio(flat(8, 8, 200))).toBe(0)
  })

  it('半分が白飛びなら 0.5', () => {
    const g = toGray(image(8, 8, (x) => (x < 4 ? 255 : 100)))
    expect(blowoutRatio(g)).toBeCloseTo(0.5, 5)
  })

  it('白い紙のカバーは白飛びとして数えない', () => {
    // 白い背表紙は 250 前後まで上がる。ここを弾くと白い本がまるごと読めなくなる
    const q = assessFrame(toGray(image(32, 32, (x, y) => ((x + y) % 4 < 1 ? 30 : 250))))
    expect(q.blowout).toBe(0)
    expect(isUsable(q)).toBe(true)
  })
})

describe('sharpness', () => {
  it('のっぺりした面は 0', () => {
    expect(sharpness(flat(16, 16, 128))).toBe(0)
  })

  it('輪郭がはっきりしているほど大きい', () => {
    expect(sharpness(checker(16, 16))).toBeGreaterThan(sharpness(gradient(16, 16)))
  })

  it('小さすぎる画像では判定しない', () => {
    expect(sharpness(flat(2, 2, 128))).toBe(0)
  })
})

describe('isUsable / frameAdvice', () => {
  it('暗すぎるコマは取り込まず、明るさを直す案内を出す', () => {
    const q = assessFrame(flat(16, 16, 10))
    expect(q.brightness).toBeLessThan(MIN_BRIGHTNESS)
    expect(isUsable(q)).toBe(false)
    expect(frameAdvice(q)).toContain('暗')
  })

  it('白飛びしているコマは反射を避ける案内を出す', () => {
    const q = assessFrame(checker(16, 16))
    expect(isUsable(q)).toBe(false)
    expect(frameAdvice(q)).toContain('反射')
  })

  it('のっぺりした面はブレとして扱い、動かす速さの案内を出す', () => {
    const q = assessFrame(flat(16, 16, 128))
    expect(isUsable(q)).toBe(false)
    expect(frameAdvice(q)).toContain('ぼやけて')
  })

  it('明るさも輪郭も足りていれば取り込む', () => {
    // 文字のような細かい濃淡があり、白飛びしていない画像
    const g = toGray(image(32, 32, (x, y) => ((x + y) % 4 < 2 ? 60 : 200)))
    const q = assessFrame(g)
    expect(isUsable(q)).toBe(true)
    expect(frameAdvice(q)).toBeNull()
  })
})

describe('frameDifference', () => {
  it('同じコマなら 0', () => {
    expect(frameDifference(gradient(8, 8), gradient(8, 8))).toBe(0)
  })

  it('黒と白なら 1', () => {
    expect(frameDifference(flat(8, 8, 0), flat(8, 8, 255))).toBe(1)
  })

  it('寸法が違うものは比較できないので「まったく別」とする', () => {
    expect(frameDifference(flat(8, 8, 0), flat(4, 4, 0))).toBe(1)
  })
})

describe('visualHash', () => {
  it('16桁の16進で返る', () => {
    expect(visualHash(gradient(32, 32))).toMatch(/^[0-9a-f]{16}$/)
  })

  it('同じ絵なら距離 0', () => {
    expect(hashDistance(visualHash(gradient(32, 32)), visualHash(gradient(32, 32)))).toBe(0)
  })

  it('別の絵は距離が開く', () => {
    const a = visualHash(toGray(image(32, 32, (x) => (x < 16 ? 0 : 255))))
    const b = visualHash(toGray(image(32, 32, (x) => (x < 16 ? 255 : 0))))
    expect(hashDistance(a, b)).toBeGreaterThan(8)
    expect(looksSame(a, b)).toBe(false)
  })

  it('片方が無ければ同一とはみなさない', () => {
    expect(looksSame(undefined, 'ffffffffffffffff')).toBe(false)
  })

  it('わずかな濃淡の違いは同じ背表紙として扱う', () => {
    const a = visualHash(toGray(image(32, 32, (x) => (x < 16 ? 40 : 200))))
    const b = visualHash(toGray(image(32, 32, (x) => (x < 16 ? 50 : 210))))
    expect(looksSame(a, b)).toBe(true)
  })
})

describe('pickSharpest', () => {
  it('最も鮮鋭な1枚を選ぶ', () => {
    const frames = [
      { id: 'a', quality: assessFrame(gradient(16, 16)) },
      { id: 'b', quality: assessFrame(checker(16, 16)) },
      { id: 'c', quality: assessFrame(flat(16, 16, 128)) },
    ]
    expect(pickSharpest(frames)?.id).toBe('b')
  })

  it('1枚も無ければ null', () => {
    expect(pickSharpest([])).toBeNull()
  })
})

describe('boxToRect', () => {
  it('相対座標を画素へ直す', () => {
    const r = boxToRect({ x: 0.5, y: 0.25, width: 0.1, height: 0.5 }, 1000, 800, 0)
    expect(r).toEqual({ x: 500, y: 200, width: 100, height: 400 })
  })

  it('左右に余白を足す（文字ぴったりに切ると何の画像か分からない）', () => {
    const tight = boxToRect({ x: 0.5, y: 0.25, width: 0.1, height: 0.5 }, 1000, 800, 0)
    const padded = boxToRect({ x: 0.5, y: 0.25, width: 0.1, height: 0.5 }, 1000, 800, 0.35)
    expect(padded.width).toBeGreaterThan(tight.width)
    expect(padded.x).toBeLessThan(tight.x)
  })

  it('画像の外へはみ出さない', () => {
    const r = boxToRect({ x: 0, y: 0, width: 1, height: 1 }, 640, 480, 0.5)
    expect(r.x).toBe(0)
    expect(r.y).toBe(0)
    expect(r.width).toBeLessThanOrEqual(640)
    expect(r.height).toBeLessThanOrEqual(480)
  })

  it('潰れた枠でも 1画素は確保する', () => {
    const r = boxToRect({ x: 0.5, y: 0.5, width: 0, height: 0 }, 100, 100, 0)
    expect(r.width).toBeGreaterThanOrEqual(1)
    expect(r.height).toBeGreaterThanOrEqual(1)
  })
})

describe('decideCapture', () => {
  const base = {
    usable: true,
    moved: 0.2,
    stable: 0,
    waitedMs: 0,
    sharpness: 0.4,
    bestSharpness: 0.4,
  }

  it('品質が足りないコマは撮らない', () => {
    expect(decideCapture({ ...base, usable: false, moved: 0, stable: 5 })).toBe('reject')
  })

  it('止まったコマが続いたら撮る', () => {
    expect(decideCapture({ ...base, moved: 0.01, stable: STABLE_TICKS - 1 })).toBe('capture')
  })

  it('止まりきらないうちは待つ', () => {
    expect(decideCapture({ ...base, moved: 0.01, stable: 0 })).toBe('wait')
    expect(decideCapture({ ...base, moved: 0.5, stable: STABLE_TICKS })).toBe('wait')
  })

  it('待たせすぎたら、そこそこ鮮鋭なコマで妥協して撮る', () => {
    // 「かざしているのに何も起きない」を潰すための経路
    const rescued = decideCapture({
      ...base,
      moved: 0.5,
      waitedMs: RESCUE_AFTER_MS,
      sharpness: 0.4,
      bestSharpness: 0.4,
    })
    expect(rescued).toBe('capture')
  })

  it('救済でも、そのとき明らかにぶれていれば見送る', () => {
    const blurred = decideCapture({
      ...base,
      moved: 0.5,
      waitedMs: RESCUE_AFTER_MS,
      sharpness: 0.1,
      bestSharpness: 0.5,
    })
    expect(blurred).toBe('wait')
  })

  it('それでも撮れないまま期限が来たら、鮮鋭度を問わず撮る', () => {
    const forced = decideCapture({
      ...base,
      moved: 0.9,
      waitedMs: RESCUE_FORCE_MS,
      sharpness: 0.05,
      bestSharpness: 0.9,
    })
    expect(forced).toBe('capture')
  })

  it('救済の期限が来ても、品質が足りなければ撮らない', () => {
    expect(decideCapture({ ...base, usable: false, waitedMs: RESCUE_FORCE_MS * 2 })).toBe('reject')
  })
})

describe('downscale', () => {
  it('指定した寸法になる', () => {
    const g = downscale(gradient(64, 64), 8, 8)
    expect(g.width).toBe(8)
    expect(g.height).toBe(8)
    expect(g.data).toHaveLength(64)
  })
})

/*
 * 読み終えた棚を撮り続けないための判定。
 * 実機で1つの棚から80件が並んだ原因の半分がここにあった。
 */
describe('shouldRearm', () => {
  it('取り込んだ直後の同じ構図では撮らない', () => {
    expect(shouldRearm({ movedFromCaptured: 0.01, sinceCaptureMs: 1500 })).toBe(false)
  })

  it('露出の揺れ程度の差では撮らない', () => {
    expect(shouldRearm({ movedFromCaptured: NEW_SHELF_DIFFERENCE - 0.01, sinceCaptureMs: 3000 })).toBe(
      false,
    )
  })

  it('別の段へ移せば撮る', () => {
    expect(shouldRearm({ movedFromCaptured: 0.3, sinceCaptureMs: 300 })).toBe(true)
  })

  it('動かないままでも、しばらく経てば撮り直す（空振りした棚を諦めない）', () => {
    expect(shouldRearm({ movedFromCaptured: 0, sinceCaptureMs: SHELF_RETRY_MS })).toBe(true)
  })
})
