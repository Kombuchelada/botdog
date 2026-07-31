// Import bespoke Fighter art into GlizzyBrawl.
//
//   node scripts/brawl-import-sprites.mjs <fighter> <root/> --clip walk=walk-v3 ...
//   node scripts/brawl-import-sprites.mjs <fighter> <root/>          (clip-per-subfolder)
//   node scripts/brawl-import-sprites.mjs --list
//
// <fighter> is one of: glizzy, ketchup, grill, corndog.
//
// A Fighter's actions are animated, so what gets imported is a **clip** per
// action, not a pose per action. Each clip is written out as
// `<fighter>_<clip>_<n>.png` and the renderer plays it — see `CLIPS` in
// `brawl-art.js`, which this script imports and enforces rather than writes.
//
// Art from an image generator never arrives game-ready: it has a background,
// inconsistent margins, whatever size the model felt like, and whatever frame
// count the animation job happened to produce. This does the boring part —
// knock out the background, resample each clip to its declared length, scale
// the whole set by one factor, and plant every frame's feet on the floor line.
//
// Sources. A clip's frames come from a folder of numbered PNGs (`0.png`,
// `1.png`, …) or from a single image for a one-frame clip. A generator names
// those folders after the animation job, not after the game's action, so:
//
//   --clip action1=jab-v3        take every frame of jab-v3/
//   --clip jump=jump:1-4         take frames 1 through 4 of jump/
//   --clip stand=reference.png   a single image
//
// Options:
//   --clip name=path[:a-b]   where a clip's frames come from (repeatable)
//   --bg "#ffffff"   background colour to remove (default: sampled from corners)
//   --tolerance 40   how close a pixel must be to count as background (0-255)
//   --keep-bg        don't remove any background (art already has alpha)
//   --frame-width N  the per-Fighter apparent-size dial (see below)
//   --dry-run        report what it would write, write nothing

import { createCanvas, loadImage } from "@napi-rs/canvas";
import { contentBounds, removeBackground, toCanvas } from "./lib/pixel-art.mjs";
import { CLIPS, clipInfo } from "../brawl-art.js";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ART_DIR = path.join(ROOT, "assets", "brawl");
const MANIFEST = path.join(ART_DIR, "manifest.json");

const FIGHTERS = ["glizzy", "ketchup", "grill", "corndog"];

/**
 * How each clip picks its frames out of a source run. Which frames matter is a
 * property of the *action*, not of the animation job, and a flat "take every
 * Nth" gets all three of these wrong:
 *
 *   loop   a cycle, so the last frame must not duplicate the first — including
 *          both makes a Fighter stutter once per stride.
 *   span   plays start to end, evenly.
 *   peak   built around its most extreme frame: `brawl-art.js` says which index
 *          of the clip that must be, and the importer lands it there. A punch
 *          reaches contact where the renderer expects to hold it, and a duck
 *          reaches its lowest frame at the end and stays there.
 *
 * The peak itself is measured, never assumed. Some of these animations peak
 * halfway and recover; some peak on their very last frame and have no recovery
 * at all (Corn Dog's stick thrust) — which is why `peak` can walk back through
 * its own wind-up when the source gives it nothing to walk back through.
 */
const STRATEGY = {
  stand: { kind: "span" },
  walk: { kind: "loop" },
  jump: { kind: "span" },
  fall: { kind: "span" },
  hurt: { kind: "span" },
  // Compress into the most compressed frame and hold it: a duck is a pose you
  // are *in*, and one that reaches its lowest point as it ends never reads.
  duck: { kind: "peak", measure: "shortest", land: "last" },
  action1: { kind: "peak", measure: "largest", land: "contact" },
  kick: { kind: "peak", measure: "largest", land: "contact" },
  action2: { kind: "peak", measure: "largest", land: "contact" },
};

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
const VALUE_FLAGS = new Set(["bg", "tolerance", "frame-width"]);

const flags = {};
const clipArgs = [];
const positional = [];
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (!arg.startsWith("--")) {
    positional.push(arg);
    continue;
  }
  const name = arg.slice(2);
  if (name === "clip") clipArgs.push(argv[++i]);
  else if (VALUE_FLAGS.has(name)) flags[name] = argv[++i];
  else flags[name] = true;
}
const flag = (name, fallback = null) => (name in flags ? flags[name] : fallback);
const has = (name) => flags[name] === true;

if (has("list")) {
  console.log("Fighters:", FIGHTERS.join(", "));
  console.log("Frame:   ", `${FRAME.width}x${FRAME.height}`);
  console.log("Clips:");
  for (const [name, spec] of Object.entries(CLIPS)) {
    const contact = Number.isFinite(spec.contact) ? `, contact ${spec.contact}` : "";
    console.log(`   ${name.padEnd(8)} ${spec.frames} frame${spec.frames === 1 ? "" : "s"}${contact}`);
  }
  process.exit(0);
}

