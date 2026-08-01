// GlizzyBrawl — the page.
//
// Self-contained SSR'd HTML in the established style of `game.js`: Tailwind
// from the CDN, no build step, all behaviour in one inline module script. The
// only import is `/brawl/sim.js`, which is byte-for-byte the module the server
// runs — the client predicts its own Fighter with the server's physics rather
// than a hand-written replica of them.

import { renderNav } from "./nav.js";

const NAV = renderNav("brawl");

function esc(value) {
  if (value === null || value === undefined) return "";
  return String(value)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

const HEAD = `
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%A5%8A%3C/text%3E%3C/svg%3E">
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = { theme: { extend: { colors: {
    accent: { DEFAULT: '#ff6b35', soft: '#ffa07a', deep: '#e25822' },
  }, fontFamily: { sans: ['Inter', 'system-ui', 'sans-serif'] } } } };
</script>
<link rel="preconnect" href="https://rsms.me/">
<link rel="stylesheet" href="https://rsms.me/inter/inter.css">`;

const STYLES = `
<style>
  html { overflow-x: clip; }
  body { background:#020617; color:#e2e8f0; max-width:100vw; }
  /* Same load-bearing rule as the dashboard: a grid/flex item holding a canvas
     defaults to min-content = the canvas's pixel width, which pins the column
     open and stops anything shrinking when the window narrows. */
  .card { background:#0b1220; border:1px solid rgba(148,163,184,0.08); border-radius:16px; min-width: 0; }
  .accent { color:#ff6b35; }
  #arena-wrap { position: relative; width: 100%; }
  #arena { display: block; width: 100%; height: auto; border-radius: 16px; background:#070d1c; touch-action: none; }
  .overlay {
    position: absolute; inset: 0; display: flex; align-items: center; justify-content: center;
    background: rgba(2,6,23,0.82); border-radius: 16px; padding: 16px; text-align: center;
  }
  .pick {
    background:#0b1220; border:1px solid rgba(148,163,184,0.14); border-radius:14px; padding:14px;
    text-align:left; transition: border-color .15s, transform .1s; cursor: pointer;
  }
  .pick:hover { border-color:#ff6b35; transform: translateY(-2px); }
  .pick.selected { border-color:#ff6b35; box-shadow: 0 0 0 1px #ff6b35 inset; }
  .kbd {
    display:inline-block; min-width:1.6em; padding:1px 6px; border-radius:6px; text-align:center;
    background:#111a30; border:1px solid rgba(148,163,184,0.18); font-size:12px; color:#cbd5e1;
  }
  .board-row { display:flex; align-items:center; gap:8px; padding:5px 0; border-bottom:1px solid rgba(148,163,184,0.07); }
  .board-row:last-child { border-bottom:0; }
  .tabular { font-variant-numeric: tabular-nums; }
  .status-dot { width:8px; height:8px; border-radius:50%; display:inline-block; }
  .pad-card {
    background:#0a1120; border:1px solid rgba(148,163,184,0.10); border-radius:14px; padding:10px 10px 12px;
    min-width: 0;
  }
  .pad-card figcaption {
    font-size:10px; letter-spacing:.14em; text-transform:uppercase; color:#64748b; margin-bottom:2px;
  }
  /* Same rule as .card: an SVG in a grid cell needs an explicit width or its
     intrinsic size pins the column open. */
  .pad { display:block; width:100%; height:auto; }
</style>`;

// ---------------------------------------------------------------------------
// The pad diagram.
//
// One function, two layouts. The two families differ only in where the left
// stick and D-pad sit and what the face buttons are called, so drawing them
// from one shape is what keeps the *mapping* identical between the pictures —
// two hand-drawn SVGs would drift the moment `PAD` changes.
//
// Face buttons are labelled in the legend beneath rather than by leader lines:
// four callouts into a 48px cluster is unreadable at the size this renders.
// ---------------------------------------------------------------------------

const PAD_STYLES = {
  xbox: {
    name: "Xbox",
    // Xbox puts the stick where PlayStation puts the D-pad, and vice versa.
    stickPrimary: [132, 100],
    dpad: [176, 124],
    stickSecondary: [222, 124],
    face: { up: "Y", right: "B", down: "A", left: "X" },
    bumper: "LB",
    trigger: "LT",
    rbumper: "RB",
    rtrigger: "RT",
    glyphSize: 12,
  },
  playstation: {
    name: "PlayStation",
    dpad: [132, 100],
    stickPrimary: [176, 126],
    stickSecondary: [224, 126],
    face: { up: "△", right: "○", down: "✕", left: "□" },
    bumper: "L1",
    trigger: "L2",
    rbumper: "R1",
    rtrigger: "R2",
    glyphSize: 13,
  },
};

function padDiagram(key) {
  const s = PAD_STYLES[key];
  const [fx, fy] = [266, 100];
  const R = 24; // face-cluster radius
  const face = (dx, dy, label) => `
      <circle cx="${fx + dx}" cy="${fy + dy}" r="11.5" fill="#141d33" stroke="#ff6b35" stroke-width="1.6"/>
      <text x="${fx + dx}" y="${fy + dy + s.glyphSize * 0.35}" text-anchor="middle"
            font-size="${s.glyphSize}" font-weight="700" fill="#ffa07a">${label}</text>`;
  const stick = ([cx, cy]) => `
      <circle cx="${cx}" cy="${cy}" r="17" fill="#0d1526" stroke="#334155" stroke-width="1.4"/>
      <circle cx="${cx}" cy="${cy}" r="10" fill="#141d33" stroke="#ff6b35" stroke-width="1.6"/>`;
  const dpad = ([cx, cy]) => `
      <path d="M${cx - 5} ${cy - 16} h10 v11 h11 v10 h-11 v11 h-10 v-11 h-11 v-10 h11 z"
            fill="#141d33" stroke="#ff6b35" stroke-width="1.6" stroke-linejoin="round"/>`;

  return `
  <svg viewBox="0 0 400 210" class="pad" role="img" aria-label="${esc(s.name)} controller layout">
    <!-- triggers sit behind the bumpers, the way they do on the pad itself -->
    <rect x="112" y="26" width="38" height="18" rx="8" fill="#0d1526" stroke="#ff6b35" stroke-width="1.4"/>
    <text x="131" y="39" text-anchor="middle" font-size="10" font-weight="700" fill="#ffa07a">${s.trigger}</text>
    <rect x="250" y="26" width="38" height="18" rx="8" fill="#0d1526" stroke="#ff6b35" stroke-width="1.4"/>
    <text x="269" y="39" text-anchor="middle" font-size="10" font-weight="700" fill="#ffa07a">${s.rtrigger}</text>
    <rect x="104" y="42" width="54" height="17" rx="8" fill="#131c30" stroke="#ff6b35" stroke-width="1.4"/>
    <text x="131" y="55" text-anchor="middle" font-size="10" font-weight="700" fill="#ffa07a">${s.bumper}</text>
    <rect x="242" y="42" width="54" height="17" rx="8" fill="#131c30" stroke="#ff6b35" stroke-width="1.4"/>
    <text x="269" y="55" text-anchor="middle" font-size="10" font-weight="700" fill="#ffa07a">${s.rbumper}</text>

    <path d="M130 54 H270 C294 54 308 70 312 92 L328 156 C334 188 308 200 290 186 L258 148 H142
             L110 186 C92 200 66 188 72 156 L88 92 C92 70 106 54 130 54 Z"
          fill="#0b1220" stroke="rgba(148,163,184,0.28)" stroke-width="1.6"/>

    ${stick(s.stickPrimary)}
    ${stick(s.stickSecondary)}
    ${dpad(s.dpad)}
    ${face(0, -R, s.face.up)}
    ${face(R, 0, s.face.right)}
    ${face(0, R, s.face.down)}
    ${face(-R, 0, s.face.left)}

    <g stroke="rgba(148,163,184,0.45)" stroke-width="1" fill="none">
      <path d="M62 22 L104 34"/>
      <path d="M338 22 L296 34"/>
      <path d="M64 132 L${s.dpad[1] < 120 ? s.dpad[0] - 20 : s.stickPrimary[0] - 18} ${s.dpad[1] < 120 ? s.dpad[1] + 12 : s.stickPrimary[1] - 4}"/>
    </g>
    <text x="8" y="22" font-size="12" font-weight="600" fill="#cbd5e1">Dodge</text>
    <text x="8" y="36" font-size="10" fill="#64748b">${s.bumper} or ${s.trigger}</text>
    <text x="392" y="22" text-anchor="end" font-size="12" font-weight="600" fill="#cbd5e1">Special</text>
    <text x="392" y="36" text-anchor="end" font-size="10" fill="#64748b">${s.rbumper} or ${s.rtrigger}</text>
    <text x="8" y="132" font-size="12" font-weight="600" fill="#cbd5e1">Run · aim</text>
    <text x="8" y="146" font-size="10" fill="#64748b">stick or D-pad</text>
    <text x="8" y="158" font-size="10" fill="#64748b">down fast-falls</text>
  </svg>
  <div class="flex items-center gap-x-3 gap-y-1 flex-wrap justify-center text-xs text-slate-400 mt-1">
    <span><span class="kbd">${s.face.down}</span><span class="kbd">${s.face.up}</span> jump</span>
    <span><span class="kbd">${s.face.left}</span> light</span>
    <span><span class="kbd">${s.face.right}</span> heavy</span>
  </div>`;
}

export function renderBrawlPage({ userId, displayName, avatarUrl, scoreboard, roster, cap }) {
  const boot = JSON.stringify({ userId, displayName, scoreboard, roster, cap }).replace(/</g, "\\u003c");

  const rosterCards = roster
    .map(
      (f) => `
      <button type="button" class="pick" data-character="${esc(f.id)}">
        <div class="flex items-center gap-2 mb-1">
          <span class="w-3 h-3 rounded-full" style="background:${esc(f.color)}"></span>
          <span class="font-bold text-white">${esc(f.name)}</span>
        </div>
        <div class="text-xs text-slate-400 mb-2">${esc(f.blurb)}</div>
        <div class="text-xs"><span class="accent font-semibold">${esc(f.special.name)}</span>
          <span class="text-slate-500">· ${esc(f.special.blurb)}</span></div>
      </button>`,
    )
    .join("");

  const boardRows = (rows, koLabel) =>
    rows.length
      ? rows
          .map(
            (r, i) => `
        <div class="board-row">
          <span class="text-slate-500 text-xs w-4 tabular">${i + 1}</span>
          ${r.avatarUrl ? `<img src="${esc(r.avatarUrl)}" alt="" class="w-5 h-5 rounded-full object-cover">` : `<span class="w-5 h-5 rounded-full bg-slate-700"></span>`}
          <span class="text-sm text-slate-200 truncate flex-1">${esc(r.name)}</span>
          <span class="text-sm text-white tabular">${esc(r.kos)}</span>
          <span class="text-xs text-slate-500 tabular w-8 text-right">${esc(r.falls)}</span>
        </div>`,
          )
          .join("")
      : `<div class="text-sm text-slate-500 py-2">No ${koLabel} yet. Be first.</div>`;

  return `<!doctype html>
<html lang="en" class="dark"><head>${HEAD}<title>GlizzyBrawl</title>${STYLES}
<script>window.BRAWL = ${boot};</script>
</head>
<body class="font-sans antialiased">
${NAV}
<main class="max-w-7xl mx-auto px-4 md:px-6 py-6">

  <div class="flex items-center justify-between gap-3 flex-wrap mb-4">
    <div>
      <h1 class="text-3xl md:text-4xl font-bold text-white tracking-tight">GlizzyBrawl</h1>
      <p class="text-slate-400 text-sm">One Arena. Always on. Nothing ever ends — just KOs, Falls, and bragging rights.</p>
    </div>
    <div class="flex items-center gap-3 text-sm">
      <span id="conn" class="text-slate-400"><span class="status-dot bg-slate-600"></span> connecting…</span>
      ${
        userId
          ? `<span class="hidden sm:inline text-slate-300">${esc(displayName)}</span>
             ${avatarUrl ? `<img src="${esc(avatarUrl)}" alt="" class="w-8 h-8 rounded-full object-cover">` : ""}
             <form method="post" action="/oauth/logout" class="inline"><button class="text-xs text-slate-500 hover:text-slate-300" type="submit">Log out</button></form>`
          : `<a href="/oauth/login?next=%2Fbrawl" class="px-4 py-2 bg-accent hover:bg-accent-deep text-white font-bold rounded-lg transition">Log in with Discord to fight</a>`
      }
    </div>
  </div>

  <div class="grid lg:grid-cols-4 gap-6 items-start">
    <section class="lg:col-span-3 min-w-0">
      <div id="arena-wrap" class="card p-2">
        <canvas id="arena" width="1280" height="720"></canvas>

        <div id="overlay" class="overlay hidden">
          <div class="max-w-2xl w-full">
            <div id="overlay-title" class="text-2xl font-bold text-white mb-1">Pick your Fighter</div>
            <div id="overlay-sub" class="text-sm text-slate-400 mb-4">Drop straight into the Arena — no queue, no lobby.</div>
            <div id="roster" class="grid sm:grid-cols-2 gap-3 text-left">${rosterCards}</div>
            <div id="overlay-actions" class="mt-4 flex items-center justify-center gap-3 flex-wrap"></div>
          </div>
        </div>
      </div>

      <div class="mt-3 flex items-center gap-3 flex-wrap text-sm">
        <button type="button" id="btn-join" class="px-4 py-2 rounded-lg bg-accent hover:bg-accent-deep text-white font-bold transition">Enter the Arena</button>
        <button type="button" id="btn-leave" class="hidden px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:text-white transition">Leave</button>
        <button type="button" id="btn-cpu" class="hidden px-3 py-2 rounded-lg border border-slate-700 text-slate-300 hover:text-white transition" title="Only while you're alone in the Arena">Spawn a CPU</button>
        <span id="arena-note" class="text-slate-500"></span>
      </div>

      <div class="card p-4 mt-4">
        <div class="text-xs uppercase tracking-widest text-slate-400 mb-3">Controls</div>
        <div class="grid sm:grid-cols-2 gap-4 text-sm text-slate-300">
          <div>
            <div class="font-semibold text-white mb-1">Keyboard <span class="text-xs text-slate-500 font-normal">— WASD and arrows are both live</span></div>
            <div class="space-y-1 text-slate-400">
              <div><span class="kbd">A</span><span class="kbd">D</span> / <span class="kbd">←</span><span class="kbd">→</span> run · <span class="kbd">Space</span> jump (twice to double jump)</div>
              <div><span class="kbd">W</span><span class="kbd">S</span> / <span class="kbd">↑</span><span class="kbd">↓</span> aim your attacks · <span class="kbd">S</span> fast-falls, <span class="kbd">S</span>+<span class="kbd">Space</span> drops through a soft platform</div>
              <div><span class="kbd">J</span> light · <span class="kbd">K</span> heavy · <span class="kbd">L</span> special · <span class="kbd">Shift</span> dodge</div>
            </div>
          </div>
          <div>
            <div class="font-semibold text-white mb-1">Controller <span class="text-xs text-slate-500 font-normal">— plug one in and press a button</span></div>
            <div class="space-y-1 text-slate-400">
              <div>Smash layout, both families mapped at once — whichever pad you own just works.</div>
              <div>Press anything to wake your Fighter after a fade.</div>
            </div>
          </div>
        </div>
        <div class="grid sm:grid-cols-2 gap-4 mt-4">
          <figure class="pad-card">
            <figcaption>Xbox</figcaption>
            ${padDiagram("xbox")}
          </figure>
          <figure class="pad-card">
            <figcaption>PlayStation</figcaption>
            ${padDiagram("playstation")}
          </figure>
        </div>
        <div class="text-xs text-slate-500 mt-3">
          The CPU sparring partner wears <a href="https://kenney.nl" class="underline hover:text-slate-300">Kenney</a>'s CC0 zombie.
          Percent has no ceiling and never kills on its own — it just means you fly farther. You only lose a stock by crossing the blast zone.
          Idle for a minute and your Fighter fades out; any button brings them back.
        </div>
      </div>
    </section>

    <aside class="lg:col-span-1 space-y-4 min-w-0">
      <div class="card p-4">
        <div class="flex items-baseline justify-between mb-2">
          <div class="text-xs uppercase tracking-widest text-slate-400">All-time</div>
          <div class="text-[10px] uppercase tracking-widest text-slate-600">KO · Fall</div>
        </div>
        <div id="board-all">${boardRows(scoreboard.allTime, "KOs")}</div>
      </div>
      <div class="card p-4">
        <div class="flex items-baseline justify-between mb-2">
          <div class="text-xs uppercase tracking-widest text-slate-400">Day Tally</div>
          <div class="text-[10px] uppercase tracking-widest text-slate-600">Pacific</div>
        </div>
        <div id="board-today">${boardRows(scoreboard.today, "KOs today")}</div>
      </div>
    </aside>
  </div>
</main>

<script type="module">
${CLIENT_SCRIPT}
</script>
</body></html>`;
}

// ---------------------------------------------------------------------------
// The client. Kept as one template literal so the page stays a single file, in
// the same spirit as game.js.
// ---------------------------------------------------------------------------

const CLIENT_SCRIPT = String.raw`
import {
  TICK_HZ, TICK_MS, STAGE, BODY, FIGHTERS,
  createArena, stepArena, emptyInput, applySnapshot, spawnFighter,
} from "/brawl/sim.js";
import {
  SPRITE, allSprites, bodyFor, frameFor, spriteKey, drawFlourish, drawCrown,
} from "/brawl/art.js";
import { allStageArt, buildScene, drawStage } from "/brawl/stage.js";

const BOOT = window.BRAWL;
const canvas = document.getElementById("arena");
const ctx = canvas.getContext("2d");
const overlay = document.getElementById("overlay");
const overlayTitle = document.getElementById("overlay-title");
const overlaySub = document.getElementById("overlay-sub");
const overlayActions = document.getElementById("overlay-actions");
const connEl = document.getElementById("conn");
const noteEl = document.getElementById("arena-note");
const btnJoin = document.getElementById("btn-join");
const btnLeave = document.getElementById("btn-leave");
const btnCpu = document.getElementById("btn-cpu");

// ------------------------------------------------------------------- state

const local = createArena(1);
let myId = null;            // set once the server confirms a spawn
let character = "glizzy";
let connected = false;
let ws = null;
let reconnectDelay = 500;
let inputSeq = 0;
let lastServerTick = -1;
let spectators = 0;
let arenaFighters = 0;
let queuePlace = null;      // {place, waiting, cap} while queued for a slot
let lastAck = 0;            // the newest input frame the server says it applied
let wantsToFight = false;   // survives a reconnect, so a deploy costs seconds
// Where each remote Fighter is drawn, eased toward the server's truth so a
// 15Hz snapshot stream doesn't look like 15Hz.
const drawPos = new Map();
const sparks = [];
let banner = null;

const held = emptyInput();

// -------------------------------------------------------------- networking

function connect() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  ws = new WebSocket(proto + "://" + location.host + "/brawl/ws");

  ws.addEventListener("open", () => {
    connected = true;
    reconnectDelay = 500;
    setConn("live", "#ff6b35");
    if (wantsToFight) ws.send(JSON.stringify({ t: "join", character }));
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    handle(msg);
  });

  ws.addEventListener("close", () => {
    connected = false;
    myId = null;
    // The stale-snapshot guard is only meaningful within one connection: a
    // restarted Arena counts from tick 0 again, and holding on to the old high
    // water mark would silently drop every snapshot from here on — a page that
    // looks alive and never updates.
    lastServerTick = -1;
    setConn("reconnecting…", "#64748b");
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 8000);
  });

  ws.addEventListener("error", () => { try { ws.close(); } catch {} });
}

function send(msg) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function handle(msg) {
  switch (msg.t) {
    case "hello":
      arenaFighters = msg.fighters;
      updateScoreboard(msg.scoreboard);
      refreshUi();
      break;

    case "joined":
      queuePlace = null;
      myId = msg.fighterId;
      character = msg.character;
      wantsToFight = true;
      hideOverlay();
      refreshUi();
      break;

    case "denied":
      wantsToFight = msg.reason === "full";
      showDenied(msg);
      refreshUi();
      break;

    case "waiting":
      queuePlace = msg;
      showWaiting(msg);
      break;

    case "fading":
      // The server counts the idle time; the page only says so out loud.
      flash("Still there? Fading in " + msg.seconds + "s — press anything.", msg.seconds * 1000);
      break;

    case "despawned":
      myId = null;
      wantsToFight = msg.reason === "afk";
      if (msg.reason === "afk") flash("Faded out — press anything to rejoin.");
      refreshUi();
      break;

    case "cpus":
      flash(msg.count + " CPU" + (msg.count === 1 ? "" : "s") + " sparring. They leave no stats.");
      break;

    case "score":
      updateScoreboard(msg.scoreboard);
      break;

    case "snap":
      // Out-of-order guard, the same rule GlizzyClicker uses for saves: a
      // snapshot older than one we've already drawn is stale, not news.
      if (msg.tick <= lastServerTick) return;
      lastServerTick = msg.tick;
      myId = msg.you || null;
      lastAck = msg.ack || 0;
      spectators = msg.spectators;
      arenaFighters = msg.fighters.length;
      applySnapshot(local, msg, myId);
      reconcileSelf(msg);
      for (const ev of msg.events) onSimEvent(ev);
      refreshUi();
      break;
  }
}

/**
 * Keep the predicted local Fighter, but pull it back when it has drifted far
 * from the server's version — the client is a guess, the server is the truth.
 */
function reconcileSelf(msg) {
  if (!myId) return;
  const authoritative = msg.fighters.find((f) => f.id === myId);
  const mine = local.fighters[myId];
  if (!authoritative) return;
  if (!mine) {
    local.fighters[myId] = { ...spawnFighter(local, {
      id: myId, character: authoritative.character, name: authoritative.name,
      cosmetics: authoritative.cosmetics, x: authoritative.x, y: authoritative.y, invuln: 0,
    }), ...authoritative };
    return;
  }
  // How far ahead of the server our prediction is. A snapshot that predates
  // our recent inputs is *expected* to disagree, so tolerate more drift the
  // more unacknowledged frames we are holding — snapping on it would yank the
  // Fighter backwards every time latency ticked up.
  const unacked = Math.max(0, inputSeq - lastAck);
  const tolerance = 60 + Math.min(unacked, 12) * 12;
  const drift = Math.hypot(mine.x - authoritative.x, mine.y - authoritative.y);
  // Percent, stocks, and anything scoreboard-shaped are never predicted.
  mine.percent = authoritative.percent;
  mine.kos = authoritative.kos;
  mine.falls = authoritative.falls;
  mine.streak = authoritative.streak;
  mine.cosmetics = authoritative.cosmetics;
  if (drift > tolerance || authoritative.state === "respawn" || mine.state === "respawn") {
    Object.assign(mine, authoritative);
  }
}

function onSimEvent(ev) {
  if (ev.type === "hit") {
    for (let i = 0; i < 8; i++) {
      sparks.push({
        x: ev.x, y: ev.y,
        vx: (Math.random() - 0.5) * 320,
        vy: (Math.random() - 0.5) * 320,
        life: 0.35, max: 0.35,
      });
    }
  } else if (ev.type === "ko") {
    const who = local.fighters[ev.victim];
    banner = { text: (who ? who.name : "Someone") + " was KO'd at " + ev.percent + "%", until: performance.now() + 2200 };
  }
}

function setConn(text, color) {
  connEl.innerHTML = '<span class="status-dot" style="background:' + color + '"></span> ' + text;
}

// -------------------------------------------------------------------- input

const KEYS = {
  left: ["ArrowLeft", "KeyA"],
  right: ["ArrowRight", "KeyD"],
  up: ["ArrowUp", "KeyW"],
  down: ["ArrowDown", "KeyS"],
  // Jump is deliberately NOT on W / ArrowUp. Sharing a key with the "up"
  // direction means every ground up-attack jumps first and comes out as its
  // aerial version instead — the ground variants become unreachable.
  jump: ["Space"],
  light: ["KeyJ"],
  heavy: ["KeyK"],
  special: ["KeyL"],
  dodge: ["ShiftLeft", "ShiftRight"],
};
// Both layouts are live at once, deliberately: no picker, whichever hand
// position you try first just works.
const keyState = new Set();
// Keys pressed since the last poll, whether or not they are still down. Input
// is sampled once per 33ms tick, so a mashed tap that went down and up between
// two samples was simply never seen — the fastest punches were the ones most
// likely to vanish. A latched press survives exactly one poll, which is all the
// sim needs to see an edge.
const keyLatched = new Set();

window.addEventListener("keydown", (e) => {
  if (e.repeat) return;
  if (isTyping(e.target)) return;
  if (usesKey(e.code)) e.preventDefault();
  keyState.add(e.code);
  keyLatched.add(e.code);
  wake();
});
window.addEventListener("keyup", (e) => keyState.delete(e.code));
window.addEventListener("blur", () => { keyState.clear(); keyLatched.clear(); });

function isTyping(el) {
  return el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
}
function usesKey(code) {
  for (const codes of Object.values(KEYS)) if (codes.includes(code)) return true;
  return false;
}

// Smash conventions on a fixed layout — no remap UI, by design.
const PAD = {
  jump: [0, 3],      // A / cross, Y / triangle
  light: [2],        // X / square
  heavy: [1],        // B / circle
  special: [7, 5],   // right trigger / right bumper
  dodge: [4, 6],     // left bumper / left trigger
};
const STICK_DEADZONE = 0.35;

function readGamepad(frame) {
  const pads = navigator.getGamepads ? navigator.getGamepads() : [];
  for (const pad of pads) {
    if (!pad) continue;
    const ax = pad.axes[0] || 0;
    const ay = pad.axes[1] || 0;
    if (ax < -STICK_DEADZONE) frame.left = true;
    if (ax > STICK_DEADZONE) frame.right = true;
    if (ay < -STICK_DEADZONE) frame.up = true;
    if (ay > STICK_DEADZONE) frame.down = true;
    // D-pad (standard mapping)
    if (pad.buttons[14] && pad.buttons[14].pressed) frame.left = true;
    if (pad.buttons[15] && pad.buttons[15].pressed) frame.right = true;
    if (pad.buttons[12] && pad.buttons[12].pressed) frame.up = true;
    if (pad.buttons[13] && pad.buttons[13].pressed) frame.down = true;
    for (const [action, buttons] of Object.entries(PAD)) {
      for (const b of buttons) {
        if (pad.buttons[b] && pad.buttons[b].pressed) frame[action] = true;
      }
    }
  }
}

function pollInput() {
  const frame = emptyInput();
  for (const [action, codes] of Object.entries(KEYS)) {
    for (const code of codes) if (keyState.has(code) || keyLatched.has(code)) frame[action] = true;
  }
  keyLatched.clear();
  readGamepad(frame);

  const active = frame.left || frame.right || frame.up || frame.down ||
    frame.jump || frame.light || frame.heavy || frame.special || frame.dodge;
  if (active) wake();

  inputSeq += 1;
  frame.seq = inputSeq;
  Object.assign(held, frame);
  return frame;
}

let wokeAt = 0;
function wake() {
  // Any button press rejoins after an AFK fade. Rate-limited so a mash doesn't
  // spam the socket with join attempts.
  if (myId || !BOOT.userId) return;
  const now = performance.now();
  if (now - wokeAt < 400) return;
  wokeAt = now;
  if (wantsToFight) send({ t: "join", character });
}

// ------------------------------------------------------------- the loop

let acc = 0;
let last = performance.now();

function frame(now) {
  const dt = Math.min(now - last, 250);
  last = now;
  acc += dt;

  let steps = 0;
  while (acc >= TICK_MS && steps < 8) {
    acc -= TICK_MS;
    steps += 1;
    const myFrame = pollInput();
    if (myId && connected) send({ t: "input", ...myFrame });
    // Predict locally with the server's own physics: only our own Fighter's
    // input is known here, everyone else coasts until the next snapshot.
    const inputs = {};
    if (myId && local.fighters[myId]) inputs[myId] = myFrame;
    stepArena(local, inputs);
  }

  ease();
  draw(now);
  requestAnimationFrame(frame);
}

function ease() {
  for (const f of Object.values(local.fighters)) {
    const target = drawPos.get(f.id);
    if (!target) {
      drawPos.set(f.id, { x: f.x, y: f.y });
      continue;
    }
    // Our own Fighter is drawn exactly where we predicted it — smoothing our
    // own input is what makes a game feel laggy.
    const k = f.id === myId ? 1 : 0.35;
    target.x += (f.x - target.x) * k;
    target.y += (f.y - target.y) * k;
  }
  for (const id of drawPos.keys()) if (!local.fighters[id]) drawPos.delete(id);
}

// ------------------------------------------------------------- the renderer
//
// Fighter art is deliberately behind brawl-art.js. The renderer knows only
// "draw this Fighter at a position, with a facing" — which clip is playing and
// which frame of it is showing are decided there, from the snapshot, and this
// file never asks why.

function draw(now) {
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // The Ballpark. Every surface draws its art if the prop has loaded and its
  // placeholder primitive if it hasn't, so a missing asset costs one piece.
  drawStage(ctx, scene, stageArt);
  drawBlastZone();

  for (const p of local.projectiles) {
    ctx.fillStyle = "#e11d48";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 12, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "rgba(225,29,72,0.25)";
    ctx.beginPath();
    ctx.arc(p.x, p.y, 20, 0, Math.PI * 2);
    ctx.fill();
  }

  const fighters = Object.values(local.fighters);
  for (const f of fighters) drawFighter(f, now);

  drawSparks();
  drawHud(fighters, now);
}

function drawBlastZone() {
  ctx.strokeStyle = "rgba(148,163,184,0.10)";
  ctx.setLineDash([10, 12]);
  ctx.lineWidth = 2;
  ctx.strokeRect(STAGE.blast.left, STAGE.blast.top, STAGE.blast.right - STAGE.blast.left, STAGE.blast.bottom - STAGE.blast.top);
  ctx.setLineDash([]);
}

// The Ballpark is composed from props rather than painted, and the scene that
// places them is derived from the sim's own geometry — so a platform cannot
// move out from under its Catwalk. Props load like sprites do: into a cache,
// with each surface falling back to its placeholder shape until (or unless) its
// art arrives.

const scene = buildScene(STAGE);
const stageArt = new Map();

(function preloadStageArt() {
  for (const { name, url } of allStageArt()) {
    const img = new Image();
    img.addEventListener("load", () => stageArt.set(name, img));
    img.src = url;
  }
})();

// Every Fighter draws its own sprite set (the CPU borrows a Kenney body), and
// every action is a clip rather than a pose — so this is a few dozen small
// PNGs per body, preloaded once and drawn from a cache. If one is missing the
// Fighter falls back to its stand frame and, failing that, renders as a plain
// block: an asset 404 must never blank the Arena.

const sprites = new Map();
let spritesReady = false;

(function preloadSprites() {
  const all = allSprites();
  let left = all.length;
  for (const { body, clip, index, url } of all) {
    const img = new Image();
    img.addEventListener("load", () => {
      sprites.set(spriteKey(body, clip, index), img);
      if (--left <= 0) spritesReady = true;
    });
    img.addEventListener("error", () => {
      if (--left <= 0) spritesReady = true;
    });
    img.src = url;
  }
})();

function spriteFor(f, now) {
  const body = bodyFor(f);
  const { clip, index } = frameFor(f, now);
  return (
    sprites.get(spriteKey(body, clip, index)) ||
    sprites.get(spriteKey(body, clip, 0)) ||
    sprites.get(spriteKey(body, "stand", 0))
  );
}

function drawFighter(f, now) {
  const pos = drawPos.get(f.id) || { x: f.x, y: f.y };
  if (f.state === "respawn") {
    ctx.globalAlpha = 0.25;
    ctx.fillStyle = "#94a3b8";
    ctx.font = "bold 20px Inter, sans-serif";
    ctx.textAlign = "center";
    ctx.fillText(Math.ceil(f.respawnTimer / TICK_HZ) + "…", pos.x, pos.y - 70);
    ctx.globalAlpha = 1;
    return;
  }

  ctx.save();
  if (f.fading) ctx.globalAlpha = 0.4;
  if (f.invuln > 0) ctx.globalAlpha = 0.45 + 0.35 * Math.sin(now / 60);

  // Trail cosmetic, drawn behind everything.
  const cos = f.cosmetics || {};
  if (cos.trail && (Math.abs(f.vx) > 40 || !f.onGround)) {
    const colors = { smoke: "148,163,184", ember: "249,115,22", plasma: "217,70,239" };
    const rgb = colors[cos.trail] || "148,163,184";
    for (let i = 1; i <= 3; i++) {
      ctx.fillStyle = "rgba(" + rgb + "," + (0.16 / i) + ")";
      ctx.beginPath();
      ctx.ellipse(pos.x - f.facing * i * 14, pos.y - BODY.height / 2, 20, 26, 0, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.translate(pos.x, pos.y);
  ctx.scale(f.facing, 1);
  drawFlourish(ctx, f, now, "back");

  const img = spriteFor(f, now);
  const h = SPRITE.drawHeight;
  // Bespoke art needn't share Kenney's proportions, so take the aspect from
  // the image itself and fall back to the pack's when it hasn't loaded.
  const aspect = img && img.naturalWidth ? img.naturalWidth / img.naturalHeight : SPRITE.width / SPRITE.height;
  const w = aspect * h;
  if (img) {
    ctx.drawImage(img, -w / 2, -h, w, h);
  } else {
    ctx.fillStyle = (FIGHTERS[f.character] && FIGHTERS[f.character].color) || "#94a3b8";
    ctx.fillRect(-w / 2, -h, w, h);
  }

  drawFlourish(ctx, f, now, "front");
  if (cos.crown) drawCrown(ctx, cos.crown);
  ctx.restore();

  // Dodge shimmer.
  if (f.state === "dodge") {
    ctx.strokeStyle = "rgba(96,165,250,0.8)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(pos.x, pos.y - BODY.height / 2, 30, 40, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  // Name + Percent tag.
  ctx.textAlign = "center";
  ctx.font = "600 14px Inter, sans-serif";
  ctx.fillStyle = f.id === myId ? "#ff6b35" : "#cbd5e1";
  ctx.fillText(f.name + (f.cpu ? " (CPU)" : ""), pos.x, pos.y - SPRITE.drawHeight - 30);
  ctx.font = "700 20px Inter, sans-serif";
  ctx.fillStyle = percentColor(f.percent);
  ctx.fillText(Math.round(f.percent) + "%", pos.x, pos.y - SPRITE.drawHeight - 10);
}

function percentColor(p) {
  // Plasma-family ramp, never red/green: the owner is colorblind.
  if (p < 40) return "#e2e8f0";
  if (p < 90) return "#f0abfc";
  if (p < 150) return "#e879f9";
  return "#fb923c";
}

function drawSparks() {
  const dt = 1 / 60;
  for (let i = sparks.length - 1; i >= 0; i--) {
    const s = sparks[i];
    s.x += s.vx * dt;
    s.y += s.vy * dt;
    s.life -= dt;
    if (s.life <= 0) {
      sparks.splice(i, 1);
      continue;
    }
    ctx.globalAlpha = s.life / s.max;
    ctx.fillStyle = "#fbbf24";
    ctx.beginPath();
    ctx.arc(s.x, s.y, 5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

function drawHud(fighters, now) {
  ctx.textAlign = "left";
  ctx.font = "600 16px Inter, sans-serif";
  ctx.fillStyle = "rgba(148,163,184,0.75)";
  ctx.fillText(fighters.filter((f) => !f.cpu).length + " in the Arena · " + spectators + " watching", 24, 36);

  if (banner && banner.until > now) {
    ctx.textAlign = "center";
    ctx.font = "700 34px Inter, sans-serif";
    ctx.fillStyle = "rgba(255,107,53,0.92)";
    ctx.fillText(banner.text, STAGE.width / 2, 120);
  } else if (banner && banner.until <= now) {
    banner = null;
  }
}

// ---------------------------------------------------------------------- UI

function showOverlay(title, sub, { roster = true, actions = [] } = {}) {
  overlayTitle.textContent = title;
  overlaySub.textContent = sub;
  document.getElementById("roster").classList.toggle("hidden", !roster);
  overlayActions.innerHTML = "";
  for (const a of actions) {
    const el = document.createElement(a.href ? "a" : "button");
    el.className = "px-5 py-2.5 rounded-lg font-bold transition " +
      (a.primary ? "bg-accent hover:bg-accent-deep text-white" : "border border-slate-700 text-slate-300 hover:text-white");
    el.textContent = a.label;
    if (a.href) el.href = a.href;
    else el.addEventListener("click", a.onClick);
    overlayActions.appendChild(el);
  }
  overlay.classList.remove("hidden");
}

function hideOverlay() {
  overlay.classList.add("hidden");
}

function showDenied(msg) {
  if (msg.reason === "auth") {
    showOverlay("Log in to fight", "Spectating is free. Fighting needs a Discord login — identify scope only.", {
      roster: false,
      actions: [{ label: "Log in with Discord", href: "/oauth/login?next=%2Fbrawl", primary: true }],
    });
  } else if (msg.reason === "full") {
    showWaiting(queuePlace || { place: null, waiting: null, cap: msg.cap });
  } else if (msg.reason === "cpu_not_alone") {
    flash("CPUs are for practising alone. Someone else is in the Arena.");
  }
}

function showWaiting({ place, waiting, cap }) {
  const line = place
    ? "You're #" + place + " of " + waiting + " waiting. The next slot is yours — you'll drop in automatically."
    : "All " + cap + " slots are taken. You'll drop in automatically when one frees up.";
  showOverlay("The Arena is full", line, { roster: false, actions: [] });
}

let flashTimer = null;
function flash(text, ms) {
  noteEl.textContent = text;
  clearTimeout(flashTimer);
  flashTimer = setTimeout(() => { noteEl.textContent = ""; }, ms || 4000);
}

function refreshUi() {
  const fighting = !!myId;
  btnJoin.classList.toggle("hidden", fighting);
  btnLeave.classList.toggle("hidden", !fighting);
  const alone = fighting && Object.values(local.fighters).filter((f) => !f.cpu).length === 1;
  btnCpu.classList.toggle("hidden", !alone);
  if (!fighting && !overlay.classList.contains("hidden")) return;
  if (!fighting && BOOT.userId && !wantsToFight) {
    showOverlay("Pick your Fighter", "Drop straight into the Arena — no queue, no lobby.");
  } else if (!fighting && !BOOT.userId) {
    showOverlay("Watching the Arena", "Anyone can watch. Log in with Discord to drop in and fight.", {
      roster: false,
      actions: [{ label: "Log in with Discord", href: "/oauth/login?next=%2Fbrawl", primary: true }],
    });
  }
}

function updateScoreboard(board) {
  renderBoard(document.getElementById("board-all"), board.allTime, "KOs");
  renderBoard(document.getElementById("board-today"), board.today, "KOs today");
}

function renderBoard(el, rows, label) {
  if (!rows.length) {
    el.innerHTML = '<div class="text-sm text-slate-500 py-2">No ' + label + " yet. Be first.</div>";
    return;
  }
  el.innerHTML = rows.map((r, i) =>
    '<div class="board-row">' +
      '<span class="text-slate-500 text-xs w-4 tabular">' + (i + 1) + "</span>" +
      (r.avatarUrl
        ? '<img src="' + escapeHtml(r.avatarUrl) + '" alt="" class="w-5 h-5 rounded-full object-cover">'
        : '<span class="w-5 h-5 rounded-full bg-slate-700"></span>') +
      '<span class="text-sm text-slate-200 truncate flex-1">' + escapeHtml(r.name) + "</span>" +
      '<span class="text-sm text-white tabular">' + r.kos + "</span>" +
      '<span class="text-xs text-slate-500 tabular w-8 text-right">' + r.falls + "</span>" +
    "</div>",
  ).join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

for (const btn of document.querySelectorAll(".pick")) {
  btn.addEventListener("click", () => {
    character = btn.dataset.character;
    for (const other of document.querySelectorAll(".pick")) other.classList.remove("selected");
    btn.classList.add("selected");
    if (!BOOT.userId) {
      location.href = "/oauth/login?next=%2Fbrawl";
      return;
    }
    wantsToFight = true;
    send({ t: "join", character });
  });
}

btnJoin.addEventListener("click", () => {
  if (!BOOT.userId) {
    location.href = "/oauth/login?next=%2Fbrawl";
    return;
  }
  wantsToFight = true;
  send({ t: "join", character });
});

btnLeave.addEventListener("click", () => {
  wantsToFight = false;
  send({ t: "leave" });
});

btnCpu.addEventListener("click", () => send({ t: "cpu", count: 1 }));

// Leaving needs no ceremony: everything worth keeping is already written, and
// the socket closing is the despawn.
window.addEventListener("pagehide", () => { try { ws && ws.close(); } catch {} });

connect();
requestAnimationFrame(frame);
refreshUi();
`;
