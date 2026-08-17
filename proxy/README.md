# NDLサーチ用プロキシ

国立国会図書館サーチ API は CORS ヘッダを返さないため、GitHub Pages のような
静的サイトからは直接呼べません。この中継を置くと、アプリの「NDLサーチと突合する」
段階が使えるようになります。

日本の書籍は法定納本により NDL の網羅性が最も高く、
Google Books や openBD で当たらない本もここでは引けます。

## スマホから設置する手順（Cloudflare Workers・無料枠）

先にコードをコピーしておくと楽です。次を開いて全選択・コピーしてください。

<https://raw.githubusercontent.com/popy48771-collab/bib/main/proxy/ndl-worker.js>

1. <https://dash.cloudflare.com/> にログイン（アカウントが無ければ作成。無料）
2. **Workers & Pages** → **Create** → **Start with Hello World!** → **Deploy**
3. デプロイ後の画面で **Edit code**
4. エディタの中身を**全部消して**、コピーしたコードを貼り付け
5. **Deploy** を押す
6. 画面に出る `https://<名前>.<サブドメイン>.workers.dev` を控える

所要はおよそ3分です。クレジットカードの登録は要りません。

### 手元に Node がある場合

```sh
cd proxy && npx wrangler deploy
```

## アプリ側の設定

アプリの **設定** を開き、**NDLサーチ用プロキシURL** に次を入力します。
**末尾の `?url=` まで含める**のを忘れないでください。

```
https://<名前>.<サブドメイン>.workers.dev/?url=
```

これで段階3「NDLサーチと突合する」のボタンが押せるようになります。

## 動作確認

ブラウザで直接開いて XML が返れば成功です。

```
https://<名前>.<サブドメイン>.workers.dev/?url=https%3A%2F%2Fndlsearch.ndl.go.jp%2Fapi%2Fopensearch%3Fisbn%3D9784873115658
```

## 設計上の約束

- **秘密情報を持ちません。** 認証も鍵も無いので、漏洩の心配がありません
- **中継先を `ndlsearch.ndl.go.jp` に限定しています。** 第三者に任意のURLを
  踏ませる踏み台にはなりません
- **応答を1日キャッシュします。** NDL は公共機関の API なので、
  同じ問い合わせを繰り返さないようにしています

## 注意

- NDL のレスポンス解析は**実地未確認**です（開発環境から NDL へ到達できず、
  公開仕様のみに基づいて実装しています）。繋いだ直後に想定と違う結果が出たら、
  上の確認用URLで生の XML を見て報告してください
- 継続的・大量にアクセスする公開サービスとして運用する場合は、
  NDL の API 利用案内に従って利用内容を届け出てください
- 書影だけはプロキシ不要です。CORS が制限するのは fetch であって
  `<img>` の画像読み込みは対象外なので、アプリは ISBN があれば
  `https://ndlsearch.ndl.go.jp/thumbnail/<ISBN>.jpg` を直接表示しています
