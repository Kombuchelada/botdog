// GlizzyBrawl — the sound of the Arena.
//
// Every sound is *synthesised*, not sampled: there is not one audio file in the
// repo and there is no import pipeline. That is a deliberate first pass. It
// costs nothing to ship, raises no redistribution question in a public repo
// (see the rule about `assets/`), and it makes the thing that is actually hard
// here — *timing* — the only thing left to get wrong.
//
// Same shared-file rule as `brawl-sim.js`, `brawl-art.js` and `brawl-stage.js`:
// this module imports nothing, touches no browser global, and never opens an
// audio device. It decides *what should be heard and how loud*; the engine in
// `brawl-page.js` is the only code that knows Web Audio exists. That split is
// what lets `test/brawl-audio.test.js` be a pure test with no canvas, no audio
// device and no mocking.
//
// The seam between the two halves is deliberately narrow: every function here
// returns **cues** — `{ id, gain, rate, pan, stretch }` — and `CUES` is the
// table of recipes those ids name.

// ---------------------------------------------------------------- the recipes
//
// A cue is one or more layers played together. A layer is either a `tone` (an
// oscillator sweeping between two frequencies) or `noise` (white noise through
// a sweeping filter). Between them they cover every sound a fight makes: bodies
// hitting things are noise, everything with a pitch to it is a tone, and a good
// impact is one of each.
//
// The numbers are seconds and Hz. `gain` is relative to the cue, and the cue's
// own gain (from `cueFor`) scales the lot — so a layer's gain is a *mix*
// decision that stays put while the cue's is a *performance* decision that
// varies per hit.
//
// `cooldownMs` is not a taste knob. Snapshots go out every other tick and carry
// every event since the last one, so a KO arrives as a KO plus most of the
// combo that caused it, all in a single frame. Without a floor between two
// firings of the same cue that lands as one clipped burst of white noise
// instead of a fight. This is the audio consequence of a fact the renderer
// already lives with.

