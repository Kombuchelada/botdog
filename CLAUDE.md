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
| `charts.js` | Server-rendered PNG charts via `@napi-rs/canvas` + Chart.js: heatmap, timeline, leaderboard, stat card, when-heatmap. Uses bundled Inter font. |
| `dashboard.js` | Public website. SSR'd HTML with Tailwind CDN + Chart.js CDN. Routes: `/`, `/users`, `/user/:id`, `/compare`, `/archive`, `/archive/:id`. |
| `admin.js` | Cookie-protected `/admin/*` admin UI. Edit/split/delete hot dog events, manage archive stories, backup/restore, retry/reset, refresh profiles, send digest. |
| `archive.js` | Channel poller + Spaces uploader + Claude story curator. Runs on `setInterval(POLL_INTERVAL_MS = 1h)`. Backfills history on first boot, then forward-polls. Weekly story job + daily digest dispatch + daily profile refresh run from the same tick. |
| `claude.js` | Anthropic SDK wrapper. `proposeStories({messages, attachmentsByMessageId, periodStart, periodEnd})` uses Sonnet 4.6 with a forced tool-call (`publish_stories`) for structured output. Resizes images via sharp, base64-encodes them (avoids URL fetch rate limits). HEIC→JPEG via `heic-convert`. |
| `digest.js` | Daily digest job. Fires once per Pacific day at/after 9 AM PT, posts an embed with yesterday's totals, top eaters, and active streaks. |
| `profiles.js` | Discord avatar mirror. Daily worker refreshes everyone in `hotdog_events`; OAuth login mirrors the logging-in user. Resizes to 256×256 PNG, uploads to `avatars/{user_id}-{hash}.png` in Spaces. |
| `do-spaces.js` | S3 client pointed at DO Spaces (signed with region from endpoint, force-path-style off). `uploadObject(key, body, contentType)` returns the public CDN URL. `deletePrefix(prefix)` for bulk cleanup. |
| `backup.js` | Hot-safe SQLite snapshot via `db.backup()`, gzip level 9, dual-upload as `backups/db-{ISO}.db.gz` + `backups/latest.db.gz`. Daily on `setInterval`, plus manual button in admin. |
| `oauth.js` | Discord OAuth2 (`identify` scope only). HMAC-signed cookie session. Dev-bypass mode when `DISCORD_CLIENT_SECRET` is unset — logs in as the latest hotdog_events user so the game is playable locally. |
| `glizzy.js` | GlizzyClicker game logic. Static `BUILDINGS` (5), `UPGRADES` (10), `ALL_BONUSES` (7). `computeBonuses(userId)` derives active modifiers from real hot dog stats. `validateAndClampSave` is server-authoritative anti-cheat. |
| `game.js` | GlizzyClicker UI. Self-contained game page with hand-drawn SVG mascot + building SVGs, vanilla JS game loop, save-every-5s + `sendBeacon` on close. Public leaderboard at `/game/leaderboard`. |
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
and this doc should be updated. Last meaningful update: GlizzyClicker
bonus rebalance (Big Eater ×100, Pope +500%, etc.) + sticky game-page columns.
