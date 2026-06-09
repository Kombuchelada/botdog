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
  { id: "mustard_stand", name: "Mustard Stand", emoji: "🌭", base_cost: 15, base_rate: 0.1,
    description: "A humble corner stand. The classic. Boosted by Breakfast Boon (eat a dog before 8 AM)." },
  { id: "bun_factory", name: "Bun Factory", emoji: "🍞", base_cost: 100, base_rate: 1.0,
    description: "Industrial-scale bun production. A reliable steady earner. Buffed only by global multipliers." },
  { id: "glizzy_cart", name: "Glizzy Cart", emoji: "🛒", base_cost: 1100, base_rate: 8.0,
    description: "Wheeled street vendor with a striped umbrella. Boosted by Night Owl (eat a dog after 10 PM)." },
  { id: "food_truck", name: "Food Truck", emoji: "🚚", base_cost: 12000, base_rate: 47.0,
    description: "Mobile vendor that chases the crowds. Mid-tier earner — the workhorse of mid-game." },
  { id: "stadium", name: "Stadium Vendor", emoji: "🏟️", base_cost: 130000, base_rate: 260.0,
    description: "Concession empire. Top-tier production — the endgame goal until you unlock Hot Dog Pope." },
  { id: "franchise", name: "Glizzy Franchise", emoji: "🏪", base_cost: 1500000, base_rate: 1400.0,
    description: "A nationwide chain of glizzy joints. Royalties roll in 24/7 — the late-game workhorse." },
  { id: "orbital_station", name: "Orbital Glizzy Station", emoji: "🛰️", base_cost: 20000000, base_rate: 8000.0,
    description: "Zero-G dogs, mass-produced in orbit. The frontier of frankfurters." },
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
  { id: "franchise_playbook", name: "Franchise Playbook", emoji: "📈", cost: 160000000,
    description: "Glizzy Franchise production ×2.",
    effect: { type: "building_mult", building: "franchise", value: 2 } },
  { id: "reinforced_casing", name: "Reinforced Casing", emoji: "🚀", cost: 2100000000,
    description: "Orbital Glizzy Station production ×2.",
    effect: { type: "building_mult", building: "orbital_station", value: 2 } },
  { id: "golden_tongs", name: "Golden Tongs", emoji: "🥇", cost: 5000000,
    description: "Click power ×7 (stacks with other click upgrades).",
    effect: { type: "click_mult", value: 7 } },
  { id: "assembly_line", name: "Assembly Line", emoji: "⚙️", cost: 8000000,
    description: "All production +25% (multiplicative).",
    effect: { type: "global_mult", value: 1.25 } },
  { id: "vertical_integration", name: "Vertical Integration", emoji: "🔗", cost: 12000000,
    description: "All production +0.1% per building owned. Scales with your total building count.",
    effect: { type: "global_per_building", value: 0.001 } },
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
    golden_effects: [],
    last_golden_at: null,
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
    description: "Click power ×100",
    trigger: "Eat more than 4 hot dogs in a single Pacific day",
    duration: "24 hours after a qualifying day",
  },
  {
    id: "breakfast_boon",
    emoji: "🌅",
    name: "Breakfast Boon",
    description: "Mustard Stand production +500%",
    trigger: "Log a hot dog before 8 AM Pacific",
    duration: "24 hours after a qualifying day",
  },
  {
    id: "night_owl",
    emoji: "🦉",
    name: "Night Owl",
    description: "Glizzy Cart production +500%",
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
    description: "+100% all production (permanent)",
    trigger: "Eat 100 lifetime hot dogs",
    duration: "Permanent (replaced by higher tier)",
  },
  {
    id: "half_grand",
    emoji: "🏆",
    name: "Half-Grand",
    description: "+250% all production (permanent)",
    trigger: "Eat 500 lifetime hot dogs",
    duration: "Permanent (replaces Centurion)",
  },
  {
    id: "glizzy_pope",
    emoji: "👑",
    name: "Glizzy Pope",
    description: "+500% all production (permanent)",
    trigger: "Eat 1,000 lifetime hot dogs",
    duration: "Permanent (replaces Half-Grand)",
  },
];

const BONUS_DEF_BY_ID = new Map(ALL_BONUSES.map((b) => [b.id, b]));

