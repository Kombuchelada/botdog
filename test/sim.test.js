// Frame-precise mechanics tests for the GlizzyBrawl simulation.
//
// This is the module's real public API — the browser client imports the same
// file over HTTP and runs it for client-side prediction — so these tests are
// not poking at a test-only seam. They assert observable outcomes (where a
// Fighter ends up, what events come out) and never inspect bookkeeping like
// tick counters or internal timers.

import test from "node:test";
import assert from "node:assert/strict";

import {
  TICK_HZ,
  STAGE,
  FIGHTERS,
  FIGHTER_IDS,
  createArena,
  spawnFighter,
  despawnFighter,
  stepArena,
  emptyInput,
  cpuInput,
  RESPAWN_DELAY_TICKS,
  snapshot,
  applySnapshot,
} from "../brawl-sim.js";

// ---------------------------------------------------------------- helpers

function arena() {
  return createArena(1234);
}

/** Step the arena `n` times, giving every Fighter the same input each tick. */
function run(state, n, inputs = {}) {
  const events = [];
  for (let i = 0; i < n; i++) events.push(...stepArena(state, inputs));
  return events;
}

function input(overrides = {}) {
  return { ...emptyInput(), ...overrides };
}

/** Spawn a Fighter standing still on the main platform. */
function grounded(state, id, character = "glizzy", x = 640) {
  const f = spawnFighter(state, { id, character, name: id, x, y: STAGE.ground.y - 1, invuln: 0 });
  run(state, 3); // settle onto the floor
  return f;
}

// ---------------------------------------------------------------- roster

test("roster is the four specified Fighters, each with one special", () => {
  assert.deepEqual(FIGHTER_IDS, ["glizzy", "ketchup", "grill", "corndog"]);
  for (const id of FIGHTER_IDS) {
    const def = FIGHTERS[id];
    assert.ok(def.name, `${id} has a display name`);
    assert.ok(def.special && def.special.name, `${id} has a named special`);
  }
  // Frame stats actually differentiate them: Ketchup fast+light, Grill slow+heavy.
  assert.ok(FIGHTERS.ketchup.runSpeed > FIGHTERS.glizzy.runSpeed);
  assert.ok(FIGHTERS.ketchup.weight < FIGHTERS.glizzy.weight);
  assert.ok(FIGHTERS.grill.runSpeed < FIGHTERS.glizzy.runSpeed);
  assert.ok(FIGHTERS.grill.weight > FIGHTERS.glizzy.weight);
  assert.ok(FIGHTERS.corndog.reach > FIGHTERS.glizzy.reach);
});

// ---------------------------------------------------------------- movement

test("running moves a Fighter in the held direction and sets facing", () => {
  const s = arena();
  const f = grounded(s, "a");
  const startX = f.x;
  run(s, 10, { a: input({ right: true }) });
  assert.ok(f.x > startX + 40, `expected to travel right, moved ${f.x - startX}`);
  assert.equal(f.facing, 1);
  run(s, 20, { a: input({ left: true }) });
  assert.equal(f.facing, -1);
});

test("a Fighter can jump, then double jump, but not triple jump", () => {
  const s = arena();
  const f = grounded(s, "a");
  const floorY = f.y;

  // Edge-triggered: hold jump for a while, we should leave the ground once.
  run(s, 1, { a: input({ jump: true }) });
  assert.ok(f.y < floorY, "first jump leaves the ground");
  run(s, 6, { a: input({ jump: true }) }); // still held — must not double jump yet
  const heldApex = f.y;

  // Release, then press again → double jump gives fresh upward velocity.
  run(s, 1, { a: input({ jump: false }) });
  const beforeSecond = f.vy;
  run(s, 1, { a: input({ jump: true }) });
  assert.ok(f.vy < beforeSecond, "second press adds upward velocity");
  assert.ok(f.y <= heldApex + 60);

  // Third press does nothing.
  run(s, 1, { a: input({ jump: false }) });
  const vyBeforeThird = f.vy;
  run(s, 1, { a: input({ jump: true }) });
  assert.ok(f.vy >= vyBeforeThird, "no third jump");
});

test("fast-falling makes a Fighter descend faster than gravity alone", () => {
  const s = arena();
  const a = grounded(s, "a", "glizzy", 600);
  const b = grounded(s, "b", "glizzy", 900);

  run(s, 1, { a: input({ jump: true }), b: input({ jump: true }) });
  run(s, 12, {}); // rise to around the apex

  const aStart = a.y;
  const bStart = b.y;
  run(s, 8, { a: input({ down: true }) });
  assert.ok(a.y - aStart > b.y - bStart, "fast-faller covered more ground");
});

