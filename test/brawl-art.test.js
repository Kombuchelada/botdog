// GlizzyBrawl — Fighter art decisions.
//
// This is a third seam in a repo that deliberately has two (the WebSocket
// boundary and the simulation's public API), and it is a conscious exception:
// neither existing seam can observe art at all, and the flourish layer has a
// silent failure mode — a signature-move effect can disappear without anything
// erroring. That is the regression these tests exist to catch.
//
// They assert only what `brawl-art.js` returns from its pure functions. No
// canvas is constructed, no image is loaded, and nothing here knows the order
// layers are drawn in — all of that changes whenever the art does.

import test from "node:test";
import assert from "node:assert/strict";

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  allSprites,
  frameFor,
  clipInfo,
  attackClipFor,
  moveTimingOf,
  bodyFor,
  CLIPS,
  CHARACTERS,
  CPU_BODY,
  flourishFor,
  FLOURISHES,
} from "../brawl-art.js";
import { MOVES, SPECIALS, DODGE_TICKS } from "../brawl-sim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * A Fighter snapshot mid-attack, in the shape the wire actually carries — which
 * now includes the move's frame data, because animating an attack across its
 * wind-up, its hitbox and its recovery is a question only the sim can answer.
 */
function attacking(character, move, frame = 0, extra = {}) {
  const m = MOVES[move] || SPECIALS[move];
  return {
    character,
    cpu: false,
    onGround: true,
    vx: 0,
    vy: 0,
    state: "attack",
    attack: {
      kind: SPECIALS[move] ? move : null,
      frame,
      move,
      startup: m && m.startup,
      active: m && m.active,
      endlag: m && m.endlag,
    },
    ...extra,
  };
}

// ---------------------------------------------------------------- flourishes

test("a Fighter's special shows its flourish whichever sprite set it draws", () => {
  // The flourish decision must not consult the manifest at all. Art of its own
  // is exactly the case where the old costume-drawn flourish silently vanished,
  // and a Fighter reverted to a borrowed body must keep the effect too.
  const f = attacking("grill", "flare", 4);
  const shown = flourishFor(f);
  assert.ok(shown, "the flare telegraph is showing");
  assert.equal(shown.id, "flare");
  assert.equal(bodyFor(f), "grill");
  // A CPU draws a borrowed body and must still show the telegraph.
  assert.deepEqual(flourishFor({ ...f, cpu: true }), shown);
});

test("flourishes fire on the special only, never on light or heavy attacks", () => {
  assert.equal(flourishFor(attacking("ketchup", "light_side", 4)), null);
  assert.equal(flourishFor(attacking("ketchup", "heavy_side", 4)), null);
  assert.equal(flourishFor(attacking("ketchup", "air_heavy_down", 4)), null);
  assert.ok(flourishFor(attacking("ketchup", "splat", 4)));
});

test("a Fighter with no flourish defined shows none", () => {
  // The Glizzy's Snap is carried by the pose alone.
  assert.equal(flourishFor(attacking("glizzy", "snap", 4)), null);
  assert.equal(flourishFor({ character: "grill", attack: null }), null);
  assert.equal(flourishFor(null), null);
});

test("every flourish names a special, and covers that special's wind-up", () => {
  // A telegraph shorter than the startup it warns about finishes before the
  // hitbox arrives; one longer keeps growing after the move has committed.
  for (const [id, spec] of Object.entries(FLOURISHES)) {
    assert.ok(SPECIALS[id], `${id} is a special in brawl-sim.js`);
    assert.ok(
      spec.windup >= SPECIALS[id].startup,
      `${id}'s telegraph covers its ${SPECIALS[id].startup}-frame startup`,
    );
  }
});

test("flourish progress tracks the attack's own frame counter", () => {
  const at = (frame) => flourishFor(attacking("grill", "flare", frame)).progress;
  assert.ok(at(0) < at(4), "the telegraph grows through the wind-up");
  assert.ok(at(4) < at(10));
  assert.equal(at(0) > 0, true, "something is visible on the first frame");
  assert.equal(at(60), 1, "progress saturates rather than running away");
  assert.equal(at(-5), 0, "a nonsense frame count cannot go negative");
});

test("The Grill's telegraph spans its whole wind-up, not a fixed six frames", () => {
  // Flare-Up is a 16-frame startup and the coals are the only warning the
  // opponent gets; a telegraph that finished at frame 6 would be a lie about
  // when the launcher lands.
  assert.ok(flourishFor(attacking("grill", "flare", FLOURISHES.flare.windup - 2)).progress < 1);
  // Ketchup's Splat is the opposite shape: two frames of startup, so its burst
  // is out by the time the projectile is, and never grows past it.
  assert.equal(flourishFor(attacking("ketchup", "splat", 1)).progress, 1);
});

test("a locally predicted attack reads the same as one off the wire", () => {
  // Prediction holds the live move object; a snapshot holds its name. The art
  // must not be able to tell the difference.
  const predicted = attacking("ketchup", "splat", 3);
  predicted.attack = { move: SPECIALS.splat, kind: "splat", frame: 3, hasHit: false };
  assert.deepEqual(flourishFor(predicted), flourishFor(attacking("ketchup", "splat", 3)));
});

