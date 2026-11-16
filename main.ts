// ai-excited-01 entry v2: "Dragonfire".
// A fully procedural, deterministic image generator (Node 22+, standard
// library only). It paints a dragon diving over a burning coastal city at
// dusk — wings spread, fire breath sweeping the rooftops, a blood-red sun
// behind its wing, storm clouds split by lightning, ships fleeing the
// harbor below — and writes it as a 1024x1024 PNG to /output/entry.png
// (MAKEFUN_OUTPUT_DIR stands in outside the grader's container). Every
// random value comes from one seeded generator, so repeated runs write the
// exact same bytes. No network, no assets, no dependencies.

import { writeFileSync, mkdirSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { join } from 'node:path';

const W = 1024;
const H = 1024;
const OUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

// ---------------------------------------------------------------------------
// One seeded generator (mulberry32) — the only randomness in the program.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261117);

// ---------------------------------------------------------------------------
// Value noise + fBm on a shuffled permutation table.
// ---------------------------------------------------------------------------
const PERM = new Uint8Array(512);
{
  const p = new Uint8Array(256);
  for (let i = 0; i < 256; i++) p[i] = i;
  for (let i = 255; i > 0; i--) {
    const j = (rand() * (i + 1)) | 0;
    const tmp = p[i];
    p[i] = p[j];
    p[j] = tmp;
  }
  for (let i = 0; i < 512; i++) PERM[i] = p[i & 255];
}

function hash2(ix: number, iy: number): number {
  return PERM[(PERM[ix & 255] + iy) & 255] / 255;
}
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}
function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = smootherstep(x - ix);
  const fy = smootherstep(y - iy);
  const a = hash2(ix, iy);
  const b = hash2(ix + 1, iy);
  const c = hash2(ix, iy + 1);
  const d = hash2(ix + 1, iy + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}
function fbm(x: number, y: number, octaves: number): number {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * vnoise(x * freq, y * freq);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

// Bilinear sample of a square grid (values in [0,1]). Coordinates mirror
// (ping-pong) instead of wrapping, so the noise tiles with no visible seams.
function sampleGrid(grid: Float32Array, u: number, v: number): number {
  const n = Math.round(Math.sqrt(grid.length));
  u = Math.abs(((u % 2) + 2) % 2 - 1);
  v = Math.abs(((v % 2) + 2) % 2 - 1);
  if (u > 1) u = 2 - u;
  if (v > 1) v = 2 - v;
  const x = u * (n - 1);
  const y = v * (n - 1);
  let ix = Math.floor(x);
  let iy = Math.floor(y);
  if (ix < 0) ix = 0;
  if (iy < 0) iy = 0;
  if (ix > n - 2) ix = n - 2;
  if (iy > n - 2) iy = n - 2;
  const fx = x - ix;
  const fy = y - iy;
  const a = grid[iy * n + ix];
  const b = grid[iy * n + ix + 1];
  const c = grid[(iy + 1) * n + ix];
  const d = grid[(iy + 1) * n + ix + 1];
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

// Cloud density grid: domain-warped fBm for billowing storm shapes.
const CG = 256;
const cloudGrid = new Float32Array(CG * CG);
for (let j = 0; j < CG; j++) {
  for (let i = 0; i < CG; i++) {
    const u = i / (CG - 1);
    const v = j / (CG - 1);
    const wx = fbm(u * 3.1 + 7.3, v * 3.1 + 2.9, 3) - 0.5;
    const wy = fbm(u * 3.1 + 1.7, v * 3.1 + 8.4, 3) - 0.5;
    cloudGrid[j * CG + i] = fbm(u * 3.4 + wx * 0.55, v * 3.4 + wy * 0.55, 5);
  }
}

// Fine fBm grid for water shimmer, flame turbulence and texture.
const FG = 256;
const fineGrid = new Float32Array(FG * FG);
for (let j = 0; j < FG; j++) {
  for (let i = 0; i < FG; i++) {
    const u = i / (FG - 1);
    const v = j / (FG - 1);
    fineGrid[j * FG + i] = fbm(u * 9.0 + 3.1, v * 9.0 + 5.7, 4);
  }
}

// ---------------------------------------------------------------------------
// PNG encoder (RGB, 8-bit, adaptive per-row filtering, zlib deflate level 9).
// Pure standard library: node:zlib plus a small CRC32 table.
// ---------------------------------------------------------------------------
const CRC_TABLE = new Int32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  CRC_TABLE[n] = c;
}
function crc32(buf: Buffer, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function pngChunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out, 4, 8 + data.length), 8 + data.length);
  return out;
}

// Score a filtered row the way libpng does: sum of absolute values of the
// signed bytes. Lower scores compress better.
function filterScore(row: Buffer, len: number): number {
  let s = 0;
  for (let i = 0; i < len; i++) {
    const b = row[i];
    s += b < 128 ? b : 256 - b;
  }
  return s;
}

