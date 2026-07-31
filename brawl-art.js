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
  const bodies = [...CHARACTERS, CPU_BODY];
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
