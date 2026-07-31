// Measure generated Fighter frames so keyframes are picked by number, not by eye.
//
//   node scripts/brawl-art-measure.mjs <folder>
//
// The folder is a working folder of raw PixelLab output: `stand.png` at the top
// level, and one subfolder per animation holding numbered frames (`0.png`, …),
// which is exactly what `pixellab/fetch.sh` produces.
//
// Every art defect found converting The Glizzy passed a visual check and failed
// a measurement, so the thresholds in the art brief are the gate:
//
//   crouch   height <= 75% of standing height
//   attack   reaches >= 15px beyond the standing bounding box
//   hurt     lifts >= 3px off the floor line
//
// The hurt threshold is 3px rather than "any lift at all" because a
// `taking-punch` template that visibly does nothing still drifts a pixel, and
// passing that is worse than having no threshold.
//
// The pose a subfolder is judged as comes from its name (duck / hurt / jab,
// kick, pogo, action, bite, splat, flare). Anything else is reported without a
// verdict, since a walk or a jump has no threshold to fail.
//
// Measurement is on the **alpha bounding box**, computed here. `sharp.trim()`
// keys off the top-left pixel and returns the full canvas on transparent art,
// which is how a "crouch" at 89% of standing height passed review once.

import { readdir } from "node:fs/promises";
import fs from "node:fs";
import path from "node:path";
import sharp from "sharp";

const CROUCH_MAX_RATIO = 0.75;
const ATTACK_MIN_EXTENSION = 15;
const HURT_MIN_LIFT = 3;

const root = process.argv[2];
if (!root) {
  console.error("usage: node scripts/brawl-art-measure.mjs <folder>");
  process.exit(1);
}

/** Tight bounding box of everything with any alpha at all. */
async function bbox(file) {
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let x0 = info.width, y0 = info.height, x1 = -1, y1 = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      if (data[(y * info.width + x) * info.channels + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) return null;
  return { x0, y0, x1, y1, width: x1 - x0 + 1, height: y1 - y0 + 1, canvas: info.width };
}

function poseKindOf(name) {
  const n = name.toLowerCase();
  if (n.includes("duck") || n.includes("crouch")) return "crouch";
  if (n.includes("hurt") || n.includes("punch")) return "hurt";
  if (/jab|kick|pogo|action|bite|splat|flare|attack/.test(n)) return "attack";
  return null;
}

const standFile = path.join(root, "stand.png");
if (!fs.existsSync(standFile)) {
  console.error(`no stand.png in ${root} — it is the baseline everything is measured against`);
  process.exit(1);
}
const stand = await bbox(standFile);
console.log(`stand: ${stand.width}x${stand.height}px, floor line y=${stand.y1}\n`);

const dirs = (await readdir(root, { withFileTypes: true }))
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

for (const dir of dirs) {
  const kind = poseKindOf(dir);
  const files = (await readdir(path.join(root, dir)))
    .filter((f) => /^\d+\.png$/.test(f))
    .sort((a, b) => parseInt(a) - parseInt(b));
  if (!files.length) continue;

  console.log(`${dir}${kind ? ` [${kind}]` : ""}`);
  for (const f of files) {
    const b = await bbox(path.join(root, dir, f));
    if (!b) {
      console.log(`  ${f.padEnd(7)} empty frame`);
      continue;
    }
    // Extension is how far past the standing silhouette the frame reaches, on
    // either side: art faces south-east but a kick can throw a leg backwards.
    const extend = Math.max(stand.x0 - b.x0, b.x1 - stand.x1);
    const lift = stand.y1 - b.y1;
    const ratio = b.height / stand.height;

    let verdict = "";
    if (kind === "crouch") verdict = ratio <= CROUCH_MAX_RATIO ? "PASS" : "fail";
    if (kind === "attack") verdict = extend >= ATTACK_MIN_EXTENSION ? "PASS" : "fail";
    if (kind === "hurt") verdict = lift >= HURT_MIN_LIFT ? "PASS" : "fail";

    console.log(
      `  ${f.padEnd(7)} ${String(b.width).padStart(3)}x${String(b.height).padStart(3)}` +
        `  height ${(ratio * 100).toFixed(0).padStart(3)}%` +
        `  extend ${(extend >= 0 ? "+" : "") + extend}px`.padEnd(15) +
        `  lift ${lift}px`.padEnd(12) +
        (verdict && `  ${verdict}`),
    );
  }
  console.log("");
}
