// Synthesised sound. One-shots (cannon, blasts, debris, ticks, chirps, bleats)
// plus quiet beds that `update` keeps in step with the game: wind, a shell's
// whistle, the engine, a fire crackle near anything burning and rain in a
// Rain round.
//
// A few Kenney samples (CC0, in sfx/) sit under the synth as defaults for
// 'debris' (the patter after a big blast) and 'thump' (the low body of a big
// blast); see DEFAULT_SAMPLES. Anything chosen in the pack review for the same
// event wins over them.
//
// Levels: every effect goes through `fx` (the Effects level and mute), music
// through its own bus (music.js), and both through `master` (the Master level,
// and M). Master sits under the device's own volume, which a web page cannot
// set; it starts at full so the device's buttons do the real work.

const MASTER_KEY = 'craterfall.master';
const FX_KEY = 'craterfall.fx';
const FX_MUTE_KEY = 'craterfall.fxMuted';
const OLD_VOLUME_KEY = 'craterfall.volume';   // the one slider before Effects and Master were split
const store = globalThis.localStorage;
export function readLevel(key, fallback) {
  const v = store?.getItem(key);
  const n = Number(v);
  return v != null && v !== '' && n >= 0 && n <= 1 ? n : fallback;
}
export function saveLevel(key, v) {
  try { store?.setItem(key, String(v)); } catch { /* private mode */ }
}
// No speed-of-sound delay: real sound speed put far blasts up to a second
// behind their flash, which read as lag. Distance only muffles and quiets.
const MAX_VOICES = 14;     // noise bursts sounding at once; quiet ones are dropped past this

