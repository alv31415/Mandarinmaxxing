// Imports a flashcard export (.zip containing a <deck> XML, or the .xml itself) into your notes.
// Usage: npm run import -- "/path/to/deck.zip"
// Existing notes are left alone, so it is safe to re-run.
import { readFileSync } from 'node:fs';
import { inflateRawSync } from 'node:zlib';
import { openDb } from '../lib/db.js';
import { createNote } from '../lib/notes.js';

const file = process.argv[2];
if (!file) { console.error('usage: npm run import -- <deck.zip | deck.xml>'); process.exit(1); }

/** Minimal zip reader: returns the bytes of the first file in the archive. */
function firstZipEntry(buf) {
  if (buf.readUInt32LE(0) !== 0x04034b50) return buf; // not a zip: assume raw xml
  const method = buf.readUInt16LE(8);
  const nameLen = buf.readUInt16LE(26), extraLen = buf.readUInt16LE(28);
  // sizes come from the central directory, which is reliable even when the local header leaves them blank
  const cd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  const compSize = buf.readUInt32LE(cd + 20);
  const start = 30 + nameLen + extraLen;
  const data = buf.subarray(start, start + compSize);
  return method === 0 ? data : inflateRawSync(data);
}

const unescapeXml = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&amp;/g, '&');

const xml = firstZipEntry(readFileSync(file)).toString('utf8');
const db = openDb();
let added = 0, skipped = 0, blank = 0;
for (const m of xml.matchAll(/<card>\s*<chinese[^>]*>([\s\S]*?)<\/chinese>\s*<text[^>]*>([\s\S]*?)<\/text>\s*<\/card>/g)) {
  const hanzi = unescapeXml(m[1]).trim(), english = unescapeXml(m[2]).trim().replace(/\s+/g, ' ');
  try {
    createNote({ hanzi, english, source: 'import', needsCheck: english ? 0 : 1 }, db);
    added++; if (!english) blank++;
  } catch (e) { if (e.status === 409 || e.status === 400) skipped++; else throw e; }
}
console.log(`imported ${added} notes (${blank} had no translation and were auto-filled; flagged to check), skipped ${skipped}`);
