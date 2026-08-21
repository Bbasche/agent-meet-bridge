import test from "node:test";
import assert from "node:assert/strict";
import {
  boundedHarnessText,
  roomHarnessAnalysisText,
  spokenHarnessText,
} from "../src/harness-output.mjs";

test("harness output is bounded before entering provider or sidecar context", () => {
  const bounded = boundedHarnessText("x".repeat(50), 20);
  assert.equal(bounded, `${"x".repeat(20)}\n\n[Output truncated]`);
});

test("local meeting speech is capped independently from private analysis", () => {
  const words = Array.from({ length: 150 }, (_, index) => `word${index}`);
  const spoken = spokenHarnessText(words.join(" "), 120);
  assert.equal(spoken.split(/\s+/).length, 121);
  assert.match(spoken, /…$/);
});

test("room harness detail is explicitly labeled as private analysis", () => {
  const text = roomHarnessAnalysisText({ text: "Checked the implementation", question: "Is it safe?" });
  assert.match(text, /^Room-request analysis for “Is it safe\?”:/);
  assert.match(text, /Checked the implementation/);
});
