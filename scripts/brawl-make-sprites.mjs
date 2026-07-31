// Generate GlizzyBrawl's pixel-art Fighter sprites.
//
//   node scripts/brawl-make-sprites.mjs
//
// The art is authored here as ASCII rigs — one glyph per pixel, one letter per
// palette entry — and rendered to PNG sprite sheets in `assets/brawl/pixel/`.
// The game only ever loads the PNGs; this script is the source those PNGs are
// built from, kept in the repo so the art stays editable.
//
// Why rigs rather than whole frames: hand-authoring 4 Fighters × 9 poses of
// 32×32 pixels is thousands of glyphs. Instead each Fighter is a *body* plus
// small shared limb pieces, composed per pose at integer offsets — which is
// how sprites of this era were actually built, and means a pose change is four
// numbers rather than a redraw.
//
// Every Fighter here is the food itself. The previous attempt borrowed human
// bodies and painted food over them, and the overlay never sat right; at this
// resolution a hot dog can just be a hot dog.

import { createCanvas } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "assets", "brawl", "pixel");

// ------------------------------------------------------------------ palette

const PALETTE = {
  ".": null,            // transparent
  K: "#241318",         // outline, shared by everything so the roster reads as one set
  W: "#ffffff",
  E: "#241318",         // eye
  // bun
  B: "#f0b96b",
  b: "#c98a45",
  // frank
  F: "#d4482f",
  f: "#a32d20",
  // mustard / batter
  N: "#f6f2e8",         // glove / shoe highlight
  M: "#f7d038",
  m: "#d9a91c",
  // ketchup
  R: "#e0243d",
  r: "#a8122a",
  L: "#f6f2e8",         // label
  // grill
  G: "#4c5668",
  g: "#2f3644",
  P: "#a855f7",         // grill glow, plasma-family (never red/green)
  p: "#7e22ce",
  // corn dog
  C: "#eda033",
  c: "#b9761d",
  S: "#c98a45",         // stick
  // limbs
  H: "#3a2b31",         // glove / boot
  h: "#241318",
};

// --------------------------------------------------------------- the rigs
//
// Bodies face right. `anchor` is the pixel the limbs hang from, measured from
// the top-left of the body art.

const BODIES = {
  // 16 wide. The anchor is the bottom-centre of the body: limbs hang off it,
  // so a body can change height without every pose needing new numbers.
  glizzy: {
    art: [
      "....KKKKKKKK....",
      "..KKffffffffKK..",
      ".KfFFFFFFFFFFfK.",
      "KfFFFFFFFFFFFFfK",
      "KFMFFMFFMFFMFFFK",
      "KFFMFFMFFMFFMFFK",
      "KFFFFFFFFFFFFFFK",
      "KFEEFFFFFFEEFFFK",
      "KFEEFFFFFFEEFFFK",
      "KFFFFFWWWWFFFFFK",
      "KfFFFFFFFFFFFFfK",
      ".KBBbbbbbbbbBBK.",
      "KBBBBBBBBBBBBBBK",
      "KBBBBBBBBBBBBBBK",
      "KbbbbbbbbbbbbbbK",
      "..KKKKKKKKKKKK..",
    ],
  },
  ketchup: {
    art: [
      "......KKKK......",
      "......KrrK......",
      "......KRRK......",
      ".....KKRRKK.....",
      "....KKRRRRKK....",
      "...KRRRRRRRRK...",
      "..KRRRRRRRRRRK..",
      ".KRREERRRREERRK.",
      ".KRREERRRREERRK.",
      ".KRRRRWWWWRRRRK.",
      ".KRRRRRRRRRRRRK.",
      ".KLLLLLLLLLLLLK.",
      ".KLLLLLLLLLLLLK.",
      ".KRRRRRRRRRRRRK.",
      ".KrrrrrrrrrrrrK.",
      "..KKKKKKKKKKKK..",
    ],
  },
  grill: {
    art: [
      "...KKKKKKKKKK...",
      "..KggggggggggK..",
      ".KGGGGGGGGGGGGK.",
      "KGGGGGGGGGGGGGGK",
      "KGGEEGGGGEEGGGGK",
      "KGGEEGGGGEEGGGGK",
      "KGGGGGWWWWGGGGGK",
      "KGGGGGGGGGGGGGGK",
      "KgggggggggggggGK",
      "KPpPpPpPpPpPpPGK",
      "KgggggggggggggGK",
      "KGGGGGGGGGGGGGGK",
      "KGGGGGGGGGGGGGGK",
      ".KGGGGGGGGGGGGK.",
      "..KggggggggggK..",
      "...KKKKKKKKKK...",
    ],
  },
  corndog: {
    art: [
      ".......KK.......",
      ".......KSK......",
      ".......KSK......",
      "....KKKKSKKK....",
      "..KKCCCCCCCCKK..",
      ".KCCcCCCCCCcCCK.",
      "KCCCCCCCCCCCCCK.",
      "KCEECCCCEECCCCK.",
      "KCEECCCCEECCCCK.",
      "KCCCCWWWWCCCCCK.",
      "KCcCCCCCCCCcCCK.",
      "KCCCCCCCCCCCCCK.",
      "KCcCCCCCCCCcCCK.",
      ".KCCCCCCCCCCCK..",
      "..KKcccccccKK...",
      "....KKKKKKK.....",
    ],
  },
};

