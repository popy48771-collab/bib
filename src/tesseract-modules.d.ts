/**
 * tesseract.js の型（このアプリが使う範囲だけ）
 *
 * パッケージ本体は CommonJS で、`export =` 形式の型定義を持つ。
 * ここでは配布済みの ESM ビルドを直接読み込むので、その分の宣言を置く。
 * ESM ビルドを使う理由は src/lib/spine/tesseract.ts の冒頭に書いてある。
 *
 * 全部の型は要らない。使う面だけ宣言しておく方が、上流の変更で
 * どこが壊れるかが分かりやすい。
 */
declare module 'tesseract.js/dist/tesseract.esm.min.js' {
  /** 画像上の位置（画素） */
  export interface TesseractBbox {
    x0: number
    y0: number
    x1: number
    y1: number
  }

  export interface TesseractWord {
    text: string
    /** 0..100 */
    confidence: number
    bbox: TesseractBbox
  }

  export interface TesseractLine {
    text: string
    /** 0..100 */
    confidence: number
    bbox: TesseractBbox
    words: TesseractWord[]
  }

  export interface TesseractParagraph {
    lines: TesseractLine[]
  }

  export interface TesseractBlock {
    paragraphs: TesseractParagraph[]
  }

  export interface TesseractPage {
    text: string
    /** 0..100 */
    confidence: number
    blocks: TesseractBlock[] | null
  }

  export interface TesseractWorker {
    setParameters(params: Record<string, string>): Promise<unknown>
    recognize(
      image: Blob,
      options?: Record<string, unknown>,
      output?: Record<string, boolean>,
    ): Promise<{ data: TesseractPage }>
    terminate(): Promise<unknown>
  }

  export interface CreateWorkerOptions {
    /** Worker 本体の URL。既定は jsDelivr なので必ず差し替える */
    workerPath?: string
    /** wasm 本体の URL。`.js` で終わる場合はそのまま読み込まれる */
    corePath?: string
    /** 言語モデルを置いた場所。`{lang}.traineddata.gz` を取りに行く */
    langPath?: string
    gzip?: boolean
    logger?: (message: { status: string; progress: number }) => void
    errorHandler?: (error: unknown) => void
  }

  const tesseract: {
    createWorker(
      langs: string | string[],
      oem?: number,
      options?: CreateWorkerOptions,
      config?: Record<string, string>,
    ): Promise<TesseractWorker>
  }

  export default tesseract
}
