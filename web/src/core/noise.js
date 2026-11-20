import { makeRng } from './rng.js';

// Seeded 2D Perlin gradient noise, roughly in [-1, 1].
export function makePerlin(seed) {
  const rng = makeRng(seed);
  const perm = new Uint8Array(512);
  const p = Array.from({ length: 256 }, (_, i) => i);
  for (let i = 255; i > 0; i--) {
    const j = Math.floor(rng.next() * (i + 1));
    [p[i], p[j]] = [p[j], p[i]];
  }
  for (let i = 0; i < 512; i++) perm[i] = p[i & 255];

  const fade = (t) => t * t * t * (t * (t * 6 - 15) + 10);
  const lerp = (a, b, t) => a + (b - a) * t;
  const grad = (h, x, y) => {
    switch (h & 7) {
      case 0: return x + y;
      case 1: return -x + y;
      case 2: return x - y;
      case 3: return -x - y;
      case 4: return x;
      case 5: return -x;
      case 6: return y;
      default: return -y;
    }
  };

  return function noise2(x, y) {
    const xi = Math.floor(x) & 255;
    const yi = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);
    const aa = perm[perm[xi] + yi];
    const ab = perm[perm[xi] + yi + 1];
    const ba = perm[perm[xi + 1] + yi];
    const bb = perm[perm[xi + 1] + yi + 1];
    const x1 = lerp(grad(aa, xf, yf), grad(ba, xf - 1, yf), u);
    const x2 = lerp(grad(ab, xf, yf - 1), grad(bb, xf - 1, yf - 1), u);
    // Scale so typical output spans about [-1, 1].
    return lerp(x1, x2, v) * 1.4;
  };
}

// Fractal sum, normalised to [-1, 1] * amplitude. Port of TerrainHeight::HeightAt:
// each octave doubles frequency and halves weight.
export function fbm(noise2, x, z, { frequency, octaves, amplitude }) {
  if (amplitude <= 0 || octaves <= 0) return 0;
  let sum = 0;
  let ampSum = 0;
  let freq = frequency;
  let w = 1;
  for (let i = 0; i < octaves; i++) {
    sum += w * noise2(x * freq, z * freq);
    ampSum += w;
    freq *= 2;
    w *= 0.5;
  }
  return (sum / ampSum) * amplitude;
}
