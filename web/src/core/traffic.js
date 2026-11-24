import { makeRng } from './rng.js';

// The City's traffic: cars, buses and delivery trucks driving the street
// grid (core/city.js). Like the villagers and sheep (core/scenery.js) it is
// set dressing with its own rng: it never stops a shell or a tank, is not in
// the snapshot, and may differ between screens online.
//
// Vehicles keep to the right-hand lane of each street, follow the one ahead,
// wait at red lights, and turn through a junction on a smooth curve. A tank
// in the lane holds them up (and they turn back if it stays). A blast near
// one wrecks it (flipped and burning for a while); one further off sends
// the traffic around it away at speed, turning back if it was headed that
// way. Craters and rubble in a street close it: vehicles route around them.

export const VEHICLES = {
  car: { len: 4.4, width: 2, speed: 11 },
  bus: { len: 11, width: 2.6, speed: 8 },
  truck: { len: 7, width: 2.4, speed: 9 },
};

const LANE = 2.3;          // m from the street's middle to a lane's
const CYCLE = 18;          // s for a junction's lights to go round
const GAP = 3;             // m kept to the vehicle ahead
const WRECK_TTL = 28;      // s a wreck burns

export class Traffic {
  constructor(city, seed = 1) {
    this.city = city;
    this.rng = makeRng(seed);
    this.time = 0;
    this.vehicles = [];
    this.build();
    this.populate();
  }

  // Junctions are where the streets cross; an edge joins two neighbours.
  build() {
    const { xs, zs } = this.city;
    this.nx = xs.length;
    this.nodes = [];
    for (let j = 0; j < zs.length; j++) {
      for (let i = 0; i < xs.length; i++) {
        this.nodes.push({ x: xs[i], z: zs[j], i, j, next: [], phase: this.rng.range(0, CYCLE) });
      }
    }
    const id = (i, j) => j * this.nx + i;
    for (const n of this.nodes) {
      if (n.i > 0) n.next.push(id(n.i - 1, n.j));
      if (n.i < xs.length - 1) n.next.push(id(n.i + 1, n.j));
      if (n.j > 0) n.next.push(id(n.i, n.j - 1));
      if (n.j < zs.length - 1) n.next.push(id(n.i, n.j + 1));
    }
  }

  populate() {
    const rng = this.rng;
    const edges = this.nodes.reduce((s, n) => s + n.next.length, 0);
    const count = Math.min(36, Math.max(8, Math.round(edges / 3.2)));
    for (let k = 0; k < count; k++) {
      const r = rng.next();
      const kind = r < 0.12 ? 'bus' : r < 0.25 ? 'truck' : 'car';
      for (let tries = 0; tries < 12; tries++) {
        const a = rng.int(0, this.nodes.length - 1);
        const b = rng.pick(this.nodes[a].next);
        if (b == null) continue;
        const len = this.edgeLen(a, b);
        const s = rng.range(this.clear(), Math.max(this.clear() + 1, len - this.clear() - 8));
        if (this.vehicles.some((v) => v.a === a && v.b === b && Math.abs(v.s - s) < 16)) continue;
        const spec = VEHICLES[kind];
        const v = {
          kind, a, b, s, len: spec.len, cruise: spec.speed * rng.range(0.85, 1.1), v: 0,
          x: 0, y: 0, z: 0, heading: 0, tint: rng.int(0, 7),
          mode: 'drive', flee: 0, hold: 0, ghost: 0,
          turn: false, t0x: 0, t0z: 0, t1x: 0, t1z: 0, t2x: 0, t2z: 0, tu: 0, tlen: 1, tnext: 0,
          flipped: false, burn: 0, alive: true,
        };
        this.vehicles.push(v);
        this.place(v);
        break;
      }
    }
  }

  // Half a junction: a vehicle drives its edge between these and curves through the rest.
  clear() { return 7; }

  edgeLen(a, b) {
    const p = this.nodes[a], q = this.nodes[b];
    return Math.abs(q.x - p.x) + Math.abs(q.z - p.z);
  }

  // The lane point `s` m along the edge a->b.
  lanePoint(a, b, s, out) {
    const p = this.nodes[a], q = this.nodes[b];
    const len = this.edgeLen(a, b);
    const dx = (q.x - p.x) / len, dz = (q.z - p.z) / len;
    out[0] = p.x + dx * s - dz * LANE;
    out[1] = p.z + dz * s + dx * LANE;
    out[2] = dx;
    out[3] = dz;
    return out;
  }

