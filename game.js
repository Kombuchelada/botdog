import express from "express";
import { getSessionUserId, requireGameSession } from "./oauth.js";
import {
  loadGameForUser,
  validateAndClampSave,
  getLeaderboardRows,
  getPlayerSummary,
  BUILDINGS,
  UPGRADES,
} from "./glizzy.js";
import { getUserProfileStmt } from "./database.js";

const NAV = `
  <header class="border-b border-slate-800/80 bg-slate-950/80 backdrop-blur sticky top-0 z-50">
    <div class="max-w-7xl mx-auto px-6 py-3 flex items-center justify-between">
      <a href="/" class="flex items-center gap-2 font-semibold">
        <span class="text-2xl">🌭</span>
        <span class="text-slate-100 tracking-tight">Hot Dog Hub</span>
      </a>
      <nav class="flex items-center gap-1 text-sm">
        <a href="/" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Server</a>
        <a href="/users" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Users</a>
        <a href="/archive" class="px-3 py-1.5 rounded-md text-slate-300 hover:text-white hover:bg-slate-800 transition">Archive</a>
        <a href="/game" class="px-3 py-1.5 rounded-md text-white bg-accent/30 transition">Game</a>
      </nav>
    </div>
  </header>`;

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { theme: { extend: { colors: {
    accent: { DEFAULT: '#ff6b35', soft: '#ffa07a', deep: '#e25822' },
  }, fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] } } } };
</script>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">`;

// =====================
// Hand-drawn SVG art
// =====================

const HERO_SVG = `
<svg viewBox="0 0 320 220" class="hero-svg" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <radialGradient id="bunTop" cx="0.5" cy="0.4" r="0.6">
      <stop offset="0%" stop-color="#f0c374"/><stop offset="100%" stop-color="#c98a3e"/>
    </radialGradient>
    <radialGradient id="bunBot" cx="0.5" cy="0.5" r="0.6">
      <stop offset="0%" stop-color="#e3b16a"/><stop offset="100%" stop-color="#a06f30"/>
    </radialGradient>
    <linearGradient id="sausage" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#d35a3a"/><stop offset="100%" stop-color="#a83a22"/>
    </linearGradient>
    <filter id="heroshadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6"/>
      <feOffset dx="0" dy="6"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.4"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>
  <g filter="url(#heroshadow)">
    <ellipse cx="160" cy="160" rx="135" ry="40" fill="url(#bunBot)"/>
    <rect x="35" y="80" width="250" height="58" rx="29" ry="29" fill="url(#sausage)"/>
    <ellipse cx="160" cy="80" rx="135" ry="40" fill="url(#bunTop)"/>
  </g>
  <!-- Sesame seeds on bun -->
  <g fill="#fff4cc" opacity="0.85">
    <ellipse cx="85" cy="65" rx="3" ry="1.6" transform="rotate(-15 85 65)"/>
    <ellipse cx="125" cy="55" rx="3" ry="1.6" transform="rotate(10 125 55)"/>
    <ellipse cx="170" cy="58" rx="3" ry="1.6" transform="rotate(-5 170 58)"/>
    <ellipse cx="215" cy="62" rx="3" ry="1.6" transform="rotate(15 215 62)"/>
    <ellipse cx="245" cy="72" rx="3" ry="1.6" transform="rotate(-10 245 72)"/>
  </g>
  <!-- Mustard squiggle -->
  <path d="M 50 108 Q 80 90 115 108 T 185 108 T 270 108" stroke="#f7c02e" stroke-width="9" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 50 108 Q 80 90 115 108 T 185 108 T 270 108" stroke="#fce078" stroke-width="3" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>
  <!-- Face -->
  <g>
    <circle cx="110" cy="108" r="7" fill="#fff"/>
    <circle cx="112" cy="110" r="3.5" fill="#1a1a1a"/>
    <circle cx="210" cy="108" r="7" fill="#fff"/>
    <circle cx="212" cy="110" r="3.5" fill="#1a1a1a"/>
    <path d="M 145 128 Q 160 138 175 128" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/>
    <!-- Cheek blush -->
    <circle cx="90" cy="118" r="6" fill="#e25822" opacity="0.25"/>
    <circle cx="230" cy="118" r="6" fill="#e25822" opacity="0.25"/>
  </g>
</svg>`;

