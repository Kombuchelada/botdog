// GlizzyBrawl — the simulation.
//
// This module is the *only* place Arena physics live. The Node server imports
// it directly; the browser fetches the very same file from `/brawl/sim.js` and
// runs it for client-side prediction. That is deliberate: this codebase has
// twice been bitten by a hand-maintained client replica drifting from the
// server (see the `computeRatesFor` note in CLAUDE.md), so here there is no
// replica to drift.
//
// Consequences of the shared-file rule, all load-bearing:
//   * zero imports — no `node:` builtins, no npm, nothing the browser lacks
//   * no `Math.random()` and no `Date.now()` — the sim must be a pure function
//     of (state, inputs) so the client's prediction lands on the same frame the
//     server computed. Randomness comes from `state.seed` via `nextRandom()`.
//   * plain data only — state is JSON-serialisable so a snapshot is just the
//     state with the private bits dropped.
//
// Units are pixels and seconds. `y` grows downward; a Fighter's `y` is at its
// feet. Durations in move tables are *ticks* at TICK_HZ.

export const TICK_HZ = 30;
export const TICK_MS = 1000 / TICK_HZ;
const DT = 1 / TICK_HZ;

export const STAGE = {
  width: 1280,
  height: 720,
  // The main platform. Nothing ever drops through this one.
  ground: { x1: 240, x2: 1040, y: 520 },
  // Soft platforms — land on them from above, drop through with down+jump.
  platforms: [
    { x1: 340, x2: 560, y: 380 },
    { x1: 720, x2: 940, y: 380 },
    { x1: 530, x2: 750, y: 250 },
  ],
  blast: { left: -180, right: 1460, top: -340, bottom: 900 },
  spawns: [
    { x: 420, y: 200 },
    { x: 860, y: 200 },
    { x: 640, y: 140 },
    { x: 320, y: 300 },
    { x: 960, y: 300 },
    { x: 540, y: 120 },
    { x: 740, y: 120 },
    { x: 640, y: 320 },
  ],
};

// Fighter body, shared by every character. Characters differ by frame stats,
// not hurtbox size — one less thing to balance.
export const BODY = { halfWidth: 18, height: 54 };

export const GRAVITY = 2400;
export const MAX_FALL = 1250;
export const FAST_FALL = 1900;
const GROUND_ACCEL = 4200;
const AIR_ACCEL = 2000;
const FRICTION = 3600;
const DRIFT_MAX = 0.95; // air speed cap as a fraction of run speed

export const RESPAWN_DELAY_TICKS = 45; // 1.5s
export const SPAWN_INVULN_TICKS = 30;
export const DODGE_TICKS = 12;
export const DODGE_INVULN_TICKS = 9;
export const DODGE_COOLDOWN_TICKS = 45;
export const DROP_THROUGH_TICKS = 9;
const SLOW_FACTOR = 0.6;
// How long a hit keeps the attacker on the hook for the KO. Longer than any
// plausible fall, short enough that a stale hit never steals a self-destruct.
const KO_CREDIT_TICKS = 8 * TICK_HZ;
const KNOCKBACK_DECAY = 0.94;

// --------------------------------------------------------------- the roster

export const FIGHTERS = {
  glizzy: {
    id: "glizzy",
    name: "The Glizzy",
    blurb: "The balanced all-rounder. Everything works, nothing is free.",
    color: "#ff6b35",
    weight: 100,
    runSpeed: 330,
    jumpVel: 880,
    reach: 1,
    damageMul: 1,
    special: {
      id: "snap",
      name: "Snap",
      blurb: "A bite-lunge that closes distance and bites at the end of it.",
    },
  },
  ketchup: {
    id: "ketchup",
    name: "Ketchup",
    blurb: "Fast and light. Gets in, stays in, dies early.",
    color: "#e11d48",
    weight: 78,
    runSpeed: 420,
    jumpVel: 900,
    reach: 0.92,
    damageMul: 0.88,
    special: {
      id: "splat",
      name: "Splat",
      blurb: "A thrown blob that damages and slows on contact.",
    },
  },
  grill: {
    id: "grill",
    name: "The Grill",
    blurb: "Slow heavyweight. Patient reads, enormous payoff.",
    color: "#a855f7",
    weight: 132,
    runSpeed: 250,
    jumpVel: 800,
    reach: 1.05,
    damageMul: 1.18,
    special: {
      id: "flare",
      name: "Flare-Up",
      blurb: "A long wind-up, then a vertical launcher that ends stocks.",
    },
  },
  corndog: {
    id: "corndog",
    name: "Corn Dog",
    blurb: "Disjointed reach on a stick, and a spike to finish with.",
    color: "#f59e0b",
    weight: 96,
    runSpeed: 310,
    jumpVel: 860,
    reach: 1.28,
    damageMul: 0.96,
    special: {
      id: "pogo",
      name: "Pogo",
      blurb: "A downward stab that spikes the victim and bounces you up.",
    },
  },
};

