import * as THREE from 'three';
import { seaMaterial } from './sceneryMesh.js';

// The arena's boundary, drawn: the curtains of the Edges rule and the
// Island's open sea.
//
// - Edges (core/ballistics.js crossEdge): with Wall, Bounce or Wrap, a faint
//   curtain of light stands along each side of the field, gridded and
//   shimmering, a different tint and pulse for each rule (amber and slow for
//   Wall, cyan with rising bands for Bounce, violet with bands that run along
//   it for Wrap). Open draws nothing. A shell that bounces leaves a flash on
//   the curtain; one that wraps leaves a ripple where it went out and another
//   where it came in.
// - The Island (core/island.js): the sea runs on past the field to the
//   horizon, and a shell or tank that goes into it throws up a splash.
//
// One per page (main.js): `update` each frame follows the game's round (the
// edge rule and the world), `event` takes the game's events, `clear` drops
// what is in flight at a match's end.

const TINT = { wall: '#ffb347', bounce: '#5fe0ff', wrap: '#c48bff' };
const MODE = { wall: 0, bounce: 1, wrap: 2 };
const LOW = -60;          // the curtains run from here...
const HIGH = 340;         // ...up to here, fading out towards the top (the rule itself has no top)

const curtainVert = /* glsl */ `
  varying vec3 vW;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vW = w.xyz;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;
const curtainFrag = /* glsl */ `
  uniform vec3 uColor;
  uniform float uTime;
  uniform float uMode;
  uniform float uAlong;     // 0: the curtain runs along x, 1: along z
  uniform float uHalf;      // the field's half-width: where a curtain ends, at a corner
  uniform float uBase;      // the waterline (the Island's sea), or a huge negative for none
  varying vec3 vW;
  void main() {
    float s = mix(vW.x, vW.z, uAlong);
    float y = vW.y;
    vec2 c = vec2(s, y) / 16.0;
    vec2 g = abs(fract(c - 0.5) - 0.5) / max(fwidth(c), vec2(1e-4));
    float grid = 1.0 - min(min(g.x, g.y), 1.0);
    float glow;
    if (uMode < 0.5) {
      // Wall: a slow, steady breath (amber reads weaker than cyan on the sky).
      glow = 1.15 + 0.35 * sin(uTime * 1.3);
    } else if (uMode < 1.5) {
      // Bounce: bright bands that rise up it.
      glow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin(y * 0.09 - uTime * 3.2), 6.0);
    } else {
      // Wrap: slanted bands that run along it.
      glow = 0.35 + 0.65 * pow(0.5 + 0.5 * sin((s + y * 0.6) * 0.06 - uTime * 2.4), 5.0);
    }
    float shimmer = 0.85 + 0.15 * sin(s * 0.37 + uTime * 5.0) * sin(y * 0.23 - uTime * 3.0);
    float fade = smoothstep(${HIGH.toFixed(1)}, ${(HIGH * 0.35).toFixed(1)}, y);
    float a = (grid * 0.24 + 0.04) * glow * shimmer * fade;
    // The edge itself: a bright line up each corner and, over the Island's sea, along the waterline, so the
    // boundary reads as a place from far off and not only as a faint grid. They keep a pixel's width at any
    // distance (the width follows fwidth), so they do not fade out as the camera pulls back.
    bool sea = uBase > -9000.0;
    float lat = max(uHalf - abs(s), 0.0);
    float post = exp(-lat / max(2.5, fwidth(s) * 1.6));
    float band = sea ? exp(-abs(y - uBase) / max(1.6, fwidth(y) * 1.6)) : 0.0;
    float rim = max(post * 0.85, band);
    float rimA = rim * 0.5 * fade * (0.85 + 0.15 * sin(uTime * 2.0 + s * 0.04));
    // ...and a low swell of colour at the foot of the wall, thinning out upwards.
    float foot = 0.06 * smoothstep(110.0, 0.0, y - (sea ? uBase : 0.0)) * step(-0.5, y - (sea ? uBase : -1.0e4));
    if (uMode < 0.5) {
      // Wall is drawn with ordinary blending, not added light: amber added to a
      // bright sky only whitens it. The lines carry more weight to make up for it.
      gl_FragColor = vec4(uColor * (0.82 + grid * 0.18 + rim * 0.25), min(0.7, a * 1.9 + rimA + foot * 1.5));
    } else {
      gl_FragColor = vec4(mix(uColor, vec3(1.0), rim * 0.25) * (0.7 + grid * 0.6 + rim * 0.9), a + rimA * 1.15 + foot);   // the edge lines run toward white so violet still shows on a blue sea
    }
  }
