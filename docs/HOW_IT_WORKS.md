# How Mandarinmaxxing works

This guide is for reading alongside the code. It assumes you can program but are new to JavaScript, web servers and databases. Each section says what a piece does, where it lives, and why it was built that way.

## 1. The big picture

The app is three things:

```
 Browser (public/)            Server (server.js + lib/)            Files (data/)
┌────────────────────┐  HTTP  ┌──────────────────────────┐  SQL  ┌───────────────┐
│ index.html         │ ─────▶ │ routes: /api/...         │ ────▶ │ user.db       │
│ style.css          │  JSON  │ lib/scheduler, hanzi,    │       │ reference.db  │
│ app.js             │ ◀───── │ stats, suggest, claude   │ ◀──── │               │
└────────────────────┘        └──────────────────────────┘       └───────────────┘
                                          │ HTTPS (optional)
                                          ▼
                                     Claude API
```

- The **browser** only draws things and reacts to clicks and keys. It holds no data of its own.
- The **server** is a Node.js program on your Mac. It answers requests such as "give me the next card" with JSON (a text format for structured data).
- The **database** is two files on disk. All knowledge and all memory of what you have studied is there.

When you press `3` (Good) on a card, this happens:

1. `public/app.js` sends `POST /api/review/answer` with `{ cardId, rating: 3 }`.
2. `server.js` finds the matching route and calls `answer()` in `lib/scheduler.js`.
3. `answer()` reads the card row from SQLite, asks `lib/fsrs.js` for the new schedule, writes the updated card and a row in the review log.
4. The browser asks `GET /api/review/next` and draws the next card.

**Why this shape.** A browser UI needs no installation and is easy to restyle. A local server is needed because a web page cannot read files on your disk or keep an API key secret. Everything runs on `127.0.0.1`, which means only this Mac can reach it.

**Why so few dependencies.** Node 26 ships with an HTTP server, SQLite and a test runner. The only installed package is the Anthropic SDK, and the app runs without it.

## 2. Files, in reading order

| File | Read it to understand |
|---|---|
| `lib/db.js` | The database tables and settings |
| `lib/fsrs.js` | The memory model behind spaced repetition |
| `lib/scheduler.js` | Which card comes next; recording answers; undo |
| `lib/hanzi.js` | Pinyin, splitting phrases into words, the breakdown tree |
| `lib/notes.js` | Creating and editing cards |
| `lib/stats.js` | Statistics |
| `lib/suggest.js` | Suggestions, offline and via Claude |
| `lib/claude.js` | All communication with the Claude API |
| `server.js` | The list of API routes; serving the pages |
| `public/app.js` | The whole user interface |
| `scripts/setup.js` | Building the reference database from downloads |
| `scripts/import-deck.js` | Importing a flashcard export |
| `scripts/polish.js` | One-off pinyin correction with Claude |
| `test/core.test.js` | Examples of how each piece is expected to behave |

A note on JavaScript modules: `import { x } from './file.js'` pulls a function out of another file, and `export function x` makes it available. That is the only mechanism connecting the files.

## 3. The database

SQLite is a database stored in a single file. You talk to it in SQL, a language for describing which rows you want. There is no database server to run.

You can look inside at any time:

```bash
sqlite3 data/user.db
sqlite> .tables
sqlite> SELECT hanzi, pinyin, english FROM notes LIMIT 5;
sqlite> .quit
```

### Two files

- `data/user.db` holds what you created. It is small and irreplaceable.
- `data/reference.db` holds dictionary data. It is large and can be rebuilt.

**Why split them.** Rebuilding or upgrading the dictionary can never damage your cards, and backing up means copying one small file. `db.js` opens `user.db` and *attaches* the other file under the name `ref`, so one query can use both (`ref.dict`, `ref.chars`, `ref.hsk`).

### Tables in user.db

