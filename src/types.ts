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

/**
 * 背表紙から読み取った1冊分。書誌DBで実在確認する前の「照合クエリ」。
 *
 * バーコード経路は ISBN で完全一致が引けるが、背表紙経路は読み取り結果が
 * 曖昧なまま出てくる。両者はここで型を分けたまま、同じ照合処理に合流する
 * (pipeline/stages.ts の entriesFromExtraction / entriesFromIsbns)。
 */
export interface ExtractedSpine {
  title: string
  authors: string[]
  publisher?: string
  /** 読み取り側の自己申告信頼度 (0..1) */
  confidence: number
  /** 写真・映像上の位置 (0..1 相対座標)。判らないこともある */
  box?: BoundingBox
  /**
   * OCR が返した行の断片。
   *
   * 背表紙は「書名・著者・出版社」が同じ面に並んでいるだけで、
   * どの行が何かは読み取り側には確定できない。title に最有力行を入れつつ、
   * 全部の行をここに残しておき、照合側が複数のクエリを組み立てられるようにする。
   */
  fragments?: OcrFragment[]
  /** どの読み取り機構が出したか。差し替えたときに結果を見分けるため */
  engine?: 'tesseract' | 'remoteVision' | 'manual'
}

/** OCR が返した1行(または1語)ぶん */
export interface OcrFragment {
  text: string
  /** 0..1。OCR 自身の自己申告 */
  confidence: number
  /** 画像上の位置 (0..1 相対座標) */
  box?: BoundingBox
}

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
  /** 写真・映像上の位置。読み取り側が返さない場合は undefined */
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

  /*
   * ここから下は背表紙経路で足した項目。
   * 以前の版で保存された IndexedDB のレコードをそのまま読めるよう、
   * すべて optional にしてある。必須項目を足してはならない。
   */

  /** どの読み取り方式で入ったか。UI の導線（バーコード救済など）の出し分けに使う */
  inputKind?: 'barcode' | 'spine'
  /** 1回のカメラ起動を指す。スキャナ画面が「この読み取りで追加した本」を出すために使う */
  scanSessionId?: string
  /** 同じ背表紙を何コマから観測したか。多いほど読みが安定している */
  observationCount?: number
  /** 取り込んだクロップの簡易ハッシュ。連続コマ由来の重複を抑えるのに使う */
  visualHash?: string
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
}

/**
 * 同梱の NDL 中継プロキシ。
 *
 * NDLサーチは CORS 非対応でブラウザから直接呼べないため中継を挟む。
 * 秘密情報を含まないので公開して差し支えない。中継先は NDL に、
 * 呼び出し元はこのアプリの生成元に限定してある(proxy/ndl-worker.js)。
 *
 * 差し替え用の設定画面は持たない。設定項目がひとつでもあると
 * 「まず設定してから使うもの」に見え、かざすだけという性質が濁る。
 */
export const NDL_PROXY_URL = 'https://still-hall-1b04.popy48771.workers.dev/?url='

/** Google Books の言語・地域の絞り込み。日本語書籍を主に扱うため JP 固定 */
export const GOOGLE_BOOKS_COUNTRY = 'JP'

/** 自動確定に必要な最低スコア。これ未満は人間の確認に回す */
export const AUTO_CONFIRM_THRESHOLD = 0.82
/** これ未満なら候補として提示すらしない */
export const CANDIDATE_FLOOR = 0.35

/*
 * ── 背表紙経路の閾値 ─────────────────────────────────
 *
 * バーコードと違い、背表紙の読み取りは「それらしいが存在しない本」を出す。
 * したがって OCR の自己申告信頼度だけで確定させない。確定してよいのは
 *  - 複数の書誌ソースが同じ ISBN を返した
 *  - 正規化した書名がほぼ完全一致し、著者も一致した
 * のいずれかだけで、それ以外は人間の確認へ回す(pipeline/stages.ts)。
 *
 * 読み落としが多少あっても、誤った本を確定一覧へ混ぜない方を採る。
 */

/** 書名がこれ以上似ていれば「ほぼ完全一致」とみなす */
export const SPINE_TITLE_EXACT = 0.95
/** 著者がこれ以上似ていれば一致とみなす。表記揺れの幅を見込んで緩めにする */
export const SPINE_AUTHOR_MATCH = 0.8
/** 正規化してこの文字数に満たない読み取りは、当たっても確定させない */
export const SPINE_MIN_QUERY_LENGTH = 4
/**
 * 1冊あたりの書誌API呼び出し上限。読めない本に延々と問い合わせない。
 *
 * クエリは当たりやすい順に並んでいて、当たったところで打ち切る。したがって
 * 実際に上限まで使うのは「どのクエリでも引けなかった本」だけである。
 * 末尾を削った前方一致まで試す余地を持たせるため、ソースあたり3回とる。
 */
export const SPINE_MAX_LOOKUPS = 6
