const $ = (id) => document.getElementById(id);

const els = {
  phasePill: $('phase-pill'),
  phaseLabel: $('phase-label'),
  bagLeft: $('bag-left'),
  poolLeft: $('pool-left'),
  minLetters: $('min-letters'),
  inviteBtn: $('invite-btn'),
  rulesBtn: $('rules-btn'),
  soundBtn: $('sound-btn'),
  connBadge: $('conn-badge'),
  connText: $('conn-text'),

  lobbyStrip: $('lobby-strip'),
  revealStrip: $('reveal-strip'),
  revealText: $('reveal-text'),
  revealHint: $('reveal-hint'),
  board: $('board'),
  tiles: $('tiles'),
  ringGuides: document.querySelector('.ring-guides'),
  holeCount: $('hole-count'),
  holeMin: $('hole-min'),

  wordForm: $('word-form'),
  wordInput: $('word-input'),
  submitBtn: $('submit-btn'),
  wordHint: $('word-hint'),
  tilePreview: $('tile-preview'),
  stealBanner: $('steal-banner'),
  stealKicker: $('steal-kicker'),
  stealWord: $('steal-word'),
  stealFrom: $('steal-from'),
  stealName: $('steal-name'),
  clearSteal: $('clear-steal'),

  players: $('players'),
  playerCount: $('player-count'),
  feed: $('feed'),
  hostPanel: $('host-panel'),

  joinOverlay: $('join-overlay'),
  joinForm: $('join-form'),
  nameInput: $('name-input'),
  joinBtn: $('join-btn'),
  joinError: $('join-error'),
  joinUrl: $('join-url'),
  copyJoinUrl: $('copy-join-url'),
  joinQr: $('join-qr'),
  joinShareStatus: $('join-share-status'),
  joinDictionary: $('join-dictionary'),

  shareOverlay: $('share-overlay'),
  shareUrl: $('share-url'),
  copyShareUrl: $('copy-share-url'),
  shareQr: $('share-qr'),
  shareStatus: $('share-status'),
  networkList: $('network-list'),

  rulesOverlay: $('rules-overlay'),
  endOverlay: $('end-overlay'),
  endTitle: $('end-title'),
  endSub: $('end-sub'),
  endRanking: $('end-ranking'),
  endActions: $('end-actions'),
  confetti: $('confetti'),
  closeEnd: $('close-end'),

  toasts: $('toasts'),
};

const OVERLAY_IDS = ['join-overlay', 'share-overlay', 'rules-overlay', 'end-overlay'];
const SESSION_NAME_KEY = 'ewb.name';
const LOCAL_NAME_KEY = 'ewb.name';
const TOKEN_MAP_KEY = 'ewb.tokens';
const SOUND_KEY = 'ewb.sound';

const app = {
  state: null,
  me: null,
  name: '',
  ws: null,
  wsOpen: false,
  joinPending: false,
  joinTimer: null,
  reconnectTimer: null,
  reconnectAttempts: 0,
  pending: false,
  pendingTimer: null,
  previewReady: false,
  stealWordId: null,
  sound: true,
  audio: null,
  info: null,
  infoPromise: null,
  infoFetchedAt: 0,
  tileEls: new Map(),
  renderedRound: null,
  layoutRaf: 0,
  lastPhase: null,
  endShownRound: null,
  endDismissedRound: null,
};

// ---------- tiny storage helpers ----------

function storageGet(key, session = false) {
  try {
    return (session ? window.sessionStorage : window.localStorage).getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key, value, session = false) {
  try {
    (session ? window.sessionStorage : window.localStorage).setItem(key, value);
  } catch {
    // Private browsing or disabled storage: the game still works for this page load.
  }
}

function tokenMap() {
  try {
    const parsed = JSON.parse(storageGet(TOKEN_MAP_KEY) || '{}');
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function getToken(name) {
  const key = name.trim().toLowerCase();
  const sessionName = storageGet('ewb.tokenName', true);
  const sessionToken = storageGet('ewb.token', true);
  if (sessionName === key && sessionToken) return sessionToken;
  return tokenMap()[key] || '';
}

function rememberToken(name, token) {
  if (!name || !token) return;
  const key = name.trim().toLowerCase();
  storageSet('ewb.tokenName', key, true);
  storageSet('ewb.token', token, true);
  const map = tokenMap();
  map[key] = token;
  storageSet(TOKEN_MAP_KEY, JSON.stringify(map));
}

// ---------- small utilities ----------

function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function makeButton(label, className, onClick) {
  const node = make('button', className, label);
  node.type = 'button';
  node.addEventListener('click', onClick);
  return node;
}

function sanitizeName(value) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f<>]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 18);
}

function normalizeWord(value) {
  return String(value ?? '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 32);
}

function letterCounts(word) {
  const counts = Object.create(null);
  for (const letter of word) counts[letter] = (counts[letter] || 0) + 1;
  return counts;
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

function findWord(wordId) {
  if (!app.state || !wordId) return null;
  for (const player of app.state.players) {
    const entry = player.words.find((word) => word.id === wordId);
    if (entry) return { entry, player };
  }
  return null;
}

function plural(n, one, many = `${one}s`) {
  return n === 1 ? one : many;
}

function formatTime(timestamp) {
  try {
    return new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
}

// ---------- startup ----------

const sessionName = sanitizeName(storageGet(SESSION_NAME_KEY, true) || '');
const savedName = sanitizeName(storageGet(LOCAL_NAME_KEY) || '');

app.name = sessionName;
app.sound = storageGet(SOUND_KEY) !== 'off';

els.nameInput.value = sessionName || savedName;
updateSoundButton();
bindEvents();
updateBodyModal();

if ('ResizeObserver' in window) {
  new ResizeObserver(scheduleLayout).observe(els.board);
}
window.addEventListener('resize', scheduleLayout);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && app.name && !app.wsOpen) connect();
});
window.addEventListener('online', () => {
  if (app.name && !app.wsOpen) connect();
});

refreshInfo();

if (sessionName) {
  beginJoin(sessionName, { auto: true });
} else {
  openOverlay('join-overlay', '#name-input');
  requestAnimationFrame(() => els.nameInput.focus());
}

// ---------- connection ----------

function setConnection(state) {
  els.connBadge.dataset.state = state;
  els.connText.textContent =
    state === 'online' ? 'Live' : state === 'offline' ? 'Offline' : 'Connecting';
  els.connBadge.title =
    state === 'online'
      ? 'Connected to the table'
      : state === 'offline'
        ? 'Connection lost — trying to reconnect'
        : 'Connecting to the table';
}

function sendHello() {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) return;
  app.ws.send(JSON.stringify({ type: 'hello', token: getToken(app.name), name: app.name }));
}

