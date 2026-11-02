import { randomBytes } from 'node:crypto';

/**
 * Standard Scrabble tile distribution (100 tiles, no blanks).
 * The two blank tiles are intentionally omitted: in a typing game they add
 * more UI complexity than fun.
 */
export const TILE_DISTRIBUTION = Object.freeze({
  A: 9,
  B: 2,
  C: 2,
  D: 4,
  E: 12,
  F: 2,
  G: 3,
  H: 2,
  I: 9,
  J: 1,
  K: 1,
  L: 4,
  M: 2,
  N: 6,
  O: 8,
  P: 2,
  Q: 1,
  R: 6,
  S: 4,
  T: 6,
  U: 4,
  V: 2,
  W: 2,
  X: 1,
  Y: 2,
  Z: 1,
});

export const PLAYER_COLORS = Object.freeze([
  '#ff7a59',
  '#3dd6c4',
  '#ffd166',
  '#b69cff',
  '#8bd450',
  '#ff8fb1',
  '#6fb3ff',
  '#ffa94d',
]);

export const MIN_WORD_LENGTH = 3;
export const MAX_WORD_LENGTH = 7;
export const DEFAULT_MIN_WORD_LENGTH = 4;

/**
 * Scoring starts after this many letters. With the default of 3, CATS is worth
 * 1 point and ACTOR is worth 2. The host can change it, because some tables
 * prefer every letter to count.
 */
export const MIN_FREE_LETTERS = 0;
export const MAX_FREE_LETTERS = 6;
export const DEFAULT_FREE_LETTERS = 3;

const MAX_NAME_LENGTH = 18;
const MAX_WORD_INPUT = 32;
const LOG_LIMIT = 60;

export function sanitizeName(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_NAME_LENGTH);
}

export function clampMinWordLength(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_MIN_WORD_LENGTH;
  return Math.min(MAX_WORD_LENGTH, Math.max(MIN_WORD_LENGTH, parsed));
}

export function clampFreeLetters(value) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed)) return DEFAULT_FREE_LETTERS;
  return Math.min(MAX_FREE_LETTERS, Math.max(MIN_FREE_LETTERS, parsed));
}

export function describeScoring(freeLetters) {
  return freeLetters <= 0
    ? 'every letter scores 1 point'
    : `letters after the first ${freeLetters} score 1 point each`;
}

export function letterCounts(word) {
  const counts = Object.create(null);
  for (const letter of word) counts[letter] = (counts[letter] || 0) + 1;
  return counts;
}

export function buildTileLetters(distribution = TILE_DISTRIBUTION) {
  const letters = [];
  for (const [letter, count] of Object.entries(distribution)) {
    for (let i = 0; i < count; i += 1) letters.push(letter);
  }
  return letters;
}

function shuffle(items, random = Math.random) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
  return items;
}

function subtractCounts(a, b) {
  const result = Object.create(null);
  for (const [letter, count] of Object.entries(a)) {
    const remaining = count - (b[letter] || 0);
    if (remaining > 0) result[letter] = remaining;
  }
  return result;
}

function countTotal(counts) {
  return Object.values(counts).reduce((sum, n) => sum + n, 0);
}

function missingLetters(required, available) {
  const missing = [];
  for (const [letter, count] of Object.entries(required)) {
    const shortfall = count - (available[letter] || 0);
    for (let i = 0; i < shortfall; i += 1) missing.push(letter);
  }
  return missing;
}

function describeMissing(letters) {
  const counts = letterCounts(letters);
  return Object.entries(counts)
    .map(([letter, count]) => (count > 1 ? `${count}x${letter}` : letter))
    .join(', ');
}

function publicWord(word, freeLetters = DEFAULT_FREE_LETTERS) {
  return {
    id: word.id,
    word: word.word,
    length: word.word.length,
    points: Math.max(0, word.word.length - freeLetters),
    at: word.at,
    stolenFrom: word.stolenFrom ?? null,
    previous: word.previous ?? null,
    selfStolen: word.selfStolen ?? false,
  };
}

function fail(error) {
  return { ok: false, error };
}

