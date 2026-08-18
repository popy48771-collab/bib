/**
 * OCR の出力を「照合できる形」に均す
 *
 * 1枚のコマには棚一段ぶんの背表紙が写っている。読み取り機構はそれを縦の列
 * (SpineColumn) に分けて返してくるので、ここでは
 *
 *  1. 列を「書名・著者・出版社」の塊へ切り分ける（文字の縦の空きで切る）
 *  2. 塊を洗う（OCR が撒く記号と、日本語行に紛れ込む空白を落とす）
 *  3. それらしい役割を当てる（出版社・著者は形で見当が付く）
 *  4. 1冊につき複数の検索クエリへ展開する
 *
 * をやる。役割の推定は外れても構わない。外れた場合の受け皿として
 * 「全文で引く」クエリと「末尾を削った前方一致」を必ず残してある。
 */

import type { ExtractedSpine, OcrFragment } from '../../types'
import { normalizeForMatch, tidy } from '../normalize'
import type { SpineColumn, SpineRecognition } from './recognizer'

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

// ───────────────────────────────────────────────────────────
// 列を塊へ切り分ける
// ───────────────────────────────────────────────────────────

/** 縦の空きがこの倍率を超えたら、別の塊とみなす */
const GAP_RATIO = 2
/** 空きが小さすぎるときの下限。文字の高さに対する割合 */
const MIN_GAP_RATIO = 0.35

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/**
 * 1本の列を、書名・著者・出版社といった塊へ切り分ける。
 *
 * 背表紙では、書名と著者のあいだに文字何個ぶんかの空きがある。OCR は
 * 列全体を1行として返してくる（「思考の整理学外山滋比古ちくま文庫」）ので、
 * このままでは書名で引けない。語の位置を見て、大きな空きで切る。
 *
 * 語の枠は重なって返ってくることがあるため、走査済みの下端を持ち回って
 * 「重なり＝空きなし」として扱う。切れなかった場合は列全体で1つの塊になる
 * （その場合は末尾を削った前方一致の検索が受け皿になる）。
 */
export function splitColumn(words: readonly OcrFragment[]): OcrFragment[] {
  const placed = words.filter((w) => w.box)
  if (placed.length < 2) {
    const text = words.map((w) => w.text).join('')
    if (!text) return []
    const confidence = words.reduce((a, w) => a + w.confidence, 0) / Math.max(1, words.length)
    return [{ text, confidence, box: words[0]?.box }]
  }

  const sorted = [...placed].sort((a, b) => a.box!.y - b.box!.y)
  const gaps: number[] = []
  let bottom = sorted[0].box!.y + sorted[0].box!.height
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i].box!.y - bottom
    if (gap > 0) gaps.push(gap)
    bottom = Math.max(bottom, sorted[i].box!.y + sorted[i].box!.height)
  }
  const heights = sorted.map((w) => w.box!.height)
  const threshold = Math.max(median(gaps) * GAP_RATIO, median(heights) * MIN_GAP_RATIO)

  const chunks: OcrFragment[][] = [[sorted[0]]]
  bottom = sorted[0].box!.y + sorted[0].box!.height
  for (let i = 1; i < sorted.length; i++) {
    const w = sorted[i]
    if (w.box!.y - bottom > threshold) chunks.push([w])
    else chunks[chunks.length - 1].push(w)
    bottom = Math.max(bottom, w.box!.y + w.box!.height)
  }

  return chunks.map((chunk) => {
    const top = Math.min(...chunk.map((w) => w.box!.y))
    const bot = Math.max(...chunk.map((w) => w.box!.y + w.box!.height))
    const left = Math.min(...chunk.map((w) => w.box!.x))
    const right = Math.max(...chunk.map((w) => w.box!.x + w.box!.width))
    return {
      text: chunk.map((w) => w.text).join(''),
      confidence: chunk.reduce((a, w) => a + w.confidence, 0) / chunk.length,
      box: { x: left, y: top, width: right - left, height: bot - top },
    }
  })
}

/**
 * 書名らしさ。
 *
 *  - 背表紙で最も大きく刷られているのは書名なので、OCR も長く読める
 *  - そして**日本語の背表紙では、書名は上に刷られている**。著者はその下、
 *    出版社は一番下。長さだけで選ぶと、著者名が書名より長い本
 *    （「罪と罰 中」/「ドストエフスキー」）で必ず外す
 *
 * 塊は読み順（上から下）に並んでいるので、位置は添字で足りる。
 */