// Shared limbs. Chunky on purpose: a 1px-wide limb between two outline pixels
// reads as a speck at any zoom, so every limb carries at least two pixels of
// fill. Same set for every Fighter, which keeps the roster looking like one cast.
const ARM = [
  "KKKK",
  "KHHK",
  "KHHK",
  "KHHK",
  "KNNK",
  "KKKK",
];
const ARM_OUT = [
  "KKKKKKK",
  "KHHHHNK",
  "KHHHHNK",
  "KKKKKKK",
];
const LEG = [
  "KKKK",
  "KHHK",
  "KHHK",
  "KNNK",
  "KKKK",
];
const LEG_RUN = [
  "..KKKK",
  ".KHHK.",
  "KHHK..",
  "KNNK..",
  "KKKK..",
];

// -------------------------------------------------------------- the poses
//
// Offsets are from the body's bottom-centre anchor. Limbs overlap the body by
// a pixel or two — a limb that merely touches the outline looks detached.

const POSES = {
  stand: { dy: 0, arms: [[ARM, -9, -13], [ARM, 5, -13]], legs: [[LEG, -6, -6], [LEG, 2, -4]] },
  walk1: { dy: -1, arms: [[ARM, -9, -14], [ARM, 5, -12]], legs: [[LEG_RUN, -8, -4], [LEG, 3, -4]] },
  walk2: { dy: 0, arms: [[ARM, -9, -12], [ARM, 5, -14]], legs: [[LEG, -6, -4], [LEG_RUN, 1, -4]] },
  jump: { dy: -2, arms: [[ARM, -9, -17], [ARM, 5, -17]], legs: [[LEG, -6, -6], [LEG, 2, -4]] },
  fall: { dy: 0, arms: [[ARM, -9, -16], [ARM, 5, -16]], legs: [[LEG, -7, -4], [LEG, 3, -5]] },
  duck: { dy: 5, arms: [[ARM, -9, -10], [ARM, 5, -10]], legs: [[LEG, -6, -7], [LEG, 2, -7]] },
  hurt: { dy: -1, arms: [[ARM, -10, -17], [ARM, 6, -17]], legs: [[LEG, -8, -4], [LEG, 4, -4]] },
  // The three attacks differ by which limb goes out and how far.
  action1: { dy: 0, arms: [[ARM, -9, -13], [ARM_OUT, 5, -13]], legs: [[LEG, -6, -6], [LEG, 2, -4]] },
  kick: { dy: 0, arms: [[ARM, -9, -11], [ARM, 5, -15]], legs: [[LEG, -7, -4], [ARM_OUT, 2, -6]] },
  action2: { dy: -1, arms: [[ARM_OUT, 4, -18], [ARM_OUT, 5, -10]], legs: [[LEG, -6, -6], [LEG, 2, -4]] },
};

export const POSE_NAMES = Object.keys(POSES);

// ------------------------------------------------------------------ render

const FRAME = { width: 36, height: 34 };

function blit(ctx, art, ox, oy) {
  for (let y = 0; y < art.length; y++) {
    const row = art[y];
    for (let x = 0; x < row.length; x++) {
      const color = PALETTE[row[x]];
      if (!color) continue;
      ctx.fillStyle = color;
      ctx.fillRect(ox + x, oy + y, 1, 1);
    }
  }
}

function renderFrame(character, poseName) {
  const body = BODIES[character];
  const pose = POSES[poseName];
  const canvas = createCanvas(FRAME.width, FRAME.height);
  const ctx = canvas.getContext("2d");
  // Sprites are built entirely from 1×1 fillRects, so nothing is ever
  // anti-aliased and the output is true pixel art.
  const bodyW = Math.max(...body.art.map((r) => r.length));
  const bodyH = body.art.length;
  const ox = Math.round((FRAME.width - bodyW) / 2);
  // Leave room under the body for legs, and a pixel of floor margin.
  const oy = FRAME.height - bodyH - 5 + pose.dy;
  const ax = ox + Math.floor(bodyW / 2);
  const ay = oy + bodyH;

  // Draw order is load-bearing. Limbs drawn *behind* the body only show the
  // part sticking out past its outline, which reads as a floating nub. Legs go
  // behind (hips are body), arms go on top and overlap the body by a few
  // pixels so they merge into the silhouette instead of hovering beside it.
  for (const [art, dx, dy] of pose.legs) blit(ctx, art, ax + dx, ay + dy);
  blit(ctx, body.art, ox, oy);
  for (const [art, dx, dy] of pose.arms) blit(ctx, art, ax + dx, ay + dy);

  return canvas;
}

fs.mkdirSync(OUT_DIR, { recursive: true });
let written = 0;
for (const character of Object.keys(BODIES)) {
  for (const pose of POSE_NAMES) {
    const canvas = renderFrame(character, pose);
    fs.writeFileSync(path.join(OUT_DIR, `${character}_${pose}.png`), canvas.toBuffer("image/png"));
    written++;
  }
}
console.log(`wrote ${written} sprites to ${path.relative(ROOT, OUT_DIR)}`);
