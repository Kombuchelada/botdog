// Render the GlizzyBrawl roster to a PNG so the art can be judged without
// opening a browser — every Fighter, every pose, side by side.
//
//   node scripts/brawl-art-preview.mjs [out.png]
//
// It runs the same `brawl-art.js` the page does, so what you see here is what
// the Arena draws. This is how the costumes got fixed the first time: rendered
// flat, it was obvious they were covering the faces the sprites were chosen
// for.
import { createCanvas, loadImage } from "@napi-rs/canvas";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { SPRITE, poseFor, drawFlourish, drawCrown, bodyFor } from "../brawl-art.js";
import { FIGHTERS, SPECIALS } from "../brawl-sim.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.argv[2] || path.join(ROOT, "brawl-roster.png");

const chars = ["glizzy", "ketchup", "grill", "corndog"];
const states = [
  { label: "idle", f: { onGround: true, vx: 0, vy: 0, state: "idle", attack: null } },
  { label: "run", f: { onGround: true, vx: 300, vy: 0, state: "run", attack: null } },
  { label: "jump", f: { onGround: false, vx: 0, vy: -400, state: "air", attack: null } },
  { label: "light", f: { onGround: true, vx: 0, vy: 0, state: "attack", attack: { move: "light_side", frame: 4 } } },
  { label: "heavy", f: { onGround: true, vx: 0, vy: 0, state: "attack", attack: { move: "heavy_side", frame: 4 } } },
  // Each Fighter throws its *own* special here — a shared "snap" showed every
  // row The Glizzy's move and so hid the flourishes this preview exists to
  // check. Held on the last wind-up frame, where a telegraph is fully out.
  { label: "special", perCharacter: true, f: { onGround: true, vx: 0, vy: 0, state: "attack", attack: null } },
  { label: "hurt", f: { onGround: false, vx: 200, vy: -200, state: "hitstun", attack: null } },
];
const CELL = 130;
const canvas = createCanvas(CELL * states.length + 40, CELL * (chars.length + 1) + 40);
const ctx = canvas.getContext("2d");
ctx.fillStyle = "#0b1220";
ctx.fillRect(0, 0, canvas.width, canvas.height);

const rows = [...chars.map((c) => ({ character: c, cpu: false })), { character: "glizzy", cpu: true }];
for (let r = 0; r < rows.length; r++) {
  for (let c = 0; c < states.length; c++) {
    const fighter = { ...rows[r], ...states[c].f };
    if (states[c].perCharacter) {
      // `FIGHTERS[x].special` is the character-select blurb; the move itself
      // lives in SPECIALS under that id, and the move name is what the art reads.
      const move = SPECIALS[FIGHTERS[fighter.character].special.id];
      fighter.attack = { move: move.name, kind: move.kind, frame: Math.max(0, move.startup - 1) };
    }
    const pose = poseFor(fighter, 300);
    const img = await loadImage(`${ROOT}/assets/brawl/${bodyFor(fighter)}_${pose}.png`);
    const cx = 20 + c * CELL + CELL / 2;
    const cy = 20 + r * CELL + CELL - 22;

    ctx.save();
    ctx.translate(cx, cy);
    drawFlourish(ctx, fighter, 1000, "back");
    const h = SPRITE.drawHeight;
    // Mirror brawl-page.js: aspect comes from the image, so bespoke art needn't
    // share Kenney's proportions. Hardcoding SPRITE's aspect here made imported
    // art look squeezed in this preview while the game drew it correctly.
    const w = (img.width / img.height) * h;
    ctx.drawImage(img, -w / 2, -h, w, h);
    drawFlourish(ctx, fighter, 1000, "front");
    if (r === 0) drawCrown(ctx, "gold");
    ctx.restore();

    ctx.fillStyle = "#64748b";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(`${rows[r].cpu ? "CPU" : rows[r].character} ${states[c].label}`, cx, 20 + r * CELL + CELL - 4);
  }
}
fs.writeFileSync(OUT, canvas.toBuffer("image/png"));
console.log("wrote", OUT);
