/**
 * データモデル
 *
 * 設計の要点: 1冊の本を「確定した1レコード」として持たない。
 * 各書誌ソース(Google Books / NDL / openBD)からの候補を並列に保持し、
 * どのフィールドがどのソース由来かを provenance で追跡する。
 *
 * これにより「Google Books で一次確定 → 後から NDL と突合して差分を見る」
 * という段階実行が、破壊的な上書きなしに成立する。
 */

/** 書誌情報の出典 */
export type SourceId = 'vlm' | 'ocr' | 'manual' | 'googleBooks' | 'ndl' | 'openbd' | 'barcode'

/** 段階(ステージ)の識別子。パイプラインはこの順に進む */
export type StageId = 'extract' | 'googleBooks' | 'ndl' | 'openbd'

/** 各段階の実行状態。段階ごとに独立して持つので、片方が失敗しても他は残る */
export type StageStatus = 'idle' | 'running' | 'done' | 'error' | 'skipped'

/** 1件の書誌候補 */
export interface BibRecord {
  title: string
  /** 副題・シリーズ名など、タイトルに付随するもの */
  subtitle?: string
  authors: string[]
  publisher?: string
  /** 出版年 (YYYY)。NDL は YYYY-MM 形式も返すため文字列で保持 */
  published?: string
  /** 正規化済み ISBN-13。ISBN-10 は取り込み時に13へ変換する */
  isbn13?: string
  /** 元データに入っていた生の ISBN 表記(ハイフン込みなど) */
  isbnRaw?: string
  series?: string
  /** 書影URL */
  coverUrl?: string
  /** 内容紹介 */
  description?: string
  /** このレコードの出典 */
  source: SourceId
  /** 出典側の詳細ページURL */
  sourceUrl?: string
}

/** 候補 + 元テキストとの一致スコア */
export interface ScoredCandidate {
  record: BibRecord
  /** 0..1。元の背表紙テキストとの類似度 */
  score: number
}

/** 本1冊の状態 */
export type BookStatus =
  /** 抽出はできたが、まだ書誌DBで実在確認が取れていない */
  | 'unverified'
  /** 書誌DBでヒットし、自動確定に足る信頼度がある */
  | 'confirmed'
  /** 候補は出たが信頼度が低く、人間の判断待ち */
  | 'needsReview'
  /** 複数ソースの結果が食い違っている */
  | 'conflict'
  /** 書誌DBで見つからなかった */
  | 'notFound'
  /** 利用者が明示的に除外した */
  | 'excluded'

/** 写真上での背表紙の位置 (0..1 の相対座標) */
export interface BoundingBox {
  x: number
  y: number
  width: number
  height: number
}

/** 本1冊 */
export interface BookEntry {
  id: string
  /** どの写真から来たか */
  photoId: string
  /** 写真上の位置。VLM が返さない場合は undefined */
  box?: BoundingBox
  /** 背表紙から読み取った生テキスト */
  rawText: string
  /** 抽出段階でモデル/OCRが推定したタイトル・著者 */
  extracted: {
    title: string
    authors: string[]
    publisher?: string
  }
  /** 抽出段階の自己申告信頼度 (0..1) */
  extractConfidence?: number

  /** ソース別の候補。段階を進めるごとに追加される(上書きしない) */
  candidates: Partial<Record<SourceId, ScoredCandidate[]>>

  /** 現時点で採用している書誌情報 */
  resolved?: BibRecord
  /** resolved の各フィールドがどのソース由来か */
  provenance: Partial<Record<keyof BibRecord, SourceId>>

  status: BookStatus
  /** 利用者が手動で確定させたか。true なら以降の段階で自動上書きしない */
  pinned: boolean
  /** 突合で検出された差分の説明(UI表示用) */
  conflicts?: FieldConflict[]
}

/** ソース間でのフィールド不一致 */
export interface FieldConflict {
  field: keyof BibRecord
  values: { source: SourceId; value: string }[]
}

/** 取り込んだ写真 */
export interface Photo {
  id: string
  /** 元画像。IndexedDB に Blob で保存する */
  blob: Blob
  width: number
  height: number
  createdAt: number
}

/** プロジェクト(1回の棚卸し単位) */
export interface Project {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  /** 段階ごとの実行状態 */
  stages: Record<StageId, { status: StageStatus; ranAt?: number; message?: string }>
}

/** 設定。localStorage に保存する */
export interface Settings {
  /** BYOK: 利用者自身のAPIキー */
  vlmProvider: 'anthropic' | 'gemini' | 'none'
  vlmApiKey: string
  vlmModel: string
  /**
   * NDLサーチは CORS 非対応のため、ブラウザから直接呼べない。
   * 利用者が自分で用意した CORS プロキシの URL をここに設定したときのみ
   * NDL 突合の段階が有効になる。未設定なら機能は無効表示のまま。
   */
  ndlProxyUrl: string
  /** Google Books の言語・地域の絞り込み */
  googleBooksCountry: string
}

export const DEFAULT_SETTINGS: Settings = {
  vlmProvider: 'none',
  vlmApiKey: '',
  vlmModel: '',
  ndlProxyUrl: '',
  googleBooksCountry: 'JP',
}

/** 自動確定に必要な最低スコア。これ未満は人間の確認に回す */
export const AUTO_CONFIRM_THRESHOLD = 0.82
/** これ未満なら候補として提示すらしない */
export const CANDIDATE_FLOOR = 0.35
