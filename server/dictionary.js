import { readFileSync } from 'node:fs';

/**
 * Load a plain newline-separated Scrabble word list.
 * The bundled list is NWL2023 (North American Scrabble, 2023 edition).
 */
export function loadDictionary(filePath) {
  const text = readFileSync(filePath, 'utf8');
  const words = new Set();
  for (const line of text.split(/\r?\n/)) {
    const word = line.trim().toUpperCase();
    if (/^[A-Z]{2,21}$/.test(word)) words.add(word);
  }
  if (words.size === 0) {
    throw new Error(`Dictionary at ${filePath} is empty or unreadable.`);
  }
  return words;
}
