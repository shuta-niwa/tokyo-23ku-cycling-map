# 東京23区 境界マップ（サイクリング用）

地図上で東京23区を区ごとに色分け表示し、現在地が「23区内（どの区か）／区外」かを一目で分かるようにする Web アプリ。自転車での23区一周時に、境界を視覚的に確認する用途。

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
- `build.js` … 元データから上記 GeoJSON を生成するビルドスクリプト
- `data/` … 元データ（国土数値情報 N03 / 13101〜13123）

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

GitHub Pages（ブランチ `main` / フォルダ `/docs`）。

## データ出典

国土数値情報「行政区域データ（N03）」（国土交通省）を加工して作成。
元 GeoJSON: [niiyz/JapanCityGeoJson](https://github.com/niiyz/JapanCityGeoJson)