export const CUES = {
  // A swing that hits nothing. Short, airy, and the most-played cue in the
  // game by a wide margin — hence the lowest gain and the tightest cooldown.
  swing: {
    cooldownMs: 30,
    layers: [
      { kind: "noise", filter: "bandpass", from: 2200, to: 520, q: 1.1, gain: 0.5, attack: 0.008, decay: 0.13 },
    ],
  },

  // Contact. Noise for the crack, a sine for the weight behind it. Both are
  // short: a hit that rings is a hit you hear over the next one.
  hit: {
    cooldownMs: 25,
    layers: [
      { kind: "noise", filter: "lowpass", from: 4200, to: 700, q: 0.9, gain: 0.75, attack: 0.002, decay: 0.1 },
      { kind: "tone", wave: "sine", from: 180, to: 60, gain: 0.6, attack: 0.003, decay: 0.16 },
    ],
  },

  // The one cue allowed to be long. A KO is the only thing in the Arena that
  // ends anything, and it has to land over the top of whatever else is going on.
  ko: {
    cooldownMs: 250,
    layers: [
      { kind: "tone", wave: "sine", from: 320, to: 40, gain: 0.9, attack: 0.004, decay: 0.75 },
      { kind: "noise", filter: "lowpass", from: 5200, to: 300, q: 0.7, gain: 0.55, attack: 0.002, decay: 0.55 },
      { kind: "tone", wave: "triangle", from: 900, to: 120, gain: 0.28, attack: 0.01, decay: 0.4, delay: 0.02 },
    ],
  },

  respawn: {
    cooldownMs: 120,
    layers: [
      { kind: "tone", wave: "triangle", from: 220, to: 880, gain: 0.32, attack: 0.01, decay: 0.22 },
    ],
  },

  jump: {
    cooldownMs: 60,
    layers: [
      { kind: "tone", wave: "triangle", from: 260, to: 620, gain: 0.28, attack: 0.005, decay: 0.11 },
      { kind: "noise", filter: "highpass", from: 900, to: 2600, q: 0.7, gain: 0.16, attack: 0.004, decay: 0.09 },
    ],
  },

  // The second jump is a separate cue rather than a pitched-up `jump`, because
  // knowing you have already spent it is worth hearing.
  double_jump: {
    cooldownMs: 60,
    layers: [
      { kind: "tone", wave: "triangle", from: 420, to: 980, gain: 0.24, attack: 0.004, decay: 0.1 },
      { kind: "noise", filter: "highpass", from: 1400, to: 3400, q: 0.7, gain: 0.14, attack: 0.004, decay: 0.08 },
    ],
  },

  land: {
    cooldownMs: 50,
    layers: [
      { kind: "noise", filter: "lowpass", from: 1200, to: 180, q: 0.8, gain: 0.42, attack: 0.002, decay: 0.1 },
      { kind: "tone", wave: "sine", from: 120, to: 48, gain: 0.34, attack: 0.003, decay: 0.12 },
    ],
  },

  dodge: {
    cooldownMs: 80,
    layers: [
      { kind: "noise", filter: "bandpass", from: 700, to: 2400, q: 3.2, gain: 0.3, attack: 0.012, decay: 0.16 },
    ],
  },

  // ------------------------------------------------------------- the specials
  //
  // Four cues that exist purely for character. This is where synthesis earns
  // its keep over a generic impact pack: a chomp, a squirt, a sizzle and a
  // boing are cheap to describe and impossible to find off the shelf.

  /** The Glizzy's Snap — two hard clacks, jaws closing. */
  special_snap: {
    cooldownMs: 90,
    layers: [
      { kind: "noise", filter: "bandpass", from: 2600, to: 900, q: 2.4, gain: 0.5, attack: 0.002, decay: 0.05 },
      { kind: "noise", filter: "bandpass", from: 1800, to: 600, q: 2.4, gain: 0.55, attack: 0.002, decay: 0.07, delay: 0.06 },
      { kind: "tone", wave: "sine", from: 150, to: 70, gain: 0.4, attack: 0.004, decay: 0.14, delay: 0.06 },
    ],
  },

  /** Ketchup's Splat — a wet upward squirt, then the blob leaving the bottle. */
  special_splat: {
    cooldownMs: 90,
    layers: [
      { kind: "noise", filter: "bandpass", from: 400, to: 2800, q: 4.5, gain: 0.42, attack: 0.006, decay: 0.12 },
      { kind: "tone", wave: "sine", from: 640, to: 150, gain: 0.34, attack: 0.006, decay: 0.18, delay: 0.03 },
    ],
  },

  /** The Grill's Flare-Up — coals catching. See the stretch note in `cueFor`. */
  special_flare: {
    cooldownMs: 120,
    layers: [
      { kind: "noise", filter: "highpass", from: 600, to: 5200, q: 0.6, gain: 0.34, attack: 0.16, decay: 0.3 },
      { kind: "noise", filter: "lowpass", from: 300, to: 2400, q: 0.9, gain: 0.5, attack: 0.2, decay: 0.34 },
      { kind: "tone", wave: "sawtooth", from: 70, to: 210, gain: 0.2, attack: 0.22, decay: 0.28 },
    ],
  },

  /** Corn Dog's Pogo — a stick, a spring, a bounce. */
  special_pogo: {
    cooldownMs: 90,
    layers: [
      { kind: "tone", wave: "square", from: 780, to: 190, gain: 0.26, attack: 0.004, decay: 0.16 },
      { kind: "tone", wave: "sine", from: 240, to: 900, gain: 0.24, attack: 0.006, decay: 0.14, delay: 0.09 },
    ],
  },
};

export const CUE_IDS = Object.keys(CUES);

/** Which special cue each `attack.kind` sounds like. Keys are `SPECIALS` ids. */
export const SPECIAL_CUES = {
  snap: "special_snap",
  splat: "special_splat",
  flare: "special_flare",
  pogo: "special_pogo",
};

/**
 * Master gain, applied once by the engine. Low on purpose: this is a browser
 * tab someone left open, not a console game with a volume slider on the box.
 */
export const MASTER_GAIN = 0.5;

/**
 * Most a single cue may be scaled up by a modulation. A hit at 300% should be
 * heavier than a hit at 10%, but not four times as loud — past this the mix
 * stops being a mix and becomes whoever is winning.
 */
export const MAX_CUE_GAIN = 1.6;

const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/**
 * Where a sound sits in the stereo field, from a Fighter's stage x.
 *
 * Takes the sim's `STAGE` as an argument rather than importing it, for the same
 * reason `buildScene(STAGE)` does: the browser's specifier for `brawl-sim.js`
 * (`/brawl/sim.js`) is not the server's, so a shared module cannot name it.
 * With no stage, everything is centred — never silent.
 */
export function panFor(x, stage) {
  if (!stage || !Number.isFinite(x)) return 0;
  const g = stage.ground;
  if (!g || !(g.x2 > g.x1)) return 0;
  const mid = (g.x1 + g.x2) / 2;
  const half = (g.x2 - g.x1) / 2;
  // Capped well short of hard-panned: a Fighter at the ledge should sit to one
  // side, not vanish from an ear.
  return clamp((x - mid) / half, -1, 1) * 0.7;
}

