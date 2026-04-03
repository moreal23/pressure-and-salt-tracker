CREATE TABLE IF NOT EXISTS auth_account (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL DEFAULT '',
  password_hash TEXT NOT NULL DEFAULT '',
  password_salt TEXT NOT NULL DEFAULT '',
  session_hash TEXT NOT NULL DEFAULT '',
  session_expires_at TEXT,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT OR IGNORE INTO auth_account (id, username, password_hash, password_salt, session_hash, session_expires_at, updated_at)
VALUES (1, '', '', '', '', NULL, CURRENT_TIMESTAMP);
