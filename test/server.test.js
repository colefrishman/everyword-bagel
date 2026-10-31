import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

import { createAppServer } from '../server/index.js';

const DICTIONARY = new Set(['TILES', 'LISTED', 'CATS', 'CHATS']);

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Tiny WebSocket client for tests. Messages are buffered; waitFor scans
 * forward from a cursor so sequential expectations stay easy to read.
 */
function makeClient(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const messages = [];
  let cursor = 0;

  const opened = new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  ws.on('message', (raw) => {
    try {
      messages.push(JSON.parse(raw.toString()));
    } catch {
      messages.push({ type: 'unparseable', raw: raw.toString() });
    }
  });

  const waitFor = async (predicate, timeout = 4000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      for (let i = cursor; i < messages.length; i += 1) {
        if (predicate(messages[i])) {
          cursor = i + 1;
          return messages[i];
        }
      }
      await delay(10);
    }
    throw new Error(
      `Timed out waiting for a message. Saw: ${JSON.stringify(messages.slice(cursor))}`,
    );
  };

  return {
    ws,
    messages,
    opened,
    waitFor,
    send(payload) {
      ws.send(JSON.stringify(payload));
    },
    close() {
      ws.close();
    },
  };
}

async function withServer(run) {
  const instance = createAppServer({ port: 0, dictionary: DICTIONARY, minWordLength: 4 });
  const { port } = await instance.start();
  try {
    await run({ instance, port });
  } finally {
    await instance.stop();
  }
}

async function join(client, name) {
  client.send({ type: 'hello', name });
  return client.waitFor((message) => message.type === 'welcome');
}

/** Make the bag deterministic and ordered, before the round starts. */
function setTiles(instance, letters) {
  instance.game.initialTileLetters = [...letters];
  instance.game.shuffleTiles = false;
}

/**
 * Flip tiles through the real turn order until the middle contains every
 * requested letter. The test can read the server's bag; the browser cannot.
 */
async function revealUntil(instance, clients, letters) {
  const needed = [...new Set(letters)];
  const deadline = Date.now() + 8000;

  while (Date.now() < deadline) {
    const pool = new Set(instance.game.center.map((tile) => tile.letter));
    if (needed.every((letter) => pool.has(letter))) return;

    const game = instance.game;
    const revealer = game.players.get(game.revealerId);
    assert.ok(revealer, 'there should be a revealer');
    const entry = clients.find((candidate) => candidate.playerId === revealer.id);
    assert.ok(entry, `a socket for ${revealer.name}`);

    const tile = game.bag.find((candidate) => needed.includes(candidate.letter)) ?? game.bag[0];
    assert.ok(tile, 'the bag should not be empty');

    const before = game.bag.length;
    entry.client.send({ type: 'reveal', tileId: tile.id });
    await entry.client.waitFor(
      (message) => message.type === 'state' && message.state.bag.length === before - 1,
    );
  }

  throw new Error('Timed out trying to reveal the needed letters');
}

test('HTTP endpoints report health, info, and a QR code', async () => {
  await withServer(async ({ port }) => {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`);
    assert.equal(health.status, 200);
    const healthBody = await health.json();
    assert.equal(healthBody.ok, true);
    assert.equal(healthBody.phase, 'lobby');

    const info = await fetch(`http://127.0.0.1:${port}/api/info`);
    assert.equal(info.status, 200);
    const infoBody = await info.json();
    assert.equal(infoBody.dictionary.words, DICTIONARY.size);
    assert.equal(infoBody.tileCount, 98);
    assert.ok(infoBody.primaryUrl.startsWith('http://'));

    const proxied = await fetch(`http://127.0.0.1:${port}/api/info`, {
      headers: {
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'everyword-bagel.onrender.com',
      },
    });
    assert.equal(proxied.status, 200);
    const proxiedBody = await proxied.json();
    assert.equal(proxiedBody.primaryUrl, 'https://everyword-bagel.onrender.com');
    assert.deepEqual(proxiedBody.urls, ['https://everyword-bagel.onrender.com']);
    assert.deepEqual(proxiedBody.addresses, []);
    assert.equal(proxiedBody.hosted, true);

    const qr = await fetch(`http://127.0.0.1:${port}/api/qr.svg`);
    assert.equal(qr.status, 200);
    assert.match(qr.headers.get('content-type'), /image\/svg\+xml/);
    assert.match(await qr.text(), /<svg/);

    const page = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /Everyword/);

    const manifest = await fetch(`http://127.0.0.1:${port}/manifest.webmanifest`);
    assert.equal(manifest.status, 200);

    const icon = await fetch(`http://127.0.0.1:${port}/icon.svg`);
    assert.equal(icon.status, 200);
  });
});

