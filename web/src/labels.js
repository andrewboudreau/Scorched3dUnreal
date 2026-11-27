// The marks over the field, all in #labels: each tank's name and health (with
// its JAM badge), the fog's ghosts ("Rook?  last seen here"), the edge arrows
// to enemies off screen, the pips where shells came down (and a rangefinder's
// probes, with their beams), and the damage numbers that pop off a hit tank.
// How much a tank's mark says in each view is cameramode.js labelMode (main.js
// passes it in); the rules and words are hudlogic.js (pure, tested).
//
// main.js makes one and calls it:
//   start(game)          a new match: a mark, a ghost and an edge arrow per tank
//   clear()              the match is over: everything in #labels goes
//   readBoxes()          once a frame, before any DOM write: where the HUD
//                        panels are, so edge marks keep clear of them
//   update(game, ctx)    each frame: the tanks' marks, the pips, the edge arrows.
//                        ctx: { mode (labelMode), sight (the sight drives the
//                        camera), overview, handoff (a hand-off card is up) }
//   ghost(i, b, game)    tank i's fog ghost at believed spot b (null: none)
//   addPip / addProbePip / retireProbes / clearPips / pipHit   the landing pips
//   popDamage(p, amount) a damage number over a tank
// deps: root (#labels), camera, scene (for the probes' beams), seen(p),
// believed(p) (main.js's fog of war) and peekAt(p) (a click on an edge arrow).

import * as THREE from 'three';
import { setText, setStyle, setDisplay, moveTo, CENTRE, ABOVE } from './domwrite.js';
import { escapeHtml, markShows, ghostText, locatorOwner, rangeText, pipHidden, probeColor, probeLabel, screenSpot, unstack } from './hudlogic.js';

// The HUD panels edge marks keep clear of.
const HUD_PANELS = ['player-card', 'range-card', 'scoreboard'];
const BEAM_GEO = new THREE.CylinderGeometry(0.8, 0.8, 50, 8, 1, true).translate(0, 25, 0);

export class Labels {
  constructor({ root, camera, scene, seen = () => true, believed = () => null, peekAt = () => {} }) {
    Object.assign(this, { root, camera, scene, seen, believed, peekAt });
    this.marks = [];      // per tank: its name and health
    this.ghosts = [];     // per tank: where this screen last placed it (fog)
    this.locators = [];   // per tank: edge arrow pointing at it when off screen
    this.pips = [];
    this.boxes = [];
    this.modeWas = '';
    // Scratch, for per-frame work; nothing keeps one past the call that filled it.
    this._v = new THREE.Vector3();
  }

  // Where the HUD panels sit, read once at the start of each frame (before that
  // frame's DOM writes) so placing a marker never forces a layout.
  readBoxes() {
    this.boxes = HUD_PANELS.map((id) => { const b = document.getElementById(id).getBoundingClientRect(); return { left: b.left, right: b.right, top: b.top, bottom: b.bottom, width: b.width }; });
  }

  // ---- a match

  start(game) {
    this.marks = game.players.map((p) => {
      const el = document.createElement('div');
      el.className = 'tank-label';
      el.innerHTML = `<div style="color:${p.color}">${escapeHtml(p.name)}<span class="tl-jam" title="Jammed">JAM</span></div><div class="bar"><div class="fill hp"></div></div>`;
      this.root.appendChild(el);
      return el;
    });
    this.ghosts = game.players.map((p) => {
      const el = document.createElement('div');
      el.className = 'tank-label ghost';
      el.innerHTML = `<div style="color:${p.color}">${escapeHtml(p.name)}?</div><small></small>`;
      el.style.display = 'none';
      this.root.appendChild(el);
      return el;
    });
    this.locators = game.players.map((p) => {
      const el = document.createElement('div');
      el.className = 'locator';
      el.style.setProperty('--c', p.color);
      el.innerHTML = `<i></i><b>${escapeHtml(p.name)}</b><small></small>`;
      el.style.display = 'none';
      el.addEventListener('click', () => this.peekAt(p));
      this.root.appendChild(el);
      return el;
    });
  }

  clear() {
    this.marks = [];
    this.clearPips();      // takes a rangefinder pip's beam out of the scene too
    this.root.innerHTML = '';
  }

