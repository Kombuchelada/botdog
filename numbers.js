// "Hot Dogs by the Numbers" — magazine-scroll stats page at /numbers.
//
// Every stat here is derived from two things: the hotdog_events table and the
// Average Glizzy (see CONTEXT.md) — one 57 g beef frank + one 43 g white bun.
// All constants live in CONSTANTS with a citation; nothing numeric is inlined
// in a formula or the markup. Health stats are collective-only by design:
// per-participant rates are computed here and only aggregates leave the
// server. Full design rationale: docs/by-the-numbers.md.

import { getAllEventsStmt } from "./database.js";
import { renderNav } from "./nav.js";
import { toPacificDateKey, parseUtcTimestamp } from "./stats.js";

// ============================================================================
// Constants — value + source, so "show your work" panels can cite everything
// ============================================================================

const SRC = {
  fdcFrank: {
    label: "USDA FDC 173862 — Frankfurter, beef, unheated",
    url: "https://fdc.nal.usda.gov/food-details/173862/nutrients",
  },
  fdcBun: {
    label: "USDA FDC 172796 — Rolls, hamburger or hotdog, plain",
    url: "https://fdc.nal.usda.gov/food-details/172796/nutrients",
  },
  fdcButter: {
    label: "USDA FDC — Butter, salted",
    url: "https://fdc.nal.usda.gov/food-details/173410/nutrients",
  },
  fdcChicken: {
    label: "USDA FDC — Chicken breast, roasted, skinless",
    url: "https://fdc.nal.usda.gov/food-details/171477/nutrients",
  },
  nhdsc: {
    label: "National Hot Dog & Sausage Council",
    url: "https://hot-dog.org/",
  },
  bls: {
    label: "BLS avg. retail frankfurters, series APU0000705111 (ended Apr 2022 at $5.22/lb)",
    url: "https://fred.stlouisfed.org/series/APU0000705111",
  },
  keys: {
    label: "Keys, Anderson & Grande 1965 — serum-cholesterol prediction equation",
    url: "https://pubmed.ncbi.nlm.nih.gov/25831119/",
  },
  micha: {
    label: "Micha, Wallace & Mozaffarian, Circulation 2010 — RR 1.42 CHD per 50 g/day processed meat",
    url: "https://www.ahajournals.org/doi/10.1161/circulationaha.109.924977",
  },
  fdaSodium: {
    label: "FDA Daily Value: sodium 2,300 mg/day",
    url: "https://www.fda.gov/food/nutrition-facts-label/sodium-your-diet",
  },
  fdaProtein: {
    label: "FDA Daily Value: protein 50 g/day",
    url: "https://www.fda.gov/food/nutrition-facts-label/daily-value-nutrition-and-supplement-facts-labels",
  },
  nass: {
    label: "USDA NASS — U.S. average wheat yield ≈ 50 bu/acre",
    url: "https://www.nass.usda.gov/Charts_and_Maps/Field_Crops/wheatyld.php",
  },
  waterFootprint: {
    label: "Mekonnen & Hoekstra 2012, Ecosystems — water footprint of farm animal products",
    url: "https://waterfootprint.org/resources/Mekonnen-Hoekstra-2012-WaterFootprintFarmAnimalProducts_1.pdf",
  },
  poore: {
    label: "Poore & Nemecek 2018, Science — food GHG footprints (dairy-herd beef)",
    url: "https://www.science.org/doi/10.1126/science.aaq0216",
  },
  epaCar: {
    label: "EPA — average passenger vehicle ≈ 400 g CO₂/mile",
    url: "https://www.epa.gov/greenvehicles/greenhouse-gas-emissions-typical-passenger-vehicle",
  },
  altman: {
    label: "Altman, “The Gentle Singularity” (2025) — 0.000085 gal (≈0.32 mL) per query",
    url: "https://blog.samaltman.com/the-gentle-singularity",
  },
  ucr: {
    label: "Li et al. (UC Riverside) 2023, “Making AI Less Thirsty” — ~500 mL per 10–50 responses",
    url: "https://arxiv.org/abs/2304.03271",
  },
  nathans: {
    label: "Nathan's Famous contest — Joey Chestnut, 76 dogs / 10 min (2021 world record)",
    url: "https://en.wikipedia.org/wiki/Nathan%27s_Hot_Dog_Eating_Contest",
  },
  runcalc: {
    label: "Harvard Health energy-expenditure tables (155 lb adult)",
    url: "https://www.health.harvard.edu/diet-and-weight-loss/calories-burned-in-30-minutes-for-people-of-three-different-weights",
  },
};

// The Average Glizzy. Frank + bun masses are the standard grocery "bun-length"
// 8-per-pound pack; per-100 g nutrition comes straight from the two USDA
// entries above and is scaled here once.
const FRANK_G = 57;
const BUN_G = 43;
const GLIZZY_LENGTH_M = 0.1524; // 6 in — NHDSC standard
const FRANK_PER_100G = { kcal: 315, protein: 11.7, satfat: 11.5, sodiumMg: 865, cholMg: 58 };
const BUN_PER_100G = { kcal: 279, protein: 9.77, satfat: 0.842, sodiumMg: 494, cholMg: 0 };

function perGlizzy(key) {
  return (FRANK_PER_100G[key] * FRANK_G + BUN_PER_100G[key] * BUN_G) / 100;
}

const GLIZZY = {
  kcal: perGlizzy("kcal"), //            ≈ 299.5
  proteinG: perGlizzy("protein"), //     ≈ 10.87
  satfatG: perGlizzy("satfat"), //       ≈ 6.92
  sodiumMg: perGlizzy("sodiumMg"), //    ≈ 705
  cholMg: perGlizzy("cholMg"), //        ≈ 33.1
  beefG: FRANK_G,
  lengthM: GLIZZY_LENGTH_M,
  priceUsd: 0.99, // BLS franks $5.22/lb → $0.66 per 57 g, + ~$0.33 bun (8-pack ≈ $2.64)
};

const CHICKEN_BREAST_PROTEIN_G = 53; // one average cooked skinless breast (172 g @ 31 g/100 g)
const PROTEIN_DV_G = 50;
const BUTTER_STICK_SATFAT_G = 58; // 113 g stick × 51.4 g/100 g
const SALT_FROM_SODIUM = 2.5; // NaCl is ~40% sodium by mass
const MORTON_CANISTER_G = 737; // the classic 26 oz round blue canister
const SODIUM_DV_MG = 2300;
const MICHA_RR_PER_50G = 1.42;
const BASELINE_DIET_KCAL = 2000;
const BASELINE_DIET_CHOL_MG = 300;
const FLOUR_PER_BUN_G = 25; // ~58% of bun mass; the rest is water/sugar/fat
const WHEAT_EXTRACTION = 0.75; // white-flour milling extraction rate
const WHEAT_G_PER_ACRE = 50 * 60 * 453.59; // 50 bu/ac × 60 lb/bu ≈ 1.36 t/acre
const SQFT_PER_ACRE = 43560;
const KCAL_PER_MARATHON = 2600; // ~100 kcal/mile × 26.2, 155 lb runner
const KCAL_PER_MILE_WALKED = 80;
const CHESTNUT_DOGS = 76;
const CHESTNUT_MINUTES = 10;
const WATER_L_PER_KG_BEEF = 15400;
const WATER_L_PER_KG_WHEAT = 1827;
const CHATGPT_ML_PER_QUERY_LOW = 0.32; // OpenAI's own figure (cooling only)
const CHATGPT_ML_PER_QUERY_HIGH = 30; // UC Riverside lifecycle estimate (10–50 mL)
const CO2_KG_PER_KG_BEEF = 25; // dairy-herd beef — hot dog beef is trimmings/cull cattle
const CAR_CO2_G_PER_MILE = 400;
const OLYMPIC_POOL_L = 2500000;

