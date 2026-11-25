// The whole frontend. No framework: each "view" is a function that fetches JSON from the server
// and builds DOM nodes with the small h() helper below. The URL hash (#/review, #/cards, …)
// decides which view is shown.

// ---------------------------------------------------------------- helpers
const $ = (sel) => document.querySelector(sel);
const app = $('#app');

/** Build a DOM element: h('div', { class: 'x', onclick: fn }, child, 'text', …) */
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k in el && k !== 'list') el[k] = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
  return el;
}

/** Like el.replaceChildren / el.append, but skips null/false and flattens arrays (so views can use `cond ? node : null`). */
const clean = (kids) => kids.flat(Infinity).filter((c) => c != null && c !== false);
const fill = (el, ...kids) => el.replaceChildren(...clean(kids));
const add = (el, ...kids) => el.append(...clean(kids));

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method, headers: body ? { 'content-type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'Request failed'), { status: res.status, data });
  return data;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toastTimer); toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

// hover tooltip for chart marks: any element with data-tip
const tip = $('#tip');
document.addEventListener('mousemove', (e) => {
  const el = e.target.closest?.('[data-tip]');
  if (!el) { tip.hidden = true; return; }
  tip.textContent = el.dataset.tip; tip.hidden = false;
  tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px';
  tip.style.top = e.clientY - 34 + 'px';
});

const HAN = /\p{Script=Han}/u;
const TONE_MARKS = { 1: 'āēīōūǖ', 2: 'áéíóúǘ', 3: 'ǎěǐǒǔǚ', 4: 'àèìòùǜ' };
const BASE = { a: 'āáǎà', e: 'ēéěè', i: 'īíǐì', o: 'ōóǒò', u: 'ūúǔù', 'ü': 'ǖǘǚǜ' };
function toneOf(syl) {
  for (const ch of syl.toLowerCase()) for (const t of [1, 2, 3, 4]) if (TONE_MARKS[t].includes(ch)) return t;
  return 5;
}
/** "nǐ hǎo" or "ni3 hao3" -> "ni3hao3"; with tones:false -> "nihao". Used to check typed answers. */
function normalizePinyin(s, tones = true) {
  let out = '';
  for (let syl of s.toLowerCase().replace(/u:|v/g, 'ü').split(/[^a-zü1-5āáǎàēéěèīíǐìōóǒòūúǔùǖǘǚǜ]+/)) {
    if (!syl) continue;
    if (/[1-5]$/.test(syl)) { out += tones ? syl : syl.slice(0, -1); continue; }
    let tone = 5, base = '';
    for (const ch of syl) {
      const hit = Object.entries(BASE).find(([, row]) => row.includes(ch));
      if (hit) { base += hit[0]; tone = hit[1].indexOf(ch) + 1; } else base += ch;
    }
    out += tones ? base + tone : base;
  }
  return out;
}

let settings = { toneColors: true };

/** Chinese text with pinyin above each character, coloured by tone. */
function zh(hanzi, pinyin = '', { cls = '', showPinyin = true, color = true } = {}) {
  const syl = pinyin.trim().split(/\s+/).filter(Boolean);
  const chars = [...hanzi];
  const aligned = syl.length === chars.filter((c) => HAN.test(c)).length;
  const out = h('span', { class: `zh ${settings.toneColors && color ? 'tones' : ''} ${cls}`, lang: 'zh-Hans' });
  let i = 0;
  for (const c of chars) {
    if (!HAN.test(c) || !aligned) { out.append(c); continue; }
    const s = syl[i++], t = 't' + toneOf(s);
    out.append(showPinyin ? h('ruby', { class: t }, c, h('rt', { class: t }, s)) : h('span', { class: t }, c));
  }
  if (!aligned && showPinyin && pinyin) return h('span', {}, out, h('div', { class: 'py' }, pinyin));
  return out;
}

const fmtDue = (ms) => {
  const d = ms - Date.now();
  if (d <= 0) return 'due now';
  const m = d / 60000;
  if (m < 60) return `in ${Math.ceil(m)} min`;
  if (m < 60 * 24) return `in ${Math.round(m / 60)} h`;
  return `in ${Math.round(m / 1440)} d`;
};
const dayLabel = (ms) => new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