// ============================================================================
// Golden Glizzy — random spawn the player clicks for a one-shot reward
// ============================================================================
//
// A golden glizzy fades onto the screen, stays clickable for ~30s, then fades
// away. Clicking it calls the server, which rolls ONE reward from the weighted
// table below. Rewards are server-authoritative: timed multipliers are written
// into state.golden_effects (so the anti-cheat budget accounts for the buffed
// earnings) and instant grants are credited directly. The client never decides
// the reward — it only renders what the server returns.
//
// `weight` is out of GOLDEN_TOTAL_WEIGHT (1000). The mega reward is 1/1000.

// Local-only fast mode for demoing the feature (set GLIZZY_TEST_MODE=1). Spawns
// golden glizzies every few seconds and drops the server claim floor so every
// reward type can be seen quickly. NEVER set this in production.
const GOLDEN_TEST_MODE = process.env.GLIZZY_TEST_MODE === "1";

export const GOLDEN_SPAWN = GOLDEN_TEST_MODE
  ? { minIntervalSec: 6, maxIntervalSec: 14, visibleSec: 30 }
  : {
      // Client-side spawn cadence (random in this range) + how long it stays clickable.
      minIntervalSec: 240,
      maxIntervalSec: 720,
      visibleSec: 30,
    };

// Server floor between two accepted claims — stops a script from farming the
// endpoint faster than golden glizzies could ever legitimately appear.
const GOLDEN_CLAIM_FLOOR_MS = (GOLDEN_TEST_MODE ? 3 : 200) * 1000;

// Rarest → commonest. Weights sum to 1000 (mega = exactly 1/1000). Magnitudes
// are tuned against real player data: every reward scales with PRODUCTION (not
// hoarded bank — most active players keep tiny banks), rarer rewards pay more,
// and no single common reward dominates expected value. The trailing comment on
// each line is roughly what it's worth in "minutes of production".
export const GOLDEN_BONUSES = [
  {
    id: "golden_rush", emoji: "🌠", name: "GOLDEN RUSH", weight: 1, mega: true,
    kind: "prod_mult", mult: 500, durationSec: 10,
    blurb: "×500 production for 10 seconds",
  }, // ≈ 83 min
  {
    id: "super_frenzy", emoji: "⚡", name: "Super Frenzy", weight: 90,
    kind: "prod_mult", mult: 13, durationSec: 120,
    blurb: "×13 production for 2 minutes",
  }, // ≈ 24 min
  {
    id: "overdrive", emoji: "⚙️", name: "Overdrive", weight: 180,
    kind: "building_mult", mult: 7, durationSec: 180,
    blurb: "Your best building ×7 for 3 minutes",
  }, // ≈ 14 min
  {
    id: "frenzy", emoji: "🔥", name: "Frenzy", weight: 280,
    kind: "prod_mult", mult: 4, durationSec: 180,
    blurb: "×4 production for 3 minutes",
  }, // ≈ 9 min
  {
    id: "cash_splash", emoji: "💰", name: "Cash Splash", weight: 200,
    kind: "prod_seconds", seconds: 360,
    blurb: "Instant glizzies — 6 minutes of production",
  }, // ≈ 6 min
  {
    id: "lucky", emoji: "🍀", name: "Lucky!", weight: 249,
    kind: "bank_pct", pct: 0.20, capSec: 600, floorSec: 120,
    blurb: "Free glizzies — 20% of your bank",
  }, // 2–10 min (floored/capped to production)
];

const GOLDEN_TOTAL_WEIGHT = GOLDEN_BONUSES.reduce((s, b) => s + b.weight, 0);
const GOLDEN_BY_ID = new Map(GOLDEN_BONUSES.map((b) => [b.id, b]));

function rollGoldenBonus() {
  let r = Math.random() * GOLDEN_TOTAL_WEIGHT;
  for (const b of GOLDEN_BONUSES) {
    if ((r -= b.weight) < 0) return b;
  }
  return GOLDEN_BONUSES[GOLDEN_BONUSES.length - 1];
}

/** Drop expired buffs from a state's golden_effects array (mutates + returns). */
function pruneGoldenEffects(state, now = Date.now()) {
  state.golden_effects = (state.golden_effects || []).filter(
    (g) => g && new Date(g.expires_at).getTime() > now,
  );
  return state.golden_effects;
}

