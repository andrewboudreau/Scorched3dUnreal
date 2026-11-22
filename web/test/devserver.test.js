// The dev server's player ids and seat rejoin (it mirrors module/Players.cs
// and module/Rooms.cs). Starts tools/devserver.mjs on a free port; with
// CRATERFALL_API_BASE set (say http://localhost:5000/Craterfall) it runs the
// same checks against that server instead, to compare the module with it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

let server;
let base;

before(async () => {
  if (process.env.CRATERFALL_API_BASE) { base = process.env.CRATERFALL_API_BASE.replace(/\/$/, ''); return; }
  server = spawn(process.execPath, [fileURLToPath(new URL('../tools/devserver.mjs', import.meta.url)), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
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

// One browser: a cookie jar of its own.
function browser() {
  let cookie = '';
  const req = async (path, body) => {
    const r = await fetch(base + path, {
      method: body ? 'POST' : 'GET',
      headers: { ...(cookie ? { cookie } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = r.headers.get('set-cookie');
    if (set) cookie = set.split(';')[0];
    return { status: r.status, body: await r.json().catch(() => null), setCookie: set };
  };
  return { req, get cookie() { return cookie; } };
}

const TAB1 = 'tab1tab1tab1tab1tab1tA';
const TAB2 = 'tab2tab2tab2tab2tab2tB';

test('api/me issues a 128-bit id in an HttpOnly cookie and keeps it', async () => {
  const b = browser();
  const first = await b.req('/api/me');
  assert.equal(first.status, 200);
  assert.match(first.body.id, /^[A-Za-z0-9_-]{22}$/);
  assert.equal(first.body.name, '');
  assert.match(first.setCookie, /^craterfall_id=[A-Za-z0-9_-]{22};/);
  assert.match(first.setCookie, /httponly/i);
  assert.match(first.setCookie, /samesite=lax/i);
  assert.match(first.setCookie, /path=\//i);
  assert.match(first.setCookie, /max-age=31536000/i);
  const again = await b.req('/api/me');
  assert.equal(again.body.id, first.body.id);
  assert.notEqual((await browser().req('/api/me')).body.id, first.body.id);
});

test('api/me saves a cleaned name', async () => {
  const b = browser();
  await b.req('/api/me');
  const r = await b.req('/api/me', { name: '  Ana\u0000​ the Great Gunner ' });
  assert.equal(r.body.name, 'Ana the Great');
  assert.equal((await b.req('/api/me')).body.name, 'Ana the Great');
  assert.equal((await b.req('/api/me', [])).status, 400);
});

test('a reload (same id, same tab) gets the same seat back with a fresh token', async () => {
  const host = browser();
  await host.req('/api/me', { name: 'Host' });
  const made = (await host.req('/api/rooms', { name: '', tab: TAB1 })).body;
  assert.equal(made.seat, 0);
  const code = made.code;

  const guest = browser();
  await guest.req('/api/me', { name: 'Ana' });
  const a = (await guest.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB1 })).body;
  assert.equal(a.seat, 1);
  assert.equal(a.rejoin, undefined);

  const again = await guest.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB1 });
  assert.equal(again.status, 200);
  assert.equal(again.body.seat, 1);
  assert.equal(again.body.rejoin, true);
  assert.notEqual(again.body.token, a.token);
  // The old token no longer holds the seat.
  assert.equal((await guest.req(`/api/rooms/${code}/send`, { token: a.token, msg: { t: 'say', text: 'hi' } })).status, 403);
  assert.equal((await guest.req(`/api/rooms/${code}/send`, { token: again.body.token, msg: { t: 'say', text: 'hi' } })).status, 200);

  // No second "join" in the log.
  const log = (await guest.req(`/api/rooms/${code}/events?token=${again.body.token}&after=0`)).body.entries;
  assert.deepEqual(log.filter((e) => e.msg.t === 'join').map((e) => [e.msg.seat, e.msg.name]), [[0, 'Host'], [1, 'Ana']]);
});

test('two tabs of one browser are two seats; each reload keeps its own', async () => {
  const host = browser();
  await host.req('/api/me');
  const code = (await host.req('/api/rooms', { name: 'Host', tab: TAB1 })).body.code;

  const b = browser();
  await b.req('/api/me', { name: 'Ana' });
  const t1 = (await b.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB1 })).body;
  const t2 = (await b.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB2 })).body;
  assert.equal(t1.seat, 1);
  assert.equal(t2.seat, 2);
  assert.equal(t2.rejoin, undefined);

  const back1 = (await b.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB1 })).body;
  const back2 = (await b.req(`/api/rooms/${code}/join`, { name: 'Ana', tab: TAB2 })).body;
  assert.deepEqual([back1.seat, back1.rejoin, back2.seat, back2.rejoin], [1, true, 2, true]);

  // The second tab's name is told apart from the first's.
  const log = (await b.req(`/api/rooms/${code}/events?token=${back1.token}&after=0`)).body.entries;
  assert.deepEqual(log.filter((e) => e.msg.t === 'join').map((e) => e.msg.name), ['Host', 'Ana', 'Ana 2']);
});

