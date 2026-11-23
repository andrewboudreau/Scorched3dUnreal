import * as THREE from 'three';
import { TANK } from '../core/tank.js';
import { ringTicks, elevTicks, yawText, elevText, yawDir, fadeStep, arcSide, loadDials, saveDials } from '../dialmath.js';

// The angle dials: two thin gauges on your own tank while you aim, so the
// turret's rotation and the barrel's elevation can be read right on the
// tank rather than only on the HUD. Which ticks and numbers they carry, and the
// strings they print, are in src/dialmath.js (tested); this draws them.
//
// Rotation ring: a ring flat on the ground round the tank, hugging the
// terrain a little above it. A tick every 15 degrees (long every 45, with a
// number), a bright amber pointer for where the turret points now, with its
// reading, and a faint pale one for your last shot's turret angle. The numbers
// are the HUD's: 0 is +x and they grow toward +z, to the right of your aim.
//
// Elevation arc: a quarter circle standing in the turret's vertical plane,
// to the side of the barrel the camera is on, 0 (level) to 90 (straight up),
// a tick and number every 15, a bright needle for the barrel now and a faint
// one for the last shot.
//
// Everything is built once. Per frame the arc and its needles are turned and
// moved, the two pointers are re-laid on the ground (a few height lookups),
// and the ring is only re-laid when the tank has moved or the dials have just
// come back. They fade in while you aim and out otherwise; main.js decides when
// (not in the sight, the overview or a kill cam) by passing `p` or null.

const DEG = Math.PI / 180;
const INK = '#ece4d0';       // ticks, numbers: warm paper, like the HUD's text
const SKY = '#bfe2ee';       // the elevation arc's, so its numbers are not taken for the ring's
const AMBER = '#ffb547';     // the current aim: the HUD's accent
const LIFT = 0.45;           // above the ground, so the ring never clips it
const R = 9;                 // ring radius, round a tank whose barrel reaches 5
const BAND = 0.2;            // half the ring's width
const SEGS = 96;             // ring segments
const POINTER_FROM = 5.8;    // pointers start just past the muzzle
const ARC_R = 7.5;           // elevation arc radius, from the turret pivot
const ARC_OFF = 1.9;         // how far beside the barrel's plane it stands
const TILT = 50;             // most the arc's plane turns toward the camera, in degrees
const FADE_IN = 5, FADE_OUT = 4;   // per second
// Numbers keep a steady size on screen, whatever the camera distance.
const LABEL_PX = 19, LIVE_PX = 24;

