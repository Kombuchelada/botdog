// GlizzyBrawl — Fighter art.
//
// The bodies are Kenney's CC0 "Platformer Characters 1" (see
// `assets/brawl/LICENSE-kenney.txt`): hand-drawn stand / walk / jump / fall /
// duck / hurt frames *plus* three real attack poses, which is the part that
// was never going to look right drawn procedurally. The costumes — bun, cap,
// grill lid, batter — are drawn on top in canvas so each Fighter still reads
// as the food it is.
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
export function allSprites() {
  const bodies = [...new Set([...Object.values(BODY), CPU_BODY])];
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

export function bodyFor(fighter) {
  return fighter.cpu ? CPU_BODY : BODY[fighter.character] || BODY.glizzy;
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
  // The signature-move flourishes (a splat leaving the nozzle, coals roaring)
  // belong to the special alone — firing them on every jab made all three
  // attacks look the same.
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

function bottleFront(ctx, { swing, special }) {
  ctx.fillStyle = "#e11d48";
  roundRect(ctx, -17, -38, 34, 22, 8);
  ctx.fill();
  ctx.fillStyle = "#fecdd3";
  roundRect(ctx, -12, -33, 24, 9, 3);
  ctx.fill();
  if (special) {
    ctx.fillStyle = "#e11d48";
    ctx.beginPath();
    ctx.arc(24 + swing * 16, -30, 4 + swing * 5, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---- The Grill: lid for a hat, grate round the middle, coals when it flares ----

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

function grateFront(ctx, { swing, special, nowMs }) {
  ctx.fillStyle = "#334155";
  roundRect(ctx, -20, -36, 40, 19, 6);
  ctx.fill();
  ctx.fillStyle = "#a855f7";
  for (let i = 0; i < 4; i++) ctx.fillRect(-15 + i * 9, -33, 4, 13);

  if (special) {
    ctx.globalAlpha = 0.7 + Math.sin(nowMs / 90) * 0.3;
    ctx.fillStyle = "#f97316";
    ctx.beginPath();
    ctx.moveTo(-14, -14);
    ctx.quadraticCurveTo(0, -34 - swing * 48, 14, -14);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = "#fde047";
    ctx.beginPath();
    ctx.moveTo(-7, -14);
    ctx.quadraticCurveTo(0, -26 - swing * 30, 7, -14);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = 1;
  }
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
