// server/accounts.js: invite-only accounts and signed-in sessions.
//
// The browser turns name + password into 64 bytes with Argon2id: the first 32 are the
// sign-in secret it sends here, the last 32 are its keyring key, which never leaves it.
// So the server never sees an account password. It keeps only an scrypt hash of the
// sign-in secret, and only a SHA-256 of each session token.
//
// Run on the Mac (accounts are only ever made here):
//   node server/accounts.js add <name>        make an account (asks for its password)
//   node server/accounts.js password <name>   set a new password (signs out everywhere)
//   node server/accounts.js invite <name>     let <name> make their own account from the site, once
//   node server/accounts.js uninvite <name>
//   node server/accounts.js list
//   node server/accounts.js backfill <file>   put letters from before accounts on shelves

import { argon2Sync, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openDb } from './db.js';

const DAY = 86_400_000, SESSION_DAYS = 90;
export const normalizeName = s => String(s ?? '').trim().toLowerCase().replace(/\s+/g, ' ');

// Exactly what the browser computes (same settings in store.js). The Mac only needs it to make an account.
export function accountSecrets(name, password) {
  const out = argon2Sync('argon2id', {
    message: Buffer.from(normalizeName(name) + '\n' + password.trim()), nonce: Buffer.from('loveletter account v1'),
    parallelism: 1, tagLength: 64, memory: 65536, passes: 3,
  });
  return { secret: out.subarray(0, 32), keyring: out.subarray(32) };
}

function hashSecret(secret, salt = randomBytes(16)) {
  return `scrypt$${salt.toString('base64')}$${scryptSync(secret, salt, 32).toString('base64')}`;
}
function checkSecret(secret, stored) {
  const [, salt, hash] = stored.split('$');
  return timingSafeEqual(scryptSync(secret, Buffer.from(salt, 'base64'), 32), Buffer.from(hash, 'base64'));
}
const DUMMY = hashSecret(randomBytes(32));   // so an unknown name takes as long as a wrong password
const tokenHash = token => createHash('sha256').update(token).digest('hex');

export function createAccount(db, name, password, now = Date.now()) {
  name = normalizeName(name);
  if (!name || !password.trim()) throw new Error('name and password are both needed');
  return db.prepare('INSERT INTO accounts (name, secret_hash, created_at) VALUES (?, ?, ?)')
    .run(name, hashSecret(accountSecrets(name, password).secret), now).lastInsertRowid;
}

// Invites let someone make their own account, so they choose a password nobody else saw.
// Their browser sends the sign-in secret made from it, like signing in. Works once per name.
export function invite(db, name, now = Date.now()) {
  name = normalizeName(name);
  if (!name) throw new Error('a name is needed');
  if (db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) throw new Error(`${name} already has an account`);
  db.prepare('INSERT OR IGNORE INTO invites (name, created_at) VALUES (?, ?)').run(name, now);
}
export function uninvite(db, name) {
  return db.prepare('DELETE FROM invites WHERE name = ?').run(normalizeName(name)).changes > 0;
}
export const invitesOpen = db => !!db.prepare('SELECT 1 FROM invites').get();

// → { token, name } for the new account, or null if that name isn't invited (or the secret is malformed)
export function claimInvite(db, name, secret, now = Date.now()) {
  name = normalizeName(name);
  if (secret?.length !== 32) return null;
  db.exec('BEGIN IMMEDIATE');
  try {
    const invited = db.prepare('DELETE FROM invites WHERE name = ? RETURNING name').get(name);
    if (!invited || db.prepare('SELECT 1 FROM accounts WHERE name = ?').get(name)) { db.exec('ROLLBACK'); return null; }
    db.prepare('INSERT INTO accounts (name, secret_hash, created_at) VALUES (?, ?, ?)').run(name, hashSecret(secret), now);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return signIn(db, name, secret, now);
}

// A new password means a new keyring, so keys locked with the old one are useless:
// they're cleared (each letter becomes tap-to-read again once reopened), and every device is signed out.
export function setPassword(db, name, password) {
  name = normalizeName(name);
  if (!password.trim()) throw new Error('a password is needed');
  const account = db.prepare('SELECT id FROM accounts WHERE name = ?').get(name);
  if (!account) throw new Error(`no account called ${name}`);
  db.prepare('UPDATE accounts SET secret_hash = ? WHERE id = ?').run(hashSecret(accountSecrets(name, password).secret), account.id);
  db.prepare('UPDATE shelf SET locked_key = NULL WHERE account_id = ?').run(account.id);
  db.prepare('DELETE FROM sessions WHERE account_id = ?').run(account.id);
}

// → { token, name } or null
export function signIn(db, name, secret, now = Date.now()) {
  const account = db.prepare('SELECT id, name, secret_hash FROM accounts WHERE name = ?').get(normalizeName(name));
  const ok = secret?.length === 32 && checkSecret(secret, account?.secret_hash ?? DUMMY);
  if (!ok || !account) return null;
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token_hash, account_id, created_at, last_seen_at, expires_at) VALUES (?, ?, ?, ?, ?)')
    .run(tokenHash(token), account.id, now, now, now + SESSION_DAYS * DAY);
  return { token, name: account.name };
}

