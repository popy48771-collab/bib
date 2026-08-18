import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SPINE_MAX_LOOKUPS } from '../types'
import type { BibRecord, BookEntry, ExtractedSpine, ScoredCandidate } from '../types'

vi.mock('../sources/openbd', () => ({ fetchByIsbns: vi.fn() }))
vi.mock('../sources/googleBooks', () => ({
  searchByIsbn: vi.fn(),
  searchByTitle: vi.fn(),
  searchByKeyword: vi.fn(),
}))
vi.mock('../sources/ndl', () => ({
  searchByIsbn: vi.fn(),
  searchByTitle: vi.fn(),
  searchByKeyword: vi.fn(),
}))

import * as googleBooks from '../sources/googleBooks'
import * as ndl from '../sources/ndl'
import * as openbd from '../sources/openbd'
import {
  collectSpineEvidence,
  dedupeRecords,
  entriesFromExtraction,
  mergeSpineResult,
  nearExactMatches,
  queriesForEntry,
  resolveEntry,
  scoreSpineCandidates,
  statusFromEvidence,
  type SpineEvidence,
} from './stages'

const ISBN = '9784130342230'
const OTHER_ISBN = '9784062748667'

const SPINE: ExtractedSpine = {
  title: '文化政策の現在',
  authors: ['小林真理'],
  publisher: '東京大学出版会',
  confidence: 0.8,
  fragments: [
    { text: '文化政策の現在', confidence: 0.9 },
    { text: '小林真理', confidence: 0.8 },
    { text: '東京大学出版会', confidence: 0.7 },
  ],
  engine: 'tesseract',
}

function spineEntry(over: Partial<ExtractedSpine> = {}): BookEntry {
  return entriesFromExtraction('p1', [{ ...SPINE, ...over }], 'p1')[0]
}

const ndlRecord: BibRecord = {
  title: '文化政策の現在',
  // NDL は「姓, 名」形式で返す。正規化して同じ人物として扱えること
  authors: ['小林, 真理'],
  publisher: '東京大学出版会',
  published: '2018-03',
  isbn13: ISBN,
  source: 'ndl',
}
const gbRecord: BibRecord = { ...ndlRecord, authors: ['小林真理'], source: 'googleBooks' }

/** すべてのソースが「見つからない」を返す状態にする */
function allMiss() {
  vi.mocked(openbd.fetchByIsbns).mockResolvedValue(new Map())
  vi.mocked(googleBooks.searchByTitle).mockResolvedValue([])
  vi.mocked(googleBooks.searchByKeyword).mockResolvedValue([])
  vi.mocked(ndl.searchByTitle).mockResolvedValue([])
  vi.mocked(ndl.searchByKeyword).mockResolvedValue([])
  vi.mocked(googleBooks.searchByIsbn).mockResolvedValue([])
  vi.mocked(ndl.searchByIsbn).mockResolvedValue([])
}

beforeEach(() => {
  vi.clearAllMocks()
  allMiss()
})

// ───────────────────────────────────────────────────────────

describe('entriesFromExtraction', () => {
  it('読めた行を印刷どおりの並びで残す', () => {
    expect(spineEntry().rawText).toBe('文化政策の現在\n小林真理\n東京大学出版会')
  })

  it('背表紙由来であることを記録する（救済導線の出し分けに使う）', () => {
    expect(spineEntry().inputKind).toBe('spine')
  })

  it('書誌DBで実在確認が取れるまで確定させない', () => {
    // 背表紙の読み取りは「それらしいが存在しない本」を出しうる
    expect(spineEntry().status).toBe('unverified')
    expect(spineEntry().pinned).toBe(false)
  })
})

describe('queriesForEntry', () => {
  it('当たりやすい順に複数のクエリへ展開する', () => {
    const queries = queriesForEntry(spineEntry())
    expect(queries[0]).toEqual({ title: '文化政策の現在', authors: ['小林真理'], mode: 'title' })
    expect(queries.length).toBeGreaterThan(1)
  })

  it('読み取り文字が空でもクエリを1つは返す', () => {
    const empty: BookEntry = { ...spineEntry(), rawText: '', extracted: { title: '', authors: [] } }
    expect(queriesForEntry(empty)).toHaveLength(1)
  })
})

