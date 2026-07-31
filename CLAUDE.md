# Year of the Glizzy (botdog) — repo guide

A Discord bot + public web dashboard + idle game that tracks hot dog
consumption in a friend group. What started as a one-command `/hotdog`
counter has grown into a multi-surface project:

- **Discord bot** with slash commands (counter, leaderboards, image charts,
  GlizzyClicker leaderboard, archive announcements, daily digest)
- **Public website** at `yearoftheglizzy.com` — overview dashboard, per-user
  pages, comparison page, archive of curated stories, GlizzyClicker idle game
- **Admin panel** at `/admin` for fixing bad submissions and managing the
  archive / backups / profiles
- **Auto-curated archive**: bot ingests messages from a designated channel,
  asks Claude to identify significant events, publishes them as magazine-style
  stories with carousels and Discord embed announcements
- **GlizzyClicker**: a Cookie-Clicker-style idle game where bonuses are
  driven by your real hot dog stats (eat 4+ dogs yesterday → Big Eater
  ×100 click; 120-day streak → +240% production; etc.)
- **GlizzyBrawl**: a realtime Smash-style platform fighter at `/brawl` — one
  always-on Arena, server-authoritative 30Hz sim over WebSockets, four
  Fighters, all-time KO/Fall scoreboard plus a Pacific Day Tally

Hosted on Railway. SQLite (`better-sqlite3`) on a Railway volume.
DO Spaces for object storage (attachments, avatars, DB backups).
Anthropic API for story curation. Discord OAuth for game player identity.

---

## Module map

### Server (Node.js + Express, ESM, `app.js` is entry)

