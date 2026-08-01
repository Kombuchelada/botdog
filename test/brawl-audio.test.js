// GlizzyBrawl — what the Arena sounds like.
//
// A fourth seam, and it exists for the same reason the art one does: neither
// the WebSocket boundary nor the sim's public API can observe sound at all, and
// the failure modes here are silent ones. A cue that names a recipe which does
// not exist, a swing that fires twice on every attack because a snapshot pulled
// a frame counter backwards, a new Fighter shipped with no voice — none of them
// throw, and none of them show up in a screenshot.
//
// These tests assert only what `brawl-audio.js` returns from its pure
// functions. No AudioContext is constructed, nothing is mocked, and nothing
// here knows how a cue is turned into sound — that is the engine's half, in
// `brawl-page.js`, and it changes whenever the mix does.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  CUES,
  CUE_IDS,
  SPECIAL_CUES,
  MASTER_GAIN,
  MAX_CUE_GAIN,
  cueFor,
  transitionCues,
  fighterAudioState,
  panFor,
} from "../brawl-audio.js";
import { STAGE, MOVES, SPECIALS, FIGHTERS } from "../brawl-sim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/** A Fighter's audio state, in the shape the watcher keeps. */
function fighter(over = {}) {
  return fighterAudioState({
    id: "p1",
    x: STAGE.ground.x1 + (STAGE.ground.x2 - STAGE.ground.x1) / 2,
    vy: 0,
    onGround: true,
    state: "idle",
    dodgeTicks: 0,
    attack: null,
    ...over,
  });
}

/** Mid-attack, in the shape the wire carries — the move's frame data inline. */
function swinging(moveName, frame = 0, over = {}) {
  const m = MOVES[moveName] || SPECIALS[moveName];
  assert.ok(m, "unknown move " + moveName);
  return fighter({
    state: "attack",
    attack: {
      kind: m.kind || null,
      frame,
      move: moveName,
      startup: m.startup,
      active: m.active,
      endlag: m.endlag,
    },
    ...over,
  });
}

const only = (cues, id) => cues.filter((c) => c.id === id);
const ids = (cues) => cues.map((c) => c.id).sort();

// --------------------------------------------------------------- the recipes

test("every cue recipe is playable", () => {
  assert.ok(CUE_IDS.length > 0);
  for (const id of CUE_IDS) {
    const cue = CUES[id];
    assert.ok(Array.isArray(cue.layers) && cue.layers.length > 0, id + " has no layers");
    assert.ok(cue.cooldownMs >= 0, id + " has a negative cooldown");
    for (const layer of cue.layers) {
      assert.ok(layer.kind === "tone" || layer.kind === "noise", id + " has an unknown layer kind");
      // Frequencies are swept exponentially, which is undefined through zero.
      assert.ok(layer.from > 0 && layer.to > 0, id + " sweeps through or from zero");
      assert.ok(layer.gain > 0, id + " has a silent layer");
      assert.ok(layer.decay > 0, id + " has a layer with no decay");
      if (layer.kind === "noise") assert.ok(layer.filter, id + " has an unfiltered noise layer");
    }
  }
});

test("the mix stays out of the red", () => {
  assert.ok(MASTER_GAIN > 0 && MASTER_GAIN <= 1);
  for (const id of CUE_IDS) {
    const summed = CUES[id].layers.reduce((n, l) => n + l.gain, 0);
    // Layers of one cue play together, so their gains add. Times the loudest a
    // cue may be modulated to, times master, this must not clip.
    assert.ok(summed * MAX_CUE_GAIN * MASTER_GAIN <= 2, id + " can clip");
  }
});

