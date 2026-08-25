import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DISPLAY_DEDUPE_WINDOW_MS,
  visibleCallEntries,
} from "../sidecar/timeline-filter.js";

function entry(timestamp, text = "Can you hear me?", speaker = "Willie") {
  return { timestamp, text, speaker };
}

test("sidecar hides exact display duplicates only inside its bounded time window", () => {
  const entries = [
    entry("2026-08-25T13:36:00.000Z"),
    entry("2026-08-25T13:36:02.000Z"),
    entry("2026-08-25T13:36:30.000Z"),
  ];
  assert.equal(DEFAULT_DISPLAY_DEDUPE_WINDOW_MS, 8_000);
  assert.deepEqual(visibleCallEntries(entries), [entries[0], entries[2]]);
});

test("suppressed display duplicates do not extend the window indefinitely", () => {
  const entries = [
    entry("2026-08-25T13:36:00.000Z"),
    entry("2026-08-25T13:36:05.000Z"),
    entry("2026-08-25T13:36:10.000Z"),
  ];
  assert.deepEqual(visibleCallEntries(entries), [entries[0], entries[2]]);
});

test("sidecar duplicate boundary suppresses 8000ms and preserves 8001ms", () => {
  const atBoundary = [
    entry("2026-08-25T13:36:00.000Z"),
    entry("2026-08-25T13:36:08.000Z"),
  ];
  const afterBoundary = [
    entry("2026-08-25T13:36:00.000Z"),
    entry("2026-08-25T13:36:08.001Z"),
  ];
  assert.deepEqual(visibleCallEntries(atBoundary), [atBoundary[0]]);
  assert.deepEqual(visibleCallEntries(afterBoundary), afterBoundary);
});

test("sidecar preserves repeated phrases without a trustworthy timestamp", () => {
  const entries = [entry(null), entry(null)];
  assert.deepEqual(visibleCallEntries(entries), entries);
});

test("sidecar display filtering remains speaker-specific and removes Meet chrome", () => {
  const entries = [
    entry("2026-08-25T13:36:00.000Z", "Can you hear me?", "Willie"),
    entry("2026-08-25T13:36:01.000Z", "Can you hear me?", "Ben"),
    entry("2026-08-25T13:36:02.000Z", "Summarize captions", "Meeting"),
  ];
  assert.deepEqual(visibleCallEntries(entries), entries.slice(0, 2));
});