function connect() {
  if (!app.name) return;
  clearTimeout(app.reconnectTimer);

  if (app.ws && app.ws.readyState === WebSocket.OPEN) {
    sendHello();
    return;
  }
  if (app.ws && app.ws.readyState === WebSocket.CONNECTING) return;

  setConnection('connecting');
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  try {
    ws = new WebSocket(`${protocol}//${location.host}`);
  } catch {
    onSocketClosed();
    return;
  }
  app.ws = ws;

  ws.addEventListener('open', () => {
    if (app.ws !== ws) return;
    app.wsOpen = true;
    app.reconnectAttempts = 0;
    setConnection('online');
    sendHello();
  });

  ws.addEventListener('message', (event) => {
    if (app.ws !== ws) return;
    handleMessage(event.data);
  });

  ws.addEventListener('close', () => {
    if (app.ws !== ws) return;
    app.ws = null;
    app.wsOpen = false;
    setConnection('offline');
    onSocketClosed();
  });

  ws.addEventListener('error', () => {
    // The close event is the single cleanup path.
  });
}

function onSocketClosed() {
  if (!app.state) {
    app.joinPending = false;
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = 'Pull up a chair';
    showJoinError('Could not reach the table. Check that everyone is on the same Wi-Fi, then try again.');
    openOverlay('join-overlay', '#join-btn');
  } else if (app.reconnectAttempts === 0) {
    toast('Connection lost. Reconnecting…', 'error', 3200);
  }
  scheduleReconnect();
}

function scheduleReconnect() {
  if (!app.name) return;
  clearTimeout(app.reconnectTimer);
  app.reconnectAttempts += 1;
  const delay = Math.min(700 + app.reconnectAttempts * 450, 5000);
  app.reconnectTimer = setTimeout(() => {
    if (!app.wsOpen) connect();
  }, delay);
}

function beginJoin(name, { auto = false } = {}) {
  app.name = name;
  storageSet(SESSION_NAME_KEY, name, true);
  storageSet(LOCAL_NAME_KEY, name);
  clearJoinError();

  app.joinPending = true;
  els.joinBtn.disabled = true;
  els.joinBtn.textContent = 'Joining...';
  if (!auto) closeOverlay('join-overlay');

  clearTimeout(app.joinTimer);
  app.joinTimer = setTimeout(() => {
    if (!app.state) {
      app.joinPending = false;
      els.joinBtn.disabled = false;
      els.joinBtn.textContent = 'Pull up a chair';
      showJoinError('No answer from the table. Check the same Wi-Fi and try again.');
      openOverlay('join-overlay', '#join-btn');
    }
  }, 9000);

  connect();
}

function handleMessage(raw) {
  let message;
  try {
    message = JSON.parse(raw);
  } catch {
    return;
  }
  if (!message || typeof message !== 'object') return;

  if (message.type === 'welcome') {
    clearTimeout(app.joinTimer);
    app.joinPending = false;
    els.joinBtn.disabled = false;
    els.joinBtn.textContent = 'Pull up a chair';
    clearJoinError();

    app.me = message.you;
    const me = message.state.players.find((player) => player.id === message.you);
    if (me) {
      app.name = me.name;
      storageSet(SESSION_NAME_KEY, app.name, true);
      storageSet(LOCAL_NAME_KEY, app.name);
      rememberToken(app.name, message.token);
    } else {
      rememberToken(app.name, message.token);
    }

    closeOverlay('join-overlay');
    setConnection('online');
    applyState(message.state, { welcome: true });
    return;
  }

  if (message.type === 'state' && message.state) {
    applyState(message.state);
    return;
  }

  if (message.type === 'accepted') {
    handleAccepted(message);
    return;
  }

  if (message.type === 'error') {
    handleServerError(message);
  }
}

function applyState(nextState, { welcome = false } = {}) {
  const prev = app.state;
  const roundChanged = prev && prev.round !== nextState.round;
  const phaseChanged = !prev || prev.phase !== nextState.phase;

  app.state = nextState;

  const me = nextState.players.find((player) => player.id === app.me);
  if (me && me.name !== app.name) {
    const existingToken = storageGet('ewb.token', true);
    app.name = me.name;
    storageSet(SESSION_NAME_KEY, app.name, true);
    storageSet(LOCAL_NAME_KEY, app.name);
    if (existingToken) rememberToken(app.name, existingToken);
    if (els.nameInput.value !== app.name) els.nameInput.value = app.name;
  }

  if (phaseChanged || roundChanged) {
    app.stealWordId = null;
    app.pending = false;
    clearTimeout(app.pendingTimer);
    els.wordInput.value = '';
  }

  if (app.stealWordId) {
    const target = findWord(app.stealWordId);
    if (!target) {
      app.stealWordId = null;
      els.wordInput.value = '';
      if (!welcome) toast('That word was taken before you could steal it.', 'error', 2600);
    }
  }

  if (roundChanged) {
    app.endDismissedRound = null;
    app.endShownRound = null;
  }

  render();

  if (phaseChanged || roundChanged) {
    if (nextState.phase === 'playing') {
      closeOverlay('end-overlay');
      app.endShownRound = null;
      if (prev && prev.phase !== 'playing') playSound('start');
      maybeFocusInput();
    } else if (nextState.phase === 'lobby') {
      closeOverlay('end-overlay');
      app.endShownRound = null;
    } else if (nextState.phase === 'ended') {
      if (prev && prev.phase !== 'ended') playSound('end');
      showEndOverlay(nextState);
    }
  } else if (nextState.phase === 'ended') {
    showEndOverlay(nextState);
  }

  app.lastPhase = nextState.phase;
}

function handleAccepted(message) {
  app.pending = false;
  clearTimeout(app.pendingTimer);
  app.stealWordId = null;
  els.wordInput.value = '';
  els.stealBanner.hidden = true;
  els.submitBtn.textContent = 'Claim';

  if (message.steal) {
    const self = Boolean(message.steal.self);
    toast(
      self
        ? `Rebuilt ${message.steal.word} → ${message.word.word} (+${message.steal.added}). You reveal next.`
        : `Stole ${message.steal.word} from ${message.steal.from} → ${message.word.word}. You reveal next.`,
      'success',
      4200,
    );
    playSound('steal');
  } else {
    toast(`Claimed ${message.word.word} (+${message.word.length})`, 'success', 2800);
    playSound('claim');
  }

  renderPlayers();
  renderWordbar();
  maybeFocusInput();
}

function handleServerError(message) {
  app.pending = false;
  clearTimeout(app.pendingTimer);
  els.submitBtn.disabled = app.state?.phase !== 'playing';
  shakeWordbar();
  playSound('error');

  if (/no longer on the table/i.test(message.message || '')) {
    app.stealWordId = null;
    els.wordInput.value = '';
    render();
  } else {
    updatePreview();
  }

  toast(message.message || 'That move did not work.', 'error', 4200);
}

function maybeFocusInput() {
  if (!window.matchMedia('(pointer: fine)').matches) return;
  if (document.body.classList.contains('modal-open')) return;
  if (app.state?.phase !== 'playing') return;
  setTimeout(() => els.wordInput.focus(), 90);
}

// ---------- rendering ----------

function render() {
  if (!app.state) {
    renderEmptyState();
    return;
  }
  renderHeader();
  renderBoard();
  renderPlayers();
  renderFeed();
  renderHostPanel();
  renderLobbyStrip();
  renderRevealStrip();
  renderWordbar();
  if (app.state.phase === 'ended') renderEndContent();
}

function renderEmptyState() {
  els.bagLeft.textContent = '—';
  els.poolLeft.textContent = '—';
  els.holeCount.textContent = '—';
  els.holeMin.textContent = 'connecting';
  els.playerCount.textContent = '0';
}

