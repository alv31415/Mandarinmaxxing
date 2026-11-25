// Run with: npm test      (uses a throwaway copy of the user database; reference data must exist)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

// Point the app at a temp folder so tests never touch real cards. reference.db is copied in.
const dir = mkdtempSync(path.join(tmpdir(), 'mandarin-test-'));
copyFileSync(new URL('../data/reference.db', import.meta.url), path.join(dir, 'reference.db'));
process.env.MANDARIN_DATA_DIR = dir;

const { schedule, State, intervalFor, retrievability } = await import('../lib/fsrs.js');
const { numericToMarks, normalizePinyin, toneOf, autoPinyin, segment, componentsOf, breakdown } = await import('../lib/hanzi.js');
const { createNote, getNote } = await import('../lib/notes.js');
const { nextCard, answer, undo, counts } = await import('../lib/scheduler.js');
const { offlineSuggestions } = await import('../lib/suggest.js');
const { stats } = await import('../lib/stats.js');

const DAY = 86400000, MIN = 60000;
const fresh = { state: 0, due: 0, stability: 0, difficulty: 0, reps: 0, lapses: 0, last_review: null };

test('fsrs: new card steps and graduation', () => {
  const t0 = 1_700_000_000_000;
  assert.equal(schedule(fresh, 1, t0).due - t0, 1 * MIN);
  const good = schedule(fresh, 3, t0);
  assert.equal(good.state, State.Learning);
  assert.equal(good.due - t0, 10 * MIN);
  const grad = schedule(good, 3, t0 + 10 * MIN);
  assert.equal(grad.state, State.Review);
  assert.ok(grad.due - (t0 + 10 * MIN) >= DAY);
  const easy = schedule(fresh, 4, t0);
  assert.equal(easy.state, State.Review);
  assert.ok(easy.due - t0 > 5 * DAY);
});

test('fsrs: reviews grow intervals, lapses shrink them, buttons are ordered', () => {
  let c = schedule(fresh, 4, 0), now = c.due;
  const first = c.due;
  const [h, g, e] = [2, 3, 4].map((r) => schedule(c, r, now).due - now);
  assert.ok(h < g && g < e, `hard ${h} < good ${g} < easy ${e}`);
  const c2 = schedule(c, 3, now);
  assert.ok(c2.due - now > first, 'interval grows after a successful review');
  assert.ok(c2.stability > c.stability);
  const lapse = schedule(c2, 1, c2.due);
  assert.equal(lapse.state, State.Relearning);
  assert.equal(lapse.lapses, 1);
  assert.ok(lapse.stability < c2.stability);
  assert.ok(lapse.difficulty > c2.difficulty);
});

test('fsrs: interval is the time at which recall drops to the target', () => {
  assert.equal(intervalFor(10, 0.9), 10);
  assert.ok(Math.abs(retrievability(10, 10) - 0.9) < 1e-9);
  assert.ok(intervalFor(10, 0.95) < 10 && intervalFor(10, 0.85) > 10);
});

test('pinyin helpers', () => {
  assert.equal(numericToMarks('hao3'), 'hǎo');
  assert.equal(numericToMarks('lu:4'), 'lǜ');
  assert.equal(numericToMarks('xue2'), 'xué');
  assert.equal(numericToMarks('gui4'), 'guì');
  assert.equal(numericToMarks('liu2'), 'liú');
  assert.equal(numericToMarks('ma5'), 'ma');
  assert.equal(toneOf('hǎo'), 3);
  assert.equal(toneOf('ma'), 5);
  assert.equal(normalizePinyin('Nǐ hǎo'), normalizePinyin('ni3hao3'));
  assert.equal(normalizePinyin('nǐ hǎo', { tones: false }), 'nihao');
  assert.notEqual(normalizePinyin('ni2 hao3'), normalizePinyin('nǐ hǎo'));
});

test('segmentation and automatic pinyin', () => {
  assert.deepEqual(segment('没关系').map((s) => s.text), ['没关系']);
  assert.deepEqual(segment('他会说中文').map((s) => s.text), ['他', '会', '说', '中文']);
  assert.equal(autoPinyin('他会说中文'), 'tā huì shuō zhōng wén');
  assert.equal(autoPinyin('好吧'), 'hǎo ba');
  assert.equal(autoPinyin('你为啥是gay').split(' ').length, 4, 'one syllable per Chinese character, Latin skipped');
});

test('decomposition', () => {
  assert.deepEqual(componentsOf('好'), ['女', '子']);
  assert.deepEqual(componentsOf('得'), ['彳', '旦', '寸']);
  const tree = breakdown('好');
  assert.equal(tree.type, 'char');
  assert.deepEqual(tree.children.map((c) => c.text), ['女', '子']);
  assert.equal(tree.children[0].role, 'radical');
});

test('notes, queue, answering and undo', () => {
  const id = createNote({ hanzi: '小学', english: 'primary school' });
  const note = getNote(id);
  assert.equal(note.pinyin, 'xiǎo xué');
  assert.equal(note.cards.length, 2);
  assert.throws(() => createNote({ hanzi: '小学', english: 'x' }), /already exists/);
  assert.throws(() => createNote({ hanzi: 'hello', english: 'x' }), /Chinese character/);

  const card = nextCard();
  assert.equal(card.hanzi, '小学');
  assert.deepEqual(Object.keys(card.intervals), ['1', '2', '3', '4']);
  answer(card.id, 3);
  assert.equal(counts().doneToday, 1);
  // the other direction of the same note is held back for the rest of the day
  const after = nextCard();
  assert.equal(after.id, card.id, 'only the learning card is offered, not its sibling');
  assert.equal(undo(), card.id);
  assert.equal(counts().doneToday, 0);
  assert.equal(getNote(id).cards.find((c) => c.id === card.id).state, 0);
});

test('seen/unseen marking, suggestions and stats follow the deck', () => {
  const tree = breakdown('大学');
  const [da, xue] = tree.children;
  assert.equal(da.seen, 0, '大 is new');
  assert.equal(xue.seen, 1, '学 is in 小学');
  const sugg = offlineSuggestions(30);
  assert.ok(sugg.length > 0);
  for (const s of sugg) {
    assert.ok(s.newChars.length <= 1, `${s.hanzi} has at most one new character`);
    assert.ok([...s.hanzi].some((c) => '小学'.includes(c)), `${s.hanzi} shares a character with the deck`);
  }
  const st = stats();
  assert.equal(st.totals.notes, 1);
  assert.equal(st.totals.characters, 2);
  assert.ok(st.radicals.some((r) => r.ch === '子' && r.chars.includes('学')));
});
