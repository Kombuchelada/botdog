// GlizzyBrawl — the Stage.
//
// The Arena's one Stage is **the Ballpark**: a night game seen from the
// outfield. Fighters brawl on the padded cap of the outfield wall and the
// scoreboard rig behind it, light towers overhead, crowd in the stands, dark
// sky above. Falling off either end of the ground drops you behind the wall
// into the dark. See `docs/glizzybrawl-stage-brief.md` and ADR 0003.
//
// Same shared-file rule as `brawl-sim.js` and `brawl-art.js`: this module
// imports nothing and touches no browser-only global beyond the 2D context it
// is handed, so the page (`/brawl/stage.js`) and the offline preview script
// both run it and neither can drift from the other.
//
// Two consequences of that rule shape the API:
//
//   * The sim's `STAGE` is *passed in* (`buildScene(stage)`) rather than
//     imported, because the browser's specifier for it (`/brawl/sim.js`) is not
//     the server's (`./brawl-sim.js`). Deriving the scene from the sim's own
//     geometry is also why a platform can't move out from under its Catwalk.
//   * Deciding what to draw (`planScene`) is separate from drawing it, so the
//     fallback behaviour is a pure function and the tests never need a canvas.
//
// The Ballpark is composed from props at native scale rather than painted as
// one image — PixelLab caps at 400×400 and every upscale to 1280×720 gives
// pixels visibly chunkier than the Fighters'. Composition is therefore the
// thing that gets iterated, so **placement lives here as readable coordinates**
// and never in an import step.

/** Every prop file in `assets/brawl/`, minus the `.png`. */
export const STAGE_ART = [
  "board_main",   // the scoreboard rig — style anchor for everything else
  "tower_light",  // one light tower, drawn twice, mirrored
  "crowd_band",   // a band of silhouettes, repeated and mirrored across the frame
  "wall_lower",   // outfield wall body
  "wall_cap",     // its padded top, the surface Fighters stand on
  "wall_end",     // the ends you can fall off
  "walk_a",       // the three Catwalks, one prop each
  "walk_b",
  "walk_c",
];

/** The wall tileset's tile size. */
export const TILE = 32;

/**
 * Where everything sits. Sizes here are the sizes the art was generated at —
 * changing one means regenerating a prop, not just moving it, which is why they
 * are stated rather than measured from whatever happens to be on disk.
 */
export const LAYOUT = {
  sky: { top: "#0b1220", bottom: "#050a17" },
  // Sizes are the art's own, at 1:1 — a Fighter is drawn one art pixel to one
  // canvas pixel, and a backdrop resampled to fit reads as a different game.
  // The importer refuses any prop that would have to be rescaled to land here.
  // Sits clear above the highest Catwalk (y=250): the rig is behind the fight,
  // and overlapping the two made the Catwalk read as part of the scoreboard.
  board: { x: 507, y: 60, width: 266, height: 173 },
  // The empty slot the board art carries. v1 draws nothing into it; wiring it
  // to the Day Tally later is then a code change against art that already
  // accommodates it. Kept high, out of the band the fighting happens in — lit
  // text down where the Catwalks are is the likeliest way to fail the contrast
  // gate. `brawl-stage-preview.mjs --slot` outlines it over the art.
  slot: { x: 537, y: 79, width: 206, height: 53 },
  towers: [
    { x: 92, y: 40, width: 100, height: 300 },
    { x: 1088, y: 40, width: 100, height: 300, mirror: true },
  ],
  crowd: { width: 400, height: 100 },
  // A Catwalk's walking surface is the top edge of its art; the rest of the
  // prop — girders, tie rods, struts — hangs below it into empty air.
  catwalk: { height: 40 },
};

/** The prop each Catwalk draws, low to high. Three distinct ones, on purpose:
 *  players learn "the high one" faster when it doesn't look like the others.
 *  Exported because the importer sizes these props from the scene, and a fourth
 *  Catwalk named off-pattern must not be able to desync the two. */
export const CATWALK_ART = ["walk_a", "walk_b", "walk_c"];

export function stageArtPath(name) {
  return `/brawl/art/${name}.png`;
}

/** Every image the Stage will ever need, for preloading. */
export function allStageArt() {
  return STAGE_ART.map((name) => ({ name, url: stageArtPath(name) }));
}

/**
 * The Ballpark, back to front, derived from the sim's own geometry.
 *
 * Each piece carries: what it is (`kind`), where it goes (`rect`), which art it
 * needs (`assets`), and whether it has a primitive to fall back on. A piece
 * with `primitive: false` is backdrop — it layers over the sky and hides
 * nothing, so its absence is simply sky.
 */