const BUILDING_SVGS = {
  mustard_stand: `
<svg viewBox="0 0 80 80">
  <rect x="14" y="56" width="52" height="14" fill="#7a5230"/>
  <rect x="14" y="56" width="52" height="3" fill="#5d3a1c"/>
  <rect x="16" y="30" width="48" height="20" fill="#f7c02e" rx="2"/>
  <text x="40" y="44" text-anchor="middle" fill="#3a2a08" font-size="10" font-weight="800" font-family="Inter">MUSTARD</text>
  <rect x="18" y="48" width="3" height="12" fill="#5d3a1c"/>
  <rect x="59" y="48" width="3" height="12" fill="#5d3a1c"/>
  <!-- Bottle on counter -->
  <rect x="36" y="62" width="8" height="6" fill="#f7c02e" rx="1"/>
</svg>`,
  bun_factory: `
<svg viewBox="0 0 80 80">
  <rect x="12" y="34" width="56" height="36" fill="#8d5a2b"/>
  <rect x="12" y="34" width="56" height="6" fill="#a16a35"/>
  <rect x="50" y="12" width="10" height="24" fill="#6b4220"/>
  <ellipse cx="55" cy="14" rx="11" ry="3" fill="#c98a3e" opacity="0.6"/>
  <ellipse cx="58" cy="9" rx="9" ry="3" fill="#c98a3e" opacity="0.4"/>
  <!-- Windows -->
  <rect x="20" y="46" width="10" height="10" fill="#f7c02e" opacity="0.85"/>
  <rect x="34" y="46" width="10" height="10" fill="#f7c02e" opacity="0.85"/>
  <rect x="48" y="46" width="10" height="10" fill="#f7c02e" opacity="0.85"/>
  <!-- Door -->
  <rect x="36" y="60" width="8" height="10" fill="#3a2a14"/>
</svg>`,
  glizzy_cart: `
<svg viewBox="0 0 80 80">
  <!-- Umbrella -->
  <path d="M 14 30 Q 40 8 66 30 Z" fill="#ff6b35"/>
  <path d="M 14 30 Q 40 8 66 30" stroke="#c44536" stroke-width="2" fill="none"/>
  <line x1="40" y1="10" x2="40" y2="40" stroke="#5d3a1c" stroke-width="2"/>
  <!-- Cart body -->
  <rect x="18" y="40" width="44" height="22" fill="#e25822" rx="3"/>
  <rect x="22" y="44" width="36" height="6" fill="#fff" opacity="0.85"/>
  <text x="40" y="49" text-anchor="middle" fill="#c44536" font-size="6" font-weight="800" font-family="Inter">HOT DOGS</text>
  <rect x="22" y="52" width="36" height="8" fill="#a83a22"/>
  <!-- Wheels -->
  <circle cx="26" cy="66" r="6" fill="#1a1a1a"/>
  <circle cx="26" cy="66" r="2.5" fill="#555"/>
  <circle cx="54" cy="66" r="6" fill="#1a1a1a"/>
  <circle cx="54" cy="66" r="2.5" fill="#555"/>
</svg>`,
  food_truck: `
<svg viewBox="0 0 80 80">
  <!-- Truck body -->
  <rect x="6" y="32" width="56" height="28" fill="#ff6b35" rx="3"/>
  <rect x="62" y="38" width="14" height="22" fill="#c44536" rx="2"/>
  <!-- Serving window -->
  <rect x="12" y="38" width="30" height="14" fill="#1a1a2e"/>
  <rect x="12" y="38" width="30" height="2" fill="#f7c02e"/>
  <!-- "GLIZZIES" awning -->
  <path d="M 6 32 L 42 32 L 38 24 L 10 24 Z" fill="#f7c02e"/>
  <text x="24" y="30" text-anchor="middle" fill="#3a2a08" font-size="6" font-weight="800" font-family="Inter">GLIZZIES</text>
  <!-- Headlight -->
  <circle cx="72" cy="44" r="2.5" fill="#fff4cc"/>
  <!-- Wheels -->
  <circle cx="20" cy="64" r="7" fill="#1a1a1a"/>
  <circle cx="20" cy="64" r="3" fill="#555"/>
  <circle cx="62" cy="64" r="7" fill="#1a1a1a"/>
  <circle cx="62" cy="64" r="3" fill="#555"/>
</svg>`,
  stadium: `
<svg viewBox="0 0 80 80">
  <!-- Stadium bowl -->
  <ellipse cx="40" cy="58" rx="34" ry="14" fill="#3b3b50"/>
  <ellipse cx="40" cy="52" rx="34" ry="14" fill="#5a5a78"/>
  <!-- Arches -->
  <path d="M 10 52 Q 20 38 30 52 Z" fill="#e25822"/>
  <path d="M 30 52 Q 40 38 50 52 Z" fill="#ff6b35"/>
  <path d="M 50 52 Q 60 38 70 52 Z" fill="#e25822"/>
  <!-- Flags -->
  <line x1="20" y1="20" x2="20" y2="38" stroke="#222" stroke-width="1"/>
  <path d="M 20 20 L 30 24 L 20 28 Z" fill="#ff6b35"/>
  <line x1="60" y1="20" x2="60" y2="38" stroke="#222" stroke-width="1"/>
  <path d="M 60 20 L 50 24 L 60 28 Z" fill="#ff6b35"/>
  <!-- Lights -->
  <circle cx="14" cy="44" r="2.5" fill="#fff4cc"/>
  <circle cx="40" cy="40" r="2.5" fill="#fff4cc"/>
  <circle cx="66" cy="44" r="2.5" fill="#fff4cc"/>
</svg>`,
};

