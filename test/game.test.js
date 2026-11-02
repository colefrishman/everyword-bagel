import test from 'node:test';
import assert from 'node:assert/strict';

import {
  AnagramsGame,
  TILE_DISTRIBUTION,
  buildTileLetters,
  clampFreeLetters,
  clampMinWordLength,
  letterCounts,
  sanitizeName,
} from '../server/game.js';

const DICTIONARY = new Set([
  'ACTS',
  'BAGEL',
  'BAGELS',
  'CAST',
  'CATS',
  'CHAT',
  'CHATS',
  'DOG',
  'DOGS',
  'GOD',
  'GODS',
  'HAT',
  'HATS',
  'ISLET',
  'LIST',
  'LISTED',
  'LISTS',
  'SASS',
  'SCATS',
  'STILE',
  'SWORD',
  'SWORDS',
  'TILES',
  'WORD',
  'WORDS',
]);

function newGame({
  letters,
  dictionary = DICTIONARY,
  min = 4,
  free = 3,
  shuffleTiles = false,
} = {}) {
  return new AnagramsGame({
    dictionary,
    dictionaryName: 'TEST',
    tileLetters: letters,
    minWordLength: min,
    freeLetters: free,
    shuffleTiles,
  });
}

/** Move every face-down tile into the middle, for tests about claiming. */
function revealAll(game) {
  game.center.push(...game.bag);
  game.bag = [];
}

/** Move specific letters from the bag into the middle, bypassing turn order. */
function revealLetters(game, letters) {
  for (const letter of letters) {
    const index = game.bag.findIndex((tile) => tile.letter === letter);
    assert.notEqual(index, -1, `the bag has no ${letter}`);
    game.center.push(...game.bag.splice(index, 1));
  }
}

function playingGame({ letters, dictionary = DICTIONARY, min = 4, free = 3 } = {}) {
  const game = newGame({ letters, dictionary, min, free });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  const start = game.start(alice.id);
  assert.equal(start.ok, true);
  revealAll(game);
  return { game, alice, bob };
}

test('standard Scrabble distribution has 98 letter tiles', () => {
  const letters = buildTileLetters();
  assert.equal(letters.length, 98);
  assert.deepEqual(letterCounts(letters), letterCounts(buildTileLetters(TILE_DISTRIBUTION)));
  assert.equal(letterCounts(letters).E, 12);
  assert.equal(letterCounts(letters).Q, 1);
  assert.equal(letterCounts(letters).S, 4);
});

test('names are sanitized and clamped', () => {
  assert.equal(sanitizeName('  Alice   <script>  '), 'Alice script');
  assert.equal(sanitizeName(''), '');
  assert.equal(sanitizeName(null), '');
  assert.equal(sanitizeName('abcdefghijklmnopqrstuvwxyz').length, 18);
});

test('minimum word length is clamped to 3..7', () => {
  assert.equal(clampMinWordLength(1), 3);
  assert.equal(clampMinWordLength(4), 4);
  assert.equal(clampMinWordLength(99), 7);
  assert.equal(clampMinWordLength('5'), 5);
  assert.equal(clampMinWordLength('nope'), 4);
});

test('free letters are clamped to 0..6', () => {
  assert.equal(clampFreeLetters(-2), 0);
  assert.equal(clampFreeLetters(3), 3);
  assert.equal(clampFreeLetters(99), 6);
  assert.equal(clampFreeLetters('2'), 2);
  assert.equal(clampFreeLetters('nope'), 3);
});

test('a new game starts in the lobby with an empty center', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  assert.equal(game.phase, 'lobby');
  assert.deepEqual(game.center, []);
  const alice = game.addPlayer('Alice');
  assert.equal(game.hostId, alice.id);
  assert.equal(game.getState(alice.id).players.length, 1);
  assert.equal(game.getState(alice.id).center.length, 0);
});

test('two players with the same name get distinct names', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const secondAlice = game.addPlayer('alice');
  assert.notEqual(alice.name, secondAlice.name);
  assert.equal(secondAlice.name, 'alice 2');
});

