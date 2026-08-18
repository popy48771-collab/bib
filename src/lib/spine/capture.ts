/**
 * 読取レーンの切り出しと、コマの品質判定
 *
 * ── なぜ「中央読取レーン」なのか ────────────────────────
 * 画面内の背表紙をすべて同時に切り分けようとすると、背表紙の境界検出が
 * 要る。日本語の棚は本の高さも厚みも不揃いで、直線検出には OpenCV.js
 * (8MB超) を持ち込むことになる。
 *
 * 代わりに、画面中央へ背表紙1冊ぶんの縦長の帯を置き、棚に沿って
 * カメラを横へ流してもらう。帯を通過した背表紙だけを取り込むので、
 *  - 境界検出が要らない
 *  - 1冊ぶんに解像度を割ける
 *  - Canvas 2D だけで完結する
 * という利点がある。「かざすだけ」という操作の性質も変わらない。
 *
 * ここに置くのは Canvas に依存しない純粋な計算が主。DOM を触るのは
 * 末尾の3つだけで、テストからは呼ばない。
 */

/** ImageData 互換。テストから作れるよう構造だけで受ける */
export interface RgbaImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** 輝度のみ。1画素1バイト */
export interface GrayImage {
  width: number
  height: number
  data: Uint8ClampedArray
}

/** コマの品質。いずれも 0..1 */
export interface FrameQuality {
  /** 平均輝度。暗すぎると OCR はまず通らない */
  brightness: number
  /** 白飛びした画素の割合。光源の映り込みで跳ね上がる */
  blowout: number
  /** 鮮鋭度。ラプラシアンの分散を正規化したもの。小さいほどブレている */
  sharpness: number
}

/*
 * 閾値。実機の棚で調整する前提の初期値である。
 * 厳しすぎると1冊も取り込めず、緩すぎると読めない画像で OCR を回して
 * 待ち行列だけが伸びる。まずは「明らかに駄目なコマ」を落とす線に置く。
 */
export const MIN_BRIGHTNESS = 0.15
export const MAX_BRIGHTNESS = 0.95
export const MAX_BLOWOUT = 0.45
export const MIN_SHARPNESS = 0.05

/**
 * 白飛びとみなす輝度。
 *
 * 「明るい画素」ではなく「振り切れた画素」を数える。白い紙のカバーは
 * 250 前後まで上がるので、そこを白飛びとして弾くと**白い背表紙の本が
 * まるごと読めなくなる**（実際にそうなった）。潰れているのは 254 以上で、
 * そこまで来ると文字は残っていない。
 */
export const BLOWOUT_LEVEL = 254

/** これ以下の差しかないコマは「止まっている」とみなす */
export const STILL_THRESHOLD = 0.045
/** これ以下のハッシュ距離なら同じ背表紙を写しているとみなす */
export const SIMILAR_HASH_DISTANCE = 6

/** 読取レーンの寸法。横向きに構えた画面の中央へ縦長に置く */
export const LANE_WIDTH_RATIO = 0.18
export const LANE_HEIGHT_RATIO = 0.92

/** ITU-R BT.601 の輝度。整数演算で足りる */
export function toGray(image: RgbaImage): GrayImage {
  const { width, height, data } = image
  const out = new Uint8ClampedArray(width * height)
  for (let i = 0, p = 0; p < out.length; i += 4, p++) {
    out[p] = (data[i] * 299 + data[i + 1] * 587 + data[i + 2] * 114) / 1000
  }
  return { width, height, data: out }
}

/**
 * 最近傍で縮小する。品質判定とハッシュにしか使わないので補間は要らない。
 * 毎コマ走る処理なので、ここで凝ると発熱する。
 */
export function downscale(g: GrayImage, targetWidth: number, targetHeight: number): GrayImage {
  const w = Math.max(1, Math.round(targetWidth))
  const h = Math.max(1, Math.round(targetHeight))
  const out = new Uint8ClampedArray(w * h)
  for (let y = 0; y < h; y++) {
    const sy = Math.min(g.height - 1, Math.floor((y * g.height) / h))
    for (let x = 0; x < w; x++) {
      const sx = Math.min(g.width - 1, Math.floor((x * g.width) / w))
      out[y * w + x] = g.data[sy * g.width + sx]
    }
  }
  return { width: w, height: h, data: out }
}

