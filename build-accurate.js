// 対象物（湖・山・鉄道）の正確な境界をOSMから取得し、
//   - 境界(=色塗り範囲)を実物の最小輪郭に置換（docs/{id}.geojson を上書き）
//   - その周囲を周回できる道を、各経由点をOSMの道にスナップして生成
//     （直線ブリッジ無し。繋がらない箇所は線を分割）
// 使い方: node build-accurate.js [id ...]
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const turf = require("@turf/turf");

const DOCS = path.join(__dirname, "docs");
const OVERPASS_EPS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const PROFILE = "fastbike";
const CHUNK = 16, DESPIKE_M = 250, CORRIDOR_M = 800, MAX_SNAP_KM = 1.2, JUMP_M = 400;

const MAPS = [
  { id: "biwako",      kind: "water", name: "琵琶湖",  nameRe: "琵琶湖",   color: "#0288d1", densifyKm: 2.2, targetKm: 200, simpDeg: 0.0012 },
  { id: "kasumigaura", kind: "water", name: "霞ヶ浦",  nameRe: "霞ヶ浦",   color: "#00897b", densifyKm: 1.8, targetKm: 140, simpDeg: 0.0012 },
  { id: "hamana",      kind: "water", name: "浜名湖",  nameRe: "^浜名湖$", color: "#0097a7", densifyKm: 1.2, targetKm: 65,  simpDeg: 0.0008 },
  { id: "teganuma",    kind: "water", name: "手賀沼",  nameRe: "^手賀沼$", color: "#43a047", densifyKm: 0.6, targetKm: 20,  simpDeg: 0.0005 },
  { id: "fuji",        kind: "peakRing", name: "富士山", color: "#2e7d32", innerKm: 6, ringKm: 9, densifyKm: 1.5, targetKm: 130 },
  // 鉄道リレーションは綺麗な環に組めないため、既存の概形（駅を結ぶ環）を使いルートのみ生成
  { id: "yamanote",    kind: "polygon", name: "山手線", color: "#7cb342", densifyKm: 0.8, targetKm: 43 },
  // 半島は明確なOSMポリゴンが無いため、既存の概形ポリゴンを使い境界は上書きしない（ルートのみ生成）
  { id: "miura",       kind: "polygon", name: "三浦半島", color: "#5e35b1", densifyKm: 1.2, targetKm: 80 },
];

const hav = (a, b) => { const R = 6371, t = (x) => x * Math.PI / 180; const dlat = t(b[1] - a[1]), dlng = t(b[0] - a[0]), la = t((a[1] + b[1]) / 2); const x = dlng * Math.cos(la), y = dlat; return R * Math.sqrt(x * x + y * y); };
function resample(line, step) { const out = [line[0]]; let acc = 0; for (let i = 1; i < line.length; i++) { acc += hav(line[i - 1], line[i]); if (acc >= step) { out.push(line[i]); acc = 0; } } out.push(line[line.length - 1]); return out; }
function densify(ring, maxKm) { const out = [ring[0]]; for (let i = 1; i < ring.length; i++) { const a = ring[i - 1], b = ring[i], n = Math.max(1, Math.ceil(hav(a, b) / maxKm)); for (let j = 1; j <= n; j++) out.push([a[0] + (b[0] - a[0]) * j / n, a[1] + (b[1] - a[1]) * j / n]); } return out; }
function overpass(q) {
  fs.writeFileSync("/tmp/oq.txt", q);
  for (let attempt = 0; attempt < 6; attempt++) {
    const ep = OVERPASS_EPS[attempt % OVERPASS_EPS.length];
    try {
      const out = execSync(`curl -s --max-time 170 -X POST --data-urlencode "data@/tmp/oq.txt" ${ep}`, { maxBuffer: 1 << 28 }).toString().trim();
      if (out[0] === "{") return JSON.parse(out);
    } catch (e) { /* fallthrough to retry */ }
    execSync("sleep 6"); // レート制限を避けて待機
  }
  throw new Error("overpass failed after retries");
}

