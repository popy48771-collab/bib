/**
 * Tesseract.js による背表紙OCR
 *
 * ── 1枚のコマから何冊も取る ───────────────────────────
 * 棚一段が写ったコマをそのまま渡すと、Tesseract のレイアウト解析が
 * 背表紙を縦の列に分けて返してくる。列の1つが背表紙1冊に対応する。
 * 背表紙の境界を自前で検出する必要がないので、OpenCV.js は要らない。
 *
 * 位置(bbox)も返ってくるので、確認用に1冊ぶんを切り出せる。
 *
 * ── 外部CDNを見に行かせない ───────────────────────────
 * tesseract.js は既定で Worker 本体・wasm・言語モデルを jsDelivr から
 * 取りに行く。静的サイトの可用性が第三者のCDNに乗ってしまうので、
 * 3つとも自サイト配下から配る。
 *   - Worker 本体と wasm … npm の依存を Vite に資産として出させる
 *   - 言語モデル        … public/ocr/lang（README に出所を書いてある）
 *
 * パッケージ本体ではなく配布済みの ESM ビルドを読むのは、本体が
 * CommonJS で node 用の分岐（fs / node-fetch）を含んでおり、
 * バンドラの browser フィールド解決に結果が左右されるため。
 *
 * ── 重い資産は遅延ロードする ──────────────────────────
 * wasm 3.8MB + 言語モデル 3.4MB を初期表示で読み込ませない。
 * 「本棚の背表紙」を選んでカメラを起動したときに初めて取りに行く。
 * 動的 import なので、バーコードしか使わない利用者には一切降ってこない。
 */

import { rotateBlob } from './capture'
import {
  EMPTY_RECOGNITION,
  SpineRecognizerUnavailableError,
  type ImageSize,
  type SpineColumn,
  type SpineRecognition,
  type SpineRecognizer,
} from './recognizer'
import type { BoundingBox, OcrFragment } from '../../types'

/**
 * 使う言語モデル。
 *
 * `jpn_vert` が縦書き用、`jpn` が横組み用。1つの Worker に両方を持たせる。
 * 読むたびに切り替える(reinitialize)方式は、切り替えのたびにモデルを
 * 読み直すので棚卸しの速度が出ない。
 *
 * 欧文専用の `eng` は入れていない。3つ同時に読ませると1冊あたりの時間が
 * 伸びるうえ、`jpn` はラテン文字も学習している(public/ocr/README.md)。
 */
const LANGS = 'jpn_vert+jpn'

/** LSTM のみ。旧エンジンは使わないので wasm も -lstm 版で足りる */
const OEM_LSTM_ONLY = 1

/** 縦書きの列として読む。日本語の棚はこれが基本 */
const PSM_VERTICAL_BLOCK = '5'
/** 横組みとして読む。回転させたあとに使う */
const PSM_BLOCK = '6'

/** 欲しい出力だけ。hOCR や PDF を作らせると時間と記憶域の無駄になる */
const OUTPUT = { text: true, blocks: true }

/** 語として採る最低の信頼度。これ未満は飾りや影を拾ったもの */
const MIN_WORD_CONFIDENCE = 0.3
/** 列として採る最低の文字数。1〜2文字の列は背表紙ではない */
const MIN_COLUMN_LENGTH = 3

/**
 * 回して読み直す条件。
 *
 * 1周目(縦書き)でこの数の列も取れなかったときだけ、90度回して読み直す。
 * 洋書ばかりの棚を救うための経路で、和書の棚では走らない。
 * 棚一段まるごとを2度3度読むのは高くつくので、空振りしたときに限る。
 */
const RETRY_BELOW_COLUMNS = 2

/**
 * 読む向きの試行順。
 *
 * 洋書の背表紙は上から下へ読む向き(英米)と下から上へ読む向き(欧州)が
 * あり、どちらかは事前に判らないので両方試す。
 */
const PASSES: { rotate: 0 | 1 | 3; psm: string; orientation: SpineRecognition['orientation'] }[] = [
  { rotate: 0, psm: PSM_VERTICAL_BLOCK, orientation: 'vertical' },
  { rotate: 3, psm: PSM_BLOCK, orientation: 'horizontal' },
  { rotate: 1, psm: PSM_BLOCK, orientation: 'horizontal' },
]

type Worker = import('tesseract.js/dist/tesseract.esm.min.js').TesseractWorker
type Page = import('tesseract.js/dist/tesseract.esm.min.js').TesseractPage

/** 資産の置き場。GitHub Pages ではリポジトリ名がパスに入るので BASE_URL を通す */
function langPath(): string {
  return `${import.meta.env.BASE_URL}ocr/lang`
}

/**
 * 回転して読んだときの位置を、元のコマの向きへ戻す。
 *
 * 回した画像の座標のまま返すと、確認用に切り出す場所がずれる。
 */
