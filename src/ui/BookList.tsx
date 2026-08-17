import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ScoredCandidate, SourceId } from '../types'
import { formatIsbn13 } from '../lib/isbn'
import { thumbnailUrl } from '../sources/ndl'

/**
 * 書影。取得元を順に試して、全部駄目なら何も出さない。
 *
 * NDL の書影はプロキシ無しで表示できる(CORS は fetch にはかかるが
 * `<img>` にはかからない)ため、書誌データが NDL から取れない状態でも
 * ISBN さえ判っていれば絵は出せる。
 *
 * 一覧の主役は書名なので、表示は小さく抑える(寸法は CSS 側で固定)。
 */
function BookCover({ isbn13, coverUrl }: { isbn13?: string; coverUrl?: string }) {
  const sources = useMemo(
    () => [coverUrl, isbn13 ? thumbnailUrl(isbn13) : undefined].filter((v): v is string => !!v),
    [coverUrl, isbn13],
  )
  const [index, setIndex] = useState(0)

  // 書影が無い ISBN では 404 が返る。その場合は次の候補へ。
  // 全部駄目でも枠だけは残す。ここで幅を失うと行ごとに書名の頭がずれる
  if (index >= sources.length) return <span className="record__cover" aria-hidden="true" />

  return (
    <img
      className="record__cover"
      src={sources[index]}
      alt=""
      loading="lazy"
      decoding="async"
      onError={() => setIndex((i) => i + 1)}
    />
  )
}

/**
 * 行の状態を説明する文。色ではなく文章で伝える。
 * 確定済みは書名と書誌が出ていること自体が結果なので、文を出さない。
 */
const STATE_TEXT: Record<BookEntry['status'], string | null> = {
  confirmed: null,
  needsReview: '候補が複数あります。正しいものを選んでください。',
  conflict: '取得元によって内容が異なります。下の差分を確認してください。',
  notFound: '書誌情報が見つかりませんでした。ISBNを確認して、もう一度読み取ってください。',
  unverified: '書誌情報を取得していません。',
  excluded: '書き出しの対象から除いています。',
}

/** 状態が問題を示すものか。文章と併せて色も添える場合の判定に使う */
const STATE_IS_PROBLEM: Record<BookEntry['status'], boolean> = {
  confirmed: false,
  needsReview: false,
  conflict: false,
  notFound: true,
  unverified: true,
  excluded: false,
}

const SOURCE_LABEL: Record<SourceId, string> = {
  vlm: '読み取り',
  ocr: 'OCR',
  manual: '手入力',
  googleBooks: 'Google Books',
  ndl: '国立国会図書館サーチ',
  openbd: 'openBD',
  barcode: 'バーコード',
}

const FIELD_LABEL: Record<string, string> = {
  title: '書名',
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
  /** 一覧から完全に削除する */
  onDelete: (entryId: string) => void
}

type RowProps = { entry: BookEntry } & Omit<Props, 'entries'>

