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
export const DEFAULT_SETTINGS = {
    vlmProvider: 'none',
    vlmApiKey: '',
    vlmModel: '',
    ndlProxyUrl: '',
    googleBooksCountry: 'JP',
};
/** 自動確定に必要な最低スコア。これ未満は人間の確認に回す */
export const AUTO_CONFIRM_THRESHOLD = 0.82;
/** これ未満なら候補として提示すらしない */
export const CANDIDATE_FLOOR = 0.35;