// -------------------------------------------------------- clips and bodies

test("clip mapping picks the right clip for each state", () => {
  assert.equal(attackClipFor(attacking("glizzy", "light_side", 2).attack), "action1");
  assert.equal(attackClipFor(attacking("glizzy", "heavy_side", 2).attack), "kick");
  assert.equal(attackClipFor(attacking("glizzy", "snap", 2).attack), "action2");
  const clip = (f) => frameFor({ character: "glizzy", cpu: false, ...f }).clip;
  assert.equal(clip({ state: "hitstun", attack: null }), "hurt");
  assert.equal(clip({ state: "dodge", attack: null }), "duck");
  assert.equal(clip({ state: "air", attack: null, onGround: false, vy: 400 }), "fall");
  assert.equal(clip({ state: "air", attack: null, onGround: false, vy: -400 }), "jump");
  assert.equal(clip({ state: "run", attack: null, onGround: true, vx: 300 }), "walk");
  assert.equal(clip({ state: "idle", attack: null, onGround: true, vx: 0 }), "stand");
});

test("every Fighter draws its own sprites; only a CPU borrows a body", () => {
  for (const character of CHARACTERS) {
    assert.equal(bodyFor({ character, cpu: false }), character);
    assert.equal(bodyFor({ character, cpu: true }), CPU_BODY);
  }
});

test("only sprites a Fighter can actually draw are preloaded", () => {
  // Anything preloaded that no Fighter can draw is an image fetched and thrown
  // away before the Arena's first frame — and there are now a hundred of them.
  assert.deepEqual(new Set(allSprites().map((s) => s.body)), new Set([...CHARACTERS, CPU_BODY]));
  for (const s of allSprites()) {
    assert.equal(s.url, `/brawl/art/${s.body}_${s.clip}_${s.index}.png`);
    assert.ok(s.index < clipInfo(s.body, s.clip).frames);
  }
});

test("every frame CLIPS promises exists on disk", () => {
  // `CLIPS` is a promise about files, and the importer is the only thing that
  // keeps it. Raising a clip's length in code and not re-importing costs a
  // frame that silently falls back mid-animation — the Fighter twitches back to
  // its first frame once a cycle and nothing errors.
  //
  // This reads a directory listing, never an image: the seam stays pure.
  const missing = allSprites()
    .map((s) => `${s.body}_${s.clip}_${s.index}.png`)
    .filter((f) => !fs.existsSync(path.join(ROOT, "assets", "brawl", f)));
  assert.deepEqual(missing, [], "re-import the Fighters whose frames are missing");
});

test("the CPU's borrowed body holds the single-frame path open", () => {
  // Kenney's zombie is a pack of static poses and always will be. Every clip
  // has to degrade to one drawing without the renderer asking for a frame that
  // was never generated — which is also the fallback any half-imported Fighter
  // lands on.
  for (const clip of Object.keys(CLIPS)) {
    const { frames } = clipInfo(CPU_BODY, clip);
    assert.ok(frames >= 1 && frames <= 2, `${clip} is a still, or a two-frame walk`);
  }
  const cpu = { character: "glizzy", cpu: true, onGround: true, vx: 0, vy: 0, state: "attack" };
  const shown = frameFor({ ...cpu, attack: attacking("glizzy", "heavy_side", 12).attack });
  assert.equal(shown.index, 0, "a one-frame clip is always frame zero");
});

// ------------------------------------------------------ the attack mapping

test("contact lands on the first active frame and holds for the whole hitbox", () => {
  // This is the invariant the whole clip model rests on. The moment a Fighter
  // looks most committed must be the moment it can actually hit you, on every
  // move, without the art knowing any move's frame data — and it has to hold
  // for a 3-frame jab and a 16-frame launcher alike.
  for (const name of ["light_neutral", "heavy_side", "air_light_down", "snap", "flare", "pogo"]) {
    const move = MOVES[name] || SPECIALS[name];
    const clip = attackClipFor({ move: name });
    const { contact } = clipInfo("glizzy", clip);
    const at = (frame) => frameFor(attacking("glizzy", name, frame)).index;
    const active = Math.max(1, move.active);

    for (let f = 0; f < move.startup; f++) {
      assert.ok(at(f) < contact, `${name}: frame ${f} is still winding up`);
    }
    for (let f = move.startup; f < move.startup + active; f++) {
      assert.equal(at(f), contact, `${name}: frame ${f} is the hitbox, so it shows contact`);
    }
    assert.ok(at(move.startup + active) > contact, `${name}: recovery moves past contact`);
  }
});

test("Splat has no active window at all and still shows the throw", () => {
  // A move that spawns a projectile and is done would otherwise skip straight
  // from wind-up to recovery, never drawing the squeeze the sprite exists for.
  const { contact } = clipInfo("ketchup", "action2");
  assert.equal(SPECIALS.splat.active, 0);
  assert.equal(frameFor(attacking("ketchup", "splat", SPECIALS.splat.startup)).index, contact);
});

