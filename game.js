import express from "express";
import { getSessionUserId, requireGameSession } from "./oauth.js";
import {
  loadGameForUser,
  validateAndClampSave,
  claimGoldenGlizzy,
  getLeaderboardRows,
  getPlayerSummary,
  BUILDINGS,
  UPGRADES,
  ALL_BONUSES,
  GOLDEN_SPAWN,
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

const RATE_SCALES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];
export function fmtRate(n) {
  if (!Number.isFinite(n) || n <= 0) return "0/s";
  if (n < 1) return n.toFixed(2) + "/s";
  if (n < 1000) return n.toFixed(1) + "/s";
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= RATE_SCALES.length) return n.toExponential(2) + "/s";
  return (n / Math.pow(1000, tier)).toFixed(2) + RATE_SCALES[tier] + "/s";
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
<svg viewBox="0 0 320 240" class="hero-svg" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="bunGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#fadc9c"/>
      <stop offset="55%" stop-color="#d6a05a"/>
      <stop offset="100%" stop-color="#8a5e23"/>
    </linearGradient>
    <linearGradient id="sausageGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#e87c4e"/>
      <stop offset="55%" stop-color="#c44536"/>
      <stop offset="100%" stop-color="#722012"/>
    </linearGradient>
    <linearGradient id="mustardGrad" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffe066"/>
      <stop offset="100%" stop-color="#d49a07"/>
    </linearGradient>
    <filter id="heroshadow" x="-20%" y="-20%" width="140%" height="140%">
      <feGaussianBlur stdDeviation="6"/>
      <feOffset dx="0" dy="8"/>
      <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
      <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter>
  </defs>

  <!-- Ground shadow -->
  <ellipse cx="160" cy="215" rx="125" ry="7" fill="rgba(0,0,0,0.35)"/>

  <g filter="url(#heroshadow)">
    <!-- Bottom bun: long pill, full width -->
    <rect x="22" y="125" width="276" height="78" rx="39" fill="url(#bunGrad)"/>
    <!-- Sausage: pokes out the top of the bun, slightly above center -->
    <rect x="38" y="92" width="244" height="58" rx="29" fill="url(#sausageGrad)"/>
  </g>

  <!-- Sausage highlight stripe -->
  <ellipse cx="160" cy="105" rx="105" ry="5" fill="rgba(255,200,170,0.55)"/>

  <!-- Subtle bun seam (where sausage emerges) -->
  <ellipse cx="160" cy="148" rx="118" ry="4" fill="rgba(50,30,10,0.18)"/>

  <!-- Mustard zigzag down the length of the sausage -->
  <path d="M 60 116 L 80 100 L 100 116 L 120 100 L 140 116 L 160 100 L 180 116 L 200 100 L 220 116 L 240 100 L 260 116"
        stroke="url(#mustardGrad)" stroke-width="8" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M 60 116 L 80 100 L 100 116 L 120 100 L 140 116 L 160 100 L 180 116 L 200 100 L 220 116 L 240 100 L 260 116"
        stroke="#fff4a3" stroke-width="2.5" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.7"/>

  <!-- Sesame seeds scattered on the bun -->
  <g fill="#fff4cc" opacity="0.85">
    <ellipse cx="55" cy="162" rx="3" ry="1.5" transform="rotate(-18 55 162)"/>
    <ellipse cx="90" cy="170" rx="3" ry="1.5" transform="rotate(8 90 170)"/>
    <ellipse cx="130" cy="165" rx="3" ry="1.5" transform="rotate(-5 130 165)"/>
    <ellipse cx="160" cy="172" rx="3" ry="1.5"/>
    <ellipse cx="195" cy="166" rx="3" ry="1.5" transform="rotate(12 195 166)"/>
    <ellipse cx="230" cy="170" rx="3" ry="1.5" transform="rotate(-8 230 170)"/>
    <ellipse cx="265" cy="162" rx="3" ry="1.5" transform="rotate(20 265 162)"/>
    <ellipse cx="75" cy="185" rx="3" ry="1.5" transform="rotate(5 75 185)"/>
    <ellipse cx="245" cy="185" rx="3" ry="1.5" transform="rotate(-12 245 185)"/>
  </g>

  <!-- Cute face on the sausage -->
  <g>
    <circle cx="125" cy="122" r="7" fill="#fff"/>
    <circle cx="127" cy="124" r="3.5" fill="#1a1a1a"/>
    <circle cx="125" cy="120" r="1.5" fill="#fff"/>
    <circle cx="195" cy="122" r="7" fill="#fff"/>
    <circle cx="197" cy="124" r="3.5" fill="#1a1a1a"/>
    <circle cx="195" cy="120" r="1.5" fill="#fff"/>
    <path d="M 145 136 Q 160 145 175 136" stroke="#1a1a1a" stroke-width="3" fill="none" stroke-linecap="round"/>
    <circle cx="105" cy="135" r="5" fill="#e25822" opacity="0.45"/>
    <circle cx="215" cy="135" r="5" fill="#e25822" opacity="0.45"/>
  </g>
