/**
 * 同じ背表紙を二度取り込まないための追跡
 *
 * レーンを通過するあいだ、1冊の背表紙は何コマにも写る。素直に全部を
 * 処理すると、OCR の待ち行列が実際の冊数の何倍にも膨れ、一覧にも同じ本が
 * 並ぶ。抑止は二段階で行う。
 *
 *  1. OCR の前  … 見た目のハッシュで弾く(処理そのものを起こさない)
 *  2. OCR の後  … 読めた文字列で照合し、同じ本なら観測を1件に束ねる
 *
 * ── 窓の取り方が二段で違う理由 ────────────────────────
 * 1段目は「いまレーンに何が写っているか」の話なので、時間で測る。
 *
 * 2段目は違う。OCR は1冊あたり数秒かかり、待ち行列が伸びると、
 * 続けて撮った2枚が10秒以上離れて処理されることがある。ここを時間で測ると、
 * **同じ本が何行にも増える**(実際にそうなった)。2段目は「直近に読んだ何冊か」
 * という件数で測る。
 *
 * どちらの誤りが痛いかで決めている。
 *  - 誤って束ねる  … 同じ本を2冊持っていた場合に1行になる。まれで、読み直せる
 *  - 誤って分ける  … 1冊が何行にも増える。棚卸しのたびに起きて、手で消すことになる
 * 後者の方がはるかに痛い。
 */

import { normalizeForMatch } from '../normalize'
import { diceCoefficient } from '../similarity'
import { looksSame } from './capture'

/** 1冊ぶんの観測。同じ背表紙を複数コマから見た記録をまとめて持つ */
export interface SpineObservation {
  /** 一覧上の行(BookEntry)のID */
  entryId: string
  /** 照合キー。正規化済みの読み取り文字列 */
  key: string
  /** 最後に観測した時刻 (ms) */
  at: number
  /** 何コマから観測したか */
  count: number
}

export interface TrackerOptions {
  /** レーンに写っているとみなす時間の窓 (ms)。OCR 前の判定にだけ使う */
  windowMs?: number
  /** 直近いくつの観測と突き合わせるか。これを超えて古いものは別の本として扱う */
  recentCount?: number
  /** 文字列がこれ以上似ていれば同じ背表紙とみなす */
  similarity?: number
}

const DEFAULT_WINDOW_MS = 8000
const DEFAULT_RECENT_COUNT = 12
const DEFAULT_SIMILARITY = 0.72

/**
 * 時刻は必ず外から渡す。内部で now を読むとテストが書けなくなるうえ、
 * 端末の時計変更に振り回される。
 */
export class SpineTracker {
  private readonly windowMs: number
  private readonly recentCount: number
  private readonly similarity: number
  private captures: { hash: string; at: number }[] = []
  private observations: SpineObservation[] = []

  constructor(options: TrackerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.recentCount = options.recentCount ?? DEFAULT_RECENT_COUNT
    this.similarity = options.similarity ?? DEFAULT_SIMILARITY
  }

  /**
   * OCR にかける前の判定。いまレーンに写っているのと同じ見た目なら false。
   *
   * 一致したものは時刻を今に更新する。1冊の背表紙を眺めたまま止まっていても、
   * 窓が切れて撮り直すことがないようにするため。
   */
  shouldCapture(hash: string, now: number): boolean {
    this.expireCaptures(now)
    const seen = this.captures.find((c) => looksSame(c.hash, hash))
    if (!seen) return true
    seen.at = now
    return false
  }

  /** 取り込んだことを記録する。shouldCapture が true を返した直後に呼ぶ */
  noteCapture(hash: string, now: number): void {
    this.expireCaptures(now)
    this.captures.push({ hash, at: now })
  }

  /** OCR 後の判定。直近に読んだ何冊かに同じ文字列があればその観測を返す */
  findSame(text: string, _now?: number): SpineObservation | undefined {
    const key = normalizeForMatch(text)
    if (!key) return undefined

    let best: SpineObservation | undefined
    let bestScore = 0
    for (const o of this.observations) {
      const score = o.key === key ? 1 : diceCoefficient(o.key, key)
      if (score >= this.similarity && score > bestScore) {
        best = o
        bestScore = score
      }
    }
    return best
  }

  /**
   * 観測を記録する。同じ背表紙の再観測なら count を増やして同じ行を返す。
   * 呼び出し側は戻り値の entryId を見て、新しい行を作るか既存の行に足すかを決める。
   */
  note(entryId: string, text: string, now: number): SpineObservation {
    const existing = this.findSame(text)
    if (existing) {
      existing.at = now
      existing.count += 1
      // 読み直すたびに文字列は揺れる。より長く読めた方を代表にする
      const key = normalizeForMatch(text)
      if (key.length > existing.key.length) existing.key = key
      // 直近に読んだものとして扱い直す
      this.observations = [...this.observations.filter((o) => o !== existing), existing]
      return existing
    }
    const created: SpineObservation = { entryId, key: normalizeForMatch(text), at: now, count: 1 }
    this.observations.push(created)
    // 古い観測から捨てる。棚の離れた場所に同じ本が出たときは
    // 2冊持っている可能性があるので、黙って束ねない(§7.3)
    if (this.observations.length > this.recentCount) {
      this.observations = this.observations.slice(-this.recentCount)
    }
    return created
  }

  /** レーンから外れた記録を捨てる */
  private expireCaptures(now: number): void {
    this.captures = this.captures.filter((c) => c.at >= now - this.windowMs)
  }
}