| Table | One row is | Key columns |
|---|---|---|
| `notes` | A phrase you are learning | `hanzi`, `pinyin`, `english`, `notes`, `needs_check` |
| `cards` | One review direction of a note | `note_id`, `direction`, `state`, `due`, `stability`, `difficulty` |
| `reviews` | One time you answered a card | `card_id`, `ts`, `rating`, `mode`, `duration_ms`, `prev` |
| `suggestions` | A Claude suggestion, or a dismissed word | `hanzi`, `reason`, `status` |
| `ai_cache` | A stored Claude answer | `key`, `response` |
| `settings` | One setting | `key`, `value` |

**Why notes and cards are separate.** A phrase has one set of facts (characters, pinyin, meaning) but two things to remember: reading it (中 → EN) and producing it (EN → 中). You forget these at different rates, so each gets its own schedule. Editing the note fixes both cards at once. This is the same model Anki uses.

**Why a review log.** `reviews` is never needed to schedule the next review; `cards` already has the current state. It exists so statistics can be computed, so undo is possible (`prev` stores the card as it was before the answer), and so the scheduler's parameters could one day be tuned to your own memory.

**What is not stored.** There is no table of characters you know and no table of radical counts. Those are computed from `notes` each time (see section 6). With a few hundred cards this takes milliseconds, and stored copies could drift out of sync with the notes.

### Reading the SQL

Queries look like this one from `scheduler.js`:

```sql
SELECT c.*, n.hanzi, n.pinyin, n.english
FROM cards c JOIN notes n ON n.id = c.note_id
WHERE c.state = 2 AND c.due <= ?
ORDER BY c.due LIMIT 1
```

Read it as: take cards (`c`) together with the note each belongs to (`n`); keep those in review state that are due; return the earliest one. The `?` is filled in safely by the code (`.get(now)`), which avoids building SQL out of strings.

`tx(db, fn)` in `db.js` runs several writes as one *transaction*: either all of them happen or none do. `answer()` uses it so a card can never be updated without its log row.

## 4. Spaced repetition (`lib/fsrs.js`)

The idea: review something just before you would forget it, and each successful review lets you wait longer.

The app uses **FSRS**, the algorithm in current versions of Anki. It keeps two numbers per card:

- **Stability**: how many days until your chance of recalling the card falls to 90%. This number grows with each success.
- **Difficulty**: from 1 to 10, how hard this card is for you. Harder cards gain stability more slowly.

From stability, the chance of recall after `t` days follows a forgetting curve (`retrievability()`), and the next interval is the point where that curve crosses your target (90% by default, changeable in Settings).

What each button does to a card in long-term review:

| Button | Stability | Difficulty | Next step |
|---|---|---|---|
| Again | drops sharply | rises | back in 5 minutes, counted as a lapse |
| Hard | grows a little | rises slightly | shorter interval |
| Good | grows | unchanged | normal interval |
| Easy | grows a lot | falls | longer interval |

New cards first pass through short **learning steps** (1, 5, 10 minutes) so you see them a few times in the first session before they move to day-scale intervals.

`schedule(card, rating, now)` is a *pure function*: it takes a card and returns the new values without touching the database. That makes it easy to test (see the tests) and lets `preview()` call it four times to show the interval on each button.

**Why FSRS instead of the older SM-2.** SM-2 multiplies the interval by a fixed "ease" factor. FSRS models forgetting directly, handles late and early reviews properly, and has been measured to need fewer reviews for the same recall. The constants in `W` are published defaults fitted to a large number of learners.

### The queue (`lib/scheduler.js`)

`nextCard()` picks in this order:

1. Cards in a learning step that are due.
2. Review cards that are due, most overdue first.
3. A new card, if today's limit is not used up.
4. A learning card due within 20 minutes, so a session can finish.

Two details worth knowing:

- The study day starts at 04:00, so a late-night session counts for the day you started it.
- A new card is held back if the other direction of the same note was studied today. Otherwise seeing 中 → EN would give away EN → 中 a minute later.

