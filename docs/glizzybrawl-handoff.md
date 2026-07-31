# GlizzyBrawl — where things stand

Working notes for picking this back up. Delete this file once the art is
settled and the branch is merged.

**Branch: `glizzybrawl`** (3 commits, nothing on `main`, nothing deployed).
Closes [issue #1](https://github.com/Kombuchelada/botdog/issues/1).

## State: feature complete, art unresolved

The game is built, tested, and playable. The only open question is what the
Fighters look like.

| Commit | What |
|---|---|
| `14e5fbe` | The Arena: sim, server, page, ledger, first tests in the repo |
| `b0b836a` | Kenney CC0 bodies + food costumes (replaced hand-drawn canvas art) |
| `c3bdfa8` | Bespoke-art pipeline: importer, manifest, art brief |

## Running it

```bash
# Local node is v24; better-sqlite3 is built for the pinned v22.
export PATH=~/.nvm/versions/node/v22.22.3/bin:$PATH

npm test          # 43 tests, ~25s (the WebSocket suite runs in real time)

DB_PATH=./hotdog-data.db ADMIN_PASSWORD=devpassword PUBLIC_KEY=dummy \
  DISCORD_TOKEN=dummy APP_ID=dummy PORT=3000 node app.js
# → http://localhost:3000/brawl  ("Log in with Discord" is a dev bypass)
```

`BRAWL_TEST_MODE=1` drops the 60s AFK fade to 2s for demos. Never in prod.

## The art question (the only open item)

Three attempts, in order:

1. **Hand-drawn canvas shapes** — rejected: "those characters look bad".
2. **Kenney CC0 bodies + food costumes painted on top** — currently live.
   Bodies are good; the overlay is the weak part: "the art on top of them does
   not look good".
3. **Pixel-art prototype** (`scripts/brawl-make-sprites.mjs`, ASCII rigs →
   `assets/brawl/pixel/`) — I built it and it's not good either: stubby,
   detached-looking limbs. Left in the repo as a worked example, **not**
   imported, so the live roster stays consistent.

**Decision taken: generate the art with an AI tool**, then import it.

Verified along the way, so nobody re-treads it: **there is no free or paid
animated food-character sprite art.** OpenGameArt has one static food icon
set; every itch food pack is static inventory icons. Checked both the food and
fighting tags.

Also worth remembering: **this repo is public**, so anything committed under
`assets/` must permit redistribution. That rules out Craftpix's free tier and
even the "CC0"-labelled itch Pixel Foods pack, whose author says not to
redistribute the originals. Kenney's CC0 is safe and is what's in there now.

### The pipeline is ready and tested

- Brief for the generator: [`docs/glizzybrawl-art-brief.md`](glizzybrawl-art-brief.md)
- Import: `node scripts/brawl-import-sprites.mjs <fighter> <sheet.png> --grid 5x2`
- Check: `node scripts/brawl-art-preview.mjs` → `brawl-roster.png`

`assets/brawl/manifest.json` lists Fighters with art of their own; those draw
`<fighter>_<pose>.png` and get **no costume**. Everyone else keeps the Kenney
body. So art can land **one Fighter at a time**, and the manifest is re-read
per request — no restart. It's currently empty (all four costumed).

The importer was tested end to end by faking a generated sheet from the pixel
prototype: background removal, uniform scale across the set, feet anchored on
the floor line, manifest updated, and the live client confirmed drawing
`glizzy_*.png` instead of `player_*.png` + costume.

## Map

| File | What |
|---|---|
| `brawl-sim.js` | Physics. Zero imports, deterministic. Served to the browser at `/brawl/sim.js` — server and client run *the same file*. |
| `brawl.js` | 30Hz loop, `ws` protocol, `brawl_stats` ledger, routes. Seam is `registerBrawl` / `attachBrawl` / `stopBrawl`. |
| `brawl-page.js` | SSR page + canvas renderer + netcode + input. |
| `brawl-art.js` | Body/pose tables + costumes. Shared with the browser and the preview script. |
| `test/sim.test.js` | Frame-precise mechanics. |
| `test/brawl-ws.test.js` | The primary seam: real clients over real WebSockets, asserting only observable behaviour + ledger rows. |
| `docs/glizzybrawl.md` | Full design/architecture doc. |
| `docs/adr/0001-continuous-arena.md` | Why nothing ever ends. |

## Bugs the tests caught (don't reintroduce)

- Grounded attacks kept full run momentum → slid past their own hitbox.
- Snapshots carried only their own tick's events → half of all hits and KOs
  never reached clients.
- A slow server tick swallowed quick taps → inputs now merge instead of
  last-write-wins.
- A KO lost its credit if the attacker left while the victim was still falling.
- The page read `BOOT` before initialisation (would have thrown in a browser).

## If you want to fiddle before the art arrives

- Balance lives in the `FIGHTERS`, `MOVES`, and `SPECIALS` tables at the top of
  `brawl-sim.js`; `npm test` covers the invariants (knockback scales with
  Percent, heavier launches less, blast-zone KOs).
- Jump is **Space**, dodge is **Shift**. Jump must never share a key with
  "up" — that makes every ground up-attack come out as its aerial version.
