// Builds data/reference.db from three open datasets (downloaded into data/raw/ on first run):
//   CC-CEDICT        dictionary: word -> pinyin + English definitions
//   Make Me a Hanzi  per-character decomposition, radical and etymology
//   complete-hsk     HSK word list with level and frequency rank (used for suggestions)
// Safe to re-run: it only rebuilds reference data and never touches data/user.db.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import path from 'node:path';
import { openDb, tx, DATA_DIR } from '../lib/db.js';

const RAW = path.join(DATA_DIR, 'raw');
const SOURCES = {
  'cedict.txt.gz': 'https://www.mdbg.net/chinese/export/cedict/cedict_1_0_ts_utf-8_mdbg.txt.gz',
  'makemeahanzi.txt': 'https://raw.githubusercontent.com/skishore/makemeahanzi/master/dictionary.txt',
  'hsk.json': 'https://raw.githubusercontent.com/drkameleon/complete-hsk-vocabulary/main/complete.json',
};

mkdirSync(RAW, { recursive: true });
for (const [file, url] of Object.entries(SOURCES)) {
  const dest = path.join(RAW, file);
  if (existsSync(dest)) continue;
  console.log(`downloading ${file} …`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed (${res.status}) for ${url}`);
  writeFileSync(dest, Buffer.from(await res.arrayBuffer()));
}

const db = openDb();
tx(db, () => {
  db.exec('DELETE FROM ref.dict; DELETE FROM ref.chars; DELETE FROM ref.hsk;');

  // CC-CEDICT line format:  繁體 简体 [pin1 yin1] /definition 1/definition 2/
  const cedict = gunzipSync(readFileSync(path.join(RAW, 'cedict.txt.gz'))).toString('utf8');
  const insDict = db.prepare('INSERT INTO ref.dict(simp, trad, pinyin, defs) VALUES(?, ?, ?, ?)');
  let n = 0;
  for (const line of cedict.split('\n')) {
    const m = /^(\S+) (\S+) \[([^\]]*)\] \/(.*)\/\s*$/.exec(line);
    if (!m) continue;
    insDict.run(m[2], m[1], m[3], m[4]); n++;
  }
  console.log(`dictionary entries: ${n}`);

  // Make Me a Hanzi: one JSON object per line.
  const insChar = db.prepare('INSERT OR REPLACE INTO ref.chars VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)');
  n = 0;
  for (const line of readFileSync(path.join(RAW, 'makemeahanzi.txt'), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    const c = JSON.parse(line), e = c.etymology || {};
    insChar.run(c.character, c.definition ?? null, (c.pinyin || []).join(','), c.decomposition ?? null, c.radical ?? null,
      e.type ?? null, e.hint ?? null, e.semantic ?? null, e.phonetic ?? null);
    n++;
  }
  console.log(`characters: ${n}`);

  // HSK list. level: prefer the current standard ("new-N", where 7 means bands 7-9).
  const insHsk = db.prepare('INSERT OR REPLACE INTO ref.hsk VALUES(?, ?, ?, ?, ?)');
  n = 0;
  for (const w of JSON.parse(readFileSync(path.join(RAW, 'hsk.json'), 'utf8'))) {
    const lv = (prefix) => { const l = w.level.find((x) => x.startsWith(prefix + '-')); return l ? +l.split('-')[1] : null; };
    const f = w.forms?.[0];
    insHsk.run(w.simplified, lv('new') ?? lv('newest') ?? lv('old'), w.frequency ?? null,
      f?.transcriptions?.pinyin ?? '', (f?.meanings || []).slice(0, 3).join('; '));
    n++;
  }
  console.log(`HSK words: ${n}`);
});
console.log('reference data ready → data/reference.db');
