// The image operations both GlizzyBrawl importers need.
//
// Art from a generator never arrives game-ready: it has a background, whatever
// margins the model felt like, and no relationship to the size the game draws
// it at. Knocking out the background and measuring what's left is the same job
// whether the subject is a Fighter or a floodlight tower — so it lives here,
// once. `brawl-import-sprites.mjs` and `brawl-import-stage.mjs` differ in what
// they do *after* this (plant feet on a floor line vs. cut to a scene rect),
// which is why they are still two scripts.
//
// They were briefly two copies of these functions, and had already drifted:
// `hexToRgb` fell back to white in one and black in the other, so the same
// `--bg` typo de-backgrounded differently depending on which importer you ran.
// That is the same failure mode as a client replica of the sim.

import { createCanvas } from "@napi-rs/canvas";

/** A loaded image as a canvas we can read pixels out of. */
export function toCanvas(img, sx = 0, sy = 0, sw = img.width, sh = img.height) {
  const canvas = createCanvas(sw, sh);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
  return canvas;
}

export function hexToRgb(hex, fallback = [255, 255, 255]) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function sampleCorners(data, w, h) {
  const corners = [[0, 0], [w - 1, 0], [0, h - 1], [w - 1, h - 1]];
  const sums = [0, 0, 0];
  for (const [x, y] of corners) {
    const i = (y * w + x) * 4;
    sums[0] += data[i];
    sums[1] += data[i + 1];
    sums[2] += data[i + 2];
  }
  return sums.map((s) => Math.round(s / corners.length));
}

/**
 * Knock out the background.
 *
 * Generated art usually has a flat backdrop rather than alpha; we flood from
 * the edges so a colour that also appears *inside* the subject — white eyes, a
 * pale bun, a lit panel the same blue as the sky — survives.
 *
 * Art that already carries alpha passes through untouched, because the flood
 * stops at the transparent pixels it starts on.
 */
export function removeBackground(canvas, bgHex, tolerance = 40) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  const target = bgHex ? hexToRgb(bgHex) : sampleCorners(data, w, h);

  const close = (i) =>
    Math.abs(data[i] - target[0]) <= tolerance &&
    Math.abs(data[i + 1] - target[1]) <= tolerance &&
    Math.abs(data[i + 2] - target[2]) <= tolerance;

  const queue = [];
  for (let x = 0; x < w; x++) queue.push([x, 0], [x, h - 1]);
  for (let y = 0; y < h; y++) queue.push([0, y], [w - 1, y]);

  const seen = new Uint8Array(w * h);
  while (queue.length) {
    const [x, y] = queue.pop();
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const key = y * w + x;
    if (seen[key]) continue;
    seen[key] = 1;
    const i = key * 4;
    if (data[i + 3] === 0) continue;
    if (!close(i)) continue;
    data[i + 3] = 0;
    queue.push([x + 1, y], [x - 1, y], [x, y + 1], [x, y - 1]);
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Knock out every pixel close to one colour, wherever it is.
 *
 * The flood fill above deliberately can't reach a colour walled in by the
 * subject — that is what protects white eyes and pale buns. But it means a
 * lattice truss keeps a backdrop pixel inside every triangle of its bracing,
 * which is exactly the Ballpark's scoreboard.
 *
 * The answer is to generate props on a chroma key — a magenta nothing in the
 * art will ever legitimately be — and key it out globally. Use this only with a
 * colour you chose for that purpose; on a sampled background it will punch
 * holes through the subject.
 */
export function keyOutColor(canvas, hex, tolerance = 60) {
  const ctx = canvas.getContext("2d");
  const { width: w, height: h } = canvas;
  const image = ctx.getImageData(0, 0, w, h);
  const data = image.data;
  // A generator rarely returns one flat backdrop: it dithers and shades the key
  // colour, and the same prompt can come back with a muted magenta *and* a
  // saturated one in different regions. Several keys, one pass.
  const keys = String(hex).split(",").map((h) => hexToRgb(h.trim(), [255, 0, 255]));
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] === 0) continue;
    for (const [r, g, b] of keys) {
      if (Math.abs(data[i] - r) <= tolerance &&
          Math.abs(data[i + 1] - g) <= tolerance &&
          Math.abs(data[i + 2] - b) <= tolerance) {
        data[i + 3] = 0;
        break;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/**
 * Bounding box of everything non-transparent, or null if nothing is.
 *
 * Measured pixel by pixel, never inferred from a corner: `sharp.trim()` keys
 * off the top-left pixel and hands back the whole canvas on art that already
 * has alpha, which is how a "trimmed" sprite keeps its margins.
 */
export function contentBounds(canvas) {
  const { width: w, height: h } = canvas;
  const data = canvas.getContext("2d").getImageData(0, 0, w, h).data;
  let x1 = w, y1 = h, x2 = -1, y2 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] < 8) continue;
      if (x < x1) x1 = x;
      if (y < y1) y1 = y;
      if (x > x2) x2 = x;
      if (y > y2) y2 = y;
    }
  }
  if (x2 < 0) return null;
  return { x1, y1, x2, y2, width: x2 - x1 + 1, height: y2 - y1 + 1 };
}
