/**
 * 棚一段のコマから、背表紙1冊ぶんの「短冊」を切り出す
 *
 * ── なぜ自前で切るのか ────────────────────────────────
 * 以前は「フレーム全体を Tesseract の PSM 5 に渡せば、レイアウト解析が
 * 背表紙を1冊ずつの縦列へ分けてくれる」としていた。**その検証は canvas に
 * IPAGothic で描いた合成画像だけで行っており、実機で全滅した。**
 *
 * 崩れる理由は Tesseract の二値化がページ単位であることにある。実物の棚は
 * 背表紙ごとに地色も文字色も違い、**白抜き文字（暗地に明るい文字）と黒文字が
 * 1枚に混在する**。1枚をまとめて二値化すると、どちらかの極性の背表紙が
 * まるごと潰れる。合成画像は地色が均一だったので、この条件が現れなかった。
 *
 * したがって切り分けを前に出す。**背表紙ごとに切ってから、短冊1本ずつ
 * 二値化する**と、極性は短冊の中で閉じる。ついでに短冊1本を読み終えた時点で
 * 1冊ぶんの結果が出せるので、「最初の1冊が出るまで十数秒」も解ける。
 *
 * ── それでも OpenCV.js は入れない ─────────────────────
 * 必要なのは「縦の境界がどこにあるか」だけで、直線検出も透視補正も要らない。
 * 縦投影プロファイル（列ごとの勾配エネルギーと輝度）で足りる。
 * 傾きは真面目に扱わず、境界は縦の直線と近似する。多少斜めでも、短冊を
 * 隣へ少しはみ出させておけば書名は欠けない。
 *
 * ここは純関数だけ。DOM を触る切り出しは capture.ts の `cropStrips` にある。
 */

import type { BoundingBox } from '../../types'
import type { GrayImage } from './capture'
import type { SpineColumn } from './recognizer'

/** 短冊1本の x 範囲 (0..1 の相対座標) */
export interface SpineBand {
  start: number
  end: number
}

/*
 * ── 寸法の見積もり ───────────────────────────────────
 * 棚一段は約 60cm。背表紙の厚みは文庫の 1.2cm から画集の 4cm まで幅がある。
 * 棚一段が画面いっぱいに収まる構図では、文庫1冊が画面幅の約 2%、
 * 画集1冊が約 7% を占める。**これ以上細い区切りは背表紙の境界ではない**
 * （書名の文字の縦棒や、帯の線を拾っている）。
 */
export const MIN_BAND_WIDTH = 0.02

/**
 * 1枚から切り出す短冊の上限。
 *
 * 棚一段に入るのは 20〜30冊で、文庫だけを詰めても 40冊は超えない。
 * これを上回る区切りが出たら、境界ではないものを拾っている。
 * 短冊の数がそのまま OCR の回数なので、上限は処理時間の歯止めでもある。
 */
export const MAX_BANDS = 36

/**
 * 短冊を左右へはみ出させる割合。
 *
 * 境界を縦の直線と近似しているので、棚が少し斜めに写っていると
 * 書名の端が隣の短冊へ落ちる。ぴったり切らずに重ねて切る。
 */
export const BAND_PAD = 0.08

/**
 * 境界とみなす勾配の段差。これ未満の変化は紙の地合いや照明のムラ。
 */
const EDGE_LEVEL = 18

/**
 * 境界の条件その1: 縦にどれだけ段差が続いているか。
 *
 * 背表紙の境目は**画面の上から下まで**段差が続く。文字も横方向の勾配を
 * 作るが、字の縁は1字ごとに幅も位置も違うので、同じ x に段差が揃うのは
 * せいぜい1字ぶんの高さである。したがって「段差のある行の割合」で見ると、
 * 境界と文字を分けられる。半分以上続いていることを条件にする。
 */
const MIN_EDGE_DENSITY = 0.45

/** 溝とみなす暗さ。左右どちらから見てもこれだけ暗い画素を溝とする */
const GROOVE_DEPTH = 10

/**
 * 境界の条件その2: 背表紙のあいだの暗い溝が、縦にどれだけ続いているか。
 *
 * ここでも「暗いか」ではなく**「縦に続いているか」**で見る。書名は
 * 明るい地に暗い字で刷られるので、字の並びも縦長の暗い帯になる。
 * 深さだけで測ると書名の縁が全部境界になってしまう（実際にそうなった）。
 */
