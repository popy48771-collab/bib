/**
 * 段階実行パイプライン
 *
 * 各段階は独立して実行でき、以下の性質を満たす:
 *
 *  1. 冪等   … 同じ段階を再実行しても結果が壊れない
 *  2. 非破壊 … 後の段階は前の段階の候補を消さない(candidates に足すだけ)
 *  3. 隔離   … ある段階が失敗しても、他の段階の成果は残る
 *  4. 尊重   … 利用者が手で確定した項目(pinned)は自動処理で上書きしない
 *
 * この性質があるため「Google Books で一次照合 → 結果を見てから
 * ボタンで NDL と突合」という運用が安全に成立する。
 */
import { AUTO_CONFIRM_THRESHOLD, CANDIDATE_FLOOR, } from '../types';
import { matchScore } from '../lib/similarity';
import { normalizeForMatch } from '../lib/normalize';
import * as googleBooks from '../sources/googleBooks';
import * as ndl from '../sources/ndl';
import * as openbd from '../sources/openbd';
/**
 * フィールドを型を保ったまま代入する。
 * keyof でループしながら書き込むには総称型の助けが要る。
 */
function assignField(target, key, value) {
    target[key] = value;
}
/** 候補にスコアを付けて、閾値未満を捨て、降順に並べる */
export function scoreCandidates(entry, records) {
    const query = {
        title: entry.extracted.title || entry.rawText,
        authors: entry.extracted.authors,
        publisher: entry.extracted.publisher,
    };
    return records
        .map((record) => ({ record, score: matchScore(query, record) }))
        .filter((c) => c.score >= CANDIDATE_FLOOR)
        .sort((a, b) => b.score - a.score);
}
/** スコアから状態を決める */
export function statusFromScore(top) {
    if (!top)
        return 'notFound';
    return top.score >= AUTO_CONFIRM_THRESHOLD ? 'confirmed' : 'needsReview';
}
/**
 * 候補を採用して resolved / provenance を更新する。
 * pinned な項目には触れない。
 */
export function adoptCandidate(entry, candidate) {
    const r = candidate.record;
    const provenance = {};
    for (const key of Object.keys(r)) {
        if (r[key] !== undefined && r[key] !== '')
            provenance[key] = r.source;
    }
    return { ...entry, resolved: { ...r }, provenance };
}
// ───────────────────────────────────────────────────────────
// 段階 0: 抽出 (写真 → 背表紙テキスト)
// ───────────────────────────────────────────────────────────
/** 抽出結果から BookEntry を作る。この時点では未確認 */
export function entriesFromExtraction(photoId, spines, idPrefix) {
    return spines.map((s, i) => ({
        id: `${idPrefix}-${i}`,
        photoId,
        rawText: [s.title, ...s.authors, s.publisher ?? ''].filter(Boolean).join(' '),
        extracted: { title: s.title, authors: s.authors, publisher: s.publisher },
        extractConfidence: s.confidence,
        box: s.box,
        candidates: {},
        provenance: {},
        // 書誌DBで実在確認が取れるまでは確定させない(VLMの捏造対策)
        status: 'unverified',
        pinned: false,
    }));
}
/**
 * バーコードで読んだ ISBN から BookEntry を作る。
 *
 * ISBN は既に確実なので resolved に入れておく(出典は barcode)。
 * ただし書名はまだ判らないので status は unverified のまま。
 * 次段の Google Books 照合で書誌が埋まり、そこで確定する。
 */
export function entriesFromIsbns(isbns, idPrefix) {
    return isbns.map((isbn13, i) => ({
        id: `${idPrefix}-${i}`,
        photoId: idPrefix,
        rawText: isbn13,
        extracted: { title: '', authors: [] },
        candidates: {},
        resolved: { title: '', authors: [], isbn13, source: 'barcode' },
        provenance: { isbn13: 'barcode' },
        status: 'unverified',
        pinned: false,
    }));
}
/** レート制限対策。Google Books は IP 単位で絞られるため間隔を空ける */
function delay(ms, signal) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted)
            return reject(new DOMException('Aborted', 'AbortError'));
        const t = setTimeout(resolve, ms);
        signal?.addEventListener('abort', () => {
            clearTimeout(t);
            reject(new DOMException('Aborted', 'AbortError'));
        }, { once: true });
    });
}
const GOOGLE_BOOKS_INTERVAL_MS = 260;
/**
 * Google Books で一次照合する。
 * ここで確定したものが「一次確定」。NDL 突合はこの後の任意ステージ。
 */