/**
 * The authoritative game. It knows nothing about sockets or HTTP, which makes
 * the rules straightforward to test. All mutations happen synchronously, so two
 * simultaneous word claims are resolved in the order Node handles them.
 */
export class AnagramsGame {
  constructor({
    dictionary,
    dictionaryName = 'NWL2023',
    minWordLength = DEFAULT_MIN_WORD_LENGTH,
    freeLetters = DEFAULT_FREE_LETTERS,
    tileLetters = null,
    shuffleTiles = true,
    random = Math.random,
  } = {}) {
    const dict = dictionary instanceof Set ? dictionary : new Set(dictionary ?? []);
    if (dict.size === 0) throw new Error('A dictionary is required.');

    const letters = tileLetters ? [...tileLetters] : buildTileLetters();
    if (letters.length === 0) throw new Error('At least one tile is required.');
    for (const letter of letters) {
      if (typeof letter !== 'string' || !/^[A-Z]$/.test(letter)) {
        throw new Error(`Invalid tile letter: ${letter}`);
      }
    }

    this.dictionary = dict;
    this.dictionaryName = dictionaryName;
    this.minWordLength = clampMinWordLength(minWordLength);
    this.freeLetters = clampFreeLetters(freeLetters);
    this.initialTileLetters = letters;
    this.shuffleTiles = shuffleTiles;
    this.random = random;

    this.players = new Map();
    /** Face-down tiles, still in the bagel. Their letters are secret. */
    this.bag = [];
    /** Face-up tiles in the middle. Only these can be used in words. */
    this.center = [];
    /** Whose turn it is to flip one face-down tile. */
    this.revealerId = null;
    this.phase = 'lobby';
    this.hostId = null;
    this.log = [];
    this.round = 0;
    this.startedAt = null;
    this.endedAt = null;
    this.winnerIds = [];

    this.playerSerial = 0;
    this.tileSerial = 0;
    this.wordSerial = 0;
    this.logSerial = 0;
  }

  addPlayer(rawName, { connected = true } = {}) {
    const name = this.uniqueName(sanitizeName(rawName) || 'Player');
    const player = {
      id: `p${(this.playerSerial += 1)}`,
      token: randomBytes(18).toString('hex'),
      name,
      color: this.pickColor(),
      connected: Boolean(connected),
      words: [],
      joinedAt: Date.now(),
    };
    this.players.set(player.id, player);
    if (!this.hostId && player.connected) this.hostId = player.id;
    if (this.phase === 'playing' && player.connected && !this.revealerId) {
      this.revealerId = player.id;
    }

    const intro =
      this.phase === 'playing'
        ? `${name} jumped in mid-round.`
        : this.phase === 'ended'
          ? `${name} joined.`
          : `${name} pulled up a chair.`;
    this.addLog('join', intro);
    return player;
  }

  reconnect(token, rawName = '') {
    if (typeof token !== 'string' || !token) return null;
    const player = [...this.players.values()].find((candidate) => candidate.token === token);
    if (!player) return null;

    const cleanName = sanitizeName(rawName);
    if (cleanName && cleanName !== player.name) {
      player.name = this.uniqueName(cleanName, player.id);
    }

    const wasConnected = player.connected;
    player.connected = true;
    if (!this.hostId) this.hostId = player.id;
    if (!wasConnected && this.phase !== 'lobby') {
      this.addLog('connection', `${player.name} reconnected.`);
    }
    if (this.phase === 'playing' && !this.revealerId) this.revealerId = player.id;
    return player;
  }

  setConnected(playerId, connected) {
    const player = this.players.get(playerId);
    if (!player) return;
    const wasConnected = player.connected;
    player.connected = Boolean(connected);

    if (!player.connected) {
      if (this.hostId === player.id) {
        this.hostId = this.firstConnectedId();
        if (this.hostId) {
          const nextHost = this.players.get(this.hostId);
          this.addLog('host', `${nextHost.name} is now host.`);
        }
      }
      if (this.phase === 'playing' && this.revealerId === player.id) {
        this.ensureRevealer();
        const next = this.players.get(this.revealerId);
        if (next) this.addLog('connection', `${next.name} is up to reveal.`);
      }
    } else if (!wasConnected) {
      if (!this.hostId) this.hostId = player.id;
      if (this.phase !== 'lobby') this.addLog('connection', `${player.name} reconnected.`);
      if (this.phase === 'playing' && !this.revealerId) this.revealerId = player.id;
    }
  }

