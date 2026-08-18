/**
 * Tesseract.js による背表紙OCR
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
 * ESM ビルドはブラウザ向けに解決済みで、この不確実性が無い。
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
  type SpineRecognition,
  type SpineRecognizer,
} from './recognizer'
import type { OcrFragment } from '../../types'

/**
 * 使う言語モデル。
 *
 * `jpn_vert` が縦書き用、`jpn` が横組み用。1つの Worker に両方を持たせる。
 * 読むたびに切り替える(reinitialize)方式は、切り替えのたびにモデルを
 * 読み直すので棚卸しの速度が出ない。
 *
 * 欧文専用の `eng` は入れていない。3つ同時に読ませると1冊あたりの時間が
 * 伸びるうえ、`jpn` はラテン文字も学習している。洋書の精度不足が実測できた
 * 時点で足す(public/ocr/README.md)。
 */
const LANGS = 'jpn_vert+jpn'

/** LSTM のみ。旧エンジンは使わないので wasm も -lstm 版で足りる */
const OEM_LSTM_ONLY = 1

/** 縦書きの1ブロックとして読む。日本語の背表紙はこれが基本 */
const PSM_VERTICAL_BLOCK = '5'
/** 横組みの1ブロックとして読む。回転させたあとに使う */
const PSM_BLOCK = '6'

/** 欲しい出力だけ。hOCR や PDF を作らせると時間と記憶域の無駄になる */
const OUTPUT = { text: true, blocks: true }

/** これを満たせば読めたとみなし、回転して読み直さない */
const GOOD_CONFIDENCE = 0.6
const GOOD_LENGTH = 3

/**
 * 読む向きの試行順。
 *
 * 1周目は回さずに縦書きとして読む(和書)。駄目なら90度回して横組みで読む。
 * 洋書の背表紙は上から下へ読む向き(英米)と下から上へ読む向き(欧州)が
 * あり、どちらかは事前に判らないので両方試す。
 * ただし1周目で読めた本には2周目以降が走らないので、
 * 費用がかかるのは「そのままでは読めなかった本」だけである。
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

/** OCR の行を断片に直す。信頼度は 0..100 で返るので 0..1 に揃える */
function fragmentsOf(page: Page): OcrFragment[] {
  const out: OcrFragment[] = []
  for (const block of page.blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        const text = line.text?.trim()
        if (text) out.push({ text, confidence: Math.max(0, Math.min(1, line.confidence / 100)) })
      }
    }
  }
  return out
}

function toRecognition(page: Page, orientation: SpineRecognition['orientation']): SpineRecognition {
  const fragments = fragmentsOf(page)
  const rawText = (page.text ?? '').trim()
  if (!rawText && fragments.length === 0) return EMPTY_RECOGNITION
  return {
    rawText,
    fragments,
    confidence: Math.max(0, Math.min(1, (page.confidence ?? 0) / 100)),
    orientation,
  }
}

/** 読めたかどうか。短すぎる読みは、飾り罫や隣の本の端であることが多い */
function isGood(rec: SpineRecognition): boolean {
  return rec.confidence >= GOOD_CONFIDENCE && rec.rawText.replace(/\s/g, '').length >= GOOD_LENGTH
}

/** 向きの違う2つの結果から良い方を採る。長く読めた方を優先する */
function better(a: SpineRecognition, b: SpineRecognition): SpineRecognition {
  const weigh = (r: SpineRecognition) =>
    r.confidence * Math.min(1, r.rawText.replace(/\s/g, '').length / 8)
  return weigh(b) > weigh(a) ? b : a
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

    async recognize(image) {
      const w = await ensure()
      let best = EMPTY_RECOGNITION

      for (const pass of PASSES) {
        let target = image
        if (pass.rotate !== 0) {
          try {
            target = await rotateBlob(image, pass.rotate)
          } catch {
            // 回転できない環境では、その周は飛ばす
            continue
          }
        }

        await w.setParameters({ tessedit_pageseg_mode: pass.psm })
        const rec = toRecognition((await w.recognize(target, undefined, OUTPUT)).data, pass.orientation)
        best = better(best, rec)
        if (isGood(rec)) return rec
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
