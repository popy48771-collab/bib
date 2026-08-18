/**
 * 実機診断（`?debug=1` のときだけ動く）
 *
 * ── なぜ要るか ──────────────────────────────────────
 * 背表紙経路の閾値は、いまも「実機で調整する前提の初期値」である。
 * ところが実機では**中身が見えない**。読めなかったときに、
 *
 *  - そもそも短冊に切れていないのか
 *  - 切れてはいるが極性の判定を外したのか
 *  - 画像は良いが OCR が読めていないのか
 *  - 読めてはいるが書誌照合で落ちているのか
 *
 * の区別がつかない。区別がつかないまま閾値を触ると、当てずっぽうになる。
 * そこで取り込んだコマ・切り出した短冊・短冊ごとの生テキスト・所要時間を
 * 直近ぶんだけ持ち、画面で見られるようにして、JSON で書き出せるようにする。
 * CLAUDE.md §10 の「精度の実測」の入り口である。
 *
 * ── 通常の利用には一切影響させない ────────────────────
 * `enabled` が false のあいだ、記録は何も持たない（記録の関数はすぐ返る）。
 * 画面の部品は遅延 import なので、通常のバンドルにも入らない。
 */

import type { FrameQuality } from './capture'
import type { SpineBand } from './segment'

/** 短冊1本ぶんの記録 */
export interface StripDiagnostic {
  index: number
  band: SpineBand
  /** OCR が返した生の文字列。整形前 */
  text: string
  /** その短冊から取れた冊数 */
  spines: number
  /** OCR にかかった時間 (ms) */
  ms: number
  /** OCR にかけた画像（前処理済み） */
  image?: Blob
}

/**
 * 書誌照合1リクエストぶんの記録。
 *
 * 実機の報告は「読めない」と「読めても書誌が引けない」が重なって届く。
 * コマと短冊の記録だけでは後者が見えない（照合の失敗は画面に「見つからず」
 * としか出ず、**中継の403なのか・0件なのか・例外なのかを区別できない**）。
 * そこで、どの本にどのクエリを撃って何が返ったかを1リクエストずつ残す。
 */
export interface LookupDiagnostic {
  at: number
  /** どの本の照合か。行の rawText の先頭 */
  entryText: string
  source: 'ndl' | 'googleBooks' | 'openbd'
  /** 実際に撃ったクエリ（title / any は文字列、isbn は ISBN そのもの） */
  query: string
  mode: 'title' | 'any' | 'isbn'
  /** 返ってきた件数。失敗したときは undefined で error に理由が入る */
  hits?: number
  /** 失敗の理由。通信エラー・HTTPエラーなど */
  error?: string
  ms: number
}

/** 1冊ぶんの照合の着地点。クエリの記録と突き合わせて読む */
export interface ResolutionDiagnostic {
  at: number
  entryText: string
  /** 照合後の状態（confirmed / needsReview / notFound / conflict） */
  status: string
  /** 最上位候補。無ければ undefined */
  topTitle?: string
  topIsbn?: string
  topScore?: number
}

/** コマ1枚ぶんの記録 */
export interface FrameDiagnostic {
  id: string
  at: number
  width: number
  height: number
  quality?: FrameQuality
  /** 切り出した短冊の範囲 */
  bands: SpineBand[]
  /** 短冊で読んだか、コマ全体へ退避したか */
  mode: 'strips' | 'frame'
  strips: StripDiagnostic[]
  /** そのコマから取れた冊数 */
  spines: number
  /** 取り込みから読み終わりまで (ms) */
  ms: number
  /** 取り込んだコマ（確認用の縮小版） */
  preview?: Blob
}

/**
 * 保持する枚数。
 *
 * 1枚につき原寸のコマと短冊 20〜30本ぶんの画像を持つので、ここを大きく
 * すると端末の記憶域を食う。原因を見るには数枚あれば足りる。
 */
const DEFAULT_LIMIT = 8

/**
 * 照合の記録の保持件数。
 *
 * 1冊で最大 SPINE_MAX_LOOKUPS 回のリクエストが飛び、棚1枚から20〜30冊入る。
 * 文字列だけなので枚数の制限より緩くてよいが、無制限には持たない。
 */
const LOOKUP_LIMIT = 120
const RESOLUTION_LIMIT = 60

/**
 * 記録の入れ物。
 *
 * 単一の実体を共有する。React の外（OCR の待ち行列の中）から書き込むので、
 * 購読者へは変更を通知する形にしておく。
 */
export class SpineDiagnosticsLog {
  enabled = false

  private readonly limit: number
  private frames: FrameDiagnostic[] = []
  private lookupLog: LookupDiagnostic[] = []
  private resolutionLog: ResolutionDiagnostic[] = []
  private listeners = new Set<() => void>()
  private snapshot: readonly FrameDiagnostic[] = []
  private lookupSnapshot: readonly LookupDiagnostic[] = []
  private resolutionSnapshot: readonly ResolutionDiagnostic[] = []
  private serial = 0

  constructor(limit = DEFAULT_LIMIT) {
    this.limit = Math.max(1, limit)
  }

