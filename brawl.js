// GlizzyBrawl — the server side of the Arena.
//
// Owns exactly three things: the authoritative simulation loop, the WebSocket
// protocol, and the ledger. Physics live in `brawl-sim.js` (shared with the
// browser); the page lives in `brawl-page.js`.
//
// The seam is deliberate. Everything in here talks to the outside world
// through `registerBrawl(app)` / `attachBrawl(server)` / `stopBrawl()`, so
// lifting the Arena into its own service later means re-pointing those three
// calls, not unpicking the game from the dashboard.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import {
  TICK_HZ,
  TICK_MS,
  STAGE,
  FIGHTERS,
  FIGHTER_IDS,
  createArena,
  spawnFighter,
  despawnFighter,
  stepArena,
  sanitizeInput,
  cpuInput,
  snapshot,
} from "./brawl-sim.js";
import { getSessionUserId } from "./oauth.js";
import {
  getUserProfileStmt,
  getUserTotalStmt,
  getAllEventsStmt,
  ensureBrawlStatsStmt,
  getBrawlStatsStmt,
  updateBrawlStatsStmt,
  topBrawlersStmt,
  topBrawlersTodayStmt,
} from "./database.js";
import { buildUserDatesMap, getCurrentStreak, toPacificDateKey } from "./stats.js";
import { renderBrawlPage } from "./brawl-page.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Which Fighters have art of their own rather than a costumed stand-in.
 * Written by `scripts/brawl-import-sprites.mjs`; re-read per request so
 * dropping in new art doesn't need a restart.
 */
function artManifest() {
  try {
    const raw = fs.readFileSync(path.join(HERE, "assets", "brawl", "manifest.json"), "utf8");
    const parsed = JSON.parse(raw);
    return { bespoke: Array.isArray(parsed.bespoke) ? parsed.bespoke : [] };
  } catch {
    return { bespoke: [] };
  }
}

export const MAX_FIGHTERS = 8;
export const MAX_CPUS = 3;
// ~60s of no button presses and your Fighter leaves the Arena. Anything longer
// and an idle body becomes a stat farm for whoever is still awake.
//
// BRAWL_TEST_MODE shrinks it to two seconds so the AFK rule is testable and
// demoable in local development, following the GLIZZY_TEST_MODE precedent.
// Never set it in production.
const AFK_TICKS = (process.env.BRAWL_TEST_MODE === "1" ? 2 : 60) * TICK_HZ;
// CPUs don't vanish instantly when a human arrives — they fade, so the screen
// reads as "they left" rather than "the game glitched".
const CPU_FADE_TICKS = TICK_HZ;
// Snapshots go out at half the tick rate; the client predicts itself and
// interpolates everyone else, so 15Hz of truth is plenty and halves bandwidth.
const SNAPSHOT_EVERY = 2;

// ------------------------------------------------------------------ runtime

const arena = createArena(20260730);
/** ws -> connection record. The only place a socket's identity lives. */
const clients = new Map();
/** fighter id -> the frame currently being held, re-applied until replaced. */
const pendingInputs = new Map();
/**
 * fighter id -> frames received since the last tick, merged.
 *
 * A client sends at ~30Hz, but under load the server can tick slower than that
 * for a moment, and "last frame wins" then silently eats whichever presses
 * landed in between — a tap simply doesn't happen. Merging keeps the newest
 * directions but ORs the action buttons, so a press is never swallowed; the
 * release still arrives on a later frame, which is what edge-triggering needs.
 */
const queuedInputs = new Map();

const ACTION_BUTTONS = ["jump", "light", "heavy", "special", "dodge"];

function mergeInput(queued, next) {
  if (!queued) return next;
  const merged = { ...next };
  for (const button of ACTION_BUTTONS) merged[button] = queued[button] || next[button];
  return merged;
}
/** user id -> in-memory ledger row, loaded on join, flushed on KO/despawn. */
const ledger = new Map();
/** cpu fighter id -> tick at which it finishes fading out. */
const fadingCpus = new Map();
/**
 * Notable events since the last snapshot went out. Snapshots are sent every
 * other tick, so events must accumulate across the gap — sending only the
 * current tick's events silently dropped half of every fight's hits and KOs.
 */
