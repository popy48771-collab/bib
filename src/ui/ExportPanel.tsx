import { useMemo, useState } from 'react'
import type { BookEntry } from '../types'
import { EXPORT_META, exportableEntries, renderExport, type ExportFormat } from '../lib/export'

interface Props {
  entries: BookEntry[]
}

export function ExportPanel({ entries }: Props) {
  const [format, setFormat] = useState<ExportFormat>('csv')
  const [includeUnconfirmed, setIncludeUnconfirmed] = useState(false)
  const [message, setMessage] = useState<string | null>(null)

  const content = useMemo(
    () => renderExport(format, entries, includeUnconfirmed),
    [format, entries, includeUnconfirmed],
  )
  const count = exportableEntries(entries, includeUnconfirmed).length
  const unconfirmed = exportableEntries(entries, true).length - exportableEntries(entries, false).length

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

      {/*
        既定では確定したものだけを出す。背表紙から読み取ったものは
        誤同定がありうるので、確認前のものを黙って蔵書リストへ混ぜない。
      */}
      <label className="checkbox">
        <input
          type="checkbox"
          checked={includeUnconfirmed}
          onChange={(e) => setIncludeUnconfirmed(e.target.checked)}
        />
        確認が済んでいないもの（要確認・差分あり）も含める
      </label>

      <p className="note">
        書き出す件数: {count} 件
        {!includeUnconfirmed && unconfirmed > 0 && `（確認が済んでいない ${unconfirmed} 件を除いています）`}
      </p>

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