function unrotate(box: BoundingBox, quarterTurns: 0 | 1 | 3): BoundingBox {
  if (quarterTurns === 0) return box
  // 3 = 反時計回りに90度回して読んだ → 元へ戻すには時計回りに90度
  if (quarterTurns === 3) {
    return { x: box.y, y: 1 - box.x - box.width, width: box.height, height: box.width }
  }
  return { x: 1 - box.y - box.height, y: box.x, width: box.height, height: box.width }
}

/** OCR の返す位置を 0..1 に直す */
function toBox(
  bbox: { x0: number; y0: number; x1: number; y1: number },
  size: ImageSize,
): BoundingBox {
  const w = Math.max(1, size.width)
  const h = Math.max(1, size.height)
  return {
    x: bbox.x0 / w,
    y: bbox.y0 / h,
    width: Math.max(0, bbox.x1 - bbox.x0) / w,
    height: Math.max(0, bbox.y1 - bbox.y0) / h,
  }
}

/**
 * 1枚の読み取り結果を、背表紙1冊ずつの列に直す。
 *
 * Tesseract の「行」は、縦書きでは1本の縦列にあたる。実測では棚の背表紙が
 * ちょうど1冊=1行として返り、行どうしの x 範囲は重ならなかった。
 */
function columnsOf(page: Page, size: ImageSize, rotate: 0 | 1 | 3): SpineColumn[] {
  const columns: SpineColumn[] = []

  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const words: OcrFragment[] = []
        for (const w of line.words ?? []) {
          const text = (w.text ?? '').replace(/\s+/g, '')
          const confidence = Math.max(0, Math.min(1, (w.confidence ?? 0) / 100))
          if (!text || confidence < MIN_WORD_CONFIDENCE) continue
          words.push({ text, confidence, box: unrotate(toBox(w.bbox, size), rotate) })
        }
        if (words.reduce((n, w) => n + w.text.length, 0) < MIN_COLUMN_LENGTH) continue

        columns.push({
          words,
          box: unrotate(toBox(line.bbox, size), rotate),
          confidence: Math.max(0, Math.min(1, (line.confidence ?? 0) / 100)),
        })
      }
    }
  }
  return columns
}

export function createTesseractRecognizer(): SpineRecognizer {
  let worker: Worker | null = null
  let starting: Promise<Worker> | null = null
  let disposed = false

  async function start(): Promise<Worker> {
    // 資産の URL は Vite に解決させる。?url なのでコードは取り込まれない
    const [tesseract, workerUrl, coreUrl] = await Promise.all([
      import('tesseract.js/dist/tesseract.esm.min.js').then((m) => m.default),
      import('tesseract.js/dist/worker.min.js?url').then((m) => m.default),
      import('tesseract.js-core/tesseract-core-simd-lstm.wasm.js?url').then((m) => m.default),
    ])

    const created = await tesseract.createWorker(LANGS, OEM_LSTM_ONLY, {
      workerPath: workerUrl,
      corePath: coreUrl,
      langPath: langPath(),
      // 言語モデルは .gz で置いてある(3.4MB → 転送量を半分以下に抑える)
      gzip: true,
    })

    // 解像度をこちらで宣言しておく。指定しないと毎回推定して警告を吐く
    await created.setParameters({ user_defined_dpi: '300' })
    return created
  }

  async function ensure(): Promise<Worker> {
    if (disposed) throw new SpineRecognizerUnavailableError('読み取りは終了しています。')
    if (worker) return worker
    if (!starting) {
      starting = start()
        .then((w) => {
          worker = w
          return w
        })
        .catch((err) => {
          starting = null
          throw new SpineRecognizerUnavailableError(
            '文字の読み取り機能を読み込めませんでした。ネットワークの状態を確認して、もう一度お試しください。' +
              (err instanceof Error ? `（${err.message}）` : ''),
          )
        })
    }
    return starting
  }

  return {
    async prepare() {
      await ensure()
    },

    async recognize(image, size) {
      const w = await ensure()
      let best = EMPTY_RECOGNITION

      for (const pass of PASSES) {
        let target = image
        let passSize = size
        if (pass.rotate !== 0) {
          try {
            target = await rotateBlob(image, pass.rotate)
            passSize = { width: size.height, height: size.width }
          } catch {
            // 回転できない環境では、その周は飛ばす
            continue
          }
        }

        await w.setParameters({ tessedit_pageseg_mode: pass.psm })
        const page = (await w.recognize(target, undefined, OUTPUT)).data
        const columns = columnsOf(page, passSize, pass.rotate)
        const rec: SpineRecognition = {
          columns,
          confidence: Math.max(0, Math.min(1, (page.confidence ?? 0) / 100)),
          orientation: columns.length > 0 ? pass.orientation : 'unknown',
        }

        if (rec.columns.length > best.columns.length) best = rec
        // 1周目で棚として読めていれば、回して読み直さない
        if (rec.columns.length >= RETRY_BELOW_COLUMNS) return rec
      }
      return best
    },

    async dispose() {
      disposed = true
      const w = worker
      worker = null
      starting = null
      if (w) await w.terminate().catch(() => undefined)
    },
  }
}
