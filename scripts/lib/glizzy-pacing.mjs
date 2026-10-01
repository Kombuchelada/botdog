// GlizzyClicker pacing math: how fast can a player — or a bot — work through
// the upgrade catalog? Two pieces, both pure (no DB, no clock):
//
//   goldenK   Monte Carlo of the golden-glizzy buff system, returning K =
//             mean income ÷ base production. Mirrors glizzy.js: same reward
//             table, eclipse/queue per group, durations × the duration
//             modifier, instant grants priced off the *buffed* rate.
//   simulate  Replays a saved state forward, buying the way an automated
//             player does, with income = K · perSecond from the real
//             computeEffectiveRates.
//
// Calibration: Randy's backups (25.8 clicks/s, every golden caught, 98/99
// upgrades) show income running at ~49× base production for weeks on end;
// goldenK reproduces that with one claim every ~230 s. See
// docs/glizzy-pacing.md.

import { GOLDEN_BONUSES } from "../../glizzy.js";

const TOTAL_WEIGHT = GOLDEN_BONUSES.reduce((s, b) => s + b.weight, 0);
const DAY = 86400;

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * K for one way of playing. `cps` is sustained clicks/s (0 = idler, 25 = the
 * anti-cheat ceiling). `claimEvery` is seconds between golden claims, or
 * "client" for the game's own spawn timer. `topShare` is the best building's
 * share of production (what Overdrive multiplies). The fixed click ladder is
 * left out: past the mid-game it is ~0.002% of a click.
 */
export function goldenK({
  cps = 25, share = 0.1, frequency = 1, duration = 1, payout = 1,
  topShare = 0.66, claimEvery = "client", catchRate = 1, days = 20, seed = 1,
}) {
  const rand = rng(seed);
  const minI = Math.max(45, Math.round(240 / frequency));
  const maxI = Math.max(minI + 30, Math.round(720 / frequency));
  const effects = [];
  const strongest = (group, t) => {
    let m = 1;
    for (const e of effects) if (e.group === group && e.start <= t && e.end > t && e.mult > m) m = e.mult;
    return m;
  };
  const rates = (t) => {
    const pps = strongest("prod", t) * (1 - topShare + topShare * strongest("building", t));
    const click = strongest("click", t);
    return { pps, perClick: pps * share * click, income: pps * (1 + share * cps * click) };
  };
  const addBuff = (group, mult, dur, now) => {
    let start = now;
    for (let hops = 0; hops < 20; hops++) {
      const blocker = effects.find((e) => e.group === group && e.mult >= mult && e.start <= start && e.end > start);
      if (!blocker) break;
      start = blocker.end;
    }
    effects.push({ group, mult, start, end: start + dur });
  };
  const nextGap = () => (typeof claimEvery === "number" ? claimEvery : minI + rand() * (maxI - minI));

  const T = days * DAY;
  let next = nextGap(), earned = 0;
  for (let t = 0; t < T; t++) {
    if (t >= next) {
      if (rand() < catchRate) {
        let r = rand() * TOTAL_WEIGHT, def = GOLDEN_BONUSES[GOLDEN_BONUSES.length - 1];
        for (const b of GOLDEN_BONUSES) if ((r -= b.weight) < 0) { def = b; break; }
        const now = rates(t);
        const base = Math.max(now.pps, now.perClick);
        // A long-running player's bank is huge, so Lucky! always hits its cap.
        if (def.kind === "prod_seconds") earned += base * def.seconds * payout;
        else if (def.kind === "bank_pct") earned += base * def.capSec * payout;
        else {
          const group = def.kind === "prod_mult" ? "prod" : def.kind === "click_mult" ? "click" : "building";
          addBuff(group, def.mult, Math.round(def.durationSec * duration), t);
        }
      }
      next = t + nextGap();
    }
    if (t % 600 === 0) for (let i = effects.length - 1; i >= 0; i--) if (effects[i].end < t) effects.splice(i, 1);
    earned += rates(t).income;
  }
  return earned / T;
}

/**
 * Ways to play, from what Randy actually does to the most a rule-abiding bot
 * could. `claimEvery: 116` is the server's claim floor with both frequency
 * upgrades — a script POSTing /api/game/golden on that cadence. Glizzy Pope
 * (×6) and an unbroken streak (+2%/day, uncapped) are the hot-dog bonuses at
 * their most generous. `kScale` covers the anti-cheat's 1.2× overage slack
 * and anything this model misses.
 */
