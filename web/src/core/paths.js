import { makePerlin } from './noise.js';

// Gravel roads between the hamlets, a track from each hamlet down to the water
// or the bridge, and a short path from every door to the middle of its hamlet.
//
// Routes are found on a coarse grid laid over the heightfield: a step costs
// more the steeper it is, cannot be steeper than `maxGrade`, and may not touch
// water, a house or the ground around a tank's starting pad. A slow noise
// makes some ground a little dearer than other ground, which is what bends
// the roads. Later routes get a discount on ground an earlier one already
// uses, so they join it instead of running alongside.
//
// The result is plain data, [{ kind, width, points: [[x, z], ...] }]; the
// renderer paints it onto the ground and the scenery keeps plants off it.

export const PATH = {
  cell: 8,            // metres between route nodes
  edge: 14,           // nothing this close to the rim of the field
  maxGrade: 0.38,     // rise over run between two nodes
  keepTank: 24,
  keepHouse: 7,
  shore: 2.4,         // a node this little above the water counts as the bank
  reach: 520,         // how much route cost a hamlet will spend to get to water
  width: { road: 3.2, track: 2.0, spur: 1.5 },
};

function distToSegment(px, pz, a, b) {
  const dx = b[0] - a[0];
  const dz = b[1] - a[1];
  const t = Math.max(0, Math.min(1, ((px - a[0]) * dx + (pz - a[1]) * dz) / (dx * dx + dz * dz || 1)));
  return Math.hypot(px - (a[0] + dx * t), pz - (a[1] + dz * t));
}

// Corner cutting: every corner becomes two points a quarter of the way along
// its sides. The ends stay where they are.
function soften(points, passes = 2) {
  let pts = points;
  for (let k = 0; k < passes && pts.length > 2; k++) {
    const out = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, az] = pts[i];
      const [bx, bz] = pts[i + 1];
      if (i > 0) out.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25]);
      if (i < pts.length - 2) out.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75]);
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return pts;
}

// How far (x, z) is from the edge of the nearest path; negative when on one.
export function distToPaths(paths, x, z) {
  let best = Infinity;
  for (const p of paths) {
    const half = p.width / 2;
    const b = p.box;
    if (b && (x < b[0] - best - half || x > b[2] + best + half || z < b[1] - best - half || z > b[3] + best + half)) continue;
    for (let i = 0; i < p.points.length - 1; i++) {
      const d = distToSegment(x, z, p.points[i], p.points[i + 1]) - half;
      if (d < best) best = d;
    }
  }
  return best;
}

function makePath(kind, points) {
  const box = [Infinity, Infinity, -Infinity, -Infinity];
  for (const [x, z] of points) {
    box[0] = Math.min(box[0], x); box[1] = Math.min(box[1], z);
    box[2] = Math.max(box[2], x); box[3] = Math.max(box[3], z);
  }
  return { kind, width: PATH.width[kind], points, box };
}