let pendingEvents = [];

let wss = null;
let timer = null;
let lastTickAt = 0;
let accumulator = 0;
let cpuCounter = 0;

/**
 * Remove a Fighter and everything keyed by its id. Four maps track a Fighter
 * and they must go together — forgetting one leaves a ghost driving inputs.
 */
function removeFighter(id) {
  despawnFighter(arena, id);
  pendingInputs.delete(id);
  queuedInputs.delete(id);
  fadingCpus.delete(id);
}

function humanFighterIds() {
  return Object.values(arena.fighters).filter((f) => !f.cpu).map((f) => f.id);
}

function cpuFighterIds() {
  return Object.values(arena.fighters).filter((f) => f.cpu).map((f) => f.id);
}

function arenaHasCpus() {
  return cpuFighterIds().length > 0;
}

// ---------------------------------------------------------------- cosmetics
//
// Strictly decoration. Reversing the original pitch, hot dog stats buy crowns
// and trails and nothing else — no weight, speed, damage, or knockback in this
// function's output, and none may ever be added to it.

/**
 * Cosmetic tiers change at most once a day, but this scans every hot dog event
 * to find a streak and it is called on hello, on join, and on every page
 * render. A short cache keeps a busy Arena off the events table.
 */
const cosmeticsCache = new Map();
const COSMETICS_TTL_MS = 60_000;

export function computeCosmetics(userId) {
  const cached = cosmeticsCache.get(userId);
  if (cached && Date.now() - cached.at < COSMETICS_TTL_MS) return cached.value;
  const value = deriveCosmetics(userId);
  cosmeticsCache.set(userId, { at: Date.now(), value });
  return value;
}

function deriveCosmetics(userId) {
  let streak = 0;
  let lifetime = 0;
  try {
    const events = getAllEventsStmt.all();
    streak = getCurrentStreak(buildUserDatesMap(events).get(userId) || new Set());
    lifetime = getUserTotalStmt.get(userId)?.total_count || 0;
  } catch {
    // A missing stats table must never keep someone out of the Arena.
  }

  let crown = null;
  if (streak >= 30) crown = "gold";
  else if (streak >= 14) crown = "silver";
  else if (streak >= 7) crown = "bronze";

  let trail = null;
  if (lifetime >= 500) trail = "plasma";
  else if (lifetime >= 250) trail = "ember";
  else if (lifetime >= 100) trail = "smoke";

  // "finish", not "skin" — CONTEXT.md reserves the latter (see the Fighter
  // entry's Avoid list).
  let finish = "plain";
  if (lifetime >= 1000) finish = "gold";
  else if (lifetime >= 300) finish = "foil";

  const notes = [];
  if (crown) notes.push(`${streak}-day streak`);
  if (trail || finish !== "plain") notes.push(`${lifetime} lifetime glizzies`);

  return { crown, trail, finish, streak, lifetime, notes };
}

// ------------------------------------------------------------------- ledger

function pacificToday() {
  return toPacificDateKey(new Date());
}

/** The name to show for a player, however little we know about them. */
function displayNameFor(userId) {
  const profile = userId ? getUserProfileStmt.get(userId) : null;
  return (
    (profile && (profile.global_name || profile.username)) ||
    (userId ? `Fighter ${String(userId).slice(-4)}` : "Spectator")
  );
}

