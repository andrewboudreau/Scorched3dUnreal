import { makeRng } from './rng.js';
import { Traffic } from './traffic.js';

// The City world (`world: 'city'`): a street grid over a gently graded field,
// blocks of buildings from low shops at the edge of town to towers in the
// middle, and parks where the tanks start, so every tank begins in the open
// with buildings between it and the others.
//
// Unlike the meadow's houses, the city's buildings are real obstacles:
//
//  - A shell that meets a standing building's side or roof stops there and
//    goes off (ballistics.groundContact asks `contact`, so the live game, the
//    CPUs' solver, the aim arc and the Survey Satellite all see the same walls).
//  - Blasts wear buildings down (`blast`): hit points, floors off the top (a
//    broken top), and chunks out of the walls. A building with no hit points
//    left comes down (`collapse`) into a rubble heap that the game raises as a
//    mound in the ground, so it stays in the way of tanks and low shots.
//  - Tanks cannot drive through a standing building (tank.js treats each as a
//    box: `hx`, `hz`, `top`).
//
// Everything here is a pure function of the match seed, the tank pads and the
// blasts so far, in order: the game records each blast and each collapse in
// its ground ops ('b' and 'r'), so another screen rebuilds the same city
// (game.rebuildGround), and snapshots carry each building's state on top.
// Traffic (core/traffic.js) is cosmetic, like the villagers.

export const CITY = {
  pitchX: [60, 72],    // m from one street's middle to the next, along x and along z
  pitchZ: [56, 70],
  street: 14,          // m between the blocks: the road and a sidewalk each side
  road: 9,             // m of asphalt: two lanes
  extent: 0.8,         // share of the field's half-size the street grid spans
  floor: 3.5,          // m a storey
  parapet: 0.8,        // m of roof edge on top of the last storey
  footing: 9,          // m a building's box reaches below its base (the foundations a crater bares)
  padClear: 16,        // m from a tank pad to the nearest building lot
  hurt: 2.4,           // a blast's tank damage times this is what it does to a building
  hitsKept: 10,        // wall scars a building remembers
  cell: 32,            // m, the lookup grid
  zones: [             // by distance from the middle of town: storeys
    { r: 95, floors: [7, 12] },    // downtown towers, about 26 to 43 m
    { r: 190, floors: [3, 7] },    // midtown, 11 to 25 m
    { r: Infinity, floors: [1, 3] },   // shops and walk-ups, 4 to 11 m
  ],
  styles: 3,           // facade styles: 0 glass, 1 office, 2 brick (render/cityMesh.js)
};

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

export class City {
  constructor(terrain) {
    this.terrain = terrain;
    this.buildings = [];
    this.blocks = [];
    this.xs = [];
    this.zs = [];
    this.holes = [];     // [x, z, r]: craters and rubble in the streets, for the traffic
    this.events = [];
    this.version = 0;
    this.traffic = null;
    this.grid = [];
    this.maxTop = -Infinity;
  }

  drainEvents() { const e = this.events; this.events = []; return e; }

  // ---------- layout ----------

