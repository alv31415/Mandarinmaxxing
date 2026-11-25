// Notes (one phrase/word/character you are learning) and their cards (one per review direction).
import { openDb, tx } from './db.js';
import { autoPinyin, autoEnglish, hanChars } from './hanzi.js';

export const DIRECTIONS = ['zh2en', 'en2zh'];

export function createNote({ hanzi, pinyin, english, notes = '', source = 'manual', needsCheck = 0 }, db = openDb()) {
  hanzi = (hanzi || '').trim().replace(/\s+/g, ' ');
  if (!hanChars(hanzi).length) throw Object.assign(new Error('The card needs at least one Chinese character.'), { status: 400 });
  const existing = db.prepare('SELECT id FROM notes WHERE hanzi = ?').get(hanzi);
  if (existing) throw Object.assign(new Error('That card already exists.'), { status: 409, noteId: existing.id });
  pinyin = (pinyin || '').trim() || autoPinyin(hanzi);
  english = (english || '').trim();
  if (!english) { english = autoEnglish(hanzi).english; needsCheck = 1; }
  return tx(db, () => {
    const now = Date.now();
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO notes(hanzi, pinyin, english, notes, source, needs_check, created_at) VALUES(?, ?, ?, ?, ?, ?, ?)')
      .run(hanzi, pinyin, english, notes.trim(), source, needsCheck ? 1 : 0, now);
    const ins = db.prepare('INSERT INTO cards(note_id, direction, due) VALUES(?, ?, ?)');
    for (const d of DIRECTIONS) ins.run(id, d, now);
    db.prepare("UPDATE suggestions SET status = 'added' WHERE hanzi = ?").run(hanzi);
    return Number(id);
  });
}

export function updateNote(id, patch, db = openDb()) {
  const cur = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!cur) throw Object.assign(new Error('No such card.'), { status: 404 });
  const next = {
    hanzi: (patch.hanzi ?? cur.hanzi).trim(), pinyin: (patch.pinyin ?? cur.pinyin).trim(),
    english: (patch.english ?? cur.english).trim(), notes: (patch.notes ?? cur.notes).trim(),
    needs_check: patch.needs_check ?? 0,
  };
  if (!hanChars(next.hanzi).length) throw Object.assign(new Error('The card needs at least one Chinese character.'), { status: 400 });
  db.prepare('UPDATE notes SET hanzi = ?, pinyin = ?, english = ?, notes = ?, needs_check = ? WHERE id = ?')
    .run(next.hanzi, next.pinyin, next.english, next.notes, next.needs_check ? 1 : 0, id);
  return getNote(id, db);
}

export function deleteNote(id, db = openDb()) {
  db.prepare('DELETE FROM notes WHERE id = ?').run(id);
}

export function getNote(id, db = openDb()) {
  const note = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!note) return null;
  note.cards = db.prepare(`
    SELECT c.*, (SELECT COUNT(*) FROM reviews r WHERE r.card_id = c.id) AS attempts,
           (SELECT COUNT(*) FROM reviews r WHERE r.card_id = c.id AND r.rating = 1) AS failures
    FROM cards c WHERE note_id = ? ORDER BY direction DESC`).all(id);
  return note;
}

export function listNotes(q = '', db = openDb()) {
  const like = `%${q.trim()}%`;
  return db.prepare(`
    SELECT n.id, n.hanzi, n.pinyin, n.english, n.needs_check, n.created_at,
           MIN(c.state) AS min_state, MAX(c.state) AS max_state, MIN(c.due) AS next_due,
           SUM(c.reps) AS reps, SUM(c.lapses) AS lapses
    FROM notes n JOIN cards c ON c.note_id = n.id
    WHERE ? = '%%' OR n.hanzi LIKE ? OR n.english LIKE ? OR n.pinyin LIKE ?
    GROUP BY n.id ORDER BY n.created_at DESC, n.id DESC`).all(like, like, like, like);
}
