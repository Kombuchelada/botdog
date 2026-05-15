import Anthropic from "@anthropic-ai/sdk";
import sharp from "sharp";
import heicConvert from "heic-convert";

const MODEL_ID = "claude-sonnet-4-6";
const MAX_IMAGE_DIM = 1500;        // Anthropic enforces 2000px in many-image requests; stay safely under
const MAX_IMAGES_PER_CALL = 50;    // Cap base64 payload (~20MB worst case)
const JPEG_QUALITY = 85;

const SYSTEM_PROMPT = `You are the curator of "Year of the Glizzy", a Discord community where people post about eating hot dogs.

Your job: read a window of channel messages and identify SIGNIFICANT events worth turning into short stories on a public web archive.

WHAT COUNTS AS SIGNIFICANT:
- Adventurous or unique moments (hot dogs in unusual places, special events)
- Funny, memorable, or surprising moments
- Group activities, collaborations, road trips
- Notable achievements (record-breaking sittings, etc.)

WHAT DOES NOT COUNT:
- Solo "pity mustard dog at 11pm" entries that exist just to log a streak
- Routine commentary or jokes without a visual or story hook
- Single ordinary messages with no real moment behind them

QUALITY BAR: would someone reading the archive a year from now actually want to remember this? If unsure, leave it out. Publishing zero stories is FAR better than publishing a forced one. A typical week should produce 0 or 1 stories, occasionally 2 or 3.

TONE & FORMAT:
- Write like a warm magazine editor — punchy headline, vivid 2-3 paragraph narrative
- Reference participants by their actual display names
- Avoid being cheesy or over-hyping mundane events
- Don't open with "In a remarkable display of…" or similar clichés
- Be specific — name the place, the food, the people, the moment

Always call the publish_stories tool exactly once with a stories array. Empty array = nothing was worth publishing this period.`;

const TOOL = {
  name: "publish_stories",
  description: "Publish zero to three short stories about significant events found in this period's messages.",
  input_schema: {
    type: "object",
    properties: {
      stories: {
        type: "array",
        maxItems: 3,
        items: {
          type: "object",
          required: ["title", "body", "source_message_ids"],
          properties: {
            title: {
              type: "string",
              description: "Punchy magazine-style headline, max ~80 characters.",
            },
            body: {
              type: "string",
              description: "2-3 paragraph narrative in a warm, conversational tone. Plain text; line breaks separate paragraphs.",
            },
            hero_attachment_id: {
              type: "string",
              description: "The attachment_id to use as the story's hero image. Use the exact id printed in the (attachment_id: …) hint after each image. Optional, but strongly preferred when images exist.",
            },
            source_message_ids: {
              type: "array",
              items: { type: "string" },
              description: "The exact Discord message IDs (as strings) this story is based on. Use the ids printed in the '— Message …— ' headers.",
            },
          },
        },
      },
    },
    required: ["stories"],
  },
};

/**
 * Ask Claude to identify significant stories in a window of messages.
 *
 * @param {object} params
 * @param {Array} params.messages - archive_messages rows in chronological order
 * @param {Map<string, Array>} params.attachmentsByMessageId - attachments grouped by message id
 * @param {string} params.periodStart - ISO timestamp
 * @param {string} params.periodEnd - ISO timestamp
 * @returns {Promise<{stories: Array, modelId: string}>}
 */
function looksLikeHeic(buf, url) {
  if (/\.(heic|heif)(\?|$)/i.test(url)) return true;
  // ISO BMFF brand at bytes 8-12: heic/heix/heif/mif1/msf1
  if (buf.length < 12) return false;
  const brand = buf.slice(8, 12).toString("ascii");
  return ["heic", "heix", "heif", "mif1", "msf1"].includes(brand);
}

async function fetchAndResize(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${res.status} from ${url}`);
  let buf = Buffer.from(await res.arrayBuffer());

  // Pre-transcode HEIC to JPEG since sharp's prebuilt binary doesn't decode it.
  // (This handles legacy files in Spaces from before ingest-time conversion was added.)
  if (looksLikeHeic(buf, url)) {
    buf = Buffer.from(await heicConvert({ buffer: buf, format: "JPEG", quality: 0.9 }));
  }

  const out = await sharp(buf)
    .rotate() // honor EXIF orientation
    .resize({ width: MAX_IMAGE_DIM, height: MAX_IMAGE_DIM, fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: JPEG_QUALITY })
    .toBuffer();
  return out.toString("base64");
}

export async function proposeStories({ messages, attachmentsByMessageId, periodStart, periodEnd }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error("ANTHROPIC_API_KEY not set");
  }
  if (!messages || messages.length === 0) return { stories: [], modelId: MODEL_ID };

  const content = [
    {
      type: "text",
      text: `You are reviewing messages from ${periodStart} to ${periodEnd}. ${messages.length} message${messages.length === 1 ? "" : "s"} follow.`,
    },
  ];

  let imageCount = 0;

  for (const m of messages) {
    const header = [
      `\n— Message ${m.id} —`,
      `Author: ${m.author_name}`,
      `When: ${m.created_at}`,
      m.reply_to ? `Reply to: ${m.reply_to}` : null,
      `Text: ${m.content && m.content.trim() ? m.content : "(none)"}`,
    ].filter(Boolean).join("\n");
    content.push({ type: "text", text: header });

    const atts = attachmentsByMessageId.get(m.id) || [];
    for (const a of atts) {
      if (!a.content_type || !a.content_type.startsWith("image/")) continue;
      if (imageCount >= MAX_IMAGES_PER_CALL) {
        content.push({ type: "text", text: `(skipped image attachment_id: ${a.id} — image limit reached for this batch)` });
        continue;
      }
      let base64;
      try {
        base64 = await fetchAndResize(a.public_url);
      } catch (err) {
        console.warn(`[claude] failed to fetch/resize ${a.public_url}:`, err.message);
        content.push({ type: "text", text: `(skipped image attachment_id: ${a.id} — failed to load)` });
        continue;
      }
      content.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64 },
      });
      content.push({ type: "text", text: `(attachment_id: ${a.id})` });
      imageCount++;
    }
  }

  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    maxRetries: 5, // SDK does exponential backoff on 429/5xx and honors retry-after
  });
  const response = await anthropic.messages.create({
    model: MODEL_ID,
    max_tokens: 4096,
    system: SYSTEM_PROMPT,
    tools: [TOOL],
    tool_choice: { type: "tool", name: "publish_stories" },
    messages: [{ role: "user", content }],
  });

  for (const block of response.content) {
    if (block.type === "tool_use" && block.name === "publish_stories") {
      const stories = Array.isArray(block.input?.stories) ? block.input.stories : [];
      return { stories, modelId: MODEL_ID };
    }
  }
  return { stories: [], modelId: MODEL_ID };
}

export function isAnthropicConfigured() {
  return !!process.env.ANTHROPIC_API_KEY;
}

export const ANTHROPIC_MODEL = MODEL_ID;