test('tiles start face down in the bag and their letters are never public', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  assert.equal(game.start(alice.id).ok, true);

  assert.equal(game.bag.length, 4);
  assert.equal(game.center.length, 0);
  assert.equal(game.revealerId, alice.id);

  const state = game.getState(alice.id);
  assert.equal(state.bag.length, 4);
  assert.equal(state.center.length, 0);
  assert.equal(
    state.bag.every((tile) => !('letter' in tile)),
    true,
  );
  assert.equal(JSON.stringify(state).includes('"letter"'), false);
});

test('only the current revealer can flip a tile, and the turn rotates in order', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.start(alice.id).ok, true);
  assert.equal(game.revealerId, alice.id);

  const bobTries = game.reveal(bob.id, game.bag[0].id);
  assert.equal(bobTries.ok, false);
  assert.match(bobTries.error, /Alice's turn to reveal/);

  const first = game.reveal(alice.id, game.bag[0].id);
  assert.equal(first.ok, true);
  assert.equal(first.tile.letter, 'C');
  assert.equal(game.center.length, 1);
  assert.equal(game.bag.length, 3);
  assert.equal(game.revealerId, bob.id);

  const second = game.reveal(bob.id, game.bag[0].id);
  assert.equal(second.ok, true);
  assert.equal(second.tile.letter, 'A');
  assert.equal(game.revealerId, alice.id);

  // The same tile cannot be revealed twice.
  const repeatreveal = game.reveal(alice.id, first.tile.id);
  assert.equal(repeatreveal.ok, false);
  assert.match(repeatreveal.error, /already face up/);
});

test('the round continues while face-down tiles remain', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'X'] });
  const alice = game.addPlayer('Alice');
  assert.equal(game.start(alice.id).ok, true);
  revealLetters(game, 'CATS');

  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, true);
  assert.equal(game.center.length, 0);
  assert.equal(game.bag.length, 1);
  assert.equal(result.ended, false);
  assert.equal(game.phase, 'playing');
});

test('the reveal right skips disconnected players', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  const carol = game.addPlayer('Carol');
  assert.equal(game.start(alice.id).ok, true);
  assert.equal(game.revealerId, alice.id);

  game.setConnected(alice.id, false);
  assert.equal(game.revealerId, bob.id);

  game.setConnected(bob.id, false);
  assert.equal(game.revealerId, carol.id);

  // When everyone is back, the rotation resumes from the current revealer.
  game.reconnect(alice.token, 'Alice');
  game.reconnect(bob.token, 'Bob');
  const next = game.nextConnectedAfter(carol.id);
  assert.equal(next, alice.id);
});

test('a steal hands the reveal right to the stealer', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.start(alice.id).ok, true);
  revealLetters(game, 'CATSH');
  assert.equal(game.revealerId, alice.id);

  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  const stolen = game.submit(bob.id, 'CHATS', alice.words[0].id);
  assert.equal(stolen.ok, true);
  assert.equal(stolen.revealerId, bob.id);
  assert.equal(game.revealerId, bob.id);

  // Bob reveals next, then the right returns to Alice.
  const revealed = game.reveal(bob.id, game.bag[0].id);
  assert.equal(revealed.ok, true);
  assert.equal(game.revealerId, alice.id);
});

test('a steal must use a revealed tile from the middle', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'H'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.start(alice.id).ok, true);
  revealLetters(game, 'CATS');

  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  // H is still face down, so the steal has no revealed tile to add.
  const stolen = game.submit(bob.id, 'CHATS', alice.words[0].id);
  assert.equal(stolen.ok, false);
  assert.match(stolen.error, /bagel is missing H/);
});

test('typing an extended word steals automatically without a target id', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.start(alice.id).ok, true);

  revealLetters(game, 'CATS');
  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  revealLetters(game, 'H');

  const stolen = game.submit(bob.id, 'CHATS');
  assert.equal(stolen.ok, true);
  assert.equal(stolen.steal.from, 'Alice');
  assert.equal(stolen.steal.word, 'CATS');
  assert.equal(stolen.steal.added, 1);
  assert.equal(stolen.steal.self, false);
  assert.deepEqual(bob.words.map((entry) => entry.word), ['CHATS']);
  assert.equal(alice.words.length, 0);
  assert.equal(game.revealerId, bob.id);
});