</svg>`;

const GOLDEN_SVG = `
<svg viewBox="0 0 320 240" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="goldBun" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#fff6c2"/>
      <stop offset="50%" stop-color="#ffd24a"/>
      <stop offset="100%" stop-color="#b8860b"/>
    </linearGradient>
    <linearGradient id="goldSausage" x1="0" x2="0" y1="0" y2="1">
      <stop offset="0%" stop-color="#ffe89a"/>
      <stop offset="55%" stop-color="#e8b923"/>
      <stop offset="100%" stop-color="#9a6b04"/>
    </linearGradient>
    <radialGradient id="goldHalo" cx="50%" cy="50%" r="50%">
      <stop offset="0%" stop-color="#fff7cc" stop-opacity="0.95"/>
      <stop offset="55%" stop-color="#ffd24a" stop-opacity="0.35"/>
      <stop offset="100%" stop-color="#ffd24a" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <ellipse cx="160" cy="150" rx="150" ry="110" fill="url(#goldHalo)"/>
  <g>
    <rect x="22" y="125" width="276" height="78" rx="39" fill="url(#goldBun)"/>
    <rect x="38" y="92" width="244" height="58" rx="29" fill="url(#goldSausage)"/>
  </g>
  <ellipse cx="160" cy="105" rx="105" ry="5" fill="rgba(255,255,230,0.7)"/>
  <path d="M 60 116 L 80 100 L 100 116 L 120 100 L 140 116 L 160 100 L 180 116 L 200 100 L 220 116 L 240 100 L 260 116"
        stroke="#fff7cc" stroke-width="6" fill="none" stroke-linecap="round" stroke-linejoin="round" opacity="0.9"/>
  <g>
    <circle cx="125" cy="122" r="7" fill="#fff"/><circle cx="127" cy="124" r="3.5" fill="#3a2a08"/>
    <circle cx="195" cy="122" r="7" fill="#fff"/><circle cx="197" cy="124" r="3.5" fill="#3a2a08"/>
    <path d="M 142 134 Q 160 150 178 134" stroke="#3a2a08" stroke-width="3" fill="none" stroke-linecap="round"/>
  </g>
  <g fill="#fff7cc">
    <path d="M 50 40 l 4 10 l 10 4 l -10 4 l -4 10 l -4 -10 l -10 -4 l 10 -4 z"/>
    <path d="M 270 50 l 3 8 l 8 3 l -8 3 l -3 8 l -3 -8 l -8 -3 l 8 -3 z"/>
    <path d="M 240 30 l 2 6 l 6 2 l -6 2 l -2 6 l -2 -6 l -6 -2 l 6 -2 z"/>
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
  franchise: `
<svg viewBox="0 0 80 80">
  <!-- Storefront block -->
  <rect x="10" y="34" width="60" height="34" fill="#7a2f1c"/>
  <rect x="10" y="34" width="60" height="34" fill="#e25822" opacity="0.85"/>
  <!-- Striped awning -->
  <path d="M 8 34 L 72 34 L 66 22 L 14 22 Z" fill="#ff6b35"/>
  <path d="M 22 34 L 28 22 L 34 22 L 28 34 Z" fill="#fff" opacity="0.9"/>
  <path d="M 40 34 L 46 22 L 52 22 L 46 34 Z" fill="#fff" opacity="0.9"/>
  <!-- Sign -->
  <text x="40" y="20" text-anchor="middle" fill="#f7c02e" font-size="7" font-weight="800" font-family="Inter">GLIZZY CO.</text>
  <!-- Windows + door -->
  <rect x="16" y="42" width="14" height="14" fill="#f7c02e" opacity="0.85"/>
  <rect x="50" y="42" width="14" height="14" fill="#f7c02e" opacity="0.85"/>
  <rect x="34" y="48" width="12" height="20" fill="#3a1a0e"/>
  <circle cx="43" cy="58" r="1" fill="#f7c02e"/>
</svg>`,
  orbital_station: `
<svg viewBox="0 0 80 80">
  <!-- Stars -->
  <circle cx="14" cy="16" r="1.2" fill="#fff" opacity="0.8"/>
  <circle cx="66" cy="12" r="1.5" fill="#fff" opacity="0.7"/>
  <circle cx="60" cy="30" r="1" fill="#fff" opacity="0.6"/>
  <!-- Solar panels -->
  <rect x="6" y="36" width="16" height="10" fill="#2b4a8a" rx="1"/>
  <rect x="58" y="36" width="16" height="10" fill="#2b4a8a" rx="1"/>
  <line x1="22" y1="41" x2="30" y2="41" stroke="#888" stroke-width="2"/>
  <line x1="50" y1="41" x2="58" y2="41" stroke="#888" stroke-width="2"/>
  <!-- Core module shaped like a dog -->
  <rect x="28" y="32" width="24" height="18" rx="9" fill="#c44536"/>
  <rect x="30" y="30" width="20" height="10" rx="5" fill="#fadc9c"/>
  <path d="M 32 36 L 36 33 L 40 36 L 44 33 L 48 36" stroke="#f7c02e" stroke-width="2" fill="none" stroke-linecap="round"/>
  <!-- Porthole + thruster glow -->
  <circle cx="40" cy="50" r="3" fill="#1a1a2e" stroke="#888" stroke-width="1"/>
  <ellipse cx="40" cy="62" rx="6" ry="9" fill="#ff6b35" opacity="0.7"/>
  <ellipse cx="40" cy="60" rx="3" ry="5" fill="#fff4cc" opacity="0.9"/>
</svg>`,
  glizzy_megaplex: `
<svg viewBox="0 0 80 80">
  <!-- Skyscraper -->
  <rect x="24" y="10" width="32" height="60" fill="#e25822"/>
  <rect x="24" y="10" width="32" height="60" fill="#ff6b35" opacity="0.5"/>
  <rect x="20" y="6" width="40" height="6" fill="#c44536"/>
  <!-- Window grid -->
  <g fill="#f7c02e" opacity="0.85">
    <rect x="28" y="16" width="6" height="6"/><rect x="38" y="16" width="6" height="6"/><rect x="48" y="16" width="6" height="6"/>
    <rect x="28" y="26" width="6" height="6"/><rect x="38" y="26" width="6" height="6"/><rect x="48" y="26" width="6" height="6"/>
    <rect x="28" y="36" width="6" height="6"/><rect x="38" y="36" width="6" height="6"/><rect x="48" y="36" width="6" height="6"/>
    <rect x="28" y="46" width="6" height="6"/><rect x="38" y="46" width="6" height="6"/><rect x="48" y="46" width="6" height="6"/>
  </g>
  <rect x="36" y="58" width="8" height="12" fill="#3a1a0e"/>
  <!-- Rooftop dog sign -->
  <rect x="34" y="0" width="12" height="6" rx="3" fill="#c44536"/>
</svg>`,
  quantum_kitchen: `
<svg viewBox="0 0 80 80">
  <!-- Nucleus -->
  <circle cx="40" cy="40" r="7" fill="#ff6b35"/>
  <circle cx="40" cy="40" r="3" fill="#fff4cc"/>
  <!-- Electron orbits -->
  <g stroke="#f7c02e" stroke-width="2" fill="none" opacity="0.9">
    <ellipse cx="40" cy="40" rx="30" ry="12"/>
    <ellipse cx="40" cy="40" rx="30" ry="12" transform="rotate(60 40 40)"/>
    <ellipse cx="40" cy="40" rx="30" ry="12" transform="rotate(120 40 40)"/>
  </g>
  <circle cx="70" cy="40" r="3" fill="#e25822"/>
  <circle cx="25" cy="16" r="3" fill="#e25822"/>
  <circle cx="25" cy="64" r="3" fill="#e25822"/>
</svg>`,
  dyson_grill: `
<svg viewBox="0 0 80 80">
  <!-- Star core -->
  <circle cx="40" cy="40" r="16" fill="#ff6b35"/>
  <circle cx="40" cy="40" r="10" fill="#f7c02e"/>
  <circle cx="40" cy="40" r="5" fill="#fff4cc"/>
  <!-- Collector ring -->
  <ellipse cx="40" cy="40" rx="34" ry="12" fill="none" stroke="#5a5a78" stroke-width="4"/>
  <ellipse cx="40" cy="40" rx="34" ry="12" fill="none" stroke="#2b4a8a" stroke-width="2"/>
  <!-- Panel nodes on ring -->
  <rect x="70" y="36" width="6" height="8" fill="#2b4a8a"/>
  <rect x="4" y="36" width="6" height="8" fill="#2b4a8a"/>
  <rect x="37" y="27" width="6" height="6" fill="#2b4a8a" opacity="0.7"/>
</svg>`,
  black_hole_bun: `
<svg viewBox="0 0 80 80">
  <!-- Accretion disk -->
  <ellipse cx="40" cy="40" rx="34" ry="12" fill="none" stroke="#ff6b35" stroke-width="5" opacity="0.8"/>
  <ellipse cx="40" cy="40" rx="26" ry="9" fill="none" stroke="#f7c02e" stroke-width="4" opacity="0.7"/>
  <!-- Bun glow above/below the rim -->
  <path d="M 14 40 Q 40 30 66 40" fill="none" stroke="#c98a3e" stroke-width="3" opacity="0.6"/>
  <!-- Event horizon -->
  <circle cx="40" cy="40" r="13" fill="#020617"/>
  <circle cx="40" cy="40" r="13" fill="none" stroke="#ffae7a" stroke-width="1.5" opacity="0.8"/>
</svg>`,
  multiverse_glizzy: `
<svg viewBox="0 0 80 80">
  <!-- Portals -->
  <ellipse cx="26" cy="30" rx="14" ry="16" fill="#3b2a6b"/>
  <ellipse cx="26" cy="30" rx="8" ry="10" fill="#ff6b35" opacity="0.8"/>
  <ellipse cx="54" cy="34" rx="13" ry="15" fill="#2b4a8a"/>
  <ellipse cx="54" cy="34" rx="7" ry="9" fill="#f7c02e" opacity="0.8"/>
  <ellipse cx="40" cy="56" rx="15" ry="14" fill="#7a2f1c"/>
  <ellipse cx="40" cy="56" rx="9" ry="8" fill="#ffae7a" opacity="0.85"/>
  <!-- Dogs through the portals -->
  <rect x="22" y="27" width="10" height="6" rx="3" fill="#c44536"/>
  <rect x="50" y="31" width="9" height="5" rx="2.5" fill="#c44536"/>
  <!-- Sparks -->
  <circle cx="14" cy="14" r="1.4" fill="#fff" opacity="0.8"/>
  <circle cx="68" cy="16" r="1.4" fill="#fff" opacity="0.7"/>
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
  .upgrade-card {
    width: 100%; text-align: left;
    background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:10px;
    padding: 10px 12px; cursor: pointer; transition: all 0.15s;
  }
  .upgrade-card.affordable { border-color: rgba(255,107,53,0.55); }
  .upgrade-card.affordable:hover { background:#1f1408; }
  .upgrade-card.locked { opacity: 0.55; cursor: default; }
  .upgrade-card.owned { background:#13241e; border-color: rgba(52,211,153,0.4); cursor: default; }
  .upgrade-card.owned .u-name { color: #6ee7b7; }
  .upgrade-card .u-emoji { font-size: 20px; line-height: 1; flex-shrink: 0; }
  .upgrade-card .u-name { color: #f1f5f9; font-weight: 600; font-size: 13px; }
  .upgrade-card .u-desc { color: #94a3b8; font-size: 11px; line-height: 1.4; margin-top: 2px; }
  .upgrade-card .u-cost { font-size: 11px; font-weight: 600; margin-top: 4px; }
  .upgrade-card.affordable .u-cost { color: #ffa07a; }
  .upgrade-card.locked .u-cost { color: #94a3b8; }
  .upgrade-card.owned .u-cost { color: #6ee7b7; }
  .collapse-toggle { cursor: pointer; }
  .collapse-toggle .chev { display:inline-block; transition: transform 0.15s; color:#64748b; font-size:10px; }
  .collapse-toggle.collapsed .chev { transform: rotate(-90deg); }
  .disclosure-toggle { cursor: pointer; width: 100%; }
  .bonus-card { background:#0b1220; border: 1px solid rgba(148,163,184,0.08); border-radius: 10px; padding: 10px 12px; transition: all 0.15s; }
  .bonus-card.active { background: linear-gradient(135deg, rgba(255,107,53,0.12), rgba(255,107,53,0.02)); border-color: rgba(255,107,53,0.4); }
  .bonus-card.locked { opacity: 0.55; }
  .bonus-row { background:#0b1220; border-left: 3px solid #ff6b35; padding: 10px 12px; border-radius: 6px; }
  .pulse-once { animation: pulse 0.6s ease-out; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(255,107,53,0.5); }
    100% { box-shadow: 0 0 0 24px rgba(255,107,53,0); }
  }
  /* Golden glizzy — random spawn the player clicks for a reward */
  #golden-glizzy {
    position: fixed; z-index: 60; width: 150px; max-width: 40vw; cursor: pointer;
    opacity: 0; transform: scale(0.6) rotate(-8deg);
    transition: opacity 0.8s ease, transform 0.8s ease;
    filter: drop-shadow(0 0 18px rgba(255,210,74,0.7)) drop-shadow(0 0 40px rgba(255,210,74,0.4));
    pointer-events: none; user-select: none; -webkit-user-select: none;
  }
  #golden-glizzy.show { opacity: 1; transform: scale(1) rotate(0deg); pointer-events: auto; }
  #golden-glizzy.show { animation: goldenbob 2.4s ease-in-out infinite; }
  #golden-glizzy:active { transform: scale(0.9); }
  @keyframes goldenbob {
    0%,100% { translate: 0 0; } 50% { translate: 0 -12px; }
  }
  #golden-toast {
    position: fixed; left: 50%; top: 80px; transform: translateX(-50%) translateY(-20px);
    z-index: 70; opacity: 0; pointer-events: none; transition: opacity 0.4s ease, transform 0.4s ease;
    background: linear-gradient(135deg, #1a1407, #2a1e08);
    border: 1px solid rgba(255,210,74,0.6); border-radius: 14px;
    padding: 14px 22px; text-align: center; box-shadow: 0 10px 40px rgba(0,0,0,0.5);
    max-width: 90vw;
  }
  #golden-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
  #golden-toast.mega { border-color: #ffd24a; box-shadow: 0 0 50px rgba(255,210,74,0.6); animation: megapulse 0.8s ease-out infinite; }
  @keyframes megapulse { 0%,100% { box-shadow: 0 0 40px rgba(255,210,74,0.5); } 50% { box-shadow: 0 0 70px rgba(255,210,74,0.9); } }
  .buff-chip {
    display: inline-flex; align-items: center; gap: 6px; padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 700; color: #1a1407;
    background: linear-gradient(135deg, #ffe89a, #ffd24a); white-space: nowrap;
  }
  .buff-chip.mega { background: linear-gradient(135deg, #fff, #ffd24a); animation: megapulse 0.8s ease-out infinite; }
  /* Subtle scrollbars on the sticky side panels — invisible until you hover/scroll */
  .game-scrollcol { scrollbar-width: thin; scrollbar-color: rgba(148,163,184,0.2) transparent; }
  .game-scrollcol::-webkit-scrollbar { width: 6px; }
  .game-scrollcol::-webkit-scrollbar-track { background: transparent; }
  .game-scrollcol::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.15); border-radius: 3px; }
  .game-scrollcol:hover::-webkit-scrollbar-thumb { background: rgba(148,163,184,0.35); }
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
    goldenSpawn: GOLDEN_SPAWN,
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker</title>${STYLES}
<script>window.GAME = ${initial};</script>
</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-7xl mx-auto px-4 md:px-6 py-6">
  <div class="sticky top-14 z-40 -mx-4 md:-mx-6 px-4 md:px-6 py-2.5 mb-4 bg-slate-950/95 backdrop-blur border-b border-slate-800/60 flex items-center justify-between">
    <div class="flex items-baseline gap-3 flex-wrap">
      <div class="text-4xl font-bold text-white tabular-nums" id="glizzies-display">0</div>
      <div class="text-slate-400 text-sm">glizzies · <span id="pps-display" class="text-accent">0/s</span></div>
      <div id="buffs-bar" class="flex items-center gap-1.5"></div>
    </div>
    <div class="flex items-center gap-3">
      <span class="hidden sm:inline text-sm text-slate-300">${esc(displayName)}</span>
      ${avatarHtml}
      <form method="post" action="/oauth/logout" class="inline">
        <button class="text-xs text-slate-500 hover:text-slate-300" type="submit">Log out</button>
      </form>
    </div>
  </div>

  <div class="grid md:grid-cols-3 gap-6 md:items-start">
    <!-- LEFT: bonuses (sticky, internal scroll) -->
    <section class="md:col-span-1 md:sticky md:top-28 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto md:pr-2 game-scrollcol">
      <div class="card p-4 mb-4">
        <button type="button" class="collapse-toggle flex items-center justify-between w-full mb-3" data-collapse="bonuses">
          <div class="flex items-center gap-2">
            <span class="chev">▾</span>
            <span class="text-xs uppercase tracking-widest text-slate-400">Bonuses</span>
          </div>
          <div class="text-xs text-slate-500"><span class="accent">${esc(bonuses.length)}</span> / ${esc(ALL_BONUSES.length)} active</div>
        </button>
        <div data-collapse-body="bonuses">
        <div class="space-y-2">
          ${ALL_BONUSES.map((def) => {
            const active = bonuses.find((b) => b.id === def.id);
            const cls = active ? "bonus-card active" : "bonus-card locked";
            const displayName = active && active.name ? active.name : def.name;
            const explanationLine = active
              ? `<div class="text-xs accent font-semibold mt-1">${esc(active.explanation || def.description)} <span class="text-slate-400 font-normal">· ${esc(def.duration)}</span></div>
                 <div class="text-xs text-slate-300 mt-1">${esc(def.description)}</div>`
              : `<div class="text-xs text-slate-400 mt-1">${esc(def.description)}</div>
                 <div class="text-xs text-slate-500 mt-1">How to earn: ${esc(def.trigger)}</div>`;
            return `
              <div class="${cls}">
                <div class="flex items-center gap-2 text-white font-semibold">
                  <span class="text-lg">${esc(def.emoji)}</span> ${esc(displayName)}
                  ${active ? `<span class="ml-auto text-[10px] uppercase tracking-widest text-accent">Active</span>` : ""}
                </div>
                ${explanationLine}
              </div>`;
          }).join("")}
        </div>
        <div class="text-[11px] text-slate-500 mt-3">
          Bonuses derive from your real hot dog activity in Discord. Log dogs there → bonuses appear here next refresh.
        </div>
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

    <!-- CENTER: hero (sticky, vertically centered) -->
    <section class="md:col-span-1 md:sticky md:top-28 md:h-[calc(100vh-8rem)] flex flex-col items-center justify-center min-h-[500px]">
      <div id="click-area" class="click-target relative">${HERO_SVG}</div>
      <div class="mt-6 text-slate-400 text-sm">Click the glizzy!</div>
    </section>

    <!-- RIGHT: upgrades + buildings (sticky, internal scroll) -->
    <section class="md:col-span-1 md:sticky md:top-28 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto md:pr-2 game-scrollcol">
      <div class="card p-4 mb-4">
        <button type="button" class="collapse-toggle flex items-center gap-2 w-full mb-3" data-collapse="buildings">
          <span class="chev">▾</span>
          <span class="text-xs uppercase tracking-widest text-slate-400">Buildings</span>
        </button>
        <div data-collapse-body="buildings">
          <div id="buildings-list" class="space-y-2"></div>
        </div>
      </div>
      <div class="card p-4">
        <button type="button" class="collapse-toggle flex items-center gap-2 w-full mb-3" data-collapse="upgrades">
          <span class="chev">▾</span>
          <span class="text-xs uppercase tracking-widest text-slate-400">Upgrades</span>
        </button>
        <div data-collapse-body="upgrades">
          <div id="upgrades-list" class="space-y-2"></div>
        </div>
      </div>
    </section>
  </div>
</main>

<div id="golden-glizzy" title="A golden glizzy! Click it!">${GOLDEN_SVG}</div>
<div id="golden-toast"></div>

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
  let showAllUpgrades = false;
  let showOwnedUpgrades = false;

  // ----- formatting -----
  const SCALES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  function fmt(n) {
    if (!Number.isFinite(n)) return String(n);
    n = Math.floor(n);
    if (n < 1000) return n.toLocaleString();
    const tier = Math.floor(Math.log10(n) / 3);
    if (tier >= SCALES.length) return n.toExponential(2);
    const scaled = n / Math.pow(1000, tier);
    return scaled.toFixed(2) + SCALES[tier];
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
      else if (e.type === 'global_per_building') {
        let total = 0; for (const b of BUILDINGS) total += state.buildings[b.id] || 0;
        globalMult *= 1 + total * e.value;
      }
    }
    for (const b of bonuses) {
      const e = b.effect;
      if (e.type === 'click_mult') clickPower *= e.value;
      else if (e.type === 'building_mult') buildingMult[e.building] *= e.value;
      else if (e.type === 'global_mult') globalMult *= e.value;
    }
    // Active golden-glizzy buffs (mirrors glizzy.js — expire by timestamp).
    const gNow = Date.now();
    for (const g of (state.golden_effects || [])) {
      if (!g || new Date(g.expires_at).getTime() <= gNow) continue;
      if (g.kind === 'prod_mult') globalMult *= g.mult;
      else if (g.kind === 'click_mult') clickPower *= g.mult;
      else if (g.kind === 'building_mult' && buildingMult[g.building] !== undefined) buildingMult[g.building] *= g.mult;
    }
    const perClick = (clickPower + clickAdd) * globalMult;
    let perSecond = 0;
    const bp = {};
    const perUnit = {};
    for (const b of BUILDINGS) {
      const owned = state.buildings[b.id] || 0;
      const oneRate = b.base_rate * buildingMult[b.id] * globalMult;
      perUnit[b.id] = oneRate;
      const r = owned * oneRate;
      bp[b.id] = r;
      perSecond += r;
    }
    rates = { perClick, perSecond, buildingProduction: bp, perUnitRate: perUnit };
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
      const cls = affordable ? 'building-card affordable card p-2.5' : 'building-card locked card p-2.5';
      const productionNum = rates.buildingProduction[b.id] || 0;
      const perUnit = (rates.perUnitRate && rates.perUnitRate[b.id]) || 0;
      const perUnitStr = perUnit < 0.1 ? perUnit.toFixed(2) : perUnit < 10 ? perUnit.toFixed(1) : fmt(perUnit);
      const productionStr = productionNum < 0.1 ? productionNum.toFixed(2) : productionNum < 10 ? productionNum.toFixed(1) : fmt(productionNum);
      return \`
        <div class="\${cls}" data-buy="\${b.id}">
          <div class="flex items-center gap-2.5">
            <div style="width:40px;height:40px;flex-shrink:0">\${BUILDING_SVGS[b.id]}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <div class="font-semibold text-white truncate text-sm">\${b.name}</div>
                <div class="text-xs text-slate-500 tabular-nums">×\${owned}</div>
              </div>
              <div class="text-[11px] mt-0.5">
                <span class="accent font-semibold">+\${perUnitStr}/s</span>
                <span class="text-slate-500"> each · </span>
                <span class="text-slate-200 font-semibold">\${fmt(cost)}</span>
                \${owned > 0 ? \`<span class="text-slate-500"> · \${productionStr}/s total</span>\` : ''}
              </div>
              \${(b.description && owned === 0) ? \`<div class="text-[11px] text-slate-500 mt-1 leading-snug">\${b.description}</div>\` : ''}
            </div>
          </div>
        </div>\`;
    }).join('');
    root.innerHTML = html;
    root.querySelectorAll('[data-buy]').forEach(el => {
      el.addEventListener('click', () => buyBuilding(el.dataset.buy));
    });
  }

  function upgradeCardHtml(u, isOwned) {
    let cls = 'upgrade-card';
    let costLabel = '';
    if (isOwned) { cls += ' owned'; costLabel = '✓ Owned'; }
    else if (state.glizzies >= u.cost) { cls += ' affordable'; costLabel = 'Cost: ' + fmt(u.cost); }
    else { cls += ' locked'; costLabel = 'Cost: ' + fmt(u.cost); }
    const desc = u.description || '';
    return \`<button class="\${cls}" data-upgrade="\${u.id}">
        <div class="flex items-start gap-2">
          <span class="u-emoji">\${u.emoji}</span>
          <div class="flex-1 min-w-0">
            <div class="u-name">\${u.name}</div>
            <div class="u-desc">\${desc}</div>
            <div class="u-cost">\${costLabel}</div>
          </div>
        </div>
      </button>\`;
  }

  function renderUpgrades() {
    const root = document.getElementById('upgrades-list');
    const owned = new Set(state.upgrades_owned);
    const ownedUps = UPGRADES.filter(u => owned.has(u.id));
    const unowned = UPGRADES.filter(u => !owned.has(u.id)).sort((a, b) => a.cost - b.cost);

    // "In reach" = affordable or within ~4x of current glizzies; the cheapest
    // unowned upgrade is always revealed so the list is never empty early on.
    const cheapest = unowned.length ? unowned[0].cost : 0;
    const threshold = Math.max(state.glizzies * 4, cheapest);
    const reach = unowned.filter(u => u.cost <= threshold);
    const far = unowned.filter(u => u.cost > threshold);

    let html = reach.map(u => upgradeCardHtml(u, false)).join('');

    if (far.length) {
      html += showAllUpgrades
        ? far.map(u => upgradeCardHtml(u, false)).join('') +
          \`<button type="button" id="upg-showall" class="disclosure-toggle text-[11px] text-slate-500 hover:text-slate-300 py-1">show fewer ▴</button>\`
        : \`<button type="button" id="upg-showall" class="disclosure-toggle text-[11px] text-slate-500 hover:text-slate-300 py-1">+ \${far.length} more upgrade\${far.length > 1 ? 's' : ''} ▾</button>\`;
    }

    if (ownedUps.length) {
      html += \`<button type="button" id="upg-owned-toggle" class="disclosure-toggle flex items-center justify-between text-[11px] text-emerald-300/70 hover:text-emerald-300 py-1 mt-1">
          <span>Owned ✓ (\${ownedUps.length})</span><span>\${showOwnedUpgrades ? '▾' : '▸'}</span>
        </button>\`;
      if (showOwnedUpgrades) {
        html += '<div class="space-y-2 mt-1">' + ownedUps.map(u => upgradeCardHtml(u, true)).join('') + '</div>';
      }
    }

    root.innerHTML = html;
    root.querySelectorAll('[data-upgrade]').forEach(el => {
      el.addEventListener('click', () => buyUpgrade(el.dataset.upgrade));
    });
    const sa = document.getElementById('upg-showall');
    if (sa) sa.addEventListener('click', () => { showAllUpgrades = !showAllUpgrades; renderUpgrades(); });
    const ot = document.getElementById('upg-owned-toggle');
    if (ot) ot.addEventListener('click', () => { showOwnedUpgrades = !showOwnedUpgrades; renderUpgrades(); });
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
  setInterval(save, 5000);
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

  // ----- collapsible section panels (persisted per-section) -----
  function initCollapsibles() {
    const DEFAULT_COLLAPSED = { upgrades: true };
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem('glizzy_collapsed') || '{}'); } catch (e) {}
    document.querySelectorAll('[data-collapse]').forEach(btn => {
      const key = btn.dataset.collapse;
      const body = document.querySelector('[data-collapse-body="' + key + '"]');
      function apply(collapsed) {
        btn.classList.toggle('collapsed', collapsed);
        if (body) body.classList.toggle('hidden', collapsed);
      }
      apply(key in saved ? !!saved[key] : !!DEFAULT_COLLAPSED[key]);
      btn.addEventListener('click', () => {
        const collapsed = !btn.classList.contains('collapsed');
        apply(collapsed);
        saved[key] = collapsed;
        try { localStorage.setItem('glizzy_collapsed', JSON.stringify(saved)); } catch (e) {}
      });
    });
  }

  // ----- golden glizzy: active buff chips -----
  function buffLabel(g) {
    const secs = Math.max(0, Math.ceil((new Date(g.expires_at).getTime() - Date.now()) / 1000));
    const t = secs >= 60 ? Math.ceil(secs / 60) + 'm' : secs + 's';
    if (g.kind === 'prod_mult') {
      const mega = g.mult >= 100;
      return { mega, html: (mega ? '🌠' : '🔥') + ' ×' + fmt(g.mult) + ' prod · ' + t };
    }
    if (g.kind === 'click_mult') return { mega: false, html: '👆 ×' + fmt(g.mult) + ' click · ' + t };
    if (g.kind === 'building_mult') {
      const b = BUILDINGS.find(x => x.id === g.building);
      return { mega: false, html: '⚙️ ' + (b ? b.name : 'Building') + ' ×' + fmt(g.mult) + ' · ' + t };
    }
    return { mega: false, html: '✨ buff · ' + t };
  }
  function renderBuffs() {
    const bar = document.getElementById('buffs-bar');
    if (!bar) return;
    const now = Date.now();
    const active = (state.golden_effects || []).filter(g => g && new Date(g.expires_at).getTime() > now);
    if (active.length !== (state.golden_effects || []).length) {
      state.golden_effects = active;  // prune client-side; rates recompute below
      recomputeRates();
    }
    bar.innerHTML = active.map(g => {
      const l = buffLabel(g);
      return '<span class="buff-chip' + (l.mega ? ' mega' : '') + '">' + l.html + '</span>';
    }).join('');
  }
  setInterval(renderBuffs, 1000);

  // ----- golden glizzy: toast -----
  let toastTimer = null;
  function showGoldenToast(data) {
    const toast = document.getElementById('golden-toast');
    if (!toast) return;
    const mega = !!data.mega;
    toast.className = mega ? 'mega' : '';
    toast.innerHTML =
      '<div style="font-size:13px;letter-spacing:.15em;text-transform:uppercase;color:' + (mega ? '#ffd24a' : '#ffe89a') + '">' +
        (mega ? '✨ MEGA GOLDEN GLIZZY ✨' : 'Golden Glizzy') + '</div>' +
      '<div style="font-size:22px;font-weight:800;color:#fff;margin-top:2px">' + data.emoji + ' ' + data.name + '</div>' +
      '<div style="font-size:14px;color:#fde68a;margin-top:2px">' + (data.message || '') + '</div>';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), mega ? 8000 : 5000);
  }

  // ----- golden glizzy: claim -----
  async function claimGolden() {
    try {
      if (dirty) await save();  // flush local earnings so the server's bank is fresh (for Lucky!)
      const res = await fetch('/api/game/golden', { method: 'POST' });
      if (!res.ok) return;
      const data = await res.json();
      if (!data || !data.ok) return;  // e.g. claimed too soon
      state = data.state;
      bonuses = data.bonuses;
      recomputeRates();
      rerender();
      renderBuffs();
      showGoldenToast(data);
      try { localStorage.setItem('glizzy_backup', JSON.stringify(state)); } catch (e) {}
    } catch (e) { console.warn('golden claim failed', e); }
  }

  // ----- golden glizzy: spawn scheduler -----
  const GS = G.goldenSpawn || { minIntervalSec: 240, maxIntervalSec: 720, visibleSec: 30 };
  const goldenEl = document.getElementById('golden-glizzy');
  let goldenVisible = false;
  let goldenHideTimer = null;

  function placeGolden() {
    // Keep clear of the sticky top bar and screen edges.
    const w = goldenEl.offsetWidth || 150;
    const h = goldenEl.offsetHeight || 112;
    const maxLeft = Math.max(20, window.innerWidth - w - 20);
    const minTop = 110;
    const maxTop = Math.max(minTop + 1, window.innerHeight - h - 30);
    goldenEl.style.left = (20 + Math.random() * (maxLeft - 20)) + 'px';
    goldenEl.style.top = (minTop + Math.random() * (maxTop - minTop)) + 'px';
  }
  function hideGolden(reschedule) {
    goldenVisible = false;
    goldenEl.classList.remove('show');
    clearTimeout(goldenHideTimer);
    if (reschedule) scheduleGolden();
  }
  function spawnGolden() {
    if (goldenVisible || document.hidden) { scheduleGolden(); return; }
    goldenVisible = true;
    placeGolden();
    goldenEl.classList.add('show');
    goldenHideTimer = setTimeout(() => hideGolden(true), (GS.visibleSec || 30) * 1000);
  }
  function scheduleGolden() {
    const span = (GS.maxIntervalSec - GS.minIntervalSec) || 0;
    const delay = (GS.minIntervalSec + Math.random() * span) * 1000;
    setTimeout(spawnGolden, delay);
  }
  if (goldenEl) {
    goldenEl.addEventListener('click', () => {
      if (!goldenVisible) return;
      hideGolden(true);
      claimGolden();
    });
    scheduleGolden();
    window.__spawnGolden = spawnGolden;  // manual trigger for testing from the console
  }

  // Initial render
  recomputeRates();
  rerender();
  renderBuffs();
  initCollapsibles();
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
              <div class="text-xs text-slate-400">${esc(r.total_buildings)} buildings · ${esc(r.total_clicks.toLocaleString())} clicks · <span class="accent font-semibold" data-prod="${esc(r.user_id)}">${esc(fmtRate(r.per_second))}</span></div>
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
<script>
(function () {
  const SCALES = ['', 'K', 'M', 'B', 'T', 'Qa', 'Qi', 'Sx', 'Sp', 'Oc', 'No', 'Dc'];
  function fmt(n) {
    if (!Number.isFinite(n)) return String(n);
    n = Math.floor(n);
    if (n < 1000) return n.toLocaleString();
    const t = Math.floor(Math.log10(n) / 3);
    if (t >= SCALES.length) return n.toExponential(2);
    return (n / Math.pow(1000, t)).toFixed(2) + SCALES[t];
  }
  function fmtRate(n) {
    if (!Number.isFinite(n) || n <= 0) return '0/s';
    if (n < 1) return n.toFixed(2) + '/s';
    if (n < 1000) return n.toFixed(1) + '/s';
    return fmt(n) + '/s';
  }
  async function poll() {
    try {
      const res = await fetch('/api/game/leaderboard');
      if (!res.ok) return;
      const rows = await res.json();
      for (const r of rows) {
        const el = document.querySelector('[data-prod="' + r.user_id + '"]');
        if (el) el.textContent = fmtRate(r.per_second || 0);
      }
    } catch (e) {}
  }
  setInterval(poll, 10000);
})();
</script>
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

  app.post("/api/game/golden", requireGameSession, (req, res) => {
    res.json(claimGoldenGlizzy(req.gameUserId));
  });

  app.get("/api/game/leaderboard", (req, res) => {
    res.json(getLeaderboardRows(50));
  });
}

// Re-exports for /glizzy slash command
export { getLeaderboardRows, getPlayerSummary };
