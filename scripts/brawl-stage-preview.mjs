// Render the GlizzyBrawl Stage to a PNG so the Ballpark can be judged without
// opening a browser — and check that Fighters still read against it.
//
//   node scripts/brawl-stage-preview.mjs [out.png]
//   node scripts/brawl-stage-preview.mjs --fighters     also composite the roster
//   node scripts/brawl-stage-preview.mjs --slot         outline the scoreboard's
//                                                       empty data slot
//   node scripts/brawl-stage-preview.mjs --baseline     ignore art, measure the
//                                                       placeholder Stage
//
// It runs the same `brawl-stage.js` the page does, so what you see here is what
// the Arena draws. That is not decoration: the Ballpark is composed from props
// rather than painted as one image, so layout gets *iterated*, and iterating
// through a live WebSocket game page is miserable. The repo has already learned
// that a preview which disagrees with the Arena is worse than none.
//
// The gate here is silhouette contrast. "Night game, crowd behind the fight" is
// precisely the composition where sprites get lost, and the crowd is generated
// blind to the Fighters — so this composites each Fighter's `stand` over the
// backdrop at all eight spawn points and measures how far the sprite's edge
// sits from what is behind it. Non-zero exit on failure.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { STAGE } from "../brawl-sim.js";
import { CHARACTERS, SPRITE } from "../brawl-art.js";
import { STAGE_ART, buildScene, drawStage, planScene } from "../brawl-stage.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "assets", "brawl");

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const OUT = argv.find((a) => !a.startsWith("--")) || path.join(ROOT, "brawl-stage.png");

/**
 * The floor a Fighter's silhouette must clear, in mean luminance delta (0-255).
 *
 * Derived, not invented: `--baseline` measures the placeholder Stage — a flat
 * gradient behind a Fighter, which is known-readable because it is what the
 * Arena shipped on — and this sits below that score. If bespoke art reads worse
 * than a flat gradient, that is a finding rather than a matter of taste.
 *
 * The placeholder scores a mean of 19.9 and a worst placement of 14.1 (Ketchup
 * over the sky at spawns 3 and 4). The floor is the worst case with a little
 * room, because the gate has to fire on *a* Fighter disappearing, not on the
 * roster's average. Re-run `--baseline` before changing it.
 */
const CONTRAST_FLOOR = 12;

// ------------------------------------------------------------------- the art

const art = new Map();
if (!flag("baseline")) {
  for (const name of STAGE_ART) {
    const file = path.join(ART_DIR, `${name}.png`);
    if (fs.existsSync(file)) art.set(name, await loadImage(file));
  }
}

const scene = buildScene(STAGE);
const plan = planScene(scene, (name) => art.has(name));
for (const entry of plan) {
  const label = entry.mode === "art" ? "art" : entry.mode === "primitive" ? "placeholder" : "sky";
  console.log(`  ${entry.id.padEnd(10)} ${label}${entry.missing.length ? `  (missing ${entry.missing.join(", ")})` : ""}`);
}

const canvas = createCanvas(STAGE.width, STAGE.height);
const ctx = canvas.getContext("2d");
drawStage(ctx, scene, art);
const backdrop = ctx.getImageData(0, 0, STAGE.width, STAGE.height).data;

// ------------------------------------------------------ silhouette contrast

const luminance = (d, i) => 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];

/**
 * How far a sprite's own edge sits from what is behind it, at one position.
 *
 * Only *edge* pixels count. A Fighter's interior can happily match the crowd's
 * average brightness — what separates a sprite from a backdrop is its outline
 * against the pixels immediately beyond it, which is exactly what gets eaten by
 * a busy band of silhouettes at the same luminance.
 */
