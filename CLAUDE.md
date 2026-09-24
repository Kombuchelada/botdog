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
| `backup.js` | Hot-safe SQLite snapshot via `db.backup()`, gzip level 9, dual-upload as `backups/db-{ISO}.db.gz` + `backups/latest.db.gz`. Every 30 min on `setInterval`, plus manual button in admin. `selectExpired` is the pure retention decision; `pruneBackups` applies it after each successful upload. |
| `oauth.js` | Discord OAuth2 (`identify` scope only). HMAC-signed cookie session. Dev-bypass mode when `DISCORD_CLIENT_SECRET` is unset — logs in as the latest hotdog_events user so the game is playable locally. |
| `glizzy.js` | GlizzyClicker game logic. Static `BUILDINGS`, `UPGRADES`, `ALL_BONUSES`. `computeBonuses(userId)` derives active modifiers from real hot dog stats. `validateAndClampSave` is server-authoritative anti-cheat (and anti-regression — see `save_seq` below). `loadGameForUser` credits offline production itself. `GOLDEN_BONUSES` + `claimGoldenGlizzy(userId)` is the golden-glizzy reward roll (server-authoritative; timed buffs live in `state.golden_effects`, weights sum to 1000 and each mega is weight 10 = 1/100). |
| `game.js` | GlizzyClicker UI. Self-contained game page with PixelLab pixel art (hero mascot, golden glizzy, building icons, emoji icon set — `assets/clicker/` via `manifest.json`, served at `/game/art/*`; the hand-drawn SVGs and raw emoji remain as per-surface fallbacks), vanilla JS game loop, save-every-5s + `sendBeacon` on hide/unload, ×1/×10/×100 buy quantity. Golden glizzy spawns client-side and claims via `POST /api/game/golden`. Public leaderboard at `/game/leaderboard`, plus an in-page peek modal (🏆 button / `L` key) fed by `/api/game/leaderboard`. Also hosts **the Oracle** — a Konami-code-gated purchase optimizer (`docs/oracle.md`). |
| `scripts/clicker-import-art.mjs` | Imports GlizzyClicker's pixel art from a staging dir into `assets/clicker/` + `manifest.json`. Gates: exact size per kind (hero/golden 120×90, buildings 40×40, emoji 32×32 — never resamples), transparent corners, content ≥20% of canvas. Owns `EMOJI_NAMES`, the emoji-character → icon-name table. Recipe: `docs/clicker-art.md`. |
| `scripts/lib/pixel-art.mjs` | Image ops for art importers: flood-fill de-background, chroma key, alpha bounding box. |
| `season.js` | The Year of the Glizzy's end: 2027-01-01 00:00 Pacific. `SEASON_END`, `isSeasonOver()`, and `seasonNow()` (the real clock, then pinned to the season's last instant). Imports nothing so `database.js` can bind it into the season-scoped statements. |
| `awards.js` | `computeAwards(events)` — pure: final standings (ties share a place), the year-end awards, group totals. Every award nets protests. The one source the finale's embed, the memorial and the Year in Review all read. |
| `finale.js` | What happens once at 12:01 AM Pacific on New Year's Day: results embed, the last partial week's stories, the Claude Opus 5.5 Year in Review (`writeYearInReview` in `claude.js`). `buildResults()` also feeds the memorial front page. |
| `achievements.js` | One-off pop-ups appended to `/hotdog` responses when a user crosses a milestone (10/25/.../1000 lifetime, 5/10/15/20 single sitting, 3/7/14/30/60/100/365 streak). |

### Schema (all in `database.js`, additive `CREATE TABLE IF NOT EXISTS`)

- `hotdog_events` — original counter. Negative amounts are valid (protests). Auto-created.
- `hotdog_totals` (view) — sums above.
- `archive_messages`, `archive_attachments`, `archive_stories`, `archive_state` — archive feature.
- `user_profiles` — Discord identity + avatar URL cache.
- `glizzy_game` — game state JSON + `lifetime_glizzies` extracted for leaderboard index.

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
- **Heatmaps start no earlier than 2025-12-31** and cap at 53 weeks — the
  whole season, Sun 2025-12-28 through Sat 2027-01-02. Constants in both
  `charts.js` (`HEATMAP_START_ISO`, `HEATMAP_MAX_WEEKS`) and `dashboard.js` —
  kept in sync manually.
