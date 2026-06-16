import express from "express";
import { db, getUserProfileStmt } from "./database.js";
import {
  BUILDINGS,
  UPGRADES,
  buildingCost,
  computeEffectiveRates,
  getPlayerSummary,
} from "./glizzy.js";

// ============================================================================
// GlizzyClicker purchase calculator — unlisted at /calculator
//
// Does the same job as cookiecalculator.com: for a given player, figure out the
// most *efficient* next purchases. Efficiency here = "payback time": how many
// seconds of the post-purchase production rate it takes to earn back what the
// purchase cost. Lower is better.
//
//   payback = cost / (newPerSecond - oldPerSecond)
//
// We greedily pick the lowest-payback purchase, apply it to a simulated state,
// and repeat N times — so building costs ramp and upgrades unlock as you'd
// actually buy them. Click-only upgrades never raise per-second production, so
// they get an infinite payback and naturally sink to the bottom (a CPS metric
// can't value them — same as cookiecalculator).
// ============================================================================

const DEFAULT_COUNT = 10;
const MAX_COUNT = 25;

const listGamePlayersStmt = db.prepare(
  "SELECT user_id, lifetime_glizzies FROM glizzy_game ORDER BY lifetime_glizzies DESC",
);
const getUserNameFromEventsStmt = db.prepare(
  "SELECT username FROM hotdog_events WHERE user_id = ? AND username NOT LIKE '<@%' ORDER BY timestamp DESC LIMIT 1",
);

function displayName(userId) {
  const profile = getUserProfileStmt.get(userId);
  if (profile && (profile.global_name || profile.username)) {
    return profile.global_name || profile.username;
  }
  const row = getUserNameFromEventsStmt.get(userId);
  if (row && row.username) return row.username;
  return `User ${String(userId).slice(-4)}`;
}

function listPlayers() {
  return listGamePlayersStmt.all().map((r) => ({
    user_id: r.user_id,
    name: displayName(r.user_id),
    lifetime: Number(r.lifetime_glizzies) || 0,
  }));
}

// ----------------------------------------------------------------------------
// Number / duration formatting (mirrors game.js fmtRate scale words)
// ----------------------------------------------------------------------------

const SCALES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
function fmtNum(n) {
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return Math.round(n).toLocaleString();
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= SCALES.length) return n.toExponential(2);
  return (n / Math.pow(1000, tier)).toFixed(2) + SCALES[tier];
}

function fmtRate(n) {
  if (!Number.isFinite(n) || n <= 0) return "0/s";
  if (n < 1000) return n.toFixed(1) + "/s";
  return fmtNum(n) + "/s";
}

function fmtDuration(sec) {
  if (!Number.isFinite(sec)) return "never";
  if (sec < 0) sec = 0;
  if (sec < 1) return "<1s";
  if (sec < 60) return Math.round(sec) + "s";
  const units = [
    ["y", 365 * 86400],
    ["d", 86400],
    ["h", 3600],
    ["m", 60],
    ["s", 1],
  ];
  const parts = [];
  let rem = Math.floor(sec);
  for (const [label, size] of units) {
    if (rem >= size) {
      const v = Math.floor(rem / size);
      rem -= v * size;
      parts.push(v + label);
      if (parts.length === 2) break;
    }
  }
  return parts.join(" ") || "0s";
}

// ----------------------------------------------------------------------------
// Core planner
// ----------------------------------------------------------------------------

function cloneSimState(state) {
  // Plan on steady-state production: drop transient golden-glizzy buffs so the
  // payback numbers reflect normal play, not a momentary ×N frenzy.
  const buildings = {};
  for (const b of BUILDINGS) buildings[b.id] = state.buildings?.[b.id] || 0;
  return {
    buildings,
    upgrades_owned: [...(state.upgrades_owned || [])],
    golden_effects: [],
  };
}

/**
 * Plan the next `count` most-efficient purchases for a user.
 * Returns null if the user has no game state, else { name, lifetime, bank,
 * startRate, endRate, steps: [...] }.
 */
