// GlizzyClicker click-power tests.
//
// `click_from_pps` is the only effect whose value depends on the rest of the
// state, and the arithmetic around it is the kind that fails silently: getting
// the share inside the click multipliers instead of outside makes one tap worth
// days of production, and getting the golden buff outside instead of inside
// makes DEMON DOG the one reward that gets weaker as you get richer. Neither
// throws, and neither is visible in a diff.
//
// glizzy.js reaches the DB at import time, so DB_PATH points at a scratch file
// before any import (same as glizzy-golden.test.js).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "glizzy-click-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { db } = await import("../database.js");
const { UPGRADES, computeEffectiveRates } = await import("../glizzy.js");

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

const NO_BONUSES = [];
const PPS_UPGRADES = UPGRADES.filter((u) => u.effect.type === "click_from_pps");

function ratesFor(overrides = {}) {
  return computeEffectiveRates(
    { buildings: {}, upgrades_owned: [], golden_effects: [], ...overrides },
    NO_BONUSES,
    Date.now(),
  );
}

test("the click_from_pps line exists and totals 10% of production per click", () => {
  assert.ok(PPS_UPGRADES.length >= 2, "a single rung is a gimmick, not a ladder");
  const total = PPS_UPGRADES.reduce((s, u) => s + u.effect.value, 0);
  assert.ok(
    Math.abs(total - 0.10) < 1e-9,
    `owning the whole line pays ${total} of /s per click; 0.10 is the tuned figure ` +
      "(a human mashing ~10/s roughly doubles their income, and no more)",
  );
});

test("a click_from_pps upgrade pays its share of production and leaves production alone", () => {
  const buildings = { glizzy_cart: 40, food_truck: 10 };
  const before = ratesFor({ buildings });
  const up = PPS_UPGRADES[0];
  const after_ = ratesFor({ buildings, upgrades_owned: [up.id] });

  assert.equal(after_.perSecond, before.perSecond, "click upgrades must not touch /s");
  assert.ok(before.perSecond > 0, "the fixture needs production for the share to be visible");
  assert.ok(
    Math.abs(after_.perClick - (before.perClick + before.perSecond * up.effect.value)) < 1e-6,
    "the share is added to the click, exactly",
  );
});

test("the shares are additive and click multipliers do not multiply them", () => {
  const buildings = { food_truck: 25 };
  const base = ratesFor({ buildings });
  const allPps = PPS_UPGRADES.map((u) => u.id);
  const share = PPS_UPGRADES.reduce((s, u) => s + u.effect.value, 0);

  const withPps = ratesFor({ buildings, upgrades_owned: allPps });
  assert.ok(Math.abs(withPps.perClick - (base.perClick + base.perSecond * share)) < 1e-6);

  // Stacking the click ladder on top must move only the fixed part. If the
  // ladder multiplied the share too, this click would be worth ~1.3M% of /s.
  const ladder = UPGRADES.filter((u) => u.effect.type === "click_mult").map((u) => u.id);
  const withBoth = ratesFor({ buildings, upgrades_owned: allPps.concat(ladder) });
  const laddered = ratesFor({ buildings, upgrades_owned: ladder });
  assert.ok(
    Math.abs(withBoth.perClick - (laddered.perClick + laddered.perSecond * share)) < 1e-6,
    "the production share sits outside the click multipliers",
  );
});

test("a golden click buff does multiply the production share", () => {
  const now = Date.now();
  const buildings = { food_truck: 25 };
  const upgrades_owned = PPS_UPGRADES.map((u) => u.id);
  const unbuffed = ratesFor({ buildings, upgrades_owned });
  const buffed = computeEffectiveRates(
    {
      buildings,
      upgrades_owned,
      golden_effects: [{
        kind: "click_mult",
        mult: 666,
        starts_at: new Date(now - 1000).toISOString(),
        expires_at: new Date(now + 14000).toISOString(),
      }],
    },
    NO_BONUSES,
    now,
  );

  assert.ok(
    Math.abs(buffed.perClick - unbuffed.perClick * 666) < 1e-3,
    "DEMON DOG is the mash-right-now reward; if it missed the production share " +
      "it would be the one buff that gets weaker the further a player gets",
  );
  assert.equal(buffed.perSecond, unbuffed.perSecond);
});

test("with no click_from_pps upgrade owned, click power is unchanged by production", () => {
  const poor = ratesFor({ buildings: {} });
  const rich = ratesFor({ buildings: { multiverse_glizzy: 500 } });
  assert.equal(rich.perClick, poor.perClick,
    "the share is opt-in — an untouched save must compute exactly as before");
});
