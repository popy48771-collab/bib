import { afterEach, describe, expect, it } from 'vitest'
import { CameraUnavailableError, isIsbnBarcode, openRearCamera, pickIsbn13 } from './barcode'

/**
 * 日本の書籍バーコードは2段組で、下段(192...)は分類・価格コードであって
 * 書籍のIDではない。しかも下段も EAN-13 なのでチェックディジットは正しく通る。
 * 「チェックディジットが合うから ISBN だろう」という判定では下段を拾ってしまい、
 * 存在しない書誌を引くことになる。ここはプレフィックスで弾く必要がある。
 */
describe('isIsbnBarcode', () => {
  it('978 で始まる正しい ISBN-13 を受理する', () => {
    expect(isIsbnBarcode('9784873115658')).toBe(true)
    expect(isIsbnBarcode('9784101010014')).toBe(true)
    expect(isIsbnBarcode('9780306406157')).toBe(true)
  })

  it('979 で始まるものも受理する', () => {
    expect(isIsbnBarcode('9798602401820')).toBe(true)
  })

  it('日本の2段バーコード下段(192...)を拒否する', () => {
    // チェックディジット自体は EAN-13 として正しいが ISBN ではない
    expect(isIsbnBarcode('1923000012004')).toBe(false)
    expect(isIsbnBarcode('1920079003001')).toBe(false)
  })

  it('チェックディジットが合わないものを拒否する', () => {
    expect(isIsbnBarcode('9784873115659')).toBe(false)
    expect(isIsbnBarcode('9784101010015')).toBe(false)
  })

  it('桁数が違うものを拒否する', () => {
    expect(isIsbnBarcode('978487311565')).toBe(false)
    expect(isIsbnBarcode('97848731156580')).toBe(false)
    expect(isIsbnBarcode('4873115655')).toBe(false) // ISBN-10 はバーコードには出ない
    expect(isIsbnBarcode('')).toBe(false)
  })

  it('数字以外が混ざるものを拒否する', () => {
    expect(isIsbnBarcode('97848731156X8')).toBe(false)
    expect(isIsbnBarcode('abcdefghijklm')).toBe(false)
  })

  it('ハイフン・空白は無視して判定する', () => {
    expect(isIsbnBarcode('978-4-87311-565-8')).toBe(true)
    expect(isIsbnBarcode('978 4 87311 565 8')).toBe(true)
  })
})

describe('pickIsbn13', () => {
  it('候補が無ければ null', () => {
    expect(pickIsbn13([])).toBeNull()
    expect(pickIsbn13(['1923000012004'])).toBeNull()
  })

  it('2段が同時に読めても上段(ISBN)を選ぶ', () => {
    expect(pickIsbn13(['1923000012004', '9784873115658'])).toBe('9784873115658')
    // 読み取り順が逆でも結果は変わらない
    expect(pickIsbn13(['9784873115658', '1923000012004'])).toBe('9784873115658')
  })

  it('ハイフン付きで返ってきても正規化して返す', () => {
    expect(pickIsbn13(['978-4-87311-565-8'])).toBe('9784873115658')
  })

  it('無効なコードを読み飛ばして有効なものを拾う', () => {
    expect(pickIsbn13(['xxxx', '', '9784873115659', '9784101010014'])).toBe('9784101010014')
  })
})

/**
 * カメラを開けなかったときの文面。
 *
 * 実機での権限拒否はヘッドレスブラウザでは再現できない
 * (NotAllowedError ではなく NotSupportedError になる)ため、
 * 分岐ごとの文面はここで固定する。
 *
 * 文面の規則は DESIGN_SYSTEM.md のとおり「何が起きたか。次に何をすればよいか。」。
 * どの分岐も、原因と次の行動の両方を含んでいなければならない。
 */
describe('openRearCamera が返すエラー文', () => {
  const define = (key: string, value: unknown, target: object = globalThis) => {
    Object.defineProperty(target, key, { value, configurable: true, writable: true })
  }

  const rejectWith = (err: unknown) => {
    define('isSecureContext', true)
    define('mediaDevices', { getUserMedia: () => Promise.reject(err) }, navigator)
  }

  afterEach(() => {
    define('mediaDevices', undefined, navigator)
    define('isSecureContext', true)
  })

  it('権限拒否では、許可されていないことと設定の確認を伝える', async () => {
    rejectWith(new DOMException('Permission denied', 'NotAllowedError'))
    await expect(openRearCamera()).rejects.toThrow(CameraUnavailableError)
    await expect(openRearCamera()).rejects.toThrow(
      'カメラへのアクセスが許可されていません。ブラウザの設定を確認して、カメラの使用を許可してください。',
    )
  })

  it('カメラが無い場合は、次に取るべき行動まで書く', async () => {
    rejectWith(new DOMException('Not found', 'NotFoundError'))
    await expect(openRearCamera()).rejects.toThrow(
      'カメラが見つかりませんでした。カメラのある端末で開いてください。',
    )
  })

  it('想定外の失敗でも、原因の候補と次の行動を示す', async () => {
    // ヘッドレス環境で実際に返るのはこの分岐(NotSupportedError)
    rejectWith(new DOMException('Not supported', 'NotSupportedError'))
    const err = await openRearCamera().catch((e: unknown) => e)
    expect(err).toBeInstanceOf(CameraUnavailableError)
    expect((err as Error).message).toMatch(/確認して/)
    expect((err as Error).message).toMatch(/もう一度/)
  })

  it('カメラ入力に対応しないブラウザでは、別のブラウザを案内する', async () => {
    define('isSecureContext', true)
    define('mediaDevices', undefined, navigator)
    await expect(openRearCamera()).rejects.toThrow(
      'このブラウザはカメラの利用に対応していません。別のブラウザで開いてください。',
    )
  })

  it('素の http では HTTPS が必要であることを伝える', async () => {
    define('isSecureContext', false)
    await expect(openRearCamera()).rejects.toThrow(/HTTPS/)
    await expect(openRearCamera()).rejects.toThrow(/開いてください/)
  })
})
