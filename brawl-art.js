// GlizzyBrawl — Fighter art.
//
// All four Fighters now have art of their own — a hot dog, a bottle, a kettle
// grill and a corn dog, generated through PixelLab and imported into
// `assets/brawl/`. They used to be Kenney's CC0 platformer humans with a
// costume painted over them, and that costume layer is gone: with every
// Fighter bespoke it had no users left, and keeping two ways to draw a Fighter
// is how the renderer and its preview quietly disagree.
//
// The CPU keeps a Kenney body on purpose (`assets/brawl/LICENSE-kenney.txt`),
// so a practice partner is never mistaken for a person. That zombie is the only
// borrowed art left in the Arena.
//
// Same shared-file rule as `brawl-sim.js`: this module imports nothing and
// touches no browser-only global beyond the 2D context it is handed, so the
// page and an offline preview script both run it and neither can drift.

/** The one borrowed body left: CPUs, so a practice partner reads as a stand-in. */
export const CPU_BODY = "zombie";

/** Fighters the Arena has art for. Sprite files are named after these. */
export const CHARACTERS = ["glizzy", "ketchup", "grill", "corndog"];

// --------------------------------------------------------------------- clips
//
// A Fighter's actions are animated, not posed. Each action is a **clip**: an
// ordered run of frames, drawn from `<body>_<clip>_<n>.png`.
//
// Every Fighter's clip is the SAME LENGTH, deliberately. Timing then belongs to
// the move — `light_side` looks the same length on all four Fighters because it
// *is* the same length — and this table stays one row per action instead of one
// row per action per Fighter. The importer resamples whatever the generator
// produced (5 frames, 7 frames, 9) down to the count declared here, so a clip's
// length is a decision made once, in code, rather than a property of whichever
// animation job happened to run.
//
// This is the Stage's `LAYOUT` rule applied to Fighters: the numbers live where
// they are readable and are *gated* at import, not written into the source by a
// script. `scripts/brawl-import-sprites.mjs` refuses art that disagrees with
// this table and prints the number to change.
//
// `contact` is the frame of maximum extension — the punch fully out. It is the
// whole reason attacks read as attacks: the renderer pins it to the move's
// first ACTIVE frame, so wind-up plays through the startup, contact holds for
// exactly as long as the hitbox exists, and what is left plays out over the
// endlag. A player who learns to watch for the extension is watching the real
// hitbox, on every move, without the art knowing any move's frame data.
export const CLIPS = {
  stand: { frames: 1 },
  walk: { frames: 4 },
  jump: { frames: 3 },
  fall: { frames: 3 },
  duck: { frames: 3 },
  hurt: { frames: 3 },
  action1: { frames: 4, contact: 2 },
  kick: { frames: 4, contact: 2 },
  action2: { frames: 4, contact: 2 },
};

/**
 * Per-body overrides. The CPU's borrowed Kenney zombie has one drawing per
 * action and always will — it is a pack of static poses, not an animated
 * character — so it holds the single-frame path open in production. Every clip
 * degrades to its first frame on its own, which is exactly what the Arena drew
 * before any of this existed.
 */
export const BODY_CLIPS = {
  [CPU_BODY]: {
    stand: { frames: 1 }, walk: { frames: 2 }, jump: { frames: 1 }, fall: { frames: 1 },
    duck: { frames: 1 }, hurt: { frames: 1 }, action1: { frames: 1 },
    kick: { frames: 1 }, action2: { frames: 1 },
  },
};

/** What a given body's clip actually is: length, and where contact lands. */
export function clipInfo(body, clip) {
  const base = CLIPS[clip] || CLIPS.stand;
  const override = (BODY_CLIPS[body] || {})[clip];
  const frames = Math.max(1, Math.floor((override && override.frames) || base.frames || 1));
  const declared = override && "contact" in override ? override.contact : base.contact;
  const contact = Number.isFinite(declared) ? Math.min(Math.max(declared, 0), frames - 1) : 0;
  return { frames, contact };
}

/** Native size of a Kenney character frame, and the height we draw it at. */
export const SPRITE = { width: 80, height: 110, drawHeight: 70 };

export function spritePath(body, clip, index = 0) {
  return `/brawl/art/${body}_${clip}_${index}.png`;
}