/** 平均輝度 (0..1) */
export function brightness(g: GrayImage): number {
  if (g.data.length === 0) return 0
  let sum = 0
  for (let i = 0; i < g.data.length; i++) sum += g.data[i]
  return sum / g.data.length / 255
}

/** 白飛びの割合 (0..1)。カバーの光沢や照明の映り込みを検出する */
export function blowoutRatio(g: GrayImage, threshold = BLOWOUT_LEVEL): number {
  if (g.data.length === 0) return 0
  let n = 0
  for (let i = 0; i < g.data.length; i++) if (g.data[i] >= threshold) n++
  return n / g.data.length
}

/**
 * 鮮鋭度。4近傍ラプラシアンの分散を使う。
 *
 * ブレた画像は輪郭が鈍り、ラプラシアンの散らばりが小さくなる。
 * 絶対値の意味は端末やレンズで変わるので、閾値は相対的な足切りとして扱う。
 * 戻り値は 0..1 に潰してある(分散 2000 でほぼ 1)。
 */
export function sharpness(g: GrayImage): number {
  const { width: w, height: h, data } = g
  if (w < 3 || h < 3) return 0

  let sum = 0
  let sumSq = 0
  let n = 0
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x
      const lap = 4 * data[i] - data[i - 1] - data[i + 1] - data[i - w] - data[i + w]
      sum += lap
      sumSq += lap * lap
      n++
    }
  }
  const mean = sum / n
  const variance = sumSq / n - mean * mean
  return Math.min(1, Math.max(0, variance) / 2000)
}

export function assessFrame(g: GrayImage): FrameQuality {
  return { brightness: brightness(g), blowout: blowoutRatio(g), sharpness: sharpness(g) }
}

/** 取り込んでよいコマか */
export function isUsable(q: FrameQuality): boolean {
  return (
    q.brightness >= MIN_BRIGHTNESS &&
    q.brightness <= MAX_BRIGHTNESS &&
    q.blowout <= MAX_BLOWOUT &&
    q.sharpness >= MIN_SHARPNESS
  )
}

/**
 * 取り込めない理由を利用者の言葉で返す。取り込める場合は null。
 *
 * 「何が起きたか。次に何をすればよいか。」の順で書く(DESIGN_SYSTEM.md 3節)。
 * 順序は「直せる見込みが高いもの」から見る。
 */
export function frameAdvice(q: FrameQuality): string | null {
  if (q.brightness < MIN_BRIGHTNESS) return '棚が暗すぎます。照明を点けるか、明るい場所で読み取ってください。'
  if (q.brightness > MAX_BRIGHTNESS) return '画面が明るすぎます。カメラの角度を変えて、光の反射を避けてください。'
  if (q.blowout > MAX_BLOWOUT) return '光が反射しています。カメラの角度を少し変えてください。'
  if (q.sharpness < MIN_SHARPNESS) return '文字がぼやけています。カメラを動かす速さを落としてください。'
  return null
}

/**
 * 2コマの差 (0..1)。手が止まったかどうかの判定に使う。
 * 寸法が違うものは比較できないので「まったく別」として 1 を返す。
 */
export function frameDifference(a: GrayImage, b: GrayImage): number {
  if (a.width !== b.width || a.height !== b.height) return 1
  if (a.data.length === 0) return 0
  let sum = 0
  for (let i = 0; i < a.data.length; i++) sum += Math.abs(a.data[i] - b.data[i])
  return sum / a.data.length / 255
}

/**
 * 平均ハッシュ (8x8 = 64bit)。16桁の16進文字列で返す。
 *
 * OCR にかける前に、同じ背表紙をレーンに置き続けているだけのコマを弾く。
 * 厳密な画像一致は要らず、「見た目が同じかどうか」だけ判れば足りる。
 */