// ---------------------------------------------------------------- breakdown tree + side panel
function treeView(tree) {
  const nodeEl = (n) => {
    const seen = n.type === 'component' ? n.seen + n.inChars > 0 : n.seen > 0 || n.noteId;
    const btn = h('button', {
      class: `node ${n.type} ${seen ? '' : 'unseen'}`,
      onclick: (e) => { document.querySelectorAll('.node.sel').forEach((x) => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); openPanel(n); },
    },
      h('span', { class: 'g' }, n.text),
      n.pinyin && h('span', { class: 'p' }, n.pinyin),
      n.gloss && h('span', { class: 'd' }, n.type === 'component' ? n.gloss.split(/[;,]/)[0] : n.gloss),
      n.role && h('span', { class: 'r' }, n.role));
    return h('li', {}, btn, n.children?.length ? h('ul', {}, n.children.map(nodeEl)) : null);
  };
  // A phrase is drawn as a row of small trees (one per word) that wraps, instead of one very wide tree.
  const roots = tree.type === 'phrase' ? tree.children : [tree];
  return h('div', {},
    h('div', { class: 'forest' }, roots.map((r) => h('div', { class: 'treewrap' }, h('ul', { class: 'tree' }, nodeEl(r))))),
    h('div', { class: 'legend' },
      h('span', {}, h('i'), 'already in your cards'),
      h('span', {}, h('i', { class: 'dash' }), 'new to you'),
      h('span', {}, 'Click anything to look inside it.')));
}

const panel = $('#panel');
function closePanel() { panel.hidden = true; panel.replaceChildren(); }
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closePanel(); });

async function openPanel(node) {
  const text = node.text;
  const single = [...text].length === 1;
  panel.hidden = false;
  panel.replaceChildren(h('div', { class: 'row spread' }, h('span', { class: 'muted small' }, node.type === 'char' ? 'character' : node.type), h('button', { class: 'btn quiet', onclick: closePanel }, 'Close')));
  const addBtn = (hanzi, label = 'Add as card') => h('button', { class: 'btn', onclick: () => { closePanel(); location.hash = '#/add?text=' + encodeURIComponent(hanzi); } }, label);

  if (!single) { // a word or phrase
    add(panel, h('div', { class: 'glyph' }, zh(text, node.pinyin || '')), h('p', {}, node.gloss || ''),
      h('div', { class: 'row' }, node.noteId ? h('a', { class: 'btn', href: '#/note/' + node.noteId, onclick: closePanel }, 'Open card') : addBtn(text)));
    return;
  }
  const d = await api('GET', '/char/' + encodeURIComponent(text));
  const e = d.etymology;
  add(panel, 
    h('div', { class: 'glyph' }, text),
    h('p', {}, h('b', {}, d.pinyin.join(', ')), d.pinyin.length ? ' · ' : '', d.definition || h('span', { class: 'muted' }, 'A building block with no meaning of its own on record.')),
    e?.hint && h('p', { class: 'muted small' }, e.type ? e.type[0].toUpperCase() + e.type.slice(1) + ': ' : '', e.hint,
      e.semantic ? ` — meaning from ${e.semantic}` : '', e.phonetic ? `, sound from ${e.phonetic}` : ''),
    h('div', { class: 'row' },
      d.noteId ? h('a', { class: 'btn', href: '#/note/' + d.noteId, onclick: closePanel }, 'Open card') : (HAN.test(text) && d.definition ? addBtn(text) : null)),
    d.notes.length ? [h('h2', {}, `In ${d.notes.length} of your cards`),
      h('div', { class: 'pills' }, d.notes.map((n) => h('a', { class: 'pill', href: '#/note/' + n.id, title: n.english, onclick: closePanel }, n.hanzi)))] : null,
    d.inChars.length ? [h('h2', {}, `Inside ${d.inChars.length} characters you know`),
      h('div', { class: 'pills' }, d.inChars.map((c) => h('button', { class: 'pill', onclick: () => openPanel({ text: c, type: 'char' }) }, c)))] : null,
    d.words.length ? [h('h2', {}, 'Common words with it'),
      d.words.map((w) => h('div', { class: 'wordrow' },
        h('span', { class: 'zh' }, w.simp), h('span', { class: 'muted' }, `${w.pinyin} · ${w.meaning}`),
        w.known ? h('span', { class: 'chip' }, 'have') : h('button', { class: 'btn quiet', title: 'Add', onclick: () => { closePanel(); location.hash = '#/add?text=' + encodeURIComponent(w.simp); } }, '+')))] : null,
  );
}