// ============================================================================
// Milestone ladders — spans ~1,000 to ~15,000+ glizzies so comparisons keep
// upgrading themselves if the pace doubles (see docs/by-the-numbers.md)
// ============================================================================

const LENGTH_LADDER_M = [
  { label: "an NFL field, end zone to end zone", short: "NFL field", m: 109.7, emoji: "🏈" },
  { label: "the Eiffel Tower", short: "Eiffel Tower", m: 330, emoji: "🗼" },
  { label: "the Empire State Building (roof)", short: "ESB roof", m: 381, emoji: "🏙️" },
  { label: "the Empire State Building (antenna tip)", short: "ESB tip", m: 443, emoji: "📡" },
  { label: "the Burj Khalifa", short: "Burj Khalifa", m: 828, emoji: "🏗️" },
  { label: "the Golden Gate Bridge main span", short: "Golden Gate span", m: 1280, emoji: "🌉" },
  { label: "a full mile of hot dog", short: "One mile", m: 1609.34, emoji: "🛣️" },
  { label: "a lap of Daytona International Speedway", short: "Daytona lap", m: 4023, emoji: "🏁" },
];

const AREA_LADDER_SQFT = [
  { label: "a parking space", sqft: 160, emoji: "🅿️" },
  { label: "a two-car garage", sqft: 440, emoji: "🏠" },
  { label: "a tennis court", sqft: 2808, emoji: "🎾" },
  { label: "a basketball court", sqft: 4700, emoji: "🏀" },
  { label: "an NHL hockey rink", sqft: 17000, emoji: "🏒" },
  { label: "a full acre", sqft: SQFT_PER_ACRE, emoji: "🌾" },
];

const MONEY_LADDER_USD = [
  { label: "AirPods Pro", usd: 249, emoji: "🎧" },
  { label: "a PS5 Pro", usd: 699, emoji: "🎮" },
  { label: "a 77-inch OLED TV", usd: 2500, emoji: "📺" },
  { label: "a semester of in-state tuition", usd: 5800, emoji: "🎓" },
  { label: "a 2012 Mazda Miata", usd: 9000, emoji: "🚗" },
  { label: "a genuine hot dog cart business", usd: 15000, emoji: "🛒" },
];

const WALK_LADDER_MI = [
  { label: "the Appalachian Trail", mi: 2197, emoji: "⛰️" },
  { label: "LA to New York on foot", mi: 2790, emoji: "🗽" },
  { label: "every street in New York City", mi: 6074, emoji: "🚕" },
  { label: "the Pan-American Highway", mi: 19000, emoji: "🌎" },
  { label: "around the equator", mi: 24901, emoji: "🌍" },
];

const WATER_LADDER_L = [
  { label: "a hot tub", l: 1500, emoji: "🛁" },
  { label: "a backyard pool", l: 75000, emoji: "🏊" },
  { label: "an Olympic swimming pool", l: OLYMPIC_POOL_L, emoji: "🏅" },
  { label: "two Olympic pools", l: OLYMPIC_POOL_L * 2, emoji: "🏅" },
  { label: "four Olympic pools", l: OLYMPIC_POOL_L * 4, emoji: "🏅" },
];

function ladderProgress(value, ladder, key) {
  const conqueredList = [];
  let next = null;
  for (const rung of ladder) {
    if (rung[key] <= value) conqueredList.push(rung);
    else if (!next) next = rung;
  }
  const conquered = conqueredList[conqueredList.length - 1] || null;
  const floor = conquered ? conquered[key] : 0;
  const pct = next ? Math.min(100, ((value - floor) / (next[key] - floor)) * 100) : 100;
  return { conquered, conqueredList, next, pct };
}

// ============================================================================
// Stats computation
// ============================================================================

const MS_DAY = 24 * 60 * 60 * 1000;
const YEAR_START_KEY = "2026-01-01";
const YEAR_END_KEY = "2026-12-31";

function keyToUtcNoon(key) {
  return new Date(key + "T12:00:00Z");
}

function netSince(events, now, days) {
  const cutoff = now.getTime() - days * MS_DAY;
  let sum = 0;
  for (const e of events) {
    if (parseUtcTimestamp(e.timestamp).getTime() >= cutoff) sum += e.amount;
  }
  return sum;
}