export function buildScene(stage) {
  const ground = stage.ground;
  const pieces = [
    {
      id: "sky",
      kind: "sky",
      z: 0,
      assets: [],
      primitive: true,
      rect: { x: 0, y: 0, width: stage.width, height: stage.height },
    },
    {
      id: "towers",
      kind: "tower",
      z: 10,
      assets: ["tower_light"],
      primitive: false,
      rect: boundsOf(LAYOUT.towers),
      instances: LAYOUT.towers,
    },
    {
      id: "crowd",
      kind: "crowd",
      z: 20,
      assets: ["crowd_band"],
      primitive: false,
      // The stands sit behind the wall, so the band's foot lands on the floor
      // line — the fight happens in front of it and the wall rises from it.
      // Enough columns to cross the canvas; the last one runs off the edge
      // rather than leaving a gap, which is the whole point of a repeat.
      rect: {
        x: 0,
        y: ground.y - LAYOUT.crowd.height,
        width: stage.width,
        height: LAYOUT.crowd.height,
      },
      repeat: {
        ...LAYOUT.crowd,
        columns: Math.ceil(stage.width / LAYOUT.crowd.width),
        mirrorAlternate: true,
      },
    },
    {
      id: "board",
      kind: "board",
      z: 30,
      assets: ["board_main"],
      primitive: false,
      rect: { ...LAYOUT.board },
    },
    {
      id: "wall",
      kind: "ground",
      z: 40,
      assets: ["wall_cap", "wall_lower", "wall_end"],
      primitive: true,
      rect: {
        x: ground.x1,
        y: ground.y,
        width: ground.x2 - ground.x1,
        height: stage.height - ground.y,
      },
      // A wang tile's terrain boundary runs down its *middle*, not along its
      // edge — the cap tile is air above its midline and wall below it, the end
      // tile air to the west of its midline and wall to the east. So the grid
      // is offset by half a tile in both axes, which is what puts the walking
      // surface exactly on `ground.y` and the ledge exactly on `ground.x1/x2`.
      // Line the grid up with the ground rect instead and the whole wall sits
      // 16px low and 16px narrow.
      tiles: {
        size: TILE,
        origin: { x: ground.x1 - TILE / 2, y: ground.y - TILE / 2 },
        columns: Math.ceil((ground.x2 - ground.x1 + TILE) / TILE),
        rows: Math.ceil((stage.height - ground.y + TILE / 2) / TILE),
      },
    },
  ];

  stage.platforms.forEach((p, i) => {
    const width = p.x2 - p.x1;
    pieces.push({
      id: `catwalk${i}`,
      kind: "catwalk",
      z: 50 + i,
      platform: i,
      assets: [CATWALK_ART[i % CATWALK_ART.length]],
      primitive: true,
      // The walking surface is the *top* of the art and the prop hangs below
      // it. Anything drawn above that line reads as collision that isn't there.
      rect: { x: p.x1, y: p.y, width, height: LAYOUT.catwalk.height },
      art: { width, height: LAYOUT.catwalk.height },
    });
  });

  return { pieces, slot: { ...LAYOUT.slot }, sky: { ...LAYOUT.sky } };
}

function boundsOf(instances) {
  const x = Math.min(...instances.map((i) => i.x));
  const y = Math.min(...instances.map((i) => i.y));
  return {
    x,
    y,
    width: Math.max(...instances.map((i) => i.x + i.width)) - x,
    height: Math.max(...instances.map((i) => i.y + i.height)) - y,
  };
}

/**
 * What each piece will actually draw, given which art has loaded.
 *
 * `mode` is one of:
 *   "art"       — every image it needs is in the cache
 *   "primitive" — it draws the placeholder Stage's shape instead
 *   "sky"       — it draws nothing, and the sky behind it shows through
 *
 * A surface (the wall, a Catwalk) always has a primitive: an asset 404 must
 * degrade the Ballpark to the placeholder Stage, never leave Fighters standing
 * on an invisible floor.
 */
export function planScene(scene, hasArt) {
  return scene.pieces.map((piece) => {
    const missing = piece.assets.filter((name) => !hasArt(name));
    const mode = missing.length === 0 && piece.assets.length ? "art"
      : piece.primitive ? "primitive"
      : "sky";
    // The piece rides along on its own plan entry: the renderer below walks the
    // plan, so nothing has to keep two arrays in the same order.
    return { id: piece.id, z: piece.z, assets: piece.assets, missing, mode, piece };
  });
}

// ----------------------------------------------------------------- drawing