test('a player can rebuild their own word by typing the larger word', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E'] });
  const alice = game.addPlayer('Alice');
  assert.equal(game.start(alice.id).ok, true);

  revealLetters(game, 'CATS');
  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  revealLetters(game, 'H');

  const rebuilt = game.submit(alice.id, 'CHATS');
  assert.equal(rebuilt.ok, true);
  assert.equal(rebuilt.steal.self, true);
  assert.equal(rebuilt.steal.from, 'Alice');
  assert.deepEqual(alice.words.map((entry) => entry.word), ['CHATS']);
  assert.equal(game.scoreOf(alice), 2);
  assert.equal(game.revealerId, alice.id);
});

test('a word the middle can build is claimed instead of stolen', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S', 'C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.start(alice.id).ok, true);

  revealLetters(game, 'CATS');
  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  revealLetters(game, 'CATS');

  const claimed = game.submit(bob.id, 'CATS');
  assert.equal(claimed.ok, true);
  assert.equal(claimed.steal, null);
  assert.deepEqual(bob.words.map((entry) => entry.word), ['CATS']);
});

test('valid word claims the right tiles and scores only letters past the third', () => {
  const { game, alice } = playingGame({ letters: ['C', 'A', 'T', 'S', 'H', 'E', 'L', 'L', 'O'] });
  const result = game.submit(alice.id, 'cats');
  assert.equal(result.ok, true);
  assert.equal(result.word.word, 'CATS');
  assert.equal(result.word.points, 1);
  assert.equal(result.points, 1);
  assert.equal(game.phase, 'playing');
  assert.deepEqual(
    game.center.map((tile) => tile.letter).sort(),
    ['E', 'H', 'L', 'L', 'O'],
  );
  assert.equal(alice.words.length, 1);
  assert.equal(game.scoreOf(alice), 1);
  const state = game.getState(alice.id);
  const me = state.players.find((p) => p.id === alice.id);
  assert.equal(me.score, 1);
  assert.equal(me.words[0].points, 1);
  assert.equal(state.freeLetters, 3);
});

test('the host can change the scoring offset, including every letter counting', () => {
  const { game, alice } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'E', 'L', 'L', 'O'],
    free: 0,
  });
  assert.equal(game.submit(alice.id, 'CATS').word.points, 4);
  assert.equal(game.scoreOf(alice), 4);

  const game2 = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const host = game2.addPlayer('Host');
  assert.equal(game2.setFreeLetters(host.id, 3).freeLetters, 3);
  assert.equal(game2.freeLetters, 3);
  assert.equal(game2.setFreeLetters(host.id, 99).freeLetters, 6);
  assert.equal(game2.start(host.id).ok, true);
  const locked = game2.setFreeLetters(host.id, 2);
  assert.equal(locked.ok, false);
  assert.match(locked.error, /Finish the round/);
});

test('words shorter than the configured minimum are rejected', () => {
  const { game, alice } = playingGame({ letters: ['C', 'A', 'T', 'S'], min: 5 });
  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, false);
  assert.match(result.error, /at least 5 letters/);
  assert.equal(alice.words.length, 0);
});

test('words not in the Scrabble dictionary are rejected', () => {
  const { game, alice } = playingGame({
    letters: ['C', 'A', 'T', 'S'],
    dictionary: new Set(['BAGEL']),
  });
  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, false);
  assert.match(result.error, /isn't in the TEST Scrabble dictionary/);
});

test('words using letters not in the center are rejected', () => {
  const { game, alice } = playingGame({
    letters: ['C', 'A', 'T', 'Z', 'Z', 'Z'],
  });
  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, false);
  assert.match(result.error, /bagel is missing S/);
  assert.equal(alice.words.length, 0);
});

