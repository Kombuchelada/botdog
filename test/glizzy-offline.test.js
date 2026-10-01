// GlizzyClicker offline-production tests.
//
// There is no idle cap. A 4-hour one shipped with the game and nobody knew:
// a player away for a week got exactly what a player away for an afternoon
// got, and the only symptom was one person noticing two welcome-back modals
// showed the same number.

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "glizzy-offline-test-"));
process.env.DB_PATH = join(dir, "test.db");

const { upsertGameStateStmt, db } = await import("../database.js");
const {
  computeEffectiveRates,
  computeBonuses,
  loadGameForUser,
  validateAndClampSave,
} = await import("../glizzy.js");

const USER = "test-player";
const HOUR = 60 * 60 * 1000;

after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

function seed(overrides = {}) {
  const state = {
    glizzies: 0,
    lifetime: 0,
    total_clicks: 0,
    buildings: { bun_factory: 10 },
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

function perSecond(state) {
  return computeEffectiveRates(state, computeBonuses(USER)).perSecond;
}

test("a week away earns a week of production, not four hours", () => {
  const away = 7 * 24 * HOUR;
  const seeded = seed({ last_seen_at: new Date(Date.now() - away).toISOString() });
  const pps = perSecond(seeded);
  assert.ok(pps > 0, "fixture must produce something");

  const { offlineEarned, state } = loadGameForUser(USER);
  const expected = pps * (away / 1000);
  assert.ok(
    offlineEarned >= expected * 0.999,
    `earned ${offlineEarned}, expected ~${expected} (4h would be ${pps * 14400})`,
  );
  assert.equal(state.glizzies, offlineEarned);
});

test("a tab frozen for days still banks every second its buildings produced", () => {
  const away = 3 * 24 * HOUR;
  const seeded = seed({ last_seen_at: new Date(Date.now() - away).toISOString() });
  const pps = perSecond(seeded);

  // The frozen client reports the bank it had before it was suspended.
  const { state } = validateAndClampSave(USER, { ...seeded, glizzies: 0 });
  assert.ok(
    state.glizzies >= pps * (away / 1000) * 0.999,
    `banked ${state.glizzies}, expected ~${pps * (away / 1000)}`,
  );
});