export function computeNumbers() {
  const events = getAllEventsStmt.all();
  const now = new Date();
  const todayKey = toPacificDateKey(now);

  // --- totals & the cumulative daily series (Pacific day buckets) ---
  const daily = new Map();
  const byUser = new Map();
  let netTotal = 0;
  for (const e of events) {
    const key = toPacificDateKey(parseUtcTimestamp(e.timestamp));
    daily.set(key, (daily.get(key) || 0) + e.amount);
    byUser.set(e.user_id, (byUser.get(e.user_id) || 0) + e.amount);
    netTotal += e.amount;
  }

  const daysElapsed = Math.round((keyToUtcNoon(todayKey) - keyToUtcNoon(YEAR_START_KEY)) / MS_DAY) + 1;
  const daysRemaining = Math.max(0, Math.round((keyToUtcNoon(YEAR_END_KEY) - keyToUtcNoon(todayKey)) / MS_DAY));

  const series = { dailyNet: [], startKey: YEAR_START_KEY };
  let cumulative = 0;
  for (let i = 0; i < daysElapsed; i++) {
    const key = toPacificDateKey(new Date(keyToUtcNoon(YEAR_START_KEY).getTime() + i * MS_DAY));
    const net = daily.get(key) || 0;
    cumulative += net;
    series.dailyNet.push(net);
  }

  // --- pace & projection (see CONTEXT.md: Pace, Projected Year-End Total) ---
  const pace28 = netSince(events, now, 28) / 28;
  const pace14 = netSince(events, now, 14) / 14;
  const paceYtd = netTotal / daysElapsed;
  const projections = [pace14, pace28, paceYtd].map((p) => Math.round(netTotal + p * daysRemaining));
  const projection = {
    mid: Math.round(netTotal + pace28 * daysRemaining),
    low: Math.min(...projections),
    high: Math.max(...projections),
  };

  // --- per-participant rates → collective-only health stats ---
  // Additive assumption: every glizzy on top of an unchanged 2,000 kcal
  // baseline diet. Per-user rates never leave this function.
  const participants = [...byUser.values()].filter((net) => net > 0);
  let collectiveCholMgDl = 0;
  let meanRate = 0;
  for (const net of participants) {
    const rate = net / daysElapsed; // dogs/day, averaged over the year so far
    meanRate += rate / participants.length;
    const satfatPctKcal = ((rate * GLIZZY.satfatG * 9) / BASELINE_DIET_KCAL) * 100;
    const cholPer1000 = (BASELINE_DIET_CHOL_MG + rate * GLIZZY.cholMg) / (BASELINE_DIET_KCAL / 1000);
    const baseCholPer1000 = BASELINE_DIET_CHOL_MG / (BASELINE_DIET_KCAL / 1000);
    collectiveCholMgDl +=
      1.35 * (2 * satfatPctKcal) + 1.5 * (Math.sqrt(cholPer1000) - Math.sqrt(baseCholPer1000));
  }
  const meanMeatGPerDay = meanRate * GLIZZY.beefG;
  const chdRiskPct = (MICHA_RR_PER_50G - 1) * (meanMeatGPerDay / 50) * 100;

  // --- everything else is Average Glizzy arithmetic ---
  const proteinG = netTotal * GLIZZY.proteinG;
  const satfatG = netTotal * GLIZZY.satfatG;
  const sodiumMg = netTotal * GLIZZY.sodiumMg;
  const saltG = (sodiumMg / 1000) * SALT_FROM_SODIUM;
  const kcal = netTotal * GLIZZY.kcal;
  const lengthM = netTotal * GLIZZY.lengthM;
  const beefKg = (netTotal * GLIZZY.beefG) / 1000;
  const wheatG = (netTotal * FLOUR_PER_BUN_G) / WHEAT_EXTRACTION;
  const wheatSqft = (wheatG / WHEAT_G_PER_ACRE) * SQFT_PER_ACRE;
  const moneyUsd = netTotal * GLIZZY.priceUsd;
  const milesWalked = kcal / KCAL_PER_MILE_WALKED;
  const waterL = beefKg * WATER_L_PER_KG_BEEF + (wheatG / 1000) * WATER_L_PER_KG_WHEAT;
  const co2Kg = beefKg * CO2_KG_PER_KG_BEEF;

  return {
    todayKey,
    daysElapsed,
    daysRemaining,
    netTotal,
    participants: participants.length,
    pace: { p14: pace14, p28: pace28, ytd: paceYtd },
    projection,
    series,
    protein: {
      grams: proteinG,
      breasts: proteinG / CHICKEN_BREAST_PROTEIN_G,
      dvDays: proteinG / PROTEIN_DV_G,
    },
    satfat: { grams: satfatG, sticks: satfatG / BUTTER_STICK_SATFAT_G },
    sodium: {
      mg: sodiumMg,
      saltG,
      canisters: saltG / MORTON_CANISTER_G,
      dvDays: sodiumMg / SODIUM_DV_MG,
    },
    cardio: { collectiveCholMgDl, chdRiskPct, meanMeatGPerDay },
    length: { m: lengthM, ladder: ladderProgress(lengthM, LENGTH_LADDER_M, "m") },
    wheat: { sqft: wheatSqft, ladder: ladderProgress(wheatSqft, AREA_LADDER_SQFT, "sqft") },
    money: { usd: moneyUsd, ladder: ladderProgress(moneyUsd, MONEY_LADDER_USD, "usd") },
    exercise: {
      kcal,
      marathons: kcal / KCAL_PER_MARATHON,
      miles: milesWalked,
      ladder: ladderProgress(milesWalked, WALK_LADDER_MI, "mi"),
    },
    chestnut: { units: netTotal / CHESTNUT_DOGS, joeyMinutes: (netTotal / CHESTNUT_DOGS) * CHESTNUT_MINUTES },
    planet: {
      waterL,
      pools: waterL / OLYMPIC_POOL_L,
      ladder: ladderProgress(waterL, WATER_LADDER_L, "l"),
      chatgptLow: (waterL * 1000) / CHATGPT_ML_PER_QUERY_HIGH, // lifecycle estimate → fewer queries
      chatgptHigh: (waterL * 1000) / CHATGPT_ML_PER_QUERY_LOW, // OpenAI's figure → absurdly many
      co2Kg,
      carMiles: (co2Kg * 1000) / CAR_CO2_G_PER_MILE,
    },
  };
}

// ============================================================================
// Rendering helpers
// ============================================================================

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function fmt(n, decimals = 0) {
  return Number(n).toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

// A big number that counts up when its section scrolls into view. SSR'd with
// the real value so the page reads fine without JS; the script zeroes it and
// animates back up.
function countup(value, { decimals = 0, prefix = "", suffix = "" } = {}) {
  return `<span class="countup" data-value="${value}" data-decimals="${decimals}" data-prefix="${esc(prefix)}" data-suffix="${esc(suffix)}">${esc(prefix + fmt(value, decimals) + suffix)}</span>`;
}

// Isotype-style unit grid: one emoji tile = N units, unit auto-picked so the
// grid stays ≤ maxTiles even as totals grow. The last, partial tile is clipped
// to its fraction.
function unitGrid(count, emoji, singular, plural, maxTiles = 90) {
  const units = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000];
  const unit = units.find((u) => count / u <= maxTiles) || units[units.length - 1];
  const whole = Math.floor(count / unit);
  const frac = count / unit - whole;
  let tiles = "";
  for (let i = 0; i < whole; i++) tiles += `<span class="pict">${emoji}</span>`;
  if (frac > 0.08) {
    tiles += `<span class="pict pict-partial"><span style="width:${Math.round(frac * 100)}%">${emoji}</span></span>`;
  }
  const per = unit === 1 ? `each ${emoji} = 1 ${singular}` : `each ${emoji} = ${fmt(unit)} ${plural}`;
  return `
    <div class="pict-grid" aria-hidden="true">${tiles}</div>
    <div class="pict-caption">${esc(per)}</div>`;
}

function ladderHTML(progress, valueFmt, opts = {}) {
  const { conquered, conqueredList, next, pct } = progress;
  const conqueredLine = conquered
    ? `<div class="ladder-conquered">✓ ${esc(conquered.emoji || "")} ${esc(conquered.label)} <span class="ladder-dim">(${valueFmt(conquered)})</span> — conquered</div>`
    : `<div class="ladder-conquered ladder-dim">Nothing conquered yet. Get eating.</div>`;
  const prior = conqueredList.length > 1
    ? `<div class="ladder-prior">also behind us: ${conqueredList
        .slice(0, -1)
        .map((r) => `<span class="ladder-chip">✓ ${esc(r.emoji || "")} ${esc(r.short || r.label)} <span class="ladder-dim">${valueFmt(r)}</span></span>`)
        .join("")}</div>`
    : "";
  if (!next) {
    return `${conqueredLine}${prior}<div class="ladder-dim mt-1">The ladder has run out. We never planned for this.</div>`;
  }
  const after = opts.after
    ? `<div class="ladder-dim mt-1">then: ${esc(opts.after)}</div>`
    : "";
  return `
    ${conqueredLine}
    ${prior}
    <div class="ladder-next">
      <div class="flex items-baseline justify-between gap-3">
        <div>▸ next: ${esc(next.emoji || "")} ${esc(next.label)}</div>
        <div class="tabular-nums text-accent-soft">${fmt(progress.pct, 0)}%</div>
      </div>
      <div class="ladder-bar"><div class="ladder-fill" data-pct="${pct.toFixed(1)}" style="width:${pct.toFixed(1)}%"></div></div>
      <div class="ladder-dim">${valueFmt(next)}</div>
    </div>
    ${after}`;
}

