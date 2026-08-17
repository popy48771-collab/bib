import { describe, expect, it } from 'vitest';
import { buildProxiedUrl, isNdlConfigured, NdlNotConfiguredError, parseNdlResponse } from './ndl';
/**
 * NDLサーチ OpenSearch の想定レスポンス。
 * 実エンドポイントへの到達が遮断された環境で実装したため、
 * このフィクスチャは公開仕様に基づく再現であり、実レスポンスとの
 * 突き合わせは未実施(docs/CONCEPT.md「未検証の前提」参照)。
 * パーサは接頭辞の揺れに耐えるよう書いてあり、その耐性をここで検証する。
 */
const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"
     xmlns:dc="http://purl.org/dc/elements/1.1/"
     xmlns:dcterms="http://purl.org/dc/terms/"
     xmlns:dcndl="http://ndl.go.jp/dcndl/terms/"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <channel>
    <title>NDLサーチ 検索結果</title>
    <item>
      <title>吾輩は猫である</title>
      <link>https://ndlsearch.ndl.go.jp/books/R100000002-I000000000001</link>
      <dc:title>吾輩は猫である</dc:title>
      <dc:creator>夏目, 漱石</dc:creator>
      <dc:publisher>岩波書店</dc:publisher>
      <dcterms:issued xsi:type="dcterms:W3CDTF">2005-10</dcterms:issued>
      <dc:identifier xsi:type="dcndl:ISBN">978-4-00-310101-8</dc:identifier>
      <dcndl:seriesTitle>岩波文庫</dcndl:seriesTitle>
    </item>
    <item>
      <title>ノルウェイの森 上</title>
      <link>https://ndlsearch.ndl.go.jp/books/R100000002-I000000000002</link>
      <dc:title>ノルウェイの森 上</dc:title>
      <dc:creator>村上, 春樹</dc:creator>
      <dc:creator>だれか, ほか</dc:creator>
      <dc:publisher>講談社</dc:publisher>
      <dcterms:issued>2004-09</dcterms:issued>
      <dc:identifier xsi:type="dcndl:NDLBibID">000007412345</dc:identifier>
      <dc:identifier xsi:type="dcndl:ISBN">4-06-274866-5</dc:identifier>
    </item>
  </channel>
</rss>`;
describe('parseNdlResponse', () => {
    const records = parseNdlResponse(SAMPLE);
    it('item をすべて取り出す', () => {
        expect(records).toHaveLength(2);
    });
    it('タイトル・出版社・出版年を取り出す', () => {
        expect(records[0].title).toBe('吾輩は猫である');
        expect(records[0].publisher).toBe('岩波書店');
        expect(records[0].published).toBe('2005-10');
    });
    it('複数の dc:creator を配列で取り出す', () => {
        expect(records[1].authors).toEqual(['村上, 春樹', 'だれか, ほか']);
    });
    it('ISBNをISBN-13に正規化する', () => {
        expect(records[0].isbn13).toBe('9784003101018');
    });
    it('ISBN-10表記もISBN-13に変換する', () => {
        expect(records[1].isbn13).toBe('9784062748667');
    });
    it('ISBN以外のidentifier(NDLBibID)をISBNとして誤採用しない', () => {
        // 000007412345 は12桁でISBNではない。ISBN側が選ばれること
        expect(records[1].isbn13).not.toBe('000007412345');
    });
    it('シリーズ名を取り出す', () => {
        expect(records[0].series).toBe('岩波文庫');
    });
    it('出典を ndl として記録する', () => {
        expect(records.every((r) => r.source === 'ndl')).toBe(true);
    });
    it('item が無ければ空配列', () => {
        const empty = `<?xml version="1.0"?><rss version="2.0"><channel><title>x</title></channel></rss>`;
        expect(parseNdlResponse(empty)).toEqual([]);
    });
    it('名前空間接頭辞が無くても解析できる', () => {
        const noPrefix = `<?xml version="1.0"?><rss><channel><item>
      <title>素のタイトル</title>
      <creator>著者名</creator>
      <identifier>ISBN978-4-00-310101-8</identifier>
    </item></channel></rss>`;
        const r = parseNdlResponse(noPrefix);
        expect(r[0].title).toBe('素のタイトル');
        expect(r[0].authors).toEqual(['著者名']);
        expect(r[0].isbn13).toBe('9784003101018');
    });
    it('壊れたXMLはエラーにする(黙って空を返さない)', () => {
        expect(() => parseNdlResponse('<rss><channel><item>')).toThrow();
    });
});
describe('buildProxiedUrl', () => {
    const target = 'https://ndlsearch.ndl.go.jp/api/opensearch?title=%E7%8C%AB';
    it('末尾が = のプロキシにはURLエンコードして連結する', () => {
        expect(buildProxiedUrl('https://proxy.example/?url=', target)).toBe('https://proxy.example/?url=' + encodeURIComponent(target));
    });
    it('パス連結型のプロキシにはそのまま繋げる', () => {
        expect(buildProxiedUrl('https://proxy.example/', target)).toBe('https://proxy.example/' + target);
    });
    it('末尾スラッシュの重複を避ける', () => {
        expect(buildProxiedUrl('https://proxy.example///', target)).toBe('https://proxy.example/' + target);
    });
    it('未設定なら専用エラーを投げる', () => {
        expect(() => buildProxiedUrl('', target)).toThrow(NdlNotConfiguredError);
        expect(() => buildProxiedUrl('   ', target)).toThrow(NdlNotConfiguredError);
    });
});
describe('isNdlConfigured', () => {
    it('未設定・空白のみは false', () => {
        expect(isNdlConfigured(undefined)).toBe(false);
        expect(isNdlConfigured('')).toBe(false);
        expect(isNdlConfigured('  ')).toBe(false);
    });
    it('URLがあれば true', () => {
        expect(isNdlConfigured('https://proxy.example/?url=')).toBe(true);
    });
});