export function planPurchases(userId, count = DEFAULT_COUNT) {
  const summary = getPlayerSummary(userId);
  if (!summary.exists) return null;

  const { state, bonuses } = summary;
  const sim = cloneSimState(state);
  const ownedUpgrades = new Set(sim.upgrades_owned);

  let currentRate = computeEffectiveRates(sim, bonuses).perSecond;
  const startRate = currentRate;

  // Affordability projection: spend the real bank, then accumulate at the
  // (rising) production rate to time when each purchase becomes affordable.
  let bank = state.glizzies || 0;
  let elapsed = 0;
  let cumulativeCost = 0;

  const steps = [];

  for (let i = 0; i < count; i++) {
    let best = null;

    // Candidate: one more of each building.
    for (const b of BUILDINGS) {
      const owned = sim.buildings[b.id] || 0;
      const cost = buildingCost(b.id, owned);
      sim.buildings[b.id] = owned + 1;
      const newRate = computeEffectiveRates(sim, bonuses).perSecond;
      sim.buildings[b.id] = owned;
      const delta = newRate - currentRate;
      const payback = delta > 0 ? cost / delta : Infinity;
      const cand = {
        kind: "building",
        id: b.id,
        emoji: b.emoji,
        label: `${b.name} #${owned + 1}`,
        cost,
        delta,
        newRate,
        payback,
      };
      if (!best || cand.payback < best.payback) best = cand;
    }

    // Candidate: each unowned upgrade.
    for (const up of UPGRADES) {
      if (ownedUpgrades.has(up.id)) continue;
      sim.upgrades_owned.push(up.id);
      const newRate = computeEffectiveRates(sim, bonuses).perSecond;
      sim.upgrades_owned.pop();
      const delta = newRate - currentRate;
      const payback = delta > 0 ? up.cost / delta : Infinity;
      const cand = {
        kind: "upgrade",
        id: up.id,
        emoji: up.emoji,
        label: up.name,
        cost: up.cost,
        delta,
        newRate,
        payback,
      };
      // Prefer real payback; only fall back to a click/no-CPS upgrade if nothing
      // else exists (it never will, since buildings always produce).
      if (!best || cand.payback < best.payback) best = cand;
    }

    if (!best) break;

    // Apply the winning purchase to the simulated state.
    if (best.kind === "building") {
      sim.buildings[best.id] = (sim.buildings[best.id] || 0) + 1;
    } else {
      sim.upgrades_owned.push(best.id);
      ownedUpgrades.add(best.id);
    }

    // Project when it can be bought given current production.
    const waitSec = currentRate > 0 ? Math.max(0, (best.cost - bank) / currentRate) : Infinity;
    if (Number.isFinite(waitSec)) {
      bank += currentRate * waitSec; // grow to afford
      bank -= best.cost;
      elapsed += waitSec;
    }
    cumulativeCost += best.cost;
    currentRate = best.newRate;

    steps.push({
      order: i + 1,
      kind: best.kind,
      emoji: best.emoji,
      label: best.label,
      cost: best.cost,
      delta: best.delta,
      payback: best.payback,
      newRate: best.newRate,
      cumulativeCost,
      readyIn: elapsed,
    });
  }

  return {
    user_id: userId,
    name: displayName(userId),
    lifetime: summary.state.lifetime || 0,
    bank: state.glizzies || 0,
    startRate,
    endRate: currentRate,
    steps,
  };
}

// ----------------------------------------------------------------------------
// Rendering (self-contained page, brand-matched, intentionally not in the nav)
// ----------------------------------------------------------------------------

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function avatar(userId, size = 28) {
  const profile = getUserProfileStmt.get(userId);
  const dim = `width:${size}px;height:${size}px;`;
  if (profile && profile.avatar_url) {
    return `<img src="${esc(profile.avatar_url)}" alt="" loading="lazy" style="${dim}border-radius:50%;object-fit:cover;flex-shrink:0;background:#1e293b;">`;
  }
  const name = displayName(userId);
  const initial = (name[0] || "?").toUpperCase();
  return `<span style="${dim}border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:${Math.round(size * 0.45)}px;flex-shrink:0;">${esc(initial)}</span>`;
}