export const FIGHTER_IDS = ["glizzy", "ketchup", "grill", "corndog"];

// ---------------------------------------------------------------- the moves
//
// angle is in radians, measured from "forward" (the Fighter's facing) with
// negative meaning upward — so -Math.PI/2 launches straight up and +0.4 spikes.

function move(o) {
  return { startup: 4, active: 3, endlag: 8, damage: 5, baseKb: 140, kbGrowth: 2, angle: -0.4, dx: 40, dy: -28, w: 48, h: 36, ...o };
}

export const MOVES = {
  light_neutral: move({ startup: 3, active: 3, endlag: 6, damage: 4, baseKb: 120, kbGrowth: 1.6, angle: -0.44, dx: 34, dy: -28, w: 44, h: 34 }),
  light_side: move({ startup: 4, active: 4, endlag: 8, damage: 6, baseKb: 150, kbGrowth: 2.2, angle: -0.32, dx: 44, dy: -26, w: 56, h: 32 }),
  light_up: move({ startup: 4, active: 4, endlag: 9, damage: 5, baseKb: 140, kbGrowth: 2.0, angle: -1.4, dx: 14, dy: -60, w: 46, h: 46 }),
  light_down: move({ startup: 4, active: 4, endlag: 9, damage: 5, baseKb: 130, kbGrowth: 1.8, angle: -0.2, dx: 38, dy: -8, w: 52, h: 26 }),
  heavy_neutral: move({ startup: 9, active: 4, endlag: 16, damage: 11, baseKb: 260, kbGrowth: 3.0, angle: -0.52, dx: 40, dy: -30, w: 56, h: 44 }),
  heavy_side: move({ startup: 12, active: 4, endlag: 20, damage: 14, baseKb: 320, kbGrowth: 3.4, angle: -0.38, dx: 56, dy: -28, w: 72, h: 40 }),
  heavy_up: move({ startup: 10, active: 5, endlag: 18, damage: 12, baseKb: 300, kbGrowth: 3.6, angle: -1.36, dx: 10, dy: -70, w: 56, h: 60 }),
  heavy_down: move({ startup: 11, active: 5, endlag: 20, damage: 12, baseKb: 280, kbGrowth: 3.0, angle: -0.14, dx: 46, dy: -10, w: 66, h: 30 }),

  air_light_neutral: move({ startup: 3, active: 4, endlag: 5, damage: 4, baseKb: 110, kbGrowth: 1.6, angle: -0.5, dx: 32, dy: -30, w: 46, h: 40 }),
  air_light_side: move({ startup: 4, active: 4, endlag: 6, damage: 6, baseKb: 145, kbGrowth: 2.1, angle: -0.36, dx: 46, dy: -28, w: 58, h: 38 }),
  air_light_up: move({ startup: 4, active: 4, endlag: 7, damage: 5, baseKb: 135, kbGrowth: 2.2, angle: -1.45, dx: 8, dy: -66, w: 50, h: 46 }),
  // The aerial down-light is the everyman spike.
  air_light_down: move({ startup: 5, active: 4, endlag: 9, damage: 6, baseKb: 150, kbGrowth: 1.9, angle: 1.15, dx: 10, dy: 18, w: 44, h: 46 }),
  air_heavy_neutral: move({ startup: 8, active: 5, endlag: 12, damage: 10, baseKb: 240, kbGrowth: 3.0, angle: -0.55, dx: 38, dy: -30, w: 58, h: 48 }),
  air_heavy_side: move({ startup: 9, active: 5, endlag: 14, damage: 13, baseKb: 300, kbGrowth: 3.3, angle: -0.34, dx: 56, dy: -28, w: 70, h: 44 }),
  air_heavy_up: move({ startup: 9, active: 5, endlag: 14, damage: 12, baseKb: 290, kbGrowth: 3.5, angle: -1.42, dx: 8, dy: -70, w: 54, h: 58 }),
  air_heavy_down: move({ startup: 10, active: 5, endlag: 16, damage: 12, baseKb: 250, kbGrowth: 2.4, angle: 1.25, dx: 12, dy: 24, w: 50, h: 56 }),
};