  // Lay the city out over the ground as it is now (call after the tank pads
  // are flattened). `pads` are the tanks' [x, z].
  generate({ seed = 1, pads = [] } = {}) {
    const t = this.terrain;
    const rng = makeRng(seed * 7 + 41);
    const L = t.half * CITY.extent;
    const lines = (pitch) => {
      const p = rng.range(pitch[0], pitch[1]);
      const o = rng.range(-p / 2, p / 2);
      const out = [];
      for (let k = Math.ceil((-L - o) / p); k <= Math.floor((L - o) / p); k++) out.push(o + k * p);
      return out;
    };
    this.xs = lines(CITY.pitchX);
    this.zs = lines(CITY.pitchZ);
    this.centre = [rng.range(-40, 40), rng.range(-40, 40)];
    this.buildings = [];
    this.blocks = [];
    this.holes = [];
    this.events = [];
    const half = CITY.street / 2;
    const padNear = (x0, x1, z0, z1, r) => pads.some(([px, pz]) => Math.hypot(Math.max(x0 - px, 0, px - x1), Math.max(z0 - pz, 0, pz - z1)) < r);
    for (let j = 0; j + 1 < this.zs.length; j++) {
      for (let i = 0; i + 1 < this.xs.length; i++) {
        const b = { i, j, x0: this.xs[i] + half, x1: this.xs[i + 1] - half, z0: this.zs[j] + half, z1: this.zs[j + 1] - half, kind: 'built', zone: 2 };
        const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
        const r = Math.hypot(cx - this.centre[0], cz - this.centre[1]) * rng.range(0.85, 1.15);
        b.zone = CITY.zones.findIndex((z) => r < z.r);
        const roll = rng.next();
        if (padNear(b.x0, b.x1, b.z0, b.z1, CITY.padClear)) b.kind = 'park';
        else if (roll < (b.zone === 2 ? 0.1 : 0.06)) b.kind = 'park';
        else if (roll < (b.zone === 2 ? 0.13 : 0.12)) b.kind = 'plaza';
        this.blocks.push(b);
        if (b.kind === 'built') this.fillBlock(b, rng);
      }
    }
    for (const b of this.buildings) this.seat(b);
    this.index();
    this.traffic = new Traffic(this, seed * 31 + 17);
    this.version++;
    return this;
  }

  // Put buildings on a block: one tower on its own, a pair, four, or a row of
  // shops along two sides; now and then a lot is left empty (a car park).
  fillBlock(b, rng) {
    const zone = CITY.zones[b.zone];
    const rects = [];
    const w = b.x1 - b.x0, d = b.z1 - b.z0;
    const roll = rng.next();
    const inset = (x0, x1, z0, z1, m) => rects.push([x0 + m, x1 - m, z0 + m, z1 - m]);
    if (b.zone === 0 && roll < 0.45) {
      const m = rng.range(6, 11);
      inset(b.x0, b.x1, b.z0, b.z1, m);
    } else if (roll < (b.zone === 2 ? 0.25 : 0.6)) {
      const gap = rng.range(4, 7);
      const f = rng.range(0.4, 0.6);
      if (w >= d) {
        const xm = b.x0 + w * f;
        inset(b.x0, xm - gap / 2, b.z0, b.z1, rng.range(1, 3));
        inset(xm + gap / 2, b.x1, b.z0, b.z1, rng.range(1, 3));
      } else {
        const zm = b.z0 + d * f;
        inset(b.x0, b.x1, b.z0, zm - gap / 2, rng.range(1, 3));
        inset(b.x0, b.x1, zm + gap / 2, b.z1, rng.range(1, 3));
      }
    } else if (roll < (b.zone === 2 ? 0.5 : 0.85)) {
      const gap = rng.range(5, 8);
      const xm = b.x0 + w * rng.range(0.42, 0.58);
      const zm = b.z0 + d * rng.range(0.42, 0.58);
      for (const [x0, x1] of [[b.x0, xm - gap / 2], [xm + gap / 2, b.x1]]) {
        for (const [z0, z1] of [[b.z0, zm - gap / 2], [zm + gap / 2, b.z1]]) inset(x0, x1, z0, z1, rng.range(0.5, 2.5));
      }
    } else {
      // Shops along two opposite sides, a yard between them.
      const deep = rng.range(11, 15);
      const alongX = rng.next() < 0.5;
      const span = alongX ? w : d;
      const n = rng.int(2, 3);
      for (const side of [0, 1]) {
        let s0 = 0;
        for (let k = 0; k < n; k++) {
          const s1 = k === n - 1 ? span : s0 + (span / n) * rng.range(0.8, 1.2);
          const a = s0 + 0.6, c = s1 - 0.6;
          if (alongX) rects.push(side ? [b.x0 + a, b.x0 + c, b.z1 - deep, b.z1 - 0.8] : [b.x0 + a, b.x0 + c, b.z0 + 0.8, b.z0 + deep]);
          else rects.push(side ? [b.x1 - deep, b.x1 - 0.8, b.z0 + a, b.z0 + c] : [b.x0 + 0.8, b.x0 + deep, b.z0 + a, b.z0 + c]);
          s0 = s1;
        }
      }
    }
    const style = rng.int(0, CITY.styles - 1);
    for (const [x0, x1, z0, z1] of rects) {
      if (x1 - x0 < 6 || z1 - z0 < 6) continue;
      if (rects.length > 1 && rng.next() < 0.08) continue;   // an empty lot
      let [lo, hi] = zone.floors;
      if (rng.next() < 0.15) { lo += 2; hi += 3; }            // a taller one now and then
      const floors = Math.min(12, rng.int(lo, hi));
      const hx = (x1 - x0) / 2, hz = (z1 - z0) / 2;
      const id = this.buildings.length;
      const h = floors * CITY.floor + CITY.parapet;
      const maxHp = Math.round(50 + 6 * h + 0.04 * hx * hz * 4);
      this.buildings.push({
        id, box: true, x: (x0 + x1) / 2, z: (z0 + z1) / 2, hx, hz, base: 0, top: 0,
        floors0: floors, floors, hp: maxHp, maxHp,
        style: b.zone === 0 ? (rng.next() < 0.6 ? 0 : 1) : b.zone === 2 ? (rng.next() < 0.6 ? 2 : style) : style,
        tint: rng.int(0, 5), seed: rng.int(1, 1e9),
        broken: false, collapsed: false, hits: [],
      });
    }
  }

