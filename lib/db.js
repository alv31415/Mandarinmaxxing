// SQLite storage. Two files so your data and the rebuildable reference data stay separate:
//   data/user.db       your notes, cards, review log, suggestions, settings  (precious)
//   data/reference.db  dictionary, character breakdowns, HSK list            (rebuilt by `npm run setup`)
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = process.env.MANDARIN_DATA_DIR || path.join(ROOT, 'data');
export const USER_DB = path.join(DATA_DIR, 'user.db');
export const REF_DB = path.join(DATA_DIR, 'reference.db');

const USER_SCHEMA = `
CREATE TABLE IF NOT EXISTS notes (
  id INTEGER PRIMARY KEY,
  hanzi TEXT NOT NULL UNIQUE,
  pinyin TEXT NOT NULL DEFAULT '',
  english TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'manual',
  needs_check INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS cards (
  id INTEGER PRIMARY KEY,
  note_id INTEGER NOT NULL REFERENCES notes(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,              -- 'zh2en' | 'en2zh'
  state INTEGER NOT NULL DEFAULT 0,     -- 0 new, 1 learning, 2 review, 3 relearning
  due INTEGER NOT NULL DEFAULT 0,       -- ms since epoch
  stability REAL NOT NULL DEFAULT 0,
  difficulty REAL NOT NULL DEFAULT 0,
  reps INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_review INTEGER,
  UNIQUE(note_id, direction)
);
CREATE INDEX IF NOT EXISTS cards_due ON cards(state, due);
CREATE TABLE IF NOT EXISTS reviews (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  ts INTEGER NOT NULL,
  rating INTEGER NOT NULL,              -- 1 again, 2 hard, 3 good, 4 easy
  mode TEXT NOT NULL DEFAULT 'flip',    -- 'flip' | 'type'
  duration_ms INTEGER,
  prev TEXT NOT NULL                    -- card state before this review (JSON), used for undo
);
CREATE INDEX IF NOT EXISTS reviews_ts ON reviews(ts);
CREATE INDEX IF NOT EXISTS reviews_card ON reviews(card_id);
CREATE TABLE IF NOT EXISTS suggestions (
  id INTEGER PRIMARY KEY,
  hanzi TEXT NOT NULL UNIQUE,
  pinyin TEXT NOT NULL DEFAULT '',
  english TEXT NOT NULL DEFAULT '',
  relation TEXT NOT NULL DEFAULT '',
  related_to TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL,                 -- 'claude' | 'offline'
  status TEXT NOT NULL DEFAULT 'new',   -- 'new' | 'added' | 'dismissed'
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_cache (
  key TEXT PRIMARY KEY,
  response TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export const REF_SCHEMA = `
CREATE TABLE IF NOT EXISTS ref.dict (
  id INTEGER PRIMARY KEY, simp TEXT NOT NULL, trad TEXT NOT NULL, pinyin TEXT NOT NULL, defs TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ref.dict_simp ON dict(simp);
CREATE TABLE IF NOT EXISTS ref.chars (
  ch TEXT PRIMARY KEY, definition TEXT, pinyin TEXT, decomposition TEXT, radical TEXT,
  etym_type TEXT, etym_hint TEXT, etym_semantic TEXT, etym_phonetic TEXT
);
CREATE TABLE IF NOT EXISTS ref.hsk (
  simp TEXT PRIMARY KEY, level INTEGER, freq INTEGER, pinyin TEXT, meaning TEXT
);
`;

let _db;
export function openDb() {
  if (_db) return _db;
  mkdirSync(DATA_DIR, { recursive: true });
  const db = new DatabaseSync(USER_DB);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
  db.exec(USER_SCHEMA);
  db.exec(`ATTACH DATABASE '${REF_DB.replaceAll("'", "''")}' AS ref`);
  db.exec(REF_SCHEMA);
  _db = db;
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const DEFAULT_SETTINGS = {
  newPerDay: 12,            // new cards introduced per day
  retention: 0.9,           // target probability of recall when a card comes due
  directions: 'both',       // 'both' | 'zh2en' | 'en2zh'
  toneColors: true,
  showPinyinOnFront: false, // show pinyin on the Chinese->English question side
  model: 'claude-opus-5-5',
};

export function getSettings(db = openDb()) {
  const out = { ...DEFAULT_SETTINGS };
  for (const { key, value } of db.prepare('SELECT key, value FROM settings').all()) {
    if (key in out) out[key] = JSON.parse(value);
  }
  return out;
}

export function setSettings(patch, db = openDb()) {
  const stmt = db.prepare('INSERT INTO settings(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULT_SETTINGS)) continue;
    if (typeof v !== typeof DEFAULT_SETTINGS[k]) continue;
    stmt.run(k, JSON.stringify(v));
  }
  return getSettings(db);
}