test('duplicate letters are counted correctly', () => {
  const { game, alice } = playingGame({
    letters: ['S', 'A', 'S', 'S', 'X', 'X'],
  });
  const result = game.submit(alice.id, 'SASS');
  assert.equal(result.ok, true);
  assert.deepEqual(
    game.center.map((tile) => tile.letter).sort(),
    ['X', 'X'],
  );
});

test('a player can steal an opponent word by adding a center letter', () => {
  const { game, alice, bob } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });

  assert.equal(game.submit(alice.id, 'CATS').ok, true);
  const targetId = alice.words[0].id;
  assert.ok(targetId);

  const result = game.submit(bob.id, 'CHATS', targetId);
  assert.equal(result.ok, true);
  assert.equal(result.steal.from, 'Alice');
  assert.equal(result.steal.word, 'CATS');
  assert.equal(alice.words.length, 0);
  assert.equal(bob.words.length, 1);
  assert.equal(bob.words[0].word, 'CHATS');
  assert.equal(game.scoreOf(alice), 0);
  assert.equal(game.scoreOf(bob), 2);
  assert.deepEqual(
    game.center.map((tile) => tile.letter).sort(),
    ['E', 'I', 'L', 'S'],
  );
});

test('a steal must keep every letter of the target word', () => {
  const { game, alice, bob } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });
  game.submit(alice.id, 'CATS');
  const result = game.submit(bob.id, 'CHAT', alice.words[0].id);
  assert.equal(result.ok, false);
  assert.match(result.error, /keep every letter from CATS/);
});

test('a steal must add at least one bagel letter', () => {
  const { game, alice, bob } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });
  game.submit(alice.id, 'CATS');
  const result = game.submit(bob.id, 'CAST', alice.words[0].id);
  assert.equal(result.ok, false);
  assert.match(result.error, /Add at least one letter/);
});

test('a player can steal their own word', () => {
  const { game, alice } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });
  game.submit(alice.id, 'CATS');
  const result = game.submit(alice.id, 'CHATS', alice.words[0].id);
  assert.equal(result.ok, true);
  assert.equal(result.steal.self, true);
  assert.equal(result.steal.from, 'Alice');
  assert.deepEqual(alice.words.map((entry) => entry.word), ['CHATS']);
  assert.equal(game.scoreOf(alice), 2);
});

test('stealing a word that no longer exists fails cleanly', () => {
  const { game, alice, bob } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });
  game.submit(alice.id, 'CATS');
  const targetId = alice.words[0].id;
  assert.equal(game.submit(bob.id, 'CHATS', targetId).ok, true);

  const result = game.submit(alice.id, 'CHATS', targetId);
  assert.equal(result.ok, false);
  assert.match(result.error, /no longer on the table/);
});

test('the round ends automatically when the last center tile is claimed', () => {
  const { game, alice, bob } = playingGame({ letters: ['C', 'A', 'T', 'S'] });
  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, true);
  assert.equal(result.ended, true);
  assert.equal(game.phase, 'ended');
  assert.deepEqual(game.winnerIds, [alice.id]);
  assert.equal(game.center.length, 0);
  assert.ok(game.getState(bob.id).endedAt);
});

test('a round of zero-point words still crowns a winner', () => {
  const { game, alice, bob } = playingGame({ letters: ['C', 'A', 'T', 'S'], free: 6 });
  const result = game.submit(alice.id, 'CATS');
  assert.equal(result.ok, true);
  assert.equal(result.word.points, 0);
  assert.equal(game.phase, 'ended');
  assert.deepEqual(game.winnerIds, [alice.id, bob.id]);
});

test('host can end a round and restart with cleared words', () => {
  const { game, alice, bob } = playingGame({
    letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'],
  });
  game.submit(alice.id, 'CATS');
  const ended = game.end(alice.id);
  assert.equal(ended.ok, true);
  assert.equal(game.phase, 'ended');
  assert.equal(game.players.get(alice.id).words.length, 1);

  const restarted = game.restart(alice.id);
  assert.equal(restarted.ok, true);
  assert.equal(game.phase, 'playing');
  assert.equal(game.players.get(alice.id).words.length, 0);
  assert.equal(game.players.get(bob.id).words.length, 0);
  assert.equal(game.bag.length, 9);
  assert.equal(game.center.length, 0);
  assert.equal(game.round, 2);
});

