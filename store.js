// store.js: sealing and opening letters.
//
// A letter is found by its sender's name + password. From those two, the browser derives:
//   id  — where the sealed letter is kept (the only thing the post office sees)
//   key — the AES key that seals it (never leaves the browser)
// So the post office (server/server.js, on the Mac) only ever holds unreadable bytes,
// and two people can use the same password as long as their names differ.

const enc = new TextEncoder(), dec = new TextDecoder();

// The post office: the local server while developing, the Mac through Tailscale Funnel otherwise.
const POST_OFFICE = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? 'http://localhost:8792'
  : 'https://hanmos-mac-studio.tail6c4683.ts.net/loveletter';

// "  Billy " and "billy" are the same sender; passwords ignore case and extra spaces too,
// because phones love to capitalise the first letter.
export const normalize = s => s.trim().toLowerCase().replace(/\s+/g, ' ');

async function derive(sender, password) {
  const secret = await crypto.subtle.importKey('raw', enc.encode(normalize(sender) + '\n' + normalize(password)), 'PBKDF2', false, ['deriveBits']);
  const bits = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode('loveletter v1'), iterations: 150000 }, secret, 512));
  const id = [...bits.slice(0, 16)].map(b => b.toString(16).padStart(2, '0')).join('');
  const key = await crypto.subtle.importKey('raw', bits.slice(32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { id, key };
}

// Network failures throw; callers say the post office is closed.
const STATUS = { 201: 'ok', 409: 'taken', 413: 'too-big', 429: 'busy', 507: 'full' };

// letter: { sender, password, message, photos: [data URLs] } → 'ok' | 'taken' | 'too-big' | 'busy' | 'full' | 'error'
export async function sealLetter({ sender, password, message, photos }) {
  const { id, key } = await derive(sender, password);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const body = enc.encode(JSON.stringify({ v: 1, sender: sender.trim(), message, photos, sealedAt: new Date().toISOString() }));
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, body));
  const blob = new Uint8Array(iv.length + sealed.length);
  blob.set(iv); blob.set(sealed, iv.length);
  const res = await fetch(`${POST_OFFICE}/v1/letters/${id}`, { method: 'PUT', body: blob, headers: { 'content-type': 'application/octet-stream' } });
  return STATUS[res.status] ?? 'error';
}

// → { sender, message, photos, sealedAt }, or null when nothing matches
export async function openLetter(sender, password) {
  const { id, key } = await derive(sender, password);
  const res = await fetch(`${POST_OFFICE}/v1/letters/${id}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`post office said ${res.status}`);
  const blob = new Uint8Array(await res.arrayBuffer());
  try {
    const body = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: blob.slice(0, 12) }, key, blob.slice(12));
    return JSON.parse(dec.decode(body));
  } catch {
    return null;
  }
}