describe('dedupeRecords', () => {
  it('同じ ISBN のレコードはまとめる', () => {
    expect(dedupeRecords([ndlRecord, { ...ndlRecord, title: '表記違い' }])).toHaveLength(1)
  })

  it('ISBN が無いものは書名と著者で見分ける', () => {
    const a: BibRecord = { title: 'A', authors: ['x'], source: 'ndl' }
    const b: BibRecord = { title: 'B', authors: ['x'], source: 'ndl' }
    expect(dedupeRecords([a, { ...a }, b])).toHaveLength(2)
  })
})

describe('scoreSpineCandidates', () => {
  it('最有力行を外していても、他のクエリと一致すれば拾う', () => {
    // 役割の推定を外し、著者名を書名として拾ってしまった状態
    const entry = spineEntry({
      title: '小林真理',
      authors: [],
      fragments: [
        { text: '小林真理', confidence: 0.9 },
        { text: '文化政策の現在', confidence: 0.85 },
      ],
    })
    const scored = scoreSpineCandidates(entry, [ndlRecord])
    expect(scored).toHaveLength(1)
    expect(scored[0].score).toBeGreaterThan(0.5)
  })

  it('無関係な候補は閾値で切り捨てる', () => {
    const other: BibRecord = { title: '全く関係のない書名XYZ', authors: ['誰か'], source: 'ndl' }
    expect(scoreSpineCandidates(spineEntry(), [other])).toHaveLength(0)
  })
})

// ───────────────────────────────────────────────────────────

function evidence(over: Partial<SpineEvidence> = {}): SpineEvidence {
  return {
    isbnAgreement: false,
    titleExact: false,
    authorMatch: false,
    repeatedObservation: false,
    disagreement: false,
    queryLength: 10,
    ...over,
  }
}

describe('statusFromEvidence — 自動確定の規則', () => {
  it('複数ソースが同じ ISBN を指したら確定', () => {
    expect(statusFromEvidence(evidence({ isbnAgreement: true }))).toBe('confirmed')
  })

  it('書名がほぼ完全一致し著者も一致すれば確定', () => {
    expect(statusFromEvidence(evidence({ titleExact: true, authorMatch: true }))).toBe('confirmed')
  })

  it('書名だけ一致していても確定させない（裏付けが無い）', () => {
    expect(statusFromEvidence(evidence({ titleExact: true }))).toBe('needsReview')
  })

  it('ソースどうしが別の本を返したら差分ありとする', () => {
    expect(statusFromEvidence(evidence({ disagreement: true, titleExact: true }))).toBe('conflict')
  })

  it('読めた文字が短すぎるものは、当たっても確定させない', () => {
    // 「猫」だけ読めて偶然当たった、という状況を確定にしてはならない
    expect(
      statusFromEvidence(evidence({ titleExact: true, authorMatch: true, queryLength: 2 })),
    ).toBe('needsReview')
  })

  it('別のコマからも同じ本に着地したなら確定する', () => {
    // 著者は崩れやすい。独立した2回の観測が同じ ISBN を指すなら、
    // 1つのDBだけの高得点より強い根拠になる
    expect(statusFromEvidence(evidence({ titleExact: true, repeatedObservation: true }))).toBe(
      'confirmed',
    )
  })

  it('再観測だけでは確定させない（同じ読み違えを繰り返しうる）', () => {
    expect(statusFromEvidence(evidence({ repeatedObservation: true }))).toBe('needsReview')
  })

  it('候補があっても根拠が無ければ人間の確認へ回す', () => {
    expect(statusFromEvidence(evidence())).toBe('needsReview')
  })
})

describe('collectSpineEvidence', () => {
  const entry = spineEntry()

  it('別のソースの上位に同じ ISBN があれば合意とみなす', () => {
    const top: ScoredCandidate = { record: ndlRecord, score: 0.95 }
    const ev = collectSpineEvidence(entry, top, {
      ndl: [top],
      googleBooks: [{ record: gbRecord, score: 0.95 }],
    })
    expect(ev.isbnAgreement).toBe(true)
    expect(ev.disagreement).toBe(false)
  })

  it('表記の違う著者名でも一致と判定する', () => {
    const top: ScoredCandidate = { record: ndlRecord, score: 0.95 }
    const ev = collectSpineEvidence(entry, top, { ndl: [top] })
    expect(ev.titleExact).toBe(true)
    expect(ev.authorMatch).toBe(true)
  })

  it('著者が読めていなければ一致とみなさない', () => {
    const noAuthor = spineEntry({
      authors: [],
      fragments: [{ text: '文化政策の現在', confidence: 0.9 }],
    })
    const top: ScoredCandidate = { record: ndlRecord, score: 0.95 }
    expect(collectSpineEvidence(noAuthor, top, { ndl: [top] }).authorMatch).toBe(false)
  })

  it('似た書名で ISBN が違えば版違いの疑いとする', () => {
    const rival: BibRecord = { ...gbRecord, isbn13: OTHER_ISBN }
    const top: ScoredCandidate = { record: ndlRecord, score: 0.95 }
    const ev = collectSpineEvidence(entry, top, {
      ndl: [top],
      googleBooks: [{ record: rival, score: 0.94 }],
    })
    expect(ev.isbnAgreement).toBe(false)
    expect(ev.disagreement).toBe(true)
  })
})

