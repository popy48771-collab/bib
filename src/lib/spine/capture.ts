/**
 * コマの取り込みと品質判定
 *
 * ── 切り出しの単位が変わった経緯 ──────────────────────
 * 最初は画面中央に背表紙1冊ぶんの帯(読取レーン)を置いていた。棚の一段が
 * 画面に収まる距離では、幅18%のレーンが**約5.3冊ぶんを覆って**いたので捨てた。
 * 背表紙の厚みは文庫1.5cmから画集4cmまで幅があり、**固定幅のレーンで
 * 1冊ちょうどを切り出すことは原理的にできない**。
 *
 * 次に「フレーム全体を Tesseract に渡し、レイアウト解析に列へ分けさせる」
 * 方式を採った。**これも実機で全滅した。** 検証が合成画像（地色が一様）
 * だけで、実物の棚に必ずある**極性の混在**（白抜き文字と黒文字が1枚に同居）
 * を再現できていなかった。Tesseract の二値化はページ単位なので、混ざると
 * どちらかの極性の背表紙が丸ごと潰れる。
 *
 * いまは**背表紙ごとの短冊に切ってから、短冊1本ずつ読む**（lib/spine/segment.ts）。
 * 極性は短冊の中で閉じ、1本読み終えるたびに1冊ぶんの結果を出せる。
 * 短冊が2本も取れなかったコマだけ、フレーム全体の読み取りへ退避する。
 *
 * したがってここでは、
 *  - フレーム全体を取り込む
 *  - 取り込んでよいコマかを品質で判定する
 *  - 短冊を切り出し、OCR にかけられる形に整える
 *  - OCR が返した位置をもとに、1冊ぶんを切り出す(確認用の画像)
 * をやる。Canvas に依存しない純粋な計算が主で、DOM を触るのは末尾だけ。
 */

import type { BoundingBox } from '../../types'
import { padBand, prepareStrip, stripScale, type SpineBand } from './segment'

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
/*
 * 鮮鋭度の下限。
 *
 * 実機で「かざしても何も起きない」という報告が出たので緩めてある。
 * 監視用の縮小画像では書名の字は潰れており、ここに出るのは背表紙の境目の
 * 輪郭だけである。棚が画面いっぱいでない構図（少し引いて構えた場合）だと
 * 0.05 に届かない。短冊ごとにコントラストを伸ばすようになったので、
 * 多少眠いコマでも読める見込みが立った。
 */
export const MIN_SHARPNESS = 0.035

/**
 * 白飛びとみなす輝度。
 *
 * 「明るい画素」ではなく「振り切れた画素」を数える。白い紙のカバーは
 * 250 前後まで上がるので、そこを白飛びとして弾くと**白い背表紙の本が
 * まるごと読めなくなる**（実際にそうなった）。潰れているのは 254 以上で、
 * そこまで来ると文字は残っていない。
 */
export const BLOWOUT_LEVEL = 254

/**
 * これ以下の差しかないコマは「止まっている」とみなす。
 *
 * 手持ちのカメラは完全には止まらない。0.045 では、腕を伸ばして棚へ
 * 向けているあいだ一度も成立しないことがあった（「かざしても何も起きない」）。
 */
export const STILL_THRESHOLD = 0.06
/** これ以下のハッシュ距離なら同じ背表紙を写しているとみなす */
export const SIMILAR_HASH_DISTANCE = 6

/**
 * 画面に出す「棚の枠」。取り込む範囲そのものではなく、構え方の案内。
 *
 * この枠に棚の一段を収めてもらうと、背表紙の高さが画面の縦をほぼ埋め、
 * 書名の文字が OCR に足る大きさ(実測で 40px 以上)になる。
 */
export const SHELF_GUIDE_INSET = 0.04

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

// ── 取り込みの見きわめ ──────────────────────────────

/**
 * 取り込むまでに必要な「止まっている」コマの連続数。約 0.75 秒ぶん。
 * 棚一段ぶんの撮り直しは高くつくので、ぶれていないことを確かめてから撮る。
 */
export const STABLE_TICKS = 3

/**
 * 救済までの待ち時間 (ms)。
 *
 * **静止3連続が成立しないまま待たせ続けない。** 実機では、品質は足りて
 * いるのに手ぶれで静止判定が一度も通らず、「かざしているのに何も起きない」
 * 状態が続いた。ここを過ぎたら、そこそこ鮮鋭なコマで妥協して撮る。
 * 1枚取り込めれば読み取りが始まり、少なくとも何が読めるかは分かる。
 */