function renderHeader() {
  const state = app.state;
  document.body.dataset.phase = state.phase;
  els.phasePill.dataset.phase = state.phase;
  els.phaseLabel.textContent =
    state.phase === 'playing' ? 'Round live' : state.phase === 'ended' ? 'Round over' : 'Lobby';
  els.bagLeft.textContent = String(state.bag.length);
  els.poolLeft.textContent = String(state.center.length);
  els.holeCount.textContent = String(state.center.length);
  els.minLetters.textContent = String(state.minWordLength);
  els.holeMin.textContent = `${state.minWordLength}+ letters`;
}

function renderBoard() {
  const state = app.state;
  if (app.renderedRound !== state.round) {
    app.renderedRound = state.round;
    app.tileEls.clear();
    els.tiles.replaceChildren();
  }

  const bagIds = new Set(state.bag.map((tile) => tile.id));
  const centerIds = new Set(state.center.map((tile) => tile.id));

  // Tiles that were claimed or stolen are no longer on the board.
  for (const [id, node] of app.tileEls) {
    if (!bagIds.has(id) && !centerIds.has(id)) {
      node.remove();
      app.tileEls.delete(id);
    }
  }

  const canReveal = state.phase === 'playing' && state.revealerId === app.me;

  // Face-down tiles. Their letters are not in the DOM at all.
  state.bag.forEach((tile, index) => {
    let node = app.tileEls.get(tile.id);
    if (!node) {
      node = make('button', 'tile is-hidden');
      node.type = 'button';
      node.dataset.tileId = tile.id;
      node.style.animationDelay = `${Math.min(index * 3, 240)}ms`;
      node.classList.add('is-entering');
      setTimeout(() => node.classList.remove('is-entering'), 700);
      node.addEventListener('click', () => onTileClick(tile.id));
      els.tiles.append(node);
      app.tileEls.set(tile.id, node);
    }
    if (!node.classList.contains('is-hidden')) {
      node.classList.add('is-hidden');
      node.classList.remove('is-pool', 'is-vowel', 'is-used');
      node.textContent = '';
    }
    node.disabled = !canReveal;
    node.setAttribute('aria-label', canReveal ? 'Reveal this face-down tile' : 'Face-down tile');
    node.title = canReveal ? 'Reveal this tile' : 'Face-down tile';
  });

  // Face-up tiles in the middle. Only these can be added to a word.
  state.center.forEach((tile, index) => {
    let node = app.tileEls.get(tile.id);
    if (!node) {
      node = make('button', 'tile is-pool', tile.letter);
      node.type = 'button';
      node.dataset.tileId = tile.id;
      node.style.animationDelay = `${Math.min(index * 3, 200)}ms`;
      node.classList.add('is-entering');
      setTimeout(() => node.classList.remove('is-entering'), 700);
      node.addEventListener('click', () => onTileClick(tile.id));
      els.tiles.append(node);
      app.tileEls.set(tile.id, node);
    }
    if (node.classList.contains('is-hidden')) {
      node.classList.remove('is-hidden');
      node.classList.add('is-pool', 'is-flipping');
      setTimeout(() => node.classList.remove('is-flipping'), 560);
    }
    if (node.textContent !== tile.letter) node.textContent = tile.letter;
    node.disabled = false;
    node.classList.toggle('is-vowel', 'AEIOU'.includes(tile.letter));
    node.setAttribute('aria-label', `Add the letter ${tile.letter}`);
    node.title = `Add ${tile.letter}`;
  });

  scheduleLayout();
}

function bagFractions(count) {
  if (count <= 0) return [];
  if (count <= 26) return [1];
  if (count <= 54) return [0.9, 1];
  return [0.8, 0.9, 1];
}

function poolFractions(count) {
  if (count <= 0) return [];
  if (count === 1) return [0];
  if (count <= 6) return [0.3];
  if (count <= 14) return [0.3, 0.46];
  if (count <= 26) return [0.26, 0.4, 0.54];
  if (count <= 44) return [0.24, 0.36, 0.48, 0.6];
  return [0.22, 0.32, 0.42, 0.52, 0.62];
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scheduleLayout() {
  if (app.layoutRaf) return;
  app.layoutRaf = requestAnimationFrame(() => {
    app.layoutRaf = 0;
    layoutTiles();
  });
}

function layoutTiles() {
  if (!app.state) return;
  const size = els.board.clientWidth;
  if (!size) return;

  const state = app.state;
  const bagBase = clamp(size * 0.058, 18, 36);
  const poolBase = clamp(size * 0.055, 16, 34);
  const rMax = size / 2 - Math.max(12, bagBase / 2 + 4);

  const bagFracs = bagFractions(state.bag.length);
  layoutGroup(state.bag, bagFracs, {
    size,
    rMax,
    baseSize: bagBase,
    minSize: 14,
    angleOffset: -Math.PI / 2,
    ringStagger: 0.18,
  });

  const poolFracs = poolFractions(state.center.length);
  layoutGroup(state.center, poolFracs, {
    size,
    rMax,
    baseSize: poolBase,
    minSize: 12,
    angleOffset: -Math.PI / 2 + 0.2,
    ringStagger: 0.35,
  });

  const guides = [...els.ringGuides.querySelectorAll('span')];
  guides.forEach((guide, index) => {
    const fraction = bagFracs[bagFracs.length - 1 - index];
    if (!fraction) {
      guide.hidden = true;
      return;
    }
    guide.hidden = false;
    guide.style.width = `${rMax * fraction * 2}px`;
    guide.style.height = `${rMax * fraction * 2}px`;
  });
}

/**
 * Distribute tiles across one or more rings, shrinking them until they fit.
 * `fractions` are radii as a fraction of rMax, outermost last.
 */
function layoutGroup(tiles, fractions, { size, rMax, baseSize, minSize, angleOffset, ringStagger }) {
  if (tiles.length === 0 || fractions.length === 0) return;

  const ringCapacity = (fraction, tileSize) =>
    fraction === 0
      ? 1
      : Math.max(1, Math.floor((Math.PI * 2 * rMax * fraction) / (tileSize * 1.06)));

  let tileSize = baseSize;
  while (tileSize > minSize) {
    let capacity = 0;
    for (const fraction of fractions) capacity += ringCapacity(fraction, tileSize);
    if (capacity >= tiles.length) break;
    tileSize -= 1;
  }

  const capacities = fractions.map((fraction) => ringCapacity(fraction, tileSize));
  const totalCapacity = capacities.reduce((sum, value) => sum + value, 0);
  const raw = capacities.map((capacity) => (tiles.length * capacity) / totalCapacity);
  const counts = raw.map((value) => Math.floor(value));
  const remainder = tiles.length - counts.reduce((sum, value) => sum + value, 0);
  const byRemainder = raw
    .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
    .sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < remainder; i += 1) {
    counts[byRemainder[i % byRemainder.length].index] += 1;
  }

  let cursor = 0;
  for (let ring = 0; ring < fractions.length; ring += 1) {
    const ringCount = counts[ring];
    if (ringCount <= 0) continue;
    const radius = rMax * fractions[ring];
    for (let i = 0; i < ringCount; i += 1) {
      const tile = tiles[cursor];
      cursor += 1;
      if (!tile) continue;
      const node = app.tileEls.get(tile.id);
      if (!node) continue;
      node.style.setProperty('--tile-size', `${tileSize}px`);
      if (radius === 0) {
        node.style.left = `${size / 2}px`;
        node.style.top = `${size / 2}px`;
        continue;
      }
      const angle =
        angleOffset + ring * ringStagger + ((i + 0.5) * (Math.PI * 2)) / ringCount;
      node.style.left = `${size / 2 + Math.cos(angle) * radius}px`;
      node.style.top = `${size / 2 + Math.sin(angle) * radius}px`;
    }
  }
}

