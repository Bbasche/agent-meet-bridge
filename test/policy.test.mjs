import test from "node:test";
import assert from "node:assert/strict";
import {
  buildVoiceInstructions,
  createAskCodexTool,
  turnCanWrite,
  utteranceAddressesAgent,
  validateMeetingUrl,
} from "../src/policy.mjs";

test("wake-name matching respects word boundaries and case", () => {
  assert.equal(utteranceAddressesAgent("Grok Bot, check that in Codex", "Grok Bot"), true);
  assert.equal(utteranceAddressesAgent("hey grok bot can you help", "Grok Bot"), true);
  assert.equal(utteranceAddressesAgent("the grok botanical demo", "Grok Bot"), false);
});

test("passive instructions prohibit ambient replies", () => {
  const prompt = buildVoiceInstructions({
    agentName: "Grok Bot",
    mode: "passive",
    codexEnabled: true,
  });
  assert.match(prompt, /Speak only after someone addresses you by name/);
  assert.match(prompt, /return exactly SILENCE/);
  assert.match(prompt, /Use ask_codex/);
});

test("Codex tool requires an explicit action class", () => {
  const tool = createAskCodexTool();
  assert.deepEqual(tool.parameters.required, ["question", "desired_action"]);
  assert.deepEqual(tool.parameters.properties.desired_action.enum, ["analyze", "prototype"]);
  assert.equal(tool.parameters.additionalProperties, false);
});

test("meeting links are restricted to the real Google Meet origin", () => {
  assert.equal(validateMeetingUrl("https://meet.google.com/abc-defg-hij").hostname, "meet.google.com");
  assert.throws(() => validateMeetingUrl("https://meet.google.com.example.org/abc"), /meet\.google\.com/);
  assert.throws(() => validateMeetingUrl("http://meet.google.com/abc"), /meet\.google\.com/);
});

test("only an explicit private prototype turn can write", () => {
  assert.equal(turnCanWrite({ bridgeAllowsWrites: true, visibility: "private", desiredAction: "prototype" }), true);
  assert.equal(turnCanWrite({ bridgeAllowsWrites: true, visibility: "private", desiredAction: "analyze" }), false);
  assert.equal(turnCanWrite({ bridgeAllowsWrites: true, visibility: "meeting", desiredAction: "prototype" }), false);
  assert.equal(turnCanWrite({ bridgeAllowsWrites: false, visibility: "private", desiredAction: "prototype" }), false);
});
