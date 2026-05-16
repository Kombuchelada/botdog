import {
  db,
  getAllEventsStmt,
  getUserTotalStmt,
  upsertGameStateStmt,
  getGameStateStmt,
  topByLifetimeStmt,
} from "./database.js";
import {
  buildUserDatesMap,
  getCurrentStreak,
  toPacificDateKey,
  parseUtcTimestamp,
} from "./stats.js";

// ============================================================================
// Game definitions
// ============================================================================

export const BUILDINGS = [
  { id: "mustard_stand", name: "Mustard Stand", emoji: "🌭", base_cost: 15, base_rate: 0.1 },
  { id: "bun_factory", name: "Bun Factory", emoji: "🍞", base_cost: 100, base_rate: 1.0 },
  { id: "glizzy_cart", name: "Glizzy Cart", emoji: "🛒", base_cost: 1100, base_rate: 8.0 },
  { id: "food_truck", name: "Food Truck", emoji: "🚚", base_cost: 12000, base_rate: 47.0 },
  { id: "stadium", name: "Stadium Vendor", emoji: "🏟️", base_cost: 130000, base_rate: 260.0 },
];

const BUILDING_IDS = BUILDINGS.map((b) => b.id);
const COST_SCALE = 1.15;

export const UPGRADES = [
  { id: "sharper_knife", name: "Sharper Knife", emoji: "🔪", cost: 100,
    description: "Doubles your click power.",
    effect: { type: "click_mult", value: 2 } },
  { id: "better_mustard", name: "Better Mustard", emoji: "🟡", cost: 1000,
    description: "Mustard Stand production ×2.",
    effect: { type: "building_mult", building: "mustard_stand", value: 2 } },
  { id: "fresh_buns", name: "Fresh Buns", emoji: "🌾", cost: 11000,
    description: "Bun Factory production ×2.",
    effect: { type: "building_mult", building: "bun_factory", value: 2 } },
  { id: "premium_cart", name: "Premium Cart", emoji: "🛍️", cost: 120000,
    description: "Glizzy Cart production ×2.",
    effect: { type: "building_mult", building: "glizzy_cart", value: 2 } },
  { id: "fancy_truck", name: "Fancy Truck", emoji: "🏎️", cost: 1300000,
    description: "Food Truck production ×2.",
    effect: { type: "building_mult", building: "food_truck", value: 2 } },
  { id: "sponsorship_deal", name: "Sponsorship Deal", emoji: "💼", cost: 14000000,
    description: "Stadium Vendor production ×2.",
    effect: { type: "building_mult", building: "stadium", value: 2 } },
  { id: "faster_hands", name: "Faster Hands", emoji: "⚡", cost: 50000,
    description: "Click power ×4 (stacks with Sharper Knife).",
    effect: { type: "click_mult", value: 4 } },
  { id: "brand_loyalty", name: "Brand Loyalty", emoji: "🤝", cost: 500000,
    description: "All production +10% (multiplicative).",
    effect: { type: "global_mult", value: 1.1 } },
  { id: "ketchup_sin", name: "Ketchup Sin", emoji: "🍅", cost: 100000,
    description: "Click power gains +0.01 per building owned (additive). Scales with your building count.",
    effect: { type: "click_per_building", value: 0.01 } },
  { id: "hot_dog_pope", name: "Hot Dog Pope", emoji: "⛪", cost: 50000000,
    description: "Doubles everything — all buildings AND click power. The endgame.",
    effect: { type: "global_mult", value: 2 } },
];

const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

const MAX_CLICKS_PER_SECOND = 25;
const OFFLINE_CAP_SECONDS = 4 * 60 * 60;
const CLAMP_OVERAGE_FACTOR = 1.2;

// ============================================================================
// Default / blank state
// ============================================================================

function blankState() {
  const buildings = Object.fromEntries(BUILDING_IDS.map((id) => [id, 0]));
  return {
    glizzies: 0,
    lifetime: 0,
    total_clicks: 0,
    buildings,
    upgrades_owned: [],
    last_seen_at: new Date().toISOString(),
  };
}

