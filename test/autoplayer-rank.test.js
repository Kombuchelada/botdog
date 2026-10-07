// Autoplayer purchase-ranking tests.
//
// The ranking is the one part of the Autoplayer that fails silently: a wrong
// pick still buys *something*, the number still goes up, and nothing says it
// went up slower than it should have. The launcher and the DOM driving are
// tested by watching them play; this is tested against the authoritative
// computeEffectiveRates in glizzy.js (the page runs it against game.js's
// replica, which CLAUDE.md requires to match).
//
// glizzy.js reaches the DB at import time, so DB_PATH points at a scratch file
// before any import (same as glizzy-golden.test.js).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "autoplayer-rank-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const { BUILDINGS, UPGRADES, computeEffectiveRates, buildingCost } = await import("../glizzy.js");
const { rankPurchases, decide, GOLDEN_EFFECTS } = await import("../scripts/autoplayer/rank.js");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const catalog = { buildings: BUILDINGS, upgrades: UPGRADES };
const byId = (id) => UPGRADES.find((u) => u.id === id);

function args(state, cps = 25) {
  const st = { buildings: {}, upgrades_owned: [], golden_effects: [], glizzies: 0, ...state };
  return {
    state: st,
    catalog,
    ratesFor: (s) => computeEffectiveRates(s, [], Date.now()),
    nextCost: (id) => buildingCost(id, st.buildings[id] || 0),
    cps,
  };
}

test("a click upgrade is priced at the Autoplayer's click rate", () => {
  // Fresh start: Sharper Knife (×2 click, 100) adds 25 × 1 = 25/s of clicking;
  // a Mustard Stand (15) adds 0.1/s. The Oracle can't see the knife at all.
  const [best] = rankPurchases(args({}));
  assert.equal(best.id, "sharper_knife");
  assert.equal(best.delta, 25);
});

test("with no clicking, click upgrades drop out and it's the Oracle's ranking", () => {
  const ranked = rankPurchases(args({ buildings: { mustard_stand: 5 } }, 0));
  assert.ok(ranked.length > 0);
  for (const c of ranked) {
    if (c.kind === "upgrade") assert.ok(!byId(c.id).effect.type.startsWith("click_"), c.id);
  }
});

test("click_from_pps is valued by the production it pays per click", () => {
  const hands = UPGRADES.find((u) => u.effect.type === "click_from_pps");
  const state = { buildings: { food_truck: 100 } };
  const pps = computeEffectiveRates({ ...args(state).state }, [], Date.now()).perSecond;
  const c = rankPurchases(args(state)).find((x) => x.id === hands.id);
  assert.ok(Math.abs(c.delta - 25 * hands.effect.value * pps) < 1e-6 * c.delta);
});

test("golden upgrades are never ranked", () => {
  const ranked = rankPurchases(args({ buildings: { multiverse_glizzy: 50 } }));
  assert.ok(!ranked.some((c) => c.kind === "upgrade" && GOLDEN_EFFECTS.includes(byId(c.id).effect.type)));
});

test("an affordable golden upgrade is bought before the ranking's #1", () => {
  const d = decide(args({ glizzies: 1e15, buildings: { food_truck: 10 } }));
  assert.ok(d.buy);
  assert.ok(GOLDEN_EFFECTS.includes(byId(d.buy.id).effect.type), d.buy.id);
  // Cheapest golden upgrade first.
  const cheapest = UPGRADES.filter((u) => GOLDEN_EFFECTS.includes(u.effect.type)).sort((a, b) => a.cost - b.cost)[0];
  assert.equal(d.buy.id, cheapest.id);
});

test("it saves for #1 rather than buying something cheaper", () => {
  // 50 glizzies: a Mustard Stand (15) is affordable, Sharper Knife (100) is #1.
  const d = decide(args({ glizzies: 50 }));
  assert.equal(d.wait.id, "sharper_knife");
  assert.equal(d.short, 50);
});

test("it buys #1 the moment it's affordable", () => {
  assert.equal(decide(args({ glizzies: 100 })).buy.id, "sharper_knife");
});

test("owned upgrades are not candidates", () => {
  const ranked = rankPurchases(args({ upgrades_owned: ["sharper_knife"] }));
  assert.ok(!ranked.some((c) => c.id === "sharper_knife"));
});

test("a running golden buff doesn't change the ranking", () => {
  const now = Date.now();
  // DEMON DOG: ×666 click. Unstripped, it would inflate every click delta.
  const buff = { kind: "click_mult", mult: 666, starts_at: new Date(now - 1000).toISOString(), expires_at: new Date(now + 60_000).toISOString() };
  const state = { buildings: { food_truck: 20, glizzy_cart: 30 }, upgrades_owned: ["sharper_knife"] };
  const plain = rankPurchases(args(state));
  const buffed = rankPurchases(args({ ...state, golden_effects: [buff] }));
  assert.deepEqual(buffed, plain);
});