const [fighter, source] = positional;
if (!fighter || !source) {
  console.error("usage: brawl-import-sprites.mjs <fighter> <root/> [--clip name=path[:a-b]]");
  process.exit(1);
}
if (!FIGHTERS.includes(fighter)) {
  console.error(`unknown fighter "${fighter}" — expected one of ${FIGHTERS.join(", ")}`);
  process.exit(1);
}

const tolerance = Number(flag("tolerance", 40));
const dryRun = has("dry-run");

/** `name=path:a-b` -> { clip, dir, from, to }. Defaults to a subfolder per clip. */
const sources = new Map();
for (const clip of Object.keys(CLIPS)) sources.set(clip, { path: clip, from: null, to: null });
for (const spec of clipArgs) {
  const eq = String(spec || "").indexOf("=");
  if (eq < 0) {
    console.error(`--clip expects name=path, got "${spec}"`);
    process.exit(1);
  }
  const clip = spec.slice(0, eq).trim();
  if (!CLIPS[clip]) {
    console.error(`unknown clip "${clip}" — brawl-art.js declares ${Object.keys(CLIPS).join(", ")}`);
    process.exit(1);
  }
  const rest = spec.slice(eq + 1).trim();
  const range = rest.match(/^(.*):(\d+)-(\d+)$/);
  sources.set(clip, range
    ? { path: range[1], from: Number(range[2]), to: Number(range[3]) }
    : { path: rest, from: null, to: null });
}

// The manifest is read here, not just written at the end, because a Fighter's
// frame width is part of its import and has to survive the *next* one. Without
// that, re-importing Corn Dog to swap a single clip would silently shrink it
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
 * Both halves matter, and "every frame" now means every frame of every clip,
 * not every pose. A per-frame scale would blow each drawing up to fill the
 * frame, so a duck would come out as tall as a stand and a wind-up as big as
 * the punch it leads to — the clip would pump. And feet-on-floor beats
 * centring: frames sitting at different heights make a Fighter bob for no
 * reason while running.
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

const IMAGE_EXT = [".png", ".webp", ".jpg", ".jpeg"];

/** Every frame a source offers, in numeric order. A file is a one-frame clip. */
async function readSource(root, spec, clip) {
  const candidates = [
    path.join(root, spec.path),
    ...IMAGE_EXT.map((ext) => path.join(root, spec.path + ext)),
  ];
  const hit = candidates.find((p) => fs.existsSync(p));
  if (!hit) return null;

  if (!fs.statSync(hit).isDirectory()) return [toCanvas(await loadImage(hit))];

  const files = fs
    .readdirSync(hit)
    .filter((f) => IMAGE_EXT.includes(path.extname(f).toLowerCase()))
    .map((f) => ({ f, n: Number(path.basename(f, path.extname(f))) }))
    .filter((e) => Number.isFinite(e.n))
    .sort((a, b) => a.n - b.n);
  if (!files.length) {
    console.warn(`  ! ${clip}: ${spec.path}/ holds no numbered frames`);
    return null;
  }

  const from = Number.isFinite(spec.from) ? spec.from : files[0].n;
  const to = Number.isFinite(spec.to) ? spec.to : files[files.length - 1].n;
  const picked = files.filter((e) => e.n >= from && e.n <= to);
  if (!picked.length) {
    console.warn(`  ! ${clip}: ${spec.path}/ has no frames in ${from}-${to}`);
    return null;
  }
  return Promise.all(picked.map((e) => loadImage(path.join(hit, e.f)).then((img) => toCanvas(img))));
}

/**
 * The most extreme frame of a source run, and by how much.
 *
 * `largest` is silhouette AREA, not width: Corn Dog's Pogo is a downward stab
 * and The Grill's Flare-Up rears its lid upward, so an attack's extension is
 * not reliably horizontal. `shortest` is height, which is the whole question a
 * duck asks. Both measure the cleaned source, before the importer plants every
 * frame on the floor line and throws the vertical away.
 */
function extremeFrame(canvases, measure) {
  const score = (c) => {
    const b = contentBounds(c);
    return measure === "shortest" ? -b.height : b.width * b.height;
  };
  let best = 0;
  let bestScore = -Infinity;
  const scores = canvases.map((c) => (c ? score(c) : -Infinity));
  for (let i = 0; i < scores.length; i++) {
    if (scores[i] > bestScore) {
      bestScore = scores[i];
      best = i;
    }
  }
  return { index: best, score: bestScore, first: scores[0] };
}