// ============================================================================
// Bonuses
// ============================================================================

/**
 * Static catalogue of every bonus the game knows about — used both by
 * computeBonuses (to figure out which are active) and by the UI (to show
 * locked bonuses with their trigger so players know how to earn them).
 */
export const ALL_BONUSES = [
  {
    id: "big_eater",
    emoji: "🍽️",
    name: "Big Eater",
    description: "+0.25× click power",
    trigger: "Eat more than 4 hot dogs in a single Pacific day",
    duration: "24 hours after a qualifying day",
  },
  {
    id: "breakfast_boon",
    emoji: "🌅",
    name: "Breakfast Boon",
    description: "Mustard Stand production +50%",
    trigger: "Log a hot dog before 8 AM Pacific",
    duration: "24 hours after a qualifying day",
  },
  {
    id: "night_owl",
    emoji: "🦉",
    name: "Night Owl",
    description: "Glizzy Cart production +50%",
    trigger: "Log a hot dog at or after 10 PM Pacific",
    duration: "24 hours after a qualifying day",
  },
  {
    id: "streak",
    emoji: "🔥",
    name: "Streak (uncapped)",
    description: "+2% production per consecutive day — no cap, scales forever",
    trigger: "Maintain a hot dog eating streak of 3 or more days",
    duration: "While the streak is alive",
  },
  {
    id: "centurion",
    emoji: "💯",
    name: "Centurion",
    description: "+10% all production (permanent)",
    trigger: "Eat 100 lifetime hot dogs",
    duration: "Permanent (replaced by higher tier)",
  },
  {
    id: "half_grand",
    emoji: "🏆",
    name: "Half-Grand",
    description: "+25% all production (permanent)",
    trigger: "Eat 500 lifetime hot dogs",
    duration: "Permanent (replaces Centurion)",
  },
  {
    id: "glizzy_pope",
    emoji: "👑",
    name: "Glizzy Pope",
    description: "+50% all production (permanent)",
    trigger: "Eat 1,000 lifetime hot dogs",
    duration: "Permanent (replaces Half-Grand)",
  },
];

const BONUS_DEF_BY_ID = new Map(ALL_BONUSES.map((b) => [b.id, b]));

// ============================================================================
// Bonus computation from hotdog_events
// ============================================================================

const PACIFIC_HOUR = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  hour: "numeric",
  hour12: false,
});

function pacificHour(date) {
  const parts = PACIFIC_HOUR.formatToParts(date);
  let h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  if (h === 24) h = 0;
  return h;
}

