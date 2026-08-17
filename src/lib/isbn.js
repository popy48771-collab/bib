/**
 * ISBN の正規化・検証・変換
 *
 * ISBN は複数ソースを突き合わせる際の「唯一の確実な鍵」なので、
 * 必ず ISBN-13 に揃えて保持する。
 */
/** ハイフン・空白を除去し大文字化 */
export function stripIsbn(raw) {
    return raw.replace(/[\s-‐−―ー]/g, '').toUpperCase();
}
/** ISBN-10 のチェックディジットを計算し 1文字で返す ('X' もありうる) */
function isbn10CheckDigit(first9) {
    let sum = 0;
    for (let i = 0; i < 9; i++)
        sum += (10 - i) * Number(first9[i]);
    const r = (11 - (sum % 11)) % 11;
    return r === 10 ? 'X' : String(r);
}
/** ISBN-13 のチェックディジットを計算 */
function isbn13CheckDigit(first12) {
    let sum = 0;
    for (let i = 0; i < 12; i++)
        sum += Number(first12[i]) * (i % 2 === 0 ? 1 : 3);
    return String((10 - (sum % 10)) % 10);
}
export function isValidIsbn10(s) {
    const v = stripIsbn(s);
    if (!/^\d{9}[\dX]$/.test(v))
        return false;
    return isbn10CheckDigit(v.slice(0, 9)) === v[9];
}
export function isValidIsbn13(s) {
    const v = stripIsbn(s);
    if (!/^\d{13}$/.test(v))
        return false;
    return isbn13CheckDigit(v.slice(0, 12)) === v[12];
}
/** ISBN-10 → ISBN-13 (978 プレフィックス) */
export function isbn10To13(s) {
    const v = stripIsbn(s);
    if (!isValidIsbn10(v))
        return null;
    const body = '978' + v.slice(0, 9);
    return body + isbn13CheckDigit(body);
}
/**
 * 任意の ISBN 表記を ISBN-13 に正規化する。
 * 不正な値・チェックディジット不一致は null（誤ったISBNで別の本を引かないため）。
 */
export function toIsbn13(raw) {
    if (!raw)
        return null;
    const v = stripIsbn(raw);
    if (isValidIsbn13(v))
        return v;
    if (isValidIsbn10(v))
        return isbn10To13(v);
    return null;
}
/**
 * 文字列中から ISBN らしき並びを拾って正規化する。
 * NDL の dc:identifier のように「ISBN978-4-...」等の混じった表記に対応。
 */
export function extractIsbn13(text) {
    if (!text)
        return null;
    const compact = stripIsbn(text);
    // 13桁優先。978/979 で始まるものを探す
    for (const m of compact.matchAll(/(97[89]\d{10})/g)) {
        const v = toIsbn13(m[1]);
        if (v)
            return v;
    }
    for (const m of compact.matchAll(/(\d{9}[\dX])/g)) {
        const v = toIsbn13(m[1]);
        if (v)
            return v;
    }
    return null;
}
/**
 * 表示用の ISBN 文字列。
 *
 * 正しいハイフン区切り(978-4-00-310101-8 等)は出版者記号の桁数が
 * 登録グループごとに異なるため、ISBN登録範囲表がないと決められない。
 * 桁数を推測して区切ると「見た目は正しいが誤ったISBN」を出力してしまうので、
 * ここではハイフンを打たず13桁のまま返す。
 * (範囲表を同梱する場合はこの関数だけ差し替えればよい)
 */
export function formatIsbn13(isbn13) {
    const v = stripIsbn(isbn13);
    return /^\d{13}$/.test(v) ? v : isbn13;
}
