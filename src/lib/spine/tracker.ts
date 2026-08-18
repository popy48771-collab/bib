/**
 * 同じ背表紙を二度取り込まないための追跡
 *
 * 1冊の背表紙は、同じ棚にかざしているあいだ何コマにも写る。素直に全部を
 * 処理すると、OCR の待ち行列が実際の冊数の何倍にも膨れ、一覧にも同じ本が
 * 並ぶ。抑止は三段階で行う。
 *
 *  1. OCR の前  … 見た目のハッシュで弾く(処理そのものを起こさない)
 *  2. OCR の後  … **棚の上の位置**で束ねる
 *  3. その次    … 読めた文字列で束ねる
 *
 * ── なぜ位置で束ねるのが先なのか ──────────────────────
 * 最初は文字列だけで束ねていた。**実機で1つの棚から80件が並んだ。**
 *
 * 原因は、抑止をいちばん壊れているもの(OCR の文字列)に頼っていたことである。
 * 読みが部分的だと、同じ本がコマごとに「思考の整」「の整理学」と別の断片に
 * なり、類似度が閾値に届かず別の本として行が増える。**読みが悪いほど行が
 * 増える**という、いちばん困る性質になっていた。
 *
 * 同じ棚にかざしているあいだ、x≈0.30 にある短冊は次のコマでも同じ本である。
 * 位置は読み取りの精度に左右されない。だから位置を先に見る。
 *
 * 位置で束ねてよいのは「同じ棚を見ているあいだ」に限る。棚を移れば同じ
 * x に別の本が来るので、世代(shelf)が変わったら位置での照合はしない。
 * 同じコマの中の隣り合う短冊どうしも束ねてはならない(frameId で除ける)。
 *
 * ── 窓の取り方が段で違う理由 ─────────────────────────
 * 1段目は「いま何が写っているか」の話なので、時間で測る。
 *
 * 3段目は違う。OCR は1冊あたり数秒かかり、待ち行列が伸びると、
 * 続けて撮った2枚が10秒以上離れて処理されることがある。ここを時間で測ると、
 * **同じ本が何行にも増える**(実際にそうなった)。3段目は「直近に読んだ何冊か」
 * という件数で測る。
 *
 * どちらの誤りが痛いかで決めている。
 *  - 誤って束ねる  … 同じ本を2冊持っていた場合に1行になる。まれで、読み直せる
 *  - 誤って分ける  … 1冊が何行にも増える。棚卸しのたびに起きて、手で消すことになる
 * 後者の方がはるかに痛い。
 */

import { normalizeForMatch } from '../normalize'
import { diceCoefficient } from '../similarity'
import { hashDistance, looksSame } from './capture'
import type { SpineBand } from './segment'

/** 読み取った場所。位置での突き合わせに使う */
export interface SpineSite {
  /** コマの中での x 範囲 */
  band: SpineBand
  /** 同じコマの中の短冊どうしを束ねないための識別子 */
  frameId: number
  /** 棚の世代。またいだら位置では束ねない */
  shelf: number
}

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
  /** 最後に見た場所。次のコマで位置を突き合わせるのに使う */
  site?: SpineSite
}

export interface TrackerOptions {
  /** レーンに写っているとみなす時間の窓 (ms)。OCR 前の判定にだけ使う */
  windowMs?: number
  /** 直近いくつの観測と突き合わせるか。これを超えて古いものは別の本として扱う */
  recentCount?: number
  /** 文字列がこれ以上似ていれば同じ背表紙とみなす */
  similarity?: number
  /** 短冊がこれ以上重なっていれば同じ位置とみなす */
  overlap?: number
}

const DEFAULT_WINDOW_MS = 8000
/*
 * 1枚のコマから棚一段ぶん(20〜30冊)が入るので、突き合わせる相手も
 * それを超える件数を持っておく。少ないと、1枚を処理し終える前に
 * 最初の方の本が窓から押し出され、次のコマで同じ本がもう一度行になる。
 */
