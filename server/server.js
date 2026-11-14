// server/server.js: the post office. Keeps sealed letters and hands them back by id.
//
// It never sees a name, a password, or what a letter says: the browser turns
// name + password into an id and a key, encrypts the letter, and sends only
// the id and the encrypted bytes. So this is just a box of locked envelopes.
//
// Letters (anyone):
//   GET    /v1/letters/<id>   → 200 the bytes, or 404
//   PUT    /v1/letters/<id>   → 201 stored, 409 id taken, 413 too big, 429 too many, 507 box full
// Accounts (invite-only, see accounts.js). Signed-in requests send `authorization: Bearer <token>`:
//   POST   /v1/session        {name, secret} → {token, name}, or 401
//   GET    /v1/session        → {name}, or 401 (is this token still good?)
//   DELETE /v1/session        → 204 signed out
//   GET    /v1/shelf          → {sent: [...], opened: [...]}
//   GET    /v1/shelf/<id>     → {letter, key}: the bytes and the key locked by your keyring, or 404
//   PUT    /v1/shelf/<id>     body = the letter's key, locked by your keyring → 204, or 404 if not on your shelf
//   GET    /v1/invites        → {open}: is anyone invited to make their own account? (never says who)
//   POST   /v1/invites        {name, secret} → {token, name} for the new account, or 403 if not invited
// Sealing while signed in puts the letter on your "sent" shelf; opening it on your "opened" one.
// Your own opens of your own letter don't mark it opened.
//
// Public through Tailscale Funnel at /loveletter (Funnel strips that prefix).
//
// Each sealed and opened letter is reported to catseye (letter_sealed, letter_opened),
// with no names, ids or contents: just sizes, how long a letter waited, and first-or-not.

import { createServer, request } from 'node:http';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';
import { signIn, sessionAccount, signOut, invitesOpen, claimInvite } from './accounts.js';

const LETTER = /^\/v1\/letters\/([0-9a-f]{32})$/;
const SHELF_ITEM = /^\/v1\/shelf\/([0-9a-f]{32})$/;
export const MAX_LETTER = 12 * 1024 * 1024;        // bytes in one sealed letter (4 photos fit easily)
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;   // all letters together
const ORIGINS = new Set(['https://adgnvtefc.github.io', 'http://localhost:4180', 'http://127.0.0.1:4180',
  ...(process.env.LOVELETTER_ORIGINS ?? '').split(',').filter(Boolean)]);

// Send one event to catseye in the background: catseye being slow or down never affects a letter.
// The page's origin is passed along so catseye can leave out local testing.
export function catseyeReporter(url) {
  return (name, data, origin) => {
    const req = request(url, { method: 'POST', timeout: 5000, headers: { 'content-type': 'text/plain', ...(origin && { origin }) } });
    req.on('response', res => res.resume());
    req.on('timeout', () => req.destroy(new Error('timed out')));
    req.on('error', e => console.warn(`catseye report failed: ${e.message}`));
    req.end(JSON.stringify({ site: 'loveletter', name, data }));
  };
}

// At most `max` hits in any rolling window (same idea as catseye's limiter).
function limiter(max, windowMs) {
  const hits = new Array(max).fill(-Infinity);
  let oldest = 0;
  return now => {
    if (now - hits[oldest] < windowMs) return false;
    hits[oldest] = now;
    oldest = (oldest + 1) % max;
    return true;
  };
}

// The request body, up to `max` bytes. Bigger: answers 413 itself and gives null.
function readBody(req, res, max) {
  return new Promise(resolve => {
    // A size announced up front: answer 413 and let the rest of the upload drain, because cutting the
    // connection mid-upload makes the browser see a network error instead. Only an unannounced
    // body that turns out too big is cut off.
    const tooBig = cut => { res.statusCode = 413; res.end(); if (cut) req.destroy(); else req.resume(); resolve(null); };
    if (Number(req.headers['content-length']) > max) return tooBig(false);
    const chunks = [];
    let size = 0, over = false;
    req.on('data', chunk => {
      if (over) return;
      size += chunk.length;
      if (size > max) { over = true; tooBig(true); } else chunks.push(chunk);
    });
    req.on('end', () => { if (!over) resolve(Buffer.concat(chunks)); });
    req.on('error', () => { if (!over) { over = true; resolve(null); } });
  });
}

