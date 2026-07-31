// GlizzyBrawl — the Stage's scene description.
//
// The Ballpark is composed from props rather than painted as one image, and
// composition is the one thing here that can go wrong *silently*: move a
// platform in `brawl-sim.js` and a Catwalk's art keeps drawing at the old
// width, over a surface that is no longer under it. Nothing errors, nothing
// looks obviously broken in a screenshot, and the sim is still right.
//
// So these tests pin the scene against the sim, and nothing else. They are pure
// in the same way `test/brawl-art.test.js` is — no canvas, no images, no draw
// calls — because everything about how the Ballpark *looks* is judged by the
// import gates and the preview script, where the art actually is.

import test from "node:test";
import assert from "node:assert/strict";

import {
  STAGE_ART,
  TILE,
  allStageArt,
  buildScene,
  planScene,
  stageArtPath,
} from "../brawl-stage.js";
import { STAGE } from "../brawl-sim.js";

const scene = buildScene(STAGE);
const catwalks = scene.pieces.filter((p) => p.kind === "catwalk");
const everything = () => true;
const nothing = () => false;

// ------------------------------------------------------------------ assets

test("every prop the scene references is a known asset the route will serve", () => {
  // `brawl.js` whitelists asset names by shape so the route can't be talked
  // into serving anything else out of the repo. A prop named outside that shape
  // 404s in production and nowhere else.
  const whitelist = /^[a-z0-9]+_[a-z0-9]+\.png$/;
  for (const piece of scene.pieces) {
    for (const name of piece.assets) {
      assert.ok(STAGE_ART.includes(name), `${name} is a known Stage asset`);
      assert.match(stageArtPath(name).split("/").pop(), whitelist);
    }
  }
});

test("only art some piece actually draws is preloaded", () => {
  const referenced = new Set(scene.pieces.flatMap((p) => p.assets));
  assert.deepEqual(new Set(STAGE_ART), referenced);
  for (const { name, url } of allStageArt()) {
    assert.equal(url, `/brawl/art/${name}.png`);
  }
});

// ------------------------------------------------- the scene against the sim

test("there is one Catwalk per soft platform, sized to it", () => {
  // The drift this catches: a platform moves or resizes in the sim, and its
  // Catwalk art — generated at one exact width — silently stretches over a
  // surface that is no longer under it.
  assert.equal(catwalks.length, STAGE.platforms.length);
  for (const piece of catwalks) {
    const p = STAGE.platforms[piece.platform];
    assert.ok(p, `Catwalk ${piece.id} names a real platform`);
    assert.equal(piece.rect.x, p.x1);
    assert.equal(piece.rect.width, p.x2 - p.x1, `${piece.id} is drawn at its platform's width`);
    assert.equal(piece.rect.y, p.y, "the walking surface is the top of the art");
    assert.equal(piece.art.width, p.x2 - p.x1, `${piece.id}'s art was generated at this width`);
  }
  assert.equal(new Set(catwalks.map((p) => p.assets[0])).size, catwalks.length,
    "each Catwalk is a distinct prop, so players can tell them apart");
});

test("the outfield wall covers the ground exactly, capped on the floor line", () => {
  const wall = scene.pieces.find((p) => p.kind === "ground");
  assert.equal(wall.rect.x, STAGE.ground.x1);
  assert.equal(wall.rect.width, STAGE.ground.x2 - STAGE.ground.x1);
  assert.equal(wall.rect.y, STAGE.ground.y, "the wall's cap sits on the floor line");

  // A wang tile's terrain boundary is its midline, so the grid is offset by
  // half a tile: line it up with the ground rect instead and the walking
  // surface lands 16px below the floor the sim collides against, which looks
  // like Fighters standing in the wall.
  const { origin, columns, rows } = wall.tiles;
  assert.equal(origin.x, STAGE.ground.x1 - TILE / 2);
  assert.equal(origin.y, STAGE.ground.y - TILE / 2);
  assert.ok(origin.x + columns * TILE >= STAGE.ground.x2 + TILE / 2, "tiles reach both ends");
  assert.ok(origin.y + rows * TILE >= STAGE.height, "and down past the bottom of the canvas");
});

test("the scoreboard's data slot stays above the play band", () => {
  // Lit text down where the Catwalks are is the single most likely way to fail
  // the silhouette-contrast gate. See ADR 0003.
  const slot = scene.slot;
  assert.ok(slot.y + slot.height <= 200, "the slot is entirely above y=200");
  const board = scene.pieces.find((p) => p.kind === "board");
  assert.ok(slot.x >= board.rect.x && slot.x + slot.width <= board.rect.x + board.rect.width,
    "the slot is inside the board art that carries it");
});

// -------------------------------------------------------------- draw order

test("the scene is ordered back to front", () => {
  const zs = scene.pieces.map((p) => p.z);
  assert.deepEqual(zs, [...zs].sort((a, b) => a - b));
  assert.equal(scene.pieces[0].kind, "sky", "the sky is behind everything");
  assert.equal(scene.pieces.at(-1).kind, "catwalk", "the Catwalks are in front of everything");
  const kindZ = (kind) => scene.pieces.find((p) => p.kind === kind).z;
  assert.ok(kindZ("crowd") < kindZ("ground"), "the crowd is behind the wall it sits behind");
  assert.ok(kindZ("board") < kindZ("ground"));
});

// ----------------------------------------------------------- the fallbacks

test("a missing asset costs its own piece and nothing else", () => {
  const full = planScene(scene, everything);
  for (const entry of full) {
    if (entry.assets.length) assert.equal(entry.mode, "art", `${entry.id} draws its art`);
  }

  const without = planScene(scene, (name) => name !== "crowd_band");
  for (const entry of without) {
    const before = full.find((e) => e.id === entry.id);
    const expected = entry.assets.includes("crowd_band") ? "sky" : before.mode;
    assert.equal(entry.mode, expected, `${entry.id} is unaffected by the crowd's absence`);
  }
});

test("a surface with no art draws its primitive, never nothing", () => {
  // This is the deploy-safety property: a bad asset must degrade the Ballpark
  // to the placeholder Stage, not leave Fighters standing on invisible floors.
  for (const entry of planScene(scene, nothing)) {
    const piece = scene.pieces.find((p) => p.id === entry.id);
    if (piece.kind === "ground" || piece.kind === "catwalk") {
      assert.equal(entry.mode, "primitive", `${entry.id} falls back to a drawn surface`);
    } else {
      assert.ok(["primitive", "sky"].includes(entry.mode));
    }
  }
});

test("a backdrop prop with no art falls through to sky, not to a grey box", () => {
  // Backdrop props layer over the sky gradient and hide nothing, so a missing
  // scoreboard just means sky. Inventing a primitive for one would mean
  // shipping a placeholder that looks like a bug.
  const plan = planScene(scene, nothing);
  for (const kind of ["board", "tower", "crowd"]) {
    const entry = plan.find((e) => scene.pieces.find((p) => p.id === e.id).kind === kind);
    assert.equal(entry.mode, "sky");
  }
});

test("the plan keeps the scene's order, whatever is loaded", () => {
  for (const has of [everything, nothing, (n) => n.startsWith("walk")]) {
    assert.deepEqual(planScene(scene, has).map((e) => e.id), scene.pieces.map((p) => p.id));
  }
});
