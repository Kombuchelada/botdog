// GlizzyClicker golden-glizzy tests.
//
// The first non-brawl tests in the repo, and they exist for the reason the
// brawl audio tests do: everything here fails *silently*. A clamp that eats a
// reward doesn't throw, doesn't log anything a player sees, and surfaces weeks
// later as one person saying "my mega didn't do anything".
//
// glizzy.js reaches the DB at import time (database.js opens the file on
// module load), so DB_PATH is pointed at a scratch file before any import.

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "glizzy-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { upsertGameStateStmt, db } = await import("../database.js");
const {
  GOLDEN_BONUSES,
  computeEffectiveRates,
  computeBonuses,
  validateAndClampSave,
} = await import("../glizzy.js");

const USER = "test-player";

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A minimal saved state. `overrides` is merged on top. */
function seed(overrides = {}) {
  const state = {
    glizzies: 0,
    lifetime: 0,
    total_clicks: 0,
    buildings: {},
    upgrades_owned: [],
    golden_effects: [],
    last_golden_at: null,
    last_seen_at: new Date().toISOString(),
    save_seq: 1,
    ...overrides,
  };
  upsertGameStateStmt.run(USER, JSON.stringify(state), Math.floor(state.lifetime));
  return state;
}

// ---------------------------------------------------------------------------
// The reward table's invariants
// ---------------------------------------------------------------------------

test("golden bonus weights sum to exactly 1000", () => {
  const total = GOLDEN_BONUSES.reduce((s, b) => s + b.weight, 0);
  assert.equal(total, 1000, "weights must sum to 1000 so odds are readable as tenths of a percent");
});

test("every mega is weight 10 (1 in 100)", () => {
  const megas = GOLDEN_BONUSES.filter((b) => b.mega);
  assert.ok(megas.length > 0);
  for (const m of megas) {
    assert.equal(m.weight, 10, `${m.id} is a mega and must be 1/100`);
  }
});

// ---------------------------------------------------------------------------
// A click buff is a click buff — it must not touch production
// ---------------------------------------------------------------------------

test("a click_mult buff multiplies perClick and leaves perSecond alone", () => {
  const now = Date.now();
  const base = {
    buildings: { glizzy_cart: 5 },
    golden_effects: [],
  };
  const bonuses = computeBonuses(USER);
  const before = computeEffectiveRates(base, bonuses, now);

  const buffed = {
    ...base,
    golden_effects: [{
      kind: "click_mult",
      mult: 666,
      starts_at: new Date(now - 1000).toISOString(),
      expires_at: new Date(now + 14000).toISOString(),
    }],
  };
  const after_ = computeEffectiveRates(buffed, bonuses, now);

  assert.equal(after_.perClick, before.perClick * 666);
  assert.equal(after_.perSecond, before.perSecond,
    "click buffs are player-interaction only — production must not move");
});

test("computeEffectiveRates evaluates buffs at the instant it is given", () => {
  const now = Date.now();
  const state = {
    buildings: {},
    golden_effects: [{
      kind: "click_mult",
      mult: 666,
      starts_at: new Date(now - 20000).toISOString(),
      expires_at: new Date(now - 3000).toISOString(),
    }],
  };
  const bonuses = computeBonuses(USER);
  assert.equal(computeEffectiveRates(state, bonuses, now).perClick, 1,
    "expired at `now`");
  assert.equal(computeEffectiveRates(state, bonuses, now - 10000).perClick, 666,
    "still running 10s ago");
});

// ---------------------------------------------------------------------------
// The clamp window — the bug these tests exist for
// ---------------------------------------------------------------------------

test("a save whose window straddles a buff expiry keeps the buffed click earnings", () => {
  const now = Date.now();
  // Buff ran from 20s ago until 3s ago. The save covers the last 6s, so 3 of
  // those seconds were genuinely buffed.
  seed({
    last_seen_at: new Date(now - 6000).toISOString(),
    golden_effects: [{
      kind: "click_mult",
      mult: 666,
      starts_at: new Date(now - 20000).toISOString(),
      expires_at: new Date(now - 3000).toISOString(),
    }],
  });

  const clicks = 30;
  const claimed = clicks * 666;
  const { state } = validateAndClampSave(USER, {
    save_seq: 1,
    total_clicks: clicks,
    glizzies: claimed,
    buildings: {},
    upgrades_owned: [],
  });

  assert.equal(state.glizzies, claimed,
    "earnings from inside the buff window must survive the clamp");
});

test("the same save with no buff at all is still clamped", () => {
  const now = Date.now();
  seed({
    last_seen_at: new Date(now - 6000).toISOString(),
    golden_effects: [],
  });

  const clicks = 30;
  const { state } = validateAndClampSave(USER, {
    save_seq: 1,
    total_clicks: clicks,
    glizzies: clicks * 666,
    buildings: {},
    upgrades_owned: [],
  });

  assert.ok(state.glizzies < clicks * 666,
    "widening the budget for expired buffs must not open a hole for everyone else");
  assert.ok(state.glizzies <= Math.ceil(clicks * 1 * 1.5 * 1.2) + 1,
    "unbuffed ceiling is clicks x perClick x 1.5 x overage");
});

test("a buff that expired before the window opened grants no extra budget", () => {
  const now = Date.now();
  seed({
    last_seen_at: new Date(now - 6000).toISOString(),
    golden_effects: [{
      kind: "click_mult",
      mult: 666,
      starts_at: new Date(now - 40000).toISOString(),
      expires_at: new Date(now - 30000).toISOString(),
    }],
  });

  const clicks = 30;
  const { state } = validateAndClampSave(USER, {
    save_seq: 1,
    total_clicks: clicks,
    glizzies: clicks * 666,
    buildings: {},
    upgrades_owned: [],
  });

  assert.ok(state.glizzies < clicks * 666,
    "only buffs live at one of the window's endpoints may widen the budget");
});

test("a production buff expiring mid-window does not inflate the passive floor", () => {
  const now = Date.now();
  // A frozen client reports a smaller bank than its buildings produced; the
  // floor corrects that. But the floor must use the window's *worse* endpoint,
  // or an expired Frenzy credits production that never happened.
  seed({
    glizzies: 0,
    buildings: { glizzy_cart: 10 },
    last_seen_at: new Date(now - 10000).toISOString(),
    golden_effects: [{
      kind: "prod_mult",
      mult: 500,
      starts_at: new Date(now - 30000).toISOString(),
      expires_at: new Date(now - 5000).toISOString(),
    }],
  });

  const bonuses = computeBonuses(USER);
  const unbuffedPerSec = computeEffectiveRates(
    { buildings: { glizzy_cart: 10 }, golden_effects: [] }, bonuses, now,
  ).perSecond;

  const { state } = validateAndClampSave(USER, {
    save_seq: 1,
    total_clicks: 0,
    glizzies: 0,
    buildings: { glizzy_cart: 10 },
    upgrades_owned: [],
  });

  assert.ok(state.glizzies <= Math.ceil(unbuffedPerSec * 11) + 1,
    "the floor must not credit production at an expired buff's rate");
});