export function spriteKey(body, clip, index = 0) {
  return `${body}:${clip}:${index}`;
}

/** Every sprite the renderer will ever need, for preloading. */
export function allSprites() {
  const bodies = [...CHARACTERS, CPU_BODY];
  const out = [];
  for (const body of bodies) {
    for (const clip of Object.keys(CLIPS)) {
      const { frames } = clipInfo(body, clip);
      for (let index = 0; index < frames; index++) {
        out.push({ body, clip, index, url: spritePath(body, clip, index) });
      }
    }
  }
  return out;
}

/**
 * The move's name, whichever form the attack is in: a snapshot carries the
 * name as a string, while a locally predicted Fighter still holds the live
 * move object. The renderer sees both and must not care.
 */
export function moveNameOf(attack) {
  if (!attack) return "";
  const move = attack.move;
  if (typeof move === "string") return move;
  return (move && move.name) || attack.kind || "";
}

/**
 * Which sprite set a Fighter draws from — its own, unless it is a CPU.
 *
 * This used to consult a manifest list of which Fighters had art of their own,
 * because art landed one Fighter at a time and the rest wore costumes over
 * borrowed bodies. All four have their own art now, so the list, the costumes
 * and the branch they fed are gone.
 */
export function bodyFor(fighter) {
  return fighter.cpu ? CPU_BODY : fighter.character;
}

/**
 * A move's frame data, whichever form the attack is in — the same dual-shape
 * problem `moveNameOf` solves. A predicted Fighter holds the live move object;
 * a snapshot carries the three numbers inline.
 *
 * The fallbacks are a middleweight light attack. They matter: a preview or an
 * older snapshot that names a move without its timing should still animate,
 * just generically, rather than freeze on frame zero.
 */
export function moveTimingOf(attack) {
  const move = attack && attack.move;
  const src = move && typeof move === "object" ? move : attack || {};
  const num = (v, fallback) => (Number.isFinite(v) ? v : fallback);
  return {
    startup: Math.max(1, num(src.startup, 4)),
    // A move with no active window at all (Splat spawns a projectile and is
    // done) still has to *show* the throw, so contact is held for a tick.
    active: Math.max(1, num(src.active, 3)),
    endlag: Math.max(1, num(src.endlag, 8)),
  };
}

/** Which clip an attack plays, by move strength — a jab, a swing, a special. */
export function attackClipFor(attack) {
  const move = moveNameOf(attack);
  if (move.includes("light")) return "action1";
  if (move.includes("heavy")) return "kick";
  return "action2";
}

const clamp01 = (t) => (t < 0 ? 0 : t > 1 ? 1 : t);

/** Frame `t` of the way through a clip, where t is in [0, 1]. */
function frameAt(body, clip, t) {
  const { frames } = clipInfo(body, clip);
  return Math.min(frames - 1, Math.floor(clamp01(t) * frames));
}

/**
 * How far through a timed state a Fighter is, from what the sim reports as
 * remaining and what it started at. Plays forward as the timer drains.
 */
function drained(remaining, total) {
  if (!Number.isFinite(total) || total <= 0) return 1;
  return clamp01(1 - (Number.isFinite(remaining) ? remaining : 0) / total);
}

/**
 * Approximate rise and fall speeds, in px/s, at which the air clips reach their
 * last frame. Unlike a state's duration these are *look* thresholds rather than
 * sim truth — jump velocity differs per Fighter and being a little off only
 * biases which frame shows, which the clip clamps. They are not a second copy
 * of anything the sim owns.
 */
const RISE_SPEED = 900;
const FALL_SPEED = 1000;

/** How much of a dodge's 12 ticks the duck spends compressing before it holds. */
const DUCK_SETTLE = 0.35;

/**
 * Pick the frame for a Fighter's current state: `{ clip, index }`. Pure — takes
 * the snapshot fields the renderer already has plus a clock, so it is trivially
 * previewable.
 *
 * Almost nothing here reads the clock. An attack is driven by its own frame
 * counter, hitstun and dodges by the timers the sim reports, and the air clips
 * by vertical velocity — so a Fighter hanging at the apex holds the apex frame
 * however long the hang lasts, and a slow tick cannot desynchronise a wind-up
 * from the hitbox it warns about. Only the walk cycle, which has no state of
 * its own to track, is on a clock.
 */
