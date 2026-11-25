// One-off helper: asks Claude to correct the dictionary-guessed pinyin on every note (context matters:
// 得 is de/dé/děi) and to translate notes flagged as guesses. Usage: node scripts/polish.js
import { openDb, tx } from '../lib/db.js';
import { polishPinyin } from '../lib/claude.js';
import { hanChars } from '../lib/hanzi.js';

const db = openDb();
const notes = db.prepare('SELECT id, hanzi, pinyin, english, needs_check FROM notes ORDER BY id').all();
let changed = 0, translated = 0;
for (let i = 0; i < notes.length; i += 60) {
  const batch = notes.slice(i, i + 60);
  const res = await polishPinyin(batch.map((n) => ({ id: n.id, hanzi: n.hanzi, pinyin_guess: n.pinyin, english: n.needs_check ? '' : n.english, english_is_guess: Boolean(n.needs_check) })));
  if (!res.ok) { console.error('stopped:', res.reason); process.exit(1); }
  tx(db, () => {
    for (const c of res.data.cards) {
      const n = batch.find((x) => x.id === c.id);
      if (!n) continue;
      const py = c.pinyin.trim().toLowerCase();
      if (py && py.split(/\s+/).length === hanChars(n.hanzi).length && py !== n.pinyin) {
        db.prepare('UPDATE notes SET pinyin = ? WHERE id = ?').run(py, n.id); changed++;
        console.log(`  ${n.hanzi}: ${n.pinyin} → ${py}`);
      }
      if (n.needs_check && c.english.trim()) {
        db.prepare('UPDATE notes SET english = ? WHERE id = ?').run(c.english.trim(), n.id); translated++;
        console.log(`  ${n.hanzi}: translated as "${c.english.trim()}"`);
      }
    }
  });
}
console.log(`pinyin corrected on ${changed} notes, ${translated} translations filled in`);
