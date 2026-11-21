import { makePerlin, fbm } from './noise.js';
import { makeRng } from './rng.js';

// Floating isles: a vertex is open sky when its top is within this of its underside.
export const OPEN = 0.3;
// The far void under and between the isles, and where a falling shell is lost.
export const ISLES = { voidY: -90, bedrock: -220 };
// A moon's pull at its surface, m/s^2 (four times the ground's gravity).
export const WELL_PULL = 40;

// Port of CraterMath::DepthAt (legacy DeformLandscape sine falloff).
// Downward depth (>= 0) at radial distance `dist` for a crater of `radius`.
export function craterDepthAt(dist, radius, depthScale = 1) {
  if (radius <= 0) return 0;
  if (dist < 0) dist = 0;
  if (dist >= radius) return 0;
  return Math.sin(((radius - dist) / radius) * (Math.PI / 2)) * radius * depthScale;
}

// A square heightfield centred on the origin. World axes: x and z horizontal,
// y up. Heights are single-valued, so a crater can never leave a "lid".
export class Heightfield {
  constructor({ size = 800, resolution = 256, bedrock = -60 } = {}) {
    this.size = size;
    this.res = resolution;            // quads per side
    this.n = resolution + 1;          // vertices per side
    this.cell = size / resolution;
    this.half = size / 2;
    this.bedrock = bedrock;
    this.heights = new Float32Array(this.n * this.n);
    this.scorch = new Float32Array(this.n * this.n); // 0..1, darkens blasted ground
    this.waterLevel = -Infinity;      // set by Scenery; ground below it shows as water
    this.baseBedrock = bedrock;
    // Floating isles (generateIsles): the underside height of every vertex,
    // or null for an ordinary field that is solid all the way down. A vertex
    // whose top is within OPEN of its underside is open sky, and there the
    // two are kept equal, so the top and the underside meet at the rim.
    this.under = null;
    this.isles = [];
    // Gravity wells: small moons hanging over the isles that pull on shells,
    // { x, y, z, r, mu } with the pull mu / d^2 (see ballistics.js).
    this.wells = [];
  }

  index(i, j) { return j * this.n + i; }

  // World x/z of a grid vertex.
  vx(i) { return -this.half + i * this.cell; }
  vz(j) { return -this.half + j * this.cell; }

  generate({ seed = 7, amplitude = 45, frequency = 0.0035, octaves = 4, edgeFalloff = true } = {}) {
    this.waterLevel = -Infinity;
    this.under = null;
    this.isles = [];
    this.wells = [];
    this.bedrock = this.baseBedrock;
    const noise = makePerlin(seed);
    const ridge = makePerlin(seed * 31 + 5);
    for (let j = 0; j < this.n; j++) {
      for (let i = 0; i < this.n; i++) {
        const x = this.vx(i);
        const z = this.vz(j);
        let h = fbm(noise, x, z, { frequency, octaves, amplitude });
        // A broad second layer gives the field a few real hills and valleys.
        h += fbm(ridge, x, z, { frequency: frequency * 0.35, octaves: 2, amplitude: amplitude * 0.9 });
        if (edgeFalloff) {
          // Ease toward a gentle rim so the slab edge reads cleanly.
          const ex = Math.abs(x) / this.half;
          const ez = Math.abs(z) / this.half;
          const e = Math.max(ex, ez);
          const t = Math.min(1, Math.max(0, (e - 0.82) / 0.18));
          h = h * (1 - t * t * 0.6);
        }
        this.heights[this.index(i, j)] = h + 20;
        this.scorch[this.index(i, j)] = 0;
      }
    }
    return this;
  }

