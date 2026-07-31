// Import bespoke Fighter art into GlizzyBrawl.
//
//   node scripts/brawl-import-sprites.mjs <fighter> <sheet.png> --grid 5x2
//   node scripts/brawl-import-sprites.mjs <fighter> <folder-of-poses/>
//   node scripts/brawl-import-sprites.mjs --list
//
// <fighter> is one of: glizzy, ketchup, grill, corndog.
//
// Art from an image generator never arrives game-ready: it has a background,
// inconsistent margins, and whatever size the model felt like. This does the
// boring part — knock out the background, trim, scale to the Arena's frame,
// and plant the feet on the floor line — then writes the per-pose PNGs the
// renderer expects, and records any frame-width override in the manifest.
//
// Options:
//   --grid CxR       slice a sheet into C columns by R rows, read left-to-right
//   --bg "#ffffff"   background colour to remove (default: sampled from corners)
//   --tolerance 40   how close a pixel must be to count as background (0-255)
//   --keep-bg        don't remove any background (art already has alpha)
//   --poses a,b,c    override the pose order used when slicing a sheet
//   --dry-run        report what it would write, write nothing

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { contentBounds, removeBackground, toCanvas } from "./lib/pixel-art.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "assets", "brawl");
const MANIFEST = path.join(ART_DIR, "manifest.json");

const FIGHTERS = ["glizzy", "ketchup", "grill", "corndog"];

/** The poses the renderer asks for, in the order a sheet is read. */
export const POSES = [
  "stand", "walk1", "walk2", "jump", "fall",
  "duck", "hurt", "action1", "kick", "action2",
];

/**
 * Frame the Arena draws. Art is scaled to fit this, feet on the bottom edge.
 *
 * The renderer normalises every sprite to `SPRITE.drawHeight` and takes the
 * aspect from the image, so how BIG a Fighter looks is the fraction of the frame
 * height its art fills — not the frame's dimensions. That makes the width
 * deliberately generous: the scale is shared across the set, so a wide pose (a
 * fully extended punch) would otherwise pin the whole Fighter small and leave
 * vertical padding. Wide frame => height is the binding constraint => the
 * character fills the frame and draws at the same size as the Kenney bodies.
 */
const FRAME = { width: 110, height: 110, floorMargin: 3 };
const DEFAULT_FRAME_WIDTH = FRAME.width;

// ------------------------------------------------------------------- args

const argv = process.argv.slice(2);
const VALUE_FLAGS = new Set(["grid", "bg", "tolerance", "poses", "frame-width"]);

const flags = {};
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
  else flags[name] = true;
}
const flag = (name, fallback = null) => (name in flags ? flags[name] : fallback);
const has = (name) => flags[name] === true;

if (has("list")) {
  console.log("Fighters:", FIGHTERS.join(", "));
  console.log("Poses:   ", POSES.join(", "));
  console.log("Frame:   ", `${FRAME.width}x${FRAME.height}`);
  process.exit(0);
}

const [fighter, source] = positional;
if (!fighter || !source) {
  console.error("usage: brawl-import-sprites.mjs <fighter> <sheet.png|folder/> [--grid CxR]");
  process.exit(1);
}
if (!FIGHTERS.includes(fighter)) {
  console.error(`unknown fighter "${fighter}" — expected one of ${FIGHTERS.join(", ")}`);
  process.exit(1);
}

const poses = String(flag("poses", POSES.join(","))).split(",").map((p) => p.trim());
const tolerance = Number(flag("tolerance", 40));
const dryRun = has("dry-run");

// The manifest is read here, not just written at the end, because a Fighter's
// frame width is part of its import and has to survive the *next* one. Without
// that, re-importing Corn Dog to swap a single pose would silently shrink it
// back to the roster default.
let manifest = { frame: { ...FRAME } };
if (fs.existsSync(MANIFEST)) {
  try {
    manifest = { ...manifest, ...JSON.parse(fs.readFileSync(MANIFEST, "utf8")) };
  } catch {
    console.warn("manifest.json was unreadable; rewriting it");
  }
}

// `--frame-width` is the per-Fighter size dial, and the reason it exists is
// Corn Dog: its light attack is a stick thrust reaching 20px past the standing
// silhouette, so the shared scale factor was set by *that* frame and the whole
// Fighter came out visibly smaller than the rest of the roster. Widening the
// frame lets the widest pose fit without shrinking the set, so height goes back
// to being the binding constraint. Retuning size is a re-import; it is never a
// reason to regenerate art.
// Narrowing is as legitimate as widening — it is how The Grill ends up the
// shortest Fighter on the roster and Corn Dog the tallest.
const storedWidth = manifest.frames && manifest.frames[fighter] && manifest.frames[fighter].width;
if ("frame-width" in flags) {
  const n = Number(flag("frame-width"));
  if (!Number.isFinite(n) || n < 40 || n > 400) {
    console.error("--frame-width must be a number between 40 and 400");
    process.exit(1);
  }
  FRAME.width = n;
} else if (Number.isFinite(storedWidth)) {
  FRAME.width = storedWidth;
  console.log(`using ${fighter}'s recorded frame width of ${storedWidth}px`);
}

// -------------------------------------------------------------- image ops
//
// De-background, measure, cut. All three are shared with the Stage importer in
// `lib/pixel-art.mjs`; a Fighter and a floodlight tower arrive from a generator
// with exactly the same problems.