## 5. Text: pinyin, words and the breakdown tree (`lib/hanzi.js`)

### Pinyin format

Pinyin is stored as one syllable per Chinese character, separated by spaces: `wǒ tóng yì`. This simple rule is what lets the interface line each syllable up above its character and colour both by tone. Latin letters and punctuation in a phrase are skipped.

### Splitting a phrase into words

Chinese has no spaces, so `segment()` finds words by **longest match**: at each position it tries the longest dictionary word starting there, then shorter ones, down to a single character.

This is simple and usually right, but it can take a character that belongs to the next word. `说中文` would split as `说中 | 文`. One extra rule handles the common case: a rare two-character match is rejected when its second character starts a common word (`中文`).

### Choosing a reading

Many characters have several readings (得 is `de`, `dé` or `děi`). Offline, the app uses the dictionary's reading for the word, a short table of grammar particles (`PARTICLES`), and otherwise the most common reading of the character. This is a guess. Claude does better because it reads the whole phrase, which is why the Add page offers "Draft with Claude" and why `scripts/polish.js` was run once over your imported deck.

### The breakdown tree

`breakdown(text)` returns a tree of plain objects:

```
phrase ─▶ words ─▶ characters ─▶ components ─▶ smaller components
```

The component data comes from Make Me a Hanzi, where each character has a decomposition such as `好 = ⿰女子`. The `⿰` symbols describe layout (left-right, top-bottom); `componentsOf()` drops them and keeps the parts.

Each node carries:

- `seen`: how many of your notes contain it. This drives the solid versus dashed outline.
- `inChars`: for a component, how many characters in your deck contain it.
- `role`: `radical`, `meaning` or `sound`, when the data says so. Most characters are a meaning part plus a sound part, and seeing that is the main payoff of breaking them down.

### "Why it is built this way"

The side panel shows a reminder sentence for any character or word. It has two sources:

- `offlineWhy()` builds a short sentence from the reference data alone: the recorded origin hint, or "X gives the meaning; Y gives the sound". It appears instantly and works offline.
- `explainWhy()` in `lib/claude.js` sends the same facts (`whyFacts()`) to Claude and gets a fuller sentence, which replaces the short one a moment later. The answer is cached, so each character is asked about once.

Claude is given the recorded etymology and told to keep history and memory tricks apart: when a part is only there for its sound, or the real origin is obscure, it has to say so. Without that instruction a model will happily invent a plausible story for every character.

**Why components stop where they do.** Decomposing all the way down ends in single strokes (二 into 一 and 一), which teaches nothing. A component is opened further only if one of its own parts is itself a compound.

**Why the tree is computed and not stored.** `deckIndex()` scans all notes once and builds lookup tables (character → notes, component → characters). Adding or deleting a card needs no bookkeeping: the next request simply sees the new deck.

## 6. Statistics (`lib/stats.js`)

Every number on the Stats page is derived on request:

- **Characters, radicals, components** come from walking the notes and their decompositions.
- **Activity, recall rate, time per card** come from the `reviews` log.
- **Forecast** counts cards by their `due` date.

The difference between the "Radicals" and "All components" tabs: a character has exactly one official radical (the one dictionaries file it under), but may contain several components at several depths.

## 7. Suggestions (`lib/suggest.js`)

Both kinds of suggestion follow one principle: a good next word is useful and close to what you already know, ideally with exactly one new character.

**Offline.** For every word in the HSK list, count how many of its characters are in your deck. Keep words with at most one unknown character, rank by how common the word is, and limit how many hang off the same known character so the list stays varied. Words already inside one of your phrases are skipped.

**Claude.** The server sends your deck (characters and meanings only) and asks for opposites, missing members of sets, same-topic words, and register variants, each tied to a specific card with a one-line reason. The reply is then checked by code: duplicates are dropped, pinyin with the wrong syllable count is replaced from the dictionary, and new characters are counted the same way as offline.

