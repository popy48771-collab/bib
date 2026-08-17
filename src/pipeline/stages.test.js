import { describe, expect, it } from 'vitest';
import { adoptCandidate, diffRecords, mergeNdlResult, scoreCandidates, statusFromScore } from './stages';
import { AUTO_CONFIRM_THRESHOLD } from '../types';
function makeEntry(over = {}) {
    return {
        id: 'e1',
        photoId: 'p1',
        rawText: '吾輩は猫である 夏目漱石',
        extracted: { title: '吾輩は猫である', authors: ['夏目漱石'] },
        candidates: {},
        provenance: {},
        status: 'unverified',
        pinned: false,
        ...over,
    };
}
const gbRecord = {
    title: '吾輩は猫である',
    authors: ['夏目漱石'],
    publisher: '岩波書店',
    isbn13: '9784003101018',
    source: 'googleBooks',
};
const ndlRecord = {
    title: '吾輩は猫である',
    authors: ['夏目, 漱石'],
    publisher: '岩波書店',
    published: '2005-10',
    isbn13: '9784003101018',
    series: '岩波文庫',
    source: 'ndl',
};
describe('scoreCandidates', () => {
    it('スコア降順に並べる', () => {
        const entry = makeEntry();
        const scored = scoreCandidates(entry, [
            { title: 'ノルウェイの森', authors: ['村上春樹'], source: 'googleBooks' },
            gbRecord,
        ]);
        expect(scored[0].record.title).toBe('吾輩は猫である');
    });
    it('無関係な候補は閾値で切り捨てる', () => {
        const scored = scoreCandidates(makeEntry(), [
            { title: '全く関係のない書名XYZ', authors: ['誰か'], source: 'googleBooks' },
        ]);
        expect(scored).toHaveLength(0);
    });
    it('タイトルが空なら rawText で照合する', () => {
        const entry = makeEntry({ extracted: { title: '', authors: [] } });
        const scored = scoreCandidates(entry, [gbRecord]);
        expect(scored.length).toBeGreaterThan(0);
    });
});
describe('statusFromScore', () => {
    it('候補なしは notFound', () => {
        expect(statusFromScore(undefined)).toBe('notFound');
    });
    it('高スコアは自動確定', () => {
        expect(statusFromScore({ record: gbRecord, score: 0.95 })).toBe('confirmed');
    });
    it('閾値ちょうどは確定', () => {
        expect(statusFromScore({ record: gbRecord, score: AUTO_CONFIRM_THRESHOLD })).toBe('confirmed');
    });
    it('低スコアは人間の確認へ回す', () => {
        expect(statusFromScore({ record: gbRecord, score: 0.5 })).toBe('needsReview');
    });
});
describe('adoptCandidate', () => {
    it('resolved を設定し provenance に出典を記録する', () => {
        const e = adoptCandidate(makeEntry(), { record: gbRecord, score: 0.9 });
        expect(e.resolved?.title).toBe('吾輩は猫である');
        expect(e.provenance.title).toBe('googleBooks');
        expect(e.provenance.isbn13).toBe('googleBooks');
    });
    it('値が無いフィールドは provenance に載せない', () => {
        const e = adoptCandidate(makeEntry(), { record: gbRecord, score: 0.9 });
        expect(e.provenance.series).toBeUndefined();
    });
});
describe('diffRecords', () => {
    it('表記揺れだけなら差分にしない', () => {
        // 「夏目漱石」と「夏目, 漱石」は同一とみなす
        expect(diffRecords(gbRecord, ndlRecord)).toEqual([]);
    });
    it('片方にしか値が無いものは差分にしない(補完余地であって矛盾ではない)', () => {
        const conflicts = diffRecords(gbRecord, ndlRecord);
        expect(conflicts.find((c) => c.field === 'published')).toBeUndefined();
    });
    it('実質的に違うタイトルは差分として報告する', () => {
        const other = { ...ndlRecord, title: 'ノルウェイの森' };
        const conflicts = diffRecords(gbRecord, other);
        expect(conflicts.some((c) => c.field === 'title')).toBe(true);
    });
    it('ISBN不一致は差分として報告する(別の版の可能性)', () => {
        const other = { ...ndlRecord, isbn13: '9784062748667' };
        const conflicts = diffRecords(gbRecord, other);
        const isbnConflict = conflicts.find((c) => c.field === 'isbn13');
        expect(isbnConflict).toBeDefined();
        expect(isbnConflict?.values.map((v) => v.source)).toEqual(['googleBooks', 'ndl']);
    });
});
describe('mergeNdlResult — 非破壊性', () => {
    const base = adoptCandidate(makeEntry({ status: 'confirmed' }), { record: gbRecord, score: 0.95 });
    it('Google Books の候補を消さない', () => {
        const withGb = { ...base, candidates: { googleBooks: [{ record: gbRecord, score: 0.95 }] } };
        const merged = mergeNdlResult(withGb, [{ record: ndlRecord, score: 0.93 }]);
        expect(merged.candidates.googleBooks).toHaveLength(1);
        expect(merged.candidates.ndl).toHaveLength(1);
    });
    it('NDLが0件でも一次結果を保持する', () => {
        const merged = mergeNdlResult(base, []);
        expect(merged.resolved?.title).toBe('吾輩は猫である');
        expect(merged.status).toBe('confirmed');
    });
    it('一次結果に無いフィールドをNDLで補完し、出典を記録する', () => {
        const merged = mergeNdlResult(base, [{ record: ndlRecord, score: 0.93 }]);
        expect(merged.resolved?.published).toBe('2005-10');
        expect(merged.provenance.published).toBe('ndl');
        expect(merged.resolved?.series).toBe('岩波文庫');
    });
    it('既にある値をNDLで上書きしない', () => {
        const merged = mergeNdlResult(base, [{ record: { ...ndlRecord, publisher: '別の出版社' }, score: 0.9 }]);
        expect(merged.resolved?.publisher).toBe('岩波書店');
        expect(merged.provenance.publisher).toBe('googleBooks');
    });
    it('食い違いがあれば conflict 状態にして差分を残す', () => {
        const conflicting = { ...ndlRecord, isbn13: '9784062748667' };
        const merged = mergeNdlResult(base, [{ record: conflicting, score: 0.9 }]);
        expect(merged.status).toBe('conflict');
        expect(merged.conflicts?.length).toBeGreaterThan(0);
    });
    it('一次照合で見つからなかったものはNDLの結果で昇格する', () => {
        const notFound = makeEntry({ status: 'notFound' });
        const merged = mergeNdlResult(notFound, [{ record: ndlRecord, score: 0.95 }]);
        expect(merged.status).toBe('confirmed');
        expect(merged.resolved?.source).toBe('ndl');
        expect(merged.provenance.title).toBe('ndl');
    });
    it('低スコアでの昇格は確認待ちに留める', () => {
        const notFound = makeEntry({ status: 'notFound' });
        const merged = mergeNdlResult(notFound, [{ record: ndlRecord, score: 0.5 }]);
        expect(merged.status).toBe('needsReview');
    });
    it('冪等: 同じ結果を2回統合しても壊れない', () => {
        const scored = [{ record: ndlRecord, score: 0.93 }];
        const once = mergeNdlResult(base, scored);
        const twice = mergeNdlResult(once, scored);
        expect(twice.resolved).toEqual(once.resolved);
        expect(twice.status).toBe(once.status);
        expect(twice.candidates.ndl).toHaveLength(1);
    });
    it('元のエントリを変更しない(純粋関数)', () => {
        const snapshot = JSON.parse(JSON.stringify(base));
        mergeNdlResult(base, [{ record: ndlRecord, score: 0.93 }]);
        expect(JSON.parse(JSON.stringify(base))).toEqual(snapshot);
    });
});