/**
 * Horizontal centre of the feet: the middle of the bottom slice of content.
 *
 * Centring a frame on its whole bounding box makes a Fighter slide sideways
 * whenever an arm extends — the box moves, so the body moves. The feet don't
 * lie.
 */
function feetCentre(canvas, bounds) {
  const { width: w } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, w, canvas.height).data;
  const from = Math.max(bounds.y1, bounds.y2 - Math.max(2, Math.round(bounds.height * 0.25)));
  let min = Infinity;
  let max = -Infinity;
  for (let y = from; y <= bounds.y2; y++) {
    for (let x = bounds.x1; x <= bounds.x2; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue;
      if (x < min) min = x;
      if (x > max) max = x;
    }
  }
  if (max < 0) return (bounds.x1 + bounds.x2) / 2;
  return (min + max) / 2;
}

/**
 * Scale every frame by the SAME factor and stand each on the floor line.
 *
 * Both halves matter. A per-frame scale would blow each pose up to fill the
 * frame, so a duck would come out as tall as a stand and the poses would stop
 * meaning anything. And feet-on-floor beats centring: frames sitting at
 * different heights make a Fighter bob for no reason while running.
 */
function fitAll(canvases) {
  const boundsList = canvases.map((c) => (c ? contentBounds(c) : null));
  const usableH = FRAME.height - FRAME.floorMargin;
  const tallest = Math.max(...boundsList.filter(Boolean).map((b) => b.height), 1);
  const widest = Math.max(...boundsList.filter(Boolean).map((b) => b.width), 1);
  const scale = Math.min(FRAME.width / widest, usableH / tallest);

  return canvases.map((canvas, i) => {
    const out = createCanvas(FRAME.width, FRAME.height);
    const ctx = out.getContext("2d");
    const bounds = boundsList[i];
    if (!canvas || !bounds) return out;

    const w = Math.max(1, Math.round(bounds.width * scale));
    const h = Math.max(1, Math.round(bounds.height * scale));
    const feet = feetCentre(canvas, bounds);
    const dx = Math.round(FRAME.width / 2 - (feet - bounds.x1) * scale);

    // Nearest-neighbour: pixel art must not be smoothed into mush on the way in.
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      canvas,
      bounds.x1, bounds.y1, bounds.width, bounds.height,
      dx, usableH - h, w, h,
    );
    return out;
  });
}

// ---------------------------------------------------------------- sources

async function framesFromSheet(file, grid) {
  const [cols, rows] = String(grid).split("x").map(Number);
  if (!cols || !rows) throw new Error(`--grid expects CxR, got "${grid}"`);
  const img = await loadImage(file);
  const cw = Math.floor(img.width / cols);
  const ch = Math.floor(img.height / rows);
  const frames = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      frames.push(toCanvas(img, c * cw, r * ch, cw, ch));
    }
  }
  return frames;
}

async function framesFromFolder(dir) {
  const out = [];
  for (const pose of poses) {
    // Accept both `stand.png` and `glizzy_stand.png` — generators and the
    // repo's own prototype set name files differently, and neither is wrong.
    const names = [pose, `${fighter}_${pose}`];
    const hit = names
      .flatMap((name) => ["png", "webp", "jpg", "jpeg"].map((ext) => path.join(dir, `${name}.${ext}`)))
      .find((p) => fs.existsSync(p));
    if (!hit) {
      console.warn(`  ! no image for "${pose}" — the renderer will fall back to stand`);
      out.push(null);
      continue;
    }
    out.push(toCanvas(await loadImage(hit)));
  }
  return out;
}

// ------------------------------------------------------------------- main

const stat = fs.statSync(source);
const frames = stat.isDirectory()
  ? await framesFromFolder(source)
  : await framesFromSheet(source, flag("grid", "5x2"));

if (!stat.isDirectory() && frames.length < poses.length) {
  console.warn(`sheet gave ${frames.length} cells for ${poses.length} poses — later poses will be missing`);
}

const cleaned = frames
  .slice(0, poses.length)
  .map((frame) => (!frame ? null : has("keep-bg") ? frame : removeBackground(frame, flag("bg"), tolerance)));
const fitted = fitAll(cleaned);

const written = [];
for (let i = 0; i < poses.length; i++) {
  if (!cleaned[i]) continue;
  const file = path.join(ART_DIR, `${fighter}_${poses[i]}.png`);
  if (!dryRun) fs.writeFileSync(file, fitted[i].toBuffer("image/png"));
  written.push(path.relative(ROOT, file));
}

// The manifest carries frame geometry only. It used to carry a list of which
// Fighters had art of their own; every Fighter does now, so nothing reads one.
// `frame` is the roster default; a Fighter imported through a wider frame
// records that separately and reads it back on the next import, so retuning one
// Fighter neither resizes the next nor evaporates when the flag is left off.
if (FRAME.width === DEFAULT_FRAME_WIDTH) {
  manifest.frame = { ...FRAME, width: DEFAULT_FRAME_WIDTH };
  if (manifest.frames) delete manifest.frames[fighter];
} else {
  manifest.frames = { ...(manifest.frames || {}), [fighter]: { ...FRAME } };
}
if (!dryRun) fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + "\n");

console.log(`${dryRun ? "[dry run] would write" : "wrote"} ${written.length} frames for ${fighter}:`);
for (const f of written) console.log("  " + f);
console.log(`${fighter} now draws these frames in the Arena.`);