/**
 * Build a clip of exactly `count` frames out of whatever the generator produced
 * — 4 frames, 5, 7, 9 — using the action's strategy.
 *
 * For a `peak` clip the extreme frame is placed at `land` and everything else
 * is sampled around it: the wind-up spread across the frames before it, and the
 * recovery across the frames after. When the source has nothing after its peak
 * the recovery walks back through the wind-up instead, which costs no art and
 * still gives the snap-back — holding a fully extended punch through the whole
 * endlag reads as the game having frozen.
 */
function buildClip(frames, count, strategy) {
  const S = frames.length;
  if (S <= 1 || count <= 1) return Array.from({ length: Math.max(1, count) }, () => frames[0]);
  const pick = (n) => frames[Math.min(S - 1, Math.max(0, Math.round(n)))];

  if (strategy.kind === "loop") {
    return Array.from({ length: count }, (_, i) => pick(Math.floor((i * S) / count)));
  }
  if (strategy.kind !== "peak") {
    return Array.from({ length: count }, (_, i) => pick((i * (S - 1)) / (count - 1)));
  }

  const { index: peak } = extremeFrame(frames, strategy.measure);
  const land = strategy.land === "last" ? count - 1 : strategy.contact;
  const out = [];
  for (let i = 0; i < count; i++) {
    if (i < land) out.push(pick(land > 0 ? (i * peak) / land : 0));
    else if (i === land) out.push(frames[peak]);
    else if (peak < S - 1) out.push(pick(peak + ((i - land) * (S - 1 - peak)) / (count - 1 - land)));
    else out.push(pick(peak * (1 - (i - land) / (count - land))));
  }
  return out;
}

// ------------------------------------------------------------------- main

if (!fs.statSync(source).isDirectory()) {
  console.error(`${source} is not a folder — a clip import reads one source per clip from a root folder`);
  process.exit(1);
}

// Read, clean and build every clip, then fit the whole set together so one
// scale factor covers the Fighter. Clips are kept as runs so the gate below can
// talk about "frame 2 of action1" rather than an index into a flat list.
const clips = [];
const failures = [];
for (const [clip, spec] of sources) {
  const { frames: want, contact } = clipInfo(fighter, clip);
  const raw = await readSource(source, spec, clip);
  if (!raw) {
    console.warn(`  ! no source for "${clip}" — the renderer will fall back to stand`);
    continue;
  }
  if (raw.length < want) {
    console.warn(`  ! ${clip}: ${raw.length} source frame(s) for a ${want}-frame clip — frames will repeat`);
  }
  const cleaned = raw.map((f) => (has("keep-bg") ? f : removeBackground(f, flag("bg"), tolerance)));
  const strategy = { ...(STRATEGY[clip] || { kind: "span" }), contact };

  // The extension gate. An attack whose most extended frame is its FIRST has no
  // attack in it at all: the clip is backwards, or the animation job came back
  // dead — which is exactly what the humanoid templates kept doing to these
  // stub-limbed Fighters, and what a visual check kept passing. There is
  // nothing to place at `contact`, so the wind-up, the hitbox and the recovery
  // all draw the same picture and the move reads as the game ignoring you.
  if (strategy.kind === "peak" && want > 1 && cleaned.length > 1) {
    const { index, score, first } = extremeFrame(cleaned, strategy.measure);
    if (index === 0 || score <= first) {
      failures.push(
        `  ${fighter} ${clip}: the source's most extreme frame is its first, so the\n` +
        `    clip has no ${strategy.measure === "shortest" ? "compression" : "extension"} to build around.\n` +
        `    Re-pick the source range, or regenerate the animation — see docs/glizzybrawl-art-brief.md.`,
      );
    }
  }

  clips.push({ clip, frames: buildClip(cleaned, want, strategy) });
}

if (failures.length) {
  console.error("art gate failed:\n");
  console.error(failures.join("\n\n"));
  process.exit(1);
}

const flat = clips.flatMap((c) => c.frames);
const fitted = fitAll(flat);

const written = [];
let cursor = 0;
for (const { clip, frames } of clips) {
  for (let i = 0; i < frames.length; i++) {
    const file = path.join(ART_DIR, `${fighter}_${clip}_${i}.png`);
    if (!dryRun) fs.writeFileSync(file, fitted[cursor + i].toBuffer("image/png"));
    written.push(path.relative(ROOT, file));
  }
  cursor += frames.length;
}

// The manifest carries frame geometry only. Clip lengths deliberately do NOT
// live here — they are in `CLIPS` in `brawl-art.js`, where the browser can read
// them without a fetch and where they are gated above rather than generated.
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
for (const { clip, frames } of clips) console.log(`  ${clip.padEnd(8)} ${frames.length} frames`);
console.log(`${fighter} now animates these clips in the Arena.`);