  rename(playerId, rawName) {
    const player = this.players.get(playerId);
    if (!player) return fail('You are not at the table.');
    const cleanName = sanitizeName(rawName);
    if (!cleanName) return fail('Pick a name with at least one character.');
    if (cleanName === player.name) return { ok: true, name: player.name };

    const oldName = player.name;
    player.name = this.uniqueName(cleanName, player.id);
    this.addLog('rename', `${oldName} is now known as ${player.name}.`);
    return { ok: true, name: player.name };
  }

  setMinWordLength(playerId, value) {
    if (!this.isHost(playerId)) return fail('Only the host can change the rules.');
    if (this.phase === 'playing') {
      return fail('Finish the round before changing the minimum word length.');
    }
    const next = clampMinWordLength(value);
    if (next === this.minWordLength) return { ok: true, minWordLength: next };
    this.minWordLength = next;
    this.addLog('config', `Minimum word length is now ${next} letters.`);
    return { ok: true, minWordLength: next };
  }

  setFreeLetters(playerId, value) {
    if (!this.isHost(playerId)) return fail('Only the host can change the rules.');
    if (this.phase === 'playing') {
      return fail('Finish the round before changing how points are scored.');
    }
    const next = clampFreeLetters(value);
    if (next === this.freeLetters) return { ok: true, freeLetters: next };
    this.freeLetters = next;
    this.addLog('config', `Scoring updated: ${describeScoring(next)}.`);
    return { ok: true, freeLetters: next };
  }

  start(playerId) {
    if (!this.isHost(playerId)) return fail('Only the host can start the round.');
    if (this.phase === 'playing') return fail('A round is already running.');
    if (![...this.players.values()].some((player) => player.connected)) {
      return fail('Nobody is connected.');
    }

    this.phase = 'playing';
    this.round += 1;
    this.winnerIds = [];
    this.startedAt = Date.now();
    this.endedAt = null;
    for (const player of this.players.values()) player.words = [];
    this.fillBag();
    this.revealerId = this.firstConnectedId();

    const connected = [...this.players.values()].filter((player) => player.connected).length;
    const starter = this.players.get(this.revealerId);
    this.addLog(
      'start',
      `The bagel is open: ${this.minWordLength}+ letters; ${describeScoring(
        this.freeLetters,
      )}, ${connected} ${connected === 1 ? 'player' : 'players'}.${
        starter ? ` ${starter.name} reveals first.` : ''
      }`,
    );
    return { ok: true };
  }

  restart(playerId) {
    if (!this.isHost(playerId)) return fail('Only the host can start a new round.');
    if (this.phase === 'lobby') return this.start(playerId);
    if (this.phase !== 'ended') return fail('The current round is still running.');

    this.phase = 'playing';
    this.round += 1;
    this.winnerIds = [];
    this.startedAt = Date.now();
    this.endedAt = null;
    for (const player of this.players.values()) player.words = [];
    this.fillBag();
    this.revealerId = this.firstConnectedId();
    const starter = this.players.get(this.revealerId);
    this.addLog(
      'start',
      `A fresh bagel hits the table: ${this.minWordLength}+ letters; ${describeScoring(
        this.freeLetters,
      )}.${starter ? ` ${starter.name} reveals first.` : ''}`,
    );
    return { ok: true };
  }

  end(playerId) {
    if (!this.isHost(playerId)) return fail('Only the host can end the round.');
    if (this.phase !== 'playing') return fail('The round is not running.');
    this.finish('The host called time.');
    return { ok: true };
  }

  reset(playerId) {
    if (!this.isHost(playerId)) return fail('Only the host can reset the table.');
    this.phase = 'lobby';
    this.bag = [];
    this.center = [];
    this.revealerId = null;
    this.winnerIds = [];
    this.startedAt = null;
    this.endedAt = null;
    for (const player of this.players.values()) player.words = [];
    this.addLog('reset', 'Back to the lobby.');
    return { ok: true };
  }

