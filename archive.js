import {
  db,
  insertArchiveMessageStmt,
  insertArchiveAttachmentStmt,
  getArchiveMessagesInRangeStmt,
  getArchiveAttachmentsForMessageStmt,
  getArchiveAttachmentByIdStmt,
  getOldestArchiveMessageIdStmt,
  getNewestArchiveMessageIdStmt,
  insertArchiveStoryStmt,
  countStoriesForPeriodStmt,
  getStoryByIdStmt,
  replaceStoryContentStmt,
  getArchiveState,
  setArchiveState,
} from "./database.js";
import { uploadObject, isSpacesConfigured } from "./do-spaces.js";
import { proposeStories, isAnthropicConfigured } from "./claude.js";
import { DiscordRequest } from "./utils.js";
import heicConvert from "heic-convert";

const POLL_INTERVAL_MS = 60 * 60 * 1000;     // 1 hour
const WEEKLY_INTERVAL_MS = 7 * 24 * 60 * 60 * 1000;
const BACKFILL_BATCH_DELAY_MS = 1500;        // gentle on Discord
const FETCH_BATCH_SIZE = 100;

const STATE_BACKFILL_DONE = "backfill_complete_at";
const STATE_BACKFILL_STORIES_DONE = "backfill_stories_complete_at";
const STATE_LAST_WEEKLY = "last_weekly_run_at";

