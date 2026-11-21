// Local server for trying online play: serves the game from web/ and the same
// rooms API as module/Rooms.cs (keep the two in step), under /api/rooms.
//   node tools/devserver.mjs [port]      then open http://localhost:8080/
//
// It also mounts the resource-pack library (CRATERFALL_PACKS, default the NAS
// library) at /packs/, lists it at /api/packs and saves review picks from the
// in-game pack review (src/review.js) to docs/pack-picks.json. The live server
// has none of this, so the review panel only ever appears locally.
import http from 'node:http';
import { readFile, stat, readdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;
const HOLD = 20000, GONE_AFTER = 45000, MAX_SEATS = 6;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8', '.webp': 'image/webp' };
const PACKS = path.resolve(process.env.CRATERFALL_PACKS || String.raw`<pack library>`);
const PICKS = path.join(root, 'docs', 'pack-picks.json');

// Every pack folder with a pack.json, newest spec fields as they are.
async function packList() {
  let dirs = [];
  try { dirs = await readdir(PACKS, { withFileTypes: true }); } catch { return null; }
  const out = [];
  for (const d of dirs) {
    if (!d.isDirectory()) continue;
    try { out.push({ ...JSON.parse(await readFile(path.join(PACKS, d.name, 'pack.json'), 'utf8')), dir: d.name }); } catch { /* not built yet */ }
  }
  return out;
}

async function packs(req, res, url) {
  if (req.method === 'GET' && url.pathname === '/api/packs') {
    const list = await packList();
    if (!list) return json(res, 404, { error: `No pack library at ${PACKS}` });
    let picks = null;
    try { picks = JSON.parse(await readFile(PICKS, 'utf8')); } catch { /* none saved yet */ }
    return json(res, 200, { root: PACKS, packs: list, picks });
  }
  if (req.method === 'POST' && url.pathname === '/api/packs/picks') {
    const b = await readBody(req);
    if (!b || typeof b.picks !== 'object') return json(res, 400, {});
    const text = JSON.stringify({ saved: new Date().toISOString(), library: PACKS, picks: b.picks }, null, 2);
    if (text.length > 512 * 1024) return json(res, 413, {});
    await writeFile(PICKS, `${text}\n`);
    return json(res, 200, { file: PICKS });
  }
  return json(res, 404, {});
}

const rooms = new Map();
const menu = new Map();          // visitor id -> { name, seen }
const MENU_FOR = 20000;

function makeRoom(priv) {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join(''); while (rooms.has(code));
  const room = { code, seats: [], log: [], started: false, waiters: [], private: priv, created: Date.now() };
  rooms.set(code, room);
  return room;
}

function append(room, seat, msg) {
  room.log.push({ n: room.log.length + 1, seat, msg });
  const w = room.waiters;
  room.waiters = [];
  w.forEach((f) => f());
}

function sweep(room) {
  const now = Date.now();
  room.seats.forEach((s, i) => {
    if (!s.gone && now - s.seen > GONE_AFTER) { s.gone = true; append(room, -1, { t: 'gone', seat: i }); }
  });
}

function join(room, name) {
  const token = randomBytes(16).toString('hex');
  room.seats.push({ token, name, seen: Date.now(), gone: false });
  const seat = room.seats.length - 1;
  append(room, -1, { t: 'join', seat, name });
  return { code: room.code, seat, token };
}

const clip = (s) => String(s ?? '').trim().slice(0, 14);
const nameOf = (b) => clip(b?.name) || 'Player';

function list(id, name) {
  const now = Date.now();
  for (const [k, v] of menu) if (now - v.seen > MENU_FOR) menu.delete(k);
  if (id && id.length <= 40) menu.set(id, { name: clip(name), seen: now });
  const out = [];
  for (const room of rooms.values()) {
    if (room.private) continue;
    const live = room.seats.filter((s) => !s.gone && now - s.seen < GONE_AFTER);
    if (!room.seats.length || !live.includes(room.seats[0])) continue;
    const open = !room.started && live.length < MAX_SEATS;
    out.push({ code: room.code, host: room.seats[0].name, players: live.map((s) => s.name), open, started: room.started, created: room.created });
  }
  out.sort((a, b) => (b.open - a.open) || (b.created - a.created));
  const others = [...menu].filter(([k]) => k !== id).map(([, v]) => v.name);
  return { rooms: out.slice(0, 30).map(({ created, ...r }) => r), menu: { count: others.length, names: others.filter(Boolean).slice(0, 20) } };
}
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((ok) => {
  let s = '';
  req.on('data', (c) => { s += c; });
  req.on('end', () => { try { const v = JSON.parse(s); ok(v && typeof v === 'object' ? v : null); } catch { ok(null); } });
});

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // api rooms [code] [action]
  const code = parts[2]?.toUpperCase();
  const action = parts[3];
  if (req.method === 'GET' && parts.length === 2) return json(res, 200, list(url.searchParams.get('id'), url.searchParams.get('name')));
  if (req.method === 'POST' && parts.length === 2) {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    return json(res, 200, join(makeRoom(b.private === true), nameOf(b)));
  }
  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'No room with that code.' });
  const seatOf = (token) => room.seats.findIndex((s) => s.token === token);
  if (req.method === 'POST' && action === 'join') {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    if (room.started) return json(res, 409, { error: 'That game has already started.' });
    if (room.seats.filter((s) => !s.gone).length >= MAX_SEATS) return json(res, 409, { error: 'That room is full.' });
    return json(res, 200, join(room, nameOf(b)));
  }
  if (req.method === 'POST' && action === 'leave') {
    const b = await readBody(req);
    const seat = seatOf(b?.token);
    if (seat < 0) return json(res, 403, {});
    if (!room.seats[seat].gone) { room.seats[seat].gone = true; append(room, -1, { t: 'gone', seat }); }
    return json(res, 200, {});
  }
  if (req.method === 'POST' && action === 'send') {
    const b = await readBody(req);
    if (!b || !b.msg || typeof b.msg !== 'object') return json(res, 400, {});
    const seat = seatOf(b.token);
    if (seat < 0) return json(res, 403, {});
    if (b.msg.t === 'join' || b.msg.t === 'gone') return json(res, 400, {});
    if (b.msg.t === 'start') { if (seat !== 0) return json(res, 403, {}); room.started = true; }
    room.seats[seat].seen = Date.now();
    append(room, seat, b.msg);
    return json(res, 200, { n: room.log.length });
  }
  if (req.method === 'GET' && action === 'events') {
    const token = url.searchParams.get('token');
    const after = Math.max(0, Number(url.searchParams.get('after')) || 0);
    const seat = seatOf(token);
    if (seat < 0) return json(res, 403, {});
    room.seats[seat].seen = Date.now();
    sweep(room);
    const reply = () => {
      if (seat >= 0) room.seats[seat].seen = Date.now();
      json(res, 200, { entries: room.log.slice(after, after + 500) });
    };
    if (room.log.length > after) return reply();
    let done = false;
    const go = () => { if (!done) { done = true; clearTimeout(timer); reply(); } };
    const timer = setTimeout(go, HOLD);
    room.waiters.push(go);
    req.on('close', () => { done = true; clearTimeout(timer); });
    return undefined;
  }
  return json(res, 404, {});
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/rooms')) return api(req, res, url);
  if (url.pathname.startsWith('/api/packs')) return packs(req, res, url);
  const fromPacks = url.pathname.startsWith('/packs/');
  const base = fromPacks ? PACKS : root;
  let file = path.join(base, decodeURIComponent(fromPacks ? url.pathname.slice(7) : url.pathname));
  if (file !== base && !file.startsWith(base + path.sep)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, () => {
  console.log(`Craterfall dev server on http://localhost:${port}/`);
  // For a phone on the same Wi-Fi (Windows Firewall must let the port in).
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) console.log(`  ${name}: http://${a.address}:${port}/`);
  }
});