/** 全候補をソース混在でスコア順に並べる */
function allCandidates(entry: BookEntry): ScoredCandidate[] {
  return Object.values(entry.candidates)
    .flat()
    .filter((c): c is ScoredCandidate => !!c)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function BookRow({ entry, onAdopt, onExclude, onRestore, onDelete }: RowProps) {
  const r = entry.resolved
  const candidates = allCandidates(entry)
  // 確定済みのものは候補を畳んでおく。人間が触るべきものだけを目立たせる
  const showCandidates =
    entry.status !== 'confirmed' && entry.status !== 'excluded' && candidates.length > 0

  const [confirming, setConfirming] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)

  // 確認を出したら、そのままキーボードで応答できるようにする
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  const title = (r?.title ?? entry.extracted.title) || '(書名未取得)'
  const authors = r?.authors?.join('、') || entry.extracted.authors.join('、')
  const stateText = STATE_TEXT[entry.status]

  return (
    <li className="record" data-excluded={entry.status === 'excluded'}>
      <div className="record__main">
        <BookCover isbn13={r?.isbn13} coverUrl={r?.coverUrl} />
        <div className="record__body">
          {/* 書名を最も強くする */}
          <h3 className="record__title">{title}</h3>

          {authors && <p className="record__authors">{authors}</p>}

          {/* 出版社・出版年 → ISBN → シリーズ の順。いずれも補助情報 */}
          {(r?.publisher || r?.published || r?.isbn13 || r?.series) && (
            <p className="record__meta">
              {r.publisher && <span>{r.publisher}</span>}
              {r.published && <span>{r.published}</span>}
              {r.isbn13 && <span className="record__isbn">ISBN {formatIsbn13(r.isbn13)}</span>}
              {r.series && <span>{r.series}</span>}
            </p>
          )}

          {stateText && (
            <p
              className="record__state"
              data-kind={STATE_IS_PROBLEM[entry.status] ? 'error' : 'normal'}
            >
              {stateText}
            </p>
          )}

          {entry.pinned && <p className="record__state">手動で確定した内容です。</p>}

          {!r?.title && entry.rawText && (
            <p className="record__state">読み取った内容: {entry.rawText}</p>
          )}
        </div>
      </div>

      {entry.conflicts && entry.conflicts.length > 0 && (
        <div className="diff">
          <b>取得元による違い</b>
          <dl>
            {entry.conflicts.map((c) => (
              <div key={c.field} className="diff__pair">
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
        <ul className="candidates">
          {candidates.map((c, i) => (
            <li key={`${c.record.source}-${i}`}>
              <button
                type="button"
                className="candidate"
                onClick={() => onAdopt(entry.id, c)}
              >
                <span className="candidate__text">
                  {c.record.title}
                  {c.record.authors.length > 0 && `／${c.record.authors.join('、')}`}
                </span>
                <span className="candidate__meta">
                  {SOURCE_LABEL[c.record.source]}　一致度 {Math.round(c.score * 100)}%
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <div className="record__actions">
        {entry.status === 'excluded' ? (
          <button
            type="button"
            className="button button--compact"
            onClick={() => onRestore(entry.id)}
          >
            書き出しの対象に戻す
          </button>
        ) : (
          <button
            type="button"
            className="button button--compact"
            onClick={() => onExclude(entry.id)}
          >
            書き出しの対象から除く
          </button>
        )}
        <button
          type="button"
          className="button button--compact"
          aria-expanded={confirming}
          onClick={() => setConfirming(true)}
        >
          削除
        </button>
      </div>

      {confirming && (
        <div className="confirm" role="group" aria-label={`${title} の削除確認`}>
          <p>
            この本を一覧から削除します。削除すると元に戻せません。
            <br />
            {title}
          </p>
          <div className="actions">
            <button
              type="button"
              ref={confirmRef}
              className="button button--danger button--compact"
              onClick={() => {
                setConfirming(false)
                onDelete(entry.id)
              }}
            >
              削除する
            </button>
            <button
              type="button"
              className="button button--compact"
              onClick={() => setConfirming(false)}
            >
              削除しない
            </button>
          </div>
        </div>
      )}
    </li>
  )
}

export function BookList({ entries, onAdopt, onExclude, onRestore, onDelete }: Props) {
  if (entries.length === 0) {
    return (
      <div className="panel stack">
        <p>登録された本はまだありません。</p>
        <p className="note">
          カメラを開始して本のバーコードをかざすと、読み取った順にここへ並びます。
        </p>
      </div>
    )
  }

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1
    return acc
  }, {})
  const unresolved = (counts.notFound ?? 0) + (counts.unverified ?? 0)

  return (
    <>
      <ul className="status-line">
        <li>
          全 <b>{entries.length}</b> 件
        </li>
        {counts.confirmed ? (
          <li>
            書誌情報あり <b>{counts.confirmed}</b> 件
          </li>
        ) : null}
        {counts.needsReview ? (
          <li>
            要確認 <b>{counts.needsReview}</b> 件
          </li>
        ) : null}
        {counts.conflict ? (
          <li>
            差分あり <b>{counts.conflict}</b> 件
          </li>
        ) : null}
        {unresolved ? (
          <li>
            書誌情報なし <b>{unresolved}</b> 件
          </li>
        ) : null}
        {counts.excluded ? (
          <li>
            除外 <b>{counts.excluded}</b> 件
          </li>
        ) : null}
      </ul>

      <ul className="record-list">
        {entries.map((e) => (
          <BookRow
            key={e.id}
            entry={e}
            onAdopt={onAdopt}
            onExclude={onExclude}
            onRestore={onRestore}
            onDelete={onDelete}
          />
        ))}
      </ul>
    </>
  )
}
