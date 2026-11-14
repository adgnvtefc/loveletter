// account.js: accounts, from the browser's side.
//
// Name + password become 64 bytes with Argon2id (the same settings as server/accounts.js,
// so the Mac and the browser agree): the first 32 are the sign-in secret sent to the
// post office, the last 32 are the keyring key, which never leaves this browser.
// Argon2id comes from hash-wasm, fetched only when an account is actually used.

import { POST_OFFICE, normalize } from './store.js';

const ARGON2 = 'https://cdn.jsdelivr.net/npm/hash-wasm@4.12.0/dist/argon2.umd.min.js';
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

const toB64 = bytes => btoa(String.fromCharCode(...bytes));

export async function accountKeys(name, password) {
  const out = await (await argon2id())({
    password: normalize(name) + '\n' + password.trim(), salt: 'loveletter account v1',
    parallelism: 1, iterations: 3, memorySize: 65536, hashLength: 64, outputType: 'binary',
  });
  return { secret: out.slice(0, 32), keyring: out.slice(32) };
}

// Is anyone invited to make their own account? (false if the post office can't be reached)
export async function invitesOpen() {
  try {
    const res = await fetch(`${POST_OFFICE}/v1/invites`, { signal: AbortSignal.timeout(4000) });
    return res.ok && (await res.json()).open === true;
  } catch {
    return false;
  }
}

// → 'ok' | 'not-invited' | 'busy' | 'closed'
export async function claimInvite(name, password) {
  try {
    const { secret } = await accountKeys(name, password);
    const res = await fetch(`${POST_OFFICE}/v1/invites`, { method: 'POST', body: JSON.stringify({ name, secret: toB64(secret) }) });
    return res.ok ? 'ok' : res.status === 403 ? 'not-invited' : res.status === 429 ? 'busy' : 'closed';
  } catch {
    return 'closed';
  }
}