function loadLedger(userId) {
  if (ledger.has(userId)) return ledger.get(userId);
  ensureBrawlStatsStmt.run(userId);
  const row = getBrawlStatsStmt.get(userId) || {};
  let characterKos = {};
  try {
    characterKos = JSON.parse(row.character_kos || "{}");
  } catch {
    characterKos = {};
  }
  const today = pacificToday();
  const sameDay = row.day_key === today;
  const rec = {
    userId,
    kos: row.kos || 0,
    falls: row.falls || 0,
    bestStreak: row.best_streak || 0,
    arenaSeconds: row.arena_seconds || 0,
    characterKos,
    dayKey: today,
    dayKos: sameDay ? row.day_kos || 0 : 0,
    dayFalls: sameDay ? row.day_falls || 0 : 0,
    dirty: false,
  };
  ledger.set(userId, rec);
  return rec;
}

/** Roll the Day Tally over lazily — the first time a player scores after Pacific midnight. */
function rollDay(rec) {
  const today = pacificToday();
  if (rec.dayKey !== today) {
    rec.dayKey = today;
    rec.dayKos = 0;
    rec.dayFalls = 0;
  }
}

function flushLedger(userId) {
  const rec = ledger.get(userId);
  if (!rec || !rec.dirty) return;
  updateBrawlStatsStmt.run(
    rec.kos,
    rec.falls,
    rec.bestStreak,
    Math.round(rec.arenaSeconds),
    JSON.stringify(rec.characterKos),
    rec.dayKey,
    rec.dayKos,
    rec.dayFalls,
    userId,
  );
  rec.dirty = false;
}

/**
 * Scoreboard rows, identity-free — same split as `getLeaderboardRows` in
 * glizzy.js, so a caller that doesn't need names doesn't pay for them.
 */
export function getBrawlScoreboardRows(limit = 10) {
  const today = pacificToday();
  const shape = (rows, koKey, fallKey) =>
    rows.map((r) => ({
      userId: r.user_id,
      kos: r[koKey],
      falls: r[fallKey],
      bestStreak: r.best_streak,
      arenaSeconds: r.arena_seconds,
    }));
  return {
    allTime: shape(topBrawlersStmt.all(limit), "kos", "falls"),
    today: shape(topBrawlersTodayStmt.all(today, limit), "day_kos", "day_falls"),
  };
}

function withProfiles(rows) {
  // One profile lookup per distinct player, not one per row per board.
  const cache = new Map();
  return rows.map((row) => {
    if (!cache.has(row.userId)) {
      const profile = getUserProfileStmt.get(row.userId);
      cache.set(row.userId, {
        name: displayNameFor(row.userId),
        avatarUrl: (profile && profile.avatar_url) || null,
      });
    }
    return { ...row, ...cache.get(row.userId) };
  });
}

export function getBrawlScoreboard(limit = 10) {
  const rows = getBrawlScoreboardRows(limit);
  return { allTime: withProfiles(rows.allTime), today: withProfiles(rows.today) };
}

// ---------------------------------------------------------------- the loop

function ensureRunning() {
  if (timer) return;
  lastTickAt = Date.now();
  accumulator = 0;
  timer = setInterval(tick, TICK_MS);
  if (timer.unref) timer.unref();
}

function sleepIfEmpty() {
  // Nobody is watching and nobody is fighting: stop burning CPU entirely.
  if (clients.size > 0 || !timer) return false;
  clearInterval(timer);
  timer = null;
  for (const id of Object.keys(arena.fighters)) removeFighter(id);
  pendingEvents = [];
  return true;
}

function tick() {
  // Accumulator, not a bare interval: a chart render or a Claude call can stall
  // the event loop for hundreds of milliseconds, and the Arena should catch up
  // afterwards rather than quietly running in slow motion.
  const now = Date.now();
  accumulator += now - lastTickAt;
  lastTickAt = now;
  // Never try to catch up more than half a second; a long stall should drop
  // frames, not spiral into a burst of a hundred ticks.
  if (accumulator > 500) accumulator = 500;

  let steps = 0;
  while (accumulator >= TICK_MS && steps < 16) {
    accumulator -= TICK_MS;
    steps += 1;
    stepOnce();
  }
}

