// Statistics. Everything is computed on demand from notes, cards and the review log —
// nothing here is stored, so the numbers can never drift out of sync with your data.
import { openDb } from './db.js';
import { charTable, allComponents, uniqueHan, hanChars } from './hanzi.js';
import { dayStart } from './scheduler.js';

const DAY = 86400000;

export function stats(now = Date.now(), db = openDb()) {
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  const start = dayStart(now);
  const notes = db.prepare('SELECT id, hanzi, english FROM notes').all();

  // --- characters, radicals, components across the deck ---
  const chars = new Map(); // char -> { count (notes containing it), notes[] }
  for (const n of notes) for (const c of uniqueHan(n.hanzi)) {
    if (!chars.has(c)) chars.set(c, { ch: c, count: 0, notes: [] });
    const e = chars.get(c); e.count++; e.notes.push(n.hanzi);
  }
  const table = charTable();
  const radicals = new Map(), components = new Map();
  for (const c of chars.keys()) {
    const rad = table.get(c)?.radical;
    if (rad) { if (!radicals.has(rad)) radicals.set(rad, []); radicals.get(rad).push(c); }
    for (const comp of allComponents(c)) { if (!components.has(comp)) components.set(comp, []); components.get(comp).push(c); }
  }
  const describe = ([ch, list]) => ({ ch, meaning: table.get(ch)?.definition || '', count: list.length, chars: list });
  const byCount = (a, b) => b.count - a.count;

  // --- review activity ---
  const perDay = db.prepare(`
    SELECT CAST((ts - ?) / ${DAY} AS INTEGER) + (CASE WHEN ts < ? THEN -1 ELSE 0 END) AS d,
           COUNT(*) AS n, SUM(rating > 1) AS ok
    FROM reviews WHERE ts >= ? GROUP BY d ORDER BY d`).all(start, start, start - 29 * DAY);
  const activity = [];
  for (let d = -29; d <= 0; d++) {
    const row = perDay.find((r) => r.d === d);
    activity.push({ day: start + d * DAY, reviews: row?.n || 0, correct: row?.ok || 0 });
  }
  const forecast = [];
  for (let d = 0; d < 14; d++) {
    const from = d === 0 ? 0 : start + d * DAY, to = start + (d + 1) * DAY;
    forecast.push({ day: start + d * DAY, due: one('SELECT COUNT(*) n FROM cards WHERE state != 0 AND due >= ? AND due < ?', from, to).n });
  }
  let streak = 0;
  for (let i = activity.length - 1; i >= 0; i--) { if (activity[i].reviews) streak++; else if (i < activity.length - 1) break; }

  const mature = one('SELECT COUNT(*) n, SUM(rating > 1) ok FROM reviews r WHERE json_extract(prev, \'$.state\') = 2');
  const cardsByState = Object.fromEntries(db.prepare('SELECT state, COUNT(*) n FROM cards GROUP BY state').all().map((r) => [r.state, r.n]));

  const cards = db.prepare(`
    SELECT n.id AS note_id, n.hanzi, n.english, c.direction, c.state, c.stability, c.difficulty, c.lapses, c.due,
           COUNT(r.id) AS attempts, COALESCE(SUM(r.rating = 1), 0) AS failures, COALESCE(AVG(r.duration_ms), 0) AS avg_ms
    FROM cards c JOIN notes n ON n.id = c.note_id LEFT JOIN reviews r ON r.card_id = c.id
    GROUP BY c.id HAVING attempts > 0 ORDER BY failures * 1.0 / attempts DESC, attempts DESC LIMIT 200`).all();

  const hsk = db.prepare(`
    SELECT h.level, COUNT(*) AS total, SUM(EXISTS (SELECT 1 FROM notes n WHERE n.hanzi = h.simp)) AS known
    FROM ref.hsk h WHERE h.level IS NOT NULL GROUP BY h.level ORDER BY h.level`).all();

  return {
    totals: {
      notes: notes.length,
      characters: chars.size,
      radicals: radicals.size,
      reviews: one('SELECT COUNT(*) n FROM reviews').n,
      reviewsToday: one('SELECT COUNT(*) n FROM reviews WHERE ts >= ?', start).n,
      minutesToday: Math.round((one('SELECT COALESCE(SUM(MIN(duration_ms, 120000)), 0) n FROM reviews WHERE ts >= ?', start).n) / 60000),
      retention: mature.n ? mature.ok / mature.n : null,
      streak,
      new: cardsByState[0] || 0, learning: (cardsByState[1] || 0) + (cardsByState[3] || 0), review: cardsByState[2] || 0,
      hanziInstances: notes.reduce((a, n) => a + hanChars(n.hanzi).length, 0),
    },
    activity, forecast,
    radicals: [...radicals].map(describe).sort(byCount),
    components: [...components].map(describe).sort(byCount).slice(0, 60),
    characters: [...chars.values()].sort(byCount).slice(0, 80),
    cards, hsk,
  };
}