function log(...args) {
  console.log("[archive]", ...args);
}
function warn(...args) {
  console.warn("[archive]", ...args);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function chanId() {
  return process.env.ARCHIVE_CHANNEL_ID;
}

function isArchiveConfigured() {
  return !!(chanId() && process.env.DISCORD_TOKEN && isSpacesConfigured() && isAnthropicConfigured());
}

async function discordGetMessages(query) {
  const url = `https://discord.com/api/v10/channels/${chanId()}/messages?${new URLSearchParams(query).toString()}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
    },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 5;
    warn(`rate-limited, sleeping ${retryAfter}s`);
    await sleep(retryAfter * 1000);
    return discordGetMessages(query);
  }
  if (!res.ok) {
    throw new Error(`Discord ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function pickAuthorName(author) {
  return author.global_name || author.username || `User ${author.id?.slice?.(-4) || "?"}`;
}

function getExtFromFilename(filename) {
  if (!filename) return "bin";
  const idx = filename.lastIndexOf(".");
  if (idx === -1) return "bin";
  return filename.slice(idx + 1).toLowerCase().replace(/[^a-z0-9]/g, "") || "bin";
}

function isHeic(contentType, filename) {
  if (contentType && /heic|heif/i.test(contentType)) return true;
  if (filename && /\.(heic|heif)$/i.test(filename)) return true;
  return false;
}

async function downloadAndStoreAttachment(messageId, att) {
  // Skip if we already have it.
  if (getArchiveAttachmentByIdStmt.get(att.id)) return;
  let body;
  try {
    const res = await fetch(att.url);
    if (!res.ok) {
      warn(`download failed ${res.status} for attachment ${att.id}`);
      return;
    }
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    warn(`download error for attachment ${att.id}:`, err.message);
    return;
  }

  // HEIC → JPEG conversion at ingest time. Sharp's prebuilt binary doesn't ship
  // libheif, and browsers other than Safari can't render HEIC, so we transcode
  // once here. The JPEG is what lands in Spaces and what both the website and
  // Claude see going forward.
  let ext = getExtFromFilename(att.filename);
  let contentType = att.content_type || null;
  if (isHeic(contentType, att.filename)) {
    try {
      const jpeg = await heicConvert({ buffer: body, format: "JPEG", quality: 0.9 });
      body = Buffer.from(jpeg);
      ext = "jpg";
      contentType = "image/jpeg";
      log(`converted HEIC -> JPEG for attachment ${att.id} (${body.length} bytes)`);
    } catch (err) {
      warn(`HEIC convert failed for attachment ${att.id}, storing original:`, err.message);
      // Fall through and store the original — better to have an unreadable file
      // archived than to drop it on the floor.
    }
  }

  const key = `attachments/${messageId}/${att.id}.${ext}`;
  let publicUrl;
  try {
    publicUrl = await uploadObject(key, body, contentType || "application/octet-stream");
  } catch (err) {
    warn(`Spaces upload failed for attachment ${att.id}:`, err.message);
    return;
  }
  insertArchiveAttachmentStmt.run(
    att.id,
    messageId,
    att.url,
    key,
    publicUrl,
    contentType,
    body.length,
    att.width || null,
    att.height || null,
  );
}

async function ingestMessages(messages) {
  let inserted = 0;
  let attachmentsHandled = 0;
  for (const m of messages) {
    // Skip system messages and bot messages — we only want human posts.
    if (m.type !== 0 && m.type !== 19) continue; // 0 = default, 19 = reply
    if (m.author?.bot) continue;

    const reply_to = m.message_reference?.message_id || null;
    const result = insertArchiveMessageStmt.run(
      m.id,
      m.channel_id,
      m.author.id,
      pickAuthorName(m.author),
      m.content || "",
      reply_to,
      m.timestamp,
    );
    if (result.changes > 0) inserted++;

    if (m.attachments && m.attachments.length > 0) {
      for (const att of m.attachments) {
        await downloadAndStoreAttachment(m.id, att);
        attachmentsHandled++;
      }
    }
  }
  return { inserted, attachmentsHandled };
}

async function backfillIfNeeded() {
  if (getArchiveState(STATE_BACKFILL_DONE)) return;
  log("starting initial backfill of channel history");
  let before = getOldestArchiveMessageIdStmt.get()?.id || null;
  let totalInserted = 0;
  let totalAttachments = 0;
  let batches = 0;

  while (true) {
    const query = { limit: String(FETCH_BATCH_SIZE) };
    if (before) query.before = before;
    let batch;
    try {
      batch = await discordGetMessages(query);
    } catch (err) {
      warn("backfill request failed:", err.message);
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) {
      setArchiveState(STATE_BACKFILL_DONE, new Date().toISOString());
      log(`backfill complete after ${batches} batches, ${totalInserted} messages inserted, ${totalAttachments} attachments processed`);
      return;
    }
    const { inserted, attachmentsHandled } = await ingestMessages(batch);
    totalInserted += inserted;
    totalAttachments += attachmentsHandled;
    batches++;
    // Discord returns newest-first; the oldest in this batch is `before` for the next call.
    before = batch.reduce((min, m) => (BigInt(m.id) < BigInt(min) ? m.id : min), batch[0].id);
    log(`backfill batch ${batches}: ${batch.length} fetched, ${inserted} new, attachments handled ${attachmentsHandled}; oldest so far = ${before}`);
    await sleep(BACKFILL_BATCH_DELAY_MS);
  }
}

async function forwardPoll() {
  let after = getNewestArchiveMessageIdStmt.get()?.id;
  if (!after) {
    // Backfill hasn't found anything yet, or empty channel. Skip forward poll until backfill done.
    return { inserted: 0 };
  }
  let totalInserted = 0;
  while (true) {
    let batch;
    try {
      batch = await discordGetMessages({ limit: String(FETCH_BATCH_SIZE), after });
    } catch (err) {
      warn("forward poll failed:", err.message);
      return { inserted: totalInserted };
    }
    if (!Array.isArray(batch) || batch.length === 0) {
      return { inserted: totalInserted };
    }
    const { inserted } = await ingestMessages(batch);
    totalInserted += inserted;
    // For `after`, batch returns newest first but we want to advance forward; use the max id in the batch.
    after = batch.reduce((max, m) => (BigInt(m.id) > BigInt(max) ? m.id : max), batch[0].id);
    log(`forward poll batch: ${batch.length} fetched, ${inserted} new`);
    if (batch.length < FETCH_BATCH_SIZE) return { inserted: totalInserted };
    await sleep(500);
  }
}

function findFirstImageForStory(story) {
  if (story.hero_attachment_id) {
    const a = getArchiveAttachmentByIdStmt.get(story.hero_attachment_id);
    if (a && a.content_type && a.content_type.startsWith("image/")) return a;
  }
  let ids = story.source_message_ids;
  if (typeof ids === "string") {
    try { ids = JSON.parse(ids); } catch { ids = []; }
  }
  if (!Array.isArray(ids)) ids = [];
  for (const mid of ids) {
    const atts = getArchiveAttachmentsForMessageStmt.all(mid);
    const img = atts.find((a) => a && a.content_type && a.content_type.startsWith("image/"));
    if (img) return img;
  }
  return null;
}

function excerpt(text, max) {
  const s = String(text || "").replace(/\s+/g, " ").trim();
  if (s.length <= max) return s;
  const cut = s.lastIndexOf(" ", max);
  return s.slice(0, cut > 0 ? cut : max) + "…";
}

async function announceStory(storyId, story) {
  const channelId = process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID || chanId();
  const baseUrl = (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
  if (!channelId || !baseUrl) {
    log(`announce skipped (need PUBLIC_BASE_URL${process.env.ARCHIVE_ANNOUNCE_CHANNEL_ID ? "" : " and a valid channel"})`);
    return;
  }
  const storyUrl = `${baseUrl}/archive/${storyId}`;
  const image = findFirstImageForStory(story);
  const embed = {
    title: story.title,
    description: excerpt(story.body, 300),
    url: storyUrl,
    color: 0xff6b35, // brand accent
    footer: { text: "Year of the Glizzy" },
    timestamp: new Date().toISOString(),
  };
  if (image && image.public_url) {
    embed.image = { url: image.public_url };
  }
  try {
    await DiscordRequest(`channels/${channelId}/messages`, {
      method: "POST",
      body: { content: "🌭 New archive story", embeds: [embed] },
    });
    log(`announced story ${storyId} in channel ${channelId}`);
  } catch (err) {
    warn(`announcement failed for story ${storyId}:`, err.message);
  }
}

function attachmentsForMessages(messageIds) {
  const map = new Map();
  for (const id of messageIds) {
    const atts = getArchiveAttachmentsForMessageStmt.all(id);
    if (atts.length > 0) map.set(id, atts);
  }
  return map;
}

async function generateStoriesForWindow(periodStartIso, periodEndIso, label) {
  // Idempotency: if we already have stories covering this exact window (from a
  // previous successful run), don't waste a Claude call generating duplicates.
  const existing = countStoriesForPeriodStmt.get(periodStartIso, periodEndIso).c;
  if (existing > 0) {
    log(`${label}: ${existing} story/ies already exist for this window, skipping`);
    return { stories: 0, skipped: true };
  }
  const messages = getArchiveMessagesInRangeStmt.all(periodStartIso, periodEndIso);
  if (messages.length === 0) {
    log(`${label}: no messages in window, skipping`);
    return { stories: 0 };
  }
  const attsByMsg = attachmentsForMessages(messages.map((m) => m.id));
  // Only bother calling Claude if at least one image exists in the window —
  // text-only weeks rarely produce a story worth publishing.
  const hasAnyImage = Array.from(attsByMsg.values()).some((arr) =>
    arr.some((a) => a.content_type && a.content_type.startsWith("image/")),
  );
  if (!hasAnyImage) {
    log(`${label}: ${messages.length} messages but no images, skipping LLM call`);
    return { stories: 0 };
  }
  log(`${label}: ${messages.length} messages, ${[...attsByMsg.values()].reduce((s, a) => s + a.length, 0)} attachments; calling Claude`);
  let result;
  try {
    result = await proposeStories({
      messages,
      attachmentsByMessageId: attsByMsg,
      periodStart: periodStartIso,
      periodEnd: periodEndIso,
    });
  } catch (err) {
    warn(`${label}: Claude call failed:`, err.message);
    return { stories: 0 };
  }
  const announceEnabled = !!getArchiveState(STATE_BACKFILL_STORIES_DONE);
  for (const s of result.stories) {
    const srcIds = JSON.stringify(s.source_message_ids || []);
    const insertResult = insertArchiveStoryStmt.run(
      s.title,
      s.body,
      s.hero_attachment_id || null,
      periodStartIso,
      periodEndIso,
      srcIds,
      result.modelId,
    );
    if (announceEnabled) {
      const storyId = Number(insertResult.lastInsertRowid);
      await announceStory(storyId, s);
    }
  }
  log(`${label}: published ${result.stories.length} stories${announceEnabled ? " (announced)" : " (backfill — no announce)"}`);
  return { stories: result.stories.length };
}

function isoFloor(date) {
  return new Date(date).toISOString();
}

async function generateBackfillStories() {
  if (getArchiveState(STATE_BACKFILL_STORIES_DONE)) return;
  if (!getArchiveState(STATE_BACKFILL_DONE)) return; // wait until messages are all in

  log("generating retroactive stories week-by-week");
  // Walk weekly windows from oldest message to now.
  const oldest = getOldestArchiveMessageIdStmt.get();
  if (!oldest) {
    setArchiveState(STATE_BACKFILL_STORIES_DONE, new Date().toISOString());
    return;
  }
  // Use the oldest message's created_at as the start. Pull it from DB.
  // Snowflake → epoch: ((BigInt(id) >> 22n) + 1420070400000n)
  const startMs = Number((BigInt(oldest.id) >> 22n) + 1420070400000n);
  const start = new Date(startMs);
  // Floor to start of week (UTC Monday).
  const day = start.getUTCDay();
  const offsetToMonday = (day + 6) % 7;
  start.setUTCDate(start.getUTCDate() - offsetToMonday);
  start.setUTCHours(0, 0, 0, 0);

  const now = new Date();
  let cursor = new Date(start);
  let windows = 0;
  while (cursor < now) {
    const next = new Date(cursor);
    next.setUTCDate(next.getUTCDate() + 7);
    const label = `backfill week ${cursor.toISOString().slice(0, 10)}`;
    try {
      await generateStoriesForWindow(isoFloor(cursor), isoFloor(next), label);
    } catch (err) {
      warn(`${label} failed:`, err.message);
    }
    cursor = next;
    windows++;
    await sleep(2000); // ~30 RPM ceiling, comfortably under Anthropic tier-1 50 RPM
  }
  setArchiveState(STATE_BACKFILL_STORIES_DONE, new Date().toISOString());
  log(`backfill stories complete after ${windows} weekly windows`);
}

async function runWeeklyJobIfDue() {
  if (!getArchiveState(STATE_BACKFILL_STORIES_DONE)) return; // still warming up
  const last = getArchiveState(STATE_LAST_WEEKLY);
  const now = Date.now();
  if (last && now - new Date(last).getTime() < WEEKLY_INTERVAL_MS) return;

  const end = new Date(now);
  const start = new Date(now - WEEKLY_INTERVAL_MS);
  log(`running weekly story job for ${start.toISOString()} -> ${end.toISOString()}`);
  try {
    await generateStoriesForWindow(start.toISOString(), end.toISOString(), "weekly");
    setArchiveState(STATE_LAST_WEEKLY, new Date().toISOString());
  } catch (err) {
    warn("weekly job failed:", err.message);
  }
}

let tickRunning = false;

/**
 * Manually trigger a tick (used by the admin "Reset archive" button so a fresh
 * backfill kicks off immediately without waiting for the next scheduled poll).
 * No-op if a tick is already running.
 */
export function triggerArchiveTick() {
  if (tickRunning) {
    log("manual trigger: tick already running, will pick up on next scheduled run");
    return;
  }
  setImmediate(() => { tick().catch((e) => warn("manual tick crashed:", e)); });
}

async function tick() {
  if (tickRunning) {
    log("previous tick still running, skipping");
    return;
  }
  tickRunning = true;
  try {
    await backfillIfNeeded();
    await forwardPoll();
    await generateBackfillStories();
    await runWeeklyJobIfDue();
  } catch (err) {
    warn("tick error:", err);
  } finally {
    tickRunning = false;
  }
}

/**
 * Re-run Claude on the source messages of an existing story and overwrite it.
 * Used by the admin "revise" button.
 */
export async function reviseStory(storyId) {
  const story = getStoryByIdStmt.get(storyId);
  if (!story) throw new Error(`story ${storyId} not found`);
  const ids = JSON.parse(story.source_message_ids || "[]");
  if (ids.length === 0) throw new Error("story has no source messages");
  const rows = db
    .prepare(`SELECT * FROM archive_messages WHERE id IN (${ids.map(() => "?").join(",")}) ORDER BY created_at ASC`)
    .all(...ids);
  if (rows.length === 0) throw new Error("no source messages found in DB");
  const atts = attachmentsForMessages(rows.map((r) => r.id));
  const result = await proposeStories({
    messages: rows,
    attachmentsByMessageId: atts,
    periodStart: rows[0].created_at,
    periodEnd: rows[rows.length - 1].created_at,
  });
  const fresh = result.stories[0];
  if (!fresh) throw new Error("Claude declined to revise (returned no stories)");
  replaceStoryContentStmt.run(
    fresh.title,
    fresh.body,
    fresh.hero_attachment_id || null,
    JSON.stringify(fresh.source_message_ids || ids),
    result.modelId,
    storyId,
  );
  return fresh;
}

export function startArchive() {
  if (!isArchiveConfigured()) {
    log("archive not fully configured (need DISCORD_TOKEN, ARCHIVE_CHANNEL_ID, ANTHROPIC_API_KEY, and DO Spaces vars); skipping background worker");
    return;
  }
  log(`starting background worker — channel ${chanId()}, polling every ${POLL_INTERVAL_MS / 60000}min`);
  // Kick off immediately, then on interval.
  setImmediate(() => { tick().catch((e) => warn("initial tick crashed:", e)); });
  setInterval(() => { tick().catch((e) => warn("scheduled tick crashed:", e)); }, POLL_INTERVAL_MS);
}