function stepOnce() {
  // An Arena with nobody in it has nothing to simulate. Spectators still get a
  // snapshot now and then so their view stays live, but the physics don't run.
  if (Object.keys(arena.fighters).length === 0) {
    if (arena.tick % (TICK_HZ * 2) === 0) broadcastSnapshot([]);
    arena.tick += 1;
    return;
  }

  const inputs = {};
  for (const f of Object.values(arena.fighters)) {
    if (f.cpu) {
      inputs[f.id] = cpuInput(arena, f.id);
      continue;
    }
    const queued = queuedInputs.get(f.id);
    if (queued) {
      pendingInputs.set(f.id, queued);
      queuedInputs.delete(f.id);
    }
    inputs[f.id] = pendingInputs.get(f.id) || undefined;
  }

  const events = stepArena(arena, inputs);
  for (const ev of events) {
    if (ev.type === "hit" || ev.type === "ko" || ev.type === "respawn") pendingEvents.push(ev);
  }
  handleEvents(events);
  expireFadingCpus();
  enforceAfk();
  accrueArenaTime();

  if (arena.tick % SNAPSHOT_EVERY === 0) {
    broadcastSnapshot(pendingEvents);
    pendingEvents = [];
  }
}

function accrueArenaTime() {
  // Sampled every SNAPSHOT_EVERY ticks rather than every tick — same total,
  // a fraction of the bookkeeping.
  if (arena.tick % SNAPSHOT_EVERY !== 0) return;
  const seconds = SNAPSHOT_EVERY / TICK_HZ;
  if (arenaHasCpus()) return; // practice time is not Arena time
  for (const conn of clients.values()) {
    if (!conn.fighterId) continue;
    const rec = ledger.get(conn.userId);
    if (!rec) continue;
    rec.arenaSeconds += seconds;
    rec.dirty = true;
  }
}

function handleEvents(events) {
  let scored = false;
  for (const ev of events) {
    if (ev.type !== "ko") continue;
    scored = recordKo(ev) || scored;
  }
  if (scored) broadcast({ t: "score", scoreboard: getBrawlScoreboard(10) });
}

/**
 * Persist a KO. Returns whether anything was written.
 *
 * A KO only counts when the Arena is purely human. Because CPUs can exist only
 * while a single human is present, "any CPU in the Arena" is the whole test —
 * there is never a human-vs-CPU KO to disambiguate.
 */
function recordKo(ev) {
  if (arenaHasCpus()) return false;
  const victim = arena.fighters[ev.victim];
  const attacker = ev.attacker ? arena.fighters[ev.attacker] : null;
  if (victim && victim.cpu) return false;
  if (attacker && attacker.cpu) return false;
  // A CPU that has already faded out can't be looked up, but its id shape can.
  if (ev.attacker && String(ev.attacker).startsWith("cpu:")) return false;

  let wrote = false;
  if (victim && !victim.cpu) {
    const rec = ledger.get(victim.id);
    if (rec) {
      rollDay(rec);
      rec.falls += 1;
      rec.dayFalls += 1;
      rec.dirty = true;
      flushLedger(victim.id);
      wrote = true;
    }
  }
  if (ev.attacker) {
    const rec = ledger.get(ev.attacker);
    if (rec) {
      rollDay(rec);
      rec.kos += 1;
      rec.dayKos += 1;
      // The running KO Streak lives on the Fighter, so it only advances while
      // they are still in the Arena. A credited-after-leaving KO still counts.
      if (attacker) rec.bestStreak = Math.max(rec.bestStreak, attacker.streak);
      const character = (attacker && attacker.character) || ev.attackerCharacter;
      if (character) rec.characterKos[character] = (rec.characterKos[character] || 0) + 1;
      rec.dirty = true;
      flushLedger(ev.attacker);
      wrote = true;
    }
  }
  return wrote;
}

function enforceAfk() {
  for (const conn of clients.values()) {
    if (!conn.fighterId) continue;
    conn.idleTicks += 1;
    if (conn.idleTicks < AFK_TICKS) continue;
    // KOs against them counted right up to this moment — the fade is the line,
    // not the moment they stopped touching the controller.
    releaseFighter(conn, "afk");
    send(conn.ws, { t: "despawned", reason: "afk" });
  }
}