// The account a token belongs to, or null. Using a session keeps it alive for another 90 days.
export function sessionAccount(db, token, now = Date.now()) {
  if (!token) return null;
  const hash = tokenHash(token);
  const row = db.prepare('SELECT a.id, a.name, s.expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.token_hash = ?').get(hash);
  if (!row) return null;
  if (row.expires_at < now) { db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash); return null; }
  db.prepare('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?').run(now, now + SESSION_DAYS * DAY, hash);
  return { id: row.id, name: row.name };
}

export function signOut(db, token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash(token));
}

// Letters sealed before accounts: [{ letter_id, sender, reader, sealed_at, first_opened_at }].
// Puts each on its sender's and reader's shelves with no key yet; each becomes tap-to-read
// once that person opens it signed in. Safe to run twice.
export function backfill(db, entries) {
  const id = name => {
    const row = db.prepare('SELECT id FROM accounts WHERE name = ?').get(normalizeName(name));
    if (!row) throw new Error(`make the account "${name}" first`);
    return row.id;
  };
  const hasLetter = db.prepare('SELECT 1 FROM letters WHERE id = ?');
  const opened = db.prepare('UPDATE letters SET first_opened_at = coalesce(first_opened_at, ?) WHERE id = ?');
  const shelve = db.prepare('INSERT OR IGNORE INTO shelf (account_id, letter_id, role, locked_key, first_at, last_at) VALUES (?, ?, ?, NULL, ?, ?)');
  db.exec('BEGIN');
  try {
    for (const e of entries) {
      if (!hasLetter.get(e.letter_id)) throw new Error(`no letter ${e.letter_id.slice(0, 8)}`);
      shelve.run(id(e.sender), e.letter_id, 'sent', e.sealed_at, e.sealed_at);
      if (e.first_opened_at) {
        opened.run(e.first_opened_at, e.letter_id);
        shelve.run(id(e.reader), e.letter_id, 'opened', e.first_opened_at, e.first_opened_at);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return entries.length;
}

// ---------- on the Mac ----------

async function askHidden(question) {
  process.stdout.write(question);
  const stdin = process.stdin;
  stdin.setRawMode(true); stdin.resume(); stdin.setEncoding('utf8');
  return new Promise(resolve => {
    let typed = '';
    const onData = chunk => {
      for (const c of chunk) {
        if (c === '\r' || c === '\n') {
          stdin.setRawMode(false); stdin.pause(); stdin.off('data', onData);
          process.stdout.write('\n');
          return resolve(typed);
        }
        if (c === '\u0003') { process.stdout.write('\n'); process.exit(130); }
        typed = c === '\u007f' || c === '\b' ? typed.slice(0, -1) : typed + c;
      }
    };
    stdin.on('data', onData);
  });
}

async function newPassword() {
  const first = await askHidden('password: ');
  if (first !== await askHidden('again: ')) throw new Error("those didn't match");
  return first;
}

if (import.meta.main) {
  const home = process.env.LOVELETTER_HOME ?? join(homedir(), '.loveletter');
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = openDb(join(home, 'letters.db'));
  const [command, arg] = process.argv.slice(2);
  try {
    if (command === 'add' && arg) {
      createAccount(db, arg, await newPassword());
      console.log(`made ${normalizeName(arg)}`);
    } else if (command === 'password' && arg) {
      setPassword(db, arg, await newPassword());
      console.log(`new password for ${normalizeName(arg)}; signed out everywhere`);
    } else if (command === 'invite' && arg) {
      invite(db, arg);
      console.log(`${normalizeName(arg)} can now make their account from the site (the pop-up shows while anyone is invited)`);
    } else if (command === 'uninvite' && arg) {
      console.log(uninvite(db, arg) ? `${normalizeName(arg)} is no longer invited` : `${normalizeName(arg)} wasn't invited`);
    } else if (command === 'list') {
      for (const a of db.prepare(`SELECT name, created_at, (SELECT count(*) FROM shelf WHERE account_id = a.id AND role = 'sent') AS sent,
        (SELECT count(*) FROM shelf WHERE account_id = a.id AND role = 'opened') AS opened FROM accounts a ORDER BY id`).all())
        console.log(`${a.name}  made ${new Date(a.created_at).toLocaleDateString()}  sent ${a.sent}  opened ${a.opened}`);
      for (const i of db.prepare('SELECT name, created_at FROM invites ORDER BY created_at').all())
        console.log(`${i.name}  invited ${new Date(i.created_at).toLocaleString()}  (no account yet)`);
    } else if (command === 'backfill' && arg && existsSync(arg)) {
      console.log(`shelved ${backfill(db, JSON.parse(readFileSync(arg, 'utf8')))} letters`);
      unlinkSync(arg);
      console.log(`deleted ${arg}`);
    } else {
      console.log('usage: node server/accounts.js add <name> | password <name> | invite <name> | uninvite <name> | list | backfill <file>');
      process.exitCode = 1;
    }
  } catch (err) {
    console.error(err.message);
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