// Built-in samples (files in sfx/, each as .ogg with an .mp3 fallback). They
// load after the audio context first starts.
const DEFAULT_SAMPLES = {
  debris: ['earth-impact-rock-2', 'earth-impact-rock-3', 'metal-debris-small-2', 'metal-debris-small-3', 'metal-debris-small-5'],
  thump: ['earth-impact-thud-1', 'earth-impact-thud-3', 'explosion-distant-3'],
};

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;                                  // master mute (M); not remembered
    this.volume = readLevel(MASTER_KEY, 1);
    this.fxVolume = readLevel(FX_KEY, readLevel(OLD_VOLUME_KEY, 0.6));
    this.fxMuted = store?.getItem(FX_MUTE_KEY) === '1';
    this.nextChirp = 4;
    this.nextBleat = 9;
    this.nextHorn = 8;
    // Recorded samples standing in for (or under) the synth, per event; only
    // the pack review (src/review.js) sets these. See sample().
    this.samples = {};
    this.defaults = {};      // the built-in ones, by event; used when none are set
    this.samplesMode = 'replace';
    this.sampleLevel = 1;
  }

  // Play one of the samples set for `event` (a random take, slightly
  // re-pitched so repeats differ), quieter and duller with distance like the
  // synth. True if the synth should then be skipped.
  sample(event, dist = 0, { gain = 1, delay = 0, rate = 1 } = {}) {
    const takes = this.samples[event]?.length ? this.samples[event] : this.defaults[event];
    if (!takes?.length) return false;
    const ctx = this.ensure();
    if (!ctx || this.silent) return true;
    const { k, cutoff } = this.far(dist);
    const src = ctx.createBufferSource();
    src.buffer = takes[Math.floor(Math.random() * takes.length)];
    src.playbackRate.value = rate * (0.95 + Math.random() * 0.1);
    const g = ctx.createGain();
    g.gain.value = gain * k * this.sampleLevel;
    let out = this.fx;
    if (cutoff) {
      out = ctx.createBiquadFilter();
      out.type = 'lowpass';
      out.frequency.value = cutoff;
      out.connect(this.fx);
    }
    src.connect(g).connect(out);
    src.start(ctx.currentTime + delay);
    return this.samplesMode === 'replace';
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain();
      this.master.gain.value = this.level();
      this.fx = ctx.createGain();
      this.fx.gain.value = this.fxLevel();
      this.fx.connect(this.master);
      // A volley is six cannons and six blasts: squash the peaks rather than clip.
      const squash = ctx.createDynamicsCompressor();
      squash.threshold.value = -16;
      squash.ratio.value = 6;
      squash.attack.value = 0.004;
      squash.release.value = 0.25;
      this.master.connect(squash).connect(ctx.destination);
      this.voices = 0;
      const len = ctx.sampleRate * 2;
      this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      this.crackleTail = this.makeCrackle(2.6, (t) => 70 * (1 - t) ** 1.6 + 4);
      this.crackleBed = this.makeCrackle(4, () => 16);
      this.startBeds();
      this.loadDefaults();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  // Fetch and decode the built-in samples (quietly skipping any that fail).
  async loadDefaults() {
    const ctx = this.ctx;
    for (const [event, names] of Object.entries(DEFAULT_SAMPLES)) {
      const bufs = [];
      for (const n of names) {
        for (const ext of ['ogg', 'mp3']) {        // e.g. Safari without Opus: try the mp3
          try {
            const r = await fetch(new URL(`../sfx/${n}.${ext}`, import.meta.url));
            if (!r.ok) continue;
            bufs.push(await ctx.decodeAudioData(await r.arrayBuffer()));
            break;
          } catch { /* try the next */ }
        }
      }
      if (bufs.length) this.defaults[event] = bufs;
    }
  }

  // A buffer of sparse, tiny noise ticks: fire crackling. `density(t)` is ticks
  // a second at fraction t of the way through.
  makeCrackle(seconds, density) {
    const ctx = this.ctx, sr = ctx.sampleRate;
    const len = Math.floor(sr * seconds);
    const buf = ctx.createBuffer(1, len, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) {
      if (Math.random() >= density(i / len) / sr) continue;
      const amp = 0.25 + Math.random() * 0.75, n = Math.floor(sr * (0.002 + Math.random() * 0.007));
      for (let j = 0; j < n && i + j < len; j++) d[i + j] += (Math.random() * 2 - 1) * amp * Math.exp(-j / (n * 0.3));
    }
    return buf;
  }

  // Nothing would be heard: skip making the voices.
  get silent() { return this.muted || this.fxMuted || this.volume === 0 || this.fxVolume === 0; }

  level() { return this.muted ? 0 : this.volume * 0.8; }
  fxLevel() { return this.fxMuted ? 0 : this.fxVolume; }

  apply() {
    const t = this.ctx?.currentTime ?? 0;
    this.master?.gain.setTargetAtTime(this.level(), t, 0.03);
    this.fx?.gain.setTargetAtTime(this.fxLevel(), t, 0.03);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    saveLevel(MASTER_KEY, this.volume);
    this.apply();
  }

  toggleMute() {
    this.muted = !this.muted;
    this.apply();
    return this.muted;
  }

  setFxVolume(v) {
    this.fxVolume = Math.max(0, Math.min(1, v));
    saveLevel(FX_KEY, this.fxVolume);
    this.apply();
  }

  toggleFx() {
    this.fxMuted = !this.fxMuted;
    saveLevel(FX_MUTE_KEY, this.fxMuted ? 1 : 0);
    this.apply();
    return this.fxMuted;
  }

  // ---- beds ----

  loopNoise(type, freq, q) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = type;
    filter.frequency.value = freq;
    filter.Q.value = q;
    const gain = ctx.createGain();
    gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.fx);
    src.start(0, Math.random());
    return { filter, gain };
  }

  startBeds() {
    const ctx = this.ctx;
    this.wind = this.loopNoise('lowpass', 320, 0.4);
    this.gust = this.loopNoise('bandpass', 700, 1.2);
    this.whistle = this.loopNoise('bandpass', 1800, 14);
    // Engine: two detuned saws through a low-pass, off until a tank drives.
    const eg = ctx.createGain();
    eg.gain.value = 0;
    const ef = ctx.createBiquadFilter();
    ef.type = 'lowpass';
    ef.frequency.value = 220;
    const oscs = [48, 72.5].map((f) => {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = f;
      o.connect(ef);
      o.start();
      return o;
    });
    ef.connect(eg).connect(this.fx);
    this.engine = { gain: eg, filter: ef, oscs };
    // Fire: a loop of crackles over a faint hiss, silent until something burns near.
    const cs = ctx.createBufferSource();
    cs.buffer = this.crackleBed;
    cs.loop = true;
    const ch = ctx.createBiquadFilter();
    ch.type = 'highpass';
    ch.frequency.value = 900;
    const cg = ctx.createGain();
    cg.gain.value = 0;
    cs.connect(ch).connect(cg).connect(this.fx);
    cs.start(0, Math.random() * 3);
    this.fireBed = { gain: cg, hiss: this.loopNoise('bandpass', 2600, 0.7), next: 0 };
    // Rain: a soft high hiss of drops over a low wash, silent until it rains.
    this.rainBed = { hiss: this.loopNoise('highpass', 1700, 0.3), wash: this.loopNoise('lowpass', 520, 0.5), loop: null };
    // The City: a low rumble of distant traffic and a murmur over it, silent elsewhere.
    this.cityBed = { rumble: this.loopNoise('lowpass', 140, 0.7), murmur: this.loopNoise('bandpass', 480, 0.8) };
  }

  // A sample chosen for 'rain' in the pack review loops in place of the synth
  // bed; `level` 0..1. The loop restarts when a different sample is chosen.
  rainLoop(level) {
    const takes = this.samples.rain;
    const bed = this.rainBed;
    const buffer = takes?.length ? takes[0] : null;
    if (bed.loop && (bed.loop.buffer !== buffer || level <= 0.001)) {
      const old = bed.loop;
      old.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.3);
      setTimeout(() => { try { old.src.stop(); } catch { /* already stopped */ } }, 1500);
      bed.loop = null;
    }
    if (!buffer || level <= 0.001) return false;
    if (!bed.loop) {
      const src = this.ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const gain = this.ctx.createGain();
      gain.gain.value = 0;
      src.connect(gain).connect(this.fx);
      src.start(0, Math.random() * Math.max(0, buffer.duration - 0.1));
      bed.loop = { src, gain, buffer };
    }
    bed.loop.gain.gain.setTargetAtTime(level * 0.45 * this.sampleLevel, this.ctx.currentTime, 0.4);
    return true;
  }

  // Called every frame.
  //   wind      strength, 0..~4
  //   driving   0..1, how hard a tank near the camera is working
  //   shell     null, or { dist, falling } for the shell in flight
  //   birds / sheep   distance from the camera to the nearest, or Infinity
  //   fire      0..~1.5, how much is burning near the camera
  //   rain      0..1, how hard it is raining (render/rain.js amount)
  //   city      0..1, how much of the City's hum to play (0 elsewhere)
  update(dt, { wind = 0, driving = 0, shell = null, birds = Infinity, sheep = Infinity, fire = 0, rain = 0, city = 0 } = {}) {
    const ctx = this.ctx;
    if (!ctx || ctx.state !== 'running') return;
    const t = ctx.currentTime;
    const ease = (param, v, tc = 0.25) => param.setTargetAtTime(v, t, tc);
    const breath = 0.75 + 0.25 * Math.sin(t * 0.37) * Math.sin(t * 0.83 + 1);
    ease(this.wind.gain.gain, (0.035 + Math.min(1, wind / 3) * 0.16) * breath, 0.6);
    ease(this.wind.filter.frequency, 260 + wind * 150, 0.6);
    ease(this.gust.gain.gain, Math.min(1, wind / 3) * 0.05 * (0.5 + 0.5 * Math.sin(t * 0.21)), 0.8);
    ease(this.gust.filter.frequency, 600 + 250 * Math.sin(t * 0.13), 0.8);

    ease(this.engine.gain.gain, driving * 0.16, 0.12);
    ease(this.engine.filter.frequency, 180 + driving * 260, 0.15);
    this.engine.oscs[0].frequency.setTargetAtTime(44 + driving * 16, t, 0.2);
    this.engine.oscs[1].frequency.setTargetAtTime(66.5 + driving * 24, t, 0.2);

    // A shell whistles on the way down, louder the nearer it passes.
    const near = shell ? 1 / (1 + shell.dist / 140) : 0;
    ease(this.whistle.gain.gain, shell ? near * (0.05 + 0.2 * shell.falling) : 0, 0.1);
    if (shell) ease(this.whistle.filter.frequency, 2300 - 1100 * shell.falling, 0.15);

    // Fire crackle: quiet, so it sits under everything else. A sample chosen
    // for 'crackle' stands in for the synthesised bed.
    const level = Math.min(1, fire);
    const own = this.samples.crackle?.length;
    ease(this.fireBed.gain.gain, own ? 0 : level * 0.075, 0.4);
    ease(this.fireBed.hiss.gain.gain, level * 0.012, 0.5);
    if (own && level > 0.05 && (this.fireBed.next -= dt) <= 0) {
      this.fireBed.next = (0.3 + Math.random() * 0.6) / level;
      this.sample('crackle', 0, { gain: 0.18 * level });
    }

    // Rain: quiet, with a slow swell so it never sits flat. A pack sample
    // chosen for 'rain' replaces it.
    const wetOwn = this.rainLoop(rain) && this.samplesMode === 'replace';
    const swell = 0.85 + 0.15 * Math.sin(t * 0.29) * Math.sin(t * 0.61 + 2);
    ease(this.rainBed.hiss.gain.gain, wetOwn ? 0 : rain * 0.05 * swell, 0.5);
    ease(this.rainBed.wash.gain.gain, wetOwn ? 0 : rain * 0.035, 0.6);

    // The City hums, well under everything else, and now and then a horn goes far off.
    const hum = 0.8 + 0.2 * Math.sin(t * 0.17) * Math.sin(t * 0.43 + 1);
    ease(this.cityBed.rumble.gain.gain, city * 0.05 * hum, 1);
    ease(this.cityBed.murmur.gain.gain, city * 0.012 * hum, 1);
    if ((this.nextHorn -= dt) <= 0) {
      this.nextHorn = 7 + Math.random() * 16;
      if (city > 0) this.horn(city);
    }

    if ((this.nextChirp -= dt) <= 0) {
      this.nextChirp = 3 + Math.random() * 7;
      if (birds < 500) this.chirp(1 / (1 + birds / 90));
    }
    if ((this.nextBleat -= dt) <= 0) {
      this.nextBleat = 9 + Math.random() * 14;
      if (sheep < 320) this.bleat(1 / (1 + sheep / 70));
    }
  }

  // ---- one-shots ----

  // A burst of filtered noise, optionally with a low sine thump under it.
  burst({ dur, freq, q = 0.7, gain = 1, sweepTo = null, thump = 0, type = 'lowpass', delay = 0, cutoff = 0 }) {
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    if (this.voices >= MAX_VOICES || (this.voices >= MAX_VOICES / 2 && gain < 0.3)) return;
    this.voices++;
    const t = ctx.currentTime + delay;
    let out = this.fx;
    if (cutoff) {
      // Distance: everything in this burst goes through one more low-pass.
      out = ctx.createBiquadFilter();
      out.type = 'lowpass';
      out.frequency.value = cutoff;
      out.connect(this.fx);
    }
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(out);
    src.start(t, Math.random());
    src.stop(t + dur);
    src.onended = () => { this.voices--; };
    if (thump) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.setValueAtTime(thump, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
      og.gain.setValueAtTime(gain * 0.9, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(og).connect(out);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  // How a sound `dist` metres from the camera arrives: quieter and duller.
  far(dist = 0) {
    return {
      k: 1 / (1 + dist / 260),
      cutoff: dist > 40 ? Math.max(260, 9000 * Math.exp(-dist / 260)) : 0,
    };
  }

  // Cannon: a sharp crack on top, a chest thump under it, a short tail.
  fire(dist = 0, wait = 0) {
    this.sample('whoosh', dist, { gain: 0.35, delay: wait + 0.06 });
    if (this.sample('fire', dist, { gain: 0.85, delay: wait })) return;
    const { k, cutoff } = this.far(dist);
    const delay = wait;
    this.burst({ dur: 0.07, freq: 3200, q: 0.9, type: 'bandpass', gain: 0.75 * k, delay, cutoff });
    this.burst({ dur: 0.5, freq: 1900, sweepTo: 180, gain: 0.6 * k, thump: 130, delay, cutoff });
    this.burst({ dur: 1.1, freq: 420, sweepTo: 90, gain: 0.22 * k, delay: delay + 0.05, cutoff });
    // The sub-bass punch in the chest, and the barrel's ringing tail.
    this.sub({ from: 80, to: 34, dur: 0.5, gain: 0.28 * Math.max(k, 1 / (1 + dist / 600)), delay, cutoff });
    this.tail({ gain: 0.05 * k, delay: delay + 0.12, cutoff, speed: 1.6 });
  }

  // A low sine that drops in pitch: the part of a blast you feel more than hear.
  // Bass carries far, so callers keep this louder at range than the rest.
  sub({ from, to, dur, gain, delay = 0, cutoff = 0 }) {
    const ctx = this.ensure();
    if (!ctx || this.silent || gain <= 0.001) return;
    const t = ctx.currentTime + delay;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(from, t);
    o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    let out = this.fx;
    if (cutoff) {
      out = ctx.createBiquadFilter();
      out.type = 'lowpass';
      out.frequency.value = Math.max(cutoff, 160);     // never so dull the bass goes
      out.connect(this.fx);
    }
    o.connect(g).connect(out);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  // The crackle of a blast dying away: a handful of tiny ticks thinning out.
  // `speed` > 1 plays it faster (shorter, higher).
  tail({ gain, delay = 0, cutoff = 0, speed = 1 }) {
    const ctx = this.ensure();
    if (!ctx || this.silent || gain <= 0.001) return;
    const t = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.crackleTail;
    src.playbackRate.value = speed * (0.9 + Math.random() * 0.2);
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 600;
    const g = ctx.createGain();
    g.gain.value = gain;
    let out = this.fx;
    if (cutoff) {
      out = ctx.createBiquadFilter();
      out.type = 'lowpass';
      out.frequency.value = cutoff;
      out.connect(this.fx);
    }
    src.connect(hp).connect(g).connect(out);
    src.start(t, Math.random() * 0.1);
  }

  // The patter of earth and bits coming back down after a big blast, a
  // second or so on. Softer and sparser the farther away.
  debris(radius, dist = 0) {
    if (this.silent || radius < 9 || dist > 450) return;
    const { k, cutoff } = this.far(dist);
    const n = Math.min(7, Math.round(2 + radius * 0.25));
    for (let i = 0; i < n; i++) {
      const delay = 0.55 + Math.random() * (0.5 + radius * 0.05) + i * 0.07;
      const gain = (0.1 + Math.random() * 0.1) * Math.max(k, 0.25);
      if (!this.sample('debris', dist, { gain, delay, rate: 0.85 + Math.random() * 0.5 })) {
        this.burst({ dur: 0.05 + Math.random() * 0.06, freq: 700 + Math.random() * 1800, q: 1.4, type: 'bandpass', gain: gain * 0.8, delay, cutoff });
      }
    }
  }

  // A burst of crackling: the test for the crackle sound, and what a sample
  // chosen for it plays.
  crackle(dist = 0, gain = 0.3) {
    if (this.sample('crackle', dist, { gain })) return;
    this.tail({ gain: gain * 0.4, speed: 0.8 });
  }

  explode(radius = 10, dist = 0) {
    // A recorded blast by size, or a far-off one (already muffled, so it gets
    // only half the distance treatment).
    const far = dist > 320 && this.samples['explode-far'];
    const size = radius < 9 ? 'explode-small' : radius < 16 ? 'explode-medium' : 'explode-big';
    const s = Math.min(1.6, radius / 12);
    // Extra body under any blast, recorded or not: a deep thump, then the
    // patter of debris coming down.
    if (radius >= 8) this.sample('thump', dist, { gain: 0.35 + 0.25 * s, rate: 0.7 - 0.1 * Math.min(1, s) });
    this.debris(radius, dist);
    if (far ? this.sample('explode-far', dist / 2, { gain: 0.9 }) : this.sample(size, dist, { gain: 0.7 + Math.min(0.3, radius / 60) })) return;
    const { k, cutoff } = this.far(dist);
    // Far blasts are muffled twice over: the air takes the highs, and the
    // distant ones roll in as a dull boom with little crack.
    const dull = dist > 150 ? 0.55 : 1;
    const body = cutoff ? cutoff * dull : 0;
    // A sharp crack on top at any range: without it a far, muffled blast has a
    // soft start, and a soft start sounds late.
    this.burst({ dur: 0.1, freq: 2200, q: 0.8, type: 'bandpass', gain: 0.45 * Math.max(k, 0.35) * (dist > 320 ? 0.7 : 1), cutoff: dist > 150 ? Math.max(900, cutoff * 1.5) : 0 });
    this.burst({ dur: 1.0 + s, freq: 1400, sweepTo: 80, gain: (0.6 + s * 0.4) * k, thump: 70, cutoff: body });
    // The sub-bass boom: it carries, so it falls off slower than the rest.
    this.sub({ from: 105, to: 27, dur: 0.9 + 0.9 * s, gain: (0.3 + 0.25 * s) * Math.max(k, 1 / (1 + dist / 700)), cutoff: body });
    // The rumble that rolls back off the hills, and the crackle of it dying.
    this.burst({ dur: 1.8 + s, freq: 240, sweepTo: 60, gain: 0.2 * k * s, delay: 0.35, cutoff: body ? Math.min(body, 500) : 500 });
    this.tail({ gain: 0.12 * k * s, delay: 0.2 + 0.1 * s, cutoff: body ? Math.min(body * 1.2, 5000) : 0, speed: 1 / (0.8 + 0.3 * s) });
  }

  // `kind`: 'impact' (shells rolling, mounds, landings, props) or 'wreck' (parts of a dead tank).
  thud(dist = 0, kind = 'impact') {
    if (this.sample(kind, dist, { gain: 0.55 })) return;
    const { k, cutoff } = this.far(dist);
    this.burst({ dur: 0.25, freq: 400, gain: 0.5 * k, thump: 60, cutoff });
  }

  // Jump jets lighting: a rising hiss that dies away as the tank climbs.
  jet(dist = 0) {
    if (this.sample('jet', dist, { gain: 0.5 })) return;
    const { k, cutoff } = this.far(dist);
    this.burst({ dur: 0.9, freq: 700, sweepTo: 2600, q: 0.6, type: 'bandpass', gain: 0.5 * k, thump: 90, cutoff });
  }

  // A Teleport: a quick bright sweep up, then a soft thump where it arrives.
  warp(dist = 0) {
    if (this.sample('warp', dist, { gain: 0.45 })) return;
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    const { k } = this.far(dist);
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.setValueAtTime(380, t);
    o.frequency.exponentialRampToValueAtTime(2400, t + 0.22);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.22 * Math.max(0.3, k), t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
    o.connect(g).connect(this.fx);
    o.start(t);
    o.stop(t + 0.35);
  }

  // A rangefinder probe touching down: a short, soft ping.
  ping(dist = 0) {
    if (this.sample('ping', dist, { gain: 0.3 })) return;
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    const t = ctx.currentTime;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.setValueAtTime(1500, t);
    o.frequency.exponentialRampToValueAtTime(1100, t + 0.18);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.16 * Math.max(0.35, this.far(dist).k), t + 0.005);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.22);
    o.connect(g).connect(this.fx);
    o.start(t);
    o.stop(t + 0.25);
  }

  click() { if (!this.sample('click', 0, { gain: 0.3 })) this.burst({ dur: 0.05, freq: 5000, gain: 0.15 }); }

  // A shell striking a tank: recorded only (the blast covers it otherwise).
  hit(dist = 0) { this.sample('hit', dist, { gain: 0.5 }); }

  // Two or three quick falling-then-rising notes.
  chirp(k = 1) {
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    const base = 2600 + Math.random() * 1500;
    const notes = 2 + Math.floor(Math.random() * 3);
    for (let i = 0; i < notes; i++) {
      const t = ctx.currentTime + i * (0.09 + Math.random() * 0.05);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.type = 'sine';
      o.frequency.setValueAtTime(base * (1 + Math.random() * 0.25), t);
      o.frequency.exponentialRampToValueAtTime(base * (0.75 + Math.random() * 0.6), t + 0.07);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.05 * k, t + 0.012);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g).connect(this.fx);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  // A car horn a few streets away: two notes together, a toot or two.
  horn(k = 1) {
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    const base = 330 + Math.random() * 120;
    const toots = Math.random() < 0.4 ? 2 : 1;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    const g = ctx.createGain();
    g.gain.value = 0;
    f.connect(g).connect(this.fx);
    const t0 = ctx.currentTime;
    let end = t0;
    for (let i = 0; i < toots; i++) {
      const t = t0 + i * 0.32;
      const dur = toots > 1 ? 0.18 : 0.3 + Math.random() * 0.35;
      g.gain.setTargetAtTime(0.022 * k, t, 0.01);
      g.gain.setTargetAtTime(0, t + dur, 0.03);
      end = t + dur + 0.2;
    }
    const oscs = [base, base * 1.26].map((fr) => {
      const o = ctx.createOscillator();
      o.type = 'square';
      o.frequency.value = fr;
      o.connect(f);
      o.start(t0);
      o.stop(end);
      return o;
    });
    oscs[0].onended = () => g.disconnect();
  }

  // A wobbly nasal "baa".
  bleat(k = 1) {
    const ctx = this.ensure();
    if (!ctx || this.silent) return;
    const t = ctx.currentTime;
    const dur = 0.45 + Math.random() * 0.25;
    const pitch = 300 + Math.random() * 90;
    const o = ctx.createOscillator();
    o.type = 'sawtooth';
    o.frequency.setValueAtTime(pitch * 1.06, t);
    o.frequency.linearRampToValueAtTime(pitch * 0.92, t + dur);
    const wobble = ctx.createOscillator();
    wobble.frequency.value = 9;
    const depth = ctx.createGain();
    depth.gain.value = pitch * 0.06;
    wobble.connect(depth).connect(o.frequency);
    const f = ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 1100;
    f.Q.value = 1.6;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.09 * k, t + 0.05);
    g.gain.setValueAtTime(0.09 * k, t + dur * 0.7);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(f).connect(g).connect(this.fx);
    o.start(t); wobble.start(t);
    o.stop(t + dur + 0.02); wobble.stop(t + dur + 0.02);
  }
}