// 端点一致で way 群をリング/線に連結
function stitch(ways) {
  const segs = ways.map((w) => w.slice()), out = [];
  const close = (a, b) => hav(a, b) < 0.03;
  while (segs.length) {
    let r = segs.shift(), ext = true;
    while (ext) { ext = false;
      for (let i = 0; i < segs.length; i++) { const s = segs[i], rh = r[0], rt = r[r.length - 1], sh = s[0], st = s[s.length - 1];
        if (close(rt, sh)) { r = r.concat(s.slice(1)); segs.splice(i, 1); ext = true; break; }
        if (close(rt, st)) { r = r.concat(s.slice().reverse().slice(1)); segs.splice(i, 1); ext = true; break; }
        if (close(rh, st)) { r = s.concat(r.slice(1)); segs.splice(i, 1); ext = true; break; }
        if (close(rh, sh)) { r = s.slice().reverse().concat(r.slice(1)); segs.splice(i, 1); ext = true; break; }
      }
    }
    out.push(r);
  }
  return out.sort((a, b) => b.length - a.length);
}

// --- 対象物の正確な境界リングを取得 ---
function objectRing(m) {
  if (m.kind === "polygon") {
    const gj = JSON.parse(fs.readFileSync(path.join(DOCS, `${m.id}.geojson`), "utf8"));
    return gj.features[0].geometry.coordinates[0];
  }
  if (m.kind === "water") {
    const re = m.nameRe || m.name;
    const j = overpass(`[out:json][timeout:150];(relation["natural"="water"]["name"~"${re}"];way["natural"="water"]["name"~"${re}"];);out geom;`);
    const rels = j.elements.filter((e) => e.type === "relation");
    let ways = [];
    for (const r of rels) for (const mem of (r.members || [])) if (mem.type === "way" && mem.role === "outer" && mem.geometry) ways.push(mem.geometry.map((g) => [g.lon, g.lat]));
    if (!ways.length) ways = j.elements.filter((e) => e.type === "way" && e.geometry).map((w) => w.geometry.map((g) => [g.lon, g.lat]));
    return stitch(ways)[0];
  }
  if (m.kind === "rail") {
    const j = overpass(`[out:json][timeout:150];relation["name"="${m.name}"]["type"="route"]["route"="railway"];out geom;`);
    const rels = j.elements.filter((e) => e.type === "relation");
    let ways = [];
    for (const r of rels) for (const mem of (r.members || [])) if (mem.type === "way" && mem.geometry) ways.push(mem.geometry.map((g) => [g.lon, g.lat]));
    return stitch(ways)[0];
  }
  if (m.kind === "peakRing") {
    const j = overpass(`[out:json][timeout:60];node["natural"~"peak|volcano"]["name"="${m.name}"];out;`);
    const n = j.elements.find((e) => e.type === "node");
    const c = [n.lon, n.lat];
    // 山頂中心の円（最小境界=innerKm）。道スナップ用の周回円は ringKm。
    const circle = (km) => { const r = []; for (let d = 0; d <= 360; d += 10) { const rad = d * Math.PI / 180; const dlat = (km / 111) * Math.cos(rad); const dlng = (km / (111 * Math.cos(c[1] * Math.PI / 180))) * Math.sin(rad); r.push([c[0] + dlng, c[1] + dlat]); } return r; };
    return { inner: circle(m.innerKm), ring: circle(m.ringKm) };
  }
}