// ---------------------------------------------------------------- review
let keyHandler = null;
document.addEventListener('keydown', (e) => {
  if (!keyHandler || e.metaKey || e.ctrlKey || e.altKey) return;
  keyHandler(e);
});

async function reviewView() {
  let mode = localStorage.getItem('mode') === 'type' ? 'type' : 'flip';
  let card, counts, flipped, started, verdict, showTree;

  async function load() {
    const r = await api('GET', '/review/next');
    card = r.card; counts = r.counts; flipped = false; verdict = null; showTree = null; started = Date.now();
    render(r.nextDue);
  }
  async function grade(rating) {
    if (!card || !flipped) return;
    await api('POST', '/review/answer', { cardId: card.id, rating, mode, durationMs: Date.now() - started });
    load();
  }
  async function undo() {
    const r = await api('POST', '/review/undo');
    if (r.cardId) { toast('Undid the last answer'); load(); } else toast('Nothing to undo');
  }
  function check(value) {
    const typed = value.trim();
    if (!typed) { flipped = true; verdict = null; return render(); }
    const han = [...typed].filter((c) => HAN.test(c)).join('');
    const target = [...card.hanzi].filter((c) => HAN.test(c)).join('');
    if (han) verdict = han === target ? 'ok' : 'no';
    else if (normalizePinyin(typed) === normalizePinyin(card.pinyin)) verdict = 'ok';
    else if (normalizePinyin(typed, false) === normalizePinyin(card.pinyin, false)) verdict = 'near';
    else verdict = 'no';
    flipped = true; render();
  }
  async function toggleTree() {
    if (showTree) { showTree = null; return render(); }
    showTree = (await api('GET', '/notes/' + card.note_id)).tree; render();
  }

  function render(nextDue) {
    app.className = '';
    if (!card) {
      keyHandler = (e) => { if (e.key === 'u') undo(); };
      return fill(app, h('div', { class: 'done' },
        h('div', { class: 'zh' }, '完成'),
        h('p', {}, counts.doneToday ? `Done for now — ${counts.doneToday} reviews today.` : 'Nothing is due.'),
        h('p', { class: 'muted small' }, nextDue ? `Next card ${fmtDue(nextDue)}.` : '',
          counts.newTotal ? ` ${counts.newTotal} new cards are waiting; today's limit of new cards is reached (change it in Settings).` : ''),
        h('div', { class: 'row', style: 'justify-content:center' }, h('a', { class: 'btn', href: '#/add' }, 'Add a phrase'), h('a', { class: 'btn', href: '#/discover' }, 'Discover'))));
    }
    const zh2en = card.direction === 'zh2en';
    const long = [...card.hanzi].length > 7;
    const front = zh2en
      ? zh(card.hanzi, card.pinyin, { cls: 'big' + (long ? ' long' : ''), showPinyin: flipped || settings.showPinyinOnFront, color: flipped || settings.showPinyinOnFront })
      : h('div', { class: 'en' + (card.english.length > 60 ? ' long' : '') }, card.english);
    const back = !flipped ? null : [
      h('hr'),
      zh2en ? h('div', { class: 'en' + (card.english.length > 60 ? ' long' : '') }, card.english) : zh(card.hanzi, card.pinyin, { cls: 'big' + (long ? ' long' : '') }),
      card.notes && h('div', { class: 'muted small' }, card.notes),
      card.needs_check ? h('div', { class: 'chip flag' }, 'translation was auto-filled — check it') : null,
    ];
    const typing = mode === 'type' && !flipped;
    const input = typing ? h('input', {
      type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
      placeholder: zh2en ? 'Type the pinyin (ni3 hao3 or nǐ hǎo), then Enter' : 'Type pinyin or characters, then Enter',
      onkeydown: (e) => { if (e.key === 'Enter') { e.preventDefault(); check(e.target.value); } e.stopPropagation(); },
    }) : null;
    const suggested = verdict === 'ok' ? 3 : verdict === 'near' ? 2 : verdict === 'no' ? 1 : 0;
    const names = { 1: 'Again', 2: 'Hard', 3: 'Good', 4: 'Easy' };

    fill(app, 
      h('div', { class: 'counts' },
        h('span', {}, h('b', {}, counts.new), ' new'), h('span', {}, h('b', {}, counts.learning), ' learning'), h('span', {}, h('b', {}, counts.review), ' to review'),
        h('span', {}, zh2en ? '中 → EN' : 'EN → 中')),
      h('div', { class: 'card', onclick: () => { if (!flipped && !typing) { flipped = true; render(); } } },
        front, back, !flipped && !typing ? h('div', { class: 'hint' }, 'Recall it, then press space') : null),
      typing ? h('div', { class: 'typed' }, input) : null,
      flipped && verdict ? h('p', { class: `verdict center ${verdict}`, style: 'margin-top:12px' },
        verdict === 'ok' ? 'Correct.' : verdict === 'near' ? 'Right syllables, but check the tones.' : 'Not quite.') : null,
      flipped ? h('div', { class: 'grades' }, [1, 2, 3, 4].map((g) =>
        h('button', { class: 'btn' + (g === suggested ? ' suggested' : ''), onclick: () => grade(g) }, h('b', {}, names[g], h('kbd', {}, g)), h('span', {}, card.intervals[g])))) : null,
      h('div', { class: 'row spread under' },
        h('div', { class: 'row' },
          h('button', { class: 'btn quiet', onclick: () => { mode = mode === 'type' ? 'flip' : 'type'; localStorage.setItem('mode', mode); render(); } },
            mode === 'type' ? 'Typing mode: on' : 'Typing mode: off', h('kbd', {}, 't')),
          h('button', { class: 'btn quiet', onclick: undo }, 'Undo', h('kbd', {}, 'u'))),
        flipped ? h('div', { class: 'row' },
          h('button', { class: 'btn quiet', onclick: toggleTree }, showTree ? 'Hide breakdown' : 'Break down', h('kbd', {}, 'b')),
          h('a', { class: 'btn quiet', href: '#/note/' + card.note_id }, 'Edit')) : null),
      showTree ? treeView(showTree) : null,
    );
    input?.focus();
    keyHandler = (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if ((e.key === ' ' || e.key === 'Enter') && !flipped) { e.preventDefault(); flipped = true; render(); }
      else if (flipped && '1234'.includes(e.key)) grade(+e.key);
      else if (flipped && (e.key === ' ' || e.key === 'Enter')) { e.preventDefault(); grade(suggested || 3); }
      else if (e.key === 'u') undo();
      else if (e.key === 't') { mode = mode === 'type' ? 'flip' : 'type'; localStorage.setItem('mode', mode); render(); }
      else if (e.key === 'b' && flipped) toggleTree();
    };
  }
  await load();
}