// One special per Fighter. `kind` drives the bespoke bits in `startAttack` and
// `stepAttack`; everything else reuses the ordinary move pipeline.
export const SPECIALS = {
  snap: move({ kind: "snap", startup: 4, active: 5, endlag: 12, damage: 9, baseKb: 200, kbGrowth: 2.4, angle: -0.36, dx: 40, dy: -28, w: 64, h: 40, lunge: 420 }),
  splat: move({ kind: "splat", startup: 2, active: 0, endlag: 16, damage: 6, baseKb: 130, kbGrowth: 1.4, angle: -0.3 }),
  flare: move({ kind: "flare", startup: 16, active: 6, endlag: 22, damage: 18, baseKb: 380, kbGrowth: 3.2, angle: -1.31, dx: 26, dy: -44, w: 80, h: 92 }),
  pogo: move({ kind: "pogo", startup: 3, active: 8, endlag: 12, damage: 10, baseKb: 300, kbGrowth: 2.0, angle: 1.31, dx: 0, dy: 26, w: 48, h: 60, dive: 900, bounce: 640 }),
};

// Every move knows its own name. The renderer needs it to pick an animation,
// and a predicted attack (a live move object) has to answer the same question
// as a serialised one (a name string) — see `moveNameOf`, which this replaces.
for (const [name, m] of Object.entries(MOVES)) m.name = name;
for (const [name, m] of Object.entries(SPECIALS)) m.name = name;

export const PROJECTILE = { speed: 620, gravity: 260, radius: 12, ttlTicks: 45, slowTicks: 60 };

// ---------------------------------------------------------------- the state

export function createArena(seed = 1) {
  return {
    tick: 0,
    seed: seed >>> 0 || 1,
    fighters: {},
    projectiles: [],
    nextProjectileId: 1,
  };
}

export function emptyInput() {
  return {
    seq: 0,
    left: false,
    right: false,
    up: false,
    down: false,
    jump: false,
    light: false,
    heavy: false,
    special: false,
    dodge: false,
  };
}

/** Coerce anything off the wire into a well-formed input frame. */
export function sanitizeInput(raw) {
  const base = emptyInput();
  if (!raw || typeof raw !== "object") return base;
  for (const key of Object.keys(base)) {
    if (key === "seq") base.seq = Number.isFinite(raw.seq) ? Math.floor(raw.seq) : 0;
    else base[key] = raw[key] === true;
  }
  return base;
}

function nextRandom(state) {
  // Deterministic LCG. See the header: no Math.random in this file.
  state.seed = (state.seed * 1664525 + 1013904223) >>> 0;
  return state.seed / 4294967296;
}

export function spawnFighter(state, {
  id,
  character,
  name,
  cpu = false,
  cosmetics = null,
  x,
  y,
  // Dropping into a live brawl grants a moment of intangibility so joining is
  // never an instant Fall. Callers that want a Fighter immediately hittable
  // (the sim's own tests, mostly) pass 0.
  invuln = SPAWN_INVULN_TICKS,
}) {
  const def = FIGHTERS[character] ? character : "glizzy";
  const spawn = STAGE.spawns[Object.keys(state.fighters).length % STAGE.spawns.length];
  const f = {
    id,
    character: def,
    name: name || id,
    cpu: !!cpu,
    fading: false,
    cosmetics: cosmetics || null,
    x: Number.isFinite(x) ? x : spawn.x,
    y: Number.isFinite(y) ? y : spawn.y,
    vx: 0,
    vy: 0,
    facing: 1,
    percent: 0,
    onGround: false,
    jumpsUsed: 0,
    state: "air",
    attack: null,
    hitstun: 0,
    hitstunTotal: 0,
    invuln,
    dodgeTicks: 0,
    dodgeCooldown: 0,
    dropThrough: 0,
    slowTicks: 0,
    respawnTimer: 0,
    lastHitBy: null,
    lastHitCharacter: null,
    lastHitTick: -1e9,
    kos: 0,
    falls: 0,
    streak: 0,
    bestStreak: 0,
    prev: emptyInput(),
    seq: 0,
    spawnTick: state.tick,
  };
  state.fighters[id] = f;
  return f;
}

