import { makePerlin, fbm } from './noise.js';

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
  }

  index(i, j) { return j * this.n + i; }

  // World x/z of a grid vertex.
  vx(i) { return -this.half + i * this.cell; }
  vz(j) { return -this.half + j * this.cell; }

  generate({ seed = 7, amplitude = 45, frequency = 0.0035, octaves = 4, edgeFalloff = true } = {}) {
    this.waterLevel = -Infinity;
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
        }
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
        this.heights[k] = this.heights[k] * (1 - t) + target * t;
      }
    }
    return r;
  }
}
