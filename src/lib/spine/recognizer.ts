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
 * ── 入口が2つある理由 ───────────────────────────────
 * かつては「フレーム全体を渡せば、レイアウト解析が列に分けてくれる」と
 * していた。実機ではこれが通らない。実物の棚は背表紙ごとに地色が違い、
 * **白抜き文字と黒文字が1枚に混在する**。ページ単位の二値化では極性を
 * 揃えられず、どちらかが潰れる。
 *
 * そこで**背表紙1冊ぶんの短冊**を渡す入口 (`recognizeColumn`) を足した。
 * 呼び出し側が segment.ts で切り、短冊ごとに極性を揃えてから渡す。
 * 1本読み終えるたびに1冊ぶんの結果が出るので、待ち時間も短くなる。
 *
 * `recognize`（フレーム全体）は残してある。短冊が2本も取れなかったコマ
 * ——背表紙の境界が写っていない構図——の退避経路として要る。
 */

import type { BoundingBox, ExtractedSpine, OcrFragment } from '../../types'

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
  /**
   * 画像対応モデルが棚全体から直接組み立てた背表紙。
   *
   * Tesseract は columns を返し、Gemini はこちらを返す。書誌照合以降は
   * ExtractedSpine に揃うので、読み取り方式の違いを持ち込まない。
   */
  extracted?: ExtractedSpine[]
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
  /** 呼び出し側が棚全体と短冊のどちらを渡すべきか */
  readonly strategy: 'segmented' | 'wholeFrame'
  /**
   * 読み取りの準備。wasm と言語モデルの取得を含むので時間がかかる。
   * カメラの許可取得と並行して呼ぶ想定。二度呼んでも1回しか走らない。
   */
  prepare(): Promise<void>
  /** コマ全体を読む。退避経路。1枚に何冊も写っている前提 */
  recognize(image: Blob, size: ImageSize): Promise<SpineRecognition>
  /**
   * 背表紙1冊ぶんの短冊を読む。
   *
   * 呼び出し側が極性を揃えて渡してくるので、こちらは向きだけを見る。
   * 縦書きで読めなかったときに 90 度回して読み直すかは `rotate` で選ぶ
   * （短冊1本ならその往復は安い）。
   */
  recognizeColumn(
    image: Blob,
    size: ImageSize,
    options?: { rotate?: boolean },
  ): Promise<SpineRecognition>
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