function expireFadingCpus() {
  for (const [id, until] of fadingCpus) {
    if (arena.tick < until) continue;
    removeFighter(id);
  }
}

function fadeOutCpus() {
  for (const id of cpuFighterIds()) {
    if (fadingCpus.has(id)) continue;
    const f = arena.fighters[id];
    if (f) f.fading = true;
    fadingCpus.set(id, arena.tick + CPU_FADE_TICKS);
  }
}

// -------------------------------------------------------------- the socket

function send(ws, msg) {
  if (!ws || ws.readyState !== 1) return;
  ws.send(JSON.stringify(msg));
}

function broadcast(msg) {
  const payload = JSON.stringify(msg);
  for (const conn of clients.values()) {
    if (conn.ws.readyState === 1) conn.ws.send(payload);
  }
}

function broadcastSnapshot(notable) {
  const snap = snapshot(arena);
  for (const conn of clients.values()) {
    if (conn.ws.readyState !== 1) continue;
    send(conn.ws, {
      t: "snap",
      tick: snap.tick,
      you: conn.fighterId,
      ack: conn.fighterId ? (arena.fighters[conn.fighterId]?.seq ?? 0) : 0,
      fighters: snap.fighters,
      projectiles: snap.projectiles,
      events: notable,
      spectators: countSpectators(),
    });
  }
}

function countSpectators() {
  let n = 0;
  for (const conn of clients.values()) if (!conn.fighterId) n += 1;
  return n;
}

function releaseFighter(conn, reason) {
  if (!conn.fighterId) return;
  const id = conn.fighterId;
  removeFighter(id);
  conn.fighterId = null;
  conn.despawnReason = reason;
  flushLedger(conn.userId);
  // Someone waiting has been promised this slot.
  if (reason !== "replaced") setImmediate(promoteFromQueue);
  // The last human standing takes their CPUs with them.
  if (humanFighterIds().length === 0) {
    for (const cpuId of cpuFighterIds()) removeFighter(cpuId);
  }
}

/**
 * Everyone waiting for a slot, oldest first. A full Arena turns you into a
 * spectator with a place in line rather than an error — and the line is what
 * makes "you're in when a slot frees" true instead of a promise the page makes
 * on the server's behalf.
 */
function waitingConns() {
  return [...clients.values()]
    .filter((c) => c.userId && !c.fighterId && c.waitingSince !== null)
    .sort((a, b) => a.waitingSince - b.waitingSince);
}

function broadcastQueuePlaces() {
  const waiting = waitingConns();
  waiting.forEach((conn, i) => {
    send(conn.ws, { t: "waiting", place: i + 1, waiting: waiting.length, cap: MAX_FIGHTERS });
  });
}

/** A slot opened: pull in whoever has been waiting longest. */
function promoteFromQueue() {
  while (humanFighterIds().length < MAX_FIGHTERS) {
    const next = waitingConns()[0];
    if (!next) break;
    next.waitingSince = null;
    joinArena(next, next.character);
    if (!next.fighterId) break; // join refused for some other reason; don't spin
  }
  broadcastQueuePlaces();
}

