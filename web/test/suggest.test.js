// The suggestion box: the pure part of src/suggest.js, and the API as the dev
// server serves it (tools/devserver.mjs, mirroring module/Suggestions.cs). With
// CRATERFALL_API_BASE and CRATERFALL_REVIEW_KEY set, the API checks run
// against that server instead.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkText, suggestionContext, AREAS, CONTEXT_MAX, TEXT_MAX } from '../src/suggest.js';

test('checkText wants a few characters and not too many', () => {
  assert.ok(checkText(''));
  assert.ok(checkText('  a '));
  assert.equal(checkText('more wind'), '');
  assert.ok(checkText('x'.repeat(TEXT_MAX + 1)));
});

test('the areas include the places the request names', () => {
  const ids = AREAS.map((a) => a.id);
  for (const id of ['game', 'match builder', 'settings', 'other']) assert.ok(ids.includes(id), id);
});

test('suggestionContext reads the match and stays small', () => {
  const game = { round: 2, phase: 'aim', modifier: { id: 'rain' }, cfg: { rounds: 5, firing: 'turns' }, online: false,
    players: [{ ai: false }, { ai: true }, { ai: true }] };
  const c = suggestionContext({ game, screen: 'match', view: { w: 878.4, h: 389 }, touch: {}, ua: 'x'.repeat(500) });
  assert.deepEqual({ round: c.round, rounds: c.rounds, phase: c.phase, modifier: c.modifier, players: c.players, cpus: c.cpus, online: c.online },
    { round: 2, rounds: 5, phase: 'aim', modifier: 'rain', players: 3, cpus: 2, online: false });
  assert.equal(c.view, '878x389');
  assert.equal(c.touch, true);   // a TouchControls object becomes a flag
  assert.equal(c.ua.length, 200);
  assert.ok(JSON.stringify(c).length <= CONTEXT_MAX);
  const bare = suggestionContext({ screen: 'catalog' });
  assert.equal(bare.round, undefined);
  assert.equal(bare.touch, false);
  const huge = suggestionContext({ screen: 'x', page: 'p'.repeat(CONTEXT_MAX), ua: 'u' });
  assert.ok(JSON.stringify(huge).length <= CONTEXT_MAX);
});

// ---- the API
const KEY = process.env.CRATERFALL_API_BASE ? process.env.CRATERFALL_REVIEW_KEY : 'test-review-key';
let server;
let base;
before(async () => {
  if (process.env.CRATERFALL_API_BASE) { base = process.env.CRATERFALL_API_BASE.replace(/\/$/, ''); return; }
  server = spawn(process.execPath, [fileURLToPath(new URL('../tools/devserver.mjs', import.meta.url)), '0'],
    { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, CRATERFALL_REVIEW_KEY: KEY } });
  base = await new Promise((ok, fail) => {
    let out = '';
    server.stdout.on('data', (c) => {
      out += c;
      const m = out.match(/http:\/\/localhost:(\d+)\//);
      if (m) ok(`http://localhost:${m[1]}`);
    });
    server.on('exit', (code) => fail(new Error(`devserver exited ${code}`)));
  });
});
after(() => server?.kill());

const call = async (path, { body, key, cookie } = {}) => {
  const r = await fetch(`${base}/api/suggestions${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(key ? { 'x-review-key': key } : {}), ...(cookie ? { cookie } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json().catch(() => null) };
};

test('anyone can send; only the review key reads and marks', async () => {
  const text = `Wind arrows are hard to see ${Date.now()}`;
  const sent = await call('', { body: { text: `  ${text}\u0007  `, area: 'Game', context: { round: 2, screen: 'match' } } });
  assert.equal(sent.status, 200);
  assert.match(sent.body.id, /^[\w-]{8}$/);

  assert.equal((await call('')).status, 401);
  assert.equal((await call('', { key: 'wrong' })).status, 401);
  assert.equal((await call(`/${sent.body.id}`, { body: { status: 'done' } })).status, 401);

  const fresh = await call('', { key: KEY });
  assert.equal(fresh.status, 200);
  const s = fresh.body.find((x) => x.id === sent.body.id);
  assert.ok(s, 'listed as new');
  assert.equal(s.text, text);          // trimmed, control characters out
  assert.equal(s.area, 'game');        // lower case
  assert.equal(s.status, 'new');
  assert.deepEqual(s.context, { round: 2, screen: 'match' });

  const marked = await call(`/${sent.body.id}`, { key: KEY, body: { status: 'done', note: 'bigger arrows' } });
  assert.equal(marked.status, 200);
  assert.equal(marked.body.status, 'done');
  assert.equal(marked.body.note, 'bigger arrows');
  assert.ok(!(await call('', { key: KEY })).body.some((x) => x.id === sent.body.id), 'gone from new');
  assert.ok((await call('?status=done', { key: KEY })).body.some((x) => x.id === sent.body.id));
  assert.ok((await call('?status=all', { key: KEY })).body.some((x) => x.id === sent.body.id));
  assert.equal((await call('/nope0000', { key: KEY, body: { status: 'done' } })).status, 404);
});

test('too short is refused, and an oversized context is dropped', async () => {
  assert.equal((await call('', { body: { text: ' a ' } })).status, 400);
  const r = await call('', { body: { text: 'context too big', context: { x: 'y'.repeat(5000) } } });
  assert.equal(r.status, 200);
  const s = (await call('', { key: KEY })).body.find((x) => x.id === r.body.id);
  assert.equal(s.area, 'other');
  assert.equal(s.context ?? null, null);
});

test('one sender is held to a few an hour', async () => {
  const cookie = `craterfall_id=${Buffer.from(String(Date.now()).padEnd(16, 'r')).toString('base64url')}`;   // a sender of its own
  const codes = [];
  for (let i = 0; i < 14; i++) codes.push((await call('', { cookie, body: { text: `flood ${i}` } })).status);
  assert.ok(codes.includes(429), codes.join(' '));
  assert.ok(codes.slice(0, 10).every((c) => c === 200 || c === 429));
});
