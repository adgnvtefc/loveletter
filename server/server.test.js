import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, createPostOffice, catseyeReporter, MAX_LETTER } from './server.js';

async function withServer(fn) {
  const server = createPostOffice({ db: openDb(':memory:') });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.close(); }
}
const ID = 'ab'.repeat(16);

test('a letter goes in once and comes back byte for byte', () => withServer(async base => {
  const bytes = new Uint8Array([1, 2, 3, 250, 0, 7]);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`)).status, 404);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: bytes })).status, 201);
  const res = await fetch(`${base}/v1/letters/${ID}`);
  assert.equal(res.status, 200);
  assert.deepEqual(new Uint8Array(await res.arrayBuffer()), bytes);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: new Uint8Array([9]) })).status, 409);
}));

test('bad ids, empty and oversized letters are refused', () => withServer(async base => {
  assert.equal((await fetch(`${base}/v1/letters/not-an-id`)).status, 404);
  assert.equal((await fetch(`${base}/v1/letters/${'AB'.repeat(16)}`)).status, 404);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: new Uint8Array() })).status, 400);
  const big = new Uint8Array(MAX_LETTER + 1);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: big })).status, 413);
  assert.equal((await fetch(`${base}/v1/letters/${ID}`)).status, 404);
}));

test('only the site itself is allowed by the browser', () => withServer(async base => {
  const ok = await fetch(`${base}/v1/letters/${ID}`, { method: 'OPTIONS', headers: { origin: 'https://adgnvtefc.github.io' } });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://adgnvtefc.github.io');
  assert.match(ok.headers.get('access-control-allow-methods'), /PUT/);
  const other = await fetch(`${base}/v1/letters/${ID}`, { headers: { origin: 'https://evil.example' } });
  assert.equal(other.headers.get('access-control-allow-origin'), null);
}));

test('sealing and opening are reported, with no ids or contents', async () => {
  const events = [];
  let t = 1_000_000;
  const server = createPostOffice({ db: openDb(':memory:'), now: () => t, report: (...e) => events.push(e) });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/v1/letters/${ID}`;
  try {
    await fetch(url, { method: 'PUT', body: new Uint8Array(3000), headers: { origin: 'https://adgnvtefc.github.io' } });
    await fetch(url, { method: 'PUT', body: new Uint8Array(10) });          // taken: not reported
    await fetch(`${url.slice(0, -2)}cd`);                                    // no such letter: not reported
    t += 5.5 * 3600_000;
    await fetch(url, { headers: { origin: 'https://evil.example' } });
    await fetch(url, { headers: { origin: 'http://localhost:4180' } });
    assert.deepEqual(events, [
      ['letter_sealed', { kb: 3 }, 'https://adgnvtefc.github.io'],
      ['letter_opened', { kb: 3, hours_waiting: 5.5, first: true }, undefined],
      ['letter_opened', { kb: 3, hours_waiting: 5.5, first: false }, 'http://localhost:4180'],
    ]);
  } finally { server.close(); }
});

test('the reporter posts the event to catseye with the page origin', async () => {
  const got = [];
  const catseye = createServer((req, res) => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => { got.push({ body: JSON.parse(body), origin: req.headers.origin }); res.end(); });
  });
  await new Promise(r => catseye.listen(0, '127.0.0.1', r));
  try {
    catseyeReporter(`http://127.0.0.1:${catseye.address().port}/v1/e`)('letter_sealed', { kb: 3 }, 'http://localhost:4180');
    while (!got.length) await new Promise(r => setTimeout(r, 10));
    assert.deepEqual(got[0], { body: { site: 'loveletter', name: 'letter_sealed', data: { kb: 3 } }, origin: 'http://localhost:4180' });
  } finally { catseye.close(); }
});

test('a letters table from before `opens` gains it and keeps its letters', () => {
  const file = join(mkdtempSync(join(tmpdir(), 'loveletter-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec('CREATE TABLE letters (id TEXT PRIMARY KEY, blob BLOB NOT NULL, sealed_at INTEGER NOT NULL)');
  old.prepare('INSERT INTO letters VALUES (?, ?, ?)').run(ID, Buffer.from([1]), 5);
  old.close();
  const db = openDb(file);
  assert.deepEqual({ ...db.prepare('SELECT id, sealed_at, opens FROM letters').get() }, { id: ID, sealed_at: 5, opens: 0 });
  openDb(file).close();   // opening again is fine
  db.close();
});