// ----------------------------------------------------------- server events
//
// The Arena only forwards three events to clients — `hit`, `ko` and `respawn`
// (`brawl.js`, `pendingEvents`). Those are exactly the ones a client cannot
// work out for itself, because they are the consequence of *other* Fighters'
// inputs, which it does not have. Everything else is derived from state below.
//
// Splitting it this way is also what removes the double-fire problem: your own
// swings are predicted locally and would otherwise sound once on prediction and
// again on the server's echo. Impacts come only from events, movement comes
// only from transitions, and no cue has two sources to be deduplicated between.

/**
 * The cue for a server event, or null for an event that makes no sound.
 *
 * @param {object} ev    a `hit` / `ko` / `respawn` event off the wire
 * @param {object} opts  `{ stage }` — the sim's STAGE, for panning
 */
export function cueFor(ev, opts = {}) {
  if (!ev || typeof ev !== "object") return null;
  const stage = opts.stage;

  if (ev.type === "hit") {
    const damage = Number.isFinite(ev.damage) ? ev.damage : 5;
    const percent = Number.isFinite(ev.percent) ? ev.percent : 0;
    return {
      id: "hit",
      // A jab does 4, a heavy does 14, Flare-Up does 18. Loud enough to rank
      // them, not so loud that a jab is inaudible next to a smash.
      gain: clamp(0.55 + damage / 26, 0.55, MAX_CUE_GAIN),
      // Damage accumulates and so does the pitch drop: the same jab lands
      // heavier at 180% than at 10%, which is exactly what the sim does to the
      // knockback. Nothing is being invented here, it is being made audible.
      rate: clamp(1.2 - percent / 420, 0.62, 1.2),
      pan: panFor(ev.x, stage),
      stretch: 1,
    };
  }

  if (ev.type === "ko") {
    const percent = Number.isFinite(ev.percent) ? ev.percent : 100;
    return {
      id: "ko",
      gain: 1,
      rate: clamp(1.1 - percent / 500, 0.7, 1.1),
      // A KO happens off-screen past a blast zone; there is no honest x to pan
      // it to and the event does not carry one.
      pan: 0,
      stretch: 1,
    };
  }

  if (ev.type === "respawn") {
    return { id: "respawn", gain: 0.8, rate: 1, pan: 0, stretch: 1 };
  }

  return null;
}

// --------------------------------------------------------- state transitions
//
// Swings, jumps, landings and dodges are not events — they are things that
// become true about a Fighter. The client's local arena already knows them for
// everybody: its own Fighter by prediction, everyone else by the snapshot it
// folded in. Deriving the cues from that costs no bandwidth and needs no change
// to the sim's event vocabulary.

/**
 * The slice of a Fighter this module needs, and nothing else.
 *
 * Reducing first is what makes the watcher cheap (it keeps one of these per
 * Fighter per tick, not a whole snapshot) and the tests legible — a transition
 * test is two small literals, not two simulated arenas.
 */
export function fighterAudioState(f) {
  const a = f.attack || null;
  return {
    id: f.id,
    x: f.x,
    vy: f.vy,
    onGround: !!f.onGround,
    state: f.state,
    dodging: (f.dodgeTicks || 0) > 0,
    // An attack has no identity on the wire, so one is composed from the shape
    // the sim reports. Combined with the frame counter below it is enough to
    // tell "still mid-swing" from "swinging again".
    attackSig: a ? `${a.kind || ""}:${a.startup}:${a.active}:${a.endlag}` : null,
    attackKind: a ? a.kind || null : null,
    attackFrame: a ? a.frame || 0 : 0,
    attackStartup: a && Number.isFinite(a.startup) ? a.startup : 3,
    attackActive: a && Number.isFinite(a.active) ? a.active : 3,
  };
}

/**
 * Reference startup, in ticks, that the swing recipe was voiced at. A move
 * faster than this sounds shorter and higher; a slower one longer and lower.
 */
const SWING_REFERENCE_STARTUP = 4;

/** Flare-Up's startup at the time the sizzle was voiced (`SPECIALS.flare`). */
const FLARE_REFERENCE_STARTUP = 12;

/**
 * Cues for everything that changed between two ticks.
 *
 * @param {object} prev  id -> `fighterAudioState`, last tick (may be empty)
 * @param {object} cur   id -> `fighterAudioState`, this tick
 * @param {object} opts  `{ stage }`
 * @returns {Array} cues, in no particular order
 */
