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
const MAX_BUYS_PER_PASS = 50;

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
let goldensClaimed = 0;
setInterval(() => {
  if (goldenEl && goldenEl.classList.contains("show")) goldenEl.click();
  const lg = g.lastGolden;
  if (lg && lg !== seenGolden) {
    seenGolden = lg;
    const d = lg.data;
    if (d && d.ok) goldensClaimed++;
    say(d && d.ok
      ? "golden: " + (d.mega ? "MEGA " : "") + d.name + (d.message ? " — " + d.message : "")
      : "golden: claim failed (" + (d ? d.reason : "HTTP " + lg.status) + ")");
  }
}, 200);

// ----- buying -----
const catalog = { buildings: g.buildings, upgrades: g.upgrades };
let target = null;
let pending = null; // { at } — a click we're waiting to see land
let purchases = 0;
setInterval(() => {
  // The ranking prices buildings ×1; a ×10 setting would make a card tap buy
  // ten of something priced as one.
  if (g.buyQty !== 1) {
    document.querySelector('#buy-qty .qty-btn[data-qty="1"]')?.click();
    return;
  }
  if (pending && Date.now() - pending.at < 2000) return;
  pending = null;

  // Keep buying until it's time to save up: a big bank (offline earnings, a
  // Lucky!) can cover hundreds of purchases, and one per pass would spend
  // minutes on them. Capped so a pass can't hog the page's thread.
  for (let n = 0; n < MAX_BUYS_PER_PASS; n++) {
    const state = g.state;
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
    if (!landed) { pending = { at: Date.now() }; return; }
    say("bought " + c.name + " for " + fmt(c.cost));
    purchases++;
    target = null;
  }
}, 250);

// ----- snapshot -----
// Raw numbers for the launcher's TUI, status line and log; formatting
// happens there.

// Same-group golden buffs eclipse (only the strongest running one applies);
// mirrors buffGroupKey in game.js.
function buffGroup(e) {
  if (e.kind === "building_mult") return "building:" + e.building;
  if (e.kind === "click_mult") return "click";
  return "prod";
}
function buffs(now) {
  const live = (g.state.golden_effects || []).filter((e) => e && Date.parse(e.expires_at) > now);
  const running = (e) => !e.starts_at || Date.parse(e.starts_at) <= now;
  const best = {};
  for (const e of live.filter(running)) {
    const k = buffGroup(e);
    if (!best[k] || e.mult > best[k].mult) best[k] = e;
  }
  return live.map((e) => ({
    kind: e.kind,
    mult: e.mult,
    building: e.building ? (g.buildings.find((b) => b.id === e.building) || {}).name || e.building : null,
    mode: !running(e) ? "queued" : best[buffGroup(e)] === e ? "on" : "eclipsed",
    startsAt: e.starts_at ? Date.parse(e.starts_at) : null,
    expiresAt: Date.parse(e.expires_at),
  }));
}
function snapshot() {
  const now = Date.now();
  const s = g.state, r = g.rates;
  return {
    at: now,
    bank: s.glizzies,
    lifetime: s.lifetime,
    perSecond: r.perSecond,
    perClick: r.perClick,
    cps: CPS,
    buffs: buffs(now),
    bonuses: (g.bonuses || window.GAME.bonuses || []).map((b) => ({ emoji: b.emoji, name: b.name, description: b.description })),
    target: target ? { name: target.name, cost: target.cost } : null,
    hidden: document.hidden,
    purchases,
    goldensClaimed,
    startedAt,
  };
}

let wasHidden = false;
window.__autoplayer = {
  drain() {
    if (document.hidden !== wasHidden) {
      wasHidden = document.hidden;
      say(wasHidden
        ? "WARNING: page hidden — golden glizzies paused and timers throttled. Keep the window visible."
        : "page visible again");
    }
    return { lines: lines.splice(0), lastSave: g.lastSave, snapshot: snapshot() };
  },
};
say("started");
