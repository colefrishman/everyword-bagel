import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { networkInterfaces } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';

import { DEFAULT_MIN_WORD_LENGTH, AnagramsGame } from './game.js';
import { loadDictionary } from './dictionary.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const WORDS_FILE = path.join(ROOT, 'data', 'scrabble-words.txt');
const DEFAULT_PORT = Number.parseInt(process.env.PORT ?? '3000', 10) || 3000;
const MAX_MESSAGE_BYTES = 16 * 1024;

const VIRTUAL_ADAPTER = /vEthernet|VirtualBox|VMware|Hyper-V|Docker|WSL|Tailscale|ZeroTier|Loopback/i;

/**
 * Every non-loopback IPv4 interface, ordered by how likely it is to be the
 * Wi-Fi/Ethernet address someone in the room can reach.
 */
export function getLanAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(networkInterfaces())) {
    for (const entry of entries ?? []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;
      let score = 4;
      if (entry.address.startsWith('192.168.')) score = 0;
      else if (entry.address.startsWith('10.')) score = 1;
      else if (/^172\.(1[6-9]|2\d|3[01])\./.test(entry.address)) score = 2;
      if (VIRTUAL_ADAPTER.test(name)) score += 10;
      found.push({ name, address: entry.address, score });
    }
  }
  return found
    .sort((a, b) => a.score - b.score || a.address.localeCompare(b.address))
    .map(({ name, address }) => ({ name, address }));
}

function isLoopbackHost(host = '') {
  return /^(localhost|127\.0\.0\.1|\[::1\]|::1)(:\d+)?$/i.test(host);
}

function firstHeaderValue(value) {
  if (Array.isArray(value)) return value[0] ?? '';
  if (typeof value !== 'string') return '';
  return value.split(',')[0].trim();
}

/**
 * Work out the URL other devices should open.
 *
 * Locally, the page is served over plain HTTP and we advertise the best LAN
 * IPv4 address. Behind a reverse proxy (Render, Cloudflare, a tunnel) the
 * public host and scheme come from the forwarded headers, and the container's
 * private address is not reachable by players, so it is omitted.
 */
export function buildJoinInfo(req, fallbackPort = DEFAULT_PORT) {
  const port = req?.socket?.localPort || fallbackPort;
  const forwardedProto = firstHeaderValue(req?.headers?.['x-forwarded-proto']);
  const forwardedHost = firstHeaderValue(req?.headers?.['x-forwarded-host']);
  const requestHost = forwardedHost || req?.headers?.host || '';
  const hosted = Boolean(forwardedProto || forwardedHost);
  const scheme = forwardedProto === 'https' || req?.socket?.encrypted ? 'https' : 'http';
  const addresses = hosted ? [] : getLanAddresses();
  const urls = addresses.map(({ address }) => `${scheme}://${address}:${port}`);

  let primaryUrl = urls[0] ?? `${scheme}://localhost:${port}`;
  if (requestHost && !isLoopbackHost(requestHost)) {
    primaryUrl = `${scheme}://${requestHost}`;
  }

  const uniqueUrls = [];
  for (const url of [primaryUrl, ...urls]) {
    if (!uniqueUrls.includes(url)) uniqueUrls.push(url);
  }

  return {
    primaryUrl,
    urls: uniqueUrls,
    addresses,
    hosted,
    port,
    host: requestHost || null,
  };
}

function send(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify(payload));
}

function sendError(ws, message, code = 'error') {
  send(ws, { type: 'error', message, code });
}

/**
 * Build the HTTP + WebSocket app. Exported so tests can run it on port 0.
 */