export const RESCUE_AFTER_MS = 4000

/** 救済を諦める時刻。ここまで来たら鮮鋭度を問わず1枚撮る */
export const RESCUE_FORCE_MS = 8000

/** 救済で撮ってよい鮮鋭度。待っているあいだの最良コマに対する割合 */
export const RESCUE_SHARPNESS_RATIO = 0.85

export interface CaptureDecisionInput {
  /** 品質が足りているか */
  usable: boolean
  /** 直前のコマとの差 */
  moved: number
  /** ここまでに続いた「止まっている」コマの数 */
  stable: number
  /** 最後に取り込んでから(または監視を始めてから)の経過 (ms) */
  waitedMs: number
  /** いまのコマの鮮鋭度 */
  sharpness: number
  /** 待っているあいだに見た最良の鮮鋭度 */
  bestSharpness: number
}

/**
 * いま撮るべきか。
 *
 *  - `reject` … 品質が足りない。撮らないし、静止の連続も切る
 *  - `wait`   … まだ止まっていない
 *  - `capture`… 撮る
 *
 * 画面から切り出してあるのは、**「かざしても何も起きない」を潰したのが
 * ここだから**である。静止の連続だけを条件にすると、手ぶれの大きい人と
 * 暗い部屋では永久に成立しない。救済の期限を測れる形で持つ。
 */
export function decideCapture(input: CaptureDecisionInput): 'capture' | 'wait' | 'reject' {
  if (!input.usable) return 'reject'
  if (input.moved <= STILL_THRESHOLD && input.stable + 1 >= STABLE_TICKS) return 'capture'
  if (input.waitedMs >= RESCUE_FORCE_MS) return 'capture'
  if (
    input.waitedMs >= RESCUE_AFTER_MS &&
    input.sharpness >= input.bestSharpness * RESCUE_SHARPNESS_RATIO
  ) {
    return 'capture'
  }
  return 'wait'
}

/**
 * 相対座標(0..1)の枠を画素へ直す。
 * OCR が返した1冊ぶんの位置から、確認用の画像を切り出すのに使う。
 *
 * 枠は少し広げる。OCR の返す枠は文字にぴったり張り付いており、
 * そのまま切ると背表紙の地色が入らず、何の画像か分からなくなる。
 */
export function boxToRect(
  box: BoundingBox,
  imageWidth: number,
  imageHeight: number,
  padRatio = 0.35,
): { x: number; y: number; width: number; height: number } {
  const padX = box.width * imageWidth * padRatio
  // 縦は文字の並びなので、横ほど広げなくてよい
  const padY = box.height * imageHeight * padRatio * 0.06
  const x = Math.max(0, Math.round(box.x * imageWidth - padX))
  const y = Math.max(0, Math.round(box.y * imageHeight - padY))
  const right = Math.min(imageWidth, Math.round((box.x + box.width) * imageWidth + padX))
  const bottom = Math.min(imageHeight, Math.round((box.y + box.height) * imageHeight + padY))
  return { x, y, width: Math.max(1, right - x), height: Math.max(1, bottom - y) }
}

// ── ここから下は DOM を触る。テストからは呼ばない ────────────

/**
 * フレーム全体を canvas へ描く。targetWidth を指定すると縮小して描く
 * (毎コマの品質判定用)。描けなければ null。
 */
export function drawFrame(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  targetWidth?: number,
): ImageData | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const scale = targetWidth ? Math.min(1, targetWidth / vw) : 1
  const dw = Math.max(1, Math.round(vw * scale))
  const dh = Math.max(1, Math.round(vh * scale))

  canvas.width = dw
  canvas.height = dh
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.drawImage(video, 0, 0, vw, vh, 0, 0, dw, dh)
  return ctx.getImageData(0, 0, dw, dh)
}

/**
 * 1枚のコマから、本ごとの位置で切り出す。
 *
 * 確認が要る行に「読み取った背表紙」を出すために使う。1冊ずつ切っておくと、
 * 候補を選ぶときに棚まで見に戻らずに済む。
 * 切り出せなかったものは null を返す。画像が無くても一覧の作成は止めない。
 */