export function frameFor(fighter, nowMs = 0) {
  const body = bodyFor(fighter);
  const at = (clip, t) => ({ clip, index: frameAt(body, clip, t) });

  if (fighter.state === "hitstun") {
    return at("hurt", drained(fighter.hitstun, fighter.hitstunTotal));
  }
  if (fighter.state === "dodge") {
    // Compress fast, then hold: a duck is a pose you are *in*, and spreading
    // the squash over the whole dodge means it never looks ducked.
    return at("duck", drained(fighter.dodgeTicks, fighter.dodgeTotal) / DUCK_SETTLE);
  }
  if (fighter.attack) {
    const clip = attackClipFor(fighter.attack);
    return { clip, index: attackFrame(body, clip, fighter.attack) };
  }
  if (!fighter.onGround) {
    return fighter.vy > 0
      ? at("fall", fighter.vy / FALL_SPEED)
      : at("jump", 1 + fighter.vy / RISE_SPEED);
  }
  if (Math.abs(fighter.vx) > 30) return { clip: "walk", index: walkFrame(body, fighter.vx, nowMs) };
  return { clip: "stand", index: 0 };
}

/**
 * Lay a clip over a move's frame data, pinning `contact` to the first ACTIVE
 * frame. Wind-up plays across the startup, contact is held for exactly the
 * hitbox's lifetime, and the rest of the clip plays out over the endlag.
 *
 * That mapping is what makes a 12-frame heavy read as slow and a 3-frame jab as
 * fast, from one clip each, with no per-move art. It is also the honest one:
 * the moment the Fighter looks most committed is the moment it can actually
 * hit you.
 */
function attackFrame(body, clip, attack) {
  const { frames, contact } = clipInfo(body, clip);
  if (frames <= 1) return 0;
  const { startup, active, endlag } = moveTimingOf(attack);
  const frame = Math.max(0, Number.isFinite(attack.frame) ? attack.frame : 0);

  if (frame < startup) return Math.min(contact, Math.floor((frame / startup) * contact));
  if (frame < startup + active) return contact;

  const rest = frames - 1 - contact;
  if (rest <= 0) return frames - 1;
  const through = (frame - startup - active) / endlag;
  return Math.min(frames - 1, contact + 1 + Math.floor(clamp01(through) * rest));
}

/**
 * The walk cycle, paced by how fast the Fighter is actually moving — a slow
 * walk animates slowly. A fixed rate made a Fighter at a crawl look like it was
 * skating.
 */
function walkFrame(body, vx, nowMs) {
  const { frames } = clipInfo(body, "walk");
  if (frames <= 1) return 0;
  const perFrameMs = Math.min(200, Math.max(70, 24000 / Math.abs(vx)));
  return Math.floor(nowMs / perFrameMs) % frames;
}

// -------------------------------------------------------------- flourishes
//
// A signature move's flourish — the splat leaving Ketchup's nozzle, the coals
// roaring on The Grill's flare — is *not* part of the costume. It used to be,
// and that made it invisible for any Fighter with art of its own: the costume
// is gated on the manifest and the flourish went through the gate with it.
// The Grill is the case that matters. Flare-Up is a 12-frame wind-up, and the
// coals are the entire telegraph; without them a stock-ending launcher reads
// as instant.
//
// Deciding *whether* a flourish is showing is separate from drawing it, and is
// a pure function of a Fighter snapshot — that is the seam
// `test/brawl-art.test.js` pins. See `docs/glizzybrawl-art-brief.md`.

/**
 * Flourishes, keyed by the special's name in `brawl-sim.js`. `windup` is how
 * many attack frames the effect takes to reach full strength; take it from the
 * move's own startup so the telegraph and the hitbox it warns about agree.
 *
 * `layer` is "back" (behind the Fighter) or "front". Flames go behind: a
 * Fighter's face is the whole reason these sprites work at 64px.
 */
export const FLOURISHES = {
  splat: { windup: 2, layer: "front", draw: drawSplatBurst },
  flare: { windup: 12, layer: "back", draw: drawCoals },
};