describe('mergeSpineResult', () => {
  const entry = spineEntry()
  const ndlScored: ScoredCandidate[] = [{ record: ndlRecord, score: 0.95 }]
  const gbScored: ScoredCandidate[] = [{ record: gbRecord, score: 0.94 }]

  it('候補が無ければ見つからずとする', () => {
    const merged = mergeSpineResult(entry, { ndl: [], googleBooks: [] })
    expect(merged.status).toBe('notFound')
  })

  it('両ソースが同じ ISBN を指したら確定する', () => {
    const merged = mergeSpineResult(entry, { ndl: ndlScored, googleBooks: gbScored })
    expect(merged.status).toBe('confirmed')
    expect(merged.resolved?.isbn13).toBe(ISBN)
  })

  it('確定しない場合でも書名は出す（どの本の話か分からないと候補を選べない）', () => {
    const noAuthor = spineEntry({
      authors: [],
      fragments: [{ text: '文化政策の現在', confidence: 0.9 }],
    })
    const merged = mergeSpineResult(noAuthor, { ndl: ndlScored })
    expect(merged.status).toBe('needsReview')
    expect(merged.resolved?.title).toBe('文化政策の現在')
  })

  it('食い違いは差分として残す', () => {
    const rival: ScoredCandidate[] = [{ record: { ...gbRecord, isbn13: OTHER_ISBN }, score: 0.94 }]
    const merged = mergeSpineResult(entry, { ndl: ndlScored, googleBooks: rival })
    expect(merged.status).toBe('conflict')
    expect(merged.conflicts?.some((c) => c.field === 'isbn13')).toBe(true)
  })

  it('他のソースの候補を消さない（非破壊）', () => {
    const withOpenbd: BookEntry = {
      ...entry,
      candidates: { openbd: [{ record: { ...ndlRecord, source: 'openbd' }, score: 1 }] },
    }
    const merged = mergeSpineResult(withOpenbd, { ndl: ndlScored })
    expect(merged.candidates.openbd).toHaveLength(1)
    expect(merged.candidates.ndl).toHaveLength(1)
  })

  it('同じ結果を二度統合しても壊れない（冪等）', () => {
    const once = mergeSpineResult(entry, { ndl: ndlScored, googleBooks: gbScored })
    const twice = mergeSpineResult(once, { ndl: ndlScored, googleBooks: gbScored })
    expect(twice).toEqual(once)
  })

  it('元のエントリを変更しない（純粋関数）', () => {
    const snapshot = JSON.parse(JSON.stringify(entry))
    mergeSpineResult(entry, { ndl: ndlScored })
    expect(JSON.parse(JSON.stringify(entry))).toEqual(snapshot)
  })
})

// ───────────────────────────────────────────────────────────

