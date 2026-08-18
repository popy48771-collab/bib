/**
 * OCR の出力を「照合できる形」に均す
 *
 * 背表紙には書名・著者・出版社が同じ面に並んでいるだけで、どの行が何かは
 * 印刷の上に書いていない。OCR もそれを教えてくれない。
 * したがって「1行=書名」と決め打って検索すると、著者名や出版社名で
 * 書誌DBを引くことになり、まず当たらない。
 *
 * ここでは
 *  - 行を洗う(OCR が撒く記号と、日本語行に紛れ込む空白を落とす)
 *  - それらしい役割を当てる(出版社・著者は形で見当が付く)
 *  - 1冊につき複数の検索クエリへ展開する
 * までをやる。役割の推定は外れても構わない。外れた場合の受け皿として
 * 「全文で引く」クエリを必ず残してある。
 */

import type { ExtractedSpine, OcrFragment } from '../../types'
import { normalizeForMatch, tidy } from '../normalize'
import type { SpineRecognition } from './recognizer'

/** 日本語(漢字・かな)を含むか。書誌ソースの当てる順を決めるのに使う */
export function hasJapanese(text: string): boolean {
  return /[぀-ヿ㐀-䶿一-鿿]/.test(text)
}

/**
 * OCR が撒く記号を落とす。
 *
 * 残すのは 漢字・かな・ラテン文字・数字と、書名に実際に現れる約物だけ。
 * 罫線や箔押しの反射は「|」「_」「~」「+」といった文字として出てくることが多く、
 * これを残したまま検索すると 0 件になる。
 */
