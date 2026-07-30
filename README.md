# 🌭 Year of the Glizzy

> What started as a single `/hotdog` slash command has become a multi-surface
> hot-dog-tracking platform with a Discord bot, a public dashboard at
> [yearoftheglizzy.com](https://yearoftheglizzy.com), an auto-curated story
> archive, and an idle game whose bonuses are powered by your real eating
> habits.

This repo holds the whole stack: bot, web app, admin tools, game, and the
glue that ties them together.

## What it does

### Discord bot

| Command | What it does |
|---|---|
| `/hotdog amount:N` | Logs `N` hot dogs to your name. Crossing milestones (10/25/50/100/250/500/1000 lifetime, 5/10/15/20 in one sitting, 3/7/14/30/60/100/365-day streaks) triggers an inline celebration in the response. |
| `/protest user amount` | Calls out another user for a bad submission. Requires a second to confirm. Inserts a negative-amount event. |
| `/leaderboard*`, `/stats` | Text leaderboards for total, streak, single-day, single-sitting, active-streak. |
| `/chart heatmap [user]` | GitHub-style calendar of daily activity (colorblind-safe plasma palette). |
| `/chart timeline [user]` | Cumulative consumption over time. |
| `/chart leaderboard [limit]` | Top-N horizontal bar chart with avatars. |
| `/chart card [user]` | Single-user stat card: avatar, totals, streaks, mini-heatmap. |
| `/chart when [user]` | When-do-dogs-get-eaten heatmap (day-of-week × hour-of-day). |
| `/glizzy leaderboard \| me \| play` | GlizzyClicker (idle game) stats and link. |

All `/chart` subcommands render real PNGs server-side and post them as
attachments — no third-party chart service.

### Public website

- **`/`** — server-wide overview: hero number, cumulative timeline,
  leaderboard, top-10 cumulative comparison, "when dogs get eaten" heatmap,
  full-year activity heatmap, GlizzyClicker leaderboard.
- **`/users`** — searchable list of every user with avatar.
- **`/user/:id`** — per-user dashboard with personal timeline, heatmap,
  when-chart, and recent submissions.
- **`/compare?ids=a,b,c`** — N-user comparison page with stacked timelines
  and side-by-side stat cards.
- **`/archive`** — magazine-style feed of curated stories (see below).
- **`/archive/:id`** — permalink with proper Open Graph tags so iMessage /
  Slack / Twitter unfurls show a real preview.

### Auto-curated story archive

The bot polls a designated channel, downloads every attachment to DO Spaces
(HEIC→JPEG transcoding included so iPhone photos work cross-browser), groups
messages into weekly windows, and asks Claude Sonnet 4.6 to identify
"significant events" worth turning into short magazine-style stories.

- Backfills the entire channel history on first boot.
- Weekly job afterwards.
- Per-window idempotency check — windows that already have a story are
  skipped on retries.
- Posts a rich Discord embed when a new story publishes (after the initial
  backfill completes, so the channel isn't carpet-bombed).
- Multi-image carousel display with prev/next buttons, dot indicators,
  and inline `<video>` for clips.
- Tag filter chips on `/archive?tag=foo` — Claude assigns 2–3 tags per story.
- Admin can edit / hide / regenerate stories via `/admin/archive`.

### GlizzyClicker

A Cookie-Clicker-style idle game at `/game` (Discord OAuth required).
What makes it different: **every bonus is derived from your real hot dog
stats in Discord**.

- **Big Eater** (×100 click): eat >4 dogs yesterday IRL.
- **Breakfast Boon** (Mustard Stand +500%): eat a dog before 8 AM PT.
- **Night Owl** (Glizzy Cart +500%): eat a dog after 10 PM PT.
- **Streak** (+2% / day, **uncapped**): maintain a 3+ day eating streak.
- **Centurion / Half-Grand / Glizzy Pope** (+100% / +250% / +500% global):
  permanent at 100 / 500 / 1,000 lifetime dogs.

5 buildings (Mustard Stand → Stadium Vendor), 10 upgrades, offline production
capped at 4 hours, server-authoritative anti-cheat that clamps clicks to a
plausible rate and rejects building purchases the player couldn't have
afforded. Numbers scale through K/M/B/T/Qa/Qi/Sx/Sp/Oc/No/Dc with a
scientific-notation fallback.

### GlizzyBrawl

A realtime Smash-style platform fighter at `/brawl`. One always-on **Arena**
that never concludes — drop in, get KO'd, respawn, leave whenever. Anyone can
watch logged out; a Discord login and a Fighter pick puts you straight in the
fight with no lobby or queue.

- **Four Fighters**: The Glizzy (balanced, *Snap*), Ketchup (fast/light,
  *Splat*), The Grill (heavy, *Flare-Up*), Corn Dog (reach, *Pogo*).
- **Smash-style combat**: Percent + knockback, blast-zone KOs, double jump,
  fast-fall, drop-through, light/heavy with direction variants, cooldown dodge.
  No shields, no grabs.
- **Server-authoritative 30Hz sim** over bare `ws`, in the same Node process.
  The browser runs the *same* simulation file for client-side prediction.
- **All-time KOs/Falls** scoreboard plus a Pacific **Day Tally**; lifetime KO
  Streak, Arena time, and per-character KOs are remembered forever.
- **Hot dog stats unlock cosmetics only** — crowns, trails, finishes. Nothing you
  eat ever changes a fight.
- **CPUs to spar with** when you are alone; they vanish when a human arrives
  and leave no stats behind.
- Controller (Gamepad API, Smash layout) and keyboard (WASD *and* arrows, both
  live) supported.

See [docs/glizzybrawl.md](docs/glizzybrawl.md).

### Admin panel

Cookie-protected `/admin` with:

- **Hot dog events**: view/edit/delete/create. **Split** turns a single
  multi-dog submission into N rows (preserves user, timestamps staggered 1s
  apart). Works for negative protests too.
- **Archive stories**: edit title/body/tags/hero, hide, regenerate from
  source messages, "retry story generation" for missed windows, full reset
  (DB + Spaces).
- **Daily digest**: manual "send now" button bypassing the 9 AM gate.
- **User profiles**: refresh avatars from Discord.
- **Backups**: status + manual snapshot trigger.

### Daily digest

Posts a Discord embed each morning at 9 AM Pacific with yesterday's eaters,
totals, and active streaks.

### Database backups

Daily hot-safe SQLite snapshots compressed with gzip and uploaded to DO
Spaces under `backups/db-{ISO}.db.gz` plus an always-current
`backups/latest.db.gz`.

## Architecture

```
                ┌─────────────┐
                │   Discord   │
                └──┬────────┬─┘
                   │        │
       POST /interactions   │ REST polling
                   │        │
       ┌───────────▼────────▼───────────┐         ┌──────────────────┐
       │           Express app          │◄────────│ Browser (web UI) │
       │   (Node.js, single process)    │         └──────────────────┘
       │                                │
       │  ├─ /interactions  (slash cmds)│
       │  ├─ /api/* (read-only JSON)    │
       │  ├─ /admin/* (cookie auth)     │
       │  ├─ /oauth/* (Discord OAuth)   │
       │  ├─ /game, /game/leaderboard   │         ┌──────────────────┐
       │  ├─ /brawl + /brawl/ws (30Hz)  │
       │  ├─ /api/game/* (save/state)   │────────►│   DO Spaces      │
       │  └─ /, /users, /archive, etc.  │  put    │ (attachments,    │
       │                                │         │  avatars,        │
       │  Background workers:           │         │  db backups)     │
       │  • Hourly archive poll/ingest  │         └──────────────────┘
       │  • Weekly Claude story job     │
       │  • Daily digest (9 AM PT)      │         ┌──────────────────┐
       │  • Daily profile refresh       │────────►│  Anthropic API   │
       │  • Daily DB backup             │  POST   │  (Sonnet 4.6)    │
       │                                │         └──────────────────┘
       │  ┌──────────────────────────┐  │
       │  │ SQLite (better-sqlite3)  │  │
       │  │ /database/data.db        │  │
       │  └──────────────────────────┘  │
       └────────────────────────────────┘
                       │
                Hosted on Railway
```

Everything runs in one Node.js process. SQLite (better-sqlite3) lives on a
Railway volume. Object storage (attachments, avatars, DB backups) is DO
Spaces with CDN.

## Local development

```bash
# Clone, install (skip postinstall if you don't have Discord creds)
git clone <repo>
cd botdog
npm install --ignore-scripts

# The repo includes a snapshot of the production DB at hotdog-data.db
# for local testing (gitignored). Use it via DB_PATH.

DB_PATH=./hotdog-data.db \
ADMIN_PASSWORD=devpassword \
PUBLIC_KEY=dummy \
DISCORD_TOKEN=dummy \
APP_ID=dummy \
node app.js

# Visit http://localhost:3000/
```

The game's OAuth flow has a **dev-bypass mode** when `DISCORD_CLIENT_SECRET`
is unset — `/oauth/login` auto-logs you in as the most-recently-active user
so the game is fully playable locally without a real Discord round-trip.

For everything you need to know about modules, schema, env vars, ops, and
conventions, see **[CLAUDE.md](./CLAUDE.md)**.

## Tech stack

- **Node.js 22** (ESM), Express 4
- **SQLite** via better-sqlite3
- **Discord interactions** (HTTP-only, no gateway/WS)
- **Anthropic SDK** — Sonnet 4.6 for story curation
- **`@napi-rs/canvas` + Chart.js** for server-rendered PNGs
- **sharp** + **heic-convert** for image processing
- **Tailwind CSS** via CDN, Chart.js + chartjs-adapter-date-fns via CDN
- **`@aws-sdk/client-s3`** for DO Spaces (S3-compatible)
- **Inter font** bundled via `@fontsource/inter`
- **Hosted on Railway**, attachments + backups on DO Spaces (sfo3)

## Deployment

Auto-deploys from `main` to Railway. The `postinstall` script runs
`npm run register` which re-publishes the slash command list to Discord
on every deploy.

Don't push without intending to deploy.

## Credits

Started from
[discord/discord-example-app](https://github.com/discord/discord-example-app)
and grew from there. The Discord OAuth flow, archive curation pipeline,
chart renderer, dashboard, admin panel, GlizzyClicker game, and everything
else was built incrementally over a few weeks of pair-programming sessions
with Claude Code.

## License

MIT — see [LICENSE](./LICENSE).
