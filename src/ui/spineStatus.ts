/**
 * 背表紙スキャナの状態表示
 *
 * 画面から切り出してあるのは、ここが**「いつ読み取りを終えてよいか」への答え**
 * だからである。1枚のコマに棚一段ぶんが写り、読み取りは数秒から十数秒かかる。
 * 撮った瞬間と読み終わった瞬間がずれるので、何もしないと利用者には
 * 「終わったのかどうか」が判らない。
 *
 * したがって次の順で見せる。上ほど優先する。
 *
 *  1. 使えない理由（カメラ・OCR・画質）
 *  2. 待たせている理由（処理が追いつかない／読み取り中で残りが何枚か）
 *  3. **この棚は読み終わったということ**
 *  4. 次にすること
 */

export interface SpineStatusInput {
  /** カメラが映っている */
  ready: boolean
  /** OCR の準備中 */
  preparing: boolean
  /** OCR の待ち行列が満杯 */
  busy: boolean
  /** OCR 待ちのコマ数 */
  ocrPending: number
  /** 書誌照合待ちの件数 */
  lookupPending: number
  /** この読み取りで撮った枚数 */
  captured: number
  /** 画質が足りない理由。無ければ null */
  advice: string | null
  /** 直近の取り込み結果 */
  lastOutcome: 'queued' | 'duplicate' | 'busy' | 'unavailable' | null
}

export interface SpineStatusView {
  kind: 'idle' | 'searching' | 'success' | 'duplicate'
  label: string
  detail?: string
  /**
   * 読み取りを終えてよい状態か。
   * 主操作のボタンに添える説明を出し分けるのに使う。
   */
  settled: boolean
}

/** 現在の状態。色ではなく文で伝える */
export function describeSpineStatus(input: SpineStatusInput): SpineStatusView {
  const pending = input.ocrPending + input.lookupPending

  if (!input.ready) {
    return {
      kind: 'idle',
      label: 'カメラを起動しています',
      detail: 'カメラの利用を許可してください。',
      settled: false,
    }
  }
  if (input.preparing) {
    return {
      kind: 'idle',
      label: '文字の読み取りを準備しています',
      detail: '初回は読み込みに少し時間がかかります。そのままお待ちください。',
      settled: false,
    }
  }
  if (input.busy) {
    return {
      kind: 'idle',
      label: '読み取りが追いついていません',
      detail: '読み取りが終わるまでお待ちください。撮ったぶんは順に処理します。',
      settled: false,
    }
  }
  if (input.advice) {
    return {
      kind: 'idle',
      label: '読み取れる状態ではありません',
      detail: input.advice,
      settled: false,
    }
  }
  if (input.lastOutcome === 'queued') {
    return {
      kind: 'success',
      label: '棚を1枚取り込みました',
      detail: '読み取っています。次の段へ移して構いません。',
      settled: false,
    }
  }

  /*
   * 残りがあるあいだは、必ず残りを見せる。
   * ここを「取り込み済みです」で覆ってしまうと、まだ処理中なのに
   * 終わったように見えてしまう。
   */
  if (input.ocrPending > 0) {
    return {
      kind: 'searching',
      label: `棚の写真を ${input.ocrPending} 枚 読み取っています`,
      detail: '次の段へ移して構いません。撮ったぶんは順に処理します。',
      settled: false,
    }
  }
  if (input.lookupPending > 0) {
    return {
      kind: 'searching',
      label: `書誌情報を ${input.lookupPending} 件 調べています`,
      detail: '次の段へ移して構いません。',
      settled: false,
    }
  }

  // 撮った枚数があり、残りが無く、いま映っている棚も取り込み済み = 終わってよい
  if (input.captured > 0 && input.lastOutcome === 'duplicate') {
    return {
      kind: 'duplicate',
      label: 'この棚は読み取り終わりました',
      detail: '次の段へ移すか、「読み取りを終える」を押してください。',
      settled: true,
    }
  }
  if (input.captured > 0 && pending === 0) {
    return {
      kind: 'searching',
      label: '次の棚を探しています',
      detail: 'まだ読んでいない段があれば、枠に収めて少し止めてください。',
      settled: true,
    }
  }
  return {
    kind: 'searching',
    label: '棚を探しています',
    detail: '棚の一段を枠に収めて、少し止めてください。',
    settled: false,
  }
}

/**
 * 主操作のボタンに添える説明。
 *
 * カメラを閉じても待ち行列は捌き切るので、そのことを言っておかないと
 * 「途中で止めてしまうのでは」と押せなくなる。
 */
export function describeCloseHint(input: {
  ocrPending: number
  lookupPending: number
  captured: number
}): string | null {
  const pending = input.ocrPending + input.lookupPending
  if (pending > 0) return '読み取りを終えても、残りの処理は最後まで続きます。'
  if (input.captured > 0) return 'この読み取りの処理はすべて終わっています。'
  return null
}