// Buffs in the same group don't stack — a new one replaces the old (newest
// wins). All global production multipliers (Frenzy/Super Frenzy/Golden Rush)
// share the "prod" group, so e.g. two ×4 Frenzies never compound to ×16.
// Building boosts only conflict with another boost on the *same* building, and a
// building boost still combines with a global Frenzy (different effect, not a stack).
function buffGroup(e) {
  if (e.kind === "building_mult") return "building:" + e.building;
  if (e.kind === "click_mult") return "click";
  return "prod"; // prod_mult
}
function addGoldenBuff(state, effect) {
  const group = buffGroup(effect);
  state.golden_effects = (state.golden_effects || []).filter((x) => buffGroup(x) !== group);
  state.golden_effects.push(effect);
}

/**
 * Roll + apply a golden glizzy reward for a user. Server-authoritative.
 * Returns { ok, ...reward, state, bonuses, rates } on success, or
 * { ok: false, reason, retryAfterMs } if claimed too soon.
 */
export function claimGoldenGlizzy(userId) {
  const state = readStateFromDb(userId) || blankState();
  const now = Date.now();

  const last = state.last_golden_at ? new Date(state.last_golden_at).getTime() : 0;
  if (Number.isFinite(last) && now - last < GOLDEN_CLAIM_FLOOR_MS) {
    return { ok: false, reason: "too_soon", retryAfterMs: GOLDEN_CLAIM_FLOOR_MS - (now - last) };
  }

  pruneGoldenEffects(state, now);
  let def = rollGoldenBonus();

  const reward = { ok: true, id: def.id, name: def.name, emoji: def.emoji, mega: !!def.mega };

  if (def.kind === "bank_pct") {
    // A % of the bank, but floored/capped to a band of current production so it
    // is never a dud for active (low-bank) players nor a jackpot for hoarders.
    const r = computeEffectiveRates(state, computeBonuses(userId));
    const raw = (state.glizzies || 0) * def.pct;
    const grant = Math.floor(
      Math.min(Math.max(raw, r.perSecond * def.floorSec), r.perSecond * def.capSec),
    );
    state.glizzies = (state.glizzies || 0) + grant;
    state.lifetime = (state.lifetime || 0) + grant;
    reward.granted = grant;
    reward.message = `+${grant.toLocaleString()} glizzies`;
  } else if (def.kind === "prod_seconds") {
    // Instant grant worth N seconds of the player's current production.
    const bonuses = computeBonuses(userId);
    const r = computeEffectiveRates(state, bonuses);
    const grant = Math.floor(r.perSecond * def.seconds);
    state.glizzies = (state.glizzies || 0) + grant;
    state.lifetime = (state.lifetime || 0) + grant;
    reward.granted = grant;
    reward.message = `+${grant.toLocaleString()} glizzies (${Math.round(def.seconds / 60)} min of production)`;
  } else if (def.kind === "building_mult") {
    // Boost the player's top-producing owned building. If they own nothing yet,
    // fall back to a Frenzy so the reward is never a complete dud.
    const bonuses = computeBonuses(userId);
    const r = computeEffectiveRates(state, bonuses);
    let top = null, topProd = -1;
    for (const b of BUILDINGS) {
      if ((state.buildings?.[b.id] || 0) > 0 && r.buildingProduction[b.id] > topProd) {
        topProd = r.buildingProduction[b.id];
        top = b;
      }
    }
    if (top) {
      const expires_at = new Date(now + def.durationSec * 1000).toISOString();
      addGoldenBuff(state, { kind: "building_mult", building: top.id, mult: def.mult, expires_at });
      reward.building = top.id;
      reward.buildingName = top.name;
      reward.mult = def.mult;
      reward.durationSec = def.durationSec;
      reward.expires_at = expires_at;
      reward.message = `${top.name} ×${def.mult} for ${Math.round(def.durationSec / 60)} min`;
    } else {
      def = GOLDEN_BY_ID.get("frenzy");
      const expires_at = new Date(now + def.durationSec * 1000).toISOString();
      addGoldenBuff(state, { kind: "prod_mult", mult: def.mult, expires_at });
      reward.id = def.id; reward.name = def.name; reward.emoji = def.emoji;
      reward.mult = def.mult; reward.durationSec = def.durationSec; reward.expires_at = expires_at;
      reward.message = def.blurb;
    }
  } else {
    // Timed global / click multiplier.
    const expires_at = new Date(now + def.durationSec * 1000).toISOString();
    addGoldenBuff(state, { kind: def.kind, mult: def.mult, expires_at });
    reward.mult = def.mult;
    reward.durationSec = def.durationSec;
    reward.expires_at = expires_at;
    reward.message = def.blurb;
  }

  state.last_golden_at = new Date(now).toISOString();
  writeStateToDb(userId, state);

  const bonuses = computeBonuses(userId);
  return { ...reward, state, bonuses, rates: computeEffectiveRates(state, bonuses) };
}

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