export function planPaths({ terrain: t, hamlets = [], houses = [], bridge = null, tanks = [], seed = 1 }) {
  const paths = [];
  if (!hamlets.length) return paths;
  const cell = PATH.cell;
  const n = Math.floor((t.size - PATH.edge * 2) / cell) + 1;
  const gx = (i) => -t.half + PATH.edge + i * cell;
  const water = t.waterLevel;
  const wander = makePerlin(seed * 17 + 5);
  const h = new Float32Array(n * n);
  const toll = new Float32Array(n * n);
  const shut = new Uint8Array(n * n);
  const used = new Uint8Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const x = gx(i);
      const z = gx(j);
      h[k] = t.heightAt(x, z);
      toll[k] = 1.4 + 0.9 * wander(x * 0.016, z * 0.016);
      shut[k] = h[k] < water + 0.8
        || tanks.some((p) => Math.hypot(p.x - x, p.z - z) < PATH.keepTank)
        || houses.some((p) => Math.hypot(p.x - x, p.z - z) < PATH.keepHouse + Math.max(0, (p.reach ?? 4.6) - 4.6)) ? 1 : 0;
    }
  }

  // The open node nearest to a point, looking a few rings out.
  const nodeNear = (x, z) => {
    const ci = Math.round((x + t.half - PATH.edge) / cell);
    const cj = Math.round((z + t.half - PATH.edge) / cell);
    let best = -1;
    let bestD = Infinity;
    for (let j = cj - 3; j <= cj + 3; j++) {
      for (let i = ci - 3; i <= ci + 3; i++) {
        if (i < 0 || j < 0 || i >= n || j >= n || shut[j * n + i]) continue;
        const d = Math.hypot(gx(i) - x, gx(j) - z);
        if (d < bestD) { bestD = d; best = j * n + i; }
      }
    }
    return best;
  };

  const span = bridge && bridge.alive !== false ? { a: nodeNear(...bridge.a), b: nodeNear(...bridge.b), len: Math.hypot(bridge.b[0] - bridge.a[0], bridge.b[1] - bridge.a[1]) } : null;
  const overBridge = (a, b) => span && span.a >= 0 && span.b >= 0 && ((a === span.a && b === span.b) || (a === span.b && b === span.a));

  // Cheapest route from `start` to the first node `isGoal` accepts. With a
  // `toward` node it is A*, without one it spreads evenly (nearest goal wins).
  const route = (start, isGoal, toward = -1, limit = Infinity) => {
    const cost = new Float32Array(n * n).fill(Infinity);
    const from = new Int32Array(n * n).fill(-1);
    const done = new Uint8Array(n * n);
    const guess = (k) => (toward < 0 ? 0 : Math.hypot((k % n) - (toward % n), Math.floor(k / n) - Math.floor(toward / n)) * cell * 0.3);
    const heap = [[guess(start), start]];
    cost[start] = 0;
    const push = (item) => {
      heap.push(item);
      for (let c = heap.length - 1; c > 0;) {
        const p = (c - 1) >> 1;
        if (heap[p][0] <= heap[c][0]) break;
        [heap[p], heap[c]] = [heap[c], heap[p]];
        c = p;
      }
    };
    const pop = () => {
      const top = heap[0];
      const last = heap.pop();
      if (heap.length) {
        heap[0] = last;
        for (let p = 0; ;) {
          let c = p * 2 + 1;
          if (c >= heap.length) break;
          if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++;
          if (heap[p][0] <= heap[c][0]) break;
          [heap[p], heap[c]] = [heap[c], heap[p]];
          p = c;
        }
      }
      return top;
    };
    const relax = (a, b, step) => {
      const c = cost[a] + step;
      if (c < cost[b] && c <= limit) { cost[b] = c; from[b] = a; push([c + guess(b), b]); }
    };
    while (heap.length) {
      const [, a] = pop();
      if (done[a]) continue;
      done[a] = 1;
      if (a !== start && isGoal(a)) {
        const nodes = [];
        for (let k = a; k >= 0; k = from[k]) nodes.push(k);
        return nodes.reverse();
      }
      const ai = a % n;
      const aj = Math.floor(a / n);
      for (let dj = -1; dj <= 1; dj++) {
        for (let di = -1; di <= 1; di++) {
          const i = ai + di;
          const j = aj + dj;
          if ((!di && !dj) || i < 0 || j < 0 || i >= n || j >= n) continue;
          const b = j * n + i;
          if (shut[b] || done[b]) continue;
          // A diagonal may not squeeze between two closed corners.
          if (di && dj && (shut[aj * n + i] || shut[j * n + ai])) continue;
          const run = cell * (di && dj ? Math.SQRT2 : 1);
          const grade = Math.abs(h[b] - h[a]) / run;
          if (grade > PATH.maxGrade) continue;
          relax(a, b, run * (1 + 30 * grade * grade) * ((toll[a] + toll[b]) / 2) * (used[b] ? 0.45 : 1));
        }
      }
      if (span && a === span.a && span.b >= 0 && !done[span.b]) relax(a, span.b, span.len * 0.6);
      if (span && a === span.b && span.a >= 0 && !done[span.a]) relax(a, span.a, span.len * 0.6);
    }
    return null;
  };

  // Turn a node route into one or more smoothed paths (a bridge splits it).
  const lay = (kind, nodes, head, tail) => {
    let run = head ? [head] : [];
    const flush = () => {
      if (run.length > 1) paths.push(makePath(kind, soften(run)));
      run = [];
    };
    nodes.forEach((k, idx) => {
      used[k] = 1;
      run.push([gx(k % n), gx(Math.floor(k / n))]);
      if (idx < nodes.length - 1 && overBridge(k, nodes[idx + 1])) {
        const [near, far] = k === span.a ? [bridge.a, bridge.b] : [bridge.b, bridge.a];
        run.push([...near]);
        flush();
        run.push([...far]);
      }
    });
    if (tail) run.push(tail);
    flush();
  };

  // Roads: join the hamlets up as a tree, nearest first.
  const homes = hamlets.map((m) => ({ ...m, node: nodeNear(m.x, m.z) })).filter((m) => m.node >= 0);
  const joined = homes.slice(0, 1);
  const waiting = homes.slice(1);
  while (waiting.length) {
    let pick = null;
    for (const w of waiting) {
      for (const j of joined) {
        const d = Math.hypot(w.x - j.x, w.z - j.z);
        if (!pick || d < pick.d) pick = { w, j, d };
      }
    }
    waiting.splice(waiting.indexOf(pick.w), 1);
    joined.push(pick.w);
    const nodes = route(pick.j.node, (k) => k === pick.w.node, pick.w.node);
    if (nodes) lay('road', nodes, [pick.j.x, pick.j.z], [pick.w.x, pick.w.z]);
  }

  // Tracks: from each hamlet to the bank or the bridge, whichever is nearer.
  if (water > -Infinity) {
    const bank = (k) => h[k] < water + PATH.shore || (span && (k === span.a || k === span.b));
    for (const m of homes) {
      if (bank(m.node)) continue;
      const nodes = route(m.node, bank, -1, PATH.reach);
      if (!nodes || nodes.length < 3 || nodes.every((k) => used[k])) continue;
      const end = nodes[nodes.length - 1];
      const tail = span && end === span.a ? [...bridge.a] : span && end === span.b ? [...bridge.b] : null;
      lay('track', nodes, [m.x, m.z], tail);
    }
  }

  // Spurs: each door to the middle of its hamlet, if nothing is in the way.
  for (const house of houses) {
    if (house.kind && house.kind !== 'house') continue;   // barns, silos and towers have no front path
    const m = hamlets.find((q) => Math.hypot(q.x - house.x, q.z - house.z) < 32);
    if (!m) continue;
    const d = Math.hypot(m.x - house.x, m.z - house.z) || 1;
    const door = [house.x + ((m.x - house.x) / d) * 4.2, house.z + ((m.z - house.z) / d) * 4.2];
    if (d < 6 || houses.some((o) => o !== house && distToSegment(o.x, o.z, door, [m.x, m.z]) < 5.5)) continue;
    paths.push(makePath('spur', [door, [m.x, m.z]]));
  }
  return paths;
}
