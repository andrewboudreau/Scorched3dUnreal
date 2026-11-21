import * as THREE from 'three';

// A tank blowing apart: the real turret (barrel and all) and hull, charred,
// thrown away from the blast, plus a few small parts. Not a physics engine:
// each piece is a point with a spin that bounces, skids and tumbles on the
// terrain and then settles flat. The hulk burns and smokes for a while.

const GRAVITY = 9.81 * 1.6;     // the same heavy gravity as the explosion debris
const UP = new THREE.Vector3(0, 1, 0);
const _v = new THREE.Vector3();
const _n = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _qs = new THREE.Quaternion();
const _axis = new THREE.Vector3();
const SOOT = new THREE.Color('#1d1a17');

// Charred copies of a tank's materials, one per original. Same material types
// and features as the live tank, so no new shader is compiled mid-match.
function charred(src, cache) {
  let m = cache.get(src);
  if (!m) {
    m = src.clone();
    m.color.multiplyScalar(src.map ? 0.45 : 0.4).lerp(SOOT, src.map ? 0 : 0.6);
    // Hot metal: a dull orange glow that cools off over the first few seconds.
    m.emissive.set(src.map ? '#000000' : '#ff4a12');
    m.emissiveIntensity = 0;
    m.metalness = 0.1;
    m.roughness = 1;
    cache.set(src, m);
  }
  return m;
}

// A copy of `group` (sharing geometry with the live tank) in charred paint.
function charredCopy(group, cache) {
  const c = group.clone();
  c.traverse((o) => { if (o.isMesh) o.material = charred(o.material, cache); });
  return c;
}

export class Wreck {
  // `tank` is the TankMesh as it stood (its pose is copied), `blast` the
  // explosion that did it ({ pos, radius }) or null, `fx` the Effects.
  constructor(scene, tank, blast, fx, groundAt) {
    this.scene = scene;
    this.fx = fx;
    this.groundAt = groundAt;
    this.group = new THREE.Group();
    this.cache = new Map();
    this.own = [];               // geometry and materials this wreck made (the copies share the tank's)
    this.pieces = [];
    this.time = 0;
    this.burn = 0;
    scene.add(this.group);

    tank.root.updateMatrixWorld(true);
    const at = tank.root.position;
    this.at = at.clone();
    // Away from the blast, flat; a direct hit (or no blast) throws mostly up.
    const away = new THREE.Vector3();
    let push = 0.35;
    if (blast) {
      away.set(at.x - blast.pos[0], 0, at.z - blast.pos[2]);
      const d = away.length();
      push = Math.max(0.25, 1 - d / (blast.radius * 1.25 + 4));
      if (d < 0.5) away.set(0, 0, 0);
    }
    if (away.lengthSq() < 1e-6) away.set(Math.random() - 0.5, 0, Math.random() - 0.5);
    away.normalize();
    const side = new THREE.Vector3(-away.z, 0, away.x);
    const rand = (a, b) => a + Math.random() * (b - a);

    // The hull: heavy. A kick away and up that tips it over away from the blast.
    const hull = charredCopy(tank.hull, this.cache);
    this.add(hull, tank.hull, 1.3, {
      vel: away.clone().multiplyScalar(rand(2, 4) * push).add(_v.set(0, rand(4, 6.5) * (0.6 + push * 0.5), 0)),
      spin: side.clone().multiplyScalar(rand(1.2, 2.2) * (Math.random() < 0.5 ? 1 : -1) * push).add(_v.set(0, rand(-0.6, 0.6), 0)),
      radius: 1.1, bounce: 0.25, heavy: true,
    });

    // The turret: light by comparison and the show piece. Up, away, tumbling.
    const turret = charredCopy(tank.turret, this.cache);
    this.add(turret, tank.turret, 0.2, {
      vel: away.clone().multiplyScalar(rand(7, 11) * push).addScaledVector(side, rand(-3, 3)).add(_v.set(0, rand(13, 17) * (0.7 + push * 0.3), 0)),
      spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(4, 7)),
      radius: 0.9, bounce: 0.35, trail: true,
    });

