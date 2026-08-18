/**
 * 背表紙の読み取り機構
 *
 * Tesseract を UI へ直接埋め込まず、交換できる形にしておく。
 *
 * 日本語の背表紙は縦書き・装飾書体・箔押し・光沢と、一般的な文書 OCR より
 * 条件が悪い。端末内 OCR で実用に届かなかった場合、ここを差し替えるだけで
 * 別の読み取り(VLM など)へ移せるようにしておく。逆に言えば、この境界より
 * 先(照合・一覧・書き出し)は読み取り手段に依存させない。
 *
 * ── 単位は「列」 ────────────────────────────────────
 * 1枚のコマには棚一段ぶん、20〜30冊の背表紙が写る。読み取り機構は
 * それを**縦の列に分けて**返す。列の1つが背表紙1冊に対応する。
 *
 * 列に分けるのは読み取り機構の仕事にした。Tesseract はレイアウト解析の
 * 副産物として列を返してくるので、こちらで境界検出をやり直す必要がない
 * (それをやると OpenCV.js が要る)。差し替える機構が列を返さない場合は、
 * その実装の中で分ければよい。
 */

import type { BoundingBox, OcrFragment } from '../../types'

/** 背表紙1冊ぶんに対応する縦の列 */
export interface SpineColumn {
  /** 列の中の語。読み順(縦書きなら上から下)に並ぶ */
  words: OcrFragment[]
  /** 列全体の位置 (0..1 の相対座標) */
  box: BoundingBox
  /** 列の自己申告信頼度 (0..1) */
  confidence: number
}

/** 1枚のコマに対する読み取り結果 */
export interface SpineRecognition {
  /** 背表紙1冊ずつに対応する列。空なら読めなかった */
  columns: SpineColumn[]
  /** 全体の自己申告信頼度 (0..1) */
  confidence: number
  /** どちらの向きで読めたか。読めなかったときは unknown */
  orientation: 'vertical' | 'horizontal' | 'unknown'
}

/** 読み取りにかける画像の寸法。位置を 0..1 に正規化するのに要る */
export interface ImageSize {
  width: number
  height: number
}

export interface SpineRecognizer {
  /**
   * 読み取りの準備。wasm と言語モデルの取得を含むので時間がかかる。
   * カメラの許可取得と並行して呼ぶ想定。二度呼んでも1回しか走らない。
   */
  prepare(): Promise<void>
  recognize(image: Blob, size: ImageSize): Promise<SpineRecognition>
  /** 待ち行列を捌き終えたあとに呼ぶ。Worker を落としてメモリを返す */
  dispose(): Promise<void>
}

/** 読み取りが成立しなかったときの値 */
export const EMPTY_RECOGNITION: SpineRecognition = {
  columns: [],
  confidence: 0,
  orientation: 'unknown',
}

export class SpineRecognizerUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SpineRecognizerUnavailableError'
  }
}
