import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
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
  goldenSpawnFor,
} from "./glizzy.js";
import { getUserProfileStmt } from "./database.js";
import { renderNav } from "./nav.js";

const NAV = renderNav("game");

// ============================================================================
// PixelLab art (assets/clicker) — loaded from the importer's manifest at boot.
// Every surface falls back on its own: hero/golden to the hand-drawn SVGs,
// a building to its BUILDING_SVGS entry, an emoji to the raw character. So a
// missing PNG (or the whole directory) degrades one surface, never the page.
// Regeneration recipe: docs/clicker-art.md; import: scripts/clicker-import-art.mjs.
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLICKER_ART_DIR = path.join(HERE, "assets", "clicker");

function loadClickerArt() {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(CLICKER_ART_DIR, "manifest.json"), "utf8"));
    const present = (f) => (f && fs.existsSync(path.join(CLICKER_ART_DIR, f)) ? f : null);
    return {
      hero: present(m.hero),
      golden: present(m.golden),
      buildings: Object.fromEntries(Object.entries(m.buildings || {}).filter(([, f]) => present(f))),
      emoji: Object.fromEntries(Object.entries(m.emoji || {}).filter(([, f]) => present(f))),
    };
  } catch {
    return { hero: null, golden: null, buildings: {}, emoji: {} };
  }
}
const ART = loadClickerArt();
const artUrl = (f) => `/game/art/${f}`;

/**
 * An emoji as its pixel icon when we have one, the raw character otherwise.
 * Sizes must keep the 32px art on an integer pixel grid: use 32 (1:1) or
 * 16 (2:1) — anything else shears the pixels unevenly.
 */
function emojiIcon(emoji, sizePx = 32) {
  const f = ART.emoji[emoji];
  if (!f) return esc(emoji);
  return `<img src="${artUrl(f)}" alt="${esc(emoji)}" class="px-art e-icon" style="width:${sizePx}px;height:${sizePx}px">`;
}

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const RATE_SCALES = ["", "K", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc"];

/**
 * Compact number for leaderboards. Top players sit on 19-digit lifetime totals;
 * printing those in full blows out every layout it touches (and on mobile it
 * pushed the whole page sideways). Mirrors the client-side `fmt` in the game.
 */
export function fmtCompact(n) {
  if (!Number.isFinite(n)) return "0";
  n = Math.floor(n);
  if (n < 1000) return n.toLocaleString();
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= RATE_SCALES.length) return n.toExponential(2);
  return (n / Math.pow(1000, tier)).toFixed(2) + RATE_SCALES[tier];
}

export function fmtRate(n) {
  if (!Number.isFinite(n) || n <= 0) return "0/s";
  if (n < 1) return n.toFixed(2) + "/s";
  if (n < 1000) return n.toFixed(1) + "/s";
  const tier = Math.floor(Math.log10(n) / 3);
  if (tier >= RATE_SCALES.length) return n.toExponential(2) + "/s";
  return (n / Math.pow(1000, tier)).toFixed(2) + RATE_SCALES[tier] + "/s";
}

const FAVICON = ART.emoji["🌭"]
  ? `<link rel="icon" type="image/png" href="${artUrl(ART.emoji["🌭"])}">`
  : `<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">`;

const HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
${FAVICON}
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
  /* clip, not hidden: kills stray horizontal overflow without turning <html>
     into a scroll container, which would break the sticky header. */
  html { overflow-x: clip; }
  body { background:#020617; color:#e2e8f0; max-width:100vw; }
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; }
  .accent { color:#ff6b35; }
  .hero-svg { width: 360px; max-width: 90vw; height: auto; display: block; }
  /* Pixel art draws at integer multiples of its native size (hero 120x90 x3,
     icons 32 x1 or /2) — pixelated keeps the grid crisp instead of smearing. */
  .px-art { image-rendering: pixelated; -webkit-user-drag: none; user-select: none; }
  .hero-img { width: 360px; max-width: 90vw; height: auto; display: block; }
  img.e-icon { display: inline-block; vertical-align: -0.25em; }
  .click-target {
    cursor: pointer;
    transition: transform 0.05s ease-out;
    user-select: none;
    -webkit-user-select: none;
    filter: drop-shadow(0 10px 30px rgba(255,107,53,0.25));
  }
  .click-target:hover { filter: drop-shadow(0 10px 40px rgba(255,107,53,0.45)); }
  .click-target.bounce { animation: glizzybounce 0.32s ease-out; }
  @keyframes glizzybounce {
    0%   { transform: scale(1); }
    25%  { transform: scale(0.88); }
    55%  { transform: scale(1.06); }
    80%  { transform: scale(0.98); }
    100% { transform: scale(1); }
  }
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
  .qty-btn {
    font-size: 11px; font-weight: 700; line-height: 1;
    padding: 5px 8px; border-radius: 6px; cursor: pointer;
    background: #111a30; color: #94a3b8;
    border: 1px solid rgba(148,163,184,0.14);
    transition: background .12s, color .12s, border-color .12s;
  }
  .qty-btn:hover { color: #e2e8f0; }
  .qty-btn.active { background: rgba(255,107,53,0.18); color: #ffa07a; border-color: rgba(255,107,53,0.55); }
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
  /* Queued / eclipsed buffs: real, but not the one applied right now. */
  .buff-chip.idle { opacity: 0.55; filter: saturate(0.6); }
  /* Oracle (cheat code) — the recommended next purchase. Violet so it reads
     against both the orange "affordable" border and the emerald "owned" one. */
  .oracle-best { position: relative; border-color: rgba(192,132,252,0.75) !important; box-shadow: 0 0 0 1px rgba(192,132,252,0.35), 0 0 18px rgba(168,85,247,0.25); }
  .oracle-best::after {
    content: '🔮 BEST'; position: absolute; top: -7px; right: 8px;
    font-size: 9px; font-weight: 800; letter-spacing: .08em;
    padding: 1px 6px; border-radius: 999px;
    background: linear-gradient(135deg, #a855f7, #7c3aed); color: #fff;
    box-shadow: 0 2px 8px rgba(0,0,0,0.5);
  }
  .oracle-row {
    width: 100%; text-align: left; display: flex; gap: 10px; align-items: flex-start;
    background:#120b20; border:1px solid rgba(192,132,252,0.22); border-radius:10px;
    padding: 8px 10px; cursor: pointer; transition: background .15s, border-color .15s;
  }
  .oracle-row:hover { background:#1a1030; border-color: rgba(192,132,252,0.5); }
  .oracle-row .o-rank { font-size: 11px; font-weight: 800; color:#c084fc; width: 12px; flex-shrink: 0; line-height: 1.5; }
  .oracle-row .o-name { color:#f1f5f9; font-weight: 600; font-size: 13px; }
  .oracle-row .o-meta { color:#94a3b8; font-size: 11px; margin-top: 2px; }
  .oracle-row .o-pay { color:#d8b4fe; font-weight: 700; }
  .oracle-row.o-ready .o-when { color:#86efac; }
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
  ${ART.hero
    ? `<img src="${artUrl(ART.hero)}" alt="" class="px-art mx-auto mb-4" style="width:240px;max-width:80vw;height:auto">`
    : `<div class="text-8xl mb-4">🌭</div>`}
  <h1 class="text-5xl md:text-6xl font-bold text-white tracking-tight mb-3">GlizzyClicker</h1>
  <p class="text-xl text-slate-300 mb-2">An idle game powered by your real hot dog stats.</p>
  <p class="text-slate-400 mb-10">Eat dogs in the channel, get bonuses in the game. Streaks scale uncapped.</p>
  <a href="/oauth/login?next=%2Fgame" class="inline-block px-8 py-4 bg-accent hover:bg-accent-deep text-white font-bold text-lg rounded-xl transition">
    Log in with Discord →
  </a>
  <div class="mt-10 grid sm:grid-cols-3 gap-4 text-left">
    <div class="card p-4"><div class="mb-1">${emojiIcon("🍽️")}</div><div class="font-bold text-white">Big Eater</div><div class="text-sm text-slate-400">Eat &gt;4 dogs yesterday → +0.25× click power for 24h.</div></div>
    <div class="card p-4"><div class="mb-1">${emojiIcon("🌅")}</div><div class="font-bold text-white">Breakfast Boon</div><div class="text-sm text-slate-400">A dog before 8 AM → Mustard Stand +50%.</div></div>
    <div class="card p-4"><div class="mb-1">${emojiIcon("🔥")}</div><div class="font-bold text-white">Streak (uncapped)</div><div class="text-sm text-slate-400">Each consecutive day adds +2% production. Day 100 = +200%.</div></div>
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
    state, bonuses, rates, offlineEarned, userId, displayName,
    buildings: BUILDINGS, upgrades: UPGRADES,
    buildingSvgs: BUILDING_SVGS,
    goldenSpawn: goldenSpawnFor(state),
    art: {
      buildings: Object.fromEntries(Object.entries(ART.buildings).map(([id, f]) => [id, artUrl(f)])),
      emoji: Object.fromEntries(Object.entries(ART.emoji).map(([e, f]) => [e, artUrl(f)])),
    },
  }).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker</title>${STYLES}
<script>window.GAME = ${initial};</script>
</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-7xl mx-auto px-4 md:px-6 py-6">
  <div class="sticky top-14 z-40 -mx-4 md:-mx-6 px-4 md:px-6 py-2.5 mb-4 bg-slate-950 border-b border-slate-800/60 flex items-center justify-between">
    <div class="flex items-baseline gap-3 flex-wrap">
      <div class="text-4xl font-bold text-white tabular-nums" id="glizzies-display">0</div>
      <div class="text-slate-400 text-sm">glizzies · <span id="pps-display" class="text-accent">0/s</span></div>
      <div class="text-slate-400 text-sm"><span id="lifetime-top-display" class="text-slate-200 tabular-nums">0</span> lifetime</div>
      <div id="buffs-bar" class="flex items-center gap-1.5"></div>
    </div>
    <div class="flex items-center gap-3">
      <button type="button" id="oracle-toggle" class="hidden text-xs px-2.5 py-1 rounded-lg border border-purple-500/60 text-purple-300 hover:text-white hover:border-purple-400 transition" title="The Oracle — optimal next purchase (O)">${emojiIcon("🔮", 16)} <span class="hidden sm:inline">Oracle</span></button>
      <button type="button" id="lb-open" class="text-xs px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-accent transition" title="Peek at the leaderboard (L)">${emojiIcon("🏆", 16)} <span class="hidden sm:inline">Leaderboard</span></button>
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
                  <span class="text-lg">${emojiIcon(def.emoji)}</span> ${esc(displayName)}
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
      <div id="click-area" class="click-target relative">${ART.hero
        ? `<img src="${artUrl(ART.hero)}" alt="" class="hero-img px-art" draggable="false">`
        : HERO_SVG}</div>
      <div class="mt-6 text-slate-400 text-sm">Click the glizzy!</div>
    </section>

    <!-- RIGHT: upgrades + buildings (sticky, internal scroll) -->
    <section class="md:col-span-1 md:sticky md:top-28 md:max-h-[calc(100vh-8rem)] md:overflow-y-auto md:pr-2 game-scrollcol">
      <div class="card p-4 mb-4 hidden" id="oracle-card" style="border-color:rgba(192,132,252,0.35)">
        <div class="flex items-center justify-between gap-2 mb-2">
          <span class="text-xs uppercase tracking-widest text-purple-300">${emojiIcon("🔮", 16)} The Oracle</span>
          <span class="text-[10px] text-slate-500">fastest payback</span>
        </div>
        <div id="oracle-list" class="space-y-2"></div>
        <div class="text-[10px] text-slate-500 mt-2 leading-snug">
          Ranked by cost ÷ production gained. Ignores click power and golden glizzies — those depend on how you play.
        </div>
      </div>
      <div class="card p-4 mb-4">
        <div class="flex items-center justify-between gap-2 mb-3">
          <button type="button" class="collapse-toggle flex items-center gap-2 min-w-0" data-collapse="buildings">
            <span class="chev">▾</span>
            <span class="text-xs uppercase tracking-widest text-slate-400">Buildings</span>
          </button>
          <div id="buy-qty" class="flex items-center gap-1 flex-shrink-0">
            <button type="button" class="qty-btn" data-qty="1">×1</button>
            <button type="button" class="qty-btn" data-qty="10">×10</button>
            <button type="button" class="qty-btn" data-qty="100">×100</button>
          </div>
        </div>
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

<div id="golden-glizzy" title="A golden glizzy! Click it!"${ART.golden ? ' style="width:240px"' : ""}>${ART.golden
  ? `<img src="${artUrl(ART.golden)}" alt="" class="px-art" style="width:100%;height:auto" draggable="false">`
  : GOLDEN_SVG}</div>
<div id="golden-toast"></div>

<div id="offline-modal" class="fixed inset-0 bg-black/70 flex items-center justify-center z-50 hidden">
  <div class="card p-8 max-w-md text-center mx-4">
    <div class="mb-3">${emojiIcon("🌭", 64)}</div>
    <div class="text-xl text-white font-bold mb-2">Welcome back!</div>
    <div class="text-slate-300 mb-4">While you were away, you earned</div>
    <div class="text-4xl font-bold accent mb-6" id="offline-amount">0</div>
    <button id="offline-close" class="px-6 py-2 bg-accent hover:bg-accent-deep text-white rounded-lg font-semibold">Sweet</button>
  </div>
</div>

<div id="lb-modal" class="fixed inset-0 bg-black/70 z-50 hidden items-start justify-center p-4 sm:p-8 overflow-y-auto">
  <div class="card w-full max-w-2xl mt-8 sm:mt-12" id="lb-panel">
    <div class="flex items-center justify-between gap-3 px-4 py-3 border-b border-slate-800">
      <div>
        <div class="text-xs uppercase tracking-widest text-slate-400">Leaderboard</div>
        <div class="text-lg font-bold text-white">Top by lifetime glizzies</div>
      </div>
      <button type="button" id="lb-close" class="text-slate-400 hover:text-white text-xl leading-none px-2" title="Close (Esc)">×</button>
    </div>
    <div id="lb-body" class="max-h-[65vh] overflow-y-auto game-scrollcol p-2">
      <div class="text-center text-slate-400 py-8 text-sm">Loading…</div>
    </div>
    <div class="px-4 py-2.5 border-t border-slate-800 text-center">
      <a href="/game/leaderboard" class="text-xs text-accent hover:text-accent-soft">Open full leaderboard →</a>
    </div>
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
  const ART = G.art || { buildings: {}, emoji: {} };
  const COST_SCALE = 1.15;

  // Pixel icon for an emoji when one shipped, the raw character otherwise.
  // 32 (1:1) and 16 (2:1) keep the art on an integer pixel grid.
  function eIcon(e, px) {
    const u = ART.emoji[e];
    if (!u) return e;
    return '<img src="' + u + '" alt="" class="px-art e-icon" style="width:' + (px || 32) + 'px;height:' + (px || 32) + 'px">';
  }
  function bIcon(id) {
    const u = ART.buildings[id];
    if (!u) return BUILDING_SVGS[id];
    return '<img src="' + u + '" alt="" class="px-art" style="width:40px;height:40px">';
  }
  const UPGRADE_MAP = new Map(UPGRADES.map(u => [u.id, u]));

  let dirty = false;
  let savePromise = null;
  let showAllUpgrades = false;
  let showOwnedUpgrades = false;

  // How many of a building a click buys. Persisted so it survives a reload.
  let buyQty = 1;
  try { buyQty = [1, 10, 100].includes(+localStorage.getItem('glizzy_buyqty')) ? +localStorage.getItem('glizzy_buyqty') : 1; } catch (e) {}

  // Tearing down and rebuilding a list mid-tap eats the tap: if the element
  // under the finger is removed between pointerdown and pointerup, no click
  // event ever fires. The periodic refresh therefore holds off while a pointer
  // is down, and the lists patch in place rather than being re-innerHTML'd.
  let pointerHeld = false;
  document.addEventListener('pointerdown', () => { pointerHeld = true; }, true);
  document.addEventListener('pointerup', () => { pointerHeld = false; }, true);
  document.addEventListener('pointercancel', () => { pointerHeld = false; }, true);

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

  // Same-group golden buffs eclipse each other (strongest running wins);
  // different groups stack. Mirrors buffGroup in glizzy.js.
  function buffGroupKey(g) {
    if (g.kind === 'building_mult') return 'building:' + g.building;
    if (g.kind === 'click_mult') return 'click';
    return 'prod';
  }

  // ----- effective rates (client-side replica of glizzy.js logic) -----
  // Pure in \`st\` ({buildings, upgrades_owned, golden_effects}) so the Oracle can
  // price a hypothetical purchase by running this over a cloned state.
  function computeRatesFor(st) {
    let clickPower = 1, clickAdd = 0, globalMult = 1;
    const buildingMult = {};
    for (const b of BUILDINGS) buildingMult[b.id] = 1;

    for (const upId of st.upgrades_owned) {
      const up = UPGRADE_MAP.get(upId); if (!up) continue;
      const e = up.effect;
      if (e.type === 'click_mult') clickPower *= e.value;
      else if (e.type === 'building_mult') buildingMult[e.building] *= e.value;
      else if (e.type === 'global_mult') globalMult *= e.value;
      else if (e.type === 'click_per_building') {
        let total = 0; for (const b of BUILDINGS) total += st.buildings[b.id] || 0;
        clickAdd += total * e.value;
      }
      else if (e.type === 'global_per_building') {
        let total = 0; for (const b of BUILDINGS) total += st.buildings[b.id] || 0;
        globalMult *= 1 + total * e.value;
      }
      else if (e.type === 'building_synergy') {
        if (buildingMult[e.building] !== undefined) {
          buildingMult[e.building] *= 1 + (st.buildings[e.per] || 0) * e.value;
        }
      }
    }
    for (const b of bonuses) {
      const e = b.effect;
      if (e.type === 'click_mult') clickPower *= e.value;
      else if (e.type === 'building_mult') buildingMult[e.building] *= e.value;
      else if (e.type === 'global_mult') globalMult *= e.value;
    }
    // Active golden-glizzy buffs (mirrors glizzy.js): per group only the
    // strongest *running* buff applies — same-group buffs eclipse, never
    // compound — and queued buffs (starts_at in the future) don't count yet.
    const gNow = Date.now();
    const gBest = {};
    for (const g of (st.golden_effects || [])) {
      if (!g || new Date(g.expires_at).getTime() <= gNow) continue;
      if (g.starts_at && new Date(g.starts_at).getTime() > gNow) continue;
      const grp = buffGroupKey(g);
      if (!gBest[grp] || g.mult > gBest[grp].mult) gBest[grp] = g;
    }
    for (const grp in gBest) {
      const g = gBest[grp];
      if (g.kind === 'prod_mult') globalMult *= g.mult;
      else if (g.kind === 'click_mult') clickPower *= g.mult;
      else if (g.kind === 'building_mult' && buildingMult[g.building] !== undefined) buildingMult[g.building] *= g.mult;
    }
    const perClick = (clickPower + clickAdd) * globalMult;
    let perSecond = 0;
    const bp = {};
    const perUnit = {};
    for (const b of BUILDINGS) {
      const owned = st.buildings[b.id] || 0;
      const oneRate = b.base_rate * buildingMult[b.id] * globalMult;
      perUnit[b.id] = oneRate;
      const r = owned * oneRate;
      bp[b.id] = r;
      perSecond += r;
    }
    return { perClick, perSecond, buildingProduction: bp, perUnitRate: perUnit };
  }

  function recomputeRates() {
    rates = computeRatesFor(state);
  }

  // Cost of buying \`n\` more of a building, as a closed-form geometric series:
  //   sum_{i=owned}^{owned+n-1} base * COST_SCALE^i
  // Must stay in step with the same formula in glizzy.js's save validator.
  function buildingCost(id, n) {
    const b = BUILDINGS.find(x => x.id === id);
    if (!b) return Infinity;
    const owned = state.buildings[id] || 0;
    const qty = n || 1;
    if (qty === 1) return Math.ceil(b.base_cost * Math.pow(COST_SCALE, owned));
    const series = (Math.pow(COST_SCALE, owned + qty) - Math.pow(COST_SCALE, owned)) / (COST_SCALE - 1);
    return Math.ceil(b.base_cost * series);
  }

  // ----- the Oracle (cheat code): optimal next purchase -----
  //
  // Every candidate is priced the same way: clone the state, apply the purchase,
  // re-run computeRatesFor, and take the delta in /s. That means it stays correct
  // for effects whose value depends on the rest of the state (synergies,
  // global_per_building) without the ranker knowing anything about effect types.
  //
  // Deliberately blind to click power and golden glizzies — both are worth
  // whatever your play style makes them worth, so they'd be noise in a ranking
  // that's supposed to be about idle production. Golden buffs are also stripped
  // from the simulated state so a Frenzy doesn't churn the recommendation.
  const ORACLE_SKIP_EFFECTS = new Set([
    'click_mult', 'click_per_building',
    'golden_frequency', 'golden_duration', 'golden_payout',
  ]);
  let oracleOn = false;
  let oracleUnlocked = false;
  let oracleTop = [];
  try { oracleUnlocked = localStorage.getItem('glizzy_oracle') === '1'; } catch (e) {}

  function fmtDur(s) {
    if (!Number.isFinite(s) || s < 0) return '—';
    if (s < 60) return Math.max(1, Math.round(s)) + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm ' + Math.round(s % 60) + 's';
    if (s < 86400) return Math.floor(s / 3600) + 'h ' + Math.round((s % 3600) / 60) + 'm';
    if (s < 86400 * 365) return Math.floor(s / 86400) + 'd ' + Math.round((s % 86400) / 3600) + 'h';
    return '>1y';
  }

  function oracleRank() {
    const base = {
      buildings: state.buildings,
      upgrades_owned: state.upgrades_owned,
      golden_effects: [],
    };
    const basePps = computeRatesFor(base).perSecond;
    const out = [];
    const qty = buyQty;

    for (const b of BUILDINGS) {
      const cost = buildingCost(b.id, qty);
      const sim = {
        buildings: Object.assign({}, base.buildings),
        upgrades_owned: base.upgrades_owned,
        golden_effects: [],
      };
      sim.buildings[b.id] = (sim.buildings[b.id] || 0) + qty;
      const delta = computeRatesFor(sim).perSecond - basePps;
      if (delta > 0 && Number.isFinite(cost)) {
        out.push({ kind: 'building', id: b.id, name: b.name + (qty > 1 ? ' ×' + qty : ''), emoji: b.emoji, cost, delta, payback: cost / delta });
      }
    }

    const owned = new Set(state.upgrades_owned);
    for (const u of UPGRADES) {
      if (owned.has(u.id) || ORACLE_SKIP_EFFECTS.has(u.effect.type)) continue;
      const sim = {
        buildings: base.buildings,
        upgrades_owned: base.upgrades_owned.concat([u.id]),
        golden_effects: [],
      };
      const delta = computeRatesFor(sim).perSecond - basePps;
      if (delta > 0) {
        out.push({ kind: 'upgrade', id: u.id, name: u.name, emoji: u.emoji, cost: u.cost, delta, payback: u.cost / delta });
      }
    }

    out.sort((a, b) => a.payback - b.payback);
    return out;
  }

  // Rebuilt only when the ranking (or a price in it) actually changes — the
  // rows are tap targets, and swapping them out from under a finger eats the
  // tap. The countdown line is patched in place every pass instead.
  let oracleSig = null;
  function renderOracle() {
    const card = document.getElementById('oracle-card');
    if (!card) return;
    card.classList.toggle('hidden', !oracleOn);
    if (!oracleOn) { oracleTop = []; oracleSig = null; return; }

    oracleTop = oracleRank().slice(0, 3);
    const list = document.getElementById('oracle-list');
    if (!oracleTop.length) {
      if (oracleSig !== 'empty') {
        oracleSig = 'empty';
        list.innerHTML = '<div class="text-xs text-slate-400 py-2">Nothing left to buy that adds production.</div>';
      }
      return;
    }

    const sig = oracleTop.map(c => c.kind + ':' + c.id + ':' + c.cost).join('|');
    if (sig !== oracleSig) {
      oracleSig = sig;
      list.innerHTML = oracleTop.map((c, i) =>
        '<button type="button" class="oracle-row" data-oracle="' + c.kind + ':' + c.id + '">' +
          '<span class="o-rank">' + (i + 1) + '</span>' +
          '<span class="flex-1 min-w-0">' +
            '<span class="o-name">' + eIcon(c.emoji, 16) + ' ' + c.name + '</span>' +
            '<div class="o-meta">' + fmt(c.cost) + ' · +' + fmtRate(c.delta) + ' · <span class="o-pay">' + fmtDur(c.payback) + ' payback</span></div>' +
            '<div class="o-meta o-when"></div>' +
          '</span>' +
        '</button>').join('');
    }

    const rows = list.querySelectorAll('[data-oracle]');
    oracleTop.forEach((c, i) => {
      const row = rows[i]; if (!row) return;
      const short = Math.max(0, c.cost - state.glizzies);
      const ready = short <= 0;
      row.classList.toggle('o-ready', ready);
      row.querySelector('.o-when').textContent = ready
        ? 'affordable now'
        : (rates.perSecond > 0 ? 'ready in ' + fmtDur(short / rates.perSecond) : 'keep clicking');
    });
  }

  // Which card in the buildings/upgrades lists wears the 🔮 BEST ring.
  function oracleBestKey() {
    if (!oracleOn || !oracleTop.length) return null;
    return oracleTop[0].kind + ':' + oracleTop[0].id;
  }

  document.getElementById('oracle-list').addEventListener('click', ev => {
    const row = ev.target.closest('[data-oracle]');
    if (!row) return;
    const [kind, id] = row.dataset.oracle.split(':');
    if (kind === 'building') buyBuilding(id); else buyUpgrade(id);
  });

  function setOracle(on) {
    oracleOn = on;
    try { localStorage.setItem('glizzy_oracle_on', on ? '1' : '0'); } catch (e) {}
    // Inline, not a Tailwind class — the CDN build only ships classes it has
    // seen in the markup, and this one never appears there.
    document.getElementById('oracle-toggle').style.background = on ? 'rgba(168,85,247,0.22)' : '';
    renderOracle();
    renderBuildings();
    renderUpgrades(true);
  }

  function unlockOracle(announce) {
    oracleUnlocked = true;
    try { localStorage.setItem('glizzy_oracle', '1'); } catch (e) {}
    document.getElementById('oracle-toggle').classList.remove('hidden');
    if (announce) {
      showGoldenToast({ emoji: '🔮', name: 'THE ORACLE AWAKENS', message: 'It knows what you should buy next. Press O to consult it.' });
      setOracle(true);
    }
  }

  document.getElementById('oracle-toggle').addEventListener('click', () => setOracle(!oracleOn));

  // ↑ ↑ ↓ ↓ ← → ← → B A
  const KONAMI = ['ArrowUp','ArrowUp','ArrowDown','ArrowDown','ArrowLeft','ArrowRight','ArrowLeft','ArrowRight','b','a'];
  let konamiAt = 0;
  document.addEventListener('keydown', ev => {
    if (!ev.key) return;
    const tag = (document.activeElement && document.activeElement.tagName) || '';
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if (oracleUnlocked && (ev.key === 'o' || ev.key === 'O') && !ev.metaKey && !ev.ctrlKey && !ev.altKey) {
      setOracle(!oracleOn);
      return;
    }
    const k = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (k === KONAMI[konamiAt]) {
      konamiAt++;
      if (konamiAt === KONAMI.length) { konamiAt = 0; unlockOracle(true); }
    } else {
      // A mismatch can still be the start of a fresh attempt (↑↑↑↓↓…).
      konamiAt = k === KONAMI[0] ? 1 : 0;
    }
  });

  // ----- rendering -----
  function renderHud() {
    document.getElementById('glizzies-display').textContent = fmt(state.glizzies);
    document.getElementById('pps-display').textContent = fmtRate(rates.perSecond);
    document.getElementById('lifetime-display').textContent = fmt(state.lifetime);
    // Same number as the Stats card, mirrored into the sticky bar so it's
    // visible without scrolling the (tall) bonuses column.
    const lifetimeTop = document.getElementById('lifetime-top-display');
    lifetimeTop.textContent = fmt(state.lifetime);
    lifetimeTop.title = Math.floor(state.lifetime).toLocaleString() + ' lifetime glizzies';
    document.getElementById('clicks-display').textContent = fmt(state.total_clicks);
    const totalBuildings = BUILDINGS.reduce((s, b) => s + (state.buildings[b.id] || 0), 0);
    document.getElementById('buildings-total-display').textContent = fmt(totalBuildings);
    document.getElementById('click-power-display').textContent = fmt(rates.perClick);
  }

  // The building list is built once and then patched in place — see the
  // \`pointerHeld\` note above for why we never re-innerHTML it.
  let buildingEls = null;
  function buildBuildingList() {
    const root = document.getElementById('buildings-list');
    root.innerHTML = BUILDINGS.map(b => \`
        <div class="building-card card p-2.5" data-buy="\${b.id}">
          <div class="flex items-center gap-2.5">
            <div style="width:40px;height:40px;flex-shrink:0">\${bIcon(b.id)}</div>
            <div class="flex-1 min-w-0">
              <div class="flex items-center justify-between gap-2">
                <div class="font-semibold text-white truncate text-sm">\${b.name}</div>
                <div class="text-xs text-slate-500 tabular-nums" data-f="owned">×0</div>
              </div>
              <div class="text-[11px] mt-0.5">
                <span class="accent font-semibold" data-f="perunit"></span>
                <span class="text-slate-500"> each · </span>
                <span class="text-slate-200 font-semibold" data-f="cost"></span>
                <span class="text-slate-500" data-f="total"></span>
              </div>
              <div class="text-[11px] text-slate-500 mt-1 leading-snug" data-f="desc">\${b.description || ''}</div>
            </div>
          </div>
        </div>\`).join('');
    buildingEls = {};
    for (const b of BUILDINGS) {
      const card = root.querySelector('[data-buy="' + b.id + '"]');
      buildingEls[b.id] = {
        card,
        owned: card.querySelector('[data-f="owned"]'),
        perunit: card.querySelector('[data-f="perunit"]'),
        cost: card.querySelector('[data-f="cost"]'),
        total: card.querySelector('[data-f="total"]'),
        desc: card.querySelector('[data-f="desc"]'),
      };
    }
    // Delegated — survives any future re-render of the children.
    root.addEventListener('click', ev => {
      const card = ev.target.closest('[data-buy]');
      if (card) buyBuilding(card.dataset.buy);
    });
  }

  function renderBuildings() {
    if (!buildingEls) buildBuildingList();
    const bestKey = oracleBestKey();
    for (const b of BUILDINGS) {
      const el = buildingEls[b.id];
      const owned = state.buildings[b.id] || 0;
      const cost = buildingCost(b.id, buyQty);
      const affordable = state.glizzies >= cost;
      el.card.classList.toggle('affordable', affordable);
      el.card.classList.toggle('locked', !affordable);
      el.card.classList.toggle('oracle-best', bestKey === 'building:' + b.id);
      el.owned.textContent = '×' + owned;

      const perUnit = (rates.perUnitRate && rates.perUnitRate[b.id]) || 0;
      el.perunit.textContent = '+' + (perUnit < 0.1 ? perUnit.toFixed(2) : perUnit < 10 ? perUnit.toFixed(1) : fmt(perUnit)) + '/s';
      el.cost.textContent = fmt(cost) + (buyQty > 1 ? ' for ×' + buyQty : '');

      const production = rates.buildingProduction[b.id] || 0;
      el.total.textContent = owned > 0
        ? ' · ' + (production < 0.1 ? production.toFixed(2) : production < 10 ? production.toFixed(1) : fmt(production)) + '/s total'
        : '';
      el.desc.style.display = (b.description && owned === 0) ? '' : 'none';
    }
  }

  function renderBuyQty() {
    document.querySelectorAll('#buy-qty .qty-btn').forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.qty === buyQty);
    });
  }

  function upgradeCardHtml(u, isOwned) {
    let cls = 'upgrade-card';
    let costLabel = '';
    if (isOwned) { cls += ' owned'; costLabel = '✓ Owned'; }
    else if (state.glizzies >= u.cost) { cls += ' affordable'; costLabel = 'Cost: ' + fmt(u.cost); }
    else { cls += ' locked'; costLabel = 'Cost: ' + fmt(u.cost); }
    if (!isOwned && oracleBestKey() === 'upgrade:' + u.id) cls += ' oracle-best';
    const desc = u.description || '';
    return \`<button class="\${cls}" data-upgrade="\${u.id}">
        <div class="flex items-start gap-2">
          <span class="u-emoji">\${eIcon(u.emoji)}</span>
          <div class="flex-1 min-w-0">
            <div class="u-name">\${u.name}</div>
            <div class="u-desc">\${desc}</div>
            <div class="u-cost">\${costLabel}</div>
          </div>
        </div>
      </button>\`;
  }

  // Same tap-eating hazard as the buildings list, but here the *membership*
  // genuinely changes as you get richer. So: only rewrite the DOM when the
  // visible set actually changes (and never mid-tap); otherwise patch the
  // affordability classes and cost labels in place.
  let upgradeSig = null;
  let upgradesDelegated = false;
  function renderUpgrades(force) {
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

    // Which cards are on screen, in order. Unchanged signature => patch only.
    const sig = [
      reach.map(u => u.id).join(','),
      showAllUpgrades ? far.map(u => u.id).join(',') : 'far:' + far.length,
      showOwnedUpgrades ? ownedUps.map(u => u.id).join(',') : 'own:' + ownedUps.length,
    ].join('|');

    if (!force && sig === upgradeSig) {
      const bestKey = oracleBestKey();
      root.querySelectorAll('[data-upgrade]').forEach(el => {
        const u = UPGRADE_MAP.get(el.dataset.upgrade); if (!u) return;
        const isOwned = owned.has(u.id);
        el.classList.toggle('owned', isOwned);
        el.classList.toggle('affordable', !isOwned && state.glizzies >= u.cost);
        el.classList.toggle('locked', !isOwned && state.glizzies < u.cost);
        el.classList.toggle('oracle-best', !isOwned && bestKey === 'upgrade:' + u.id);
        const c = el.querySelector('.u-cost');
        if (c) c.textContent = isOwned ? '✓ Owned' : 'Cost: ' + fmt(u.cost);
      });
      return;
    }
    // Never swap the DOM out from under a finger that's mid-tap (unless this
    // render *is* the response to a tap, in which case the tap already landed).
    if (pointerHeld && !force && upgradeSig !== null) return;

    upgradeSig = sig;
    root.innerHTML = html;
    if (!upgradesDelegated) {
      upgradesDelegated = true;
      root.addEventListener('click', ev => {
        const card = ev.target.closest('[data-upgrade]');
        if (card) { buyUpgrade(card.dataset.upgrade); return; }
        if (ev.target.closest('#upg-showall')) { showAllUpgrades = !showAllUpgrades; renderUpgrades(true); return; }
        if (ev.target.closest('#upg-owned-toggle')) { showOwnedUpgrades = !showOwnedUpgrades; renderUpgrades(true); }
      });
    }
  }

  function rerender() {
    renderHud();
    renderOracle();
    renderBuildings();
    renderUpgrades();
  }

  // ----- actions -----
  function buyBuilding(id) {
    // All-or-nothing: the card shows the price of \`buyQty\`, so that's what a
    // tap costs. Partial buys would make the displayed price a lie.
    const qty = buyQty;
    const cost = buildingCost(id, qty);
    if (state.glizzies < cost) return;
    state.glizzies -= cost;
    state.buildings[id] = (state.buildings[id] || 0) + qty;
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

  document.getElementById('buy-qty').addEventListener('click', ev => {
    const btn = ev.target.closest('.qty-btn');
    if (!btn) return;
    buyQty = +btn.dataset.qty || 1;
    try { localStorage.setItem('glizzy_buyqty', String(buyQty)); } catch (e) {}
    renderBuyQty();
    renderOracle();   // qty changes the price, and therefore the ranking
    renderBuildings();
  });

  const clickArea = document.getElementById('click-area');
  clickArea.addEventListener('click', (ev) => {
    const gain = rates.perClick;
    state.glizzies += gain;
    state.lifetime += gain;
    state.total_clicks += 1;
    dirty = true;

    // Bounce the glizzy (restart the animation on every click)
    clickArea.classList.remove('bounce');
    void clickArea.offsetWidth;
    clickArea.classList.add('bounce');

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

  // Production tick — driven by the wall clock, not by the assumption that the
  // interval actually fired every 100 ms. Backgrounded tabs get throttled (and
  // suspended phones stop firing entirely), which used to silently drop idle
  // production on the floor. Long gaps are capped here and settled properly by
  // the server on the next save, which knows the real elapsed time.
  const MAX_LOCAL_CATCHUP_SEC = 10;
  let lastTick = Date.now();
  setInterval(() => {
    const now = Date.now();
    const dt = Math.min((now - lastTick) / 1000, MAX_LOCAL_CATCHUP_SEC);
    lastTick = now;
    if (dt > 0 && rates.perSecond > 0) {
      const gain = rates.perSecond * dt;
      state.glizzies += gain;
      state.lifetime += gain;
      dirty = true;
      renderHud();
    }
  }, 100);
  // Refresh affordability once a second — but not mid-tap (see \`pointerHeld\`).
  setInterval(() => { if (!pointerHeld) { renderOracle(); renderBuildings(); renderUpgrades(); } }, 1000);

  // ----- save -----

  // The server's reply describes the world as of the payload we *sent*. The
  // player kept clicking and buying while the request was in flight, so re-apply
  // everything that happened locally since the snapshot instead of blowing the
  // live state away. Without this, a tap that landed during a save silently
  // vanished when the response arrived.
  function adoptServerState(server, sent) {
    // Responses can arrive out of order (an autosave and a golden claim in
    // flight together). Adopting an older snapshot than one we've already
    // adopted would wipe whatever the newer write added — most visibly a
    // just-claimed golden buff. Newer save_seq always wins; mark dirty so the
    // next save round-trip resyncs with the server instead.
    if ((Number(server.save_seq) || 0) < (Number(state.save_seq) || 0)) { dirty = true; return; }
    const next = Object.assign({}, server);
    next.buildings = Object.assign({}, server.buildings);
    let localActivity = false;

    if (sent) {
      const glizzyDelta = state.glizzies - sent.glizzies;
      const lifetimeDelta = Math.max(0, state.lifetime - sent.lifetime);
      const clickDelta = Math.max(0, state.total_clicks - sent.total_clicks);
      next.glizzies = Math.max(0, server.glizzies + glizzyDelta);
      next.lifetime = server.lifetime + lifetimeDelta;
      next.total_clicks = server.total_clicks + clickDelta;
      for (const b of BUILDINGS) {
        const bought = (state.buildings[b.id] || 0) - (sent.buildings[b.id] || 0);
        if (bought > 0) { next.buildings[b.id] = (next.buildings[b.id] || 0) + bought; localActivity = true; }
      }
      const ups = new Set(server.upgrades_owned || []);
      const sentUps = new Set(sent.upgrades_owned);
      for (const id of state.upgrades_owned) {
        if (!sentUps.has(id)) { ups.add(id); localActivity = true; }
      }
      next.upgrades_owned = Array.from(ups);
      if (glizzyDelta !== 0 || lifetimeDelta > 0 || clickDelta > 0) localActivity = true;
    }

    state = next;
    recomputeRates();
    // Anything we re-applied still needs persisting.
    if (localActivity) dirty = true;
    try { localStorage.setItem('glizzy_backup', JSON.stringify(state)); } catch (e) {}
  }

  async function save() {
    // Re-entrant: a second caller gets the in-flight save's promise, so
    // \`await save()\` always means the flush has actually landed (claimGolden
    // relies on this — Lucky! pays out of the server-side bank).
    if (savePromise) return savePromise;
    if (!dirty) return;
    savePromise = (async () => {
      dirty = false;
      const sent = {
        save_seq: state.save_seq || 0,
        glizzies: state.glizzies,
        lifetime: state.lifetime,
        total_clicks: state.total_clicks,
        buildings: Object.assign({}, state.buildings),
        upgrades_owned: state.upgrades_owned.slice(),
      };
      try {
        const res = await fetch('/api/game/save', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sent),
        });
        if (res.ok) {
          const data = await res.json();
          bonuses = data.bonuses;
          // A \`stale\` reply means our snapshot was behind the server's (another
          // tab, or a save queued before the device suspended). Take the server's
          // word for everything — our local numbers describe a dead timeline.
          adoptServerState(data.state, data.stale ? null : sent);
          rerender();
        }
      } catch (e) {
        console.warn('save failed', e);
        dirty = true;  // retry next tick
      }
    })();
    try { await savePromise; } finally { savePromise = null; }
  }
  setInterval(save, 5000);

  function flushBeacon() {
    if (!dirty || !navigator.sendBeacon) return;
    navigator.sendBeacon('/api/game/save', new Blob([JSON.stringify({
      save_seq: state.save_seq || 0,
      glizzies: state.glizzies, lifetime: state.lifetime, total_clicks: state.total_clicks,
      buildings: state.buildings, upgrades_owned: state.upgrades_owned,
    })], { type: 'application/json' }));
  }
  window.addEventListener('beforeunload', flushBeacon);
  // \`pagehide\` is the one that actually fires on iOS when a tab is backgrounded.
  window.addEventListener('pagehide', flushBeacon);

  // Coming back from a suspended/backgrounded tab: our tick timers may have been
  // frozen for hours. Reset the tick clock so we don't mint a huge local jump,
  // then push a save — the server credits the real idle production and hands
  // back the authoritative state.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { flushBeacon(); return; }
    lastTick = Date.now();
    dirty = true;
    save();
  });

  // ----- offline modal -----
  // Purely informational: the server already credited these when it built the
  // page state, so the client must NOT add them again.
  if (G.offlineEarned && G.offlineEarned > 5) {
    document.getElementById('offline-amount').innerHTML = fmt(G.offlineEarned) + ' ' + eIcon('🌭');
    document.getElementById('offline-modal').classList.remove('hidden');
    document.getElementById('offline-close').addEventListener('click', () => {
      document.getElementById('offline-modal').classList.add('hidden');
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
  // mode: 'on' (applied now), 'queued' (starts_at in the future — shows its
  // full run length), 'eclipsed' (running but beaten by a stronger same-group
  // buff — still burns wall-clock, shows remaining time, dimmed).
  function buffLabel(g, mode) {
    const ms = mode === 'queued'
      ? new Date(g.expires_at).getTime() - new Date(g.starts_at).getTime()
      : new Date(g.expires_at).getTime() - Date.now();
    const secs = Math.max(0, Math.ceil(ms / 1000));
    const t = (secs >= 60 ? Math.ceil(secs / 60) + 'm' : secs + 's') + (mode === 'queued' ? ' next' : '');
    if (g.kind === 'prod_mult') {
      const mega = g.mult >= 100;
      return { mega, html: eIcon(mega ? '🌠' : '🔥', 16) + ' ×' + fmt(g.mult) + ' prod · ' + t };
    }
    if (g.kind === 'click_mult') {
      // Same >=100 test as prod_mult: DEMON DOG's chip has to look like the
      // mega it is, or the rarest reward in the table renders as a plain one.
      const mega = g.mult >= 100;
      return { mega, html: eIcon(mega ? '😈' : '👆', 16) + ' ×' + fmt(g.mult) + ' click · ' + t };
    }
    if (g.kind === 'building_mult') {
      const b = BUILDINGS.find(x => x.id === g.building);
      return { mega: false, html: eIcon('⚙️', 16) + ' ' + (b ? b.name : 'Building') + ' ×' + fmt(g.mult) + ' · ' + t };
    }
    return { mega: false, html: eIcon('✨', 16) + ' buff · ' + t };
  }
  let lastBuffSig = '';
  function renderBuffs() {
    const bar = document.getElementById('buffs-bar');
    if (!bar) return;
    const now = Date.now();
    const active = (state.golden_effects || []).filter(g => g && new Date(g.expires_at).getTime() > now);
    if (active.length !== (state.golden_effects || []).length) state.golden_effects = active;
    // Which buff actually applies per group right now (mirrors computeRatesFor).
    const winners = {};
    for (const g of active) {
      if (g.starts_at && new Date(g.starts_at).getTime() > now) continue;
      const k = buffGroupKey(g);
      if (!winners[k] || g.mult > winners[k].mult) winners[k] = g;
    }
    // Rates change whenever the applied set changes — a buff expired, a queued
    // one kicked in, a stronger one eclipsed a weaker — not only on prune.
    const sig = Object.keys(winners).map(k => k + ':' + winners[k].mult + ':' + winners[k].expires_at).sort().join('|');
    if (sig !== lastBuffSig) { lastBuffSig = sig; recomputeRates(); }
    bar.innerHTML = active.map(g => {
      const mode = (g.starts_at && new Date(g.starts_at).getTime() > now) ? 'queued'
        : (winners[buffGroupKey(g)] === g ? 'on' : 'eclipsed');
      const l = buffLabel(g, mode);
      return '<span class="buff-chip' + (l.mega ? ' mega' : '') + (mode === 'on' ? '' : ' idle') + '">' + l.html + '</span>';
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
      '<div style="font-size:22px;font-weight:800;color:#fff;margin-top:2px">' + eIcon(data.emoji) + ' ' + data.name + '</div>' +
      '<div style="font-size:14px;color:#fde68a;margin-top:2px">' + (data.message || '') + '</div>';
    toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove('show'), mega ? 8000 : 5000);
  }

  // ----- golden glizzy: claim -----
  async function claimGolden() {
    try {
      await save();  // flush local earnings — including a save already in flight — so the server's bank is fresh (for Lucky!)
      const sent = {
        glizzies: state.glizzies,
        lifetime: state.lifetime,
        total_clicks: state.total_clicks,
        buildings: Object.assign({}, state.buildings),
        upgrades_owned: state.upgrades_owned.slice(),
      };
      const res = await fetch('/api/game/golden', { method: 'POST' });
      const data = res.ok ? await res.json() : null;
      // A click must never just swallow the glizzy silently — that reads as a
      // broken game. Say what happened, and if the server is still cooling down
      // re-spawn as soon as it isn't rather than burning the whole interval.
      if (!data || !data.ok) {
        if (data && data.reason === 'too_soon') {
          showGoldenToast({ emoji: '⏳', name: 'Not yet!', message: 'That one came too fast — hang on for the next.' });
          scheduleGolden((data.retryAfterMs || 0) + 2000);
        } else {
          showGoldenToast({ emoji: '💨', name: 'It got away', message: 'Could not reach the server — try the next one.' });
        }
        return;
      }
      bonuses = data.bonuses;
      adoptServerState(data.state, sent);  // keep anything bought mid-request
      rerender();
      renderBuffs();
      showGoldenToast(data);
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
  // A single spawn timer, always replaced rather than stacked — otherwise a
  // reschedule on top of a pending one eventually spawns two at once.
  let goldenSpawnTimer = null;
  function scheduleGolden(delayMs) {
    clearTimeout(goldenSpawnTimer);
    const span = (GS.maxIntervalSec - GS.minIntervalSec) || 0;
    const delay = delayMs != null
      ? delayMs
      : (GS.minIntervalSec + Math.random() * span) * 1000;
    goldenSpawnTimer = setTimeout(spawnGolden, delay);
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

  // ----- leaderboard peek -----
  // Navigating to /game/leaderboard costs a save round-trip and drops you out
  // of the running loop, so standings get their own overlay. The game keeps
  // ticking underneath while it's open.
  (function initLeaderboardModal() {
    const modal = document.getElementById('lb-modal');
    const body = document.getElementById('lb-body');
    let timer = null;
    let scrollToMe = false;

    function escHtml(s) {
      return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
      });
    }
    function avatarHtml(row) {
      if (row.avatar_url) {
        return '<img src="' + escHtml(row.avatar_url) + '" alt="" style="width:32px;height:32px;border-radius:50%;object-fit:cover;flex-shrink:0;">';
      }
      const initial = escHtml(((row.name || '?')[0] || '?').toUpperCase());
      return '<span style="width:32px;height:32px;border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:700;font-size:13px;flex-shrink:0;">' + initial + '</span>';
    }
    function rowHtml(row, rank, isMe) {
      const rankColor = rank === 1 ? '#ffd166' : rank === 2 ? '#cbd5e1' : rank === 3 ? '#d4a574' : '#6b7280';
      const rowCls = isMe ? 'bg-slate-800/60 ring-1 ring-accent/40' : 'hover:bg-slate-800/40';
      return '<div ' + (isMe ? 'data-me="1" ' : '') + 'class="flex items-center gap-2 sm:gap-3 px-2 py-2.5 rounded-lg ' + rowCls + '">' +
        '<div class="text-base sm:text-xl font-bold tabular-nums w-6 sm:w-8 text-right flex-shrink-0" style="color:' + rankColor + '">' + (rank || '—') + '</div>' +
        avatarHtml(row) +
        '<div class="flex-1 min-w-0">' +
          '<div class="flex items-baseline justify-between gap-2 min-w-0">' +
            '<div class="font-semibold text-white truncate min-w-0 text-sm">' + escHtml(row.name || '') + (isMe ? ' <span class="text-[10px] uppercase tracking-widest accent">you</span>' : '') + '</div>' +
            '<div class="text-base sm:text-xl font-bold accent tabular-nums flex-shrink-0 whitespace-nowrap" title="' + Math.floor(row.lifetime || 0).toLocaleString() + ' lifetime glizzies">' + fmt(row.lifetime || 0) + '</div>' +
          '</div>' +
          '<div class="text-[11px] text-slate-400 truncate">' + fmt(row.total_buildings || 0) + ' buildings · ' + fmt(row.total_clicks || 0) + ' clicks · <span class="accent font-semibold">' + fmtRate(row.per_second || 0) + '</span></div>' +
        '</div>' +
      '</div>';
    }

    function render(rows) {
      if (!rows.length) {
        body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">No players yet.</div>';
        return;
      }
      let html = rows.map(function (r, i) { return rowHtml(r, i + 1, r.user_id === G.userId); }).join('');
      // Top 50 only — if you're not on the board, show your own line anyway so
      // the modal never looks like it forgot you exist.
      if (!rows.some(function (r) { return r.user_id === G.userId; })) {
        html += '<div class="border-t border-slate-800 mt-2 pt-2">' +
          rowHtml({ name: G.displayName, lifetime: state.lifetime, total_buildings: BUILDINGS.reduce(function (s, b) { return s + (state.buildings[b.id] || 0); }, 0), total_clicks: state.total_clicks, per_second: rates.perSecond }, 0, true) +
          '</div>';
      }
      body.innerHTML = html;
      if (scrollToMe) {
        scrollToMe = false;
        const me = body.querySelector('[data-me]');
        if (me) me.scrollIntoView({ block: 'center' });
      }
    }

    async function refresh() {
      try {
        const res = await fetch('/api/game/leaderboard');
        if (!res.ok) throw new Error('http ' + res.status);
        render(await res.json());
      } catch (e) {
        body.innerHTML = '<div class="text-center text-slate-400 py-8 text-sm">Couldn\\'t load the leaderboard.</div>';
      }
    }

    function isOpen() { return !modal.classList.contains('hidden'); }
    function open() {
      if (isOpen()) return;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      scrollToMe = true;
      refresh();
      timer = setInterval(refresh, 10000);
    }
    function close() {
      modal.classList.add('hidden');
      modal.classList.remove('flex');
      if (timer) { clearInterval(timer); timer = null; }
    }

    document.getElementById('lb-open').addEventListener('click', open);
    document.getElementById('lb-close').addEventListener('click', close);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    document.addEventListener('keydown', function (e) {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = (document.activeElement && document.activeElement.tagName) || '';
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      if (e.key === 'Escape' && isOpen()) close();
      else if (e.key === 'l' || e.key === 'L') { isOpen() ? close() : open(); }
    });
  })();

  // Initial render
  recomputeRates();
  renderBuyQty();
  if (oracleUnlocked) {
    unlockOracle(false);
    let wasOn = false;
    try { wasOn = localStorage.getItem('glizzy_oracle_on') === '1'; } catch (e) {}
    if (wasOn) setOracle(true);
  }
  rerender();
  renderBuffs();
  initCollapsibles();
})();
</script>`;

/**
 * Attach display identity to raw leaderboard rows. The full-page leaderboard
 * and the in-game modal both need it, and the modal renders client-side, so
 * the name/avatar has to ride along in the JSON.
 */
function withProfiles(rows) {
  return rows.map((r) => {
    const profile = getUserProfileStmt.get(r.user_id);
    return {
      ...r,
      name: (profile && (profile.global_name || profile.username)) || `User ${String(r.user_id).slice(-4)}`,
      avatar_url: (profile && profile.avatar_url) || null,
    };
  });
}

function renderLeaderboardPage(rows) {
  const cards = rows.length === 0
    ? `<div class="card p-12 text-center"><div class="mb-3">${emojiIcon("🌭", 64)}</div><div class="text-xl text-slate-200 font-semibold">No players yet</div><div class="text-slate-400 mt-2">Be the first — log in and start clicking.</div></div>`
    : `<div class="card p-2">${rows.map((r, i) => {
        const profile = getUserProfileStmt.get(r.user_id);
        const name = (profile && (profile.global_name || profile.username)) || `User ${String(r.user_id).slice(-4)}`;
        const avatar = profile && profile.avatar_url
          ? `<img src="${esc(profile.avatar_url)}" style="width:36px;height:36px;border-radius:50%;object-fit:cover;flex-shrink:0;">`
          : `<span style="width:36px;height:36px;border-radius:50%;background:#334155;color:#cbd5e1;display:inline-flex;align-items:center;justify-content:center;font-weight:700;flex-shrink:0;">${esc((name[0] || "?").toUpperCase())}</span>`;
        const rankColor = i === 0 ? "#ffd166" : i === 1 ? "#cbd5e1" : i === 2 ? "#d4a574" : "#6b7280";
        return `
          <div class="flex items-center gap-2 sm:gap-4 px-2 sm:px-3 py-3 hover:bg-slate-800/40 transition">
            <div class="text-lg sm:text-2xl font-bold tabular-nums w-6 sm:w-10 text-right flex-shrink-0" style="color:${rankColor}">${esc(i + 1)}</div>
            ${avatar}
            <div class="flex-1 min-w-0">
              <div class="flex items-baseline justify-between gap-2 min-w-0">
                <div class="font-semibold text-white truncate min-w-0">${esc(name)}</div>
                <div class="text-lg sm:text-2xl font-bold accent tabular-nums flex-shrink-0 whitespace-nowrap" title="${esc(r.lifetime.toLocaleString())} lifetime glizzies">${esc(fmtCompact(r.lifetime))}</div>
              </div>
              <div class="flex items-baseline justify-between gap-2 min-w-0">
                <div class="text-xs text-slate-400 min-w-0">${esc(r.total_buildings)} buildings · ${esc(fmtCompact(r.total_clicks))} clicks · <span class="accent font-semibold" data-prod="${esc(r.user_id)}">${esc(fmtRate(r.per_second))}</span></div>
                <div class="hidden sm:block text-[10px] text-slate-500 uppercase tracking-widest flex-shrink-0">lifetime ${emojiIcon("🌭", 16)}</div>
              </div>
            </div>
          </div>`;
      }).join("")}</div>`;

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyClicker · Leaderboard</title>${STYLES}</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-3xl mx-auto px-4 sm:px-6 py-8">
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
  // GlizzyClicker's pixel art. Whitelisted by name shape (same rule as
  // /brawl/art) so the route can never serve anything else out of the repo.
  app.get("/game/art/:file", (req, res) => {
    if (!/^[a-z0-9_]+\.png$/.test(req.params.file)) return res.status(404).end();
    res.type("image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(path.join(CLICKER_ART_DIR, req.params.file))
      .on("error", () => res.status(404).end())
      .pipe(res);
  });

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
    res.json(withProfiles(getLeaderboardRows(50)));
  });
}

// Re-exports for /glizzy slash command
export { getLeaderboardRows, getPlayerSummary };
