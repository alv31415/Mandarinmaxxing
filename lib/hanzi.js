// Everything about the text itself: pinyin, word segmentation, and the breakdown tree
// phrase -> words -> characters -> components.
import { openDb } from './db.js';

export const HAN = /\p{Script=Han}/u;
export const hanChars = (s) => [...s].filter((c) => HAN.test(c));
export const uniqueHan = (s) => [...new Set(hanChars(s))];

// ---------- pinyin ----------
const MARKS = { a: 'āáǎàa', e: 'ēéěèe', i: 'īíǐìi', o: 'ōóǒòo', u: 'ūúǔùu', 'ü': 'ǖǘǚǜü' };
const MARK_TO_BASE = {};
for (const [base, row] of Object.entries(MARKS)) [...row].forEach((ch, i) => { if (i < 4) MARK_TO_BASE[ch] = [base, i + 1]; });

/** "lu:4" / "hao3" / "r5" -> "lǜ" / "hǎo" / "r" */
export function numericToMarks(syl) {
  const m = /^([A-Za-zü:]+)([1-5])$/.exec(syl.replace(/u:/g, 'ü').replace(/U:/g, 'Ü').replace(/v/g, 'ü'));
  if (!m) return syl;
  let [, body, tone] = m; tone = +tone;
  if (tone === 5) return body;
  const lower = body.toLowerCase();
  let idx = lower.indexOf('a');
  if (idx < 0) idx = lower.indexOf('e');
  if (idx < 0) idx = lower.indexOf('ou');
  if (idx < 0) for (let i = lower.length - 1; i >= 0; i--) if ('iouü'.includes(lower[i])) { idx = i; break; }
  if (idx < 0) return body;
  const marked = MARKS[lower[idx]][tone - 1];
  const out = body[idx] === lower[idx] ? marked : marked.toUpperCase();
  return body.slice(0, idx) + out + body.slice(idx + 1);
}

/** tone (1-5) of a syllable written with tone marks */
export function toneOf(syl) {
  for (const ch of syl.toLowerCase()) if (MARK_TO_BASE[ch]) return MARK_TO_BASE[ch][1];
  return 5;
}