function layout(title, body) {
  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(title)} · Hot Dog Hub</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { theme: { extend: { colors: {
    accent: { DEFAULT: '#ff6b35', soft: '#ffa07a', deep: '#e25822' },
  }, fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'] } } } };
</script>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  body { background:#020617; color:#e2e8f0; font-feature-settings: "cv11", "ss03"; }
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; }
  .stat-label { color:#94a3b8; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; font-weight:600; }
  .accent { color:#ff6b35; }
  table.calc td, table.calc th { padding:0.6rem 0.75rem; }
  table.calc tbody tr { border-top:1px solid rgba(148,163,184,0.08); }
  .tnum { font-variant-numeric: tabular-nums; }
</style>
</head>
<body class="font-sans antialiased">
  <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-5xl mx-auto px-6 py-3 flex items-center justify-between">
      <a href="/" class="flex items-center gap-2 font-semibold">
        <span class="text-2xl">🌭</span>
        <span class="text-slate-100 tracking-tight">Hot Dog Hub</span>
      </a>
      <a href="/game" class="text-sm text-slate-300 hover:text-white">← Back to game</a>
    </div>
  </header>
  <main class="max-w-5xl mx-auto px-6 py-8">${body}</main>
  <footer class="mt-16 border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
    🌭 GlizzyClicker purchase calculator · ranks by payback time (cost ÷ added production)
  </footer>
</body>
</html>`;
}

function renderPicker(players, selectedId, count) {
  const options = players
    .map(
      (p) =>
        `<option value="${esc(p.user_id)}"${p.user_id === selectedId ? " selected" : ""}>${esc(p.name)} · ${fmtNum(p.lifetime)} lifetime</option>`,
    )
    .join("");
  return `
    <form method="get" action="/calculator" class="card p-5 flex flex-col sm:flex-row gap-3 sm:items-end mb-8">
      <div class="flex-1">
        <label class="stat-label block mb-1.5" for="user">Player</label>
        <select id="user" name="user" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent">
          <option value="">Select a player…</option>
          ${options}
        </select>
      </div>
      <div class="w-full sm:w-28">
        <label class="stat-label block mb-1.5" for="n">Purchases</label>
        <input id="n" name="n" type="number" min="1" max="${MAX_COUNT}" value="${esc(count)}" class="w-full bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-slate-100 focus:outline-none focus:ring-2 focus:ring-accent">
      </div>
      <button class="px-5 py-2 bg-accent hover:bg-accent-deep text-white rounded-lg font-semibold transition">Calculate →</button>
    </form>`;
}

function renderResult(plan) {
  const rows = plan.steps
    .map((s) => {
      const paybackText = Number.isFinite(s.payback)
        ? fmtDuration(s.payback)
        : `<span class="text-slate-500">no CPS gain</span>`;
      const kindChip = s.kind === "upgrade"
        ? `<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-500/15 text-violet-300">upgrade</span>`
        : `<span class="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-accent/15 text-accent-soft">building</span>`;
      return `
        <tr>
          <td class="text-slate-500 tnum text-right">${s.order}</td>
          <td>
            <div class="flex items-center gap-2">
              <span class="text-lg">${esc(s.emoji || "🌭")}</span>
              <div>
                <div class="text-slate-100 font-medium">${esc(s.label)}</div>
                <div class="mt-0.5">${kindChip}</div>
              </div>
            </div>
          </td>
          <td class="text-right tnum text-slate-200">${fmtNum(s.cost)}</td>
          <td class="text-right tnum text-emerald-300">+${fmtRate(s.delta)}</td>
          <td class="text-right tnum accent font-semibold">${paybackText}</td>
          <td class="text-right tnum text-slate-400">${fmtNum(s.cumulativeCost)}</td>
          <td class="text-right tnum text-slate-400">${fmtDuration(s.readyIn)}</td>
        </tr>`;
    })
    .join("");

  return `
    <section class="mb-6 flex items-center gap-4">
      ${avatar(plan.user_id, 48)}
      <div>
        <h1 class="text-3xl font-bold text-white tracking-tight">${esc(plan.name)}</h1>
        <div class="text-slate-400 text-sm mt-0.5">Most efficient next ${plan.steps.length} purchases</div>
      </div>
    </section>

    <section class="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
      <div class="card p-4"><div class="stat-label">Bank now</div><div class="text-xl font-bold mt-1 tnum">${fmtNum(plan.bank)}</div></div>
      <div class="card p-4"><div class="stat-label">Production now</div><div class="text-xl font-bold mt-1 tnum">${fmtRate(plan.startRate)}</div></div>
      <div class="card p-4"><div class="stat-label">After ${plan.steps.length} buys</div><div class="text-xl font-bold mt-1 tnum accent">${fmtRate(plan.endRate)}</div></div>
      <div class="card p-4"><div class="stat-label">Total spend</div><div class="text-xl font-bold mt-1 tnum">${fmtNum(plan.steps.reduce((s, x) => Math.max(s, x.cumulativeCost), 0))}</div></div>
    </section>

    <section class="card p-2 sm:p-4 overflow-x-auto">
      <table class="calc w-full text-sm">
        <thead>
          <tr class="stat-label text-left">
            <th class="text-right">#</th>
            <th>Buy</th>
            <th class="text-right">Cost</th>
            <th class="text-right">Δ Production</th>
            <th class="text-right" title="Seconds of new production to earn the cost back">Payback</th>
            <th class="text-right">Cumulative</th>
            <th class="text-right" title="Projected wait at current production, spending your bank in order">Ready in</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </section>

    <p class="text-xs text-slate-500 mt-4 leading-relaxed">
      <span class="text-slate-300 font-semibold">Payback</span> = purchase cost ÷ the production it adds — the lower the number,
      the faster it pays for itself. Each row assumes you've already bought the rows above it (building prices ramp, upgrades unlock).
      Transient golden-glizzy buffs are excluded so the plan reflects steady production.
      <span class="text-slate-300 font-semibold">Ready in</span> spends your current bank top-to-bottom and waits at your live production rate.
    </p>`;
}

export function registerCalculator(app) {
  app.get("/calculator", (req, res) => {
    const players = listPlayers();
    const selectedId = req.query.user ? String(req.query.user).trim() : "";
    let count = parseInt(req.query.n, 10);
    if (!Number.isFinite(count) || count < 1) count = DEFAULT_COUNT;
    if (count > MAX_COUNT) count = MAX_COUNT;

    let body = `
      <section class="mb-6">
        <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">GlizzyClicker</div>
        <h1 class="text-4xl font-bold text-white tracking-tight">Purchase calculator</h1>
        <p class="text-slate-400 mt-2 max-w-2xl">Pick a player to see their most efficient next buys, ranked by payback time — how long each purchase takes to earn back its own cost.</p>
      </section>
      ${renderPicker(players, selectedId, count)}`;

    if (selectedId) {
      const plan = planPurchases(selectedId, count);
      if (!plan) {
        body += `<div class="card p-8 text-center text-slate-400">No GlizzyClicker save found for that player yet.</div>`;
      } else if (plan.steps.length === 0) {
        body += `<div class="card p-8 text-center text-slate-400">Couldn't find any production-improving purchases.</div>`;
      } else {
        body += renderResult(plan);
      }
    }

    res.send(layout("Purchase calculator", body));
  });

  // JSON, for tinkering / external use.
  app.get("/api/calculator/:userId", (req, res) => {
    let count = parseInt(req.query.n, 10);
    if (!Number.isFinite(count) || count < 1) count = DEFAULT_COUNT;
    if (count > MAX_COUNT) count = MAX_COUNT;
    const plan = planPurchases(req.params.userId, count);
    if (!plan) return res.status(404).json({ error: "no game state for user" });
    res.json(plan);
  });
}