const DEFAULT_RECENT_COUNT = 80
const DEFAULT_SIMILARITY = 0.72
/*
 * 短冊の重なり。狭い方の幅に対する割合で測る。
 *
 * 短冊は隣へ 8% はみ出させて切ってあり(BAND_PAD)、コマごとに境界は数画素
 * ずれる。半分以上が重なっていれば同じ背表紙とみなしてよい。逆に隣の本とは、
 * はみ出しぶんしか重ならないので、この線なら取り違えない。
 */
const DEFAULT_OVERLAP = 0.5

/**
 * 棚が変わったとみなすハッシュ距離。
 *
 * 取り込みの重複判定(SIMILAR_HASH_DISTANCE=6)より緩い。手ぶれや露出の
 * 揺れで 6 を超えることは珍しくないが、それは「同じ棚を少しずれて見ている」
 * のであって、別の段ではない。位置で束ねてよい範囲はここまでとする。
 */
export const SHELF_HASH_DISTANCE = 18

/** 1次元の重なり。狭い方の幅に対する割合 (0..1) */
export function bandOverlap(a: SpineBand, b: SpineBand): number {
  const left = Math.max(a.start, b.start)
  const right = Math.min(a.end, b.end)
  const shared = right - left
  if (shared <= 0) return 0
  const narrowest = Math.min(a.end - a.start, b.end - b.start)
  if (narrowest <= 0) return 0
  return shared / narrowest
}

/**
 * 時刻は必ず外から渡す。内部で now を読むとテストが書けなくなるうえ、
 * 端末の時計変更に振り回される。
 */
export class SpineTracker {
  private readonly windowMs: number
  private readonly recentCount: number
  private readonly similarity: number
  private readonly overlap: number
  private captures: { hash: string; at: number }[] = []
  private observations: SpineObservation[] = []
  private shelf = 0
  private shelfHash: string | null = null

  constructor(options: TrackerOptions = {}) {
    this.windowMs = options.windowMs ?? DEFAULT_WINDOW_MS
    this.recentCount = options.recentCount ?? DEFAULT_RECENT_COUNT
    this.similarity = options.similarity ?? DEFAULT_SIMILARITY
    this.overlap = options.overlap ?? DEFAULT_OVERLAP
  }

  /**
   * OCR にかける前の判定。いま写っているのと同じ見た目なら false。
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

  /**
   * このコマが属する棚の世代を返す。
   *
   * 前に取り込んだコマと見た目が近ければ同じ棚を見ているとみなし、同じ世代を
   * 返す。位置での突き合わせは、この世代の中でだけ行う。
   */
  shelfFor(hash: string): number {
    if (this.shelfHash === null || hashDistance(this.shelfHash, hash) > SHELF_HASH_DISTANCE) {
      this.shelf += 1
    }
    this.shelfHash = hash
    return this.shelf
  }

  /**
   * OCR 後の判定。同じ背表紙の観測があれば返す。
   *
   * 位置を先に見る(同じ棚・別のコマ・短冊が重なっている)。位置で見つからない
   * ときだけ、読めた文字列で照合する。
   */
  findSame(text: string, _now?: number, site?: SpineSite): SpineObservation | undefined {
    if (site) {
      const here = this.observations.find(
        (o) =>
          o.site !== undefined &&
          o.site.shelf === site.shelf &&
          // 同じコマの中の隣り合う短冊は、重なっていても別の本である
          o.site.frameId !== site.frameId &&
          bandOverlap(o.site.band, site.band) >= this.overlap,
      )
      if (here) return here
    }

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
  note(entryId: string, text: string, now: number, site?: SpineSite): SpineObservation {
    const existing = this.findSame(text, now, site)
    if (existing) {
      existing.at = now
      existing.count += 1
      if (site) existing.site = site
      // 読み直すたびに文字列は揺れる。より長く読めた方を代表にする
      const key = normalizeForMatch(text)
      if (key.length > existing.key.length) existing.key = key
      // 直近に読んだものとして扱い直す
      this.observations = [...this.observations.filter((o) => o !== existing), existing]
      return existing
    }
    const created: SpineObservation = {
      entryId,
      key: normalizeForMatch(text),
      at: now,
      count: 1,
      site,
    }
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
