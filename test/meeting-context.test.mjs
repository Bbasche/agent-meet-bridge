import test from "node:test";
import assert from "node:assert/strict";
import { buildMeetingContext } from "../src/meeting-context.mjs";

test("meeting context keeps speakers, chronology, questions, and commitments", () => {
  const context = buildMeetingContext([
    { speaker: "Maya", text: "Which API should the plugin call?", timestamp: "2026-08-21T10:00:00.000Z" },
    { speaker: "Lee", text: "We'll validate the webhook by Friday.", timestamp: "2026-08-21T10:00:05.000Z" },
  ]);
  assert.match(context, /Participants heard: Maya, Lee/);
  assert.match(context, /Recent questions or uncertainties/);
  assert.match(context, /Candidate decisions or commitments/);
  assert.match(context, /\[10:00:05\] Lee/);
});

test("meeting context applies a bounded recent-turn budget", () => {
  const entries = Array.from({ length: 100 }, (_, index) => ({
    speaker: "Speaker",
    text: `Turn ${index} with enough words to consume the context budget`,
  }));
  const context = buildMeetingContext(entries, { maxChars: 240, maxTurns: 80 });
  assert.match(context, /Turn 99/);
  assert.doesNotMatch(context, /Turn 0\b/);
});
