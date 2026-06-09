// Seed realistic GlizzyClicker demo data for showing off the golden glizzy
// feature locally. Idempotent — re-running overwrites the same demo users.
//
//   DB_PATH=./golden-demo.db node scripts/seed-golden-demo.js
//   DB_PATH=./golden-demo.db GLIZZY_TEST_MODE=1 \
//     ADMIN_PASSWORD=dev PUBLIC_KEY=dummy DISCORD_TOKEN=dummy APP_ID=dummy node app.js
//
// Dev-bypass logs you in as the most-recently-active hotdog_events user, which
// this script makes the owner ("Daniel"), so /game opens straight onto a loaded
// account.

import {
  db,
  upsertGameStateStmt,
  upsertUserProfileStmt,
  insertEventWithTimestampStmt,
} from "../database.js";
import { computeEffectiveRates, BUILDINGS } from "../glizzy.js";
import { toPacificDateKey } from "../stats.js";

const UPGRADES_FULL = [
  "sharper_knife", "better_mustard", "fresh_buns", "premium_cart", "fancy_truck",
  "sponsorship_deal", "faster_hands", "brand_loyalty", "ketchup_sin", "hot_dog_pope",
  "franchise_playbook", "reinforced_casing", "golden_tongs", "assembly_line",
  "vertical_integration",
];

// A UTC timestamp string ("YYYY-MM-DD HH:MM:SS") for a given Pacific date key +
// Pacific hour. June is PDT (UTC-7); Date.UTC handles hour overflow into the
// next UTC day, while toPacificDateKey still maps it back to the intended day.
function pacificStamp(dateKey, hour) {
  const [y, m, d] = dateKey.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d, hour + 7, 0, 0));
  return dt.toISOString().slice(0, 19).replace("T", " ");
}

// dateKey for `daysAgo` days before today (Pacific).
function pacificKeyDaysAgo(daysAgo) {
  const todayKey = toPacificDateKey(new Date());
  const anchor = new Date(todayKey + "T12:00:00Z");
  anchor.setUTCDate(anchor.getUTCDate() - daysAgo);
  return toPacificDateKey(anchor);
}

// Build a glizzy_game state and size the bank to ~`bankMinutes` of production so
// the Lucky! reward demonstrates its floor/cap banding.
function gameState({ buildings, upgrades, bankMinutes, lifetime }) {
  const partial = {
    glizzies: 0, lifetime, total_clicks: 0,
    buildings, upgrades_owned: upgrades,
    golden_effects: [], last_golden_at: null,
    last_seen_at: new Date().toISOString(),
  };
  const perSecond = computeEffectiveRates(partial, []).perSecond;
  partial.glizzies = Math.floor(perSecond * 60 * bankMinutes);
  return partial;
}

function seedPlayer({ userId, username, globalName, buildings, upgrades, bankMinutes, lifetime }) {
  const state = gameState({ buildings, upgrades, bankMinutes, lifetime });
  upsertGameStateStmt.run(userId, JSON.stringify(state), Math.floor(lifetime));
  upsertUserProfileStmt.run(userId, username, globalName, null, null);
  return state;
}

// Wipe prior demo rows so re-runs stay clean.
const DEMO_IDS = [
  "100000000000000001", "100000000000000002",
  "100000000000000003", "100000000000000004",
];
const wipe = db.transaction(() => {
  for (const id of DEMO_IDS) {
    db.prepare("DELETE FROM glizzy_game WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM user_profiles WHERE user_id = ?").run(id);
    db.prepare("DELETE FROM hotdog_events WHERE user_id = ?").run(id);
  }
});
wipe();

// --- The owner: a loaded mid/late-game account (dev-bypass logs in as this) ---
const OWNER = "100000000000000001";
const ownerState = seedPlayer({
  userId: OWNER, username: "daniel", globalName: "Daniel",
  buildings: { mustard_stand: 122, bun_factory: 118, glizzy_cart: 110, food_truck: 98, stadium: 90, franchise: 12, orbital_station: 4 },
  upgrades: UPGRADES_FULL,
  bankMinutes: 25,        // 20% = 5 min -> Lucky floors up toward the band
  lifetime: 5.2e11,
});

// Owner hot dog history -> live bonuses (streak + big eater + breakfast + night owl + Centurion-class lifetime).
const ownerEvents = [];
// One historical bulk event so lifetime dog count clears the milestone tiers.
ownerEvents.push([pacificKeyDaysAgo(200), 12, 520]);
// A 14-day active streak (2 dogs/day at noon).
for (let d = 1; d <= 14; d++) ownerEvents.push([pacificKeyDaysAgo(d), 12, 2]);
// Yesterday: early dog (Breakfast Boon) + late dog (Night Owl) + extras -> >4 total (Big Eater).
ownerEvents.push([pacificKeyDaysAgo(1), 7, 3]);
ownerEvents.push([pacificKeyDaysAgo(1), 23, 1]);
// Today: a couple so "today" is alive and the owner is the most-recent event.
ownerEvents.push([pacificKeyDaysAgo(0), 9, 2]);
ownerEvents.push([pacificKeyDaysAgo(0), Math.min(new Date().getUTCHours(), 20), 1]);

const insertOwnerEvents = db.transaction(() => {
  for (const [key, hour, amount] of ownerEvents) {
    insertEventWithTimestampStmt.run(OWNER, "daniel", amount, pacificStamp(key, hour));
  }
});
insertOwnerEvents();

// --- A few rival players for a realistic leaderboard ---
seedPlayer({
  userId: "100000000000000002", username: "marcus", globalName: "Marcus",
  buildings: { mustard_stand: 130, bun_factory: 125, glizzy_cart: 120, food_truck: 100, stadium: 86, franchise: 0, orbital_station: 0 },
  upgrades: UPGRADES_FULL.filter((u) => !["franchise_playbook", "reinforced_casing"].includes(u)),
  bankMinutes: 2, lifetime: 3.4e11,
});
seedPlayer({
  userId: "100000000000000003", username: "priya", globalName: "Priya",
  buildings: { mustard_stand: 103, bun_factory: 100, glizzy_cart: 96, food_truck: 82, stadium: 75, franchise: 0, orbital_station: 0 },
  upgrades: UPGRADES_FULL.filter((u) => !["hot_dog_pope", "franchise_playbook", "reinforced_casing"].includes(u)),
  bankMinutes: 60, lifetime: 4.5e10,   // a hoarder -> Lucky caps out at 10 min
});
seedPlayer({
  userId: "100000000000000004", username: "sam", globalName: "Sam",
  buildings: { mustard_stand: 18, bun_factory: 9, glizzy_cart: 4, food_truck: 1, stadium: 0, franchise: 0, orbital_station: 0 },
  upgrades: ["sharper_knife", "better_mustard"],
  bankMinutes: 5, lifetime: 9.8e4,     // an early player
});

const P = computeEffectiveRates(ownerState, []).perSecond;
console.log("Seeded golden glizzy demo:");
console.log(`  owner (Daniel)  production ≈ ${Math.round(P).toLocaleString()}/s  bank ≈ ${Math.round(P * 60 * 25).toLocaleString()} (25 min)`);
console.log(`  + 3 rival players for the leaderboard`);
console.log("  owner hot dog history -> Streak / Big Eater / Breakfast Boon / Night Owl bonuses");
console.log(`\nTotal glizzy_game rows: ${db.prepare("SELECT COUNT(*) c FROM glizzy_game").get().c}`);
