import type { Settings } from '../types'

interface Props {
  settings: Settings
  onChange: (next: Settings) => void
}

/**
 * 設定画面。
 * APIキーとプロキシURLはどちらも「利用者が自分で用意するもの」なので、
 * 何がどこに送られるのかをここで明示する。
 *
 * 並びは ラベル → 補足説明 → 入力欄 に統一する。
 */
export function SettingsPanel({ settings, onChange }: Props) {
  const set = <K extends keyof Settings>(key: K, value: Settings[K]) =>
    onChange({ ...settings, [key]: value })

  return (
    <div className="stack">
      <section className="section">
        <h2 className="section-title">背表紙の読み取り</h2>
        <div className="panel">
          <div className="field">
            <label htmlFor="provider">読み取りに使うサービス</label>
            <p className="field-hint">
              写真から背表紙を読み取るために、利用者ご自身のAPIキーを使います。キーはこのブラウザにのみ保存され、当サイトの提供者へ送信されることはありません。読み取りを実行したときだけ、写真が選んだサービスへ送信されます。
            </p>
            <select
              id="provider"
              value={settings.vlmProvider}
              onChange={(e) => set('vlmProvider', e.target.value as Settings['vlmProvider'])}
            >
              <option value="none">使用しない</option>
              <option value="anthropic">Anthropic (Claude)</option>
              <option value="gemini">Google Gemini</option>
            </select>
          </div>

          {settings.vlmProvider !== 'none' && (
            <>
              <div className="field">
                <label htmlFor="apikey">APIキー</label>
                <p className="field-hint">選んだサービスで発行したキーを入力してください。</p>
                <input
                  id="apikey"
                  type="password"
                  autoComplete="off"
                  value={settings.vlmApiKey}
                  onChange={(e) => set('vlmApiKey', e.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="model">モデル名</label>
                <p className="field-hint">
                  空欄のままにすると、既定のモデル（
                  {settings.vlmProvider === 'anthropic' ? 'claude-opus-5' : 'gemini-2.5-flash'}
                  ）を使います。
                </p>
                <input
                  id="model"
                  type="text"
                  value={settings.vlmModel}
                  onChange={(e) => set('vlmModel', e.target.value)}
                />
              </div>
            </>
          )}
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">国立国会図書館サーチ</h2>
        <div className="panel">
          <div className="field">
            <label htmlFor="ndlproxy">中継サーバのURL</label>
            <p className="field-hint">
              国立国会図書館サーチはブラウザから直接呼び出せないため、中継を経由します。既定の中継が設定されているので、通常は変更する必要はありません。空欄で保存すると既定に戻ります。末尾が <code>=</code> の場合は対象URLをエンコードして連結し、それ以外はパスとして連結します。
            </p>
            <input
              id="ndlproxy"
              type="text"
              value={settings.ndlProxyUrl}
              onChange={(e) => set('ndlProxyUrl', e.target.value)}
              placeholder="https://example.workers.dev/?url="
            />
          </div>
        </div>
      </section>

      <section className="section">
        <h2 className="section-title">Google Books</h2>
        <div className="panel">
          <div className="field">
            <label htmlFor="country">地域コード</label>
            <p className="field-hint">
              検索結果の地域を指定します。日本国内で使う場合は JP のままにしてください。
            </p>
            <input
              id="country"
              type="text"
              value={settings.googleBooksCountry}
              onChange={(e) => set('googleBooksCountry', e.target.value.toUpperCase())}
              placeholder="JP"
            />
          </div>
        </div>
      </section>
    </div>
  )
}