const MIN_GROOVE_DENSITY = 0.5

/** 境界らしさの配点。溝より段差の連続性を重く見る */
const EDGE_WEIGHT = 0.6
const GROOVE_WEIGHT = 0.4

export interface SegmentOptions {
  /** 最小の短冊幅 (0..1)。これ未満の短冊は作らない */
  minWidth?: number
  /** 短冊の数の上限 */
  maxBands?: number
}

// ───────────────────────────────────────────────────────────
// 縦投影プロファイル
// ───────────────────────────────────────────────────────────

/**
 * 列ごとの「段差が続いている割合」(0..1)。
 *
 * x と x+1 の差が EDGE_LEVEL を超えた行を数え、高さで割る。
 * 値の大きさではなく**続いているか**を見るのが要点で、これにより
 * 濃い文字の縦棒（続かない）と背表紙の境目（続く）を分けられる。
 */
export function columnEdgeDensity(g: GrayImage): Float64Array {
  const { width: w, height: h, data } = g
  const out = new Float64Array(w)
  if (w < 2 || h < 1) return out
  for (let x = 0; x < w - 1; x++) {
    let n = 0
    for (let y = 0; y < h; y++) {
      const i = y * w + x
      if (Math.abs(data[i + 1] - data[i]) >= EDGE_LEVEL) n++
    }
    out[x] = n / h
  }
  return out
}

/** 列ごとの平均輝度 */
export function columnMean(g: GrayImage): Float64Array {
  const { width: w, height: h, data } = g
  const out = new Float64Array(w)
  if (h < 1) return out
  for (let x = 0; x < w; x++) {
    let sum = 0
    for (let y = 0; y < h; y++) sum += data[y * w + x]
    out[x] = sum / h
  }
  return out
}

/**
 * 列ごとの「溝が続いている割合」(0..1)。
 *
 * **左右どちらから見ても暗い**画素だけを溝として数える。ここが要点で、
 * 単に「周りより暗い」で測ると、書名の左右の縁がどちらも溝になってしまう
 * （字は明るい地の上の暗い帯なので、片側から見れば必ず暗い）。
 * 両側より暗いのは、背表紙のあいだの隙間と、字の中の細い縦棒だけである。
 * 後者は1字ぶんの高さしか続かないので、割合で落ちる。
 */
export function columnGrooveDensity(g: GrayImage, radius: number, depth = GROOVE_DEPTH): Float64Array {
  const { width: w, height: h, data } = g
  const out = new Float64Array(w)
  const r = Math.max(1, Math.round(radius))
  if (h < 1) return out

  for (let x = r; x < w - r; x++) {
    let n = 0
    for (let y = 0; y < h; y++) {
      const row = y * w
      const v = data[row + x]
      if (v + depth <= data[row + x - r] && v + depth <= data[row + x + r]) n++
    }
    out[x] = n / h
  }
  return out
}

/** 移動平均。1画素ぶんの揺れで峰が割れるのを防ぐ */
export function smoothProfile(values: Float64Array, radius = 1): Float64Array {
  const r = Math.max(0, Math.round(radius))
  if (r === 0) return values
  const out = new Float64Array(values.length)
  for (let x = 0; x < values.length; x++) {
    let sum = 0
    let n = 0
    for (let d = -r; d <= r; d++) {
      const j = x + d
      if (j < 0 || j >= values.length) continue
      sum += values[j]
      n++
    }
    out[x] = sum / n
  }
  return out
}

/** 0..1 に伸ばす。差が無いものは全部 0 にする(峰を作らない) */
export function normalizeProfile(values: Float64Array): Float64Array {
  const out = new Float64Array(values.length)
  if (values.length === 0) return out
  let min = Infinity
  let max = -Infinity
  for (const v of values) {
    if (v < min) min = v
    if (v > max) max = v
  }
  const span = max - min
  if (!(span > 1e-9)) return out
  for (let i = 0; i < values.length; i++) out[i] = (values[i] - min) / span
  return out
}

// ───────────────────────────────────────────────────────────
// 短冊の切り出し
// ───────────────────────────────────────────────────────────

/**
 * 縮小したグレー画像から、背表紙の縦境界を推定して短冊に分ける。
 *
 * 境界が1本も立たなければ、フレーム全体を1本の短冊として返す。
 * 呼び出し側は短冊が2本未満のときフレーム全体の読み取りへ退避する。
 */
