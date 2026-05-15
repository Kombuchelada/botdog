import 'dotenv/config';

export async function DiscordRequest(endpoint, options) {
  // append endpoint to root API URL
  const url = 'https://discord.com/api/v10/' + endpoint;
  // Stringify payloads
  if (options.body) options.body = JSON.stringify(options.body);
  // Use fetch to make requests
  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': 'DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)',
    },
    ...options
  });
  // throw API errors
  if (!res.ok) {
    const data = await res.json();
    console.log(res.status);
    throw new Error(JSON.stringify(data));
  }
  // return original response
  return res;
}

/**
 * Send (or PATCH) an interaction follow-up message with a PNG attachment.
 * Uses multipart/form-data; Node 18+'s global FormData/Blob/fetch handle this.
 *
 * @param {string} interactionToken - token from req.body.token
 * @param {Buffer} pngBuffer        - PNG bytes to attach
 * @param {string} filename         - filename Discord should show
 * @param {object} payload          - optional extra fields (content, components, etc.)
 */
export async function uploadInteractionAttachment(interactionToken, pngBuffer, filename, payload = {}) {
  const url = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interactionToken}/messages/@original`;
  const form = new FormData();
  form.append(
    "payload_json",
    JSON.stringify({ ...payload, attachments: [{ id: 0, filename }] }),
  );
  form.append("files[0]", new Blob([pngBuffer], { type: "image/png" }), filename);
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
      // intentionally no Content-Type — FormData sets it with the multipart boundary
    },
    body: form,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`upload failed ${res.status}: ${text}`);
  }
  return res;
}

/**
 * PATCH the original interaction response with plain text. Used to surface
 * errors when image rendering fails, so the user isn't left with "thinking…"
 */
export async function editOriginalInteractionMessage(interactionToken, content) {
  const url = `https://discord.com/api/v10/webhooks/${process.env.APP_ID}/${interactionToken}/messages/@original`;
  const res = await fetch(url, {
    method: "PATCH",
    headers: {
      Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
    },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    console.error("editOriginalInteractionMessage failed", res.status, await res.text());
  }
  return res;
}

export async function InstallGlobalCommands(appId, commands) {
  // API endpoint to overwrite global commands
  const endpoint = `applications/${appId}/commands`;

  try {
    // This is calling the bulk overwrite endpoint: https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
    await DiscordRequest(endpoint, { method: 'PUT', body: commands });
  } catch (err) {
    console.error(err);
  }
}

// Simple method that returns a random emoji from list
export function getRandomEmoji() {
  const emojiList = ['😭','😄','😌','🤓','😎','😤','🤖','😶‍🌫️','🌏','📸','💿','👋','🌊','✨'];
  return emojiList[Math.floor(Math.random() * emojiList.length)];
}

export function capitalize(str) {
  return str.charAt(0).toUpperCase() + str.slice(1);
}
