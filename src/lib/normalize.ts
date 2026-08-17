/**
 * 日本語書誌タイトルの正規化
 *
 * OCR/VLM の出力は必ず汚れている。素の文字列比較では照合できないので、
 * 「表記の揺れ」を潰してから比較する。
 *
 * 潰す対象:
 *  - 全角/半角 (NFKC)
 *  - ひらがな/カタカナ
 *  - 濁点・半濁点の合成/分解
 *  - 長音・ダッシュ・ハイフン類
 *  - 空白・記号
 *  - 巻次や副題の区切り
 */

/**
 * 長音・ダッシュ・ハイフンとして扱う文字。OCR が取り違えやすいので全部潰す。
 * 範囲指定はコードポイント順を誤りやすいため、意図を明示して列挙する。
 */
const DASH_LIKE =
  /[-~‐-―−ー゠－～〜]/g

/**
 * 除去する記号・約物。ASCII記号・CJK約物・全角記号をまとめて落とす。
 *
 * 注意: 中黒 ・ (U+30FB) はカタカナブロックにあり CJK約物の範囲 (U+3001-U+303F) に
 * 入らない。半角中黒 ･ (U+FF65) は NFKC で U+30FB に畳まれるため、
 * U+30FB を明示的に含めないと「コンピュータ・サイエンス」が正規化しきれない。
 */
const PUNCT =
  /[\s　!-/:-@[-`{-~、-〿・゠！-＠［-｀｛-･‘’“”]/g

/** カタカナ → ひらがな */
export function katakanaToHiragana(s: string): string {
  return s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
}

/** ひらがな → カタカナ */
export function hiraganaToKatakana(s: string): string {
  return s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60))
}

/**
 * 照合用の正規化キーを作る。
 * 情報を大きく捨てるので、表示には使わないこと。
 */
export function normalizeForMatch(input: string): string {
  if (!input) return ''
  let s = input.normalize('NFKC')
  s = s.toLowerCase()
  // 長音・ダッシュ類はすべて除去する。「サーバ」と「サーバー」を同一視するため
  s = s.replace(DASH_LIKE, '')
  s = katakanaToHiragana(s)
  s = s.replace(PUNCT, '')
  // NFKC 後も残る濁点の分解表記を合成に寄せる
  s = s.normalize('NFC')
  return s
}

/**
 * 表示用の軽い整形。情報は捨てない。
 * 前後の空白と、連続空白の畳み込みのみ。
 */
export function tidy(input: string): string {
  return input.replace(/[\s　]+/g, ' ').trim()
}

/**
 * タイトルから副題・巻次を切り離す。
 * 「吾輩は猫である 上」「魔女の宅急便 その1」「Foo: Bar」など。
 *
 * 書誌DBは巻次をタイトルに含めたり別フィールドに持ったりと一貫しないので、
 * 照合時は本題だけで当てて、巻次は別途突き合わせる。
 */
export function splitTitle(title: string): { main: string; sub?: string; volume?: string } {
  const t = tidy(title)

  // 巻次らしき末尾表現
  const volPatterns = [
    /[\s　]*[（(]?(?:第)?\s*([0-9０-９一二三四五六七八九十百]+)\s*(?:巻|集|部|冊)[)）]?$/,
    /[\s　]+([上中下前後続新旧])$/,
    /[\s　]*(?:vol\.?|no\.?)\s*([0-9０-９]+)$/i,
  ]
  let main = t
  let volume: string | undefined
  for (const re of volPatterns) {
    const m = main.match(re)
    if (m) {
      volume = m[1]
      main = main.slice(0, m.index).trim()
      break
    }
  }

  // 副題の区切り
  const subMatch = main.match(/^(.+?)[\s　]*[:：\-—―~〜][\s　]*(.+)$/)
  if (subMatch && subMatch[1].length >= 2 && subMatch[2].length >= 2) {
    return { main: subMatch[1].trim(), sub: subMatch[2].trim(), volume }
  }
  return { main, volume }
}

/**
 * 著者名の正規化。
 * NDL は「夏目, 漱石」形式、Google Books は「夏目漱石」形式を返すため、
 * 区切りを除去して比較できるようにする。
 */
export function normalizeAuthor(name: string): string {
  return normalizeForMatch(name.replace(/[,，、]/g, ''))
}