export function transitionCues(prev, cur, opts = {}) {
  const out = [];
  const stage = opts.stage;
  if (!cur) return out;

  for (const id of Object.keys(cur)) {
    const b = cur[id];
    const a = prev ? prev[id] : null;
    // A Fighter we have never seen has not *changed* — it arrived. Sounding off
    // for its current state would fire a burst of swings and landings at
    // whoever just opened the page.
    if (!a) continue;

    const pan = panFor(b.x, stage);
    const hurt = b.state === "hitstun" || b.state === "respawn";

    // -- a swing starts ---------------------------------------------------
    if (b.attackSig && startedSwinging(a, b)) out.push(swingCue(b, pan));

    // -- feet leave the ground --------------------------------------------
    // Only upward, and never while hurt: knockback takes a Fighter off the
    // ground too, and that already has a sound of its own.
    if (a.onGround && !b.onGround && b.vy < -50 && !hurt) {
      out.push({ id: "jump", gain: 1, rate: 1, pan, stretch: 1 });
    }

    // -- a second jump ----------------------------------------------------
    // Airborne throughout, and suddenly moving up much harder than it was.
    // Gravity can only ever make vy *larger*, so a large negative step is
    // something the Fighter did, not something it fell into.
    if (!a.onGround && !b.onGround && !hurt && b.vy < -300 && b.vy < a.vy - 200) {
      out.push({ id: "double_jump", gain: 1, rate: 1, pan, stretch: 1 });
    }

    // -- and come back down ------------------------------------------------
    if (!a.onGround && b.onGround) {
      // How hard, from how fast it was falling. A step off a platform should
      // not sound like a spike from the top one.
      const speed = clamp(Math.abs(a.vy) / 900, 0.25, 1.4);
      out.push({ id: "land", gain: 0.55 + speed * 0.6, rate: clamp(1.25 - speed * 0.35, 0.7, 1.25), pan, stretch: 1 });
    }

    // -- a dodge -----------------------------------------------------------
    if (!a.dodging && b.dodging) {
      out.push({ id: "dodge", gain: 1, rate: 1, pan, stretch: 1 });
    }
  }

  return out;
}

/**
 * Whether `b` is a swing that has just begun rather than one already in flight.
 *
 * The easy two cases are an attack appearing where there was none, and a
 * different move replacing the last one. The third is the same move thrown
 * twice in a row, which the input buffer makes routine, and it is the reason
 * this is a function and not an expression.
 *
 * A repeat shows up as the frame counter going backwards — but so does an
 * ordinary snapshot landing on a remote Fighter, because the local arena
 * predicts every tick while snapshots arrive on every second one, so its copy
 * of an attack runs a frame or two ahead and gets pulled back. Firing on any
 * decrease would sound a second swing on every attack anyone else throws.
 *
 * A real repeat restarts at the top of the move from near the end of the last
 * one, so it is both a *large* jump backwards and a landing at frame zero.
 * A correction is neither.
 */
function startedSwinging(a, b) {
  if (!a.attackSig) return true;
  if (a.attackSig !== b.attackSig) return true;
  return b.attackFrame <= 1 && a.attackFrame - b.attackFrame >= 4;
}

/**
 * The cue for an attack that has just started.
 *
 * A special gets its own voice; everything else is one `swing` recipe stretched
 * and pitched by the move's own frame data. That is on purpose — there is no
 * table here mapping `light_side` to a sound. The sim reports how long a move
 * takes to come out, so a jab is short and high and a heavy is long and low
 * *because the sim says so*, and a balance change to the frame data changes how
 * the move sounds without anything here being edited. Same rule the art follows:
 * a duration the presentation layer plays is a duration the sim reports.
 */
function swingCue(f, pan) {
  const special = f.attackKind ? SPECIAL_CUES[f.attackKind] : null;
  if (special) {
    // Flare-Up is the Arena's one long telegraph, and the coals in
    // `FLOURISHES.flare` are its only visual warning. The sizzle is now its
    // second, so it must last exactly as long — derived from the startup the
    // sim reports, never from a constant that can drift away from it.
    const stretch =
      special === "special_flare" ? clamp(f.attackStartup / FLARE_REFERENCE_STARTUP, 0.35, 2.5) : 1;
    return { id: special, gain: 1, rate: 1, pan, stretch };
  }

  const windup = clamp(f.attackStartup / SWING_REFERENCE_STARTUP, 0.4, 2.6);
  return {
    id: "swing",
    // A heavy is a bigger noise than a jab, but the jab is thrown ten times as
    // often — so this range is narrow on purpose.
    gain: clamp(0.55 + windup * 0.28, 0.55, 1.15),
    rate: clamp(1.35 - f.attackStartup * 0.055, 0.6, 1.35),
    pan,
    stretch: windup,
  };
}