/**
 * Is a flourish showing for this Fighter, and how far through it is it?
 *
 * Returns `null` or `{ id, progress }` with progress in [0, 1]. Pure, and
 * blind to the manifest — a bespoke Fighter's flourish must survive exactly
 * the change that used to delete it.
 *
 * Flourishes fire on the special alone. Firing them on every jab made all
 * three of a Fighter's attacks look like the same move.
 */
export function flourishFor(fighter) {
  if (!fighter || !fighter.attack) return null;
  const move = moveNameOf(fighter.attack);
  if (move.includes("light") || move.includes("heavy")) return null;
  const spec = FLOURISHES[move];
  if (!spec) return null;
  const frame = Number.isFinite(fighter.attack.frame) ? fighter.attack.frame : 0;
  // Progress comes from the attack's own frame counter, never from the clock,
  // so a telegraph stays in step with the hitbox even under a slow tick.
  const progress = Math.max(0, Math.min(1, (frame + 1) / spec.windup));
  return { id: move, progress };
}

/**
 * Draw the flourish for a Fighter, if one is showing. Called for **every**
 * Fighter, whichever sprite set it draws.
 *
 * @param layer "back" (before the body sprite) or "front" (after)
 */
export function drawFlourish(ctx, fighter, nowMs = 0, layer = "front") {
  const showing = flourishFor(fighter);
  if (!showing) return;
  const spec = FLOURISHES[showing.id];
  if (!spec || spec.layer !== layer) return;
  spec.draw(ctx, { progress: showing.progress, nowMs });
}

/**
 * Ketchup's Splat: a burst of sauce at the nozzle. Deliberately stays *on the
 * Fighter* and never travels — the blob in flight is a real projectile the
 * renderer already draws, and a second moving blob here means the player cannot
 * tell where the shot actually is.
 *
 * Splat's startup is two frames, so this is at full strength by the time the
 * projectile leaves and simply hangs at the nozzle through the endlag.
 */
function drawSplatBurst(ctx, { progress }) {
  ctx.globalAlpha = 0.9;
  ctx.fillStyle = "#e11d48";
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 3;
    ctx.beginPath();
    ctx.arc(14 + progress * 8 * t, -34 - i * 4, 4 - i, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

/**
 * The Grill's Flare-Up: coals roaring higher the closer the launcher gets.
 *
 * Drawn behind the Fighter, so it has to be *wider* than one. A single tongue
 * up the centre line was completely hidden by the body and telegraphed
 * nothing — the outer licks are what make it visible at a glance.
 */
function drawCoals(ctx, { progress, nowMs }) {
  const flicker = 1 + Math.sin(nowMs / 90) * 0.08;
  const tongue = (x, halfWidth, height, color) => {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.moveTo(x - halfWidth, -4);
    ctx.quadraticCurveTo(x, -height * flicker, x + halfWidth, -4);
    ctx.closePath();
    ctx.fill();
  };
  ctx.globalAlpha = 0.85;
  tongue(-26, 11, 26 + progress * 44, "#ea580c");
  tongue(26, 11, 26 + progress * 44, "#ea580c");
  tongue(0, 20, 40 + progress * 62, "#f97316");
  tongue(0, 10, 28 + progress * 40, "#fde047");
  ctx.globalAlpha = 1;
}

// ------------------------------------------------------------------ crowns

// Fighter-local space: feet at (0, 0), head around y = -70, facing +x. The
// caller has already flipped the context for facing, so nothing here needs to
// know which way anyone is looking.

/** Head height in Fighter-local space; the crown seats above it. */
const CROWN_BASE = -62;

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Crowns are cosmetic-only, and sit above whatever hat is worn. */
export function drawCrown(ctx, kind) {
  const colors = { bronze: "#d97706", silver: "#cbd5e1", gold: "#facc15" };
  ctx.fillStyle = colors[kind] || "#facc15";
  const y = CROWN_BASE - 24;
  ctx.beginPath();
  ctx.moveTo(-13, y + 9);
  ctx.lineTo(-13, y);
  ctx.lineTo(-6, y + 5);
  ctx.lineTo(0, y - 4);
  ctx.lineTo(6, y + 5);
  ctx.lineTo(13, y);
  ctx.lineTo(13, y + 9);
  ctx.closePath();
  ctx.fill();
}
