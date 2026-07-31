// Render the GlizzyBrawl roster to a PNG so the art can be judged without
// opening a browser — every Fighter, every action, as a filmstrip.
//
//   node scripts/brawl-art-preview.mjs [out.png]
//
// It runs the same `brawl-art.js` the page does, so what you see here is what
// the Arena draws. This is how the costumes got fixed the first time: rendered
// flat, it was obvious they were covering the faces the sprites were chosen
// for.
//
// Now that actions are clips rather than poses, a grid of stills is the wrong
// preview: it cannot show the thing most likely to be wrong. What matters is
// the *mapping* — a wind-up playing over the startup, contact held for exactly
// the hitbox's lifetime, recovery over the endlag — so each row walks a real
// action forward in sim time and draws whatever `frameFor` picks. The shaded
// columns are the frames on which the move can actually hit you, and the
// Fighter should look most committed inside them.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPRITE, frameFor, drawFlourish, drawCrown, bodyFor, CPU_BODY, CHARACTERS } from "../brawl-art.js";
import { FIGHTERS, SPECIALS, MOVES, DODGE_TICKS } from "../brawl-sim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || path.join(ROOT, "brawl-roster.png");

const COLS = 9;
const CELL = 96;
const LABEL_W = 132;
const ROW_H = CELL + 16;

/** A row: one action, sampled `COLS` times across its real lifetime. */
function rowsFor(character, cpu) {
  const base = { character, cpu, cosmetics: null, facing: 1, x: 0, y: 0 };
  const rows = [];
  const sampleFrame = (i, total) => Math.round((i * (total - 1)) / (COLS - 1));

  const attack = (label, move) => {
    const active = Math.max(1, move.active);
    const total = move.startup + active + move.endlag;
    rows.push({
      label: `${label} ${move.startup}/${move.active}/${move.endlag}`,
      active: (i) => {
        const frame = sampleFrame(i, total);
        return frame >= move.startup && frame < move.startup + active;
      },
      at: (i) => ({
        ...base,
        onGround: true, vx: 0, vy: 0, state: "attack",
        attack: {
          move: move.name, kind: move.kind || null,
          startup: move.startup, active: move.active, endlag: move.endlag,
          frame: sampleFrame(i, total),
        },
      }),
    });
  };

  attack("light", MOVES.light_side);
  attack("heavy", MOVES.heavy_side);
  // Each Fighter throws its *own* special — a shared "snap" showed every row
  // The Glizzy's move and so hid the flourishes this preview exists to check.
  attack("special", SPECIALS[FIGHTERS[character].special.id]);

  rows.push({
    label: "hurt",
    at: (i) => ({
      ...base, onGround: false, vx: 220, vy: -180, state: "hitstun", attack: null,
      hitstunTotal: 16, hitstun: Math.round(16 * (1 - i / (COLS - 1))),
    }),
  });
  rows.push({
    label: "dodge",
    at: (i) => ({
      ...base, onGround: true, vx: 0, vy: 0, state: "dodge", attack: null,
      dodgeTotal: DODGE_TICKS, dodgeTicks: Math.round(DODGE_TICKS * (1 - i / (COLS - 1))),
    }),
  });
  rows.push({
    label: "walk",
    at: () => ({ ...base, onGround: true, vx: 300, vy: 0, state: "run", attack: null }),
    // The one clip on a clock, so the clock is what this row steps.
    now: (i) => i * 90,
  });
  rows.push({
    // Rise through the apex and down: the air clips are driven by vertical
    // velocity, so a Fighter hanging at the apex holds the apex frame however
    // long the hang lasts.
    label: "jump → fall",
    at: (i) => ({
      ...base, onGround: false, vx: 0, state: "air", attack: null,
      vy: -900 + (i / (COLS - 1)) * 1900,
    }),
  });
  return rows;
}

const bodies = [
  ...CHARACTERS.map((character) => ({ character, cpu: false, title: character })),
  { character: CHARACTERS[0], cpu: true, title: `CPU (${CPU_BODY})` },
];
const blocks = bodies.map((b) => ({ ...b, rows: rowsFor(b.character, b.cpu) }));
const totalRows = blocks.reduce((n, b) => n + b.rows.length, 0);

const canvas = createCanvas(LABEL_W + COLS * CELL + 24, totalRows * ROW_H + blocks.length * 30 + 24);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#0b1220";
ctx.fillRect(0, 0, canvas.width, canvas.height);

// One cache: a filmstrip draws the same frame many times over, and a missing
// file is reported rather than thrown, so one gap doesn't cost the whole sheet.
const images = new Map();
async function sprite(body, clip, index) {
  const key = `${body}_${clip}_${index}`;
  if (!images.has(key)) {
    const file = `${ROOT}/assets/brawl/${key}.png`;
    images.set(key, fs.existsSync(file) ? await loadImage(file) : null);
  }
  return images.get(key);
}

let missing = 0;
let y = 12;
for (const block of blocks) {
  ctx.fillStyle = "#ff6b35";
  ctx.font = "600 14px sans-serif";
  ctx.textAlign = "left";
  ctx.fillText(block.title, 12, y + 18);
  y += 30;

  for (const row of block.rows) {
    ctx.fillStyle = "#94a3b8";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(row.label, 12, y + ROW_H / 2);

    for (let i = 0; i < COLS; i++) {
      const fighter = row.at(i);
      const now = typeof row.now === "function" ? row.now(i) : 0;
      const { clip, index } = frameFor(fighter, now);
      const img = await sprite(bodyFor(fighter), clip, index);
      if (!img) missing++;
      const cx = LABEL_W + i * CELL + CELL / 2;
      const cy = y + ROW_H - 22;

      if (row.active && row.active(i)) {
        ctx.fillStyle = "rgba(255,107,53,0.16)";
        ctx.fillRect(LABEL_W + i * CELL, y, CELL, ROW_H - 12);
      }

      ctx.save();
      ctx.translate(cx, cy);
      drawFlourish(ctx, fighter, 1000, "back");
      const h = SPRITE.drawHeight;
      if (img) {
        // Mirror brawl-page.js: aspect comes from the image, so bespoke art
        // needn't share Kenney's proportions. Hardcoding SPRITE's aspect here
        // made imported art look squeezed in this preview while the game drew
        // it correctly.
        const w = (img.width / img.height) * h;
        ctx.drawImage(img, -w / 2, -h, w, h);
      } else {
        ctx.fillStyle = "#7f1d1d";
        ctx.fillRect(-20, -h, 40, h);
      }
      drawFlourish(ctx, fighter, 1000, "front");
      if (block === blocks[0] && row === block.rows[0]) drawCrown(ctx, "gold");
      ctx.restore();

      ctx.fillStyle = img ? "#475569" : "#f87171";
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(img ? `${clip} ${index}` : `MISSING ${clip}_${index}`, cx, y + ROW_H - 4);
    }
    y += ROW_H;
  }
}

fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
console.log("wrote", OUT);
if (missing) console.error(`${missing} cell(s) had no sprite file — see the red boxes`);
process.exit(missing ? 1 : 0);
