/**
 * Gemini による棚全体の背表紙読み取り。
 *
 * 端末内 OCR と違い、棚一段の画像を分割せずに一度だけ渡す。Gemini は
 * 背表紙の領域、見えている文字、書名・著者・出版社の候補を構造化 JSON で
 * 返す。ここで得た値はまだ「書誌」ではなく検索の手掛かりにすぎない。
 * 実在確認と確定は従来どおり NDL / openBD / Google Books が担う。
 *
 * API キーは GitHub Actions の Secret から Vite のビルド変数へ渡される。
 * 静的サイトなので、ソースへ直書きしなくても配信後の JavaScript からキーを
 * 見ることはできる。Google Cloud 側で API と利用量を必ず制限すること。
 */

import type { BoundingBox, ExtractedSpine, OcrFragment } from '../../types'
import {
  SpineRecognizerUnavailableError,
  type ImageSize,
  type SpineRecognition,
  type SpineRecognizer,
} from './recognizer'

const INTERACTIONS_URL = 'https://generativelanguage.googleapis.com/v1beta/interactions'
const DEFAULT_MODEL = 'gemini-3.7-flash'
const REQUEST_TIMEOUT_MS = 30_000

const API_KEY = String(import.meta.env.VITE_GEMINI_API_KEY ?? '').trim()
export const GEMINI_MODEL =
  String(import.meta.env.VITE_GEMINI_MODEL ?? '').trim() || DEFAULT_MODEL

/** 棚全体の解析に使う指示。推測した書誌と、写真から読めた文字を混ぜさせない。 */
const PROMPT = `この画像は本棚の一段です。物理的な背表紙を1冊ずつ検出し、左から右の順で返してください。

守ること:
- 写真に実際に見えている文字だけを転記する。一般知識から書名、著者、出版社、ISBN、版を補わない。
- 縦書き、横書き、90度回転した欧文を、それぞれ自然な読み順へ直す。
- 読めない1文字は ? にする。ほとんど読めない背表紙や、本ではない領域は返さない。
- raw_visible_text は見えた行を改行区切りで残す。
- title、authors、publisher は背表紙上で役割を判断できる範囲だけ。著者不明なら authors は空配列、出版社不明なら publisher は空文字。
- box_2d は [y_min, x_min, y_max, x_max]、各値は画像全体を0〜1000とした座標。
- confidence は、領域検出ではなく文字と役割の読み取りに対する0〜1の確信度。
- 同じ背表紙を複数件に分けない。隣り合う複数冊を1件にまとめない。`

/** Gemini Structured Outputs に渡す JSON Schema。 */
const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    spines: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          box_2d: {
            type: 'array',
            items: { type: 'number' },
            minItems: 4,
            maxItems: 4,
          },
          raw_visible_text: { type: 'string' },
          title: { type: 'string' },
          authors: { type: 'array', items: { type: 'string' } },
          publisher: { type: 'string' },
          confidence: { type: 'number' },
        },
        required: [
          'box_2d',
          'raw_visible_text',
          'title',
          'authors',
          'publisher',
          'confidence',
        ],
        additionalProperties: false,
      },
    },
  },
  required: ['spines'],
  additionalProperties: false,
} as const

interface GeminiSpinePayload {
  box_2d?: unknown
  raw_visible_text?: unknown
  title?: unknown
  authors?: unknown
  publisher?: unknown
  confidence?: unknown
}

interface GeminiPayload {
  spines?: unknown
}

interface InteractionContent {
  type?: unknown
  text?: unknown
}

interface InteractionStep {
  type?: unknown
  content?: unknown
}

interface InteractionResponse {
  status?: unknown
  steps?: unknown
}

function clamp(value: number, min = 0, max = 1): number {
  return Math.min(max, Math.max(min, value))
}

function nonEmptyString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** [yMin, xMin, yMax, xMax] (0..1000) をアプリの相対座標へ直す。 */
function toBox(value: unknown): BoundingBox | null {
  if (!Array.isArray(value) || value.length !== 4) return null
  const numbers = value.map(Number)
  if (numbers.some((n) => !Number.isFinite(n))) return null

  const [rawTop, rawLeft, rawBottom, rawRight] = numbers
  const top = clamp(rawTop, 0, 1000) / 1000
  const left = clamp(rawLeft, 0, 1000) / 1000
  const bottom = clamp(rawBottom, 0, 1000) / 1000
  const right = clamp(rawRight, 0, 1000) / 1000
  if (right <= left || bottom <= top) return null

  return { x: left, y: top, width: right - left, height: bottom - top }
}

function fragmentsOf(
  raw: string,
  title: string,
  authors: string[],
  publisher: string,
  confidence: number,
  box: BoundingBox,
): OcrFragment[] {
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const fallback = [title, ...authors, publisher].filter(Boolean)
  return (lines.length > 0 ? lines : fallback).map((text) => ({ text, confidence, box }))
}

/**
 * Gemini が返した JSON をアプリの入力へ変換する。
 *
 * 外部応答なので、Schema を使っていても実行時検査は省かない。不正な1件だけを
 * 落とし、残りの背表紙は利用できるようにする。
 */
