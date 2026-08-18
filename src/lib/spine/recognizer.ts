/**
 * 背表紙の読み取り機構
 *
 * Tesseract を UI へ直接埋め込まず、交換できる形にしておく。
 *
 * 日本語の背表紙は縦書き・装飾書体・箔押し・光沢と、一般的な文書 OCR より
 * 条件が悪い。端末内 OCR で実用に届かなかった場合、ここを差し替えるだけで
 * 別の読み取り(VLM など)へ移せるようにしておく。逆に言えば、この境界より
 * 先(照合・一覧・書き出し)は読み取り手段に依存させない。
 */

import type { OcrFragment } from '../../types'

/** 1枚の背表紙画像に対する読み取り結果 */
export interface SpineRecognition {
  /** 読めた文字をそのまま連結したもの。行の区切りは改行で残す */
  rawText: string
  /** 行ごとの断片。照合クエリの組み立てに使う */
  fragments: OcrFragment[]
  /** 全体の自己申告信頼度 (0..1) */
  confidence: number
  /** どちらの向きで読めたか。読めなかったときは unknown */
  orientation: 'vertical' | 'horizontal' | 'unknown'
}

export interface SpineRecognizer {
  /**
   * 読み取りの準備。wasm と言語モデルの取得を含むので時間がかかる。
   * カメラの許可取得と並行して呼ぶ想定。二度呼んでも1回しか走らない。
   */
  prepare(): Promise<void>
  recognize(image: Blob): Promise<SpineRecognition>
  /** 待ち行列を捌き終えたあとに呼ぶ。Worker を落としてメモリを返す */
  dispose(): Promise<void>
}

/** 読み取りが成立しなかったときの値 */
export const EMPTY_RECOGNITION: SpineRecognition = {
  rawText: '',
  fragments: [],
  confidence: 0,
  orientation: 'unknown',
}

export class SpineRecognizerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpineRecognizerUnavailableError'
  }
}
