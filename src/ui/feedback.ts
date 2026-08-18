/**
 * 読み取れたことを身体に返す。
 *
 * カメラを本棚へ向けているあいだ、利用者の目は棚か枠を見ていて画面の文字は
 * 追えない。撮れたかどうかは振動で伝えるのが確実で、これが無いと同じ棚を
 * 何度も撮り直すことになる。
 *
 * 対応していない端末（iOS Safari など）では何も起きない。それでよい。
 */
export function signalHit(pattern: number | number[] = 60): void {
  try {
    navigator.vibrate?.(pattern)
  } catch {
    /* 未対応。無視してよい */
  }
}