| File | What it does |
|---|---|
| `app.js` | Entry point. Wires routers, starts background workers, handles graceful SIGTERM shutdown. |
| `database.js` | Single `better-sqlite3` connection, all `CREATE TABLE IF NOT EXISTS` migrations, all prepared statements. Path is `process.env.DB_PATH \|\| "/database/data.db"`. |
| `interactions.js` | Discord slash-command dispatcher. Handles `/hotdog`, `/protest`, `/leaderboard*`, `/stats`, `/chart`, `/glizzy`. |
| `commands.js` | Slash command definitions; `npm run register` pushes them to Discord. |
| `utils.js` | `DiscordRequest`, `uploadInteractionAttachment` (multipart), `editOriginalInteractionMessage`, `InstallGlobalCommands`. |
| `api.js` | Read-only JSON endpoints (`/api/hotdog-totals`, etc.) for external consumers. |
| `stats.js` | Pure-function aggregation helpers: `buildUserDatesMap`, `getCurrentStreak`, `toPacificDateKey`, `parseUtcTimestamp`. Reused across charts/dashboard/glizzy. |
| `nav.js` | Shared site header (`renderNav(activeKey)`), imported by `dashboard.js` and `game.js`. Collapses to a toggle panel below `md`. |
| `charts.js` | Server-rendered PNG charts via `@napi-rs/canvas` + Chart.js: heatmap, timeline, leaderboard, stat card, when-heatmap. Uses bundled Inter font. |
| `dashboard.js` | Public website. SSR'd HTML with Tailwind CDN + Chart.js CDN. Routes: `/`, `/users`, `/user/:id`, `/compare`, `/archive`, `/archive/:id`. |
| `numbers.js` | "Hot Dogs by the Numbers" magazine-scroll page at `/numbers`. Every stat derives from the Average Glizzy (CONTEXT.md) × `hotdog_events`; constants all carry cited sources for the per-section "show your work" panels. Trailing-28-day Pace + projection fan; milestone ladders auto-upgrade to ~15k glizzies; health stats are collective-only (per-user rates never leave the server). GSAP ScrollTrigger + Chart.js. See `docs/by-the-numbers.md`. |
| `admin.js` | Cookie-protected `/admin/*` admin UI. Edit/split/delete hot dog events, manage archive stories, backup/restore, retry/reset, refresh profiles, send digest. |
| `archive.js` | Channel poller + Spaces uploader + Claude story curator. Runs on `setInterval(POLL_INTERVAL_MS = 1h)`. Backfills history on first boot, then forward-polls. Weekly story job + daily digest dispatch + daily profile refresh run from the same tick. |
| `claude.js` | Anthropic SDK wrapper. `proposeStories({messages, attachmentsByMessageId, periodStart, periodEnd})` uses Sonnet 4.6 with a forced tool-call (`publish_stories`) for structured output. Resizes images via sharp, base64-encodes them (avoids URL fetch rate limits). HEIC→JPEG via `heic-convert`. |
| `digest.js` | Daily digest job. Fires once per Pacific day at/after 9 AM PT, posts an embed with yesterday's totals, top eaters, and active streaks. |
| `profiles.js` | Discord avatar mirror. Daily worker refreshes everyone in `hotdog_events`; OAuth login mirrors the logging-in user. Resizes to 256×256 PNG, uploads to `avatars/{user_id}-{hash}.png` in Spaces. |
| `do-spaces.js` | S3 client pointed at DO Spaces (signed with region from endpoint, force-path-style off). `uploadObject(key, body, contentType)` returns the public CDN URL. `deletePrefix(prefix)` for bulk cleanup. |
| `backup.js` | Hot-safe SQLite snapshot via `db.backup()`, gzip level 9, dual-upload as `backups/db-{ISO}.db.gz` + `backups/latest.db.gz`. Daily on `setInterval`, plus manual button in admin. |
| `oauth.js` | Discord OAuth2 (`identify` scope only). HMAC-signed cookie session. Dev-bypass mode when `DISCORD_CLIENT_SECRET` is unset — logs in as the latest hotdog_events user so the game is playable locally. |
| `glizzy.js` | GlizzyClicker game logic. Static `BUILDINGS`, `UPGRADES`, `ALL_BONUSES`. `computeBonuses(userId)` derives active modifiers from real hot dog stats. `validateAndClampSave` is server-authoritative anti-cheat (and anti-regression — see `save_seq` below). `loadGameForUser` credits offline production itself. `GOLDEN_BONUSES` + `claimGoldenGlizzy(userId)` is the golden-glizzy reward roll (server-authoritative; timed buffs live in `state.golden_effects`, weights sum to 1000 so the mega is exactly 1/1000). |
| `game.js` | GlizzyClicker UI. Self-contained game page with hand-drawn SVG mascot + building SVGs, vanilla JS game loop, save-every-5s + `sendBeacon` on hide/unload, ×1/×10/×100 buy quantity. Golden glizzy spawns client-side and claims via `POST /api/game/golden`. Public leaderboard at `/game/leaderboard`, plus an in-page peek modal (🏆 button / `L` key) fed by `/api/game/leaderboard`. Also hosts **the Oracle** — a Konami-code-gated purchase optimizer (`docs/oracle.md`). |
| `brawl-sim.js` | GlizzyBrawl's simulation. Pure, dependency-free, deterministic (no `Math.random`/`Date.now`). **Served verbatim to the browser at `/brawl/sim.js`** — server and client run the same file, so there is no replica to drift. See `docs/glizzybrawl.md`. |
| `brawl.js` | GlizzyBrawl server: 30Hz accumulator loop, `ws` protocol, the `brawl_stats` ledger, routes. `registerBrawl(app)` / `attachBrawl(server)` / `stopBrawl()` are the whole seam — the Arena could move to its own service by re-pointing those three. |
| `brawl-art.js` | GlizzyBrawl Fighter art: the pose mapping, plus Kenney CC0 bodies (`assets/brawl/`) and per-Fighter costumes for Fighters that don't yet have bespoke art. The Glizzy is bespoke (PixelLab, south-east 3/4); the rest are still costumed. Shared with the browser at `/brawl/art.js` and with `scripts/brawl-art-preview.mjs`, which renders the roster to a PNG so art can be judged without a browser. |
| `scripts/brawl-import-sprites.mjs` | Imports bespoke Fighter art (generated or commissioned) — de-backgrounds, trims, scales the set uniformly, plants feet on the floor line, updates `assets/brawl/manifest.json`. A Fighter in that manifest draws its own sprites and gets no costume, so new art lands one Fighter at a time. Recipe: `docs/glizzybrawl-art-brief.md`. |
| `brawl-page.js` | GlizzyBrawl UI: SSR'd page plus a hand-rolled canvas renderer, client prediction, gamepad + dual-keyboard input, scoreboards. Fighter art is one function per character in `ART` (deliberately swappable for sprite sheets). |
| `achievements.js` | One-off pop-ups appended to `/hotdog` responses when a user crosses a milestone (10/25/.../1000 lifetime, 5/10/15/20 single sitting, 3/7/14/30/60/100/365 streak). |

