// The Year of the Glizzy's finale: what happens once, at 12:01 AM Pacific on
// New Year's Day, when the season (season.js) is over.
//
//   1. The results embed goes to Discord — champion, podium, awards.
//   2. The season's last partial week gets its stories (the weekly job stops
//      at the season end, so without this those days would never be covered).
//   3. Claude writes the Year in Review, which is published to the archive and
//      announced like any other story.
//
// Each step records that it happened in archive_state, so a restart or deploy
// picks up where the last one left off and nothing posts twice. The Year in
// Review is retried a few times, then left for a human (it costs money, and a
// failure that repeats is one a person should look at).

import {
  getAllEventsStmt,
  getArchiveState,
  setArchiveState,
  insertArchiveStoryStmt,
  listPublishedStoriesStmt,
  getArchiveAttachmentByIdStmt,
  getArchiveMessagesInRangeStmt,
  getArchiveAttachmentsForMessageStmt,
  getUserProfileStmt,
} from "./database.js";
import { computeAwards } from "./awards.js";
import { isSeasonOver, SEASON_END, SEASON_LAST_DAY_KEY } from "./season.js";
import { getDisplayName } from "./profiles.js";
import { toPacificDateKey, parseUtcTimestamp } from "./stats.js";
import { writeYearInReview, isAnthropicConfigured, toPacificDateTimeString } from "./claude.js";
import { announceStory, generateStoriesForWindow, STATE_LAST_WEEKLY } from "./archive.js";
import { DiscordRequest } from "./utils.js";

const FINALE_AT_MS = SEASON_END.getTime() + 60 * 1000; // 12:01 AM Pacific
const CHECK_INTERVAL_MS = 60 * 1000;
const MAX_REVIEW_ATTEMPTS = 3;

const STATE_ANNOUNCED = "finale_announced_at";
const STATE_FINAL_WEEK = "finale_final_week_at";
export const STATE_REVIEW_STORY_ID = "year_in_review_story_id";
export const STATE_REVIEW_ATTEMPTS = "year_in_review_attempts";

function log(...args) {
  console.log("[finale]", ...args);
}
function warn(...args) {
  console.warn("[finale]", ...args);
}

function announceChannel() {
  return process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID || process.env.ARCHIVE_CHANNEL_ID || null;
}

export function isFinaleDue(now = Date.now()) {
  return isSeasonOver(new Date(now)) && now >= FINALE_AT_MS;
}

/**
 * The season's results with names attached — the one shape the embed, the
 * Year in Review briefing and the memorial page all read.
 */
export function buildResults() {
  const events = getAllEventsStmt.all();
  const results = computeAwards(events);
  const named = (userIds) => userIds.map((id) => ({ id, name: getDisplayName(id) }));
  return {
    ...results,
    standings: results.standings.map((row) => ({ ...row, name: getDisplayName(row.userId) })),
    awards: results.awards.map((award) => ({ ...award, winners: named(award.userIds) })),
    months: monthlyTotals(events),
  };
}

function monthlyTotals(events) {
  const byMonth = new Map();
  for (const e of events) {
    const month = toPacificDateKey(parseUtcTimestamp(e.timestamp)).slice(0, 7);
    byMonth.set(month, (byMonth.get(month) || 0) + e.amount);
  }
  return [...byMonth.entries()].sort().map(([month, total]) => ({ month, total }));
}

// ============================================================================
// 1. The results embed
// ============================================================================

const plural = (n, unit) => `${n.toLocaleString("en-US")} ${n === 1 ? unit.replace(/s$/, "") : unit}`;
const mentions = (award) => award.userIds.map((id) => `<@${id}>`).join(", ");

