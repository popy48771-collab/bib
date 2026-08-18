/**
 * 直列キュー
 *
 * OCR も書誌照合も、同時に何本も走らせてはいけない。
 *  - OCR: スマートフォンで Worker を複数持つとメモリと発熱で落ちる
 *  - 照合: 同時に投げると Google Books に絞られる
 *
 * カメラの走査だけは止めない。読み取りが OCR の速さに引きずられると
 * 「かざすだけ」の速度が出ないので、取り込みと処理を切り離す。
 * ただし際限なく溜めると端末が保たないので、上限を設けて
 * 「少しゆっくり動かしてください」と伝えられるようにする。
 */

export interface SerialQueueOptions {
  /** 待ち行列に積める上限。超えた push は false を返す */
  capacity?: number
  /** 待ち件数が変わるたびに呼ばれる */
  onChange?: (pending: number) => void
}

export class SerialQueue {
  readonly capacity: number
  onChange?: (pending: number) => void

  private tasks: (() => Promise<unknown>)[] = []
  private running = false
  private idleWaiters: (() => void)[] = []

  constructor(options: SerialQueueOptions = {}) {
    this.capacity = options.capacity ?? Infinity
    this.onChange = options.onChange
  }

  /** 待ち件数(実行中の1件を含む) */
  get pending(): number {
    return this.tasks.length + (this.running ? 1 : 0)
  }

  get isFull(): boolean {
    return this.pending >= this.capacity
  }

  /**
   * 積む。満杯なら積まずに false を返す。
   * 「積めなかった」ことを呼び出し側が知れないと、黙って読み落とすことになる。
   */
  push(task: () => Promise<unknown>): boolean {
    if (this.isFull) return false
    this.tasks.push(task)
    this.notify()
    if (!this.running) void this.run()
    return true
  }

  /** 空になるまで待つ。カメラを閉じたあとも処理を続けるために使う */
  whenIdle(): Promise<void> {
    if (this.pending === 0) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.push(resolve))
  }

  private async run(): Promise<void> {
    this.running = true
    while (this.tasks.length > 0) {
      const task = this.tasks.shift()!
      try {
        await task()
      } catch {
        // 1件の失敗を他へ波及させない。失敗の報告は task 側の責任
      }
      this.notify()
    }
    this.running = false
    this.notify()

    const waiters = this.idleWaiters
    this.idleWaiters = []
    for (const w of waiters) w()
  }

  private notify(): void {
    this.onChange?.(this.pending)
  }
}