test("brawl-audio.js is shared with the browser, so it imports nothing", () => {
  // The same rule brawl-sim.js and brawl-stage.js live under: the server's
  // specifier for a sibling module is not the browser's, and an npm import
  // would not resolve at all. It must also stay deterministic — a cue that
  // rolls dice cannot be tested, and variation belongs in the engine.
  const src = fs.readFileSync(path.join(ROOT, "brawl-audio.js"), "utf8");
  assert.equal(/^\s*import\s/m.test(src), false, "brawl-audio.js has an import");
  assert.equal(/Math\.random|Date\.now|AudioContext/.test(src), false);
});

// -------------------------------------------------------------- server events

test("a hit sounds like the damage it did", () => {
  const light = cueFor({ type: "hit", damage: 4, percent: 10, x: 640 }, { stage: STAGE });
  const heavy = cueFor({ type: "hit", damage: 18, percent: 10, x: 640 }, { stage: STAGE });
  assert.equal(light.id, "hit");
  assert.ok(heavy.gain > light.gain, "a heavy should land harder than a jab");
  assert.ok(heavy.gain <= MAX_CUE_GAIN);
});

test("the same hit gets heavier as a percent climbs", () => {
  const fresh = cueFor({ type: "hit", damage: 6, percent: 0, x: 640 }, { stage: STAGE });
  const cooked = cueFor({ type: "hit", damage: 6, percent: 220, x: 640 }, { stage: STAGE });
  assert.ok(cooked.rate < fresh.rate, "a hit at 220% should sound lower than the same hit at 0%");
  assert.ok(cooked.rate > 0, "an inaudible hit is a bug, not a mix");
});

test("a KO is loud, and a respawn is not", () => {
  const ko = cueFor({ type: "ko", percent: 140 }, { stage: STAGE });
  const respawn = cueFor({ type: "respawn", fighter: "p1" }, { stage: STAGE });
  assert.equal(ko.id, "ko");
  assert.equal(respawn.id, "respawn");
  assert.ok(ko.gain > respawn.gain);
});

test("events with nothing to say make no sound", () => {
  assert.equal(cueFor(null), null);
  assert.equal(cueFor({ type: "attackStart" }), null);
  assert.equal(cueFor({ type: "projectile" }), null);
});

test("a hit with missing numbers still sounds", () => {
  // The wire is the wire. A cue that returns NaN gain schedules a silent — or
  // worse, permanently stuck — node in the engine.
  const cue = cueFor({ type: "hit" }, { stage: STAGE });
  assert.ok(Number.isFinite(cue.gain) && cue.gain > 0);
  assert.ok(Number.isFinite(cue.rate) && cue.rate > 0);
  assert.ok(Number.isFinite(cue.pan));
});

// --------------------------------------------------------------------- panning

test("sound sits where the Fighter is", () => {
  const mid = (STAGE.ground.x1 + STAGE.ground.x2) / 2;
  assert.equal(panFor(mid, STAGE), 0);
  assert.ok(panFor(STAGE.ground.x1, STAGE) < 0);
  assert.ok(panFor(STAGE.ground.x2, STAGE) > 0);
  // Never hard-panned: a Fighter at the ledge is off to one side, not gone.
  assert.ok(Math.abs(panFor(STAGE.blast.left, STAGE)) < 1);
  assert.ok(Math.abs(panFor(STAGE.blast.right, STAGE)) < 1);
});

test("without the sim's geometry, everything is centred rather than silent", () => {
  assert.equal(panFor(200, null), 0);
  assert.equal(panFor(undefined, STAGE), 0);
});

// ---------------------------------------------------------------- transitions

test("a Fighter that has just appeared makes no sound", () => {
  // Otherwise opening the page mid-fight fires a swing, a jump and a landing
  // for everyone already in the Arena.
  const cur = { p1: swinging("heavy_side", 3, { onGround: false, vy: -600 }) };
  assert.deepEqual(transitionCues({}, cur, { stage: STAGE }), []);
  assert.deepEqual(transitionCues(null, cur, { stage: STAGE }), []);
});

