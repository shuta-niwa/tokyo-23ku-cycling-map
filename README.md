# 境界マップ（サイクリング用 / 一周企画）

地図上で「一周対象の範囲」を色塗りし、その境界線（＝走行ルート）を太線で表示。現在地が範囲の内/外かを一目で分かるようにする Web アプリ。自転車一周企画で境界を視覚的に確認する用途。

上部のセレクタで一周マップを切り替えられる（複数登録可）。

- **東京23区一周**（外周 約100km）… 23区を区ごとに色分け、現在いる区名を表示
- **東京湾一周（試作）**（約200km・ベイイチ/ワンイチ）… 湾を囲む一周ルートで閉じたエリアを色塗り。湾口は金谷↔久里浜の東京湾フェリー線で閉じる。海岸線は概形（要精緻化）

## 機能（MVP: F1〜F5）

- F1 地図表示（Leaflet + OpenStreetMap）
- F2 23区を区ごとに色分け
- F3 23区の外周ラインを太線で強調
- F4 現在地表示・GPS追従
- F5 内/外判定 ＋ 現在いる区名の表示

位置情報は端末内のみで処理し、サーバーへ送信しません。

## 構成

- `docs/index.html` … アプリ本体（依存ライブラリは Leaflet のみ、CDN 読み込み）
- `docs/wards.geojson` … 23区ポリゴン（区ごと・色付き）
- `docs/boundary.geojson` … 23区全体の外周ライン
- `docs/tokyobay.geojson` … 東京湾一周エリア（概形ポリゴン1枚／試作）
- `build.js` … 23区データから wards/boundary GeoJSON を生成するビルドスクリプト
- `data/` … 23区の元データ（国土数値情報 N03 / 13101〜13123）

## 一周マップを追加する

`docs/index.html` の `MAPS` 配列に1項目足すだけ。色塗りする範囲の GeoJSON（`regionsUrl`）を `docs/` に置き、必要なら別途ルート線（`boundaryUrl`、省略時は範囲の輪郭を太線描画）を指定する。

```js
{
  id: "tokyobay", label: "東京湾一周（約200km・試作）",
  regionsUrl: "tokyobay.geojson", boundaryUrl: null,
  center: [35.45, 139.85], zoom: 10, multiColor: false, fillColor: "#1e88e5",
  insideLabel: () => "東京湾エリア内", outsideLabel: "東京湾エリア外",
}
```

## ビルド（データ再生成）

```bash
npm install
node build.js
```

## ローカル確認

```bash
npx http-server docs -p 8080
# http://localhost:8080 を開く（位置情報は https か localhost が必要）
```

## デプロイ

GitHub Pages（ブランチ `master` / フォルダ `/docs`）。`master` の `/docs` を push すると自動ビルドされ、数分で公開URLへ反映される。

## データ出典

国土数値情報「行政区域データ（N03）」（国土交通省）を加工して作成。
元 GeoJSON: [niiyz/JapanCityGeoJson](https://github.com/niiyz/JapanCityGeoJson)