- **The competition ends; the game doesn't.** The Year of the Glizzy is a
  season ending 2027-01-01 00:00 Pacific (`season.js`). Every statement that
  feeds a leaderboard, the dashboard, a chart, `/stats` or the digest reads
  only rows logged before it — that's why `getAllEventsStmt`,
  `getLeaderboardStmt`, `getTotalHotdogsStmt`, `getUserTotalStmt` keep their
  plain names. GlizzyClicker reads `getLifetime*` instead and keeps paying
  bonuses for dogs eaten in 2027 and beyond, forever. `/hotdog` keeps logging
  after the season (its reply reads lifetime and adds a "2026 is closed" line).
  There is deliberately no season *start*. Anything that counts back from
  "today" on a competition surface reads `seasonNow()`, which pins to the
  season's last instant once it's over — otherwise streaks zero out and
  heatmaps drift into empty 2027 weeks. `getCurrentStreak` takes the clock as
  an argument for this reason; the game passes the real one.
- **The finale runs once, at 12:01 AM Pacific on New Year's Day** (`finale.js`):
  results embed, stories for the season's last partial week, then the Year in
  Review. Each step records itself in `archive_state` and fails independently,
  so a restart can't double-post and a Discord outage can't cost the story.
  It's a once-a-minute check, not a timer — `setTimeout` overflows past ~24.8
  days. The Year in Review gets three attempts, then waits for a human. The
  weekly story job and the daily digest stop at the season end. Every finale
  surface reads `computeAwards` (`awards.js`), so the embed, the memorial
  front page and the story can't disagree about who won; every award nets
  protests like everything else here. Preview it against a real DB with
  `scripts/finale-preview.mjs` (`--write` drafts the Year in Review for ~$0.25
  without saving or posting). Tests: `test/season.test.js`,
  `test/awards.test.js`, `test/finale.test.js`.
- **Discord bot is HTTP-only** (interactions endpoint), no gateway/WS
  connection. Archive ingest polls via REST.
- **Commits are fine; pushing to `main` is not, without explicit confirmation.**
  The Railway deploy pipeline auto-deploys from `main`, so a push to `main` ==
  shipping. Committing and pushing *other* branches is fine any time — only the
  push to `main` is gated on the owner asking for it.
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
- **A day is worth what it *nets*, and that rule is not just for streaks.** A
  protest is a free-floating negative row filed at protest time — it never
  retracts the submission it disputes and nothing links the two — so anything
  reading raw positive rows credits a meal that was argued away. Three places got
  this wrong and all failed silently, because a phantom bonus and a phantom
  record look exactly like real ones: `computeBonuses` filtered to `amount > 0`
  and paid Big Eater ×100 plus the time-of-day boons on a day protested back to
  zero, the `/stats` single-sitting record came off a raw `MAX(amount)`, and the
  public dashboard's front-page "Biggest single" (`buildOverview` in
  `dashboard.js`) reduced raw rows the same way — so Tilor's protested-away 75
  headlined the site after `/stats` was already fixed.
  `cappedSittings` in `stats.js` (now exported) caps every sitting by its day's
  net; both records run through it, and there is deliberately no `MAX(amount)`
  statement in `database.js` any more. The boons are gated on the day netting
  positive. Partial protests keep the boon —
  nothing says *which* dog was disputed. `test/protest-accounting.test.js`.
  What the day-net rule still can't fix: a protest filed the *next* day lands on
  that day, so yesterday's inflated total stands for one more bonus cycle. The
  fix for that is attributing protests to the events they cancel, which is a
  schema question (`/protest` takes an amount, not an event) — not done.
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
- **The anti-cheat budget covers the save *window*, not the save *instant*.**
  Golden buffs expire on a wall clock and saves fire every 5 s, so a save
  routinely covers seconds that were buffed and lands after the buff has gone.
  `computeEffectiveRates` therefore takes an optional `at` timestamp and
  `validateAndClampSave` evaluates both endpoints — the earning **ceiling**
  takes the higher, the passive **floor** takes the lower. They want opposite
  endpoints and swapping them is the easy mistake: a max on the floor credits
  production that never happened. Harmless-looking while every buff ran for
  minutes; it ate up to a third of the 15 s DEMON DOG and the 10 s GOLDEN RUSH,
  which are the rewards a player sees once in a hundred glizzies and is
  guaranteed to notice losing.
