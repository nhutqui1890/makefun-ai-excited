// ai-excited-01 entry: "Alien Storm".
// A fully procedural, deterministic image generator (Node 22, standard library
// only). It paints a dramatic alien seascape at 1024x1024 — a ringed planet
// hanging over a storm-lit ocean at dusk, lightning splitting the clouds, a low
// burning sun, mountain silhouettes and a glittering sea — and writes it as a
// PNG to /output/entry.png (MAKEFUN_OUTPUT_DIR stands in outside the grader's
// container). Every random value comes from one seeded generator, so repeated
// runs write the exact same bytes. No network, no assets, no dependencies.

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
const rand = mulberry32(20261116);

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

// Fine fBm grid for sea sparkle, wave texture and planet turbulence.
const SG = 256;
const seaGrid = new Float32Array(SG * SG);
for (let j = 0; j < SG; j++) {
  for (let i = 0; i < SG; i++) {
    const u = i / (SG - 1);
    const v = j / (SG - 1);
    seaGrid[j * SG + i] = fbm(u * 9.0 + 3.1, v * 9.0 + 5.7, 4);
  }
}

// 1D ridgeline noise for mountain and rock silhouettes.
function ridgeNoise(x: number, seed: number): number {
  return fbm(x * 2.2 + seed, 11.5 + seed, 4);
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
// Scene layout (normalised coordinates, origin top-left).
// ---------------------------------------------------------------------------
const HORIZON = 0.62 * H; // the sea starts here
const SUN_X = 0.30 * W;
const SUN_Y = 0.47 * H;
const PLANET_X = 0.70 * W;
const PLANET_Y = 0.28 * H;
const PLANET_R = 0.155 * W;

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

// Stars: a brightness grid, drawn before the clouds so clouds occlude them.
const starGrid = new Float32Array(W * H);
{
  for (let i = 0; i < 620; i++) {
    const x = (rand() * W) | 0;
    const y = (rand() * 0.52 * H) | 0;
    const b = 0.12 + Math.pow(rand(), 3.2) * 0.88;
    if (b > starGrid[y * W + x]) starGrid[y * W + x] = b;
    if (b > 0.82) {
      // Bright stars get a small cross flare.
      if (x > 0) starGrid[y * W + x - 1] = Math.max(starGrid[y * W + x - 1], b * 0.45);
      if (x < W - 1) starGrid[y * W + x + 1] = Math.max(starGrid[y * W + x + 1], b * 0.45);
      if (y > 0) starGrid[(y - 1) * W + x] = Math.max(starGrid[(y - 1) * W + x], b * 0.45);
      if (y < H - 1) starGrid[(y + 1) * W + x] = Math.max(starGrid[(y + 1) * W + x], b * 0.45);
    }
  }
}

// Lightning bolts: seeded random-walk polylines with branches.
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
  // Branches from two mid points.
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
const BOLTS: { segs: Seg[]; x0: number; x1: number; y0: number; y1: number; topX: number; topY: number }[] = [];
{
  const b1 = makeBolt(0.155 * W, 0.13 * H, 0.235 * W, HORIZON + 6, 17, 16);
  const b2 = makeBolt(0.865 * W, 0.09 * H, 0.815 * W, 0.47 * H, 12, 12);
  for (const segs of [b1, b2]) {
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
    const m = 110;
    BOLTS.push({
      segs,
      x0: Math.max(0, Math.floor(x0 - m)),
      x1: Math.min(W - 1, Math.ceil(x1 + m)),
      y0: Math.max(0, Math.floor(y0 - m)),
      y1: Math.min(H - 1, Math.ceil(y1 + m)),
      topX: segs[0][0],
      topY: segs[0][1],
    });
  }
}

// Mountain ridge lines, one per column (a far ridge along the horizon and
// near headlands rising at the left and right edges).
const farRidge = new Float32Array(W);
const nearRidge = new Float32Array(W);
for (let x = 0; x < W; x++) {
  const u = x / W;
  farRidge[x] = HORIZON - (36 + ridgeNoise(u, 3.7) * 92);
  const edge = u < 0.30 ? 1 - u / 0.30 : u > 0.80 ? (u - 0.80) / 0.20 : 0;
  nearRidge[x] = HORIZON - edge * (14 + ridgeNoise(u, 9.1) * 64);
}

// Rocky foreground masses at the bottom-left and bottom-right.
const rockLine = new Float32Array(W);
for (let x = 0; x < W; x++) {
  const u = x / W;
  const edge = u < 0.27 ? 1 - u / 0.27 : u > 0.74 ? (u - 0.74) / 0.26 : 0;
  rockLine[x] = H - edge * (40 + ridgeNoise(u, 5.5) * 110);
}

// Sky base gradient, precomputed per row (top -> horizon).
const SKY_STOPS: [number, number, number, number][] = [
  [0.0, 7, 11, 38],
  [0.30, 20, 30, 74],
  [0.50, 48, 48, 106],
  [0.62, 96, 66, 110],
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

const PLANET_BBOX = {
  x0: Math.max(0, Math.floor(PLANET_X - PLANET_R * 2.05)),
  x1: Math.min(W - 1, Math.ceil(PLANET_X + PLANET_R * 2.05)),
  y0: Math.max(0, Math.floor(PLANET_Y - PLANET_R * 1.06)),
  y1: Math.min(H - 1, Math.ceil(PLANET_Y + PLANET_R * 1.06)),
};

// ---------------------------------------------------------------------------
// Renderer.
// ---------------------------------------------------------------------------
const img = new Uint8Array(W * H * 3);

for (let y = 0; y < H; y++) {
  const v = y / H;
  const skyR = skyRows[y * 3];
  const skyG = skyRows[y * 3 + 1];
  const skyB = skyRows[y * 3 + 2];
  const inSea = y >= HORIZON;
  const seaT = inSea ? (y - HORIZON) / (H - HORIZON) : 0;
  for (let x = 0; x < W; x++) {
    const u = x / W;
    const idx = (y * W + x) * 3;
    let r: number;
    let g: number;
    let b: number;

    if (!inSea) {
      // --- sky base ---
      r = skyR;
      g = skyG;
      b = skyB;

      // --- stars ---
      const star = starGrid[y * W + x];
      if (star > 0) {
        const s = star * 235;
        r += s;
        g += s;
        b += s * 1.05;
      }

      // --- ringed planet ---
      if (x >= PLANET_BBOX.x0 && x <= PLANET_BBOX.x1 && y >= PLANET_BBOX.y0 && y <= PLANET_BBOX.y1) {
        const dx = (x - PLANET_X) / PLANET_R;
        const dy = (y - PLANET_Y) / PLANET_R;
        const r2 = dx * dx + dy * dy;
        const ringD = Math.sqrt(dx * dx + (dy / 0.30) * (dy / 0.30));
        const inRing = ringD >= 1.28 && ringD <= 1.95;
        if (r2 <= 1) {
          // Planet disc: wavy bands.
          const turb = sampleGrid(seaGrid, u * 2 + 0.3, v * 2 + 0.7) - 0.5;
          const band = Math.sin(dy * 15 + turb * 3.4);
          const t = (band + 1) / 2;
          let pr: number;
          let pg: number;
          let pb: number;
          if (t < 0.33) {
            const f = t / 0.33;
            pr = 248 + (228 - 248) * f;
            pg = 236 + (182 - 236) * f;
            pb = 210 + (130 - 210) * f;
          } else if (t < 0.66) {
            const f = (t - 0.33) / 0.33;
            pr = 228 + (198 - 228) * f;
            pg = 182 + (146 - 182) * f;
            pb = 130 + (92 - 130) * f;
          } else {
            const f = (t - 0.66) / 0.34;
            pr = 198 + (160 - 198) * f;
            pg = 146 + (110 - 146) * f;
            pb = 92 + (70 - 92) * f;
          }
          // Terminator: the sun is to the left.
          const light = Math.max(0.38, Math.min(1, 0.82 - dx * 0.55 + (1 - dy) * 0.08));
          pr *= light;
          pg *= light;
          pb *= light;
          // Ring shadow: a dark diagonal band across the disc.
          const bandC = -0.02 + dx * 0.06;
          if (Math.abs(dy - bandC) < 0.04) {
            pr *= 0.68;
            pg *= 0.68;
            pb *= 0.7;
          }
          // Atmosphere rim on the sun side.
          if (r2 > 0.93 && dx < 0.3) {
            const rim = ((r2 - 0.93) / 0.07) * Math.max(0, 0.3 - dx) * 1.6;
            pr += 140 * rim;
            pg += 200 * rim;
            pb += 255 * rim;
          }
          // The front half of the ring passes over the disc.
          if (inRing && dy > 0) {
            const gap = 0.5 + 0.5 * Math.sin(ringD * 46 + turb * 2);
            const alpha = (0.3 + 0.55 * gap) * (1 - smoothstep(1.85, 1.95, ringD)) * 0.72;
            pr = pr * (1 - alpha) + 216 * alpha;
            pg = pg * (1 - alpha) + 184 * alpha;
            pb = pb * (1 - alpha) + 136 * alpha;
          }
          r = pr;
          g = pg;
          b = pb;
        } else if (inRing) {
          // Ring outside the disc.
          const turb = sampleGrid(seaGrid, u * 2 + 0.3, v * 2 + 0.7) - 0.5;
          const gap = 0.5 + 0.5 * Math.sin(ringD * 46 + turb * 2);
          const alpha = (0.3 + 0.55 * gap) * (1 - smoothstep(1.85, 1.95, ringD)) * 0.9;
          r = r * (1 - alpha) + 216 * alpha;
          g = g * (1 - alpha) + 184 * alpha;
          b = b * (1 - alpha) + 136 * alpha;
        }
      }

      // --- sun glow + disc ---
      {
        const dx = x - SUN_X;
        const dy = y - SUN_Y;
        const d2 = dx * dx + dy * dy;
        if (d2 < 260000) {
          const d = Math.sqrt(d2);
          if (d < 30) {
            // Disc: hot white-yellow centre cooling to orange at the limb.
            const f = d / 30;
            r = 255;
            g = 246 - 46 * f;
            b = 207 - 97 * f;
          } else {
            const halo = Math.exp(-d / 55);
            const wide = Math.exp(-d / 220);
            r += 255 * halo * 0.75 + 200 * wide * 0.28;
            g += 170 * halo * 0.75 + 110 * wide * 0.28;
            b += 80 * halo * 0.75 + 60 * wide * 0.28;
            const streak = Math.exp(-Math.abs(dy) / 7) * Math.exp(-Math.abs(dx) / 170);
            r += 255 * streak * 0.22;
            g += 180 * streak * 0.22;
            b += 110 * streak * 0.22;
          }
        }
      }

      // --- storm clouds ---
      {
        const eu = (u - 0.2) / 0.4;
        const ev = (v - 0.16) / 0.26;
        let m = 1 - (eu * eu + ev * ev);
        m = m <= 0 ? 0 : m * m * (3 - 2 * m);
        const d = sampleGrid(cloudGrid, u * 1.9, v * 2.1);
        const d2 = d * (0.68 + 0.55 * m) + m * 0.12;
        const a = smoothstep(0.58, 0.8, d2);
        if (a > 0.01) {
          const dAbove = sampleGrid(cloudGrid, u * 1.9, (v - 0.012) * 2.1);
          const edge = clamp01((d2 - dAbove) * 6) * a;
          const sdx = u - 0.3;
          const sdy = v - 0.47;
          const sunProx = Math.exp(-(sdx * sdx + sdy * sdy) / 0.22);
          let cr = 30;
          let cg = 34;
          let cb = 72;
          const lit = sunProx * 0.5;
          cr += (232 - 30) * lit * a;
          cg += (144 - 34) * lit * a;
          cb += (90 - 72) * lit * a;
          cr += 85 * edge;
          cg += 92 * edge;
          cb += 105 * edge;
          const under = Math.pow(v / 0.62, 4) * 0.2 * a;
          cr += 255 * under;
          cg += 140 * under;
          cb += 80 * under;
          if (cr > 225) cr = 225;
          if (cg > 225) cg = 225;
          if (cb > 225) cb = 225;
          r = r * (1 - a) + cr * a;
          g = g * (1 - a) + cg * a;
          b = b * (1 - a) + cb * a;
        }
        // Thin high wisps.
        if (v < 0.34) {
          const w = sampleGrid(cloudGrid, u * 1.7 + 0.4, v * 2.2 + 0.2);
          const wa = smoothstep(0.58, 0.76, w) * 0.22;
          if (wa > 0.01) {
            const sdx = u - 0.3;
            const sdy = v - 0.47;
            const sunProx = Math.exp(-(sdx * sdx + sdy * sdy) / 0.22);
            const wr = 180 + 75 * sunProx;
            const wg = 190 + 30 * sunProx;
            const wb = 230 - 60 * sunProx;
            r = r * (1 - wa) + wr * wa;
            g = g * (1 - wa) + wg * wa;
            b = b * (1 - wa) + wb * wa;
          }
        }
      }

      // --- mountains (far ridge, then near headlands) ---
      if (y >= farRidge[x]) {
        let mr = 44;
        let mg = 36;
        let mb = 84;
        const rimD = y - farRidge[x];
        if (rimD < 3 && x < SUN_X + 280) {
          const rim = (1 - rimD / 3) * 0.4;
          mr += 255 * rim;
          mg += 150 * rim;
          mb += 90 * rim;
        }
        r = mr;
        g = mg;
        b = mb;
      }
      if (nearRidge[x] < HORIZON && y >= nearRidge[x]) {
        let mr = 18;
        let mg = 14;
        let mb = 40;
        const rimD = y - nearRidge[x];
        if (rimD < 3 && x < SUN_X + 280) {
          const rim = (1 - rimD / 3) * 0.5;
          mr += 255 * rim;
          mg += 150 * rim;
          mb += 90 * rim;
        }
        r = mr;
        g = mg;
        b = mb;
      }
    } else {
      // --- sea ---
      const t = seaT;
      const tf = Math.pow(t, 0.8);
      r = 52 + (14 - 52) * tf;
      g = 84 + (26 - 84) * tf;
      b = 118 + (46 - 118) * tf;
      const gx = Math.exp(-Math.pow((x - SUN_X) / 240, 2));
      r += 120 * gx * (1 - t) * 0.5;
      g += 60 * gx * (1 - t) * 0.5;
      b += 30 * gx * (1 - t) * 0.5;
      // Broad sun reflection.
      const refl = Math.exp(-t * 2.0) * 0.6;
      r += 255 * gx * refl;
      g += 150 * gx * refl;
      b += 80 * gx * refl;
      // Planet reflection streak.
      const px = Math.exp(-Math.pow((x - PLANET_X) / 80, 2));
      const prefl = Math.exp(-t * 2.6) * 0.35;
      r += 200 * px * prefl;
      g += 180 * px * prefl;
      b += 140 * px * prefl;
      // Sun glitter (two sparkle scales).
      const n1 = sampleGrid(seaGrid, u * 3, v * 3);
      const sp1 = Math.pow(Math.max(0, n1 - 0.5) / 0.5, 3) * gx * (1 - t * 0.5);
      r += 255 * sp1 * 1.8;
      g += 195 * sp1 * 1.8;
      b += 115 * sp1 * 1.8;
      const n2 = sampleGrid(seaGrid, u * 7 + 0.5, v * 7 + 0.2);
      const sp2 = Math.pow(Math.max(0, n2 - 0.58) / 0.42, 4) * gx * 1.2;
      r += 255 * sp2;
      g += 200 * sp2;
      b += 130 * sp2;
      // Wave banding.
      const w = sampleGrid(seaGrid, u * 1.2, v * 8.0);
      const mult = 0.78 + w * 0.44;
      r *= mult;
      g *= mult;
      b *= mult;
      // Foam near the shore.
      if (y > H - 140) {
        const f = Math.pow(sampleGrid(seaGrid, u * 4 + 0.9, v * 4 + 0.3), 6) * smoothstep(H - 140, H - 40, y);
        r += 230 * f * 0.5;
        g += 235 * f * 0.5;
        b += 245 * f * 0.5;
      }
      // Foreground rocks.
      if (rockLine[x] < H && y >= rockLine[x]) {
        r = 9;
        g = 8;
        b = 20;
        if (y - rockLine[x] < 5) {
          const fn = sampleGrid(seaGrid, u * 6, v * 6);
          if (fn > 0.55) {
            const fo = (fn - 0.55) * 1.4;
            r += 230 * fo;
            g += 235 * fo;
            b += 245 * fo;
          }
        }
      }
    }

    // --- lightning (additive, only inside the bolt bounding boxes) ---
    for (let bi = 0; bi < BOLTS.length; bi++) {
      const bolt = BOLTS[bi];
      if (x < bolt.x0 || x > bolt.x1 || y < bolt.y0 || y > bolt.y1) continue;
      let minD = Infinity;
      for (let s = 0; s < bolt.segs.length; s++) {
        const [ax, ay, bx, by] = bolt.segs[s];
        const d = pointSegDist(x, y, ax, ay, bx, by);
        if (d < minD) minD = d;
      }
      if (minD < 110) {
        const core = Math.exp(-Math.pow(minD / 1.3, 2));
        const glow = Math.exp(-minD / 22);
        r += 235 * core + 140 * glow * 0.8;
        g += 242 * core + 155 * glow * 0.8;
        b += 255 * core + 255 * glow * 0.8;
      }
    }

    // --- grade: split tone, saturation, contrast, vignette ---
    let lum = (r + g + b) / 3 / 255;
    r *= 1 + 0.06 * (lum - 0.5);
    b *= 1 - 0.05 * (lum - 0.5);
    lum = (r + g + b) / 3;
    const sat = 1.12;
    r = lum + (r - lum) * sat;
    g = lum + (g - lum) * sat;
    b = lum + (b - lum) * sat;
    r = (r / 255 - 0.5) * 1.06 * 255 + 127.5;
    g = (g / 255 - 0.5) * 1.06 * 255 + 127.5;
    b = (b / 255 - 0.5) * 1.06 * 255 + 127.5;
    const vdx = (x - W / 2) / (0.62 * W);
    const vdy = (y - H / 2) / (0.62 * H);
    const vd2 = vdx * vdx + vdy * vdy;
    const vig = 1 - 0.2 * clamp01((vd2 - 0.5) / 0.7);
    r *= vig;
    g *= vig;
    b *= vig;

    img[idx] = r < 0 ? 0 : r > 255 ? 255 : r;
    img[idx + 1] = g < 0 ? 0 : g > 255 ? 255 : g;
    img[idx + 2] = b < 0 ? 0 : b > 255 ? 255 : b;
  }
}

// Flash glow at each bolt's cloud base: a separate pass over a disc that fades
// to exactly zero at its edge, so no bounding-box seam can show.
for (const bolt of BOLTS) {
  const R = 130;
  const x0 = Math.max(0, Math.floor(bolt.topX - R));
  const x1 = Math.min(W - 1, Math.ceil(bolt.topX + R));
  const y0 = Math.max(0, Math.floor(bolt.topY - R));
  const y1 = Math.min(H - 1, Math.ceil(bolt.topY + R));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = x - bolt.topX;
      const dy = y - bolt.topY;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d >= R) continue;
      const fl = Math.exp(-d / 60) * (1 - smoothstep(80, R, d)) * 0.22;
      const i = (y * W + x) * 3;
      img[i] = Math.min(255, img[i] + 165 * fl);
      img[i + 1] = Math.min(255, img[i + 1] + 180 * fl);
      img[i + 2] = Math.min(255, img[i + 2] + 255 * fl);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------
mkdirSync(OUT_DIR, { recursive: true });
const png = encodePNG(img, W, H);
writeFileSync(join(OUT_DIR, 'entry.png'), png);
