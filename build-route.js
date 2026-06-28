// 境界線を「実際の道」にスナップした走行ルートを生成する。
// boundary.geojson の最外リングを等間隔にリサンプル → BRouter(自転車)で
// 経由点間を道沿いにルーティング → 1本の LineString に連結して保存。
// 使い方: node build-route.js
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const turf = require("@turf/turf");

const OUT = path.join(__dirname, "docs", "tokyo23-route.geojson");
// 環境変数で上書き可（スイープ用）: TOL, SPACING, DESPIKE
const SIMPLIFY_TOL = Number(process.env.TOL || 0.012); // 蛇行/出っ張りを均す(~1.3km)。湾岸のヒゲを消すため強め
const SPACING_KM = Number(process.env.SPACING || 2.0); // 経由点間隔（密=境界に密着 / 疎=滑らか）
const DESPIKE_M = Number(process.env.DESPIKE || 250);  // 生成ルートのヒゲ除去：往復幅がこれ未満なら刈る(m)
const CHUNK = 16;           // 1リクエストあたりの経由点数（端点を次チャンクと共有）
const PROFILE = "fastbike"; // 幹線寄りで余計な迂回を減らす

function hav(a, b) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dlat = toR(b[1] - a[1]), dlng = toR(b[0] - a[0]);
  const la = toR((a[1] + b[1]) / 2);
  const x = dlng * Math.cos(la), y = dlat;
  return R * Math.sqrt(x * x + y * y);
}

// 最外リング（最長リング）を取得
const gj = JSON.parse(fs.readFileSync(path.join(__dirname, "docs", "boundary.geojson"), "utf8"));
const g = gj.features[0].geometry;
let rings = [];
if (g.type === "Polygon") rings = g.coordinates;
else if (g.type === "MultiPolygon") g.coordinates.forEach((p) => p.forEach((r) => rings.push(r)));
rings.sort((a, b) => b.length - a.length);
let ring = rings[0];

// 微細な蛇行を均して実用的なループにする
try {
  const simp = turf.simplify(turf.lineString(ring), { tolerance: SIMPLIFY_TOL, highQuality: true });
  ring = simp.geometry.coordinates;
  console.log(`simplify: ${rings[0].length} -> ${ring.length} 点`);
} catch (e) { console.warn("simplify skip:", e.message); }

// 累積距離で等間隔リサンプル
const wp = [ring[0]];
let acc = 0;
for (let i = 1; i < ring.length; i++) {
  acc += hav(ring[i - 1], ring[i]);
  if (acc >= SPACING_KM) { wp.push(ring[i]); acc = 0; }
}
if (wp[wp.length - 1] !== ring[0]) wp.push(ring[0]); // ループを閉じる
console.log(`waypoints: ${wp.length}（間隔~${SPACING_KM}km, 周回を閉じる）`);

