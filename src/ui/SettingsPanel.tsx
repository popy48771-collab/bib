import type { Settings } from '../types'

interface Props {
  settings: Settings
  onChange: (next: Settings) => void
}

/**
 * 設定画面。
 * APIキーとプロキシURLはどちらも「利用者が自分で用意するもの」なので、
 * 何がどこに送られるのかをここで明示する。
 */
export function SettingsPanel({ settings, onChange }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value })

  return (
    <details className="settings">
      <summary>設定（APIキー・NDLプロキシ）</summary>
      <div>
        <div className="field">
          <label htmlFor="provider">背表紙の読み取り方式</label>
          <select
            id="provider"
            value={settings.vlmProvider}
            onChange={(e) => set('vlmProvider', e.target.value as Settings['vlmProvider'])}
          >
            <option value="none">未設定（読み取りは使えません）</option>
            <option value="anthropic">Anthropic (Claude)</option>
            <option value="gemini">Google Gemini</option>
          </select>
          <p className="hint">
            写真から背表紙を読み取るために、利用者ご自身のAPIキーを使います。
            キーはこのブラウザの localStorage にのみ保存され、当アプリのサーバ（存在しません）には送信されません。
            読み取り実行時のみ、写真が選択したモデル提供元へ送信されます。
          </p>
        </div>

        {settings.vlmProvider !== 'none' && (
          <>
            <div className="field">
              <label htmlFor="apikey">APIキー</label>
              <input
                id="apikey"
                type="password"
                autoComplete="off"
                value={settings.vlmApiKey}
                onChange={(e) => set('vlmApiKey', e.target.value)}
                placeholder="sk-..."
              />
            </div>
            <div className="field">
              <label htmlFor="model">モデル名（省略時は既定値）</label>
              <input
                id="model"
                type="text"
                value={settings.vlmModel}
                onChange={(e) => set('vlmModel', e.target.value)}
                placeholder={settings.vlmProvider === 'anthropic' ? 'claude-opus-5' : 'gemini-2.5-flash'}
              />
            </div>
          </>
        )}

        <div className="field">
          <label htmlFor="ndlproxy">NDLサーチ用プロキシURL（任意）</label>
          <input
            id="ndlproxy"
            type="text"
            value={settings.ndlProxyUrl}
            onChange={(e) => set('ndlProxyUrl', e.target.value)}
            placeholder="https://your-proxy.example/?url="
          />
          <p className="hint">
            国立国会図書館サーチは CORS に対応していないため、ブラウザから直接呼び出せません。
            突合機能を使うには、ご自身で用意した CORS プロキシの URL を登録してください。
            未設定でも他の機能はすべて動作します。
            末尾が <code>=</code> の場合は対象URLをエンコードして連結し、それ以外はパスとして連結します。
          </p>
        </div>

        <div className="field">
          <label htmlFor="country">Google Books の地域コード</label>
          <input
            id="country"
            type="text"
            value={settings.googleBooksCountry}
            onChange={(e) => set('googleBooksCountry', e.target.value.toUpperCase())}
            placeholder="JP"
          />
        </div>
      </div>
    </details>
  )
}
