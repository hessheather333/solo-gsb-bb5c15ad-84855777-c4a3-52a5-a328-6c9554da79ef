const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'cues.db');

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS scripts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  title           TEXT    NOT NULL,
  content         TEXT    NOT NULL DEFAULT '',
  current_version INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS script_versions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id  INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  version    INTEGER NOT NULL,
  title      TEXT    NOT NULL,
  content    TEXT    NOT NULL,
  created_at TEXT    NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cues (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  script_id      INTEGER NOT NULL REFERENCES scripts(id) ON DELETE CASCADE,
  type           TEXT    NOT NULL CHECK (type IN ('light', 'sound')),
  label          TEXT    NOT NULL,
  note           TEXT    NOT NULL DEFAULT '',
  version        INTEGER NOT NULL DEFAULT 1,
  line_no        INTEGER,
  line_text      TEXT,
  anchor_index   INTEGER,
  anchor_text    TEXT,
  context_before TEXT    NOT NULL DEFAULT '',
  context_after  TEXT    NOT NULL DEFAULT '',
  anchor_status  TEXT    NOT NULL DEFAULT 'bound' CHECK (anchor_status IN ('bound', 'pending')),
  issue_type     TEXT,
  issue_detail   TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cues_script ON cues(script_id);
CREATE INDEX IF NOT EXISTS idx_versions_script ON script_versions(script_id);
`);

module.exports = db;
module.exports.DB_PATH = DB_PATH;
