#!/usr/bin/env node
// Read and triage the suggestion box (module/Suggestions.cs) from a shell: for
// the owner and their agents. Same data as suggestions.html.
//
//   node tools/suggestions.mjs                    new suggestions, newest first
//   node tools/suggestions.mjs --status all       or done
//   node tools/suggestions.mjs --json             raw JSON (for scripts and agents)
//   node tools/suggestions.mjs done <id> [note]   mark one handled, with an optional note
//   node tools/suggestions.mjs reopen <id>        back to new
//   node tools/suggestions.mjs note <id> <text>   set the note only
//   --base <url>   the game's URL (default https://blogfor.net/Craterfall/;
//                  http://localhost:8090/ for the dev server)
//
// The review key is CRATERFALL_REVIEW_KEY, else "reviewKey" in the gitignored
// tools/local.json (the dev server's default is "dev"). It reads and marks
// suggestions only; it is not the deploy key.
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return null;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const has = (name) => { const i = args.indexOf(name); if (i < 0) return false; args.splice(i, 1); return true; };

const base = (flag('--base') || process.env.CRATERFALL_BASE || 'https://blogfor.net/Craterfall/').replace(/\/?$/, '/');
const status = flag('--status') || 'new';
const asJson = has('--json');
const local = await readFile(path.join(here, 'local.json'), 'utf8').then(JSON.parse).catch(() => ({}));
const key = process.env.CRATERFALL_REVIEW_KEY || local.reviewKey || (/localhost|127\.0\.0\.1/.test(base) ? 'dev' : '');
if (!key) { console.error('No review key: set CRATERFALL_REVIEW_KEY or "reviewKey" in tools/local.json.'); process.exit(2); }

async function call(p = '', body) {
  const r = await fetch(new URL(`api/suggestions${p}`, base), {
    method: body ? 'POST' : 'GET',
    headers: { 'x-review-key': key, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) {
    const why = r.status === 401 ? 'the review key was not accepted' : r.status === 404 ? 'not found (or reading is off on this server)' : `HTTP ${r.status}`;
    console.error(`${base}: ${why}`);
    process.exit(1);
  }
  return r.json();
}

const [cmd, id, ...rest] = args;
if (cmd === 'done' || cmd === 'reopen' || cmd === 'note') {
  if (!id) { console.error(`usage: ${cmd} <id>${cmd === 'reopen' ? '' : ' [note]'}`); process.exit(2); }
  const change = cmd === 'note' ? { note: rest.join(' ') } : { status: cmd === 'done' ? 'done' : 'new', ...(rest.length ? { note: rest.join(' ') } : {}) };
  const s = await call(`/${encodeURIComponent(id)}`, change);
  console.log(asJson ? JSON.stringify(s, null, 2) : `${s.id}: ${s.status}${s.note ? ` (${s.note})` : ''}`);
} else if (cmd) {
  console.error(`unknown command "${cmd}" (try: done, reopen, note, or nothing to list)`);
  process.exit(2);
} else {
  const list = await call(`?status=${encodeURIComponent(status)}`);
  if (asJson) console.log(JSON.stringify(list, null, 2));
  else if (!list.length) console.log(`No ${status === 'all' ? '' : `${status} `}suggestions.`);
  else {
    for (const s of list) {
      const who = s.name || (s.player ? `player ${s.player.slice(0, 6)}` : 'anonymous');
      const ctx = s.context ? Object.entries(s.context).filter(([k]) => k !== 'ua').map(([k, v]) => `${k}=${v}`).join(' ') : '';
      console.log(`[${s.id}] ${s.at.slice(0, 16).replace('T', ' ')} · ${s.area} · ${who}${s.status === 'done' ? ' · DONE' : ''}`);
      console.log(`  ${s.text.replace(/\n/g, '\n  ')}`);
      if (ctx) console.log(`  (${ctx})`);
      if (s.note) console.log(`  note: ${s.note}`);
      console.log();
    }
    console.log(`${list.length} ${status === 'all' ? '' : `${status} `}suggestion${list.length === 1 ? '' : 's'}.`);
  }
}
