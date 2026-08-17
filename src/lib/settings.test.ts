import { beforeEach, describe, expect, it } from 'vitest'
import { loadSettings, saveSettings } from './db'
import { DEFAULT_NDL_PROXY_URL } from '../types'

const KEY = 'bookshelf-scanner:settings'

describe('設定の読み込み', () => {
  beforeEach(() => localStorage.clear())

  it('初回は既定のNDL中継が入っている', () => {
    expect(loadSettings().ndlProxyUrl).toBe(DEFAULT_NDL_PROXY_URL)
  })

  it('既定の中継を導入する前に保存された設定(空文字)は既定に戻す', () => {
    // 以前の版は ndlProxyUrl: '' を保存していた。
    // そのまま採ると NDL 段階が無効のままになってしまう
    localStorage.setItem(KEY, JSON.stringify({ vlmProvider: 'none', ndlProxyUrl: '' }))
    expect(loadSettings().ndlProxyUrl).toBe(DEFAULT_NDL_PROXY_URL)
  })

  it('空白のみでも既定に戻す', () => {
    localStorage.setItem(KEY, JSON.stringify({ ndlProxyUrl: '   ' }))
    expect(loadSettings().ndlProxyUrl).toBe(DEFAULT_NDL_PROXY_URL)
  })

  it('自分で設定した中継は尊重する', () => {
    saveSettings({ ...loadSettings(), ndlProxyUrl: 'https://my-proxy.example/?url=' })
    expect(loadSettings().ndlProxyUrl).toBe('https://my-proxy.example/?url=')
  })

  it('APIキーなど他の設定は既定で空のまま', () => {
    const s = loadSettings()
    expect(s.vlmApiKey).toBe('')
    expect(s.vlmProvider).toBe('none')
  })

  it('壊れた保存値でも既定に落ちる', () => {
    localStorage.setItem(KEY, '{壊れている')
    expect(loadSettings().ndlProxyUrl).toBe(DEFAULT_NDL_PROXY_URL)
  })
})
