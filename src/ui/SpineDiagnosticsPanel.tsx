import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import {
  buildReport,
  spineDiagnostics,
  type FrameDiagnostic,
  type LookupDiagnostic,
} from '../lib/spine/diagnostics'

/**
 * 実機診断の表示（`?debug=1` のときだけ描画される）
 *
 * 実機で読めなかったとき、原因が「切り出し」「前処理」「OCR」「照合」の
 * どこにあるのかを目で確かめるための画面である。短冊の画像と、その短冊から
 * 出た生テキストを並べて出す。**ここを見ずに閾値を動かさない。**
 *
 * 遅延 import で読み込まれるので、通常のバンドルには入らない。
 * 画面の規則（DESIGN_SYSTEM.md）に従い、既存のトークンと部品だけで組む。
 */

/** Blob を img で出す。表示のあいだだけ URL を持つ */
function BlobImage({ blob, alt, className }: { blob: Blob; alt: string; className?: string }) {
  const [url, setUrl] = useState<string | null>(null)

  useEffect(() => {
    const created = URL.createObjectURL(blob)
    setUrl(created)
    // 開きっぱなしにすると、数十枚ぶんの画像が端末に残る
    return () => URL.revokeObjectURL(created)
  }, [blob])

  if (!url) return null
  return <img src={url} alt={alt} className={className} />
}

/** Blob を data URL にする。書き出す JSON に画像を含めるため */
function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader()
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : '')
    reader.onerror = () => resolve('')
    reader.readAsDataURL(blob)
  })
}

function DiagnosticFrameView({ frame }: { frame: FrameDiagnostic }) {
  const read =
    frame.mode === 'gemini' ? frame.spines : frame.strips.filter((s) => s.spines > 0).length
  const mode =
    frame.mode === 'gemini'
      ? 'Gemini（棚全体）'
      : frame.mode === 'strips'
        ? '短冊'
        : 'コマ全体（退避）'

  return (
    <li className="diagnostics__frame">
      <p className="diagnostics__heading">
        {new Date(frame.at).toLocaleTimeString('ja-JP')} / {frame.width}×{frame.height} /{' '}
        {mode} / 短冊 {frame.bands.length} 本 / 読めた {read} 本 / {frame.spines} 冊 /{' '}
        {frame.ms} ms
      </p>
      {frame.quality && (
        <ul className="status-line">
          <li>
            明るさ <b>{frame.quality.brightness.toFixed(3)}</b>
          </li>
          <li>
            白飛び <b>{frame.quality.blowout.toFixed(3)}</b>
          </li>
          <li>
            鮮鋭度 <b>{frame.quality.sharpness.toFixed(3)}</b>
          </li>
        </ul>
      )}
      {frame.preview && (
        <BlobImage blob={frame.preview} alt="取り込んだコマ" className="diagnostics__preview" />
      )}
      <ol className="diagnostics__strips">
        {frame.strips.map((strip) => (
          <li key={strip.index}>
            {strip.image && (
              <BlobImage
                blob={strip.image}
                alt={`短冊 ${strip.index + 1}`}
                className="diagnostics__strip"
              />
            )}
            <span className="diagnostics__text">{strip.text || '（読めず）'}</span>
            <span className="diagnostics__meta">
              {(strip.band.start * 100).toFixed(1)}–{(strip.band.end * 100).toFixed(1)}% /{' '}
              {strip.ms} ms
            </span>
          </li>
        ))}
      </ol>
    </li>
  )
}

/** 照合1リクエストぶんの表示。失敗と0件を見分けられる形で出す */
function LookupLine({ lookup }: { lookup: LookupDiagnostic }) {
  const outcome = lookup.error ? `失敗: ${lookup.error}` : `${lookup.hits} 件`
  return (
    <li>
      <span className="diagnostics__text">
        [{lookup.source}/{lookup.mode}] {lookup.query || '（空）'} → {outcome}
      </span>
      <span className="diagnostics__meta">
        {new Date(lookup.at).toLocaleTimeString('ja-JP')} / {lookup.ms} ms / 対象:{' '}
        {lookup.entryText || '（不明）'}
      </span>
    </li>
  )
}

