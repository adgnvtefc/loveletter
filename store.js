// store.js: sealing and opening letters.
//
// A letter is found by its sender's name + password. From those two, the browser derives:
//   id  — where the sealed letter is kept (the only thing the post office sees)
//   key — the AES key that seals it (never leaves the browser)
// So the post office (server/server.js, on the Mac) only ever holds unreadable bytes,
// and two people can use the same password as long as their names differ.

const enc = new TextEncoder(), dec = new TextDecoder();

// The post office: the Mac through Tailscale Funnel, or the local one while developing.
// On localhost, `?office=8793` points at a throwaway post office on that port instead (for testing).
const local = ['localhost', '127.0.0.1'].includes(location.hostname);
const testPort = new URLSearchParams(location.search).get('office');
export const POST_OFFICE = !local ? 'https://hanmos-mac-studio.tail6c4683.ts.net/loveletter'
  : `http://localhost:${/^\d{4,5}$/.test(testPort ?? '') ? testPort : 8792}`;

// "  Billy " and "billy" are the same sender; passwords ignore case and extra spaces too,
// because phones love to capitalise the first letter.
export const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function derive(sender, password) {
  const secret = await crypto.subtle.importKey('raw', enc.encode(normalize(sender) + '\n' + normalize(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('loveletter v1'), iterations: 150000 }, secret, 512));
  const id = [...bits.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  const keyBytes = bits.slice(32);   // kept so a signed-in browser can lock it onto its shelf
  const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key, keyBytes };
}

// Unseal a letter's bytes with its raw key → the letter, or null if the key doesn't fit.
export async function unseal(blob, keyBytes) {
  try {
    const key = await crypto.subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
    return JSON.parse(dec.decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12))));
  } catch {
    return null;
  }
}

// Network failures throw; callers say the post office is closed.
const STATUS = { 201: 'ok', 409: 'taken', 413: 'too-big', 429: 'busy', 507: 'full' };

// letter: { sender, password, message, photos: [data URLs] }; `headers` carries a sign-in, if any.
// → { status: 'ok' | 'taken' | 'too-big' | 'busy' | 'full' | 'error', id, keyBytes }
export async function sealLetter({ sender, password, message, photos }, headers = {}) {
  const { id, key, keyBytes } = await derive(sender, password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(JSON.stringify({ v: 1, sender: sender.trim(), message, photos, sealedAt: new Date().toISOString() }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const blob = new Uint8Array(iv.length + sealed.length);
  blob.set(iv); blob.set(sealed, iv.length);
  const res = await fetch(`${POST_OFFICE}/v1/letters/${id}`, { method: 'PUT', body: blob, headers: { 'content-type': 'application/octet-stream', ...headers } });
  return { status: STATUS[res.status] ?? 'error', id, keyBytes };
}

// → { letter: { sender, message, photos, sealedAt }, id, keyBytes }, or null when nothing matches.
// `headers` carries a sign-in, if any, so the post office can put it on your shelf.
export async function openLetter(sender, password, headers = {}) {
  const { id, keyBytes } = await derive(sender, password);
  return openWithKey(id, keyBytes, headers);
}

// ---------- links ----------
// A link carries the letter's id and key (not its name or password) after the #, which
// browsers never send anywhere: not to GitHub, not to link-preview servers. 48 bytes → 64 characters.

const toB64url = bytes => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const fromB64url = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));

export function letterLink(base, id, keyBytes) {
  const token = new Uint8Array(48);
  token.set(id.match(/../g).map(h => parseInt(h, 16)));
  token.set(keyBytes, 16);
  return `${base}#open=${toB64url(token)}`;
}

// '#open=…' → { id, keyBytes, token }, or null
export function readLink(hash) {
  const token = /^#open=([A-Za-z0-9_-]{64})$/.exec(hash)?.[1];
  if (!token) return null;
  const bytes = fromB64url(token);
  return { id: [...bytes.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join(''), keyBytes: bytes.slice(16), token };
}

// Open a letter when you already have its id and key (from a link).
export async function openWithKey(id, keyBytes, headers = {}) {
  const res = await fetch(`${POST_OFFICE}/v1/letters/${id}`, { headers });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`post office said ${res.status}`);
  const letter = await unseal(new Uint8Array(await res.arrayBuffer()), keyBytes);
  return letter && { letter, id, keyBytes };
}
