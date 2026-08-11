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
  { id: "glizzy_megaplex", name: "Glizzy Megaplex", emoji: "🏢", base_cost: 250000000, base_rate: 44000.0,
    description: "A 200-story tower that is glizzies all the way down. Where the orbital frontier becomes an empire." },
  { id: "quantum_kitchen", name: "Quantum Kitchen", emoji: "⚛️", base_cost: 3300000000, base_rate: 250000.0,
    description: "Cooks every possible hot dog at once, then collapses the wavefunction onto the tastiest. Probably." },
  { id: "dyson_grill", name: "Dyson Grill", emoji: "☀️", base_cost: 45000000000, base_rate: 1400000.0,
    description: "A megastructure that grills with the full output of a star. Char marks visible from neighboring systems." },
  { id: "black_hole_bun", name: "Black Hole Bun", emoji: "🕳️", base_cost: 600000000000, base_rate: 8000000.0,
    description: "Condiments fall in and never escape; glizzies radiate out forever. Late-late-game heavy hitter." },
  { id: "multiverse_glizzy", name: "Multiverse Glizzy Cartel", emoji: "🌌", base_cost: 8000000000000, base_rate: 45000000.0,
    description: "Franchises across every parallel universe, paying royalties into this one. The true endgame — owning even a few is a flex." },
];

const BUILDING_IDS = BUILDINGS.map((b) => b.id);
const COST_SCALE = 1.15;

