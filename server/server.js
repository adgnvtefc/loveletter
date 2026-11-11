// server/server.js: the post office. Keeps sealed letters and hands them back by id.
//
// It never sees a name, a password, or what a letter says: the browser turns
// name + password into an id and a key, encrypts the letter, and sends only
// the id and the encrypted bytes. So this is just a box of locked envelopes.
//
//   GET  /v1/letters/<id>   → 200 the bytes, or 404
//   PUT  /v1/letters/<id>   → 201 stored, 409 id taken, 413 too big, 429 too many, 507 box full
//
// Public through Tailscale Funnel at /loveletter (Funnel strips that prefix).
//
// Each sealed and opened letter is reported to catseye (letter_sealed, letter_opened),
// with no names, ids or contents: just sizes, how long a letter waited, and first-or-not.

import { createServer, request } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ID = /^\/v1\/letters\/([0-9a-f]{32})$/;
export const MAX_LETTER = 12 * 1024 * 1024;        // bytes in one sealed letter (4 photos fit easily)
export const MAX_TOTAL = 2 * 1024 * 1024 * 1024;   // all letters together
const ORIGINS = new Set(['https://adgnvtefc.github.io', 'http://localhost:4180', 'http://127.0.0.1:4180',
  ...(process.env.LOVELETTER_ORIGINS ?? '').split(',').filter(Boolean)]);

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS letters (id TEXT PRIMARY KEY, blob BLOB NOT NULL, sealed_at INTEGER NOT NULL);`);
  // `opens` came later; letters sealed before it start at 0.
  if (!db.prepare('PRAGMA table_info(letters)').all().some(c => c.name === 'opens'))
    db.exec('ALTER TABLE letters ADD COLUMN opens INTEGER NOT NULL DEFAULT 0');
  return db;
}

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

export function createPostOffice({ db, now = Date.now, report = () => {} }) {
  const get = db.prepare('SELECT 1 FROM letters WHERE id = ?');
  const open = db.prepare('UPDATE letters SET opens = opens + 1 WHERE id = ? RETURNING blob, opens, sealed_at');
  const put = db.prepare('INSERT OR IGNORE INTO letters (id, blob, sealed_at) VALUES (?, ?, ?)');
  const total = db.prepare('SELECT coalesce(sum(length(blob)), 0) AS n FROM letters');
  const canRead = limiter(240, 60_000);         // slows down anyone guessing passwords
  const canWrite = limiter(30, 60 * 60_000);    // new letters per hour, everyone together

  return createServer((req, res) => {
    const origin = ORIGINS.has(req.headers.origin) ? req.headers.origin : undefined;
    if (origin) {
      res.setHeader('access-control-allow-origin', origin);
      res.setHeader('vary', 'origin');
    }
    const done = (status, body) => { res.statusCode = status; res.end(body); };
    const { pathname } = new URL(req.url, 'http://post');

    if (req.method === 'OPTIONS') {
      res.setHeader('access-control-allow-methods', 'GET, PUT');
      res.setHeader('access-control-allow-headers', 'content-type');
      res.setHeader('access-control-max-age', '86400');
      return done(204);
    }
    if (req.method === 'GET' && pathname === '/health') return done(200, 'ok');
    const id = ID.exec(pathname)?.[1];
    if (!id) return done(404);

    if (req.method === 'GET') {
      if (!canRead(now())) return done(429);
      const row = open.get(id);
      if (!row) return done(404);
      res.setHeader('content-type', 'application/octet-stream');
      res.setHeader('cache-control', 'no-store');
      done(200, Buffer.from(row.blob));
      return report('letter_opened', {
        kb: Math.round(row.blob.length / 1024),
        hours_waiting: Math.round((now() - row.sealed_at) / 360_000) / 10,
        first: row.opens === 1,
      }, origin);
    }

    if (req.method !== 'PUT') return done(405);
    if (Number(req.headers['content-length']) > MAX_LETTER) return done(413);
    const chunks = [];
    let size = 0;
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_LETTER) { done(413); req.destroy(); } else chunks.push(chunk);
    });
    req.on('end', () => {
      if (size === 0) return done(400);
      if (get.get(id)) return done(409);
      if (total.get().n + size > MAX_TOTAL) return done(507);
      if (!canWrite(now())) return done(429);
      const { changes } = put.run(id, Buffer.concat(chunks), now());
      done(changes ? 201 : 409);
      if (changes) report('letter_sealed', { kb: Math.round(size / 1024) }, origin);
    });
  });
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