export function despawnFighter(state, id) {
  delete state.fighters[id];
  state.projectiles = state.projectiles.filter((p) => p.owner !== id);
}

// ---------------------------------------------------------------- geometry

function hurtbox(f) {
  return {
    x1: f.x - BODY.halfWidth,
    x2: f.x + BODY.halfWidth,
    y1: f.y - BODY.height,
    y2: f.y,
  };
}

function hitbox(f, m) {
  const reach = FIGHTERS[f.character].reach;
  const cx = f.x + f.facing * m.dx * reach;
  const cy = f.y + m.dy;
  const hw = (m.w * reach) / 2;
  const hh = m.h / 2;
  return { x1: cx - hw, x2: cx + hw, y1: cy - hh, y2: cy + hh };
}

function overlaps(a, b) {
  return a.x1 < b.x2 && a.x2 > b.x1 && a.y1 < b.y2 && a.y2 > b.y1;
}

function isIntangible(f) {
  return f.invuln > 0 || (f.state === "dodge" && f.dodgeTicks > DODGE_TICKS - DODGE_INVULN_TICKS);
}

function isFighting(f) {
  return f.state !== "respawn";
}

// ---------------------------------------------------------------- stepping

/**
 * Advance the Arena one tick.
 *
 * @param {object} state   arena state, mutated in place
 * @param {object} inputs  map of fighter id -> input frame (missing = idle)
 * @returns {Array} events — `hit`, `ko`, `respawn`, `projectile` — the only
 *   thing callers should read to learn what happened. Everything else is
 *   position data they can render.
 */
export function stepArena(state, inputs = {}) {
  const events = [];
  state.tick += 1;

  for (const f of Object.values(state.fighters)) {
    const raw = inputs[f.id];
    const input = raw ? sanitizeInput(raw) : emptyInput();
    if (raw && Number.isFinite(raw.seq)) f.seq = Math.max(f.seq, Math.floor(raw.seq));
    stepFighter(state, f, input, events);
    f.prev = input;
  }

  stepProjectiles(state, events);

  for (const f of Object.values(state.fighters)) {
    if (f.state === "respawn") continue;
    if (outsideBlastZone(f)) knockOut(state, f, events);
  }

  return events;
}

function outsideBlastZone(f) {
  return (
    f.x < STAGE.blast.left ||
    f.x > STAGE.blast.right ||
    f.y < STAGE.blast.top ||
    f.y > STAGE.blast.bottom
  );
}

function knockOut(state, victim, events) {
  // Credit is by id, not by presence. Landing the hit that sends someone off
  // the stage earns the KO even if you left, were replaced, or faded out
  // during the two seconds they spent falling.
  const attackerId =
    victim.lastHitBy && state.tick - victim.lastHitTick <= KO_CREDIT_TICKS ? victim.lastHitBy : null;
  const attacker = attackerId && attackerId !== victim.id ? state.fighters[attackerId] || null : null;

  victim.falls += 1;
  victim.streak = 0;
  victim.state = "respawn";
  victim.respawnTimer = RESPAWN_DELAY_TICKS;
  victim.vx = 0;
  victim.vy = 0;
  victim.attack = null;
  victim.hitstun = 0;
  victim.slowTicks = 0;
  victim.lastHitBy = null;

  if (attacker) {
    attacker.kos += 1;
    attacker.streak += 1;
    attacker.bestStreak = Math.max(attacker.bestStreak, attacker.streak);
  }

  events.push({
    type: "ko",
    tick: state.tick,
    victim: victim.id,
    attacker: attackerId === victim.id ? null : attackerId,
    // The character the credited hit was thrown with, carried on the victim so
    // per-character credit survives the attacker leaving.
    attackerCharacter: attackerId ? victim.lastHitCharacter : null,
    attackerPresent: !!attacker,
    percent: Math.round(victim.percent),
    streak: attacker ? attacker.streak : 0,
  });
  victim.percent = 0;
}