test('two clients join, reveal in turn, claim, and steal over WebSockets', async () => {
  await withServer(async ({ instance, port }) => {
    setTiles(instance, 'TILESDQZQATS');

    const alice = makeClient(port);
    const bob = makeClient(port);
    await Promise.all([alice.opened, bob.opened]);

    const aliceWelcome = await join(alice, 'Alice');
    assert.equal(aliceWelcome.state.phase, 'lobby');
    assert.equal(aliceWelcome.state.hostId, aliceWelcome.you);
    assert.ok(aliceWelcome.token);

    const bobWelcome = await join(bob, 'Bob');
    assert.equal(bobWelcome.state.players.length, 2);

    const clients = [
      { client: alice, playerId: aliceWelcome.you },
      { client: bob, playerId: bobWelcome.you },
    ];

    // Alice (the host) sees Bob arrive.
    await alice.waitFor(
      (message) =>
        message.type === 'state' &&
        message.state.players.length === 2 &&
        message.state.players.some((player) => player.name === 'Bob'),
    );

    // Bob is not the host and cannot start the round.
    bob.send({ type: 'start' });
    const notHost = await bob.waitFor((message) => message.type === 'error');
    assert.match(notHost.message, /Only the host/);

    // Host starts the round. Everything begins face down.
    alice.send({ type: 'start' });
    const playing = await alice.waitFor(
      (message) => message.type === 'state' && message.state.phase === 'playing',
    );
    assert.equal(playing.state.center.length, 0);
    assert.equal(playing.state.bag.length, 12);
    assert.equal(playing.state.revealerId, aliceWelcome.you);
    // Hidden letters never travel to the browser.
    assert.equal(
      playing.state.bag.every((tile) => !('letter' in tile)),
      true,
    );

    await bob.waitFor((message) => message.type === 'state' && message.state.phase === 'playing');

    // Bob cannot reveal out of turn.
    bob.send({ type: 'reveal', tileId: playing.state.bag[0].id });
    const outOfTurn = await bob.waitFor((message) => message.type === 'error');
    assert.match(outOfTurn.message, /turn to reveal/);

    // Flip enough tiles for TILES and LISTED, alternating through the turn order.
    await revealUntil(instance, clients, 'TILESD');
    const pool = instance.game.center.map((tile) => tile.letter);
    assert.equal(pool.length, 6);
    assert.equal(new Set(pool).size, 6);

    // Alice claims TILES.
    alice.send({ type: 'submit', word: 'tiles' });
    const claimed = await alice.waitFor((message) => message.type === 'accepted');
    assert.equal(claimed.word.word, 'TILES');
    assert.equal(claimed.word.length, 5);
    assert.equal(claimed.steal, null);

    const afterClaim = await bob.waitFor(
      (message) =>
        message.type === 'state' &&
        message.state.players.find((player) => player.name === 'Alice').words.length === 1,
    );
    assert.equal(afterClaim.state.center.length, 1);
    assert.equal(afterClaim.state.bag.length, 6);

    // Bob steals TILES by adding D and rearranging into LISTED.
    bob.send({ type: 'submit', word: 'LISTED', stealWordId: claimed.word.id });
    const stolen = await bob.waitFor((message) => message.type === 'accepted');
    assert.equal(stolen.word.word, 'LISTED');
    assert.equal(stolen.steal.from, 'Alice');
    assert.equal(stolen.steal.word, 'TILES');
    assert.equal(stolen.steal.added, 1);
    assert.equal(stolen.revealerId, bobWelcome.you);

    const afterSteal = await alice.waitFor(
      (message) =>
        message.type === 'state' &&
        message.state.players.find((player) => player.name === 'Alice').words.length === 0 &&
        message.state.players.find((player) => player.name === 'Bob').words.length === 1,
    );
    // The steal consumed the last face-up tile, but the bag still has letters.
    assert.equal(afterSteal.state.center.length, 0);
    assert.equal(afterSteal.state.bag.length, 6);
    assert.equal(afterSteal.state.revealerId, bobWelcome.you);
    assert.equal(
      afterSteal.state.players.find((player) => player.name === 'Bob').score,
      6,
    );

    // Reveal Q, A, T, S, then submit a letter-valid non-word.
    await revealUntil(instance, clients, 'QATS');
    await delay(150);
    bob.send({ type: 'submit', word: 'QATS' });
    const rejected = await bob.waitFor(
      (message) => message.type === 'error' && message.code === 'rejected',
    );
    assert.match(rejected.message, /Scrabble dictionary/);

    // Too fast: the anti-spam cooldown answers with a rate error.
    bob.send({ type: 'submit', word: 'CATS' });
    const rateLimited = await bob.waitFor(
      (message) => message.type === 'error' && message.code === 'rate',
    );
    assert.match(rateLimited.message, /one word at a time/);

    alice.close();
    bob.close();
  });
});