const CORE_UPGRADES = [
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

// ----------------------------------------------------------------------------
// Generated upgrade catalog (Cookie-Clicker-scale). The live data showed every
// elite player had maxed all 15 CORE_UPGRADES while sitting on trillions of
// lifetime glizzies — the whole tree cost <0.1% of their lifetime. These extend
// the tree into the Qa/Qi range so "own every upgrade" is genuinely elite-only.
// All of these use effect types the engine already understands, except the
// building_synergy block (handled in computeEffectiveRates below).
// ----------------------------------------------------------------------------

const BUILDING_NAME = Object.fromEntries(BUILDINGS.map((b) => [b.id, b.name]));
const BUILDING_BASE_COST = Object.fromEntries(BUILDINGS.map((b) => [b.id, b.base_cost]));
const NEW_BUILDING_IDS = new Set([
  "glizzy_megaplex", "quantum_kitchen", "dyson_grill", "black_hole_bun", "multiverse_glizzy",
]);

// Per-building ×2 production ladders. Old buildings already ship rung 1 (e.g.
// "Better Mustard"), so they only get rungs 2–4; the five new buildings get the
// full 1–4 ladder. Cost = base_cost × the rung's multiplier, so each building's
// ladder naturally lands in the right magnitude band.
const LADDER_COST_X = [100, 15000, 2_000_000, 300_000_000]; // rung 1..4
const PROD_LADDER_NAMES = {
  mustard_stand:    { e: "🌭", names: ["Better Mustard", "Spicy Brown Mustard", "Artisanal Mustard Lab", "Mustard Singularity"] },
  bun_factory:      { e: "🍞", names: ["Fresh Buns", "Brioche Retooling", "Automated Bun Line", "Bun Replicator"] },
  glizzy_cart:      { e: "🛒", names: ["Premium Cart", "Chrome Cart", "Self-Driving Cart", "Hypersonic Cart"] },
  food_truck:       { e: "🚚", names: ["Fancy Truck", "Turbo Truck", "Fleet Logistics", "Convoy AI"] },
  stadium:          { e: "🏟️", names: ["Sponsorship Deal", "Jumbotron Ads", "Naming Rights", "Global Broadcast Deal"] },
  franchise:        { e: "🏪", names: ["Franchise Playbook", "Regional Rollout", "National Saturation", "Franchise Hegemony"] },
  orbital_station:  { e: "🛰️", names: ["Reinforced Casing", "Ion Thrusters", "Orbital Ring", "Dyson Swarm Tap"] },
  glizzy_megaplex:  { e: "🏢", names: ["Megaplex Grand Opening", "VIP Skyboxes", "Vertical Expansion", "Arcology Conversion"] },
  quantum_kitchen:  { e: "⚛️", names: ["Quantum Prep", "Superposition Searing", "Entangled Inventory", "Many-Worlds Menu"] },
  dyson_grill:      { e: "☀️", names: ["Mirror Array", "Stellar Lattice", "Photon Funnel", "Total Output Capture"] },
  black_hole_bun:   { e: "🕳️", names: ["Event Horizon Glaze", "Hawking Seasoning", "Accretion Toppings", "Singularity Yield"] },
  multiverse_glizzy:{ e: "🌌", names: ["Parallel Kitchens", "Brane Logistics", "Omniversal Supply", "Infinite Regress Profits"] },
};

const PROD_LADDER_UPGRADES = [];
for (const b of BUILDINGS) {
  const cfg = PROD_LADDER_NAMES[b.id];
  if (!cfg) continue;
  const startRung = NEW_BUILDING_IDS.has(b.id) ? 0 : 1; // old buildings already have rung 0
  for (let r = startRung; r < 4; r++) {
    PROD_LADDER_UPGRADES.push({
      id: `${b.id}_p${r + 1}`,
      name: cfg.names[r],
      emoji: cfg.e,
      cost: Math.round(BUILDING_BASE_COST[b.id] * LADDER_COST_X[r]),
      description: `${BUILDING_NAME[b.id]} production ×2.`,
      effect: { type: "building_mult", building: b.id, value: 2 },
    });
  }
}

// Global "+X% all production" flavor upgrades — Cookie-Clicker's bread and
// butter. Pure money sinks at escalating fixed prices so maxed players always
// have something to save toward. Stored as global_mult = 1 + pct/100.
const GLOBAL_UPGRADES = [
  ["condiment_council",  "🧂", "Condiment Council",     2e8,   5],
  ["relish_renaissance", "🥒", "Relish Renaissance",    1.5e9, 5],
  ["onion_optimization", "🧅", "Onion Optimization",    1.2e10, 6],
  ["kraut_surplus",      "🥬", "Sauerkraut Surplus",    1e11,  7],
  ["bacon_wrapping",     "🥓", "Bacon Wrapping",        8e11,  8],
  ["cheese_cascade",     "🧀", "Cheese Cascade",        6e12,  9],
  ["chili_empire",       "🌶️", "Chili Empire",          5e13, 10],
  ["slaw_dynasty",       "🥗", "Slaw Dynasty",          4e14, 12],
  ["glizzy_gospel",      "📖", "Glizzy Gospel",         3e15, 14],
  ["frankfurter_fame",   "⭐", "Frankfurter Fame",      2.5e16, 16],
  ["wiener_world_order", "🌍", "Wiener World Order",    2e17, 18],
  ["sausage_sovereignty","👑", "Sausage Sovereignty",   1.5e18, 20],
  ["encased_eternal",    "♾️", "Encased Meat Eternal",  1.2e19, 25],
  ["the_final_frank",    "🏁", "The Final Frank",       1e20, 30],
].map(([id, emoji, name, cost, pct]) => ({
  id, emoji, name, cost,
  description: `All production +${pct}% (multiplicative).`,
  effect: { type: "global_mult", value: 1 + pct / 100 },
}));

// Click-power ladder extensions (existing types: click_mult, click_per_building).
const CLICK_UPGRADES = [
  { id: "titanium_tongs",  emoji: "🥢", name: "Titanium Tongs",   cost: 25e6,  description: "Click power ×3 (stacks with other click upgrades).", effect: { type: "click_mult", value: 3 } },
  { id: "relish_per_tap",  emoji: "🥒", name: "Relish Per Tap",   cost: 20e6,  description: "Click power gains +0.05 per building owned (additive).", effect: { type: "click_per_building", value: 0.05 } },
  { id: "mustard_reflexes",emoji: "🤺", name: "Mustard Reflexes", cost: 8e8,   description: "Click power ×5 (stacks with other click upgrades).", effect: { type: "click_mult", value: 5 } },
  { id: "condiment_cascade",emoji: "💧",name: "Condiment Cascade",cost: 2e9,   description: "Click power gains +0.25 per building owned (additive).", effect: { type: "click_per_building", value: 0.25 } },
  { id: "glizzy_grip",     emoji: "✊", name: "Glizzy Grip",      cost: 50e9,  description: "Click power ×8 (stacks with other click upgrades).", effect: { type: "click_mult", value: 8 } },
  { id: "bun_per_tap",     emoji: "🍞", name: "Bun Per Tap",      cost: 200e9, description: "Click power gains +1 per building owned (additive).", effect: { type: "click_per_building", value: 1 } },
  { id: "snap_reflex",     emoji: "⚡", name: "Snap Reflex",      cost: 5e12,  description: "Click power ×10 (stacks with other click upgrades).", effect: { type: "click_mult", value: 10 } },
  { id: "divine_digit",    emoji: "☝️", name: "Divine Digit",     cost: 5e14,  description: "Click power ×20 (stacks with other click upgrades).", effect: { type: "click_mult", value: 20 } },
];

// Click power that scales with production (`click_from_pps`).
//
// Every upgrade above multiplies a base of 1, so a click is a fixed number
// while production is an exponential one: by the time a player owns a Dyson
// Grill their whole click ladder is a rounding error against their /s and
// clicking stops being the game the game is named after. These add a share of
// the player's *own* per-second production to every click, so a tap is worth
// the same fraction of a run at every tier, forever.
//
// The line totals 10% of /s per click on purpose: a human mashing ~10 clicks/s
// then roughly doubles their income while they're actually playing, and does
// nothing at all when they aren't. Clicking supplements idle production; it
// must never replace it (25 clicks/s is the anti-cheat ceiling, so the most an
// autoclicker can wring out is ~2.5× production).
const CLICK_SCALE_UPGRADES = [
  { id: "hands_on", emoji: "🖐️", name: "Hands-On Management", cost: 1e9,
    description: "Each click also earns +1% of your per-second production.",
    effect: { type: "click_from_pps", value: 0.01 } },
  { id: "line_cook_soul", emoji: "🧑‍🍳", name: "Line Cook Soul", cost: 1e11,
    description: "Each click earns another +2% of your per-second production.",
    effect: { type: "click_from_pps", value: 0.02 } },
  { id: "thousand_fingers", emoji: "🤲", name: "Thousand Fingers", cost: 1e13,
    description: "Each click earns another +3% of your per-second production.",
    effect: { type: "click_from_pps", value: 0.03 } },
  { id: "the_glizzy_touch", emoji: "✨", name: "The Glizzy Touch", cost: 1e15,
    description: "Each click earns another +4% of your per-second production.",
    effect: { type: "click_from_pps", value: 0.04 } },
];

// Building synergies (Cookie-Clicker grandma-style): a building gains +0.1%
// production per unit of the tier below it that you own. New effect type
// `building_synergy`, applied in computeEffectiveRates. Chains the whole tree.
const SYNERGY_CHAIN = [
  ["bun_factory", "mustard_stand", "Bun Logistics", "🍞", 50e6],
  ["glizzy_cart", "bun_factory", "Cart Supply Chain", "🛒", 5e8],
  ["food_truck", "glizzy_cart", "Truck Dispatch", "🚚", 5e9],
  ["stadium", "food_truck", "Stadium Catering", "🏟️", 5e10],
  ["franchise", "stadium", "Franchise Network", "🏪", 5e11],
  ["orbital_station", "franchise", "Orbital Logistics", "🛰️", 5e12],
  ["glizzy_megaplex", "orbital_station", "Megaplex Pipeline", "🏢", 5e13],
  ["quantum_kitchen", "glizzy_megaplex", "Quantum Tunnel", "⚛️", 5e14],
  ["dyson_grill", "quantum_kitchen", "Stellar Feed", "☀️", 5e15],
  ["black_hole_bun", "dyson_grill", "Horizon Drift", "🕳️", 5e16],
  ["multiverse_glizzy", "black_hole_bun", "Multiverse Mesh", "🌌", 5e17],
];
const SYNERGY_UPGRADES = SYNERGY_CHAIN.map(([building, per, name, emoji, cost]) => ({
  id: `syn_${building}_${per}`,
  emoji, name, cost,
  description: `${BUILDING_NAME[building]} gains +0.1% production per ${BUILDING_NAME[per]} owned.`,
  effect: { type: "building_synergy", building, per, value: 0.001 },
}));

// Golden-glizzy upgrades (Cookie-Clicker's Lucky Day / Get Lucky line). Unlike
// every other upgrade these don't feed computeEffectiveRates — they tune the
// golden-glizzy system via computeGoldenModifiers (frequency = how often they
// spawn, duration = how long timed buffs last, payout = how big instant grants
// are). Multiple of the same kind multiply together. Priced as premium endgame.
const GOLDEN_UPGRADES = [
  { id: "lucky_day", emoji: "🍀", name: "Lucky Day", cost: 20e9,
    description: "Golden glizzies appear ~33% more often.",
    effect: { type: "golden_frequency", value: 1.33 } },
  { id: "get_lucky", emoji: "🎰", name: "Get Lucky", cost: 50e9,
    description: "Golden glizzy buff effects (Frenzy, Overdrive, etc.) last 50% longer.",
    effect: { type: "golden_duration", value: 1.5 } },
  { id: "golden_buns", emoji: "🥇", name: "Golden Buns", cost: 100e9,
    description: "Instant golden glizzy rewards (Cash Splash, Lucky!) pay 50% more.",
    effect: { type: "golden_payout", value: 1.5 } },
  { id: "serendipity", emoji: "🌈", name: "Serendipity", cost: 2e12,
    description: "Golden glizzies appear another ~33% more often (stacks with Lucky Day).",
    effect: { type: "golden_frequency", value: 1.33 } },
  { id: "four_leaf_frank", emoji: "☘️", name: "Four-Leaf Frank", cost: 5e12,
    description: "Golden glizzy buff effects last another 50% longer (stacks with Get Lucky).",
    effect: { type: "golden_duration", value: 1.5 } },
  { id: "midas_mustard", emoji: "👑", name: "Midas Mustard", cost: 10e12,
    description: "Instant golden glizzy rewards pay another 50% more (stacks with Golden Buns).",
    effect: { type: "golden_payout", value: 1.5 } },
];

export const UPGRADES = [
  ...CORE_UPGRADES,
  ...PROD_LADDER_UPGRADES,
  ...GLOBAL_UPGRADES,
  ...CLICK_UPGRADES,
  ...CLICK_SCALE_UPGRADES,
  ...SYNERGY_UPGRADES,
  ...GOLDEN_UPGRADES,
];

const UPGRADE_BY_ID = new Map(UPGRADES.map((u) => [u.id, u]));

/**
 * Golden-glizzy modifiers derived from a player's owned upgrades. Same-kind
 * upgrades multiply together. frequency = spawn-rate multiplier (>1 = more
 * often), duration = timed-buff length multiplier, payout = instant-grant size
 * multiplier. Kept separate from computeEffectiveRates since these don't touch
 * production — they tune the golden-glizzy system in claimGoldenGlizzy / spawn.
 */
export function computeGoldenModifiers(state) {
  const mod = { frequency: 1, duration: 1, payout: 1 };
  for (const upId of state?.upgrades_owned || []) {
    const e = UPGRADE_BY_ID.get(upId)?.effect;
    if (!e) continue;
    if (e.type === "golden_frequency") mod.frequency *= e.value;
    else if (e.type === "golden_duration") mod.duration *= e.value;
    else if (e.type === "golden_payout") mod.payout *= e.value;
  }
  return mod;
}

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
    // Bumped on every server-side write. The client echoes back the seq it last
    // received so we can spot (and drop) a save built on a stale snapshot.
    save_seq: 0,
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
// `weight` is out of GOLDEN_TOTAL_WEIGHT (1000). Each mega reward is 1/100.

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

// Never let frequency upgrades push the spawn cadence below this — keeps the
// page from feeling spammy even with every golden-frequency upgrade owned.
const GOLDEN_MIN_SPAWN_FLOOR_SEC = GOLDEN_TEST_MODE ? 4 : 45;

/**
 * Per-player spawn cadence: the base GOLDEN_SPAWN with intervals shortened by
 * the player's golden_frequency upgrades (floored so it never gets spammy).
 * Sent to the client at page render so the spawn scheduler reflects upgrades.
 */
export function goldenSpawnFor(state) {
  const freq = computeGoldenModifiers(state).frequency;
  if (freq <= 1) return GOLDEN_SPAWN;
  const minIntervalSec = Math.max(GOLDEN_MIN_SPAWN_FLOOR_SEC, Math.round(GOLDEN_SPAWN.minIntervalSec / freq));
  const maxIntervalSec = Math.max(minIntervalSec + 30, Math.round(GOLDEN_SPAWN.maxIntervalSec / freq));
  return { ...GOLDEN_SPAWN, minIntervalSec, maxIntervalSec };
}

// Server floor between two accepted claims — stops a script from farming the
// endpoint faster than golden glizzies could ever legitimately appear.
//
// This MUST be derived from the player's own spawn cadence, not a flat number.
// A flat 200 s floor silently rejected roughly a quarter of all claims for
// anyone owning both frequency upgrades (Lucky Day + Serendipity drop the
// minimum spawn interval to 136 s) — i.e. the players who paid the most for
// "golden glizzies appear more often" were the ones whose glizzies did nothing.
const GOLDEN_MIN_CLAIM_FLOOR_SEC = GOLDEN_TEST_MODE ? 3 : 60;
const GOLDEN_MAX_CLAIM_FLOOR_SEC = GOLDEN_TEST_MODE ? 3 : 200;
// Slack under the player's fastest possible spawn, so a spawn landing right at
// the minimum interval (plus clock skew and travel time) still claims cleanly.
const GOLDEN_CLAIM_GRACE_SEC = 20;

function goldenClaimFloorMs(state) {
  const { minIntervalSec } = goldenSpawnFor(state);
  const sec = Math.min(
    GOLDEN_MAX_CLAIM_FLOOR_SEC,
    Math.max(GOLDEN_MIN_CLAIM_FLOOR_SEC, minIntervalSec - GOLDEN_CLAIM_GRACE_SEC),
  );
  return sec * 1000;
}

// Ordered by value tier, biggest first. Weights sum to 1000, and a `mega` sits at weight 10 —
// exactly 1/100. (It used to be 1/1000, which nobody ever reached: the spawn
// timer only advances while the game page is open, so 1/1000 was a ~92-hour
// career event. Rare is a feeling, not an arithmetic dare.)
//
// Magnitudes are tuned against real player data: every PRODUCTION reward scales
// with production (not hoarded bank — most active players keep tiny banks),
// rarer rewards pay more, and no single common reward dominates expected value.
// The trailing comment on each line is roughly what it's worth in "minutes of
// production".
//
// The two `click_mult` rewards are deliberately exempt from that yardstick:
// they multiply perClick and nothing else, so their value is denominated in
// clicks the player chooses to make and is zero for a player who catches one
// and walks away. See docs/golden-glizzy.md.
export const GOLDEN_BONUSES = [
  {
    id: "golden_rush", emoji: "🌠", name: "GOLDEN RUSH", weight: 10, mega: true,
    kind: "prod_mult", mult: 500, durationSec: 10,
    blurb: "×500 production for 10 seconds",
  }, // ≈ 83 min
  {
    id: "demon_dog", emoji: "😈", name: "DEMON DOG", weight: 10, mega: true,
    kind: "click_mult", mult: 666, durationSec: 15,
    blurb: "×666 click power for 15 seconds — MASH",
  }, // worth whatever you can mash out of it
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
    id: "frenzy", emoji: "🔥", name: "Frenzy", weight: 240,
    kind: "prod_mult", mult: 4, durationSec: 180,
    blurb: "×4 production for 3 minutes",
  }, // ≈ 9 min
  {
    id: "cash_splash", emoji: "💰", name: "Cash Splash", weight: 190,
    kind: "prod_seconds", seconds: 360,
    blurb: "Instant glizzies — 6 minutes of production",
  }, // ≈ 6 min
  {
    id: "lucky", emoji: "🍀", name: "Lucky!", weight: 210,
    kind: "bank_pct", pct: 0.20, capSec: 600, floorSec: 120,
    blurb: "Free glizzies — 20% of your bank",
  }, // 2–10 min (floored/capped to production)
  {
    id: "tap_frenzy", emoji: "👆", name: "Tap Frenzy", weight: 70,
    kind: "click_mult", mult: 6, durationSec: 60,
    blurb: "×6 click power for 1 minute",
  }, // worth whatever you can mash out of it
];

