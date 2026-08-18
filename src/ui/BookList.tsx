import { useEffect, useMemo, useRef, useState } from 'react'
import type { BookEntry, ScoredCandidate, SourceId } from '../types'
import { formatIsbn13 } from '../lib/isbn'
import { getPhoto } from '../lib/db'
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
 * 読み取った背表紙そのもの。
 *
 * 候補を選ぶとき、本棚まで見に戻らずに済むようにする。画像は端末内
 * (IndexedDB) にしかなく、容量不足などで保存できていないこともあるので、
 * 取れなければ黙って出さない。書誌一覧の作成はそれで止まらない。
 */
function SpineCropImage({ photoId }: { photoId: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    let disposed = false
    let objectUrl: string | null = null

    getPhoto(photoId)
      .then((photo) => {
        if (!photo || disposed) return
        objectUrl = URL.createObjectURL(photo.blob)
        setUrl(objectUrl)
      })
      .catch(() => undefined)

    return () => {
      disposed = true
      if (objectUrl) URL.revokeObjectURL(objectUrl)
    }
  }, [photoId])

  if (!url) return null
  return (
    <figure className="crop">
      <figcaption>読み取った背表紙</figcaption>
      {/* 説明は figcaption が担う。画像そのものは文章に置き換えられない */}
      <img src={url} alt="" loading="lazy" decoding="async" />
    </figure>
  )
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

/**
 * 行の状態を説明する文。色ではなく文章で伝える。
 * 確定済みは書名と書誌が出ていること自体が結果なので、文を出さない。
 *
 * 次にすべきことは読み取り方式で変わる。バーコードなら読み直せばよいが、
 * 背表紙は読み直しても同じ結果になりやすく、文字を直すかバーコードへ
 * 移る方が早い。
 */
function stateText(entry: BookEntry): string | null {
  const spine = entry.inputKind === 'spine'
  switch (entry.status) {
    case 'confirmed':
      return null
    case 'needsReview':
      return '候補が複数あります。正しいものを選んでください。'
    case 'conflict':
      return '取得元によって内容が異なります。下の差分を確認してください。'
    case 'notFound':
      return spine
        ? '書誌情報が見つかりませんでした。読み取り文字を直すか、バーコードで確定してください。'
        : '書誌情報が見つかりませんでした。ISBNを確認して、もう一度読み取ってください。'
    case 'unverified':
      return '書誌情報を取得していません。'
    case 'excluded':
      return '書き出しの対象から除いています。'
  }
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

/** 手を入れる必要がある行か。確定済みと除外済み以外はすべて当てはまる */
export function needsAttention(entry: BookEntry): boolean {
  return entry.status !== 'confirmed' && entry.status !== 'excluded'
}

interface Props {
  /** 一覧に入っている全件。件数の内訳はこちらから数える */
  entries: BookEntry[]
  /** true なら、手を入れる必要がある行だけを描く */
  onlyAttention?: boolean
  onAdopt: (entryId: string, candidate: ScoredCandidate) => void
  onExclude: (entryId: string) => void
  onRestore: (entryId: string) => void
  /** 一覧から完全に削除する */
  onDelete: (entryId: string) => void
  /** 読み取り文字を直して照合し直す。背表紙経路の救済 */
  onEditText?: (entryId: string, text: string) => void
  /** この行をバーコードで確定させる。新しい行は増やさない */
  onRescue?: (entryId: string) => void
  /** いまバーコードで確定させようとしている行 */
  rescuingId?: string | null
  /** バーコードによる確定をやめる */
  onCancelRescue?: () => void
}

type RowProps = { entry: BookEntry } & Omit<Props, 'entries' | 'onlyAttention'>

/** 全候補をソース混在でスコア順に並べる */
function allCandidates(entry: BookEntry): ScoredCandidate[] {
  return Object.values(entry.candidates)
    .flat()
    .filter((c): c is ScoredCandidate => !!c)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5)
}

