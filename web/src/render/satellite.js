import * as THREE from 'three';
import {
  SURVEY, surveySites, labelledSites, labelShare, surveyConditions, surveyFocus, patchCentre, solveSite, SurveyCache,
} from '../core/survey.js';

// The Survey Satellite, drawn: a small low-poly satellite high over the
// enemy, a projector beam down from it, and the patch of Voronoi cells it
// paints on the ground (thin glowing borders, a radar-like sweep). Some cell
// sites carry a small label, the turret and power that land there from where
// the planner stands (core/survey.js does the placing and solving).
//
// Only for the planner on this screen, during their own aim. main.js passes
// the enemies as this screen believes them (fog of war), never the real ones.

const MAX_SITES = 96;
const LIFT = 0.45;          // m the patch floats over the ground
const SOLVES_PER_FRAME = 3;
const COLOR = new THREE.Color('#72e6ff');

const PATCH_VERT = /* glsl */`
  attribute float solid;
  varying vec3 vWorld;
  varying float vSolid;
  void main() {
    vec4 w = modelMatrix * vec4(position, 1.0);
    vWorld = w.xyz;
    vSolid = solid;
    gl_Position = projectionMatrix * viewMatrix * w;
  }
`;

const PATCH_FRAG = /* glsl */`
  uniform vec3 uSites[${MAX_SITES}];   // x, z, 1 when the site is labelled
  uniform int uCount;
  uniform vec2 uCentre;
  uniform float uRadius;
  uniform float uTime;
  uniform float uFade;
  uniform vec3 uColor;
  varying vec3 vWorld;
  varying float vSolid;
  void main() {
    vec2 p = vWorld.xz;
    vec2 rel = p - uCentre;
    float r = length(rel);
    float rim = 1.0 - smoothstep(uRadius * 0.7, uRadius, r);
    if (rim <= 0.0 || vSolid < 0.5) discard;
    int a = 0;
    float da = 1e9;
    for (int i = 0; i < ${MAX_SITES}; i++) {
      if (i >= uCount) break;
      vec2 q = p - uSites[i].xy;
      float d = dot(q, q);
      if (d < da) { da = d; a = i; }
    }
    vec2 sa = uSites[a].xy;
    // Distance to the nearest cell border: the closest bisector with a neighbour.
    float edge = 1e9;
    for (int i = 0; i < ${MAX_SITES}; i++) {
      if (i >= uCount) break;
      if (i == a) continue;
      vec2 n = uSites[i].xy - sa;
      float L = length(n);
      if (L < 1e-3 || L > ${(SURVEY.spacing * 3).toFixed(1)}) continue;
      edge = min(edge, -dot(p - (sa + uSites[i].xy) * 0.5, n / L));
    }
    float px = max(fwidth(edge), 0.02);
    float line = 1.0 - smoothstep(0.12, 0.12 + max(px * 1.6, 0.22), edge);
    float glow = exp(-edge * 0.55) * 0.22;
    // Site marks: a ring round a labelled site, a dot on the rest.
    float ds = sqrt(da);
    float mark = uSites[a].z > 0.5
      ? 1.0 - smoothstep(0.25, 0.25 + max(px * 1.5, 0.2), abs(ds - 1.8))
      : 1.0 - smoothstep(0.45, 0.45 + max(px * 1.5, 0.2), ds);
    // The scan: a slow sweep round the patch, like a radar, and a faint fill in the labelled cells.
    float ang = atan(rel.y, rel.x) / 6.2831853 + 0.5;
    float scan = pow(fract(ang - uTime * 0.12), 6.0);
    float fill = uSites[a].z > 0.5 ? 0.05 : 0.015;
    float a1 = (line + glow * 0.45 + mark * 0.9 + fill) * (0.6 + 0.6 * scan) * rim * uFade;
    gl_FragColor = vec4(uColor * a1, a1);
  }
`;

const BEAM_VERT = /* glsl */`
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;
const BEAM_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uFade;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    // vUv.y runs from the ground (0) to the projector (1).
    float bands = 0.65 + 0.35 * sin(vUv.y * 60.0 + uTime * 6.0);
    float a = (0.1 + 0.14 * (1.0 - vUv.y)) * bands * uFade;
    gl_FragColor = vec4(uColor * a, a);
  }
`;

