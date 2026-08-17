import type { ReactNode } from 'react'

export type NoticeKind = 'error' | 'success' | 'info'

/**
 * 種類を示す見出し語。
 * 色を落としても種類が分かるようにするため、帯の色とは別に必ず語を出す。
 */
const KIND_LABEL: Record<NoticeKind, string> = {
  error: 'エラー',
  success: '完了',
  info: 'お知らせ',
}

interface Props {
  kind: NoticeKind
  /** 見出し語を差し替える場合に指定する */
  title?: string
  children: ReactNode
  /**
   * 読み上げの扱い。
   * 処理の結果は status(polite)、操作を止める失敗は alert(assertive)。
   * 最初から画面にあるもの（説明文など）は none。
   */
  live?: 'status' | 'alert' | 'none'
  /** 追加の操作。再実行ボタンなどを置く */
  actions?: ReactNode
}

/**
 * 通知バナー。
 *
 * 本文は「何が起きたか。次に何をすればよいか。」の順で書く。
 * 呼び出し側でその順序を守ること。
 */
export function Notice({ kind, title, children, live = 'none', actions }: Props) {
  return (
    <div className={`notice notice--${kind}`} role={live === 'none' ? undefined : live}>
      <p className="notice__title">{title ?? KIND_LABEL[kind]}</p>
      <div className="notice__body">{children}</div>
      {actions && <div className="actions">{actions}</div>}
    </div>
  )
}
