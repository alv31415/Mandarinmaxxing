// The whole backend: a small HTTP server that serves the pages in public/ and a JSON API under /api.
// Run with `npm start`, then open http://localhost:4747
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { openDb, getSettings, setSettings, ROOT } from './lib/db.js';
import { createNote, updateNote, deleteNote, getNote, listNotes } from './lib/notes.js';
import { nextCard, answer, undo, counts, nextDue } from './lib/scheduler.js';
import { breakdown, charDetail, autoPinyin, autoEnglish, deckIndex, hanChars, whyFacts, offlineWhy } from './lib/hanzi.js';
import { stats } from './lib/stats.js';
import { offlineSuggestions, storedSuggestions, claudeSuggestions, dismissSuggestion } from './lib/suggest.js';
import { draftCard, explainWhy, aiConfigured } from './lib/claude.js';

const PORT = Number(process.env.PORT) || 4747;
const PUBLIC = path.join(ROOT, 'public');
const db = openDb();

const fail = (status, message) => Object.assign(new Error(message), { status });
const id = (s) => { const n = Number(s); if (!Number.isInteger(n)) throw fail(400, 'bad id'); return n; };

// Each route: [METHOD, /path/with/:params, handler({ params, query, body }) -> JSON-able value]
const routes = [
  ['GET', '/api/state', () => ({ counts: counts(), nextDue: nextDue(), settings: getSettings(), ai: aiConfigured(), notes: db.prepare('SELECT COUNT(*) n FROM notes').get().n })],
  ['PUT', '/api/settings', ({ body }) => setSettings(body)],

  ['GET', '/api/review/next', () => ({ card: nextCard(), counts: counts(), nextDue: nextDue() })],
  ['POST', '/api/review/answer', ({ body }) => { answer(id(body.cardId), body.rating, { mode: body.mode === 'type' ? 'type' : 'flip', durationMs: Number(body.durationMs) || null }); return { ok: true }; }],
  ['POST', '/api/review/undo', () => ({ cardId: undo() })],

  ['GET', '/api/notes', ({ query }) => listNotes(query.get('q') || '')],
  ['POST', '/api/notes', ({ body }) => getNote(createNote(body))],
  ['GET', '/api/notes/:id', ({ params }) => {
    const note = getNote(id(params.id));
    if (!note) throw fail(404, 'No such card.');
    return { note, tree: breakdown(note.hanzi) };
  }],
  ['PUT', '/api/notes/:id', ({ params, body }) => updateNote(id(params.id), body)],
  ['DELETE', '/api/notes/:id', ({ params }) => { deleteNote(id(params.id)); return { ok: true }; }],

  ['GET', '/api/breakdown', ({ query }) => {
    const text = (query.get('text') || '').trim();
    if (!hanChars(text).length) throw fail(400, 'Type some Chinese characters.');
    return { text, tree: breakdown(text), pinyin: autoPinyin(text), ...autoEnglish(text), noteId: deckIndex().exact.get(hanChars(text).join('')) ?? null };
  }],
  ['GET', '/api/char/:ch', ({ params }) => charDetail(params.ch)],
  // "Why is it built like this?" — dictionary sentence straight away, Claude's fuller one when available.
  ['GET', '/api/why', async ({ query }) => {
    const text = hanChars(query.get('text') || '').join('');
    if (!text) throw fail(400, 'Nothing to explain.');
    const offline = offlineWhy(text);
    const res = await explainWhy(whyFacts(text));
    return res.ok && res.data.why.trim() ? { why: res.data.why.trim(), source: 'claude' } : { why: offline, source: 'dictionary', aiError: res.reason };
  }],
  ['POST', '/api/draft', async ({ body }) => {
    const hanzi = String(body.hanzi || '').trim();
    if (!hanChars(hanzi).length) throw fail(400, 'Type some Chinese characters.');
    const offline = { pinyin: autoPinyin(hanzi), ...autoEnglish(hanzi), literal: '', note: '', source: 'dictionary' };
    if (body.ai === false) return offline;
    const res = await draftCard(hanzi);
    if (!res.ok) return { ...offline, aiError: res.reason };
    const py = res.data.pinyin.trim().toLowerCase();
    return { ...res.data, pinyin: py.split(/\s+/).length === hanChars(hanzi).length ? py : offline.pinyin, source: 'claude' };
  }],

  ['GET', '/api/stats', () => stats()],

  ['GET', '/api/suggestions', () => ({ claude: storedSuggestions(), offline: offlineSuggestions(), ai: aiConfigured() })],
  ['POST', '/api/suggestions/generate', async ({ body }) => claudeSuggestions({ focusNoteId: body.noteId ? id(body.noteId) : null })],
  ['POST', '/api/suggestions/dismiss', ({ body }) => { dismissSuggestion(String(body.hanzi)); return { ok: true }; }],
];

const compiled = routes.map(([method, pattern, handler]) => ({
  method, handler,
  regex: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'),
}));

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 1e6) throw fail(413, 'too large'); chunks.push(c); }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw fail(400, 'invalid JSON'); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const send = (status, body, type = 'application/json; charset=utf-8') => {
    res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(type.startsWith('application/json') ? JSON.stringify(body) : body);
  };
  try {
    if (url.pathname.startsWith('/api/')) {
      // Only the pages this server serves may call the API (blocks other websites open in your browser).
      const origin = req.headers.origin;
      if (origin && new URL(origin).host !== req.headers.host) throw fail(403, 'forbidden');
      const pathname = decodeURIComponent(url.pathname);
      for (const r of compiled) {
        const m = r.method === req.method && r.regex.exec(pathname);
        if (!m) continue;
        const body = req.method === 'GET' ? {} : await readBody(req);
        return send(200, await r.handler({ params: m.groups || {}, query: url.searchParams, body }));
      }
      throw fail(404, 'not found');
    }
    // static files; anything else gets the app shell
    let file = path.normalize(path.join(PUBLIC, url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname)));
    if (!file.startsWith(PUBLIC + path.sep)) throw fail(403, 'forbidden');
    const data = await readFile(file).catch(() => null);
    if (data) return send(200, data, MIME[path.extname(file)] || 'application/octet-stream');
    throw fail(404, 'not found');
  } catch (e) {
    if (!e.status) console.error(e);
    send(e.status || 500, { error: e.status ? e.message : 'Something went wrong on the server.', noteId: e.noteId });
  }
});

// 127.0.0.1 = reachable from this Mac only.
server.listen(PORT, '127.0.0.1', () => console.log(`Mandarinmaxxing → http://localhost:${PORT}`));