// ---------------------------------------------------------------- cards list
async function cardsView() {
  const list = h('div', { class: 'list' });
  const count = h('span', { class: 'muted small' });
  async function load(q = '') {
    const notes = await api('GET', '/notes?q=' + encodeURIComponent(q));
    count.textContent = `${notes.length} card${notes.length === 1 ? '' : 's'}`;
    list.replaceChildren(...notes.map((n) => h('a', { class: 'item', href: '#/note/' + n.id },
      h('div', {}, zh(n.hanzi, n.pinyin, { showPinyin: false }), h('div', { class: 'sub' }, n.pinyin)),
      h('div', { class: 'mid' }, n.english),
      h('div', { class: 'row' },
        n.needs_check ? h('span', { class: 'chip flag' }, 'check') : null,
        h('span', { class: 'chip' }, n.max_state === 0 ? 'new' : n.min_state === 0 ? 'started' : n.next_due <= Date.now() ? 'due' : fmtDue(n.next_due))))));
    if (!notes.length) list.append(h('p', { class: 'muted', style: 'padding:24px 4px' }, q ? 'No matches.' : 'No cards yet.'));
  }
  let timer;
  fill(app, 
    h('div', { class: 'row spread' }, h('h1', {}, 'Cards'), count),
    h('input', { type: 'search', placeholder: 'Search characters, pinyin or English', oninput: (e) => { clearTimeout(timer); timer = setTimeout(() => load(e.target.value), 150); } }),
    h('div', { style: 'height:16px' }), list);
  await load();
}