const STYLES = `
<style>
  body { background:#020617; color:#e2e8f0; }
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; }
  .accent { color:#ff6b35; }
  .hero-svg { width: 360px; max-width: 90vw; height: auto; display: block; }
  .click-target {
    cursor: pointer;
    transition: transform 0.05s ease-out;
    user-select: none;
    -webkit-user-select: none;
    filter: drop-shadow(0 10px 30px rgba(255,107,53,0.25));
  }
  .click-target:active { transform: scale(0.96); }
  .click-target:hover { filter: drop-shadow(0 10px 40px rgba(255,107,53,0.45)); }
  .float-num {
    position: absolute; pointer-events: none; font-weight: 700; font-size: 22px;
    color: #ffa07a; text-shadow: 0 2px 8px rgba(0,0,0,0.6);
    animation: floatup 1.1s ease-out forwards;
  }
  @keyframes floatup {
    0% { transform: translate(-50%, 0); opacity: 1; }
    100% { transform: translate(-50%, -90px); opacity: 0; }
  }
  .building-card { transition: background 0.15s; }
  .building-card:hover { background:#111a30; }
  .building-card.affordable { cursor: pointer; }
  .building-card.locked { opacity: 0.45; }
  .upgrade-pill {
    background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:999px;
    padding: 6px 12px; font-size: 13px; display: inline-flex; align-items: center; gap: 6px;
    cursor: pointer; transition: all 0.15s;
  }
  .upgrade-pill.affordable { border-color: #ff6b35; color: #ffa07a; }
  .upgrade-pill.affordable:hover { background:#1f1408; }
  .upgrade-pill.locked { opacity: 0.4; cursor: default; }
  .upgrade-pill.owned { background:#1d2a3a; border-color: #34d399; color: #6ee7b7; cursor: default; }
  .bonus-row { background:#0b1220; border-left: 3px solid #ff6b35; padding: 10px 12px; border-radius: 6px; }
  .pulse-once { animation: pulse 0.6s ease-out; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(255,107,53,0.5); }
    100% { box-shadow: 0 0 0 24px rgba(255,107,53,0); }
  }
</style>`;

