// Local server for trying online play: serves the game from web/ and the same
// rooms API as module/Rooms.cs (keep the two in step), under /api/rooms.
//   node tools/devserver.mjs [port]      then open http://localhost:8080/
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { randomBytes, randomInt } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2]) || 8080;
const HOLD = 20000, GONE_AFTER = 45000, MAX_SEATS = 6;
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.json': 'application/json', '.wasm': 'application/wasm' };

const rooms = new Map();

function makeRoom() {
  let code;
  do code = Array.from({ length: 4 }, () => LETTERS[randomInt(LETTERS.length)]).join(''); while (rooms.has(code));
  const room = { code, seats: [], log: [], started: false, waiters: [] };
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

const nameOf = (b) => (String(b?.name ?? '').trim().slice(0, 14) || 'Player');
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
  if (req.method === 'POST' && parts.length === 2) {
    const b = await readBody(req);
    if (!b) return json(res, 400, {});
    return json(res, 200, join(makeRoom(), nameOf(b)));
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
  let file = path.join(root, decodeURIComponent(url.pathname));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  try {
    if ((await stat(file)).isDirectory()) file = path.join(file, 'index.html');
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    res.end(body);
  } catch {
    res.writeHead(404);
    res.end();
  }
}).listen(port, () => console.log(`Craterfall dev server on http://localhost:${port}/`));
