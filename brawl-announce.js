// GlizzyBrawl — "someone stepped into the Arena" notifications.
//
// Lives outside `brawl.js` on purpose: the Arena's job is the sim, the socket
// and the ledger, and it reaches the outside world through named seams. This
// is one more of them — a single fire-and-forget call the Arena makes, which
// can fail, be unconfigured, or be deleted entirely without the game noticing.
//
// Every join would be too many messages. A join happens on a page load, on a
// reconnect, on being promoted out of the queue, and every time an AFK'd
// Fighter touches a key — so a player who leaves the tab open all afternoon
// would carpet-bomb the channel. The rule is one announcement per player per
// quiet period; a genuinely new arrival always gets one.

import { DiscordRequest } from "./utils.js";

const QUIET_MS = 30 * 60 * 1000;

/** user id -> ms timestamp of the last announcement we posted for them. */
const lastAnnouncedAt = new Map();

function announceChannel() {
  return (
    process.env.BRAWL_ANNOUNCE_CHANNEL_ID ||
    process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID ||
    process.env.ARCHIVE_CHANNEL_ID ||
    null
  );
}

export function isBrawlAnnounceConfigured() {
  return !!(process.env.DISCORD_TOKEN && announceChannel());
}

/** Test/admin hook: forget who we've announced, so the next join posts again. */
export function resetBrawlAnnounceCooldowns() {
  lastAnnouncedAt.clear();
}

function buildEmbed({ name, characterName, fighters }) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const others = Math.max(0, fighters - 1);
  const description =
    others === 0
      ? `**${name}** is warming up as **${characterName}** — the Arena is empty.\nGo take a swing at them.`
      : `**${name}** joined as **${characterName}** — **${fighters}** in the Arena right now.`;

  const embed = {
    title: "🥊 Someone's in the Arena",
    description,
    color: 0xff6b35,
    footer: { text: "GlizzyBrawl" },
    timestamp: new Date().toISOString(),
  };
  if (base) embed.url = `${base}/brawl`;
  return embed;
}

/**
 * Post a join announcement, unless this player has had one recently.
 *
 * Never throws and never rejects — the caller is the join path, and a Discord
 * outage must not be able to keep anyone out of the Arena.
 *
 * @param {{ userId: string, name: string, characterName: string, fighters: number }} join
 * @returns {Promise<{ sent: boolean, reason?: string }>}
 */
export async function announceArenaJoin({ userId, name, characterName, fighters }) {
  if (!isBrawlAnnounceConfigured()) return { sent: false, reason: "not_configured" };
  if (!userId) return { sent: false, reason: "no_user" };

  const now = Date.now();
  const last = lastAnnouncedAt.get(userId);
  if (last && now - last < QUIET_MS) return { sent: false, reason: "quiet_period" };
  // Claim the slot before the await: two joins racing (a reconnect landing on
  // top of a page load) must not both get past the check.
  lastAnnouncedAt.set(userId, now);

  try {
    await DiscordRequest(`channels/${announceChannel()}/messages`, {
      method: "POST",
      body: { embeds: [buildEmbed({ name, characterName, fighters })] },
    });
    return { sent: true };
  } catch (err) {
    // Let them try again rather than eating the announcement for half an hour.
    lastAnnouncedAt.delete(userId);
    console.warn(`[brawl] join announcement failed: ${err.message}`);
    return { sent: false, reason: err.message };
  }
}