/** "nǐ hǎo" -> "ni3hao3" (comparison form). Accepts tone marks or numbers. */
export function normalizePinyin(s, { tones = true } = {}) {
  let out = '';
  const flush = (syl) => {
    if (!syl) return;
    if (/[1-5]$/.test(syl)) { out += tones ? syl : syl.slice(0, -1); return; }
    let tone = 5, base = '';
    for (const ch of syl) { if (MARK_TO_BASE[ch]) { base += MARK_TO_BASE[ch][0]; tone = MARK_TO_BASE[ch][1]; } else base += ch; }
    out += tones ? base + tone : base;
  };
  for (const syl of s.toLowerCase().replace(/u:|v/g, 'ü').split(/[^a-zü1-5āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+/)) flush(syl);
  return out;
}

// ---------- reference lookups ----------
let _chars; // Map<char, row> — 9.5k rows, loaded once
export function charTable() {
  if (_chars) return _chars;
  _chars = new Map();
  for (const r of openDb().prepare('SELECT * FROM ref.chars').all()) _chars.set(r.ch, r);
  return _chars;
}
export function resetCaches() { _chars = undefined; }

// Grammar particles are almost always neutral-tone in speech, but dictionaries list their
// full-tone reading first (吧 bā). When one stands alone in a phrase, use the spoken reading.
const PARTICLES = { 的: 'de', 了: 'le', 吗: 'ma', 吧: 'ba', 呢: 'ne', 着: 'zhe', 得: 'de', 们: 'men', 么: 'me', 啊: 'a', 嘛: 'ma', 呀: 'ya', 啦: 'la', 个: 'gè', 还: 'hái', 都: 'dōu', 说: 'shuō' };

const BORING = /^(variant of|old variant of|surname |see |used in |abbr\. for|\(bound form\)$|CL:|erhua variant)/i;
function shortGloss(defs, max = 48) {
  const parts = defs.split('/').map((d) => d.trim()).filter(Boolean);
  const pick = parts.find((d) => !BORING.test(d)) || parts[0] || '';
  const clean = pick.replace(/^\(bound form\)\s*/i, '').replace(/\s*\(.*?\)\s*$/g, '').trim() || pick;
  return clean.length > max ? clean.slice(0, max - 1).trimEnd() + '…' : clean;
}

/** Best dictionary reading for a word: { pinyin: [syllables with marks], gloss, defs } or null */
export function lookupWord(word) {
  const db = openDb();
  const chars = [...word];
  if (chars.length === 1) {
    const c = charTable().get(word);
    const d = db.prepare('SELECT pinyin, defs FROM ref.dict WHERE simp = ? ORDER BY id').all(word);
    const hsk = db.prepare('SELECT pinyin, meaning FROM ref.hsk WHERE simp = ?').get(word);
    const py = (PARTICLES[word] || (c?.pinyin ? c.pinyin.split(',')[0] : '') || hsk?.pinyin || (d[0] ? numericToMarks(d[0].pinyin) : '')).toLowerCase();
    if (!py && !c && !d.length) return null;
    return { pinyin: [py], gloss: c?.definition ? trim(c.definition) : d[0] ? shortGloss(d[0].defs) : '', defs: d.map((x) => `${fmtPinyin(x.pinyin)}: ${x.defs.replaceAll('/', '; ')}`) };
  }
  const rows = db.prepare('SELECT pinyin, defs FROM ref.dict WHERE simp = ? ORDER BY id').all(word);
  if (!rows.length) return null;
  const hsk = db.prepare('SELECT pinyin, meaning FROM ref.hsk WHERE simp = ?').get(word);
  const best = rows.find((r) => !/^[A-Z]/.test(r.pinyin) && !BORING.test(r.defs.split('/')[0])) || rows[0];
  let syl = best.pinyin.split(' ').map(numericToMarks);
  if (hsk?.pinyin && hsk.pinyin.split(' ').length === chars.length) syl = hsk.pinyin.split(' ');
  return { pinyin: syl, gloss: shortGloss(best.defs), defs: rows.map((x) => `${fmtPinyin(x.pinyin)}: ${x.defs.replaceAll('/', '; ')}`) };
}
const fmtPinyin = (numeric) => numeric.split(' ').map(numericToMarks).join(' ');
const trim = (s, max = 48) => (s.length > max ? s.slice(0, max - 1).trimEnd() + '…' : s);

/** Greedy longest-match segmentation into dictionary words. Non-Han runs are kept as-is. */
export function segment(text) {
  const db = openDb();
  const has = db.prepare('SELECT 1 AS x FROM ref.dict WHERE simp = ? LIMIT 1');
  const common = db.prepare('SELECT 1 AS x FROM ref.hsk WHERE simp = ?');
  const chars = [...text];
  const out = [];
  let i = 0;
  while (i < chars.length) {
    if (!HAN.test(chars[i])) {
      let j = i; while (j < chars.length && !HAN.test(chars[j])) j++;
      out.push({ text: chars.slice(i, j).join(''), han: false }); i = j; continue;
    }
    let len = Math.min(6, chars.length - i), found = 1;
    for (; len > 1; len--) {
      const cand = chars.slice(i, i + len).join('');
      if (![...cand].every((c) => HAN.test(c)) || !has.get(cand)) continue;
      // Greedy matching can steal a character from the next word: 说中文 would split as 说中|文
      // ("hit the nail" + "culture"). If a rare two-character match is followed by a common word
      // starting at its second character (中文), keep the first character on its own instead.
      if (len === 2 && i + 2 < chars.length && !common.get(cand) && common.get(chars[i + 1] + chars[i + 2])) continue;
      found = len; break;
    }
    out.push({ text: chars.slice(i, i + found).join(''), han: true }); i += found;
  }
  return out;
}

/** Offline pinyin for a phrase: one syllable per Han character, space separated. */
export function autoPinyin(text) {
  const syl = [];
  for (const seg of segment(text)) {
    if (!seg.han) continue;
    const w = lookupWord(seg.text);
    const n = [...seg.text].length;
    if (w && w.pinyin.length === n) syl.push(...w.pinyin);
    else for (const ch of seg.text) syl.push(lookupWord(ch)?.pinyin[0] || '?');
  }
  return syl.join(' ').toLowerCase();
}

/** Offline English guess: exact dictionary entry, else word-by-word glosses. */
export function autoEnglish(text) {
  const han = hanChars(text).join('');
  const exact = han && lookupWord(han);
  if (exact && [...han].length > 1) return { english: exact.gloss, exact: true };
  if (exact) return { english: exact.gloss, exact: true };
  const parts = segment(text).filter((s) => s.han).map((s) => lookupWord(s.text)?.gloss.split(/[;,]/)[0].trim()).filter(Boolean);
  return { english: parts.join(' · '), exact: false };
}

// ---------- decomposition ----------
const IDS_OPS = new Set([...'⿰⿱⿲⿳⿴⿵⿶⿷⿸⿹⿺⿻']);
/** Leaf components of a character, e.g. 得 "⿰彳⿱旦寸" -> [彳, 旦, 寸] */
export function componentsOf(ch) {
  const row = charTable().get(ch);
  if (!row?.decomposition) return [];
  const leaves = [...row.decomposition].filter((c) => !IDS_OPS.has(c) && c !== '？' && c !== ch);
  return leaves.length >= 2 || (leaves.length === 1 && row.decomposition.includes('？')) ? leaves : [];
}

/** All components of a character, recursively (deduplicated). */
export function allComponents(ch, depth = 3, acc = new Set()) {
  if (depth === 0) return acc;
  for (const c of componentsOf(ch)) { if (!acc.has(c)) { acc.add(c); allComponents(c, depth - 1, acc); } }
  return acc;
}

/** Which notes contain each character: Map<char, [{id, hanzi}]>, plus set of exact-note hanzi. */
export function deckIndex() {
  const byChar = new Map(), exact = new Map();
  for (const n of openDb().prepare('SELECT id, hanzi, english FROM notes').all()) {
    exact.set(hanChars(n.hanzi).join(''), n.id);
    for (const c of uniqueHan(n.hanzi)) { if (!byChar.has(c)) byChar.set(c, []); byChar.get(c).push({ id: n.id, hanzi: n.hanzi, english: n.english }); }
  }
  // component -> deck characters that contain it
  const byComponent = new Map();
  for (const c of byChar.keys()) for (const comp of allComponents(c)) {
    if (!byComponent.has(comp)) byComponent.set(comp, new Set()); byComponent.get(comp).add(c);
  }
  return { byChar, exact, byComponent };
}

function charNode(ch, idx, role, depth) {
  const row = charTable().get(ch);
  const notes = idx.byChar.get(ch) || [];
  const inChars = [...(idx.byComponent.get(ch) || [])];
  const node = {
    type: depth === 0 ? 'char' : 'component', text: ch,
    pinyin: row?.pinyin ? row.pinyin.split(',')[0] : (depth === 0 ? lookupWord(ch)?.pinyin[0] || '' : ''),
    gloss: row?.definition ? trim(row.definition, 60) : (depth === 0 ? lookupWord(ch)?.gloss || '' : ''),
    seen: notes.length, noteId: idx.exact.get(ch) ?? null,
    inChars: inChars.length, role: role || null, children: [],
  };
  // Always open up a character; open up a component only if it is itself a compound of compounds.
  // Otherwise the tree fills with stroke-level noise (二 -> 一 + 一).
  const comps0 = componentsOf(ch);
  const worthOpening = depth === 0 || comps0.some((c) => componentsOf(c).length > 0);
  if (depth < 3 && worthOpening) {
    const comps = comps0;
    node.children = comps.map((c) => charNode(c, idx,
      c === row?.radical ? 'radical' : c === row?.etym_semantic ? 'meaning' : c === row?.etym_phonetic ? 'sound' : null, depth + 1));
  }
  return node;
}

/** The breakdown tree for any text. */
export function breakdown(text, idx = deckIndex()) {
  const han = hanChars(text).join('');
  const segs = segment(text).filter((s) => s.han);
  const wordNode = (w) => {
    const info = lookupWord(w);
    const chars = [...w];
    if (chars.length === 1) return charNode(w, idx, null, 0);
    return {
      type: 'word', text: w, pinyin: info && info.pinyin.length === chars.length ? info.pinyin.join(' ') : chars.map((c) => lookupWord(c)?.pinyin[0] || '?').join(' '),
      gloss: info?.gloss || '', seen: chars.every((c) => idx.byChar.has(c)) ? 1 : 0, noteId: idx.exact.get(w) ?? null,
      children: chars.map((c) => charNode(c, idx, null, 0)),
    };
  };
  if (segs.length === 1) return wordNode(segs[0].text);
  return {
    type: 'phrase', text: text.trim(), pinyin: '', gloss: '', seen: 0, noteId: idx.exact.get(han) ?? null,
    children: segs.map((s) => wordNode(s.text)),
  };
}

/** Everything known about one character or component, for the detail panel. */
export function charDetail(ch, idx = deckIndex()) {
  const row = charTable().get(ch);
  const w = lookupWord(ch);
  const db = openDb();
  const words = HAN.test(ch) ? db.prepare(
    `SELECT simp, level, freq, pinyin, meaning FROM ref.hsk WHERE simp LIKE ? AND length(simp) > 1 ORDER BY freq LIMIT 12`).all(`%${ch}%`) : [];
  return {
    text: ch, pinyin: row?.pinyin ? row.pinyin.split(',') : w?.pinyin || [], definition: row?.definition || w?.gloss || '',
    defs: w?.defs || [], radical: row?.radical || '', decomposition: row?.decomposition || '',
    etymology: row ? { type: row.etym_type, hint: row.etym_hint, semantic: row.etym_semantic, phonetic: row.etym_phonetic } : null,
    notes: idx.byChar.get(ch) || [], noteId: idx.exact.get(ch) ?? null,
    inChars: [...(idx.byComponent.get(ch) || [])],
    words: words.map((x) => ({ ...x, known: idx.exact.has(x.simp) })),
  };
}