function renderRevealStrip() {
  const state = app.state;
  if (!state || state.phase !== 'playing') {
    els.revealStrip.hidden = true;
    els.board.classList.remove('is-my-reveal');
    return;
  }

  const mine = state.revealerId === app.me;
  const revealer = state.players.find((player) => player.id === state.revealerId);
  els.revealStrip.hidden = false;
  els.revealStrip.classList.toggle('is-mine', mine);
  els.board.classList.toggle('is-my-reveal', mine);

  els.revealText.replaceChildren();
  if (mine) {
    els.revealText.append(
      make('strong', null, 'Your turn to reveal.'),
      document.createTextNode(' Tap a face-down tile.'),
    );
  } else {
    els.revealText.append(
      make('strong', null, revealer?.name ?? 'Another player'),
      document.createTextNode(' is choosing a tile to reveal.'),
    );
  }
  els.revealHint.textContent = `${state.bag.length} down · ${state.center.length} up`;
}

function renderPlayers() {
  const state = app.state;
  if (!state) return;

  const iAmHost = state.hostId === app.me;
  const fragment = document.createDocumentFragment();

  // Your own row always sits at the top of the table list.
  const players = [...state.players].sort((a, b) => {
    if (a.id === app.me) return -1;
    if (b.id === app.me) return 1;
    return 0;
  });

  for (const player of players) {
    const card = make('div', 'player');
    if (player.id === app.me) card.classList.add('is-you');
    if (!player.connected) card.classList.add('is-offline');
    card.style.setProperty('--pc', player.color);

    const head = make('div', 'player-head');
    const name = make('span', 'player-name', player.name);
    name.title = player.name;
    head.append(name);

    if (player.isHost) head.append(make('span', 'p-tag host', 'host'));
    if (player.id === app.me) head.append(make('span', 'p-tag you', 'you'));
    if (!player.connected) head.append(make('span', 'p-tag offline', 'offline'));

    const score = make('span', 'player-score');
    score.append(document.createTextNode(String(player.score)), make('small', null, 'letters'));
    score.title = `${player.score} letters in ${player.wordCount} ${plural(player.wordCount, 'word')}`;
    head.append(score);

    if (iAmHost && state.phase === 'lobby' && !player.connected && player.id !== app.me) {
      const remove = makeButton('×', 'remove-player', () => removePlayer(player.id, player.name));
      remove.setAttribute('aria-label', `Remove ${player.name}`);
      remove.title = `Remove ${player.name}`;
      head.append(remove);
    }

    card.append(head);

    const words = make('div', 'words');
    if (player.words.length === 0) {
      words.append(
        make('span', 'no-words', state.phase === 'lobby' ? 'Ready' : 'No words yet'),
      );
    } else {
      for (const entry of player.words) {
        const mine = player.id === app.me;
        // Every word is tappable now, including your own: a tap pre-fills the
        // steal box, but typing the extended word steals without a tap.
        const chip = makeButton(entry.word, mine ? 'word-chip is-mine' : 'word-chip', () =>
          selectSteal(entry.id),
        );
        chip.dataset.wordId = entry.id;

        if (entry.selfStolen) {
          chip.title = entry.previous
            ? `You rebuilt ${entry.previous} as ${entry.word}`
            : 'You rebuilt this word';
          chip.append(make('span', 'stolen-mark', '*'));
        } else if (entry.stolenFrom) {
          chip.title = `Stolen from ${entry.stolenFrom}${
            entry.previous ? ` (was ${entry.previous})` : ''
          }`;
          chip.append(make('span', 'stolen-mark', '*'));
        } else if (mine) {
          chip.title = 'Rebuild or extend your word';
        } else {
          chip.title = `Steal ${entry.word} from ${player.name}`;
        }

        if (entry.id === app.stealWordId) chip.classList.add('is-steal-target');
        words.append(chip);
      }
    }
    card.append(words);
    fragment.append(card);
  }

  els.players.replaceChildren(fragment);
  els.playerCount.textContent = String(state.players.length);
}

function renderFeed() {
  const state = app.state;
  if (!state) return;
  const fragment = document.createDocumentFragment();
  const entries = state.log.slice(0, 40);

  if (entries.length === 0) {
    const empty = make('li', 'feed-empty', 'The table is quiet. Start a round.');
    fragment.append(empty);
  }

  for (const entry of entries) {
    const item = make('li');
    item.dataset.kind = entry.kind;
    const text = make('div', 'feed-text');
    text.append(make('span', null, entry.text));
    const time = make('time', null, formatTime(entry.at));
    try {
      time.dateTime = new Date(entry.at).toISOString();
    } catch {
      // Ignore invalid timestamps.
    }
    text.append(time);
    item.append(make('span', 'feed-dot'), text);
    fragment.append(item);
  }

  els.feed.replaceChildren(fragment);
}

function renderLobbyStrip() {
  const state = app.state;
  if (!state || state.phase !== 'lobby') {
    els.lobbyStrip.hidden = true;
    els.lobbyStrip.replaceChildren();
    return;
  }

  els.lobbyStrip.hidden = false;
  const fragment = document.createDocumentFragment();
  const iAmHost = state.hostId === app.me;
  const host = state.players.find((player) => player.id === state.hostId);

  if (iAmHost) {
    fragment.append(make('strong', null, "You're the host."));
    fragment.append(document.createTextNode(' Start when everyone is here.'));
    fragment.append(makeButton('Invite', 'ghost-btn small', openShare));
    fragment.append(makeButton('Start round', 'primary-btn', startRound));
  } else {
    fragment.append(make('strong', null, host?.name ?? 'The host'));
    fragment.append(document.createTextNode(' will open the bagel when everyone is here.'));
    fragment.append(makeButton('Invite', 'ghost-btn small', openShare));
    fragment.append(make('span', 'spinner'));
  }

  els.lobbyStrip.replaceChildren(fragment);
}

