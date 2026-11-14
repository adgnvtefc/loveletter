import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPostOffice, catseyeReporter, MAX_LETTER } from './server.js';
import { openDb } from './db.js';
import { createAccount, accountSecrets, setPassword, backfill, invite } from './accounts.js';

async function withServer(fn, db = openDb(':memory:')) {
  const server = createPostOffice({ db });
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
  assert.match(ok.headers.get('access-control-allow-headers'), /authorization/);
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
  assert.deepEqual({ ...db.prepare('SELECT id, sealed_at, opens, first_opened_at FROM letters').get() }, { id: ID, sealed_at: 5, opens: 0, first_opened_at: null });
  openDb(file).close();   // opening again is fine
  db.close();
});

// ---------- accounts ----------

const ID2 = 'cd'.repeat(16);
const secretOf = (name, password) => accountSecrets(name, password).secret.toString('base64');
async function signInAs(base, name, password) {
  const res = await fetch(`${base}/v1/session`, { method: 'POST', body: JSON.stringify({ name, secret: secretOf(name, password) }) });
  return res.ok ? (await res.json()).token : res.status;
}
const as = token => ({ headers: { authorization: `Bearer ${token}` } });
async function shelfOf(base, token) { return (await fetch(`${base}/v1/shelf`, as(token))).json(); }

test('signing in, staying signed in, signing out', async () => {
  const db = openDb(':memory:');
  createAccount(db, ' Billy ', 'hunter two');
  await withServer(async base => {
    assert.equal(await signInAs(base, 'billy', 'hunter three'), 401);
    assert.equal(await signInAs(base, 'nobody', 'hunter two'), 401);
    const token = await signInAs(base, 'BILLY', 'hunter two');
    assert.equal(typeof token, 'string');
    assert.deepEqual(await (await fetch(`${base}/v1/session`, as(token))).json(), { name: 'billy' });
    assert.equal((await fetch(`${base}/v1/session`, { method: 'DELETE', ...as(token) })).status, 204);
    assert.equal((await fetch(`${base}/v1/session`, as(token))).status, 401);
    assert.equal((await fetch(`${base}/v1/shelf`)).status, 401);
  }, db);
});

test('shelves: sent and opened, own opens ignored, tap to re-read', async () => {
  const db = openDb(':memory:');
  createAccount(db, 'billy', 'pw one');
  createAccount(db, 'bob', 'pw two');
  await withServer(async base => {
    const billy = await signInAs(base, 'billy', 'pw one'), bob = await signInAs(base, 'bob', 'pw two');
    const letter = new Uint8Array([5, 6, 7]);
    assert.equal((await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: letter, ...as(billy) })).status, 201);
    assert.equal((await fetch(`${base}/v1/letters/${ID2}`, { method: 'PUT', body: letter })).status, 201);  // signed out: nobody's

    // billy checks his own letter: still unopened, and not on his "opened" shelf
    assert.equal((await fetch(`${base}/v1/letters/${ID}`, as(billy))).status, 200);
    let shelf = await shelfOf(base, billy);
    assert.deepEqual(shelf.sent.map(l => [l.id, l.opened, l.readable]), [[ID, false, false]]);
    assert.deepEqual(shelf.opened, []);
    assert.equal((await fetch(`${base}/v1/shelf/${ID}`, { method: 'PUT', body: new Uint8Array([7, 7]), ...as(billy) })).status, 204);

    // bob opens it: billy sees it opened, bob has it on his shelf
    assert.equal((await fetch(`${base}/v1/letters/${ID}`, as(bob))).status, 200);
    assert.equal((await shelfOf(base, billy)).sent[0].opened, true);
    shelf = await shelfOf(base, bob);
    assert.deepEqual(shelf.sent, []);
    assert.deepEqual(shelf.opened.map(l => [l.id, l.readable]), [[ID, false]]);

    // re-reading needs the key on your shelf first
    assert.equal((await fetch(`${base}/v1/shelf/${ID}`, as(bob))).status, 404);
    assert.equal((await fetch(`${base}/v1/shelf/${ID}`, { method: 'PUT', body: new Uint8Array([9, 9]), ...as(bob) })).status, 204);
    const reread = await (await fetch(`${base}/v1/shelf/${ID}`, as(bob))).json();
    assert.deepEqual([...Buffer.from(reread.letter, 'base64')], [5, 6, 7]);
    assert.deepEqual([...Buffer.from(reread.key, 'base64')], [9, 9]);
    assert.deepEqual([...Buffer.from((await (await fetch(`${base}/v1/shelf/${ID}`, as(billy))).json()).key, 'base64')], [7, 7]);

    // only your own shelf: not someone else's letter, not signed out
    assert.equal((await fetch(`${base}/v1/shelf/${ID2}`, { method: 'PUT', body: new Uint8Array([1]), ...as(bob) })).status, 404);
    assert.equal((await fetch(`${base}/v1/shelf/${ID}`, { method: 'PUT', body: new Uint8Array([1]) })).status, 401);
  }, db);
});

