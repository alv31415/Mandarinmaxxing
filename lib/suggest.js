// What to learn next.
//   offlineSuggestions(): pure dictionary logic, always available.
//   claudeSuggestions():  semantic links (opposites, sets, slang), needs the API.
// Both are ranked by the same idea: a good next word is common, and mostly made of characters
// you already know — ideally with exactly one new character ("one new thing at a time").
import { openDb } from './db.js';
import { deckIndex, hanChars, autoPinyin, lookupWord } from './hanzi.js';
import { suggestWords } from './claude.js';

function novelty(hanzi, idx) {
  const chars = [...new Set(hanChars(hanzi))];
  const unknown = chars.filter((c) => !idx.byChar.has(c));
  return { known: chars.length - unknown.length, unknown, total: chars.length };
}

export function offlineSuggestions(limit = 24, db = openDb()) {
  const idx = deckIndex();
  const hidden = new Set(db.prepare("SELECT hanzi FROM suggestions WHERE status != 'new'").all().map((r) => r.hanzi));
  const allText = db.prepare('SELECT hanzi FROM notes').all().map((r) => r.hanzi).join('\n');
  const scored = [];
  for (const w of db.prepare('SELECT simp, level, freq, pinyin, meaning FROM ref.hsk WHERE freq IS NOT NULL').all()) {
    if (idx.exact.has(w.simp) || hidden.has(w.simp)) continue;
    if (allText.includes(w.simp)) continue;                    // already inside one of your phrases
    const nv = novelty(w.simp, idx);
    if (nv.total < 2) continue;                              // single characters you meet inside phrases anyway
    if (nv.known === 0 || nv.unknown.length > 1) continue;
    const commonness = 1 / Math.log2(2 + w.freq / 150);      // 1.0 for the most frequent words, falling slowly
    const anchor = hanChars(w.simp).find((c) => idx.byChar.has(c));
    scored.push({ w, nv, anchor, score: commonness });
  }
  scored.sort((a, b) => b.score - a.score);
  // Two lists — words with exactly one new character (the sweet spot) and words made only of
  // known characters — interleaved, so each batch teaches something new without being all new.
  const perAnchor = new Map();
  const take = (wantNew) => {
    const picked = [];
    for (const s of scored) {
      if ((s.nv.unknown.length === 1) !== wantNew) continue;
      const n = perAnchor.get(s.anchor) || 0;
      if (n >= 2) continue;                                  // at most two ideas hanging off one known character
      perAnchor.set(s.anchor, n + 1);
      picked.push(s);
      if (picked.length >= Math.ceil(limit / 2)) break;
    }
    return picked;
  };
  const withNew = take(true), allKnown = take(false), out = [];
  for (let i = 0; i < Math.max(withNew.length, allKnown.length); i++) for (const s of [withNew[i], allKnown[i]]) {
    if (!s) continue;
    const from = idx.byChar.get(s.anchor).map((n) => n.hanzi).sort((a, b) => a.length - b.length)[0];
    out.push({
      hanzi: s.w.simp, pinyin: (s.w.pinyin || autoPinyin(s.w.simp)).toLowerCase(), english: s.w.meaning,
      relation: '', related_to: from,
      reason: s.nv.unknown.length
        ? `Reuses ${s.anchor} from ${from}; the only new character is ${s.nv.unknown[0]}.`
        : `Built entirely from characters you have seen (${s.anchor} is in ${from}).`,
      source: 'offline', level: s.w.level, newChars: s.nv.unknown,
    });
  }
  return out;
}

export function storedSuggestions(db = openDb()) {
  const idx = deckIndex();
  return db.prepare("SELECT * FROM suggestions WHERE status = 'new' AND source = 'claude' ORDER BY id DESC").all()
    .map((s) => ({ ...s, newChars: novelty(s.hanzi, idx).unknown }));
}

export async function claudeSuggestions({ focusNoteId = null, count = 12 } = {}, db = openDb()) {
  const notes = db.prepare('SELECT id, hanzi, english FROM notes ORDER BY id').all();
  if (!notes.length) return { ok: false, reason: 'Add a few cards first.' };
  const focus = focusNoteId ? notes.find((n) => n.id === focusNoteId) : null;
  const exclude = db.prepare('SELECT hanzi FROM suggestions').all().map((r) => r.hanzi);
  const res = await suggestWords({
    deck: notes.map((n) => ({ hanzi: n.hanzi, english: n.english })), exclude,
    focus: focus ? { hanzi: focus.hanzi, english: focus.english } : null, count,
  });
  if (!res.ok) return res;
  const idx = deckIndex();
  const have = new Set([...notes.map((n) => hanChars(n.hanzi).join('')), ...exclude]);
  const ins = db.prepare(`INSERT OR IGNORE INTO suggestions(hanzi, pinyin, english, relation, related_to, reason, source, created_at)
                          VALUES(?, ?, ?, ?, ?, ?, 'claude', ?)`);
  let added = 0;
  for (const s of res.data.suggestions) {
    const hanzi = hanChars(s.hanzi).join('');
    if (!hanzi || have.has(hanzi)) continue; // already known or already suggested
    have.add(hanzi);
    // Trust the dictionary over the model for pinyin when the whole word is a dictionary entry.
    const n = [...hanzi].length;
    const dict = n > 1 ? lookupWord(hanzi) : null;
    let pinyin = s.pinyin.trim().toLowerCase();
    if (pinyin.split(/\s+/).length !== n) pinyin = dict?.pinyin.length === n ? dict.pinyin.join(' ').toLowerCase() : autoPinyin(hanzi);
    ins.run(hanzi, pinyin, s.english.trim(), s.relation, s.related_to.trim(), s.reason.trim(), Date.now());
    added++;
  }
  return { ok: true, added };
}

export function dismissSuggestion(hanzi, db = openDb()) {
  db.prepare(`INSERT INTO suggestions(hanzi, source, status, created_at) VALUES(?, 'offline', 'dismissed', ?)
              ON CONFLICT(hanzi) DO UPDATE SET status = 'dismissed'`).run(hanzi, Date.now());
}