test('non-hosts cannot start, end, configure, or reset', () => {
  const { game, bob } = playingGame({ letters: ['C', 'A', 'T', 'S'] });
  assert.equal(game.end(bob.id).ok, false);
  assert.equal(game.setMinWordLength(bob.id, 5).ok, false);
  assert.equal(game.setFreeLetters(bob.id, 2).ok, false);
  assert.equal(game.reset(bob.id).ok, false);
  assert.equal(game.restart(bob.id).ok, false);
});

test('host can configure the minimum only outside a live round', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  assert.equal(game.setMinWordLength(alice.id, 99).minWordLength, 7);
  assert.equal(game.start(alice.id).ok, true);
  const result = game.setMinWordLength(alice.id, 4);
  assert.equal(result.ok, false);
  assert.match(result.error, /Finish the round/);
});

test('host moves to a connected player when the host disconnects', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  assert.equal(game.hostId, alice.id);

  game.setConnected(alice.id, false);
  assert.equal(game.hostId, bob.id);

  game.reconnect(alice.token, 'Alice');
  assert.equal(game.hostId, bob.id);
  assert.equal(game.players.get(alice.id).connected, true);
});

test('reset returns everyone to the lobby and clears words', () => {
  const { game, alice } = playingGame({ letters: ['C', 'A', 'T', 'S'] });
  game.submit(alice.id, 'CATS');
  assert.equal(game.phase, 'ended');
  const result = game.reset(alice.id);
  assert.equal(result.ok, true);
  assert.equal(game.phase, 'lobby');
  assert.equal(game.center.length, 0);
  assert.equal(alice.words.length, 0);
  assert.deepEqual(game.winnerIds, []);
});

test('state never includes secret reconnect tokens', () => {
  const { game, alice } = playingGame({ letters: ['C', 'A', 'T', 'S'] });
  game.submit(alice.id, 'CATS');
  const state = game.getState(alice.id);
  assert.equal(state.you, alice.id);
  assert.equal('token' in state.players[0], false);
  assert.equal(JSON.stringify(state).includes(alice.token), false);
});

test('disconnected lobby players can only be removed by the host', () => {
  const game = newGame({ letters: ['C', 'A', 'T', 'S'] });
  const alice = game.addPlayer('Alice');
  const bob = game.addPlayer('Bob');
  game.setConnected(bob.id, false);

  assert.equal(game.removePlayer(bob.id, bob.id).ok, false);
  assert.equal(game.removePlayer(bob.id, alice.id).ok, false);
  const removed = game.removePlayer(alice.id, bob.id);
  assert.equal(removed.ok, true);
  assert.equal(game.players.has(bob.id), false);
});

test('a late joiner can play in the current round', () => {
  const { game } = playingGame({ letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'] });
  const carol = game.addPlayer('Carol');
  assert.equal(game.getState(carol.id).players.length, 3);
  assert.equal(carol.words.length, 0);
  assert.match(game.log[0].text, /jumped in mid-round/);
});

test('invalid input is rejected without changing state', () => {
  const { game, alice } = playingGame({ letters: ['C', 'A', 'T', 'S', 'H', 'I', 'L', 'E', 'S'] });
  const before = game.getState(alice.id);

  assert.equal(game.submit(alice.id, '').ok, false);
  assert.equal(game.submit(alice.id, 'CAT-S').ok, false);
  assert.equal(game.submit(alice.id, 'CATS!').ok, false);
  assert.equal(game.submit(alice.id, 'CAT').ok, false);
  assert.equal(game.submit(alice.id, 'X'.repeat(40)).ok, false);

  const after = game.getState(alice.id);
  assert.equal(before.center.length, after.center.length);
  assert.equal(alice.words.length, 0);
});
