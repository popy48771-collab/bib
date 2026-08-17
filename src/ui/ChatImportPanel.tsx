import { useCallback, useState } from 'react'
import { CHAT_EXTRACTION_PROMPT, CHAT_TARGETS } from '../lib/chatPrompt'
import { parseImportedBooks } from '../lib/importText'
import type { ExtractedSpine } from '../sources/vlm'

interface Props {
  /** 取り込みを実行する。書名の一覧と ISBN の一覧が渡る */
  onImport: (spines: ExtractedSpine[], isbns: string[]) => void
  disabled?: boolean
}

/** クリップボードへ書く。古い環境向けの退避も持つ */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
  } catch {
    // 権限が無い / セキュアコンテキストでない。下の退避へ
  }
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.setAttribute('readonly', '')
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}

/**
 * 手持ちのチャットAIを使って読み取る経路。
 *
 * 既に払っているサブスクをそのまま使えるので API 課金が発生しない。
 * 画像は URL に載せられないため、写真の添付だけは人の手で行う。
 *
 * URLパラメータでのプロンプト受け渡しはサービスによって効いたり効かなかったり
 * するので、リンクを開くときは必ずクリップボードにも入れる。
 * こうしておけば、prefill が効かない環境でも貼るだけで済む。
 */
export function ChatImportPanel({ onImport, disabled }: Props) {
  const [pasted, setPasted] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const notifyCopied = useCallback((label: string, ok: boolean) => {
    setCopied(
      ok ? label : 'コピーできませんでした。下の入力欄の内容を選択してコピーしてください。',
    )
    setTimeout(() => setCopied(null), 6000)
  }, [])

  const onCopy = useCallback(async () => {
    notifyCopied('指示文をコピーしました。', await copyText(CHAT_EXTRACTION_PROMPT))
  }, [notifyCopied])

  const onOpen = useCallback(
    async (targetId: string) => {
      const target = CHAT_TARGETS.find((t) => t.id === targetId)
      if (!target) return
      // 先にコピーしておく。プロンプトが URL で渡らなくても貼れば済むようにする
      const ok = await copyText(CHAT_EXTRACTION_PROMPT)
      notifyCopied(
        target.prefills
          ? `${target.label} を新しいタブで開きました。指示文はコピー済みです。`
          : `${target.label} を新しいタブで開きました。コピー済みの指示文を貼り付けてください。`,
        ok,
      )
      window.open(target.url(CHAT_EXTRACTION_PROMPT), '_blank', 'noopener,noreferrer')
    },
    [notifyCopied],
  )

  const onSubmit = useCallback(() => {
    const { spines, isbns } = parseImportedBooks(pasted)
    if (spines.length === 0 && isbns.length === 0) {
      setResult(
        '本の情報を読み取れませんでした。JSON、1行1冊の箇条書き、ISBNの並びのいずれかの形式で貼り付けてください。',
      )
      return
    }
    onImport(spines, isbns)
    setPasted('')
    const parts = [
      spines.length > 0 ? `書名 ${spines.length} 件` : '',
      isbns.length > 0 ? `ISBN ${isbns.length} 件` : '',
    ].filter(Boolean)
    setResult(`${parts.join('、')} を取り込みました。`)
  }, [pasted, onImport])

  return (
    <div className="panel">
      <ol className="steps">
        <li>
          <h2 className="subheading">指示文をコピーして、チャットAIを開く</h2>
          <p className="note">
            写真はURLで渡せないため、チャットAIへの写真の添付はご自身で行ってください。
          </p>
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              onClick={() => void onCopy()}
              disabled={disabled}
            >
              指示文をコピー
            </button>
            {CHAT_TARGETS.map((t) => (
              <button
                type="button"
                key={t.id}
                className="button button--secondary"
                onClick={() => void onOpen(t.id)}
                disabled={disabled}
              >
                {t.label} を開く
              </button>
            ))}
          </div>
          {copied && (
            <p className="note" role="status">
              {copied}
            </p>
          )}
          <details className="disclosure">
            <summary>指示文の内容を確認する</summary>
            <div className="field">
              <label htmlFor="chat-prompt">チャットAIへ渡す指示文</label>
              <textarea
                id="chat-prompt"
                readOnly
                rows={8}
                value={CHAT_EXTRACTION_PROMPT}
                onFocus={(e) => e.currentTarget.select()}
              />
            </div>
          </details>
        </li>

        <li>
          <h2 className="subheading">チャットAIで写真を読み取らせる</h2>
          <p className="note">本棚の写真を添付して実行し、返ってきた結果をコピーしてください。</p>
        </li>

        <li>
          <h2 className="subheading">結果を貼り付ける</h2>
          <div className="field">
            <label htmlFor="chat-result">チャットAIの結果</label>
            <p className="field-hint">
              JSON、1行1冊の箇条書き、ISBNの並びのいずれの形式でも取り込めます。
            </p>
            <textarea
              id="chat-result"
              rows={6}
              value={pasted}
              disabled={disabled}
              onChange={(e) => setPasted(e.target.value)}
            />
          </div>
          <div className="actions">
            <button
              type="button"
              className="button button--primary"
              onClick={onSubmit}
              disabled={disabled || !pasted.trim()}
            >
              一覧に追加
            </button>
          </div>
          {result && (
            <p className="note" role="status">
              {result}
            </p>
          )}
        </li>
      </ol>
    </div>
  )
}
