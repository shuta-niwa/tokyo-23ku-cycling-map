// 23区以外の「走れる一周マップ」について、範囲ポリゴンの輪郭を実際の道に
// スナップした走行ルートと密集箇所を生成する。BRouter(自転車)を使用。
// 使い方: node build-routes-extra.js [id ...]   (id省略で全マップ)
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DOCS = path.join(__dirname, "docs");
const PROFILE = "fastbike";
const CHUNK = 16, DESPIKE_M = 250;

// 自走で一周できるマップ（東京湾=フェリー必須は対象外）
// densifyKm: 輪郭をこの間隔に刻んで道へ密着させる / targetKm: 妥当性チェックの目安
const MAPS = [
  { id: "yamanote",    densifyKm: 0.8, targetKm: 43 },
  { id: "teganuma",    densifyKm: 0.6, targetKm: 20 },
  { id: "hamana",      densifyKm: 1.2, targetKm: 65 },
  { id: "miura",       densifyKm: 1.2, targetKm: 80 },
  { id: "kasumigaura", densifyKm: 1.8, targetKm: 140 },
  { id: "fuji",        densifyKm: 1.8, targetKm: 150 },
  { id: "biwako",      densifyKm: 2.2, targetKm: 200 },
];

function hav(a, b) {
  const R = 6371, toR = (x) => (x * Math.PI) / 180;
  const dlat = toR(b[1] - a[1]), dlng = toR(b[0] - a[0]);
  const la = toR((a[1] + b[1]) / 2);
  const x = dlng * Math.cos(la), y = dlat;
  return R * Math.sqrt(x * x + y * y);
}
function resample(line, step) {
  const out = [line[0]]; let acc = 0;
  for (let i = 1; i < line.length; i++) { acc += hav(line[i - 1], line[i]); if (acc >= step) { out.push(line[i]); acc = 0; } }
  out.push(line[line.length - 1]); return out;
}
// 辺を maxKm 以下に刻む（粗いポリゴンを道に密着させるため）
function densify(ring, maxKm) {
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], n = Math.max(1, Math.ceil(hav(a, b) / maxKm));
    for (let j = 1; j <= n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
  }
  return out;
}
function tryRoute(points) {
  const lonlats = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join("|");
  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${PROFILE}&alternativeidx=0&format=geojson`;
  const out = execSync(`curl -s --max-time 60 "${url}"`, { maxBuffer: 1 << 26 }).toString().trim();
  execSync("sleep 0.4");
  if (out[0] !== "{") return null;
  try { return JSON.parse(out).features[0].geometry.coordinates; } catch { return null; }
}
let skipped = 0;
function routeRange(points) {
  const c = tryRoute(points);
  if (c) return c;
  if (points.length <= 2) { skipped++; return points; }
  const mid = Math.floor(points.length / 2);
  return routeRange(points.slice(0, mid + 1)).concat(routeRange(points.slice(mid)).slice(1));
}
function despike(line, thM) {
  const pts = resample(line, 0.05), D = thM / 1000, W = Math.round(3 / 0.05);
  const out = []; let i = 0;
  while (i < pts.length) {
    out.push(pts[i]); let best = i;
    for (let j = i + 2; j < Math.min(i + W, pts.length); j++) if (hav(pts[i], pts[j]) < D) best = j;
    i = best > i ? best : i + 1;
  }
  return out;
}
// 密集(=短縮候補): セルに経路長が多く かつ 2回以上通っているもの
function hotspots(coords, cellM = 350, hotLen = 0.7, minVisits = 2) {
  const LAT0 = 35.6, DLAT = cellM / 1000 / 111, DLNG = cellM / 1000 / (111 * Math.cos(LAT0 * Math.PI / 180));
  const rs = resample(coords, 0.03), key = (p) => Math.round(p[0] / DLNG) + "," + Math.round(p[1] / DLAT);
  const kc = rs.map(key), cells = new Map();
  for (let i = 0; i < rs.length; i++) {
    const seg = i < rs.length - 1 ? hav(rs[i], rs[i + 1]) : 0;
    const e = cells.get(kc[i]) || { len: 0, kx: Math.round(rs[i][0] / DLNG), ky: Math.round(rs[i][1] / DLAT) };
    e.len += seg; cells.set(kc[i], e);
  }
  const visits = (k) => { let v = 0, ins = false; for (const c of kc) { if (c === k) { if (!ins) { v++; ins = true; } } else ins = false; } return v; };
  return [...cells.entries()].map(([k, c]) => ({ ...c, visits: visits(k) }))
    .filter((c) => c.len >= hotLen && c.visits >= minVisits)
    .map((c) => ({ type: "Feature", properties: { len_km: +c.len.toFixed(2), visits: c.visits }, geometry: { type: "Point", coordinates: [+(c.kx * DLNG).toFixed(5), +(c.ky * DLAT).toFixed(5)] } }));
}

const only = process.argv.slice(2);
for (const m of MAPS) {
  if (only.length && !only.includes(m.id)) continue;
  skipped = 0;
  const gj = JSON.parse(fs.readFileSync(path.join(DOCS, `${m.id}.geojson`), "utf8"));
  const ring = gj.features[0].geometry.coordinates[0];
  const wp = densify(ring, m.densifyKm);
  let coords = [];
  for (let i = 0; i < wp.length - 1; i += CHUNK - 1) {
    const seg = wp.slice(i, Math.min(i + CHUNK, wp.length));
    if (seg.length < 2) break;
    const c = routeRange(seg);
    coords = coords.length ? coords.concat(c.slice(1)) : coords.concat(c);
  }
  coords = despike(coords, DESPIKE_M);
  let len = 0; for (let i = 1; i < coords.length; i++) len += hav(coords[i - 1], coords[i]);
  const hot = hotspots(coords);

  fs.writeFileSync(path.join(DOCS, `${m.id}-route.geojson`), JSON.stringify({
    type: "FeatureCollection",
    _note: `${m.id} の範囲ポリゴン輪郭を BRouter(${PROFILE}) で道にスナップした走行ルート概略（試作・要精緻化）。`,
    features: [{ type: "Feature", properties: { name: `${m.id} 走行ルート`, profile: PROFILE, distance_km: +len.toFixed(1) }, geometry: { type: "LineString", coordinates: coords } }],
  }));
  fs.writeFileSync(path.join(DOCS, `${m.id}-route-hotspots.geojson`), JSON.stringify({ type: "FeatureCollection", features: hot }));

  const ratio = (len / m.targetKm).toFixed(2);
  const flag = (ratio < 0.6 || ratio > 1.6) ? "  ⚠ 目安から乖離" : "";
  console.log(`${m.id.padEnd(12)} 生成 ${len.toFixed(1)}km (目安 ${m.targetKm}km, 比 ${ratio}) / 密集 ${hot.length} / bridge ${skipped}${flag}`);
}
console.log("done.");
