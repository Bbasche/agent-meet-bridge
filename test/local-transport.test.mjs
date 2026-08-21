import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUDIO_SAMPLE_RATE,
  BrowserMeetTransport,
  MEET_BROWSER_ARGS,
  meetingPopulationFromSnapshot,
  nextMeetingPresence,
} from "../src/browser-meet-transport.mjs";
import { GrokVoiceRuntime } from "../src/grok-voice-runtime.mjs";

test("local Meet transport uses the same 48 kHz PCM rate as Grok", () => {
  assert.equal(AUDIO_SAMPLE_RATE, 48_000);
});

test("local Meet transport keeps a dedicated persistent browser profile", () => {
  const transport = new BrowserMeetTransport({
    meetingUrl: "https://meet.google.com/abc-defg-hij",
    displayName: "Grok Bot",
    profileDir: "./data/browser-profile",
  });
  assert.equal(transport.displayName, "Grok Bot");
  assert.equal(transport.profileDir, path.resolve("./data/browser-profile"));
});

test("bot capture does not use Chrome mute-audio, which zeros WebRTC samples", () => {
  assert.equal(MEET_BROWSER_ARGS.includes("--mute-audio"), false);
});

test("bot media elements are locally silenced to prevent same-machine feedback", async () => {
  const source = await readFile(new URL("../src/browser-meet-transport.mjs", import.meta.url), "utf8");
  assert.match(source, /__meetingAgentSilencesLocalPlayback/);
  assert.match(source, /element\.muted = true/);
  assert.match(source, /element\.volume = 0/);
});

test("remote WebRTC tracks are mixed into the realtime PCM input bridge", async () => {
  const source = await readFile(new URL("../src/browser-meet-transport.mjs", import.meta.url), "utf8");
  assert.match(source, /createMediaStreamSource\(new MediaStream\(\[track\]\)\)/);
  assert.match(source, /__meetingAgentAudioIn/);
  assert.match(source, /FRAME_SAMPLES = 4800/);
});

test("meeting population detection recognizes only-participant and ended states", () => {
  assert.deepEqual(
    meetingPopulationFromSnapshot({ bodyText: "You're the only one here" }),
    { ended: false, alone: true, participantCount: null },
  );
  assert.deepEqual(
    meetingPopulationFromSnapshot({ ariaLabels: ["People (3)"] }),
    { ended: false, alone: false, participantCount: 3 },
  );
  assert.equal(meetingPopulationFromSnapshot({ bodyText: "Meeting has ended" }).ended, true);
});

test("alone timeout starts only after another participant was observed", () => {
  const timeoutMs = 5 * 60_000;
  const initialAlone = nextMeetingPresence(
    {},
    { alone: true },
    { now: 1_000, timeoutMs },
  );
  assert.equal(initialAlone.shouldLeave, false);
  assert.equal(initialAlone.aloneSince, null);

  const occupied = nextMeetingPresence(
    initialAlone,
    { participantCount: 2 },
    { now: 2_000, timeoutMs },
  );
  const alone = nextMeetingPresence(
    occupied,
    { alone: true, participantCount: 2 },
    { now: 3_000, timeoutMs },
  );
  assert.equal(alone.shouldLeave, false);
  assert.equal(alone.aloneSince, 3_000);
  assert.equal(
    nextMeetingPresence(alone, { alone: true }, { now: 302_999, timeoutMs }).shouldLeave,
    false,
  );
  assert.equal(
    nextMeetingPresence(alone, { alone: true }, { now: 303_000, timeoutMs }).shouldLeave,
    true,
  );
});

test("caption capture records ambient speech instead of requiring the wake name", async () => {
  const source = await readFile(new URL("../src/browser-meet-transport.mjs", import.meta.url), "utf8");
  assert.match(source, /speaker: candidate\.speaker/);
  assert.doesNotMatch(source, /SuppressCaptionsUntil/);
  assert.match(source, /isAgentCaption/);
  assert.match(source, /wakeBuffer/);
  assert.match(source, /mergeIncremental/);
});

test("Grok input is safely ignored until the realtime socket is open", () => {
  const runtime = new GrokVoiceRuntime({
    apiKey: "test",
    instructions: "test",
    agentName: "Grok Bot",
    mode: "passive",
  });
  assert.doesNotThrow(() => runtime.appendAudio(Buffer.alloc(9_600)));
});