describe('nearExactMatches — まとめて確定できる行', () => {
  const scored = (record: BibRecord, score: number): ScoredCandidate[] => [{ record, score }]

  it('書名がほぼ一致している要確認の行を拾う', () => {
    const entry: BookEntry = {
      ...spineEntry(),
      status: 'needsReview',
      candidates: { ndl: scored(ndlRecord, 0.8) },
    }
    expect(nearExactMatches([entry])).toHaveLength(1)
  })

  it('書名が似ているだけの行は拾わない', () => {
    const entry: BookEntry = {
      ...spineEntry(),
      status: 'needsReview',
      candidates: { ndl: scored({ ...ndlRecord, title: '文化政策の展開と課題' }, 0.8) },
    }
    expect(nearExactMatches([entry])).toHaveLength(0)
  })

  it('確定済み・手動確定済みは対象にしない', () => {
    const base: BookEntry = { ...spineEntry(), candidates: { ndl: scored(ndlRecord, 0.8) } }
    expect(nearExactMatches([{ ...base, status: 'confirmed' }])).toHaveLength(0)
    expect(nearExactMatches([{ ...base, status: 'needsReview', pinned: true }])).toHaveLength(0)
  })

  it('読めた文字が短すぎる行は対象にしない', () => {
    const short: BookEntry = {
      ...spineEntry({ title: '猫', authors: [], fragments: [{ text: '猫', confidence: 0.9 }] }),
      status: 'needsReview',
      candidates: { ndl: scored({ ...ndlRecord, title: '猫' }, 0.9) },
    }
    expect(nearExactMatches([short])).toHaveLength(0)
  })

  it('候補が無ければ対象にしない', () => {
    expect(nearExactMatches([{ ...spineEntry(), status: 'needsReview' }])).toHaveLength(0)
  })
})