### Schema (all in `database.js`, additive `CREATE TABLE IF NOT EXISTS`)

- `hotdog_events` — original counter. Negative amounts are valid (protests). Auto-created.
- `hotdog_totals` (view) — sums above.
- `archive_messages`, `archive_attachments`, `archive_stories`, `archive_state` — archive feature.
- `user_profiles` — Discord identity + avatar URL cache.
- `glizzy_game` — game state JSON + `lifetime_glizzies` extracted for leaderboard index.
- `brawl_stats` — GlizzyBrawl ledger: one row per player ever (KOs, Falls, best
  KO Streak, arena seconds, per-character KOs, Pacific Day Tally). Deliberately
  has no match/bout/win concept to hang a row on — see `docs/adr/0001-continuous-arena.md`.

`archive_stories` has a `tags TEXT DEFAULT '[]'` column added by a one-shot
ALTER migration (idempotent — checks `PRAGMA table_info`).

---

## Conventions & non-obvious decisions

- **All time bucketing is Pacific time** (`stats.js: toPacificDateKey`). Don't
  use UTC dates for "day" boundaries — the community lives in Pacific and the
  whole leaderboard logic depends on this. When passing timestamps to Claude,
  `claude.js` formats them as `"YYYY-MM-DD HH:MM Pacific"` strings so the LLM
  doesn't muddle day boundaries.
- **Heatmap color palette is `plasma`** (purple → magenta → orange → yellow),
  not red/green. Owner is colorblind. Same palette used everywhere (web SVG +
  Discord PNG + stat-card mini-heatmap).
- **Heatmaps start no earlier than 2025-12-31** and cap at 52 weeks. Constants
  in both `charts.js` (`HEATMAP_START_ISO`, `HEATMAP_MAX_WEEKS`) and
  `dashboard.js` — kept in sync manually.
- **Discord bot is HTTP-only** (interactions endpoint), no gateway/WS
  connection. Archive ingest polls via REST.
- **No new commits without the owner running `git commit` manually.** The
  Railway deploy pipeline auto-deploys from `main`, so committing == shipping.
- **`postinstall` runs `npm run register`**, which pushes the slash command
  list to Discord. Locally this fails with 401 if Discord credentials aren't
  in `.env`; use `npm install --ignore-scripts` to skip.
- **Anti-cheat in GlizzyClicker** uses *previous*-state production rates for
  the earnings budget, not the claimed end state. Otherwise a cheater could
  claim N buildings and reap their production in the same tick.
- **Saves are guarded in both directions.** The ceiling is the anti-cheat
  budget above; the *floor* is passive production accrued since `last_seen_at`,
  so a client whose timers were frozen (backgrounded phone) can never report a
  smaller bank than the buildings already produced. On top of that, every
  server-side write bumps `state.save_seq` and the client echoes back the seq it
  last received — a payload built on an older snapshot (a queued save from a
  suspended tab, a second tab) is dropped and the client resyncs.
- **Offline production is credited server-side** in `loadGameForUser`, not by
  the client on dismissing the welcome-back modal. The modal is display-only;
  adding the amount client-side too would double-credit.
- **The game's lists are patched in place, never re-`innerHTML`'d on a timer.**
  Replacing an element between `pointerdown` and `pointerup` means no `click`
  event fires at all, which ate taps on mobile. Buildings patch text/classes;
  upgrades only rebuild when the visible set actually changes, and never while
  a pointer is held (`pointerHeld`).