  // Floating isles in open sky. Each tank pad ([x, z]) gets an isle of its
  // own, a few more hang in the gaps at other heights, and two or three small
  // moons float above with gravity of their own. Under every isle is a rocky
  // underside tapering to a point, so an isle is thickest in the middle.
  generateIsles({ seed = 7, amplitude = 45, pads = [] } = {}) {
    this.waterLevel = -Infinity;
    this.bedrock = ISLES.bedrock;
    const rng = makeRng(seed * 13 + 1);
    const shape = makePerlin(seed * 7 + 3);
    const hills = makePerlin(seed);
    const rough = makePerlin(seed * 31 + 5);
    const isles = [];
    const clear = (x, z, r) => isles.every((o) => Math.hypot(o.x - x, o.z - z) > (o.r + r) * 1.25 + 10);
    for (const [x, z] of pads) {
      const a = rng.range(0, Math.PI * 2);
      const off = rng.range(0, 12);
      isles.push({ x: x + Math.cos(a) * off, z: z + Math.sin(a) * off, r: rng.range(55, 72), base: rng.range(5, 30), pad: true });
    }
    const want = isles.length + rng.int(6, 10);
    for (let tries = 0; isles.length < want && tries < 300; tries++) {
      const r = rng.range(16, 50);
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, this.half * 0.8 - r);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      if (clear(x, z, r)) isles.push({ x, z, r, base: rng.range(-20, 50), pad: false });
    }
    this.isles = isles;
    const amp = Math.min(amplitude, 45) * 0.3;
    const n = this.n;
    const H = this.heights;
    const U = (this.under = new Float32Array(n * n));
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const x = this.vx(i);
        const z = this.vz(j);
        const k = this.index(i, j);
        this.scorch[k] = 0;
        // The isle this vertex belongs to most, by how far inside its ragged edge it is.
        let best = null;
        let s = 0;
        for (const o of isles) {
          const si = 1 - Math.hypot(x - o.x, z - o.z) / o.r + 0.3 * shape(x * 0.022, z * 0.022) + 0.1 * shape(x * 0.07 + 9, z * 0.07);
          if (si > s) { s = si; best = o; }
        }
        if (!best) { H[k] = U[k] = NaN; continue; }
        const inner = Math.min(1, s * 2.5);
        const top = best.base + 6 * Math.sqrt(s) + fbm(hills, x, z, { frequency: 0.012, octaves: 3, amplitude: amp }) * inner;
        const depth = 1.5 + best.r * (0.55 + 0.2 * rough(x * 0.03, z * 0.03)) * s ** 0.8
          + Math.max(0, rough(x * 0.16, z * 0.16)) * 7 * inner;
        H[k] = top;
        U[k] = Math.min(top - 1.5, best.base - depth);
      }
    }
    // Open sky: next to an isle it meets the isle's lip, a little below the
    // grass; far out it sits down in the void.
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const k = this.index(i, j);
        if (!Number.isNaN(H[k])) continue;
        let sum = 0;
        let cnt = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            const ii = i + di;
            const jj = j + dj;
            if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
            const h = H[this.index(ii, jj)];
            if (!Number.isNaN(h)) { sum += h; cnt++; }
          }
        }
        U[k] = cnt ? sum / cnt - 0.9 : ISLES.voidY;
      }
    }
    for (let k = 0; k < H.length; k++) if (Number.isNaN(H[k])) H[k] = U[k];
    this.wells = this.placeWells(rng, pads);
    return this;
  }

  placeWells(rng, pads) {
    const wells = [];
    const want = rng.int(2, 3);
    for (let tries = 0; wells.length < want && tries < 200; tries++) {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, this.half * 0.5);
      const x = Math.cos(a) * d;
      const z = Math.sin(a) * d;
      const r = rng.range(8, 14);
      const y = rng.range(70, 120);
      if (pads.some(([px, pz]) => Math.hypot(px - x, pz - z) < 70)) continue;
      if (this.solidAt(x, z) && y - this.heightAt(x, z) < r + 35) continue;
      if (wells.some((w) => Math.hypot(w.x - x, w.y - y, w.z - z) < w.r + r + 90)) continue;
      wells.push({ x, y, z, r, mu: WELL_PULL * r * r });
    }
    return wells;
  }

  // Bilinear sample of a per-vertex array (clamped to the field).
  sample(arr, x, z) {
    const fx = Math.min(this.res - 1e-6, Math.max(0, (x + this.half) / this.cell));
    const fz = Math.min(this.res - 1e-6, Math.max(0, (z + this.half) / this.cell));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const n = this.n;
    const k = j * n + i;
    return (arr[k] * (1 - tx) + arr[k + 1] * tx) * (1 - tz) + (arr[k + n] * (1 - tx) + arr[k + n + 1] * tx) * tz;
  }

  // The underside of the isles at x/z (-Infinity on an ordinary field).
  underAt(x, z) { return this.under ? this.sample(this.under, x, z) : -Infinity; }

  // Is there ground at x/z, or open sky? Always ground on an ordinary field
  // (inside the arena).
  solidAt(x, z) {
    if (!this.inBounds(x, z)) return false;
    if (!this.under) return true;
    return this.heightAt(x, z) - this.underAt(x, z) > OPEN;
  }

  // Is the point x/y/z inside the ground?
  inside(x, y, z) {
    if (!this.inBounds(x, z)) return false;
    const top = this.heightAt(x, z);
    if (y > top) return false;
    if (!this.under) return true;
    const u = this.underAt(x, z);
    return top - u > OPEN && y >= u;
  }

  // Is vertex k open sky?
  isOpen(k) { return !!this.under && this.heights[k] - this.under[k] <= OPEN; }

  // Vertex k was blown through: its top drops to meet the underside.
  open(k) { this.heights[k] = this.under[k]; }

  inBounds(x, z) {
    return x >= -this.half && x <= this.half && z >= -this.half && z <= this.half;
  }

  // Bilinear height at any world x/z (clamped to the field).
  heightAt(x, z) {
    const fx = Math.min(this.res - 1e-6, Math.max(0, (x + this.half) / this.cell));
    const fz = Math.min(this.res - 1e-6, Math.max(0, (z + this.half) / this.cell));
    const i = Math.floor(fx);
    const j = Math.floor(fz);
    const tx = fx - i;
    const tz = fz - j;
    const h = this.heights;
    const n = this.n;
    const a = h[j * n + i];
    const b = h[j * n + i + 1];
    const c = h[(j + 1) * n + i];
    const d = h[(j + 1) * n + i + 1];
    return (a * (1 - tx) + b * tx) * (1 - tz) + (c * (1 - tx) + d * tx) * tz;
  }

  // Surface normal by central differences, as [x, y, z].
  normalAt(x, z) {
    const e = this.cell;
    const dx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const dz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    const nx = -dx;
    const ny = 2 * e;
    const nz = -dz;
    const len = Math.hypot(nx, ny, nz);
    return [nx / len, ny / len, nz / len];
  }

  // Grid-index bounding box of a circle, clamped. Returned so the renderer can
  // update only the touched region.
  regionFor(cx, cz, radius) {
    const i0 = Math.max(0, Math.floor((cx - radius + this.half) / this.cell) - 1);
    const i1 = Math.min(this.res, Math.ceil((cx + radius + this.half) / this.cell) + 1);
    const j0 = Math.max(0, Math.floor((cz - radius + this.half) / this.cell) - 1);
    const j1 = Math.min(this.res, Math.ceil((cz + radius + this.half) / this.cell) + 1);
    return { i0, i1, j0, j1 };
  }

  // Port of ACraterTerrainActor::CarveCrater: lower each vertex within the
  // radius by the sine falloff measured from the impact height, never raising
  // anything and never going below bedrock.
  carveCrater(cx, cy, cz, radius, depthScale = 0.6) {
    const r = this.regionFor(cx, cz, radius);
    const U = this.under;
    // On the isles a blast nearer an isle's underside than its top eats upward.
    if (U && this.solidAt(cx, cz) && cy < (this.heightAt(cx, cz) + this.underAt(cx, cz)) / 2) {
      for (let j = r.j0; j <= r.j1; j++) {
        for (let i = r.i0; i <= r.i1; i++) {
          const dist = Math.hypot(this.vx(i) - cx, this.vz(j) - cz);
          if (dist >= radius) continue;
          const k = this.index(i, j);
          if (this.isOpen(k)) continue;
          const ceil = cy + craterDepthAt(dist, radius, depthScale);
          if (ceil > U[k]) U[k] = Math.min(ceil, this.heights[k]);
          if (this.isOpen(k)) this.open(k);
        }
      }
      return r;
    }
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const x = this.vx(i);
        const z = this.vz(j);
        const dist = Math.hypot(x - cx, z - cz);
        if (dist >= radius) continue;
        const k = this.index(i, j);
        const floor = cy - craterDepthAt(dist, radius, depthScale);
        if (floor < this.heights[k]) {
          this.heights[k] = Math.max(this.bedrock + 1, floor);
          if (U && this.heights[k] - U[k] <= OPEN) this.open(k);
        }
        if (U && floor > this.heights[k] + 2) continue;   // a burst high over an isle leaves it unburnt
        const s = 1 - dist / radius;
        this.scorch[k] = Math.min(1, this.scorch[k] + s * 0.9);
      }
    }
    return r;
  }

  // Heap dirt in a sine mound. The mirror of a crater, used by the Mound weapon.
  raiseMound(cx, cz, radius, height) {
    const r = this.regionFor(cx, cz, radius);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const dist = Math.hypot(this.vx(i) - cx, this.vz(j) - cz);
        if (dist >= radius) continue;
        const k = this.index(i, j);
        if (this.isOpen(k)) continue;   // no heaping dirt on thin air
        this.heights[k] += craterDepthAt(dist, radius, height / radius);
        // Fresh dirt covers the burn: a light scorch value renders as bare earth.
        this.scorch[k] = Math.min(0.32, this.scorch[k] * 0.3 + 0.32 * (1 - dist / radius) + 0.08);
      }
    }
    return r;
  }

  // Flatten a pad so a tank starts on level ground (legacy flattenArea).
  flatten(cx, cz, radius) {
    const target = this.heightAt(cx, cz);
    const r = this.regionFor(cx, cz, radius * 1.6);
    for (let j = r.j0; j <= r.j1; j++) {
      for (let i = r.i0; i <= r.i1; i++) {
        const dist = Math.hypot(this.vx(i) - cx, this.vz(j) - cz);
        if (dist >= radius * 1.6) continue;
        const k = this.index(i, j);
        const t = dist <= radius ? 1 : 1 - (dist - radius) / (radius * 0.6);
        if (this.isOpen(k)) continue;
        this.heights[k] = this.heights[k] * (1 - t) + target * t;
        if (this.under) this.under[k] = Math.min(this.under[k], this.heights[k] - 1.5);
      }
    }
    return r;
  }
}
