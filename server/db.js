// server/db.js: the post office's one SQLite file (~/.loveletter/letters.db).
//
//   letters   the sealed letters: id, encrypted bytes, when sealed, how often opened,
//             and when someone other than its sender first opened it
//   accounts  invite-only accounts, made on the Mac (see accounts.js)
//   sessions  signed-in devices; only a hash of each token is kept
//   shelf     each account's letters: the ones it sent and the ones it opened, each with
//             the letter's key locked by that account's keyring (unreadable here)
//   invites   names allowed to make their own account once, choosing their own password

import { DatabaseSync } from 'node:sqlite';

export function openDb(file) {
  const db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS letters (
      id TEXT PRIMARY KEY,
      blob BLOB NOT NULL,
      sealed_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      secret_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS shelf (
      account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
      letter_id TEXT NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('sent', 'opened')),
      locked_key BLOB,
      first_at INTEGER NOT NULL,
      last_at INTEGER NOT NULL,
      PRIMARY KEY (account_id, letter_id, role)
    );
    CREATE INDEX IF NOT EXISTS shelf_by_letter ON shelf (letter_id, role);
    CREATE TABLE IF NOT EXISTS invites (
      name TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );
  `);
  // Columns that came after the first letters were sealed; older rows get the defaults.
  const cols = new Set(db.prepare('PRAGMA table_info(letters)').all().map(c => c.name));
  if (!cols.has('opens')) db.exec('ALTER TABLE letters ADD COLUMN opens INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('first_opened_at')) db.exec('ALTER TABLE letters ADD COLUMN first_opened_at INTEGER');
  return db;
}