function stepFighter(state, f, input, events) {
  if (f.hitstun > 0) f.hitstun -= 1;
  if (f.invuln > 0) f.invuln -= 1;
  if (f.dodgeCooldown > 0) f.dodgeCooldown -= 1;
  if (f.slowTicks > 0) f.slowTicks -= 1;
  if (f.dropThrough > 0) f.dropThrough -= 1;

  if (f.state === "respawn") {
    f.respawnTimer -= 1;
    if (f.respawnTimer <= 0) respawn(state, f, events);
    return;
  }

  const def = FIGHTERS[f.character];
  const controllable = f.hitstun <= 0 && f.state !== "dodge" && !f.attack;

  if (f.state === "dodge") {
    f.dodgeTicks -= 1;
    if (f.dodgeTicks <= 0) {
      f.state = f.onGround ? "idle" : "air";
      f.dodgeCooldown = DODGE_COOLDOWN_TICKS;
    }
  }

  if (controllable) {
    if (pressed(f, input, "dodge") && f.dodgeCooldown <= 0) {
      f.state = "dodge";
      f.dodgeTicks = DODGE_TICKS;
      f.vx *= 0.3;
    } else if (pressed(f, input, "special")) {
      startAttack(state, f, SPECIALS[def.special.id], input, events);
    } else if (pressed(f, input, "light") || pressed(f, input, "heavy")) {
      const strength = pressed(f, input, "heavy") ? "heavy" : "light";
      startAttack(state, f, MOVES[moveKey(f, input, strength)], input, events);
    }
  }

  const canMove = f.hitstun <= 0 && f.state !== "dodge" && (!f.attack || f.attack.kind === "pogo");

  if (canMove) {
    const speedCap = def.runSpeed * (f.slowTicks > 0 ? SLOW_FACTOR : 1);
    const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
    const accel = f.onGround ? GROUND_ACCEL : AIR_ACCEL;
    const cap = f.onGround ? speedCap : speedCap * DRIFT_MAX;
    if (dir !== 0) {
      if (!f.attack) f.facing = dir;
      f.vx += dir * accel * DT;
      if (Math.abs(f.vx) > cap) f.vx = cap * Math.sign(f.vx);
      if (f.onGround && !f.attack) f.state = "run";
    } else if (f.onGround) {
      const drop = FRICTION * DT;
      f.vx = Math.abs(f.vx) <= drop ? 0 : f.vx - Math.sign(f.vx) * drop;
      if (!f.attack) f.state = "idle";
    }

    // Jump / double jump / drop-through, all edge-triggered so holding the
    // button can never eat both jumps in consecutive frames.
    if (pressed(f, input, "jump")) {
      if (f.onGround && input.down && onSoftPlatform(f)) {
        f.dropThrough = DROP_THROUGH_TICKS;
        f.onGround = false;
        f.y += 2;
        f.state = "air";
      } else if (f.onGround) {
        f.vy = -def.jumpVel;
        f.onGround = false;
        f.jumpsUsed = 1;
        f.state = "air";
      } else if (f.jumpsUsed < 2) {
        f.vy = -def.jumpVel * 0.92;
        f.jumpsUsed = 2;
        f.state = "air";
      }
    }

    if (!f.onGround && input.down && f.vy > 0) f.vy = Math.max(f.vy, FAST_FALL);
  }

  if (f.attack) stepAttack(state, f, events);

  // Integrate.
  if (!f.onGround) {
    f.vy += GRAVITY * DT;
    if (f.vy > MAX_FALL && f.vy !== FAST_FALL) f.vy = Math.max(MAX_FALL, Math.min(f.vy, FAST_FALL));
  }
  if (f.hitstun > 0) f.vx *= KNOCKBACK_DECAY;

  const prevY = f.y;
  f.x += f.vx * DT;
  f.y += f.vy * DT;

  resolveGround(f, prevY);
}

function pressed(f, input, key) {
  return input[key] === true && f.prev[key] !== true;
}

function moveKey(f, input, strength) {
  let dir = "neutral";
  if (input.up) dir = "up";
  else if (input.down) dir = "down";
  else if (input.left || input.right) dir = "side";
  return `${f.onGround ? "" : "air_"}${strength}_${dir}`;
}

function onSoftPlatform(f) {
  return STAGE.platforms.some((p) => Math.abs(f.y - p.y) < 2 && f.x > p.x1 - BODY.halfWidth && f.x < p.x2 + BODY.halfWidth);
}

