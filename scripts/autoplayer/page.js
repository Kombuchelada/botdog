// The in-page half of the Autoplayer. The launcher injects this (with rank.js
// prepended) into /game and polls window.__autoplayer.drain() once a second.
// It plays only through the DOM, exactly as a player would: clicking the
// glizzy, the golden glizzy, and the cards. game.js's window.__glizzy hook is
// read, never written.
//
// Not a module: no imports, no exports, and it `return`s at top level — the
// launcher wraps it in a function. `decide` comes from rank.js.

const CPS = 25;             // MAX_CLICKS_PER_SECOND in glizzy.js
const TICK_MS = 40;         // one click per tick at 25/s
const STATUS_EVERY_MS = 60_000;

if (window.__autoplayer) return;
// Mid-load, window.GAME can exist before game.js's script has defined the
// hook; wait for the load and the launcher will inject again.
if (document.readyState !== "complete") return;
const g = window.__glizzy;
if (!g) {
  // A logged-in page without the hook is a deploy that predates it. The login
  // gate is recognised by its button, not by window.GAME being missing: the
  // browser's own error page (server down mid-deploy) has no GAME either, and
  // that one should be reloaded, not treated as an expired session.
  if (window.GAME) window.__autoplayer = { error: "no-hook" };
  else if (document.querySelector('a[href^="/oauth/login"]')) window.__autoplayer = { error: "logged-out" };
  return;
}

const startedAt = Date.now();
const lines = [];
const say = (s) => lines.push(s);

const SCALES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
function fmt(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < 1000) return String(Math.floor(n));
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SCALES.length) return n.toExponential(2);
  return (n / Math.pow(1000, tier)).toFixed(2) + SCALES[tier];
}
function fmtDur(s) {
  if (!Number.isFinite(s)) return "never";
  if (s < 60) return Math.ceil(s) + "s";
  if (s < 3600) return Math.floor(s / 60) + "m" + Math.round(s % 60) + "s";
  if (s < 86400) return Math.floor(s / 3600) + "h" + Math.round((s % 3600) / 60) + "m";
  return Math.floor(s / 86400) + "d" + Math.round((s % 86400) / 3600) + "h";
}

// ----- clicking -----
// Paced off the clock rather than the timer count, so a late tick catches up
// instead of losing its clicks. A backlog over a second (a throttled or
// suspended tab) is dropped: dumping it in one burst could overrun the
// server's per-save allowance, and clicks over it are discarded anyway.
const area = document.getElementById("click-area");
let clickStart = performance.now();
let clicked = 0;
setInterval(() => {
  let owed = Math.floor(((performance.now() - clickStart) / 1000) * CPS) - clicked;
  if (owed > CPS) {
    clickStart = performance.now();
    clicked = 0;
    owed = 1;
  }
  if (owed <= 0) return;
  const r = area.getBoundingClientRect();
  const init = { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
  for (let i = 0; i < owed; i++) area.dispatchEvent(new MouseEvent("click", init));
  clicked += owed;
}, TICK_MS);

// ----- golden glizzies -----
const goldenEl = document.getElementById("golden-glizzy");
let seenGolden = g.lastGolden;
setInterval(() => {
  if (goldenEl && goldenEl.classList.contains("show")) goldenEl.click();
  const lg = g.lastGolden;
  if (lg && lg !== seenGolden) {
    seenGolden = lg;
    const d = lg.data;
    say(d && d.ok
      ? "golden: " + (d.mega ? "MEGA " : "") + d.name + (d.message ? " — " + d.message : "")
      : "golden: claim failed (" + (d ? d.reason : "HTTP " + lg.status) + ")");
  }
}, 200);

// ----- buying -----
const catalog = { buildings: g.buildings, upgrades: g.upgrades };
let target = null;
let pending = null; // { key, at } — a click we're waiting to see land
setInterval(() => {
  // The ranking prices buildings ×1; a ×10 setting would make a card tap buy
  // ten of something priced as one.
  if (g.buyQty !== 1) {
    document.querySelector('#buy-qty .qty-btn[data-qty="1"]')?.click();
    return;
  }
  const state = g.state;
  if (pending && Date.now() - pending.at < 2000) return;
  pending = null;

  const d = decide({
    state,
    catalog,
    ratesFor: g.computeRatesFor,
    nextCost: (id) => g.buildingCost(id, 1),
    cps: CPS,
  });
  if (!d) { target = null; return; }
  if (d.wait) { target = d.wait; return; }

  const c = d.buy;
  const el = document.querySelector(c.kind === "building" ? '[data-buy="' + c.id + '"]' : '[data-upgrade="' + c.id + '"]');
  if (!el) return; // upgrade list not rendered yet; next pass
  const before = c.kind === "building" ? state.buildings[c.id] || 0 : null;
  el.click();
  const now = g.state;
  const landed = c.kind === "building" ? (now.buildings[c.id] || 0) > before : now.upgrades_owned.includes(c.id);
  if (landed) {
    say("bought " + c.name + " for " + fmt(c.cost));
    target = null;
  } else {
    pending = { at: Date.now() };
  }
}, 250);

// ----- status -----
let lastStatus = Date.now();
let wasHidden = false;
function status() {
  const s = g.state, r = g.rates;
  const next = target
    ? target.name + " in " + fmtDur(Math.max(0, target.cost - s.glizzies) / Math.max(r.perSecond + CPS * r.perClick, 1e-9))
    : "—";
  return fmt(r.perSecond) + "/s · " + fmt(r.perClick) + "/click · bank " + fmt(s.glizzies) + " · next: " + next;
}

window.__autoplayer = {
  drain() {
    const now = Date.now();
    if (document.hidden !== wasHidden) {
      wasHidden = document.hidden;
      say(wasHidden
        ? "WARNING: page hidden — golden glizzies paused and timers throttled. Keep the window visible."
        : "page visible again");
    }
    if (now - lastStatus >= STATUS_EVERY_MS) {
      lastStatus = now;
      say(status());
    }
    return { lines: lines.splice(0), lastSave: g.lastSave, startedAt };
  },
};
say("started · " + status());