function renderHostPanel() {
  const state = app.state;
  const panel = els.hostPanel;
  if (!state) {
    panel.replaceChildren();
    return;
  }

  const iAmHost = state.hostId === app.me;
  const host = state.players.find((player) => player.id === state.hostId);
  const fragment = document.createDocumentFragment();
  fragment.append(make('h2', null, iAmHost ? 'Host controls' : 'Round controls'));

  const totalWords = state.players.reduce((sum, player) => sum + player.wordCount, 0);

  if (state.phase === 'lobby') {
    fragment.append(
      make(
        'p',
        'host-copy',
        iAmHost
          ? 'Everyone here? Set the minimum and open the bagel.'
          : `${host?.name ?? 'The host'} can start once everyone is ready.`,
      ),
    );
    appendMinSetting(fragment, state, iAmHost);
    if (iAmHost) {
      const actions = make('div', 'host-actions');
      actions.append(makeButton('Start round', 'primary-btn', startRound));
      fragment.append(actions);
      fragment.append(
        make(
          'p',
          'host-tip',
          'All 98 tiles start face down. Players take turns revealing one into the middle. The round ends when every tile has been used or you call time.',
        ),
      );
    } else {
      fragment.append(
        hostWait('Waiting for the host to start the round.'),
      );
    }
  } else if (state.phase === 'playing') {
    fragment.append(
      make(
        'p',
        'host-copy',
        `${state.bag.length} face down · ${state.center.length} face up. ${totalWords} ${plural(
          totalWords,
          'word',
        )} on the table.`,
      ),
    );
    appendMinSetting(fragment, state, false);
    if (iAmHost) {
      const actions = make('div', 'host-actions');
      const end = makeButton('End round', 'ghost-btn danger', endRound);
      end.title = 'End the round for everyone';
      actions.append(end);
      fragment.append(actions);
      fragment.append(
        make('p', 'host-tip', 'Call time when the bagel gets stuck or the room gets rowdy.'),
      );
    } else {
      fragment.append(hostWait('Only the host can call time.'));
    }
  } else {
    fragment.append(
      make('p', 'host-copy', 'Round over. Check the results, then run it back.'),
    );
    appendMinSetting(fragment, state, iAmHost);

    const actions = make('div', 'host-actions');
    actions.append(
      makeButton('Show results', 'ghost-btn', () => showEndOverlay(state, true)),
    );
    if (iAmHost) {
      actions.append(makeButton('Play again', 'primary-btn', restartRound));
      actions.append(makeButton('Back to lobby', 'ghost-btn', resetToLobby));
    } else {
      actions.append(make('p', 'end-wait', 'Waiting for the host to start the next round…'));
    }
    fragment.append(actions);
  }

  const dictionary = state.dictionary ?? { name: 'NWL2023', words: 0 };
  fragment.append(
    make(
      'p',
      'host-tip',
      `Dictionary: ${dictionary.name} · ${Number(dictionary.words).toLocaleString()} words.`,
    ),
  );

  const nameBtn = makeButton('Change my name', 'ghost-btn small', renameMe);
  nameBtn.style.marginTop = '10px';
  fragment.append(nameBtn);

  panel.replaceChildren(fragment);
}

function appendMinSetting(fragment, state, canEdit) {
  const row = make('div', 'host-setting');
  const label = make('label', null, 'Minimum word length');
  label.htmlFor = 'min-select';
  row.append(label);

  if (canEdit) {
    const select = make('select');
    select.id = 'min-select';
    for (const value of [3, 4, 5, 6, 7]) {
      const option = make('option', null, `${value} letters`);
      option.value = String(value);
      select.append(option);
    }
    select.value = String(state.minWordLength);
    select.addEventListener('change', () => send({ type: 'config', minWordLength: Number(select.value) }));
    row.append(select);
  } else {
    row.append(make('span', 'muted', `${state.minWordLength} letters`));
  }
  fragment.append(row);
}

function hostWait(text) {
  const node = make('div', 'host-wait');
  node.append(make('span', 'spinner'), document.createTextNode(text));
  return node;
}

// ---------- word bar and preview ----------

function renderWordbar() {
  const state = app.state;
  const playing = state?.phase === 'playing';

  els.wordInput.disabled = !playing;
  refreshStealUi();
  els.wordInput.placeholder = playing
    ? app.stealWordId
      ? 'Build the new word...'
      : 'Type a word...'
    : state?.phase === 'ended'
      ? 'Round over'
      : 'Waiting for the host...';

  if (!playing) {
    clearUsedTiles();
    setHint(
      state?.phase === 'ended'
        ? 'The round is over. Check the results.'
        : 'The host will start the round when everyone is ready.',
    );
    els.tilePreview.textContent = '';
    els.submitBtn.disabled = true;
    app.previewReady = false;
    return;
  }

  updatePreview();
}

/** Label the button and banner from the current steal target, if any. */
function refreshStealUi() {
  const state = app.state;
  const playing = state?.phase === 'playing';
  const target = app.stealWordId ? findWord(app.stealWordId) : null;
  const showSteal = Boolean(playing && target);
  if (app.stealWordId && !showSteal) app.stealWordId = null;

  const selfTarget = Boolean(target && target.player.id === app.me);
  els.submitBtn.textContent = app.stealWordId ? (selfTarget ? 'Rebuild' : 'Steal') : 'Claim';
  els.stealBanner.hidden = !showSteal;
  for (const chip of els.players.querySelectorAll('.word-chip[data-word-id]')) {
    chip.classList.toggle('is-steal-target', chip.dataset.wordId === app.stealWordId);
  }
  if (!showSteal || !target) return;

  els.stealKicker.textContent = selfTarget ? 'Rebuilding' : 'Stealing';
  els.stealWord.textContent = target.entry.word;
  els.stealFrom.hidden = selfTarget;
  els.stealName.hidden = selfTarget;
  els.stealName.textContent = target.player.name;
}

function updatePreview() {
  clearUsedTiles();
  const state = app.state;
  if (!state || state.phase !== 'playing') {
    app.previewReady = false;
    return;
  }

  const word = normalizeWord(els.wordInput.value);
  let target = app.stealWordId ? findWord(app.stealWordId) : null;

  if (app.stealWordId && !target) app.stealWordId = null;

  // Typing an extended word steals automatically; no tap on a word is needed.
  if (word) {
    const auto = findAutoSteal(word);
    if (auto) {
      target = auto;
      app.stealWordId = auto.entry.id;
    } else if (!target) {
      app.stealWordId = null;
    }
  }

  refreshStealUi();

  const selfTarget = Boolean(target && target.player.id === app.me);
  const action = selfTarget ? 'Rebuild' : 'Steal';

  if (!word) {
    setHint(
      target
        ? `${action} ${target.entry.word}: add at least one face-up letter and rearrange.`
        : state.center.length === 0
          ? 'No face-up tiles yet. Tap a face-down tile when it is your turn to reveal.'
          : 'Type a word using the face-up tiles in the middle.',
    );
    els.tilePreview.textContent = target ? `target: ${target.entry.word}` : '';
    els.submitBtn.disabled = true;
    app.previewReady = false;
    return;
  }

  const wordCounts = letterCounts(word);
  let required = wordCounts;
  let extra = 0;

  if (target) {
    const targetCounts = letterCounts(target.entry.word);
    const missingTarget = missingLetters(targetCounts, wordCounts);
    if (missingTarget.length > 0) {
      setHint(`Keep every letter from ${target.entry.word}.`, 'is-bad');
      els.tilePreview.textContent = '';
      els.submitBtn.disabled = true;
      app.previewReady = false;
      return;
    }
    required = subtractCounts(wordCounts, targetCounts);
    extra = countTotal(required);
    if (extra < 1) {
      setHint(`Add at least one face-up letter to ${selfTarget ? 'rebuild' : 'steal'} ${target.entry.word}.`, 'is-bad');
      els.tilePreview.textContent = '';
      els.submitBtn.disabled = true;
      app.previewReady = false;
      return;
    }
  }

  const missing = markRequiredTiles(required);
  const longEnough = word.length >= state.minWordLength;

  if (missing.length > 0) {
    setHint(`The middle is missing ${describeMissing(missing)}.`, 'is-bad');
    els.tilePreview.textContent = '';
    els.submitBtn.disabled = true;
    app.previewReady = false;
    return;
  }

  if (!longEnough) {
    const short = state.minWordLength - word.length;
    setHint(`Add ${short} more ${plural(short, 'letter')}.`, 'is-bad');
    els.tilePreview.textContent = `${extra || word.length} from middle`;
    els.submitBtn.disabled = true;
    app.previewReady = false;
    return;
  }

  setHint(
    target
      ? `${action} ${target.entry.word} → ${word}. Uses ${extra} ${plural(extra, 'letter')} from the middle.`
      : `Uses ${word.length} ${plural(word.length, 'tile')} from the middle.`,
    'is-good',
  );
  els.tilePreview.textContent = target ? `${extra} + target` : `${word.length} tiles`;
  els.submitBtn.disabled = app.pending;
  app.previewReady = true;
}