export function createPostOffice({ db, now = Date.now, report = () => {} }) {
  const q = {
    exists: db.prepare('SELECT 1 FROM letters WHERE id = ?'),
    peek: db.prepare('SELECT blob, sealed_at FROM letters WHERE id = ?'),
    open: db.prepare('UPDATE letters SET opens = opens + 1 WHERE id = ? RETURNING blob, sealed_at, first_opened_at'),
    markOpened: db.prepare('UPDATE letters SET first_opened_at = ? WHERE id = ? AND first_opened_at IS NULL'),
    put: db.prepare('INSERT OR IGNORE INTO letters (id, blob, sealed_at) VALUES (?, ?, ?)'),
    total: db.prepare('SELECT coalesce(sum(length(blob)), 0) AS n FROM letters'),
    sender: db.prepare("SELECT account_id FROM shelf WHERE letter_id = ? AND role = 'sent'"),
    shelveSent: db.prepare("INSERT OR IGNORE INTO shelf (account_id, letter_id, role, first_at, last_at) VALUES (?, ?, 'sent', ?, ?)"),
    shelveOpened: db.prepare(`INSERT INTO shelf (account_id, letter_id, role, first_at, last_at) VALUES (?, ?, 'opened', ?, ?)
      ON CONFLICT (account_id, letter_id, role) DO UPDATE SET last_at = excluded.last_at`),
    touch: db.prepare('UPDATE shelf SET last_at = ? WHERE account_id = ? AND letter_id = ? AND role = ?'),
    setKey: db.prepare('UPDATE shelf SET locked_key = ? WHERE account_id = ? AND letter_id = ?'),
    key: db.prepare(`SELECT role, locked_key FROM shelf WHERE account_id = ? AND letter_id = ? AND locked_key IS NOT NULL
      ORDER BY role = 'sent' DESC LIMIT 1`),
    sent: db.prepare(`SELECT l.id, l.sealed_at, l.first_opened_at IS NOT NULL AS opened, s.locked_key IS NOT NULL AS readable
      FROM shelf s JOIN letters l ON l.id = s.letter_id WHERE s.account_id = ? AND s.role = 'sent' ORDER BY l.sealed_at DESC`),
    opened: db.prepare(`SELECT l.id, l.sealed_at, s.first_at, s.last_at, s.locked_key IS NOT NULL AS readable
      FROM shelf s JOIN letters l ON l.id = s.letter_id WHERE s.account_id = ? AND s.role = 'opened' ORDER BY s.first_at DESC`),
  };
  const canRead = limiter(240, 60_000);         // slows down anyone guessing passwords
  const canWrite = limiter(30, 60 * 60_000);    // new letters per hour, everyone together
  const canSignIn = limiter(20, 15 * 60_000);   // sign-in attempts, everyone together
  const opening = (blob, sealedAt, first) =>
    ({ kb: Math.round(blob.length / 1024), hours_waiting: Math.round((now() - sealedAt) / 360_000) / 10, first });

  async function handle(req, res) {
    const origin = ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    const done = (status, body) => { res.statusCode = status; res.end(body); };
    const json = (status, value) => { res.setHeader('content-type', 'application/json'); res.setHeader('cache-control', 'no-store'); done(status, JSON.stringify(value)); };
    const { pathname } = new URL(req.url, 'http://post');
    const { method } = req;

    if (method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, PUT, POST, DELETE');
      res.setHeader('access-control-allow-headers', 'content-type, authorization');
      res.setHeader('access-control-max-age', '86400');
      return done(204);
    }
    if (method === 'GET' && pathname === '/health') return done(200, 'ok');

    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
    const me = token ? sessionAccount(db, token, now()) : null;   // a stale token just means signed out

    // ---- accounts ----
    if (pathname === '/v1/session') {
      if (method === 'GET') return me ? json(200, { name: me.name }) : done(401);
      if (method === 'DELETE') { signOut(db, token); return done(204); }
      if (method !== 'POST') return done(405);
      const body = await readBody(req, res, 4096);
      if (!body) return;
      if (!canSignIn(now())) return done(429);
      let sent;
      try { sent = JSON.parse(body); } catch { return done(400); }
      const session = signIn(db, sent?.name, Buffer.from(String(sent?.secret ?? ''), 'base64'), now());
      return session ? json(200, session) : done(401);
    }
    if (pathname === '/v1/invites') {
      if (method === 'GET') return json(200, { open: invitesOpen(db) });
      if (method !== 'POST') return done(405);
      const body = await readBody(req, res, 4096);
      if (!body) return;
      if (!canSignIn(now())) return done(429);
      let sent;
      try { sent = JSON.parse(body); } catch { return done(400); }
      const session = claimInvite(db, sent?.name, Buffer.from(String(sent?.secret ?? ''), 'base64'), now());
      return session ? json(200, session) : done(403);
    }
    if (pathname === '/v1/shelf') {
      if (method !== 'GET') return done(405);
      if (!me) return done(401);
      const flags = r => ({ ...r, readable: !!r.readable, ...('opened' in r && { opened: !!r.opened }) });
      return json(200, { name: me.name, sent: q.sent.all(me.id).map(flags), opened: q.opened.all(me.id).map(flags) });
    }
    const shelfId = SHELF_ITEM.exec(pathname)?.[1];
    if (shelfId) {
      if (!me) return done(401);
      if (method === 'PUT') {
        const body = await readBody(req, res, 256);
        if (!body) return;
        if (!body.length) return done(400);
        return done(q.setKey.run(body, me.id, shelfId).changes ? 204 : 404);
      }
      if (method !== 'GET') return done(405);
      if (!canRead(now())) return done(429);
      const kept = q.key.get(me.id, shelfId);
      if (!kept) return done(404);
      const letter = kept.role === 'opened' ? q.open.get(shelfId) : q.peek.get(shelfId);
      q.touch.run(now(), me.id, shelfId, kept.role);
      json(200, { letter: Buffer.from(letter.blob).toString('base64'), key: Buffer.from(kept.locked_key).toString('base64') });
      if (kept.role === 'opened') report('letter_opened', opening(letter.blob, letter.sealed_at, false), origin);
      return;
    }

    // ---- letters ----
    const id = LETTER.exec(pathname)?.[1];
    if (!id) return done(404);

    if (method === 'GET') {
      if (!canRead(now())) return done(429);
      const own = me && q.sender.get(id)?.account_id === me.id;
      const row = own ? q.peek.get(id) : q.open.get(id);
      if (!row) return done(404);
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      done(200, Buffer.from(row.blob));
      if (own) return;   // checking your own letter isn't an open
      const t = now();
      q.markOpened.run(t, id);
      if (me) q.shelveOpened.run(me.id, id, t, t);
      return report('letter_opened', opening(row.blob, row.sealed_at, row.first_opened_at == null), origin);
    }

    if (method !== 'PUT') return done(405);
    const body = await readBody(req, res, MAX_LETTER);
    if (!body) return;
    if (!body.length) return done(400);
    if (q.exists.get(id)) return done(409);
    if (q.total.get().n + body.length > MAX_TOTAL) return done(507);
    if (!canWrite(now())) return done(429);
    const t = now();
    const { changes } = q.put.run(id, body, t);
    if (changes && me) q.shelveSent.run(me.id, id, t, t);
    done(changes ? 201 : 409);
    if (changes) report('letter_sealed', { kb: Math.round(body.length / 1024) }, origin);
  }

  return createServer((req, res) => handle(req, res).catch(err => {
    console.error(err);
    if (!res.headersSent) { res.statusCode = 500; res.end(); }
  }));
}

if (import.meta.main) {
  const home = process.env.LOVELETTER_HOME ?? join(homedir(), '.loveletter');
  const port = Number(process.env.PORT ?? 8792);
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = openDb(join(home, 'letters.db'));
  const catseye = process.env.CATSEYE_URL ?? 'http://127.0.0.1:8790/v1/e';
  createPostOffice({ db, report: catseyeReporter(catseye) }).listen(port, '127.0.0.1', () => {
    console.log(`loveletter post office on http://127.0.0.1:${port} (data: ${home}, reporting to ${catseye})`);
  });
  // launchd stops us with SIGTERM; closing folds the WAL back into the main file.
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => { db.close(); process.exit(0); });
}