export function extractedSpinesFromGemini(value: unknown): ExtractedSpine[] {
  if (!value || typeof value !== 'object') return []
  const payload = value as GeminiPayload
  if (!Array.isArray(payload.spines)) return []

  const spines: ExtractedSpine[] = []
  for (const item of payload.spines) {
    if (!item || typeof item !== 'object') continue
    const spine = item as GeminiSpinePayload
    const box = toBox(spine.box_2d)
    if (!box) continue

    const raw = nonEmptyString(spine.raw_visible_text)
    const title = nonEmptyString(spine.title)
    const authors = Array.isArray(spine.authors)
      ? spine.authors.map(nonEmptyString).filter(Boolean)
      : []
    const publisher = nonEmptyString(spine.publisher)
    const confidence = clamp(Number(spine.confidence) || 0)

    // 書名が空でも、生テキストがあれば書誌照合の手掛かりとして残す。
    const fallbackTitle =
      raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? ''
    const resolvedTitle = title || fallbackTitle
    if (!resolvedTitle) continue

    spines.push({
      title: resolvedTitle,
      authors,
      publisher: publisher || undefined,
      confidence,
      box,
      fragments: fragmentsOf(raw, resolvedTitle, authors, publisher, confidence, box),
      engine: 'remoteVision',
    })
  }

  return spines.sort((a, b) => (a.box?.x ?? 0) - (b.box?.x ?? 0))
}

/** REST 応答の model_output ステップから Structured Output の本文を取り出す。 */
export function interactionOutputText(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null
  const response = value as InteractionResponse
  if (!Array.isArray(response.steps)) return null

  for (const rawStep of response.steps) {
    if (!rawStep || typeof rawStep !== 'object') continue
    const step = rawStep as InteractionStep
    if (step.type !== 'model_output' || !Array.isArray(step.content)) continue
    for (const rawContent of step.content) {
      if (!rawContent || typeof rawContent !== 'object') continue
      const content = rawContent as InteractionContent
      if (content.type === 'text' && typeof content.text === 'string') return content.text
    }
  }
  return null
}

async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer())
  // spread で一度に渡すと高解像度画像で call stack を使い切るので、小分けにする。
  let binary = ''
  const chunkSize = 0x8000
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize))
  }
  return btoa(binary)
}

async function errorDetail(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: unknown } }
    const message = body.error?.message
    return typeof message === 'string' ? message : ''
  } catch {
    return ''
  }
}

export class GeminiRecognizerError extends SpineRecognizerUnavailableError {
  readonly status?: number

  constructor(message: string, status?: number) {
    super(message)
    this.name = 'GeminiRecognizerError'
    this.status = status
  }
}

export function hasGeminiApiKey(): boolean {
  return API_KEY.length > 0
}

async function recognizeWithGemini(image: Blob, _size: ImageSize): Promise<SpineRecognition> {
  if (!API_KEY) {
    throw new GeminiRecognizerError(
      'Gemini API キーが設定されていないため、端末内の文字読み取りへ切り替えます。',
    )
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const data = await blobToBase64(image)
    const response = await fetch(INTERACTIONS_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': API_KEY,
      },
      body: JSON.stringify({
        model: GEMINI_MODEL,
        store: false,
        input: [
          { type: 'text', text: PROMPT },
          { type: 'image', data, mime_type: image.type || 'image/jpeg' },
        ],
        response_format: {
          type: 'text',
          mime_type: 'application/json',
          schema: RESPONSE_SCHEMA,
        },
        generation_config: {
          thinking_level: 'low',
          max_output_tokens: 8192,
        },
      }),
      signal: controller.signal,
    })

    if (!response.ok) {
      const detail = await errorDetail(response)
      throw new GeminiRecognizerError(
        `Gemini の読み取りに失敗しました（HTTP ${response.status}${detail ? `: ${detail}` : ''}）。`,
        response.status,
      )
    }

    const interaction = (await response.json()) as unknown
    const text = interactionOutputText(interaction)
    if (!text) throw new GeminiRecognizerError('Gemini から読み取り結果が返りませんでした。')

    let payload: unknown
    try {
      payload = JSON.parse(text)
    } catch {
      throw new GeminiRecognizerError('Gemini の読み取り結果を解釈できませんでした。')
    }
    const extracted = extractedSpinesFromGemini(payload)
    const confidence =
      extracted.reduce((sum, spine) => sum + spine.confidence, 0) / Math.max(1, extracted.length)
    return {
      columns: [],
      extracted,
      confidence,
      orientation: 'unknown',
    }
  } catch (err) {
    if (err instanceof GeminiRecognizerError) throw err
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new GeminiRecognizerError('Gemini の応答が30秒以内に返りませんでした。')
    }
    throw new GeminiRecognizerError(
      `Gemini に接続できませんでした${err instanceof Error ? `（${err.message}）` : '。'}`,
    )
  } finally {
    clearTimeout(timeout)
  }
}

export function createGeminiRecognizer(): SpineRecognizer {
  let disposed = false

  const ensure = () => {
    if (disposed) throw new SpineRecognizerUnavailableError('読み取りは終了しています。')
    if (!API_KEY) {
      throw new GeminiRecognizerError(
        'Gemini API キーが設定されていないため、端末内の文字読み取りへ切り替えます。',
      )
    }
  }

  return {
    strategy: 'wholeFrame',

    async prepare() {
      ensure()
    },

    async recognize(image, size) {
      ensure()
      return recognizeWithGemini(image, size)
    },

    async recognizeColumn(image, size) {
      ensure()
      return recognizeWithGemini(image, size)
    },

    async dispose() {
      disposed = true
    },
  }
}