export function segmentSpines(g: GrayImage, options: SegmentOptions = {}): SpineBand[] {
  const w = g.width
  if (w < 8 || g.height < 8) return []

  const minWidth = options.minWidth ?? MIN_BAND_WIDTH
  const maxBands = Math.max(1, options.maxBands ?? MAX_BANDS)
  const minPx = Math.max(2, Math.round(minWidth * w))

  /*
   * 実寸の足切りには平滑化していない値を使う。
   *
   * 隙間なく詰まった棚では、境界は**1画素幅の段差**になる。平滑化した値で
   * 足切りすると、その1本が両隣の 0 に薄められて（1/3 になる）閾値を割り、
   * 棚がまるごと1本の短冊になる（実際にそうなった）。
   * 平滑化は峰の位置を安定させるためのもので、点数付けにだけ使う。
   */
  const rawEdge = columnEdgeDensity(g)
  const rawGroove = columnGrooveDensity(g, Math.max(2, Math.round(minPx / 2)))

  const edge = normalizeProfile(smoothProfile(rawEdge, 1))
  const groove = normalizeProfile(smoothProfile(rawGroove, 1))
  const score = new Float64Array(w)
  for (let x = 0; x < w; x++) score[x] = EDGE_WEIGHT * edge[x] + GROOVE_WEIGHT * groove[x]

  /** 峰の位置は平滑化で1画素ずれることがあるので、隣も見て足切りする */
  const strongEnough = (x: number): boolean => {
    for (let d = -1; d <= 1; d++) {
      const j = x + d
      if (j < 0 || j >= w) continue
      if (rawEdge[j] >= MIN_EDGE_DENSITY || rawGroove[j] >= MIN_GROOVE_DENSITY) return true
    }
    return false
  }

  // 峰を拾う。同じ高さが続く場合は左端だけを採る(平坦な頂上で2本立てない)
  const peakRadius = Math.max(1, Math.floor(minPx / 2))
  const peaks: { x: number; score: number }[] = []
  for (let x = minPx; x <= w - minPx; x++) {
    /*
     * 実寸で足切りする。正規化した値だけで見ると、のっぺりした壁でも
     * どこかが 1.0 になり、境界が無い場所に区切りを立ててしまう。
     */
    if (!strongEnough(x)) continue

    let isPeak = true
    for (let d = -peakRadius; d <= peakRadius && isPeak; d++) {
      const j = x + d
      if (j < 0 || j >= w || j === x) continue
      if (score[j] > score[x]) isPeak = false
      else if (score[j] === score[x] && j < x) isPeak = false
    }
    if (isPeak) peaks.push({ x, score: score[x] })
  }

  // 強い峰から採り、最小幅より近いものは捨てる
  peaks.sort((a, b) => b.score - a.score)
  const cuts: number[] = []
  for (const p of peaks) {
    if (cuts.length >= maxBands - 1) break
    if (cuts.some((c) => Math.abs(c - p.x) < minPx)) continue
    cuts.push(p.x)
  }
  cuts.sort((a, b) => a - b)

  const edges = [0, ...cuts, w]
  const bands: SpineBand[] = []
  for (let i = 0; i < edges.length - 1; i++) {
    bands.push({ start: edges[i] / w, end: edges[i + 1] / w })
  }
  return bands
}

/** 短冊を左右へ少し広げる。切り出すときに使う */
export function padBand(band: SpineBand, ratio = BAND_PAD): SpineBand {
  const pad = (band.end - band.start) * ratio
  return { start: Math.max(0, band.start - pad), end: Math.min(1, band.end + pad) }
}

/**
 * 語の並びが上から下へ進むか。
 *
 * **Tesseract の縦書きは、読み順どおりに語を返しつつ、その y が
 * 下から上へ並ぶことがある**（縦の行を下から上へ走る向きで解釈したとき）。
 * 実測で「人間失格」の3語が y = 0.85 → 0.75 → 0.54 の順に返ってきた。
 * これを y の昇順に並べ直すと「失格間人」になる。
 *
 * したがって並べ直すときは、**返ってきた順が示す向き**に従う。
 * 判らないとき（1語以下・位置が無い）は上から下とみなす。
 */
export function readsDownward(words: readonly { box?: BoundingBox }[]): boolean {
  let down = 0
  let up = 0
  let previous: number | null = null
  for (const w of words) {
    if (!w.box) continue
    if (previous !== null) {
      if (w.box.y > previous) down++
      else if (w.box.y < previous) up++
    }
    previous = w.box.y
  }
  return up > down ? false : true
}