// ---------------------------------------------------------------- one note
async function noteView(id) {
  let data;
  try { data = await api('GET', '/notes/' + id); } catch { return fill(app, h('p', {}, 'That card no longer exists. ', h('a', { href: '#/cards' }, 'Back to cards'))); }
  const { note, tree } = data;
  const f = { hanzi: h('input', { type: 'text', value: note.hanzi, class: 'zh' }), pinyin: h('input', { type: 'text', value: note.pinyin }),
    english: h('input', { type: 'text', value: note.english }), notes: h('textarea', { rows: 2, value: note.notes }) };
  const stateName = ['new', 'learning', 'review', 'relearning'];
  fill(app, 
    h('p', {}, h('a', { class: 'muted small', href: '#/cards' }, '← Cards')),
    h('div', { class: 'center', style: 'font-size:44px; line-height:1.8' }, zh(note.hanzi, note.pinyin)),
    h('p', { class: 'center' }, note.english),
    note.needs_check ? h('p', { class: 'center' }, h('span', { class: 'chip flag' }, 'translation was auto-filled — edit or just save to confirm')) : null,
    h('h2', {}, 'Breakdown'), treeView(tree),
    h('h2', {}, 'Memory'),
    h('table', {}, h('tr', {}, ['Direction', 'State', 'Attempts', 'Forgot', 'Stability', 'Next'].map((x) => h('th', {}, x))),
      note.cards.map((c) => h('tr', {},
        h('td', {}, c.direction === 'zh2en' ? '中 → EN' : 'EN → 中'), h('td', {}, stateName[c.state]), h('td', {}, c.attempts), h('td', {}, c.failures),
        h('td', { 'data-tip': 'Days until you would have a 90% chance of recalling it' }, c.stability ? c.stability.toFixed(1) + ' d' : '—'),
        h('td', {}, c.state === 0 ? '—' : fmtDue(c.due))))),
    h('h2', {}, 'Edit'),
    h('label', {}, 'Chinese'), f.hanzi, h('label', {}, 'Pinyin (one syllable per character)'), f.pinyin,
    h('label', {}, 'English'), f.english, h('label', {}, 'Notes'), f.notes,
    h('div', { class: 'row spread', style: 'margin-top:16px' },
      h('div', { class: 'row' },
        h('button', { class: 'btn primary', onclick: async () => {
          try { await api('PUT', '/notes/' + id, Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value]))); toast('Saved'); noteView(id); }
          catch (e) { toast(e.message); }
        } }, 'Save'),
        h('button', { class: 'btn', onclick: async (e) => {
          e.target.disabled = true; e.target.textContent = 'Asking Claude…';
          const r = await api('POST', '/suggestions/generate', { noteId: id });
          if (r.ok) location.hash = '#/discover'; else { toast(r.reason); e.target.disabled = false; e.target.textContent = 'Suggest related'; }
        } }, 'Suggest related')),
      h('button', { class: 'btn quiet danger', onclick: async () => { if (confirm(`Delete “${note.hanzi}” and its review history?`)) { await api('DELETE', '/notes/' + id); location.hash = '#/cards'; } } }, 'Delete')));
}