export function visualHash(g: GrayImage): string {
  const small = downscale(g, 8, 8)
  let sum = 0
  for (let i = 0; i < small.data.length; i++) sum += small.data[i]
  const mean = sum / small.data.length

  let hex = ''
  for (let nibble = 0; nibble < 16; nibble++) {
    let v = 0
    for (let bit = 0; bit < 4; bit++) {
      v = (v << 1) | (small.data[nibble * 4 + bit] >= mean ? 1 : 0)
    }
    hex += v.toString(16)
  }
  return hex
}

/** ハッシュ距離。桁数が違うものは比較しない(最大距離を返す) */
export function hashDistance(a: string, b: string): number {
  if (a.length !== b.length) return a.length * 4 || 64
  let d = 0
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

/** 同じ背表紙を写しているとみなせるか */
export function looksSame(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false
  return hashDistance(a, b) <= SIMILAR_HASH_DISTANCE
}

/**
 * 連写した中から最も鮮鋭な1枚を選ぶ(ベスト・オブ・バースト)。
 *
 * 同じ背表紙へ何度も OCR をかけずに手ブレの影響を減らせる。
 * 空配列なら null。
 */
export function pickSharpest<T extends { quality: FrameQuality }>(frames: readonly T[]): T | null {
  let best: T | null = null
  for (const f of frames) {
    if (!best || f.quality.sharpness > best.quality.sharpness) best = f
  }
  return best
}

/** 映像内での読取レーンの位置(画素)。UI の枠と切り出しで同じ値を使う */
export function laneRect(
  videoWidth: number,
  videoHeight: number,
  widthRatio = LANE_WIDTH_RATIO,
  heightRatio = LANE_HEIGHT_RATIO,
): { x: number; y: number; width: number; height: number } {
  const width = Math.max(1, Math.round(videoWidth * widthRatio))
  const height = Math.max(1, Math.round(videoHeight * heightRatio))
  return {
    x: Math.round((videoWidth - width) / 2),
    y: Math.round((videoHeight - height) / 2),
    width,
    height,
  }
}

// ── ここから下は DOM を触る。テストからは呼ばない ────────────

/**
 * 読取レーンを canvas へ描く。targetWidth を指定すると縮小して描く
 * (毎コマの品質判定用)。描けなければ null。
 */
export function drawLane(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  targetWidth?: number,
): ImageData | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const rect = laneRect(vw, vh)
  const scale = targetWidth ? Math.min(1, targetWidth / rect.width) : 1
  const dw = Math.max(1, Math.round(rect.width * scale))
  const dh = Math.max(1, Math.round(rect.height * scale))

  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.drawImage(video, rect.x, rect.y, rect.width, rect.height, 0, 0, dw, dh)
  return ctx.getImageData(0, 0, dw, dh)
}

/** canvas を Blob にする。保存と OCR の受け渡しに使う */
export function canvasToBlob(canvas: HTMLCanvasElement, quality = 0.85): Promise<Blob | null> {
  return new Promise((resolve) => {
    // 背表紙は文字が主役なので、圧縮しすぎない。JPEG で十分小さくなる
    canvas.toBlob((b) => resolve(b), 'image/jpeg', quality)
  })
}

/**
 * 画像を90度単位で回転した Blob を作る。
 *
 * 洋書の背表紙は文字が横倒しに入っていることが多く、縦書き用のモデルでは
 * 読めない。読めなかったときに回して読み直すために使う。
 */
export async function rotateBlob(blob: Blob, quarterTurns: 1 | 3): Promise<Blob> {
  const bitmap = await createImageBitmap(blob)
  try {
    const canvas = document.createElement('canvas')
    canvas.width = bitmap.height
    canvas.height = bitmap.width
    const ctx = canvas.getContext('2d')
    if (!ctx) return blob

    ctx.translate(canvas.width / 2, canvas.height / 2)
    ctx.rotate((quarterTurns * Math.PI) / 2)
    ctx.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2)

    return (await canvasToBlob(canvas)) ?? blob
  } finally {
    bitmap.close()
  }
}
