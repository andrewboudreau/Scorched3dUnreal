// The soundtrack: a small step sequencer playing a handful of synth voices,
// no audio files. Each track is a key, a chord progression and a `play`
// function that is asked, sixteenth by sixteenth, what to sound. Notes are
// scheduled a little ahead on the audio clock, so timing does not depend on
// the frame rate. It plays into Sound's master, so M and Master reach it;
// it has its own level and mute on top. In the kill cam the music closes down to a
// muffled low-pass along with the slow motion.

const TRACK_KEY = 'craterfall.music';
const LEVEL_KEY = 'craterfall.musicVolume';
const MUTE_KEY = 'craterfall.musicMuted';
const AHEAD = 0.25;            // seconds of notes scheduled ahead of the clock

const SCALES = {
  minor: [0, 2, 3, 5, 7, 8, 10],
  harmonic: [0, 2, 3, 5, 7, 8, 11],
  major: [0, 2, 4, 5, 7, 9, 11],
};
const mtof = (m) => 440 * Math.pow(2, (m - 69) / 12);

// `gain` evens out how loud the tracks sound. Track `play(m, s, t, bar, c, sd)`: s is the sixteenth in the bar (0..15),
// t its time, c the bar's chord (c.tone(i, oct) is its i-th chord tone,
// c.step(d, oct) the scale step d above its root), sd one sixteenth in seconds.
export const TRACKS = [
  { id: 'off', name: 'Off' },
  {
    id: 'outpost', name: 'Outpost', mood: 'calm',
    bpm: 72, root: 50, scale: 'minor', prog: [0, 5, 2, 6],
    play(m, s, t, bar, c, sd) {
      if (s === 0) {
        m.pad(t, [c.tone(0), c.tone(1), c.tone(2)], sd * 16, 0.04);
        m.voice(t, c.tone(0, -1), sd * 10, { type: 'sine', gain: 0.17, attack: 0.06, release: 0.7, cutoff: 420 });
      }
      if (s === 10) m.voice(t, c.step(4, -1), sd * 5, { type: 'sine', gain: 0.12, attack: 0.04, release: 0.5, cutoff: 420 });
      if (s % 2 === 0 && m.rand(bar % 8, s) < 0.6) {
        const i = [0, 1, 2, 3, 1, 2, 4, 2][s / 2];
        m.voice(t, c.tone(i, 1), 0.02, { type: 'triangle', gain: 0.07, release: 0.55, cutoff: 2600, cutoffTo: 500, echo: 0.5, verb: 0.35 });
      }
      if (s === 4 || s === 12) m.hat(t, 0.012);
    },
  },
  {
    id: 'march', name: 'Artillery March', mood: 'martial',
    bpm: 100, gain: 1.45, root: 45, scale: 'harmonic', prog: [0, 0, 3, 4, 0, 5, 3, 4],
    play(m, s, t, bar, c, sd) {
      const roll = [1, 0, 0, 0.4, 1, 0, 0.5, 0.5, 1, 0, 0, 0.4, 1, 0.35, 0.6, 0.8][s];
      if (roll) m.snare(t, 0.1 * roll, 0.5);
      if (s === 0 || s === 8) m.kick(t, 0.45);
      if (s % 4 === 0) {
        m.voice(t, s % 8 === 0 ? c.tone(0) : c.tone(2, -1), sd * 3,
          { type: 'sawtooth', gain: 0.12, attack: 0.01, release: 0.12, cutoff: 520, cutoffTo: 240 });
      }
      const tune = bar % 2 === 0
        ? [0, null, null, 0, 2, null, 4, null, 4, null, null, 2, 1, null, 0, null]
        : [4, null, null, 4, 5, null, 4, null, 2, null, null, null, 0, null, null, null];
      const d = tune[s];
      if (d != null) {
        m.voice(t, c.step(d, 1), sd * 1.7, {
          type: [['sawtooth', -6], ['sawtooth', 6]], gain: 0.045, attack: 0.03, release: 0.16,
          cutoff: 1500, cutoffTo: 800, verb: 0.35,
        });
      }
    },
  },
  {
    id: 'bunker', name: 'Bunker Lo-fi', mood: 'mellow',
    bpm: 78, swing: 0.22, root: 53, scale: 'major', prog: [0, 5, 1, 4],
    play(m, s, t, bar, c, sd) {
      if (s === 0 || s === 7) {
        for (let i = 0; i < 4; i++) {
          m.voice(t + i * 0.012, c.tone(i), sd * (s === 0 ? 5 : 3), {
            type: [['sine', 0], ['triangle', 0, 1]], gain: 0.032, attack: 0.01, release: 0.5,
            cutoff: 1800, cutoffTo: 900, verb: 0.4,
          });
        }
      }
      if (s === 0 || s === 6 || s === 8) m.voice(t, c.tone(0, -1), sd * (s === 6 ? 1.5 : 3), { type: 'sine', gain: 0.2, attack: 0.01, release: 0.15, cutoff: 320 });
      if (s === 0 || s === 10) m.kick(t, 0.32);
      if (s === 4 || s === 12) m.snare(t, 0.055, 0.15, 1300);
      if (s % 2 === 0) m.hat(t, s % 4 === 2 ? 0.018 : 0.01);
      if (m.rand(bar * 31 + s, 7) < 0.2) m.crackle(t);
      if ((s === 3 || s === 11 || s === 14) && m.rand(bar % 4, s) < 0.5) {
        m.voice(t, c.tone(Math.floor(m.rand(bar % 4, s + 1) * 4), 1), sd * 2,
          { type: 'sine', gain: 0.04, attack: 0.01, release: 0.6, cutoff: 3000, echo: 0.4, verb: 0.3 });
      }
    },
  },
  {
    id: 'barrage', name: 'Barrage', mood: 'chiptune',
    bpm: 140, gain: 1.25, root: 52, scale: 'minor', prog: [0, 5, 6, 4],
    play(m, s, t, bar, c, sd) {
      const arp = [0, 1, 2, 3, 2, 1, 0, 1, 0, 1, 2, 3, 4, 3, 2, 1][s];
      m.voice(t, c.tone(arp, 1), sd * 0.6, { type: 'square', gain: 0.026, attack: 0.002, release: 0.04, cutoff: 5000 });
      if (s % 2 === 0) m.voice(t, c.tone(0, s % 4 ? 0 : -1), sd * 0.9, { type: 'triangle', gain: 0.16, attack: 0.002, release: 0.05, cutoff: 3000 });
      if (s === 0 || s === 8 || s === 11) m.kick(t, 0.38);
      if (s === 4 || s === 12) m.snare(t, 0.075, 0.1);
      m.hat(t, s % 2 ? 0.005 : 0.011);
      if (bar % 4 >= 2 && s % 2 === 0 && m.rand(bar % 8, s) < 0.6) {
        m.voice(t, c.step(Math.floor(m.rand(bar % 8, s + 50) * 7), 2), sd * 1.8,
          { type: [['square', 0], ['square', 7]], gain: 0.022, attack: 0.005, release: 0.08, cutoff: 4000, echo: 0.3 });
      }
    },
  },
];
export const TRACK_BY_ID = Object.fromEntries(TRACKS.map((t) => [t.id, t]));

