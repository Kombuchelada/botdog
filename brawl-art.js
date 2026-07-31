// GlizzyBrawl — Fighter art.
//
// The bodies are Kenney's CC0 "Platformer Characters 1" (see
// `assets/brawl/LICENSE-kenney.txt`): hand-drawn stand / walk / jump / fall /
// duck / hurt frames *plus* three real attack poses, which is the part that
// was never going to look right drawn procedurally. The costumes — bun, cap,
// grill lid, batter — are drawn on top in canvas so each Fighter still reads
// as the food it is. A Fighter with art of its own drops the costume; its
// signature-move *flourish* is a separate layer and never drops (see
// `FLOURISHES`).
//
// Same shared-file rule as `brawl-sim.js`: this module imports nothing and
// touches no browser-only global beyond the 2D context it is handed, so the
// page and an offline preview script both run it and neither can drift.

/** Which Kenney body each Fighter wears. The zombie is reserved for CPUs. */
export const BODY = {
  glizzy: "player",
  ketchup: "female",
  grill: "soldier",
  corndog: "adventurer",
};
export const CPU_BODY = "zombie";

export const POSES = [
  "stand", "walk1", "walk2", "jump", "fall", "duck", "hurt",
  "action1", "action2", "kick",
];

/** Native size of a Kenney character frame, and the height we draw it at. */
export const SPRITE = { width: 80, height: 110, drawHeight: 70 };

export function spritePath(body, pose) {
  return `/brawl/art/${body}_${pose}.png`;
}

export function spriteKey(body, pose) {
  return `${body}:${pose}`;
}