  // A building stands on the lowest point of its footprint; its box reaches
  // below that (the foundations), so it never floats on a slope.
  seat(b) {
    const t = this.terrain;
    let lo = t.heightAt(b.x, b.z);
    for (const [u, v] of [[1, 1], [1, -1], [-1, 1], [-1, -1], [1, 0], [-1, 0], [0, 1], [0, -1]]) lo = Math.min(lo, t.heightAt(b.x + u * b.hx, b.z + v * b.hz));
    b.base = lo;
    this.reroof(b);
  }

  reroof(b) {
    b.top = b.collapsed ? b.base : b.base + b.floors * CITY.floor + CITY.parapet;
  }

  // Which lookup cells each building's footprint covers.
  index() {
    const t = this.terrain;
    const n = (this.gridN = Math.ceil(t.size / CITY.cell));
    this.grid = Array.from({ length: n * n }, () => []);
    for (const b of this.buildings) {
      const i0 = this.cellI(b.x - b.hx), i1 = this.cellI(b.x + b.hx);
      const j0 = this.cellI(b.z - b.hz), j1 = this.cellI(b.z + b.hz);
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) this.grid[j * n + i].push(b.id);
    }
    this.restack();
  }

  cellI(v) { return clamp(Math.floor((v + this.terrain.half) / CITY.cell), 0, this.gridN - 1); }
  cellAt(x, z) { return this.cellI(z) * this.gridN + this.cellI(x); }

  // The tallest roof and the buildings still standing (game.obstacles).
  restack() {
    this.standing = this.buildings.filter((b) => !b.collapsed);
    this.maxTop = this.standing.reduce((m, b) => Math.max(m, b.top), -Infinity);
  }

  // Standing buildings within `r` of x/z (footprint to point).
  near(x, z, r) {
    const out = [];
    const i0 = this.cellI(x - r), i1 = this.cellI(x + r);
    const j0 = this.cellI(z - r), j1 = this.cellI(z + r);
    const seen = new Set();
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.grid[j * this.gridN + i]) {
          if (seen.has(id)) continue;
          seen.add(id);
          const b = this.buildings[id];
          if (!b.collapsed && footDist(b, x, z) < r) out.push(b);
        }
      }
    }
    return out;
  }

  // ---------- what a shell meets ----------

  // Did the step from `a` to `b` ([x, y, z]) enter a standing building? The
  // first point where it did, tagged with the building's id (`.building`), or
  // null. A step that starts inside one stops where it starts.
  contact(a, b) {
    if ((a[1] < b[1] ? a[1] : b[1]) > this.maxTop || !this.gridN) return null;
    const i0 = this.cellI(Math.min(a[0], b[0])), i1 = this.cellI(Math.max(a[0], b[0]));
    const j0 = this.cellI(Math.min(a[2], b[2])), j1 = this.cellI(Math.max(a[2], b[2]));
    let best = Infinity;
    let who = -1;
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.grid[j * this.gridN + i]) {
          const k = this.buildings[id];
          if (k.collapsed) continue;
          const s = segBox(a, b, k.x - k.hx, k.x + k.hx, k.base - CITY.footing, k.top, k.z - k.hz, k.z + k.hz);
          if (s < best) { best = s; who = id; }
        }
      }
    }
    if (who < 0) return null;
    const p = [a[0] + (b[0] - a[0]) * best, a[1] + (b[1] - a[1]) * best, a[2] + (b[2] - a[2]) * best];
    p.building = who;
    return p;
  }

  // Is x/y/z inside a standing building? (y omitted: anywhere up its height.)
  inside(x, z, y = null) {
    if (!this.gridN) return false;
    for (const id of this.grid[this.cellAt(x, z)]) {
      const k = this.buildings[id];
      if (k.collapsed || Math.abs(x - k.x) > k.hx || Math.abs(z - k.z) > k.hz) continue;
      if (y == null || (y <= k.top && y >= k.base - CITY.footing)) return true;
    }
    return false;
  }

  // The highest standing roof within `margin` of x/z, or -Infinity (the camera keeps above it).
  roofAt(x, z, margin = 0) {
    if (!this.gridN) return -Infinity;
    let top = -Infinity;
    const i0 = this.cellI(x - margin), i1 = this.cellI(x + margin);
    const j0 = this.cellI(z - margin), j1 = this.cellI(z + margin);
    for (let j = j0; j <= j1; j++) {
      for (let i = i0; i <= i1; i++) {
        for (const id of this.grid[j * this.gridN + i]) {
          const k = this.buildings[id];
          if (!k.collapsed && k.top > top && Math.abs(x - k.x) <= k.hx + margin && Math.abs(z - k.z) <= k.hz + margin) top = k.top;
        }
      }
    }
    return top;
  }

  // ---------- blasts ----------

  // A blast of `radius` (and tank `damage`) at x/y/z. Every standing building
  // in reach loses hit points, by the same falloff as a tank (out to 1.25
  // radius from its nearest face); one hit near its roof loses the floors the
  // blast reaches, and every building keeps only as many floors as its hit
  // points hold up, so a hurt building comes down from the top. Returns the
  // ids of the buildings it left with no hit points (the game collapses them).
  blast(x, y, z, radius, damage) {
    const reach = radius * 1.25;
    const fallen = [];
    let changed = false;
    for (const b of this.near(x, z, reach)) {
      const dy = y > b.top ? y - b.top : y < b.base ? b.base - y : 0;
      const d = Math.hypot(footDist(b, x, z), dy);
      if (d >= reach) continue;
      const before = b.floors;
      b.hp -= damage * CITY.hurt * (1 - d / reach);
      changed = true;
      let floors = b.floors;
      if (d < radius && y + radius * 0.5 > b.top) {
        floors = Math.min(floors, Math.floor((Math.min(y, b.top) - radius * 0.45 - b.base) / CITY.floor));
      }
      floors = Math.min(floors, Math.ceil(b.floors0 * (0.25 + 0.75 * Math.max(0, b.hp) / b.maxHp)));
      b.floors = Math.max(1, floors);
      if (b.floors < before) {
        b.broken = true;
        this.reroof(b);
        this.events.push({ type: 'building', id: b.id, how: 'floors', lost: before - b.floors, pos: [b.x, b.top, b.z] });
      }
      if (d < radius * 0.5 && y < b.top - 0.5) this.scar(b, x, y, z, radius);
      if (b.hp <= 0) fallen.push(b.id);
      else if (b.floors === before) this.events.push({ type: 'building', id: b.id, how: 'hit', pos: [x, y, z] });
    }
    const g = this.terrain.heightAt(x, z);
    if (y - g < radius) this.holes.push([x, z, radius * 0.8]);
    this.traffic?.afterBlast(x, y, z, radius);
    if (changed) this.restack();
    this.version++;
    return fallen;
  }

  // A chunk out of the wall the blast was against: [face, along, up, size],
  // face 0..3 for +x, -x, +z, -z.
  scar(b, x, y, z, radius) {
    const fx = (x - b.x) / b.hx, fz = (z - b.z) / b.hz;
    const face = Math.abs(fx) > Math.abs(fz) ? (fx > 0 ? 0 : 1) : (fz > 0 ? 2 : 3);
    const along = face < 2 ? clamp(z - b.z, -b.hz + 1, b.hz - 1) : clamp(x - b.x, -b.hx + 1, b.hx - 1);
    const up = clamp(y - b.base, 1, b.top - b.base - 1);
    b.hits.push([face, along, up, Math.min(radius * 0.35, 6)]);
    if (b.hits.length > CITY.hitsKept) b.hits.shift();
  }

  // Bring building `id` down. Returns the rubble heap { x, z, radius, height }
  // that the game raises in the ground (game.collapseBuilding).
  collapse(id) {
    const b = this.buildings[id];
    const tall = b.floors0 * CITY.floor;
    b.collapsed = true;
    b.hp = 0;
    b.floors = 0;
    this.reroof(b);
    this.restack();
    const heap = { x: b.x, z: b.z, radius: Math.max(b.hx, b.hz) + 3, height: clamp(1.5 + tall * 0.13, 2.5, 7.5) };
    this.holes.push([b.x, b.z, heap.radius]);
    this.traffic?.afterBlast(b.x, b.base, b.z, heap.radius + 4);
    this.events.push({ type: 'building', id, how: 'collapse', pos: [b.x, b.base, b.z], tall, size: [b.hx, b.hz] });
    this.version++;
    return heap;
  }

  // ---------- online ----------

  // Each building's hit points, floors and whether it has come down: what a
  // snapshot carries on top of the ground's ops (game.snapshot).
  state() { return this.buildings.map((b) => [Math.round(b.hp * 100) / 100, b.floors, b.collapsed ? 1 : 0]); }

  setState(s) {
    if (!Array.isArray(s) || s.length !== this.buildings.length) return;
    let changed = false;
    s.forEach(([hp, floors, down], i) => {
      const b = this.buildings[i];
      if (b.collapsed !== !!down || b.floors !== (down ? 0 : floors)) changed = true;
      b.hp = hp;
      b.collapsed = !!down;
      b.floors = down ? 0 : floors;
      if (b.floors < b.floors0) b.broken = true;
      this.reroof(b);
    });
    if (!changed) return;
    this.restack();
    this.version++;
  }

  // ---------- set dressing (core/scenery.js calls this for a city) ----------

  // Trees and strollers in the parks, a few trees along the sidewalks. Kept
  // `keep` m clear of the tanks, as on the meadows.
  dress(scenery, rng, tanks, keep = 18) {
    const t = this.terrain;
    const nearTank = (x, z, r) => tanks.some((k) => Math.hypot(k.x - x, k.z - z) < r);
    const prop = (kind, x, z, scale = rng.range(0.8, 1.2)) => scenery.props.push({ kind, x, y: t.heightAt(x, z), z, rot: rng.range(0, Math.PI * 2), scale, tint: rng.int(0, 3), state: 'ok' });
    for (const b of this.blocks) {
      if (b.kind !== 'park') continue;
      const cx = (b.x0 + b.x1) / 2, cz = (b.z0 + b.z1) / 2;
      const n = rng.int(5, 10);
      for (let k = 0; k < n * 3 && n > 0; k++) {
        const x = rng.range(b.x0 + 3, b.x1 - 3), z = rng.range(b.z0 + 3, b.z1 - 3);
        if (nearTank(x, z, keep)) continue;
        if (Math.abs(x - cx) < 2.5 || Math.abs(z - cz) < 2.5) continue;   // the park's paths
        const r = rng.next();
        prop(r < 0.6 ? 'oak' : r < 0.8 ? 'pine' : 'bush', x, z);
        if (scenery.props.length > 400) break;
      }
      scenery.hamlets.push({ x: cx, z: cz });
      if (nearTank(cx, cz, 14)) continue;
      for (let k = rng.int(1, 3); k > 0; k--) {
        const a = rng.range(0, Math.PI * 2), d = rng.range(2, 10);
        const x = cx + Math.cos(a) * d, z = cz + Math.sin(a) * d;
        scenery.walkers.push({ kind: 'villager', x, y: t.heightAt(x, z), z, heading: a, hx: cx, hz: cz, roam: 15, tx: x, tz: z, mode: 'idle', wait: rng.range(0, 5), tint: rng.int(0, 3), alive: true });
      }
    }
    // Woods and copses round the edge of town.
    const L = Math.max(Math.abs(this.xs[0]), Math.abs(this.xs[this.xs.length - 1]), Math.abs(this.zs[0]), Math.abs(this.zs[this.zs.length - 1]));
    for (let k = 0; k < 160; k++) {
      const x = rng.range(-1, 1) * t.half * 0.95, z = rng.range(-1, 1) * t.half * 0.95;
      if (x > this.xs[0] - 6 && x < this.xs[this.xs.length - 1] + 6 && z > this.zs[0] - 6 && z < this.zs[this.zs.length - 1] + 6) continue;
      if (nearTank(x, z, keep) || Math.max(Math.abs(x), Math.abs(z)) < L) continue;
      prop(rng.next() < 0.55 ? 'pine' : 'oak', x, z);
    }
    // Street trees on the sidewalks of the quieter streets.
    const side = CITY.street / 2 - 1.2;
    for (const b of this.blocks) {
      if (b.zone === 0 || b.kind === 'park' || rng.next() < 0.5) continue;
      const edges = [[b.x0, b.z0 - 0, b.x1, b.z0, 0, -1], [b.x0, b.z1, b.x1, b.z1, 0, 1], [b.x0, b.z0, b.x0, b.z1, -1, 0], [b.x1, b.z0, b.x1, b.z1, 1, 0]];
      const [x0, z0, x1, z1, nx, nz] = rng.pick(edges);
      const len = Math.hypot(x1 - x0, z1 - z0);
      for (let s = 8; s < len - 8; s += rng.range(10, 14)) {
        const x = x0 + ((x1 - x0) / len) * s + nx * (CITY.street / 2 - side);
        const z = z0 + ((z1 - z0) / len) * s + nz * (CITY.street / 2 - side);
        if (!nearTank(x, z, keep)) prop('oak', x, z, rng.range(0.6, 0.8));
      }
    }
  }
}

// How far x/z is from a building's footprint (0 inside it).
export function footDist(b, x, z) {
  const dx = Math.abs(x - b.x) - b.hx;
  const dz = Math.abs(z - b.z) - b.hz;
  return Math.hypot(dx > 0 ? dx : 0, dz > 0 ? dz : 0);
}

// Where along the segment a->b (0..1) it first enters the box, or Infinity.
function segBox(a, b, x0, x1, y0, y1, z0, z1) {
  let t0 = 0, t1 = 1;
  const lo = [x0, y0, z0], hi = [x1, y1, z1];
  for (let k = 0; k < 3; k++) {
    const d = b[k] - a[k];
    if (d > -1e-9 && d < 1e-9) {
      if (a[k] < lo[k] || a[k] > hi[k]) return Infinity;
      continue;
    }
    let ta = (lo[k] - a[k]) / d, tb = (hi[k] - a[k]) / d;
    if (ta > tb) { const s = ta; ta = tb; tb = s; }
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}
