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

**Safari (macOS)**, once: Safari ▸ Settings ▸ Advanced ▸ *Show features for web
developers*, then Develop ▸ *Allow Remote Automation*, then
`sudo safaridriver --enable`.

## Running

```bash
node scripts/autoplayer.mjs run                       # Safari on macOS, headless Chromium elsewhere
node scripts/autoplayer.mjs run --browser chromium --headed
node scripts/autoplayer.mjs run --url http://localhost:3000
```

It runs until Ctrl-C. Output is one line per purchase, golden glizzy and
reload, plus a status line every minute.

**Safari must stay visible.** The game only spawns golden glizzies while
`document.hidden` is false, and Safari throttles timers in hidden windows. If
the window is minimised, on another Space or fully covered, the Autoplayer logs
a warning and carries on. It does not pull the window to the front.
Safari also locks an automation window against your input. Headless Chromium
always counts as visible.

**Don't play the same account elsewhere while it runs.** The `save_seq` guard
drops whichever tab's save is out of date. Two sessions keep resyncing each
other and both lose work.

## What it does

| | |
|---|---|
| Clicking | 25 clicks/s, which is `MAX_CLICKS_PER_SECOND`. Clicks are paced off the clock, so a late tick catches up. A backlog of more than a second (throttled tab) is dropped rather than burst. |
| Golden glizzies | Clicked within 200 ms of appearing. The reward is logged. |
| Buying | Buy quantity is forced to ×1. An affordable golden upgrade is bought first. Otherwise it buys the ranking's #1 the moment it's affordable, and buys nothing cheaper while saving for it. |

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
| `game.js` → `window.__glizzy` | Read-only getters for state, rates and buy quantity, plus the last save and golden-claim outcomes, `computeRatesFor` and `buildingCost`. Grants nothing. The Autoplayer acts only by clicking the DOM. |
| `scripts/autoplayer/rank.js` | The purchase decision. |
| `scripts/autoplayer/page.js` | The in-page loop. It has a top-level `return`, because the launcher wraps it in a function, prepends `rank.js` with its `export`s stripped, and injects the result. |
| `scripts/autoplayer.mjs` | The launcher. Chromium is driven through Playwright. Safari is driven through plain WebDriver HTTP against `safaridriver`. Automation sessions start with no cookies, so the session cookie is copied over from the Chromium profile. |

The launcher polls the page every second. If the page has no Autoplayer (a
fresh load), it injects one. Otherwise it drains the page's log.

**Watchdog.** If there has been no successful save for 60 s, the launcher
navigates back to `/game`. Repeated failures back off exponentially, capped at
30 minutes. A 401, or the login gate, stops it with "Session expired". A
`/game` without the hook stops it too, since that means an old deploy.
Purchases made locally while the server was unreachable are lost on that
reload, because the server never accepted them.