- **Streaks only count days with a positive net total** (`buildUserDatesMap`).
  Protests are negative `hotdog_events` rows and must not sustain a streak.
  This also narrows "active days" — a day that nets to zero isn't an eating day.
- **The golden-glizzy claim floor is per player, never a flat constant.**
  `goldenClaimFloorMs` derives it from that player's own `goldenSpawnFor`
  cadence. A flat 200 s floor silently rejected ~24% of claims for anyone
  owning both frequency upgrades (which drop the spawn interval to 136 s) —
  the glizzy vanished and nothing happened. See `docs/golden-glizzy.md`.
- **No golden-glizzy reward may pay zero.** Instant grants scale off
  `goldenBaseRate` = `max(perSecond, perClick, 1)`, not `perSecond` alone,
  which is 0 until the first building. The client toasts on failure too — a
  glizzy that disappears with no feedback reads as a broken game.
- **Golden buffs never downgrade.** Same-group buffs eclipse — at any instant
  only the strongest *running* one applies, never a product — and a weaker or
  equal claim queues behind the stronger via `starts_at` with its full
  duration. "Newest wins" replacement was wrong the moment frequency/duration
  upgrades let buffs overlap (a ×4 Frenzy replaced a running ×13 Super Frenzy).
  Client `adoptServerState` also drops out-of-order responses (older
  `save_seq`) — an autosave echo landing after a claim used to wipe the fresh
  buff. See `docs/golden-glizzy.md`.
- **The sticky header and game balance bar are opaque, not `backdrop-blur`.**
  A `backdrop-filter` layer re-rasterises whenever anything animates beneath
  it, and the game scales the glizzy on every click; on Safari that makes the
  header's emoji visibly pulse. Solid `bg-slate-950` looks identical here.
- **`.card { min-width: 0 }` is load-bearing** (`dashboard.js` styles). Grid
  and flex items default to `min-width: auto` = min-content, which for a card
  holding a Chart.js `<canvas>` is the canvas's current pixel width. Without
  it, a chart rendered wide pins its card open and neither can shrink when the
  window narrows (Chart.js only downsizes *after* its container does).
- **Checking the leaderboard shouldn't cost you the session.** Navigating to
  `/game/leaderboard` tears down the running loop and forces a save round-trip,
  so the game page has an overlay (🏆 button, `L` toggles, Esc/backdrop closes)
  that polls `/api/game/leaderboard` every 10 s while open and leaves the game
  ticking underneath. `getLeaderboardRows` stays identity-free — the route
  wraps it in `withProfiles()` so the client-rendered modal gets name +
  avatar. Top 50 only, so the modal appends your own line from local state
  when you're not on the board.
- **The Oracle prices every candidate by simulation, never by a heuristic.**
  Clone the state, apply the purchase, re-run `computeRatesFor`, diff the /s;
  rank by `cost ÷ Δpps`. That's what keeps it correct for effects whose value
  depends on the rest of the state (`building_synergy`, `global_per_building`)
  without the ranker knowing they exist — and it's why the *cheapest* building
  legitimately ranks #1 for anyone owning Vertical Integration. A hand-written
  "base_rate ÷ cost" heuristic gets that case badly wrong. See `docs/oracle.md`.
- **`computeRatesFor(st)` in `game.js` must mirror `computeEffectiveRates` in
  `glizzy.js` effect-for-effect.** The client one is a replica, and it had
  silently dropped `building_synergy` — anyone owning a synergy upgrade saw an
  understated /s until the next page load quietly corrected it. When you add an
  effect type, add it in both places.
- **Leaderboard numbers use `fmtCompact`, not `toLocaleString`.** Top players
  sit on 19-digit lifetime totals; printing those in full broke every layout
  they touched. Full value goes in a `title` attribute.
- **Don't trust `document.scrollWidth` to detect layout overflow** — `html`
  has `overflow-x: clip`, so it always reads clean. Measure each element's
  `getBoundingClientRect().width` against `clientWidth` instead, and test
  resizing *down* from a wide viewport, not just loading narrow.
