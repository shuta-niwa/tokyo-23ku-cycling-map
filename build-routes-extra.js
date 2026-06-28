// 23区以外の「走れる一周マップ」の走行ルートを、OSMの実際の道に正確に
// スナップして生成する。
//   1) ポリゴン輪郭の周辺コリドーの道を Overpass で取得
//   2) 各経由点を最寄りの道へスナップ（道が遠い=水上の点は破棄）
//   3) BRouter(自転車)で連結。繋がらない所は直線で橋渡しせず線を分割
//      (MultiLineString)し、"道でない直線"を描かない
//   4) 150m超のジャンプ(=非道接続)の本数を計測（0が理想）
// 使い方: node build-routes-extra.js [id ...]
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const DOCS = path.join(__dirname, "docs");
const PROFILE = "fastbike";
const CHUNK = 16, DESPIKE_M = 250;
const CORRIDOR_M = 800;      // 道を取得するコリドー幅
const MAX_SNAP_KM = 1.2;     // これより遠い道しか無い経由点は破棄（水上点対策）
const JUMP_M = 150;          // これ超の連続点間距離は「非道接続」とみなす
const OVERPASS = "https://overpass-api.de/api/interpreter";

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
function densify(ring, maxKm) {
  const out = [ring[0]];
  for (let i = 1; i < ring.length; i++) {
    const a = ring[i - 1], b = ring[i], n = Math.max(1, Math.ceil(hav(a, b) / maxKm));
    for (let j = 1; j <= n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]);
  }
  return out;
}

// --- 最寄り道スナップ用：点→線分の最近点（局所メートル換算）---
function nearestOnSeg(p, a, b) {
  const latR = p[1] * Math.PI / 180, kx = Math.cos(latR) * 111320, ky = 110540;
  const px = p[0] * kx, py = p[1] * ky, ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return { dist: Math.hypot(px - cx, py - cy), pt: [cx / kx, cy / ky] };
}

// --- Overpass: ring 周辺の道（geometry付き）を取得 ---
function fetchRoads(ring) {
  let around = densify(ring, 1.0);
  if (around.length > 200) { // クエリ肥大化を防ぐため間引き
    const step = Math.ceil(around.length / 200);
    around = around.filter((_, i) => i % step === 0);
  }
  const coords = around.map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join(",");
  const q = `[out:json][timeout:120];way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|raceway|bus_guideway|escape|steps|elevator|platform|corridor)$"](around:${CORRIDOR_M},${coords});out geom;`;
  const tmp = "/tmp/ov_q.txt";
  fs.writeFileSync(tmp, q);
  const out = execSync(`curl -s --max-time 150 -X POST --data-urlencode "data@${tmp}" ${OVERPASS}`, { maxBuffer: 1 << 28 }).toString();
  const j = JSON.parse(out);
  // ways を [lon,lat] 配列に
  return j.elements.filter((e) => e.type === "way" && e.geometry).map((e) => e.geometry.map((g) => [g.lon, g.lat]));
}

// 経由点を最寄り道へスナップ。遠すぎる点は破棄。連続重複は除去。
function snapToRoads(wps, ways) {
  const snapped = []; let dropped = 0;
  for (const p of wps) {
    let best = null;
    for (const w of ways) for (let i = 1; i < w.length; i++) {
      const r = nearestOnSeg(p, w[i - 1], w[i]);
      if (!best || r.dist < best.dist) best = r;
    }
    if (!best || best.dist > MAX_SNAP_KM * 1000) { dropped++; continue; }
    const last = snapped[snapped.length - 1];
    if (!last || hav(last, best.pt) > 0.03) snapped.push(best.pt); // 30m未満の重複は捨てる
  }
  return { snapped, dropped };
}

function tryRoute(points) {
  const lonlats = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join("|");
  const url = `https://brouter.de/brouter?lonlats=${lonlats}&profile=${PROFILE}&alternativeidx=0&format=geojson`;
  const out = execSync(`curl -s --max-time 60 "${url}"`, { maxBuffer: 1 << 26 }).toString().trim();
  execSync("sleep 0.4");
  if (out[0] !== "{") return null;
  try { return JSON.parse(out).features[0].geometry.coordinates; } catch { return null; }
}

// 直線ブリッジを作らない連結：窓を縮めながら最大限つなぎ、
// 単一ペアでも繋がらない時だけ線を分割（pieces）。
function routePieces(wps) {
  const pieces = []; let cur = [], breaks = 0, i = 0;
  while (i < wps.length - 1) {
    let hi = Math.min(i + CHUNK - 1, wps.length - 1);
    let c = tryRoute(wps.slice(i, hi + 1));
    while (!c && hi > i + 1) { hi--; c = tryRoute(wps.slice(i, hi + 1)); }
    if (c) { cur = cur.length ? cur.concat(c.slice(1)) : c; i = hi; }
    else { if (cur.length) { pieces.push(cur); cur = []; } breaks++; i++; }
  }
  if (cur.length) pieces.push(cur);
  return { pieces, breaks };
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
// 連続点間が JUMP_M を超える本数（=非道接続の疑い）
function countJumps(line) { let n = 0; for (let i = 1; i < line.length; i++) if (hav(line[i - 1], line[i]) * 1000 > JUMP_M) n++; return n; }

const only = process.argv.slice(2);
for (const m of MAPS) {
  if (only.length && !only.includes(m.id)) continue;
  const gj = JSON.parse(fs.readFileSync(path.join(DOCS, `${m.id}.geojson`), "utf8"));
  const ring = gj.features[0].geometry.coordinates[0];
  const wp0 = densify(ring, m.densifyKm);

  const ways = fetchRoads(ring);
  const { snapped, dropped } = snapToRoads(wp0, ways);
  // ループを閉じる
  if (snapped.length && hav(snapped[0], snapped[snapped.length - 1]) > 0.03) snapped.push(snapped[0]);

  const { pieces, breaks } = routePieces(snapped);
  // 各ピースを despike、ジャンプ数を集計
  const cleanPieces = pieces.map((p) => despike(p, DESPIKE_M));
  const allCoords = cleanPieces.flat();
  let len = 0; for (const p of cleanPieces) for (let i = 1; i < p.length; i++) len += hav(p[i - 1], p[i]);
  const jumps = cleanPieces.reduce((s, p) => s + countJumps(p), 0);
  const hot = hotspots(allCoords);

  const geometry = cleanPieces.length === 1
    ? { type: "LineString", coordinates: cleanPieces[0] }
    : { type: "MultiLineString", coordinates: cleanPieces };
  fs.writeFileSync(path.join(DOCS, `${m.id}-route.geojson`), JSON.stringify({
    type: "FeatureCollection",
    _note: `${m.id} の輪郭をOSMの道へスナップしてBRouter(${PROFILE})で連結した走行ルート概略（直線ブリッジ無し）。`,
    features: [{ type: "Feature", properties: { name: `${m.id} 走行ルート`, profile: PROFILE, distance_km: +len.toFixed(1), pieces: cleanPieces.length }, geometry }],
  }));
  fs.writeFileSync(path.join(DOCS, `${m.id}-route-hotspots.geojson`), JSON.stringify({ type: "FeatureCollection", features: hot }));

  const ratio = (len / m.targetKm).toFixed(2);
  console.log(`${m.id.padEnd(12)} ${len.toFixed(1)}km(目安${m.targetKm}/比${ratio}) roads=${ways.length} snap drop=${dropped} pieces=${cleanPieces.length} breaks=${breaks} jumps>${JUMP_M}m=${jumps} 密集=${hot.length}`);
}
console.log("done.");