function encodePNG(rgb: Uint8Array, width: number, height: number): Buffer {
  const stride = width * 3;
  const raw = Buffer.alloc((stride + 1) * height);
  const cand = Buffer.alloc(stride);
  const best = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * stride;
    const hasPrev = y > 0;
    const prevOff = rowOff - stride;
    let bestType = 0;
    let bestScore = Infinity;
    for (let f = 0; f <= 4; f++) {
      for (let x = 0; x < stride; x++) {
        const a = x >= 3 ? rgb[rowOff + x - 3] : 0;
        const b = hasPrev ? rgb[prevOff + x] : 0;
        const c = x >= 3 && hasPrev ? rgb[prevOff + x - 3] : 0;
        let pred = 0;
        if (f === 1) pred = a;
        else if (f === 2) pred = b;
        else if (f === 3) pred = (a + b) >> 1;
        else if (f === 4) {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        cand[x] = (rgb[rowOff + x] - pred) & 0xff;
      }
      const s = filterScore(cand, stride);
      if (s < bestScore) {
        bestScore = s;
        bestType = f;
        best.set(cand);
      }
    }
    const outOff = y * (stride + 1);
    raw[outOff] = bestType;
    best.copy(raw, outOff + 1, 0, stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 = RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------
function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}
function smoothstep(a: number, b: number, x: number): number {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
}
function pointSegDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.sqrt((px - cx) * (px - cx) + (py - cy) * (py - cy));
}
// Even-odd point-in-polygon test. poly is a flat [x0,y0,x1,y1,...] array.
function inPolygon(px: number, py: number, poly: number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i * 2];
    const yi = poly[i * 2 + 1];
    const xj = poly[j * 2];
    const yj = poly[j * 2 + 1];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function polyEdgeDist(px: number, py: number, poly: number[]): number {
  let m = Infinity;
  const n = poly.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const d = pointSegDist(px, py, poly[i * 2], poly[i * 2 + 1], poly[j * 2], poly[j * 2 + 1]);
    if (d < m) m = d;
  }
  return m;
}
// Signed distance to a filled polygon: negative inside.
function polySDF(px: number, py: number, poly: number[]): number {
  const d = polyEdgeDist(px, py, poly);
  return inPolygon(px, py, poly) ? -d : d;
}

// ---------------------------------------------------------------------------
// Scene layout (pixels, origin top-left).
// ---------------------------------------------------------------------------
const CITY_BASE = 862; // rooftops sit above this; harbor water below it
const SUN_X = 830;
const SUN_Y = 592;
const SUN_R = 48;

// Sky base gradient, precomputed per row (top -> city line).
const SKY_STOPS: [number, number, number, number][] = [
  [0.0, 8, 7, 30],
  [0.25, 24, 16, 58],
  [0.45, 62, 30, 74],
  [0.62, 138, 58, 62],
  [0.78, 208, 96, 48],
  [0.845, 226, 120, 52],
];
const skyRows = new Float32Array(H * 3);
for (let y = 0; y < H; y++) {
  const t = y / H;
  let a = SKY_STOPS[0];
  let b = SKY_STOPS[SKY_STOPS.length - 1];
  for (let s = 0; s < SKY_STOPS.length - 1; s++) {
    if (t >= SKY_STOPS[s][0] && t <= SKY_STOPS[s + 1][0]) {
      a = SKY_STOPS[s];
      b = SKY_STOPS[s + 1];
      break;
    }
  }
  const f = b[0] === a[0] ? 0 : (t - a[0]) / (b[0] - a[0]);
  skyRows[y * 3] = a[1] + (b[1] - a[1]) * f;
  skyRows[y * 3 + 1] = a[2] + (b[2] - a[2]) * f;
  skyRows[y * 3 + 2] = a[3] + (b[3] - a[3]) * f;
}

// Stars: sparse at dusk, only in the upper sky, drawn before the clouds.
const starGrid = new Float32Array(W * H);
{
  for (let i = 0; i < 260; i++) {
    const x = (rand() * W) | 0;
    const y = (rand() * 0.38 * H) | 0;
    const b = 0.1 + Math.pow(rand(), 3.0) * 0.8;
    if (b > starGrid[y * W + x]) starGrid[y * W + x] = b;
  }
}

// Lightning bolt: seeded random-walk polyline with branches.
type Seg = [number, number, number, number];
function makeBolt(x0: number, y0: number, x1: number, y1: number, steps: number, jitter: number): Seg[] {
  const segs: Seg[] = [];
  const pts: [number, number][] = [[x0, y0]];
  let px = x0;
  let py = y0;
  for (let s = 1; s <= steps; s++) {
    const t = s / steps;
    const tx = x0 + (x1 - x0) * t + (rand() - 0.5) * jitter * 2;
    const ty = y0 + (y1 - y0) * t + (rand() - 0.5) * jitter * 0.5;
    segs.push([px, py, tx, ty]);
    px = tx;
    py = ty;
    pts.push([px, py]);
  }
  for (const bi of [Math.floor(steps * 0.35), Math.floor(steps * 0.6)]) {
    const [bx, by] = pts[bi];
    const dir = rand() < 0.5 ? -1 : 1;
    let cx = bx;
    let cy = by;
    const blen = 3 + ((rand() * 3) | 0);
    for (let s = 0; s < blen; s++) {
      const nx = cx + dir * (14 + rand() * 22);
      const ny = cy + 16 + rand() * 22;
      segs.push([cx, cy, nx, ny]);
      cx = nx;
      cy = ny;
    }
  }
  return segs;
}
const BOLT = (() => {
  const segs = makeBolt(0.15 * W, 0.06 * H, 0.24 * W, 0.44 * H, 17, 16);
  let x0 = Infinity;
  let x1 = -Infinity;
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [ax, ay, bx, by] of segs) {
    x0 = Math.min(x0, ax, bx);
    x1 = Math.max(x1, ax, bx);
    y0 = Math.min(y0, ay, by);
    y1 = Math.max(y1, ay, by);
  }
  const m = 120;
  return {
    segs,
    x0: Math.max(0, Math.floor(x0 - m)),
    x1: Math.min(W - 1, Math.ceil(x1 + m)),
    y0: Math.max(0, Math.floor(y0 - m)),
    y1: Math.min(H - 1, Math.ceil(y1 + m)),
    topX: segs[0][0],
    topY: segs[0][1],
  };
})();