function titleScore(f: OcrFragment, index: number): number {
  const lengthWeight = 0.4 + 0.6 * Math.min(1, f.text.length / 10)
  const positionWeight = 1 / (1 + index * 0.6)
  return f.confidence * lengthWeight * positionWeight
}

/** 塊の並びから1冊ぶんを組み立てる。使える塊が無ければ null */
function spineFromFragments(
  fragments: OcrFragment[],
  confidence: number,
  engine: ExtractedSpine['engine'],
  box?: ExtractedSpine['box'],
): ExtractedSpine | null {
  const clean = cleanFragments(fragments)
  if (clean.length === 0) return null

  const publisherLine = clean.find((f) => looksLikePublisher(f.text))
  const rest = clean.filter((f) => f !== publisherLine)

  // 書名は「残りのうち最も書名らしい塊」。著者候補も書名になりうるので、
  // ここでは著者らしさで除外しない(1つしか読めなかった場合に何も残らなくなる)
  const titleFragment =
    [...rest]
      .map((f, i) => ({ f, score: titleScore(f, clean.indexOf(f) >= 0 ? clean.indexOf(f) : i) }))
      .sort((a, b) => b.score - a.score)[0]?.f ?? clean[0]

  const authors = rest
    .filter((f) => f !== titleFragment && looksLikeAuthor(f.text))
    .map((f) => stripAuthorRole(f.text))
    .filter(Boolean)

  return {
    title: titleFragment.text,
    authors,
    publisher: publisherLine ? tidy(publisherLine.text) : undefined,
    confidence,
    fragments: clean,
    engine,
    box,
  }
}

/**
 * 1枚のコマの読み取り結果から、背表紙を1冊ずつ取り出す。
 *
 * 列の1つが背表紙1冊に対応する。読めなかった列は落とす。
 */
export function spinesFromRecognition(
  rec: SpineRecognition,
  engine: ExtractedSpine['engine'] = 'tesseract',
): ExtractedSpine[] {
  const out: ExtractedSpine[] = []
  for (const column of rec.columns) {
    const spine = spineFromFragments(splitColumn(column.words), column.confidence, engine, column.box)
    if (spine) out.push(spine)
  }
  return out
}

/** 列の中身をつないだ文字列。追跡（同じ背表紙かどうか）の照合キーに使う */
export function columnText(column: SpineColumn): string {
  return column.words.map((w) => w.text).join('')
}

/** 改行区切りのテキストを断片にする。手入力の修正用 */
export function fragmentsFromText(text: string, confidence = 1): OcrFragment[] {
  return text
    .split(/\r?\n/)
    .map((line) => tidy(line))
    .filter(Boolean)
    .map((line) => ({ text: line, confidence }))
}

/** 利用者が手で直した文字列から作る。信頼度は満点だが、確定はさせない */
export function spineFromText(text: string): ExtractedSpine | null {
  return spineFromFragments(fragmentsFromText(text), 1, 'manual')
}

/**
 * 背表紙1冊ぶんの生テキスト。読めた塊を印刷どおりの並びで残す。
 *
 * 役割の推定(どれが書名でどれが著者か)は外れることがある。並びを
 * 保っておけば、照合側は複数のクエリへ展開し直せるし、利用者が
 * 読み取り文字を直すときも、背表紙と見比べられる形で出せる。
 */
export function spineRawText(spine: ExtractedSpine): string {
  if (spine.fragments?.length) return spine.fragments.map((f) => f.text).join('\n')
  return [spine.title, ...spine.authors, spine.publisher ?? ''].filter(Boolean).join(' ')
}

// ───────────────────────────────────────────────────────────
// 検索クエリの組み立て
// ───────────────────────────────────────────────────────────

export interface SpineQuery {
  title: string
  authors: string[]
  /**
   * 引き方。
   *  - `title` … 書名の項目で引く。精度は高いが、1文字違うと 0 件になる
   *  - `any`   … 全項目のキーワードで引く。当たりは広いが雑音も増える
   */
  mode: 'title' | 'any'
}