/**
 * Mirror of the server's automatic steal lookup. Returns a table word that the
 * typed word extends with face-up tiles, or null when the middle can make the
 * word by itself. Own words are included.
 */
function findAutoSteal(word) {
  const state = app.state;
  if (!state || !word) return null;
  const wordCounts = letterCounts(word);
  const centerCounts = letterCounts(state.center.map((tile) => tile.letter));
  if (missingLetters(wordCounts, centerCounts).length === 0) return null;

  let best = null;
  for (const player of state.players) {
    for (const entry of player.words) {
      const targetCounts = letterCounts(entry.word);
      if (missingLetters(targetCounts, wordCounts).length > 0) continue;

      const required = subtractCounts(wordCounts, targetCounts);
      if (countTotal(required) < 1) continue;
      if (missingLetters(required, centerCounts).length > 0) continue;

      if (!best || entry.word.length > best.entry.word.length) {
        best = { entry, player, required };
      }
    }
  }
  return best;
}

function markRequiredTiles(required) {
  const state = app.state;
  if (!state) return [];
  const remaining = { ...required };
  for (const tile of state.center) {
    if ((remaining[tile.letter] || 0) > 0) {
      const node = app.tileEls.get(tile.id);
      if (node) {
        node.classList.add('is-used');
        remaining[tile.letter] -= 1;
      }
    }
  }

  const missing = [];
  for (const [letter, count] of Object.entries(remaining)) {
    for (let i = 0; i < count; i += 1) missing.push(letter);
  }
  return missing;
}

function clearUsedTiles() {
  for (const node of app.tileEls.values()) node.classList.remove('is-used');
}

function setHint(text, kind = '') {
  els.wordHint.textContent = text;
  els.wordHint.className = kind;
}

// ---------- actions ----------

function onTileClick(tileId) {
  const state = app.state;
  if (!state || state.phase !== 'playing' || app.pending) return;

  const bagTile = state.bag.find((tile) => tile.id === tileId);
  if (bagTile) {
    if (state.revealerId !== app.me) {
      const revealer = state.players.find((player) => player.id === state.revealerId);
      toast(`${revealer?.name ?? 'Another player'} has the reveal right now.`, 'error', 2200);
      return;
    }
    if (send({ type: 'reveal', tileId })) playSound('tick');
    return;
  }

  const poolTile = state.center.find((tile) => tile.id === tileId);
  if (!poolTile) return;
  els.wordInput.value = normalizeWord(`${els.wordInput.value}${poolTile.letter}`);
  els.wordInput.focus();
  updatePreview();
  playSound('tick');
}

function onWordInput() {
  const clean = normalizeWord(els.wordInput.value);
  if (els.wordInput.value !== clean) els.wordInput.value = clean;
  updatePreview();
}

function onSubmit(event) {
  event.preventDefault();
  if (app.state?.phase !== 'playing' || app.pending) return;

  if (!els.wordInput.value) {
    shakeWordbar();
    els.wordInput.focus();
    toast('Type a word first.', 'error', 2000);
    return;
  }

  if (!app.previewReady) {
    shakeWordbar();
    els.wordInput.focus();
    toast(els.wordHint.textContent || 'That word is not ready yet.', 'error', 2600);
    return;
  }

  app.pending = true;
  els.submitBtn.disabled = true;
  const sent = send({
    type: 'submit',
    word: normalizeWord(els.wordInput.value),
    stealWordId: app.stealWordId,
  });
  if (!sent) {
    app.pending = false;
    els.submitBtn.disabled = false;
    return;
  }

  clearTimeout(app.pendingTimer);
  app.pendingTimer = setTimeout(() => {
    if (!app.pending) return;
    app.pending = false;
    els.submitBtn.disabled = false;
    updatePreview();
    toast('The server did not answer. Try that again.', 'error', 3200);
  }, 3200);
}

function selectSteal(wordId) {
  if (app.state?.phase !== 'playing') return;
  const found = findWord(wordId);
  if (!found) {
    toast('That word is no longer on the table.', 'error', 2400);
    return;
  }
  if (app.stealWordId === wordId) {
    clearStealTarget();
    return;
  }

  app.stealWordId = wordId;
  els.wordInput.value = '';
  renderPlayers();
  renderWordbar();
  els.wordInput.focus();
  playSound('tick');
}

function clearStealTarget() {
  if (!app.stealWordId) {
    els.wordInput.value = '';
    updatePreview();
    return;
  }
  app.stealWordId = null;
  els.wordInput.value = '';
  renderPlayers();
  renderWordbar();
}

function send(payload) {
  if (!app.ws || app.ws.readyState !== WebSocket.OPEN) {
    toast('Not connected to the table yet.', 'error', 2600);
    return false;
  }
  app.ws.send(JSON.stringify(payload));
  return true;
}

function startRound() {
  send({ type: 'start' });
}

function restartRound() {
  send({ type: 'restart' });
}

function endRound() {
  send({ type: 'end' });
}

function resetToLobby() {
  send({ type: 'reset' });
}

function removePlayer(playerId, name) {
  if (!window.confirm(`Remove ${name} from the table?`)) return;
  send({ type: 'remove', playerId });
}

function renameMe() {
  const next = window.prompt('What should we call you?', app.name);
  if (next == null) return;
  const clean = sanitizeName(next);
  if (!clean) {
    toast('Pick a name with at least one character.', 'error', 2600);
    return;
  }
  send({ type: 'rename', name: clean });
}

// ---------- end of round ----------

function showEndOverlay(state = app.state, force = false) {
  if (!state || state.phase !== 'ended') return;
  if (!force && app.endDismissedRound === state.round) return;
  if (!force && app.endShownRound === state.round && !els.endOverlay.hidden) return;

  renderEndContent();
  app.endShownRound = state.round;
  const focusSelector =
    state.hostId === app.me ? '#end-actions .primary-btn' : '#end-actions .end-wait, #close-end';
  openOverlay('end-overlay', focusSelector);
  burstConfetti();
}