test("leaving the ground jumps, landing lands", () => {
  const grounded = fighter({ onGround: true, vy: 0 });
  const rising = fighter({ onGround: false, vy: -880 });
  assert.deepEqual(ids(transitionCues({ p1: grounded }, { p1: rising }, {})), ["jump"]);

  const landed = fighter({ onGround: true, vy: 0 });
  assert.deepEqual(ids(transitionCues({ p1: rising }, { p1: landed }, {})), ["land"]);
});

test("a harder landing is a louder one", () => {
  const soft = fighter({ onGround: false, vy: 120 });
  const hard = fighter({ onGround: false, vy: 1400 });
  const down = fighter({ onGround: true, vy: 0 });
  const a = only(transitionCues({ p1: soft }, { p1: down }, {}), "land")[0];
  const b = only(transitionCues({ p1: hard }, { p1: down }, {}), "land")[0];
  assert.ok(b.gain > a.gain, "a spike should hit the floor harder than a step off a ledge");
  assert.ok(b.rate < a.rate);
});

test("being knocked into the air is not a jump", () => {
  // Knockback takes a Fighter off the ground exactly like a jump does, and it
  // already has a sound: the hit that caused it.
  const grounded = fighter({ onGround: true, vy: 0 });
  const launched = fighter({ onGround: false, vy: -900, state: "hitstun" });
  assert.deepEqual(transitionCues({ p1: grounded }, { p1: launched }, {}), []);
});

test("the second jump sounds different from the first", () => {
  const rising = fighter({ onGround: false, vy: -200 });
  const again = fighter({ onGround: false, vy: -810 });
  assert.deepEqual(ids(transitionCues({ p1: rising }, { p1: again }, {})), ["double_jump"]);
});

test("falling is not a double jump", () => {
  // Gravity can only make vy larger. Anything that makes it sharply smaller is
  // something the Fighter did.
  const a = fighter({ onGround: false, vy: -400 });
  const b = fighter({ onGround: false, vy: -100 });
  assert.deepEqual(transitionCues({ p1: a }, { p1: b }, {}), []);
});

test("a dodge is heard once, not for as long as it lasts", () => {
  const idle = fighter({ dodgeTicks: 0 });
  const rolling = fighter({ dodgeTicks: 14, state: "dodge" });
  const stillRolling = fighter({ dodgeTicks: 9, state: "dodge" });
  assert.deepEqual(ids(transitionCues({ p1: idle }, { p1: rolling }, {})), ["dodge"]);
  assert.deepEqual(transitionCues({ p1: rolling }, { p1: stillRolling }, {}), []);
});

// --------------------------------------------------------------------- swings

test("a swing sounds when it starts and not while it continues", () => {
  const idle = fighter();
  const f0 = swinging("light_side", 0);
  const f1 = swinging("light_side", 1);
  assert.deepEqual(ids(transitionCues({ p1: idle }, { p1: f0 }, {})), ["swing"]);
  assert.deepEqual(transitionCues({ p1: f0 }, { p1: f1 }, {}), []);
});

test("the same move thrown twice is heard twice", () => {
  // The input buffer makes this routine: a press during recovery is held and
  // fires the instant the move ends, so back-to-back jabs are the normal case.
  const late = swinging("light_neutral", 8);
  const again = swinging("light_neutral", 0);
  assert.deepEqual(ids(transitionCues({ p1: late }, { p1: again }, {})), ["swing"]);
});

test("a snapshot pulling an attack's frame back is not a second swing", () => {
  // This is the regression this file exists for. The local arena predicts every
  // tick while snapshots land on every second one, so a remote Fighter's attack
  // routinely runs a frame or two ahead and gets corrected backwards. Firing on
  // any decrease sounds a phantom swing on every attack anyone else throws.
  const ahead = swinging("heavy_side", 7);
  const corrected = swinging("heavy_side", 6);
  assert.deepEqual(transitionCues({ p1: ahead }, { p1: corrected }, {}), []);

  const early = swinging("heavy_side", 2);
  const correctedEarly = swinging("heavy_side", 0);
  assert.deepEqual(transitionCues({ p1: early }, { p1: correctedEarly }, {}), []);
});