test("holding down and pressing jump drops a Fighter through a soft platform", () => {
  const s = arena();
  const plat = STAGE.platforms[0];
  const x = (plat.x1 + plat.x2) / 2;
  const f = spawnFighter(s, { id: "a", character: "glizzy", name: "a", x, y: plat.y - 2, invuln: 0 });
  run(s, 5);
  assert.ok(Math.abs(f.y - plat.y) < 2, "landed on the soft platform");

  run(s, 1, { a: input({ down: true, jump: true }) });
  run(s, 6, { a: input({ down: true }) });
  assert.ok(f.y > plat.y + 10, "dropped through");
});

test("a Fighter never falls through the main platform", () => {
  const s = arena();
  const f = grounded(s, "a");
  run(s, 60, { a: input({ down: true, jump: true }) });
  assert.ok(Math.abs(f.y - STAGE.ground.y) < 2, "still standing on the stage");
});

// ---------------------------------------------------------------- dodge

test("dodge beats an attack, and the cooldown means the next one doesn't", () => {
  function swingInto({ dodgeAgain }) {
    const s = arena();
    const attacker = grounded(s, "atk", "glizzy", 620);
    const victim = grounded(s, "vic", "glizzy", 660);
    attacker.facing = 1;

    // First exchange: victim dodges the swing.
    for (let i = 0; i < 8; i++) {
      stepArena(s, { atk: input({ light: true, right: false }), vic: input({ dodge: i === 0 }) });
    }
    const afterFirst = victim.percent;

    // Second exchange, once the attacker has recovered but while the victim is
    // still inside the dodge cooldown.
    for (let i = 0; i < 20; i++) {
      stepArena(s, {
        atk: input({ light: i >= 8 }),
        vic: input({ dodge: dodgeAgain && i === 8 }),
      });
    }
    return { afterFirst, afterSecond: victim.percent };
  }

  const withDodge = swingInto({ dodgeAgain: true });
  assert.equal(withDodge.afterFirst, 0, "the dodged hit dealt no Percent");
  assert.ok(withDodge.afterSecond > 0, "a second dodge on cooldown does not protect");
});

test("dropping into a live brawl grants brief spawn protection", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 620);
  attacker.facing = 1;
  // Default spawn — no `invuln: 0` — so this Fighter just landed in the Arena.
  const victim = spawnFighter(s, { id: "vic", character: "glizzy", name: "vic", x: 664, y: STAGE.ground.y - 1 });
  run(s, 20, { atk: input({ light: true }) });
  assert.equal(victim.percent, 0, "a Fighter cannot be hit the instant they arrive");
});

// ---------------------------------------------------------------- combat

test("a light attack deals Percent to a Fighter in range", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 620);
  const victim = grounded(s, "vic", "glizzy", 664);
  attacker.facing = 1;

  const events = run(s, 20, { atk: input({ light: true }) });
  assert.ok(victim.percent > 0, "victim took Percent");
  assert.ok(events.some((e) => e.type === "hit" && e.victim === "vic" && e.attacker === "atk"));
});

test("attacking on the ground plants your feet instead of sliding you past the target", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 560);
  const victim = grounded(s, "vic", "glizzy", 664);

  // Run in at full speed and swing on approach — the classic way to whiff by
  // sliding straight through someone.
  run(s, 8, { atk: input({ right: true }) });
  const xAtSwing = attacker.x;
  run(s, 12, { atk: input({ right: true, light: true }) });

  assert.ok(attacker.x - xAtSwing < 70, `attacker slid ${attacker.x - xAtSwing}px while attacking`);
  assert.ok(victim.percent > 0, "the running attack connected");
});

// The pace of play. Both of these are about how fast a player can *act*, which
// is the thing the Arena is judged on before any of its mechanics are.

test("mashing light throws punches several times a second", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 620);
  attacker.facing = 1;
  spawnFighter(s, { id: "vic", character: "glizzy", name: "vic", x: 664, y: STAGE.ground.y - 1, invuln: 0 });

  // Press and release on alternating ticks, the way a mashing thumb reads to a
  // 30Hz sim, for one second.
  let starts = 0;
  for (let i = 0; i < TICK_HZ; i++) {
    const events = stepArena(s, { atk: input({ light: i % 2 === 0 }) });
    starts += events.filter((e) => e.type === "attackStart" && e.fighter === "atk").length;
  }
  assert.ok(starts >= 3, `only ${starts} punches came out in a second of mashing`);
});

