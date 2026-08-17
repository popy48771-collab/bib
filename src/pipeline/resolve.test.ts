import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BibRecord, BookEntry } from '../types'

vi.mock('../sources/openbd', () => ({ fetchByIsbns: vi.fn() }))
vi.mock('../sources/googleBooks', () => ({ searchByIsbn: vi.fn(), searchByTitle: vi.fn() }))
vi.mock('../sources/ndl', () => ({ searchByIsbn: vi.fn(), searchByTitle: vi.fn() }))

import * as googleBooks from '../sources/googleBooks'
import * as ndl from '../sources/ndl'
import * as openbd from '../sources/openbd'
import { entriesFromExtraction, entriesFromIsbns, resolveEntries, resolveEntry } from './stages'

const ISBN = '9784873115658'

const openbdHit: BibRecord = {
  title: 'リーダブルコード',
  authors: ['Dustin Boswell'],
  publisher: 'オライリージャパン',
  isbn13: ISBN,
  source: 'openbd',
}
const googleHit: BibRecord = { ...openbdHit, source: 'googleBooks' }
const ndlHit: BibRecord = { ...openbdHit, source: 'ndl' }

/** すべてのソースが「見つからない」を返す状態にする */
function allMiss() {
  vi.mocked(openbd.fetchByIsbns).mockResolvedValue(new Map())
  vi.mocked(googleBooks.searchByIsbn).mockResolvedValue([])
  vi.mocked(googleBooks.searchByTitle).mockResolvedValue([])
  vi.mocked(ndl.searchByIsbn).mockResolvedValue([])
  vi.mocked(ndl.searchByTitle).mockResolvedValue([])
}

function barcodeEntry(): BookEntry {
  return entriesFromIsbns([ISBN], 'scan1')[0]
}

beforeEach(() => {
  vi.clearAllMocks()
  allMiss()
})

/**
 * バーコード経路は ISBN 完全一致で引けるので、人間のトリアージを挟まずに
 * 確定してよい。「かざすだけで一覧ができる」という性質はここが支えている。
 */
describe('resolveEntry — ISBN 経路', () => {
  it('openBD で当たったら確定し、他のソースは引かない', async () => {
    vi.mocked(openbd.fetchByIsbns).mockResolvedValue(new Map([[ISBN, openbdHit]]))

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('confirmed')
    expect(resolved.resolved?.title).toBe('リーダブルコード')
    expect(resolved.resolved?.source).toBe('openbd')
    // 当たった時点で打ち切る。無駄な通信は利用者の待ち時間そのもの
    expect(googleBooks.searchByIsbn).not.toHaveBeenCalled()
    expect(ndl.searchByIsbn).not.toHaveBeenCalled()
  })

  it('openBD が外れたら Google Books に回して確定する', async () => {
    vi.mocked(googleBooks.searchByIsbn).mockResolvedValue([googleHit])

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('confirmed')
    expect(resolved.resolved?.source).toBe('googleBooks')
    expect(ndl.searchByIsbn).not.toHaveBeenCalled()
  })

  it('openBD も Google Books も外れたら NDL で拾う', async () => {
    vi.mocked(ndl.searchByIsbn).mockResolvedValue([ndlHit])

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('confirmed')
    expect(resolved.resolved?.source).toBe('ndl')
    expect(resolved.candidates.ndl).toHaveLength(1)
    // 空振りした Google Books の記録も残す(非破壊)
    expect(resolved.candidates.googleBooks).toEqual([])
  })

  it('ISBN一致は完全一致なので、書名の類似度で絞り込まない', async () => {
    // 書名がまるで違っても、ISBN で引いた結果はその本そのもの
    vi.mocked(googleBooks.searchByIsbn).mockResolvedValue([
      { ...googleHit, title: '全く似ていない書名' },
    ])

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('confirmed')
    expect(resolved.resolved?.title).toBe('全く似ていない書名')
  })

  it('どこにも無ければ notFound だが、読んだ ISBN は捨てない', async () => {
    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('notFound')
    expect(resolved.resolved?.isbn13).toBe(ISBN)
    expect(ndl.searchByIsbn).toHaveBeenCalled()
  })

  it('書誌側に ISBN が無くても、読んだ ISBN を保持する', async () => {
    vi.mocked(ndl.searchByIsbn).mockResolvedValue([{ ...ndlHit, isbn13: undefined }])

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.resolved?.isbn13).toBe(ISBN)
    expect(resolved.provenance.isbn13).toBe('barcode')
  })

  it('あるソースが落ちていても、次のソースで確定できる(隔離)', async () => {
    vi.mocked(openbd.fetchByIsbns).mockRejectedValue(new Error('openBD APIエラー: 500'))
    vi.mocked(googleBooks.searchByIsbn).mockRejectedValue(new Error('通信できません'))
    vi.mocked(ndl.searchByIsbn).mockResolvedValue([ndlHit])

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('confirmed')
  })

  it('全ソースが落ちても例外は投げず、未確認のまま残す', async () => {
    const boom = () => Promise.reject(new Error('通信できません'))
    vi.mocked(openbd.fetchByIsbns).mockImplementation(boom)
    vi.mocked(googleBooks.searchByIsbn).mockImplementation(boom)
    vi.mocked(ndl.searchByIsbn).mockImplementation(boom)

    const resolved = await resolveEntry(barcodeEntry())

    expect(resolved.status).toBe('unverified')
    expect(resolved.resolved?.isbn13).toBe(ISBN)
  })

  it('中断は上へ抜ける', async () => {
    vi.mocked(openbd.fetchByIsbns).mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    await expect(resolveEntry(barcodeEntry())).rejects.toThrow(DOMException)
  })

  it('一度照合が通った項目でも、再照合で ISBN 経路に乗る', async () => {
    // 照合が通ると provenance.isbn13 は書誌ソース側に移る。
    // それでもバーコード由来だと分からないと、再照合が書名検索に落ちてしまう
    vi.mocked(googleBooks.searchByIsbn).mockResolvedValue([googleHit])
    const once = await resolveEntry(barcodeEntry())
    expect(once.provenance.isbn13).toBe('googleBooks')

    vi.clearAllMocks()
    allMiss()
    vi.mocked(openbd.fetchByIsbns).mockResolvedValue(new Map([[ISBN, openbdHit]]))

    await resolveEntry(once)

    expect(openbd.fetchByIsbns).toHaveBeenCalledWith([ISBN], undefined)
    expect(googleBooks.searchByTitle).not.toHaveBeenCalled()
  })

  it('手で確定した項目には触らない', async () => {
    const pinned: BookEntry = { ...barcodeEntry(), pinned: true }
    expect(await resolveEntry(pinned)).toBe(pinned)
    expect(openbd.fetchByIsbns).not.toHaveBeenCalled()
  })

  it('除外した項目には触らない', async () => {
    const excluded: BookEntry = { ...barcodeEntry(), status: 'excluded' }
    expect(await resolveEntry(excluded)).toBe(excluded)
    expect(openbd.fetchByIsbns).not.toHaveBeenCalled()
  })
})

