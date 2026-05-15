import sharp from "sharp";
import {
  upsertUserProfileStmt,
  getUserProfileStmt,
  listDistinctEventUserIdsStmt,
  getArchiveState,
  setArchiveState,
} from "./database.js";
import { uploadObject, isSpacesConfigured } from "./do-spaces.js";

const STATE_LAST_PROFILES_REFRESH = "last_profiles_refresh";
const REFRESH_INTERVAL_MS = 24 * 60 * 60 * 1000;
const AVATAR_SIZE = 256;

function log(...args) { console.log("[profiles]", ...args); }
function warn(...args) { console.warn("[profiles]", ...args); }

async function discordGetUser(userId) {
  const url = `https://discord.com/api/v10/users/${userId}`;
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
    },
  });
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after")) || 5;
    warn(`rate-limited fetching user ${userId}; sleeping ${retryAfter}s`);
    await new Promise((r) => setTimeout(r, retryAfter * 1000));
    return discordGetUser(userId);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Discord /users/${userId}: ${res.status} ${await res.text()}`);
  return res.json();
}

/**
 * Refresh a single user's profile. If their avatar hash hasn't changed since
 * we last fetched, this is a no-op (no Spaces upload).
 *
 * @returns {Promise<{updated: boolean, profile: object | null}>}
 */
export async function refreshProfile(userId) {
  if (!process.env.DISCORD_TOKEN) throw new Error("DISCORD_TOKEN not set");
  if (!isSpacesConfigured()) throw new Error("DO Spaces not configured");

  const user = await discordGetUser(userId);
  if (!user) {
    warn(`user ${userId} not found on Discord`);
    return { updated: false, profile: null };
  }

  const cached = getUserProfileStmt.get(userId);
  const newHash = user.avatar || null;

  // No avatar: clear cached avatar but still upsert other fields.
  if (!newHash) {
    if (cached && cached.avatar_hash === null && cached.username === (user.username || null) && cached.global_name === (user.global_name || null)) {
      return { updated: false, profile: cached };
    }
    upsertUserProfileStmt.run(userId, user.username || null, user.global_name || null, null, null);
    log(`updated ${userId} (no avatar)`);
    return { updated: true, profile: getUserProfileStmt.get(userId) };
  }

  // Same hash — skip the download/upload.
  if (cached && cached.avatar_hash === newHash && cached.avatar_url) {
    // Still refresh username/global_name in case those changed.
    if (cached.username !== (user.username || null) || cached.global_name !== (user.global_name || null)) {
      upsertUserProfileStmt.run(userId, user.username || null, user.global_name || null, newHash, cached.avatar_url);
    }
    return { updated: false, profile: getUserProfileStmt.get(userId) };
  }

  // Avatar changed (or no cache) — download + transcode + upload.
  const ext = newHash.startsWith("a_") ? "gif" : "png";
  const sourceUrl = `https://cdn.discordapp.com/avatars/${userId}/${newHash}.${ext}?size=512`;
  let body;
  try {
    const res = await fetch(sourceUrl);
    if (!res.ok) throw new Error(`avatar fetch ${res.status} for ${userId}`);
    body = Buffer.from(await res.arrayBuffer());
  } catch (err) {
    warn(`failed to fetch avatar for ${userId}:`, err.message);
    return { updated: false, profile: cached || null };
  }

  // Animated GIFs: take the first frame, return as PNG. Static: just resize to PNG.
  let pngBuffer;
  try {
    pngBuffer = await sharp(body, { animated: false })
      .resize({ width: AVATAR_SIZE, height: AVATAR_SIZE, fit: "cover" })
      .png({ compressionLevel: 9 })
      .toBuffer();
  } catch (err) {
    warn(`sharp resize failed for ${userId}:`, err.message);
    return { updated: false, profile: cached || null };
  }

  const key = `avatars/${userId}-${newHash}.png`;
  let publicUrl;
  try {
    publicUrl = await uploadObject(key, pngBuffer, "image/png");
  } catch (err) {
    warn(`Spaces upload failed for ${userId} avatar:`, err.message);
    return { updated: false, profile: cached || null };
  }

  upsertUserProfileStmt.run(userId, user.username || null, user.global_name || null, newHash, publicUrl);
  log(`updated avatar for ${userId} -> ${publicUrl}`);
  return { updated: true, profile: getUserProfileStmt.get(userId) };
}

/**
 * Walk every user_id that has at least one hotdog event and refresh their profile.
 * Sleeps 250 ms between calls to be polite to Discord (a non-issue for low-volume
 * communities but cheap insurance).
 */
export async function refreshAllKnownProfiles() {
  const rows = listDistinctEventUserIdsStmt.all();
  let updated = 0;
  let skipped = 0;
  let errored = 0;
  for (const { user_id } of rows) {
    try {
      const r = await refreshProfile(user_id);
      if (r.updated) updated++;
      else skipped++;
    } catch (err) {
      errored++;
      warn(`refresh failed for ${user_id}:`, err.message);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  return { total: rows.length, updated, skipped, errored };
}

export async function refreshProfilesIfDue() {
  if (!process.env.DISCORD_TOKEN || !isSpacesConfigured()) return { skipped: "not_configured" };
  const last = getArchiveState(STATE_LAST_PROFILES_REFRESH);
  const now = Date.now();
  if (last && now - new Date(last).getTime() < REFRESH_INTERVAL_MS) return { skipped: "not_due" };
  log("refreshing all known user profiles");
  const summary = await refreshAllKnownProfiles();
  setArchiveState(STATE_LAST_PROFILES_REFRESH, new Date().toISOString());
  log(`refresh complete: ${summary.updated} updated, ${summary.skipped} unchanged, ${summary.errored} errored (of ${summary.total})`);
  return summary;
}
