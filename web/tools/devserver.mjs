// Local server for trying online play: serves the game from web/ and the same
// rooms API as module/Rooms.cs (keep the two in step), under /api/rooms, and
// the player id API as module/Players.cs, under /api/me (records in memory only).
//   node tools/devserver.mjs [port]      then open http://localhost:8080/
// Port 0 picks a free one; the first line printed says which.
//
// It also mounts the resource-pack library (CRATERFALL_PACKS, else "packs" in the
// gitignored tools/local.json; none set, no packs) at /packs/, lists it at /api/packs and saves review picks from the
// in-game pack review (src/review.js) to docs/pack-picks.json. The live server
// has none of this, so the review panel only ever appears locally.
import http from 'node:http';
import { readFile, stat, readdir, writeFile } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = process.argv[2] != null && process.argv[2] !== '' ? Number(process.argv[2]) : 8080;
const HOLD = 20000, GONE_AFTER = 45000, MAX_SEATS = 6;
// As Rooms.cs: body, log and memory limits, and when a room is let go.
const MAX_BODY = 128 * 1024, MAX_ENTRIES = 20000, MAX_ROOM_BYTES = 8 * 1024 * 1024, MAX_ALL_BYTES = 64 * 1024 * 1024;
const MAX_ROOMS = 300, IDLE_AFTER = 3 * 3600e3, ABANDONED_AFTER = 30 * 60e3;
let allBytes = 0;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.wasm': 'application/wasm',
  '.ogg': 'audio/ogg', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.glb': 'model/gltf-binary', '.hdr': 'application/octet-stream', '.md': 'text/markdown; charset=utf-8', '.webp': 'image/webp' };
// Where this machine keeps things the repo shouldn't name: tools/local.json (gitignored).
const local = await readFile(path.join(root, 'tools', 'local.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const PACKS = path.resolve(process.env.CRATERFALL_PACKS || local.packs || path.join(root, 'no-pack-library'));
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

// ---- who is playing (module/Players.cs): a random id in a cookie, and a small
// record per id. The id is an identifier, not a secret. A visit alone stores
// nothing: a record is made when a player sets a name or finishes a match. Here the game is served
// from /, so the cookie's path is / rather than /Craterfall.
const COOKIE = 'craterfall_id';
const MAX_PLAYERS = 20000;
const players = new Map();       // id -> { name, firstSeen, lastSeen, played, won }

const isId = (s) => typeof s === 'string' && /^[A-Za-z0-9_-]{22}$/.test(s);
const newId = () => randomBytes(16).toString('base64url');
function cookieId(req) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === COOKIE && isId(v.join('='))) return v.join('=');
  }
  return null;
}
// The caller's id, issuing one if it has none; the cookie is renewed every time.
function identify(req, res) {
  const id = cookieId(req) || newId();
  const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';
  res.setHeader('set-cookie', `${COOKIE}=${id}; Path=/; Max-Age=${365 * 24 * 3600}; HttpOnly; SameSite=Lax${secure}`);
  return id;
}
function touch(id) {
  const now = new Date().toISOString();
  let r = players.get(id);
  if (!r) {
    if (players.size >= MAX_PLAYERS) {
      // Full: drop a record that never set a name or played, else the one seen longest ago.
      const kept = (q) => (q.name || q.played ? 1 : 0);
      let worst = null;
      for (const [k, q] of players) {
        const w = worst && players.get(worst);
        if (!w || kept(q) < kept(w) || (kept(q) === kept(w) && q.lastSeen < w.lastSeen)) worst = k;
      }
      players.delete(worst);
    }
    r = { name: '', firstSeen: now, lastSeen: now, played: 0, won: 0 };
    players.set(id, r);
  }
  r.lastSeen = now;
  return r;
}
const me = (id, r) => ({ id, name: r.name, played: r.played, won: r.won });
const blank = () => ({ name: '', played: 0, won: 0 });
// The id's record, seen now, or null when it has none.
function known(id) {
  const r = players.get(id);
  if (r) r.lastSeen = new Date().toISOString();
  return r || null;
}

