/**
 * NDLサーチ用 CORS プロキシ (Cloudflare Workers)
 *
 * ── なぜ要るのか ────────────────────────────────────────
 * NDLサーチ API は CORS ヘッダを返さないため、ブラウザから直接 fetch できない。
 * 日本の書籍については法定納本により NDL の網羅性が最も高く、
 * Google Books や openBD では当たらない本もここでは引ける。
 * サーバを持たない構成で NDL に届く唯一の道がこの中継である。
 *
 * ── 何をしないか ────────────────────────────────────────
 * 秘密情報を一切持たない。認証もしない。したがって鍵の管理や漏洩の心配がない。
 * 中継先を ndlsearch.ndl.go.jp に限定してあるので、
 * 第三者に任意のURLを踏ませる踏み台にはならない。
 *
 * ── 使い方 ──────────────────────────────────────────────
 *   https://<あなたのworker>.workers.dev/?url=<エンコードしたNDLのURL>
 * アプリの設定「NDLサーチ用プロキシURL」には末尾 `=` まで含めて
 *   https://<あなたのworker>.workers.dev/?url=
 * と登録する。
 */

/** 中継を許す宛先。ここを広げると誰でも使える公開プロキシになるので広げない */
const ALLOWED_HOST = 'ndlsearch.ndl.go.jp'

/** NDL は公共機関のAPI。同じ問い合わせを何度も投げないよう1日キャッシュする */
const CACHE_SECONDS = 86400

function corsHeaders(extra = {}) {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    ...extra,
  }
}

function fail(status, message) {
  return new Response(message, {
    status,
    headers: corsHeaders({ 'Content-Type': 'text/plain;charset=utf-8' }),
  })
}

export default {
  async fetch(request) {
    // プリフライト
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    if (request.method !== 'GET') {
      return fail(405, 'GET のみ受け付けます')
    }

    const target = new URL(request.url).searchParams.get('url')
    if (!target) {
      return fail(400, 'url パラメータが要ります: /?url=<エンコードしたNDLのURL>')
    }

    let parsed
    try {
      parsed = new URL(target)
    } catch {
      return fail(400, 'url が URL として解釈できません')
    }

    // 宛先の限定。https と NDL のホストだけを通す
    if (parsed.protocol !== 'https:' || parsed.hostname !== ALLOWED_HOST) {
      return fail(403, `中継できるのは https://${ALLOWED_HOST} のみです`)
    }

    let upstream
    try {
      upstream = await fetch(parsed.toString(), {
        headers: { Accept: 'application/xml, text/xml, */*' },
        // Cloudflare 側でもキャッシュさせ、NDL への往復を減らす
        cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
      })
    } catch {
      return fail(502, 'NDLサーチへ到達できませんでした')
    }

    // 本文はそのまま返す。解析はアプリ側で行う
    return new Response(upstream.body, {
      status: upstream.status,
      headers: corsHeaders({
        'Content-Type': upstream.headers.get('Content-Type') ?? 'application/xml;charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_SECONDS}`,
      }),
    })
  },
}