  place(v) {
    const t = this.city.terrain;
    if (v.turn) {
      const u = v.tu, w = 1 - u;
      v.x = w * w * v.t0x + 2 * w * u * v.t1x + u * u * v.t2x;
      v.z = w * w * v.t0z + 2 * w * u * v.t1z + u * u * v.t2z;
      const dx = 2 * w * (v.t1x - v.t0x) + 2 * u * (v.t2x - v.t1x);
      const dz = 2 * w * (v.t1z - v.t0z) + 2 * u * (v.t2z - v.t1z);
      if (dx * dx + dz * dz > 1e-6) v.heading = Math.atan2(dz, dx);
    } else {
      const o = this.lanePoint(v.a, v.b, v.s, _p);
      v.x = o[0];
      v.z = o[1];
      v.heading = Math.atan2(o[3], o[2]);
    }
    v.y = t.heightAt(v.x, v.z);
  }

  // Is the street a->b closed by a crater or rubble?
  blocked(a, b) {
    const holes = this.city.holes;
    if (!holes.length) return false;
    const p = this.nodes[a], q = this.nodes[b];
    for (const [hx, hz, r] of holes) {
      const x = Math.max(Math.min(p.x, q.x), Math.min(Math.max(p.x, q.x), hx));
      const z = Math.max(Math.min(p.z, q.z), Math.min(Math.max(p.z, q.z), hz));
      if (Math.hypot(hx - x, hz - z) < r + 3) return true;
    }
    return false;
  }

  // Which way next from b, having come from a: not back unless there is no
  // other way, and not into a closed street if there is an open one.
  chooseNext(a, b) {
    const opts = this.nodes[b].next;
    let open = 0, any = 0;
    for (const c of opts) {
      if (c === a) continue;
      any++;
      if (!this.blocked(b, c)) open++;
    }
    const pickFrom = (wantOpen, count) => {
      let k = this.rng.int(0, count - 1);
      for (const c of opts) {
        if (c === a || (wantOpen && this.blocked(b, c))) continue;
        if (k-- === 0) return c;
      }
      return a;
    };
    if (open) return pickFrom(true, open);
    if (!this.blocked(b, a)) return a;
    return any ? pickFrom(false, any) : a;
  }

  // Is the light green for a vehicle going a->b into b?
  green(a, b) {
    const n = this.nodes[b];
    const along = n.z === this.nodes[a].z;   // travelling along x
    const t = (this.time + n.phase) % CYCLE;
    return along ? t < CYCLE / 2 - 1.5 : t >= CYCLE / 2 && t < CYCLE - 1.5;
  }

  uturn(v) {
    const s = this.edgeLen(v.a, v.b) - v.s;
    const a = v.a;
    v.a = v.b;
    v.b = a;
    v.s = Math.max(this.clear(), Math.min(s, this.edgeLen(v.a, v.b) - this.clear()));
    v.turn = false;
    v.v *= 0.3;
    v.hold = 0;
  }

  // Start the curve through junction b onto b->c.
  startTurn(v, c) {
    const len = this.edgeLen(v.a, v.b);
    const e = this.lanePoint(v.a, v.b, len - this.clear(), _p);
    v.t0x = e[0]; v.t0z = e[1];
    const ex = e[2], ez = e[3];
    const n = this.lanePoint(v.b, c, this.clear(), _q);
    v.t2x = n[0]; v.t2z = n[1];
    if (Math.abs(ex * n[2] + ez * n[3]) > 0.9) {
      // Straight on, or back the way it came: the middle of the two ends.
      v.t1x = (v.t0x + v.t2x) / 2;
      v.t1z = (v.t0z + v.t2z) / 2;
      if (ex * n[2] + ez * n[3] < 0) {   // a U-turn swings out through the junction
        const nb = this.nodes[v.b];
        v.t1x = nb.x + ex * 4;
        v.t1z = nb.z + ez * 4;
      }
    } else {
      // A corner: where the two lanes would meet.
      v.t1x = Math.abs(ex) > 0.5 ? v.t2x : v.t0x;
      v.t1z = Math.abs(ex) > 0.5 ? v.t0z : v.t2z;
    }
    v.tlen = Math.max(2, Math.hypot(v.t1x - v.t0x, v.t1z - v.t0z) + Math.hypot(v.t2x - v.t1x, v.t2z - v.t1z));
    v.tu = 0;
    v.tnext = c;
    v.turn = true;
  }

