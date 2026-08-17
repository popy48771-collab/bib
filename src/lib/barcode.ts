/**
 * ISBN バーコードの読み取り
 *
 * 背表紙OCRと違い、バーコードは誤読がほぼ無く、通信も課金も発生しない。
 * 「課金ゼロで確実に蔵書リストを作る」経路の中核。
 *
 * ── 検出器の二本立て ──────────────────────────────────
 * BarcodeDetector はブラウザ内蔵で高速だが Safari が非対応。
 * 非対応環境では zxing-wasm を遅延ロードして代替する。
 * wasm は初回スキャン時まで読み込まないので、初期表示は重くならない。
 */

import { isValidIsbn13 } from './isbn'

/**
 * 日本の書籍は2段バーコードで、
 *   上段 = 978/979 で始まる ISBN
 *   下段 = 192... で始まる分類・価格コード
 * の2本が並んでいる。下段を本のIDとして拾うと存在しない書誌を引くため、
 * 「978/979 で始まり ISBN-13 のチェックディジットが合うもの」だけを通す。
 *
 * isbn.ts の extractIsbn13 は使わない。あちらは文字列中から10桁ISBNも
 * 拾おうとするため、下段の 13桁コードの部分列がたまたま ISBN-10 として
 * 成立してしまう危険がある。バーコードでは厳密一致で十分。
 */
export function isIsbnBarcode(raw: string): boolean {
  const v = raw.replace(/[\s-]/g, '')
  if (!/^97[89]\d{10}$/.test(v)) return false
  return isValidIsbn13(v)
}

/** 検出された複数のコードから ISBN を1つ選ぶ。無ければ null */
export function pickIsbn13(codes: readonly string[]): string | null {
  for (const c of codes) {
    const v = c.replace(/[\s-]/g, '')
    if (isIsbnBarcode(v)) return v
  }
  return null
}

// ── 検出器 ────────────────────────────────────────────

/** フレーム1枚から生のコード文字列を取り出すもの */
export interface BarcodeReader {
  readonly kind: 'native' | 'wasm'
  detect(image: ImageData): Promise<string[]>
}

/** BarcodeDetector の最小限の型。lib.dom には未収録 */
interface BarcodeDetectorLike {
  detect(source: ImageData): Promise<{ rawValue: string }[]>
}
interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
  getSupportedFormats(): Promise<string[]>
}

function nativeCtor(): BarcodeDetectorCtor | undefined {
  return (globalThis as { BarcodeDetector?: BarcodeDetectorCtor }).BarcodeDetector
}

/** 内蔵 BarcodeDetector が EAN-13 を読めるか */
export async function hasNativeDetector(): Promise<boolean> {
  const Ctor = nativeCtor()
  if (!Ctor) return false
  try {
    return (await Ctor.getSupportedFormats()).includes('ean_13')
  } catch {
    return false
  }
}

async function createNativeReader(): Promise<BarcodeReader> {
  const Ctor = nativeCtor()!
  const detector = new Ctor({ formats: ['ean_13'] })
  return {
    kind: 'native',
    async detect(image) {
      return (await detector.detect(image)).map((b) => b.rawValue)
    },
  }
}

async function createWasmReader(): Promise<BarcodeReader> {
  // 遅延ロード。ここで初めて wasm を取りに行く
  const [{ prepareZXingModule, readBarcodes }, wasmUrl] = await Promise.all([
    import('zxing-wasm/reader'),
    // Vite に wasm を資産として配置させ、その URL を得る。
    // これをしないと zxing-wasm は CDN を見に行き、オフラインで壊れる
    import('zxing-wasm/reader/zxing_reader.wasm?url').then((m) => m.default as string),
  ])

  prepareZXingModule({ overrides: { locateFile: () => wasmUrl } })

  return {
    kind: 'wasm',
    async detect(image) {
      // フォーマット名は 'EAN13'。'EAN-13' のようなハイフン付きは受理されず、
      // 指定が無効だと全フォーマット走査になって遅くなる
      const results = await readBarcodes(image, { formats: ['EAN13'], tryHarder: true })
      return results.filter((r) => r.isValid !== false).map((r) => r.text)
    },
  }
}

/**
 * 使える検出器を作る。内蔵を優先し、駄目なら wasm。
 * wasm のロードに失敗した場合は例外を投げる(呼び出し側でUI表示する)。
 */
export async function createBarcodeReader(): Promise<BarcodeReader> {
  if (await hasNativeDetector()) return createNativeReader()
  return createWasmReader()
}

// ── カメラ ────────────────────────────────────────────

export class CameraUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CameraUnavailableError'
  }
}

/**
 * 背面カメラを開く。
 *
 * getUserMedia はセキュアコンテキスト(HTTPS または localhost)でしか動かない。
 * LAN の開発サーバ(素の http)では必ずここで失敗するので、
 * 原因が分かるメッセージにしておく。
 */
export async function openRearCamera(): Promise<MediaStream> {
  if (!globalThis.isSecureContext) {
    throw new CameraUnavailableError(
      'カメラは HTTPS でのみ利用できます。公開URL(https://)から開いてください。',
    )
  }
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new CameraUnavailableError(
      'このブラウザはカメラの利用に対応していません。別のブラウザで開いてください。',
    )
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: { ideal: 'environment' },
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
      audio: false,
    })
  } catch (err) {
    const name = err instanceof DOMException ? err.name : ''
    // 文面は「何が起きたか。次に何をすればよいか。」の順に揃える
    if (name === 'NotAllowedError') {
      throw new CameraUnavailableError(
        'カメラへのアクセスが許可されていません。ブラウザの設定を確認して、カメラの使用を許可してください。',
      )
    }
    if (name === 'NotFoundError') {
      throw new CameraUnavailableError(
        'カメラが見つかりませんでした。カメラのある端末で開いてください。',
      )
    }
    throw new CameraUnavailableError(
      'カメラを開けませんでした。他のアプリがカメラを使っていないか確認して、もう一度お試しください。',
    )
  }
}

/**
 * 映像の中央帯だけを ImageData として切り出す。
 *
 * バーコードは画面中央にかざされるので、周辺を捨てると
 * 検出が速くなり、隣の本を誤って読む事故も減る。
 */
export function grabCenterBand(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  bandRatio = 0.45,
): ImageData | null {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return null

  const bandH = Math.max(1, Math.round(vh * bandRatio))
  const sy = Math.round((vh - bandH) / 2)

  canvas.width = vw
  canvas.height = bandH
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.drawImage(video, 0, sy, vw, bandH, 0, 0, vw, bandH)
  return ctx.getImageData(0, 0, vw, bandH)
}