test("an attack press during recovery is buffered, not swallowed", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 620);
  attacker.facing = 1;
  spawnFighter(s, { id: "vic", character: "glizzy", name: "vic", x: 664, y: STAGE.ground.y - 1, invuln: 0 });

  // One press, then a second press two ticks later — far too early, while the
  // first move is still running. The second must still come out.
  const starts = [];
  for (let i = 0; i < 20; i++) {
    const events = stepArena(s, { atk: input({ light: i === 0 || i === 2 }) });
    for (const e of events) if (e.type === "attackStart" && e.fighter === "atk") starts.push(i);
  }
  assert.equal(starts.length, 2, `presses that came out: ${starts.join(", ")}`);
  assert.ok(starts[1] > starts[0], "the buffered press fires after the first move, not during it");
});

test("an attack whiffs when the target is out of reach", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 400);
  const victim = grounded(s, "vic", "glizzy", 900);
  attacker.facing = 1;
  run(s, 20, { atk: input({ light: true }) });
  assert.equal(victim.percent, 0);
});

test("knockback scales with the victim's Percent", () => {
  function launchSpeedAt(percent) {
    const s = arena();
    const attacker = grounded(s, "atk", "glizzy", 620);
    const victim = grounded(s, "vic", "glizzy", 664);
    attacker.facing = 1;
    victim.percent = percent;
    let best = 0;
    for (let i = 0; i < 20; i++) {
      stepArena(s, { atk: input({ heavy: true }) });
      best = Math.max(best, Math.hypot(victim.vx, victim.vy));
    }
    return best;
  }
  const low = launchSpeedAt(0);
  const mid = launchSpeedAt(80);
  const high = launchSpeedAt(200);
  assert.ok(low > 0, "a hit at 0% still moves the victim");
  assert.ok(mid > low, `80% (${mid}) should launch farther than 0% (${low})`);
  assert.ok(high > mid, `200% (${high}) should launch farther than 80% (${mid})`);
});

test("heavier Fighters are launched less by the same hit", () => {
  function launchSpeed(victimChar) {
    const s = arena();
    const attacker = grounded(s, "atk", "glizzy", 620);
    const victim = grounded(s, "vic", victimChar, 664);
    attacker.facing = 1;
    victim.percent = 100;
    let best = 0;
    for (let i = 0; i < 20; i++) {
      stepArena(s, { atk: input({ heavy: true }) });
      best = Math.max(best, Math.hypot(victim.vx, victim.vy));
    }
    return best;
  }
  assert.ok(launchSpeed("grill") < launchSpeed("ketchup"));
});

test("direction variants are distinct moves", () => {
  function hitWith(dir) {
    const s = arena();
    const attacker = grounded(s, "atk", "glizzy", 620);
    const victim = grounded(s, "vic", "glizzy", 660);
    attacker.facing = 1;
    run(s, 20, { atk: input({ heavy: true, ...dir }) });
    return victim.percent;
  }
  const side = hitWith({ right: true });
  const down = hitWith({ down: true });
  assert.ok(side > 0 && down > 0);
  assert.notEqual(side, down);
});

// ---------------------------------------------------------------- KO

test("crossing the blast zone is a KO, and only that", () => {
  const s = arena();
  const f = grounded(s, "a");
  f.percent = 400;
  run(s, 5);
  assert.equal(f.state !== "ko" && f.state !== "respawn", true, "400% alone never kills");

  f.x = STAGE.blast.right + 5;
  const events = run(s, 1);
  const ko = events.find((e) => e.type === "ko");
  assert.ok(ko, "leaving the blast zone produced a KO event");
  assert.equal(ko.victim, "a");
});

test("a KO credits the last Fighter who landed a hit", () => {
  const s = arena();
  const attacker = grounded(s, "atk", "glizzy", 620);
  const victim = grounded(s, "vic", "glizzy", 664);
  attacker.facing = 1;
  victim.percent = 260;

  let ko = null;
  for (let i = 0; i < 200 && !ko; i++) {
    const events = stepArena(s, { atk: input({ heavy: true, right: i < 3 }) });
    ko = events.find((e) => e.type === "ko");
  }
  assert.ok(ko, "high-Percent heavy eventually sent the victim off-stage");
  assert.equal(ko.victim, "vic");
  assert.equal(ko.attacker, "atk");
});

