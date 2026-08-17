/**
 * 画像の前処理
 *
 * 背表紙は細かい文字なので解像度が命だが、大きすぎると
 * 送信コスト(画像トークン)が跳ね上がる。上限に合わせて縮小する。
 */

/**
 * Claude の高解像度ビジョンの上限は長辺 2576px。
 * これを超える画像を送っても精度は上がらず、トークンだけ増える。
 */
export const MAX_IMAGE_EDGE = 2576

export interface EncodedImage {
  /** base64 (data URI プレフィックスなし) */
  base64: string
  mediaType: 'image/jpeg' | 'image/png'
  width: number
  height: number
}

/** Blob から ImageBitmap を作る。EXIF の向きも反映させる */
async function loadBitmap(blob: Blob): Promise<ImageBitmap> {
  return createImageBitmap(blob, { imageOrientation: 'from-image' })
}

/**
 * 長辺が maxEdge 以下になるよう縮小して JPEG に符号化する。
 * 既に十分小さければ拡大はしない。
 */
export async function encodeForVlm(
  blob: Blob,
  maxEdge = MAX_IMAGE_EDGE,
  quality = 0.9,
): Promise<EncodedImage> {
  const bitmap = await loadBitmap(blob)
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D コンテキストを取得できませんでした')
    ctx.drawImage(bitmap, 0, 0, width, height)

    const dataUrl = canvas.toDataURL('image/jpeg', quality)
    const comma = dataUrl.indexOf(',')
    if (comma < 0) throw new Error('画像の符号化に失敗しました')

    return { base64: dataUrl.slice(comma + 1), mediaType: 'image/jpeg', width, height }
  } finally {
    bitmap.close()
  }
}

/** 表示用の縮小サムネイル。IndexedDB とメモリを節約する */
export async function makeThumbnail(blob: Blob, maxEdge = 640): Promise<Blob> {
  const bitmap = await loadBitmap(blob)
  try {
    const longEdge = Math.max(bitmap.width, bitmap.height)
    const scale = longEdge > maxEdge ? maxEdge / longEdge : 1
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))

    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d')
    if (!ctx) throw new Error('Canvas 2D コンテキストを取得できませんでした')
    ctx.drawImage(bitmap, 0, 0, width, height)

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error('サムネイル生成に失敗しました'))),
        'image/jpeg',
        0.8,
      )
    })
  } finally {
    bitmap.close()
  }
}

/** 画像の実寸を得る */
export async function getDimensions(blob: Blob): Promise<{ width: number; height: number }> {
  const bitmap = await loadBitmap(blob)
  try {
    return { width: bitmap.width, height: bitmap.height }
  } finally {
    bitmap.close()
  }
}
