# Mandarinmaxxing

A personal Mandarin flashcard app: spaced repetition, character breakdowns, statistics and suggestions for what to learn next. It runs entirely on this Mac.

## Use it

```bash
npm start
```

Then open <http://localhost:4747>. Stop it with `Ctrl+C` in the terminal.

| Page | What it is for |
|---|---|
| **Review** | Study the cards that are due. `Space` flips, `1`–`4` grade, `u` undoes, `t` switches typing mode, `b` shows the breakdown. |
| **Cards** | Search, open and edit everything in your deck. |
| **Add** | Type a phrase; see its breakdown and which parts you already know; save it as a card. |
| **Discover** | Suggestions: semantic ones from Claude, and offline ones built from characters you know. |
| **Stats** | Review activity, radicals and components across your deck, hardest cards. |
| **Settings** | New cards per day, directions, target recall, tone colours. |

## First-time setup (already done on this Mac)

```bash
npm install                                   # one package: the Anthropic SDK
npm run setup                                 # downloads dictionary data, builds data/reference.db
npm run import -- "/path/to/deck.zip"         # imports a flashcard export
```

Claude features read `ANTHROPIC_API_KEY` from `.env`. Without a key, or without credits or a network connection, the app keeps working and falls back to the dictionary.

## Your data

Everything you create lives in `data/user.db`. To back up, copy that file while the app is stopped. `data/reference.db` and `data/raw/` can always be rebuilt with `npm run setup`.

## Learn how it works

See [docs/HOW_IT_WORKS.md](docs/HOW_IT_WORKS.md) for a guided tour of the code and the reasons behind the design.

## Data sources

- [CC-CEDICT](https://www.mdbg.net/chinese/dictionary?page=cc-cedict) (CC BY-SA 4.0): dictionary
- [Make Me a Hanzi](https://github.com/skishore/makemeahanzi) (LGPL / Arphic PL): character decomposition and etymology
- [complete-hsk-vocabulary](https://github.com/drkameleon/complete-hsk-vocabulary) (MIT): HSK levels and word frequency
