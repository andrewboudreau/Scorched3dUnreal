import { makeRng } from './rng.js';
import { makePerlin } from './noise.js';
import { planPaths, distToPaths } from './paths.js';

// Everything that makes the field look lived in: water in the lowest basins,
// trees, bushes, rocks, a few hamlets, a footbridge, gravel roads and paths
// (core/paths.js), villagers and sheep.
//
// Scenery is set dressing. It never blocks a shell and never hurts a tank. It
// does react to the ground: `afterBlast` and `afterMound` remove, topple or
// re-seat whatever a crater or mound touched, so nothing is left floating or
// buried. The renderer redraws when `version` changes.

export const HOUSE = { halfW: 3.6, halfD: 2.8 };   // footprint half extents
export const BRIDGE = { width: 3.4, pierEvery: 9 };

const KEEP_TANK = 18;          // nothing grows this close to a tank pad
const WALK = {
  villager: { speed: 1.3, flee: 5.5 },
  sheep: { speed: 0.7, flee: 6.5 },
};

const isTree = (p) => p.kind === 'pine' || p.kind === 'oak';

function distToSegment(px, pz, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

export class Scenery {
  constructor(terrain) {
    this.terrain = terrain;
    this.clear();
  }

  clear() {
    this.props = [];      // { kind, x, y, z, rot, scale, tint, state: 'ok'|'fallen'|'ruin'|'gone', fall }
    this.walkers = [];    // villagers and sheep
    this.hamlets = [];    // { x, z }
    this.bridge = null;   // { a: [x, z], b: [x, z], y, alive }
    this.paths = [];      // roads and footpaths: { kind, width, points: [[x, z], ...] }
    this.events = [];
    this.version = (this.version || 0) + 1;
    this.terrain.waterLevel = -Infinity;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  slopeAt(x, z) { return 1 - this.terrain.normalAt(x, z)[1]; }
  dry(x, z, margin = 0) { return this.terrain.heightAt(x, z) > this.terrain.waterLevel + margin; }

  // The height a prop rests at. A standing house sits on the lowest point of
  // its footprint (its foundation covers the rest).
  seat(p) {
    const t = this.terrain;
    if (p.kind !== 'house' || p.state !== 'ok') return t.heightAt(p.x, p.z);
    return Math.min(t.heightAt(p.x, p.z), ...this.footprint(p).map(([x, z]) => t.heightAt(x, z)));
  }

  footprint(p) {
    const c = Math.cos(p.rot);
    const s = Math.sin(p.rot);
    return [[1, 1], [1, -1], [-1, 1], [-1, -1]].map(([u, v]) => {
      const lx = u * HOUSE.halfW;
      const lz = v * HOUSE.halfD;
      return [p.x + lx * c + lz * s, p.z - lx * s + lz * c];
    });
  }

  // ---------- generation ----------

  // `tanks` are the spawn points to keep clear. Call after the tanks are placed.
  generate({ seed = 1, tanks = [] } = {}) {
    this.clear();
    const t = this.terrain;
    const rng = makeRng(seed * 13 + 7);
    this.rng = makeRng(seed * 29 + 3);        // walkers, falls: separate from the game's dice
    const area = (t.size / 800) ** 2;
    const nearTank = (x, z, r) => tanks.some((k) => Math.hypot(k.x - x, k.z - z) < r);
    const spot = (reach = 0.42) => [rng.range(-1, 1) * t.size * reach, rng.range(-1, 1) * t.size * reach];

    this.chooseWaterLevel(tanks);
    let lo = Infinity;
    let hi = -Infinity;
    for (const h of t.heights) { if (h < lo) lo = h; if (h > hi) hi = h; }
    const band = (h) => (h - lo) / Math.max(1, hi - lo);

    // Hamlets: a handful of houses on flat, dry ground away from the tanks.
    const houses = [];
    const wantHamlets = Math.max(1, Math.round(3 * area));
    for (let tries = 0; tries < 400 && this.hamlets.length < wantHamlets; tries++) {
      const [x, z] = spot(0.4);
      if (!this.dry(x, z, 2.5) || this.slopeAt(x, z) > 0.035 || band(t.heightAt(x, z)) > 0.65) continue;
      if (nearTank(x, z, 55) || this.hamlets.some((h) => Math.hypot(h.x - x, h.z - z) < 150)) continue;
      const hamlet = { x, z };
      const want = rng.int(3, 6);
      let built = 0;
      for (let k = 0; k < 40 && built < want; k++) {
        const a = rng.range(0, Math.PI * 2);
        const r = rng.range(9, 28);
        const hx = x + Math.cos(a) * r;
        const hz = z + Math.sin(a) * r;
        if (!t.inBounds(hx, hz) || !this.dry(hx, hz, 2) || this.slopeAt(hx, hz) > 0.09) continue;
        if (nearTank(hx, hz, 32) || houses.some((h) => Math.hypot(h.x - hx, h.z - hz) < 12.5)) continue;
        t.flatten(hx, hz, 4.6);
        // Doors face the middle of the hamlet, give or take.
        const house = { kind: 'house', x: hx, y: 0, z: hz, rot: -a - Math.PI / 2 + rng.range(-0.4, 0.4), scale: rng.range(0.9, 1.15), tint: rng.int(0, 3), state: 'ok' };
        houses.push(house);
        built++;
      }
      if (built >= 2) this.hamlets.push(hamlet);
    }
    this.props.push(...houses);

    this.placeBridge(rng, nearTank, houses);
    this.paths = planPaths({ terrain: t, hamlets: this.hamlets, houses, bridge: this.bridge, tanks, seed });

    // Flora and rocks, scattered by height, slope and a low-frequency "grove"
    // noise so trees gather into woods instead of an even sprinkle.
    const grove = makePerlin(seed * 3 + 11);
    const taken = new Set();
    const count = { pine: 0, oak: 0, bush: 0, rock: 0 };
    const cap = { pine: 170 * area, oak: 150 * area, bush: 170 * area, rock: 110 * area };
    const blocked = (x, z) => nearTank(x, z, KEEP_TANK)
      || houses.some((h) => Math.hypot(h.x - x, h.z - z) < 7.5)
      || (this.bridge && distToSegment(x, z, this.bridge.a, this.bridge.b) < 6)
      || distToPaths(this.paths, x, z) < 2.5;
    for (let i = 0; i < 3200 * area; i++) {
      const x = rng.range(-1, 1) * (t.half - 5);
      const z = rng.range(-1, 1) * (t.half - 5);
      const r = rng.next();
      const h = t.heightAt(x, z);
      if (h < t.waterLevel + 0.6 || blocked(x, z)) continue;
      const s = this.slopeAt(x, z);
      const b = band(h);
      const g = grove(x * 0.011, z * 0.011);
      let kind = null;
      if ((s > 0.1 && r < 0.3) || r < 0.025) kind = 'rock';
      else if (s < 0.14 && b > 0.42 && g < 0.05 && r < 0.6) kind = 'pine';
      else if (s < 0.09 && b < 0.62 && g > 0.08 && h > t.waterLevel + 1.2 && r < 0.65) kind = 'oak';
      else if (s < 0.12 && r > 0.86) kind = 'bush';
      if (!kind || count[kind] >= cap[kind] || s > 0.3) continue;
      if (kind === 'pine' || kind === 'oak') {
        const key = `${Math.floor(x / 5)},${Math.floor(z / 5)}`;
        if (taken.has(key)) continue;
        taken.add(key);
      }
      count[kind]++;
      this.props.push({ kind, x, y: h, z, rot: rng.range(0, Math.PI * 2), scale: rng.range(0.75, 1.3), tint: rng.int(0, 3), state: 'ok' });
    }
    for (const p of this.props) p.y = this.seat(p);

    // Villagers potter about their hamlet; sheep graze in small flocks.
    const addWalker = (kind, hx, hz, roam) => {
      const a = rng.range(0, Math.PI * 2);
      const d = rng.range(2, roam * 0.6);
      const x = hx + Math.cos(a) * d;
      const z = hz + Math.sin(a) * d;
      if (!t.inBounds(x, z) || !this.dry(x, z, 0.4) || nearTank(x, z, 14)) return;
      this.walkers.push({ kind, x, y: t.heightAt(x, z), z, heading: a, hx, hz, roam, tx: x, tz: z, mode: 'idle', wait: rng.range(0, 5), tint: rng.int(0, 3), alive: true });
    };
    for (const h of this.hamlets) for (let k = rng.int(2, 3); k > 0; k--) addWalker('villager', h.x, h.z, 22);
    let flocks = 0;
    for (let tries = 0; tries < 200 && flocks < Math.max(1, Math.round(2 * area)); tries++) {
      const [x, z] = spot();
      if (!this.dry(x, z, 1.5) || this.slopeAt(x, z) > 0.06 || nearTank(x, z, 45)) continue;
      if (houses.some((h) => Math.hypot(h.x - x, h.z - z) < 30)) continue;
      for (let k = rng.int(4, 6); k > 0; k--) addWalker('sheep', x, z, 14);
      flocks++;
    }
    this.version++;
    return this;
  }

  // Flood the lowest few percent of the field, but never a tank.
  chooseWaterLevel(tanks) {
    const t = this.terrain;
    const sorted = Float32Array.from(t.heights).sort();
    let level = sorted[Math.floor(sorted.length * 0.07)];
    for (const k of tanks) level = Math.min(level, t.heightAt(k.x, k.z) - 4);
    let wet = 0;
    while (wet < sorted.length && sorted[wet] < level) wet++;
    t.waterLevel = wet / sorted.length >= 0.004 ? level : -Infinity;
  }

  // Look for the shortest dry-to-dry crossing of a stretch of water.
  placeBridge(rng, nearTank, houses) {
    const t = this.terrain;
    if (t.waterLevel === -Infinity) return;
    let best = null;
    for (let tries = 0, found = 0; tries < 600 && found < 14; tries++) {
      const x = rng.range(-1, 1) * t.size * 0.42;
      const z = rng.range(-1, 1) * t.size * 0.42;
      if (t.heightAt(x, z) > t.waterLevel - 0.3) continue;
      const a = rng.range(0, Math.PI);
      const shore = (dir) => {
        for (let d = 1.5; d <= 34; d += 1.5) {
          const px = x + Math.cos(a) * d * dir;
          const pz = z + Math.sin(a) * d * dir;
          if (!t.inBounds(px, pz)) return null;
          if (t.heightAt(px, pz) >= t.waterLevel + 1.2) return [px + Math.cos(a) * 2 * dir, pz + Math.sin(a) * 2 * dir];
        }
        return null;
      };
      const A = shore(-1);
      const B = shore(1);
      if (!A || !B || !t.inBounds(A[0], A[1]) || !t.inBounds(B[0], B[1])) continue;
      const hA = t.heightAt(A[0], A[1]);
      const hB = t.heightAt(B[0], B[1]);
      const span = Math.hypot(B[0] - A[0], B[1] - A[1]);
      if (Math.abs(hA - hB) > 2.5 || span < 14 || span > 60) continue;
      if (nearTank(A[0], A[1], 30) || nearTank(B[0], B[1], 30)) continue;
      if (houses.some((h) => distToSegment(h.x, h.z, A, B) < 9)) continue;
      const y = Math.max(hA, hB) + 0.4;
      // Nothing between the banks may poke up through the deck.
      let clear = true;
      for (let k = 1; k < 10 && clear; k++) {
        const u = k / 10;
        if (u * span > 4 && (1 - u) * span > 4 && t.heightAt(A[0] + (B[0] - A[0]) * u, A[1] + (B[1] - A[1]) * u) > y - 0.6) clear = false;
      }
      if (!clear) continue;
      found++;
      if (!best || span < best.span) best = { a: A, b: B, y, span, alive: true };
    }
    this.bridge = best;
  }

  // ---------- reacting to the ground ----------

  note(p, how) { this.events.push({ type: 'prop', kind: p.kind, how, pos: [p.x, p.y, p.z] }); }

  remove(p, how = 'gone') {
    p.state = 'gone';
    this.note(p, how);
  }

  // A crater of `radius` was just carved at (cx, cz).
  afterBlast(cx, cz, radius) {
    for (const p of this.props) {
      if (p.state === 'gone') continue;
      const d = Math.hypot(p.x - cx, p.z - cz);
      if (p.kind === 'rock') continue;             // rocks just drop into the hole
      if (p.kind === 'house') {
        if (p.state === 'ruin' && d < radius * 0.6) this.remove(p);
        else if (p.state === 'ok' && d < radius + 4.5) this.ruin(p);
      } else if (d < radius * 0.85) this.remove(p);
      else if (isTree(p) && p.state === 'ok' && d < radius * 1.3) this.topple(p, Math.atan2(p.z - cz, p.x - cx));
    }
    this.settle(cx, cz, radius + 6);
    const b = this.bridge;
    if (b && b.alive && distToSegment(cx, cz, b.a, b.b) < radius + 2) this.dropBridge();
    for (const w of this.walkers) {
      if (!w.alive) continue;
      const d = Math.hypot(w.x - cx, w.z - cz);
      if (d < radius) { w.alive = false; this.note(w, 'gone'); } else if (d < radius + 80) this.scare(w, cx, cz);
    }
    this.version++;
  }

  // A mound of `radius` was just raised at (cx, cz).
  afterMound(cx, cz, radius) {
    this.settle(cx, cz, radius + 6);
    const b = this.bridge;
    if (b && b.alive && distToSegment(cx, cz, b.a, b.b) < radius) this.dropBridge();
    for (const w of this.walkers) {
      if (w.alive && Math.hypot(w.x - cx, w.z - cz) < radius + 40) this.scare(w, cx, cz);
    }
    this.version++;
  }

  // Put every prop near (cx, cz) back on the ground as it is now. Anything the
  // ground rose over is buried, anything now under water is lost.
  settle(cx, cz, reach) {
    const t = this.terrain;
    for (const p of this.props) {
      if (p.state === 'gone' || Math.hypot(p.x - cx, p.z - cz) > reach) continue;
      let g = this.seat(p);
      const shift = g - p.y;
      if (shift > 1.2) { this.remove(p, 'buried'); continue; }
      if (p.kind !== 'rock' && t.heightAt(p.x, p.z) < t.waterLevel - 0.4) { this.remove(p, 'drowned'); continue; }
      if (p.kind === 'house' && p.state === 'ok') {
        const uneven = Math.max(...this.footprint(p).map(([x, z]) => t.heightAt(x, z))) - g;
        if (Math.abs(shift) > 0.5 || uneven > 1.2) { this.ruin(p); g = this.seat(p); }
      } else if (isTree(p) && p.state === 'ok' && shift < -2.5) this.topple(p, this.rng.range(0, Math.PI * 2));
      p.y = g;
    }
    for (const w of this.walkers) if (w.alive) w.y = t.heightAt(w.x, w.z);
  }

  ruin(p) { p.state = 'ruin'; p.y = this.seat(p); this.note(p, 'ruin'); }
  topple(p, dir) { p.state = 'fallen'; p.fall = dir; this.note(p, 'fallen'); }

  dropBridge() {
    const b = this.bridge;
    b.alive = false;
    this.events.push({ type: 'prop', kind: 'bridge', how: 'gone', pos: [(b.a[0] + b.b[0]) / 2, b.y, (b.a[1] + b.b[1]) / 2], a: b.a, b: b.b });
  }

  // ---------- villagers and sheep ----------

  scare(w, fromX, fromZ) {
    w.mode = 'flee';
    w.route = null;
    w.heading = Math.atan2(w.z - fromZ, w.x - fromX) + this.rng.range(-0.5, 0.5);
    w.wait = this.rng.range(2.5, 4.5);
  }

  // Send a villager for a walk along the nearest road or path: over to it,
  // then a way along it, never far from home. False if there is none handy.
  stroll(w, open) {
    let best = null;
    for (const p of this.paths) {
      if (p.kind === 'spur') continue;
      p.points.forEach((q, i) => {
        const d = Math.hypot(q[0] - w.x, q[1] - w.z);
        if (d < 40 && (!best || d < best.d)) best = { p, i, d };
      });
    }
    if (!best) return false;
    const dir = this.rng.next() < 0.5 ? 1 : -1;
    const want = this.rng.int(5, 16);
    const route = [];
    for (let i = best.i; i >= 0 && i < best.p.points.length && route.length < want; i += dir) {
      const [x, z] = best.p.points[i];
      if (!open(x, z) || Math.hypot(x - w.hx, z - w.hz) > 80) break;
      route.push([x, z]);
    }
    if (route.length < 3) return false;
    [w.tx, w.tz] = route.shift();
    w.route = route;
    w.mode = 'walk';
    return true;
  }

  update(dt, tanks = []) {
    const t = this.terrain;
    const rng = this.rng;
    const edge = t.half - 4;
    const open = (x, z) => Math.abs(x) < edge && Math.abs(z) < edge && this.dry(x, z, 0.25)
      && !tanks.some((k) => k.alive !== false && Math.hypot(k.x - x, k.z - z) < 13);
    for (const w of this.walkers) {
      if (!w.alive) continue;
      const pace = WALK[w.kind];
      if (w.mode === 'flee') {
        w.wait -= dt;
        const x = w.x + Math.cos(w.heading) * pace.flee * dt;
        const z = w.z + Math.sin(w.heading) * pace.flee * dt;
        if (open(x, z)) { w.x = x; w.z = z; } else w.heading += 0.9;
        if (w.wait <= 0) { w.mode = 'idle'; w.wait = rng.range(1, 3); }
      } else if (w.mode === 'idle') {
        w.wait -= dt;
        if (w.wait <= 0 && w.kind === 'villager' && this.paths.length && rng.next() < 0.5 && this.stroll(w, open)) {
          // off along the road
        } else if (w.wait <= 0) {
          const a = rng.range(0, Math.PI * 2);
          const d = rng.range(2, w.roam);
          const x = w.hx + Math.cos(a) * d;
          const z = w.hz + Math.sin(a) * d;
          if (open(x, z) && this.slopeAt(x, z) < 0.2) { w.tx = x; w.tz = z; w.mode = 'walk'; } else w.wait = 0.6;
        }
      } else {
        const dx = w.tx - w.x;
        const dz = w.tz - w.z;
        const d = Math.hypot(dx, dz);
        const step = pace.speed * dt;
        if (d <= step && w.route && w.route.length) [w.tx, w.tz] = w.route.shift();
        else if (d <= step) { w.mode = 'idle'; w.wait = rng.range(1.5, w.kind === 'sheep' ? 9 : 5); } else {
          const x = w.x + (dx / d) * step;
          const z = w.z + (dz / d) * step;
          w.heading = Math.atan2(dz, dx);
          if (open(x, z)) { w.x = x; w.z = z; } else { w.mode = 'idle'; w.wait = 1; w.route = null; }
        }
      }
      w.y = t.heightAt(w.x, w.z);
    }
  }
}
