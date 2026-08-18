# OCR 資産

背表紙OCR（Tesseract）が使う言語モデルを置く場所。**外部CDNを見に行かせないために自サイト配下へ置いている。**

`lang/` に置いてあるのは [tesseract-ocr/tessdata_fast](https://github.com/tesseract-ocr/tessdata_fast) の学習済みモデル（Apache License 2.0）を gzip したもの。

| ファイル | 用途 |
|---|---|
| `lang/jpn_vert.traineddata.gz` | 日本語の縦書き。背表紙の主経路 |
| `lang/jpn.traineddata.gz` | 横組み・欧文混じり。回転して読み直すときに使う |

`best` ではなく `fast` を採る。端末上で1冊あたり数秒に収める必要があり、`best` は数倍遅い。

更新するときは同じ名前で置き換える。取得元は次のとおり。

```
curl -L -o jpn_vert.traineddata https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/main/jpn_vert.traineddata
gzip -9 jpn_vert.traineddata
```

**欧文専用の `eng` は入れていない。** 3言語同時に読ませると1冊あたりの時間が伸びるうえ、
`jpn` はラテン文字も学習している。洋書の精度が足りないと実測できた時点で足す。

wasm 本体（tesseract.js-core）はここには置かない。npm の依存として持ち、
Vite に資産として出させている（`src/lib/spine/tesseract.ts`）。