async function profileApi(req, res) {
  if (req.method === 'GET') { const id = identify(req, res); return json(res, 200, me(id, known(id) || blank())); }
  if (req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    const id = identify(req, res);
    const name = typeof b.name === 'string' ? clip(b.name) : null;
    // Setting a name is what makes a record; an empty one alone does not.
    const r = known(id) || (name ? touch(id) : blank());
    if (name !== null && players.has(id)) r.name = name;
    return json(res, 200, me(id, r));
  }
  return json(res, 404, {});
}

const rooms = new Map();
const menu = new Map();          // visitor id -> { name, seen }
const MENU_FOR = 20000;

// Drops rooms idle for hours or that nobody has polled for half an hour; with
// `full`, also rooms not started whose seats have all stopped polling.
function cleanup(full = false) {
  const now = Date.now();
  for (const [code, room] of rooms) {
    const polled = room.seats.length ? Math.max(...room.seats.map((s) => s.seen)) : room.created;
    if (now - room.active > IDLE_AFTER || now - polled > ABANDONED_AFTER || (full && !room.started && now - polled > GONE_AFTER)) {
      allBytes -= room.bytes;
      rooms.delete(code);
    }
  }
}

function makeRoom(priv) {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join(''); while (rooms.has(code));
  const room = { code, seats: [], log: [], started: false, waiters: [], private: priv, created: Date.now(), active: Date.now(), bytes: 0 };
  rooms.set(code, room);
  return room;
}

