import { makeRng } from './rng.js';

// Relics on the floating isles: whoever lived out here left things behind.
// Derelict dishes, monoliths and obelisks with faint glyph strips, crystal
// clusters, broken arches and ring ruins, the odd crashed hull, and loose rocks
// drifting round the bigger isles.
//
// Like the rest of the scenery they are set dressing: they never stop a shell
// or hurt a tank. They react to the ground: a blast close by clears one away,
// a near miss topples a tall one, and the rest are re-seated on the ground as
// it is now. One blown out from under falls into the void.
//
// Kept on `scenery.artifacts` ({ kind, x, y, z, rot, scale, tint, state:
// 'ok'|'fallen'|'gone', fall }) and `scenery.drifters` (orbits, which only
// the renderer moves). Placement is seeded, so every screen agrees.

// Footprint radius at scale 1 (what must stay on the isle and clear of a tank
// pad), whether it topples (else a near miss only clears it), and how often
// each kind comes up.
export const ARTIFACTS = {
  dish: { reach: 3.6, tall: true, weight: 3 },
  monolith: { reach: 1.8, tall: true, weight: 3 },
  obelisk: { reach: 1.6, tall: true, weight: 2 },
  crystals: { reach: 2.6, tall: false, weight: 4 },
  arch: { reach: 4.4, tall: true, weight: 2 },
  ring: { reach: 4.2, tall: true, weight: 2 },
  hull: { reach: 6.5, tall: false, weight: 1 },
};
export const ARTIFACT_KINDS = Object.keys(ARTIFACTS);
export const isArtifact = (kind) => kind in ARTIFACTS;
export const KEEP_PAD = 20;      // no relic closer than this (plus its reach) to a tank

const pickKind = (rng) => {
  let roll = rng.next() * ARTIFACT_KINDS.reduce((s, k) => s + ARTIFACTS[k].weight, 0);
  for (const k of ARTIFACT_KINDS) { roll -= ARTIFACTS[k].weight; if (roll < 0) return k; }
  return ARTIFACT_KINDS[0];
};

// Is there isle under the whole footprint, a margin in from the lip?
function footed(t, x, z, r) {
  if (!t.solidAt(x, z)) return false;
  for (let a = 0; a < 6; a++) {
    const c = Math.cos((a * Math.PI) / 3) * (r + 2);
    const s = Math.sin((a * Math.PI) / 3) * (r + 2);
    if (!t.solidAt(x + c, z + s)) return false;
  }
  return true;
}

// The height an artifact rests at: the lowest ground under its footprint,
// sunk a little so it never floats on a slope.
export function artifactSeat(t, a) {
  const r = ARTIFACTS[a.kind].reach * a.scale * 0.6;
  let g = t.heightAt(a.x, a.z);
  for (let k = 0; k < 4; k++) {
    const ang = a.rot + (k * Math.PI) / 2;
    g = Math.min(g, t.heightAt(a.x + Math.cos(ang) * r, a.z + Math.sin(ang) * r));
  }
  return g - 0.15;
}

// Lay out the relics on `terrain`'s isles, clear of the tanks and of each
// other. Returns { artifacts, drifters }.
export function placeArtifacts(terrain, { seed = 1, tanks = [] } = {}) {
  const t = terrain;
  const out = { artifacts: [], drifters: [] };
  if (!t.under || !t.isles?.length) return out;
  const rng = makeRng(seed * 41 + 17);
  const list = out.artifacts;
  for (const isle of t.isles) {
    // A big isle holds two or three, a small one one at most, a tank's isle one or two.
    const want = isle.pad ? rng.int(1, 2) : isle.r > 34 ? rng.int(1, 3) : rng.int(0, 1);
    for (let tries = 0, n = 0; tries < 40 && n < want; tries++) {
      const kind = pickKind(rng);
      const A = ARTIFACTS[kind];
      const scale = rng.range(1.2, 1.7);
      const reach = A.reach * scale;
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(0, isle.r * 0.75);
      const x = isle.x + Math.cos(a) * d;
      const z = isle.z + Math.sin(a) * d;
      if (!t.inBounds(x, z) || !footed(t, x, z, reach)) continue;
      if (tanks.some((k) => Math.hypot(k.x - x, k.z - z) < KEEP_PAD + reach)) continue;
      if (list.some((o) => Math.hypot(o.x - x, o.z - z) < o.reach + reach + 4)) continue;
      const art = { kind, x, y: 0, z, rot: rng.range(0, Math.PI * 2), scale, reach, tint: rng.int(0, 3), state: 'ok', fall: 0 };
      // The crashed hull lies nose down and canted over.
      if (kind === 'hull') art.tilt = [rng.range(0.12, 0.3), rng.range(-0.35, 0.35)];
      art.y = artifactSeat(t, art);
      list.push(art);
      n++;
    }
  }
  // Loose rocks circling the larger isles, a little below their rims.
  for (const isle of t.isles) {
    if (isle.r < 40) continue;
    for (let k = rng.int(2, 5); k > 0; k--) {
      out.drifters.push({
        cx: isle.x, cz: isle.z,
        r: isle.r * rng.range(1.1, 1.55),
        y: isle.base + rng.range(-22, 6),
        phase: rng.range(0, Math.PI * 2),
        speed: rng.range(0.025, 0.07) * (rng.next() < 0.5 ? -1 : 1),
        bob: rng.range(0.5, 2.5),
        size: rng.range(1.2, 4.2),
        spin: rng.range(0.1, 0.5),
        tint: rng.int(0, 3),
      });
    }
  }
  return out;
}

// Scenery props (trees, rocks, houses) that a relic now stands on: dropped,
// so nothing grows through a monolith.
export function clearUnder(props, artifacts) {
  return props.filter((p) => !artifacts.some((a) => Math.hypot(a.x - p.x, a.z - p.z) < a.reach + (p.reach || 1.5) + 1));
}

// A crater of `radius` at (cx, cz) on the isles' tops. `note(a, how)` reports
// each change (Scenery.note). Scenery.settle re-seats the rest after.
export function blastArtifacts(t, artifacts, cx, cz, radius, note) {
  for (const a of artifacts) {
    if (a.state === 'gone') continue;
    const d = Math.hypot(a.x - cx, a.z - cz);
    if (d < radius * 0.7 + a.reach * 0.3) { a.state = 'gone'; note(a, 'gone'); }
    else if (ARTIFACTS[a.kind].tall && a.state === 'ok' && d < radius * 1.3 + a.reach * 0.5) {
      a.state = 'fallen';
      a.fall = Math.atan2(a.z - cz, a.x - cx);
      note(a, 'fallen');
    }
  }
}

// Put every relic within `reach` of (cx, cz) back on the ground as it is now.
// Blown out from under: it falls. Ground heaped over it: buried. Ground
// dropped away under a tall one: it topples.
export function settleArtifacts(t, artifacts, cx, cz, reach, note) {
  for (const a of artifacts) {
    if (a.state === 'gone' || Math.hypot(a.x - cx, a.z - cz) > reach + a.reach) continue;
    if (!t.solidAt(a.x, a.z)) { a.state = 'gone'; note(a, 'fell'); continue; }
    const g = artifactSeat(t, a);
    const shift = g - a.y;
    if (shift > 2.5) { a.state = 'gone'; note(a, 'buried'); continue; }
    if (shift < -2.5 && ARTIFACTS[a.kind].tall && a.state === 'ok') {
      a.state = 'fallen';
      a.fall = Math.atan2(a.z - cz, a.x - cx);
      note(a, 'fallen');
    }
    a.y = g;
  }
}