export const SCENARIOS = {
  realistic: { cps: 25.8, claimEvery: 230, milestone: 2, streak: false },
  api_bot: { cps: 25.8, claimEvery: 116, milestone: 2, streak: false },
  paranoid: { cps: 25, claimEvery: 116, milestone: 6, streak: true },
  paranoid_x2: { cps: 25, claimEvery: 116, milestone: 6, streak: true, kScale: 2 },
};

/**
 * Replay `startState` forward for `years`. Each step the player buys any
 * affordable upgrade on sight (cheapest first — Randy's script), otherwise
 * saves for whatever pays back fastest: cost ÷ Δincome plus the wait, which
 * is the Oracle's rule made income-aware. Pass `scen.k` to skip the Monte
 * Carlo (tests do); otherwise K is computed per golden/click setup and cached.
 *
 * Returns the purchase log as seconds from the start.
 */
export function simulate(G, startState, scen, { years = 10 } = {}) {
  const kCache = new Map();
  const byId = new Map(G.UPGRADES.map((u) => [u.id, u]));
  const K = (st) => {
    if (scen.k) return scen.k;
    const gm = G.computeGoldenModifiers(st);
    const share = st.upgrades_owned.reduce((s, id) => s + (byId.get(id)?.effect.type === "click_from_pps" ? byId.get(id).effect.value : 0), 0);
    const key = [gm.frequency, gm.duration, gm.payout, share].join("|");
    if (!kCache.has(key)) {
      const ks = [1, 2].map((seed) => goldenK({ ...scen, ...gm, share, seed }));
      kCache.set(key, ((ks[0] + ks[1]) / 2) * (scen.kScale || 1));
    }
    return kCache.get(key);
  };
  const bonuses = (day) => {
    const b = [{ effect: { type: "global_mult", value: scen.milestone || 1 } }];
    if (scen.streak && day >= 3) b.push({ effect: { type: "global_mult", value: 1 + 0.02 * day } });
    return b;
  };
  const income = (st, day) => K(st) * G.computeEffectiveRates(st, bonuses(day), 0).perSecond;

  const st = structuredClone(startState);
  st.golden_effects = [];
  st.buildings = { ...st.buildings };
  const owned = new Set(st.upgrades_owned);
  let bank = st.glizzies || 0, t = 0;
  const end = years * 365.25 * DAY;
  const bought = [];

  while (t < end) {
    const day = Math.floor(t / DAY);
    const unowned = G.UPGRADES.filter((u) => !owned.has(u.id));
    let pick = unowned.filter((u) => u.cost <= bank).sort((a, b) => a.cost - b.cost)[0];
    let target;
    if (pick) {
      target = { cost: pick.cost, apply: (s) => s.upgrades_owned.push(pick.id), id: pick.id };
    } else {
      const cur = income(st, day);
      let best = null;
      const consider = (id, cost, apply) => {
        const s2 = { ...st, buildings: { ...st.buildings }, upgrades_owned: st.upgrades_owned.slice() };
        apply(s2);
        const gain = income(s2, day) - cur;
        if (gain <= 0) return;
        const score = Math.max(0, cost - bank) / cur + cost / gain;
        if (!best || score < best.score) best = { id, cost, apply, score };
      };
      for (const b of G.BUILDINGS) {
        consider(null, G.buildingCost(b.id, st.buildings[b.id] || 0), (s) => { s.buildings[b.id] = (s.buildings[b.id] || 0) + 1; });
      }
      for (const u of unowned) consider(u.id, u.cost, (s) => s.upgrades_owned.push(u.id));
      if (!best) break;
      target = best;
    }
    // Save up — but wake the moment any upgrade comes into reach, and at
    // every day boundary so a streak keeps compounding.
    const cheapestUp = unowned.length ? Math.min(...unowned.map((u) => u.cost)) : Infinity;
    const waitTo = Math.min(target.cost, cheapestUp);
    while (bank < waitTo && t < end) {
      const d = Math.floor(t / DAY);
      const rate = income(st, d);
      const dt = Math.min((waitTo - bank) / rate, (d + 1) * DAY - t + 1e-6);
      bank += rate * dt;
      t += dt;
    }
    if (t >= end) break;
    if (bank < target.cost) continue;
    bank -= target.cost;
    target.apply(st);
    if (target.id) { owned.add(target.id); bought.push({ id: target.id, t }); }
  }
  return { bought, state: st };
}
