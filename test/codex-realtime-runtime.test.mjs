import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexRealtimeVoiceRuntime,
  REALTIME_METHODS,
  REALTIME_NOTIFICATIONS,
} from "../src/codex-realtime-runtime.mjs";

class FakeCodex {
  constructor() {
    this.calls = [];
    this.listeners = new Map();
    this.child = {};
  }

  async start() {}

  async request(method, params) {
    this.calls.push({ method, params });
    return {};
  }

  onNotification(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }
}

function audioParams(data = Buffer.from([1, 2, 3, 4])) {
  return {
    threadId: "thread-1",
    audio: { data: data.toString("base64"), sampleRate: 24_000, numChannels: 1 },
  };
}

test("Codex realtime negotiates a thread-scoped subscription session", async () => {
  const codex = new FakeCodex();
  const runtime = new CodexRealtimeVoiceRuntime({
    codex,
    threadId: "thread-1",
    instructions: "Be the meeting agent",
  });
  await runtime.connect();
  assert.deepEqual(codex.calls[0], {
    method: "thread/resume",
    params: { threadId: "thread-1" },
  });
  assert.deepEqual(codex.calls[1], {
    method: REALTIME_METHODS.start,
    params: {
      threadId: "thread-1",
      outputModality: "audio",
      version: "v2",
      voice: "marin",
      transport: { type: "websocket" },
      prompt: "Be the meeting agent",
      includeStartupContext: true,
      clientManagedHandoffs: false,
      codexResponsesAsItems: true,
      flushTranscriptTailOnSessionEnd: true,
    },
  });
  await runtime.close();
});

test("newly created tasks can start realtime without a redundant resume", async () => {
  const codex = new FakeCodex();
  const runtime = new CodexRealtimeVoiceRuntime({
    codex,
    threadId: "thread-1",
    instructions: "Be the meeting agent",
    resumeThread: false,
  });
  await runtime.connect();
  assert.equal(codex.calls[0].method, REALTIME_METHODS.start);
  await runtime.close();
});

test("passive mode suppresses ambient answers and releases addressed audio", async () => {
  const codex = new FakeCodex();
  const played = [];
  const transcripts = [];
  const runtime = new CodexRealtimeVoiceRuntime({
    codex,
    threadId: "thread-1",
    instructions: "Be the meeting agent",
    agentName: "Atlas",
    mode: "passive",
    onAudio: (bytes, metadata) => played.push({ bytes, metadata }),
    onTranscript: (entry) => transcripts.push(entry),
  });
  await runtime.connect();

  codex.emit(REALTIME_NOTIFICATIONS.transcriptDelta, { threadId: "thread-1", role: "user", delta: "What" });
  codex.emit(REALTIME_NOTIFICATIONS.outputAudio, audioParams());
  codex.emit(REALTIME_NOTIFICATIONS.transcriptDone, { threadId: "thread-1", role: "user", text: "What do you think, Alex?" });
  await new Promise(setImmediate);
  assert.equal(played.length, 0);

  codex.emit(REALTIME_NOTIFICATIONS.transcriptDelta, { threadId: "thread-1", role: "user", delta: "Atlas" });
  codex.emit(REALTIME_NOTIFICATIONS.outputAudio, audioParams(Buffer.from([5, 6])));
  codex.emit(REALTIME_NOTIFICATIONS.transcriptDone, { threadId: "thread-1", role: "user", text: "Atlas, check the plugin." });
  await new Promise(setImmediate);
  assert.equal(played.length, 1);
  assert.equal(played[0].metadata.sampleRate, 24_000);
  assert.deepEqual(transcripts.map(({ speaker, text }) => ({ speaker, text })), [
    { speaker: "Meeting", text: "What do you think, Alex?" },
    { speaker: "Meeting", text: "Atlas, check the plugin." },
  ]);
  await runtime.close();
});

test("explicit sidecar speech crosses the passive output gate", async () => {
  const codex = new FakeCodex();
  const played = [];
  const runtime = new CodexRealtimeVoiceRuntime({
    codex,
    threadId: "thread-1",
    instructions: "Be the meeting agent",
    mode: "passive",
    onAudio: (bytes) => played.push(bytes),
  });
  await runtime.connect();
  await runtime.speak("A reviewed answer");
  codex.emit(REALTIME_NOTIFICATIONS.outputAudio, audioParams());
  await new Promise(setImmediate);
  assert.equal(played.length, 1);
  assert.equal(codex.calls.at(-1).method, REALTIME_METHODS.speech);
  await runtime.close();
});

test("audio input includes exact PCM shape metadata", async () => {
  const codex = new FakeCodex();
  const runtime = new CodexRealtimeVoiceRuntime({
    codex,
    threadId: "thread-1",
    instructions: "Be the meeting agent",
  });
  await runtime.connect();
  assert.equal(runtime.appendAudio(Buffer.alloc(9_600)), true);
  await new Promise(setImmediate);
  const request = codex.calls.find((call) => call.method === REALTIME_METHODS.audio);
  assert.equal(request.params.audio.sampleRate, 48_000);
  assert.equal(request.params.audio.numChannels, 1);
  assert.equal(request.params.audio.samplesPerChannel, 4_800);
  await runtime.close();
});
