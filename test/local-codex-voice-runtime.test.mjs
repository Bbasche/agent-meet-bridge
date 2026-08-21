import test from "node:test";
import assert from "node:assert/strict";
import {
  cleanWhisperText,
  downsample48kTo16k,
  isSilentReply,
  LocalCodexVoiceRuntime,
  pcmRms,
  wavBuffer,
} from "../src/local-codex-voice-runtime.mjs";

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
