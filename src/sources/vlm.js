/**
 * 背表紙抽出 (BYOK)
 *
 * 本棚の写真をそのままマルチモーダルモデルに渡し、
 * 「写っている本のタイトル・著者」を構造化JSONで受け取る。
 * 背表紙の切り出し・回転補正・OCR・表記正規化をモデルが一度に処理するため、
 * 古典的な CV + OCR パイプラインより実装が軽く精度も高い。
 *
 * ── 鍵の扱い ──────────────────────────────────────────────
 * GitHub Pages は静的ホスティングで秘密を持てないため、
 * 利用者自身の APIキーを localStorage に保存してブラウザから直接呼ぶ (BYOK)。
 * キーはこのアプリのサーバ(存在しない)には送られない。
 *
 * ── 捏造対策 ──────────────────────────────────────────────
 * モデルは「それらしいが存在しない本」を出力しうる。
 * ここでの出力は最終結果ではなく「照合クエリ」として扱い、
 * 書誌DBで実在確認が取れたものだけを確定させる (pipeline/stages.ts)。
 */
import Anthropic from '@anthropic-ai/sdk';
import { encodeForVlm } from '../lib/image';
import { tidy } from '../lib/normalize';
/** 構造化出力のスキーマ。実在確認前の「読み取り結果」であることを明示する */
const SPINE_SCHEMA = {
    type: 'object',
    properties: {
        books: {
            type: 'array',
            description: '写真に写っている本。背表紙1本につき1要素。',
            items: {
                type: 'object',
                properties: {
                    title: { type: 'string', description: '背表紙から読み取れたタイトル。読めた部分のみ。' },
                    authors: {
                        type: 'array',
                        items: { type: 'string' },
                        description: '著者名。読み取れない場合は空配列。',
                    },
                    publisher: { type: 'string', description: '出版社・レーベル。読み取れない場合は空文字。' },
                    confidence: {
                        type: 'number',
                        description: '読み取りの確信度。0.0(推測)〜1.0(明瞭に読めた)。',
                    },
                },
                required: ['title', 'authors', 'publisher', 'confidence'],
                additionalProperties: false,
            },
        },
    },
    required: ['books'],
    additionalProperties: false,
};
const SYSTEM_PROMPT = `あなたは本棚の写真から背表紙を読み取る専門家です。

写真に写っているすべての本について、背表紙に書かれたタイトル・著者・出版社を読み取ってください。

読み取りの原則:
- 背表紙は縦書きが多く、90度回転しています。回転を考慮して読んでください。
- 実際に写真に写っている文字だけを報告してください。
- 一部しか読めない場合は、読めた部分だけを報告し confidence を下げてください。
- 装丁やレーベルの見た目から書名を推測して補完してはいけません。読めないものは読めないまま報告します。
- 写真に存在しない本を出力してはいけません。これは検索用の読み取り結果であり、
  後段で書誌データベースと照合されます。推測で埋めると誤った本が混入します。
- 判読できない背表紙は、その旨がわかるよう title に読めた断片のみを入れ confidence を 0.2 以下にしてください。
- 左から右(または上から下)の並び順で報告してください。
- 同じ本が複数冊並んでいる場合は、それぞれ別の要素として報告してください。`;
export class VlmNotConfiguredError extends Error {
    constructor() {
        super('APIキーが未設定です。設定画面で登録するか、キー不要の抽出方式を選んでください。');
        this.name = 'VlmNotConfiguredError';
    }
}
/** 出力を内部形式に整える。空タイトルや破損した要素は落とす */
function normalizeExtracted(raw) {
    const books = raw?.books;
    if (!Array.isArray(books))
        return [];
    const out = [];
    for (const b of books) {
        if (!b || typeof b !== 'object')
            continue;
        const rec = b;
        const title = typeof rec.title === 'string' ? tidy(rec.title) : '';
        if (!title)
            continue;
        const authors = Array.isArray(rec.authors)
            ? rec.authors.filter((a) => typeof a === 'string').map(tidy).filter(Boolean)
            : [];
        const publisher = typeof rec.publisher === 'string' ? tidy(rec.publisher) : '';
        const confidence = typeof rec.confidence === 'number' && Number.isFinite(rec.confidence)
            ? Math.min(1, Math.max(0, rec.confidence))
            : 0.5;
        out.push({ title, authors, publisher: publisher || undefined, confidence });
    }
    return out;
}
const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5';
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash';
async function extractWithAnthropic(image, settings, signal) {
    const client = new Anthropic({
        apiKey: settings.vlmApiKey,
        // BYOK 構成では利用者自身のキーをブラウザから直接使う。
        // 公式にサポートされた経路で、キーは第三者のサーバを経由しない。
        dangerouslyAllowBrowser: true,
    });
    const response = await client.messages.create({
        model: settings.vlmModel || DEFAULT_ANTHROPIC_MODEL,
        max_tokens: 16000,
        system: SYSTEM_PROMPT,
        // 知覚タスクであり深い推論は不要。効率重視で effort を下げる
        output_config: {
            effort: 'low',
            format: { type: 'json_schema', schema: SPINE_SCHEMA },
        },
        messages: [
            {
                role: 'user',
                content: [
                    {
                        type: 'image',
                        source: { type: 'base64', media_type: image.mediaType, data: image.base64 },
                    },
                    { type: 'text', text: 'この本棚の写真から、背表紙の書誌情報を読み取ってください。' },
                ],
            },
        ],
    }, { signal });
    if (response.stop_reason === 'refusal') {
        throw new Error('モデルがこの画像の処理を拒否しました。別の写真を試してください。');
    }
    const textBlock = response.content.find((b) => b.type === 'text');
    if (!textBlock || textBlock.type !== 'text') {
        throw new Error('モデルから読み取り結果が返りませんでした。');
    }
    try {
        return normalizeExtracted(JSON.parse(textBlock.text));
    }
    catch {
        throw new Error('読み取り結果を解析できませんでした。');
    }
}
async function extractWithGemini(image, settings, signal) {
    const model = settings.vlmModel || DEFAULT_GEMINI_MODEL;
    // 公式JS SDKは独自ヘッダを付けるためブラウザのpreflightで弾かれる報告がある。
    // 生の fetch + ?key= なら余計なヘッダが乗らない。
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(settings.vlmApiKey)}`;
    const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal,
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
            contents: [
                {
                    role: 'user',
                    parts: [
                        { inlineData: { mimeType: image.mediaType, data: image.base64 } },
                        { text: 'この本棚の写真から、背表紙の書誌情報を読み取ってください。' },
                    ],
                },
            ],
            generationConfig: {
                responseMimeType: 'application/json',
                responseSchema: SPINE_SCHEMA,
            },
        }),
    });
    if (!res.ok) {
        throw new Error(`画像認識APIエラー: ${res.status}`);
    }
    const json = (await res.json());
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('');
    if (!text)
        throw new Error('モデルから読み取り結果が返りませんでした。');
    try {
        return normalizeExtracted(JSON.parse(text));
    }
    catch {
        throw new Error('読み取り結果を解析できませんでした。');
    }
}
/** 写真1枚から背表紙を抽出する */
export async function extractSpines(photo, settings, signal) {
    if (settings.vlmProvider === 'none' || !settings.vlmApiKey.trim()) {
        throw new VlmNotConfiguredError();
    }
    const image = await encodeForVlm(photo);
    return settings.vlmProvider === 'anthropic'
        ? extractWithAnthropic(image, settings, signal)
        : extractWithGemini(image, settings, signal);
}
/** 設定済みかどうか。UI のボタン活性判定に使う */
export function isVlmConfigured(settings) {
    return settings.vlmProvider !== 'none' && settings.vlmApiKey.trim().length > 0;
}
export { normalizeExtracted as __normalizeExtractedForTest };