function joinArena(conn, character) {
  if (!conn.userId) {
    send(conn.ws, { t: "denied", reason: "auth" });
    return;
  }
  if (conn.fighterId) return;
  if (FIGHTER_IDS.includes(character)) conn.character = character;
  if (humanFighterIds().length >= MAX_FIGHTERS) {
    if (conn.waitingSince === null) conn.waitingSince = Date.now();
    send(conn.ws, { t: "denied", reason: "full", cap: MAX_FIGHTERS });
    broadcastQueuePlaces();
    return;
  }
  conn.waitingSince = null;

  // One Fighter per player: a second tab (or a reconnect that beat the close
  // event) replaces the old body instead of cloning it.
  for (const other of clients.values()) {
    if (other !== conn && other.fighterId === conn.userId) {
      releaseFighter(other, "replaced");
      send(other.ws, { t: "despawned", reason: "replaced" });
    }
  }
  if (arena.fighters[conn.userId]) despawnFighter(arena, conn.userId);

  const humansBefore = humanFighterIds().length;
  const char = FIGHTER_IDS.includes(character) ? character : "glizzy";
  const rec = loadLedger(conn.userId);
  spawnFighter(arena, {
    id: conn.userId,
    character: char,
    name: conn.displayName,
    cosmetics: computeCosmetics(conn.userId),
  });
  conn.fighterId = conn.userId;
  conn.character = char;
  conn.idleTicks = 0;
  conn.despawnReason = null;

  // A second human ends practice mode.
  if (humansBefore >= 1) fadeOutCpus();

  send(conn.ws, {
    t: "joined",
    fighterId: conn.fighterId,
    character: char,
    cosmetics: arena.fighters[conn.fighterId].cosmetics,
    stats: { kos: rec.kos, falls: rec.falls, bestStreak: rec.bestStreak },
  });
}

function spawnCpus(conn, count) {
  // Practice is a solo affair: exactly one human in the Arena, and it's you.
  const humans = humanFighterIds();
  if (humans.length !== 1 || humans[0] !== conn.fighterId) {
    send(conn.ws, { t: "denied", reason: "cpu_not_alone" });
    return;
  }
  const room = MAX_CPUS - cpuFighterIds().length;
  if (room <= 0) {
    send(conn.ws, { t: "denied", reason: "cpu_limit", cap: MAX_CPUS });
    return;
  }
  const want = Math.min(room, Math.max(1, Math.floor(count) || 1));
  for (let i = 0; i < want; i++) {
    cpuCounter += 1;
    const character = FIGHTER_IDS[cpuCounter % FIGHTER_IDS.length];
    const id = `cpu:${cpuCounter}`;
    spawnFighter(arena, {
      id,
      character,
      name: `CPU ${FIGHTERS[character].name}`,
      cpu: true,
    });
  }
  send(conn.ws, { t: "cpus", count: cpuFighterIds().length });
}

function handleMessage(conn, raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return;
  }
  if (!msg || typeof msg.t !== "string") return;

  switch (msg.t) {
    case "join":
      joinArena(conn, msg.character);
      break;

    case "input": {
      const input = sanitizeInput(msg);
      const active =
        input.left || input.right || input.up || input.down ||
        input.jump || input.light || input.heavy || input.special || input.dodge;
      if (active) conn.idleTicks = 0;

      if (!conn.fighterId) {
        // Any button press brings an AFK'd Fighter back — no menu, no ceremony.
        if (active && conn.userId && conn.despawnReason === "afk") joinArena(conn, conn.character);
        return;
      }
      // The out-of-order guard, same shape as GlizzyClicker's save_seq: an input
      // frame built before one we've already applied is stale, not news.
      if (input.seq <= conn.lastSeq) return;
      conn.lastSeq = input.seq;
      queuedInputs.set(conn.fighterId, mergeInput(queuedInputs.get(conn.fighterId), input));
      break;
    }

    case "cpu":
      spawnCpus(conn, msg.count);
      break;

    case "leave":
      conn.waitingSince = null;
      releaseFighter(conn, "left");
      send(conn.ws, { t: "despawned", reason: "left" });
      break;

    default:
      break;
  }
}

