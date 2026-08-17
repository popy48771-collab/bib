import { useMemo, useState } from 'react'
import type { BookEntry } from '../types'
import { EXPORT_META, exportableEntries, renderExport, type ExportFormat } from '../lib/export'

interface Props {
  entries: BookEntry[]
}

export function ExportPanel({ entries }: Props) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [includeUnverified, setIncludeUnverified] = useState(false)

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
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(content)
    } catch {
      /* クリップボードが使えない環境ではテキスト欄から手動コピーしてもらう */
    }
  }

  return (
    <div>
      <div className="export-row">
        <select
          value={format}
          onChange={(e) => setFormat(e.target.value as ExportFormat)}
          style={{ width: 'auto' }}
          aria-label="出力形式"
        >
          {(Object.keys(EXPORT_META) as ExportFormat[]).map((f) => (
            <option key={f} value={f}>
              {EXPORT_META[f].label}
            </option>
          ))}
        </select>
        <button className="primary" onClick={download} disabled={count === 0}>
          ダウンロード
        </button>
        <button onClick={copy} disabled={count === 0}>
          コピー
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', margin: 0 }}>
          <input
            type="checkbox"
            checked={includeUnverified}
            onChange={(e) => setIncludeUnverified(e.target.checked)}
            style={{ width: 'auto' }}
          />
          未確認も含める
        </label>
      </div>

      <p className="hint">出力対象: {count} 冊</p>

      <textarea className="preview" readOnly value={content} aria-label="出力プレビュー" />
    </div>
  )
}