// A text sprite: pale text with a dark outline, so it reads on sand and grass.
class Label {
  constructor({ w = 128, h = 64, font = 40, color = INK, opacity = 0.9, px = LABEL_PX }) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = w;
    this.canvas.height = h;
    this.ctx = this.canvas.getContext('2d');
    this.ctx.font = `700 ${font}px system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    this.ctx.textAlign = 'center';
    this.ctx.textBaseline = 'middle';
    this.ctx.lineJoin = 'round';
    this.color = color;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.anisotropy = 4;
    this.mat = new THREE.SpriteMaterial({ map: this.tex, transparent: true, depthTest: false, depthWrite: false, opacity: 0 });
    this.sprite = new THREE.Sprite(this.mat);
    this.sprite.renderOrder = 8;
    this.sprite.frustumCulled = false;
    this.opacity = opacity;
    this.px = px;
    this.aspect = w / h;
    this.text = null;
  }

  set(text) {
    if (text === this.text) return;
    this.text = text;
    const { ctx, canvas } = this;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.strokeStyle = 'rgba(12,16,22,0.9)';
    ctx.lineWidth = 9;
    ctx.strokeText(text, canvas.width / 2, canvas.height / 2 + 2);
    ctx.fillStyle = this.color;
    ctx.fillText(text, canvas.width / 2, canvas.height / 2 + 2);
    this.tex.needsUpdate = true;
  }

  // Size for a camera `dist` away, so it stays `px` CSS pixels tall on screen.
  size(dist, tanHalfFov, viewH) {
    const h = Math.min(7, Math.max(1.4, (this.px * 2 * dist * tanHalfFov) / viewH));
    this.sprite.scale.set(h * this.aspect, h, 1);
  }
}

// Geometry from quads, for the parts that are built once.
class Mesh {
  constructor() { this.pos = []; this.idx = []; }
  quad(a, b, c, d) {   // corners in order round the quad, each [x, y, z]
    const n = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c, ...d);
    this.idx.push(n, n + 1, n + 2, n, n + 2, n + 3);
  }
  tri(a, b, c) {
    const n = this.pos.length / 3;
    this.pos.push(...a, ...b, ...c);
    this.idx.push(n, n + 1, n + 2);
  }
  geometry() {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setIndex(this.idx);
    return g;
  }
}

const flat = (color, opacity, depthTest = true) => new THREE.MeshBasicMaterial({
  color, transparent: true, opacity: 0, depthWrite: false, depthTest, side: THREE.DoubleSide,
  polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3,
});

// A pointer lying on the ground from the tank outward: a shaft and an
// arrowhead, laid fresh each frame over the terrain's height.
class Pointer {
  constructor(color, half, head) {
    this.half = half;
    this.head = head;
    this.pos = new Float32Array(9 * 3);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 6, 7, 8]);
    this.mat = flat(color, 1);
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
  }

  // Lie along `yaw` from the tank at cx/cz; `ground(x, z)` gives the height.
  lay(yaw, cx, cz, ground) {
    const [dx, dz] = yawDir(yaw);
    const nx = -dz, nz = dx;
    const r = [POINTER_FROM, (POINTER_FROM + R + 0.2) / 2, R + 0.2];
    const P = this.pos;
    for (let s = 0; s < 3; s++) {
      const x = cx + dx * r[s], z = cz + dz * r[s], y = ground(x, z);
      const o = s * 6;
      P[o] = x + nx * this.half; P[o + 1] = y; P[o + 2] = z + nz * this.half;
      P[o + 3] = x - nx * this.half; P[o + 4] = y; P[o + 5] = z - nz * this.half;
    }
    const yb = P[13];
    P[18] = P[12] + nx * (this.head - this.half); P[19] = yb; P[20] = P[14] + nz * (this.head - this.half);
    P[21] = P[15] - nx * (this.head - this.half); P[22] = yb; P[23] = P[17] - nz * (this.head - this.half);
    const tx = cx + dx * (R + 2.3), tz = cz + dz * (R + 2.3);
    P[24] = tx; P[25] = ground(tx, tz); P[26] = tz;
    this.mesh.geometry.attributes.position.needsUpdate = true;
  }
}

// A needle in the arc's plane, pointing along +x (turned by the elevation).
function needle(half, head, color) {
  const m = new Mesh();
  const x0 = 2.4, x1 = ARC_R - 0.2;
  m.quad([x0, -half, 0], [x1, -half, 0], [x1, half, 0], [x0, half, 0]);
  m.tri([x1, -head, 0], [ARC_R + 1.1, 0, 0], [x1, head, 0]);
  const mesh = new THREE.Mesh(m.geometry(), flat(color, 1, false));
  mesh.renderOrder = 7;
  mesh.frustumCulled = false;
  return mesh;
}

export class AngleDials {
  constructor(scene) {
    this.enabled = loadDials();
    this.root = new THREE.Group();
    this.root.visible = false;
    scene.add(this.root);
    this.alpha = 0;
    this.tank = null;
    this.game = null;
    this.key = '';
    this.side = 1;          // which side of the barrel the arc stands on
    this.sideNow = 1;       // eased toward it
    this.tiltNow = 0;       // how far the arc's plane is turned toward the camera, degrees
    this.lastText = '';

    // The ring: SEGS band pieces (a quad each, so a gap in an isle's edge can
    // drop one) then a quad per tick.
    this.ticks = ringTicks();
    const quads = SEGS + this.ticks.length;
    this.ringPos = new Float32Array(quads * 4 * 3);
    const ig = [];
    for (let q = 0; q < quads; q++) ig.push(q * 4, q * 4 + 1, q * 4 + 2, q * 4, q * 4 + 2, q * 4 + 3);
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.BufferAttribute(this.ringPos, 3));
    rg.setIndex(ig);
    this.ringMat = flat(INK, 1);
    this.ring = new THREE.Mesh(rg, this.ringMat);
    this.ring.frustumCulled = false;
    this.ring.renderOrder = 4;
    this.root.add(this.ring);
    this.ringNums = this.ticks.filter((t) => t.label).map((t) => {
      const l = new Label({});
      l.set(t.label);
      l.deg = t.deg;
      this.root.add(l.sprite);
      return l;
    });
    this.yaw = new Pointer(AMBER, 0.38, 1.1);
    this.lastYaw = new Pointer('#ffffff', 0.2, 0.62);
    this.root.add(this.lastYaw.mesh, this.yaw.mesh);
    this.yawLive = new Label({ w: 192, h: 64, font: 44, color: AMBER, opacity: 1, px: LIVE_PX });
    this.root.add(this.yawLive.sprite);

    // The arc: in the turret's vertical plane, x along the barrel, y up, z to
    // the right. `arc` sits at the pivot, turned with the turret; `body`
    // inside it slides to the side the camera is on.
    this.arc = new THREE.Group();
    this.body = new THREE.Group();
    this.arc.add(this.body);
    this.root.add(this.arc);
    const m = new Mesh();
    const step = 3;
    for (let a = 0; a < 90; a += step) {
      const c0 = Math.cos(a * DEG), s0 = Math.sin(a * DEG), c1 = Math.cos((a + step) * DEG), s1 = Math.sin((a + step) * DEG);
      m.quad([c0 * (ARC_R - BAND), s0 * (ARC_R - BAND), 0], [c0 * (ARC_R + BAND), s0 * (ARC_R + BAND), 0],
        [c1 * (ARC_R + BAND), s1 * (ARC_R + BAND), 0], [c1 * (ARC_R - BAND), s1 * (ARC_R - BAND), 0]);
    }
    this.elevNums = [];
    for (const t of elevTicks()) {
      const c = Math.cos(t.deg * DEG), s = Math.sin(t.deg * DEG);
      const len = t.major ? 1.7 : 1.0, w = 0.15;
      const r0 = ARC_R - len, r1 = ARC_R + 0.2;
      m.quad([c * r0 - s * w, s * r0 + c * w, 0], [c * r1 - s * w, s * r1 + c * w, 0], [c * r1 + s * w, s * r1 - c * w, 0], [c * r0 + s * w, s * r0 - c * w, 0]);
      if (!t.label) continue;
      const l = new Label({ color: SKY });
      l.set(t.label);
      l.sprite.position.set(c * (ARC_R + 1.7), s * (ARC_R + 1.7), 0);
      this.body.add(l.sprite);
      this.elevNums.push(l);
    }
    this.arcMat = flat(SKY, 1);
    const band = new THREE.Mesh(m.geometry(), this.arcMat);
    band.frustumCulled = false;
    band.renderOrder = 4;
    this.body.add(band);
    this.needle = needle(0.2, 0.6, AMBER);
    this.lastNeedle = needle(0.14, 0.4, '#ffffff');
    this.body.add(this.lastNeedle, this.needle);
    this.elevLive = new Label({ w: 192, h: 64, font: 44, color: AMBER, opacity: 1, px: LIVE_PX });
    this.body.add(this.elevLive.sprite);

    this.labels = [...this.ringNums, this.yawLive, ...this.elevNums, this.elevLive];
    this.mats = [[this.ringMat, 0.5], [this.arcMat, 0.65], [this.yaw.mat, 0.95], [this.lastYaw.mat, 0.8],
      [this.needle.material, 0.95], [this.lastNeedle.material, 0.85]];
    this._ground = (x, z) => this.groundY(x, z, true);
  }

  // The setting (Settings > Graphics > Angle dials), remembered.
  setEnabled(on) {
    this.enabled = !!on;
    saveDials(this.enabled);
  }

  // A new match: nothing to show until someone aims.
  reset() {
    this.alpha = 0;
    this.tank = this.game = null;
    this.root.visible = false;
  }

  // Ground height (a little above) at x/z for the current tank, or its own
  // level where there is open sky (the edge of an isle) when `fill`, else NaN.
  groundY(x, z, fill) {
    const t = this.game.terrain;
    if (t.solidAt(x, z)) return Math.max(t.heightAt(x, z), t.waterLevel ?? -Infinity) + LIFT;
    return fill ? this.tank.y + LIFT : NaN;
  }

  // Lay the ring and its numbers on the ground round the tank.
  layRing(p) {
    const P = this.ringPos;
    const ys = new Float64Array(SEGS + 1);   // rebuilt only when the tank moves
    for (let i = 0; i <= SEGS; i++) {
      const a = (i % SEGS) * (360 / SEGS) * DEG;
      ys[i] = this.groundY(p.x + Math.cos(a) * R, p.z + Math.sin(a) * R, false);
    }
    const put = (o, x, y, z) => { P[o] = x; P[o + 1] = y; P[o + 2] = z; };
    for (let i = 0; i < SEGS; i++) {
      const o = i * 12;
      const y0 = ys[i], y1 = ys[i + 1];
      const a0 = i * (360 / SEGS) * DEG, a1 = (i + 1) * (360 / SEGS) * DEG;
      if (Number.isNaN(y0) || Number.isNaN(y1)) {    // over the void: no piece
        for (let k = 0; k < 4; k++) put(o + k * 3, p.x, p.y, p.z);
        continue;
      }
      const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
      put(o, p.x + c0 * (R - BAND), y0, p.z + s0 * (R - BAND));
      put(o + 3, p.x + c0 * (R + BAND), y0, p.z + s0 * (R + BAND));
      put(o + 6, p.x + c1 * (R + BAND), y1, p.z + s1 * (R + BAND));
      put(o + 9, p.x + c1 * (R - BAND), y1, p.z + s1 * (R - BAND));
    }
    this.ticks.forEach((t, k) => {
      const o = (SEGS + k) * 12;
      const a = t.deg * DEG, c = Math.cos(a), s = Math.sin(a);
      const r0 = R - (t.major ? 1.8 : 1.0), r1 = R + 0.2, w = 0.15;
      const x0 = p.x + c * r0, z0 = p.z + s * r0, x1 = p.x + c * r1, z1 = p.z + s * r1;
      const y0 = this.groundY(x0, z0, false), y1 = this.groundY(x1, z1, false);
      if (Number.isNaN(y0) || Number.isNaN(y1)) { for (let q = 0; q < 4; q++) put(o + q * 3, p.x, p.y, p.z); return; }
      put(o, x0 - s * w, y0, z0 + c * w);
      put(o + 3, x1 - s * w, y1, z1 + c * w);
      put(o + 6, x1 + s * w, y1, z1 - c * w);
      put(o + 9, x0 + s * w, y0, z0 - c * w);
    });
    this.ring.geometry.attributes.position.needsUpdate = true;
    for (const l of this.ringNums) {
      const a = l.deg * DEG;
      const x = p.x + Math.cos(a) * (R + 2.6), z = p.z + Math.sin(a) * (R + 2.6);
      l.sprite.position.set(x, this.groundY(x, z, true) + 1.0, z);
    }
  }

  // Once a frame. `p` is the tank to show the dials on, or null to fade them
  // out; `camera` and `dt` (seconds, real time) drive the sizes and the fade.
  update({ game, p, camera, dt }) {
    const want = !!p && this.enabled;
    if (p && p !== this.tank) { this.tank = p; this.game = game; this.alpha = 0; this.key = ''; this.sideNow = this.side; this.tiltNow = 0; }
    this.alpha = fadeStep(this.alpha, want ? 1 : 0, dt, want ? FADE_IN : FADE_OUT);
    if (this.alpha <= 0 || !this.tank) { this.root.visible = false; return; }
    const tank = this.tank;
    if (!this.root.visible) { this.root.visible = true; this.key = ''; }
    const key = `${tank.x},${tank.y},${tank.z}`;
    if (key !== this.key) { this.key = key; this.layRing(tank); }

    // The pointers and the arc follow the aim.
    this.yaw.lay(tank.yaw, tank.x, tank.z, this._ground);
    const last = tank.ai ? null : tank.shots[tank.shots.length - 1];
    this.lastYaw.mesh.visible = !!last;
    this.lastNeedle.visible = !!last;
    if (last) {
      this.lastYaw.lay(last.yaw, tank.x, tank.z, this._ground);
      this.lastNeedle.rotation.z = last.elev * DEG;
    }
    this.needle.rotation.z = tank.elev * DEG;
    this.arc.position.set(tank.x, tank.y + TANK.turretHeight, tank.z);
    // The camera's side of the barrel (+ is to the right of the aim).
    const [dx, dz] = yawDir(tank.yaw);
    const cross = (camera.position.x - tank.x) * -dz + (camera.position.z - tank.z) * dx;
    this.side = arcSide(this.side, cross);
    const ease = Math.min(1, dt * 8);
    this.sideNow += (this.side - this.sideNow) * ease;
    // Seen from right behind the barrel the arc's plane is edge on and reads as
    // a line, so it turns a little toward the camera (never more than TILT).
    const along = (camera.position.x - tank.x) * dx + (camera.position.z - tank.z) * dz;
    const off = Math.atan2(Math.abs(cross), Math.abs(along)) / DEG;     // 0 edge on at the muzzle line, 90 side on
    const tilt = this.side * Math.max(0, TILT - Math.min(off, 180 - off));
    this.tiltNow += (tilt - this.tiltNow) * ease;
    this.arc.rotation.y = -(tank.yaw + this.tiltNow) * DEG;
    this.body.position.z = this.sideNow * ARC_OFF;

    // The readings, as the HUD prints them, out past the tip of each pointer.
    this.yawLive.set(yawText(tank.yaw));
    // (on the side away from the arc, so the two readings never sit on each other)
    const lx = tank.x + dx * (R + 3.6) + dz * this.sideNow * 4.6, lz = tank.z + dz * (R + 3.6) - dx * this.sideNow * 4.6;
    this.yawLive.sprite.position.set(lx, this.groundY(lx, lz, true) + 1.0, lz);
    this.elevLive.set(elevText(tank.elev));
    const ea = tank.elev * DEG;
    this.elevLive.sprite.position.set(Math.cos(ea) * (ARC_R + 3.6), Math.sin(ea) * (ARC_R + 3.6), 0);

    // Fade, and keep the numbers a steady size on screen.
    for (const [mat, base] of this.mats) mat.opacity = base * this.alpha;
    const dist = Math.hypot(camera.position.x - tank.x, camera.position.y - tank.y, camera.position.z - tank.z);
    const tanHalf = Math.tan((camera.fov * DEG) / 2), viewH = window.innerHeight;
    for (const l of this.labels) { l.mat.opacity = l.opacity * this.alpha; l.size(dist, tanHalf, viewH); }
  }
}
