import {
  db,
  getAllEventsStmt,
  getLeaderboardStmt,
  getTotalHotdogsStmt,
  getArchiveState,
  setArchiveState,
} from "./database.js";
import {
  buildUserDatesMap,
  getCurrentStreak,
  toPacificDateKey,
  parseUtcTimestamp,
} from "./stats.js";
import { DiscordRequest } from "./utils.js";

const STATE_LAST_DIGEST_DATE = "last_digest_date";
const POST_HOUR_PACIFIC = 9; // post at/after 9 AM Pacific each day

function log(...args) {
  console.log("[digest]", ...args);
}
function warn(...args) {
  console.warn("[digest]", ...args);
}

function pacificHour(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    hour: "numeric",
    hour12: false,
  }).formatToParts(date);
  let h = parseInt(parts.find((p) => p.type === "hour")?.value || "0", 10);
  if (h === 24) h = 0;
  return h;
}

function shiftDayKey(key, deltaDays) {
  const d = new Date(key + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return toPacificDateKey(d);
}

function getDigestChannel() {
  return (
    process.env.DIGEST_CHANNEL_ID ||
    process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID ||
    process.env.ARCHIVE_CHANNEL_ID ||
    null
  );
}

export function isDigestConfigured() {
  return !!(process.env.DISCORD_TOKEN && getDigestChannel());
}

function buildDigest(forDateKey) {
  const events = getAllEventsStmt.all();
  const yesterdayEvents = events.filter(
    (e) => toPacificDateKey(parseUtcTimestamp(e.timestamp)) === forDateKey,
  );
  const perUser = new Map();
  for (const e of yesterdayEvents) {
    perUser.set(e.user_id, (perUser.get(e.user_id) || 0) + e.amount);
  }
  const sortedUsers = Array.from(perUser.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([uid, amt]) => ({ user_id: uid, amount: amt }));
  const totalYesterday = sortedUsers.reduce((s, u) => s + u.amount, 0);
  const totalServer = getTotalHotdogsStmt.get().total_hotdogs || 0;

  // Active streaks (live users with current streak >= 3)
  const datesMap = buildUserDatesMap(events);
  const activeStreaks = [];
  for (const [uid, dates] of datesMap.entries()) {
    const s = getCurrentStreak(dates);
    if (s >= 3) activeStreaks.push({ user_id: uid, streak: s });
  }
  activeStreaks.sort((a, b) => b.streak - a.streak);

  return {
    forDateKey,
    totalYesterday,
    sortedUsers,
    totalServer,
    activeStreaks,
    contributorCount: sortedUsers.length,
  };
}

function buildEmbed(d) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const niceDate = new Date(d.forDateKey + "T12:00:00Z").toLocaleDateString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const fields = [];
  if (d.sortedUsers.length > 0) {
    const top = d.sortedUsers
      .slice(0, 5)
      .map((u) => `<@${u.user_id}> — **${u.amount}**`)
      .join("\n");
    fields.push({ name: `Yesterday's eaters (${d.contributorCount})`, value: top, inline: false });
  } else {
    fields.push({
      name: "Yesterday",
      value: "_Nobody logged a dog. The streak is in danger._",
      inline: false,
    });
  }

  if (d.activeStreaks.length > 0) {
    const streaks = d.activeStreaks
      .slice(0, 5)
      .map((s) => `<@${s.user_id}> — **${s.streak}** day${s.streak === 1 ? "" : "s"} 🔥`)
      .join("\n");
    fields.push({ name: "Active streaks", value: streaks, inline: false });
  }

  const description = d.totalYesterday > 0
    ? `**${d.totalYesterday}** dog${d.totalYesterday === 1 ? "" : "s"} eaten ${niceDate}.\nServer total: **${d.totalServer}**.`
    : `No dogs logged for ${niceDate}.\nServer total still at **${d.totalServer}**.`;

  const embed = {
    title: `🌭 Daily Glizzy Report`,
    description,
    color: 0xff6b35,
    fields,
    footer: { text: "Year of the Glizzy" },
    timestamp: new Date().toISOString(),
  };
  if (base) embed.url = base;
  return embed;
}

export async function runDigestIfDue() {
  if (!isDigestConfigured()) return { sent: false, reason: "not_configured" };

  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const lastDigestKey = getArchiveState(STATE_LAST_DIGEST_DATE);
  if (lastDigestKey === todayKey) return { sent: false, reason: "already_sent_today" };
  if (pacificHour(now) < POST_HOUR_PACIFIC) return { sent: false, reason: "too_early" };

  const yesterdayKey = shiftDayKey(todayKey, -1);
  const d = buildDigest(yesterdayKey);
  const embed = buildEmbed(d);
  const channelId = getDigestChannel();
  try {
    await DiscordRequest(`channels/${channelId}/messages`, {
      method: "POST",
      body: { embeds: [embed] },
    });
    setArchiveState(STATE_LAST_DIGEST_DATE, todayKey);
    log(`posted digest for ${yesterdayKey} to channel ${channelId} (${d.totalYesterday} dogs by ${d.contributorCount} users)`);
    return { sent: true };
  } catch (err) {
    warn(`failed to post digest:`, err.message);
    return { sent: false, reason: err.message };
  }
}

/**
 * Force a digest post for "yesterday" right now, bypassing the hour-of-day gate.
 * Used by the admin "Send digest now" button. Still updates last_digest_date so
 * the scheduled job won't double-post.
 */
export async function runDigestNow() {
  if (!isDigestConfigured()) throw new Error("DIGEST_CHANNEL_ID and DISCORD_TOKEN required");
  const now = new Date();
  const todayKey = toPacificDateKey(now);
  const yesterdayKey = shiftDayKey(todayKey, -1);
  const d = buildDigest(yesterdayKey);
  const embed = buildEmbed(d);
  const channelId = getDigestChannel();
  await DiscordRequest(`channels/${channelId}/messages`, {
    method: "POST",
    body: { embeds: [embed] },
  });
  setArchiveState(STATE_LAST_DIGEST_DATE, todayKey);
  return d;
}
