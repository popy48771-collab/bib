/**
 * 実機診断のスイッチ
 *
 * URL に `?debug=1` が付いているときだけ、診断の記録と画面を出す。
 * **設定画面は持たない**（CLAUDE.md §2）ので、切り替えは URL に置く。
 * 利用者が通常たどる導線には現れず、こちらが実機を触るときだけ使う。
 */

/** 診断モードか。URL を読めない環境（テスト等）では false */
export function isDebugEnabled(search?: string): boolean {
  const query = search ?? (typeof location === 'undefined' ? '' : location.search)
  if (!query) return false
  try {
    return new URLSearchParams(query).get('debug') === '1'
  } catch {
    return false
  }
}