  removePlayer(requesterId, targetId) {
    if (!this.isHost(requesterId)) return fail('Only the host can remove a player.');
    if (this.phase !== 'lobby') return fail('Players can only be removed in the lobby.');
    if (requesterId === targetId) return fail('You cannot remove yourself.');
    const target = this.players.get(targetId);
    if (!target) return fail('That player is not at the table.');
    if (target.connected) return fail('That player is still connected.');
    this.players.delete(targetId);
    this.addLog('leave', `${target.name} was removed from the table.`);
    return { ok: true };
  }

  submit(playerId, rawWord, stealWordId = null) {
    if (this.phase !== 'playing') return fail('The round is not running.');
    const player = this.players.get(playerId);
    if (!player) return fail('You are not at the table.');
    if (!player.connected) return fail('You are not connected.');

    const word = typeof rawWord === 'string' ? rawWord.trim().toUpperCase() : '';
    if (!word) return fail('Type a word first.');
    if (word.length > MAX_WORD_INPUT) return fail('That word is too long.');
    if (!/^[A-Z]+$/.test(word)) return fail('Letters only, no spaces or punctuation.');
    if (word.length < this.minWordLength) {
      return fail(`Words need at least ${this.minWordLength} letters.`);
    }

    const wordCounts = letterCounts(word);
    const centerCounts = letterCounts(this.center.map((tile) => tile.letter));

    let target = null;
    let victim = null;
    let required = wordCounts;

    if (stealWordId) {
      // An explicit target, from a tap in the browser. Stealing your own word
      // is allowed: it lets you rebuild and extend a word you already hold.
      for (const candidate of this.players.values()) {
        const found = candidate.words.find((entry) => entry.id === stealWordId);
        if (found) {
          target = found;
          victim = candidate;
          break;
        }
      }
      if (!target) return fail('That word is no longer on the table.');

      const targetCounts = letterCounts(target.word);
      const keptShort = missingLetters(targetCounts, wordCounts);
      if (keptShort.length > 0) {
        return fail(`Your new word must keep every letter from ${target.word}.`);
      }
      required = subtractCounts(wordCounts, targetCounts);
      if (countTotal(required) < 1) {
        return fail(`Add at least one letter from the bagel to steal ${target.word}.`);
      }
    } else if (missingLetters(wordCounts, centerCounts).length > 0) {
      // The face-up tiles cannot make this word on their own, so look for a
      // word on the table that this word extends. No selection step needed:
      // typing the extended word steals automatically.
      const auto = this.findStealTarget(wordCounts, centerCounts);
      if (auto) {
        target = auto.entry;
        victim = auto.owner;
        required = auto.required;
      }
    }

    const missing = missingLetters(required, centerCounts);
    if (missing.length > 0) {
      return fail(`The bagel is missing ${describeMissing(missing)}.`);
    }

    if (!this.dictionary.has(word)) {
      return fail(`${word} isn't in the ${this.dictionaryName} Scrabble dictionary.`);
    }

    // All validation passed. Mutate in one synchronous block.
    if (target && victim) {
      victim.words = victim.words.filter((entry) => entry.id !== target.id);
    }

    const stillNeeded = { ...required };
    this.center = this.center.filter((tile) => {
      if ((stillNeeded[tile.letter] || 0) > 0) {
        stillNeeded[tile.letter] -= 1;
        return false;
      }
      return true;
    });

    const selfSteal = Boolean(target && victim && victim.id === player.id);
    const entry = {
      id: `w${(this.wordSerial += 1)}`,
      word,
      at: Date.now(),
      stolenFrom: victim ? victim.name : null,
      previous: target ? target.word : null,
      selfStolen: selfSteal,
    };
    player.words.push(entry);

    const points = this.pointsFor(word);
    if (target && victim) {
      const added = countTotal(required);
      // A steal wins the right to reveal next, overriding the normal rotation.
      this.revealerId = player.id;
      const message = selfSteal
        ? `${player.name} rebuilt ${target.word} as ${word} (+${points}, ${added} new). ${player.name} reveals next.`
        : `${player.name} stole ${target.word} from ${victim.name} and built ${word} (+${points}, ${added} new). ${player.name} reveals next.`;
      this.addLog('steal', message);
    } else {
      this.addLog('claim', `${player.name} claimed ${word} (+${points}).`);
    }

    let ended = false;
    if (this.bag.length === 0 && this.center.length === 0) {
      this.finish('The bagel is empty. That is the round.');
      ended = true;
    }

    return {
      ok: true,
      word: publicWord(entry, this.freeLetters),
      points,
      steal:
        target && victim
          ? {
              from: victim.name,
              word: target.word,
              added: countTotal(required),
              self: selfSteal,
            }
          : null,
      ended,
      revealerId: this.revealerId,
      phase: this.phase,
    };
  }

