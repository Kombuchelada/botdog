// How long would the GlizzyClicker upgrade catalog last a given player?
//
// Replays one player's saved state forward under each scenario in
// scripts/lib/glizzy-pacing.mjs and prints how many of the upgrades they
// don't yet own they'd have by each New Year, and when they'd own them all.
// Run it against a fresh backup before retuning prices (docs/glizzy-pacing.md):
//
//   DB_PATH=./hotdog-data.db node scripts/glizzy-pacing.mjs [--user ID] [--years N] [--scenarios a,b]
//
// Defaults to the player with the highest lifetime. Read-only.

import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    user: { type: "string" },
    years: { type: "string", default: "25" },
    scenarios: { type: "string", default: "realistic,api_bot,paranoid,paranoid_x2" },
  },
});

const G = await import("../glizzy.js");
const { db } = await import("../database.js");
const { simulate, SCENARIOS } = await import("./lib/glizzy-pacing.mjs");

const row = args.user
  ? db.prepare("SELECT user_id, state FROM glizzy_game WHERE user_id = ?").get(args.user)
  : db.prepare("SELECT user_id, state FROM glizzy_game ORDER BY lifetime_glizzies DESC LIMIT 1").get();
if (!row) throw new Error("no such player");
const state = JSON.parse(row.state);
const start = Date.now();
const remaining = G.UPGRADES.filter((u) => !state.upgrades_owned.includes(u.id)).length;
const date = (t) => new Date(start + t * 1000).toISOString().slice(0, 10);

const years = [];
for (let y = new Date(start).getUTCFullYear() + 1; y <= new Date(start).getUTCFullYear() + Number(args.years); y++) {
  if (years.length < 6 || y % 5 === 0) years.push(y);
}

console.log(`player ${row.user_id}: owns ${state.upgrades_owned.length}/${G.UPGRADES.length}, ${remaining} to go, lifetime ${state.lifetime.toExponential(2)}`);
console.log("scenario".padEnd(12) + years.map((y) => String(y).padStart(6)).join("") + "   all owned");
for (const name of args.scenarios.split(",")) {
  const { bought } = simulate(G, state, SCENARIOS[name], { years: Number(args.years) });
  const by = (y) => bought.filter((b) => start + b.t * 1000 < Date.UTC(y, 0, 1, 8)).length;
  const done = bought.length === remaining ? date(bought[bought.length - 1].t) : `not by ${years[years.length - 1]}`;
  console.log(name.padEnd(12) + years.map((y) => String(by(y)).padStart(6)).join("") + "   " + done);
}