// The satellite itself: a foil-wrapped body, two solar wings on struts, a
// projector underneath and a whip antenna. About 20 m across.
function buildSatellite() {
  const g = new THREE.Group();
  // Lit from below as often as above, so each part glows a little and never reads as a black blot.
  const foil = new THREE.MeshStandardMaterial({ color: '#d8b050', emissive: '#5a4310', metalness: 0.4, roughness: 0.45, flatShading: true });
  const frame = new THREE.MeshStandardMaterial({ color: '#c3cad2', emissive: '#3a4048', metalness: 0.3, roughness: 0.5, flatShading: true });
  const cells = new THREE.MeshStandardMaterial({ color: '#2b5cc4', emissive: '#16367a', metalness: 0.2, roughness: 0.35, flatShading: true });
  const lens = new THREE.MeshBasicMaterial({ color: COLOR });
  const body = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 3, 6), foil);
  g.add(body);
  for (const s of [-1, 1]) {
    const strut = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.6, 5).rotateZ(Math.PI / 2), frame);
    strut.position.x = s * 2.2;
    const wing = new THREE.Mesh(new THREE.BoxGeometry(6.5, 0.12, 2.6), cells);
    wing.position.x = s * 6.2;
    // Two thin ribs across each wing, so it reads as panels.
    for (const k of [-1, 1]) {
      const rib = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 2.7), frame);
      rib.position.set(s * 6.2 + k * 1.1, 0, 0);
      g.add(rib);
    }
    g.add(strut, wing);
  }
  const projector = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 1.2, 1.2, 8), frame);
  projector.position.y = -2.1;
  const glass = new THREE.Mesh(new THREE.CircleGeometry(0.9, 12).rotateX(Math.PI / 2), lens);
  glass.position.y = -2.72;
  const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 2.6, 4), frame);
  mast.position.set(0.6, 2.8, 0);
  const tip = new THREE.Mesh(new THREE.SphereGeometry(0.22, 6, 4), lens);
  tip.position.set(0.6, 4.1, 0);
  g.add(projector, glass, mast, tip);
  g.scale.setScalar(2.4);
  return g;
}

const _v = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _down = new THREE.Vector3(0, -1, 0);