function renderLoginGate() {
  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker · login</title>${STYLES}</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-3xl mx-auto px-6 py-16 text-center">
  <div class="text-8xl mb-4">🌭</div>
  <h1 class="text-5xl md:text-6xl font-bold text-white tracking-tight mb-3">GlizzyClicker</h1>
  <p class="text-xl text-slate-300 mb-2">An idle game powered by your real hot dog stats.</p>
  <p class="text-slate-400 mb-10">Eat dogs in the channel, get bonuses in the game. Streaks scale uncapped.</p>
  <a href="/oauth/login?next=%2Fgame" class="inline-block px-8 py-4 bg-accent hover:bg-accent-deep text-white font-bold text-lg rounded-xl transition">
    Log in with Discord →
  </a>
  <div class="mt-10 grid sm:grid-cols-3 gap-4 text-left">
    <div class="card p-4"><div class="text-2xl mb-1">🍽️</div><div class="font-bold text-white">Big Eater</div><div class="text-sm text-slate-400">Eat &gt;4 dogs yesterday → +0.25× click power for 24h.</div></div>
    <div class="card p-4"><div class="text-2xl mb-1">🌅</div><div class="font-bold text-white">Breakfast Boon</div><div class="text-sm text-slate-400">A dog before 8 AM → Mustard Stand +50%.</div></div>
    <div class="card p-4"><div class="text-2xl mb-1">🔥</div><div class="font-bold text-white">Streak (uncapped)</div><div class="text-sm text-slate-400">Each consecutive day adds +2% production. Day 100 = +200%.</div></div>
  </div>
  <p class="text-xs text-slate-500 mt-8">We only request the <code class="bg-slate-900 px-1 rounded">identify</code> scope. Your Discord ID is matched to your hotdog stats automatically.</p>
</main>
</body></html>`;
}

function renderGamePage({ state, bonuses, rates, offlineEarned, profile, userId }) {
  const displayName = (profile && (profile.global_name || profile.username)) || `User ${String(userId).slice(-4)}`;
  const avatarUrl = profile && profile.avatar_url;
  const avatarHtml = avatarUrl
    ? `<img src="${esc(avatarUrl)}" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;">`
    : `<span style="width:32px;height:32px;border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:14px;">${esc((displayName[0] || "?").toUpperCase())}</span>`;

  const initial = JSON.stringify({
    state, bonuses, rates, offlineEarned,
    buildings: BUILDINGS, upgrades: UPGRADES,
    buildingSvgs: BUILDING_SVGS,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker</title>${STYLES}
<script>window.GAME = ${initial};</script>
</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-7xl mx-auto px-4 md:px-6 py-6">
  <div class="flex items-center justify-between mb-4">
    <div class="flex items-baseline gap-3">
      <div class="text-5xl font-bold text-white tabular-nums" id="glizzies-display">0</div>
      <div class="text-slate-400">glizzies · <span id="pps-display" class="text-accent">0/s</span></div>
    </div>
    <div class="flex items-center gap-3">
      <span class="text-sm text-slate-300">${esc(displayName)}</span>
      ${avatarHtml}
      <form method="post" action="/oauth/logout" class="inline">
        <button class="text-xs text-slate-500 hover:text-slate-300" type="submit">Log out</button>
      </form>
    </div>
  </div>

  <div class="grid md:grid-cols-3 gap-6">
    <!-- LEFT: bonuses -->
    <section class="md:col-span-1">
      <div class="card p-4 mb-4">
        <div class="text-xs uppercase tracking-widest text-slate-400 mb-3">Active bonuses</div>
        <div id="bonuses-list" class="space-y-2">
          ${bonuses.length === 0
            ? `<div class="text-slate-500 text-sm">No active bonuses. Eat dogs in the channel to earn them.</div>`
            : bonuses.map((b) => `
                <div class="bonus-row">
                  <div class="flex items-center gap-2 text-white font-semibold"><span class="text-lg">${esc(b.emoji)}</span> ${esc(b.name)}</div>
                  <div class="text-xs text-slate-400 mt-0.5">${esc(b.explanation)}</div>
                </div>`).join("")}
        </div>
      </div>
      <div class="card p-4">
        <div class="text-xs uppercase tracking-widest text-slate-400 mb-2">Stats</div>
        <div class="text-sm space-y-1">
          <div class="flex justify-between"><span class="text-slate-400">Lifetime</span><span id="lifetime-display" class="tabular-nums">0</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Total clicks</span><span id="clicks-display" class="tabular-nums">0</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Buildings</span><span id="buildings-total-display" class="tabular-nums">0</span></div>
          <div class="flex justify-between"><span class="text-slate-400">Click power</span><span id="click-power-display" class="tabular-nums">0</span></div>
        </div>
        <div class="mt-4 text-center">
          <a href="/game/leaderboard" class="text-xs text-accent hover:text-accent-soft">Leaderboard →</a>
        </div>
      </div>
    </section>

    <!-- CENTER: hero -->
    <section class="md:col-span-1 flex flex-col items-center justify-center min-h-[500px]">
      <div id="click-area" class="click-target relative">${HERO_SVG}</div>
      <div class="mt-6 text-slate-400 text-sm">Click the glizzy!</div>
    </section>

    <!-- RIGHT: upgrades + buildings -->
    <section class="md:col-span-1">
      <div class="card p-4 mb-4">
        <div class="text-xs uppercase tracking-widest text-slate-400 mb-3">Upgrades</div>
        <div id="upgrades-list" class="flex flex-wrap gap-2"></div>
      </div>
      <div class="card p-4">
        <div class="text-xs uppercase tracking-widest text-slate-400 mb-3">Buildings</div>
        <div id="buildings-list" class="space-y-2"></div>
      </div>
    </section>
  </div>
</main>

<div id="offline-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
  <div class="card p-8 max-w-md text-center mx-4">
    <div class="text-5xl mb-3">🌭</div>
    <div class="text-xl text-white font-bold mb-2">Welcome back!</div>
    <div class="text-slate-300 mb-4">While you were away, you earned</div>
    <div class="text-4xl font-bold accent mb-6" id="offline-amount">0</div>
    <button id="offline-close" class="px-6 py-2 bg-accent hover:bg-accent-deep text-white rounded-lg font-semibold">Sweet</button>
  </div>
</div>

${GAME_CLIENT_JS}
</body></html>`;
}

const GAME_CLIENT_JS = `
<script>
(function () {
  const G = window.GAME;
  let state = G.state;
  let bonuses = G.bonuses;
  let rates = G.rates;
  const BUILDINGS = G.buildings;
  const UPGRADES = G.upgrades;
  const BUILDING_SVGS = G.buildingSvgs;
  const COST_SCALE = 1.15;
  const UPGRADE_MAP = new Map(UPGRADES.map(u => [u.id, u]));

  let dirty = false;
  let saveInFlight = false;

  // ----- formatting -----
  function fmt(n) {
    n = Math.floor(n);
    if (n < 1e3) return n.toLocaleString();
    if (n < 1e6) return (n/1e3).toFixed(2) + 'K';
    if (n < 1e9) return (n/1e6).toFixed(2) + 'M';
    if (n < 1e12) return (n/1e9).toFixed(2) + 'B';
    return (n/1e12).toFixed(2) + 'T';
  }
  function fmtRate(n) {
    if (n < 1) return n.toFixed(2) + '/s';
    if (n < 1e3) return n.toFixed(1) + '/s';
    return fmt(n) + '/s';
  }

  // ----- effective rates (client-side replica of glizzy.js logic) -----
  function recomputeRates() {
    let clickPower = 1, clickAdd = 0, globalMult = 1;
    const buildingMult = {};
    for (const b of BUILDINGS) buildingMult[b.id] = 1;

    for (const upId of state.upgrades_owned) {
      const up = UPGRADE_MAP.get(upId); if (!up) continue;
      const e = up.effect;
      if (e.type === 'click_mult') clickPower *= e.value;
      else if (e.type === 'building_mult') buildingMult[e.building] *= e.value;
      else if (e.type === 'global_mult') globalMult *= e.value;
      else if (e.type === 'click_per_building') {
        let total = 0; for (const b of BUILDINGS) total += state.buildings[b.id] || 0;
        clickAdd += total * e.value;
      }
    }
    for (const b of bonuses) {
      const e = b.effect;
      if (e.type === 'click_mult') clickPower *= e.value;
      else if (e.type === 'building_mult') buildingMult[e.building] *= e.value;
      else if (e.type === 'global_mult') globalMult *= e.value;
    }
    const perClick = (clickPower + clickAdd) * globalMult;
    let perSecond = 0;
    const bp = {};
    for (const b of BUILDINGS) {
      const owned = state.buildings[b.id] || 0;
      const r = owned * b.base_rate * buildingMult[b.id] * globalMult;
      bp[b.id] = r;
      perSecond += r;
    }
    rates = { perClick, perSecond, buildingProduction: bp };
  }

  function buildingCost(id) {
    const b = BUILDINGS.find(x => x.id === id);
    if (!b) return Infinity;
    return Math.ceil(b.base_cost * Math.pow(COST_SCALE, state.buildings[id] || 0));
  }

  // ----- rendering -----
  function renderHud() {
    document.getElementById('glizzies-display').textContent = fmt(state.glizzies);
    document.getElementById('pps-display').textContent = fmtRate(rates.perSecond);
    document.getElementById('lifetime-display').textContent = fmt(state.lifetime);
    document.getElementById('clicks-display').textContent = fmt(state.total_clicks);
    const totalBuildings = BUILDINGS.reduce((s, b) => s + (state.buildings[b.id] || 0), 0);
    document.getElementById('buildings-total-display').textContent = fmt(totalBuildings);
    document.getElementById('click-power-display').textContent = fmt(rates.perClick);
  }

  function renderBuildings() {
    const root = document.getElementById('buildings-list');
    const html = BUILDINGS.map(b => {
      const owned = state.buildings[b.id] || 0;
      const cost = buildingCost(b.id);
      const affordable = state.glizzies >= cost;
      const cls = affordable ? 'building-card affordable card p-3' : 'building-card locked card p-3';
      const production = (rates.buildingProduction[b.id] || 0).toFixed(2);
      return \`
        <div class="\${cls}" data-buy="\${b.id}">
          <div class="flex items-center gap-3">
            <div style="width:48px;height:48px;flex-shrink:0">\${BUILDING_SVGS[b.id]}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <div class="font-semibold text-white truncate">\${b.name}</div>
                <div class="text-xs text-slate-500 tabular-nums">×\${owned}</div>
              </div>
              <div class="text-xs text-slate-400 mt-0.5">\${production}/s · cost \${fmt(cost)}</div>
            </div>
          </div>
        </div>\`;
    }).join('');
    root.innerHTML = html;
    root.querySelectorAll('[data-buy]').forEach(el => {
      el.addEventListener('click', () => buyBuilding(el.dataset.buy));
    });
  }

  function renderUpgrades() {
    const root = document.getElementById('upgrades-list');
    const owned = new Set(state.upgrades_owned);
    const html = UPGRADES.map(u => {
      let cls = 'upgrade-pill';
      if (owned.has(u.id)) cls += ' owned';
      else if (state.glizzies >= u.cost) cls += ' affordable';
      else cls += ' locked';
      return \`<button class="\${cls}" data-upgrade="\${u.id}" title="\${u.name} — costs \${fmt(u.cost)}"><span>\${u.emoji}</span><span>\${u.name}</span><span class="text-xs opacity-60">\${owned.has(u.id) ? 'owned' : fmt(u.cost)}</span></button>\`;
    }).join('');
    root.innerHTML = html;
    root.querySelectorAll('[data-upgrade]').forEach(el => {
      el.addEventListener('click', () => buyUpgrade(el.dataset.upgrade));
    });
  }

  function rerender() {
    renderHud();
    renderBuildings();
    renderUpgrades();
  }

  // ----- actions -----
  function buyBuilding(id) {
    const cost = buildingCost(id);
    if (state.glizzies < cost) return;
    state.glizzies -= cost;
    state.buildings[id] = (state.buildings[id] || 0) + 1;
    recomputeRates();
    dirty = true;
    rerender();
    save();
  }
  function buyUpgrade(id) {
    if (state.upgrades_owned.includes(id)) return;
    const up = UPGRADE_MAP.get(id); if (!up) return;
    if (state.glizzies < up.cost) return;
    state.glizzies -= up.cost;
    state.upgrades_owned.push(id);
    recomputeRates();
    dirty = true;
    rerender();
    save();
  }

  const clickArea = document.getElementById('click-area');
  clickArea.addEventListener('click', (ev) => {
    const gain = rates.perClick;
    state.glizzies += gain;
    state.lifetime += gain;
    state.total_clicks += 1;
    dirty = true;

    // Floating "+N" anim
    const rect = clickArea.getBoundingClientRect();
    const el = document.createElement('div');
    el.className = 'float-num';
    el.textContent = '+' + fmt(gain);
    el.style.left = (ev.clientX - rect.left) + 'px';
    el.style.top = (ev.clientY - rect.top) + 'px';
    clickArea.appendChild(el);
    setTimeout(() => el.remove(), 1100);

    renderHud();
  });

  // Production tick — 100 ms
  setInterval(() => {
    if (rates.perSecond > 0) {
      const gain = rates.perSecond / 10;
      state.glizzies += gain;
      state.lifetime += gain;
      dirty = true;
      renderHud();
      // Rebuilds the building affordability state every second.
    }
  }, 100);
  setInterval(() => { renderBuildings(); renderUpgrades(); }, 1000);

  // ----- save -----
  async function save() {
    if (saveInFlight) return;
    if (!dirty) return;
    saveInFlight = true;
    dirty = false;
    try {
      const res = await fetch('/api/game/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          glizzies: state.glizzies,
          lifetime: state.lifetime,
          total_clicks: state.total_clicks,
          buildings: state.buildings,
          upgrades_owned: state.upgrades_owned,
        }),
      });
      if (res.ok) {
        const data = await res.json();
        state = data.state;
        bonuses = data.bonuses;
        recomputeRates();
        localStorage.setItem('glizzy_backup', JSON.stringify(state));
      }
    } catch (e) {
      console.warn('save failed', e);
      dirty = true;  // retry next tick
    } finally {
      saveInFlight = false;
    }
  }
  setInterval(save, 10000);
  window.addEventListener('beforeunload', () => {
    if (dirty) {
      navigator.sendBeacon('/api/game/save', new Blob([JSON.stringify({
        glizzies: state.glizzies, lifetime: state.lifetime, total_clicks: state.total_clicks,
        buildings: state.buildings, upgrades_owned: state.upgrades_owned,
      })], { type: 'application/json' }));
    }
  });

  // ----- offline modal -----
  if (G.offlineEarned && G.offlineEarned > 5) {
    document.getElementById('offline-amount').textContent = fmt(G.offlineEarned) + ' 🌭';
    document.getElementById('offline-modal').classList.remove('hidden');
    document.getElementById('offline-close').addEventListener('click', () => {
      state.glizzies += G.offlineEarned;
      state.lifetime += G.offlineEarned;
      dirty = true;
      document.getElementById('offline-modal').classList.add('hidden');
      renderHud();
      save();
    });
  }

  // Initial render
  recomputeRates();
  rerender();
})();
</script>`;

function renderLeaderboardPage(rows) {
  const cards = rows.length === 0
    ? `<div class="card p-12 text-center"><div class="text-5xl mb-3">🌭</div><div class="text-xl text-slate-200 font-semibold">No players yet</div><div class="text-slate-400 mt-2">Be the first — log in and start clicking.</div></div>`
    : `<div class="card p-2">${rows.map((r, i) => {
        const profile = getUserProfileStmt.get(r.user_id);
        const name = (profile && (profile.global_name || profile.username)) || `User ${String(r.user_id).slice(-4)}`;
        const avatar = profile && profile.avatar_url
          ? `<img src="${esc(profile.avatar_url)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;">`
          : `<span style="width:36px;height:36px;border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:700;">${esc((name[0] || "?").toUpperCase())}</span>`;
        const rankColor = i === 0 ? "#ffd166" : i === 1 ? "#cbd5e1" : i === 2 ? "#d4a574" : "#6b7280";
        return `
          <div class="flex items-center gap-4 px-3 py-3 hover:bg-slate-800/40 transition">
            <div class="text-2xl font-bold tabular-nums w-10 text-right" style="color:${rankColor}">${esc(i + 1)}</div>
            ${avatar}
            <div class="flex-1">
              <div class="font-semibold text-white">${esc(name)}</div>
              <div class="text-xs text-slate-400">${esc(r.total_buildings)} buildings · ${esc(r.total_clicks.toLocaleString())} clicks</div>
            </div>
            <div class="text-right">
              <div class="text-2xl font-bold accent tabular-nums">${esc(r.lifetime.toLocaleString())}</div>
              <div class="text-xs text-slate-500">lifetime 🌭</div>
            </div>
          </div>`;
      }).join("")}</div>`;

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker · Leaderboard</title>${STYLES}</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-3xl mx-auto px-6 py-8">
  <section class="mb-6">
    <div class="text-slate-400 text-sm uppercase tracking-widest mb-2">Leaderboard</div>
    <h1 class="text-4xl font-bold text-white tracking-tight">GlizzyClicker</h1>
    <p class="text-slate-400 mt-2">Top players by lifetime glizzies earned.</p>
  </section>
  ${cards}
  <div class="text-center mt-6">
    <a href="/game" class="text-accent hover:text-accent-soft">← back to the game</a>
  </div>
</main>
</body></html>`;
}

export function registerGame(app) {
  app.get("/game", (req, res) => {
    const userId = getSessionUserId(req);
    if (!userId) return res.send(renderLoginGate());
    const data = loadGameForUser(userId);
    const profile = getUserProfileStmt.get(userId);
    res.send(renderGamePage({ ...data, profile, userId }));
  });

  app.get("/game/leaderboard", (req, res) => {
    res.send(renderLeaderboardPage(getLeaderboardRows(50)));
  });

  app.get("/api/game/state", requireGameSession, (req, res) => {
    res.json(loadGameForUser(req.gameUserId));
  });

  app.post("/api/game/save", requireGameSession, express.json({ limit: "32kb" }), (req, res) => {
    const result = validateAndClampSave(req.gameUserId, req.body || {});
    res.json(result);
  });

  app.get("/api/game/leaderboard", (req, res) => {
    res.json(getLeaderboardRows(50));
  });
}

// Re-exports for /glizzy slash command
export { getLeaderboardRows, getPlayerSummary };
