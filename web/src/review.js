// Resource-pack review: audition the asset library's packs inside a live
// match: Settings > Resource packs, or P. Sounds can be played on their own or put in for a game event
// (the cannon, blasts by size, impacts, jets...), so the next shot uses them;
// a sky HDRI replaces the sky, its light and the sun's direction; a material
// re-skins the ground or a sample ball; a model is set down by the camera.
// Every item can be marked keep or drop, and the picks saved to
// docs/pack-picks.json for the resource oracle.
//
// Only loaded when tools/devserver.mjs serves the library, or on the live site
// with ?packs from the phone-sized mirror (see main.js and tools/packmirror.py).
// The ones the game keeps are copied into the repo separately.

import * as THREE from 'three';
import { HDRLoader } from '../vendor/three/addons/loaders/HDRLoader.js';
import { GLTFLoader } from '../vendor/three/addons/loaders/GLTFLoader.js';
import { groundShade } from './render/terrainMesh.js';
import { EVENTS, guessEvent, kindOf, groupOf, soundFiles, packUrl, itemFacts, summarizePicks } from './packkit.js';

const VOTES_KEY = 'craterfall.packVotes';
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const keyOf = (pack, item) => `${pack.id}/${item.id}`;

export class PackReview {
  // `lib` is the dev server's /api/packs answer; `env` the game's scene, sky,
  // sound and so on, with ground() the terrain mesh in view and groundAt(x, z).
  constructor(lib, env) {
    this.lib = lib;
    this.env = env;
    this.packs = lib.packs;
    this.pack = this.packs[0];
    this.votes = {};
    try { this.votes = JSON.parse(localStorage.getItem(VOTES_KEY)) || {}; } catch { /* none yet */ }
    // Picks saved to the repo earlier fill in what this browser has not seen.
    for (const [p, v] of Object.entries(lib.picks?.picks?.packs || {})) {
      const mine = this.votes[p] || (this.votes[p] = {});
      for (const id of v.keep || []) mine[id] ??= 'keep';
      for (const id of v.drop || []) mine[id] ??= 'drop';
    }
    this.use = Object.fromEntries(EVENTS.map(([ev]) => [ev, []]));   // event -> item keys
    this.buffers = new Map();       // item key -> AudioBuffer
    this.textures = new Map();      // url -> Texture
    this.materials = new Map();     // item key -> MeshStandardMaterial (ground scale)
    this.skyOn = null;
    this.groundOn = null;
    this.placed = new THREE.Group();
    env.scene.add(this.placed);
    this.spots = 0;
    this.build();
    window.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === 'p' || e.key === 'P') this.toggle();
    });
  }

  // ---------------------------------------------------------------- panel

  // Opened from Settings (main.js), or P on a keyboard.
  build() {
    const el = this.el = document.createElement('div');
    el.id = 'review';
    el.className = 'hidden';
    el.innerHTML = `
      <div class="rv-head">
        <b>Resource packs</b><small>${this.lib.static ? 'shareable packs, phone-sized' : 'local review'}</small>
        <button class="rv-x" title="Close (P)">&#x2715;</button>
      </div>
      <select class="rv-packs"></select>
      <div class="rv-about"></div>
      <div class="rv-tools"></div>
      <div class="rv-list"></div>
      <div class="rv-foot"><span class="rv-count"></span><button class="rv-save">${this.lib.static ? 'Copy picks' : 'Save picks'}</button></div>`;
    document.body.appendChild(el);
    const $ = (s) => el.querySelector(s);
    this.$ = $;
    // Keys typed or pressed in the panel are not the game's.
    for (const t of ['keydown', 'keyup']) el.addEventListener(t, (e) => { if (e.key !== 'p' && e.key !== 'P') e.stopPropagation(); });
    $('.rv-x').addEventListener('click', () => this.toggle(false));
    const packs = $('.rv-packs');
    packs.innerHTML = this.packs.map((p, i) => `<option value="${i}">${esc(p.title || p.id)} (${p.items?.length || 0})</option>`).join('');
    packs.addEventListener('change', () => { this.pack = this.packs[Number(packs.value)]; this.render(); });
    $('.rv-save').addEventListener('click', () => this.save());
    this.render();
  }

  toggle(on = this.el.classList.contains('hidden')) {
    this.el.classList.toggle('hidden', !on);
  }

  render() {
    const p = this.pack, $ = this.$;
    const license = `${esc(p.license || '?')}${p.redistributable === false ? ' &middot; <em>not redistributable</em>' : ''}`;
    $('.rv-about').innerHTML = `<p>${esc(p.description || '')}</p><small>${license} &middot; v${esc(p.version || '?')} &middot; built ${esc(p.built || '?')}</small>`;
    const kinds = new Set((p.items || []).map((i) => kindOf(i.type)));
    $('.rv-tools').innerHTML = this.tools(kinds);
    this.wireTools();

    const groups = new Map();
    for (const item of p.items || []) {
      const g = groupOf(item);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(item);
    }
    const list = $('.rv-list');
    list.innerHTML = [...groups].map(([g, items]) => `<h4>${esc(g)}</h4>${items.map((it) => this.row(it)).join('')}`).join('');
    for (const row of list.querySelectorAll('.rv-item')) this.wireRow(row);
    this.count();
  }

  tools(kinds) {
    const out = [];
    if (kinds.has('sound')) {
      out.push(`<div class="rv-bar">
        <button data-t="auto" title="Put every sound in for the event its name suggests">Use pack in game</button>
        <button data-t="synth" title="Back to the synthesised sounds">Synth only</button>
        <label title="Replace the synth, or play under it"><input type="checkbox" data-t="layer" ${this.env.sound.samplesMode === 'layer' ? 'checked' : ''}/> layer</label>
        <label>level <input type="range" data-t="level" min="0.2" max="2" step="0.1" value="${this.env.sound.sampleLevel}"/></label>
      </div>
      <div class="rv-bar rv-test">Test:
        <button data-test="fire">Cannon</button><button data-test="small">Small</button><button data-test="medium">Medium</button>
        <button data-test="big">Big</button><button data-test="far">Far</button><button data-test="impact">Impact</button>
        <button data-test="hit">Hit</button><button data-test="wreck">Wreck</button><button data-test="jet">Jet</button><button data-test="warp">Warp</button>
      </div>`);
    }
    if (kinds.has('sky')) {
      out.push(`<div class="rv-bar"><button data-t="gamesky">Game sky</button>
        <label>sky light <input type="range" data-t="env" min="0" max="2" step="0.1" value="${this.env.scene.environmentIntensity ?? 1}"/></label></div>`);
    }
    if (kinds.has('material')) out.push('<div class="rv-bar"><button data-t="gameground">Game ground</button><button data-t="clear">Clear samples</button></div>');
    else if (kinds.has('model')) out.push('<div class="rv-bar"><button data-t="clear">Clear placed</button></div>');
    return out.join('');
  }

  wireTools() {
    const s = this.env.sound;
    const on = (t, ev, fn) => this.$(`.rv-tools [data-t=${t}]`)?.addEventListener(ev, fn);
    on('auto', 'click', () => this.autoAssign());
    on('synth', 'click', () => { for (const ev in this.use) this.use[ev] = []; this.applySamples(); this.render(); });
    on('layer', 'change', (e) => { s.samplesMode = e.target.checked ? 'layer' : 'replace'; });
    on('level', 'input', (e) => { s.sampleLevel = Number(e.target.value); });
    on('gamesky', 'click', () => this.gameSky());
    on('env', 'input', (e) => { this.env.scene.environmentIntensity = Number(e.target.value); });
    on('gameground', 'click', () => this.gameGround());
    on('clear', 'click', () => this.clearPlaced());
    const test = {
      fire: () => s.fire(0), small: () => s.explode(6, 60), medium: () => s.explode(12, 60), big: () => s.explode(20, 60),
      far: () => s.explode(14, 450), impact: () => s.thud(20), hit: () => s.hit(20), wreck: () => s.thud(20, 'wreck'),
      jet: () => s.jet(10), warp: () => s.warp(10),
    };
    for (const b of this.el.querySelectorAll('.rv-tools [data-test]')) b.addEventListener('click', () => test[b.dataset.test]());
  }

  row(item) {
    const p = this.pack;
    const kind = kindOf(item.type);
    const vote = this.votes[p.id]?.[item.id] || '';
    const key = keyOf(p, item);
    const thumb = item.preview ? `<img src="${packUrl(p, item.preview)}" loading="lazy" alt="">` : '';
    let act = '';
    if (kind === 'sound') {
      const now = EVENTS.find(([ev]) => this.use[ev].includes(key))?.[0] || '';
      act = `<button data-a="play" title="Play">&#9654;</button>
        <select data-a="use" title="Use for a game event"><option value="">use for&hellip;</option>${EVENTS.map(([ev, name]) => `<option value="${ev}" ${ev === now ? 'selected' : ''}>${name}</option>`).join('')}</select>`;
    } else if (kind === 'sky') act = `<button data-a="sky" class="${this.skyOn === key ? 'on' : ''}">Sky</button>`;
    else if (kind === 'material') act = `<button data-a="ground" class="${this.groundOn === key ? 'on' : ''}">Ground</button><button data-a="ball">Ball</button>`;
    else if (kind === 'model') act = '<button data-a="place">Place</button>';
    const facts = itemFacts(item);
    return `<div class="rv-item ${vote}" data-id="${esc(item.id)}">
      ${thumb}
      <div class="rv-main"><b>${esc(item.title || item.id)}</b>
        <small>${esc(facts.join(' · '))}</small>
        ${item.notes ? `<small class="rv-notes">${esc(item.notes)}</small>` : ''}
      </div>
      <div class="rv-act">${act}
        <button data-v="keep" class="rv-keep ${vote === 'keep' ? 'on' : ''}" title="Keep">&#10003;</button>
        <button data-v="drop" class="rv-drop ${vote === 'drop' ? 'on' : ''}" title="Drop">&#10007;</button>
      </div>
    </div>`;
  }

  wireRow(row) {
    const item = this.pack.items.find((i) => String(i.id) === row.dataset.id);
    const busy = async (btn, fn) => {
      btn.classList.add('busy');
      try { await fn(); } catch (err) { this.env.banner('Could not load', String(err?.message || err).slice(0, 80), 1800); }
      btn.classList.remove('busy');
    };
    for (const b of row.querySelectorAll('[data-a]')) {
      const a = b.dataset.a;
      if (a === 'use') b.addEventListener('change', () => busy(b, () => this.assign(item, b.value)));
      else b.addEventListener('click', () => busy(b, () => ({
        play: () => this.play(item), sky: () => this.applySky(item), ground: () => this.applyGround(item),
        ball: () => this.ball(item), place: () => this.place(item),
      })[a]()));
    }
    for (const b of row.querySelectorAll('[data-v]')) b.addEventListener('click', () => this.vote(item, b.dataset.v, row));
  }

  vote(item, v, row) {
    const mine = this.votes[this.pack.id] || (this.votes[this.pack.id] = {});
    if (mine[item.id] === v) delete mine[item.id]; else mine[item.id] = v;
    try { localStorage.setItem(VOTES_KEY, JSON.stringify(this.votes)); } catch { /* private mode */ }
    row.classList.remove('keep', 'drop');
    if (mine[item.id]) row.classList.add(mine[item.id]);
    row.querySelector('.rv-keep').classList.toggle('on', mine[item.id] === 'keep');
    row.querySelector('.rv-drop').classList.toggle('on', mine[item.id] === 'drop');
    this.count();
  }

  count() {
    const v = Object.values(this.votes[this.pack.id] || {});
    const used = Object.values(this.use).reduce((n, l) => n + l.length, 0);
    this.$('.rv-count').textContent = `${v.filter((x) => x === 'keep').length} kept · ${v.filter((x) => x === 'drop').length} dropped${used ? ` · ${used} in game` : ''}`;
  }

  async save() {
    const body = { picks: summarizePicks(this.votes, this.use) };
    if (this.lib.static) return this.copyPicks(body.picks);
    const r = await fetch('api/packs/picks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    this.env.banner(r.ok ? 'Picks saved' : 'Save failed', r.ok ? 'docs/pack-picks.json' : `HTTP ${r.status}`, 1400);
  }

  // The live mirror can't write to the repo: put the picks on the clipboard to
  // paste to Claude, or failing that in a box to copy by hand.
  async copyPicks(picks) {
    const text = `Craterfall pack picks: ${JSON.stringify(picks)}`;
    try {
      await navigator.clipboard.writeText(text);
      this.env.banner('Picks copied', 'Paste them to Claude', 1800);
    } catch {
      let box = this.el.querySelector('.rv-copy');
      if (!box) {
        box = document.createElement('textarea');
        box.className = 'rv-copy';
        box.readOnly = true;
        this.el.insertBefore(box, this.$('.rv-foot'));
      }
      box.value = text;
      box.focus();
      box.select();
      this.env.banner('Copy the picks', 'Select all in the box and copy', 1800);
    }
  }

  // ---------------------------------------------------------------- sound

  async buffer(item, pack = this.pack) {
    const key = keyOf(pack, item);
    if (this.buffers.has(key)) return this.buffers.get(key);
    const ctx = this.env.sound.ensure();
    if (!ctx) throw new Error('No Web Audio');
    let last = null;
    for (const f of soundFiles(item)) {
      try {
        const r = await fetch(packUrl(pack, f));
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const buf = await ctx.decodeAudioData(await r.arrayBuffer());
        this.buffers.set(key, buf);
        return buf;
      } catch (err) { last = err; }   // e.g. Safari without Opus: try the mp3
    }
    throw last || new Error('No audio file');
  }

  async play(item) {
    const s = this.env.sound;
    const buf = await this.buffer(item);
    const ctx = s.ensure();
    this.voice?.stop();
    const src = this.voice = ctx.createBufferSource();
    src.buffer = buf;
    const g = ctx.createGain();
    g.gain.value = 0.8 * s.sampleLevel;
    src.connect(g).connect(s.fx);
    src.start();
  }

  async assign(item, ev) {
    const key = keyOf(this.pack, item);
    for (const e in this.use) this.use[e] = this.use[e].filter((k) => k !== key);
    if (ev) { await this.buffer(item); this.use[ev].push(key); }
    this.applySamples();
    this.count();
  }

  async autoAssign() {
    const p = this.pack;
    const picks = (p.items || []).map((it) => [it, guessEvent(it)]).filter(([it, ev]) => ev && kindOf(it.type) === 'sound');
    // Kept items win: if any take for an event is marked keep, only kept ones go in.
    const vote = this.votes[p.id] || {};
    const byEvent = {};
    for (const [it, ev] of picks) (byEvent[ev] ||= []).push(it);
    for (const [ev, items] of Object.entries(byEvent)) {
      const kept = items.filter((it) => vote[it.id] === 'keep');
      const chosen = (kept.length ? kept : items.filter((it) => vote[it.id] !== 'drop'));
      await Promise.all(chosen.map((it) => this.buffer(it)));
      this.use[ev] = chosen.map((it) => keyOf(p, it));
    }
    this.applySamples();
    this.render();
    this.env.banner('Pack sounds in', `${Object.keys(byEvent).length} events`, 1200);
  }

  applySamples() {
    const s = this.env.sound;
    s.samples = {};
    for (const [ev, keys] of Object.entries(this.use)) {
      const bufs = keys.map((k) => this.buffers.get(k)).filter(Boolean);
      if (bufs.length) s.samples[ev] = bufs;
    }
  }

  // ---------------------------------------------------------------- sky

  async applySky(item) {
    const { scene, sky, renderer } = this.env;
    const file = item.files?.['1k'] || item.files?.['2k'] || item.file;
    const tex = await new HDRLoader().setDataType(THREE.FloatType).loadAsync(packUrl(this.pack, file));
    tex.mapping = THREE.EquirectangularReflectionMapping;
    this.pmrem ||= new THREE.PMREMGenerator(renderer);
    const env = this.pmrem.fromEquirectangular(tex).texture;
    if (!this.skyOn) this.saved = { fog: scene.fog.color.clone() };
    this.dropSky();
    this.skyTex = tex;
    this.envTex = env;
    scene.background = tex;
    scene.environment = env;
    sky.frozen = true;
    sky.dome.visible = false;
    sky.cloudMesh.visible = false;
    for (const c of groundShade.clouds.value) c.z = 0;     // no cloud shadows without the clouds

    // Point the game's sun (and its shadows) at the brightest spot in the
    // sky, coloured like it; an overcast sky gets a weak, white sun.
    const { dir, color, horizon } = readSky(tex);
    sky.sunDir.copy(dir);
    sky.sun.color.copy(color);
    sky.sun.intensity = item.sun === false ? 0.5 : 2.0;
    sky.hemi.intensity = 0.15;
    scene.fog.color.copy(horizon);
    sky.place();
    this.skyOn = keyOf(this.pack, item);
    this.render();
  }

  dropSky() {
    this.skyTex?.dispose();
    this.envTex?.dispose();
    this.skyTex = this.envTex = null;
  }

  gameSky() {
    if (!this.skyOn) return;
    const { scene, sky } = this.env;
    this.dropSky();
    scene.background = null;
    scene.environment = null;
    sky.frozen = false;
    sky.dome.visible = true;
    sky.cloudMesh.visible = true;
    scene.fog.color.copy(this.saved.fog);
    // setDay skips a day it already has, so make it redo the sun and light.
    const day = sky.day;
    sky.day = -1;
    sky.setDay(day);
    this.skyOn = null;
    this.render();
  }

  // ---------------------------------------------------------------- ground

  async texture(rel, srgb) {
    const url = packUrl(this.pack, rel);
    if (!this.textures.has(url)) {
      const t = await new THREE.TextureLoader().loadAsync(url);
      t.wrapS = t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
      t.anisotropy = 8;
      this.textures.set(url, t);
    }
    return this.textures.get(url);
  }

  // A material for the item, its maps repeating every `tile` uv units.
  async material(item, tile) {
    const m = item.maps || {};
    const get = async (k, srgb) => {
      if (!m[k]) return null;
      const t = (await this.texture(m[k], srgb)).clone();
      t.repeat.set(1 / tile, 1 / tile);
      t.needsUpdate = true;
      return t;
    };
    const [map, normalMap, roughnessMap, aoMap, metalnessMap] = await Promise.all(
      [get('albedo', true), get('normal'), get('roughness'), get('ao'), get('metalness')]);
    return new THREE.MeshStandardMaterial({ map, normalMap, roughnessMap, aoMap, metalnessMap, roughness: 1, metalness: metalnessMap ? 1 : 0 });
  }

  async applyGround(item) {
    const key = keyOf(this.pack, item);
    if (!this.materials.has(key)) this.materials.set(key, await this.material(item, item.tile_m || 2));
    this.groundOn = key;
    this.groundMat = this.materials.get(key);
    this.dressGround();
    this.render();
  }

  // Put the chosen material on the ground in view; its uvs are world metres.
  dressGround() {
    const tm = this.env.ground();
    if (!tm || !this.groundMat) return;
    const g = tm.geometry;
    const pos = tm.positions;
    const n = pos.length / 3;
    let uv = g.getAttribute('uv');
    if (!uv || uv.count !== n) {
      uv = new THREE.BufferAttribute(new Float32Array(n * 2), 2);
      g.setAttribute('uv', uv);
    }
    for (let i = 0; i < n; i++) uv.setXY(i, pos[i * 3], pos[i * 3 + 2]);
    uv.needsUpdate = true;
    tm.mesh.material = this.groundMat;
  }

  gameGround() {
    const tm = this.env.ground();
    if (tm) tm.mesh.material = tm.material;
    this.groundOn = null;
    this.groundMat = null;
    this.render();
  }

  // A new match made a new ground: dress it too.
  onMatch() { this.dressGround(); this.spots = 0; }

  // ---------------------------------------------------------------- props

  // Somewhere in front of the camera, on the ground, a few metres apart.
  spot() {
    const { camera, controls, groundAt } = this.env;
    const right = new THREE.Vector3().setFromMatrixColumn(camera.matrixWorld, 0).setY(0).normalize();
    const k = this.spots++;
    const p = controls.target.clone().addScaledVector(right, ((k % 5) - 2) * 9);
    p.y = groundAt(p.x, p.z);
    return p;
  }

  async ball(item) {
    const mat = await this.material(item, 0.25);
    const m = new THREE.Mesh(new THREE.SphereGeometry(3, 48, 24), mat);
    m.position.copy(this.spot()).y += 3;
    m.castShadow = m.receiveShadow = true;
    this.placed.add(m);
  }

  async place(item) {
    const gltf = await new GLTFLoader().loadAsync(packUrl(this.pack, item.file));
    const obj = gltf.scene;
    obj.traverse((o) => { if (o.isMesh) { o.castShadow = o.receiveShadow = true; } });
    obj.position.copy(this.spot());
    this.placed.add(obj);
    const size = new THREE.Box3().setFromObject(obj).getSize(new THREE.Vector3());
    this.env.banner(item.title || item.id, `${size.x.toFixed(1)} x ${size.y.toFixed(1)} x ${size.z.toFixed(1)} m`, 1400);
  }

  clearPlaced() {
    for (const o of [...this.placed.children]) {
      this.placed.remove(o);
      o.traverse((c) => { if (c.isMesh) c.geometry.dispose(); });
    }
    this.spots = 0;
  }
}