export class Music {
  constructor(sound) {
    this.sound = sound;
    const ls = globalThis.localStorage;
    const saved = ls?.getItem(TRACK_KEY);
    this.trackId = TRACK_BY_ID[saved] ? saved : 'outpost';
    const level = Number(ls?.getItem(LEVEL_KEY));
    this.volume = ls?.getItem(LEVEL_KEY) != null && level >= 0 && level <= 1 ? level : 0.5;
    this.muted = ls?.getItem(MUTE_KEY) === '1';
    this.ctx = null;
    this.cur = null;
    this.slow = 1;
  }

  get track() { return TRACK_BY_ID[this.trackId]; }

  // Hook up once Sound has an audio context (after the first click or key).
  attach() {
    const ctx = this.ctx = this.sound.ctx;
    this.out = ctx.createGain();
    this.out.gain.value = this.level();
    this.muffle = ctx.createBiquadFilter();
    this.muffle.type = 'lowpass';
    this.muffle.frequency.value = 18000;
    this.out.connect(this.muffle).connect(this.sound.master);

    // A short room for pads and leads.
    this.verbIn = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = this.impulse(2.2);
    const verbOut = ctx.createGain();
    verbOut.gain.value = 0.4;
    this.verbIn.connect(verb).connect(verbOut).connect(this.out);

    // A dotted-eighth-ish echo, darker on every repeat.
    this.echoIn = ctx.createGain();
    this.echo = ctx.createDelay(1.5);
    const fb = ctx.createGain();
    fb.gain.value = 0.33;
    const dark = ctx.createBiquadFilter();
    dark.type = 'lowpass';
    dark.frequency.value = 2400;
    this.echoIn.connect(this.echo).connect(dark).connect(fb).connect(this.echo);
    const echoOut = ctx.createGain();
    echoOut.gain.value = 0.45;
    dark.connect(echoOut).connect(this.out);

    const len = ctx.sampleRate;
    this.noise = ctx.createBuffer(1, len, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;

    // A timer rather than the frame loop, so the music keeps time while the
    // frame rate dips.
    this.timer = setInterval(() => this.pump(), 40);
    this.play(this.trackId);
  }

  impulse(secs) {
    const ctx = this.ctx;
    const n = Math.floor(ctx.sampleRate * secs);
    const b = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / n, 3.2);
    }
    return b;
  }

  // Under Master since the split (it used to sit under the one shared level).
  level() { return this.muted ? 0 : this.volume * 0.3; }

  toggleMute() {
    this.muted = !this.muted;
    try { globalThis.localStorage?.setItem(MUTE_KEY, this.muted ? '1' : '0'); } catch { /* private mode */ }
    if (this.out) this.out.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
    return this.muted;
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    try { globalThis.localStorage?.setItem(LEVEL_KEY, String(this.volume)); } catch { /* private mode */ }
    if (this.out) this.out.gain.setTargetAtTime(this.level(), this.ctx.currentTime, 0.05);
  }

  // Switch tracks, fading the old one out over a second.
  select(id) {
    if (!TRACK_BY_ID[id]) return;
    this.trackId = id;
    try { globalThis.localStorage?.setItem(TRACK_KEY, id); } catch { /* private mode */ }
    if (this.ctx) this.play(id);
  }

  next() {
    const i = TRACKS.findIndex((t) => t.id === this.trackId);
    this.select(TRACKS[(i + 1) % TRACKS.length].id);
    return this.track;
  }

  play(id) {
    const ctx = this.ctx;
    const now = ctx.currentTime;
    if (this.cur) {
      const old = this.cur.bus;
      old.gain.setTargetAtTime(0, now, 0.3);
      setTimeout(() => old.disconnect(), 2500);
      this.cur = null;
    }
    const track = TRACK_BY_ID[id];
    if (!track.play) return;
    const bus = ctx.createGain();
    bus.gain.setValueAtTime(0, now);
    bus.gain.linearRampToValueAtTime(track.gain || 1, now + 1.2);
    bus.connect(this.out);
    this.echo.delayTime.setValueAtTime(Math.min(1.4, (60 / track.bpm) * 0.75), now);
    this.cur = { track, bus, step: 0, next: now + 0.1 };
  }

  // Called every frame with the game's time scale (1, or less in the kill cam).
  update(dt, slow = 1) {
    if (!this.ctx) {
      if (this.sound.ctx) this.attach();
      else return;
    }
    const k = Math.max(0, Math.min(1, (slow - 0.28) / 0.72));
    this.muffle.frequency.setTargetAtTime(650 * Math.pow(28, k), this.ctx.currentTime, 0.12);
  }

  pump() {
    const ctx = this.ctx;
    const cur = this.cur;
    if (!ctx || ctx.state !== 'running' || !cur) return;
    // Back from a hidden tab: pick up from now instead of rushing the backlog.
    if (cur.next < ctx.currentTime - 0.1) cur.next = ctx.currentTime + 0.05;
    const tr = cur.track;
    const sd = 60 / tr.bpm / 4;
    while (cur.next < ctx.currentTime + AHEAD) {
      const s = cur.step % 16;
      const bar = Math.floor(cur.step / 16);
      const t = cur.next + (s % 2 ? (tr.swing || 0) * sd : 0);
      this.bus = cur.bus;
      tr.play(this, s, t, bar, this.chord(tr, tr.prog[bar % tr.prog.length]), sd);
      cur.step++;
      cur.next += sd;
    }
  }

  chord(tr, deg) {
    const sc = SCALES[tr.scale];
    const n = (d) => tr.root + 12 * Math.floor(d / 7) + sc[((d % 7) + 7) % 7];
    return {
      tone: (i, oct = 0) => n(deg + 2 * i) + 12 * oct,
      step: (d, oct = 0) => n(deg + d) + 12 * oct,
    };
  }

  // A repeatable 0..1 for (a, b), so a track's "random" figures come back
  // the same every time round the loop.
  rand(a, b) {
    let h = Math.imul(a + 1, 374761393) ^ Math.imul(b + 7, 668265263);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  }

  // ---- voices ----

  // One note: oscillators (type, or [[type, cents, octave], ...]) through a
  // low-pass, with an attack, a hold of `dur` and a release.
  voice(t, midi, dur, { type = 'triangle', gain = 0.1, attack = 0.005, release = 0.2, cutoff = 4000, cutoffTo = null, q = 0.7, verb = 0, echo = 0 } = {}) {
    const ctx = this.ctx;
    const f = mtof(midi);
    const end = t + Math.max(attack, dur) + release * 4;
    const g = ctx.createGain();
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(gain, t + attack);
    g.gain.setTargetAtTime(0, t + Math.max(attack, dur), release);
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = q;
    lp.frequency.setValueAtTime(cutoff, t);
    if (cutoffTo) lp.frequency.exponentialRampToValueAtTime(cutoffTo, end);
    const layers = Array.isArray(type) ? type : [[type, 0, 0]];
    for (const [ty, cents = 0, oct = 0] of layers) {
      const o = ctx.createOscillator();
      o.type = ty;
      o.frequency.value = f * Math.pow(2, oct);
      o.detune.value = cents;
      o.connect(lp);
      o.start(t);
      o.stop(end);
    }
    lp.connect(g).connect(this.bus);
    this.send(g, this.verbIn, verb);
    this.send(g, this.echoIn, echo);
  }

  send(from, to, amount) {
    if (!(amount > 0)) return;
    const s = this.ctx.createGain();
    s.gain.value = amount;
    from.connect(s).connect(to);
  }

  pad(t, midis, dur, gain) {
    for (const m of midis) {
      this.voice(t, m, dur * 0.85, {
        type: [['sawtooth', -9], ['sawtooth', 9]], gain, attack: dur * 0.3, release: dur * 0.2,
        cutoff: 900, verb: 0.7,
      });
    }
  }

  kick(t, gain) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    o.type = 'sine';
    o.frequency.setValueAtTime(140, t);
    o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + 0.32);
    o.connect(g).connect(this.bus);
    o.start(t);
    o.stop(t + 0.35);
  }

  noiseHit(t, gain, decay, type, freq, q = 0.8) {
    const ctx = this.ctx;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.0005, t + decay);
    src.connect(f).connect(g).connect(this.bus);
    src.start(t, Math.random() * 0.8);
    src.stop(t + decay + 0.02);
    return g;
  }

  // `body` is how much of the drum's pitched thump is under the rattle;
  // `tone` darkens it (lo-fi).
  snare(t, gain, body = 0.4, tone = 2200) {
    const g = this.noiseHit(t, gain, 0.16, 'bandpass', tone, 0.7);
    this.send(g, this.verbIn, 0.25);
    if (body > 0) {
      const o = this.ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
      const bg = this.ctx.createGain();
      bg.gain.setValueAtTime(gain * body * 2, t);
      bg.gain.exponentialRampToValueAtTime(0.001, t + 0.08);
      o.connect(bg).connect(this.bus);
      o.start(t);
      o.stop(t + 0.1);
    }
  }

  hat(t, gain) { this.noiseHit(t, gain, 0.035, 'highpass', 7500, 0.5); }

  crackle(t) { this.noiseHit(t + Math.random() * 0.05, 0.02 + Math.random() * 0.03, 0.006, 'highpass', 2500, 0.5); }
}
