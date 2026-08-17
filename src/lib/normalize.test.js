import { describe, expect, it } from 'vitest';
import { katakanaToHiragana, normalizeAuthor, normalizeForMatch, splitTitle, tidy } from './normalize';
describe('normalizeForMatch', () => {
    it('全角英数を半角に寄せる', () => {
        expect(normalizeForMatch('ＡＢＣ１２３')).toBe('abc123');
    });
    it('カタカナとひらがなを同一視する', () => {
        expect(normalizeForMatch('コンピュータ')).toBe(normalizeForMatch('こんぴゅーた'));
    });
    it('長音の有無を吸収する', () => {
        expect(normalizeForMatch('サーバー')).toBe(normalizeForMatch('サーバ'));
        expect(normalizeForMatch('コンピューター')).toBe(normalizeForMatch('コンピュータ'));
    });
    it('空白と約物を除去する', () => {
        expect(normalizeForMatch('吾輩は 猫である！')).toBe(normalizeForMatch('吾輩は猫である'));
        expect(normalizeForMatch('『ノルウェイの森』')).toBe(normalizeForMatch('ノルウェイの森'));
    });
    it('半角カナを全角に正規化してからひらがな化する', () => {
        expect(normalizeForMatch('ﾉﾙｳｪｲ')).toBe(normalizeForMatch('ノルウェイ'));
    });
    it('空文字を安全に扱う', () => {
        expect(normalizeForMatch('')).toBe('');
    });
});
describe('katakanaToHiragana', () => {
    it('濁音・半濁音・拗音を変換する', () => {
        expect(katakanaToHiragana('ガギグゲゴパピプペポャュョ')).toBe('がぎぐげごぱぴぷぺぽゃゅょ');
    });
    it('漢字と英字はそのまま', () => {
        expect(katakanaToHiragana('猫ABC')).toBe('猫ABC');
    });
});
describe('splitTitle', () => {
    it('末尾の巻次を分離する', () => {
        expect(splitTitle('吾輩は猫である 上')).toEqual({ main: '吾輩は猫である', volume: '上' });
    });
    it('第N巻を分離する', () => {
        expect(splitTitle('鋼の錬金術師 第3巻')).toEqual({ main: '鋼の錬金術師', volume: '3' });
    });
    it('コロン区切りの副題を分離する', () => {
        expect(splitTitle('リーダブルコード: より良いコードを書くために')).toEqual({
            main: 'リーダブルコード',
            sub: 'より良いコードを書くために',
            volume: undefined,
        });
    });
    it('区切りがなければ main のみ', () => {
        const r = splitTitle('ノルウェイの森');
        expect(r.main).toBe('ノルウェイの森');
        expect(r.sub).toBeUndefined();
        expect(r.volume).toBeUndefined();
    });
    it('短すぎる断片は副題として切らない', () => {
        // 「A:B」のような1文字ずつは副題扱いしない
        expect(splitTitle('A:B').main).toBe('A:B');
    });
});
describe('normalizeAuthor', () => {
    it('NDL形式とGoogle Books形式を同一視する', () => {
        expect(normalizeAuthor('夏目, 漱石')).toBe(normalizeAuthor('夏目漱石'));
    });
    it('全角スペース区切りを吸収する', () => {
        expect(normalizeAuthor('村上　春樹')).toBe(normalizeAuthor('村上春樹'));
    });
});
describe('tidy', () => {
    it('連続空白を畳んで前後を削る', () => {
        expect(tidy('  吾輩は   猫　である  ')).toBe('吾輩は 猫 である');
    });
});