function resolveGround(f, prevY) {
  const g = STAGE.ground;
  const overGround = f.x > g.x1 - BODY.halfWidth && f.x < g.x2 + BODY.halfWidth;

  if (overGround && prevY <= g.y && f.y >= g.y && f.vy >= 0) {
    land(f, g.y);
    return;
  }

  if (f.dropThrough <= 0 && f.vy >= 0) {
    for (const p of STAGE.platforms) {
      const over = f.x > p.x1 - BODY.halfWidth && f.x < p.x2 + BODY.halfWidth;
      if (over && prevY <= p.y && f.y >= p.y) {
        land(f, p.y);
        return;
      }
    }
  }

  // Walked off an edge.
  if (f.onGround) {
    const stillOnGround = overGround && Math.abs(f.y - g.y) < 2;
    const stillOnPlatform = onSoftPlatform(f);
    if (!stillOnGround && !stillOnPlatform) {
      f.onGround = false;
      f.jumpsUsed = 1; // no free double jump from walking off
      if (f.state === "idle" || f.state === "run") f.state = "air";
    }
  }
}

function land(f, y) {
  f.y = y;
  f.vy = 0;
  f.onGround = true;
  f.jumpsUsed = 0;
  if (f.state === "air") f.state = "idle";
}

function respawn(state, f, events) {
  const spawn = STAGE.spawns[Math.floor(nextRandom(state) * STAGE.spawns.length)];
  f.x = spawn.x;
  f.y = spawn.y;
  f.vx = 0;
  f.vy = 0;
  f.percent = 0;
  f.state = "air";
  f.onGround = false;
  f.jumpsUsed = 0;
  f.invuln = SPAWN_INVULN_TICKS;
  f.attack = null;
  f.dodgeTicks = 0;
  f.dodgeCooldown = 0;
  events.push({ type: "respawn", tick: state.tick, fighter: f.id });
}

// ---------------------------------------------------------------- attacking

function startAttack(state, f, m, input, events) {
  if (!m) return;
  f.attack = { move: m, kind: m.kind || null, frame: 0, hasHit: false };
  f.state = "attack";
  if (input.right) f.facing = 1;
  else if (input.left) f.facing = -1;

  // A grounded swing plants your feet. Without this, an attack begun mid-run
  // keeps every pixel of that run — you slide straight past your own hitbox and
  // frequently off the ledge, which reads as the attack simply not working.
  if (f.onGround && !m.lunge) f.vx *= 0.2;
  if (m.kind === "snap") f.vx = f.facing * m.lunge;
  if (m.kind === "flare") f.vx = 0;
  if (m.kind === "pogo") {
    if (f.onGround) {
      // Give it a hop so the stab has somewhere to fall from.
      f.vy = -FIGHTERS[f.character].jumpVel * 0.55;
      f.onGround = false;
      f.jumpsUsed = 1;
    }
    f.vy = Math.max(f.vy, 0);
  }
  events.push({ type: "attackStart", tick: state.tick, fighter: f.id, move: m.kind || null });
}

function stepAttack(state, f, events) {
  const a = f.attack;
  const m = a.move;

  if (m.kind === "pogo" && a.frame >= m.startup && !a.hasHit) f.vy = Math.max(f.vy, m.dive);
  // The Snap lunge carries the wind-up, then plants for the bite — otherwise
  // the lunge outruns its own hitbox and the bite lands behind the target.
  if (m.kind === "snap" && a.frame >= m.startup) f.vx *= 0.5;
  if (f.onGround && !m.lunge) f.vx *= 0.7;

  if (m.kind === "splat" && a.frame === m.startup) {
    const p = {
      id: state.nextProjectileId++,
      owner: f.id,
      kind: "splat",
      x: f.x + f.facing * 26,
      y: f.y - 30,
      vx: f.facing * PROJECTILE.speed,
      vy: -40,
      ttl: PROJECTILE.ttlTicks,
      damage: m.damage * FIGHTERS[f.character].damageMul,
      baseKb: m.baseKb,
      kbGrowth: m.kbGrowth,
      angle: m.angle,
      facing: f.facing,
    };
    state.projectiles.push(p);
    events.push({ type: "projectile", tick: state.tick, fighter: f.id, projectile: p.id });
  }

  const activeStart = m.startup;
  const activeEnd = m.startup + m.active;
  if (!a.hasHit && m.active > 0 && a.frame >= activeStart && a.frame < activeEnd) {
    const box = hitbox(f, m);
    for (const victim of Object.values(state.fighters)) {
      if (victim.id === f.id || !isFighting(victim) || isIntangible(victim)) continue;
      if (!overlaps(box, hurtbox(victim))) continue;
      applyHit(state, f, victim, m, events);
      a.hasHit = true;
      if (m.kind === "pogo") f.vy = -m.bounce;
      break;
    }
  }

  a.frame += 1;
  if (a.frame >= activeEnd + m.endlag) {
    f.attack = null;
    f.state = f.onGround ? "idle" : "air";
  }
}

