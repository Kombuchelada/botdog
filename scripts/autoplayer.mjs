// GlizzyClicker Autoplayer launcher. Opens /game in a real browser, injects
// scripts/autoplayer/page.js, and keeps it alive: re-injects after any reload,
// and reloads the page when saves stop landing. See docs/autoplayer.md.
//
//   node scripts/autoplayer.mjs login              # once; Discord login in a visible Chromium
//   node scripts/autoplayer.mjs run                # headless Chromium
//   node scripts/autoplayer.mjs run --headed       # watch it play
//
// Options: --url (default https://yearoftheglizzy.com), --profile (default
// ~/.glizzy-autoplayer/profile), --headed,
// --log-dir (default ~/.glizzy-autoplayer/logs), --plain (no TUI; one line
// per event on stdout, which is also what you get when stdout isn't a terminal).

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { openLog } from "./autoplayer/logfile.mjs";
import { createTui, statusLine, fmtDur } from "./autoplayer/tui.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = "glizzy_session"; // oauth.js
const STALE_MS = 60_000;                 // no successful save for this long → reload
const MAX_BACKOFF_MS = 30 * 60_000;
const POLL_MS = 1000;
const STATUS_EVERY_MS = 60_000;          // status line in the log file

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "https://yearoftheglizzy.com" },
    profile: { type: "string", default: join(homedir(), ".glizzy-autoplayer", "profile") },
    headed: { type: "boolean", default: false },
    "log-dir": { type: "string", default: join(homedir(), ".glizzy-autoplayer", "logs") },
    plain: { type: "boolean", default: false },
  },
});
const BASE = opts.url.replace(/\/+$/, "");
const GAME_URL = BASE + "/game";

// Every line goes to the log file; on screen it's either the TUI's event pane
// or plain stdout. Both are set up by `run`; `login` just prints.
let logFile = null;
let tui = null;
function log(s, { screen = true } = {}) {
  const now = new Date();
  logFile?.write(now.toISOString() + "  " + s);
  if (!screen) return;
  const line = now.toLocaleTimeString("en-GB") + "  " + s;
  if (tui) tui.event(line);
  else console.log(line);
}
function die(s) {
  tui?.close();
  tui = null;
  log(s);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// rank.js is an ES module so the tests can import it; in the page it's just
// source, so the exports come off and everything shares one function scope.
const PAYLOAD = "(function () {\n" +
  readFileSync(join(HERE, "autoplayer", "rank.js"), "utf8").replace(/^export /gm, "") + "\n" +
  readFileSync(join(HERE, "autoplayer", "page.js"), "utf8") + "\n})();";
const DRAIN = "window.__autoplayer ? (window.__autoplayer.drain ? window.__autoplayer.drain() : window.__autoplayer) : null";

async function loadPlaywright() {
  try {
    return (await import("playwright")).chromium;
  } catch {
    die("Playwright isn't installed: npm install --ignore-scripts && npx playwright install chromium");
  }
}

function openProfile(chromium, headless) {
  return chromium.launchPersistentContext(opts.profile, { headless, viewport: { width: 1280, height: 800 } });
}

async function sessionCookie(context) {
  return (await context.cookies(BASE)).find((c) => c.name === SESSION_COOKIE);
}

// ----- the browser: goto / evaluate(expression) / close -----

async function openGame() {
  const chromium = await loadPlaywright();
  const context = await openProfile(chromium, !opts.headed);
  if (!(await sessionCookie(context))) {
    await context.close();
    die("Not logged in. Run: node scripts/autoplayer.mjs login");
  }
  const page = context.pages()[0] || (await context.newPage());
  return {
    goto: (url) => page.goto(url),
    evaluate: (expr) => page.evaluate(expr),
    close: () => context.close(),
  };
}

// ----- commands -----

async function login() {
  const chromium = await loadPlaywright();
  const context = await openProfile(chromium, false);
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(BASE + "/oauth/login?next=/game");
  log("Log in with Discord in the browser window. Waiting up to 5 minutes…");
  for (let i = 0; i < 300; i++) {
    if (await sessionCookie(context)) {
      log("Logged in. Profile saved to " + opts.profile);
      await context.close();
      return;
    }
    await sleep(1000);
  }
  await context.close();
  die("Gave up waiting for the login.");
}

const sinceSave = (at) => "last save " + fmtDur((Date.now() - at) / 1000) + " ago";

async function run() {
  logFile = openLog(opts["log-dir"]);
  const title = (opts.headed ? "chromium" : "chromium (headless)") + " · " + BASE.replace(/^https?:\/\//, "");
  if (process.stdout.isTTY && !opts.plain) tui = createTui({ title });
  const driver = await openGame();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    tui?.close();
    tui = null;
    log("stopping");
    await driver.close().catch(() => {});
    await logFile.flush();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`Autoplayer · ${title} · log: ${logFile.path}`);
  await driver.goto(GAME_URL);

  let healthyAt = Date.now(); // last successful save, or the last (re)load
  let lastReload = 0;
  let failures = 0;
  let lastStatus = "no save yet";
  let lastStatusLine = 0;

  while (!closing) {
    await sleep(POLL_MS);
    let r = null;
    try {
      r = await driver.evaluate(DRAIN);
      if (!r) await driver.evaluate(PAYLOAD); // fresh page; drained next poll
    } catch {
      // mid-navigation; the next poll re-injects
    }

    if (r) {
      if (r.error === "logged-out") { await driver.close(); die("Session expired. Run: node scripts/autoplayer.mjs login"); }
      if (r.error === "no-hook") { await driver.close(); die("The deployed game has no window.__glizzy hook — the game.js change isn't deployed yet."); }
      for (const line of r.lines) log(line);
      const save = r.lastSave;
      if (save && save.status === 401) { await driver.close(); die("Session expired. Run: node scripts/autoplayer.mjs login"); }
      if (save && save.ok && save.at > healthyAt) {
        healthyAt = save.at;
        failures = 0;
      }
      lastStatus = save ? "HTTP " + save.status : "no save yet";
      if (r.snapshot) {
        tui?.update(r.snapshot);
        if (Date.now() - lastStatusLine >= STATUS_EVERY_MS) {
          lastStatusLine = Date.now();
          log(statusLine(r.snapshot), { screen: !tui });
        }
      }
    }
    tui?.setHealth(sinceSave(healthyAt));

    // Runs whether or not the page answered: a browser error page (server
    // down mid-deploy) never will, and that's exactly when this matters.
    const now = Date.now();
    const backoff = failures ? Math.min(STALE_MS * 2 ** failures, MAX_BACKOFF_MS) : 0;
    if (now - healthyAt > STALE_MS && now - lastReload > backoff) {
      failures++;
      lastReload = now;
      healthyAt = now;
      log(`no successful save for ${Math.round(STALE_MS / 1000)}s (last: ${lastStatus}) — reloading (attempt ${failures})`);
      // Navigate rather than reload: a reload of a browser error page reloads
      // the error page.
      try { await driver.goto(GAME_URL); } catch (e) { log("reload failed: " + e.message.split("\n")[0]); }
    }
  }
}

const cmd = positionals[0];
if (cmd === "login") await login();
else if (cmd === "run") await run();
else die("usage: node scripts/autoplayer.mjs login | run [--headed] [--plain] [--url URL]");