- **Click power has to scale with production, or clicking stops being the
  game.** Every `click_mult` / `click_per_building` upgrade multiplies a base of
  1 — a fixed number racing an exponential one — so past the mid-game a tap was
  a rounding error against /s in a game called GlizzyClicker. The
  `click_from_pps` line (Hands-On Management → The Glizzy Touch) adds a share of
  the player's *own* per-second production to every click, totalling 10% of /s,
  which is tuned so a human mashing ~10 clicks/s roughly doubles their income
  while playing and gains nothing while idle. The share is added **outside** the
  click multipliers — stacking the ×1.3M click ladder on it would make one tap
  worth days of production — but **inside** golden click buffs, which are the
  only mash-right-now reward and would otherwise be the one buff that gets
  weaker the richer you are. Pinned by `test/glizzy-click.test.js`; the client's
  `computeRatesFor` mirrors it (see the rule below).
- **A golden-glizzy click buff is player-interaction only, and that is a
  deliberate exemption.** Tap Frenzy (×6/60 s) and DEMON DOG (×666/15 s)
  multiply `perClick` and nothing else — no production, no offline earnings,
  nothing whatsoever for a player who catches one and walks away. They are the
  only rewards not denominated in "minutes of production", the only ones worth
  *more* to a new player than a rich one, and they cost the late game ~9% of the
  table's expected value to add. All of that is intended; see
  `docs/golden-glizzy.md` before retuning either. What is *not* optional is that
  they go through `computeEffectiveRates` like every other buff — a click buff
  the server doesn't know about gets clamped straight back off.
- **`GOLDEN_BONUSES` weights sum to 1000 and a `mega` is weight 10.** Golden
  Rush spent its life at weight 1 and literally no player ever saw it: the spawn
  timer only advances while the page is open, making 1/1000 a ~92-hour career
  event. A 1/1000 mega suits a game left running on a background tab for months;
  this is not that game.
- **GlizzyClicker art is manifest-driven with per-surface fallback.** `game.js`
  reads `assets/clicker/manifest.json` at boot; a missing PNG (or the whole
  directory) reverts exactly one surface to its hand-drawn SVG or raw emoji,
  never the page. Pixel art draws only at integer multiples of its native size
  (hero ×3, golden ×2, icons ×1 or ÷2) with `.px-art` (`image-rendering:
  pixelated`) — a 24px icon or a 150px golden shears the pixel grid unevenly.
  The golden glizzy is a programmatic gold hue-remap of the hero, not a
  generation, so the silhouette always matches. See `docs/clicker-art.md`.
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
- **`npm test` is Node's built-in `node:test`, zero new dependencies.**
  Tests call pure functions and the DB through a scratch `DB_PATH`.
  `test/backup-retention.test.js` covers the only code in the repo that deletes durable data, and an over-eager
  policy throws nothing — it shows up the day a snapshot someone needs is gone.
  It calls `selectExpired` and nothing else: no S3, and the clock is an
  argument, so the suite cannot behave differently depending on when it runs.
- **Backups are the whole durability story, so their retention deletes on
  positive evidence only.** Railway's volume backups and PITR are Pro-plan
  features and this project is on Hobby, so `backups/` in Spaces is the only
  copy of anything — which is why the cadence is 30 minutes, not daily. The
  policy keeps every snapshot for 7 days and then the *first of each UTC day*
  forever, rather than the obvious "delete anything older than N days": the
  daily trail predates the half-hourly cadence, so a plain age cutoff destroys
  months of history on its first run. `selectExpired` is pure and takes the
  clock as an argument, so it can be dry-run against the live bucket and tested
  without S3 (`test/backup-retention.test.js`). It also never sees
  `backups/latest.db.gz` — that key doesn't match the `backups/db-` prefix, so
  the one the restore recipe names is structurally out of reach of a policy
  bug. Reading and gzipping are async on purpose: the sync versions were a
  shrug once a day and a real event-loop stall at 48 times a day.
  See `docs/adr/0004-backups-live-in-object-storage.md` — including why
  Railway's own volume backups are not the answer, so it isn't re-litigated.
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
| `SEASON_END_OVERRIDE` | Local only. An ISO timestamp that moves the season's end, so the post-season site (memorial, frozen stats, finale) can be previewed now against a real DB. **Never set in prod** — it moves the finish line. |
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

- **Auto-deploys from `main`.** So don't push to `main` without the owner
  asking — that push is the deploy. Commits and pushes to other branches are
  fine any time.
- `npm run register` runs as `postinstall`, which re-publishes the slash
  command list to Discord on every deploy.
