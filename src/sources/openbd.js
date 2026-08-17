/**
 * openBD クライアント
 *
 * ISBN 引きのみで、タイトル検索はできない。したがって「照合」には使えず、
 * ISBN が確定したあとの情報補完(書影・出版社・発売日・内容紹介)専用。
 *
 * ブラウザからの利用を前提に設計されており、複数 ISBN のまとめ取得ができる。
 */
import { toIsbn13 } from '../lib/isbn';
import { tidy } from '../lib/normalize';
const ENDPOINT = 'https://api.openbd.jp/v1/get';
/** openBD の pubdate は "20051001" や "2005-10" など揺れる。YYYY-MM に寄せる */
function normalizePubdate(pubdate) {
    if (!pubdate)
        return undefined;
    const d = pubdate.replace(/[^\d]/g, '');
    if (d.length >= 6)
        return `${d.slice(0, 4)}-${d.slice(4, 6)}`;
    if (d.length >= 4)
        return d.slice(0, 4);
    return undefined;
}
/** summary.author は "夏目漱石／著" のような表記。区切って著者名だけ取る */
function parseAuthors(author) {
    if (!author)
        return [];
    return author
        .split(/[,，、;；]/)
        .map((a) => a.replace(/[／/]\s*(著|編|訳|監修|画|作|絵|原作|校訂).*$/, ''))
        .map(tidy)
        .filter(Boolean);
}
function toBibRecord(item) {
    const s = item.summary;
    if (!s?.title)
        return null;
    const description = item.onix?.CollateralDetail?.TextContent?.find((t) => t.Text && t.Text.trim().length > 0)?.Text;
    return {
        title: tidy(s.title),
        authors: parseAuthors(s.author),
        publisher: s.publisher ? tidy(s.publisher) : undefined,
        published: normalizePubdate(s.pubdate),
        isbn13: toIsbn13(s.isbn) ?? undefined,
        isbnRaw: s.isbn,
        series: s.series ? tidy(s.series) : undefined,
        coverUrl: s.cover || undefined,
        description: description?.trim(),
        source: 'openbd',
    };
}
/**
 * 複数 ISBN をまとめて引く。
 * openBD は見つからない ISBN に対して配列内 null を返し、順序は要求順を保つ。
 * 戻り値は ISBN-13 をキーにした Map。
 */
export async function fetchByIsbns(isbns, signal) {
    const valid = [...new Set(isbns.map((i) => toIsbn13(i)).filter((i) => !!i))];
    const out = new Map();
    if (valid.length === 0)
        return out;
    // URL 長を抑えるため分割して投げる
    const CHUNK = 50;
    for (let i = 0; i < valid.length; i += CHUNK) {
        const chunk = valid.slice(i, i + CHUNK);
        const res = await fetch(`${ENDPOINT}?isbn=${chunk.join(',')}`, { signal });
        if (!res.ok)
            throw new Error(`openBD APIエラー: ${res.status}`);
        const json = (await res.json());
        json.forEach((item, idx) => {
            if (!item)
                return;
            const rec = toBibRecord(item);
            if (!rec)
                return;
            // summary.isbn が欠けている場合に備えて要求時の ISBN をキーに使う
            out.set(rec.isbn13 ?? chunk[idx], rec);
        });
    }
    return out;
}
