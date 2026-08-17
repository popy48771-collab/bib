import { jsx as _jsx, jsxs as _jsxs, Fragment as _Fragment } from "react/jsx-runtime";
import { formatIsbn13 } from '../lib/isbn';
const STATUS_LABEL = {
    confirmed: '確定',
    needsReview: '要確認',
    conflict: '差分あり',
    notFound: '見つからず',
    unverified: '未確認',
    excluded: '除外',
};
const SOURCE_LABEL = {
    vlm: '読み取り',
    ocr: 'OCR',
    manual: '手入力',
    googleBooks: 'Google Books',
    ndl: 'NDL',
    openbd: 'openBD',
    barcode: 'バーコード',
};
const FIELD_LABEL = {
    title: 'タイトル',
    authors: '著者',
    publisher: '出版社',
    published: '出版年',
    isbn13: 'ISBN',
};
/** 全候補をソース混在でスコア順に並べる */
function allCandidates(entry) {
    return Object.values(entry.candidates)
        .flat()
        .filter((c) => !!c)
        .sort((a, b) => b.score - a.score)
        .slice(0, 5);
}
function BookRow({ entry, onAdopt, onExclude, onRestore }) {
    const r = entry.resolved;
    const candidates = allCandidates(entry);
    // 確定済みのものは候補を畳んでおく。人間が触るべきものだけを目立たせる
    const showCandidates = entry.status !== 'confirmed' && entry.status !== 'excluded' && candidates.length > 0;
    return (_jsxs("li", { className: "book", "data-status": entry.status, children: [_jsxs("h3", { children: [(r?.title ?? entry.extracted.title) || '(タイトル不明)', ' ', _jsx("span", { className: "source-tag", children: STATUS_LABEL[entry.status] })] }), _jsx("p", { className: "meta", children: [
                    r?.authors?.join(', ') || entry.extracted.authors.join(', '),
                    r?.publisher,
                    r?.published,
                    r?.isbn13 ? `ISBN ${formatIsbn13(r.isbn13)}` : '',
                ]
                    .filter(Boolean)
                    .join(' / ') || '書誌情報なし' }), !r && entry.rawText && _jsxs("p", { className: "raw", children: ["\u8AAD\u307F\u53D6\u308A: ", entry.rawText] }), entry.conflicts && entry.conflicts.length > 0 && (_jsxs("div", { className: "conflicts", children: [_jsx("strong", { children: "\u30BD\u30FC\u30B9\u9593\u3067\u98DF\u3044\u9055\u3044\u304C\u3042\u308A\u307E\u3059" }), _jsx("dl", { children: entry.conflicts.map((c) => (_jsxs("div", { style: { display: 'contents' }, children: [_jsx("dt", { children: FIELD_LABEL[c.field] ?? c.field }), _jsx("dd", { children: c.values.map((v) => `${SOURCE_LABEL[v.source]}: ${v.value}`).join(' ／ ') })] }, c.field))) })] })), showCandidates && (_jsx("div", { className: "candidates", children: candidates.map((c, i) => (_jsxs("button", { className: "candidate", onClick: () => onAdopt(entry.id, c), children: [_jsxs("span", { className: "score", children: [Math.round(c.score * 100), "%"] }), _jsxs("span", { style: { flex: 1, minWidth: 0 }, children: [c.record.title, c.record.authors.length > 0 && ` — ${c.record.authors.join(', ')}`] }), _jsx("span", { className: "source-tag", children: SOURCE_LABEL[c.record.source] })] }, `${c.record.source}-${i}`))) })), _jsxs("div", { className: "book-actions", children: [entry.status === 'excluded' ? (_jsx("button", { onClick: () => onRestore(entry.id), children: "\u5143\u306B\u623B\u3059" })) : (_jsx("button", { onClick: () => onExclude(entry.id), children: "\u9664\u5916" })), entry.pinned && _jsx("span", { className: "source-tag", children: "\u624B\u52D5\u78BA\u5B9A" })] })] }));
}
export function BookList({ entries, onAdopt, onExclude, onRestore }) {
    if (entries.length === 0) {
        return _jsx("p", { className: "hint", children: "\u307E\u3060\u672C\u304C\u3042\u308A\u307E\u305B\u3093\u3002\u5199\u771F\u3092\u53D6\u308A\u8FBC\u3093\u3067\u8AAD\u307F\u53D6\u308A\u3092\u5B9F\u884C\u3057\u3066\u304F\u3060\u3055\u3044\u3002" });
    }
    const counts = entries.reduce((acc, e) => {
        acc[e.status] = (acc[e.status] ?? 0) + 1;
        return acc;
    }, {});
    return (_jsxs(_Fragment, { children: [_jsxs("div", { className: "summary", children: [_jsxs("span", { className: "chip", children: ["\u5168 ", entries.length, " \u518A"] }), counts.confirmed && (_jsxs("span", { className: "chip", "data-tone": "ok", children: ["\u78BA\u5B9A ", counts.confirmed] })), counts.needsReview && (_jsxs("span", { className: "chip", "data-tone": "warn", children: ["\u8981\u78BA\u8A8D ", counts.needsReview] })), counts.conflict && _jsxs("span", { className: "chip", children: ["\u5DEE\u5206\u3042\u308A ", counts.conflict] }), (counts.notFound || counts.unverified) && (_jsxs("span", { className: "chip", "data-tone": "danger", children: ["\u672A\u78BA\u8A8D ", (counts.notFound ?? 0) + (counts.unverified ?? 0)] })), counts.excluded && _jsxs("span", { className: "chip", children: ["\u9664\u5916 ", counts.excluded] })] }), _jsx("ul", { className: "book-list", children: entries.map((e) => (_jsx(BookRow, { entry: e, onAdopt: onAdopt, onExclude: onExclude, onRestore: onRestore }, e.id))) })] }));
}