describe('resolveEntry — 背表紙(書名)経路', () => {
  it('日本語なら NDL を先に当てる（和書の網羅性が最も高い）', async () => {
    const order: string[] = []
    vi.mocked(ndl.searchByTitle).mockImplementation(async () => {
      order.push('ndl')
      return []
    })
    vi.mocked(googleBooks.searchByTitle).mockImplementation(async () => {
      order.push('googleBooks')
      return []
    })

    await resolveEntry(spineEntry())

    expect(order[0]).toBe('ndl')
    expect(order).toContain('googleBooks')
  })

  it('欧文中心なら Google Books を先に当てる', async () => {
    const order: string[] = []
    vi.mocked(ndl.searchByTitle).mockImplementation(async () => {
      order.push('ndl')
      return []
    })
    vi.mocked(googleBooks.searchByTitle).mockImplementation(async () => {
      order.push('googleBooks')
      return []
    })

    await resolveEntry(
      spineEntry({
        title: 'Clean Architecture',
        authors: ['Robert Martin'],
        publisher: undefined,
        fragments: [
          { text: 'Clean Architecture', confidence: 0.9 },
          { text: 'Robert Martin', confidence: 0.8 },
        ],
      }),
    )

    expect(order[0]).toBe('googleBooks')
  })

  it('両ソースの上位が一致したら確定する', async () => {
    vi.mocked(ndl.searchByTitle).mockResolvedValue([ndlRecord])
    vi.mocked(googleBooks.searchByTitle).mockResolvedValue([gbRecord])

    const resolved = await resolveEntry(spineEntry())

    expect(resolved.status).toBe('confirmed')
    expect(resolved.resolved?.isbn13).toBe(ISBN)
  })

  it('片方のソースだけで著者の裏付けが無ければ確認へ回す', async () => {
    vi.mocked(ndl.searchByTitle).mockResolvedValue([{ ...ndlRecord, authors: [] }])

    const resolved = await resolveEntry(
      spineEntry({ authors: [], fragments: [{ text: '文化政策の現在', confidence: 0.9 }] }),
    )

    expect(resolved.status).toBe('needsReview')
    expect(resolved.candidates.ndl).toHaveLength(1)
  })

  it('最初のクエリで外れたら次のクエリを試す', async () => {
    // 書名がまるごと一致しないと引けないソースでも、末尾を削れば当たる
    const tried: string[] = []
    vi.mocked(ndl.searchByTitle).mockImplementation(async (title) => {
      tried.push(title)
      return title === '文化政策の現' ? [ndlRecord] : []
    })

    const resolved = await resolveEntry(spineEntry())

    expect(tried.length).toBeGreaterThan(1)
    expect(resolved.candidates.ndl?.length).toBe(1)
  })

  it('当たったクエリで打ち切る（無駄な通信をしない）', async () => {
    vi.mocked(ndl.searchByTitle).mockResolvedValue([ndlRecord])
    await resolveEntry(spineEntry())
    expect(vi.mocked(ndl.searchByTitle).mock.calls).toHaveLength(1)
  })

  it('1冊あたりの問い合わせ回数に上限を置く', async () => {
    // どのクエリも外れる本。延々と引き続けてはいけない
    await resolveEntry(spineEntry())

    const calls =
      vi.mocked(ndl.searchByTitle).mock.calls.length +
      vi.mocked(googleBooks.searchByTitle).mock.calls.length
    expect(calls).toBeLessThanOrEqual(SPINE_MAX_LOOKUPS)
  })

  it('先に当てたソースが予算を使い切らない（合意の判定材料を残す）', async () => {
    // NDL が全部外れても、Google Books に最有力クエリ以外も撃てること
    await resolveEntry(spineEntry())
    expect(vi.mocked(googleBooks.searchByTitle).mock.calls.length).toBeGreaterThan(1)
  })

  it('確定したら openBD で書影などを補う', async () => {
    vi.mocked(ndl.searchByTitle).mockResolvedValue([ndlRecord])
    vi.mocked(googleBooks.searchByTitle).mockResolvedValue([gbRecord])
    vi.mocked(openbd.fetchByIsbns).mockResolvedValue(
      new Map([
        [
          ISBN,
          {
            title: '文化政策の現在',
            authors: ['小林真理'],
            publisher: '東京大学出版会',
            isbn13: ISBN,
            coverUrl: 'https://cover.example/1.jpg',
            source: 'openbd' as const,
          },
        ],
      ]),
    )

    const resolved = await resolveEntry(spineEntry())

    expect(resolved.resolved?.coverUrl).toBe('https://cover.example/1.jpg')
    expect(resolved.provenance.coverUrl).toBe('openbd')
    // 既にある値は上書きしない
    expect(resolved.provenance.title).not.toBe('openbd')
  })

  it('確定していない本には openBD を引かない（無駄な通信をしない）', async () => {
    vi.mocked(ndl.searchByTitle).mockResolvedValue([{ ...ndlRecord, authors: [] }])
    await resolveEntry(
      spineEntry({ authors: [], fragments: [{ text: '文化政策の現在', confidence: 0.9 }] }),
    )
    expect(openbd.fetchByIsbns).not.toHaveBeenCalled()
  })

  it('あるソースが落ちても、もう片方の成果は残す（隔離）', async () => {
    vi.mocked(ndl.searchByTitle).mockRejectedValue(new Error('中継が落ちています'))
    vi.mocked(googleBooks.searchByTitle).mockResolvedValue([gbRecord])

    const resolved = await resolveEntry(spineEntry())

    expect(resolved.candidates.googleBooks).toHaveLength(1)
    expect(resolved.resolved?.title).toBe('文化政策の現在')
  })

  it('両方落ちても例外は投げず、読み取った文字は残す', async () => {
    vi.mocked(ndl.searchByTitle).mockRejectedValue(new Error('通信できません'))
    vi.mocked(googleBooks.searchByTitle).mockRejectedValue(new Error('通信できません'))

    const resolved = await resolveEntry(spineEntry())

    expect(resolved.status).toBe('notFound')
    expect(resolved.rawText).toContain('文化政策の現在')
  })

  it('中断は上へ抜ける', async () => {
    vi.mocked(ndl.searchByTitle).mockRejectedValue(new DOMException('Aborted', 'AbortError'))
    await expect(resolveEntry(spineEntry())).rejects.toThrow(DOMException)
  })

  it('書名の項目で外れたら、末尾を削った前方一致を試す', async () => {
    // 実測で崩れるのは末尾の1〜2文字が多い。「文化政策の現在」→「文化政策の現不」
    const tried: string[] = []
    vi.mocked(ndl.searchByTitle).mockImplementation(async (title) => {
      tried.push(title)
      return []
    })

    await resolveEntry(
      spineEntry({
        title: '文化政策の現不',
        fragments: [{ text: '文化政策の現不', confidence: 0.9 }],
      }),
    )

    expect(tried.some((t) => t === '文化政策の現')).toBe(true)
  })

  it('最後は全項目のキーワードで引く', async () => {
    await resolveEntry(spineEntry())
    // 書名の項目で全部外れたら、当たりの広いキーワード検索へ落とす
    expect(ndl.searchByKeyword).toHaveBeenCalled()
  })

  it('手で確定した項目・除外した項目には触らない', async () => {
    const pinned: BookEntry = { ...spineEntry(), pinned: true }
    expect(await resolveEntry(pinned)).toBe(pinned)

    const excluded: BookEntry = { ...spineEntry(), status: 'excluded' }
    expect(await resolveEntry(excluded)).toBe(excluded)

    expect(ndl.searchByTitle).not.toHaveBeenCalled()
  })
})