`;

export class ArenaView {
  // `effects` (render/effects.js) for spray, `sound` (audio.js) and
  // `camDist(pos)` for how loud.
  constructor(scene, { effects = null, sound = null, camDist = () => 0 } = {}) {
    this.scene = scene;
    this.effects = effects;
    this.sound = sound;
    this.camDist = camDist;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.uniforms = { uColor: { value: new THREE.Color() }, uTime: { value: 0 }, uMode: { value: 0 }, uHalf: { value: 1 }, uBase: { value: -1e4 } };
    this.curtains = [];
    for (let k = 0; k < 4; k++) {
      const mat = new THREE.ShaderMaterial({
        uniforms: { ...this.uniforms, uAlong: { value: k < 2 ? 0 : 1 } },
        vertexShader: curtainVert,
        fragmentShader: curtainFrag,
        transparent: true,
        depthWrite: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
      });
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, HIGH - LOW), mat);
      m.frustumCulled = false;
      m.renderOrder = 4;
      this.curtains.push(m);
      this.group.add(m);
    }
    this.rule = 'open';
    this.half = 0;
    this.sea = null;      // the outer sea's mesh, while the world is the Island
    this.seaKey = '';
    this.fx = [];         // flashes, ripples and splashes in flight: { obj, t, max, step }
    this.ringGeo = new THREE.RingGeometry(0.82, 1, 48);
    this.discGeo = new THREE.CircleGeometry(1, 32);
    this.columnGeo = new THREE.CylinderGeometry(0.35, 1, 1, 16, 1, true).translate(0, 0.5, 0);
    this.setRule('open', 0);
  }

  setRule(rule, half) {
    this.rule = rule;
    this.half = half;
    const on = rule in MODE;
    for (const c of this.curtains) { c.visible = on; c.material.blending = rule === 'wall' ? THREE.NormalBlending : THREE.AdditiveBlending; }
    if (!on) return;
    this.uniforms.uColor.value.set(TINT[rule]);
    this.uniforms.uMode.value = MODE[rule];
    this.uniforms.uHalf.value = half;
    const w = half * 2;
    const mid = (LOW + HIGH) / 2;
    // Two along x (at z = -half and +half), two along z (at x = -half and +half).
    [[0, mid, -half, 0], [0, mid, half, 0], [-half, mid, 0, Math.PI / 2], [half, mid, 0, Math.PI / 2]].forEach(([x, y, z, ry], k) => {
      const c = this.curtains[k];
      c.position.set(x, y, z);
      c.rotation.set(0, ry, 0);
      c.scale.set(w, 1, 1);
    });
  }

  // The open sea round the Island: a wide sheet at the sea's level with the
  // field cut out of it (the field's own water fills that).
  setSea(level, half) {
    const key = level == null ? '' : `${level},${half}`;
    if (key === this.seaKey) return;
    this.seaKey = key;
    if (this.sea) { this.group.remove(this.sea); this.sea.geometry.dispose(); this.sea = null; }   // (its material is the field's own water, shared: not ours to dispose)
    if (level == null) return;
    const R = 6000;
    const shape = new THREE.Shape([new THREE.Vector2(-R, -R), new THREE.Vector2(R, -R), new THREE.Vector2(R, R), new THREE.Vector2(-R, R)]);
    shape.holes.push(new THREE.Path([new THREE.Vector2(-half, -half), new THREE.Vector2(-half, half), new THREE.Vector2(half, half), new THREE.Vector2(half, -half)]));
    const geo = new THREE.ShapeGeometry(shape).rotateX(-Math.PI / 2);
    this.sea = new THREE.Mesh(geo, seaMaterial());
    this.sea.position.y = level;
    this.sea.receiveShadow = true;
    this.group.add(this.sea);
  }

  update(game, time, dt) {
    const t = game?.terrain;
    const rule = game ? game.edge || 'open' : 'open';
    if (rule !== this.rule || (t && t.half !== this.half)) this.setRule(rule, t ? t.half : 0);
    this.setSea(t && t.sea != null ? t.sea : null, t ? t.half : 0);
    this.uniforms.uBase.value = t && t.sea != null ? t.sea : -1e4;
    this.uniforms.uTime.value = time;
    for (let i = this.fx.length - 1; i >= 0; i--) {
      const f = this.fx[i];
      f.t += dt;
      const k = Math.min(1, f.t / f.max);
      f.step(k);
      if (k >= 1) { this.group.remove(f.obj); f.obj.material.dispose(); this.fx.splice(i, 1); }
    }
  }

  event(e) {
    if (e.type === 'edge') {
      if (e.kind === 'bounce') {
        this.flash(e.pos, TINT.bounce, 9, 0.5);
        this.flash(e.pos, '#ffffff', 3.5, 0.25, true);
        this.ring(e.pos, TINT.bounce, 3, 14, 0.6);
        this.ping(e.pos, 1900);
      } else if (e.kind === 'wrap') {
        for (const [p, delay] of [[e.pos, 0], [e.to, 0.08]]) {
          this.ring(p, TINT.wrap, 2, 16, 0.9, delay);
          this.ring(p, TINT.wrap, 1, 10, 0.7, delay + 0.18);
          this.flash(p, TINT.wrap, 6, 0.45, false, delay);
        }
        this.ping(e.pos, 700);
      } else if (e.kind === 'wall') {
        this.flash(e.pos, TINT.wall, 12, 0.6);
        this.ring(e.pos, TINT.wall, 4, 20, 0.7);
      }
    } else if (e.type === 'impact' && e.splash) this.splash(e.pos, 1);
    else if (e.type === 'void' && e.sea) this.splash([e.pos[0], this.sea ? this.sea.position.y : e.pos[1], e.pos[2]], 2.2);
  }

  // The wall a point sits on: which way its curtain faces.
  facing(obj, pos) {
    const alongZ = Math.abs(Math.abs(pos[0]) - this.half) < Math.abs(Math.abs(pos[2]) - this.half);
    obj.rotation.set(0, alongZ ? Math.PI / 2 : 0, 0);
  }

  add(obj, max, step, delay = 0) {
    obj.visible = delay <= 0;
    const f = { obj, t: -delay, max, step: (k) => { if (f.t < 0) return; obj.visible = true; step(k); } };
    this.fx.push(f);
    this.group.add(obj);
  }

  flash(pos, color, size, max, hot = false, delay = 0) {
    const m = new THREE.Mesh(this.discGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.set(...pos);
    this.facing(m, pos);
    m.renderOrder = 6;
    this.add(m, max, (k) => {
      m.scale.setScalar(size * (hot ? 1 - 0.5 * k : 0.6 + 0.8 * k));
      m.material.opacity = (hot ? 1 : 0.7) * (1 - k) ** 1.5;
    }, delay);
  }

  ring(pos, color, from, to, max, delay = 0) {
    const m = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending }));
    m.position.set(...pos);
    this.facing(m, pos);
    m.renderOrder = 6;
    this.add(m, max, (k) => {
      m.scale.setScalar(from + (to - from) * Math.sqrt(k));
      m.material.opacity = 0.9 * (1 - k);
    }, delay);
  }

  // Into the sea: a ring on the water, a column of spray that rises and
  // falls, and a little mist. `big` scales it (a tank going under is bigger).
  splash(pos, big = 1) {
    const [x, y, z] = pos;
    const ring = new THREE.Mesh(this.ringGeo, new THREE.MeshBasicMaterial({ color: '#e8f6fa', transparent: true, opacity: 0.8, depthWrite: false, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, y + 0.15, z);
    this.add(ring, 1.6, (k) => { ring.scale.setScalar(big * (1.5 + 9 * Math.sqrt(k))); ring.material.opacity = 0.8 * (1 - k); });
    const col = new THREE.Mesh(this.columnGeo, new THREE.MeshBasicMaterial({ color: '#f2fbff', transparent: true, opacity: 0.85, depthWrite: false }));
    col.position.set(x, y, z);
    this.add(col, 1.1, (k) => {
      const h = big * 11 * Math.sin(Math.min(1, k * 1.15) * Math.PI);
      col.scale.set(big * (1 + k * 1.6), Math.max(0.01, h), big * (1 + k * 1.6));
      col.material.opacity = 0.85 * (1 - k * k);
    });
    if (this.effects) {
      for (let i = 0; i < 6 * big; i++) {
        const a = (i / (6 * big)) * Math.PI * 2;
        this.effects.puff({ x: x + Math.cos(a) * big * 1.6, y: y + 0.5, z: z + Math.sin(a) * big * 1.6 }, { color: '#eef7fa', size: 1.4 * big, life: 1.2, rise: 3 + 2 * big, opacity: 0.6 });
      }
    }
    const s = this.sound;
    if (s?.burst) {
      const { k, cutoff } = s.far(this.camDist(pos));
      s.burst({ dur: 0.7 * Math.sqrt(big), freq: 1600, sweepTo: 380, q: 0.5, type: 'bandpass', gain: 0.55 * k * Math.min(1.5, big), thump: 55, cutoff });
    }
  }

  ping(pos, freq) {
    const s = this.sound;
    if (!s?.burst) return;
    const { k, cutoff } = s.far(this.camDist(pos));
    s.burst({ dur: 0.35, freq, sweepTo: freq * 1.8, q: 4, type: 'bandpass', gain: 0.35 * k, cutoff });
  }

  // A match ended: nothing left in flight, and no curtains or sea until the next.
  clear() {
    for (const f of this.fx) { this.group.remove(f.obj); f.obj.material.dispose(); }
    this.fx.length = 0;
    this.setRule('open', 0);
    this.setSea(null, 0);
  }
}