test("a KO credits the Fighter who landed the hit even after they leave", () => {
  const s = arena();
  grounded(s, "atk", "glizzy", 600);
  const victim = grounded(s, "vic", "glizzy", 800);
  victim.lastHitBy = "atk";
  victim.lastHitCharacter = "glizzy";
  victim.lastHitTick = s.tick;

  // The attacker closes their tab while the victim is still falling.
  despawnFighter(s, "atk");
  victim.x = STAGE.blast.right + 5;
  const ko = run(s, 1).find((e) => e.type === "ko");

  assert.equal(ko.attacker, "atk", "the hit still earned the KO");
  assert.equal(ko.attackerCharacter, "glizzy");
  assert.equal(ko.attackerPresent, false);
});

test("a KO'd Fighter respawns at 0 Percent after a delay", () => {
  const s = arena();
  const f = grounded(s, "a");
  f.percent = 150;
  f.y = STAGE.blast.bottom + 10;
  run(s, 1);
  assert.equal(f.state, "respawn");

  run(s, RESPAWN_DELAY_TICKS - 2);
  assert.equal(f.state, "respawn", "still waiting to come back");

  run(s, 4);
  assert.notEqual(f.state, "respawn");
  assert.equal(f.percent, 0, "back at 0 Percent");
  assert.ok(f.y < STAGE.blast.bottom, "back inside the Arena");
});

test("KO and Fall counters and the KO Streak follow from play", () => {
  const s = arena();
  const a = grounded(s, "a", "glizzy", 600);
  const b = grounded(s, "b", "glizzy", 800);

  b.lastHitBy = "a";
  b.lastHitTick = s.tick;
  b.x = STAGE.blast.right + 5;
  run(s, 1);
  assert.equal(a.kos, 1);
  assert.equal(b.falls, 1);
  assert.equal(a.streak, 1);
  assert.equal(b.streak, 0);
});

// ---------------------------------------------------------------- specials

test("each Fighter's special does something observable", () => {
  // The Glizzy's Snap lunges forward and hits.
  {
    const s = arena();
    const a = grounded(s, "a", "glizzy", 600);
    const b = grounded(s, "b", "glizzy", 660);
    a.facing = 1;
    const x0 = a.x;
    run(s, 20, { a: input({ special: true }) });
    assert.ok(a.x > x0, "Snap lunged forward");
    assert.ok(b.percent > 0, "Snap connected");
  }

  // Ketchup's Splat throws a projectile that damages and slows at range.
  {
    const s = arena();
    const a = grounded(s, "a", "ketchup", 600);
    const b = grounded(s, "b", "glizzy", 830);
    a.facing = 1;
    run(s, 4, { a: input({ special: true }) });
    assert.ok(s.projectiles.length > 0, "Splat spawned a projectile");
    run(s, 30);
    assert.ok(b.percent > 0, "Splat connected at range");
    assert.ok(b.slowTicks > 0, "Splat slowed the victim");
  }

  // The Grill's Flare-Up is slow but launches hard, mostly upward.
  {
    const s = arena();
    const a = grounded(s, "a", "grill", 620);
    const b = grounded(s, "b", "glizzy", 664);
    a.facing = 1;
    let launchedUp = false;
    for (let i = 0; i < 40; i++) {
      const events = stepArena(s, { a: input({ special: true }) });
      if (events.some((e) => e.type === "hit")) launchedUp = b.vy < 0;
    }
    assert.ok(b.percent >= 15, "Flare-Up hits hard");
    assert.ok(launchedUp, "Flare-Up sends them up");
  }

  // Corn Dog's Pogo spikes downward and bounces the user back up.
  {
    const s = arena();
    const a = spawnFighter(s, { id: "a", character: "corndog", name: "a", x: 640, y: 300, invuln: 0 });
    const b = spawnFighter(s, { id: "b", character: "glizzy", name: "b", x: 640, y: 400, invuln: 0 });
    let bounced = false;
    let spiked = false;
    for (let i = 0; i < 30; i++) {
      const events = stepArena(s, { a: input({ special: i === 0 }) });
      if (events.some((e) => e.type === "hit")) spiked = b.vy > 0;
      if (b.percent > 0 && a.vy < -100) bounced = true;
    }
    assert.ok(b.percent > 0, "Pogo connected");
    assert.ok(bounced, "Pogo bounced its user upward");
    assert.ok(spiked, "victim was spiked downward");
  }
});

// ---------------------------------------------------------------- CPU

test("a CPU produces ordinary input frames and closes on its opponent", () => {
  const s = arena();
  const cpu = spawnFighter(s, { id: "cpu1", character: "glizzy", name: "CPU", cpu: true, x: 340, y: 400, invuln: 0 });
  const human = grounded(s, "h", "glizzy", 940);
  const gap0 = Math.abs(cpu.x - human.x);

  for (let i = 0; i < 90; i++) {
    const frame = cpuInput(s, "cpu1");
    assert.equal(typeof frame.left, "boolean", "CPU emits a normal input frame");
    stepArena(s, { cpu1: frame });
  }
  assert.ok(Math.abs(cpu.x - human.x) < gap0, "CPU closed the distance");
});

