// Settings > Graphics > Detail: High or Low, or Auto (the default), which picks
// one for this device. What each tier changes is render/graphics.js; this module
// is the choice, where it is kept, and the Auto rule. No three.js and no DOM
// beyond requestAnimationFrame and the storage handed in, so the rule is tested
// (test/graphics.test.js).
//
// Auto starts from the device: Low on a touch-first device with few cores or
// little memory (`deviceTier`), High otherwise. While the menu's backdrop is up
// it then times a few seconds of frames (`FrameJudge`); if they are slow it
// drops to Low once and stays there for the session. It never goes back up.

export const GRAPHICS_KEY = 'craterfall.graphics';
export const CHOICES = ['auto', 'high', 'low'];

// The saved choice, or 'auto'.
export function loadChoice(storage) {
  try {
    const v = storage?.getItem(GRAPHICS_KEY);
    if (CHOICES.includes(v)) return v;
  } catch { /* private mode */ }
  return 'auto';
}

export function saveChoice(storage, v) {
  try { storage?.setItem(GRAPHICS_KEY, v); } catch { /* private mode */ }
}

// The device's own answer: Low on a phone or tablet (coarse pointer) with four
// cores or fewer, or 2 GB of memory or less (`navigator.deviceMemory`, Chromium
// only, rounded to a power of two). Unknown values count as fine; the frame
// check catches what this misses.
export const SMALL = { cores: 4, memory: 2 };
export function deviceTier({ coarse = false, cores = 0, memory = 0 } = {}) {
  if (!coarse) return 'high';
  if (cores > 0 && cores <= SMALL.cores) return 'low';
  if (memory > 0 && memory <= SMALL.memory) return 'low';
  return 'high';
}

// What to draw: the choice, or for Auto the device's tier lowered by a slow
// frame check (`slow`). Auto never rises above the device's answer.
export function resolveTier(choice, device, slow = false) {
  if (choice === 'high' || choice === 'low') return choice;
  return device === 'low' || slow ? 'low' : 'high';
}

// Times the menu's frames. add(ms) takes one frame's length and returns
// 'slow' or 'fine' once it has seen enough, null until then. The first `skip`
// frames are dropped (shaders compiling, textures uploading), and so is any gap
// over `maxGap` ms (a hidden tab, a stall), which says nothing about the GPU.
// The verdict is the median of `frames` frames against `slowMs`: 24 ms is
// about 40 fps, below a 60 Hz screen's pace with room for a missed vsync or two.
export class FrameJudge {
  constructor({ skip = 30, frames = 90, slowMs = 24, maxGap = 250 } = {}) {
    Object.assign(this, { skip, frames, slowMs, maxGap });
    this.seen = 0;
    this.samples = [];
    this.verdict = null;
  }

  add(ms) {
    if (this.verdict) return this.verdict;
    if (!(ms > 0) || ms > this.maxGap) return null;
    if (this.seen++ < this.skip) return null;
    this.samples.push(ms);
    if (this.samples.length < this.frames) return null;
    this.verdict = median(this.samples) > this.slowMs ? 'slow' : 'fine';
    return this.verdict;
  }
}

export function median(list) {
  const s = [...list].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// The setting itself. apply(tier) draws at that tier ('high' or 'low'); it is
// called once at start and again only when the tier changes. menu() says the
// menu's backdrop is what is on screen (the frame check runs only then).
export class Graphics {
  constructor({ storage = null, coarse = false, cores = 0, memory = 0, apply, menu = () => true }) {
    this.storage = storage;
    this.apply = apply;
    this.menu = menu;
    this.choice = loadChoice(storage);
    this.device = deviceTier({ coarse, cores, memory });
    this.slow = false;
    this.tier = null;
    this.update();
  }

  // The tier now drawn: 'high' or 'low'.
  get low() { return this.tier === 'low'; }

  set(choice) {
    if (!CHOICES.includes(choice)) return;
    this.choice = choice;
    saveChoice(this.storage, choice);
    this.update();
  }

  update() {
    const t = resolveTier(this.choice, this.device, this.slow);
    if (t === this.tier) return;
    this.tier = t;
    this.apply?.(t);
  }

  // Auto's frame check on the menu: a few seconds of animation frames, then
  // one verdict. Stops early (with no verdict) once a match starts or after
  // `limit` seconds. Nothing to check when the device is already Low.
  watch({ raf = globalThis.requestAnimationFrame, limit = 20 } = {}) {
    if (this.device === 'low' || this.slow || !raf) return;
    const judge = new FrameJudge();
    let last = 0;
    let start = 0;
    const step = (now) => {
      if (!start) start = now;
      if (!this.menu() || now - start > limit * 1000) return;
      if (last) {
        const v = judge.add(now - last);
        if (v) {
          this.verdict = v;
          if (v === 'slow') { this.slow = true; this.update(); }
          return;
        }
      }
      last = now;
      raf(step);
    };
    raf(step);
  }
}