// ---------------------------------------------------------------------------
// The dragon. A diving silhouette built from a tapered spine tube, two wing
// membranes (point-in-polygon), a horned head, legs and a spade-tipped tail.
// Head is down-left, body sweeps up-right, tail curls toward the top-right.
// ---------------------------------------------------------------------------
// Spine: [x, y, radius] from neck to tail tip.
const SPINE: [number, number, number][] = [
  [452, 372, 26],
  [500, 352, 32],
  [552, 336, 40],
  [606, 316, 44],
  [662, 296, 42],
  [714, 278, 36],
  [764, 258, 28],
  [812, 238, 20],
  [856, 220, 13],
  [894, 206, 8],
  [920, 196, 4],
];
// Head: circle + snout wedge + horns + open jaw (mouth is the fire source).
const HEAD_CX = 428;
const HEAD_CY = 382;
const HEAD_R = 34;
const SNOUT = [452, 366, 398, 392, 386, 414, 424, 412, 448, 398]; // flat poly
const HORN1 = [438, 352, 500, 306, 456, 360]; // swept-back horn
const HORN2 = [414, 358, 452, 304, 430, 366];
const JAW = [448, 396, 396, 424, 388, 432, 430, 420, 452, 406]; // open lower jaw
const MOUTH_X = 392;
const MOUTH_Y = 418;
// Tail spade.
const SPADE = [920, 196, 946, 178, 954, 198, 928, 210];
// Near wing (right, below the body): membrane polygon + finger tips.
const WING_NEAR = [556, 332, 648, 470, 742, 548, 838, 508, 884, 414, 800, 356, 668, 338];
const WING_NEAR_FINGERS: [number, number][] = [
  [648, 470],
  [742, 548],
  [838, 508],
  [884, 414],
];
// Far wing (left, above the body): slightly smaller, darker.
const WING_FAR = [536, 324, 440, 186, 336, 148, 252, 192, 208, 272, 330, 300, 452, 322];
const WING_FAR_FINGERS: [number, number][] = [
  [440, 186],
  [336, 148],
  [252, 192],
  [208, 272],
];
// Legs: bent tubes with claws, hanging under the body.
const LEG1: [number, number, number, number, number][] = [
  // x1,y1,x2,y2,radius
  [584, 352, 612, 420, 11],
  [612, 420, 646, 448, 8],
];
const LEG2: [number, number, number, number, number][] = [
  [700, 302, 736, 372, 11],
  [736, 372, 772, 398, 8],
];

const DRAGON_BBOX = { x0: 180, x1: 970, y0: 120, y1: 570 };