- **GlizzyBrawl's sim is one file both sides run.** `brawl-sim.js` imports
  nothing and is deterministic so the browser can predict with the server's own
  physics. Adding a `node:` import, an npm dependency, `Math.random()`, or
  `Date.now()` to it breaks either the browser or prediction — usually both.
  This is the `computeRatesFor` lesson applied by construction rather than by
  discipline.
- **GlizzyBrawl snapshots buffer events, and queued inputs merge.** Snapshots
  go out every other tick, so they must carry *all* events since the last one
  (sending only that tick's events dropped half of every fight's hits and KOs).
  And queued input frames merge rather than replace — under load the server can
  tick slower than a client sends, and "newest wins" swallows taps outright.
  Both are covered by tests; both were invisible bugs found by them.
- **GlizzyBrawl's Fighters are borrowed bodies in costume.** Kenney's CC0
  platformer characters do the acting (they have real attack poses); the bun,
  bottle, lid and batter are painted over them. Costumes draw in a back and a
  front layer and never cover the face — the face is the whole reason the
  sprites are there. Anything committed under `assets/` must permit
  redistribution: this repo is public, which rules out most itch "free" packs.
- **In GlizzyBrawl, jump is Space — never the same key as "up".** Sharing them
  makes every ground up-attack jump first and come out as its aerial variant,
  silently deleting half the ground moveset.
- **A grounded attack plants your feet** (`vx *= 0.2` on startup). Without it,
  an attack begun mid-run keeps all of that run: you slide past your own hitbox
  and off the ledge, and the attack reads as broken. Found by the WebSocket
  tests, not by playing.
- **GlizzyBrawl's food Fighters face south-east (3/4), not in profile.** A
  person in profile still reads as a person; a hot dog in profile is a
  featureless lump with no face, no arms and one leg. The face is why these
  sprites work at 64px. See `docs/adr/0002-food-characters-face-three-quarter.md`
  — this reversed an explicit rule in the art brief, so don't re-derive it per
  character. The renderer still mirrors for left-facing.
- **Humanoid animation templates don't work on stub-limbed characters.**
  PixelLab's templates rotate a skeleton, and these Fighters have no thigh or
  upper arm to rotate — `walking`, `crouching`, `taking-punch` and both punch
  templates all came back with almost no visible motion (a "crouch" at 89% of
  standing height, a "punch" extending 3px). v3 custom descriptions that deform
  the whole body are the tool; only `jumping-1` and `high-kick` survived.
- **Judge poses by measurement, not by eye.** Both art defects found in the
  bespoke-art session passed a visual check and failed a bounding box: a crouch
  must land ≤75% of standing height, an attack must extend ≥+15px, a hurt pose
  must show lift. Measure the alpha bounding box directly — `sharp.trim()` keys
  off the top-left pixel and returns the full canvas on transparent art.
- **`FRAME.width` in the sprite importer is the apparent-size dial.** The
  renderer normalises every sprite to `SPRITE.drawHeight` and takes the aspect
  from the image, so a Fighter's on-screen size is the fraction of frame height
  its art fills. The importer's shared scale factor is set by the widest pose —
  usually a fully extended attack — so a narrow frame pins the whole Fighter
  small. Widen the frame to grow a Fighter; no regeneration needed.
- **Anything reading `assets/brawl/` must read `manifest.json` too.**
  `scripts/brawl-art-preview.mjs` didn't, so it painted costumes over bespoke
  art and drew it at Kenney's aspect ratio while the game drew it correctly —
  a preview tool that disagrees with the thing it previews is worse than none.
- **No GlizzyBrawl KO involving a CPU is ever persisted**, and neither is Arena
  time during practice. CPUs exist only while a lone human is present, so
  "are there CPUs in the Arena?" is the entire check — there is never a
  human-vs-CPU KO to disambiguate.
- **Hot dog stats are cosmetic-only in GlizzyBrawl.** `computeCosmetics` may
  grow crowns/trails/finishes and nothing else; no weight, speed, damage, reach,
  or knockback may ever derive from a hot dog stat. This reversed the original
  pitch on purpose.
- **`npm test` is Node's built-in `node:test`, zero new dependencies.** The two
  seams are the WebSocket boundary (primary) and the sim's public API. Tests
  assert what a connected client observes and what the ledger records — never
  internal state shapes or tick bookkeeping.