test('a client reconnecting with its token keeps its words', async () => {
  await withServer(async ({ instance, port }) => {
    setTiles(instance, 'CATSQ');
    const alice = makeClient(port);
    await alice.opened;
    const welcome = await join(alice, 'Alice');

    alice.send({ type: 'start' });
    await alice.waitFor((message) => message.type === 'state' && message.state.phase === 'playing');

    await revealUntil(instance, [{ client: alice, playerId: welcome.you }], 'CATS');
    alice.send({ type: 'submit', word: 'CATS' });
    await alice.waitFor((message) => message.type === 'accepted');

    alice.close();
    await delay(80);

    const again = makeClient(port);
    await again.opened;
    again.send({ type: 'hello', token: welcome.token, name: 'Alice' });
    const reconnect = await again.waitFor((message) => message.type === 'welcome');

    assert.equal(reconnect.you, welcome.you);
    assert.equal(reconnect.state.phase, 'playing');
    const player = reconnect.state.players.find((entry) => entry.id === welcome.you);
    assert.equal(player.name, 'Alice');
    assert.equal(player.connected, true);
    assert.deepEqual(
      player.words.map((entry) => entry.word),
      ['CATS'],
    );
    assert.equal(reconnect.state.bag.length, 1);

    again.close();
  });
});

test('every connected client sees the round end when the bagel empties', async () => {
  await withServer(async ({ instance, port }) => {
    setTiles(instance, 'CATS');

    const alice = makeClient(port);
    const bob = makeClient(port);
    await Promise.all([alice.opened, bob.opened]);
    const aliceWelcome = await join(alice, 'Alice');
    const bobWelcome = await join(bob, 'Bob');
    await alice.waitFor(
      (message) => message.type === 'state' && message.state.players.length === 2,
    );

    alice.send({ type: 'start' });
    await bob.waitFor((message) => message.type === 'state' && message.state.phase === 'playing');

    const clients = [
      { client: alice, playerId: aliceWelcome.you },
      { client: bob, playerId: bobWelcome.you },
    ];
    await revealUntil(instance, clients, 'CATS');

    alice.send({ type: 'submit', word: 'CATS' });
    const accepted = await alice.waitFor((message) => message.type === 'accepted');
    assert.equal(accepted.ended, true);

    const ended = await bob.waitFor(
      (message) => message.type === 'state' && message.state.phase === 'ended',
    );
    assert.deepEqual(ended.state.winnerIds, [ended.state.hostId]);
    assert.equal(ended.state.center.length, 0);
    assert.equal(ended.state.bag.length, 0);

    alice.close();
    bob.close();
  });
});