/** 末尾を削った前方一致を作るときの、最短の長さ */
const MIN_PREFIX_LENGTH = 4

/**
 * 1冊ぶんの検索クエリを、当たりやすい順に組み立てる。
 *
 * 背表紙は「書名」「副題」「著者」「出版社」が別々の塊に割れて出てくる。
 * 最有力の塊だけで引くと、副題が本題として刷られている本や、書名が2つに
 * 割れている本を取り逃がす。かといって全文で引くと出版社名がノイズになる。
 * どちらか一方に賭けず、精度の高い順に並べて上から試す。
 *
 *  1. 最有力の塊 + 著者        … 最も絞れる
 *  2. 末尾を1文字削った前方一致 … 実測で最も多い崩れ方の受け皿
 *  3. 隣を連結 / 出版社を除く   … 役割の推定を外した場合の受け皿
 *  4. 全塊をキーワードで        … 項目を限定しない
 *  5. 半分まで削った頭を全項目で … 文字列も項目も一番広い。最後の受け皿
 *
 * 並びは「効く見込みが高い順」ではなく「絞りが強い順」にしてある。
 * 呼び出し側は上から数件と**最後の1件**を撃つので、最も絞れるものと
 * 最も当たりが広いものの両方が必ず試される。
 *
 * 同じ文字列になったものは落とす。
 */
export function buildQueries(spine: ExtractedSpine): SpineQuery[] {
  const fragments = spine.fragments ?? []
  const lines = fragments.map((f) => f.text)
  const nonPublisher = fragments.filter((f) => !looksLikePublisher(f.text)).map((f) => f.text)

  const queries: SpineQuery[] = []
  const push = (title: string, authors: string[], mode: SpineQuery['mode'] = 'title') => {
    const t = tidy(title)
    if (t) queries.push({ title: t, authors, mode })
  }

  push(spine.title, spine.authors)

  /*
   * 末尾を削る。
   *
   * 実測では「文化政策の現在」が「文化政策の現不」、「宮沢賢治」が
   * 「宮沢忠治」のように、末尾や途中の1文字が崩れる。書名の項目で
   * 引いていると、これだけで 0 件になる。
   * 前方一致なら、崩れた文字より手前だけで引ける。
   */
  const head = tidy(spine.title)
  if (head.length > MIN_PREFIX_LENGTH + 1) push(head.slice(0, head.length - 1), [])

  // 最有力の塊の隣。断片は読み取り順に並んでいるので、その前後を見る
  const at = lines.indexOf(spine.title)
  if (at >= 0) {
    const after = lines[at + 1]
    const before = lines[at - 1]
    if (after && !looksLikePublisher(after)) push(`${spine.title} ${after}`, [])
    else if (before && !looksLikePublisher(before)) push(`${before} ${spine.title}`, [])
  }

  if (nonPublisher.length > 1) push(nonPublisher.join(' '), [])

  // 全項目のキーワードとして引く。書名の項目に縛られない受け皿
  if (lines.length > 0) push(lines.join(' '), [], 'any')

  /*
   * 最後の受け皿。半分まで削った頭を、全項目のキーワードで引く。
   *
   * 塊の切り分けに失敗すると、書名に出版社まで繋がったものが出る
   * （「文化政策の現東京大学出版会」）。書名は上に刷られているので、
   * こういう塊でも**頭のほうは書名**である。
   *
   * 文字列も項目も、ここが一番広い。呼び出し側はこの1件を必ず撃つので、
   * 絞り込みで全部外した本にも当たりの目が残る。
   */
  if (head.length > MIN_PREFIX_LENGTH + 1) {
    const shorter = Math.max(MIN_PREFIX_LENGTH, Math.floor(head.length * 0.5))
    if (shorter < head.length - 1) push(head.slice(0, shorter), [], 'any')
  }

  const seen = new Set<string>()
  return queries.filter((q) => {
    const key = `${q.mode}|${normalizeForMatch(q.title)}|${q.authors.map(normalizeForMatch).join(',')}`
    if (!normalizeForMatch(q.title) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** 照合に使う文字数。これが短すぎるものは当たっても確定させない */
export function queryLength(spine: { title: string; authors: string[] }): number {
  return normalizeForMatch(spine.title).length
}