test("an attack runs to the end of its clip and stops there", () => {
  const { frames } = clipInfo("glizzy", "kick");
  const last = frameFor(attacking("glizzy", "heavy_side", 200)).index;
  assert.equal(last, frames - 1);
  assert.equal(frameFor(attacking("glizzy", "heavy_side", -5)).index, 0, "a nonsense frame cannot go negative");
});

test("a locally predicted attack animates the same as one off the wire", () => {
  // Prediction holds the live move object; a snapshot carries the numbers
  // inline. The art must not be able to tell the difference — a Fighter whose
  // own attack animated differently from everyone else's view of it is the
  // worst version of this bug, because only the player who did it can see it.
  const wire = attacking("ketchup", "heavy_side", 13);
  const predicted = { ...wire, attack: { move: MOVES.heavy_side, kind: null, frame: 13, hasHit: false } };
  assert.deepEqual(moveTimingOf(predicted.attack), moveTimingOf(wire.attack));
  assert.deepEqual(frameFor(predicted), frameFor(wire));
});

test("a move with no timing at all still animates", () => {
  // An older snapshot, or a preview that names a move without its frame data.
  // Freezing on frame zero would be indistinguishable from the game hanging.
  const bare = { character: "glizzy", cpu: false, state: "attack", onGround: true, vx: 0, vy: 0 };
  const early = frameFor({ ...bare, attack: { move: "light_side", frame: 0 } }).index;
  const late = frameFor({ ...bare, attack: { move: "light_side", frame: 20 } }).index;
  assert.ok(late > early, "it plays forward on the fallback timing");
});

test("every declared contact frame is inside its clip", () => {
  for (const [clip, spec] of Object.entries(CLIPS)) {
    if (!Number.isFinite(spec.contact)) continue;
    assert.ok(spec.contact > 0, `${clip} needs a wind-up before contact`);
    assert.ok(spec.contact < spec.frames - 1, `${clip} needs a recovery after contact`);
  }
});

// --------------------------------------------------- the timed-state clips

test("hurt and dodge play forward as the sim's own timers drain", () => {
  const hurt = (hitstun) =>
    frameFor({ character: "glizzy", cpu: false, state: "hitstun", attack: null, hitstun, hitstunTotal: 18 }).index;
  assert.equal(hurt(18), 0, "the frame of the hit");
  assert.ok(hurt(9) > hurt(18));
  assert.ok(hurt(0) >= hurt(9));

  const duck = (dodgeTicks) =>
    frameFor({
      character: "glizzy", cpu: false, state: "dodge", attack: null,
      onGround: true, vx: 0, vy: 0, dodgeTicks, dodgeTotal: DODGE_TICKS,
    }).index;
  assert.equal(duck(DODGE_TICKS), 0);
  // Compressed and holding well before the dodge ends: a duck that only reaches
  // its lowest frame as it finishes never reads as a duck at all.
  const low = clipInfo("glizzy", "duck").frames - 1;
  assert.equal(duck(Math.round(DODGE_TICKS * 0.5)), low);
  assert.equal(duck(0), low);
});

test("a state with no timer reported still shows something", () => {
  // `hitstunTotal` is a newer field than `hitstun`; a snapshot without it must
  // not divide by zero into a NaN frame index.
  const f = frameFor({ character: "glizzy", cpu: false, state: "hitstun", attack: null });
  assert.ok(Number.isInteger(f.index) && f.index >= 0);
});

test("the air clips are driven by velocity, not by the clock", () => {
  // A Fighter hanging at the apex holds the apex frame however long the hang
  // lasts, and a slow tick cannot desynchronise the arc from the jump.
  const air = (vy, now) =>
    frameFor({ character: "glizzy", cpu: false, state: "air", attack: null, onGround: false, vx: 0, vy }, now);
  assert.deepEqual(air(-800, 0), air(-800, 99999));
  assert.equal(air(-880, 0).clip, "jump");
  assert.equal(air(600, 0).clip, "fall");
  assert.ok(air(-100, 0).index > air(-880, 0).index, "the rise plays out as it slows");
  assert.ok(air(1200, 0).index > air(50, 0).index, "the fall plays out as it speeds up");
});

test("the walk cycle paces itself to how fast the Fighter is moving", () => {
  const walking = (vx) => ({ character: "glizzy", cpu: false, state: "run", attack: null, onGround: true, vy: 0, vx });
  const cycle = (vx) => {
    const seen = [];
    for (let t = 0; t < 4000; t += 10) seen.push(frameFor(walking(vx), t).index);
    // How many times the cycle wrapped in four seconds.
    return seen.filter((v, i) => i > 0 && v < seen[i - 1]).length;
  };
  assert.ok(cycle(400) > cycle(90), "a sprint steps faster than a crawl");
  const { frames } = clipInfo("glizzy", "walk");
  for (let t = 0; t < 3000; t += 7) {
    assert.ok(frameFor(walking(300), t).index < frames, "never past the end of the clip");
  }
});