// --- 道スナップ ---
function nearestOnSeg(p, a, b) { const latR = p[1] * Math.PI / 180, kx = Math.cos(latR) * 111320, ky = 110540; const px = p[0] * kx, py = p[1] * ky, ax = a[0] * kx, ay = a[1] * ky, bx = b[0] * kx, by = b[1] * ky; const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = Math.max(0, Math.min(1, t)); const cx = ax + t * dx, cy = ay + t * dy; return { dist: Math.hypot(px - cx, py - cy), pt: [cx / kx, cy / ky] }; }
function fetchRoads(ring) {
  let around = densify(ring, 1.0);
  if (around.length > 200) { const step = Math.ceil(around.length / 200); around = around.filter((_, i) => i % step === 0); }
  const coords = around.map((p) => `${p[1].toFixed(5)},${p[0].toFixed(5)}`).join(",");
  const j = overpass(`[out:json][timeout:150];way["highway"]["highway"!~"^(motorway|motorway_link|construction|proposed|raceway|bus_guideway|escape|steps|elevator|platform|corridor)$"](around:${CORRIDOR_M},${coords});out geom;`);
  return j.elements.filter((e) => e.type === "way" && e.geometry).map((e) => e.geometry.map((g) => [g.lon, g.lat]));
}
function snapToRoads(wps, ways) {
  const snapped = []; let dropped = 0;
  for (const p of wps) { let best = null;
    for (const w of ways) for (let i = 1; i < w.length; i++) { const r = nearestOnSeg(p, w[i - 1], w[i]); if (!best || r.dist < best.dist) best = r; }
    if (!best || best.dist > MAX_SNAP_KM * 1000) { dropped++; continue; }
    const last = snapped[snapped.length - 1];
    if (!last || hav(last, best.pt) > 0.03) snapped.push(best.pt);
  }
  return { snapped, dropped };
}

// --- BRouter 連結（直線ブリッジ無し）---
function tryRoute(points) { const lonlats = points.map((p) => `${p[0].toFixed(6)},${p[1].toFixed(6)}`).join("|"); const out = execSync(`curl -s --max-time 60 "https://brouter.de/brouter?lonlats=${lonlats}&profile=${PROFILE}&alternativeidx=0&format=geojson"`, { maxBuffer: 1 << 26 }).toString().trim(); execSync("sleep 0.4"); if (out[0] !== "{") return null; try { return JSON.parse(out).features[0].geometry.coordinates; } catch { return null; } }
function routePieces(wps) {
  const pieces = []; let cur = [], breaks = 0, i = 0;
  while (i < wps.length - 1) {
    let hi = Math.min(i + CHUNK - 1, wps.length - 1), c = tryRoute(wps.slice(i, hi + 1));
    while (!c && hi > i + 1) { hi--; c = tryRoute(wps.slice(i, hi + 1)); }
    if (c) { cur = cur.length ? cur.concat(c.slice(1)) : c; i = hi; }
    else { if (cur.length) { pieces.push(cur); cur = []; } breaks++; i++; }
  }
  if (cur.length) pieces.push(cur);
  return { pieces, breaks };
}
// 往復(ヒゲ)だけを短縮。直線前進は温存するため「迂回率(沿道距離/直線距離)が高い」
// 場合のみ短絡する。step=30mで道の形を保つ。
function despike(line, thM, ratio = 2.6) {
  const pts = resample(line, 0.03), D = thM / 1000, W = Math.round(3 / 0.03);
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum[i] = cum[i - 1] + hav(pts[i - 1], pts[i]);
  const out = []; let i = 0;
  while (i < pts.length) {
    out.push(pts[i]); let best = i;
    for (let j = i + 2; j < Math.min(i + W, pts.length); j++) {
      const straight = hav(pts[i], pts[j]);
      if (straight < D && (cum[j] - cum[i]) / Math.max(straight, 1e-6) > ratio) best = j;
    }
    i = best > i ? best : i + 1;
  }
  return out;
}
function hotspots(coords, cellM = 350, hotLen = 0.7, minVisits = 2) { const LAT0 = 35.6, DLAT = cellM / 1000 / 111, DLNG = cellM / 1000 / (111 * Math.cos(LAT0 * Math.PI / 180)); const rs = resample(coords, 0.03), key = (p) => Math.round(p[0] / DLNG) + "," + Math.round(p[1] / DLAT); const kc = rs.map(key), cells = new Map(); for (let i = 0; i < rs.length; i++) { const seg = i < rs.length - 1 ? hav(rs[i], rs[i + 1]) : 0; const e = cells.get(kc[i]) || { len: 0, kx: Math.round(rs[i][0] / DLNG), ky: Math.round(rs[i][1] / DLAT) }; e.len += seg; cells.set(kc[i], e); } const visits = (k) => { let v = 0, ins = false; for (const c of kc) { if (c === k) { if (!ins) { v++; ins = true; } } else ins = false; } return v; }; return [...cells.entries()].map(([k, c]) => ({ ...c, visits: visits(k) })).filter((c) => c.len >= hotLen && c.visits >= minVisits).map((c) => ({ type: "Feature", properties: { len_km: +c.len.toFixed(2), visits: c.visits }, geometry: { type: "Point", coordinates: [+(c.kx * DLNG).toFixed(5), +(c.ky * DLAT).toFixed(5)] } })); }
const countJumps = (line) => { let n = 0; for (let i = 1; i < line.length; i++) if (hav(line[i - 1], line[i]) * 1000 > JUMP_M) n++; return n; };