// From an equirectangular HDR (float RGBA): the direction of its brightest
// texel in the upper half, that texel's colour (scaled to a max channel of 1)
// and the average colour just above the horizon (for the fog).
function readSky(tex) {
  const { data, width: w, height: h } = tex.image;
  const ch = data.length / (w * h);
  let best = -1, at = 0;
  for (let r = 0; r < h / 2; r++) {
    for (let c = 0; c < w; c++) {
      const i = (r * w + c) * ch;
      const lum = data[i] * 0.2126 + data[i + 1] * 0.7152 + data[i + 2] * 0.0722;
      if (lum > best) { best = lum; at = r * w + c; }
    }
  }
  const r = Math.floor(at / w), c = at % w;
  // The loader flips rows, so row 0 is the top of the sky (v = 1); three's
  // equirect lookup is u = atan(z, x) / 2pi + 0.5, v = asin(y) / pi + 0.5.
  const v = 1 - (r + 0.5) / h, u = (c + 0.5) / w;
  const lat = (v - 0.5) * Math.PI, lon = (u - 0.5) * Math.PI * 2;
  const dir = new THREE.Vector3(Math.cos(lon) * Math.cos(lat), Math.sin(lat), Math.sin(lon) * Math.cos(lat));
  if (dir.y < 0.12) dir.y = 0.12;    // keep some shadow under a sun on the horizon
  dir.normalize();
  const i = at * ch;
  const peak = Math.max(data[i], data[i + 1], data[i + 2], 1e-6);
  const color = new THREE.Color(data[i] / peak, data[i + 1] / peak, data[i + 2] / peak);

  const row = Math.floor(h / 2 - h * 0.03);
  let sr = 0, sg = 0, sb = 0;
  for (let k = 0; k < w; k++) {
    const j = (row * w + k) * ch;
    sr += data[j]; sg += data[j + 1]; sb += data[j + 2];
  }
  const horizon = new THREE.Color(Math.min(1, sr / w), Math.min(1, sg / w), Math.min(1, sb / w));
  return { dir, color, horizon };
}
