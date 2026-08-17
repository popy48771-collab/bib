import { describe, expect, it } from 'vitest';
import { isIsbnBarcode, pickIsbn13 } from './barcode';
/**
 * 日本の書籍バーコードは2段組で、下段(192...)は分類・価格コードであって
 * 書籍のIDではない。しかも下段も EAN-13 なのでチェックディジットは正しく通る。
 * 「チェックディジットが合うから ISBN だろう」という判定では下段を拾ってしまい、
 * 存在しない書誌を引くことになる。ここはプレフィックスで弾く必要がある。
 */
describe('isIsbnBarcode', () => {
    it('978 で始まる正しい ISBN-13 を受理する', () => {
        expect(isIsbnBarcode('9784873115658')).toBe(true);
        expect(isIsbnBarcode('9784101010014')).toBe(true);
        expect(isIsbnBarcode('9780306406157')).toBe(true);
    });
    it('979 で始まるものも受理する', () => {
        expect(isIsbnBarcode('9798602401820')).toBe(true);
    });
    it('日本の2段バーコード下段(192...)を拒否する', () => {
        // チェックディジット自体は EAN-13 として正しいが ISBN ではない
        expect(isIsbnBarcode('1923000012004')).toBe(false);
        expect(isIsbnBarcode('1920079003001')).toBe(false);
    });
    it('チェックディジットが合わないものを拒否する', () => {
        expect(isIsbnBarcode('9784873115659')).toBe(false);
        expect(isIsbnBarcode('9784101010015')).toBe(false);
    });
    it('桁数が違うものを拒否する', () => {
        expect(isIsbnBarcode('978487311565')).toBe(false);
        expect(isIsbnBarcode('97848731156580')).toBe(false);
        expect(isIsbnBarcode('4873115655')).toBe(false); // ISBN-10 はバーコードには出ない
        expect(isIsbnBarcode('')).toBe(false);
    });
    it('数字以外が混ざるものを拒否する', () => {
        expect(isIsbnBarcode('97848731156X8')).toBe(false);
        expect(isIsbnBarcode('abcdefghijklm')).toBe(false);
    });
    it('ハイフン・空白は無視して判定する', () => {
        expect(isIsbnBarcode('978-4-87311-565-8')).toBe(true);
        expect(isIsbnBarcode('978 4 87311 565 8')).toBe(true);
    });
});
describe('pickIsbn13', () => {
    it('候補が無ければ null', () => {
        expect(pickIsbn13([])).toBeNull();
        expect(pickIsbn13(['1923000012004'])).toBeNull();
    });
    it('2段が同時に読めても上段(ISBN)を選ぶ', () => {
        expect(pickIsbn13(['1923000012004', '9784873115658'])).toBe('9784873115658');
        // 読み取り順が逆でも結果は変わらない
        expect(pickIsbn13(['9784873115658', '1923000012004'])).toBe('9784873115658');
    });
    it('ハイフン付きで返ってきても正規化して返す', () => {
        expect(pickIsbn13(['978-4-87311-565-8'])).toBe('9784873115658');
    });
    it('無効なコードを読み飛ばして有効なものを拾う', () => {
        expect(pickIsbn13(['xxxx', '', '9784873115659', '9784101010014'])).toBe('9784101010014');
    });
});
