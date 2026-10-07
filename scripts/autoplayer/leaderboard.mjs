// The TUI's leaderboard: /api/game/leaderboard's rows (public, top 50) with
// the player's own line swapped for their live numbers, re-ranked.
//
// Everyone else is shown as stored, the same numbers the site's leaderboard
// shows. A stored total only moves when that player saves (every 5 s while
// they're playing), and jumps by their offline earnings when they come back,
// so a player is "active" when they saved in the last two minutes. Only an
// active player's /s counts against the time it takes to pass them. Anyone
// else stands still until they come back.

const ACTIVE_MS = 2 * 60_000;

// SQLite's datetime('now'): "YYYY-MM-DD HH:MM:SS", UTC.
const parseUpdated = (s) => (s ? Date.parse(s.replace(" ", "T") + "Z") : NaN);

// rows: the API's rows. me: { userId, lifetime, income } with income in /s.
// Returns everyone ranked, plus my rank and how long until I pass the player
// above me (null if I'm first, Infinity if I'm not catching up).
export function standings(rows, me, now = Date.now()) {
  const list = rows
    .filter((r) => r.user_id !== me.userId)
    .map((r) => ({
      userId: r.user_id,
      name: r.name || "?",
      lifetime: Number(r.lifetime) || 0,
      perSecond: Number(r.per_second) || 0,
      active: now - parseUpdated(r.updated_at) < ACTIVE_MS,
      me: false,
    }));
  list.push({ userId: me.userId, name: "you", lifetime: me.lifetime, perSecond: me.income, active: true, me: true });
  list.sort((a, b) => b.lifetime - a.lifetime);
  list.forEach((r, i) => { r.rank = i + 1; });

  const i = list.findIndex((r) => r.me);
  // The API returns only the top 50. Off the end of it, the row above isn't
  // really the next player up, so there's no honest ETA.
  const offBoard = i === list.length - 1 && rows.length >= 50;
  let passIn = null;
  if (i > 0 && !offBoard) {
    const above = list[i - 1];
    const closing = me.income - (above.active ? above.perSecond : 0);
    passIn = closing > 0 ? (above.lifetime - me.lifetime) / closing : Infinity;
  }
  return { list, myRank: offBoard ? null : i + 1, passIn };
}