// Signed distance to the dragon silhouette (negative inside). Also reports
// which part is nearest: 0 body/head/legs, 1 near wing, 2 far wing.
function dragonSDF(x: number, y: number): [number, number] {
  let d = Infinity;
  let part = 0;
  // Spine tube with linearly interpolated radius.
  for (let i = 0; i < SPINE.length - 1; i++) {
    const [ax, ay, ar] = SPINE[i];
    const [bx, by, br] = SPINE[i + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((x - ax) * dx + (y - ay) * dy) / len2;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    const r = ar + (br - ar) * t;
    const dd = Math.sqrt((x - cx) * (x - cx) + (y - cy) * (y - cy)) - r;
    if (dd < d) {
      d = dd;
      part = 0;
    }
  }
  // Head circle.
  {
    const dd = Math.sqrt((x - HEAD_CX) * (x - HEAD_CX) + (y - HEAD_CY) * (y - HEAD_CY)) - HEAD_R;
    if (dd < d) {
      d = dd;
      part = 0;
    }
  }
  // Snout, horns, jaw, spade.
  for (const poly of [SNOUT, HORN1, HORN2, JAW, SPADE]) {
    const dd = polySDF(x, y, poly);
    if (dd < d) {
      d = dd;
      part = 0;
    }
  }
  // Legs.
  for (const leg of [LEG1, LEG2]) {
    for (const [ax, ay, bx, by, r] of leg) {
      const dd = pointSegDist(x, y, ax, ay, bx, by) - r;
      if (dd < d) {
        d = dd;
        part = 0;
      }
    }
  }
  // Wings (checked last so the body wins overlaps).
  const dn = polySDF(x, y, WING_NEAR);
  if (dn < d) {
    d = dn;
    part = 1;
  }
  const df = polySDF(x, y, WING_FAR);
  if (df < d) {
    d = df;
    part = 2;
  }
  return [d, part];
}

// Wing finger bones: distance to the nearest bone line (for darkening).
function wingBoneDist(x: number, y: number, shoulderX: number, shoulderY: number, fingers: [number, number][]): number {
  let m = Infinity;
  for (const [tx, ty] of fingers) {
    const d = pointSegDist(x, y, shoulderX, shoulderY, tx, ty);
    if (d < m) m = d;
  }
  return m;
}

// ---------------------------------------------------------------------------
// Fire breath: a turbulent cone from the dragon's mouth sweeping down-left
// onto the rooftops.
// ---------------------------------------------------------------------------
const FLAME_EX = 132;
const FLAME_EY = 648;
const FLAME_DX = FLAME_EX - MOUTH_X;
const FLAME_DY = FLAME_EY - MOUTH_Y;
const FLAME_LEN = Math.sqrt(FLAME_DX * FLAME_DX + FLAME_DY * FLAME_DY);
const FLAME_UX = FLAME_DX / FLAME_LEN;
const FLAME_UY = FLAME_DY / FLAME_LEN;
const FLAME_BBOX = { x0: 60, x1: 430, y0: 380, y1: 760 };

// Flame intensity at a point: 0 outside, up to ~1.6 in the white core.
function flameAt(x: number, y: number): number {
  const px = x - MOUTH_X;
  const py = y - MOUTH_Y;
  const along = px * FLAME_UX + py * FLAME_UY;
  if (along < -8 || along > FLAME_LEN + 30) return 0;
  const t = along / FLAME_LEN;
  const perp = -px * FLAME_UY + py * FLAME_UX;
  const halfW = 15 + t * 92;
  // Turbulence grows down the cone and licks the edges.
  const turb = (sampleGrid(fineGrid, t * 3.2 + 0.7, (perp / 90 + 1) * 1.4) - 0.5) * (20 + 70 * t);
  const lick = Math.sin(t * 34 + sampleGrid(fineGrid, t * 6, 0.3) * 6) * 7 * t;
  const dd = Math.abs(perp + turb + lick);
  if (dd >= halfW) return 0;
  const shape = 1 - dd / halfW;
  const flick = 0.80 + 0.45 * sampleGrid(fineGrid, t * 5.5, 1.9);
  return Math.pow(shape, 1.35) * (1 - t * 0.5) * flick;
}

// ---------------------------------------------------------------------------
// The burning city: a seeded skyline along the harbor. Per-column arrays
// give each building's roofline; a few buildings burn.
// ---------------------------------------------------------------------------
type Building = {
  x0: number;
  x1: number;
  top: number;
  roof: number; // 0 flat, 1 peaked, 2 spire, 3 dome
  burning: boolean;
  seed: number;
};
const BUILDINGS: Building[] = [];
const bTop = new Float32Array(W);
const bIdx = new Int16Array(W);
{
  let x = -8;
  let bi = 0;
  while (x < W + 8) {
    const w = 30 + rand() * 46;
    const h = 46 + Math.pow(rand(), 1.4) * 128;
    const roof = rand() < 0.45 ? 0 : rand() < 0.6 ? 1 : rand() < 0.75 ? 2 : 3;
    const top = CITY_BASE - h;
    BUILDINGS.push({ x0: Math.floor(x), x1: Math.floor(x + w), top, roof, burning: false, seed: bi * 7 + 3 });
    x += w + 2 + rand() * 8;
    bi++;
  }
  // Choose the burning buildings: one under the flame cone, two more spread out.
  const burnPick = [1, Math.floor(BUILDINGS.length * 0.38), Math.floor(BUILDINGS.length * 0.58)];
  for (const i of burnPick) {
    if (BUILDINGS[i]) BUILDINGS[i].burning = true;
  }
  // Fill per-column roofline, accounting for roof shapes.
  bTop.fill(CITY_BASE);
  bIdx.fill(-1);
  for (let i = 0; i < BUILDINGS.length; i++) {
    const b = BUILDINGS[i];
    for (let cx = Math.max(0, b.x0); cx < Math.min(W, b.x1); cx++) {
      const f = (cx - b.x0) / Math.max(1, b.x1 - b.x0);
      let top = b.top;
      if (b.roof === 1) top -= Math.sin(f * Math.PI) * 14; // peaked
      else if (b.roof === 2) top -= f > 0.44 && f < 0.56 ? 34 : Math.sin(f * Math.PI) * 6; // spire
      else if (b.roof === 3) top -= Math.sin(f * Math.PI) * 16; // dome
      bTop[cx] = top;
      bIdx[cx] = i;
    }
  }
}
// Flame plume + smoke column for each burning building.
const FIRE_COLS = BUILDINGS.filter((b) => b.burning).map((b) => ({
  cx: (b.x0 + b.x1) / 2,
  top: b.top,
  w: b.x1 - b.x0,
}));

// ---------------------------------------------------------------------------
// Fleeing ships in the harbor.
// ---------------------------------------------------------------------------
type Ship = { hx: number; hy: number; len: number; dir: number; scale: number };
const SHIPS: Ship[] = [
  { hx: 150, hy: 916, len: 120, dir: -1, scale: 1.0 },
  { hx: 660, hy: 934, len: 96, dir: 1, scale: 0.85 },
  { hx: 878, hy: 898, len: 64, dir: -1, scale: 0.6 },
];
// Ship silhouette as polygons, computed per ship at draw time.
function shipPolys(s: Ship): { hull: number[]; sail1: number[]; sail2: number[]; mastX: number; mastTop: number; mastBot: number } {
  const k = s.scale;
  const x = s.hx;
  const y = s.hy;
  const L = s.len;
  const hull = [
    x - L / 2, y - 12 * k,
    x + L / 2, y - 12 * k,
    x + L / 2 - 10 * k, y + 8 * k,
    x - L / 2 + 12 * k, y + 8 * k,
  ];
  const mx = x + s.dir * L * 0.08;
  const mastTop = y - 74 * k;
  // Two triangular sails, billowed leeward.
  const sail1 = [
    mx, mastTop,
    mx + s.dir * 42 * k, y - 26 * k,
    mx - s.dir * 6 * k, y - 24 * k,
  ];
  const sail2 = [
    mx, mastTop + 26 * k,
    mx - s.dir * 32 * k, y - 30 * k,
    mx + s.dir * 4 * k, y - 28 * k,
  ];
  return { hull, sail1, sail2, mastX: mx, mastTop, mastBot: y - 10 * k };
}

// ---------------------------------------------------------------------------
// Embers: bright sparks rising from the fires, drawn in a post pass.
// ---------------------------------------------------------------------------
type Ember = { x: number; y: number; r: number; b: number; trail: number };
const EMBERS: Ember[] = [];
{
  for (let i = 0; i < 340; i++) {
    // Cluster near the flame cone and the burning buildings, thinning upward.
    let x: number;
    let y: number;
    const pick = rand();
    if (pick < 0.45) {
      const t = rand();
      x = MOUTH_X + FLAME_UX * FLAME_LEN * t + (rand() - 0.5) * (50 + 160 * t);
      y = MOUTH_Y + FLAME_UY * FLAME_LEN * t + (rand() - 0.5) * (50 + 120 * t) - rand() * 60;
    } else if (pick < 0.8) {
      const c = FIRE_COLS[(rand() * FIRE_COLS.length) | 0];
      x = c.cx + (rand() - 0.5) * (c.w + 90);
      y = c.top - rand() * 210;
    } else {
      x = rand() * W;
      y = 480 + rand() * 380;
    }
    if (x < 2 || x > W - 3 || y < 2 || y > H - 3) continue;
    EMBERS.push({
      x,
      y,
      r: 0.7 + Math.pow(rand(), 2.4) * 2.2,
      b: 0.35 + Math.pow(rand(), 1.6) * 0.65,
      trail: rand() < 0.4 ? 4 + rand() * 10 : 0,
    });
  }
}

// Dorsal spikes along the spine: small swept-back triangles.
const SPIKES: number[][] = [];
{
  for (let i = 1; i < SPINE.length - 2; i++) {
    const [px, py, pr] = SPINE[i];
    const [nx, ny] = SPINE[i + 1];
    let dx = nx - px;
    let dy = ny - py;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len;
    dy /= len;
    // "Up" normal (spine runs left-down -> right-up).
    const ux = dy;
    const uy = -dx;
    const bx = px + ux * pr * 0.9;
    const by = py + uy * pr * 0.9;
    const hgt = 12 + 16 * (1 - i / (SPINE.length - 2));
    const hw = 7;
    SPIKES.push([
      bx - dx * hw, by - dy * hw,
      bx + dx * hw, by + dy * hw,
      bx + ux * hgt - dx * 7, by + uy * hgt - dy * 7,
    ]);
  }
}
function spikeSDF(x: number, y: number): number {
  let d = Infinity;
  for (const poly of SPIKES) {
    const dd = polySDF(x, y, poly);
    if (dd < d) d = dd;
  }
  return d;
}

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------
const img = new Uint8Array(W * H * 3);

for (let y = 0; y < H; y++) {
  const v = y / H;
  const skyR = skyRows[y * 3];
  const skyG = skyRows[y * 3 + 1];
  const skyB = skyRows[y * 3 + 2];
  const inWater = y >= CITY_BASE;
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const idx = (y * W + x) * 3;
    let r: number;
    let g: number;
    let b: number;

    if (!inWater) {
      // --- sky base ---
      r = skyR;
      g = skyG;
      b = skyB;

      // --- stars ---
      const star = starGrid[y * W + x];
      if (star > 0) {
        const s = star * 200;
        r += s;
        g += s;
        b += s * 1.05;
      }

      // --- blood-red sun: disc + halo + haze bands ---
      {
        const dx = x - SUN_X;
        const dy = y - SUN_Y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 420 * 420) {
          const d = Math.sqrt(d2);
          if (d < SUN_R) {
            const f = d / SUN_R;
            const haze = 0.92 + 0.08 * Math.sin(y * 0.42 + 1.7);
            r = (255 - 45 * f) * haze;
            g = (118 - 55 * f) * haze;
            b = (52 - 22 * f) * haze;
          } else {
            const halo = Math.exp(-(d - SUN_R) / 85);
            const wide = Math.exp(-(d - SUN_R) / 200);
            r += 230 * halo * 0.5 + 170 * wide * 0.15;
            g += 105 * halo * 0.5 + 70 * wide * 0.15;
            b += 45 * halo * 0.5 + 30 * wide * 0.15;
          }
        }
      }

      // --- storm clouds: a heavy mass upper-left, thin wisps elsewhere ---
      {
        const eu = (u - 0.22) / 0.36;
        const ev = (v - 0.15) / 0.30;
        let m = 1 - (eu * eu + ev * ev);
        m = m <= 0 ? 0 : m * m * (3 - 2 * m);
        const d = sampleGrid(cloudGrid, u * 1.9, v * 2.1);
        const d2 = d * (0.66 + 0.55 * m) + m * 0.13;
        const a = smoothstep(0.56, 0.80, d2) * (0.35 + 0.65 * m);
        if (a > 0.01) {
          const dAbove = sampleGrid(cloudGrid, u * 1.9, (v - 0.012) * 2.1);
          const edge = clamp01((d2 - dAbove) * 6) * a;
          let cr = 26;
          let cg = 22;
          let cb = 46;
          // Underlit bellies catch the burning horizon.
          const under = Math.pow(clamp01(v / 0.62), 3.5) * a;
          cr += 210 * under * 0.75;
          cg += 95 * under * 0.75;
          cb += 45 * under * 0.75;
          // Pale lit edges on top.
          cr += 150 * edge * 0.5;
          cg += 140 * edge * 0.5;
          cb += 175 * edge * 0.5;
          if (cr > 235) cr = 235;
          if (cg > 235) cg = 235;
          if (cb > 235) cb = 235;
          r = r * (1 - a) + cr * a;
          g = g * (1 - a) + cg * a;
          b = b * (1 - a) + cb * a;
        }
        // Thin high wisps across the top.
        if (v < 0.30) {
          const w = sampleGrid(cloudGrid, u * 1.7 + 0.4, v * 2.2 + 0.2);
          const wa = smoothstep(0.60, 0.78, w) * 0.20;
          if (wa > 0.01) {
            const wr = 150;
            const wg = 130;
            const wb = 170;
            r = r * (1 - wa) + wr * wa;
            g = g * (1 - wa) + wg * wa;
            b = b * (1 - wa) + wb * wa;
          }
        }
      }

      // --- smoke columns rising from the burning buildings ---
      for (let ci = 0; ci < FIRE_COLS.length; ci++) {
        const col = FIRE_COLS[ci];
        const rise = col.top - y;
        if (rise <= 0 || rise > 330) continue;
        const halfW = col.w / 2 + rise * 0.28 + 18;
        const dx = x - (col.cx + rise * 0.22);
        if (Math.abs(dx) > halfW) continue;
        const n = fbm(dx / 95 + ci * 3.1 + rise * 0.004, rise / 130 + ci * 2.7, 3);
        const edgeFade = 1 - smoothstep(0.55, 1.0, Math.abs(dx) / halfW);
        const topFade = 1 - smoothstep(240, 330, rise);
        const a = smoothstep(0.40, 0.70, n) * 0.88 * edgeFade * topFade;
        if (a > 0.01) {
          const lit = Math.exp(-rise / 110);
          const sr = 26 + 130 * lit;
          const sg = 22 + 62 * lit;
          const sb = 32 + 26 * lit;
          r = r * (1 - a) + sr * a;
          g = g * (1 - a) + sg * a;
          b = b * (1 - a) + sb * a;
        }
      }

      // --- flame plumes above the burning rooftops ---
      for (let ci = 0; ci < FIRE_COLS.length; ci++) {
        const col = FIRE_COLS[ci];
        const rise = col.top - y;
        if (rise <= 0 || rise > 95) continue;
        const halfW = col.w / 2 + 12;
        const dx = x - col.cx;
        if (Math.abs(dx) > halfW) continue;
        const n = sampleGrid(fineGrid, (dx / 46) + ci * 2.3, rise / 60 + ci * 1.1);
        const fl = smoothstep(0.42, 0.72, n) * (1 - rise / 100) * (1 - Math.abs(dx) / (halfW + 6));
        if (fl > 0.01) {
          r += 255 * fl * 1.15;
          g += (110 + 90 * fl) * fl;
          b += 30 * fl;
        }
      }

      // --- lightning (additive, inside the bolt bounding box) ---
      if (x >= BOLT.x0 && x <= BOLT.x1 && y >= BOLT.y0 && y <= BOLT.y1) {
        let minD = Infinity;
        for (let s = 0; s < BOLT.segs.length; s++) {
          const [ax, ay, bx, by] = BOLT.segs[s];
          const d = pointSegDist(x, y, ax, ay, bx, by);
          if (d < minD) minD = d;
        }
        if (minD < 110) {
          const core = Math.exp(-Math.pow(minD / 1.3, 2));
          const glow = Math.exp(-minD / 22);
          r += 225 * core + 130 * glow * 0.8;
          g += 232 * core + 145 * glow * 0.8;
          b += 255 * core + 250 * glow * 0.8;
        }
      }

      // --- the dragon ---
      if (x >= DRAGON_BBOX.x0 && x <= DRAGON_BBOX.x1 && y >= DRAGON_BBOX.y0 && y <= DRAGON_BBOX.y1) {
        let [d, part] = dragonSDF(x, y);
        const ds = spikeSDF(x, y);
        if (ds < d) {
          d = ds;
          part = 0;
        }
        if (d < 0) {
          const n = sampleGrid(fineGrid, u * 4.5, v * 4.5) - 0.5;
          if (part === 0) {
            r = 24 + n * 14;
            g = 18 + n * 10;
            b = 34 + n * 12;
            // Fire glow on the underside near the breath and the city.
            const glow = clamp01((y - 320) / 260) * 0.55 + clamp01(1 - Math.hypot(x - MOUTH_X, y - MOUTH_Y) / 260) * 0.6;
            r += 150 * glow;
            g += 55 * glow;
            b += 18 * glow;
          } else if (part === 1) {
            // Near wing membrane: dark maroon, translucent near the sun.
            r = 48 + n * 12;
            g = 20 + n * 8;
            b = 28 + n * 8;
            const sunD = Math.hypot(x - SUN_X, y - SUN_Y);
            const trans = Math.exp(-sunD / 260) * clamp01(1 - -d / 34);
            r += 170 * trans;
            g += 60 * trans;
            b += 22 * trans;
            const bone = wingBoneDist(x, y, 556, 332, WING_NEAR_FINGERS);
            if (bone < 4.5) {
              const bf = 1 - bone / 4.5;
              r *= 1 - 0.5 * bf;
              g *= 1 - 0.5 * bf;
              b *= 1 - 0.5 * bf;
            }
          } else {
            // Far wing: darker, cooler.
            r = 27 + n * 10;
            g = 15 + n * 7;
            b = 28 + n * 8;
            const bone = wingBoneDist(x, y, 536, 324, WING_FAR_FINGERS);
            if (bone < 4) {
              const bf = 1 - bone / 4;
              r *= 1 - 0.45 * bf;
              g *= 1 - 0.45 * bf;
              b *= 1 - 0.45 * bf;
            }
          }
          // Rim light: gradient normal vs fire (below-left) and sun (below-right).
          if (d > -10) {
            const e = 2;
            const gx = dragonSDF(x + e, y)[0] - dragonSDF(x - e, y)[0];
            const gy = dragonSDF(x, y + e)[0] - dragonSDF(x, y - e)[0];
            const gl = Math.sqrt(gx * gx + gy * gy) || 1;
            const nx = gx / gl;
            const ny = gy / gl;
            let fx = 300 - x;
            let fy = 720 - y;
            const fl = Math.sqrt(fx * fx + fy * fy) || 1;
            fx /= fl;
            fy /= fl;
            let sx = SUN_X - x;
            let sy = SUN_Y - y;
            const sl = Math.sqrt(sx * sx + sy * sy) || 1;
            sx /= sl;
            sy /= sl;
            const warm = Math.max(0, nx * fx + ny * fy) + 0.8 * Math.max(0, nx * sx + ny * sy);
            const cool = Math.max(0, -ny);
            const edge = 1 - -d / 10;
            const rw = Math.min(1.4, warm) * edge;
            const rc = cool * edge * 0.55;
            r += 255 * rw * 0.85 + 110 * rc;
            g += 130 * rw * 0.85 + 150 * rc;
            b += 55 * rw * 0.85 + 235 * rc;
          }
          // The eye: a burning amber dot that makes the head read.
          const ed = Math.hypot(x - 414, y - 370);
          if (ed < 12) {
            const glow = Math.exp(-ed / 4.5);
            r += 255 * glow;
            g += 190 * glow;
            b += 70 * glow;
            if (ed < 3.2) {
              r = 255;
              g = 225;
              b = 130;
            }
          }
        }
      }

      // --- fire breath (additive, over sky and dragon) ---
      if (x >= FLAME_BBOX.x0 && x <= FLAME_BBOX.x1 && y >= FLAME_BBOX.y0 && y <= FLAME_BBOX.y1) {
        const f = flameAt(x, y);
        if (f > 0.01) {
          const core = smoothstep(0.55, 1.15, f);
          r += (255 * core + 255 * (1 - core)) * f * 1.05;
          g += (240 * core + 120 * (1 - core)) * f * 1.05;
          b += (190 * core + 28 * (1 - core)) * f * 1.05;
        }
      }

      // --- the city ---
      if (y >= bTop[x] && y < CITY_BASE) {
        const bi = bIdx[x];
        const bd = bi >= 0 ? BUILDINGS[bi] : null;
        const shade = bd ? 0.85 + 0.3 * hash2(bd.seed, 5) : 1;
        r = 17 * shade;
        g = 13 * shade;
        b = 22 * shade;
        // Warm wash from the fires on the burning buildings.
        if (bd && bd.burning) {
          const wash = clamp01(1 - (y - bd.top) / 130);
          r += 90 * wash;
          g += 34 * wash;
          b += 12 * wash;
        }
        // Rooftop rim where the firelight catches it.
        if (y - bTop[x] < 2 && x < 520) {
          const rim = (1 - (y - bTop[x]) / 2) * 0.6;
          r += 255 * rim;
          g += 120 * rim;
          b += 50 * rim;
        }
        // Windows.
        if (bd) {
          const wx = (x - bd.x0) % 20;
          const wy = (y - Math.floor(bd.top)) % 24;
          if (wx >= 7 && wx <= 13 && wy >= 7 && wy <= 15) {
            const wcol = Math.floor((x - bd.x0) / 20);
            const wrow = Math.floor((y - Math.floor(bd.top)) / 24);
            const h = hash2(bd.seed * 13 + wcol * 5, wrow * 7 + 2);
            const litProb = bd.burning ? 0.78 : 0.30;
            if (h < litProb) {
              const h2 = hash2(wcol * 11 + 1, wrow * 3 + bd.seed);
              if (bd.burning) {
                r = 255;
                g = 105 + 75 * h2;
                b = 26;
              } else {
                r = 255 * (0.6 + 0.4 * h2);
                g = 185 * (0.6 + 0.4 * h2);
                b = 90 * (0.6 + 0.4 * h2);
              }
            }
          }
        }
        // Fire breath washes over the rooftops too.
        if (x >= FLAME_BBOX.x0 && x <= FLAME_BBOX.x1 && y >= FLAME_BBOX.y0 && y <= FLAME_BBOX.y1) {
          const f = flameAt(x, y);
          if (f > 0.01) {
            const core = smoothstep(0.55, 1.15, f);
            r += 255 * f * 1.05;
            g += (240 * core + 120 * (1 - core)) * f * 1.05;
            b += (190 * core + 28 * (1 - core)) * f * 1.05;
          }
        }
      }
    } else {
      // --- harbor water ---
      const t = (y - CITY_BASE) / (H - CITY_BASE);
      r = 26 + (12 - 26) * t;
      g = 20 + (10 - 20) * t;
      b = 44 + (24 - 44) * t;
      // Warm horizon glow.
      const hg = Math.exp(-(y - CITY_BASE) / 110) * 0.55;
      r += 130 * hg;
      g += 55 * hg;
      b += 24 * hg;
      // Wave banding.
      const w = sampleGrid(fineGrid, u * 1.6, v * 11.0);
      const mult = 0.80 + w * 0.40;
      r *= mult;
      g *= mult;
      b *= mult;
      // Fire reflections under the burning buildings.
      for (let ci = 0; ci < FIRE_COLS.length; ci++) {
        const col = FIRE_COLS[ci];
        const dx = (x - col.cx) / (col.w * 0.85 + 26);
        const streak = Math.exp(-dx * dx) * Math.exp(-(y - CITY_BASE) / 250);
        if (streak > 0.01) {
          const flick = 0.55 + 0.75 * sampleGrid(fineGrid, x / 110 + ci, y / 42);
          r += 255 * streak * flick * 0.85;
          g += 110 * streak * flick * 0.85;
          b += 30 * streak * flick * 0.85;
        }
      }
      // Sun reflection streak.
      {
        const dx = (x - SUN_X) / 70;
        const streak = Math.exp(-dx * dx) * Math.exp(-(y - CITY_BASE) / 300);
        if (streak > 0.01) {
          const flick = 0.55 + 0.75 * sampleGrid(fineGrid, x / 90 + 3, y / 38);
          r += 255 * streak * flick * 0.7;
          g += 130 * streak * flick * 0.7;
          b += 55 * streak * flick * 0.7;
        }
      }
      // Ships.
      for (let si = 0; si < SHIPS.length; si++) {
        const s = SHIPS[si];
        if (x < s.hx - s.len / 2 - 40 || x > s.hx + s.len / 2 + 40) continue;
        if (y < s.hy - 80 * s.scale || y > s.hy + 10) continue;
        const sp = shipPolys(s);
        if (inPolygon(x, y, sp.hull)) {
          r = 11;
          g = 9;
          b = 17;
          // Fire rim on the port side.
          if (x < s.hx - s.len / 2 + 8) {
            r += 120;
            g += 50;
            b += 18;
          }
        } else if (inPolygon(x, y, sp.sail1) || inPolygon(x, y, sp.sail2)) {
          // Sails catch the firelight: pale warm canvas.
          const shade = 0.82 + 0.18 * sampleGrid(fineGrid, u * 6, v * 6);
          r = 214 * shade;
          g = 168 * shade;
          b = 122 * shade;
        } else if (Math.abs(x - sp.mastX) < 1.5 && y >= sp.mastTop && y <= sp.mastBot) {
          r = 12;
          g = 10;
          b = 18;
        }
      }
    }

    // --- grade: split tone, saturation, contrast, vignette ---
    let lum = (r + g + b) / 3 / 255;
    r *= 1 + 0.07 * (lum - 0.5);
    b *= 1 - 0.06 * (lum - 0.5);
    lum = (r + g + b) / 3;
    const sat = 1.16;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    r = (r / 255 - 0.5) * 1.07 * 255 + 127.5;
    g = (g / 255 - 0.5) * 1.07 * 255 + 127.5;
    b = (b / 255 - 0.5) * 1.07 * 255 + 127.5;
    const vdx = (x - W / 2) / (0.62 * W);
    const vdy = (y - H / 2) / (0.62 * H);
    const vd2 = vdx * vdx + vdy * vdy;
    const vig = 1 - 0.22 * clamp01((vd2 - 0.5) / 0.7);
    r *= vig;
    g *= vig;
    b *= vig;

    img[idx] = r < 0 ? 0 : r > 255 ? 255 : r;
    img[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    img[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

// ---------------------------------------------------------------------------
// Post passes.
// ---------------------------------------------------------------------------

// Lightning flash glow at the bolt's cloud base.
{
  const R = 130;
  const x0 = Math.max(0, Math.floor(BOLT.topX - R));
  const x1 = Math.min(W - 1, Math.ceil(BOLT.topX + R));
  const y0 = Math.max(0, Math.floor(BOLT.topY - R));
  const y1 = Math.min(H - 1, Math.ceil(BOLT.topY + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - BOLT.topX;
      const dy = y - BOLT.topY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= R) continue;
      const fl = Math.exp(-d / 60) * (1 - smoothstep(80, R, d)) * 0.22;
      const i = (y * W + x) * 3;
      img[i] = Math.min(255, img[i] + 160 * fl);
      img[i + 1] = Math.min(255, img[i + 1] + 175 * fl);
      img[i + 2] = Math.min(255, img[i + 2] + 250 * fl);
    }
  }
}

// Embers: additive glowing sparks with short rising trails.
for (const e of EMBERS) {
  const R = Math.ceil(e.r + 2);
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const px = Math.round(e.x) + dx;
      const py = Math.round(e.y) + dy;
      if (px < 0 || px >= W || py < 0 || py >= H) continue;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > e.r + 2) continue;
      const a = e.b * Math.exp(-Math.pow(d / Math.max(0.8, e.r), 2));
      const i = (py * W + px) * 3;
      img[i] = Math.min(255, img[i] + 255 * a);
      img[i + 1] = Math.min(255, img[i + 1] + 150 * a);
      img[i + 2] = Math.min(255, img[i + 2] + 55 * a);
    }
  }
  // Trail: a short fading streak rising above the spark.
  if (e.trail > 0) {
    for (let s = 1; s <= e.trail; s++) {
      const py = Math.round(e.y) - s;
      const px = Math.round(e.x) - Math.floor(s * 0.3);
      if (px < 0 || px >= W || py < 0 || py >= H) break;
      const a = e.b * 0.5 * (1 - s / (e.trail + 1));
      const i = (py * W + px) * 3;
      img[i] = Math.min(255, img[i] + 255 * a);
      img[i + 1] = Math.min(255, img[i + 1] + 130 * a);
      img[i + 2] = Math.min(255, img[i + 2] + 45 * a);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const png = encodePNG(img, W, H);
writeFileSync(join(OUT_DIR, 'entry.png'), png);