function silhouetteDelta(sprite, x, y) {
  const { width: w, height: h } = sprite.canvas;
  const d = sprite.data;
  const alphaAt = (px, py) =>
    px < 0 || py < 0 || px >= w || py >= h ? 0 : d[(py * w + px) * 4 + 3];

  let total = 0;
  let count = 0;
  for (let py = 0; py < h; py++) {
    for (let px = 0; px < w; px++) {
      const i = (py * w + px) * 4;
      if (d[i + 3] < 128) continue;
      const isEdge =
        alphaAt(px - 1, py) < 128 || alphaAt(px + 1, py) < 128 ||
        alphaAt(px, py - 1) < 128 || alphaAt(px, py + 1) < 128;
      if (!isEdge) continue;
      const cx = x + px;
      const cy = y + py;
      if (cx < 0 || cy < 0 || cx >= STAGE.width || cy >= STAGE.height) continue;
      const b = (cy * STAGE.width + cx) * 4;
      total += Math.abs(luminance(d, i) - luminance(backdrop, b));
      count += 1;
    }
  }
  return count ? total / count : 0;
}

/** A Fighter's `stand`, rasterised at exactly the size the Arena draws it. */
async function standSprite(character) {
  const img = await loadImage(path.join(ART_DIR, `${character}_stand.png`));
  const h = SPRITE.drawHeight;
  const w = Math.round((img.width / img.height) * h);
  const c = createCanvas(w, h);
  const cx = c.getContext("2d");
  cx.imageSmoothingEnabled = false;
  cx.drawImage(img, 0, 0, w, h);
  return { canvas: c, data: cx.getImageData(0, 0, w, h).data, width: w, height: h };
}

const results = [];
for (const character of CHARACTERS) {
  const sprite = await standSprite(character);
  for (let s = 0; s < STAGE.spawns.length; s++) {
    const spawn = STAGE.spawns[s];
    const x = Math.round(spawn.x - sprite.width / 2);
    const y = Math.round(spawn.y - sprite.height);
    results.push({ character, spawn: s, delta: silhouetteDelta(sprite, x, y) });
  }
  if (flag("fighters")) {
    for (const spawn of STAGE.spawns) {
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(sprite.canvas, Math.round(spawn.x - sprite.width / 2), Math.round(spawn.y - sprite.height));
    }
  }
}

// The scoreboard's data slot is a claim about the *art* — that the board
// carries a flat empty panel there, high and dark, ready for a Day Tally that
// v1 doesn't draw. Nothing else reads `scene.slot` until that wiring exists, so
// this is how the claim gets checked: outline it and see whether it lands on
// the panel or on a girder.
if (flag("slot")) {
  const s = scene.slot;
  ctx.strokeStyle = "#ff6b35";
  ctx.lineWidth = 1;
  ctx.strokeRect(s.x + 0.5, s.y + 0.5, s.width - 1, s.height - 1);
  console.log(`slot outlined at ${s.x},${s.y} ${s.width}x${s.height}`);
}

fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
console.log("wrote", path.relative(ROOT, OUT));

results.sort((a, b) => a.delta - b.delta);
const worst = results.slice(0, 5);
const mean = results.reduce((s, r) => s + r.delta, 0) / results.length;
console.log(`\nsilhouette contrast — mean ${mean.toFixed(1)}, floor ${CONTRAST_FLOOR}`);
for (const r of worst) {
  console.log(`  ${r.delta < CONTRAST_FLOOR ? "FAIL" : "ok  "} ${r.character} @ spawn ${r.spawn}: ${r.delta.toFixed(1)}`);
}

if (flag("baseline")) {
  console.log("\nbaseline run — the placeholder Stage is known-readable, so this is the number");
  console.log("CONTRAST_FLOOR is derived from. Nothing fails a baseline.");
  process.exit(0);
}

const failed = results.filter((r) => r.delta < CONTRAST_FLOOR);
if (failed.length) {
  console.error(`\n${failed.length} of ${results.length} placements read below the floor.`);
  console.error("A Fighter that vanishes into the crowd is the failure this Stage is most prone to.");
  process.exit(1);
}
console.log("every Fighter reads against the Ballpark at every spawn.");