- **Archive stories ingest *everything***, even before-deploy history. Re-runs
  are idempotent (per-window story count check). The "Reset archive" admin
  button also wipes the `attachments/` prefix in Spaces.
- **Avatars on the website** use the Discord CDN URL by default (set during
  OAuth login), then get replaced with the Spaces-mirrored URL by the daily
  worker for permanence. Both work; mirror is just more durable.
- **Story announcements are gated on `backfill_stories_complete_at`** — the
  initial backfill posts zero notifications, then every weekly story
  announces. Avoids carpet-bombing the channel on re-backfill.

---

## Environment variables (Railway)

**Required for the bot to work at all**

| Var | Source |
|---|---|
| `DISCORD_TOKEN` | Discord Developer Portal → Bot |
| `APP_ID` | Discord Developer Portal → General Info (same as Client ID) |
| `PUBLIC_KEY` | Discord Developer Portal → General Info (interaction sig check) |

**Required for the admin panel**

| Var | Notes |
|---|---|
| `ADMIN_PASSWORD` | Any string. Used as HMAC key for admin cookies. |

**Required for the dashboard's archive + GlizzyClicker game**

| Var | Notes |
|---|---|
| `PUBLIC_BASE_URL` | e.g., `https://yearoftheglizzy.com`. Used for permalinks and OAuth redirect. |
| `DISCORD_CLIENT_SECRET` | OAuth2 → General → Client Secret. **Not the bot token.** Without it, the game runs in dev-bypass mode. |
| `GAME_SESSION_SECRET` | HMAC key for the game session cookie. `openssl rand -hex 32`. Falls back to `ADMIN_PASSWORD` if unset. |
| `ANTHROPIC_API_KEY` | console.anthropic.com → API Keys |
| `ARCHIVE_CHANNEL_ID` | Right-click channel in Discord (Developer Mode on) → Copy Channel ID |
| `ARCHIVE_ANNOUNCE_CHANNEL_ID` | Optional, falls back to `ARCHIVE_CHANNEL_ID` |
| `DIGEST_CHANNEL_ID` | Optional, falls back to `ARCHIVE_ANNOUNCE_CHANNEL_ID` |

**DO Spaces (for attachments + avatars + DB backups)**

