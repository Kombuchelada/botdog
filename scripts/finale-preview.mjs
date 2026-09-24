// Preview the finale against a real database without posting anything.
//
//   DB_PATH=./hotdog-data.db node scripts/finale-preview.mjs           # embed + briefing
//   DB_PATH=./hotdog-data.db node scripts/finale-preview.mjs --write   # also draft the Year in Review
//
// --write makes one real Claude Opus 5.5 call (needs ANTHROPIC_API_KEY, costs
// roughly $0.25) and prints the draft. Nothing is saved or announced — the
// draft is exactly what finale.js would publish, minus the insert.

import "dotenv/config";

import { buildResults, buildResultsMessage, buildBriefing, recentMessages } from "../finale.js";
import { listPublishedStoriesStmt } from "../database.js";
import { writeYearInReview } from "../claude.js";

const results = buildResults();
console.log("=== Discord results message ===");
console.log(JSON.stringify(buildResultsMessage(results), null, 2));

const stories = listPublishedStoriesStmt.all();
const messages = recentMessages(stories);
const briefing = buildBriefing(results, stories, messages);
console.log(`\n=== Year in Review briefing: ${stories.length} stories + ${messages.length} recent messages, ~${Math.round(briefing.length / 4).toLocaleString()} tokens ===`);
console.log(briefing.slice(0, 3000));
console.log(briefing.length > 3000 ? `\n… (${(briefing.length - 3000).toLocaleString()} more characters)` : "");

if (process.argv.includes("--write")) {
  console.log("\n=== Drafting the Year in Review (Claude Opus 5.5) ===");
  const review = await writeYearInReview({ briefing });
  console.log(`# ${review.title}\n\n${review.body}\n`);
  console.log(`highlights: ${review.highlight_story_ids.join(", ")}`);
  console.log(`tags: ${review.tags.join(", ")} · model: ${review.modelId}`);
}
process.exit(0);