  update(game, { mode, sight = false, overview = false, handoff = false }) {
    this.updateMarks(game, mode, sight);
    this.updatePips(game, handoff);
    this.updateLocators(game, { sight, overview, handoff });
  }

  // ---- the marks over the tanks

  updateMarks(game, mode, sight) {
    if (mode !== this.modeWas) { this.root.className = `lb-${mode}`; this.modeWas = mode; }
    game.players.forEach((p, i) => {
      const el = this.marks[i];
      const v = this._v.set(p.x, p.y + 8, p.z).project(this.camera);
      const visible = markShows({ alive: p.alive, seen: this.seen(p), v, ownInSight: sight && p === game.current });
      setDisplay(el, visible ? 'block' : 'none');
      if (!visible) return;
      moveTo(el, (v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight, ABOVE);
      setStyle(el._fill || (el._fill = el.querySelector('.fill')), 'width', `${(p.hp / p.maxHp) * 100}%`);
      const jam = game.jammed(p) > 0;   // a Jammer Drone over it (core/mods.js JAM)
      if (el._jam !== jam) { el._jam = jam; el.classList.toggle('jammed', jam); }
    });
  }

  // A fog ghost: the tank's name and how old the sighting is, over where this
  // screen believes it is (`b`, from main.js believed()); null hides it.
  ghost(i, b, game) {
    const el = this.ghosts[i];
    if (!b) { setDisplay(el, 'none'); return; }
    const v = this._v.set(b.x, b.y + 7, b.z).project(this.camera);
    const on = v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
    setDisplay(el, on ? 'block' : 'none');
    if (!on) return;
    moveTo(el, (v.x * 0.5 + 0.5) * window.innerWidth, (-v.y * 0.5 + 0.5) * window.innerHeight, ABOVE);
    setText(el._small || (el._small = el.querySelector('small')), ghostText({ r: b.r, ago: game.turnsThisRound - b.at, volley: game.volleyMode }));
  }

  // ---- edge markers

  spot(x, y, z) {
    return screenSpot(this._v.set(x, y, z).project(this.camera), window.innerWidth, window.innerHeight, this.boxes);
  }

  place(el, s) {
    if (el._edge !== s.off) { el._edge = s.off; el.classList.toggle('edge', s.off); }
    moveTo(el, s.sx, s.sy, CENTRE);
    if (s.off) {
      const a = `${s.angle}rad`;
      if (el._a !== a) { el._a = a; el.style.setProperty('--a', a); }
    }
  }

  // While you plan, every opponent that is off screen gets an arrow on the
  // screen edge with its name and range. Click one, or press F, to look.
  updateLocators(game, { sight, overview, handoff }) {
    const me = locatorOwner({ phase: game.phase, current: game.current, handoff, overview, mode: sight ? 'sight' : '' });   // the sight draws its own markers
    const placed = [];
    game.players.forEach((p, i) => {
      const el = this.locators[i];
      const b = me && p !== me && p.alive ? this.believed(p) : null;
      const s = b ? this.spot(b.x, b.y + 4, b.z) : null;
      if (!s || !s.off) { setDisplay(el, 'none'); return; }
      setDisplay(el, '');
      unstack(s, placed);
      this.place(el, s);
      setText(el._small || (el._small = el.querySelector('small')), rangeText(b, me));
    });
  }

  // ---- pips

  // A small dot where a shell came down, pinned to the screen edge (with an
  // arrow) when that spot is off camera. In a volley, other tanks' landings get
  // one in the shooter's colour, lasting a few seconds into the next planning
  // phase. A rangefinder's probes get `sticky` ones, kept until that tank fires
  // again and shown only to it while it plans.
  addPip(game, owner, pos, { label, color, sticky = false } = {}) {
    const now = performance.now();
    // A cluster's bomblets land together: one pip covers them.
    if (!sticky && this.pips.some((q) => q.owner === owner && !q.sticky && now - q.born < 2500 && Math.hypot(q.pos[0] - pos[0], q.pos[2] - pos[2]) < 40)) return;
    const p = game.players[owner];
    const el = document.createElement('div');
    el.className = sticky ? 'pip probe' : 'pip';
    el.style.setProperty('--c', color || p.color);
    el.innerHTML = `<i></i><span>${escapeHtml(label || p.name)}</span>`;
    this.root.appendChild(el);
    const q = { owner, pos: [...pos], el, born: now, until: 0, sticky };
    this.pips.push(q);
    return q;
  }

  // A rangefinder probe's landing: a sticky pip in its colour, and a tall thin
  // beam, so the spread reads from across the map.
  addProbePip(game, owner, pos, pb) {
    const color = probeColor(pb.key);
    const q = this.addPip(game, owner, pos, { label: probeLabel(pb), color, sticky: true });
    q.beam = new THREE.Mesh(BEAM_GEO, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5, depthWrite: false }));
    q.beam.position.set(pos[0], pos[1], pos[2]);
    this.scene.add(q.beam);
  }

  dropPip(q) {
    q.el.remove();
    if (q.beam) { this.scene.remove(q.beam); q.beam.material.dispose(); }
  }

  clearPips() {
    this.pips.forEach((q) => this.dropPip(q));
    this.pips.length = 0;
  }

  // Its next shot retires a tank's rangefinder marks.
  retireProbes(owner) {
    this.pips.forEach((q) => { if (q.sticky && q.owner === owner) { q.sticky = false; q.until = performance.now() + 600; } });
  }

  // Name the victim on the shooter's pip.
  pipHit(game, by, victim, heroId) {
    const pip = by != null && by !== victim && [...this.pips].reverse().find((q) => q.owner === by && performance.now() - q.born < 3000);
    if (pip) pip.el.querySelector('span').textContent = `${game.players[by].name} hit ${victim === heroId ? 'you' : game.players[victim].name}`;
  }

  updatePips(game, handoff) {
    const now = performance.now();
    const placed = [];
    const labels = [];            // label boxes already placed, so close-together marks stay readable
    const { camera } = this;
    for (let i = this.pips.length - 1; i >= 0; i--) {
      const q = this.pips[i];
      if (!q.until && !q.sticky && game.phase === 'aim') q.until = now + 4000;
      const left = q.until ? (q.until - now) / 1000 : Infinity;
      if (left <= 0) { this.dropPip(q); this.pips.splice(i, 1); continue; }
      const hide = pipHidden({ handoff, sticky: q.sticky, phase: game.phase, current: game.current, owner: q.owner });
      setDisplay(q.el, hide ? 'none' : '');
      if (q.beam) {
        // Fade a beam the camera is right beside: up close it is a wall, not a marker.
        const near = Math.min(1, Math.max(0.12, (Math.hypot(camera.position.x - q.pos[0], camera.position.z - q.pos[2]) - 25) / 90));
        q.beam.visible = !hide;
        q.beam.material.opacity = 0.5 * near * Math.min(1, left / 1.2);
      }
      if (hide) continue;
      setStyle(q.el, 'opacity', Math.min(1, left / 1.2));
      const s = this.spot(q.pos[0], q.pos[1] + 1, q.pos[2]);
      if (s.off) unstack(s, placed);
      this.place(q.el, s);
      // Marks that land close together (a rangefinder's always do from afar):
      // the dots stay put and their names stack downward.
      const span = q.el.lastElementChild;
      const w = (q.w ||= span.offsetWidth || 60) / 2 + 4;
      let top = 14;
      while (top < 100 && labels.some(([x, y, hw]) => Math.abs(x - s.sx) < hw + w && Math.abs(y - (s.sy + top)) < 13)) top += 13;
      setStyle(span, 'top', `${top}px`);
      labels.push([s.sx, s.sy + top, w]);
    }
  }

  // ---- damage numbers

  popDamage(p, amount) {
    const v = this._v.set(p.x, p.y + 6, p.z).project(this.camera);
    if (v.z > 1) return;
    const el = document.createElement('div');
    el.className = 'dmg-pop';
    el.textContent = `-${Math.round(amount)}`;
    el.style.left = `${(v.x * 0.5 + 0.5) * window.innerWidth}px`;
    el.style.top = `${(-v.y * 0.5 + 0.5) * window.innerHeight}px`;
    this.root.appendChild(el);
    setTimeout(() => el.remove(), 1300);
  }
}