function applyHit(state, attacker, victim, m, events) {
  const attackerDef = FIGHTERS[attacker.character];
  const victimDef = FIGHTERS[victim.character];
  const damage = m.damage * attackerDef.damageMul;
  victim.percent += damage;

  const kb = (m.baseKb + victim.percent * m.kbGrowth) * (100 / victimDef.weight) * attackerDef.damageMul;
  const dir = attacker.facing;
  victim.vx = Math.cos(m.angle) * kb * dir;
  victim.vy = Math.sin(m.angle) * kb;
  victim.hitstunTotal = victim.hitstun = Math.min(45, Math.round(kb * 0.045) + 3);
  victim.onGround = false;
  victim.jumpsUsed = Math.max(victim.jumpsUsed, 1);
  victim.attack = null;
  victim.state = "hitstun";
  victim.lastHitBy = attacker.id;
  victim.lastHitCharacter = attacker.character;
  victim.lastHitTick = state.tick;

  events.push({
    type: "hit",
    tick: state.tick,
    attacker: attacker.id,
    victim: victim.id,
    damage: Math.round(damage * 10) / 10,
    percent: Math.round(victim.percent),
    knockback: Math.round(kb),
    x: victim.x,
    y: victim.y - BODY.height / 2,
  });
}

function stepProjectiles(state, events) {
  const kept = [];
  for (const p of state.projectiles) {
    p.vy += PROJECTILE.gravity * DT;
    p.x += p.vx * DT;
    p.y += p.vy * DT;
    p.ttl -= 1;

    let consumed = false;
    for (const victim of Object.values(state.fighters)) {
      if (victim.id === p.owner || !isFighting(victim) || isIntangible(victim)) continue;
      const box = { x1: p.x - PROJECTILE.radius, x2: p.x + PROJECTILE.radius, y1: p.y - PROJECTILE.radius, y2: p.y + PROJECTILE.radius };
      if (!overlaps(box, hurtbox(victim))) continue;

      const owner = state.fighters[p.owner];
      const victimDef = FIGHTERS[victim.character];
      victim.percent += p.damage;
      const kb = (p.baseKb + victim.percent * p.kbGrowth) * (100 / victimDef.weight);
      victim.vx = Math.cos(p.angle) * kb * p.facing;
      victim.vy = Math.sin(p.angle) * kb;
      victim.hitstunTotal = victim.hitstun = Math.min(45, Math.round(kb * 0.045) + 3);
      victim.onGround = false;
      victim.state = "hitstun";
      victim.slowTicks = PROJECTILE.slowTicks;
      if (owner) {
        victim.lastHitBy = owner.id;
        victim.lastHitCharacter = owner.character;
        victim.lastHitTick = state.tick;
      }
      events.push({
        type: "hit",
        tick: state.tick,
        attacker: p.owner,
        victim: victim.id,
        damage: Math.round(p.damage * 10) / 10,
        percent: Math.round(victim.percent),
        knockback: Math.round(kb),
        x: victim.x,
        y: victim.y - BODY.height / 2,
      });
      consumed = true;
      break;
    }

    const offStage = p.x < STAGE.blast.left || p.x > STAGE.blast.right || p.y > STAGE.blast.bottom;
    if (!consumed && p.ttl > 0 && !offStage) kept.push(p);
  }
  state.projectiles = kept;
}

// ------------------------------------------------------------------ the CPU
//
// The CPU is not a special case in the simulation: it reads the state and
// emits an ordinary input frame, so a practice fight exercises exactly the
// same code path a human does.

