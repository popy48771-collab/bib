import type { BookEntry, ScoredCandidate, SourceId } from '../types'
import { formatIsbn13 } from '../lib/isbn'

const STATUS_LABEL: Record<BookEntry['status'], string> = {
  confirmed: '確定',
  needsReview: '要確認',
  conflict: '差分あり',
  notFound: '見つからず',
  unverified: '未確認',
  excluded: '除外',
}

const SOURCE_LABEL: Record<SourceId, string> = {
  vlm: '読み取り',
  ocr: 'OCR',
  manual: '手入力',
  googleBooks: 'Google Books',
  ndl: 'NDL',
  openbd: 'openBD',
  barcode: 'バーコード',
}

const FIELD_LABEL: Record<string, string> = {
  title: 'タイトル',
  authors: '著者',
  publisher: '出版社',
  published: '出版年',
  isbn13: 'ISBN',
}

interface Props {
  entries: BookEntry[]
  onAdopt: (entryId: string, candidate: ScoredCandidate) => void
  onExclude: (entryId: string) => void
  onRestore: (entryId: string) => void
}

/** 全候補をソース混在でスコア順に並べる */
function allCandidates(entry: BookEntry): ScoredCandidate[] {
  return Object.values(entry.candidates)
    .flat()
    .filter((c): c is ScoredCandidate => !!c)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function BookRow({ entry, onAdopt, onExclude, onRestore }: { entry: BookEntry } & Omit<Props, 'entries'>) {
  const r = entry.resolved
  const candidates = allCandidates(entry)
  // 確定済みのものは候補を畳んでおく。人間が触るべきものだけを目立たせる
  const showCandidates =
    entry.status !== 'confirmed' && entry.status !== 'excluded' && candidates.length > 0

  return (
    <li className="book" data-status={entry.status}>
      <h3>
        {(r?.title ?? entry.extracted.title) || '(タイトル不明)'}{' '}
        <span className="source-tag">{STATUS_LABEL[entry.status]}</span>
      </h3>

      <p className="meta">
        {[
          r?.authors?.join(', ') || entry.extracted.authors.join(', '),
          r?.publisher,
          r?.published,
          r?.isbn13 ? `ISBN ${formatIsbn13(r.isbn13)}` : '',
        ]
          .filter(Boolean)
          .join(' / ') || '書誌情報なし'}
      </p>

      {!r && entry.rawText && <p className="raw">読み取り: {entry.rawText}</p>}

      {entry.conflicts && entry.conflicts.length > 0 && (
        <div className="conflicts">
          <strong>ソース間で食い違いがあります</strong>
          <dl>
            {entry.conflicts.map((c) => (
              <div key={c.field} style={{ display: 'contents' }}>
                <dt>{FIELD_LABEL[c.field] ?? c.field}</dt>
                <dd>
                  {c.values.map((v) => `${SOURCE_LABEL[v.source]}: ${v.value}`).join(' ／ ')}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      )}

      {showCandidates && (
        <div className="candidates">
          {candidates.map((c, i) => (
            <button
              key={`${c.record.source}-${i}`}
              className="candidate"
              onClick={() => onAdopt(entry.id, c)}
            >
              <span className="score">{Math.round(c.score * 100)}%</span>
              <span style={{ flex: 1, minWidth: 0 }}>
                {c.record.title}
                {c.record.authors.length > 0 && ` — ${c.record.authors.join(', ')}`}
              </span>
              <span className="source-tag">{SOURCE_LABEL[c.record.source]}</span>
            </button>
          ))}
        </div>
      )}

      <div className="book-actions">
        {entry.status === 'excluded' ? (
          <button onClick={() => onRestore(entry.id)}>元に戻す</button>
        ) : (
          <button onClick={() => onExclude(entry.id)}>除外</button>
        )}
        {entry.pinned && <span className="source-tag">手動確定</span>}
      </div>
    </li>
  )
}

export function BookList({ entries, onAdopt, onExclude, onRestore }: Props) {
  if (entries.length === 0) {
    return <p className="hint">まだ本がありません。写真を取り込んで読み取りを実行してください。</p>
  }

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1
    return acc
  }, {})

  return (
    <>
      <div className="summary">
        <span className="chip">全 {entries.length} 冊</span>
        {counts.confirmed && (
          <span className="chip" data-tone="ok">
            確定 {counts.confirmed}
          </span>
        )}
        {counts.needsReview && (
          <span className="chip" data-tone="warn">
            要確認 {counts.needsReview}
          </span>
        )}
        {counts.conflict && <span className="chip">差分あり {counts.conflict}</span>}
        {(counts.notFound || counts.unverified) && (
          <span className="chip" data-tone="danger">
            未確認 {(counts.notFound ?? 0) + (counts.unverified ?? 0)}
          </span>
        )}
        {counts.excluded && <span className="chip">除外 {counts.excluded}</span>}
      </div>

      <ul className="book-list">
        {entries.map((e) => (
          <BookRow
            key={e.id}
            entry={e}
            onAdopt={onAdopt}
            onExclude={onExclude}
            onRestore={onRestore}
          />
        ))}
      </ul>
    </>
  )
}