  /** 診断を有効にする。無効へ戻すときは記録も捨てる */
  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return
    this.enabled = enabled
    if (!enabled) {
      this.frames = []
      this.lookupLog = []
      this.resolutionLog = []
    }
    this.publish()
  }

  /**
   * コマ1枚の記録を始める。無効なときは null を返し、呼び出し側は何もしない。
   */
  begin(frame: { width: number; height: number; at: number; quality?: FrameQuality }): string | null {
    if (!this.enabled) return null
    const id = `frame-${++this.serial}`
    const created: FrameDiagnostic = {
      id,
      at: frame.at,
      width: frame.width,
      height: frame.height,
      quality: frame.quality,
      bands: [],
      mode: 'strips',
      strips: [],
      spines: 0,
      ms: 0,
    }
    this.frames = [...this.frames, created].slice(-this.limit)
    this.publish()
    return id
  }

  /** 記録を1件だけ書き換える。無効・見つからないときは何もしない */
  update(id: string | null, patch: Partial<FrameDiagnostic>): void {
    if (!this.enabled || !id) return
    let changed = false
    this.frames = this.frames.map((f) => {
      if (f.id !== id) return f
      changed = true
      return { ...f, ...patch }
    })
    if (changed) this.publish()
  }

  /** 短冊1本ぶんを足す */
  addStrip(id: string | null, strip: StripDiagnostic): void {
    if (!this.enabled || !id) return
    let changed = false
    this.frames = this.frames.map((f) => {
      if (f.id !== id) return f
      changed = true
      return { ...f, strips: [...f.strips, strip] }
    })
    if (changed) this.publish()
  }

  /** 書誌照合1リクエストぶんを足す */
  addLookup(lookup: LookupDiagnostic): void {
    if (!this.enabled) return
    this.lookupLog = [...this.lookupLog, lookup].slice(-LOOKUP_LIMIT)
    this.publish()
  }

  /** 1冊ぶんの照合の着地点を足す */
  addResolution(resolution: ResolutionDiagnostic): void {
    if (!this.enabled) return
    this.resolutionLog = [...this.resolutionLog, resolution].slice(-RESOLUTION_LIMIT)
    this.publish()
  }

  list(): readonly FrameDiagnostic[] {
    return this.snapshot
  }

  listLookups(): readonly LookupDiagnostic[] {
    return this.lookupSnapshot
  }

  listResolutions(): readonly ResolutionDiagnostic[] {
    return this.resolutionSnapshot
  }

  clear(): void {
    this.frames = []
    this.lookupLog = []
    this.resolutionLog = []
    this.publish()
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /**
   * useSyncExternalStore から読むので、同じ内容なら同じ配列を返す必要がある
   * （毎回新しい配列を返すと無限に再描画される）。
   */
  private publish(): void {
    this.snapshot = this.frames
    this.lookupSnapshot = this.lookupLog
    this.resolutionSnapshot = this.resolutionLog
    for (const listener of this.listeners) listener()
  }
}

export const spineDiagnostics = new SpineDiagnosticsLog()

/** 書き出す JSON の形。画像は別に data URL で足す */
export interface DiagnosticsReport {
  generatedAt: string
  frames: {
    id: string
    at: string
    width: number
    height: number
    quality?: FrameQuality
    mode: FrameDiagnostic['mode']
    bandCount: number
    spines: number
    ms: number
    strips: { index: number; band: SpineBand; text: string; spines: number; ms: number }[]
  }[]
  /** 書誌照合のリクエスト履歴。読めても書誌が引けないときはここを見る */
  lookups: (Omit<LookupDiagnostic, 'at'> & { at: string })[]
  /** 1冊ごとの照合の着地点 */
  resolutions: (Omit<ResolutionDiagnostic, 'at'> & { at: string })[]
}

/**
 * 記録を書き出せる形にする。画像は含めない（純関数として検査できるように）。
 *
 * 画像は UI 側で data URL に直して足す。ここで Blob を触ると、
 * この関数だけ環境に依存してしまう。
 */
export function buildReport(
  frames: readonly FrameDiagnostic[],
  generatedAt = Date.now(),
  lookups: readonly LookupDiagnostic[] = [],
  resolutions: readonly ResolutionDiagnostic[] = [],
): DiagnosticsReport {
  return {
    generatedAt: new Date(generatedAt).toISOString(),
    lookups: lookups.map((l) => ({ ...l, at: new Date(l.at).toISOString() })),
    resolutions: resolutions.map((r) => ({ ...r, at: new Date(r.at).toISOString() })),
    frames: frames.map((f) => ({
      id: f.id,
      at: new Date(f.at).toISOString(),
      width: f.width,
      height: f.height,
      quality: f.quality,
      mode: f.mode,
      bandCount: f.bands.length,
      spines: f.spines,
      ms: f.ms,
      strips: f.strips.map((s) => ({
        index: s.index,
        band: s.band,
        text: s.text,
        spines: s.spines,
        ms: s.ms,
      })),
    })),
  }
}