const GOLDEN_TOTAL_WEIGHT = GOLDEN_BONUSES.reduce((s, b) => s + b.weight, 0);
const GOLDEN_BY_ID = new Map(GOLDEN_BONUSES.map((b) => [b.id, b]));

/**
 * The per-second earn rate an instant reward is worth N seconds of.
 *
 * Instant grants used to scale off `perSecond` alone, which is exactly 0 until
 * you buy your first building — so Cash Splash and Lucky! (45% of the table
 * between them) paid literally "+0 glizzies" to brand-new players. Falling back
 * to click power keeps a golden glizzy worth having before your first building,
 * and the trailing 1 guarantees a reward is never nothing.
 */
function goldenBaseRate(rates) {
  return Math.max(rates.perSecond || 0, rates.perClick || 0, 1);
}

function rollGoldenBonus() {
  let r = Math.random() * GOLDEN_TOTAL_WEIGHT;
  for (const b of GOLDEN_BONUSES) {
    if ((r -= b.weight) < 0) return b;
  }
  return GOLDEN_BONUSES[GOLDEN_BONUSES.length - 1];
}

// Toast text for a timed buff. Uses the def's static blurb unless a Get
// Lucky-style duration upgrade stretched it, in which case we render the real
// duration so the toast matches the buff chip's live countdown.
function goldenBuffMessage(def, durSec, durationMult) {
  if (durationMult === 1) return def.blurb;
  const durText = durSec >= 60 ? `${Math.round(durSec / 60)} min` : `${durSec} sec`;
  const what = def.kind === "click_mult" ? "click power" : "production";
  return `×${def.mult} ${what} for ${durText}`;
}