test('a seat comes back after the match started; a newcomer still cannot join', async () => {
  const host = browser();
  await host.req('/api/me');
  const made = (await host.req('/api/rooms', { name: 'Host', tab: TAB1 })).body;
  const guest = browser();
  await guest.req('/api/me');
  await guest.req(`/api/rooms/${made.code}/join`, { name: 'Bo', tab: TAB1 });
  assert.equal((await host.req(`/api/rooms/${made.code}/send`, { token: made.token, msg: { t: 'start' } })).status, 200);

  const back = await guest.req(`/api/rooms/${made.code}/join`, { name: 'Bo', tab: TAB1 });
  assert.deepEqual([back.status, back.body.seat, back.body.rejoin], [200, 1, true]);
  assert.equal((await guest.req(`/api/rooms/${made.code}/join`, { name: 'Bo', tab: TAB2 })).status, 409);
  assert.equal((await browser().req(`/api/rooms/${made.code}/join`, { name: 'Cy', tab: TAB1 })).status, 409);
});

test('a seat that left is let go: joining again takes a new seat', async () => {
  const host = browser();
  await host.req('/api/me');
  const code = (await host.req('/api/rooms', { name: 'Host', tab: TAB1 })).body.code;
  const b = browser();
  await b.req('/api/me');
  const first = (await b.req(`/api/rooms/${code}/join`, { name: 'Bo', tab: TAB1 })).body;
  await b.req(`/api/rooms/${code}/leave`, { token: first.token });
  const next = (await b.req(`/api/rooms/${code}/join`, { name: 'Bo', tab: TAB1 })).body;
  assert.equal(next.seat, 2);
  assert.equal(next.rejoin, undefined);
  assert.equal((await b.req(`/api/rooms/${code}/join`, { name: 'Bo', tab: TAB1 })).body.seat, 2);
});

test('old clients (no cookie, no tab key) get a new seat every time', async () => {
  const host = browser();
  const made = await fetch(`${base}/api/rooms`, { method: 'POST', body: JSON.stringify({ name: 'Old' }) }).then((r) => r.json());
  const join = () => fetch(`${base}/api/rooms/${made.code}/join`, { method: 'POST', body: JSON.stringify({ name: 'Old' }) }).then((r) => r.json());
  assert.deepEqual([(await join()).seat, (await join()).seat], [1, 2]);
  // A cookie but no tab key: also a new seat, never a takeover.
  await host.req('/api/me');
  const a = (await host.req(`/api/rooms/${made.code}/join`, { name: 'H' })).body;
  const b = (await host.req(`/api/rooms/${made.code}/join`, { name: 'H' })).body;
  assert.deepEqual([a.seat, b.seat, b.rejoin], [3, 4, undefined]);
});

test('the host reports the result: played and won are counted once per player', async () => {
  const host = browser();
  await host.req('/api/me');
  const made = (await host.req('/api/rooms', { name: 'Host', tab: TAB1 })).body;
  const guest = browser();
  await guest.req('/api/me');
  const g1 = (await guest.req(`/api/rooms/${made.code}/join`, { name: 'Bo', tab: TAB1 })).body;
  await guest.req(`/api/rooms/${made.code}/join`, { name: 'Bo', tab: TAB2 });   // a second tab, same player
  assert.equal((await host.req(`/api/rooms/${made.code}/result`, { token: made.token, winner: 1 })).status, 409);   // not started
  await host.req(`/api/rooms/${made.code}/send`, { token: made.token, msg: { t: 'start' } });
  assert.equal((await guest.req(`/api/rooms/${made.code}/result`, { token: g1.token, winner: 1 })).status, 403);   // host only
  assert.equal((await host.req(`/api/rooms/${made.code}/result`, { token: made.token, winner: 1 })).status, 200);
  assert.equal((await host.req(`/api/rooms/${made.code}/result`, { token: made.token, winner: 0 })).status, 200);   // once only
  const h = (await host.req('/api/me')).body;
  const g = (await guest.req('/api/me')).body;
  assert.deepEqual([h.played, h.won, g.played, g.won], [1, 0, 1, 1]);
});