export class SatelliteView {
  constructor(scene, labels) {
    this.scene = scene;
    this.labels = labels;     // #labels: cleared at each match start (main.js), so tags are put back
    this.group = new THREE.Group();
    this.group.visible = false;
    scene.add(this.group);

    this.sat = buildSatellite();
    this.group.add(this.sat);

    this.beamMat = new THREE.ShaderMaterial({
      uniforms: { uTime: { value: 0 }, uFade: { value: 0 }, uColor: { value: COLOR } },
      vertexShader: BEAM_VERT, fragmentShader: BEAM_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    });
    // Apex at the origin, base one unit down: scaled to reach the patch.
    this.beam = new THREE.Mesh(new THREE.ConeGeometry(1, 1, 28, 1, true).translate(0, -0.5, 0), this.beamMat);
    this.beam.frustumCulled = false;
    this.group.add(this.beam);

    this.sites = Array.from({ length: MAX_SITES }, () => new THREE.Vector3());
    this.patchMat = new THREE.ShaderMaterial({
      uniforms: {
        uSites: { value: this.sites }, uCount: { value: 0 }, uCentre: { value: new THREE.Vector2() },
        uRadius: { value: SURVEY.radius }, uTime: { value: 0 }, uFade: { value: 0 }, uColor: { value: COLOR },
      },
      vertexShader: PATCH_VERT, fragmentShader: PATCH_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    this.patch = null;        // built for the field's cell size on first use
    this.patchFor = null;

    this.cache = new SurveyCache();
    this.tags = [];
    this.legend = document.createElement('div');
    this.legend.className = 'survey-legend';
    this.fade = 0;
    this.focus = null;        // eased focus { x, z }
    this.lastPatch = '';
    this.active = false;
  }

  hide() {
    this.active = false;
    this.fade = 0;
    this.group.visible = false;
    if (this.patch) this.patch.visible = false;
    for (const t of this.tags) t.el.style.display = 'none';
    this.legend.style.display = 'none';
    this.focus = null;
  }

  // The patch: a grid laid over the field's own vertices, re-draped as it drifts.
  ensurePatch(terrain) {
    if (this.patchFor === terrain && this.patch) return;
    if (this.patch) { this.group.remove(this.patch); this.patch.geometry.dispose(); }
    const span = (SURVEY.radius + 4) * 2;
    const n = Math.ceil(span / terrain.cell);
    const geo = new THREE.PlaneGeometry(n * terrain.cell, n * terrain.cell, n, n).rotateX(-Math.PI / 2);
    geo.setAttribute('solid', new THREE.BufferAttribute(new Float32Array(geo.attributes.position.count), 1));
    this.patch = new THREE.Mesh(geo, this.patchMat);
    this.patch.frustumCulled = false;
    this.patch.renderOrder = 4;
    this.group.add(this.patch);
    this.patchFor = terrain;
    this.lastPatch = '';
  }

  drape(terrain, cx, cz, groundKey) {
    // Snap to the field's grid, so the patch's vertices sit on the ground's.
    const sx = Math.round(cx / terrain.cell) * terrain.cell;
    const sz = Math.round(cz / terrain.cell) * terrain.cell;
    const key = `${sx},${sz},${groundKey}`;
    if (key === this.lastPatch) return;
    this.lastPatch = key;
    this.patch.position.set(sx, 0, sz);
    const pos = this.patch.geometry.attributes.position;
    const solid = this.patch.geometry.attributes.solid;
    const base = this.patch.geometry.userData.base || (this.patch.geometry.userData.base = Float32Array.from(pos.array));
    for (let k = 0; k < pos.count; k++) {
      const x = sx + base[k * 3], z = sz + base[k * 3 + 2];
      const ok = terrain.solidAt(x, z);
      solid.array[k] = ok ? 1 : 0;
      pos.array[k * 3 + 1] = (ok ? Math.max(terrain.heightAt(x, z), terrain.waterLevel) : terrain.bedrock) + LIFT;   // over a lake, on the water
    }
    pos.needsUpdate = true;
    solid.needsUpdate = true;
  }

  // Each frame. `p` is the planner (null: nothing to show), `level` its
  // satellite level, `foes` the enemies as this screen believes them ({ x, z }).
  update({ game, p, level, camera, foes, time, dt, compact }) {
    if (!p || !level) { if (this.active || this.group.visible) this.hide(); return; }
    const t = game.terrain;
    this.active = true;
    this.ensurePatch(t);
    if (!this.legend.isConnected) this.labels.appendChild(this.legend);
    this.fade = Math.min(1, this.fade + dt * 1.6);

    // Where to look: ease toward the focus so a change of target glides over.
    const goal = surveyFocus(p, foes, game.gravity);
    if (!this.focus) this.focus = { x: goal.x, z: goal.z };
    const ease = 1 - Math.exp(-dt * 2.2);
    this.focus.x += (goal.x - this.focus.x) * ease;
    this.focus.z += (goal.z - this.focus.z) * ease;
    const c = patchCentre(this.focus, time);

    // Sites and their solutions. The key holds everything a solution depends on.
    const seed = (game.cfg.seed + game.round * 7919) | 0;
    const sites = surveySites({ cx: c.x, cz: c.z, seed }).sort((a, b) => a.d - b.d).slice(0, MAX_SITES);
    const cond = surveyConditions(level, { wind: game.wind, windK: game.windShare(p), gravity: game.gravity, wells: t.wells });
    const groundKey = `${game.round}.${game.ground?.ops.length || 0}`;
    this.cache.setKey([p.x, p.y, p.z].map((n) => n.toFixed(2)).join() + `|${p.elev.toFixed(1)}|${level}|${cond.wind.join()}|${cond.windK}|${cond.gravity}|${groundKey}`);
    const share = labelShare(game.cfg.lab, level);
    const marked = labelledSites(sites, share, SURVEY.radius + SURVEY.spacing * 0.5);
    this.cache.step(marked, SOLVES_PER_FRAME, (s, guess) => solveSite({
      shooter: p, elev: p.elev, target: [s.x, t.heightAt(s.x, s.z), s.z], cond, terrain: t, guess,
    }));

    // The patch on the ground.
    this.drape(t, c.x, c.z, groundKey);
    const u = this.patchMat.uniforms;
    sites.forEach((s, i) => this.sites[i].set(s.x, s.z, s.roll < share ? 1 : 0));
    u.uCount.value = sites.length;
    u.uCentre.value.set(c.x, c.z);
    u.uTime.value = time;
    u.uFade.value = this.fade;
    this.patch.visible = true;

    // The satellite: high over the focus, a little toward the shooter so the
    // beam leans in, turning slowly; the beam follows the drifting patch.
    const gy = t.solidAt(c.x, c.z) ? t.heightAt(c.x, c.z) : p.y;
    const toMe = Math.atan2(p.z - this.focus.z, p.x - this.focus.x);
    this.sat.position.set(this.focus.x + Math.cos(toMe) * 45, Math.max(gy, p.y) + 150 + Math.sin(time * 0.6) * 2, this.focus.z + Math.sin(toMe) * 45);
    this.sat.rotation.set(0.15 * Math.sin(time * 0.4), time * 0.08, 0.1);
    const apex = _v.copy(this.sat.position);
    apex.y -= 2.72 * this.sat.scale.y;   // the projector's lens
    _dir.set(c.x, gy, c.z).sub(apex);
    const len = _dir.length();
    this.beam.position.copy(apex);
    this.beam.quaternion.setFromUnitVectors(_down, _dir.normalize());
    this.beam.scale.set(SURVEY.radius * 0.8, len, SURVEY.radius * 0.8);
    this.beamMat.uniforms.uTime.value = time;
    this.beamMat.uniforms.uFade.value = this.fade;
    this.group.visible = true;

    this.placeTags({ game, p, level, camera, marked, compact, live: cond.live, foes });
  }

  // The labels: the nearest few to the patch's middle that fit without
  // overlapping, fading with distance from the camera and toward the rim.
  placeTags({ game, p, level, camera, marked, compact, live, foes }) {
    const t = game.terrain;
    const max = compact ? 5 : 8;
    const gapX = compact ? 58 : 72, gapY = compact ? 18 : 22;
    const W = window.innerWidth, H = window.innerHeight;
    // Keep clear of the enemies' own name tags.
    const placed = [];
    for (const f of foes) {
      _v.set(f.x, (f.y ?? 0) + 6, f.z).project(camera);
      if (_v.z <= 1) placed.push([(_v.x * 0.5 + 0.5) * W, (-_v.y * 0.5 + 0.5) * H]);
    }
    let n = 0;
    for (const s of marked) {
      if (n >= max) break;
      if (s.d > SURVEY.radius) continue;
      const sol = this.cache.get(s);
      if (!sol || !sol.reach) continue;
      const y = t.heightAt(s.x, s.z) + 2.2;
      _v.set(s.x, y, s.z).project(camera);
      if (_v.z > 1) continue;
      const x = (_v.x * 0.5 + 0.5) * W, yy = (-_v.y * 0.5 + 0.5) * H;
      if (x < 8 || x > W - 8 || yy < 8 || yy > H - 8) continue;
      if (placed.some((q) => Math.abs(q[0] - x) < gapX && Math.abs(q[1] - yy) < gapY)) continue;
      placed.push([x, yy]);
      const far = camera.position.distanceTo(_v.set(s.x, y, s.z));
      const rim = 1 - Math.max(0, Math.min(1, (s.d - SURVEY.radius * 0.6) / (SURVEY.radius * 0.4)));
      const near = 1 - 0.65 * Math.max(0, Math.min(1, (far - 140) / 380));
      const tag = this.tags[n] || this.newTag();
      tag.el.style.display = '';
      tag.el.style.opacity = (Math.max(0.25, rim) * near * (sol.stale ? 0.55 : 1)).toFixed(2);
      tag.el.style.transform = `translate(${x.toFixed(1)}px, ${yy.toFixed(1)}px) translate(-50%, -100%)`;
      const text = `${sol.yaw.toFixed(1)}°|${sol.power.toFixed(1)}`;
      if (tag.text !== text) {
        tag.text = text;
        tag.yaw.textContent = `${sol.yaw.toFixed(1)}°`;
        tag.pow.textContent = sol.power.toFixed(1);
      }
      n++;
    }
    for (let k = n; k < this.tags.length; k++) this.tags[k].el.style.display = 'none';

    // One legend by the satellite says what every label assumes.
    _v.copy(this.sat.position).project(camera);
    const sx = (_v.x * 0.5 + 0.5) * W, sy = (-_v.y * 0.5 + 0.5) * H;
    const onScreen = _v.z <= 1 && sx > 40 && sx < W - 40 && sy > 30 && sy < H - 30;
    this.legend.style.display = onScreen ? '' : 'none';
    if (onScreen) {
      this.legend.style.transform = `translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) translate(-50%, -150%)`;
      const text = `SAT ${level} · elev ${p.elev.toFixed(1)}° · ${live ? 'wind in' : 'no wind'}`;
      if (this.legend.textContent !== text) this.legend.textContent = text;
    }
  }

  newTag() {
    const el = document.createElement('div');
    el.className = 'survey-tag';
    const yaw = document.createElement('b');
    const pow = document.createElement('span');
    el.append(yaw, pow);
    this.labels.appendChild(el);
    const tag = { el, yaw, pow, text: '' };
    this.tags.push(tag);
    return tag;
  }

  // A new match: the labels box was emptied, so start the tags afresh.
  reset() {
    this.hide();
    this.tags = [];
    this.cache = new SurveyCache();
  }
}