/** Drop expired buffs from a state's golden_effects array (mutates + returns). */
function pruneGoldenEffects(state, now = Date.now()) {
  state.golden_effects = (state.golden_effects || []).filter(
    (g) => g && new Date(g.expires_at).getTime() > now,
  );
  return state.golden_effects;
}

// Effects written before the queue existed have no starts_at — treat as started.
function goldenStartMs(g) {
  return g.starts_at ? new Date(g.starts_at).getTime() : 0;
}
function goldenExpireMs(g) {
  return new Date(g.expires_at).getTime();
}

// Buffs in the same group never compound — at any instant only the strongest
// *running* buff in a group applies (two ×4 Frenzies never multiply to ×16;
// see computeEffectiveRates). But a claim must never be a downgrade or a dud
// either, so instead of "newest wins" replacement:
//   - a stronger claim starts immediately; the weaker buff it eclipses keeps
//     ticking on the wall clock and resumes if it outlives the stronger one;
//   - a weaker/equal claim is queued (`starts_at`) to begin the moment the
//     buffs beating it expire, with its full duration intact.
// The old replacement assumed timed buffs could never overlap (spawns ≥4 min
// apart, buffs ≤3 min) — the frequency/duration upgrades broke that, and a ×4
// Frenzy could replace a running ×13 Super Frenzy.
// Building boosts only conflict with a boost on the *same* building; a building
// boost and a global Frenzy are different groups and genuinely stack.
function buffGroup(e) {
  if (e.kind === "building_mult") return "building:" + e.building;
  if (e.kind === "click_mult") return "click";
  return "prod"; // prod_mult
}
function addGoldenBuff(state, effect, durSec, now) {
  const group = buffGroup(effect);
  const effects = pruneGoldenEffects(state, now);
  // Start when nothing at least as strong in this group covers the moment: hop
  // past each blocker until the new buff would actually be the one applied.
  let start = now;
  for (let hops = 0; hops < 20; hops++) {
    const blocker = effects.find(
      (e) => buffGroup(e) === group && e.mult >= effect.mult &&
        goldenStartMs(e) <= start && goldenExpireMs(e) > start,
    );
    if (!blocker) break;
    start = goldenExpireMs(blocker);
  }
  effect.starts_at = new Date(start).toISOString();
  effect.expires_at = new Date(start + durSec * 1000).toISOString();
  effects.push(effect);
  // Safety valve: the claim floor makes deep queues unreachable in prod, but
  // GLIZZY_TEST_MODE's seconds-long floor can build silly ones. Keep the 8
  // soonest per group, dropping the farthest-out.
  const same = effects.filter((e) => buffGroup(e) === group);
  if (same.length > 8) {
    const drop = same.reduce((a, b) => (goldenStartMs(a) >= goldenStartMs(b) ? a : b));
    state.golden_effects = effects.filter((e) => e !== drop);
  }
  return effect;
}

