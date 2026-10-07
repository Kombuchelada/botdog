# The Autoplayer

A personal program that plays GlizzyClicker for you through the real game page
(see **Autoplayer** in `CONTEXT.md`). It clicks the glizzy at the server's limit,
claims every golden glizzy, and buys the best purchase as soon as it can afford
it. It isn't served by the site; it runs on your machine against
`yearoftheglizzy.com`.

## Setup

```bash
npm install --ignore-scripts
npx playwright install chromium          # Linux Mint: also `sudo npx playwright install-deps chromium`
node scripts/autoplayer.mjs login        # a Chromium window opens; log in with Discord once
```

`login` saves a persistent Chromium profile to `~/.glizzy-autoplayer/profile`
(`--profile` to move it). The session lasts 30 days. When it expires the
Autoplayer stops with "Session expired". Run `login` again.

It's headless Chromium on every platform (macOS and Linux alike). Safari
support was built first and dropped: an automation session can't share your
Safari login, locks the window, and stops golden glizzies whenever the window
is covered.

## Running

```bash
node scripts/autoplayer.mjs run                       # headless, live TUI
node scripts/autoplayer.mjs run --headed              # watch it play in a window
node scripts/autoplayer.mjs run --plain               # one line per event, no TUI
node scripts/autoplayer.mjs run --url http://localhost:3000
```

It runs until Ctrl-C.

**The TUI** redraws once a second. It shows bank, production, per click (and
what 25/s of it earns), the next purchase with its ETA, running golden buffs
(running ▶, queued, or outranked by a stronger buff in the same group), your
hot dog bonuses, the leaderboard, and the newest events below.

The leaderboard is `/api/game/leaderboard` (public, top 50), fetched every 10 s
by the launcher, with your own line replaced by your live numbers. Everyone
else is shown as stored, the same as on the site. ● marks a player who saved
in the last two minutes. The row above yours shows how long until you pass
them. That counts their /s only if they're playing, because a stored total
stands still until its player comes back. Rank changes are logged
(`scripts/autoplayer/leaderboard.mjs`, `test/autoplayer-leaderboard.test.js`). If stdout isn't a terminal
(piped, `nohup`), it falls back to `--plain` output.

**The log file** is `~/.glizzy-autoplayer/logs/autoplayer.log` (`--log-dir` to
move it). It holds every event, plus a status line every minute. It rolls over
at 10 MB or when the local date changes. Each rolled file is gzipped as
`autoplayer-<timestamp>.log.gz`, and the newest 30 are kept
(`scripts/autoplayer/logfile.mjs`, `test/autoplayer-logfile.test.js`).

The game only spawns golden glizzies while `document.hidden` is false.
Headless Chromium always counts as visible. A `--headed` window that's
minimised doesn't, so the Autoplayer warns when that happens.

**Don't play the same account elsewhere while it runs.** The `save_seq` guard
drops whichever tab's save is out of date. Two sessions keep resyncing each
other and both lose work.

## What it does

| | |
|---|---|
| Clicking | 25 clicks/s, which is `MAX_CLICKS_PER_SECOND`. Clicks are paced off the clock, so a late tick catches up. A backlog of more than a second (throttled tab) is dropped rather than burst. |
| Golden glizzies | Clicked within 200 ms of appearing. The reward is logged. |
| Buying | Buy quantity is forced to ×1. An affordable golden upgrade is bought first. Otherwise it buys the ranking's #1 the moment it's affordable, and buys nothing cheaper while saving for it. Each pass (every 250 ms) keeps buying until it has to save, up to 50, so a big bank gets spent in seconds. |

### The ranking

This is the Oracle's method (`docs/oracle.md`): clone the state, apply the
purchase, re-run `computeRatesFor`, then rank by cost ÷ Δ. It differs from the
Oracle in one way. The Oracle can't price click upgrades, because a click is
worth whatever your clicking makes it worth. An Autoplayer clicks at a known
25/s, so it measures Δ as **perSecond + 25 × perClick** and click upgrades get
a real price. Golden upgrades still can't be priced. Their value depends on
golden-glizzy income, which is a Monte Carlo (`docs/glizzy-pacing.md`), so
they're bought as soon as affordable instead.

The ranking lives in `scripts/autoplayer/rank.js`. It's pure and is tested
against `glizzy.js`'s `computeEffectiveRates` (`test/autoplayer-rank.test.js`).
In the page it runs against `game.js`'s own `computeRatesFor`, exposed by the
read-only `window.__glizzy` hook, so it always matches whatever is deployed.

## How it hangs together

| File | Role |
|---|---|
| `game.js` → `window.__glizzy` | Read-only getters for state, rates, bonuses and buy quantity, plus the last save and golden-claim outcomes, `computeRatesFor` and `buildingCost`. Grants nothing. The Autoplayer acts only by clicking the DOM. |
| `scripts/autoplayer/rank.js` | The purchase decision. |
| `scripts/autoplayer/page.js` | The in-page loop. It has a top-level `return`, because the launcher wraps it in a function, prepends `rank.js` with its `export`s stripped, and injects the result. |
| `scripts/autoplayer/tui.mjs` | The live terminal view: plain ANSI on the alternate screen, no dependencies. |
| `scripts/autoplayer/leaderboard.mjs` | Ranks the leaderboard with your live line and works out the pass ETA. |
| `scripts/autoplayer/logfile.mjs` | The rolling, gzipping log file. |
| `scripts/autoplayer.mjs` | The launcher. Drives Chromium through Playwright. |

The launcher polls the page every second. If the page has no Autoplayer (a
fresh load), it injects one. Otherwise it drains the page's events and a
snapshot of the numbers the TUI shows.

**Watchdog.** If there has been no successful save for 60 s, the launcher
navigates back to `/game`. Repeated failures back off exponentially, capped at
30 minutes. A 401, or the login gate, stops it with "Session expired". A
`/game` without the hook stops it too, since that means an old deploy.
Purchases made locally while the server was unreachable are lost on that
reload, because the server never accepted them.