  /**
   * Find a word already on the table that the typed word extends by at least
   * one face-up tile. The longest matching word wins, because it needs the
   * fewest new letters. Includes words the player owns.
   */
  findStealTarget(wordCounts, centerCounts) {
    let best = null;
    for (const owner of this.players.values()) {
      for (const entry of owner.words) {
        const targetCounts = letterCounts(entry.word);
        if (missingLetters(targetCounts, wordCounts).length > 0) continue;

        const required = subtractCounts(wordCounts, targetCounts);
        if (countTotal(required) < 1) continue;
        if (missingLetters(required, centerCounts).length > 0) continue;

        if (!best || entry.word.length > best.entry.word.length) {
          best = { entry, owner, required };
        }
      }
    }
    return best;
  }

  /**
   * Flip one face-down tile into the middle. Only the current revealer may do
   * this, and the right to reveal passes to the next connected player.
   */
  reveal(playerId, tileId) {
    if (this.phase !== 'playing') return fail('The round is not running.');
    const player = this.players.get(playerId);
    if (!player) return fail('You are not at the table.');
    if (!player.connected) return fail('You are not connected.');

    this.ensureRevealer();
    if (this.revealerId !== playerId) {
      const current = this.players.get(this.revealerId);
      return fail(`It is ${current?.name ?? 'another player'}'s turn to reveal.`);
    }

    const index = this.bag.findIndex((tile) => tile.id === tileId);
    if (index === -1) return fail('That tile is already face up.');

    const [tile] = this.bag.splice(index, 1);
    this.center.push(tile);
    this.revealerId = this.nextConnectedAfter(playerId);
    const next = this.players.get(this.revealerId);

    this.addLog(
      'reveal',
      `${player.name} revealed ${tile.letter}.${next && next.id !== player.id ? ` ${next.name} is up.` : ''}`,
    );

    let ended = false;
    if (this.bag.length === 0 && this.center.length === 0) {
      this.finish('The bagel is empty. That is the round.');
      ended = true;
    }

    return {
      ok: true,
      tile: { id: tile.id, letter: tile.letter },
      revealerId: this.revealerId,
      ended,
      phase: this.phase,
    };
  }

  /** Move the reveal right off a disconnected player, or pick the first one. */
  ensureRevealer() {
    if (this.phase !== 'playing') return;
    const current = this.players.get(this.revealerId);
    if (current?.connected) return;
    this.revealerId = current
      ? this.nextConnectedAfter(current.id)
      : this.firstConnectedId();
    if (!this.revealerId) this.revealerId = this.firstConnectedId();
  }

  /** Next connected player in join order, wrapping around. */
  nextConnectedAfter(playerId) {
    const ordered = [...this.players.values()]
      .filter((player) => player.connected)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    if (ordered.length === 0) return null;
    const index = ordered.findIndex((player) => player.id === playerId);
    if (index === -1) return ordered[0].id;
    return ordered[(index + 1) % ordered.length].id;
  }

  finish(note = '') {
    if (this.phase !== 'playing') return;
    this.phase = 'ended';
    this.endedAt = Date.now();
    const ranked = this.rankedPlayers();
    const topScore = ranked[0]?.score ?? 0;
    const anyWords = ranked.some((row) => row.wordCount > 0);
    this.winnerIds = anyWords
      ? ranked.filter((row) => row.score === topScore).map((row) => row.player.id)
      : [];

    if (note) this.addLog('end', note);

    if (!anyWords) {
      this.addLog('end', 'Round over. No words made it to the table.');
    } else if (this.winnerIds.length > 1) {
      const names = this.winnerIds.map((id) => this.players.get(id)?.name).filter(Boolean);
      const last = names.pop();
      this.addLog('end', `Round over. ${names.join(', ')} and ${last} tie with ${topScore} points.`);
    } else {
      const winner = this.players.get(this.winnerIds[0]);
      this.addLog('end', `Round over. ${winner.name} wins with ${topScore} points.`);
    }
  }

