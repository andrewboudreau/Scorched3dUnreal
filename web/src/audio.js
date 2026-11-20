// Synthesised sound, no assets. One-shots (cannon, blasts, ticks, chirps,
// bleats) plus three quiet beds that `update` keeps in step with the game:
// wind, a shell's whistle and the engine. Everything goes through `master`,
// so the volume slider and M reach all of it.

const VOLUME_KEY = 'craterfall.volume';
const SOUND_SPEED = 340;   // m/s, for the delay on a distant blast
const MAX_VOICES = 14;     // noise bursts sounding at once; quiet ones are dropped past this

export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
    const saved = Number(globalThis.localStorage?.getItem(VOLUME_KEY));
    this.volume = saved > 0 && saved <= 1 ? saved : 0.6;
    this.nextChirp = 4;
    this.nextBleat = 9;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      const ctx = this.ctx = new AC();
      this.master = ctx.createGain();
      this.master.gain.value = this.level();
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
      this.startBeds();
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  level() { return this.muted ? 0 : this.volume * 0.8; }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { globalThis.localStorage?.setItem(VOLUME_KEY, String(this.volume)); } catch { /* private mode */ }
    if (this.master) this.master.gain.value = this.level();
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.level();
    return this.muted;
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
    src.connect(filter).connect(gain).connect(this.master);
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
    ef.connect(eg).connect(this.master);
    this.engine = { gain: eg, filter: ef, oscs };
  }

  // Called every frame.
  //   wind      strength, 0..~4
  //   driving   0..1, how hard a tank near the camera is working
  //   shell     null, or { dist, falling } for the shell in flight
  //   birds / sheep   distance from the camera to the nearest, or Infinity
  update(dt, { wind = 0, driving = 0, shell = null, birds = Infinity, sheep = Infinity } = {}) {
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
    if (!ctx || this.muted) return;
    if (this.voices >= MAX_VOICES || (this.voices >= MAX_VOICES / 2 && gain < 0.3)) return;
    this.voices++;
    const t = ctx.currentTime + delay;
    let out = this.master;
    if (cutoff) {
      // Distance: everything in this burst goes through one more low-pass.
      out = ctx.createBiquadFilter();
      out.type = 'lowpass';
      out.frequency.value = cutoff;
      out.connect(this.master);
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

  // How a sound `dist` metres from the camera arrives: quieter, duller, later.
  far(dist = 0) {
    return {
      k: 1 / (1 + dist / 260),
      cutoff: dist > 40 ? Math.max(260, 9000 * Math.exp(-dist / 260)) : 0,
      delay: Math.min(1.3, dist / SOUND_SPEED),
    };
  }

  // Cannon: a sharp crack on top, a chest thump under it, a short tail.
  fire(dist = 0, wait = 0) {
    const { k, cutoff, delay: travel } = this.far(dist);
    const delay = travel + wait;
    this.burst({ dur: 0.07, freq: 3200, q: 0.9, type: 'bandpass', gain: 0.75 * k, delay, cutoff });
    this.burst({ dur: 0.5, freq: 1900, sweepTo: 180, gain: 0.6 * k, thump: 130, delay, cutoff });
    this.burst({ dur: 1.1, freq: 420, sweepTo: 90, gain: 0.22 * k, delay: delay + 0.05, cutoff });
  }

  explode(radius = 10, dist = 0) {
    const s = Math.min(1.6, radius / 12);
    const { k, cutoff, delay } = this.far(dist);
    this.burst({ dur: 1.0 + s, freq: 1400, sweepTo: 80, gain: (0.6 + s * 0.4) * k, thump: 70, delay, cutoff });
    if (dist < 220) this.burst({ dur: 0.12, freq: 2600, q: 0.8, type: 'bandpass', gain: 0.4 * k, delay });
    // The rumble that rolls back off the hills.
    this.burst({ dur: 1.8 + s, freq: 240, sweepTo: 60, gain: 0.2 * k * s, delay: delay + 0.35, cutoff: cutoff ? Math.min(cutoff, 500) : 500 });
  }

  thud(dist = 0) {
    const { k, cutoff, delay } = this.far(dist);
    this.burst({ dur: 0.25, freq: 400, gain: 0.5 * k, thump: 60, delay, cutoff });
  }

  click() { this.burst({ dur: 0.05, freq: 5000, gain: 0.15 }); }

  // Two or three quick falling-then-rising notes.
  chirp(k = 1) {
    const ctx = this.ensure();
    if (!ctx || this.muted) return;
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
      o.connect(g).connect(this.master);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  // A wobbly nasal "baa".
  bleat(k = 1) {
    const ctx = this.ensure();
    if (!ctx || this.muted) return;
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
    o.connect(f).connect(g).connect(this.master);
    o.start(t); wobble.start(t);
    o.stop(t + dur + 0.02); wobble.stop(t + dur + 0.02);
  }
}
