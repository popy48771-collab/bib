/**
 * 国立国会図書館サーチ (NDLサーチ) OpenSearch API クライアント
 *
 * ── 重要な制約 ──────────────────────────────────────────────
 * NDLサーチ API は CORS ヘッダを返さないため、ブラウザから直接 fetch できない。
 * GitHub Pages のような静的ホスティングだけでは完結しない。
 *
 * そこで本アプリでは NDL を「必須の依存」ではなく「任意の突合ステージ」として扱う。
 *  - 利用者が設定画面で CORS プロキシの URL を登録したときだけ有効になる
 *  - 未設定なら NDL ステージは無効表示のまま、他の機能はすべて動く
 *
 * ── 検証状況 ────────────────────────────────────────────────
 * 開発環境から NDL へのネットワーク到達が遮断されていたため、
 * 以下のレスポンス解析は公開仕様に基づく実装であり、実エンドポイントでの
 * 突き合わせ確認は未実施。名前空間接頭辞の有無や要素名の揺れに耐えるよう
 * 防御的に書いてあるが、初回接続時は必ず生レスポンスを確認すること。
 * (docs/CONCEPT.md「未検証の前提」参照)
 */
import { extractIsbn13 } from '../lib/isbn';
import { tidy } from '../lib/normalize';
const NDL_OPENSEARCH_PATH = 'https://ndlsearch.ndl.go.jp/api/opensearch';
export class NdlNotConfiguredError extends Error {
    constructor() {
        super('NDLサーチはブラウザから直接呼べません(CORS非対応)。設定画面でプロキシURLを登録してください。');
        this.name = 'NdlNotConfiguredError';
    }
}
/**
 * プロキシURLを組み立てる。
 * 2通りの書式を許容する:
 *   1. `https://proxy.example/?url=` … 末尾が `=` なら対象URLをエンコードして連結
 *   2. `https://proxy.example/`      … それ以外は対象URLをそのまま後ろに連結
 */
export function buildProxiedUrl(proxyUrl, targetUrl) {
    const p = proxyUrl.trim();
    if (!p)
        throw new NdlNotConfiguredError();
    if (p.endsWith('='))
        return p + encodeURIComponent(targetUrl);
    return p.replace(/\/+$/, '') + '/' + targetUrl;
}
/**
 * 名前空間接頭辞の有無に依存せず要素を取り出す。
 * DOMParser は text/xml だと名前空間解決が環境依存になりやすいので、
 * localName 一致で拾う実装にしておく。
 */
function childText(parent, localName) {
    for (const el of Array.from(parent.children)) {
        const ln = el.localName || el.nodeName.replace(/^.*:/, '');
        if (ln === localName) {
            const t = el.textContent?.trim();
            if (t)
                return t;
        }
    }
    return undefined;
}
function childTexts(parent, localName) {
    const out = [];
    for (const el of Array.from(parent.children)) {
        const ln = el.localName || el.nodeName.replace(/^.*:/, '');
        if (ln === localName) {
            const t = el.textContent?.trim();
            if (t)
                out.push(t);
        }
    }
    return out;
}
/**
 * item 要素から ISBN を取り出す。
 * NDL は dc:identifier に xsi:type="dcndl:ISBN" を付けて返すが、
 * 属性名の解決に失敗しても拾えるよう、値の形からも判定する。
 */
function extractIsbnFromItem(item) {
    const identifiers = [];
    for (const el of Array.from(item.children)) {
        const ln = el.localName || el.nodeName.replace(/^.*:/, '');
        if (ln !== 'identifier')
            continue;
        const raw = el.textContent?.trim();
        if (!raw)
            continue;
        const typeAttr = el.getAttribute('xsi:type') ?? el.getAttribute('type') ?? '';
        identifiers.push({ raw, typed: /ISBN/i.test(typeAttr) });
    }
    // 型属性で ISBN と明示されているものを優先
    for (const id of identifiers) {
        if (!id.typed)
            continue;
        const v = extractIsbn13(id.raw);
        if (v)
            return { isbn13: v, isbnRaw: id.raw };
    }
    // 属性が取れなかった場合は値の形で判定
    for (const id of identifiers) {
        const v = extractIsbn13(id.raw);
        if (v)
            return { isbn13: v, isbnRaw: id.raw };
    }
    return {};
}
/** OpenSearch(RSS) レスポンスXMLを解析する */
export function parseNdlResponse(xml) {
    const doc = new DOMParser().parseFromString(xml, 'application/xml');
    // パースエラー検出 (ブラウザは parsererror 要素を埋め込む)
    if (doc.getElementsByTagName('parsererror').length > 0) {
        throw new Error('NDLサーチのレスポンスXMLを解析できませんでした');
    }
    const items = Array.from(doc.getElementsByTagName('item'));
    const records = [];
    for (const item of items) {
        // dc:title を優先し、無ければ RSS の title を使う
        const title = childText(item, 'title');
        if (!title)
            continue;
        const { isbn13, isbnRaw } = extractIsbnFromItem(item);
        records.push({
            title: tidy(title),
            authors: childTexts(item, 'creator').map(tidy),
            publisher: childText(item, 'publisher'),
            published: childText(item, 'issued') ?? childText(item, 'date'),
            isbn13,
            isbnRaw,
            series: childText(item, 'seriesTitle'),
            source: 'ndl',
            sourceUrl: childText(item, 'link'),
        });
    }
    return records;
}
async function ndlRequest(params, opts) {
    if (!opts.proxyUrl?.trim())
        throw new NdlNotConfiguredError();
    const target = `${NDL_OPENSEARCH_PATH}?${params.toString()}`;
    const res = await fetch(buildProxiedUrl(opts.proxyUrl, target), { signal: opts.signal });
    if (!res.ok)
        throw new Error(`NDLサーチ APIエラー: ${res.status}`);
    return parseNdlResponse(await res.text());
}
/** タイトル(+著者)で検索 */
export async function searchByTitle(title, authors, opts) {
    const t = tidy(title);
    if (!t)
        return [];
    const p = new URLSearchParams({ title: t, cnt: String(opts.maxResults ?? 10) });
    if (authors[0])
        p.set('creator', tidy(authors[0]));
    const results = await ndlRequest(p, opts);
    if (results.length > 0 || !authors[0])
        return results;
    // 著者名の表記揺れで 0 件になることがあるため、タイトルのみで再試行
    const fallback = new URLSearchParams({ title: t, cnt: String(opts.maxResults ?? 10) });
    return ndlRequest(fallback, opts);
}
/** ISBN で引く */
export async function searchByIsbn(isbn, opts) {
    const v = extractIsbn13(isbn);
    if (!v)
        return [];
    return ndlRequest(new URLSearchParams({ isbn: v, cnt: '5' }), opts);
}
/** 設定済みかどうか。UI のボタン活性判定に使う */
export function isNdlConfigured(proxyUrl) {
    return !!proxyUrl?.trim();
}
