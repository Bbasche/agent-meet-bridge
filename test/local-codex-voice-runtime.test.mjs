import test from "node:test";
import assert from "node:assert/strict";
import {
  captionsAreSemanticDuplicates,
  cleanWhisperText,
  downsample48kTo16k,
  isSilentReply,
  LocalCodexVoiceRuntime,
  pcmRms,
  wavBuffer,
} from "../src/local-codex-voice-runtime.mjs";

function captionTestRuntime({ mode = "passive", onTranscript, onUserTurn } = {}) {
  const runtime = new LocalCodexVoiceRuntime({
    agentName: "John",
    mode,
    modelPath: "/unused/model.bin",
    utteranceDir: "/tmp/meeting-agent-caption-test",
    ttsCommand: "/unused/meeting-tts",
    onTranscript,
    onUserTurn,
  });
  runtime.connected = true;
  return runtime;
}

async function flushCaptionRuntime(runtime) {
  await runtime.queue;
  await runtime.responseQueue;
}

test("passive silence sentinels are never spoken aloud", () => {
  for (const reply of [
    "SILENCE",
    "[Agent remains silent.]",
    "No problem. I'll stay quiet until you address me directly.",
    "The agent will not respond.",
  ]) {
    assert.equal(isSilentReply(reply), true, reply);
  }
  assert.equal(isSilentReply("Yes, I can hear you."), false);
});

test("48 kHz meeting PCM is downsampled to 16 kHz mono", () => {
  const input = Buffer.alloc(12);
  for (let index = 0; index < 6; index += 1) input.writeInt16LE(index * 300, index * 2);
  const output = downsample48kTo16k(input);
  assert.equal(output.length, 4);
  assert.equal(output.readInt16LE(0), 300);
  assert.equal(output.readInt16LE(2), 1_200);
});

test("Whisper silence markers do not become meeting transcript", () => {
  assert.equal(cleanWhisperText(" [BLANK_AUDIO] \n"), "");
  assert.equal(cleanWhisperText("  Atlas, can you check the plugin?  "), "Atlas, can you check the plugin?");
});

test("WAV output has a valid PCM header and exact data length", () => {
  const pcm = Buffer.alloc(320);
  const wav = wavBuffer(pcm);
  assert.equal(wav.toString("ascii", 0, 4), "RIFF");
  assert.equal(wav.toString("ascii", 8, 12), "WAVE");
  assert.equal(wav.readUInt32LE(24), 16_000);
  assert.equal(wav.readUInt32LE(40), pcm.length);
  assert.equal(wav.length, pcm.length + 44);
});

test("PCM energy separates silence from meeting speech", () => {
  assert.equal(pcmRms(Buffer.alloc(9_600)), 0);
  const speech = Buffer.alloc(9_600);
  for (let offset = 0; offset < speech.length; offset += 2) speech.writeInt16LE(2_000, offset);
  assert.equal(pcmRms(speech), 2_000);
});

test("local runtime rejects a missing speech command before joining", async () => {
  const runtime = new LocalCodexVoiceRuntime({
    transcriptSource: "local-whisper",
    modelPath: "/missing/model.bin",
    utteranceDir: "/tmp/meeting-agent-test",
    ttsCommand: "/missing/meeting-tts",
    whisperCommand: "definitely-not-a-real-whisper-command",
  });
  await assert.rejects(runtime.connect(), /unavailable/);
});

test("semantic caption comparison tolerates a corrected name and leading filler", () => {
  assert.equal(
    captionsAreSemanticDuplicates(
      "Okay. John, tell Billy I think it's on his side since you can hear me.",
      "John tell Willie I think it's on his side since you can hear me.",
    ),
    true,
  );
});

test("short evolving hypotheses differing only by the wake name are duplicates", () => {
  assert.equal(
    captionsAreSemanticDuplicates(
      "John, can you hear me?",
      "Can you hear me?",
      { wakeName: "John" },
    ),
    true,
  );
});

test("semantic caption comparison never collapses negation or meaning reversals", () => {
  for (const [left, right] of [
    ["John, can you hear me?", "John, can you not hear me?"],
    ["John, tell Willie it is on his side.", "John, tell Willie it is not on his side."],
    ["John, send the proposal.", "John, don't send the proposal."],
    ["John, we can approve this.", "John, we cannot approve this."],
    ["John, do not tell Willie yet.", "John, tell Willie not to wait."],
    ["John, tell Willie we should approve the proposal.", "John, tell Willie we should reject the proposal."],
    ["John, tell Willie we should enable the integration.", "John, tell Willie we should disable the integration."],
    ["John, tell Willie to increase the limit today.", "John, tell Willie to decrease the limit today."],
    ["John, schedule the plugin review for Monday at three.", "John, schedule the plugin review for Tuesday at three."],
    ["John, schedule the plugin review for Monday at three.", "John, schedule the plugin review for Sunday at three."],
    ["John, schedule the plugin review in March at three.", "John, schedule the plugin review in May at three."],
    ["John, schedule the plugin review at 3 tomorrow.", "John, schedule the plugin review at 4 tomorrow."],
    ["John, set the referral fee to 10 percent today.", "John, set the referral fee to 20 percent today."],
    ["John, tell Willie to open the account today.", "John, tell Willie to close the account today."],
  ]) {
    assert.equal(
      captionsAreSemanticDuplicates(left, right, { wakeName: "John" }),
      false,
      `${left} <> ${right}`,
    );
  }
});