function dismissEnd() {
  if (app.state?.phase === 'ended') app.endDismissedRound = app.state.round;
  closeOverlay('end-overlay');
}

function renderEndContent() {
  const state = app.state;
  if (!state || state.phase !== 'ended') return;

  const sorted = [...state.players].sort(
    (a, b) =>
      b.score - a.score ||
      b.longest - a.longest ||
      a.joinedAt - b.joinedAt,
  );
  const winners = sorted.filter((player) => state.winnerIds.includes(player.id));
  const topScore = sorted[0]?.score ?? 0;
  const totalWords = sorted.reduce((sum, player) => sum + player.wordCount, 0);

  els.endTitle.textContent =
    winners.length === 0
      ? 'The bagel wins'
      : winners.length === 1
        ? `${winners[0].name} takes the bagel`
        : `${winners.map((player) => player.name).join(' & ')} split the bagel`;

  els.endSub.textContent =
    topScore > 0
      ? `${topScore} letters · ${totalWords} ${plural(totalWords, 'word')} on the table`
      : 'No words made it to the table. Bold strategy.';

  const ranking = document.createDocumentFragment();
  sorted.forEach((player, index) => {
    const row = make('div', 'rank-row');
    if (state.winnerIds.includes(player.id)) row.classList.add('is-winner');
    row.style.setProperty('--pc', player.color);

    const dot = make('span', 'rank-dot');
    dot.style.background = player.color;
    row.append(dot);
    row.append(make('span', 'rank-num', String(index + 1)));

    const info = make('div', 'rank-info');
    const name = player.name + (player.id === app.me ? ' (you)' : '');
    info.append(make('span', 'rank-name', name));

    const best = player.words.reduce(
      (current, entry) => (!current || entry.word.length > current.word.length ? entry : current),
      null,
    );
    info.append(
      make(
        'span',
        'rank-best',
        best
          ? `${player.wordCount} ${plural(player.wordCount, 'word')} · longest ${best.word}`
          : 'No words',
      ),
    );
    row.append(info);

    const score = make('span', 'rank-score');
    score.append(document.createTextNode(String(player.score)), make('small', null, 'letters'));
    row.append(score);
    ranking.append(row);
  });
  els.endRanking.replaceChildren(ranking);

  const actions = document.createDocumentFragment();
  if (state.hostId === app.me) {
    actions.append(makeButton('Play again', 'primary-btn', restartRound));
    actions.append(makeButton('Back to lobby', 'ghost-btn', resetToLobby));
  } else {
    actions.append(make('p', 'end-wait', 'Waiting for the host to start the next round…'));
  }
  els.endActions.replaceChildren(actions);
}

function burstConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  els.confetti.replaceChildren();
  const colors = ['#f2b45c', '#ffd28a', '#7bd88f', '#7cc4ff', '#ff6b5e', '#f8ecd8', '#b69cff'];
  const fragment = document.createDocumentFragment();
  for (let i = 0; i < 42; i += 1) {
    const piece = make('span');
    piece.style.left = `${Math.random() * 100}%`;
    piece.style.background = colors[i % colors.length];
    piece.style.animationDelay = `${Math.random() * 0.55}s`;
    piece.style.animationDuration = `${1.6 + Math.random() * 1.3}s`;
    piece.style.transform = `rotate(${Math.random() * 180}deg)`;
    fragment.append(piece);
  }
  els.confetti.append(fragment);
}

// ---------- overlays ----------

function openOverlay(id, focusSelector) {
  const overlay = $(id);
  if (!overlay) return;
  overlay.hidden = false;
  overlay.setAttribute('aria-hidden', 'false');
  updateBodyModal();
  if (focusSelector) {
    setTimeout(() => {
      const target = overlay.querySelector(focusSelector);
      if (target && typeof target.focus === 'function') target.focus();
    }, 40);
  }
}

function closeOverlay(id) {
  const overlay = $(id);
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  overlay.setAttribute('aria-hidden', 'true');
  updateBodyModal();
}

function updateBodyModal() {
  const anyOpen = OVERLAY_IDS.some((id) => {
    const overlay = $(id);
    return overlay && !overlay.hidden;
  });
  document.body.classList.toggle('modal-open', anyOpen);
}

function openShare() {
  openOverlay('share-overlay', '#copy-share-url');
  refreshInfo(true);
}

// ---------- invite / info ----------