/** 短冊の中の位置を、コマ全体の位置へ直す */
export function toFrameBox(box: BoundingBox, band: SpineBand): BoundingBox {
  const span = Math.max(1e-6, band.end - band.start)
  return {
    x: band.start + box.x * span,
    y: box.y,
    width: box.width * span,
    height: box.height,
  }
}

/** 短冊の読み取り結果を、コマ全体の座標へ直す */
export function toFrameColumns(columns: readonly SpineColumn[], band: SpineBand): SpineColumn[] {
  return columns.map((c) => ({
    ...c,
    box: toFrameBox(c.box, band),
    words: c.words.map((w) => (w.box ? { ...w, box: toFrameBox(w.box, band) } : w)),
  }))
}

/**
 * 短冊の中で分かれてしまった列を、1冊ぶんにまとめる。
 *
 * 短冊1本 = 背表紙1冊のつもりで切っているが、Tesseract は背表紙の中の
 * 「書名」と「著者」を別々の列として返してくることがある。x 方向に重なって
 * いるものは同じ読み列とみなして束ね、上から下へ並べ直す
 * （縦の空きによる切り分けは parse.ts の splitColumn がやる）。
 *
 * 逆に、x が重ならない列は残す。短冊に2冊入ってしまった場合と、
 * 太い背表紙に書名が2行で刷られている場合がこれにあたる。
 */
/**
 * 短冊の中で、これより細い列は捨てる（短冊の幅に対する割合）。
 *
 * 短冊は隣へ少しはみ出させて切ってあるので、端に隣の背表紙の縁や
 * 溝が入る。それが縦棒として読まれ、「11」「ェェ」といった列になる
 * （実測でそう出た）。書名の列は短冊の 4〜5割を占めるので、
 * 細い列は書名ではない。
 */
const MIN_COLUMN_WIDTH_RATIO = 0.15

export function mergeStripColumns(
  columns: readonly SpineColumn[],
  overlapRatio = 0.5,
): SpineColumn[] {
  const kept = columns.filter((c) => c.box.width >= MIN_COLUMN_WIDTH_RATIO)
  if (kept.length < 2) return [...kept]

  const sorted = [...kept].sort((a, b) => a.box.x - b.box.x)
  const groups: SpineColumn[][] = [[sorted[0]]]

  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i]
    const group = groups[groups.length - 1]
    const left = Math.min(...group.map((c) => c.box.x))
    const right = Math.max(...group.map((c) => c.box.x + c.box.width))
    const overlap =
      Math.min(right, current.box.x + current.box.width) - Math.max(left, current.box.x)
    const narrower = Math.min(right - left, current.box.width)
    if (narrower > 0 && overlap / narrower >= overlapRatio) group.push(current)
    else groups.push([current])
  }

  return groups.map((group) => {
    if (group.length === 1) return group[0]
    /*
     * 列どうしの並べ方は、語が返ってきた向きに合わせる。
     * 列の中の語順は Tesseract の読み順のまま触らない。
     */
    const downward = readsDownward(group.flatMap((c) => c.words))
    const words = [...group]
      .sort((a, b) => (downward ? a.box.y - b.box.y : b.box.y - a.box.y))
      .flatMap((c) => c.words)
    const left = Math.min(...group.map((c) => c.box.x))
    const top = Math.min(...group.map((c) => c.box.y))
    const right = Math.max(...group.map((c) => c.box.x + c.box.width))
    const bottom = Math.max(...group.map((c) => c.box.y + c.box.height))
    return {
      words,
      box: { x: left, y: top, width: right - left, height: bottom - top },
      confidence: group.reduce((a, c) => a + c.confidence, 0) / group.length,
    }
  })
}

// ───────────────────────────────────────────────────────────
// 短冊ごとの前処理
// ───────────────────────────────────────────────────────────

/**
 * OCR にかけたい短冊の幅。
 *
 * Tesseract は文字の高さが 30〜40px を下回ると急に落ちる。縦書きの
 * 背表紙では字の大きさは**短冊の幅**でほぼ決まるので、細い短冊は拡大する。
 */
export const TARGET_STRIP_WIDTH = 160

/** 拡大しすぎない上限。1本あたりの画素数が増えるとそのまま時間になる */
export const MAX_STRIP_SCALE = 3
const MAX_STRIP_PIXELS = 2_400_000