test("similar short natural follow-ups remain distinct", () => {
  for (const [left, right] of [
    ["John, can you hear me?", "John, can you hear Willie?"],
    ["John, what happens next?", "John, what is the price?"],
    ["John, tell Willie to refresh.", "John, tell Willie to reconnect."],
  ]) {
    assert.equal(
      captionsAreSemanticDuplicates(left, right, { wakeName: "John" }),
      false,
      `${left} <> ${right}`,
    );
  }
});

test("same-speaker duplicate caption hypotheses produce one handled turn", async () => {
  const transcripts = [];
  const turns = [];
  const runtime = captionTestRuntime({
    onTranscript: (entry) => transcripts.push(entry),
    onUserTurn: (turn) => {
      turns.push(turn);
      return "";
    },
  });

  runtime.appendCaption({
    speaker: "Ben Basche",
    text: "Okay. John, tell Billy I think it's on his side since you can hear me.",
  });
  runtime.appendCaption({
    speaker: "Ben Basche",
    text: "John tell Willie I think it's on his side since you can hear me.",
  });
  await flushCaptionRuntime(runtime);

  assert.equal(transcripts.length, 1);
  assert.equal(turns.length, 1);
});

test("distinct addressed follow-ups from the same speaker are preserved", async () => {
  const turns = [];
  const runtime = captionTestRuntime({
    onUserTurn: (turn) => {
      turns.push(turn.text);
      return "";
    },
  });

  runtime.appendCaption({ speaker: "Ben Basche", text: "John, can you hear Willie clearly?" });
  runtime.appendCaption({ speaker: "Ben Basche", text: "John, what should we cover next?" });
  await flushCaptionRuntime(runtime);

  assert.deepEqual(turns, [
    "John, can you hear Willie clearly?",
    "John, what should we cover next?",
  ]);
});

test("a legitimate same-speaker repetition after the semantic window is preserved", async (t) => {
  const turns = [];
  const originalNow = Date.now;
  let currentTime = 1_000;
  Date.now = () => currentTime;
  t.after(() => { Date.now = originalNow; });
  const runtime = captionTestRuntime({
    onUserTurn: (turn) => {
      turns.push(turn.text);
      return "";
    },
  });

  runtime.appendCaption({ speaker: "Ben Basche", text: "John, can you hear me?" });
  await flushCaptionRuntime(runtime);
  currentTime += 9_000;
  runtime.appendCaption({ speaker: "Ben Basche", text: "John, can you hear me?" });
  await flushCaptionRuntime(runtime);

  assert.deepEqual(turns, ["John, can you hear me?", "John, can you hear me?"]);
});

test("matching speech from different speakers is not deduplicated", async () => {
  const transcripts = [];
  const runtime = captionTestRuntime({
    onTranscript: (entry) => transcripts.push(`${entry.speaker}: ${entry.text}`),
  });

  runtime.appendCaption({ speaker: "Ben Basche", text: "The activities plugin needs a pilot." });
  runtime.appendCaption({ speaker: "Willie Cilliers", text: "The activities plugin needs a pilot." });
  await flushCaptionRuntime(runtime);

  assert.deepEqual(transcripts, [
    "Ben Basche: The activities plugin needs a pilot.",
    "Willie Cilliers: The activities plugin needs a pilot.",
  ]);
});

test("distinct ambient speech remains available to the transcript", async () => {
  const transcripts = [];
  const turns = [];
  const runtime = captionTestRuntime({
    onTranscript: (entry) => transcripts.push(entry.text),
    onUserTurn: (turn) => turns.push(turn),
  });

  runtime.appendCaption({ speaker: "Willie Cilliers", text: "I am sharing the booking screen now." });
  runtime.appendCaption({ speaker: "Willie Cilliers", text: "The customer chooses a date and activity." });
  await flushCaptionRuntime(runtime);

  assert.deepEqual(transcripts, [
    "I am sharing the booking screen now.",
    "The customer chooses a date and activity.",
  ]);
  assert.equal(turns.length, 0);
});
