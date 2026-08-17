/**
 * IndexedDB 永続化
 *
 * サーバを持たない設計なので、蔵書データはすべて利用者の端末に残る。
 * 写真は Blob のまま、書誌データは構造化オブジェクトとして保存する。
 */

import type { BookEntry, Photo, Project, Settings } from '../types'
import { DEFAULT_SETTINGS } from '../types'

const DB_NAME = 'bookshelf-scanner'
const DB_VERSION = 1

const STORE_PHOTOS = 'photos'
const STORE_ENTRIES = 'entries'
const STORE_PROJECTS = 'projects'

const SETTINGS_KEY = 'bookshelf-scanner:settings'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_PHOTOS)) {
        db.createObjectStore(STORE_PHOTOS, { keyPath: 'id' })
      }
      if (!db.objectStoreNames.contains(STORE_ENTRIES)) {
        const store = db.createObjectStore(STORE_ENTRIES, { keyPath: 'id' })
        store.createIndex('photoId', 'photoId', { unique: false })
      }
      if (!db.objectStoreNames.contains(STORE_PROJECTS)) {
        db.createObjectStore(STORE_PROJECTS, { keyPath: 'id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB を開けませんでした'))
  })
}

function promisify<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('IndexedDB 操作に失敗しました'))
  })
}

async function withStore<T>(
  storeName: string,
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => Promise<T> | T,
): Promise<T> {
  const db = await openDb()
  try {
    const tx = db.transaction(storeName, mode)
    const result = await fn(tx.objectStore(storeName))
    await new Promise<void>((resolve, reject) => {
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error ?? new Error('トランザクションに失敗しました'))
      tx.onabort = () => reject(tx.error ?? new Error('トランザクションが中断されました'))
    })
    return result
  } finally {
    db.close()
  }
}

// ── 写真 ──────────────────────────────────────────────

export function savePhoto(photo: Photo): Promise<void> {
  return withStore(STORE_PHOTOS, 'readwrite', async (s) => {
    await promisify(s.put(photo))
  })
}

export function getPhoto(id: string): Promise<Photo | undefined> {
  return withStore(STORE_PHOTOS, 'readonly', (s) => promisify(s.get(id)))
}

export function listPhotos(): Promise<Photo[]> {
  return withStore(STORE_PHOTOS, 'readonly', (s) => promisify(s.getAll()))
}

export function deletePhoto(id: string): Promise<void> {
  return withStore(STORE_PHOTOS, 'readwrite', async (s) => {
    await promisify(s.delete(id))
  })
}

// ── 本 ────────────────────────────────────────────────

export function saveEntries(entries: BookEntry[]): Promise<void> {
  return withStore(STORE_ENTRIES, 'readwrite', async (s) => {
    for (const e of entries) await promisify(s.put(e))
  })
}

export function listEntries(): Promise<BookEntry[]> {
  return withStore(STORE_ENTRIES, 'readonly', (s) => promisify(s.getAll()))
}

export function deleteEntry(id: string): Promise<void> {
  return withStore(STORE_ENTRIES, 'readwrite', async (s) => {
    await promisify(s.delete(id))
  })
}

export function clearEntries(): Promise<void> {
  return withStore(STORE_ENTRIES, 'readwrite', async (s) => {
    await promisify(s.clear())
  })
}

// ── プロジェクト ──────────────────────────────────────

export function saveProject(project: Project): Promise<void> {
  return withStore(STORE_PROJECTS, 'readwrite', async (s) => {
    await promisify(s.put(project))
  })
}

export function listProjects(): Promise<Project[]> {
  return withStore(STORE_PROJECTS, 'readonly', (s) => promisify(s.getAll()))
}

// ── 設定 ──────────────────────────────────────────────

/**
 * 設定は localStorage に置く。APIキーを含むため、
 * 保存されるのは利用者の端末内のみである旨を UI で明示すること。
 */
export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY)
    if (!raw) return { ...DEFAULT_SETTINGS }
    const parsed = JSON.parse(raw) as Partial<Settings>
    return { ...DEFAULT_SETTINGS, ...parsed }
  } catch {
    return { ...DEFAULT_SETTINGS }
  }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings))
}

export function clearApiKey(): void {
  const s = loadSettings()
  saveSettings({ ...s, vlmApiKey: '' })
}
