// Decides which card to show next, and records answers. The memory maths lives in fsrs.js;
// this file is the "queue" around it.
import { openDb, tx, getSettings } from './db.js';
import { schedule, preview, humanInterval, State } from './fsrs.js';

const DAY = 86400000;
const LEARN_AHEAD = 20 * 60 * 1000; // if nothing else is due, show learning cards up to 20 min early

/** Start of the current "study day". The day rolls over at 04:00 so late-night reviews count as today. */
export function dayStart(now = Date.now()) {
  const d = new Date(now);
  if (d.getHours() < 4) d.setDate(d.getDate() - 1);
  d.setHours(4, 0, 0, 0);
  return d.getTime();
}

const dirFilter = (s) => (s.directions === 'both' ? '' : ` AND c.direction = '${s.directions === 'en2zh' ? 'en2zh' : 'zh2en'}'`);

export function counts(now = Date.now(), db = openDb()) {
  const s = getSettings(db), f = dirFilter(s), start = dayStart(now);
  const one = (sql, ...a) => db.prepare(sql).get(...a).n;
  const learning = one(`SELECT COUNT(*) n FROM cards c WHERE state IN (1,3) AND due <= ?${f}`, now + LEARN_AHEAD);
  const review = one(`SELECT COUNT(*) n FROM cards c WHERE state = 2 AND due <= ?${f}`, now);
  const newAvail = one(`SELECT COUNT(*) n FROM cards c WHERE state = 0${f}`);
  const introduced = one(
    `SELECT COUNT(*) n FROM (SELECT card_id FROM reviews GROUP BY card_id HAVING MIN(ts) >= ?)`, start);
  const doneToday = one('SELECT COUNT(*) n FROM reviews WHERE ts >= ?', start);
  return { learning, review, new: Math.max(0, Math.min(newAvail, s.newPerDay - introduced)), newTotal: newAvail, doneToday };
}

/** The next card to study, or null when you are done for now. */
export function nextCard(now = Date.now(), db = openDb()) {
  const s = getSettings(db), f = dirFilter(s), start = dayStart(now);
  const sel = `SELECT c.*, n.hanzi, n.pinyin, n.english, n.notes, n.needs_check FROM cards c JOIN notes n ON n.id = c.note_id`;
  // 1. cards in a learning step that are due
  let card = db.prepare(`${sel} WHERE c.state IN (1,3) AND c.due <= ?${f} ORDER BY c.due LIMIT 1`).get(now);
  // 2. reviews that are due — most overdue relative to their stability first
  card ||= db.prepare(`${sel} WHERE c.state = 2 AND c.due <= ?${f} ORDER BY (? - c.due) / MAX(c.stability, 0.1) DESC LIMIT 1`).get(now, now);
  // 3. a new card, within today's limit. Skip a note whose other direction was already studied today,
  //    so the two directions of one phrase do not give each other away.
  if (!card && counts(now, db).new > 0) {
    card = db.prepare(`${sel} WHERE c.state = 0${f}
      AND NOT EXISTS (SELECT 1 FROM cards o JOIN reviews r ON r.card_id = o.id
                      WHERE o.note_id = c.note_id AND o.id != c.id AND r.ts >= ?)
      ORDER BY n.created_at, n.id, c.direction DESC LIMIT 1`).get(start);
  }
  // 4. nothing else: pull a learning card forward a little
  card ||= db.prepare(`${sel} WHERE c.state IN (1,3) AND c.due <= ?${f} ORDER BY c.due LIMIT 1`).get(now + LEARN_AHEAD);
  if (!card) return null;
  const p = preview(card, now, s.retention);
  card.intervals = Object.fromEntries(Object.entries(p).map(([g, ms]) => [g, humanInterval(ms)]));
  return card;
}

export function nextDue(db = openDb()) {
  const s = getSettings(db);
  return db.prepare(`SELECT MIN(due) AS due FROM cards c WHERE state != 0${dirFilter(s)}`).get().due;
}

const FIELDS = ['state', 'due', 'stability', 'difficulty', 'reps', 'lapses', 'last_review'];

export function answer(cardId, rating, { mode = 'flip', durationMs = null, now = Date.now() } = {}, db = openDb()) {
  if (![1, 2, 3, 4].includes(rating)) throw Object.assign(new Error('rating must be 1-4'), { status: 400 });
  const card = db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
  if (!card) throw Object.assign(new Error('No such card.'), { status: 404 });
  const next = schedule(card, rating, now, getSettings(db).retention);
  const prev = Object.fromEntries(FIELDS.map((k) => [k, card[k]]));
  tx(db, () => {
    db.prepare(`UPDATE cards SET ${FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...FIELDS.map((k) => next[k]), cardId);
    db.prepare('INSERT INTO reviews(card_id, ts, rating, mode, duration_ms, prev) VALUES(?, ?, ?, ?, ?, ?)')
      .run(cardId, now, rating, mode, durationMs, JSON.stringify(prev));
  });
  return next;
}

/** Undo the most recent answer (for mis-clicks). */
export function undo(db = openDb()) {
  const last = db.prepare('SELECT * FROM reviews ORDER BY id DESC LIMIT 1').get();
  if (!last || Date.now() - last.ts > DAY) return null;
  const prev = JSON.parse(last.prev);
  tx(db, () => {
    db.prepare(`UPDATE cards SET ${FIELDS.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...FIELDS.map((k) => prev[k]), last.card_id);
    db.prepare('DELETE FROM reviews WHERE id = ?').run(last.id);
  });
  return last.card_id;
}
export { State };
