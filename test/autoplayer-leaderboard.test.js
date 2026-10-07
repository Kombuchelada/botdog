// The Autoplayer TUI's leaderboard. The pass-ETA is the one number on it that
// can mislead without looking wrong: counting an idle player's /s as if they
// were playing turns "passing them in 5 minutes" into "never".

import { test } from "node:test";
import assert from "node:assert/strict";
import { standings } from "../scripts/autoplayer/leaderboard.mjs";

const NOW = Date.parse("2026-10-07T20:00:00Z");
const sqlite = (ms) => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
const row = (user_id, lifetime, per_second, agoMs) => ({ user_id, name: "p" + user_id, lifetime, per_second, updated_at: sqlite(NOW - agoMs) });

test("my live lifetime replaces my stored row and re-ranks", () => {
  const rows = [row("a", 1000, 0, 1e9), row("me", 100, 0, 0), row("b", 500, 0, 1e9)];
  const st = standings(rows, { userId: "me", lifetime: 600, income: 10 }, NOW);
  assert.deepEqual(st.list.map((r) => r.userId), ["a", "me", "b"]);
  assert.equal(st.myRank, 2);
  assert.equal(st.list[1].lifetime, 600);
});

test("an idle player stands still: ETA is gap ÷ my income", () => {
  const st = standings([row("a", 1000, 50, 10 * 60_000)], { userId: "me", lifetime: 400, income: 10 }, NOW);
  assert.equal(st.passIn, 60);
});

test("an active player's /s closes the gap more slowly", () => {
  const st = standings([row("a", 1000, 5, 10_000)], { userId: "me", lifetime: 400, income: 10 }, NOW);
  assert.equal(st.passIn, 120);
  assert.equal(st.list[0].active, true);
});

test("never, when an active player above out-earns me", () => {
  const st = standings([row("a", 1000, 20, 10_000)], { userId: "me", lifetime: 400, income: 10 }, NOW);
  assert.equal(st.passIn, Infinity);
});

test("first place has nobody to pass", () => {
  const st = standings([row("a", 10, 0, 0)], { userId: "me", lifetime: 400, income: 10 }, NOW);
  assert.equal(st.myRank, 1);
  assert.equal(st.passIn, null);
});

test("below a full top 50 there's no honest rank or ETA", () => {
  const rows = Array.from({ length: 50 }, (_, i) => row("p" + i, 1e6 - i, 0, 1e9));
  const st = standings(rows, { userId: "me", lifetime: 5, income: 10 }, NOW);
  assert.equal(st.myRank, null);
  assert.equal(st.passIn, null);
});