/** Every sprite the renderer will ever need, for preloading. */
export function allSprites(bespoke = []) {
  const bodies = [...new Set([...Object.values(BODY), CPU_BODY, ...bespoke])];
  const out = [];
  for (const body of bodies) {
    for (const pose of POSES) out.push({ body, pose, url: spritePath(body, pose) });
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
 * Which sprite set a Fighter draws from.
 *
 * A Fighter with art of its own ("bespoke", per `assets/brawl/manifest.json`)
 * uses sprites named after the character and gets no costume — the art already
 * *is* the food. Everyone else wears a borrowed Kenney body plus a costume.
 * This is what lets bespoke art land one Fighter at a time.
 */
export function bodyFor(fighter, bespoke = null) {
  if (bespoke && !fighter.cpu && bespoke.has(fighter.character)) return fighter.character;
  return fighter.cpu ? CPU_BODY : BODY[fighter.character] || BODY.glizzy;
}

export function wearsCostume(fighter, bespoke = null) {
  return !(bespoke && !fighter.cpu && bespoke.has(fighter.character));
}

/**
 * Pick the frame for a Fighter's current state. Pure — takes the snapshot
 * fields the renderer already has plus a clock, so it is trivially previewable.
 *
 * The three attack poses are mapped by move *strength*, so a light jab, a
 * heavy swing, and a special all look like different things without the sim
 * knowing anything about art.
 */
export function poseFor(fighter, nowMs = 0) {
  if (fighter.state === "hitstun") return "hurt";
  if (fighter.state === "dodge") return "duck";
  if (fighter.attack) {
    const move = moveNameOf(fighter.attack);
    if (move.includes("light")) return "action1";
    if (move.includes("heavy")) return "kick";
    return "action2"; // the specials
  }
  if (!fighter.onGround) return fighter.vy > 60 ? "fall" : "jump";
  if (Math.abs(fighter.vx) > 30) return Math.floor(nowMs / 110) % 2 ? "walk2" : "walk1";
  return "stand";
}

// -------------------------------------------------------------- flourishes
//
// A signature move's flourish — the splat leaving Ketchup's nozzle, the coals
// roaring on The Grill's flare — is *not* part of the costume. It used to be,
// and that made it invisible for any Fighter with art of its own: the costume
// is gated on the manifest and the flourish went through the gate with it.
// The Grill is the case that matters. Flare-Up is a 16-frame wind-up, and the
// coals are the entire telegraph; without them a stock-ending launcher reads
// as instant.
//
// Deciding *whether* a flourish is showing is separate from drawing it, and is
// a pure function of a Fighter snapshot — that is the seam `test/brawl-art.js`
// tests. See `docs/glizzybrawl-art-brief.md`.

/**
 * Flourishes, keyed by the special's name in `brawl-sim.js`. `windup` is how
 * many attack frames the effect takes to reach full strength; take it from the
 * move's own startup so the telegraph and the hitbox it warns about agree.
 *
 * `layer` is "back" (behind the Fighter) or "front". Flames go behind: a
 * Fighter's face is the whole reason these sprites work at 64px.
 */
export const FLOURISHES = {
  splat: { windup: 6, layer: "front", draw: drawSplatBurst },
  flare: { windup: 16, layer: "back", draw: drawCoals },
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
 * Fighter, costumed or bespoke.
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
 * Fighter* — the blob in flight is a real projectile the renderer already
 * draws, and a second travelling blob here means the player cannot tell where
 * the shot actually is.
 */
function drawSplatBurst(ctx, { progress }) {
  const reach = 6 + progress * 12;
  ctx.globalAlpha = 1 - progress * 0.5;
  ctx.fillStyle = "#e11d48";
  for (let i = 0; i < 3; i++) {
    const t = (i + 1) / 3;
    ctx.beginPath();
    ctx.arc(14 + reach * t, -34 - i * 4 + progress * 5, 4 - i, 0, Math.PI * 2);
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

// ---------------------------------------------------------------- costumes
//
// Costume paths are drawn in the Fighter's local space: feet at (0, 0), head
// around y = -70, facing +x. The caller has already flipped the context for
// facing, so nothing here needs to know which way anyone is looking.
//
// Two rules, both learned by drawing it wrong first:
//   1. Costumes come in a BACK layer (behind the body) and a FRONT layer. A
//      bun cradling the Fighter has to be behind them, or it's a barrel.
//   2. Nothing covers the face. These bodies are worth borrowing *because*
//      they act — a costume that hides the face throws away the only thing
//      procedural drawing couldn't do. Hats sit above FACE_TOP; everything
//      else sits below FACE_BOTTOM.

export const FACE_TOP = -70;
export const FACE_BOTTOM = -40;
/** Where a hat's brim sits: on top of the hair, not hovering above it. */
const HAT_BASE = -62;

const COSTUMES = {
  glizzy: { back: bunBack, front: bunFront },
  ketchup: { back: capBack, front: bottleFront },
  grill: { back: lidBack, front: grateFront },
  corndog: { back: stickBack, front: batterFront },
};

/**
 * @param ctx     a 2D context, browser or node-canvas
 * @param fighter snapshot fields (character, attack, vx, vy, onGround, state)
 * @param nowMs   clock, for idle motion
 * @param layer   "back" (before the body sprite) or "front" (after)
 */
export function drawCostume(ctx, fighter, nowMs = 0, layer = "front") {
  const costume = COSTUMES[fighter.character];
  if (!costume || !costume[layer]) return;
  const swing = fighter.attack ? Math.min(1, (fighter.attack.frame + 1) / 6) : 0;
  // Costume geometry may still react to the special (Corn Dog's stick swings
  // down for its Pogo), but the signature-move *flourishes* have moved out to
  // `drawFlourish`, which runs for bespoke Fighters too.
  const move = moveNameOf(fighter.attack);
  const special = swing > 0 && !move.includes("light") && !move.includes("heavy");
  costume[layer](ctx, { swing, special, nowMs, fighter });
}

// ---- The Glizzy: a frank arcing behind the head, bun round the middle ----

function bunBack(ctx, { nowMs }) {
  const bob = Math.sin(nowMs / 420) * 1.5;
  ctx.fillStyle = "#c2410c";
  ctx.beginPath();
  ctx.ellipse(0, HAT_BASE + bob, 24, 15, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = "#facc15";
  ctx.lineWidth = 3;
  ctx.lineCap = "round";
  ctx.beginPath();
  for (let i = 0; i < 4; i++) {
    ctx.moveTo(-14 + i * 9, HAT_BASE - 7 + bob + (i % 2) * 4);
    ctx.lineTo(-9 + i * 9, HAT_BASE - 12 + bob - (i % 2) * 4);
  }
  ctx.stroke();
}

function bunFront(ctx) {
  // A bun band round the waist, well clear of the face.
  ctx.fillStyle = "#f4b860";
  roundRect(ctx, -20, -34, 40, 15, 7);
  ctx.fill();
  ctx.fillStyle = "rgba(180,120,40,0.3)";
  roundRect(ctx, -20, -27, 40, 3, 2);
  ctx.fill();
}

// ---- Ketchup: cap for a hat, bottle round the middle ----

function capBack(ctx, { nowMs }) {
  const bob = Math.sin(nowMs / 380) * 1.2;
  ctx.fillStyle = "#9f1239";
  roundRect(ctx, -13, HAT_BASE - 10 + bob, 26, 10, 4);
  ctx.fill();
  ctx.fillStyle = "#be123c";
  roundRect(ctx, -6, HAT_BASE - 17 + bob, 12, 8, 3);
  ctx.fill();
}

function bottleFront(ctx) {
  ctx.fillStyle = "#e11d48";
  roundRect(ctx, -17, -38, 34, 22, 8);
  ctx.fill();
  ctx.fillStyle = "#fecdd3";
  roundRect(ctx, -12, -33, 24, 9, 3);
  ctx.fill();
}

// ---- The Grill: lid for a hat, grate round the middle ----

function lidBack(ctx, { nowMs }) {
  const bob = Math.sin(nowMs / 500) * 1;
  ctx.fillStyle = "#1e293b";
  ctx.beginPath();
  ctx.ellipse(0, HAT_BASE - 5 + bob, 26, 13, 0, Math.PI, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = "#475569";
  roundRect(ctx, -26, HAT_BASE - 6 + bob, 52, 4, 2);
  ctx.fill();
  ctx.fillStyle = "#94a3b8";
  roundRect(ctx, -4, HAT_BASE - 17 + bob, 8, 7, 3);
  ctx.fill();
}

function grateFront(ctx) {
  ctx.fillStyle = "#334155";
  roundRect(ctx, -20, -36, 40, 19, 6);
  ctx.fill();
  ctx.fillStyle = "#a855f7";
  for (let i = 0; i < 4; i++) ctx.fillRect(-15 + i * 9, -33, 4, 13);
}

// ---- Corn Dog: batter round the middle, stick out the back ----

function stickBack(ctx, { swing, special }) {
  ctx.fillStyle = "#b45309";
  ctx.save();
  ctx.rotate(0.4 - (special ? swing : 0) * 1.0);
  roundRect(ctx, -8, -14, 7, 32, 3);
  ctx.fill();
  ctx.restore();
}

function batterFront(ctx, { nowMs }) {
  const bob = Math.sin(nowMs / 400) * 1.2;
  ctx.fillStyle = "#f59e0b";
  roundRect(ctx, -19, -40 + bob, 38, 25, 10);
  ctx.fill();
  ctx.fillStyle = "#fbbf24";
  roundRect(ctx, -13, -35 + bob, 26, 9, 4);
  ctx.fill();
  // Crumb texture, deterministic so it doesn't crawl between frames.
  ctx.fillStyle = "rgba(120,53,15,0.35)";
  for (let i = 0; i < 7; i++) {
    ctx.fillRect(-15 + ((i * 37) % 30), -37 + bob + ((i * 23) % 18), 2, 2);
  }
}

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
  const y = HAT_BASE - 24;
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
