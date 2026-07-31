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
| `brawl-art.js` | GlizzyBrawl Fighter art. Every action is a **clip** (`CLIPS`), and `frameFor(fighter, nowMs)` returns `{ clip, index }` from a snapshot — attacks driven by their own frame counter against the move's frame data, hitstun/dodge by the sim's timers, the air clips by vertical velocity, only the walk on a clock. Also the signature-move flourish layer (`flourishFor` / `drawFlourish`). All four Fighters have bespoke PixelLab art (south-east 3/4) in `assets/brawl/`; the only borrowed art left is Kenney's CC0 zombie for CPUs, whose clips are one frame each. Shared with the browser at `/brawl/art.js` and with `scripts/brawl-art-preview.mjs`, which renders the roster as a filmstrip so the *mapping* can be judged without a browser. |
| `scripts/brawl-import-sprites.mjs` | Imports bespoke Fighter art, one `--clip` per action — de-backgrounds, trims, resamples each animation to the length `CLIPS` declares, scales the whole set uniformly, plants feet on the floor line, updates `assets/brawl/manifest.json`. Fails if a peak clip's most extreme frame is its first (a dead animation). `--frame-width` is the per-Fighter apparent-size dial and records itself per Fighter so one import can't resize another. Recipe: `docs/glizzybrawl-art-brief.md`. |
| `scripts/brawl-art-measure.mjs` | Gates keyframe picks on measured alpha bounding boxes (crouch ≤75% of standing height, attack ≥+15px extension, hurt ≥3px lift) instead of on judgement. |
| `brawl-stage.js` | GlizzyBrawl's Stage — **the Ballpark**, a night game seen from the outfield. Composed from props at native scale (scoreboard rig, light towers, crowd band, a 32px wall tileset, three Catwalks), not painted as one image. The scene is *derived* from the sim's `STAGE`, so a platform can't move out from under its Catwalk. `planScene` is the pure fallback decision (art → primitive → sky); placement lives here as readable coordinates. Shared with the browser at `/brawl/stage.js`. See `docs/glizzybrawl-stage-brief.md`. |
| `scripts/brawl-import-stage.mjs` | Imports Ballpark props — chroma-keys the background out, trims, cuts to the size the scene draws them at, records bounds in the manifest. Three gates fail the import: **scale** (a prop must land 1:1, never resampled — the fix is to put the art's size into `LAYOUT`), **floor** (the wall cap's surface must be on the wang midline, or the wall sits off the floor line) and **clearance** (nothing standing above a Catwalk's walk line — a phantom railing). |
| `scripts/lib/pixel-art.mjs` | The image ops both importers need: flood-fill de-background, chroma key, alpha bounding box. Shared because two copies had already drifted (`hexToRgb` fell back to white in one and black in the other). |
| `scripts/brawl-stage-preview.mjs` | Renders the Ballpark to a PNG from `brawl-stage.js` itself, and gates silhouette contrast — each Fighter's `stand` over the backdrop at all eight spawn points. `--baseline` measures the placeholder Stage, which is where the threshold comes from. |
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
- **A GlizzyBrawl action is a clip, and its `contact` frame is pinned to the
  move's first *active* frame.** Wind-up plays over the startup, contact holds
  for exactly the hitbox's lifetime, recovery plays over the endlag — so one
  4-frame clip per attack reads correctly on a 3-frame jab and a 16-frame
  launcher alike, and the moment a Fighter looks most committed is the moment it
  can actually hit you. Clip lengths live in `CLIPS` in `brawl-art.js` (not the
  manifest — the browser reads them without a fetch), are the same for every
  Fighter so timing belongs to the move, and are *gated* at import rather than
  generated. Same call as the Stage's `LAYOUT`.
- **A duration GlizzyBrawl's art animates is reported by the sim.** The snapshot
  carries each attack's `startup`/`active`/`endlag` and each timed state's
  remaining ticks *and* its total (`hitstun`/`hitstunTotal`,
  `dodgeTicks`/`dodgeTotal`). The alternative is `brawl-art.js` holding its own
  copy of `DODGE_TICKS` and the hitstun formula — a second source of truth for
  numbers the sim owns. Almost nothing in the art is on a clock as a result:
  only the walk cycle, which has no state of its own to track.
- **Every GlizzyBrawl Fighter now has art of its own**, generated through
  PixelLab, so `bodyFor` is `cpu ? zombie : character` and nothing branches on
  a manifest list any more. The costume layer, the bespoke list and the four
  borrowed Kenney bodies are all deleted — with no users left they were just a
  second way to draw a Fighter for the renderer and its preview to disagree
  about. The CPU keeps a Kenney zombie on purpose. Anything committed under
  `assets/` must permit redistribution: this repo is public, which rules out
  most itch "free" packs.
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
  small. `--frame-width` is the dial in both directions — widen to grow, narrow
  to shrink — and it records itself per Fighter in the manifest *and reads it
  back*, so one import can neither resize the next nor silently undo a tuning
  when the flag is left off. That is how the roster gets its ~15% size spread
  (Grill 84.5% of frame height, everyone else 97.3%) with no regeneration.
- **The roster preview must agree with the Arena.**
  `scripts/brawl-art-preview.mjs` once drew bespoke art at Kenney's aspect ratio
  while the game drew it correctly — a preview tool that disagrees with the
  thing it previews is worse than none. It also has to throw each Fighter's
  *own* special: a shared move name showed every row The Glizzy's and hid the
  flourishes the preview exists to check. It is a **filmstrip** now, walking
  each action forward in real sim time and shading the frames on which the move
  can hit: a grid of stills cannot show whether the animation lands contact
  inside the hitbox, which is the thing most likely to be wrong.
- **The Stage is derived from the sim, never described alongside it.**
  `buildScene(STAGE)` takes the sim's geometry as an argument (it can't import
  it — the browser's specifier for `brawl-sim.js` isn't the server's) and places
  every Catwalk from `STAGE.platforms`. A scene with its own copy of the
  coordinates is the one way this feature can break *silently*: move a platform
  and the art keeps drawing at the old width over a surface that's no longer
  under it. What the test pins is the part deriving can't fix — that each
  Catwalk's art was *generated* at its platform's width.
- **Every Stage surface falls back to its placeholder shape, per surface.** A
  missing prop costs one piece: the wall can be bespoke while the Catwalks are
  still orange bars. Backdrop props (board, towers, crowd) fall through to sky
  instead, because they hide nothing — inventing a grey box for them would ship
  a placeholder that looks like a bug. Nothing may make a *surface* invisible;
  Fighters standing on an invisible floor is the failure this rule exists for.
- **Stage props are drawn 1:1 and generated on a chroma key.** The Ballpark is
  composed from props precisely because no upscale of a 400×400 backdrop to
  1280×720 gives pixels the same size as the Fighters' — so resampling a prop on
  the way in loses that by the back door. The importer refuses it: the fix is to
  put the art's own size into `LAYOUT`, where placement lives and is meant to be
  iterated. And props are generated on magenta rather than "transparent",
  because an edge flood fill can never reach the background trapped inside a
  lattice truss's bracing, and `no_background` is also what made PixelLab's
  `create_image_pro` stall at 49% indefinitely.
- **A wang tile's terrain boundary is its midline, not its edge.** The wall
  tileset's cap tile is air above the midline and wall below it, so the scene
  offsets the whole tile grid by half a tile in both axes. Line the grid up with
  `STAGE.ground` instead and the walking surface lands 16px below the floor the
  sim collides against — Fighters standing in the wall. Tiles are also copied
  verbatim at import: trimming one and stretching what's left doubles a cap
  tile's pixels and slides the wall face half a tile sideways, both silently.
- **The Stage's art gates live at import and in the preview, not in `npm test`.**
  A floating floor and a phantom railing are properties of an asset, and assets
  change only when art is imported — so they fail `scripts/brawl-import-stage.mjs`,
  at the moment the art is wrong. Silhouette contrast is measured in the preview
  script against a floor *derived* from the placeholder Stage (`--baseline`),
  which is known-readable. `test/brawl-stage.test.js` stays pure — no canvas, no
  images — like the art seam beside it.
- **No GlizzyBrawl KO involving a CPU is ever persisted**, and neither is Arena
  time during practice. CPUs exist only while a lone human is present, so
  "are there CPUs in the Arena?" is the entire check — there is never a
  human-vs-CPU KO to disambiguate.
- **Hot dog stats are cosmetic-only in GlizzyBrawl.** `computeCosmetics` may
  grow crowns/trails/finishes and nothing else; no weight, speed, damage, reach,
  or knockback may ever derive from a hot dog stat. This reversed the original
  pitch on purpose.
- **A signature-move flourish is its own layer, not part of a Fighter's art.** The splat at
  Ketchup's nozzle and The Grill's roaring coals live in `FLOURISHES` and are
  drawn for *every* Fighter. Inside the old costume closures they were gated on
  the manifest, so giving a Fighter bespoke art silently deleted its special's
  effect — fatal for Flare-Up, whose 16-frame wind-up the coals are the only
  warning of. Progress comes from the attack's own frame counter, never the
  clock. A back-layer flourish must also be *wider* than a Fighter: a single
  flame up the centre line is completely hidden by the body.
- **`npm test` is Node's built-in `node:test`, zero new dependencies.** The two
  seams are the WebSocket boundary (primary) and the sim's public API. Tests
  assert what a connected client observes and what the ledger records — never
  internal state shapes or tick bookkeeping. `test/brawl-art.test.js` is a
  deliberate third seam and the only one: neither other seam can observe art,
  and the flourish layer has a silent failure mode. It tests pure functions
  only — no canvas, no images, and never the order layers draw in.
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
Fighter animation — every action a clip driven by
sim state, with contact pinned to the hitbox
(`brawl-art.js`, `scripts/brawl-import-sprites.mjs`); before that, GlizzyBrawl
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