/**
 * Draw the Ballpark. `art` is a lookup of loaded images by name — a `Map`, or
 * anything with a `get`. Missing art is not an error; it's a fallback.
 */
export function drawStage(ctx, scene, art) {
  const get = (name) => (art && art.get ? art.get(name) : null);
  const has = (name) => Boolean(get(name));
  const plan = planScene(scene, has);

  // Pixel art must never be smoothed into mush, and the Fighters are drawn 1:1
  // with the props — a blurred backdrop behind crisp sprites reads as two games.
  const smoothing = ctx.imageSmoothingEnabled;
  ctx.imageSmoothingEnabled = false;

  for (const { mode, piece } of plan) {
    if (mode === "sky") continue;
    if (mode === "art") drawArt(ctx, piece, get);
    else drawPrimitive(ctx, piece, scene);
  }

  ctx.imageSmoothingEnabled = smoothing;
}

function drawArt(ctx, piece, get) {
  switch (piece.kind) {
    case "tower": {
      const img = get("tower_light");
      for (const inst of piece.instances) drawMaybeMirrored(ctx, img, inst);
      break;
    }
    case "crowd": {
      const img = get("crowd_band");
      const { width, height, columns, mirrorAlternate } = piece.repeat;
      for (let c = 0; c < columns; c++) {
        drawMaybeMirrored(ctx, img, {
          x: c * width,
          y: piece.rect.y,
          width,
          height,
          mirror: mirrorAlternate && c % 2 === 1,
        });
      }
      break;
    }
    case "board":
      ctx.drawImage(get("board_main"), piece.rect.x, piece.rect.y, piece.rect.width, piece.rect.height);
      break;
    case "ground":
      drawWall(ctx, piece, get);
      break;
    case "catwalk":
      ctx.drawImage(get(piece.assets[0]), piece.rect.x, piece.rect.y, piece.rect.width, piece.rect.height);
      break;
    default:
      break;
  }
}

function drawMaybeMirrored(ctx, img, { x, y, width, height, mirror }) {
  if (!mirror) {
    ctx.drawImage(img, x, y, width, height);
    return;
  }
  ctx.save();
  ctx.translate(x + width, y);
  ctx.scale(-1, 1);
  ctx.drawImage(img, 0, 0, width, height);
  ctx.restore();
}

/**
 * The outfield wall: a cap row sitting exactly on the floor line, body rows
 * below it, and its own end tiles on the two columns you can fall off.
 */
function drawWall(ctx, piece, get) {
  const { size, columns, rows, origin } = piece.tiles;
  const cap = get("wall_cap");
  const lower = get("wall_lower");
  const end = get("wall_end");
  ctx.save();
  ctx.beginPath();
  ctx.rect(origin.x, origin.y, columns * size, rows * size);
  ctx.clip();
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      const x = origin.x + c * size;
      const y = origin.y + r * size;
      if (r === 0) {
        ctx.drawImage(cap, x, y, size, size);
      } else if (c === 0 || c === columns - 1) {
        drawMaybeMirrored(ctx, end, { x, y, width: size, height: size, mirror: c !== 0 });
      } else {
        ctx.drawImage(lower, x, y, size, size);
      }
    }
  }
  ctx.restore();
}

// The placeholder Stage, kept as the per-surface fallback. It is the Arena
// everyone played on before there was art, so a bad deploy degrades to a game
// rather than to a bug.

function drawPrimitive(ctx, piece, scene) {
  switch (piece.kind) {
    case "sky": {
      const sky = ctx.createLinearGradient(0, 0, 0, piece.rect.height);
      sky.addColorStop(0, scene.sky.top);
      sky.addColorStop(1, scene.sky.bottom);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, piece.rect.width, piece.rect.height);
      break;
    }
    case "ground": {
      const { x, y, width } = piece.rect;
      const grad = ctx.createLinearGradient(0, y, 0, y + 120);
      grad.addColorStop(0, "#7c2d12");
      grad.addColorStop(1, "#1c1917");
      ctx.fillStyle = grad;
      ctx.fillRect(x, y, width, 160);
      ctx.fillStyle = "#ff6b35";
      ctx.fillRect(x, y - 6, width, 6);
      break;
    }
    case "catwalk": {
      const { x, y, width } = piece.rect;
      ctx.fillStyle = "rgba(255,107,53,0.75)";
      ctx.fillRect(x, y - 6, width, 6);
      ctx.fillStyle = "rgba(124,45,18,0.35)";
      ctx.fillRect(x, y, width, 10);
      break;
    }
    default:
      break;
  }
}