function BookRow({
  entry,
  onAdopt,
  onExclude,
  onRestore,
  onDelete,
  onEditText,
  onRescue,
  rescuingId,
  onCancelRescue,
}: RowProps) {
  const r = entry.resolved
  const candidates = allCandidates(entry)
  // 確定済みのものは候補を畳んでおく。人間が触るべきものだけを目立たせる
  const settled = entry.status === 'confirmed' || entry.status === 'excluded'
  const showCandidates = !settled && candidates.length > 0
  const fromSpine = entry.inputKind === 'spine'

  const [confirming, setConfirming] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(entry.rawText)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const editRef = useRef<HTMLTextAreaElement>(null)

  // 確認を出したら、そのままキーボードで応答できるようにする
  useEffect(() => {
    if (confirming) confirmRef.current?.focus()
  }, [confirming])

  // 開いた時点の内容を入れる。entry を依存に入れると、編集中に照合結果が
  // 返ってきたときに入力中の文字が打ち消される
  useEffect(() => {
    if (editing) {
      setDraft(entry.rawText)
      editRef.current?.focus()
    }
  }, [editing]) // eslint-disable-line react-hooks/exhaustive-deps

  const title = (r?.title ?? entry.extracted.title) || '(書名未取得)'
  const authors = r?.authors?.join('、') || entry.extracted.authors.join('、')
  const state = stateText(entry)
  const rescuing = rescuingId === entry.id

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

          {state && (
            <p
              className="record__state"
              data-kind={STATE_IS_PROBLEM[entry.status] ? 'error' : 'normal'}
            >
              {state}
            </p>
          )}

          {entry.pinned && <p className="record__state">手動で確定した内容です。</p>}

          {!r?.title && entry.rawText && (
            <p className="record__state">読み取った内容: {entry.rawText.split('\n').join(' / ')}</p>
          )}
        </div>
      </div>

      {/* 候補を選ぶときは、読み取った背表紙そのものを並べて見比べられるようにする */}
      {fromSpine && !settled && <SpineCropImage photoId={entry.photoId} />}

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
        {fromSpine && !settled && onEditText && (
          <button
            type="button"
            className="button button--compact"
            aria-expanded={editing}
            onClick={() => setEditing((v) => !v)}
          >
            読み取り文字を修正
          </button>
        )}
        {!settled && onRescue && !rescuing && (
          <button
            type="button"
            className="button button--compact"
            onClick={() => onRescue(entry.id)}
          >
            バーコードで確定
          </button>
        )}
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

      {rescuing && (
        <p className="record__state" role="status">
          この本のバーコードを読み取っています。上のカメラに裏表紙のバーコードをかざしてください。{' '}
          {onCancelRescue && (
            <button type="button" className="button button--compact" onClick={onCancelRescue}>
              やめる
            </button>
          )}
        </p>
      )}

      {editing && onEditText && (
        <form
          className="record__edit"
          onSubmit={(e) => {
            e.preventDefault()
            setEditing(false)
            onEditText(entry.id, draft)
          }}
        >
          <div className="field">
            <label htmlFor={`edit-${entry.id}`}>読み取った文字</label>
            <p className="note">
              背表紙に印刷されているとおりに直してください。書名・著者・出版社を1行ずつに分けると当たりやすくなります。
            </p>
            <textarea
              id={`edit-${entry.id}`}
              ref={editRef}
              value={draft}
              rows={4}
              onChange={(e) => setDraft(e.target.value)}
            />
          </div>
          <div className="actions">
            <button type="submit" className="button button--primary button--compact">
              この内容で調べ直す
            </button>
            <button
              type="button"
              className="button button--compact"
              onClick={() => setEditing(false)}
            >
              やめる
            </button>
          </div>
        </form>
      )}

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

export function BookList({ entries, onlyAttention = false, ...handlers }: Props) {
  if (entries.length === 0) {
    return (
      <div className="panel stack">
        <p>登録された本はまだありません。</p>
        <p className="note">
          カメラを開始して、本のバーコードまたは本棚の背表紙をかざすと、読み取った順にここへ並びます。
        </p>
      </div>
    )
  }

  const counts = entries.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1
    return acc
  }, {})
  const unresolved = (counts.notFound ?? 0) + (counts.unverified ?? 0)
  // 件数の内訳は全件から数え、描くのは絞り込んだぶんだけ
  const shown = onlyAttention ? entries.filter(needsAttention) : entries

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

      {shown.length === 0 ? (
        <div className="panel">
          <p>手を入れる必要がある本はありません。</p>
        </div>
      ) : (
        <ul className="record-list">
          {shown.map((e) => (
            <BookRow key={e.id} entry={e} {...handlers} />
          ))}
        </ul>
      )}
    </>
  )
}
