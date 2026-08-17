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
    setCopied(ok ? label : 'コピーできませんでした。下の本文を選択してコピーしてください。')
    setTimeout(() => setCopied(null), 2600)
  }, [])

  const onCopy = useCallback(async () => {
    notifyCopied('プロンプトをコピーしました', await copyText(CHAT_EXTRACTION_PROMPT))
  }, [notifyCopied])

  const onOpen = useCallback(
    async (targetId: string) => {
      const target = CHAT_TARGETS.find((t) => t.id === targetId)
      if (!target) return
      // 先にコピーしておく。プロンプトが URL で渡らなくても貼れば済むようにする
      const ok = await copyText(CHAT_EXTRACTION_PROMPT)
      notifyCopied(
        target.prefills
          ? `${target.label} を開きます（プロンプトはコピー済み）`
          : `${target.label} を開きます。プロンプトを貼り付けてください（コピー済み）`,
        ok,
      )
      window.open(target.url(CHAT_EXTRACTION_PROMPT), '_blank', 'noopener,noreferrer')
    },
    [notifyCopied],
  )

  const onSubmit = useCallback(() => {
    const { spines, isbns } = parseImportedBooks(pasted)
    if (spines.length === 0 && isbns.length === 0) {
      setResult('読み取れる本がありませんでした。JSON でも、1行1冊の箇条書きでも取り込めます。')
      return
    }
    onImport(spines, isbns)
    setPasted('')
    const parts = [
      spines.length > 0 ? `書名 ${spines.length} 件` : '',
      isbns.length > 0 ? `ISBN ${isbns.length} 件` : '',
    ].filter(Boolean)
    setResult(`${parts.join(' / ')} を取り込みました。`)
  }, [pasted, onImport])

  return (
    <div className="chat-import">
      <ol className="chat-steps">
        <li>
          <p>
            プロンプトをコピーして、お使いのチャットAIを開きます。
            <strong>写真は URL に載せられない</strong>ので、添付だけはご自身で行ってください。
          </p>
          <div className="chat-actions">
            <button className="primary" onClick={() => void onCopy()} disabled={disabled}>
              プロンプトをコピー
            </button>
            {CHAT_TARGETS.map((t) => (
              <button key={t.id} onClick={() => void onOpen(t.id)} disabled={disabled}>
                {t.label} を開く
              </button>
            ))}
          </div>
          {copied && <p className="chat-toast">{copied}</p>}
          <details className="chat-prompt">
            <summary>プロンプトの内容を見る</summary>
            <textarea readOnly rows={8} value={CHAT_EXTRACTION_PROMPT} onFocus={(e) => e.currentTarget.select()} />
          </details>
        </li>

        <li>
          <p>チャット側で本棚の写真を添付して実行し、返ってきた結果をコピーします。</p>
        </li>

        <li>
          <p>ここに貼り付けます。</p>
          <textarea
            rows={6}
            value={pasted}
            disabled={disabled}
            placeholder={'ここに結果を貼り付け\n\nJSON でも、1行1冊の箇条書きでも、ISBN の羅列でも取り込めます'}
            onChange={(e) => setPasted(e.target.value)}
          />
          <div className="chat-actions">
            <button className="primary" onClick={onSubmit} disabled={disabled || !pasted.trim()}>
              取り込む
            </button>
          </div>
          {result && <p className="chat-toast">{result}</p>}
        </li>
      </ol>
    </div>
  )
}
