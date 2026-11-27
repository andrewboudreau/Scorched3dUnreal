import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GRAPHICS_KEY, loadChoice, deviceTier, resolveTier, FrameJudge, median, Graphics, blobLay, BLOB_FADE } from '../src/graphics.js';

const memory = (start = {}) => {
  const m = new Map(Object.entries(start));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), raw: m };
};

test('the choice defaults to Auto and ignores what it does not know', () => {
  assert.equal(loadChoice(memory()), 'auto');
  assert.equal(loadChoice(null), 'auto');
  assert.equal(loadChoice(memory({ [GRAPHICS_KEY]: 'ultra' })), 'auto');
  assert.equal(loadChoice(memory({ [GRAPHICS_KEY]: 'low' })), 'low');
  const broken = { getItem: () => { throw new Error('private mode'); } };
  assert.equal(loadChoice(broken), 'auto');
});

test('the device rule: Low only on a touch device with few cores or little memory', () => {
  assert.equal(deviceTier({ coarse: false, cores: 2, memory: 1 }), 'high');   // a desktop is never Low by itself
  assert.equal(deviceTier({ coarse: true, cores: 8, memory: 8 }), 'high');
  assert.equal(deviceTier({ coarse: true, cores: 4, memory: 8 }), 'low');
  assert.equal(deviceTier({ coarse: true, cores: 8, memory: 2 }), 'low');
  assert.equal(deviceTier({ coarse: true }), 'high');                          // unknown counts as fine
  assert.equal(deviceTier({ coarse: true, cores: 8, memory: 4 }), 'high');
});

test('Auto follows the device and the frame check; High and Low are what they say', () => {
  assert.equal(resolveTier('auto', 'high'), 'high');
  assert.equal(resolveTier('auto', 'low'), 'low');
  assert.equal(resolveTier('auto', 'high', true), 'low');
  assert.equal(resolveTier('high', 'low', true), 'high');
  assert.equal(resolveTier('low', 'high'), 'low');
});

test('the frame judge skips the warm-up and stalls, then gives one verdict', () => {
  const j = new FrameJudge({ skip: 3, frames: 5, slowMs: 24 });
  for (const ms of [200, 90, 80]) assert.equal(j.add(ms), null);   // shaders compiling
  assert.equal(j.add(5000), null);                                  // a hidden tab: ignored
  for (const ms of [16, 17, 16, 18]) assert.equal(j.add(ms), null);
  assert.equal(j.add(40), 'fine');                                  // median 17 ms
  assert.equal(j.add(90), 'fine');                                  // decided once
  const slow = new FrameJudge({ skip: 0, frames: 5 });
  let v = null;
  for (const ms of [33, 34, 16, 35, 33]) v = slow.add(ms);
  assert.equal(v, 'slow');
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
});

// A fake requestAnimationFrame: step(ms) runs the queued callback at now += ms.
function fakeRaf() {
  let queued = null, now = 1000;
  return {
    raf: (cb) => { queued = cb; },
    step(ms) { now += ms; const cb = queued; queued = null; cb?.(now); },
    get waiting() { return !!queued; },
  };
}

test('Auto drops to Low once when the menu runs slow, and never climbs back', () => {
  const applied = [];
  const g = new Graphics({ storage: memory(), coarse: false, cores: 8, apply: (t) => applied.push(t) });
  assert.deepEqual(applied, ['high']);
  const clock = fakeRaf();
  g.watch({ raf: clock.raf });
  clock.step(0);
  for (let i = 0; i < 200 && clock.waiting; i++) clock.step(40);
  assert.equal(clock.waiting, false);
  assert.deepEqual(applied, ['high', 'low']);
  assert.equal(g.tier, 'low');
  g.watch({ raf: clock.raf });          // no second check
  assert.equal(clock.waiting, false);
  g.set('high');
  g.set('auto');                        // back to Auto: still the slow verdict
  assert.deepEqual(applied, ['high', 'low', 'high', 'low']);
});

test('a smooth menu keeps High; a match starting stops the check', () => {
  const applied = [];
  const g = new Graphics({ storage: memory(), apply: (t) => applied.push(t) });
  const clock = fakeRaf();
  g.watch({ raf: clock.raf });
  clock.step(0);
  for (let i = 0; i < 200 && clock.waiting; i++) clock.step(16.7);
  assert.equal(g.verdict, 'fine');
  assert.deepEqual(applied, ['high']);
  let menu = true;
  const h = new Graphics({ storage: memory(), apply: () => {}, menu: () => menu });
  const c2 = fakeRaf();
  h.watch({ raf: c2.raf });
  c2.step(0);
  for (let i = 0; i < 40; i++) c2.step(40);
  menu = false;
  c2.step(40);
  assert.equal(c2.waiting, false);
  assert.equal(h.tier, 'high');
});

test('a chosen tier is saved and applied at once; a Low device needs no check', () => {
  const s = memory();
  const applied = [];
  const g = new Graphics({ storage: s, coarse: true, cores: 4, apply: (t) => applied.push(t) });
  assert.equal(g.tier, 'low');
  const clock = fakeRaf();
  g.watch({ raf: clock.raf });
  assert.equal(clock.waiting, false);
  g.set('high');
  assert.equal(s.raw.get(GRAPHICS_KEY), 'high');
  assert.deepEqual(applied, ['low', 'high']);
  g.set('nonsense');
  assert.equal(g.choice, 'high');
  assert.equal(new Graphics({ storage: s, coarse: true, cores: 4, apply: () => {} }).tier, 'high');
});

test('the Low blob follows the ground under the tank and shrinks as the tank rises', () => {
  const on = blobLay(10, 10);
  assert.ok(Math.abs(on.dy - 0.06) < 1e-9 && on.scale === 1);                 // on the ground: just above it, full size
  const hop = blobLay(15, 10);                                              // 5 m up: it stays on the ground below
  assert.ok(Math.abs(hop.dy - (-5 + 0.06)) < 1e-9);
  assert.ok(hop.scale > 0 && hop.scale < 1);
  assert.equal(blobLay(10 + BLOB_FADE, 10).scale, 0);                       // high enough: gone
  assert.equal(blobLay(100, 10).scale, 0);
  assert.ok(blobLay(12, 10).scale > blobLay(16, 10).scale);                  // smaller the higher it is
  assert.ok(blobLay(8, 10).dy > 0 && blobLay(8, 10).scale === 1);           // half buried: the blob stays on the ground
  assert.equal(blobLay(10, 10, false).scale, 0);                             // open sky under it: no blob
});