  // A blast at x/y/z: wreck what it reaches, send the rest away.
  afterBlast(x, y, z, radius) {
    for (const v of this.vehicles) {
      if (!v.alive) continue;
      const d = Math.hypot(v.x - x, v.y - y, v.z - z);
      if (d < radius * 1.3 + v.len / 2) {
        v.alive = false;
        v.mode = 'wreck';
        v.flipped = d < radius * 0.9 || this.rng.next() < 0.5;
        v.burn = WRECK_TTL * this.rng.range(0.7, 1.1);
        v.v = 0;
        v.heading += this.rng.range(-0.8, 0.8);
        continue;
      }
      if (d < radius + 70) {
        v.mode = 'flee';
        v.flee = this.rng.range(5, 9);
        const fx = Math.cos(v.heading), fz = Math.sin(v.heading);
        const towards = (fx * (x - v.x) + fz * (z - v.z)) / Math.max(1, Math.hypot(x - v.x, z - v.z));
        if (towards > 0.3 && !v.turn) this.uturn(v);
      }
    }
    // A street the blast closed turns back whoever is driving into it.
    for (const v of this.vehicles) {
      if (v.alive && !v.turn && v.mode !== 'flee' && this.blocked(v.a, v.b)) {
        const n = this.nodes[v.b];
        if (Math.hypot(n.x - x, n.z - z) < Math.hypot(v.x - x, v.z - z) + 4) this.uturn(v);
      }
    }
  }

  // Called every frame with the tanks (core/game.js update).
  update(dt, tanks = []) {
    if (dt <= 0) return;
    this.time += dt;
    for (const v of this.vehicles) {
      if (!v.alive) {
        if (v.burn > 0) v.burn = Math.max(0, v.burn - dt);
        continue;
      }
      if (v.flee > 0 && (v.flee -= dt) <= 0) v.mode = 'drive';
      let want = v.cruise * (v.mode === 'flee' ? 1.6 : 1);
      const fx = Math.cos(v.heading), fz = Math.sin(v.heading);
      // Hold back behind whatever is ahead: another vehicle in this lane, or a tank.
      let room = Infinity;
      let stuck = false;   // held up by a tank or a wreck, which won't move on
      for (const o of this.vehicles) {
        if (o === v || v.ghost > 0) continue;
        const dx = o.x - v.x, dz = o.z - v.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0 || ahead > 30) continue;
        const side = Math.abs(dx * fz - dz * fx);
        if (side > 1.6) continue;
        const r = ahead - (v.len + o.len) / 2 - GAP;
        if (r < room) { room = r; stuck = !o.alive; }
      }
      for (const k of tanks) {
        if (k.alive === false) continue;
        const dx = k.x - v.x, dz = k.z - v.z;
        const ahead = dx * fx + dz * fz;
        if (ahead <= 0 || ahead > 26) continue;
        if (Math.abs(dx * fz - dz * fx) > 5.5) continue;
        const r = ahead - v.len / 2 - 7;
        if (r < room) { room = r; stuck = true; }
      }
      // Red light: stop at the line, unless already over it or running away.
      if (!v.turn && v.mode !== 'flee') {
        const line = this.edgeLen(v.a, v.b) - this.clear() - 1 - v.len / 2;
        if (v.s < line + 0.5 && !this.green(v.a, v.b)) room = Math.min(room, line - v.s);
      }
      if (room < Infinity) want = Math.min(want, Math.max(0, room) * 1.2);
      // A tank or a wreck in the lane: give up after a while and turn back.
      // Held up by other traffic for long (two turning across each other),
      // edge through it.
      if (v.ghost > 0) v.ghost -= dt;
      if (v.v < 0.5 && room < 4 && want < 0.5 && (stuck || v.turn || this.green(v.a, v.b))) {
        v.hold += dt;
        if (stuck && v.hold > 4 && !v.turn) this.uturn(v);
        else if (!stuck && v.hold > 7) { v.ghost = 2.5; v.hold = 0; }
      } else if (room > 10) v.hold = 0;
      const accel = want > v.v ? 4 : 9;
      v.v += Math.max(-accel * dt, Math.min(accel * dt, want - v.v));
      const step = v.v * dt;
      if (v.turn) {
        v.tu += step / v.tlen;
        if (v.tu >= 1) {
          v.a = v.b;
          v.b = v.tnext;
          v.s = this.clear() + (v.tu - 1) * v.tlen;
          v.turn = false;
        }
      } else {
        v.s += step;
        const end = this.edgeLen(v.a, v.b) - this.clear();
        if (v.s >= end) this.startTurn(v, this.chooseNext(v.a, v.b));
      }
      this.place(v);
    }
  }
}

const _p = [0, 0, 0, 0];
const _q = [0, 0, 0, 0];