export function buildResultsMessage(results) {
  const base = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  const champion = results.awards.find((a) => a.id === "champion");
  const podiumIds = new Set(["champion", "second", "third"]);

  const standings = results.standings
    .slice(0, 10)
    .map((row) => `${row.rank}. <@${row.userId}> — **${row.total.toLocaleString("en-US")}**`)
    .join("\n");
  const awards = results.awards
    .filter((a) => !podiumIds.has(a.id))
    .map((a) => `${a.emoji} **${a.name}** — ${mentions(a)} (${plural(a.value, a.unit)})`)
    .join("\n");

  const { group } = results;
  const lines = [];
  if (champion) {
    const verb = champion.userIds.length > 1 ? "share the crown" : "is the 2026 Glizzy Champion";
    lines.push(`👑 ${mentions(champion)} ${verb} with **${plural(champion.value, "dogs")}**.`);
  }
  lines.push(
    `${plural(group.participants, "people")} ate **${plural(group.total, "hot dogs")}** across ${plural(group.activeDays, "days")}.`,
  );
  if (group.bestDay) {
    const day = new Date(`${group.bestDay.dateKeys[0]}T12:00:00Z`).toLocaleDateString("en-US", {
      timeZone: "UTC",
      month: "long",
      day: "numeric",
    });
    lines.push(`The group's biggest day was ${day}: ${plural(group.bestDay.value, "dogs")}.`);
  }

  const embed = {
    title: "🏆 The Year of the Glizzy is over",
    description: lines.join("\n"),
    color: 0xff6b35,
    fields: [
      { name: "Final standings", value: standings || "_Nobody ate a hot dog._", inline: false },
      ...(awards ? [{ name: "Awards", value: awards, inline: false }] : []),
    ],
    footer: { text: "Year of the Glizzy · 2026" },
    timestamp: new Date().toISOString(),
  };
  if (base) embed.url = base;

  return {
    content: champion ? `🌭 **That's the year.** Congratulations ${mentions(champion)}!` : "🌭 **That's the year.**",
    embeds: [embed],
  };
}

async function announceResults() {
  if (getArchiveState(STATE_ANNOUNCED)) return;
  const channelId = announceChannel();
  if (!process.env.DISCORD_TOKEN || !channelId) {
    log("results announcement skipped (need DISCORD_TOKEN and an announce channel)");
    setArchiveState(STATE_ANNOUNCED, `skipped ${new Date().toISOString()}`);
    return;
  }
  const body = buildResultsMessage(buildResults());
  await DiscordRequest(`channels/${channelId}/messages`, { method: "POST", body });
  setArchiveState(STATE_ANNOUNCED, new Date().toISOString());
  log(`results announced in channel ${channelId}`);
}

// ============================================================================
// 2. The season's last partial week
// ============================================================================

async function coverFinalWeek() {
  if (getArchiveState(STATE_FINAL_WEEK)) return;
  const lastWeekly = getArchiveState(STATE_LAST_WEEKLY);
  if (lastWeekly && isAnthropicConfigured()) {
    await generateStoriesForWindow(lastWeekly, SEASON_END.toISOString(), "final week");
  }
  setArchiveState(STATE_FINAL_WEEK, new Date().toISOString());
}

// ============================================================================
// 3. The Year in Review
// ============================================================================

// Messages posted after the newest story: the stretch no story has covered
// yet. The final-week job runs first at the finale, so this is usually short —
// but a week the weekly job judged not worth a story still happened, and the
// Year in Review shouldn't go quiet about the year's last days. Capped so a
// long gap can't blow up the prompt; the newest messages are the ones kept.
const MAX_RECENT_MESSAGES = 1000;

export function recentMessages(stories) {
  const newestStoryEnd = stories.reduce(
    (latest, s) => (s.period_end > latest ? s.period_end : latest),
    "2026-01-01T08:00:00.000Z",
  );
  return getArchiveMessagesInRangeStmt
    .all(newestStoryEnd, SEASON_END.toISOString())
    .slice(-MAX_RECENT_MESSAGES)
    .map((m) => ({ ...m, hasMedia: getArchiveAttachmentsForMessageStmt.all(m.id).length > 0 }));
}

export function buildBriefing(results, stories, messages = []) {
  const standings = results.standings.map((row) => `${row.rank}. ${row.name} — ${row.total}`).join("\n");
  const awards = results.awards
    .map((a) => `${a.emoji} ${a.name} (${a.blurb}): ${a.winners.map((w) => w.name).join(", ")} — ${plural(a.value, a.unit)}`)
    .join("\n");
  const months = results.months.map((m) => `${m.month}: ${m.total}`).join("\n");
  const storyText = [...stories]
    .reverse() // listPublishedStoriesStmt is newest-first; the year reads forwards
    .map((s) => {
      const date = toPacificDateKey(new Date(s.period_end));
      let tags = [];
      try { tags = JSON.parse(s.tags || "[]"); } catch {}
      return `[story ${s.id}] week ending ${date}${tags.length ? ` · ${tags.join(", ")}` : ""}\n${s.title}\n${s.body}`;
    })
    .join("\n\n");
  const messageText = messages
    .map((m) => {
      const text = m.content && m.content.trim() ? m.content.trim() : "";
      const media = m.hasMedia ? " [photo/video]" : "";
      const profile = getUserProfileStmt.get(m.author_id);
      const name = profile?.global_name || profile?.username || m.author_name;
      return `[${toPacificDateTimeString(m.created_at)}] ${name}: ${text}${media}`;
    })
    .join("\n");
  const { group } = results;
  return [
    `THE YEAR: January 1 – ${SEASON_LAST_DAY_KEY}, Pacific time.`,
    `${group.participants} people, ${group.total} hot dogs (net of protests), ${group.activeDays} days with at least one dog.`,
    group.bestDay ? `Biggest group day: ${group.bestDay.dateKeys.join(", ")} with ${group.bestDay.value} dogs.` : "",
    `\nFINAL STANDINGS\n${standings}`,
    `\nAWARDS\n${awards}`,
    `\nDOGS PER MONTH\n${months}`,
    `\nEVERY ARCHIVE STORY OF THE YEAR (${stories.length}), oldest first\n\n${storyText}`,
    messages.length
      ? `\nRECENT MESSAGES — posted after the newest story, not yet covered by any (${messages.length}), oldest first\n\n${messageText}`
      : "",
  ].filter(Boolean).join("\n");
}