/**
 * 背表紙経路は読み取り自体が曖昧なので、ISBN 経路とは扱いを変える。
 * 類似度で絞り、確信が持てないものは人間の判断に回す。
 */
describe('resolveEntry — 書名経路', () => {
  const spineEntry = () =>
    entriesFromExtraction(
      'p1',
      [{ title: 'リーダブルコード', authors: ['Dustin Boswell'], confidence: 0.9 }],
      'p1',
    )[0]

  it('ISBN が無ければ書名で引く', async () => {
    vi.mocked(googleBooks.searchByTitle).mockResolvedValue([googleHit])

    const resolved = await resolveEntry(spineEntry())

    expect(googleBooks.searchByTitle).toHaveBeenCalled()
    expect(googleBooks.searchByIsbn).not.toHaveBeenCalled()
    expect(resolved.status).toBe('confirmed')
  })

  it('似ていない候補しか無ければ確定させず、NDL にも当たる', async () => {
    vi.mocked(googleBooks.searchByTitle).mockResolvedValue([
      { ...googleHit, title: '全く関係のない書名XYZ', authors: ['別人'] },
    ])

    const resolved = await resolveEntry(spineEntry())

    expect(resolved.status).not.toBe('confirmed')
    expect(ndl.searchByTitle).toHaveBeenCalled()
  })
})

describe('resolveEntries', () => {
  it('解決したそばから onEntry で返す', async () => {
    vi.mocked(openbd.fetchByIsbns).mockResolvedValue(new Map([[ISBN, openbdHit]]))
    const seen: string[] = []

    const out = await resolveEntries(entriesFromIsbns([ISBN, ISBN], 'scan1'), {
      onEntry: (e) => seen.push(e.status),
    })

    expect(seen).toEqual(['confirmed', 'confirmed'])
    expect(out).toHaveLength(2)
  })

  it('1件が失敗しても残りを処理する', async () => {
    // 1冊目だけ全ソースが落ちる。2冊目は openBD で当たる
    const boom = new Error('通信できません')
    vi.mocked(openbd.fetchByIsbns)
      .mockRejectedValueOnce(boom)
      .mockResolvedValue(new Map([[ISBN, openbdHit]]))
    vi.mocked(googleBooks.searchByIsbn).mockRejectedValueOnce(boom).mockResolvedValue([])
    vi.mocked(ndl.searchByIsbn).mockRejectedValueOnce(boom).mockResolvedValue([])

    const out = await resolveEntries(entriesFromIsbns([ISBN, ISBN], 'scan1'))

    expect(out[0].status).toBe('unverified')
    expect(out[1].status).toBe('confirmed')
  })
})
