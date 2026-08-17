import { describe, expect, it } from 'vitest';
import { authorSimilarity, diceCoefficient, levenshtein, levenshteinRatio, matchScore, ngrams, titleSimilarity, } from './similarity';
import { normalizeForMatch } from './normalize';
describe('levenshtein', () => {
    it('同一文字列は0', () => {
        expect(levenshtein('猫である', '猫である')).toBe(0);
    });
    it('1文字置換は1', () => {
        expect(levenshtein('猫である', '犬である')).toBe(1);
    });
    it('空文字は相手の長さ', () => {
        expect(levenshtein('', 'abc')).toBe(3);
        expect(levenshtein('abc', '')).toBe(3);
    });
    it('引数の順序に依存しない', () => {
        expect(levenshtein('kitten', 'sitting')).toBe(levenshtein('sitting', 'kitten'));
        expect(levenshtein('kitten', 'sitting')).toBe(3);
    });
});
describe('levenshteinRatio', () => {
    it('同一なら1', () => {
        expect(levenshteinRatio('abc', 'abc')).toBe(1);
    });
    it('両方空なら1', () => {
        expect(levenshteinRatio('', '')).toBe(1);
    });
});
describe('ngrams', () => {
    it('bigramを作る', () => {
        expect(ngrams('あいう', 2)).toEqual(['あい', 'いう']);
    });
    it('n未満の文字列は全体を1要素で返す', () => {
        expect(ngrams('あ', 2)).toEqual(['あ']);
    });
    it('空文字は空配列', () => {
        expect(ngrams('', 2)).toEqual([]);
    });
});
describe('diceCoefficient', () => {
    it('同一文字列は1', () => {
        expect(diceCoefficient('ノルウェイの森', 'ノルウェイの森')).toBe(1);
    });
    it('無関係な文字列は低い', () => {
        expect(diceCoefficient('ノルウェイの森', '吾輩は猫である')).toBeLessThan(0.2);
    });
    it('繰り返し文字を多重集合として扱う(過大評価しない)', () => {
        // 'ああああ' と 'ああ' が完全一致にならないこと
        expect(diceCoefficient('ああああ', 'ああ')).toBeLessThan(1);
    });
});
describe('titleSimilarity', () => {
    it('完全一致は1', () => {
        expect(titleSimilarity('吾輩は猫である', '吾輩は猫である')).toBe(1);
    });
    it('表記揺れを吸収する', () => {
        expect(titleSimilarity('ノルウェイの森', 'ノルウェイの森 ')).toBe(1);
        expect(titleSimilarity('サーバー構築', 'サーバ構築')).toBe(1);
    });
    it('OCRの1文字誤りでも高いスコアを保つ', () => {
        // 「猫」→「description的に近い字」への誤読を想定
        const s = titleSimilarity('吾輩は猫である', '吾輩は描である');
        expect(s).toBeGreaterThan(0.7);
    });
    it('部分的にしか読めなくても拾える(包含ボーナス)', () => {
        const s = titleSimilarity('ノルウェイ', 'ノルウェイの森');
        expect(s).toBeGreaterThan(0.6);
    });
    it('別の本は低いスコアになる', () => {
        expect(titleSimilarity('吾輩は猫である', 'ノルウェイの森')).toBeLessThan(0.3);
    });
    it('巻次違いは本題が同じなら高い', () => {
        expect(titleSimilarity('鋼の錬金術師 第3巻', '鋼の錬金術師')).toBeGreaterThan(0.9);
    });
    it('空文字は0', () => {
        expect(titleSimilarity('', '吾輩は猫である')).toBe(0);
    });
});
describe('authorSimilarity', () => {
    it('NDL形式とGoogle Books形式を一致とみなす', () => {
        expect(authorSimilarity(['夏目, 漱石'], ['夏目漱石'])).toBe(1);
    });
    it('どちらかが空なら中立値', () => {
        expect(authorSimilarity([], ['夏目漱石'])).toBe(0.5);
    });
    it('別人は低い', () => {
        expect(authorSimilarity(['夏目漱石'], ['村上春樹'])).toBeLessThan(0.4);
    });
    it('複数著者のうち1人が一致すれば拾う', () => {
        expect(authorSimilarity(['村上春樹'], ['村上春樹', '佐藤某'])).toBe(1);
    });
});
describe('matchScore', () => {
    const target = { title: '吾輩は猫である', authors: ['夏目漱石'], publisher: '岩波書店' };
    it('タイトル・著者とも一致すれば非常に高い', () => {
        expect(matchScore({ title: '吾輩は猫である', authors: ['夏目, 漱石'] }, target)).toBeGreaterThan(0.95);
    });
    it('タイトルが違えば著者が合っていても低い', () => {
        const s = matchScore({ title: 'ノルウェイの森', authors: ['夏目漱石'] }, target);
        expect(s).toBeLessThan(0.3);
    });
    it('著者不明でもタイトル一致なら実用的なスコアが出る', () => {
        expect(matchScore({ title: '吾輩は猫である', authors: [] }, target)).toBeGreaterThan(0.8);
    });
    it('出版社一致は過度に効かない(0.05以内の加点)', () => {
        const withPub = matchScore({ title: '吾輩は猫である', authors: ['夏目漱石'], publisher: '岩波書店' }, target);
        const withoutPub = matchScore({ title: '吾輩は猫である', authors: ['夏目漱石'] }, target);
        expect(withPub - withoutPub).toBeLessThanOrEqual(0.05 + 1e-9);
    });
    it('スコアは常に0..1に収まる', () => {
        const cases = [
            { title: '', authors: [] },
            { title: 'あ', authors: ['あ'] },
            { title: '吾輩は猫である'.repeat(10), authors: [] },
        ];
        for (const c of cases) {
            const s = matchScore(c, target);
            expect(s).toBeGreaterThanOrEqual(0);
            expect(s).toBeLessThanOrEqual(1);
        }
    });
});
describe('正規化と類似度の結合', () => {
    it('正規化キーが一致するものは類似度1になる', () => {
        const a = 'コンピューター・サイエンス';
        const b = 'コンピュータサイエンス';
        expect(normalizeForMatch(a)).toBe(normalizeForMatch(b));
        expect(titleSimilarity(a, b)).toBe(1);
    });
});