function workPanel({ formula = [], constants = [], assumptions = [] }) {
  const f = formula.map((l) => `<div>${l}</div>`).join("");
  const c = constants
    .map(
      (x) =>
        `<li>${esc(x.text)}${x.source ? ` — <a href="${esc(x.source.url)}" target="_blank" rel="noopener">${esc(x.source.label)}</a>` : ""}</li>`,
    )
    .join("");
  const a = assumptions.map((x) => `<li>${esc(x)}</li>`).join("");
  return `
    <details class="work">
      <summary>▸ show your work</summary>
      <div class="work-body">
        <div class="work-formula">${f}</div>
        ${c ? `<div class="work-h">constants</div><ul>${c}</ul>` : ""}
        ${a ? `<div class="work-h">assumptions</div><ul>${a}</ul>` : ""}
      </div>
    </details>`;
}

function section({ id, kicker, headlineHTML, sublineHTML, visualHTML = "", ladderBlock = "", work = null, tone = "" }) {
  return `
  <section class="num-section ${tone}" id="${esc(id)}">
    <div class="num-inner">
      <div class="num-kicker reveal">${esc(kicker)}</div>
      <div class="num-headline reveal">${headlineHTML}</div>
      <div class="num-subline reveal">${sublineHTML}</div>
      ${visualHTML ? `<div class="num-visual reveal">${visualHTML}</div>` : ""}
      ${ladderBlock ? `<div class="num-ladder reveal">${ladderBlock}</div>` : ""}
      ${work ? `<div class="reveal">${work}</div>` : ""}
    </div>
  </section>`;
}

// The Tower scene: our glizzy stack as a to-scale column next to the last
// conquered landmark, the next one, and the one after — auto-scales with the
// ladder forever. Columns are outlines; only our stack wears the accent.
function towerSVG(lengthM, progress) {
  // Every landmark already surpassed, plus the next two ahead. Early rungs
  // shrink into footnotes beside the growing stack — that's the point.
  const nextIdx = progress.next ? LENGTH_LADDER_M.indexOf(progress.next) : LENGTH_LADDER_M.length;
  const rungs = LENGTH_LADDER_M.slice(0, Math.min(nextIdx + 2, LENGTH_LADDER_M.length));
  const maxM = Math.max(lengthM, ...rungs.map((r) => r.m));
  const H = 250;
  const colW = 64;
  const gap = 26;
  const n = rungs.length + 1;
  const W = n * colW + (n - 1) * gap;
  const scale = (m) => Math.max(6, (m / maxM) * (H - 40));

  let x = 0;
  const ourH = scale(lengthM);
  let cols = `
    <g class="tower-col">
      <rect x="${x}" y="${H - ourH}" width="${colW}" height="${ourH}" rx="4" fill="url(#dogstack)" class="tower-us" />
      <text x="${x + colW / 2}" y="${H - ourH - 16}" class="tw-emoji" text-anchor="middle">🌭</text>
      <text x="${x + colW / 2}" y="${H + 16}" class="tw-label" text-anchor="middle">our stack</text>
      <text x="${x + colW / 2}" y="${H + 30}" class="tw-h" text-anchor="middle">${fmt(lengthM)} m</text>
    </g>`;
  for (const r of rungs) {
    x += colW + gap;
    const h = scale(r.m);
    cols += `
    <g class="tower-col">
      <rect x="${x}" y="${H - h}" width="${colW}" height="${h}" rx="4" fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="2" stroke-dasharray="${r.m <= lengthM ? "0" : "5 4"}" />
      <text x="${x + colW / 2}" y="${H - h - 16}" class="tw-emoji" text-anchor="middle">${r.emoji}</text>
      <text x="${x + colW / 2}" y="${H + 16}" class="tw-label" text-anchor="middle">${esc(r.short)}</text>
      <text x="${x + colW / 2}" y="${H + 30}" class="tw-h" text-anchor="middle">${fmt(r.m)} m${r.m <= lengthM ? " ✓" : ""}</text>
    </g>`;
  }
  return `
  <div class="tower-wrap">
  <svg viewBox="-10 -34 ${W + 20} ${H + 76}" class="tower-svg" style="min-width:${W + 20}px" role="img" aria-label="Glizzy stack height compared to landmarks">
    <defs>
      <linearGradient id="dogstack" x1="0" y1="1" x2="0" y2="0">
        <stop offset="0%" stop-color="#e25822"/>
        <stop offset="100%" stop-color="#ffa07a"/>
      </linearGradient>
    </defs>
    <line x1="-10" y1="${H}" x2="${W + 10}" y2="${H}" stroke="rgba(148,163,184,0.25)" stroke-width="1.5"/>
    ${cols}
  </svg>
  </div>`;
}

function poolSVG(fillFrac) {
  const pct = Math.min(1, fillFrac);
  const W = 320;
  const H = 130;
  const waterH = Math.max(4, Math.round((H - 26) * pct));
  return `
  <svg viewBox="0 0 ${W} ${H + 30}" class="pool-svg" role="img" aria-label="Olympic pool ${fmt(pct * 100)}% full">
    <path d="M8 8 L8 ${H} Q8 ${H + 12} 20 ${H + 12} L${W - 20} ${H + 12} Q${W - 8} ${H + 12} ${W - 8} ${H} L${W - 8} 8"
      fill="none" stroke="rgba(148,163,184,0.45)" stroke-width="3" stroke-linecap="round"/>
    <rect class="pool-water" x="11" y="${H + 9 - waterH}" width="${W - 22}" height="${waterH}" rx="6" fill="rgba(59,130,246,0.45)"/>
    <text x="${W / 2}" y="${H / 2}" text-anchor="middle" class="pool-label">${fmt(pct * 100)}% of an Olympic pool</text>
  </svg>`;
}

const EKG_PATH = "M0 40 L70 40 L84 40 L92 18 L102 58 L110 40 L150 40 L164 40 L172 20 L182 56 L190 40 L240 40 L254 40 L262 16 L272 60 L280 40 L340 40";

// ============================================================================
// Page
// ============================================================================

