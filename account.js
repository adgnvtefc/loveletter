// account.js: accounts, from the browser's side.
//
// Name + password become 64 bytes with Argon2id (the same settings as server/accounts.js,
// so the Mac and the browser agree): the first 32 are the sign-in secret sent to the
// post office, the last 32 are the keyring key, which never leaves this browser.
// Argon2id comes from hash-wasm, fetched only when an account is actually used.
//
// The keyring locks what goes on your shelf: each letter's key plus a small peek (who
// it's from, its first line, how many photos), so the post office can hand them back
// without being able to read them.
//
// Being signed in is remembered in localStorage only as a cache: if the browser forgets
// it, you sign in again and everything is still there, because it all lives on the server.

import { POST_OFFICE, normalize, unseal } from './store.js';

const ARGON2 = 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/argon2.umd.min.js';
const CACHE = 'loveletter:signed-in';
const enc = new TextEncoder(), dec = new TextDecoder();

let loading = null;
function argon2id() {
  loading ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = ARGON2;
    script.onload = () => resolve(window.hashwasm.argon2id);
    script.onerror = () => { loading = null; reject(new Error('could not load argon2')); };
    document.head.append(script);
  });
  return loading;
}

const toB64 = bytes => { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s); };
const fromB64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

export async function accountKeys(name, password) {
  const out = await (await argon2id())({
    password: normalize(name) + '\n' + password.trim(), salt: 'loveletter account v1',
    parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 64, outputType: 'binary',
  });
  return { secret: out.slice(0, 32), keyring: out.slice(32) };
}

// ---------- being signed in (a cache) ----------

function readCache() { try { return JSON.parse(localStorage.getItem(CACHE)); } catch { return null; } }
function writeCache(value) {
  try { value ? localStorage.setItem(CACHE, JSON.stringify(value)) : localStorage.removeItem(CACHE); } catch {}
}
let session = readCache();   // { name, token, keyring } or null

function remember(name, token, keyring) { session = { name, token, keyring: toB64(keyring) }; writeCache(session); }
function forget() { session = null; writeCache(null); }

export const signedInAs = () => session?.name ?? null;
export const authHeaders = () => (session ? { authorization: `Bearer ${session.token}` } : {});

// Is the cached sign-in still good? Forgets it if the post office says no.
export async function checkSignIn() {
  if (!session) return null;
  try {
    const res = await fetch(`${POST_OFFICE}/v1/session`, { headers: authHeaders() });
    if (res.status === 401) forget();
  } catch {}   // can't reach the post office: keep the cache, try again later
  return signedInAs();
}

// → 'ok' | 'wrong' | 'busy' | 'closed'
export async function signIn(name, password) {
  try {
    const { secret, keyring } = await accountKeys(name, password);
    const res = await fetch(`${POST_OFFICE}/v1/session`, { method: 'POST', body: JSON.stringify({ name, secret: toB64(secret) }) });
    if (!res.ok) return res.status === 401 ? 'wrong' : res.status === 429 ? 'busy' : 'closed';
    const { token, name: account } = await res.json();
    remember(account, token, keyring);
    return 'ok';
  } catch {
    return 'closed';
  }
}

export async function signOut() {
  const headers = authHeaders();
  forget();
  try { await fetch(`${POST_OFFICE}/v1/session`, { method: 'DELETE', headers }); } catch {}
}

// ---------- invites (temporary, see invite.js) ----------

// Is anyone invited to make their own account? (false if the post office can't be reached)
export async function invitesOpen() {
  try {
    const res = await fetch(`${POST_OFFICE}/v1/invites`, { signal: AbortSignal.timeout(4000) });
    return res.ok && (await res.json()).open === true;
  } catch {
    return false;
  }
}

// Makes the account and signs in. → 'ok' | 'not-invited' | 'busy' | 'closed'
export async function claimInvite(name, password) {
  try {
    const { secret, keyring } = await accountKeys(name, password);
    const res = await fetch(`${POST_OFFICE}/v1/invites`, { method: 'POST', body: JSON.stringify({ name, secret: toB64(secret) }) });
    if (!res.ok) return res.status === 403 ? 'not-invited' : res.status === 429 ? 'busy' : 'closed';
    const { token, name: account } = await res.json();
    remember(account, token, keyring);
    return 'ok';
  } catch {
    return 'closed';
  }
}

// ---------- the shelf ----------

async function keyring() {
  return crypto.subtle.importKey('raw', fromB64(session.keyring), 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function lock(value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyring(), enc.encode(JSON.stringify(value))));
  const out = new Uint8Array(12 + sealed.length);
  out.set(iv); out.set(sealed, 12);
  return out;
}
async function unlock(b64) {
  try {
    const bytes = fromB64(b64);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes.slice(0, 12) }, await keyring(), bytes.slice(12))));
  } catch {
    return null;   // locked with an older password
  }
}
async function call(path, options = {}) {
  const res = await fetch(`${POST_OFFICE}${path}`, { ...options, headers: { ...options.headers, ...authHeaders() } });
  if (res.status === 401) forget();
  return res;
}

// After opening or sealing a letter while signed in: lock its key and a peek onto your shelf.
// Best effort: if it fails, opening the letter with its password later tries again.
export async function shelve(id, keyBytes, letter) {
  if (!session || !id) return;
  const first = (letter.message ?? '').split('\n').find(line => line.trim())?.trim().slice(0, 60) ?? '';
  const peek = { k: toB64(keyBytes), from: letter.sender, first, photos: letter.photos?.length ?? 0 };
  try { await call(`/v1/shelf/${id}`, { method: 'PUT', body: await lock(peek) }); } catch {}
}

// → { name, sent: [...], opened: [...] }, each letter with its unlocked `peek` (or null), or null if signed out
export async function myShelf() {
  if (!session) return null;
  const res = await call('/v1/shelf');
  if (!res.ok) return null;
  const shelf = await res.json();
  for (const list of [shelf.sent, shelf.opened]) for (const l of list) l.peek = l.key ? await unlock(l.key) : null;
  return shelf;
}

// Tap to re-read: → the letter, or null if it can't be opened from the shelf
export async function reread(id) {
  if (!session) return null;
  const res = await call(`/v1/shelf/${id}`);
  if (!res.ok) return null;
  const { letter, key } = await res.json();
  const peek = await unlock(key);
  return peek && unseal(fromB64(letter), fromB64(peek.k));
}