  isHost(playerId) {
    return Boolean(playerId) && this.hostId === playerId;
  }

  pointsFor(word) {
    return Math.max(0, String(word).length - this.freeLetters);
  }

  scoreOf(player) {
    return player.words.reduce((sum, entry) => sum + this.pointsFor(entry.word), 0);
  }

  longestOf(player) {
    return player.words.reduce((best, entry) => Math.max(best, entry.word.length), 0);
  }

  rankedPlayers() {
    return [...this.players.values()]
      .map((player) => ({
        player,
        score: this.scoreOf(player),
        wordCount: player.words.length,
        longest: this.longestOf(player),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          b.longest - a.longest ||
          b.wordCount - a.wordCount ||
          a.player.joinedAt - b.player.joinedAt,
      );
  }

  getState(viewerId = null) {
    const ranked = this.rankedPlayers();
    const rankById = new Map(ranked.map((row, index) => [row.player.id, index + 1]));

    const players = [...this.players.values()]
      .map((player) => ({
        id: player.id,
        name: player.name,
        color: player.color,
        connected: player.connected,
        isHost: player.id === this.hostId,
        score: this.scoreOf(player),
        wordCount: player.words.length,
        longest: this.longestOf(player),
        rank: rankById.get(player.id) ?? 0,
        words: player.words.map((entry) => publicWord(entry, this.freeLetters)),
        joinedAt: player.joinedAt,
      }))
      .sort((a, b) => a.joinedAt - b.joinedAt);

    return {
      phase: this.phase,
      minWordLength: this.minWordLength,
      freeLetters: this.freeLetters,
      center: this.center.map((tile) => ({ id: tile.id, letter: tile.letter })),
      // Face-down tiles are sent without their letters so the browser cannot
      // peek. Only the count and the stable ids travel over the wire.
      bag: this.bag.map((tile) => ({ id: tile.id })),
      revealerId: this.revealerId,
      players,
      you: viewerId,
      hostId: this.hostId,
      log: this.log,
      winnerIds: this.winnerIds,
      round: this.round,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      tileCount: this.initialTileLetters.length,
      dictionary: {
        name: this.dictionaryName,
        words: this.dictionary.size,
      },
    };
  }

  fillBag() {
    const letters = [...this.initialTileLetters];
    if (this.shuffleTiles) shuffle(letters, this.random);
    this.bag = letters.map((letter) => ({
      id: `t${(this.tileSerial += 1)}`,
      letter,
    }));
    this.center = [];
  }

  pickColor() {
    const used = new Set([...this.players.values()].map((player) => player.color));
    return (
      PLAYER_COLORS.find((color) => !used.has(color)) ??
      PLAYER_COLORS[this.players.size % PLAYER_COLORS.length]
    );
  }

  uniqueName(baseName, excludeId = null) {
    const clean = baseName || 'Player';
    const used = new Set(
      [...this.players.values()]
        .filter((player) => player.id !== excludeId)
        .map((player) => player.name.toLowerCase()),
    );
    if (!used.has(clean.toLowerCase())) return clean;

    let suffix = 2;
    while (used.has(`${clean} ${suffix}`.toLowerCase())) suffix += 1;
    return `${clean.slice(0, MAX_NAME_LENGTH - String(suffix).length - 1)} ${suffix}`;
  }

  firstConnectedId() {
    for (const player of this.players.values()) {
      if (player.connected) return player.id;
    }
    return null;
  }

  addLog(kind, text) {
    this.log.unshift({
      id: `l${(this.logSerial += 1)}`,
      kind,
      text,
      at: Date.now(),
    });
    if (this.log.length > LOG_LIMIT) this.log.length = LOG_LIMIT;
  }
}