**Why both.** The dictionary knows which characters words share but not that 早安 is the counterpart of 晚安. Claude knows that, but needs a network and credits. The offline list is always there.

## 8. Claude (`lib/claude.js`)

All API use is in this one file, behind four functions: `draftCard`, `polishPinyin`, `suggestWords`, `explainWhy`.

Design rules it follows:

- **Optional.** Every function returns `{ ok: true, data }` or `{ ok: false, reason }` and never throws for expected problems (no key, no credits, offline). Callers fall back to the dictionary.
- **Structured output.** Each request includes a JSON schema, so the reply is guaranteed to be parseable data with the expected fields, not free text.
- **Cached.** Answers are stored in `ai_cache`, keyed by a hash of the question. Asking for the same phrase twice costs nothing. Suggestions are not cached, because asking again should produce new ideas.
- **The key stays on the server.** The browser never sees it. It is read from `.env`, which git ignores.

The model is a setting (`model` in `lib/db.js`, default `claude-opus-5-5`).

## 9. The server (`server.js`)

The `routes` array is the table of contents of the backend: each line is a method, a path and a function. Reading that array top to bottom tells you everything the app can do.

Around it is plumbing: parse the request body as JSON, match the path, call the function, send the result as JSON, and turn thrown errors into error responses. Errors created with a `status` (such as 404 or 409) are sent to the browser as messages; anything else is logged and reported as a generic failure.

## 10. The interface (`public/app.js`)

There is no framework. Three ideas carry the whole file:

1. **`h(tag, attributes, ...children)`** creates one HTML element. Nested calls build a page. Because text goes in as text and never as HTML, content from your cards cannot break the page.
2. **A view is a function** that fetches data and fills `<main id="app">`. When something changes, the view draws itself again from scratch. That is wasteful in theory and unnoticeable at this size, and it means there is never stale UI to track down.
3. **The router** reads the part of the URL after `#` (`#/stats`, `#/note/12`) and calls the matching view. Browser back and forward work for free.

Styling is in `public/style.css`. Colours are variables at the top of the file, with a second set for dark mode, so restyling means editing a dozen lines.

## 11. How to change things

| I want to… | Start here |
|---|---|
| Change colours, sizes, spacing | `public/style.css`, variables at the top |
| Change what a card shows | `reviewView()` in `public/app.js` |
| Change learning steps or intervals | `STEPS` and `schedule()` in `lib/fsrs.js` |
| Change the order cards appear | `nextCard()` in `lib/scheduler.js` |
| Fix a wrong reading for a particle | `PARTICLES` in `lib/hanzi.js` |
| Change what Claude is asked | The `system` texts in `lib/claude.js` |
| Change how offline suggestions are ranked | `offlineSuggestions()` in `lib/suggest.js` |
| Add a statistic | Compute it in `lib/stats.js`, draw it in `statsView()` |
| Add a field to cards | Add the column in `lib/db.js`, then `lib/notes.js`, then the forms in `app.js` |
| Add a new page | A view function in `app.js`, an entry in `views`, a link in `index.html` |

Adding a column to an existing database needs one manual step, because `CREATE TABLE IF NOT EXISTS` does not alter a table that already exists:

```bash
sqlite3 data/user.db "ALTER TABLE notes ADD COLUMN example TEXT NOT NULL DEFAULT ''"
```

## 12. Debugging

- **Server errors** print in the terminal where `npm start` is running.
- **Browser errors** show in Safari under Develop → Show JavaScript Console (enable the Develop menu in Safari's Advanced settings).
- **See what the server returns** by opening an API address directly, for example <http://localhost:4747/api/stats>.
- **Inspect the data** with `sqlite3 data/user.db`.
- **Check you broke nothing** with `npm test`. The tests run against a temporary copy and never touch your cards.
- **After editing server code**, stop and restart `npm start`. Changes to files in `public/` only need a page reload.
