// Synthesised sound (no assets): cannon thump, explosion rumble, UI ticks.
export class Sound {
  constructor() {
    this.ctx = null;
    this.muted = false;
  }

  ensure() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.5;
      this.master.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }

  toggleMute() {
    this.muted = !this.muted;
    if (this.master) this.master.gain.value = this.muted ? 0 : 0.5;
    return this.muted;
  }

  burst({ dur, freq, q = 0.7, gain = 1, sweepTo = null, thump = 0 }) {
    const ctx = this.ensure();
    if (!ctx || this.muted) return;
    const t = ctx.currentTime;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.setValueAtTime(freq, t);
    if (sweepTo) f.frequency.exponentialRampToValueAtTime(sweepTo, t + dur);
    f.Q.value = q;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    g.gain.exponentialRampToValueAtTime(0.001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random());
    src.stop(t + dur);
    if (thump) {
      const o = ctx.createOscillator();
      const og = ctx.createGain();
      o.frequency.setValueAtTime(thump, t);
      o.frequency.exponentialRampToValueAtTime(30, t + 0.35);
      og.gain.setValueAtTime(gain * 0.9, t);
      og.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(og).connect(this.master);
      o.start(t);
      o.stop(t + 0.45);
    }
  }

  fire() { this.burst({ dur: 0.45, freq: 2400, sweepTo: 300, gain: 0.7, thump: 120 }); }
  explode(radius = 10) {
    const s = Math.min(1.6, radius / 12);
    this.burst({ dur: 1.0 + s, freq: 1400, sweepTo: 80, gain: 0.6 + s * 0.4, thump: 70 });
  }
  thud() { this.burst({ dur: 0.25, freq: 400, gain: 0.5, thump: 60 }); }
  click() { this.burst({ dur: 0.05, freq: 5000, gain: 0.15 }); }
}
