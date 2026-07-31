// GlizzyBrawl — Fighter art decisions.
//
// This is a third seam in a repo that deliberately has two (the WebSocket
// boundary and the simulation's public API), and it is a conscious exception:
// neither existing seam can observe art at all, and the flourish layer has a
// silent failure mode — convert a Fighter to bespoke art and its signature-move
// effect quietly disappears. That is the regression these tests exist to catch.
//
// They assert only what `brawl-art.js` returns from its pure functions. No
// canvas is constructed, no image is loaded, and nothing here knows the order
// layers are drawn in — all of that changes whenever the art does.

import test from "node:test";
import assert from "node:assert/strict";

import {
  allSprites,
  poseFor,
  bodyFor,
  BODY,
  flourishFor,
  FLOURISHES,
} from "../brawl-art.js";
import { SPECIALS } from "../brawl-sim.js";

/** A Fighter snapshot mid-attack, in the shape the wire actually carries. */
function attacking(character, move, frame = 0, extra = {}) {
  return {
    character,
    cpu: false,
    onGround: true,
    vx: 0,
    vy: 0,
    state: "attack",
    attack: { kind: SPECIALS[move] ? move : null, frame, move },
    ...extra,
  };
}

const BESPOKE_ALL = new Set(["glizzy", "ketchup", "grill", "corndog"]);

// ---------------------------------------------------------------- flourishes

test("a Fighter's special shows its flourish whichever sprite set it draws", () => {
  // The flourish decision must not consult the manifest at all. Art of its own
  // is exactly the case where the old costume-drawn flourish silently vanished,
  // and a Fighter reverted to a borrowed body must keep the effect too.
  const f = attacking("grill", "flare", 4);
  const shown = flourishFor(f);
  assert.ok(shown, "the flare telegraph is showing");
  assert.equal(shown.id, "flare");
  assert.equal(bodyFor(f, BESPOKE_ALL), "grill");
  assert.equal(bodyFor(f, new Set()), "soldier");
  assert.deepEqual(flourishFor({ ...f }), shown);
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

// ------------------------------------------------------- poses and bodies

test("pose mapping is unchanged by the flourish extraction", () => {
  assert.equal(poseFor(attacking("glizzy", "light_side", 2)), "action1");
  assert.equal(poseFor(attacking("glizzy", "heavy_side", 2)), "kick");
  assert.equal(poseFor(attacking("glizzy", "snap", 2)), "action2");
  assert.equal(poseFor({ state: "hitstun", attack: null }), "hurt");
  assert.equal(poseFor({ state: "dodge", attack: null }), "duck");
  assert.equal(poseFor({ state: "air", attack: null, onGround: false, vy: 400 }), "fall");
  assert.equal(poseFor({ state: "air", attack: null, onGround: false, vy: -400 }), "jump");
  assert.equal(poseFor({ state: "idle", attack: null, onGround: true, vx: 0 }), "stand");
});

test("the manifest alone decides which sprite set a Fighter draws", () => {
  const f = { character: "corndog", cpu: false };
  assert.equal(bodyFor(f, new Set(["corndog"])), "corndog");
  // Dropping a Fighter from the manifest reverts it to a borrowed body, which
  // is what makes a conversion the owner dislikes a one-line undo. Which
  // borrowed body is art bookkeeping, so assert only that it is one of them.
  assert.notEqual(bodyFor(f, new Set()), "corndog");
  assert.ok(Object.values(BODY).includes(bodyFor(f, new Set())));
});

test("the CPU keeps its borrowed body even when its character has art", () => {
  const cpu = { character: "corndog", cpu: true };
  assert.equal(bodyFor(cpu, new Set(["corndog"])), "zombie");
  assert.equal(bodyFor(cpu, new Set()), "zombie");
});

test("only sprites a Fighter can actually draw are preloaded", () => {
  // Every borrowed body preloaded alongside the bespoke ones is ten images
  // fetched and never drawn, before the Arena's first frame.
  const bodies = (list) => new Set(allSprites(list).map((s) => s.body));
  assert.deepEqual(bodies([...BESPOKE_ALL]), new Set([...BESPOKE_ALL, "zombie"]));
  assert.deepEqual(
    bodies(["glizzy"]),
    new Set(["glizzy", BODY.ketchup, BODY.grill, BODY.corndog, "zombie"]),
    "a Fighter without art still preloads the body it falls back to",
  );
  for (const s of allSprites([...BESPOKE_ALL])) {
    assert.equal(s.url, `/brawl/art/${s.body}_${s.pose}.png`);
  }
});