test("a different move interrupting is its own swing", () => {
  const light = swinging("light_side", 4);
  const special = swinging("flare", 0);
  assert.deepEqual(ids(transitionCues({ p1: light }, { p1: special }, {})), ["special_flare"]);
});

test("a jab and a heavy do not sound the same", () => {
  const idle = fighter();
  const jab = only(transitionCues({ p1: idle }, { p1: swinging("light_neutral", 0) }, {}), "swing")[0];
  const heavy = only(transitionCues({ p1: idle }, { p1: swinging("heavy_side", 0) }, {}), "swing")[0];
  // Both derived from the move's own frame data, which the sim reports — there
  // is no table here mapping a move name to a sound, and a balance change to
  // the frame data changes how the move sounds without this file being touched.
  assert.ok(heavy.rate < jab.rate, "a slower move should swing lower");
  assert.ok(heavy.stretch > jab.stretch, "a slower move should swing longer");
  assert.ok(heavy.gain > jab.gain);
});

// ------------------------------------------------------------------- specials

test("every Fighter's special has a voice", () => {
  // Pinned against the sim's roster, so adding a Fighter without giving its
  // special a sound fails here rather than shipping silent.
  for (const id of Object.keys(FIGHTERS)) {
    const kind = FIGHTERS[id].special.id;
    const cueId = SPECIAL_CUES[kind];
    assert.ok(cueId, "no cue for " + id + "'s " + kind);
    assert.ok(CUES[cueId], "cue " + cueId + " has no recipe");
  }
});

test("a special is heard as itself, not as a swing", () => {
  const idle = fighter();
  for (const kind of Object.keys(SPECIAL_CUES)) {
    const cues = transitionCues({ p1: idle }, { p1: swinging(kind, 0) }, {});
    assert.deepEqual(ids(cues), [SPECIAL_CUES[kind]], kind + " did not sound like itself");
  }
});

test("Flare-Up's sizzle lasts exactly as long as its wind-up", () => {
  // The Arena's one long telegraph. The coals in FLOURISHES.flare are its only
  // visual warning and the sizzle is now its only audible one — both are
  // derived from the startup the sim reports, so cutting that startup shortens
  // the warning in all three places at once instead of leaving a sound playing
  // over a move that already hit.
  const idle = fighter();
  const now = only(transitionCues({ p1: idle }, { p1: swinging("flare", 0) }, {}), "special_flare")[0];
  assert.equal(now.stretch, 1, "the recipe is voiced at the current startup — retune it if this fails");

  const slower = fighter({
    state: "attack",
    attack: { kind: "flare", frame: 0, startup: SPECIALS.flare.startup * 2, active: 6, endlag: 16 },
  });
  const stretched = only(transitionCues({ p1: idle }, { p1: slower }, {}), "special_flare")[0];
  assert.ok(stretched.stretch > now.stretch, "a longer wind-up must sizzle for longer");
});

test("every cue a Fighter can produce names a real recipe", () => {
  const idle = fighter();
  const seen = new Set();
  for (const name of [...Object.keys(MOVES), ...Object.keys(SPECIALS)]) {
    for (const cue of transitionCues({ p1: idle }, { p1: swinging(name, 0) }, { stage: STAGE })) {
      seen.add(cue.id);
      assert.ok(CUES[cue.id], cue.id + " has no recipe");
      assert.ok(cue.gain > 0 && Number.isFinite(cue.gain), cue.id + " is silent");
      assert.ok(cue.rate > 0 && Number.isFinite(cue.rate), cue.id + " has no pitch");
      assert.ok(cue.stretch > 0 && Number.isFinite(cue.stretch), cue.id + " has no length");
    }
  }
  assert.ok(seen.has("swing"));
});
