// Build-time script: combine 23 ward GeoJSONs into wards.geojson + boundary.geojson
// Source N03 data crams multiple disjoint areas into one polygon's ring list
// (a ward's main landmass can sit in a non-first ring), so we reconstruct proper
// outer/hole nesting before simplifying and unioning. Run: node build.js
const fs = require("fs");
const path = require("path");
const turf = require("@turf/turf");

const DATA_DIR = path.join(__dirname, "data");
const OUT_DIR = path.join(__dirname, "docs");
fs.mkdirSync(OUT_DIR, { recursive: true });

function hslToHex(h, s, l) {
  s /= 100; l /= 100;
  const k = (n) => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const toHex = (x) => Math.round(255 * x).toString(16).padStart(2, "0");
  return `#${toHex(f(0))}${toHex(f(8))}${toHex(f(4))}`;
}

function pointInRing(pt, ring) {
  let inside = false; const x = pt[0], y = pt[1];
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function ringArea(r) {
  let a = 0;
  for (let i = 0, j = r.length - 1; i < r.length; j = i++) a += (r[j][0] + r[i][0]) * (r[j][1] - r[i][1]);
  return Math.abs(a) / 2;
}

// Collect every ring from a Polygon/MultiPolygon, then rebuild proper polygons by
// nesting depth: a ring contained in an even number of others is an outer ring,
// odd is a hole assigned to the smallest outer that contains it.
function reconstruct(geom) {
  const rings = [];
  if (geom.type === "Polygon") geom.coordinates.forEach((r) => rings.push(r));
  else if (geom.type === "MultiPolygon") geom.coordinates.forEach((p) => p.forEach((r) => rings.push(r)));

  const reps = rings.map((r) => r[0]); // any vertex; rings don't intersect, so this is unambiguous
  const depth = rings.map((_, i) =>
    rings.reduce((d, r, j) => (j !== i && pointInRing(reps[i], r) ? d + 1 : d), 0)
  );
  const outers = [], holes = [];
  rings.forEach((r, i) => (depth[i] % 2 === 0 ? outers : holes).push(i));

  const polys = outers.map((oi) => [rings[oi]]);
  holes.forEach((hi) => {
    let best = -1, bestArea = Infinity;
    outers.forEach((oi, k) => {
      if (pointInRing(reps[hi], rings[oi])) {
        const ar = ringArea(rings[oi]);
        if (ar < bestArea) { bestArea = ar; best = k; }
      }
    });
    if (best >= 0) polys[best].push(rings[hi]);
  });
  return { type: "MultiPolygon", coordinates: polys };
}

const codes = [];
for (let c = 13101; c <= 13123; c++) codes.push(String(c));

const SIMPLIFY_TOLERANCE = 0.00008; // ~9m

// Full-resolution reconstructed wards (shared edges stay coincident -> clean union)
const fullWards = codes.map((code) => {
  const fc = JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${code}.json`), "utf8"));
  const src = fc.features[0];
  return { type: "Feature", properties: { name: src.properties.N03_004, code }, geometry: reconstruct(src.geometry) };
});

// Display/detection layer: simplify each ward independently + assign color
const wardFeatures = fullWards.map((full, i) => {
  let feature = full;
  try { feature = turf.simplify(full, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true }); } catch (e) {}
  const color = hslToHex(Math.round((360 / codes.length) * i), 65, 55);
  console.log(`  ${full.properties.code} ${full.properties.name} -> ${color}`);
  return { type: "Feature", properties: { name: full.properties.name, code: full.properties.code, color }, geometry: feature.geometry };
});

const wards = { type: "FeatureCollection", features: wardFeatures };
fs.writeFileSync(path.join(OUT_DIR, "wards.geojson"), JSON.stringify(wards));
console.log(`wards.geojson: ${(fs.statSync(path.join(OUT_DIR, "wards.geojson")).size / 1024).toFixed(0)} KB`);

// Outer boundary: union the FULL-resolution wards (coincident edges dissolve cleanly),
// then simplify the single merged shape.
let merged = fullWards[0];
for (let i = 1; i < fullWards.length; i++) {
  try { merged = turf.union(turf.featureCollection([merged, fullWards[i]])); }
  catch (e) { console.warn(`  union skip ${i}: ${e.message}`); }
}
try { merged = turf.simplify(merged, { tolerance: SIMPLIFY_TOLERANCE, highQuality: true }); } catch (e) {}

// Drop tiny disjoint pieces (bay/river islets) so the outer perimeter line stays clean.
// Keep landmasses >= 0.1 km^2 (includes the merged 23-ku mainland + notable reclaimed land).
const MIN_AREA_M2 = 1e5;
if (merged.geometry.type === "MultiPolygon") {
  const kept = merged.geometry.coordinates.filter((p) => turf.area(turf.polygon(p)) >= MIN_AREA_M2);
  merged = { type: "Feature", properties: {}, geometry: { type: "MultiPolygon", coordinates: kept } };
}
const bParts = merged.geometry.type === "MultiPolygon" ? merged.geometry.coordinates.length : 1;
console.log(`boundary parts kept: ${bParts}`);
fs.writeFileSync(path.join(OUT_DIR, "boundary.geojson"), JSON.stringify({ type: "FeatureCollection", features: [merged] }));
console.log(`boundary.geojson: ${(fs.statSync(path.join(OUT_DIR, "boundary.geojson")).size / 1024).toFixed(0)} KB`);
console.log("Done.");