    // A few small parts flung wider and faster.
    const trim = charred(tank.wheels[0].material, this.cache);
    const box = (w, h, d) => this.mine(new THREE.BoxGeometry(w, h, d));
    const smalls = [
      [this.mine(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 6)), 0.5],   // road wheels
      [this.mine(new THREE.CylinderGeometry(0.5, 0.5, 1.2, 6)), 0.5],
      [this.mine(new THREE.CylinderGeometry(0.42, 0.48, 0.22, 8)), 0.25],   // hatch
      [box(0.7, 0.5, 1.5), 0.35],                                        // stowage box
      [box(1.6, 0.14, 1.1), 0.2],                                        // fender plates
      [box(1.2, 0.14, 0.9), 0.2],
    ];
    for (const [geo, r] of smalls) {
      const m = new THREE.Mesh(geo, trim);
      m.castShadow = true;
      const a = rand(-1.1, 1.1);
      const dir = away.clone().multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      m.position.set(at.x + rand(-1.5, 1.5), at.y + rand(1, 2.2), at.z + rand(-1.5, 1.5));
      m.quaternion.setFromEuler(new THREE.Euler(rand(0, 6), rand(0, 6), rand(0, 6)));
      this.addLoose(m, {
        vel: dir.multiplyScalar(rand(6, 14) * (0.5 + push * 0.5)).add(_v.set(0, rand(8, 15), 0)),
        spin: new THREE.Vector3(rand(-1, 1), rand(-1, 1), rand(-1, 1)).normalize().multiplyScalar(rand(6, 12)),
        radius: r, bounce: 0.3,
      });
    }
  }

  mine(geo) { this.own.push(geo); return geo; }

  // A copy of one of the tank's parts. The piece turns about its middle
  // (`lift` metres above the part's origin), so it gets a pivot there.
  add(copy, part, lift, opt) {
    const pivot = new THREE.Group();
    part.getWorldPosition(pivot.position);
    part.getWorldQuaternion(pivot.quaternion);
    // The copy keeps its local pose under the pivot, minus the lift.
    copy.position.set(0, -lift, 0);
    copy.quaternion.identity();
    copy.scale.set(1, 1, 1);
    pivot.add(copy);
    pivot.position.addScaledVector(_v.set(0, 1, 0).applyQuaternion(pivot.quaternion), lift);
    this.addLoose(pivot, opt);
  }

  addLoose(obj, { vel, spin, radius, bounce, heavy = false, trail = false }) {
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
    this.group.add(obj);
    this.pieces.push({ obj, vel, spin, radius, bounce, heavy, trail, rest: false, landed: false, puff: 0, settle: null });
  }

  update(dt) {
    if (dt <= 0) return;
    this.time += dt;
    const glow = 0.35 * Math.max(0, 1 - this.time / 2.5) ** 2;
    this.cache.forEach((m) => { m.emissiveIntensity = glow; });
    for (const p of this.pieces) if (!p.rest) this.step(p, dt);
    this.smoke(dt);
  }

  step(p, dt) {
    const o = p.obj;
    p.vel.y -= GRAVITY * dt;
    o.position.addScaledVector(p.vel, dt);
    const w = p.spin.length();
    if (w > 1e-4) o.quaternion.premultiply(_q.setFromAxisAngle(_axis.copy(p.spin).divideScalar(w), w * dt));
    const g = this.groundAt(o.position.x, o.position.z);
    if (o.position.y - p.radius <= g) {
      o.position.y = g + p.radius;
      if (!p.landed) {
        p.landed = true;
        if (p.heavy || p.trail) this.fx.dust([o.position.x, g, o.position.z], p.heavy ? 6 : 3.5);
        this.onLand?.(o.position, p.heavy);
      }
      if (p.vel.y < 0) {
        const hit = -p.vel.y;
        p.vel.y = hit > 2 ? hit * p.bounce : 0;
        // Skid: the ground takes speed off and turns some of it into a tumble
        // about the axis across the slide.
        p.vel.x *= 0.62; p.vel.z *= 0.62;
        _axis.set(p.vel.z, 0, -p.vel.x);
        p.spin.multiplyScalar(0.55).addScaledVector(_axis, 0.25 / Math.max(0.3, p.radius));
      }
      // Rolling friction while it stays down.
      const k = Math.exp(-dt * 3);
      p.vel.x *= k; p.vel.z *= k;
      p.spin.multiplyScalar(Math.exp(-dt * 2.5));
      // Slow enough: lie it flat on the ground, top up or bottom up, whichever is closer.
      if (p.vel.lengthSq() < 0.5 && p.spin.lengthSq() < 0.6) {
        if (!p.settle) {
          const [nx, ny, nz] = this.groundNormal(o.position.x, o.position.z);
          _n.set(nx, ny, nz);
          const up = _v.copy(UP).applyQuaternion(o.quaternion);
          const flip = up.dot(_n) < 0 ? -1 : 1;
          _qs.setFromUnitVectors(up, _n.multiplyScalar(flip));
          p.settle = { to: _qs.clone().multiply(o.quaternion), t: 0 };
          p.vel.set(0, 0, 0);
          p.spin.set(0, 0, 0);
        }
        p.settle.t += dt;
        o.quaternion.slerp(p.settle.to, Math.min(1, dt * 6));
        if (p.settle.t > 0.8) { o.quaternion.copy(p.settle.to); p.rest = true; }
      }
    }
  }

  groundNormal(x, z) {
    const e = 1.5;
    const hx = this.groundAt(x + e, z) - this.groundAt(x - e, z);
    const hz = this.groundAt(x, z + e) - this.groundAt(x, z - e);
    const n = _v.set(-hx, 2 * e, -hz).normalize();
    return [n.x, n.y, n.z];
  }

  // Fire and smoke from the hulk for a few seconds, a trail off the flying turret.
  smoke(dt) {
    const hull = this.pieces[0].obj.position;
    const t = this.time;
    if (t < 9 && (this.burn -= dt) <= 0) {
      const k = Math.max(0, 1 - t / 9);
      this.burn = 0.12 + (1 - k) * 0.3;
      this.fx.puff({ x: hull.x + (Math.random() - 0.5) * 2, y: hull.y + 1, z: hull.z + (Math.random() - 0.5) * 2 },
        { color: '#2a2725', size: 1.8 + k * 1.2, life: 2.8, rise: 4, opacity: 0.45 * (0.4 + k * 0.6) });
      if (t < 4 && Math.random() < 0.7) {
        this.fx.puff({ x: hull.x + (Math.random() - 0.5) * 1.5, y: hull.y + 0.8, z: hull.z + (Math.random() - 0.5) * 1.5 },
          { color: '#ff8a3a', size: 1.2 + k, life: 0.5, rise: 3, opacity: 0.85 * k });
      }
    }
    for (const p of this.pieces) {
      if (!p.trail || p.landed || (p.puff -= dt) > 0) continue;
      p.puff = 0.035;
      const q = p.obj.position;
      this.fx.puff({ x: q.x, y: q.y, z: q.z }, { color: '#3a3532', size: 1.1, life: 1.4, rise: 0.6, opacity: 0.55 });
    }
  }

  dispose() {
    this.scene.remove(this.group);
    this.own.forEach((g) => g.dispose());
    this.cache.forEach((m) => m.dispose());
  }
}