// 経由点群を1リクエストでルーティング。成功なら座標配列、失敗(target island等)なら null。
function tryRoute(points) {
  const lonlats = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join("|");
  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${PROFILE}&alternativeidx=0&format=geojson`;
  const out = execSync(`curl -s --max-time 60 "${url}"`, { maxBuffer: 1 << 26 }).toString().trim();
  execSync("sleep 0.4"); // 公開サーバーへの配慮
  if (out[0] !== "{") return null; // BRouterはエラー時プレーンテキストを返す
  try { return JSON.parse(out).features[0].geometry.coordinates; }
  catch { return null; }
}

// 失敗したら半分に分割して再試行。2点まで分割しても駄目なら、その区間は
// 直線で繋いで先へ進む（=道に乗らない箇所だけを小さなギャップにする）。
let skipped = 0;
function routeRange(points) {
  const c = tryRoute(points);
  if (c) return c;
  if (points.length <= 2) { skipped++; return points; } // 孤立点：直線でブリッジ
  const mid = Math.floor(points.length / 2);
  const left = routeRange(points.slice(0, mid + 1));
  const right = routeRange(points.slice(mid));
  return right.length ? left.concat(right.slice(1)) : left;
}

let coords = [];
let chunkCount = 0;
for (let i = 0; i < wp.length - 1; i += CHUNK - 1) {
  const seg = wp.slice(i, Math.min(i + CHUNK, wp.length));
  if (seg.length < 2) break;
  chunkCount++;
  const c = routeRange(seg);
  if (coords.length && c.length) coords = coords.concat(c.slice(1));
  else coords = coords.concat(c);
  console.log(`  chunk ${chunkCount}: wp[${i}..${i + seg.length - 1}] -> total ${coords.length} pts`);
}
console.log(`道に乗らずブリッジした区間: ${skipped}`);

// ---- ヒゲ（出っ張りへの往復）除去：ショートサーキット法 ----
// まず50m間隔に均し、ある点から先で経路が D[m] 以内に戻ってきたら、その間の
// 寄り道（往復・入り江への突っ込み）を丸ごと飛ばして直結する。長短に関係なく刈れる。
function resample(line, stepKm) {
  const out = [line[0]]; let acc = 0;
  for (let i = 1; i < line.length; i++) {
    acc += hav(line[i - 1], line[i]);
    if (acc >= stepKm) { out.push(line[i]); acc = 0; }
  }
  out.push(line[line.length - 1]);
  return out;
}
function despike(line, thM) {
  const pts = resample(line, 0.05); // 50m
  const D = thM / 1000, W = Math.round(3 / 0.05); // 探索窓 ~3km
  const out = []; let i = 0;
  while (i < pts.length) {
    out.push(pts[i]);
    let best = i;
    for (let j = i + 2; j < Math.min(i + W, pts.length); j++) {
      if (hav(pts[i], pts[j]) < D) best = j; // i に最も先で近接する点まで飛ばす
    }
    i = best > i ? best : i + 1;
  }
  return out;
}
// 滑らかさ指標：100m間隔に均してから鋭い折返し(<70°)の数を数える
function smoothness(line) {
  // resample ~100m
  const rs = [line[0]]; let acc = 0;
  for (let i = 1; i < line.length; i++) { acc += hav(line[i - 1], line[i]); if (acc >= 0.1) { rs.push(line[i]); acc = 0; } }
  let hair = 0;
  for (let i = 1; i < rs.length - 1; i++) {
    const a = rs[i - 1], b = rs[i], c = rs[i + 1];
    const v1 = [b[0] - a[0], b[1] - a[1]], v2 = [c[0] - b[0], c[1] - b[1]];
    const d1 = Math.hypot(...v1), d2 = Math.hypot(...v2);
    if (d1 === 0 || d2 === 0) continue;
    const cos = (v1[0] * v2[0] + v1[1] * v2[1]) / (d1 * d2);
    if (cos < Math.cos(70 * Math.PI / 180)) hair++; // 70°より鋭い折返し
  }
  return { hair, pts: rs.length };
}

const before = smoothness(coords);
coords = despike(coords, DESPIKE_M);
const after = smoothness(coords);
console.log(`despike: ${before.pts}->${after.pts} 点 / 鋭い折返し ${before.hair}→${after.hair}`);

// 走行距離（概算）
let len = 0;
for (let i = 1; i < coords.length; i++) len += hav(coords[i - 1], coords[i]);

const feature = {
  type: "FeatureCollection",
  _note: `23区の境界線(boundary.geojson)を BRouter(${PROFILE}) で実際の道にスナップした走行ルート概略。海岸/河川部は道が無い箇所で迂回することがある。`,
  features: [{
    type: "Feature",
    properties: { name: "23区一周 走行ルート", profile: PROFILE, distance_km: Number(len.toFixed(1)) },
    geometry: { type: "LineString", coordinates: coords },
  }],
};
fs.writeFileSync(OUT, JSON.stringify(feature));
console.log(`\n${OUT}`);
console.log(`走行ルート: ${coords.length} 点 / 約 ${len.toFixed(1)} km`);