async function refreshInfo(force = false) {
  if (!force && app.info && Date.now() - app.infoFetchedAt < 12_000) {
    updateShareInfo();
    return app.info;
  }
  if (app.infoPromise) return app.infoPromise;

  app.infoPromise = (async () => {
    try {
      const response = await fetch('/api/info', { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      app.info = await response.json();
      app.infoFetchedAt = Date.now();
      updateShareInfo();
      return app.info;
    } catch {
      if (!app.info) {
        els.joinUrl.textContent = location.origin;
        els.joinShareStatus.textContent =
          'Could not read the network address. You can still play on this device.';
        els.shareUrl.textContent = location.origin;
        els.shareStatus.textContent = 'Could not read the network address.';
      }
      return null;
    } finally {
      app.infoPromise = null;
    }
  })();

  return app.infoPromise;
}

function updateShareInfo() {
  const info = app.info;
  if (!info) return;

  const primary = info.primaryUrl || location.origin;
  const hasLan = Array.isArray(info.addresses) && info.addresses.length > 0;
  const shareable = hasLan || !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(primary);

  els.joinUrl.textContent = primary;
  els.shareUrl.textContent = primary;

  const phaseNote =
    info.phase === 'playing'
      ? 'A round is in progress. Late joiners jump in with zero words.'
      : info.phase === 'ended'
        ? 'A round just ended. Jump in for the next one.'
        : 'The lobby is open.';

  if (shareable) {
    els.joinShareStatus.textContent = `${phaseNote} Scan the QR or open the address.`;
    els.shareStatus.textContent = `${phaseNote} Everyone needs the same Wi-Fi.`;
  } else {
    els.joinShareStatus.textContent =
      'No LAN address detected. Connect this computer to Wi-Fi or use a hotspot to invite phones.';
    els.shareStatus.textContent =
      'No LAN address detected. Other devices cannot reach this computer yet.';
  }

  for (const image of [els.joinQr, els.shareQr]) {
    image.hidden = !shareable;
    if (shareable) {
      image.src = `/api/qr.svg?ts=${Date.now()}`;
    } else {
      image.removeAttribute('src');
    }
  }

  const dictionary = info.dictionary ?? { name: 'NWL2023', words: 0 };
  els.joinDictionary.textContent = `${dictionary.name} Scrabble dictionary · ${Number(
    dictionary.words,
  ).toLocaleString()} words`;

  const otherUrls = Array.isArray(info.urls)
    ? info.urls.filter((url) => url !== primary)
    : [];
  const network = document.createDocumentFragment();
  if (otherUrls.length > 0) {
    network.append(make('span', null, 'Other addresses to try:'));
    for (const url of otherUrls) {
      const row = make('div', 'network-row');
      row.append(make('code', null, url));
      network.append(row);
    }
  }
  els.networkList.replaceChildren(network);
}

async function copyText(text) {
  if (!text) return false;
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the old textarea method.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    area.style.pointerEvents = 'none';
    document.body.append(area);
    area.select();
    const copied = document.execCommand('copy');
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

// ---------- sound ----------

function updateSoundButton() {
  els.soundBtn.setAttribute('aria-pressed', String(app.sound));
  els.soundBtn.textContent = app.sound ? 'Sound' : 'Muted';
  els.soundBtn.title = app.sound ? 'Sound on. Click to mute.' : 'Sound off. Click to unmute.';
}

function ensureAudio() {
  if (!app.sound) return null;
  if (!app.audio) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return null;
    try {
      app.audio = new AudioContextClass();
    } catch {
      return null;
    }
  }
  if (app.audio.state === 'suspended') {
    app.audio.resume().catch(() => {});
  }
  return app.audio;
}

function note(context, frequency, start, duration, type = 'sine', gain = 0.03) {
  const oscillator = context.createOscillator();
  const amp = context.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  amp.gain.setValueAtTime(0.0001, start);
  amp.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(amp).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.03);
}

function playSound(kind) {
  if (!app.sound) return;
  const context = ensureAudio();
  if (!context) return;
  const now = context.currentTime + 0.005;

  if (kind === 'tick') {
    note(context, 720, now, 0.045, 'triangle', 0.018);
  } else if (kind === 'claim') {
    [523.25, 659.25, 783.99].forEach((frequency, index) => {
      note(context, frequency, now + index * 0.055, 0.13, 'sine', 0.028);
    });
  } else if (kind === 'steal') {
    [392, 523.25, 659.25, 783.99].forEach((frequency, index) => {
      note(context, frequency, now + index * 0.06, 0.15, 'triangle', 0.03);
    });
  } else if (kind === 'error') {
    const oscillator = context.createOscillator();
    const amp = context.createGain();
    oscillator.type = 'sawtooth';
    oscillator.frequency.setValueAtTime(170, now);
    oscillator.frequency.exponentialRampToValueAtTime(95, now + 0.18);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(0.03, now + 0.012);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    oscillator.connect(amp).connect(context.destination);
    oscillator.start(now);
    oscillator.stop(now + 0.22);
  } else if (kind === 'start') {
    [392, 523.25, 659.25, 783.99].forEach((frequency, index) => {
      note(context, frequency, now + index * 0.075, 0.18, 'sine', 0.022);
    });
  } else if (kind === 'end') {
    [523.25, 659.25, 783.99, 1046.5].forEach((frequency, index) => {
      note(context, frequency, now + index * 0.11, 0.35, 'sine', 0.03);
    });
  }
}

function toggleSound() {
  app.sound = !app.sound;
  storageSet(SOUND_KEY, app.sound ? 'on' : 'off');
  updateSoundButton();
  if (app.sound) {
    ensureAudio();
    playSound('tick');
  }
}

// ---------- toasts / join errors / shake ----------

function toast(message, kind = 'info', ttl = 3500) {
  const last = els.toasts.lastElementChild;
  if (last && last.dataset.text === message && !last.classList.contains('is-out')) return;

  const item = make('div', `toast is-${kind}`, message);
  item.dataset.text = message;
  els.toasts.append(item);
  while (els.toasts.children.length > 4) els.toasts.firstElementChild.remove();

  setTimeout(() => {
    item.classList.add('is-out');
    setTimeout(() => item.remove(), 260);
  }, ttl);
}

function showJoinError(message) {
  els.joinError.textContent = message;
  els.joinError.hidden = false;
}

function clearJoinError() {
  els.joinError.hidden = true;
  els.joinError.textContent = '';
}

function shakeWordbar() {
  els.wordForm.classList.remove('is-shaking');
  void els.wordForm.offsetWidth;
  els.wordForm.classList.add('is-shaking');
  setTimeout(() => els.wordForm.classList.remove('is-shaking'), 420);
}

// ---------- events ----------

function bindEvents() {
  els.joinForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = sanitizeName(els.nameInput.value);
    if (!name) {
      showJoinError('Pick a name first.');
      els.nameInput.focus();
      return;
    }
    beginJoin(name);
  });

  els.nameInput.addEventListener('input', clearJoinError);

  els.wordForm.addEventListener('submit', onSubmit);
  els.wordInput.addEventListener('input', onWordInput);
  els.clearSteal.addEventListener('click', clearStealTarget);
  els.submitBtn.addEventListener('click', () => {
    // The form submit event handles this; this listener exists for clarity.
  });

  els.inviteBtn.addEventListener('click', openShare);
  els.rulesBtn.addEventListener('click', () => openOverlay('rules-overlay', '#rules-overlay .close-btn'));
  els.soundBtn.addEventListener('click', toggleSound);

  for (const button of document.querySelectorAll('[data-close]')) {
    button.addEventListener('click', () => closeOverlay(button.dataset.close));
  }

  els.closeEnd.addEventListener('click', dismissEnd);

  for (const id of ['share-overlay', 'rules-overlay']) {
    const overlay = $(id);
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) closeOverlay(id);
    });
  }
  els.endOverlay.addEventListener('click', (event) => {
    if (event.target === els.endOverlay) dismissEnd();
  });

  els.copyJoinUrl.addEventListener('click', async () => {
    const ok = await copyText(els.joinUrl.textContent);
    toast(ok ? 'Join address copied.' : 'Could not copy. Select the address manually.', ok ? 'success' : 'error', 2400);
  });
  els.copyShareUrl.addEventListener('click', async () => {
    const ok = await copyText(els.shareUrl.textContent);
    toast(ok ? 'Join address copied.' : 'Could not copy. Select the address manually.', ok ? 'success' : 'error', 2400);
  });

  for (const image of [els.joinQr, els.shareQr]) {
    image.addEventListener('error', () => {
      image.hidden = true;
      els.shareStatus.textContent =
        'The QR code could not be generated. Use the address instead.';
    });
  }

  document.addEventListener('keydown', onGlobalKey);
  document.addEventListener('pointerdown', ensureAudio, { once: true });
}

function onGlobalKey(event) {
  if (event.key === 'Escape') {
    if (!els.joinOverlay.hidden) return;
    if (!els.shareOverlay.hidden) {
      closeOverlay('share-overlay');
      return;
    }
    if (!els.rulesOverlay.hidden) {
      closeOverlay('rules-overlay');
      return;
    }
    if (!els.endOverlay.hidden) {
      dismissEnd();
      return;
    }
    if (app.stealWordId) {
      clearStealTarget();
      return;
    }
    if (els.wordInput.value) {
      els.wordInput.value = '';
      updatePreview();
    }
    return;
  }

  if (document.body.classList.contains('modal-open')) return;
  if (app.state?.phase !== 'playing') return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (document.activeElement === els.wordInput) return;

  const tag = document.activeElement?.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (!/^[a-zA-Z]$/.test(event.key)) return;

  event.preventDefault();
  els.wordInput.focus();
  els.wordInput.value = normalizeWord(`${els.wordInput.value}${event.key}`);
  updatePreview();
}