- **Deploys must launch `node app.js` directly, never `npm start`** —
  `railway.json` pins `startCommand`. Nixpacks' default (`npm run start`) put
  npm at PID 1, and npm dies on SIGTERM (status 143 = crash alert) *without
  forwarding it*, so the `app.js` SIGTERM handler never ran in prod and the
  orphaned app served until SIGKILL. This is why adding the handler alone
  didn't stop the per-deploy crash alerts. Verifiable locally: SIGTERM the
  top-level PID only — a terminal masks the bug by signalling the whole group.
- `railway.json` also sets `drainingSeconds: 30` — Railway's default grace
  between SIGTERM and SIGKILL is **0 seconds**. The 20s force-exit failsafe in
  `app.js` must stay below it.
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
- **Commit freely; never push to `main` unasked.** A push to `main` deploys,
  so that one is gated on the owner asking. Other branches are unrestricted.
- **Confirm before destructive actions.** Even with admin auth, wraps
  destructive admin buttons in JS `confirm()` prompts.
- **Plasma palette, never red/green.** Owner is colorblind.
- **Match the existing brand**: dark slate background, accent
  `#ff6b35` (orange), Inter font.

If anything here drifts from the actual code, the code is the source of truth
and this doc should be updated. Last meaningful update: the Year of the
Glizzy got an ending — `season.js` bounds the competition at 2027-01-01
00:00 Pacific while GlizzyClicker reads lifetime, `awards.js` computes the
trophies, `finale.js` posts the results and has Claude Opus 5.5 write the
Year in Review at 12:01 AM, and the front page becomes a memorial; before
that, GlizzyBrawl (`/brawl`)
removed entirely — unused; `database.js` drops its `brawl_stats` table on
boot; before that, protests now actually
take the dogs back — `computeBonuses` nets the day instead of summing positive
rows, and the single-sitting record is capped by its day's net
(`cappedSittings` in `stats.js`, `test/protest-accounting.test.js`); before
that, backups moved to a
30-minute cadence with a retention policy — `selectExpired`/`pruneBackups` in
`backup.js`, `listObjects`/`deleteObjects` in `do-spaces.js`, and
`test/backup-retention.test.js`; reading and gzipping went async so 48
backups a day don't stall the event loop. Prompted by a Railway volume that
hung in uninterruptible `D` state on 2026-08-10 and took the app down with
`SQLITE_BUSY` (a symptom of the unkillable process holding the file lock, not
a code bug), and by Railway's own volume backups being Pro-only; before
that, GlizzyClicker's
`click_from_pps` upgrade line — four upgrades that pay a share of your own
production per click so clicking still matters at the top of the tree
(`glizzy.js`, the `computeRatesFor` mirror in `game.js`,
`test/glizzy-click.test.js`, plus three new emoji icons 🖐️ 🧑‍🍳 🤲); before
that, GlizzyClicker's art
replaced with PixelLab pixel art — hero mascot, golden glizzy (gold remap of
the hero), 12 building icons, and a ~67-icon emoji replacement set
(`assets/clicker/` + `scripts/clicker-import-art.mjs` + `/game/art/*` route,
per-surface fallback to the old SVGs/emoji, `docs/clicker-art.md`); before
that, the per-deploy crash
alert diagnosed and fixed — `railway.json` (startCommand `node app.js` +
`drainingSeconds: 30`) so SIGTERM actually reaches node; before that, golden-glizzy click
buffs (Tap Frenzy ×6/60 s, DEMON DOG ×666/15 s) — the table's first
player-interaction-only rewards — plus the mega rate moving from 1/1000 to
1/100, the clamp-window fix in `validateAndClampSave`, GlizzyClicker's first
tests (`test/glizzy-golden.test.js`) and a `### GlizzyClicker` section in
`CONTEXT.md`; before that, GlizzyBrawl (since removed) + the repo's first
test suite (`npm test`); before that, the By the Numbers
page (`numbers.js`, `/numbers`) + `CONTEXT.md` glossary; before that, golden-buff
eclipse/queue stacking (no more downgrades) + out-of-order save-response guard;
before that, the Oracle (Konami-code purchase optimizer) + the client-side
`building_synergy` fix; before that,
lifetime total in the game's sticky bar + in-page leaderboard peek modal,
streak/protest fix, GlizzyClicker stale-save + tap-loss + golden-glizzy
claim-floor fixes, ×10/×100 buying, shared responsive nav, mobile
leaderboard/chart sizing.
