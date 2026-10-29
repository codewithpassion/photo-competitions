-- Passwordless email sign-in replaces Google sign-in.
-- users: email becomes the identity (unique, stored lowercase); google_sub stays only as an unused, nullable column.
-- SQLite cannot drop NOT NULL / UNIQUE in place, so the table is rebuilt. Rows keep their ids, so every
-- foreign key that points at users stays valid (checks are deferred until the migration commits).
PRAGMA defer_foreign_keys = on;

-- Dropping users would cascade-delete sessions, so park them and put them back afterwards.
CREATE TABLE sessions_backup AS SELECT id, user_id, expires_at FROM sessions;

CREATE TABLE users_backup AS SELECT id, google_sub, lower(email) AS email, name, picture, created_at FROM users;
DROP TABLE users;
CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  google_sub TEXT UNIQUE,
  email TEXT NOT NULL UNIQUE CHECK (email = lower(email)),
  name TEXT NOT NULL DEFAULT '',
  picture TEXT,
  created_at TEXT NOT NULL
);
-- Re-inserting the same ids is what satisfies the deferred foreign-key checks.
INSERT INTO users (id, google_sub, email, name, picture, created_at)
  SELECT id, google_sub, email, name, picture, created_at FROM users_backup;
DROP TABLE users_backup;

INSERT INTO sessions (id, user_id, expires_at) SELECT id, user_id, expires_at FROM sessions_backup
  WHERE id NOT IN (SELECT id FROM sessions);
DROP TABLE sessions_backup;

-- One row per "send me a code" request. Only SHA-256 hashes of the code and the link token are stored.
CREATE TABLE login_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL,
  code_hash TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  return_to TEXT NOT NULL DEFAULT '/',
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  used_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX login_codes_email ON login_codes(email, created_at);