// ---------------------------------------------------------------- lifecycle

test("despawning removes a Fighter from the Arena", () => {
  const s = arena();
  grounded(s, "a");
  assert.ok(s.fighters.a);
  despawnFighter(s, "a");
  run(s, 2);
  assert.equal(s.fighters.a, undefined);
});

test("the simulation is deterministic for identical inputs", () => {
  function play() {
    const s = createArena(99);
    spawnFighter(s, { id: "a", character: "glizzy", name: "a", x: 600, y: 300 });
    spawnFighter(s, { id: "b", character: "ketchup", name: "b", x: 700, y: 300 });
    for (let i = 0; i < 120; i++) {
      stepArena(s, {
        a: input({ right: i % 7 < 3, light: i % 11 === 0, jump: i % 23 === 0 }),
        b: cpuInput(s, "b"),
      });
    }
    return JSON.stringify(s.fighters);
  }
  assert.equal(play(), play());
});

test("the tick rate is the agreed 30Hz", () => {
  assert.equal(TICK_HZ, 30);
});

// ------------------------------------------------- snapshots are simulatable
//
// The browser folds server snapshots into an arena it keeps stepping, so
// whatever comes out of `applySnapshot` has to be something `stepArena` can
// still run. The wire deliberately carries an attack's move as a NAME (art
// needs the name, not the frame data), while the simulation needs the move
// OBJECT — `stepAttack` reads `startup`/`active`/`endlag` off it to know when
// the attack is over.
//
// Feed the wire shape back into the stepper and `startup + active` is
// `undefined + undefined` = NaN, so `frame >= activeEnd + endlag` is false on
// every future tick and the attack NEVER ENDS. A Fighter with an attack that
// cannot end is permanently unactionable: `controllable` and `canMove` are both
// gated on `!f.attack`. That is a frozen Fighter for the rest of the session,
// and it is invisible to the server, which has its own perfectly healthy copy.

test("a Fighter folded in from a snapshot mid-attack still finishes the attack", () => {
  const server = arena();
  spawnFighter(server, { id: "a", character: "glizzy", name: "A" });
  server.fighters.a.onGround = true;
  const swing = emptyInput();
  swing.light = true;
  stepArena(server, { a: swing });
  assert.ok(server.fighters.a.attack, "precondition: the server Fighter is mid-attack");

  const client = arena();
  applySnapshot(client, snapshot(server));
  const mine = client.fighters.a;
  assert.ok(mine.attack, "the attack should survive the fold");

  // Every attack in the game is over well inside 60 ticks (two seconds).
  for (let i = 0; i < 60; i++) stepArena(client, {});
  assert.equal(mine.attack, null, "the attack never ended — this Fighter is frozen forever");
});

test("a Fighter folded in mid-attack can act again afterwards", () => {
  // The symptom the frame data actually causes: an attack that cannot end means
  // `controllable` is false forever, so no input is ever read again.
  const server = arena();
  spawnFighter(server, { id: "a", character: "grill", name: "A" });
  server.fighters.a.onGround = true;
  const swing = emptyInput();
  swing.heavy = true;
  stepArena(server, { a: swing });

  const client = arena();
  applySnapshot(client, snapshot(server));
  const mine = client.fighters.a;
  mine.onGround = true;

  for (let i = 0; i < 60; i++) stepArena(client, {});

  const startX = mine.x;
  const run = emptyInput();
  run.right = true;
  for (let i = 0; i < 10; i++) stepArena(client, { a: run });
  assert.ok(mine.x > startX + 20, "the Fighter never regained control after the fold");
});

test("an unknown move name folded in does not freeze the Fighter", () => {
  // A client running older code than the server must degrade to "no attack",
  // never to "an attack that cannot end".
  const client = arena();
  spawnFighter(client, { id: "a", character: "glizzy", name: "A" });
  client.fighters.a.onGround = true;
  const snap = {
    tick: 5,
    fighters: [{
      ...snapshot(client).fighters[0],
      attack: { kind: null, frame: 0, move: "a_move_from_the_future", startup: 3, active: 3, endlag: 6 },
    }],
    projectiles: [],
  };
  applySnapshot(client, snap);
  for (let i = 0; i < 60; i++) stepArena(client, {});
  assert.equal(client.fighters.a.attack, null);
});