export function computeBonuses(userId, ctx) {
  const allEvents = ctx?.allEvents || getAllEventsStmt.all();
  const userEvents = allEvents.filter((e) => e.user_id === userId && e.amount > 0);
  const yesterday = yesterdayPacificKey();
  const yesterdayEvents = userEvents.filter(
    (e) => toPacificDateKey(parseUtcTimestamp(e.timestamp)) === yesterday,
  );
  const yesterdayTotal = yesterdayEvents.reduce((s, e) => s + e.amount, 0);
  const hadEarlyDog = yesterdayEvents.some((e) => pacificHour(parseUtcTimestamp(e.timestamp)) < 8);
  const hadLateDog = yesterdayEvents.some((e) => pacificHour(parseUtcTimestamp(e.timestamp)) >= 22);

  const datesMap = ctx?.datesMap || buildUserDatesMap(allEvents);
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
      effect: { type: "click_mult", value: 100 },
    });
  }
  if (hadEarlyDog) {
    activate("breakfast_boon", {
      explanation: "Ate a dog before 8 AM yesterday",
      effect: { type: "building_mult", building: "mustard_stand", value: 6 },
    });
  }
  if (hadLateDog) {
    activate("night_owl", {
      explanation: "Ate a dog after 10 PM yesterday",
      effect: { type: "building_mult", building: "glizzy_cart", value: 6 },
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
      effect: { type: "global_mult", value: 6 },
    });
  } else if (userTotal >= 500) {
    activate("half_grand", {
      explanation: `${userTotal} lifetime dogs`,
      effect: { type: "global_mult", value: 3.5 },
    });
  } else if (userTotal >= 100) {
    activate("centurion", {
      explanation: `${userTotal} lifetime dogs`,
      effect: { type: "global_mult", value: 2 },
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
    else if (e.type === "global_per_building") {
      const totalBuildings = BUILDING_IDS.reduce((s, b) => s + (state.buildings?.[b] || 0), 0);
      globalMult *= 1 + totalBuildings * e.value;
    }
  }

  // Active bonuses (same shape, applied multiplicatively on top)
  for (const b of bonuses) {
    const e = b.effect;
    if (e.type === "click_mult") clickPower *= e.value;
    else if (e.type === "building_mult") buildingMult[e.building] *= e.value;
    else if (e.type === "global_mult") globalMult *= e.value;
  }

  // Active golden-glizzy buffs (server-recorded in state, expire by timestamp).
  const goldNow = Date.now();
  for (const g of state.golden_effects || []) {
    if (!g || new Date(g.expires_at).getTime() <= goldNow) continue;
    if (g.kind === "prod_mult") globalMult *= g.mult;
    else if (g.kind === "click_mult") clickPower *= g.mult;
    else if (g.kind === "building_mult" && buildingMult[g.building] !== undefined) {
      buildingMult[g.building] *= g.mult;
    }
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
  pruneGoldenEffects(state);
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

  // ----- 8. Golden glizzy fields are server-owned — never trust the client.
  //          Carry them forward from the previous state (pruning expired buffs).
  out.last_golden_at = previous.last_golden_at || null;
  out.golden_effects = previous.golden_effects || [];
  pruneGoldenEffects(out);

  out.last_seen_at = new Date().toISOString();
  writeStateToDb(userId, out);
  return { state: out, bonuses, rates: computeEffectiveRates(out, bonuses) };
}

// ============================================================================
// Leaderboard
// ============================================================================

export function getLeaderboardRows(limit = 50) {
  const rows = topByLifetimeStmt.all(limit);
  // Shared context so we scan the events table once for the whole board,
  // not once per user. Production includes each user's live bonuses.
  const allEvents = getAllEventsStmt.all();
  const datesMap = buildUserDatesMap(allEvents);
  return rows.map((row) => {
    let state = {};
    try { state = JSON.parse(row.state); } catch {}
    const bonuses = computeBonuses(row.user_id, { allEvents, datesMap });
    const rates = computeEffectiveRates(state, bonuses);
    return {
      user_id: row.user_id,
      lifetime: Number(row.lifetime_glizzies) || 0,
      current: state.glizzies || 0,
      per_second: rates.perSecond,
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
