// GlizzyClicker's second hundred upgrades ("Beyond the Final Frank").
//
// The first catalog was priced on a guess that nobody would own all of it,
// and somebody did within two months. Running out is silent — the upgrade
// list just stops — so these tests pin the two properties the new catalog was
// built for, with the same simulator that priced it (scripts/lib/glizzy-pacing.mjs):
//
//   1. It lasts. Even a bot at the anti-cheat ceiling that claims every
//      golden glizzy the server allows, at Glizzy Pope, on an unbroken streak,
//      with 2× margin on top, can't own every upgrade before 2031.
//   2. Clicking stays worth it. Nothing in it changes how much a click is
//      worth relative to idling.
//
// glizzy.js reaches the DB at import time, so DB_PATH points at a scratch
// file before any import (same as glizzy-golden.test.js).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "glizzy-beyond-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const G = await import("../glizzy.js");
const { simulate, goldenK } = await import("../scripts/lib/glizzy-pacing.mjs");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const BEYOND = G.UPGRADES.slice(-100);
const ORIGINAL = G.UPGRADES.slice(0, -100);

// The save that ran out of upgrades (2026-10-01): 98 of the original 99, an
// autoclicker at 25.8/s, every golden glizzy caught.
const RANDY = {
  glizzies: 7.07e19,
  lifetime: 7.36e20,
  buildings: {
    mustard_stand: 289, bun_factory: 275, glizzy_cart: 258, food_truck: 241, stadium: 224,
    franchise: 206, orbital_station: 188, glizzy_megaplex: 170, quantum_kitchen: 151,
    dyson_grill: 132, black_hole_bun: 116, multiverse_glizzy: 101,
  },
  upgrades_owned: ORIGINAL.map((u) => u.id).filter((id) => id !== "multiverse_glizzy_p4"),
  golden_effects: [],
};

const YEAR = 365.25 * 86400;
// Seconds from 2026-10-01 to Pacific New Year's Day.
const untilNewYear = (y) => (Date.UTC(y, 0, 1, 8) - Date.UTC(2026, 9, 1, 4)) / 1000;

test("a hundred of them, all above the old catalog, listed in price order", () => {
  assert.equal(new Set(G.UPGRADES.map((u) => u.id)).size, G.UPGRADES.length, "upgrade ids must be unique");
  assert.equal(BEYOND.length, 100);
  const oldMax = Math.max(...ORIGINAL.map((u) => u.cost));
  assert.ok(BEYOND[0].cost < oldMax, "the first rung should land before the old catalog's last, so there's no dead zone");
  for (let i = 1; i < BEYOND.length; i++) {
    assert.ok(BEYOND[i].cost > BEYOND[i - 1].cost, `${BEYOND[i].id} is priced out of order`);
  }
});

test("every icon already has pixel art (the PixelLab subscription is gone)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../assets/clicker/manifest.json", import.meta.url)));
  for (const u of BEYOND) assert.ok(manifest.emoji[u.emoji], `${u.id}: no art for ${u.emoji}`);
});

test("production-side effects only", () => {
  // Golden frequency/duration make income super-linear (buff coverage
  // compounds), and golden payout pays idlers as much as clickers — three of
  // them cut clicking's edge over idling from +48% to +22%.
  const allowed = new Set(["building_mult", "global_mult", "building_synergy", "global_per_building"]);
  for (const u of BEYOND) assert.ok(allowed.has(u.effect.type), `${u.id}: ${u.effect.type}`);
});

test("a click is worth the same share of production with or without them", () => {
  const bonuses = [{ effect: { type: "global_mult", value: 2 } }];
  const before = G.computeEffectiveRates(RANDY, bonuses, 0);
  const after_ = G.computeEffectiveRates({ ...RANDY, upgrades_owned: G.UPGRADES.map((u) => u.id) }, bonuses, 0);
  assert.ok(after_.perSecond > 1000 * before.perSecond, "they should be worth having");
  const ratio = (r) => r.perClick / r.perSecond;
  assert.ok(Math.abs(ratio(after_) - ratio(before)) < 1e-3, `click/production went ${ratio(before)} → ${ratio(after_)}`);
});

test("clicking still beats idling once golden glizzies are in play", () => {
  const gm = G.computeGoldenModifiers({ upgrades_owned: G.UPGRADES.map((u) => u.id) });
  const k = (cps) => goldenK({ ...gm, cps, claimEvery: 230, days: 10 });
  const edge = k(6) / k(0);
  assert.ok(edge > 1.4, `a human clicking 6/s earns only ${edge.toFixed(2)}× an idler`);
});

test("the golden model still matches what the data showed", () => {
  // Randy's backups: income at ~49× base production for weeks on end. If the
  // reward table changes, this moves — re-run scripts/glizzy-pacing.mjs.
  const gm = G.computeGoldenModifiers(RANDY);
  const k = goldenK({ ...gm, cps: 25.8, claimEvery: 230, days: 20 });
  assert.ok(k > 40 && k < 60, `K = ${k.toFixed(1)}`);
});

test("the most a bot could do doesn't empty the catalog before 2031", () => {
  // K = 2 × what claiming at the server floor (every 116 s) is worth, at
  // Glizzy Pope, with the streak compounding from today.
  const { bought } = simulate(G, RANDY, { k: 470, milestone: 6, streak: true }, { years: untilNewYear(2031) / YEAR });
  assert.ok(bought.length < 101, `owned all ${bought.length} before 2031`);
});

test("but the bot that actually exists gets a steady stream of them", () => {
  const { bought } = simulate(G, RANDY, { k: 49, milestone: 2 }, { years: untilNewYear(2031) / YEAR });
  const by = (y) => bought.filter((b) => b.t < untilNewYear(y)).length;
  assert.ok(bought[0].t < 14 * 86400, "first one within two weeks");
  assert.ok(by(2027) >= 10, `only ${by(2027)} by the season's end`);
  assert.ok(by(2029) - by(2028) >= 10, "still buying in 2028");
  assert.ok(by(2031) - by(2030) >= 5, "still buying in 2030");
  assert.ok(by(2031) < 101, "and not finished");
});