export default function SpineDiagnosticsPanel() {
  const frames = useSyncExternalStore(
    (listener) => spineDiagnostics.subscribe(listener),
    () => spineDiagnostics.list(),
    () => spineDiagnostics.list(),
  )
  const lookups = useSyncExternalStore(
    (listener) => spineDiagnostics.subscribe(listener),
    () => spineDiagnostics.listLookups(),
    () => spineDiagnostics.listLookups(),
  )
  const resolutions = useSyncExternalStore(
    (listener) => spineDiagnostics.subscribe(listener),
    () => spineDiagnostics.listResolutions(),
    () => spineDiagnostics.listResolutions(),
  )
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    setSaving(true)
    try {
      const report = buildReport(frames, Date.now(), lookups, resolutions)
      // 画像は data URL で足す。これが無いと、あとから見返しても
      // 「その文字列がどの画像から出たのか」が判らない
      const withImages = {
        ...report,
        frames: await Promise.all(
          report.frames.map(async (f, i) => ({
            ...f,
            preview: frames[i]?.preview ? await toDataUrl(frames[i].preview) : undefined,
            strips: await Promise.all(
              f.strips.map(async (s, j) => ({
                ...s,
                image: frames[i]?.strips[j]?.image
                  ? await toDataUrl(frames[i].strips[j].image)
                  : undefined,
              })),
            ),
          })),
        ),
      }

      const blob = new Blob([JSON.stringify(withImages, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `spine-diagnostics-${new Date().toISOString().slice(0, 19)}.json`
      link.click()
      URL.revokeObjectURL(url)
    } finally {
      setSaving(false)
    }
  }, [frames, lookups, resolutions])

  return (
    <section className="section" aria-labelledby="diagnostics-title">
      <h2 className="section-title" id="diagnostics-title">
        読み取りの診断
      </h2>
      <p className="note">
        <code>?debug=1</code> が付いているあいだだけ表示します。直近{' '}
        {frames.length} 枚ぶんの取り込みと、短冊ごとの読み取り結果です。
      </p>

      <div className="actions">
        <button
          type="button"
          className="button button--neutral"
          onClick={() => void save()}
          disabled={(frames.length === 0 && lookups.length === 0) || saving}
        >
          診断データを書き出す
        </button>
        <button
          type="button"
          className="button button--neutral"
          onClick={() => spineDiagnostics.clear()}
          disabled={frames.length === 0 && lookups.length === 0}
        >
          診断データを消す
        </button>
      </div>

      {frames.length === 0 ? (
        <p className="note">まだ取り込んでいません。背表紙の読み取りを始めてください。</p>
      ) : (
        <ol className="diagnostics">
          {[...frames].reverse().map((frame) => (
            <DiagnosticFrameView key={frame.id} frame={frame} />
          ))}
        </ol>
      )}

      {/*
        読めても書誌が引けないときに見る場所。中継の403・0件・例外を
        区別できる形で、1リクエストずつ残す
      */}
      {lookups.length > 0 && (
        <>
          <h3 className="subheading">書誌照合のリクエスト（直近 {lookups.length} 件）</h3>
          <ol className="diagnostics__strips">
            {[...lookups].reverse().map((lookup, i) => (
              <LookupLine key={`${lookup.at}-${i}`} lookup={lookup} />
            ))}
          </ol>
        </>
      )}

      {resolutions.length > 0 && (
        <>
          <h3 className="subheading">照合の着地点（直近 {resolutions.length} 冊）</h3>
          <ol className="diagnostics__strips">
            {[...resolutions].reverse().map((r, i) => (
              <li key={`${r.at}-${i}`}>
                <span className="diagnostics__text">
                  {r.entryText || '（不明）'} → {r.status}
                  {r.topTitle
                    ? ` / 最上位: ${r.topTitle}${r.topIsbn ? ` (${r.topIsbn})` : ''}${
                        r.topScore !== undefined ? ` 一致度 ${r.topScore}` : ''
                      }`
                    : ' / 候補なし'}
                </span>
              </li>
            ))}
          </ol>
        </>
      )}
    </section>
  )
}