function yesterdayPacificKey(now = new Date()) {
  const todayKey = toPacificDateKey(now);
  const d = new Date(todayKey + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return toPacificDateKey(d);
}

export function computeBonuses(userId) {
  const allEvents = getAllEventsStmt.all();
  const userEvents = allEvents.filter((e) => e.user_id === userId && e.amount > 0);
  const yesterday = yesterdayPacificKey();
  const yesterdayEvents = userEvents.filter(
    (e) => toPacificDateKey(parseUtcTimestamp(e.timestamp)) === yesterday,
  );
  const yesterdayTotal = yesterdayEvents.reduce((s, e) => s + e.amount, 0);
  const hadEarlyDog = yesterdayEvents.some((e) => pacificHour(parseUtcTimestamp(e.timestamp)) < 8);
  const hadLateDog = yesterdayEvents.some((e) => pacificHour(parseUtcTimestamp(e.timestamp)) >= 22);

  const datesMap = buildUserDatesMap(allEvents);
  const streak = getCurrentStreak(datesMap.get(userId) || new Set());

  const userTotal = getUserTotalStmt.get(userId)?.total_count || 0;

  const active = [];

  function activate(id, overrides) {
    const def = BONUS_DEF_BY_ID.get(id);
    active.push({ ...def, ...overrides });
  }

  if (yesterdayTotal > 4) {
    activate("big_eater", {
      explanation: `Ate ${yesterdayTotal} dogs yesterday`,
      effect: { type: "click_mult", value: 1.25 },
    });
  }
  if (hadEarlyDog) {
    activate("breakfast_boon", {
      explanation: "Ate a dog before 8 AM yesterday",
      effect: { type: "building_mult", building: "mustard_stand", value: 1.5 },
    });
  }
  if (hadLateDog) {
    activate("night_owl", {
      explanation: "Ate a dog after 10 PM yesterday",
      effect: { type: "building_mult", building: "glizzy_cart", value: 1.5 },
    });
  }
  if (streak >= 3) {
    activate("streak", {
      name: `Streak ×${streak}`,
      explanation: `${streak}-day active streak (+${streak * 2}% production)`,
      effect: { type: "global_mult", value: 1 + streak * 0.02 },
    });
  }
  // Permanent milestones: only the highest tier applies.
  if (userTotal >= 1000) {
    activate("glizzy_pope", {
      explanation: `${userTotal} lifetime dogs`,
      effect: { type: "global_mult", value: 1.5 },
    });
  } else if (userTotal >= 500) {
    activate("half_grand", {
      explanation: `${userTotal} lifetime dogs`,
      effect: { type: "global_mult", value: 1.25 },
    });
  } else if (userTotal >= 100) {
    activate("centurion", {
      explanation: `${userTotal} lifetime dogs`,
      effect: { type: "global_mult", value: 1.1 },
    });
  }

  return active;
}

// ============================================================================
// Effective rates with bonuses + upgrades applied
// ============================================================================

export function computeEffectiveRates(state, bonuses) {
  // Click power
  let clickPower = 1;
  let clickAdditive = 0;
  let globalMult = 1;
  const buildingMult = Object.fromEntries(BUILDING_IDS.map((id) => [id, 1]));

  // Owned upgrades
  for (const upId of state.upgrades_owned || []) {
    const up = UPGRADE_BY_ID.get(upId);
    if (!up) continue;
    const e = up.effect;
    if (e.type === "click_mult") clickPower *= e.value;
    else if (e.type === "building_mult") buildingMult[e.building] *= e.value;
    else if (e.type === "global_mult") globalMult *= e.value;
    else if (e.type === "click_per_building") {
      const totalBuildings = BUILDING_IDS.reduce((s, b) => s + (state.buildings?.[b] || 0), 0);
      clickAdditive += totalBuildings * e.value;
    }
  }

  // Active bonuses (same shape, applied multiplicatively on top)
  for (const b of bonuses) {
    const e = b.effect;
    if (e.type === "click_mult") clickPower *= e.value;
    else if (e.type === "building_mult") buildingMult[e.building] *= e.value;
    else if (e.type === "global_mult") globalMult *= e.value;
  }

  const effectivePerClick = (clickPower + clickAdditive) * globalMult;

  let perSecond = 0;
  const buildingProduction = {};
  for (const b of BUILDINGS) {
    const owned = state.buildings?.[b.id] || 0;
    const rate = owned * b.base_rate * buildingMult[b.id] * globalMult;
    buildingProduction[b.id] = rate;
    perSecond += rate;
  }

  return { perClick: effectivePerClick, perSecond, buildingProduction };
}

// ============================================================================
// Building cost calculator
// ============================================================================

export function buildingCost(buildingId, owned) {
  const b = BUILDINGS.find((x) => x.id === buildingId);
  if (!b) return Infinity;
  return Math.ceil(b.base_cost * Math.pow(COST_SCALE, owned));
}

// ============================================================================
// Offline production
// ============================================================================

function computeOfflineEarned(state, perSecond) {
  if (!state.last_seen_at) return 0;
  const elapsedMs = Date.now() - new Date(state.last_seen_at).getTime();
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return 0;
  const elapsedSec = Math.min(elapsedMs / 1000, OFFLINE_CAP_SECONDS);
  return Math.floor(perSecond * elapsedSec);
}

// ============================================================================
// Load / save
// ============================================================================

function readStateFromDb(userId) {
  const row = getGameStateStmt.get(userId);
  if (!row) return null;
  try {
    return JSON.parse(row.state);
  } catch {
    return null;
  }
}

function writeStateToDb(userId, state) {
  upsertGameStateStmt.run(userId, JSON.stringify(state), Math.floor(state.lifetime || 0));
}

/**
 * Load (or initialize) a user's state and compute current bonuses + offline production.
 * The caller is expected to send `offline_earned` to the client; we do NOT auto-credit
 * here — the client confirms acceptance via the next save (last_seen_at gets updated).
 */
export function loadGameForUser(userId) {
  let state = readStateFromDb(userId);
  let isNew = false;
  if (!state) {
    state = blankState();
    isNew = true;
    writeStateToDb(userId, state);
  }
  const bonuses = computeBonuses(userId);
  const rates = computeEffectiveRates(state, bonuses);
  const offlineEarned = isNew ? 0 : computeOfflineEarned(state, rates.perSecond);
  return { state, bonuses, rates, offlineEarned, isNew };
}

// ============================================================================
// Anti-cheat validation (server-authoritative basics)
// ============================================================================

function isNonNegFinite(n) {
  return Number.isFinite(n) && n >= 0;
}

function isNonNegInt(n) {
  return Number.isInteger(n) && n >= 0;
}

/**
 * Validate and clamp a save payload against the previous server-side state.
 * Returns the canonical state to persist. Never throws — silently clamps and logs.
 */
export function validateAndClampSave(userId, incoming) {
  const previous = readStateFromDb(userId) || blankState();
  const out = blankState();
  const prevGlizzies = previous.glizzies || 0;
  const prevClicks = previous.total_clicks || 0;
  const prevSeen = previous.last_seen_at ? new Date(previous.last_seen_at).getTime() : Date.now();
  const elapsedSec = Math.max(1, (Date.now() - prevSeen) / 1000);

  // ----- 1. Clicks: cannot regress; click delta capped at MAX_CLICKS_PER_SECOND * elapsed
  let incomingClicks = isNonNegFinite(incoming?.total_clicks) ? Math.floor(incoming.total_clicks) : prevClicks;
  if (incomingClicks < prevClicks) incomingClicks = prevClicks;
  const maxClickDelta = Math.ceil(MAX_CLICKS_PER_SECOND * elapsedSec) + 5;
  const clickDelta = Math.min(incomingClicks - prevClicks, maxClickDelta);
  out.total_clicks = prevClicks + clickDelta;

  // ----- 2. Tentative building/upgrade purchases (monotonic only — affordability check next)
  for (const id of BUILDING_IDS) {
    let v = incoming?.buildings?.[id];
    if (!isNonNegInt(v)) v = previous.buildings[id] || 0;
    if (v < (previous.buildings[id] || 0)) v = previous.buildings[id];
    out.buildings[id] = v;
  }
  const incomingUp = Array.isArray(incoming?.upgrades_owned) ? incoming.upgrades_owned : [];
  const upSet = new Set(previous.upgrades_owned || []);
  for (const id of incomingUp) {
    if (UPGRADE_BY_ID.has(id)) upSet.add(id);
  }
  out.upgrades_owned = Array.from(upSet);

  // ----- 3. Earning budget: must be computed from the PREVIOUS state's rates.
  // Buildings/upgrades purchased *this* tick weren't producing during it, so
  // the cap on earnings is what the player could have made before the buys.
  // (This is also what blocks cheaters from claiming a giant building count
  // and reaping its production in the same tick.)
  const bonuses = computeBonuses(userId);
  const ratesPrev = computeEffectiveRates(previous, bonuses);
  const maxEarnedSincePrev = Math.ceil(
    ratesPrev.perSecond * Math.min(elapsedSec, OFFLINE_CAP_SECONDS) +
      clickDelta * ratesPrev.perClick * 1.5,
  );
  const budget = prevGlizzies + maxEarnedSincePrev * CLAMP_OVERAGE_FACTOR;

  // ----- 4. Cost of tentative purchases (closed-form geometric series)
  let buildingCostDelta = 0;
  for (const b of BUILDINGS) {
    const prevCount = previous.buildings[b.id] || 0;
    const nextCount = out.buildings[b.id];
    if (nextCount <= prevCount) continue;
    // Sum_{i=prevCount}^{nextCount-1} base * COST_SCALE^i
    //   = base * (COST_SCALE^nextCount - COST_SCALE^prevCount) / (COST_SCALE - 1)
    const delta = (Math.pow(COST_SCALE, nextCount) - Math.pow(COST_SCALE, prevCount)) / (COST_SCALE - 1);
    buildingCostDelta += b.base_cost * delta;
  }
  let upgradeCostDelta = 0;
  for (const upId of out.upgrades_owned) {
    if (!(previous.upgrades_owned || []).includes(upId)) {
      upgradeCostDelta += UPGRADE_BY_ID.get(upId)?.cost || 0;
    }
  }
  const totalSpending = buildingCostDelta + upgradeCostDelta;

  // ----- 5. If they can't afford the purchases, revert (no half-purchases — keep it simple)
  if (totalSpending > budget) {
    console.warn(`[glizzy] rejected purchases for ${userId}: total ${totalSpending} > budget ${Math.floor(budget)}`);
    for (const id of BUILDING_IDS) out.buildings[id] = previous.buildings[id] || 0;
    out.upgrades_owned = previous.upgrades_owned || [];
  }

  // Recompute spending after possible revert (in case we reverted to 0 delta)
  const finalSpending = totalSpending > budget ? 0 : totalSpending;

  // ----- 6. Glizzies: must equal budget - spending, ceiling-clamped
  let incomingGlizzies = isNonNegFinite(incoming?.glizzies) ? incoming.glizzies : previous.glizzies;
  const glizzyCeiling = Math.max(0, budget - finalSpending);
  if (incomingGlizzies > glizzyCeiling) {
    console.warn(`[glizzy] clamping glizzies for ${userId}: claimed ${incomingGlizzies}, ceiling ${Math.floor(glizzyCeiling)}`);
    incomingGlizzies = glizzyCeiling;
  }
  out.glizzies = Math.floor(Math.max(0, incomingGlizzies));

  // ----- 7. Lifetime: server-derived, never trust the client's claimed lifetime.
  //          New lifetime = previous + clamped earnings this tick.
  //          Earnings = (glizzies gained) + (spending we approved). Both already clamped.
  const earningsThisTick = Math.max(0, out.glizzies - prevGlizzies) + finalSpending;
  const cappedEarnings = Math.min(earningsThisTick, maxEarnedSincePrev);
  out.lifetime = Math.max(previous.lifetime || 0, (previous.lifetime || 0) + cappedEarnings);

  out.last_seen_at = new Date().toISOString();
  writeStateToDb(userId, out);
  return { state: out, bonuses, rates: computeEffectiveRates(out, bonuses) };
}

// ============================================================================
// Leaderboard
// ============================================================================

export function getLeaderboardRows(limit = 50) {
  const rows = topByLifetimeStmt.all(limit);
  return rows.map((row) => {
    let state = {};
    try { state = JSON.parse(row.state); } catch {}
    return {
      user_id: row.user_id,
      lifetime: Number(row.lifetime_glizzies) || 0,
      current: state.glizzies || 0,
      total_clicks: state.total_clicks || 0,
      total_buildings: BUILDING_IDS.reduce((s, id) => s + (state.buildings?.[id] || 0), 0),
      updated_at: row.updated_at,
    };
  });
}

/**
 * Pure helper for the /glizzy me Discord command.
 */
export function getPlayerSummary(userId) {
  const state = readStateFromDb(userId);
  const bonuses = computeBonuses(userId);
  if (!state) return { exists: false, bonuses };
  const rates = computeEffectiveRates(state, bonuses);
  const totalBuildings = BUILDING_IDS.reduce((s, id) => s + (state.buildings?.[id] || 0), 0);
  // Find top-producing building
  let topBuilding = null;
  let topProduction = 0;
  for (const b of BUILDINGS) {
    const prod = rates.buildingProduction[b.id];
    if (prod > topProduction) {
      topProduction = prod;
      topBuilding = b;
    }
  }
  return {
    exists: true,
    state,
    bonuses,
    rates,
    totalBuildings,
    topBuilding,
    topProduction,
  };
}
