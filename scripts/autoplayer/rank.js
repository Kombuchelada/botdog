// The Autoplayer's purchase decision. Pure: everything it needs is passed in,
// so the page runs it against game.js's computeRatesFor and the tests run it
// against glizzy.js's computeEffectiveRates.
//
// It's the Oracle's ranking (docs/oracle.md) with one change: an Autoplayer
// clicks at a known rate, so click upgrades have a known value and are priced
// at Δ(perSecond + cps × perClick) instead of being skipped. Golden upgrades
// still can't be priced (their value is how many glizzies you catch, which is
// a Monte Carlo — docs/glizzy-pacing.md), so they're bought as soon as they're
// affordable instead of ranked.
//
// No imports and no top-level code besides the exports: the launcher strips
// the `export` keywords and injects this file into the page as-is.

export const GOLDEN_EFFECTS = ["golden_frequency", "golden_duration", "golden_payout"];

// Ranked candidates, best (lowest payback) first. Buildings are priced ×1.
//   state        { buildings, upgrades_owned, glizzies }
//   catalog      { buildings: [{id, name}], upgrades: [{id, name, cost, effect}] }
//   ratesFor(st) → { perSecond, perClick } for a state of the same shape
//   nextCost(id) → price of the next one of building `id`
//   cps          clicks per second the Autoplayer delivers
export function rankPurchases({ state, catalog, ratesFor, nextCost, cps }) {
  // Golden buffs are stripped from both sides, as in the Oracle: a running
  // Frenzy would otherwise churn the target for its whole duration.
  const base = { buildings: state.buildings, upgrades_owned: state.upgrades_owned, golden_effects: [] };
  const value = (st) => {
    const r = ratesFor(st);
    return r.perSecond + cps * r.perClick;
  };
  const baseValue = value(base);
  const out = [];

  for (const b of catalog.buildings) {
    const cost = nextCost(b.id);
    if (!Number.isFinite(cost)) continue;
    const buildings = { ...base.buildings, [b.id]: (base.buildings[b.id] || 0) + 1 };
    const delta = value({ ...base, buildings }) - baseValue;
    if (delta > 0) out.push({ kind: "building", id: b.id, name: b.name, cost, delta, payback: cost / delta });
  }

  const owned = new Set(state.upgrades_owned);
  for (const u of catalog.upgrades) {
    if (owned.has(u.id) || GOLDEN_EFFECTS.includes(u.effect.type)) continue;
    const delta = value({ ...base, upgrades_owned: [...base.upgrades_owned, u.id] }) - baseValue;
    if (delta > 0) out.push({ kind: "upgrade", id: u.id, name: u.name, cost: u.cost, delta, payback: u.cost / delta });
  }

  out.sort((a, b) => a.payback - b.payback);
  return out;
}

// What to do right now:
//   { buy: candidate }               — buy this, now
//   { wait: candidate, short }       — saving for this; `short` glizzies to go
//   null                             — nothing left that adds anything
// An affordable golden upgrade always comes first (cheapest of them). Otherwise
// it's the ranking's #1 or nothing: buying something cheaper while saving only
// delays the best purchase.
export function decide(args) {
  const { state, catalog } = args;
  const owned = new Set(state.upgrades_owned);
  const golden = catalog.upgrades
    .filter((u) => !owned.has(u.id) && GOLDEN_EFFECTS.includes(u.effect.type) && u.cost <= state.glizzies)
    .sort((a, b) => a.cost - b.cost)[0];
  if (golden) return { buy: { kind: "upgrade", id: golden.id, name: golden.name, cost: golden.cost } };

  const best = rankPurchases(args)[0];
  if (!best) return null;
  if (best.cost <= state.glizzies) return { buy: best };
  return { wait: best, short: best.cost - state.glizzies };
}