export async function runGoogleBooksStage(entries, ctx) {
    const out = [];
    let done = 0;
    for (const entry of entries) {
        if (ctx.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        // 手動確定済み・除外済みは触らない
        if (entry.pinned || entry.status === 'excluded') {
            out.push(entry);
            done++;
            ctx.onProgress?.(done, entries.length);
            continue;
        }
        try {
            // ISBN が既に判っている(バーコード経路)なら ISBN で引く。
            // 完全一致なので、タイトル類似度による絞り込みは不要かつ有害
            const knownIsbn = entry.provenance.isbn13 === 'barcode' ? entry.resolved?.isbn13 : undefined;
            if (knownIsbn) {
                const records = await googleBooks.searchByIsbn(knownIsbn, {
                    country: ctx.settings.googleBooksCountry,
                    signal: ctx.signal,
                });
                out.push(mergeIsbnResult(entry, knownIsbn, scoreIsbnCandidates(knownIsbn, records)));
            }
            else {
                const records = await googleBooks.searchByTitle(entry.extracted.title || entry.rawText, entry.extracted.authors, { country: ctx.settings.googleBooksCountry, signal: ctx.signal });
                const scored = scoreCandidates(entry, records);
                const top = scored[0];
                let next = {
                    ...entry,
                    candidates: { ...entry.candidates, googleBooks: scored },
                    status: statusFromScore(top),
                };
                if (top)
                    next = { ...adoptCandidate(next, top), status: next.status };
                out.push(next);
            }
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError')
                throw err;
            // 1件の失敗で全体を止めない。未確認のまま残す
            out.push({ ...entry, status: entry.resolved ? entry.status : 'unverified' });
        }
        done++;
        ctx.onProgress?.(done, entries.length);
        if (done < entries.length)
            await delay(GOOGLE_BOOKS_INTERVAL_MS, ctx.signal);
    }
    return out;
}
/**
 * ISBN 検索の結果に点を付ける。
 * `isbn:` クエリの戻りはその ISBN の本そのものなので、類似度計算はしない。
 * ISBN が一致したものを最上位に置くだけ。
 */
export function scoreIsbnCandidates(isbn13, records) {
    return records
        .map((record) => ({ record, score: record.isbn13 === isbn13 ? 1 : 0.9 }))
        .sort((a, b) => b.score - a.score);
}
/**
 * ISBN 経路の結果を統合する。
 *
 * バーコードは誤読がほぼ無いので、書誌が引けた時点で確定してよい。
 * 背表紙OCR経路と違って人間のトリアージを挟まないのが、この経路の値打ち。
 */
export function mergeIsbnResult(entry, isbn13, scored) {
    const next = { ...entry, candidates: { ...entry.candidates, googleBooks: scored } };
    const top = scored[0];
    // ISBN は読めたが書誌DBに無い。ISBN は確かなので捨てず、未確認として残す
    if (!top)
        return { ...next, status: 'notFound' };
    const adopted = adoptCandidate(next, top);
    const resolved = { ...adopted.resolved };
    const provenance = { ...adopted.provenance };
    // Google Books のレコードは ISBN を持たないことがある。
    // バーコードで読んだ値の方が確実なので、欠けていれば埋め戻す
    if (!resolved.isbn13) {
        resolved.isbn13 = isbn13;
        provenance.isbn13 = 'barcode';
    }
    return { ...adopted, resolved, provenance, status: 'confirmed' };
}
// ───────────────────────────────────────────────────────────
// 段階 2: NDL 突合 (任意・ボタン起動)
// ───────────────────────────────────────────────────────────
/** 比較対象のフィールド。表記揺れが激しいものは入れない */
const COMPARED_FIELDS = ['title', 'authors', 'publisher', 'published', 'isbn13'];
function fieldToString(value) {
    if (Array.isArray(value))
        return value.join(', ');
    return value == null ? '' : String(value);
}
/**
 * 2つのレコードを比較し、実質的に異なるフィールドを列挙する。
 * 正規化して同一とみなせるものは差分として報告しない
 * (「夏目, 漱石」と「夏目漱石」を差分にすると人間の確認作業が無意味に増える)。
 */
export function diffRecords(a, b) {
    const conflicts = [];
    for (const field of COMPARED_FIELDS) {
        const av = fieldToString(a[field]);
        const bv = fieldToString(b[field]);
        if (!av || !bv)
            continue; // 片方に情報が無いのは「差分」ではなく「補完余地」
        if (field === 'isbn13') {
            // ISBN は正規化済みなので厳密比較。ここが食い違うなら別の版か別の本
            if (av !== bv) {
                conflicts.push({ field, values: [{ source: a.source, value: av }, { source: b.source, value: bv }] });
            }
            continue;
        }
        if (normalizeForMatch(av) !== normalizeForMatch(bv)) {
            conflicts.push({ field, values: [{ source: a.source, value: av }, { source: b.source, value: bv }] });
        }
    }
    return conflicts;
}
/**
 * NDL で突合する。
 *
 * 一次照合の結果を上書きせず、
 *  - NDL 側の候補を candidates.ndl に追加
 *  - 一次結果との差分を conflicts に記録
 *  - 一次照合で見つからなかった項目は、NDL でヒットすれば昇格させる
 *  - 一次結果に欠けているフィールド(ISBN等)は NDL の値で補完する
 * という振る舞いにする。
 */
export async function runNdlStage(entries, ctx) {
    if (!ndl.isNdlConfigured(ctx.settings.ndlProxyUrl)) {
        throw new ndl.NdlNotConfiguredError();
    }
    const out = [];
    let done = 0;
    for (const entry of entries) {
        if (ctx.signal?.aborted)
            throw new DOMException('Aborted', 'AbortError');
        if (entry.pinned || entry.status === 'excluded') {
            out.push(entry);
            done++;
            ctx.onProgress?.(done, entries.length);
            continue;
        }
        try {
            // ISBN が既に判っているならそれで引く方が確実
            const isbn = entry.resolved?.isbn13;
            const records = isbn
                ? await ndl.searchByIsbn(isbn, { proxyUrl: ctx.settings.ndlProxyUrl, signal: ctx.signal })
                : await ndl.searchByTitle(entry.extracted.title || entry.rawText, entry.extracted.authors, { proxyUrl: ctx.settings.ndlProxyUrl, signal: ctx.signal });
            const scored = scoreCandidates(entry, records);
            out.push(mergeNdlResult(entry, scored));
        }
        catch (err) {
            if (err instanceof DOMException && err.name === 'AbortError')
                throw err;
            if (err instanceof ndl.NdlNotConfiguredError)
                throw err;
            // 通信失敗は一次結果を壊さずに素通り
            out.push(entry);
        }
        done++;
        ctx.onProgress?.(done, entries.length);
    }
    return out;
}
/**
 * NDL の結果を既存エントリに統合する。純粋関数なのでテストしやすい。
 */
export function mergeNdlResult(entry, scored) {
    const next = { ...entry, candidates: { ...entry.candidates, ndl: scored } };
    const top = scored[0];
    if (!top) {
        // NDL で見つからなくても、一次結果は保持したまま
        return next;
    }
    // 一次照合で確定できていなかった → NDL の結果で昇格
    if (!entry.resolved || entry.status === 'notFound' || entry.status === 'unverified') {
        const adopted = adoptCandidate(next, top);
        return { ...adopted, status: statusFromScore(top) };
    }
    // 一次結果がある → 差分を記録し、欠けているフィールドだけ補完する
    const conflicts = diffRecords(entry.resolved, top.record);
    const resolved = { ...entry.resolved };
    const provenance = { ...entry.provenance };
    for (const field of Object.keys(top.record)) {
        if (field === 'source' || field === 'sourceUrl')
            continue;
        const current = resolved[field];
        const incoming = top.record[field];
        const isEmpty = current === undefined || current === '' || (Array.isArray(current) && current.length === 0);
        if (isEmpty && incoming !== undefined && incoming !== '') {
            assignField(resolved, field, incoming);
            provenance[field] = 'ndl';
        }
    }
    return {
        ...next,
        resolved,
        provenance,
        conflicts: conflicts.length > 0 ? conflicts : undefined,
        status: conflicts.length > 0 ? 'conflict' : entry.status,
    };
}
// ───────────────────────────────────────────────────────────
// 段階 3: openBD エンリッチ (任意・ボタン起動)
// ───────────────────────────────────────────────────────────
/**
 * ISBN が確定している項目に、書影・出版社・発売日・内容紹介を補う。
 * 照合は行わない(openBD はタイトル検索ができないため)。
 */
export async function runOpenBdStage(entries, ctx) {
    const isbns = entries
        .filter((e) => e.status !== 'excluded' && e.resolved?.isbn13)
        .map((e) => e.resolved.isbn13);
    if (isbns.length === 0)
        return entries;
    const byIsbn = await openbd.fetchByIsbns(isbns, ctx.signal);
    ctx.onProgress?.(entries.length, entries.length);
    return entries.map((entry) => {
        const isbn = entry.resolved?.isbn13;
        if (!isbn || entry.pinned)
            return entry;
        const found = byIsbn.get(isbn);
        if (!found)
            return entry;
        const resolved = { ...entry.resolved };
        const provenance = { ...entry.provenance };
        // 空欄のみ補完する。既存の値は上書きしない
        for (const field of ['publisher', 'published', 'series', 'coverUrl', 'description']) {
            const current = resolved[field];
            const incoming = found[field];
            if ((current === undefined || current === '') && incoming) {
                assignField(resolved, field, incoming);
                provenance[field] = 'openbd';
            }
        }
        return {
            ...entry,
            candidates: { ...entry.candidates, openbd: [{ record: found, score: 1 }] },
            resolved,
            provenance,
        };
    });
}