function append(room, seat, msg) {
  room.log.push({ n: room.log.length + 1, seat, msg });
  room.active = Date.now();
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

const newToken = () => randomBytes(16).toString('hex').toUpperCase();

// A seat belongs to a player id and a tab key (as Rooms.cs): two tabs of one
// browser are two seats, told apart by name ("Ana", "Ana 2").
function join(room, name, pid = null, tab = null) {
  if (pid) {
    const taken = new Set(room.seats.filter((s) => s.pid === pid && !s.gone).map((s) => s.name.toLowerCase()));
    for (let k = 2; taken.has(name.toLowerCase()) && k <= MAX_SEATS + 1; k++) {
      const tail = ` ${k}`;
      let cut = Math.min(name.length, 14 - tail.length);
      if (cut < name.length && /[\uD800-\uDBFF]/.test(name[cut - 1])) cut--;
      const next = name.slice(0, cut).trimEnd() + tail;
      if (!taken.has(next.toLowerCase())) { name = next; break; }
    }
  }
  const token = newToken();
  room.seats.push({ token, name, pid, tab, seen: Date.now(), gone: false });
  const seat = room.seats.length - 1;
  append(room, -1, { t: 'join', seat, name });
  return { code: room.code, seat, token };
}

// As Players.CleanName: no control or invisible formatting characters, trimmed,
// at most 14 UTF-16 units without splitting a surrogate pair.
function clip(s) {
  let t = String(s ?? '').replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').trim();
  if (t.length > 14) t = t.slice(0, /[\uD800-\uDBFF]/.test(t[13]) ? 13 : 14).trimEnd();
  return t;
}
// The name sent, else the player's saved name, else "Player".
const tabOf = (b) => (typeof b?.tab === 'string' && /^[A-Za-z0-9_-]{8,40}$/.test(b.tab) ? b.tab : null);
const nameOf = (b, pid) => clip(b?.name) || (pid && players.get(pid)?.name) || 'Player';

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
// A JSON object body and its size in bytes, or null (not an object, or past MAX_BODY).
const readRaw = (req) => new Promise((ok) => {
  const parts = [];
  let size = 0;
  req.on('data', (c) => { size += c.length; if (size <= MAX_BODY) parts.push(c); });
  req.on('end', () => {
    if (size > MAX_BODY) return ok(null);
    try { const v = JSON.parse(Buffer.concat(parts).toString('utf8')); ok(v && typeof v === 'object' && !Array.isArray(v) ? { value: v, size } : null); } catch { ok(null); }
  });
});
const readBody = async (req) => (await readRaw(req))?.value ?? null;

async function api(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean);   // api rooms [code] [action]
  const code = parts[2]?.toUpperCase();
  const action = parts[3];
  if (req.method === 'GET' && parts.length === 2) { cleanup(); return json(res, 200, list(url.searchParams.get('id'), url.searchParams.get('name'))); }
  const pid = cookieId(req);
  if (req.method === 'POST' && parts.length === 2) {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    cleanup();
    if (rooms.size >= MAX_ROOMS) cleanup(true);
    if (rooms.size >= MAX_ROOMS) return json(res, 503, {});
    if (pid) known(pid);
    return json(res, 200, join(makeRoom(b.private === true), nameOf(b, pid), pid, tabOf(b)));
  }
  const room = rooms.get(code);
  if (!room) return json(res, 404, { error: 'No room with that code.' });
  const seatOf = (token) => room.seats.findIndex((s) => s.token === token);
  if (req.method === 'POST' && action === 'join') {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    if (pid) known(pid);
    // This id and tab's seat is still here: hand it back, with a fresh token.
    const tab = tabOf(b);
    const mine = pid && tab ? room.seats.findIndex((s) => s.pid === pid && s.tab === tab && !s.gone) : -1;
    if (mine >= 0) {
      const s = room.seats[mine];
      s.token = newToken();
      s.seen = Date.now();
      return json(res, 200, { code: room.code, seat: mine, token: s.token, rejoin: true });
    }
    if (room.started) return json(res, 409, { error: 'That game has already started.' });
    if (room.seats.filter((s) => !s.gone).length >= MAX_SEATS) return json(res, 409, { error: 'That room is full.' });
    if (pid && tab) for (const s of room.seats) if (s.pid === pid && s.tab === tab) s.tab = null;   // a gone seat: let go
    return json(res, 200, join(room, nameOf(b, pid), pid, tab));
  }
  if (req.method === 'POST' && action === 'result') {
    // The host's report of the match's end; trusted as it is, like every client for now.
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    if (seatOf(b.token) !== 0) return json(res, 403, {});
    if (!room.started || !room.matchIds) return json(res, 409, {});
    if (!room.reported) {
      room.reported = true;
      const winner = Number.isInteger(b.winner) ? b.winner : null;
      // One match per player, even with two tabs (two seats) in it.
      const won = new Map();
      for (const [seat, id] of room.matchIds) won.set(id, won.get(id) || seat === winner);
      for (const [id, w] of won) { const r = touch(id); r.played++; if (w) r.won++; }
    }
    return json(res, 200, {});
  }
  if (req.method === 'POST' && action === 'leave') {
    const b = await readBody(req);
    const seat = seatOf(b?.token);
    if (seat < 0) return json(res, 403, {});
    if (!room.seats[seat].gone) { room.seats[seat].gone = true; append(room, -1, { t: 'gone', seat }); }
    return json(res, 200, {});
  }
  if (req.method === 'POST' && action === 'send') {
    const raw = await readRaw(req);
    const b = raw?.value;
    if (!b || !b.msg || typeof b.msg !== 'object' || Array.isArray(b.msg)) return json(res, 400, {});
    if (!rooms.has(room.code)) return json(res, 404, {});
    const seat = seatOf(b.token);
    if (seat < 0) return json(res, 403, {});
    if (b.msg.t === 'join' || b.msg.t === 'gone') return json(res, 400, {});
    if (b.msg.t === 'start' && seat !== 0) return json(res, 403, {});
    if (b.msg.t === 'start' && room.started) return json(res, 409, {});   // one match per room
    if (room.log.length >= MAX_ENTRIES || room.bytes + raw.size > MAX_ROOM_BYTES || allBytes + raw.size > MAX_ALL_BYTES) return json(res, 507, {});
    room.bytes += raw.size;
    allBytes += raw.size;
    if (b.msg.t === 'start') {
      room.started = true;
      room.matchIds = room.seats.map((s, i) => [i, s]).filter(([, s]) => !s.gone && s.pid).map(([i, s]) => [i, s.pid]);
    }
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

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname.startsWith('/api/rooms')) return api(req, res, url);
  if (url.pathname === '/api/me') return profileApi(req, res);
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
});
server.listen(port, () => {
  const { port } = server.address();
  console.log(`Craterfall dev server on http://localhost:${port}/`);
  // For a phone on the same Wi-Fi (Windows Firewall must let the port in).
  for (const [name, addrs] of Object.entries(networkInterfaces())) {
    for (const a of addrs || []) if (a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')) console.log(`  ${name}: http://${a.address}:${port}/`);
  }
});