// The carousel is built from a story's source messages, so the highlights'
// cover photos become a reel of the year: for each chosen story, the message
// its hero image came from (or its first source message).
function highlightSources(highlightIds, storiesById) {
  const messageIds = [];
  let hero = null;
  for (const id of highlightIds) {
    const story = storiesById.get(id);
    if (!story) continue;
    const attachment = story.hero_attachment_id
      ? getArchiveAttachmentByIdStmt.get(story.hero_attachment_id)
      : null;
    if (attachment && !hero) hero = attachment.id;
    let sources = [];
    try { sources = JSON.parse(story.source_message_ids || "[]"); } catch {}
    const messageId = attachment?.message_id || sources[0];
    if (messageId && !messageIds.includes(messageId)) messageIds.push(messageId);
  }
  return { messageIds, hero };
}

async function publishYearInReview() {
  if (getArchiveState(STATE_REVIEW_STORY_ID)) return;
  if (!isAnthropicConfigured()) {
    log("Year in Review skipped (ANTHROPIC_API_KEY not set)");
    return;
  }
  const attempts = Number(getArchiveState(STATE_REVIEW_ATTEMPTS) || 0);
  if (attempts >= MAX_REVIEW_ATTEMPTS) return;
  setArchiveState(STATE_REVIEW_ATTEMPTS, String(attempts + 1));

  const stories = listPublishedStoriesStmt.all().filter((s) => s.period_end <= SEASON_END.toISOString());
  const storiesById = new Map(stories.map((s) => [s.id, s]));
  const results = buildResults();
  log(`writing the Year in Review from ${stories.length} stories (attempt ${attempts + 1}/${MAX_REVIEW_ATTEMPTS})`);

  const review = await writeYearInReview({
    briefing: buildBriefing(results, stories, recentMessages(stories)),
  });
  const { messageIds, hero } = highlightSources(review.highlight_story_ids || [], storiesById);
  const tags = (review.tags || []).map((t) => String(t).toLowerCase().trim()).filter(Boolean);
  const insert = insertArchiveStoryStmt.run(
    review.title,
    review.body,
    hero,
    "2026-01-01T08:00:00.000Z",
    SEASON_END.toISOString(),
    JSON.stringify(messageIds),
    review.modelId,
    JSON.stringify(tags),
  );
  const storyId = Number(insert.lastInsertRowid);
  setArchiveState(STATE_REVIEW_STORY_ID, String(storyId));
  log(`Year in Review published as story ${storyId} (${review.modelId})`);
  await announceStory(storyId, { ...review, hero_attachment_id: hero, source_message_ids: messageIds }, "📖 **The 2026 Year in Review is up.**");
}

// ============================================================================
// Scheduling
// ============================================================================

let running = false;

export async function runFinaleIfDue(now = Date.now()) {
  if (!isFinaleDue(now) || running) return;
  running = true;
  try {
    // Each step is independent: a Discord outage mustn't cost the story, and a
    // failed story mustn't re-post the embed.
    for (const [label, step] of [
      ["results announcement", announceResults],
      ["final week stories", coverFinalWeek],
      ["Year in Review", publishYearInReview],
    ]) {
      try {
        await step();
      } catch (err) {
        warn(`${label} failed:`, err.message);
      }
    }
  } finally {
    running = false;
  }
}

export function startFinale() {
  // A one-shot timer can't reach New Year's from here: setTimeout overflows
  // past ~24.8 days. A once-a-minute check also covers a deploy or restart
  // that lands after 12:01 — the state keys make every step run exactly once.
  const tick = () => runFinaleIfDue().catch((err) => warn("finale tick crashed:", err));
  setImmediate(tick);
  return setInterval(tick, CHECK_INTERVAL_MS);
}