// ---------------------------------------------------------------- add / explore
async function addView(params) {
  const f = { hanzi: h('input', { type: 'text', class: 'zh', placeholder: '输入中文…', style: 'font-size:24px', value: params.get('text') || '' }),
    pinyin: h('input', { type: 'text' }), english: h('input', { type: 'text' }), notes: h('textarea', { rows: 2 }) };
  const treeBox = h('div'), status = h('span', { class: 'muted small' });
  const draftBtn = h('button', { class: 'btn', onclick: draft }, 'Draft with Claude');
  const saveBtn = h('button', { class: 'btn primary', onclick: save }, 'Save card');
  let touched = { pinyin: false, english: false }, seq = 0;
  f.pinyin.oninput = () => (touched.pinyin = true); f.english.oninput = () => (touched.english = true);

  async function look() {
    const text = f.hanzi.value.trim(), mine = ++seq;
    if (![...text].some((c) => HAN.test(c))) { fill(treeBox); status.textContent = ''; return; }
    const r = await api('GET', '/breakdown?text=' + encodeURIComponent(text)).catch(() => null);
    if (!r || mine !== seq) return;
    if (!touched.pinyin) f.pinyin.value = r.pinyin;
    if (!touched.english) f.english.value = r.english;
    status.textContent = r.noteId ? 'You already have this card.' : r.exact ? 'Filled from the dictionary.' : 'Dictionary guess, word by word — check it or ask Claude.';
    saveBtn.disabled = Boolean(r.noteId);
    treeBox.replaceChildren(h('h2', {}, 'Breakdown'), treeView(r.tree));
  }
  async function draft() {
    const hanzi = f.hanzi.value.trim(); if (!hanzi) return;
    draftBtn.disabled = true; draftBtn.textContent = 'Asking Claude…';
    try {
      const r = await api('POST', '/draft', { hanzi });
      f.pinyin.value = r.pinyin; f.english.value = r.english + (r.literal ? ` (lit. ${r.literal})` : '');
      if (r.note && !f.notes.value) f.notes.value = r.note;
      touched = { pinyin: true, english: true };
      status.textContent = r.source === 'claude' ? 'Drafted by Claude — edit freely.' : `Claude unavailable (${r.aiError}); used the dictionary.`;
    } catch (e) { toast(e.message); }
    draftBtn.disabled = false; draftBtn.textContent = 'Draft with Claude';
  }
  async function save() {
    try {
      const note = await api('POST', '/notes', Object.fromEntries(Object.entries(f).map(([k, el]) => [k, el.value])));
      toast(`Added ${note.hanzi}`);
      for (const el of Object.values(f)) el.value = '';
      touched = { pinyin: false, english: false }; fill(treeBox); status.textContent = ''; f.hanzi.focus();
    } catch (e) { toast(e.message); }
  }
  let timer;
  f.hanzi.oninput = () => { touched = { pinyin: false, english: false }; clearTimeout(timer); timer = setTimeout(look, 200); };
  fill(app, 
    h('h1', {}, 'Add a phrase'),
    h('p', { class: 'muted' }, 'Type or paste Chinese. You will see what it is made of and which parts you already know.'),
    f.hanzi,
    h('label', {}, 'Pinyin'), f.pinyin, h('label', {}, 'English'), f.english, h('label', {}, 'Notes (optional)'), f.notes,
    h('div', { class: 'row', style: 'margin-top:16px' }, saveBtn, settings.ai ? draftBtn : null, status),
    treeBox);
  f.hanzi.focus();
  if (f.hanzi.value) look();
}

// ---------------------------------------------------------------- discover
async function discoverView() {
  const box = h('div');
  const btn = h('button', { class: 'btn primary', onclick: generate }, 'Ask Claude for ideas');
  async function generate() {
    btn.disabled = true; btn.textContent = 'Thinking…';
    const r = await api('POST', '/suggestions/generate', {}).catch((e) => ({ ok: false, reason: e.message }));
    btn.disabled = false; btn.textContent = 'Ask Claude for ideas';
    if (!r.ok) toast(r.reason); else { toast(`${r.added} new ideas`); load(); }
  }
  const row = (s, reload) => h('div', { class: 'sugg' },
    h('div', {},
      h('div', {}, zh(s.hanzi, s.pinyin)),
      h('div', {}, s.english),
      h('div', { class: 'why' }, s.reason),
      h('div', { class: 'row', style: 'margin-top:6px' }, s.relation ? h('span', { class: 'chip' }, s.relation) : null,
        s.related_to ? h('span', { class: 'chip' }, '↔ ' + s.related_to) : null,
        s.newChars?.length ? h('span', { class: 'chip' }, `new: ${s.newChars.join(' ')}`) : h('span', { class: 'chip' }, 'no new characters'),
        s.level ? h('span', { class: 'chip' }, 'HSK ' + (s.level === 7 ? '7–9' : s.level)) : null)),
    h('div', { class: 'row', style: 'align-self:start' },
      h('button', { class: 'btn', onclick: async () => {
        try { await api('POST', '/notes', { hanzi: s.hanzi, pinyin: s.pinyin, english: s.english, notes: s.source === 'claude' ? s.reason : '', source: 'suggestion' }); toast(`Added ${s.hanzi}`); reload(); }
        catch (e) { toast(e.message); }
      } }, 'Add'),
      h('button', { class: 'btn quiet', title: 'See what it is made of', onclick: () => (location.hash = '#/add?text=' + encodeURIComponent(s.hanzi)) }, 'Look'),
      h('button', { class: 'btn quiet', title: 'Do not suggest again', onclick: async () => { await api('POST', '/suggestions/dismiss', { hanzi: s.hanzi }); reload(); } }, 'Dismiss')));
  async function load() {
    const d = await api('GET', '/suggestions');
    fill(box, 
      h('h2', {}, 'Connected to what you know'),
      d.claude.length ? d.claude.map((s) => row(s, load))
        : h('p', { class: 'muted' }, d.ai ? 'Ask Claude for opposites, missing members of sets, and related slang based on your cards.' : 'Claude is not set up, so only dictionary-based ideas are shown below.'),
      h('h2', {}, 'One step from your characters'),
      h('p', { class: 'muted small' }, 'Common words made of characters you already know plus at most one new one. Works offline.'),
      d.offline.map((s) => row(s, load)));
  }
  fill(app, h('div', { class: 'row spread' }, h('h1', {}, 'Discover'), settings.ai ? btn : null), box);
  await load();
}