export async function cropBoxes(
  frame: Blob,
  boxes: readonly (BoundingBox | undefined)[],
): Promise<(CroppedImage | null)[]> {
  if (boxes.length === 0) return []
  const bitmap = await createImageBitmap(frame)
  try {
    const canvas = document.createElement('canvas')
    const ctx = canvas.getContext('2d')
    if (!ctx) return boxes.map(() => null)

    const out: (CroppedImage | null)[] = []
    for (const box of boxes) {
      if (!box) {
        out.push(null)
        continue
      }
      const r = boxToRect(box, bitmap.width, bitmap.height)
      canvas.width = r.width
      canvas.height = r.height
      ctx.drawImage(bitmap, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height)
      const blob = await canvasToBlob(canvas)
      out.push(blob ? { blob, width: r.width, height: r.height } : null)
    }
    return out
  } finally {
    bitmap.close()
  }
}

/** 切り出した1冊ぶんの画像 */
export interface CroppedImage {
  blob: Blob
  width: number
  height: number
}

/** 背表紙1冊ぶんの短冊 */
export interface SpineStrip {
  /** コマの中での x 範囲 */
  band: SpineBand
  /** OCR にかける画像。極性を揃え、コントラストを伸ばし、拡大してある */
  image: Blob
  width: number
  height: number
  /** 確認用の画像。**前処理する前の見たまま**を残す(反転した画像では見比べられない) */
  preview: CroppedImage | null
}

/**
 * コマを短冊へ切り分け、1本ずつ OCR にかけられる形にする。
 *
 * ここが今回の改修の本丸。**前処理を短冊ごとにやる**ことに意味がある。
 * 1枚まるごとを二値化すると、白抜きの背表紙と黒文字の背表紙が同じ閾値に
 * かかり、どちらかが潰れる。短冊に切ってからなら、地色は1冊ぶんに閉じる。
 *
 * 画像の復号は1回だけにする。短冊ごとに createImageBitmap を呼ぶと、
 * 20〜30冊ぶんで端末が保たない。
 */
export async function cropStrips(
  frame: Blob,
  bands: readonly SpineBand[],
): Promise<SpineStrip[]> {
  if (bands.length === 0) return []
  const bitmap = await createImageBitmap(frame)
  try {
    const source = document.createElement('canvas')
    const sourceCtx = source.getContext('2d', { willReadFrequently: true })
    const out = document.createElement('canvas')
    const outCtx = out.getContext('2d')
    if (!sourceCtx || !outCtx) return []

    const strips: SpineStrip[] = []
    for (const band of bands) {
      // 境界は縦の直線と近似しているので、隣へ少しはみ出させて切る
      const padded = padBand(band)
      const x = Math.max(0, Math.round(padded.start * bitmap.width))
      const right = Math.min(bitmap.width, Math.round(padded.end * bitmap.width))
      const width = Math.max(1, right - x)
      const height = bitmap.height

      source.width = width
      source.height = height
      sourceCtx.drawImage(bitmap, x, 0, width, height, 0, 0, width, height)

      // 確認用は前処理前のまま。候補を選ぶときに背表紙と見比べるためのもの
      const previewBlob = await canvasToBlob(source)
      const preview = previewBlob ? { blob: previewBlob, width, height } : null

      const gray = prepareStrip(toGray(sourceCtx.getImageData(0, 0, width, height)))
      const scale = stripScale(width, height)
      out.width = width * scale
      out.height = height * scale
      putGray(outCtx, gray, scale)

      const image = await canvasToBlob(out, 0.92)
      if (!image) continue
      strips.push({ band, image, width: out.width, height: out.height, preview })
    }
    return strips
  } finally {
    bitmap.close()
  }
}

/**
 * 濃淡画像を canvas へ書き戻す。整数倍の拡大を同時に行う。
 *
 * 拡大は最近傍で足りる。滑らかに補間すると字の輪郭が鈍り、
 * かえって OCR の当たりが下がる。
 */
function putGray(ctx: CanvasRenderingContext2D, g: GrayImage, scale: number): void {
  const w = g.width * scale
  const h = g.height * scale
  const image = ctx.createImageData(w, h)
  const data = image.data
  for (let y = 0; y < h; y++) {
    const sy = Math.floor(y / scale) * g.width
    for (let x = 0; x < w; x++) {
      const v = g.data[sy + Math.floor(x / scale)]
      const i = (y * w + x) * 4
      data[i] = v
      data[i + 1] = v
      data[i + 2] = v
      data[i + 3] = 255
    }
  }
  ctx.putImageData(image, 0, 0)
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