export function createAppServer({
  port = DEFAULT_PORT,
  host = '0.0.0.0',
  dictionary = null,
  wordsFile = WORDS_FILE,
  minWordLength = DEFAULT_MIN_WORD_LENGTH,
} = {}) {
  const words = dictionary ?? loadDictionary(wordsFile);
  const game = new AnagramsGame({
    dictionary: words,
    dictionaryName: 'NWL2023',
    minWordLength,
  });

  const app = express();
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self' ws: wss:; font-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    );
    next();
  });

  app.get('/api/health', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ok: true,
      phase: game.phase,
      players: game.getState().players.length,
      uptime: Math.round(process.uptime()),
    });
  });

  app.get('/api/info', (req, res) => {
    const info = buildJoinInfo(req, port);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      ...info,
      phase: game.phase,
      minWordLength: game.minWordLength,
      dictionary: { name: 'NWL2023', words: words.size },
      tileCount: game.initialTileLetters.length,
    });
  });

  app.get('/api/qr.svg', async (req, res) => {
    try {
      const { primaryUrl } = buildJoinInfo(req, port);
      const svg = await QRCode.toString(primaryUrl, {
        type: 'svg',
        margin: 1,
        width: 260,
        errorCorrectionLevel: 'M',
        color: { dark: '#2a1810', light: '#fff6e2' },
      });
      res.setHeader('Cache-Control', 'no-store');
      res.type('image/svg+xml').send(svg);
    } catch (error) {
      console.error('QR generation failed:', error);
      res.status(500).type('text/plain').send('Could not generate the QR code.');
    }
  });

  app.use(
    express.static(PUBLIC_DIR, {
      extensions: ['html'],
      etag: true,
      maxAge: 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('index.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  const server = createHttpServer(app);
  const wss = new WebSocketServer({
    server,
    maxPayload: MAX_MESSAGE_BYTES,
    clientTracking: true,
  });

  /** playerId -> Set<WebSocket> (a player may reconnect from more than one tab) */
  const playerSockets = new Map();
  /** playerId -> last submit timestamp, for a tiny anti-spam cooldown */
  const lastSubmitAt = new Map();

  const broadcastState = () => {
    for (const ws of wss.clients) {
      if (ws.readyState !== WebSocket.OPEN || !ws.playerId) continue;
      send(ws, { type: 'state', state: game.getState(ws.playerId) });
    }
  };

  const attachSocket = (ws, player) => {
    ws.playerId = player.id;
    if (!playerSockets.has(player.id)) playerSockets.set(player.id, new Set());
    playerSockets.get(player.id).add(ws);

    send(ws, {
      type: 'welcome',
      you: player.id,
      token: player.token,
      state: game.getState(player.id),
    });
    broadcastState();
  };

  const handleHello = (ws, message) => {
    if (ws.playerId) {
      sendError(ws, 'You are already at the table.');
      return;
    }
    const token = typeof message.token === 'string' ? message.token : '';
    const name = typeof message.name === 'string' ? message.name : '';
    const player = game.reconnect(token, name) ?? game.addPlayer(name);
    attachSocket(ws, player);
  };

  const handleClose = (ws) => {
    const playerId = ws.playerId;
    if (!playerId) return;
    const sockets = playerSockets.get(playerId);
    if (sockets) {
      sockets.delete(ws);
      if (sockets.size > 0) return;
      playerSockets.delete(playerId);
    }
    lastSubmitAt.delete(playerId);
    game.setConnected(playerId, false);
    broadcastState();
  };

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.playerId = null;

    const helloTimer = setTimeout(() => {
      if (!ws.playerId) ws.close(4001, 'Hello timeout');
    }, 15_000);

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch {
        sendError(ws, 'That message was not valid JSON.');
        return;
      }
      if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
        sendError(ws, 'Unknown message.');
        return;
      }

      if (message.type === 'hello') {
        clearTimeout(helloTimer);
        handleHello(ws, message);
        return;
      }

      if (!ws.playerId) {
        sendError(ws, 'Join the table first.');
        return;
      }

      switch (message.type) {
        case 'rename': {
          const result = game.rename(ws.playerId, message.name);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'config': {
          const result = game.setMinWordLength(ws.playerId, message.minWordLength);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'start': {
          const result = game.start(ws.playerId);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'restart': {
          const result = game.restart(ws.playerId);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'end': {
          const result = game.end(ws.playerId);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'reset': {
          const result = game.reset(ws.playerId);
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'remove': {
          const result = game.removePlayer(
            ws.playerId,
            typeof message.playerId === 'string' ? message.playerId : '',
          );
          if (!result.ok) sendError(ws, result.error);
          else broadcastState();
          break;
        }

        case 'submit': {
          const now = Date.now();
          const previous = lastSubmitAt.get(ws.playerId) ?? 0;
          if (now - previous < 120) {
            sendError(ws, 'Easy there, one word at a time.', 'rate');
            break;
          }
          lastSubmitAt.set(ws.playerId, now);

          const result = game.submit(
            ws.playerId,
            message.word,
            typeof message.stealWordId === 'string' ? message.stealWordId : null,
          );
          if (!result.ok) {
            sendError(ws, result.error, 'rejected');
            break;
          }

          send(ws, {
            type: 'accepted',
            word: result.word,
            steal: result.steal,
            ended: result.ended,
            revealerId: result.revealerId,
          });
          broadcastState();
          break;
        }

        case 'reveal': {
          const result = game.reveal(
            ws.playerId,
            typeof message.tileId === 'string' ? message.tileId : '',
          );
          if (!result.ok) {
            sendError(ws, result.error, 'rejected');
            break;
          }
          broadcastState();
          break;
        }

        default:
          sendError(ws, `Unknown action: ${message.type}`);
      }
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      handleClose(ws);
    });

    ws.on('error', () => {
      // The close event handles cleanup.
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch {
        // Ignore; the next tick or close event will clean it up.
      }
    }
  }, 30_000);

  const start = async () => {
    await new Promise((resolve, reject) => {
      const onError = (error) => {
        server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        server.off('error', onError);
        resolve();
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, host);
    });
    const actualPort = server.address().port;
    return { port: actualPort, urls: getLanAddresses().map((a) => `http://${a.address}:${actualPort}`) };
  };

  const stop = async () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    await new Promise((resolve) => wss.close(() => resolve()));
    if (server.listening) {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  };

  return { app, server, wss, game, dictionary: words, start, stop, buildJoinInfo };
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === pathToFileURL(fileURLToPath(import.meta.url)).href;

if (isMain) {
  const instance = createAppServer();
  let started;
  try {
    started = await instance.start();
  } catch (error) {
    if (error.code === 'EADDRINUSE') {
      console.error(
        `Port ${DEFAULT_PORT} is already in use. Try another one, for example:\n  PORT=3001 npm start`,
      );
    } else if (error.code === 'EACCES') {
      console.error(`Permission denied while opening port ${DEFAULT_PORT}. Try a port above 1024.`);
    } else {
      console.error(error);
    }
    process.exit(1);
  }

  const addresses = getLanAddresses();
  const { port: actualPort } = started;
  console.log('');
  console.log('  EVERYWORD BAGEL');
  console.log('  ===============');
  console.log(`  This device:  http://localhost:${actualPort}`);
  if (addresses.length > 0) {
    console.log('  Same Wi-Fi:');
    for (const { name, address } of addresses) {
      console.log(`    http://${address}:${actualPort}   (${name})`);
    }
  } else {
    console.log('  No LAN IPv4 address found. Connect to Wi-Fi or use a hotspot.');
  }
  console.log(`  Dictionary:   NWL2023, ${instance.dictionary.size.toLocaleString()} words`);
  console.log('');
  console.log('  On Windows, allow Node.js on private networks if the firewall asks.');
  console.log('  Press Ctrl+C to stop.');
  console.log('');

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n${signal} received. Closing the bagel...`);
    try {
      await instance.stop();
    } catch (error) {
      console.error('Error while shutting down:', error);
    }
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}