// ---------------------------------------------------------------- stats
async function statsView() {
  app.className = 'wide';
  const s = await api('GET', '/stats'), t = s.totals;
  const tile = (n, label) => h('div', { class: 'tile' }, h('b', {}, n), h('span', {}, label));
  const bars = (rows, value, tipFn) => {
    const max = Math.max(1, ...rows.map(value));
    return h('div', {}, h('div', { class: 'bars' }, rows.map((r) => h('div', { 'data-tip': tipFn(r) }, h('i', { style: `height:${(value(r) / max) * 100}%` })))),
      h('div', { class: 'axis' }, h('span', {}, dayLabel(rows[0].day)), h('span', {}, dayLabel(rows[rows.length - 1].day))));
  };
  const hbars = (rows) => {
    const max = Math.max(1, ...rows.map((r) => r.count));
    return rows.map((r) => h('div', { class: 'hbar', 'data-tip': r.chars.join(' '), onclick: () => openPanel({ text: r.ch, type: 'component' }) },
      h('span', { class: 'zh' }, r.ch), h('span', { class: 'muted' }, (r.meaning || '').split(/[;,]/)[0]),
      h('span', { class: 'track' }, h('i', { style: `width:${(r.count / max) * 100}%` })), h('span', { class: 'n' }, r.count)));
  };
  let tab = 'radicals';
  const partBox = h('div');
  const tabs = h('div', { class: 'tabs' });
  const drawParts = () => {
    tabs.replaceChildren(...[['radicals', 'Radicals'], ['components', 'All components'], ['characters', 'Characters']].map(([k, label]) =>
      h('button', { class: tab === k ? 'on' : '', onclick: () => { tab = k; drawParts(); } }, label)));
    const rows = tab === 'characters' ? s.characters.map((c) => ({ ch: c.ch, meaning: '', count: c.count, chars: c.notes.slice(0, 6) })) : s[tab];
    fill(partBox, 
      h('p', { class: 'muted small' }, tab === 'radicals' ? 'How many of your characters are filed under each radical.'
        : tab === 'components' ? 'How many of your characters contain each building block, at any depth.' : 'How many of your cards each character appears in.'),
      ...hbars(rows.slice(0, 40)));
  };
  drawParts();
  fill(app, 
    h('h1', {}, 'Stats'),
    h('div', { class: 'tiles' },
      tile(t.notes, 'phrases'), tile(t.characters, 'unique characters'), tile(t.radicals, 'radicals met'),
      tile(t.reviewsToday, 'reviews today'), tile(t.reviews, 'reviews in total'),
      tile(t.retention == null ? '—' : Math.round(t.retention * 100) + '%', 'recall on mature cards'), tile(t.streak, 'day streak')),
    h('p', { class: 'muted small', style: 'margin-top:12px' }, `Cards: ${t.new} new · ${t.learning} learning · ${t.review} in long-term review.`),
    h('h2', {}, 'Reviews per day, last 30 days'),
    bars(s.activity, (r) => r.reviews, (r) => `${dayLabel(r.day)}: ${r.reviews} reviews${r.reviews ? `, ${Math.round((r.correct / r.reviews) * 100)}% recalled` : ''}`),
    h('h2', {}, 'Cards coming due, next 14 days'),
    bars(s.forecast, (r) => r.due, (r) => `${dayLabel(r.day)}: ${r.due} due`),
    h('h2', {}, 'What your characters are made of'), tabs, partBox,
    h('h2', {}, 'Cards by difficulty'),
    s.cards.length ? h('table', {}, h('tr', {}, ['Card', 'Direction', 'Attempts', 'Forgot', 'Avg. time', 'Stability'].map((x) => h('th', {}, x))),
      s.cards.slice(0, 25).map((c) => h('tr', {},
        h('td', { class: 'zh' }, h('a', { href: '#/note/' + c.note_id }, c.hanzi)), h('td', {}, c.direction === 'zh2en' ? '中 → EN' : 'EN → 中'),
        h('td', {}, c.attempts), h('td', {}, c.failures), h('td', {}, (c.avg_ms / 1000).toFixed(1) + ' s'), h('td', {}, c.stability ? c.stability.toFixed(1) + ' d' : '—'))))
      : h('p', { class: 'muted' }, 'Appears after your first reviews.'),
    h('h2', {}, 'HSK words in your deck'),
    h('table', {}, h('tr', {}, ['Level', 'In your deck', 'Words at this level'].map((x) => h('th', {}, x))),
      s.hsk.map((r) => h('tr', {}, h('td', {}, r.level === 7 ? '7–9' : r.level), h('td', {}, r.known), h('td', {}, r.total)))));
}