| Var | Notes |
|---|---|
| `DO_SPACES_KEY` | Access Key ID (full-access; read-only won't work) |
| `DO_SPACES_SECRET` | Secret access key |
| `DO_SPACES_ENDPOINT` | e.g., `https://sfo3.digitaloceanspaces.com` — region-only, no bucket prefix |
| `DO_SPACES_BUCKET` | e.g., `yotg` |
| `DO_SPACES_PUBLIC_BASE` | e.g., `https://yotg.sfo3.cdn.digitaloceanspaces.com` — the CDN URL prefix used by browsers |

**Operational**

| Var | Notes |
|---|---|
| `DB_PATH` | Defaults to `/database/data.db`. Override to `./hotdog-data.db` for local testing. |
| `BRAWL_TEST_MODE` | Local/test only. `=1` drops the GlizzyBrawl AFK despawn from 60s to 2s so the rule is testable and demoable. **Never set in prod.** |
| `GLIZZY_TEST_MODE` | Local only. `=1` makes golden glizzies spawn every 6–14s and drops the claim floor so the feature is demoable in seconds. **Never set in prod.** See `docs/golden-glizzy.md`. |
| `NIXPACKS_NODE_VERSION` | Pin to `22` (also in `package.json:engines.node`) |
| `NPM_CONFIG_OMIT=dev` + `NPM_CONFIG_PRODUCTION=` (empty) | Cosmetic — silences the npm deprecation warning during deploy |

**Discord Developer Portal config (manual, one-time)**

- Bot → Privileged Gateway Intents → enable **Message Content Intent** (required even for REST channel reads since 2022)
- OAuth2 → General → add redirect URI `${PUBLIC_BASE_URL}/oauth/callback`

---

## Running locally

```bash
# Skip the postinstall (Discord command push) if you don't have creds locally
npm install --ignore-scripts

# Boot pointing at the local DB copy (the prod DB lives in /database on Railway)
DB_PATH=./hotdog-data.db \
ADMIN_PASSWORD=devpassword \
PUBLIC_KEY=dummy \
DISCORD_TOKEN=dummy \
APP_ID=dummy \
node app.js
```

The game's OAuth flow enters **dev-bypass mode** when `DISCORD_CLIENT_SECRET`
is unset — `/oauth/login` short-circuits and logs in as the most recent
hotdog_events user so the game is playable end-to-end without a real Discord
round-trip.

The local repo includes `hotdog-data.db` (gitignored via `*.db`) — a snapshot
of the production database the owner downloaded for testing. There's also a
`*.db.bak` pattern in gitignore for backups.

---

## Deployment (Railway)

- **Auto-deploys from `main`.** The owner explicitly wants commits gated —
  don't push without confirmation.
- `npm run register` runs as `postinstall`, which re-publishes the slash
  command list to Discord on every deploy.
- Railway grace-shutdown was a problem (crash alerts on each deploy) — fixed
  in `app.js` with a SIGTERM handler that drains the HTTP server, closes the
  SQLite handle, and exits 0.
- **better-sqlite3 is pinned to ^12.x** because ^8.x has no Node 22 prebuilds.
  v12 returns integer columns as JS `Number` (not `BigInt`), so existing code
  still works.

---

## Operational notes

- **DB backups**: daily at boot+30s, weekly cron-style after that, plus a
  manual "Back up now" button at `/admin/backup`. Restore is documented in
  the recipe at `/admin/backup`: download `backups/latest.db.gz`, gunzip,
  `mv` over `/database/data.db` from a Railway shell, restart.
- **Archive reset**: `/admin/archive` → **Reset archive (DB + Spaces) and
  re-backfill** is destructive but bounded — wipes the `attachments/` prefix
  in Spaces and the four `archive_*` tables, then triggers a fresh tick.
- **Profile refresh**: `/admin/archive` → "Refresh profiles now" pulls every
  known user's Discord info + avatar. Daily worker also runs this.
- **Retry stories**: `/admin/archive` → "Retry story generation" clears
  `backfill_stories_complete_at` so the worker rebuilds. Per-window
  idempotency check skips weeks that already have stories — only gaps get
  re-processed.

---

## Future directions (discussed but not built)

- **Prestige system** in GlizzyClicker (reset for permanent multipliers).
  Numbers can already scale into Qa/Qi/Sx via the formatter. For *true*
  infinite-scale numbers (10^100+), swap client to `break_eternity.js`.
- **Pet/kid management / couples AI assistant** — separate project the owner
  is considering, likely on Telegram (best bot API). Not part of this repo.

---

## Owner preferences (learned)

- **Terse responses.** No fluff, no recap-of-what-I-just-did at the end of
  every message.
- **Don't commit or push.** The owner deploys manually. Always.
- **Confirm before destructive actions.** Even with admin auth, wraps
  destructive admin buttons in JS `confirm()` prompts.
- **Plasma palette, never red/green.** Owner is colorblind.
- **Match the existing brand**: dark slate background, accent
  `#ff6b35` (orange), Inter font.

If anything here drifts from the actual code, the code is the source of truth
and this doc should be updated. Last meaningful update: GlizzyBrawl
(`brawl-sim.js` / `brawl.js` / `brawl-page.js`, `/brawl`) + the repo's first
test suite (`npm test`); before that, the By the Numbers
page (`numbers.js`, `/numbers`) + `CONTEXT.md` glossary; before that, golden-buff
eclipse/queue stacking (no more downgrades) + out-of-order save-response guard;
before that, the Oracle (Konami-code purchase optimizer) + the client-side
`building_synergy` fix; before that,
lifetime total in the game's sticky bar + in-page leaderboard peek modal,
streak/protest fix, GlizzyClicker stale-save + tap-loss + golden-glizzy
claim-floor fixes, ×10/×100 buying, shared responsive nav, mobile
leaderboard/chart sizing.
