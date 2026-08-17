/**
 * 手持ちのチャットAIに渡すプロンプト
 *
 * API ではなくチャットのUIに人間が貼る前提なので、
 * vlm.ts のシステムプロンプトとは書き分けている。
 *  - 構造化出力の機能が使えないので、JSON で返すことを本文で指示する
 *  - 前置きや解説が混ざると貼り戻しが面倒なので、それも抑制する
 * (とはいえモデルは説明文を付けがちなので、取り込み側は寛容に作ってある)
 */
export const CHAT_EXTRACTION_PROMPT = `この画像は本棚の写真です。写っている本の背表紙を読み取ってください。

読み取りの原則:
- 背表紙は縦書きが多く、90度回転しています。回転を考慮して読んでください。
- 実際に写真に写っている文字だけを報告してください。
- 装丁やレーベルの見た目から書名を推測して補完してはいけません。読めないものは読めないまま報告します。
- 写真に存在しない本を出力してはいけません。この結果は後で書誌データベースと照合されるため、推測で埋めると誤った本が混入します。
- 一部しか読めない場合は、読めた部分だけを報告し confidence を下げてください。
- 左から右の並び順で報告してください。

出力は次の JSON だけを返してください。前置きや解説は不要です。

{"books":[{"title":"書名","authors":["著者"],"publisher":"出版社","confidence":0.9}]}`

/** チャットAIの入口。プロンプトをURLに載せられるものは載せる */
export interface ChatTarget {
  id: string
  label: string
  /** プロンプトを渡すURLを作る。渡せないサービスは受け取らずに入口だけ返す */
  url(prompt: string): string
  /** URLパラメータでプロンプトを渡せるか。UIの説明を変えるために持つ */
  prefills: boolean
}

export const CHAT_TARGETS: ChatTarget[] = [
  {
    id: 'claude',
    label: 'Claude',
    // ?q= で入力欄に入る(非公式だが安定して動く)
    url: (p) => `https://claude.ai/new?q=${encodeURIComponent(p)}`,
    prefills: true,
  },
  {
    id: 'chatgpt',
    label: 'ChatGPT',
    // ?q= に対応するが、モバイルアプリでは反映されない報告がある。
    // 効かなくてもクリップボードから貼れるようにしてある
    url: (p) => `https://chatgpt.com/?q=${encodeURIComponent(p)}`,
    prefills: true,
  },
  {
    id: 'gemini',
    label: 'Gemini',
    // プロンプトを渡す公式のパラメータが見当たらないため入口のみ
    url: () => 'https://gemini.google.com/app',
    prefills: false,
  },
]