// ---------------------------------------------------------------- settings
async function settingsView() {
  const s = (await api('GET', '/state')).settings;
  const save = async (patch) => { Object.assign(settings, await api('PUT', '/settings', patch)); toast('Saved'); };
  const check = (key, label) => h('label', { style: 'display:flex; gap:8px; align-items:center; color:var(--ink); font-size:15px' },
    h('input', { type: 'checkbox', checked: s[key], onchange: (e) => save({ [key]: e.target.checked }) }), label);
  fill(app, 
    h('h1', {}, 'Settings'),
    h('label', {}, 'New cards per day'),
    h('input', { type: 'number', min: 0, max: 200, value: s.newPerDay, onchange: (e) => save({ newPerDay: Math.max(0, Math.round(+e.target.value) || 0) }) }),
    h('label', {}, 'Directions to study'),
    h('select', { onchange: (e) => save({ directions: e.target.value }) },
      [['both', 'Both directions'], ['zh2en', 'Chinese → English only'], ['en2zh', 'English → Chinese only']].map(([v, l]) => h('option', { value: v, selected: s.directions === v }, l))),
    h('label', {}, 'Target recall when a card comes due'),
    h('select', { onchange: (e) => save({ retention: +e.target.value }) },
      [[0.85, '85% — fewer reviews'], [0.9, '90% — balanced'], [0.95, '95% — more reviews']].map(([v, l]) => h('option', { value: v, selected: s.retention === v }, l))),
    h('div', { style: 'height:16px' }),
    check('toneColors', 'Colour characters and pinyin by tone'),
    check('showPinyinOnFront', 'Show pinyin on the question side of Chinese → English cards'),
    h('h2', {}, 'Tone colours'),
    h('p', { class: 'zh tones', style: 'font-size:20px' }, [['mā', 1], ['má', 2], ['mǎ', 3], ['mà', 4], ['ma', 5]].map(([p, t]) => h('span', { class: 't' + t, style: 'margin-right:16px' }, p))));
}

// ---------------------------------------------------------------- router
const views = { review: reviewView, cards: cardsView, add: addView, discover: discoverView, stats: statsView, settings: settingsView };
async function route() {
  const [pathPart, query = ''] = location.hash.replace(/^#\/?/, '').split('?');
  const [name = 'review', arg] = pathPart.split('/');
  keyHandler = null; closePanel(); app.className = '';
  document.querySelectorAll('#nav a').forEach((a) => a.classList.toggle('active', a.getAttribute('href') === '#/' + (name === 'note' ? 'cards' : name || 'review')));
  try {
    const st = await api('GET', '/state');
    settings = { ...st.settings, ai: st.ai };
    if (name === 'note') await noteView(arg);
    else await (views[name] || reviewView)(new URLSearchParams(query));
  } catch (e) {
    fill(app, h('p', {}, 'Something went wrong: ' + e.message));
    console.error(e);
  }
  scrollTo(0, 0);
}
addEventListener('hashchange', route);
route();