const only = process.argv.slice(2);
for (const m of MAPS) {
  if (only.length && !only.includes(m.id)) continue;
  try {
  // 1) 対象物の正確な境界
  const obj = objectRing(m);
  if (!obj || (m.kind !== "peakRing" && (!obj.length || obj.length < 4))) { console.log(`${m.id}: 対象物の境界が取得できず → スキップ`); continue; }
  let regionRing, waypointRing;
  if (m.kind === "peakRing") { regionRing = obj.inner; waypointRing = obj.ring; }
  else {
    let ring = obj;
    if (hav(ring[0], ring[ring.length - 1]) > 0.03) ring = ring.concat([ring[0]]); // 閉じる
    const simp = m.simpDeg ? turf.simplify(turf.lineString(ring), { tolerance: m.simpDeg, highQuality: true }).geometry.coordinates : ring;
    regionRing = simp; waypointRing = simp;
  }
  // 2) 境界(色塗り範囲)を正確版で上書き（polygon種別=半島等は既存境界を尊重して上書きしない）
  if (m.kind !== "polygon") fs.writeFileSync(path.join(DOCS, `${m.id}.geojson`), JSON.stringify({
    type: "FeatureCollection",
    _note: `${m.name} の正確な輪郭(OSM)。${m.kind === "peakRing" ? "山頂中心の最小境界円。" : ""}`,
    features: [{ type: "Feature", properties: { name: m.name, color: m.color }, geometry: { type: "Polygon", coordinates: [regionRing.concat(hav(regionRing[0], regionRing[regionRing.length - 1]) > 0.001 ? [regionRing[0]] : [])] } }],
  }));
  // 3) 周回道路の生成（スナップ→連結）
  const wp0 = densify(waypointRing, m.densifyKm);
  const ways = fetchRoads(waypointRing);
  const { snapped, dropped } = snapToRoads(wp0, ways);
  if (snapped.length && hav(snapped[0], snapped[snapped.length - 1]) > 0.03) snapped.push(snapped[0]);
  const { pieces, breaks } = routePieces(snapped);
  const cleanPieces = pieces.map((p) => despike(p, DESPIKE_M));
  const allCoords = cleanPieces.flat();
  let len = 0; for (const p of cleanPieces) for (let i = 1; i < p.length; i++) len += hav(p[i - 1], p[i]);
  const jumps = cleanPieces.reduce((s, p) => s + countJumps(p), 0);
  const hot = hotspots(allCoords);
  const geometry = cleanPieces.length === 1 ? { type: "LineString", coordinates: cleanPieces[0] } : { type: "MultiLineString", coordinates: cleanPieces };
  fs.writeFileSync(path.join(DOCS, `${m.id}-route.geojson`), JSON.stringify({ type: "FeatureCollection", _note: `${m.name} の正確な境界の周囲を、OSMの道にスナップして周回する走行ルート。`, features: [{ type: "Feature", properties: { name: `${m.name} 周回ルート`, profile: PROFILE, distance_km: +len.toFixed(1), pieces: cleanPieces.length }, geometry }] }));
  fs.writeFileSync(path.join(DOCS, `${m.id}-route-hotspots.geojson`), JSON.stringify({ type: "FeatureCollection", features: hot }));
  console.log(`${m.id.padEnd(12)} 境界${regionRing.length}点 / ルート${len.toFixed(1)}km(目安${m.targetKm}/比${(len / m.targetKm).toFixed(2)}) roads=${ways.length} drop=${dropped} pieces=${cleanPieces.length} jumps=${jumps} 密集=${hot.length}`);
  } catch (e) { console.log(`${m.id}: エラー ${String(e).slice(0, 140)}`); }
}
console.log("done.");
