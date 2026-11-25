// Optional Claude features: drafting translations/pinyin and semantic suggestions.
// Everything here is a bonus layer — if there is no API key, no network, or no credits,
// callers get { ok: false, reason } and fall back to the offline dictionary logic.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import path from 'node:path';
import { openDb, getSettings, ROOT } from './db.js';

const envFile = path.join(ROOT, '.env');
// The project's .env wins over any ANTHROPIC_API_KEY already exported in the shell, so the app
// always uses the key that was set up for it.
if (existsSync(envFile)) {
  const fromFile = parseEnv(readFileSync(envFile, 'utf8')).ANTHROPIC_API_KEY;
  if (fromFile) process.env.ANTHROPIC_API_KEY = fromFile;
}

let _client, _sdk;
async function client() {
  if (_client) return _client;
  if (!process.env.ANTHROPIC_API_KEY) return null;
  try { _sdk = (await import('@anthropic-ai/sdk')).default; } catch { return null; } // SDK not installed
  _client = new _sdk({ maxRetries: 1, timeout: 90_000 });
  return _client;
}
export const aiConfigured = () => Boolean(process.env.ANTHROPIC_API_KEY);

const cacheKey = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/**
 * Ask Claude for JSON matching `schema`. Results are cached in SQLite so the same question is
 * never paid for twice. Returns { ok: true, data } or { ok: false, reason }.
 */
async function askJson({ kind, system, user, schema, effort = 'low', cache = true }) {
  const db = openDb();
  const model = getSettings(db).model;
  const key = cacheKey(kind, model, system, user);
  if (cache) {
    const hit = db.prepare('SELECT response FROM ai_cache WHERE key = ?').get(key);
    if (hit) return { ok: true, data: JSON.parse(hit.response), cached: true };
  }
  const c = await client();
  if (!c) return { ok: false, reason: 'Claude is not set up (no API key in .env).' };
  try {
    const res = await c.beta.messages.create({
      model,
      max_tokens: 16000,
      system,
      messages: [{ role: 'user', content: user }],
      output_config: { effort, format: { type: 'json_schema', schema } },
      // If a safety classifier declines a request, let the API retry it on a fallback model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    if (res.stop_reason === 'refusal') return { ok: false, reason: 'Claude declined this request.' };
    if (res.stop_reason === 'max_tokens') return { ok: false, reason: 'Claude ran out of room before finishing.' };
    const text = res.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    const data = JSON.parse(text);
    db.prepare('INSERT OR REPLACE INTO ai_cache(key, response, created_at) VALUES(?, ?, ?)').run(key, JSON.stringify(data), Date.now());
    return { ok: true, data };
  } catch (e) {
    const A = _sdk;
    if (A && e instanceof A.AuthenticationError) return { ok: false, reason: 'The API key was rejected.' };
    if (A && e instanceof A.RateLimitError) return { ok: false, reason: 'Rate limited — try again in a moment.' };
    if (A && e instanceof A.BadRequestError && /credit balance/i.test(e.message)) return { ok: false, reason: 'No API credits left this month.' };
    if (A && e instanceof A.APIConnectionError) return { ok: false, reason: 'Could not reach the Claude API (offline?).' };
    if (A && e instanceof A.APIError) return { ok: false, reason: `Claude API error ${e.status ?? ''}: ${e.message}`.trim() };
    if (e instanceof SyntaxError) return { ok: false, reason: 'Claude returned something unreadable.' };
    throw e;
  }
}

const PINYIN_RULES = `Pinyin format: lowercase, tone marks (not numbers), exactly one syllable per Chinese character, syllables separated by single spaces, no punctuation. Use the reading that is correct in this context, with neutral tones where they are actually spoken (吧 ba, 喜欢 xǐ huan, 的 de). Do not apply tone sandhi (write 你好 as nǐ hǎo, 不是 as bù shì). Skip Latin letters, digits and punctuation in the Chinese text.`;

const STR = { type: 'string' };
const obj = (properties) => ({ type: 'object', properties, required: Object.keys(properties), additionalProperties: false });

/** Translation + pinyin for a phrase the learner just typed in. */
export function draftCard(hanzi) {
  return askJson({
    kind: 'draft',
    system: `You help an English-speaking learner of Mandarin write flashcards for phrases picked up in conversation with Chinese friends; many are colloquial, slang or internet speak. Given a Chinese phrase, return its pinyin and a natural English translation as a native speaker would mean it.\n\n${PINYIN_RULES}\n\n"english": short and natural, flashcard-sized. "literal": a word-for-word gloss only when it differs from the natural translation in a way that helps memory (like 没关系 → "no relation"), otherwise an empty string. "note": one short sentence on register or usage only if a learner would otherwise misuse it (vulgar, regional, internet slang, a pun), otherwise an empty string.`,
    user: hanzi,
    schema: obj({ pinyin: STR, english: STR, literal: STR, note: STR }),
  });
}

/** Context-aware pinyin for many notes at once (used after an import). */
export function polishPinyin(notes) {
  return askJson({
    kind: 'polish',
    system: `You are correcting machine-generated pinyin on a Mandarin learner's flashcards. For each card return the correct pinyin, and an English translation only when the given one is empty or marked as a guess.\n\n${PINYIN_RULES}\n\nReturn one item per input card, with the same id.`,
    user: JSON.stringify(notes),
    schema: obj({ cards: { type: 'array', items: obj({ id: { type: 'integer' }, pinyin: STR, english: STR }) } }),
    effort: 'medium',
  });
}

/** Semantic suggestions: opposites, sets, related slang, words built from known characters. */
export function suggestWords({ deck, exclude, focus, count = 12 }) {
  return askJson({
    kind: 'suggest',
    cache: false, // asking again should give new ideas
    system: `You suggest what a Mandarin learner should learn next. They learn informally, from conversations with Chinese friends, and collect phrases as flashcards — everyday words, food, slang, jokes, internet speak. You will get their whole deck.

Suggest ${count} new words or short phrases that connect to what they already know, because connected vocabulary sticks. Good connections:
- "opposite": the natural counterpart of something they know (小 → 大, 便宜 → 贵)
- "set": the missing members of a set they have started (school levels, colours, family members, fruit, days)
- "same-topic": a word they would need in the same conversation as one they know
- "same-character": a common word reusing a character they know, showing that character in a new light
- "register": a politer, ruder, more formal or more current way to say something they know

Favour things real people say in conversation today over textbook vocabulary, and match the register of their deck. Prefer suggestions where most characters are already known to them. Spread suggestions across different parts of the deck instead of clustering on one card. Never suggest anything already in the deck or in the excluded list.${focus ? '\n\nThe learner asked specifically for suggestions related to one card; make every suggestion connect to that card.' : ''}

For each suggestion: "hanzi" in simplified characters with no punctuation; "related_to" must be copied exactly from the deck; "reason" is one short sentence addressed to the learner explaining the link.

${PINYIN_RULES}`,
    user: JSON.stringify({ deck, excluded: exclude, ...(focus ? { focus } : {}) }),
    schema: obj({
      suggestions: {
        type: 'array',
        items: obj({ hanzi: STR, pinyin: STR, english: STR, relation: { type: 'string', enum: ['opposite', 'set', 'same-topic', 'same-character', 'register'] }, related_to: STR, reason: STR }),
      },
    }),
    effort: 'medium',
  });
}