test('a signed-out open still counts as opened', async () => {
  const db = openDb(':memory:');
  createAccount(db, 'billy', 'pw one');
  await withServer(async base => {
    const billy = await signInAs(base, 'billy', 'pw one');
    await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: new Uint8Array([1]), ...as(billy) });
    await fetch(`${base}/v1/letters/${ID}`);
    assert.equal((await shelfOf(base, billy)).sent[0].opened, true);
  }, db);
});

test('a new password clears locked keys and signs out everywhere', async () => {
  const db = openDb(':memory:');
  createAccount(db, 'billy', 'old');
  await withServer(async base => {
    const billy = await signInAs(base, 'billy', 'old');
    await fetch(`${base}/v1/letters/${ID}`, { method: 'PUT', body: new Uint8Array([1]), ...as(billy) });
    await fetch(`${base}/v1/shelf/${ID}`, { method: 'PUT', body: new Uint8Array([7]), ...as(billy) });
    setPassword(db, 'billy', 'new');
    assert.equal((await fetch(`${base}/v1/session`, as(billy))).status, 401);
    assert.equal(await signInAs(base, 'billy', 'old'), 401);
    const again = await signInAs(base, 'billy', 'new');
    assert.deepEqual((await shelfOf(base, again)).sent.map(l => l.readable), [false]);
  }, db);
});

test('backfill puts old letters on both shelves, once', async () => {
  const db = openDb(':memory:');
  createAccount(db, 'billy', 'pw one');
  createAccount(db, 'bob', 'pw two');
  db.prepare('INSERT INTO letters (id, blob, sealed_at) VALUES (?, ?, ?)').run(ID, Buffer.from([1]), 1000);
  const entries = [{ letter_id: ID, sender: 'billy', reader: 'Bob', sealed_at: 1000, first_opened_at: 5000 }];
  assert.equal(backfill(db, entries), 1);
  backfill(db, entries);
  assert.throws(() => backfill(db, [{ ...entries[0], sender: 'carol' }]), /carol/);
  await withServer(async base => {
    const billy = await signInAs(base, 'billy', 'pw one'), bob = await signInAs(base, 'bob', 'pw two');
    assert.deepEqual((await shelfOf(base, billy)).sent.map(l => [l.id, l.sealed_at, l.opened, l.readable]), [[ID, 1000, true, false]]);
    assert.deepEqual((await shelfOf(base, bob)).opened.map(l => [l.id, l.first_at]), [[ID, 5000]]);
  }, db);
});

test('an invited name can make its own account once, choosing its password', async () => {
  const db = openDb(':memory:');
  createAccount(db, 'billy', 'pw one');
  assert.throws(() => invite(db, 'Billy'), /already has an account/);
  await withServer(async base => {
    const claim = (name, password) => fetch(`${base}/v1/invites`, { method: 'POST', body: JSON.stringify({ name, secret: secretOf(name, password) }) });
    assert.deepEqual(await (await fetch(`${base}/v1/invites`)).json(), { open: false });
    invite(db, ' Bob ');
    assert.deepEqual(await (await fetch(`${base}/v1/invites`)).json(), { open: true });
    assert.equal((await claim('carol', 'mine')).status, 403);
    assert.equal((await claim('billy', 'stolen')).status, 403);
    const made = await claim('BOB', 'her own choice');
    assert.equal(made.status, 200);
    const { token, name } = await made.json();
    assert.equal(name, 'bob');
    assert.deepEqual(await (await fetch(`${base}/v1/session`, as(token))).json(), { name: 'bob' });
    assert.equal((await claim('bob', 'second try')).status, 403);          // only once
    assert.equal(await signInAs(base, 'bob', 'second try'), 401);
    assert.equal(typeof await signInAs(base, 'bob', 'her own choice'), 'string');
    assert.deepEqual(await (await fetch(`${base}/v1/invites`)).json(), { open: false });
  }, db);
});