/** 何倍に拡大するか。整数倍だけを使う(半端な倍率は字を滲ませる) */
export function stripScale(width: number, height: number): number {
  if (width < 1 || height < 1) return 1
  let scale = Math.min(MAX_STRIP_SCALE, Math.max(1, Math.ceil(TARGET_STRIP_WIDTH / width)))
  while (scale > 1 && width * scale * height * scale > MAX_STRIP_PIXELS) scale--
  return scale
}

/** 輝度の分布 */
export function grayHistogram(g: GrayImage): Uint32Array {
  const hist = new Uint32Array(256)
  for (let i = 0; i < g.data.length; i++) hist[g.data[i]]++
  return hist
}

/**
 * 大津の方法で地と文字を分ける閾値を求める。
 *
 * 短冊は1冊ぶんなので、地色は1色に近い。全体を1枚で二値化するより
 * ずっと素直に分かれる。これが短冊単位にした最大の利得である。
 */
export function otsuThreshold(g: GrayImage): number {
  const hist = grayHistogram(g)
  const total = g.data.length
  if (total === 0) return 128

  let sum = 0
  for (let v = 0; v < 256; v++) sum += v * hist[v]

  let sumB = 0
  let weightB = 0
  let best = 0
  let threshold = 128
  for (let t = 0; t < 256; t++) {
    weightB += hist[t]
    if (weightB === 0) continue
    const weightF = total - weightB
    if (weightF === 0) break
    sumB += t * hist[t]
    const meanB = sumB / weightB
    const meanF = (sum - sumB) / weightF
    const between = weightB * weightF * (meanB - meanF) * (meanB - meanF)
    if (between > best) {
      best = between
      threshold = t
    }
  }
  return threshold
}

/**
 * 白抜き文字（暗い地に明るい文字）か。
 *
 * 判定は素朴でよい。**画素の多数派が地、少数派が文字**である。
 * 地の側が暗ければ、文字は明るい＝白抜きということになる。
 */
export function isLightOnDark(g: GrayImage): boolean {
  if (g.data.length === 0) return false
  const t = otsuThreshold(g)
  const hist = grayHistogram(g)
  let dark = 0
  for (let v = 0; v <= t; v++) dark += hist[v]
  const light = g.data.length - dark
  return dark > light
}

/** 白黒を反転する */
export function invertGray(g: GrayImage): GrayImage {
  const out = new Uint8ClampedArray(g.data.length)
  for (let i = 0; i < g.data.length; i++) out[i] = 255 - g.data[i]
  return { width: g.width, height: g.height, data: out }
}

/**
 * コントラストを伸ばす。上下 clip ぶんを切り捨ててから 0..255 へ張る。
 *
 * 背表紙は照明のムラで階調が偏る。短冊ごとに伸ばすと、暗い棚の奥の
 * 1冊だけを持ち上げられる（1枚まとめてやると、明るい手前に引きずられる）。
 * 元から階調差が無いものは伸ばさない。ノイズを増幅するだけになるため。
 */
export function stretchContrast(g: GrayImage, clip = 0.02): GrayImage {
  const total = g.data.length
  if (total === 0) return g
  const hist = grayHistogram(g)
  const cut = total * clip

  // 下から数えて clip を超えた値が下端、上から数えて超えた値が上端
  let acc = 0
  let low = 0
  for (let v = 0; v < 256; v++) {
    acc += hist[v]
    if (acc > cut) {
      low = v
      break
    }
  }
  acc = 0
  let high = 255
  for (let v = 255; v >= 0; v--) {
    acc += hist[v]
    if (acc > cut) {
      high = v
      break
    }
  }
  if (high - low < 8) return g

  const out = new Uint8ClampedArray(total)
  const span = high - low
  for (let i = 0; i < total; i++) {
    out[i] = ((g.data[i] - low) * 255) / span
  }
  return { width: g.width, height: g.height, data: out }
}

/**
 * 短冊1本を OCR にかけられる形にする。
 *
 * コントラストを伸ばし、白抜き文字なら反転して、**必ず「明るい地に暗い文字」**
 * へ揃える。1枚まるごとではこれができない（1枚に両方の極性が混ざっている）。
 */
export function prepareStrip(g: GrayImage): GrayImage {
  const stretched = stretchContrast(g)
  return isLightOnDark(stretched) ? invertGray(stretched) : stretched
}
