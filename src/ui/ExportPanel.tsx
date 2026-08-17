import { useMemo, useState } from 'react'
import type { BookEntry } from '../types'
import { EXPORT_META, exportableEntries, renderExport, type ExportFormat } from '../lib/export'

interface Props {
  entries: BookEntry[]
}

export function ExportPanel({ entries }: Props) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [includeUnverified, setIncludeUnverified] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const content = useMemo(
    () => renderExport(format, entries, includeUnverified),
    [format, entries, includeUnverified],
  )
  const count = exportableEntries(entries, includeUnverified).length

  const download = () => {
    const meta = EXPORT_META[format]
    const blob = new Blob([content], { type: meta.mime })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `bookshelf.${meta.ext}`
    a.click()
    URL.revokeObjectURL(url)
    setMessage(`${count} 件を ${meta.ext.toUpperCase()} 形式で書き出しました。`)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
      setMessage('書き出す内容をクリップボードにコピーしました。')
    } catch {
      // クリップボードが使えない環境ではテキスト欄から手動コピーしてもらう
      setMessage('コピーできませんでした。下の入力欄の内容を選択してコピーしてください。')
    }
  }

  return (
    <div className="panel stack">
      <div className="export-controls">
        <div className="field">
          <label htmlFor="export-format">形式</label>
          <select
            id="export-format"
            value={format}
            onChange={(e) => setFormat(e.target.value as ExportFormat)}
          >
            {(Object.keys(EXPORT_META) as ExportFormat[]).map((f) => (
              <option key={f} value={f}>
                {EXPORT_META[f].label}
              </option>
            ))}
          </select>
        </div>
        <div className="actions">
          <button
            type="button"
            className="button button--primary"
            onClick={download}
            disabled={count === 0}
          >
            ファイルを保存
          </button>
          <button
            type="button"
            className="button button--secondary"
            onClick={() => void copy()}
            disabled={count === 0}
          >
            クリップボードにコピー
          </button>
        </div>
      </div>

      <label className="checkbox">
        <input
          type="checkbox"
          checked={includeUnverified}
          onChange={(e) => setIncludeUnverified(e.target.checked)}
        />
        書誌情報を取得できなかったものも含める
      </label>

      <p className="note">書き出す件数: {count} 件</p>

      {message && (
        <p className="note" role="status">
          {message}
        </p>
      )}

      <div className="field">
        <label htmlFor="export-preview">書き出す内容</label>
        <textarea id="export-preview" className="preview" readOnly value={content} />
      </div>
    </div>
  )
}
