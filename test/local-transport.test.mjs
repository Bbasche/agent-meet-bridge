import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  AUDIO_BRIDGE_SCRIPT,
  AUDIO_SAMPLE_RATE,
  BrowserMeetTransport,
  CAPTION_SETTLE_MS,
  CAPTION_SENT_DEDUPE_WINDOW_MS,
  MEET_BROWSER_ARGS,
  captionCandidateOnSpeakerChange,
  captionKeyWasRecentlySent,
  captionMatchesExpectedSpeech,
  isKnownMeetChromeCaption,
  meetingPopulationFromSnapshot,
  mergeIncrementalCaption,
  nextMeetingPresence,
} from "../src/browser-meet-transport.mjs";
import { GrokVoiceRuntime } from "../src/grok-voice-runtime.mjs";

test("local Meet transport uses the same 48 kHz PCM rate as Grok", () => {
  assert.equal(AUDIO_SAMPLE_RATE, 48_000);
  assert.doesNotThrow(() => new Function(AUDIO_BRIDGE_SCRIPT));
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

test("caption settling flushes a pending candidate before a different speaker arrives", () => {
  const pending = {
    key: "Ben Basche\u0000John, can you hear me?",
    speaker: "Ben Basche",
    text: "John, can you hear me?",
  };
  assert.equal(captionCandidateOnSpeakerChange(pending, "Willie Cilliers"), pending);
  assert.equal(captionCandidateOnSpeakerChange(pending, "Ben Basche"), null);
  assert.equal(captionCandidateOnSpeakerChange(null, "Willie Cilliers"), null);
});

test("caption bridge applies speaker-transition flushing to ambient speech as well as wake turns", () => {
  assert.match(AUDIO_BRIDGE_SCRIPT, /candidateOnSpeakerChange\(lastCandidate, effectiveSpeaker\)/);
  assert.match(AUDIO_BRIDGE_SCRIPT, /emitCandidate\(previousSpeakerCandidate\)/);
});

test("browser exact-caption suppression expires instead of hiding later repetition forever", () => {
  const key = "Willie\u0000Can you hear me?";
  assert.equal(CAPTION_SENT_DEDUPE_WINDOW_MS, 8_000);
  assert.equal(captionKeyWasRecentlySent(key, key, 1_000, 9_000), true);
  assert.equal(captionKeyWasRecentlySent(key, key, 1_000, 9_001), false);
  assert.equal(captionKeyWasRecentlySent(key, "Ben\u0000Can you hear me?", 1_000, 2_000), false);
  assert.match(AUDIO_BRIDGE_SCRIPT, /keyWasRecentlySent\(key, lastSent, lastSentAt, now/);
});

test("speaker-transition settling preserves rapid A to B to A order and same-speaker revision", () => {
  const events = [
    { speaker: "Ben", text: "John, can you" },
    { speaker: "Ben", text: "John, can you hear me?" },
    { speaker: "Willie", text: "I can hear you." },
    { speaker: "Ben", text: "Great, thank you." },
  ];
  const emitted = [];
  let pending = null;
  for (const event of events) {
    const flush = captionCandidateOnSpeakerChange(pending, event.speaker);
    if (flush) emitted.push(flush);
    pending = { key: `${event.speaker}\u0000${event.text}`, ...event };
  }
  if (pending) emitted.push(pending);
  assert.deepEqual(emitted.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: "Ben", text: "John, can you hear me?" },
    { speaker: "Willie", text: "I can hear you." },
    { speaker: "Ben", text: "Great, thank you." },
  ]);
});

test("incremental Meet hypotheses replace punctuation revisions instead of duplicating them", () => {
  const fragments = [
    "Okay, we're waiting for Village John.",
    "Okay, we're waiting for Village John get.",
    "Okay, we're waiting for Village John. Get ready with.",
    "Okay, we're waiting for Village John. Get ready with all the.",
    "Okay, we're waiting for Village John. Get ready with all the cont.",
    "Okay, we're waiting for Village John. Get ready with all the context.",
    "Okay, we're waiting for Village John. Get ready with all the context on activ.",
    "activities.",
    "activities plug-in.",
    "activities plug-in as.",
    "activities plug-in as we do.",
  ];
  let whole = fragments[0];
  for (let index = 1; index < fragments.length; index += 1) {
    whole = mergeIncrementalCaption(whole, fragments[index - 1], fragments[index]);
  }
  assert.equal(
    whole,
    "Okay, we're waiting for Village John. Get ready with all the context on activities plug-in as we do.",
  );
});

test("incremental wake-name questions settle on the final hypothesis", () => {
  const fragments = [
    "John.",
    "John do?",
    "John, do you have?",
    "John, do you have the?",
    "John, do you have the cont?",
    "John, do you have the context?",
  ];
  let whole = fragments[0];
  for (let index = 1; index < fragments.length; index += 1) {
    whole = mergeIncrementalCaption(whole, fragments[index - 1], fragments[index]);
  }
  assert.equal(whole, "John, do you have the context?");
});

test("a corrected whole hypothesis replaces the stale assembled caption", () => {
  assert.equal(
    mergeIncrementalCaption(
      "Okay, we're waiting for Village John. Get ready with all the context on activities plug-in as we do.",
      "activities plug-in as we do.",
      "Okay, we're waiting for Village John. Get ready with all the contacts on activities. Plug-in is.",
    ),
    "Okay, we're waiting for Village John. Get ready with all the contacts on activities. Plug-in is.",
  );
});

test("caption merging appends unrelated blocks and ignores shorter interim regressions", () => {
  assert.equal(
    mergeIncrementalCaption(
      "John, review the pricing.",
      "John, review the pricing.",
      "Willie described the checkout.",
    ),
    "John, review the pricing. Willie described the checkout.",
  );
  assert.equal(
    mergeIncrementalCaption(
      "John, do you have the context?",
      "John, do you have the context?",
      "John, do",
    ),
    "John, do you have the context?",
  );
  assert.equal(CAPTION_SETTLE_MS, 1_600);
});

test("captions matching John's recent spoken output are recognized as self-speech", () => {
  const expected = "Hi Willie, I'm John, an AI participant supporting Ben. I'm listening and keeping a transcript, so just say John whenever you'd like my input.";
  assert.equal(
    captionMatchesExpectedSpeech(
      "I'm listening and keeping a transcript, so just say John whenever you'd like my input.",
      expected,
    ),
    true,
  );
  assert.equal(
    captionMatchesExpectedSpeech(
      "Willie explained that the WordPress token field is still blocking the embed.",
      expected,
    ),
    false,
  );
});

test("caption bridge filters known Meet chrome without suppressing participant speech", () => {
  assert.match(AUDIO_BRIDGE_SCRIPT, /Summarize captions/);
  assert.match(AUDIO_BRIDGE_SCRIPT, /matchesAgentSpeech/);
  assert.equal(
    isKnownMeetChromeCaption("radio_button_checked", "This meeting is being recorded"),
    true,
  );
  assert.equal(
    isKnownMeetChromeCaption("Ben Basche", "This meeting is being recorded"),
    false,
  );
  assert.equal(
    isKnownMeetChromeCaption("radio_button_checked", "Willie explained the plugin workflow"),
    false,
  );
  assert.doesNotMatch(AUDIO_BRIDGE_SCRIPT, /Willie explained/);
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