const KEEP =
  /[^぀-ヿ㐀-䶿一-鿿Ａ-Ｚａ-ｚ０-９A-Za-z0-9ー－・、。「」『』（）()〈〉《》【】〜~:：.,&＆'’!?！？\/+#\-\s]/g

/**
 * 1行を洗う。
 *
 * 日本語の行からは空白を全部落とす。日本語は分かち書きをしないので、
 * OCR が入れた空白はすべて誤りである。ラテン文字の行では語の区切りとして
 * 意味を持つので、連続空白を1つに畳むだけに留める。
 */
export function cleanLine(raw: string): string {
  // 半角カナや全角英数は先に畳む。Tesseract はどちらの形でも返してくる
  const stripped = raw.normalize('NFKC').replace(KEEP, ' ')
  // 前後に残った約物は落とす。「」で括られた書名をそのまま検索に出さないため
  const collapsed = tidy(stripped).replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
  if (!collapsed) return ''
  if (hasJapanese(collapsed)) {
    // 日本語の行に空白は無い。ラテン文字が混じる行では語間だけ残す
    return collapsed.replace(/\s+(?=[^\x20-\x7e])|(?<=[^\x20-\x7e])\s+/g, '')
  }
  return collapsed
}

/** 出版社らしい行か。書名として採ると必ず外すので、先に除ける */
const PUBLISHER_HINT =
  /(出版|書店|書房|新聞社|刊行会|大学出版|文庫|新書|選書|叢書|株式会社|[社舎堂閣]$|press|publish|books?$)/i

export function looksLikePublisher(line: string): boolean {
  const t = tidy(line)
  if (!t) return false
  // 長い行は書名である可能性の方が高い。出版社名がここまで長いことは稀
  if (t.length > 16) return false
  return PUBLISHER_HINT.test(t)
}

/**
 * 著者らしい行か。
 *
 * 日本語の人名は短く、助詞を含まない。役割表記(著・編・訳)が付いていれば
 * ほぼ確実である。欧文は「大文字で始まる語が2〜3個」を人名とみなす。
 */
export function looksLikeAuthor(line: string): boolean {
  const t = tidy(line)
  if (!t) return false
  if (/[／\/]?\s*(著|編著|編|訳|監修|共著)\s*$/.test(t)) return true

  if (hasJapanese(t)) {
    if (t.length < 2 || t.length > 12) return false
    // 助詞・活用語尾が入っていれば文であって人名ではない
    if (/[はがをにへとでもやのかなるれたい]{2}/.test(t)) return false
    return /^[㐀-䶿一-鿿゠-ヿ・\s]+$/.test(t)
  }
  return /^([A-Z][a-z.'-]+\s+){1,2}[A-Z][a-z.'-]+$/.test(t)
}

/** 役割表記を落として人名だけにする */
export function stripAuthorRole(line: string): string {
  return tidy(line.replace(/[／\/]?\s*(著|編著|編|訳|監修|共著)\s*$/, ''))
}

/**
 * 断片を洗って、使える行だけ残す。
 *
 * 1文字だけの断片は、背表紙の飾りや隣の本の端を拾ったものがほとんどなので落とす。
 * ただし全部落ちてしまう場合に備えて、呼び出し側は空配列を扱えるようにしておく。
 */
export function cleanFragments(fragments: readonly OcrFragment[]): OcrFragment[] {
  const out: OcrFragment[] = []
  for (const f of fragments) {
    const text = cleanLine(f.text)
    if (text.length < 2) continue
    out.push({ ...f, text })
  }
  return out
}

/**
 * 書名らしさ。信頼度が高く、長い行を上位に置く。
 * 背表紙で最も大きく刷られているのは書名なので、OCR も長く読める。
 */
function titleScore(f: OcrFragment): number {
  const lengthWeight = 0.4 + 0.6 * Math.min(1, f.text.length / 10)
  return f.confidence * lengthWeight
}

/**
 * 読み取り結果から ExtractedSpine を作る。
 * 使える行が1つも無ければ null(＝読めず)。
 */
export function spineFromRecognition(
  rec: SpineRecognition,
  engine: ExtractedSpine['engine'] = 'tesseract',
): ExtractedSpine | null {
  const fragments = cleanFragments(rec.fragments.length > 0 ? rec.fragments : fragmentsFromText(rec.rawText))
  if (fragments.length === 0) return null

  const publisherLine = fragments.find((f) => looksLikePublisher(f.text))
  const rest = fragments.filter((f) => f !== publisherLine)

  // 書名は「残りのうち最も書名らしい行」。著者候補も書名になりうるので、
  // ここでは著者らしさで除外しない(1行しか読めなかった場合に何も残らなくなる)
  const titleFragment = [...rest].sort((a, b) => titleScore(b) - titleScore(a))[0] ?? fragments[0]

  const authors = rest
    .filter((f) => f !== titleFragment && looksLikeAuthor(f.text))
    .map((f) => stripAuthorRole(f.text))
    .filter(Boolean)

  return {
    title: titleFragment.text,
    authors,
    publisher: publisherLine ? tidy(publisherLine.text) : undefined,
    confidence: rec.confidence,
    fragments,
    engine,
  }
}

/** 改行区切りのテキストを断片にする。手入力の修正と、行情報の無い OCR 用 */
export function fragmentsFromText(text: string, confidence = 1): OcrFragment[] {
  return text
    .split(/\r?\n/)
    .map((line) => tidy(line))
    .filter(Boolean)
    .map((line) => ({ text: line, confidence }))
}

/**
 * 背表紙1冊ぶんの生テキスト。読めた行を印刷どおりの並びで残す。
 *
 * 役割の推定(どれが書名でどれが著者か)は外れることがある。行の並びを
 * 保っておけば、照合側は複数のクエリへ展開し直せるし、利用者が
 * 読み取り文字を直すときも、背表紙と見比べられる形で出せる。
 */
export function spineRawText(spine: ExtractedSpine): string {
  if (spine.fragments?.length) return spine.fragments.map((f) => f.text).join('\n')
  return [spine.title, ...spine.authors, spine.publisher ?? ''].filter(Boolean).join(' ')
}

/** 利用者が手で直した文字列から作る。信頼度は満点だが、確定はさせない */
export function spineFromText(text: string): ExtractedSpine | null {
  return spineFromRecognition(
    { rawText: text, fragments: fragmentsFromText(text), confidence: 1, orientation: 'unknown' },
    'manual',
  )
}

// ───────────────────────────────────────────────────────────
// 検索クエリの組み立て
// ───────────────────────────────────────────────────────────

export interface SpineQuery {
  title: string
  authors: string[]
}

/**
 * 1冊ぶんの検索クエリを、当たりやすい順に組み立てる。
 *
 * 背表紙は「書名」「副題」「著者」「出版社」が別々の行に割れて出てくる。
 * 最有力行だけで引くと、副題が本題として刷られている本や、書名が2行に
 * 割れている本を取り逃がす。かといって全文で引くと出版社名がノイズになる。
 * どちらか一方に賭けず、精度の高い順に並べて上から試す。
 *
 *  1. 最有力行 + 著者          … 最も絞れる
 *  2. 最有力行と隣の行を連結    … 書名が2行に割れた場合の受け皿
 *  3. 出版社を除いた全行        … 役割の推定を外した場合の受け皿
 *  4. OCR 全文                  … 最後の総当たり
 *
 * 同じ文字列になったものは落とす。呼び出し側は上限件数で切ること。
 */
export function buildQueries(spine: ExtractedSpine): SpineQuery[] {
  const fragments = spine.fragments ?? []
  const lines = fragments.map((f) => f.text)
  const nonPublisher = fragments.filter((f) => !looksLikePublisher(f.text)).map((f) => f.text)

  const queries: SpineQuery[] = []
  const push = (title: string, authors: string[]) => {
    const t = tidy(title)
    if (t) queries.push({ title: t, authors })
  }

  push(spine.title, spine.authors)

  // 最有力行の隣。断片は読み取り順に並んでいるので、その前後を見る
  const at = lines.indexOf(spine.title)
  if (at >= 0) {
    const after = lines[at + 1]
    const before = lines[at - 1]
    if (after && !looksLikePublisher(after)) push(`${spine.title} ${after}`, [])
    else if (before && !looksLikePublisher(before)) push(`${before} ${spine.title}`, [])
  }

  if (nonPublisher.length > 1) push(nonPublisher.join(' '), [])
  if (lines.length > 1) push(lines.join(' '), [])

  const seen = new Set<string>()
  return queries.filter((q) => {
    const key = `${normalizeForMatch(q.title)}|${q.authors.map(normalizeForMatch).join(',')}`
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 照合に使う文字数。これが短すぎるものは当たっても確定させない */
export function queryLength(spine: { title: string; authors: string[] }): number {
  return normalizeForMatch(spine.title).length
}
