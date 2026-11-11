import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb, createPostOffice, MAX_LETTER } from './server.js';

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
