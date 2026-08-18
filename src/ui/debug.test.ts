import { describe, expect, it } from 'vitest'
import { isDebugEnabled } from './debug'

describe('isDebugEnabled', () => {
  it('?debug=1 のときだけ有効になる', () => {
    expect(isDebugEnabled('?debug=1')).toBe(true)
    expect(isDebugEnabled('?a=b&debug=1')).toBe(true)
  })

  it('付いていなければ無効', () => {
    expect(isDebugEnabled('')).toBe(false)
    expect(isDebugEnabled('?debug=0')).toBe(false)
    expect(isDebugEnabled('?debug')).toBe(false)
    expect(isDebugEnabled('?other=1')).toBe(false)
  })
})
