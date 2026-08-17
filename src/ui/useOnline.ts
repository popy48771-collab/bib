import { useEffect, useState } from 'react'

/**
 * ネットワークに繋がっているか。
 *
 * 書誌照合はすべて外部APIへの通信なので、切れている状態で
 * ボタンを押させると「通信エラー」しか返らない。押す前に伝える。
 *
 * navigator.onLine は「繋がっている」の保証にはならない(LANだけ生きている
 * 場合も true になる)が、「切れている」の検出には十分使える。
 */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() =>
    typeof navigator === 'undefined' ? true : navigator.onLine,
  )

  useEffect(() => {
    const goOnline = () => setOnline(true)
    const goOffline = () => setOnline(false)
    window.addEventListener('online', goOnline)
    window.addEventListener('offline', goOffline)
    return () => {
      window.removeEventListener('online', goOnline)
      window.removeEventListener('offline', goOffline)
    }
  }, [])

  return online
}