function renderNumbersPage(n) {
  const S = (v, d = 0, o = {}) => countup(v, { decimals: d, ...o });

  const glizzyConstants = [
    { text: `frank: ${FRANK_G} g beef, bun: ${BUN_G} g white — the standard grocery bun-length pack`, source: SRC.fdcFrank },
    { text: `per glizzy: ${fmt(GLIZZY.kcal)} kcal, ${GLIZZY.proteinG.toFixed(1)} g protein, ${GLIZZY.satfatG.toFixed(1)} g sat fat, ${fmt(GLIZZY.sodiumMg)} mg sodium, ${GLIZZY.cholMg.toFixed(0)} mg cholesterol`, source: SRC.fdcBun },
  ];

  const hero = `
  <section class="num-section" id="hero">
    <div class="num-inner">
      <div class="num-kicker reveal">Year of the Glizzy · by the numbers</div>
      <div class="num-headline num-headline-xl reveal">${S(n.netTotal)}</div>
      <div class="num-subline reveal">
        hot dogs eaten by ${fmt(n.participants)} people since January 1
        · <span class="text-accent-soft">${n.pace.p28.toFixed(1)}/day</span> pace
      </div>
      <div class="num-visual reveal">
        <div class="chart-wrap card p-4 sm:p-6">
          <div class="stat-label mb-3">The year so far — and where it's headed</div>
          <div style="position:relative;height:290px;"><canvas id="heroChart"></canvas></div>
        </div>
      </div>
      <div class="num-subline reveal">
        projected year-end: <span class="text-slate-100 font-semibold">~${fmt(n.projection.mid)}</span>
        <span class="ladder-dim">(range ${fmt(n.projection.low)} – ${fmt(n.projection.high)})</span>
      </div>
      <div class="reveal">${workPanel({
        formula: [
          `projected = net_total + pace × days_remaining`,
          `${fmt(n.netTotal)} + ${n.pace.p28.toFixed(2)}/day × ${n.daysRemaining} days ≈ ${fmt(n.projection.mid)}`,
        ],
        constants: [
          { text: `pace = trailing-28-day net rate (${n.pace.p28.toFixed(2)}/day); range uses trailing-14 (${n.pace.p14.toFixed(2)}) and YTD average (${n.pace.ytd.toFixed(2)})` },
          { text: `net total counts protests as negative — the community self-polices` },
        ],
        assumptions: [
          "All day boundaries are Pacific time, like everything else on this site.",
          "The projection assumes tomorrow resembles the last four weeks. Rally, and the number climbs.",
        ],
      })}</div>
      <div class="scroll-hint reveal">scroll ↓</div>
    </div>
  </section>`;

  const tower = section({
    id: "length",
    kicker: "laid end to end",
    headlineHTML: `${S(n.length.m, 0, { suffix: " m" })} <span class="num-unit">of hot dog</span>`,
    sublineHTML: `${fmt(n.netTotal)} glizzies × 6 inches each, stacked into the sky`,
    visualHTML: towerSVG(n.length.m, n.length.ladder),
    ladderBlock: ladderHTML(n.length.ladder, (r) => `${fmt(r.m)} m`),
    work: workPanel({
      formula: [`length = net_total × 0.1524 m`, `${fmt(n.netTotal)} × 6 in = ${fmt(n.length.m)} m`],
      constants: [{ text: "6 in (15.24 cm) per standard hot dog", source: SRC.nhdsc }],
      assumptions: ["Dogs stack tip-to-tip with no squish. Structural integrity not evaluated."],
    }),
  });

  const protein = section({
    id: "protein",
    kicker: "the body · protein",
    headlineHTML: `${S(n.protein.grams / 1000, 1, { suffix: " kg" })} <span class="num-unit">of protein</span>`,
    sublineHTML: `that's ${S(n.protein.breasts)} chicken breasts — or one adult's protein needs for ${fmt(n.protein.dvDays)} days`,
    visualHTML: unitGrid(n.protein.breasts, "🍗", "chicken breast", "chicken breasts"),
    work: workPanel({
      formula: [
        `protein = net_total × ${GLIZZY.proteinG.toFixed(2)} g = ${fmt(n.protein.grams / 1000, 1)} kg`,
        `breasts = protein ÷ ${CHICKEN_BREAST_PROTEIN_G} g`,
      ],
      constants: [
        ...glizzyConstants,
        { text: `${CHICKEN_BREAST_PROTEIN_G} g protein per average cooked skinless breast (172 g)`, source: SRC.fdcChicken },
        { text: `${PROTEIN_DV_G} g/day protein Daily Value`, source: SRC.fdaProtein },
      ],
    }),
  });

  const butter = section({
    id: "satfat",
    kicker: "the body · saturated fat",
    headlineHTML: `${S(n.satfat.sticks)} <span class="num-unit">sticks of butter</span>`,
    sublineHTML: `${fmt(n.satfat.grams / 1000, 1)} kg of saturated fat — the sat-fat payload of ${fmt(n.satfat.sticks)} full sticks`,
    visualHTML: unitGrid(n.satfat.sticks, "🧈", "stick", "sticks"),
    work: workPanel({
      formula: [
        `sat_fat = net_total × ${GLIZZY.satfatG.toFixed(2)} g = ${fmt(n.satfat.grams / 1000, 1)} kg`,
        `sticks = sat_fat ÷ ${BUTTER_STICK_SATFAT_G} g per stick`,
      ],
      constants: [
        ...glizzyConstants,
        { text: `a 113 g stick of butter carries ${BUTTER_STICK_SATFAT_G} g saturated fat`, source: SRC.fdcButter },
      ],
      assumptions: ["Sticks-of-butter is by saturated fat, not by weight — by weight it'd be ~2× worse. You're welcome."],
    }),
  });

  const salt = section({
    id: "sodium",
    kicker: "the body · sodium",
    headlineHTML: `${S(n.sodium.canisters, 1)} <span class="num-unit">canisters of salt</span>`,
    sublineHTML: `${fmt(n.sodium.mg / 1e6, 2)} kg of pure sodium = ${fmt(n.sodium.saltG / 1000, 1)} kg of table salt — ${fmt(n.sodium.dvDays)} person-days at the FDA daily limit`,
    visualHTML: unitGrid(n.sodium.canisters, "🧂", "canister", "canisters"),
    work: workPanel({
      formula: [
        `sodium = net_total × ${fmt(GLIZZY.sodiumMg)} mg = ${fmt(n.sodium.mg / 1e6, 2)} kg`,
        `salt = sodium × ${SALT_FROM_SODIUM} (NaCl is ~40% sodium)`,
        `canisters = salt ÷ ${MORTON_CANISTER_G} g`,
      ],
      constants: [
        ...glizzyConstants,
        { text: `classic 26 oz (737 g) round salt canister` },
        { text: `${fmt(SODIUM_DV_MG)} mg/day sodium limit`, source: SRC.fdaSodium },
      ],
    }),
  });

  const cardio = section({
    id: "cardio",
    kicker: "the cardiologist's note",
    tone: "tone-clinical",
    headlineHTML: `+${S(n.cardio.collectiveCholMgDl, 0, { suffix: " mg/dL" })} <span class="num-unit">collective serum cholesterol</span>`,
    sublineHTML: `summed across ${fmt(n.participants)} brave participants · average participant's coronary heart disease relative risk: <span class="text-accent-soft">+${n.cardio.chdRiskPct.toFixed(0)}%</span> while the pace holds`,
    visualHTML: `<svg viewBox="0 0 340 80" class="ekg-svg" role="img" aria-label="EKG trace"><path class="ekg" d="${EKG_PATH}" fill="none" stroke="#ff6b35" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
    work: workPanel({
      formula: [
        `per person: ΔChol = 1.35 × (2 × ΔS) + 1.5 × Δ√(dietary chol per 1,000 kcal)   (Keys equation)`,
        `ΔS = % of calories newly from sat fat = (dogs/day × ${GLIZZY.satfatG.toFixed(1)} g × 9 kcal) ÷ ${fmt(BASELINE_DIET_KCAL)} kcal`,
        `collective = Σ over every participant · CHD risk = 42% × (mean ${n.cardio.meanMeatGPerDay.toFixed(0)} g/day ÷ 50 g)`,
      ],
      constants: [
        { text: "serum-cholesterol prediction equation", source: SRC.keys },
        { text: "RR 1.42 per 50 g/day processed meat, linearly interpolated", source: SRC.micha },
      ],
      assumptions: [
        `Every glizzy is eaten ON TOP of an unchanged ${fmt(BASELINE_DIET_KCAL)} kcal, ${BASELINE_DIET_CHOL_MG} mg-cholesterol baseline diet. Nobody skipped dinner to make room; we know these people.`,
        "Collective mg/dL is a sum over individuals — medically meaningless, spiritually accurate.",
        "This is back-of-napkin epidemiology on a hot dog website, not medical advice.",
      ],
    }),
  });

  const wheat = section({
    id: "wheat",
    kicker: "the land",
    headlineHTML: `${S(n.wheat.sqft)} <span class="num-unit">sq ft of wheat field</span>`,
    sublineHTML: `the acreage needed to grow flour for ${fmt(n.netTotal)} buns`,
    visualHTML: unitGrid(n.wheat.sqft / 100, "🌾", "hundred square feet", "hundred square feet"),
    ladderBlock: ladderHTML(n.wheat.ladder, (r) => `${fmt(r.sqft)} sq ft`),
    work: workPanel({
      formula: [
        `wheat = buns × ${FLOUR_PER_BUN_G} g flour ÷ ${WHEAT_EXTRACTION} extraction = ${fmt(n.wheat.sqft / SQFT_PER_ACRE * WHEAT_G_PER_ACRE / 1000, 0)} kg`,
        `area = wheat ÷ ${fmt(WHEAT_G_PER_ACRE / 1000, 0)} kg/acre × ${fmt(SQFT_PER_ACRE)} sq ft`,
      ],
      constants: [
        { text: `${FLOUR_PER_BUN_G} g flour per ${BUN_G} g bun (the rest is water, sugar, fat)` },
        { text: `${Math.round(WHEAT_EXTRACTION * 100)}% white-flour milling extraction` },
        { text: "U.S. average wheat yield ≈ 50 bu/acre (3,000 lb)", source: SRC.nass },
      ],
    }),
  });

  const money = section({
    id: "money",
    kicker: "the wallet",
    headlineHTML: `${S(n.money.usd, 0, { prefix: "$" })} <span class="num-unit">grilled and swallowed</span>`,
    sublineHTML: `at grocery prices a glizzy costs almost exactly a dollar — the counter above is basically the counter at the top of the page`,
    ladderBlock: ladderHTML(n.money.ladder, (r) => `$${fmt(r.usd)}`),
    work: workPanel({
      formula: [
        `spent = net_total × $${GLIZZY.priceUsd.toFixed(2)}`,
        `$${GLIZZY.priceUsd.toFixed(2)} = $0.66 of frank + $0.33 of bun`,
      ],
      constants: [
        { text: "franks $5.22/lb — the government stopped tracking frankfurter prices in April 2022, presumably out of respect", source: SRC.bls },
        { text: "buns ≈ $2.64 per 8-pack, your grocery store's middle shelf" },
      ],
      assumptions: ["Everything home-grilled. Nobody paid stadium prices; we checked the archive."],
    }),
  });

  const treadmill = section({
    id: "exercise",
    kicker: "the treadmill",
    headlineHTML: `${S(n.exercise.marathons)} <span class="num-unit">marathons to burn off</span>`,
    sublineHTML: `${fmt(n.exercise.kcal)} kcal consumed — or a ${fmt(n.exercise.miles)}-mile walk`,
    visualHTML: unitGrid(n.exercise.marathons, "🏃", "marathon", "marathons"),
    ladderBlock: ladderHTML(n.exercise.ladder, (r) => `${fmt(r.mi)} miles walked`),
    work: workPanel({
      formula: [
        `kcal = net_total × ${fmt(GLIZZY.kcal)} kcal = ${fmt(n.exercise.kcal)}`,
        `marathons = kcal ÷ ${fmt(KCAL_PER_MARATHON)} · miles = kcal ÷ ${KCAL_PER_MILE_WALKED}`,
      ],
      constants: [
        ...glizzyConstants,
        { text: `${fmt(KCAL_PER_MARATHON)} kcal per marathon, ${KCAL_PER_MILE_WALKED} kcal per mile walked (155 lb adult)`, source: SRC.runcalc },
      ],
    }),
  });

  const chestnut = section({
    id: "chestnut",
    kicker: "the professional benchmark",
    headlineHTML: `${S(n.chestnut.units, 1)} <span class="num-unit">Chestnuts</span>`,
    sublineHTML: `1 Chestnut = 76 dogs in 10 minutes. Joey would need <span class="text-slate-100 font-semibold">${Math.floor(n.chestnut.joeyMinutes / 60)} h ${fmt(n.chestnut.joeyMinutes % 60)} min</span> of nonstop contest-pace eating to clear our year`,
    visualHTML: unitGrid(n.chestnut.units, "🏆", "Chestnut", "Chestnuts"),
    work: workPanel({
      formula: [
        `Chestnuts = net_total ÷ ${CHESTNUT_DOGS}`,
        `Joey time = Chestnuts × ${CHESTNUT_MINUTES} min = ${fmt(n.chestnut.joeyMinutes)} min`,
      ],
      constants: [{ text: "76 dogs in 10 minutes — Joey Chestnut's 2021 world record", source: SRC.nathans }],
      assumptions: ["Assumes Joey does not slow down. Historically a safe assumption."],
    }),
  });

  const planet = section({
    id: "planet",
    kicker: "the planet",
    headlineHTML: `${S(n.planet.pools, 2)} <span class="num-unit">Olympic pools of water</span>`,
    sublineHTML: `${fmt(n.planet.waterL / 1e6, 2)} million liters to raise the beef and grow the wheat — somewhere between
      <span class="text-slate-100 font-semibold">${fmt(n.planet.chatgptLow / 1e6)} million</span> and
      <span class="text-slate-100 font-semibold">${fmt(n.planet.chatgptHigh / 1e9, 1)} billion</span> ChatGPT queries,
      depending on whose math you trust · plus ${fmt(n.planet.co2Kg / 1000, 1)} t CO₂e ≈ ${fmt(n.planet.carMiles)} miles of driving`,
    visualHTML: poolSVG(n.planet.pools),
    ladderBlock: ladderHTML(n.planet.ladder, (r) => `${fmt(r.l / 1000)} m³`),
    work: workPanel({
      formula: [
        `water = beef_kg × ${fmt(WATER_L_PER_KG_BEEF)} L + wheat_kg × ${fmt(WATER_L_PER_KG_WHEAT)} L = ${fmt(n.planet.waterL / 1e6, 2)} ML`,
        `queries = water ÷ (${CHATGPT_ML_PER_QUERY_LOW} mL … ${CHATGPT_ML_PER_QUERY_HIGH} mL each)`,
        `CO₂e = beef_kg × ${CO2_KG_PER_KG_BEEF} kg · miles = CO₂e ÷ ${CAR_CO2_G_PER_MILE} g/mile`,
      ],
      constants: [
        { text: "15,400 L water per kg beef (global average, 94% rain)", source: SRC.waterFootprint },
        { text: "0.32 mL/query is OpenAI's cooling-only figure", source: SRC.altman },
        { text: "~30 mL/query is the UC Riverside lifecycle estimate — a 100× disagreement we are not qualified to referee", source: SRC.ucr },
        { text: `${CO2_KG_PER_KG_BEEF} kg CO₂e per kg — dairy-herd beef, because hot dogs are made of trimmings, not wagyu`, source: SRC.poore },
        { text: "400 g CO₂ per mile, average passenger car", source: SRC.epaCar },
      ],
    }),
  });

  const outro = `
  <section class="num-section" id="outro">
    <div class="num-inner text-center">
      <div class="num-kicker reveal">the year is ${Math.round((n.daysElapsed / 365) * 100)}% over</div>
      <div class="num-subline reveal">and the glizzies are ${Math.round((n.netTotal / n.projection.mid) * 100)}% eaten. See you at ~${fmt(n.projection.mid)}.</div>
      <div class="reveal mt-6"><a href="/" class="text-accent hover:text-accent-soft">← back to the dashboard</a></div>
    </div>
  </section>`;

  const pageData = {
    series: n.series,
    netTotal: n.netTotal,
    todayKey: n.todayKey,
    daysElapsed: n.daysElapsed,
    projection: n.projection,
  };
  const dataJson = JSON.stringify(pageData).replace(/</g, "\\u003c");

  return `<!doctype html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hot Dogs by the Numbers · Hot Dog Hub</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8C%AD%3C/text%3E%3C/svg%3E">
<meta property="og:site_name" content="Year of the Glizzy">
<meta property="og:title" content="Hot Dogs by the Numbers">
<meta property="og:description" content="${esc(`${fmt(n.netTotal)} hot dogs and counting. The protein, the butter, the buildings, the damage.`)}">
<script>window.PAGE_DATA = ${dataJson};</script>
<script src="https://cdn.tailwindcss.com"></script>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/gsap.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/gsap/3.12.5/ScrollTrigger.min.js"></script>
<script>
  tailwind.config = {
    theme: {
      extend: {
        colors: { accent: { DEFAULT: '#ff6b35', soft: '#ffa07a', deep: '#e25822' } },
        fontFamily: { sans: ['Inter', 'ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'] },
      },
    },
  };
</script>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">
<style>
  html { overflow-x: clip; scroll-behavior: smooth; }
  body { background:#020617; color:#e2e8f0; font-feature-settings: "cv11", "ss03"; max-width:100vw; }
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; min-width:0; }
  .stat-label { color:#94a3b8; font-size:11px; letter-spacing:0.12em; text-transform:uppercase; font-weight:600; }

  .num-section {
    min-height: 92vh;
    display: flex; align-items: center; justify-content: center;
    padding: 4.5rem 1rem;
    border-bottom: 1px solid rgba(148,163,184,0.06);
  }
  .num-inner { width: 100%; max-width: 46rem; }
  .num-kicker { color:#94a3b8; font-size:12px; letter-spacing:0.18em; text-transform:uppercase; font-weight:600; margin-bottom:0.9rem; }
  .num-headline { font-size: clamp(2.6rem, 8vw, 4.6rem); font-weight: 800; line-height: 1.05; color:#f8fafc; letter-spacing:-0.02em; font-variant-numeric: tabular-nums; }
  .num-headline-xl { font-size: clamp(4rem, 14vw, 8rem); color:#ff6b35; }
  .num-unit { display:block; font-size: clamp(1.1rem, 3vw, 1.5rem); font-weight:600; color:#94a3b8; letter-spacing:0; margin-top:0.3rem; }
  .num-subline { color:#cbd5e1; margin-top: 1rem; max-width: 40rem; line-height:1.6; }
  .num-visual { margin-top: 1.6rem; }
  .num-ladder { margin-top: 1.4rem; font-size: 0.95rem; }
  .tone-clinical .num-headline { color:#ffa07a; }

  .ladder-conquered { color:#a7f3d0; }
  .ladder-dim { color:#64748b; font-size: 0.85rem; }
  .ladder-next { margin-top: 0.6rem; color:#e2e8f0; }
  .ladder-bar { height: 8px; background: rgba(30,41,59,0.9); border-radius: 999px; overflow: hidden; margin: 0.45rem 0 0.3rem; }
  .ladder-fill { height: 100%; border-radius: 999px; background: linear-gradient(90deg, #e25822, #ff6b35, #ffa07a); }

  .pict-grid { display:flex; flex-wrap:wrap; gap:2px; font-size:26px; line-height:1; max-width:36rem; }
  .pict { display:inline-block; }
  .pict-partial { position:relative; }
  .pict-partial > span { display:inline-block; overflow:hidden; white-space:nowrap; opacity:0.9; }
  .pict-caption { color:#64748b; font-size:0.8rem; margin-top:0.5rem; }

  .work { margin-top: 1.4rem; font-size: 0.9rem; }
  .work summary { cursor:pointer; color:#94a3b8; list-style:none; user-select:none; }
  .work summary::-webkit-details-marker { display:none; }
  .work summary:hover { color:#e2e8f0; }
  .work[open] summary { color:#ffa07a; }
  .work-body { margin-top: 0.8rem; background:#0b1220; border:1px solid rgba(148,163,184,0.1); border-radius:12px; padding:1rem 1.2rem; }
  .work-formula { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:0.82rem; color:#cbd5e1; line-height:1.8; overflow-x:auto; }
  .work-h { color:#94a3b8; font-size:10px; letter-spacing:0.14em; text-transform:uppercase; font-weight:700; margin:0.9rem 0 0.3rem; }
  .work-body ul { list-style:none; padding:0; }
  .work-body li { color:#94a3b8; font-size:0.82rem; line-height:1.7; }
  .work-body li::before { content:"· "; color:#475569; }
  .work-body a { color:#ffa07a; text-decoration:underline; text-decoration-color:rgba(255,160,122,0.35); }
  .work-body a:hover { color:#ff6b35; }

  .tower-wrap { overflow-x:auto; padding-bottom:4px; }
  .tower-svg { width:100%; max-width:34rem; height:auto; overflow:visible; }
  .ladder-prior { margin-top:0.55rem; display:flex; flex-wrap:wrap; gap:6px; align-items:center; color:#64748b; font-size:0.8rem; }
  .ladder-chip { display:inline-block; background:rgba(30,41,59,0.7); border:1px solid rgba(148,163,184,0.12); border-radius:999px; padding:2px 10px; color:#a7f3d0; font-size:0.78rem; white-space:nowrap; }
  .tw-label { fill:#94a3b8; font-size:11px; font-weight:600; }
  .tw-h { fill:#64748b; font-size:10px; }
  .tw-emoji { font-size:18px; }
  .pool-svg { width:100%; max-width:22rem; height:auto; }
  .pool-label { fill:#cbd5e1; font-size:13px; font-weight:600; }
  .ekg-svg { width:100%; max-width:22rem; height:auto; }
  .scroll-hint { color:#475569; font-size:0.8rem; margin-top:2.2rem; letter-spacing:0.1em; }

  @media (prefers-reduced-motion: reduce) {
    html { scroll-behavior:auto; }
  }
</style>
</head>
<body class="font-sans antialiased">
${renderNav("numbers")}
<main>
  ${hero}
  ${tower}
  ${protein}
  ${butter}
  ${salt}
  ${cardio}
  ${wheat}
  ${money}
  ${treadmill}
  ${chestnut}
  ${planet}
  ${outro}
</main>
<footer class="border-t border-slate-800/80 py-6 text-center text-xs text-slate-500">
  🌭 every number recomputed from the live database on page load · <a href="/" class="hover:text-slate-300">Hot Dog Hub</a>
</footer>
<script>
(function () {
  var D = window.PAGE_DATA;
  var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // ---- hero chart: cumulative + projection fan ----
  var start = new Date(D.series.startKey + 'T12:00:00Z');
  var labels = [];
  var actual = [];
  var mid = [];
  var lo = [];
  var hi = [];
  var cum = 0;
  var DAY = 86400000;
  var yearDays = Math.round((new Date('2026-12-31T12:00:00Z') - start) / DAY) + 1;
  var todayIdx = D.series.dailyNet.length - 1;
  var remaining = yearDays - 1 - todayIdx;
  for (var i = 0; i < yearDays; i++) {
    var d = new Date(start.getTime() + i * DAY);
    labels.push((d.getUTCMonth() + 1) + '/' + d.getUTCDate());
    if (i <= todayIdx) {
      cum += D.series.dailyNet[i];
      actual.push(cum);
      mid.push(i === todayIdx ? cum : null);
      lo.push(i === todayIdx ? cum : null);
      hi.push(i === todayIdx ? cum : null);
    } else {
      var t = (i - todayIdx) / remaining;
      actual.push(null);
      mid.push(Math.round(D.netTotal + (D.projection.mid - D.netTotal) * t));
      lo.push(Math.round(D.netTotal + (D.projection.low - D.netTotal) * t));
      hi.push(Math.round(D.netTotal + (D.projection.high - D.netTotal) * t));
    }
  }
  var MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  var endLabels = {
    id: 'endLabels',
    afterDatasetsDraw: function (chart) {
      var ctx = chart.ctx;
      ctx.save();
      ctx.font = '600 11px Inter, sans-serif';
      ctx.textAlign = 'right';
      var mActual = chart.getDatasetMeta(0);
      var pt = mActual.data[todayIdx];
      if (pt) {
        ctx.fillStyle = '#ff6b35';
        ctx.fillText('today: ' + D.netTotal.toLocaleString(), pt.x - 6, pt.y - 8);
      }
      var mMid = chart.getDatasetMeta(1);
      var end = mMid.data[mMid.data.length - 1];
      if (end) {
        ctx.fillStyle = '#ffa07a';
        ctx.fillText('~' + D.projection.mid.toLocaleString() + ' by Dec 31', end.x, end.y - 10);
      }
      ctx.restore();
    },
  };
  var canvas = document.getElementById('heroChart');
  if (canvas && window.Chart) {
    new Chart(canvas, {
      type: 'line',
      plugins: [endLabels],
      data: {
        labels: labels,
        datasets: [
          { data: actual, borderColor: '#ff6b35', borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, pointHoverBackgroundColor: '#ff6b35', tension: 0, spanGaps: false },
          { data: mid, borderColor: '#ff6b35', borderWidth: 2, borderDash: [6, 4], pointRadius: 0, pointHoverRadius: 0, tension: 0 },
          { data: hi, borderWidth: 0, pointRadius: 0, pointHoverRadius: 0, fill: 3, backgroundColor: 'rgba(255,107,53,0.10)' },
          { data: lo, borderWidth: 0, pointRadius: 0, pointHoverRadius: 0 },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: reduced ? false : { duration: 900, easing: 'easeOutQuart' },
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { display: false },
          tooltip: {
            backgroundColor: '#0b1220',
            borderColor: 'rgba(148,163,184,0.2)',
            borderWidth: 1,
            titleColor: '#e2e8f0',
            bodyColor: '#cbd5e1',
            displayColors: false,
            callbacks: {
              title: function (items) { return items.length ? items[0].label : ''; },
              label: function (item) {
                if (item.datasetIndex === 0) {
                  var daily = D.series.dailyNet[item.dataIndex] || 0;
                  return item.parsed.y.toLocaleString() + ' total' + (daily ? ' (+' + daily + ' that day)' : '');
                }
                if (item.datasetIndex === 1) return 'projected: ' + item.parsed.y.toLocaleString();
                return null;
              },
            },
          },
        },
        scales: {
          x: {
            grid: { display: false },
            border: { color: 'rgba(148,163,184,0.15)' },
            ticks: {
              color: '#64748b',
              maxRotation: 0,
              autoSkip: false,
              callback: function (v) {
                var l = this.getLabelForValue(v);
                var p = l.split('/');
                if (p[1] !== '1') return null;
                // narrow screens: every other month, or the labels touch
                if (this.chart.width < 520 && p[0] % 2 === 0) return null;
                return MONTHS[p[0] - 1];
              },
            },
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(148,163,184,0.08)' },
            border: { display: false },
            ticks: { color: '#64748b', callback: function (v) { return v.toLocaleString(); } },
          },
        },
      },
    });
  }

  // ---- scroll-triggered reveals + count-ups ----
  var fmtNum = function (v, dec) {
    return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
  };
  if (reduced || !window.gsap) return; // SSR values already in place — done.
  gsap.registerPlugin(ScrollTrigger);

  document.querySelectorAll('.num-section').forEach(function (sec) {
    var reveals = sec.querySelectorAll('.reveal');
    gsap.set(reveals, { opacity: 0, y: 26 });
    gsap.to(reveals, {
      opacity: 1, y: 0, duration: 0.7, stagger: 0.12, ease: 'power2.out',
      scrollTrigger: { trigger: sec, start: 'top 62%', once: true },
    });

    sec.querySelectorAll('.countup').forEach(function (el) {
      var target = parseFloat(el.dataset.value);
      var dec = parseInt(el.dataset.decimals, 10) || 0;
      var pre = el.dataset.prefix || '';
      var suf = el.dataset.suffix || '';
      var state = { v: 0 };
      el.textContent = pre + fmtNum(0, dec) + suf;
      gsap.to(state, {
        v: target, duration: 1.8, ease: 'power2.out',
        onUpdate: function () { el.textContent = pre + fmtNum(state.v, dec) + suf; },
        onComplete: function () { el.textContent = pre + fmtNum(target, dec) + suf; },
        scrollTrigger: { trigger: sec, start: 'top 62%', once: true },
      });
    });

    sec.querySelectorAll('.pict').forEach(function (p, i) {
      gsap.set(p, { opacity: 0, scale: 0.4 });
      gsap.to(p, {
        opacity: 1, scale: 1, duration: 0.3, ease: 'back.out(2)', delay: Math.min(i * 0.012, 1.2),
        scrollTrigger: { trigger: sec, start: 'top 55%', once: true },
      });
    });

    sec.querySelectorAll('.ladder-fill').forEach(function (bar) {
      var pct = bar.dataset.pct;
      gsap.set(bar, { width: 0 });
      gsap.to(bar, {
        width: pct + '%', duration: 1.1, ease: 'power2.out', delay: 0.4,
        scrollTrigger: { trigger: sec, start: 'top 55%', once: true },
      });
    });
  });

  // The Tower grows with scroll on wider screens; on phones it just reveals.
  ScrollTrigger.matchMedia({
    '(min-width: 768px)': function () {
      var us = document.querySelector('.tower-us');
      if (!us) return;
      gsap.from(us, {
        scaleY: 0, transformOrigin: 'bottom', ease: 'none',
        scrollTrigger: { trigger: '#length', start: 'top 80%', end: 'center 45%', scrub: 0.5 },
      });
    },
  });

  // EKG draws itself when the cardiology section arrives.
  var ekg = document.querySelector('.ekg');
  if (ekg) {
    var len = ekg.getTotalLength();
    gsap.set(ekg, { strokeDasharray: len, strokeDashoffset: len });
    gsap.to(ekg, {
      strokeDashoffset: 0, duration: 2.2, ease: 'none',
      scrollTrigger: { trigger: '#cardio', start: 'top 60%', once: true },
    });
  }
})();
</script>
</body>
</html>`;
}

// ============================================================================
// Registration
// ============================================================================

export function registerNumbers(app) {
  app.get("/numbers", (req, res) => {
    res.send(renderNumbersPage(computeNumbers()));
  });
}