/**
 * Roll + apply a golden glizzy reward for a user. Server-authoritative.
 * Returns { ok, ...reward, state, bonuses, rates } on success, or
 * { ok: false, reason, retryAfterMs } if claimed too soon.
 */
export function claimGoldenGlizzy(userId) {
  const state = readStateFromDb(userId) || blankState();
  const now = Date.now();

  const claimFloorMs = goldenClaimFloorMs(state);
  const last = state.last_golden_at ? new Date(state.last_golden_at).getTime() : 0;
  if (Number.isFinite(last) && now - last < claimFloorMs) {
    return { ok: false, reason: "too_soon", retryAfterMs: claimFloorMs - (now - last) };
  }

  pruneGoldenEffects(state, now);
  let def = rollGoldenBonus();

  // Golden-glizzy upgrades: payout scales instant grants, duration scales timed buffs.
  const gmod = computeGoldenModifiers(state);

  const reward = { ok: true, id: def.id, name: def.name, emoji: def.emoji, mega: !!def.mega };

  if (def.kind === "bank_pct") {
    // A % of the bank, but floored/capped to a band of earn rate so it is never
    // a dud for active (low-bank) players nor a jackpot for hoarders.
    const r = computeEffectiveRates(state, computeBonuses(userId));
    const base = goldenBaseRate(r);
    const raw = (state.glizzies || 0) * def.pct;
    const grant = Math.max(1, Math.floor(
      Math.min(Math.max(raw, base * def.floorSec), base * def.capSec) * gmod.payout,
    ));
    state.glizzies = (state.glizzies || 0) + grant;
    state.lifetime = (state.lifetime || 0) + grant;
    reward.granted = grant;
    reward.message = `+${grant.toLocaleString()} glizzies`;
  } else if (def.kind === "prod_seconds") {
    // Instant grant worth N seconds of the player's current earn rate.
    const bonuses = computeBonuses(userId);
    const r = computeEffectiveRates(state, bonuses);
    const grant = Math.max(1, Math.floor(goldenBaseRate(r) * def.seconds * gmod.payout));
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
      const durSec = Math.round(def.durationSec * gmod.duration);
      const buff = addGoldenBuff(state, { kind: "building_mult", building: top.id, mult: def.mult }, durSec, now);
      reward.building = top.id;
      reward.buildingName = top.name;
      reward.mult = def.mult;
      reward.durationSec = durSec;
      reward.starts_at = buff.starts_at;
      reward.expires_at = buff.expires_at;
      reward.queued = goldenStartMs(buff) > now;
      reward.message = `${top.name} ×${def.mult} for ${Math.round(durSec / 60)} min` +
        (reward.queued ? " — queued behind your stronger buff" : "");
    } else {
      def = GOLDEN_BY_ID.get("frenzy");
      const durSec = Math.round(def.durationSec * gmod.duration);
      const buff = addGoldenBuff(state, { kind: "prod_mult", mult: def.mult }, durSec, now);
      reward.id = def.id; reward.name = def.name; reward.emoji = def.emoji;
      reward.mult = def.mult; reward.durationSec = durSec;
      reward.starts_at = buff.starts_at; reward.expires_at = buff.expires_at;
      reward.queued = goldenStartMs(buff) > now;
      reward.message = goldenBuffMessage(def, durSec, gmod.duration) +
        (reward.queued ? " — queued behind your stronger buff" : "");
    }
  } else {
    // Timed global / click multiplier.
    const durSec = Math.round(def.durationSec * gmod.duration);
    const buff = addGoldenBuff(state, { kind: def.kind, mult: def.mult }, durSec, now);
    reward.mult = def.mult;
    reward.durationSec = durSec;
    reward.starts_at = buff.starts_at;
    reward.expires_at = buff.expires_at;
    reward.queued = goldenStartMs(buff) > now;
    reward.message = goldenBuffMessage(def, durSec, gmod.duration) +
      (reward.queued ? " — queued behind your stronger buff" : "");
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
  const userEvents = allEvents.filter((e) => e.user_id === userId);
  const yesterday = yesterdayPacificKey();
  const yesterdayEvents = userEvents.filter(
    (e) => toPacificDateKey(parseUtcTimestamp(e.timestamp)) === yesterday,
  );
  // Net, not gross. Protests are negative rows, and dropping them here paid out
  // Big Eater and the time-of-day boons for a day that was argued back to zero.
  // Same rule as buildUserDatesMap's streak days: a day is worth what it nets.
  const yesterdayTotal = yesterdayEvents.reduce((s, e) => s + e.amount, 0);
  // A time-of-day boon is a *claim about a dog* — so it needs the day to have
  // survived, not just a positive row sitting at that hour. Partial protests
  // keep it: some of what was eaten stands, and nothing says which dog went.
  const ateYesterday = yesterdayTotal > 0;
  const atHour = (e, pred) => e.amount > 0 && pred(pacificHour(parseUtcTimestamp(e.timestamp)));
  const hadEarlyDog = ateYesterday && yesterdayEvents.some((e) => atHour(e, (h) => h < 8));
  const hadLateDog = ateYesterday && yesterdayEvents.some((e) => atHour(e, (h) => h >= 22));

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

/**
 * Rates as of an instant. `at` defaults to now and only affects which
 * golden-glizzy buffs count as running — everything else is timeless.
 *
 * The parameter exists because "what is this player earning?" and "what was
 * this player earning during the window I am about to validate?" are different
 * questions, and validateAndClampSave needs the second one. See the budget
 * comment there.
 */
export function computeEffectiveRates(state, bonuses, at = Date.now()) {
  // Click power
  let clickPower = 1;
  let clickAdditive = 0;
  let clickPpsShare = 0; // fraction of per-second production added to each click
  let goldenClickMult = 1;
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
    else if (e.type === "click_from_pps") clickPpsShare += e.value;
    else if (e.type === "global_per_building") {
      const totalBuildings = BUILDING_IDS.reduce((s, b) => s + (state.buildings?.[b] || 0), 0);
      globalMult *= 1 + totalBuildings * e.value;
    }
    else if (e.type === "building_synergy") {
      // Boost one building's multiplier by +value per unit of another building owned.
      if (buildingMult[e.building] !== undefined) {
        const count = state.buildings?.[e.per] || 0;
        buildingMult[e.building] *= 1 + count * e.value;
      }
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
  // Per group only the strongest currently-running buff applies — same-group
  // buffs eclipse rather than compound — and queued buffs (starts_at still in
  // the future) contribute nothing yet. Mirrored by computeRatesFor in game.js.
  const goldNow = at;
  const goldWinners = new Map();
  for (const g of state.golden_effects || []) {
    if (!g || goldenStartMs(g) > goldNow || goldenExpireMs(g) <= goldNow) continue;
    const group = buffGroup(g);
    const best = goldWinners.get(group);
    if (!best || g.mult > best.mult) goldWinners.set(group, g);
  }
  for (const g of goldWinners.values()) {
    if (g.kind === "prod_mult") globalMult *= g.mult;
    else if (g.kind === "click_mult") goldenClickMult *= g.mult;
    else if (g.kind === "building_mult" && buildingMult[g.building] !== undefined) {
      buildingMult[g.building] *= g.mult;
    }
  }

  let perSecond = 0;
  const buildingProduction = {};
  for (const b of BUILDINGS) {
    const owned = state.buildings?.[b.id] || 0;
    const rate = owned * b.base_rate * buildingMult[b.id] * globalMult;
    buildingProduction[b.id] = rate;
    perSecond += rate;
  }

  // Production has to be known before click power, because `click_from_pps`
  // pays a share of it. That share is added *outside* the click multipliers —
  // stacking a ×1.3M click ladder on top of "10% of your /s" would make one tap
  // worth days of production. The one multiplier that does apply to it is a
  // golden click buff, which is the game's only mash-right-now reward and the
  // reason DEMON DOG exists; without this it would be the one buff that gets
  // *weaker* the further a player gets. (It now also multiplies the
  // click_per_building term, which is the same rule stated once instead of
  // twice.) Mirrored by computeRatesFor in game.js.
  const effectivePerClick =
    ((clickPower + clickAdditive) * globalMult + perSecond * clickPpsShare) * goldenClickMult;

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
  state.save_seq = (Number(state.save_seq) || 0) + 1;
  upsertGameStateStmt.run(userId, JSON.stringify(state), Math.floor(state.lifetime || 0));
}

/**
 * Load (or initialize) a user's state, crediting offline production.
 *
 * Offline earnings are applied *here*, server-side, rather than being handed to
 * the client to add on its own. The client-side version lost the whole idle
 * window whenever a phone suspended the tab and later flushed a save built on
 * the pre-suspend snapshot. Now the server owns the clock in both directions
 * and `offlineEarned` is purely something to show in the welcome-back modal.
 */
export function loadGameForUser(userId) {
  let state = readStateFromDb(userId);
  let isNew = false;
  if (!state) {
    state = blankState();
    isNew = true;
  }
  pruneGoldenEffects(state);
  const bonuses = computeBonuses(userId);
  const offlineEarned = isNew
    ? 0
    : computeOfflineEarned(state, computeEffectiveRates(state, bonuses).perSecond);
  if (offlineEarned > 0) {
    state.glizzies = (state.glizzies || 0) + offlineEarned;
    state.lifetime = (state.lifetime || 0) + offlineEarned;
  }
  state.last_seen_at = new Date().toISOString();
  writeStateToDb(userId, state);
  return {
    state,
    bonuses,
    rates: computeEffectiveRates(state, bonuses),
    offlineEarned,
    isNew,
  };
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
 *
 * Two guards keep a stale client from *reducing* a player's progress:
 *
 *   1. `save_seq` — every server write bumps it and the client echoes back the
 *      seq it last received. A payload built on an older snapshot (a phone that
 *      suspended for an hour and then flushed its queued save, a second tab)
 *      is dropped outright rather than written over newer state.
 *   2. A passive-production floor — whatever the client claims, the player is
 *      always credited for production that accrued since `last_seen_at`. A
 *      client whose timers were frozen therefore can't undercount idle earnings.
 */
export function validateAndClampSave(userId, incoming) {
  const previous = readStateFromDb(userId) || blankState();
  const prevSeq = Number(previous.save_seq) || 0;
  const incomingSeq = Number(incoming?.save_seq);

  // ----- 0. Stale snapshot: the client is a version behind, so its numbers
  //          describe a world that no longer exists. Hand back current state
  //          and let it resync; do NOT touch last_seen_at (that would silently
  //          swallow the idle window this save was late for).
  if (Number.isFinite(incomingSeq) && incomingSeq < prevSeq) {
    console.warn(`[glizzy] dropping stale save for ${userId}: seq ${incomingSeq} < ${prevSeq}`);
    const staleBonuses = computeBonuses(userId);
    return {
      state: previous,
      bonuses: staleBonuses,
      rates: computeEffectiveRates(previous, staleBonuses),
      stale: true,
    };
  }

  const out = blankState();
  out.save_seq = prevSeq;
  const prevGlizzies = previous.glizzies || 0;
  const prevClicks = previous.total_clicks || 0;
  const prevSeen = previous.last_seen_at ? new Date(previous.last_seen_at).getTime() : Date.now();
  const trueElapsedSec = Math.max(0, (Date.now() - prevSeen) / 1000);
  const elapsedSec = Math.max(1, trueElapsedSec);

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
  //
  // The budget also has to cover the WHOLE window, not just its final instant.
  // Golden buffs expire on a wall clock, so a save landing a second after one
  // ends covers seconds that were genuinely buffed; asking only "what are they
  // earning now?" would clamp those earnings away. That is barely visible on a
  // 3-minute Frenzy against a 5-second save interval, and eats a third of a
  // 15-second DEMON DOG or a 10-second GOLDEN RUSH — the two rewards a player
  // sees once in a hundred glizzies and is guaranteed to notice losing.
  // So take the better of the window's two endpoints, per component. The
  // concession to a cheater is one save window at the higher rate after a buff
  // ends, which they must have legitimately earned the buff to get at all.
  const bonuses = computeBonuses(userId);
  const ratesAtStart = computeEffectiveRates(previous, bonuses, prevSeen);
  const ratesAtEnd = computeEffectiveRates(previous, bonuses);
  // Ceiling takes the window's better endpoint; the passive floor further down
  // takes its worse one. Both stay conservative in their own direction — a
  // buff that expired mid-window must not shrink the ceiling, and must not
  // inflate the floor either.
  const ratesCeil = {
    perSecond: Math.max(ratesAtStart.perSecond, ratesAtEnd.perSecond),
    perClick: Math.max(ratesAtStart.perClick, ratesAtEnd.perClick),
  };
  const ratesFloor = {
    perSecond: Math.min(ratesAtStart.perSecond, ratesAtEnd.perSecond),
  };
  const maxEarnedSincePrev = Math.ceil(
    ratesCeil.perSecond * Math.min(elapsedSec, OFFLINE_CAP_SECONDS) +
      clickDelta * ratesCeil.perClick * 1.5,
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

  // ----- 6. Glizzies: clamped into [floor, ceiling].
  //   ceiling — everything they could possibly have earned (anti-cheat).
  //   floor   — everything they definitely *did* earn passively. Buildings
  //             produce on wall-clock time, so a client whose timers were
  //             throttled or frozen (backgrounded phone) must not be able to
  //             report a lower bank than the buildings already generated.
  let incomingGlizzies = isNonNegFinite(incoming?.glizzies) ? incoming.glizzies : previous.glizzies;
  const glizzyCeiling = Math.max(0, budget - finalSpending);
  const passiveEarned = ratesFloor.perSecond * Math.min(trueElapsedSec, OFFLINE_CAP_SECONDS);
  const glizzyFloor = Math.max(0, Math.min(glizzyCeiling, prevGlizzies + passiveEarned - finalSpending));
  if (incomingGlizzies > glizzyCeiling) {
    console.warn(`[glizzy] clamping glizzies for ${userId}: claimed ${incomingGlizzies}, ceiling ${Math.floor(glizzyCeiling)}`);
    incomingGlizzies = glizzyCeiling;
  } else if (incomingGlizzies < glizzyFloor) {
    incomingGlizzies = glizzyFloor;
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