function handleConnection(ws, req) {
  let userId = null;
  try {
    userId = getSessionUserId(req);
  } catch {
    userId = null;
  }
  const conn = {
    ws,
    userId,
    displayName: displayNameFor(userId),
    fighterId: null,
    character: "glizzy",
    waitingSince: null,
    idleTicks: 0,
    lastSeq: 0,
    despawnReason: null,
  };
  clients.set(ws, conn);
  ensureRunning();

  send(ws, {
    t: "hello",
    you: userId,
    name: conn.displayName,
    canFight: !!userId,
    tickHz: TICK_HZ,
    cap: MAX_FIGHTERS,
    maxCpus: MAX_CPUS,
    stage: STAGE,
    roster: FIGHTER_IDS.map((id) => FIGHTERS[id]),
    art: artManifest(),
    fighters: humanFighterIds().length,
    cosmetics: userId ? computeCosmetics(userId) : null,
    scoreboard: getBrawlScoreboard(10),
  });

  ws.on("message", (data) => {
    try {
      handleMessage(conn, typeof data === "string" ? data : data.toString());
    } catch (err) {
      console.error("[brawl] message failed:", err.message);
    }
  });

  ws.on("close", () => {
    releaseFighter(conn, "closed");
    if (conn.userId) flushLedger(conn.userId);
    clients.delete(ws);
    if (!sleepIfEmpty()) promoteFromQueue();
  });

  ws.on("error", () => {});
}

// ------------------------------------------------------------------ wiring

export function attachBrawl(server) {
  wss = new WebSocketServer({ server, path: "/brawl/ws" });
  wss.on("connection", handleConnection);
  return wss;
}

export function stopBrawl() {
  for (const userId of ledger.keys()) flushLedger(userId);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (wss) {
    for (const conn of clients.values()) {
      try {
        conn.ws.close();
      } catch {
        // already gone
      }
    }
    clients.clear();
    wss.close();
    wss = null;
  }
  for (const id of Object.keys(arena.fighters)) removeFighter(id);
  ledger.clear();
}

export function registerBrawl(app) {
  app.get("/brawl", (req, res) => {
    const userId = getSessionUserId(req);
    const profile = userId ? getUserProfileStmt.get(userId) : null;
    res.send(
      renderBrawlPage({
        userId,
        displayName: userId ? displayNameFor(userId) : null,
        avatarUrl: (profile && profile.avatar_url) || null,
        cosmetics: userId ? computeCosmetics(userId) : null,
        scoreboard: getBrawlScoreboard(10),
        roster: FIGHTER_IDS.map((id) => FIGHTERS[id]),
        art: artManifest(),
        cap: MAX_FIGHTERS,
      }),
    );
  });

  // The browser runs the very same simulation file the server does. Served from
  // disk rather than bundled so there is no build step and no chance of a stale
  // copy: if this file changes, both sides change together.
  app.get("/brawl/sim.js", (req, res) => {
    res.type("application/javascript");
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(path.join(HERE, "brawl-sim.js")).pipe(res);
  });

  // The art module is shared with the browser for the same reason the sim is:
  // one file, no replica to drift.
  app.get("/brawl/art.js", (req, res) => {
    res.type("application/javascript");
    res.setHeader("Cache-Control", "no-cache");
    fs.createReadStream(path.join(HERE, "brawl-art.js")).pipe(res);
  });

  // Kenney's CC0 sprites. Whitelisted by name shape so the route can never be
  // talked into serving anything else out of the repo.
  app.get("/brawl/art/:file", (req, res) => {
    if (!/^[a-z0-9]+_[a-z0-9]+\.png$/.test(req.params.file)) return res.status(404).end();
    const file = path.join(HERE, "assets", "brawl", req.params.file);
    res.type("image/png");
    res.setHeader("Cache-Control", "public, max-age=86400");
    fs.createReadStream(file).on("error", () => res.status(404).end()).pipe(res);
  });

  app.get("/api/brawl/scoreboard", (req, res) => {
    res.json(getBrawlScoreboard(50));
  });

  app.get("/api/brawl/me", (req, res) => {
    const userId = getSessionUserId(req);
    if (!userId) return res.status(401).json({ error: "auth_required" });
    const row = getBrawlStatsStmt.get(userId) || null;
    res.json({
      userId,
      stats: row,
      cosmetics: computeCosmetics(userId),
    });
  });
}
