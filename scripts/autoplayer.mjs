// GlizzyClicker Autoplayer launcher. Opens /game in a real browser, injects
// scripts/autoplayer/page.js, and keeps it alive: re-injects after any reload,
// and reloads the page when saves stop landing. See docs/autoplayer.md.
//
//   node scripts/autoplayer.mjs login              # once; Discord login in a visible Chromium
//   node scripts/autoplayer.mjs run                # Safari on macOS, headless Chromium elsewhere
//   node scripts/autoplayer.mjs run --browser chromium --headed
//
// Options: --url (default https://yearoftheglizzy.com), --profile (default
// ~/.glizzy-autoplayer/profile), --browser safari|chromium, --headed.

import { readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION_COOKIE = "glizzy_session"; // oauth.js
const STALE_MS = 60_000;                 // no successful save for this long → reload
const MAX_BACKOFF_MS = 30 * 60_000;
const POLL_MS = 1000;

const { values: opts, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "https://yearoftheglizzy.com" },
    profile: { type: "string", default: join(homedir(), ".glizzy-autoplayer", "profile") },
    browser: { type: "string", default: process.platform === "darwin" ? "safari" : "chromium" },
    headed: { type: "boolean", default: false },
  },
});
const BASE = opts.url.replace(/\/+$/, "");
const GAME_URL = BASE + "/game";

const log = (s) => console.log(new Date().toLocaleTimeString("en-GB") + "  " + s);
const die = (s) => { log(s); process.exit(1); };
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

// ----- drivers: goto / evaluate(expression) / close -----

async function chromiumDriver() {
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

// Safari has no Playwright; it's driven over plain WebDriver HTTP against
// safaridriver. Automation sessions start with an empty cookie jar, so the
// session cookie is copied over from the Chromium login profile.
async function safariDriver() {
  const chromium = await loadPlaywright();
  const context = await openProfile(chromium, true);
  const cookie = await sessionCookie(context);
  await context.close();
  if (!cookie) die("Not logged in. Run: node scripts/autoplayer.mjs login");

  const port = 4444 + Math.floor(Math.random() * 1000);
  const proc = spawn("safaridriver", ["-p", String(port)], { stdio: "ignore" });
  proc.on("error", (e) => die("Couldn't start safaridriver: " + e.message));
  const root = "http://127.0.0.1:" + port;
  async function wd(method, path, body) {
    const res = await fetch(root + path, {
      method,
      headers: { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error((json.value && json.value.message) || "WebDriver HTTP " + res.status);
    return json.value;
  }
  for (let i = 0; ; i++) {
    try { await wd("GET", "/status"); break; } catch { if (i > 50) die("safaridriver never came up"); await sleep(100); }
  }
  let session;
  try {
    session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "safari" } } })).sessionId;
  } catch (e) {
    proc.kill();
    die("Safari refused the automation session (" + e.message + "). Enable it once: " +
      "Safari ▸ Settings ▸ Advanced ▸ Show features for web developers, then Develop ▸ Allow Remote Automation, " +
      "and run `sudo safaridriver --enable`.");
  }
  const s = "/session/" + session;
  // A cookie can only be set for the page's current origin.
  await wd("POST", s + "/url", { url: BASE + "/" });
  await wd("POST", s + "/cookie", {
    cookie: {
      name: cookie.name,
      value: cookie.value,
      path: "/",
      secure: cookie.secure,
      httpOnly: cookie.httpOnly,
      ...(cookie.expires > 0 ? { expiry: Math.floor(cookie.expires) } : {}),
    },
  });
  return {
    goto: (url) => wd("POST", s + "/url", { url }),
    evaluate: (expr) => wd("POST", s + "/execute/sync", { script: "return (" + expr + ");", args: [] }),
    close: async () => { await wd("DELETE", s).catch(() => {}); proc.kill(); },
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

async function run() {
  const driver = opts.browser === "safari" ? await safariDriver() : await chromiumDriver();
  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log("stopping");
    await driver.close().catch(() => {});
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  log(`Autoplayer · ${opts.browser}${opts.browser === "chromium" && !opts.headed ? " (headless)" : ""} · ${GAME_URL}`);
  await driver.goto(GAME_URL);

  let healthyAt = Date.now(); // last successful save, or the last (re)load
  let lastReload = 0;
  let failures = 0;
  let lastStatus = "no save yet";

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
    }

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
else die("usage: node scripts/autoplayer.mjs login | run [--browser safari|chromium] [--headed] [--url URL]");
