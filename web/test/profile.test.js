import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeProfile, cleanName, isId, tabKey, newLocalId, NAME_KEY, ID_KEY } from '../src/profile.js';

// localStorage / sessionStorage as a Map.
function memStore(init = {}) {
  const m = new Map(Object.entries(init));
  return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

const reply = (status, body, { html = false } = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => (html ? JSON.parse('<!DOCTYPE html>') : body),
});

// A fake api/me that keeps one player, and logs what it was asked.
function fakeServer({ id = 'AAAAAAAAAAAAAAAAAAAAAA', name = '' } = {}) {
  const calls = [];
  const fetch = async (url, opts = {}) => {
    calls.push({ url, method: opts.method || 'GET', body: opts.body ? JSON.parse(opts.body) : null });
    if (opts.method === 'POST') name = JSON.parse(opts.body).name;
    return reply(200, { id, name, played: 3, won: 1 });
  };
  return { fetch, calls };
}

test('cleanName drops control and invisible characters, trims, caps at 14', () => {
  assert.equal(cleanName('  Ana\u0000\u0007 '), 'Ana');
  assert.equal(cleanName('A​n‮a'), 'Ana');
  assert.equal(cleanName('line\nbreak'), 'linebreak');
  assert.equal(cleanName('abcdefghijklmnopq'), 'abcdefghijklmn');
  assert.equal(cleanName('abcdefghijklm ' + 'xyz'), 'abcdefghijklm');
  assert.equal(cleanName(null), '');
  // A surrogate pair straddling the cap is dropped whole, never split.
  const s = cleanName('abcdefghijklm\u{1F600}');
  assert.equal(s, 'abcdefghijklm');
  assert.ok(!/[\uD800-\uDBFF]$/.test(s));
});

test('local ids are 128-bit and URL-safe', () => {
  const a = newLocalId();
  assert.ok(isId(a), a);
  assert.notEqual(a, newLocalId());
  assert.ok(isId(newLocalId(() => new Uint8Array(16).fill(255))));
});

test('offline: a local id is made once and kept, the stored name is used', async () => {
  const storage = memStore({ [NAME_KEY]: 'Ana' });
  const fetch = async () => { throw new TypeError('Failed to fetch'); };
  const p = makeProfile({ base: 'http://x/api/me', fetch, storage });
  assert.equal(p.name, 'Ana');   // known before ready
  await p.ready;
  assert.equal(p.online, false);
  assert.ok(isId(p.id));
  assert.equal(storage.getItem(ID_KEY), p.id);
  const again = await makeProfile({ base: 'http://x/api/me', fetch, storage }).ready;
  assert.equal(again.id, p.id);
});

test('a static host with no API (404, or its HTML page) falls back to local', async () => {
  for (const fetch of [async () => reply(404, null), async () => reply(200, null, { html: true }), async () => reply(200, { nope: 1 })]) {
    const storage = memStore();
    const p = await makeProfile({ base: 'http://x/api/me', fetch, storage }).ready;
    assert.equal(p.online, false);
    assert.ok(isId(p.id));
    await p.setName('  Bo\u0001 ');
    assert.equal(p.name, 'Bo');
    assert.equal(storage.getItem(NAME_KEY), 'Bo');
  }
});

test('online: the server id wins, and its name replaces the local one', async () => {
  const server = fakeServer({ name: 'Cyd' });
  const storage = memStore({ [NAME_KEY]: 'Old' });
  const p = await makeProfile({ base: 'http://x/api/me', fetch: server.fetch, storage }).ready;
  assert.equal(p.online, true);
  assert.equal(p.id, 'AAAAAAAAAAAAAAAAAAAAAA');
  assert.equal(p.name, 'Cyd');
  assert.equal(p.played, 3);
  assert.equal(storage.getItem(NAME_KEY), 'Cyd');
  assert.equal(storage.getItem(ID_KEY), null);   // no local id needed
});

test('online: a name saved before ids existed is handed to the server', async () => {
  const server = fakeServer({ name: '' });
  const p = await makeProfile({ base: 'http://x/api/me', fetch: server.fetch, storage: memStore({ [NAME_KEY]: 'Dee' }) }).ready;
  assert.equal(p.name, 'Dee');
  assert.deepEqual(server.calls.map((c) => c.method), ['GET', 'POST']);
  assert.deepEqual(server.calls[1].body, { name: 'Dee' });
});

test('setName saves here and on the server', async () => {
  const server = fakeServer();
  const storage = memStore();
  const p = makeProfile({ base: 'http://x/api/me', fetch: server.fetch, storage });
  await p.setName('Eve the very long name');
  assert.equal(p.name, 'Eve the very l');
  assert.equal(storage.getItem(NAME_KEY), 'Eve the very l');
  assert.deepEqual(server.calls.at(-1), { url: 'http://x/api/me', method: 'POST', body: { name: 'Eve the very l' } });
});

test('setName keeps the name locally when the server is unreachable later', async () => {
  let up = true;
  const server = fakeServer();
  const fetch = async (...a) => { if (!up) throw new TypeError('Failed to fetch'); return server.fetch(...a); };
  const storage = memStore();
  const p = await makeProfile({ base: 'http://x/api/me', fetch, storage }).ready;
  up = false;
  await p.setName('Fay');
  assert.equal(p.name, 'Fay');
  assert.equal(storage.getItem(NAME_KEY), 'Fay');
  assert.equal(p.online, true);
});

test('storage that throws (private mode) still gives a working profile', async () => {
  const storage = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const p = await makeProfile({ base: 'http://x/api/me', fetch: async () => reply(404), storage }).ready;
  assert.ok(isId(p.id));
  await p.setName('Gus');
  assert.equal(p.name, 'Gus');
  assert.ok(isId(tabKey(storage)));
});

test('tab key: the same through a reload, a new one in a new tab', () => {
  const tab1 = memStore();
  const a = tabKey(tab1);
  assert.ok(isId(a));
  assert.equal(tabKey(tab1), a);   // reload: sessionStorage stays
  assert.notEqual(tabKey(memStore()), a);   // another tab: its own sessionStorage
});
