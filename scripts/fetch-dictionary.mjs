import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// NWL2023 is the current North American Scrabble tournament word list.
// The source file contains one entry per line: WORD definition...
// We keep only the headwords, because the game never needs definitions.
const SOURCE_URL =
  process.env.NWL_SOURCE_URL ??
  'https://raw.githubusercontent.com/scrabblewords/scrabblewords/main/words/North-American/NWL2023.txt';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'data', 'scrabble-words.txt');

console.log(`Downloading NWL2023 from:\n  ${SOURCE_URL}`);
const response = await fetch(SOURCE_URL);
if (!response.ok) {
  throw new Error(`Download failed with HTTP ${response.status}`);
}

const text = await response.text();
const words = new Set();
for (const line of text.split(/\r?\n/)) {
  const headword = line.trim().split(/\s+/, 1)[0]?.toUpperCase();
  if (headword && /^[A-Z]{2,21}$/.test(headword)) words.add(headword);
}

if (words.size < 100000) {
  throw new Error(`Only parsed ${words.size} words — that looks wrong.`);
}

await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, `${[...words].sort().join('\n')}\n`, 'utf8');

console.log(`Wrote ${words.size.toLocaleString()} words to ${output}`);