export function cpuInput(state, id) {
  const me = state.fighters[id];
  const frame = emptyInput();
  if (!me || me.state === "respawn") return frame;

  let target = null;
  let bestDist = Infinity;
  for (const other of Object.values(state.fighters)) {
    if (other.id === id || other.state === "respawn") continue;
    const d = Math.hypot(other.x - me.x, other.y - me.y);
    if (d < bestDist) {
      bestDist = d;
      target = other;
    }
  }
  if (!target) {
    // Nothing to fight — just get back to the middle of the stage.
    const mid = (STAGE.ground.x1 + STAGE.ground.x2) / 2;
    if (me.x < mid - 40) frame.right = true;
    else if (me.x > mid + 40) frame.left = true;
    if (!me.onGround && me.y > STAGE.ground.y - 40) frame.jump = true;
    return frame;
  }

  const dx = target.x - me.x;
  const dy = target.y - me.y;
  const reach = 52 * FIGHTERS[me.character].reach;

  // Recover first: off the side of the stage, everything else can wait.
  const offStage = me.x < STAGE.ground.x1 || me.x > STAGE.ground.x2;
  if (offStage && !me.onGround) {
    if (me.x < STAGE.ground.x1) frame.right = true;
    else frame.left = true;
    if (me.vy > 60) frame.jump = state.tick % 6 === 0;
    return frame;
  }

  if (Math.abs(dx) > reach * 0.8) {
    if (dx > 0) frame.right = true;
    else frame.left = true;
  }
  if (dy < -70 && me.onGround) frame.jump = true;
  if (dy > 90 && !me.onGround && me.y < STAGE.ground.y - 60) frame.down = true;

  const inRange = Math.abs(dx) < reach && Math.abs(dy) < 70;
  if (inRange) {
    const roll = (state.tick + Math.floor(me.x)) % 100;
    if (target.attack && me.dodgeCooldown <= 0 && roll < 18) frame.dodge = true;
    else if (roll < 42) frame.light = true;
    else if (roll < 58) frame.heavy = true;
    else if (roll < 66) frame.special = true;
    if (dy < -30) frame.up = true;
    else if (frame.left || frame.right) {
      // keep the directional variant, direction is already held
    }
  }
  return frame;
}

// ------------------------------------------------------------ serialisation

/** The over-the-wire view of the Arena. Private bookkeeping stays home. */
export function snapshot(state) {
  return {
    tick: state.tick,
    fighters: Object.values(state.fighters).map((f) => ({
      id: f.id,
      character: f.character,
      name: f.name,
      cpu: f.cpu,
      fading: f.fading,
      cosmetics: f.cosmetics,
      x: round2(f.x),
      y: round2(f.y),
      vx: round2(f.vx),
      vy: round2(f.vy),
      facing: f.facing,
      percent: Math.round(f.percent),
      state: f.state,
      onGround: f.onGround,
      // The attack carries its own frame data, not just its name. Art animates
      // a move across its wind-up, its hitbox and its recovery, and only the
      // sim knows how long each of those is — see the rule below.
      attack: f.attack
        ? {
            kind: f.attack.kind,
            frame: f.attack.frame,
            move: f.attack.move.name,
            startup: f.attack.move.startup,
            active: f.attack.move.active,
            endlag: f.attack.move.endlag,
          }
        : null,
      invuln: f.invuln,
      slowTicks: f.slowTicks,
      // A timed state that art animates emits both what is LEFT of it and what
      // it started at, because "how far through am I" is the only question an
      // animation asks and the sim is the only thing that can answer it. The
      // alternative is `brawl-art.js` carrying its own copy of DODGE_TICKS and
      // the hitstun formula — a second source of truth for a number the sim
      // owns, which is the drift this codebase keeps designing out.
      hitstun: f.hitstun,
      hitstunTotal: f.hitstunTotal,
      dodgeTicks: f.dodgeTicks,
      dodgeTotal: DODGE_TICKS,
      dodgeCooldown: f.dodgeCooldown,
      respawnTimer: f.respawnTimer,
      kos: f.kos,
      falls: f.falls,
      streak: f.streak,
      seq: f.seq,
    })),
    projectiles: state.projectiles.map((p) => ({ id: p.id, kind: p.kind, x: round2(p.x), y: round2(p.y), owner: p.owner })),
  };
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

/**
 * Fold a server snapshot into a local arena, keeping `exceptId` (the local
 * player, who is predicted) untouched. Used by the browser client only.
 */
export function applySnapshot(state, snap, exceptId = null) {
  state.tick = snap.tick;
  const seen = new Set();
  for (const s of snap.fighters) {
    seen.add(s.id);
    if (s.id === exceptId) continue;
    const existing = state.fighters[s.id];
    if (existing) Object.assign(existing, s);
    else state.fighters[s.id] = { ...spawnFighter(state, { id: s.id, character: s.character, name: s.name, cpu: s.cpu, cosmetics: s.cosmetics, x: s.x, y: s.y }), ...s };
  }
  for (const id of Object.keys(state.fighters)) {
    if (!seen.has(id) && id !== exceptId) delete state.fighters[id];
  }
  state.projectiles = snap.projectiles.map((p) => ({ ...p, vx: 0, vy: 0, ttl: 1 }));
}
