# Everyword Bagel

A real-time, same-room **Anagrams** game for any phone, tablet, or laptop on the
same Wi-Fi. All the Scrabble tiles start face down in one big circular bagel.
Players take turns flipping letters into the middle, then anyone can grab a word
or steal one by adding letters.

```
        A  N  A  G  R  A  M  S
     ·  all 98 tiles start face down  ·
        reveal · claim · steal
```

## Quick start

Requires **Node.js 18.17+** (tested on Node 22).

```sh
npm install
npm start
```

The terminal prints two kinds of address:

```
This device:  http://localhost:3000
Same Wi-Fi:
  http://192.168.1.42:3000   (Wi-Fi)
```

Open the `192.168.x.x` address on any device in the room. The first person to
join is the host and can start the round. The **Invite** button in the app shows
the same address plus a QR code.

> **Why LAN and not Bluetooth?** Web Bluetooth only lets a page talk to a nearby
> peripheral (a heart-rate strap, a keyboard) and requires HTTPS. It cannot host
> or advertise a game that other phones discover. A tiny HTTP + WebSocket server
> on one laptop or phone is the reliable cross-device option, and it works in
> every modern browser with no install on the other devices.

## How to play

- **Reveal** — face-down tiles form the outer ring. Only one player may flip at a
  time, in the order everyone joined the table. On your turn, tap a face-down
  tile to turn it face up in the middle. The reveal then passes to the next
  connected player.
- **Claim** — type any word that uses the **face-up** tiles in the middle. The
  default minimum is 4 letters; the host can set 3–7 in the lobby.
- **Steal** — type a word that keeps *every* letter of a word already on the
  table and adds at least one face-up letter from the middle. No tapping needed:
  the steal is detected as you type. Rearranging is expected: `CATS` + `H` →
  `CHATS`. You can extend anyone's word, including your own. A steal also hands
  you the next reveal, so you flip another tile before the rotation continues.
- **Score** — your score is the total number of letters in all the words you
  own. The round ends when every tile has been used or the host calls time. Most
  letters wins; ties share the win.
- Duplicate words in different players' piles are allowed, and a word can be
  stolen repeatedly.

The server is the referee. Every reveal, claim, and steal is validated against
the current turn, tile availability, and the dictionary, and all mutations
happen synchronously. Face-down letters are never sent to the browser, so a
player cannot peek at the bag with developer tools.

## Word list

Words are checked against the **NWL2023** North American Scrabble tournament
list — **196,601** headwords — bundled at `data/scrabble-words.txt`.

- Source: [scrabblewords/scrabblewords · NWL2023](https://github.com/scrabblewords/scrabblewords/blob/main/words/North-American/NWL2023.txt)
- Refresh with `npm run fetch-dictionary`
- Use a different list with `NWL_SOURCE_URL=... npm run fetch-dictionary`

See `data/README.md` for attribution. This is a Scrabble lexicon, not a general
English dictionary: expect obscure two-letter words and no brand names.

## Configuration

| Setting | How |
| --- | --- |
| Port | `PORT=4000 npm start` |
| Minimum word length | Host control in the lobby (3–7), default 4 |
| Dictionary | Replace `data/scrabble-words.txt` (one uppercase word per line) |

On Windows PowerShell, set the port with `$env:PORT=4000; npm start`.

## Troubleshooting

**A phone cannot reach the address**

1. Make sure both devices are on the *same* Wi-Fi network (not one on Wi-Fi and
   one on cellular).
2. Allow **Node.js** through the firewall on **private networks**. Windows
   usually asks the first time; if you dismissed it, open *Windows Security →
   Firewall & network protection → Allow an app through firewall* and tick
   Node.js for Private.
3. Guest Wi-Fi and some router "AP isolation" / "client isolation" settings
   block devices from talking to each other. Use a phone hotspot instead: turn
   on the hotspot, connect the laptop to it, and use the hotspot's LAN address
   (often `172.20.10.x`).
4. Try another address printed by the server. Virtual adapters (VPN, Docker,
   WSL) are ranked last but are still listed in the Invite dialog.

**Port already in use**

```sh
PORT=3001 npm start
```

**Everyone disappeared / the page says Offline**

The game state lives in the server process. If the host laptop sleeps or the
server stops, state is lost. Refreshing a tab reconnects a player while the
server is running; restarting the server starts a fresh table.

**A word was rejected but it is a real word**

The list is NWL2023. Some modern words and British spellings are absent. The
error message names the dictionary so players know the rule.

## Project layout

```
server/game.js         authoritative rules, scoring, reconnection
server/index.js        Express + ws server, QR, LAN address detection
server/dictionary.js   dictionary loader
public/                vanilla HTML/CSS/JS client (no build step)
test/                  node:test unit + WebSocket integration tests
scripts/               dictionary downloader
data/                  bundled NWL2023 headwords
```

## Development

```sh
npm run dev     # restart the server on file changes
npm test        # 25 unit tests + 4 HTTP/WebSocket integration tests
```

There is no client build step: the browser loads `public/` directly. The client
is intentionally dependency-free.

## Notes

- No service worker/PWA offline cache: LAN HTTP is not a secure context, so
  caching is unreliable across browsers. The app still provides a web manifest
  and icon for "Add to Home Screen".
- Sound effects use the Web Audio API and start after the first tap, as browsers
  require.
- The game is designed for a trusted same-room group. There is no account
  system; reconnect tokens are stored in the browser.
