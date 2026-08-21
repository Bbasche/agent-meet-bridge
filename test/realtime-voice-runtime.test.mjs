import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { RealtimeVoiceRuntime } from "../src/realtime-voice-runtime.mjs";

class FakeSocket extends EventEmitter {
  static instances = [];

  constructor(url, options) {
    super();
    this.url = url;
    this.options = options;
    this.readyState = 0;
    this.sent = [];
    FakeSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(message) {
    const event = JSON.parse(message);
    this.sent.push(event);
    if (event.type === "session.update") {
      queueMicrotask(() => this.event({ type: "session.updated", session: { id: "test-session" } }));
    }
  }

  close(code, reason) {
    this.readyState = 3;
    this.emit("close", code, Buffer.from(reason));
  }

  event(payload) {
    this.emit("message", Buffer.from(JSON.stringify(payload)), false);
  }
}

function makeRuntime(options = {}) {
  return new RealtimeVoiceRuntime({
    provider: "openai",
    apiKey: "test-key",
    agentName: "Ada",
    mode: "passive",
    instructions: "Meeting assistant",
    WebSocketImpl: FakeSocket,
    reconnect: false,
    ...options,
  });
}

test("OpenAI realtime configures audio, tools, and 48k-to-24k conversion", async () => {
  FakeSocket.instances = [];
  const runtime = makeRuntime({ harnessEnabled: true });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  assert.match(socket.url, /^wss:\/\/api\.openai\.com\/v1\/realtime/);
  assert.equal(socket.options.headers.Authorization, "Bearer test-key");
  const update = socket.sent[0];
  assert.equal(update.type, "session.update");
  assert.equal(update.session.audio.input.format.rate, 24_000);
  assert.equal(update.session.tools[0].name, "ask_agent");
  runtime.appendAudio(Buffer.alloc(9_600));
  const appended = socket.sent.at(-1);
  assert.equal(Buffer.from(appended.audio, "base64").length, 4_800);
  await runtime.close();
});

test("realtime connect rejects a provider session error before readiness", async () => {
  class RejectingSocket extends FakeSocket {
    send(message) {
      const event = JSON.parse(message);
      this.sent.push(event);
      if (event.type === "session.update") {
        queueMicrotask(() => this.event({ type: "error", error: { message: "invalid voice" } }));
      }
    }
  }
  const runtime = makeRuntime({ WebSocketImpl: RejectingSocket, onError: () => {} });
  await assert.rejects(runtime.connect(), /invalid voice/);
  await runtime.close();
});

test("passive realtime buffers ambient output and releases addressed output", async () => {
  FakeSocket.instances = [];
  const audio = [];
  const runtime = makeRuntime({ onAudio: (bytes) => audio.push(bytes) });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  socket.event({ type: "response.created", response: { id: "ambient" } });
  socket.event({ type: "response.output_audio.delta", delta: Buffer.from([1, 2]).toString("base64") });
  socket.event({ type: "conversation.item.input_audio_transcription.completed", transcript: "What do you think?" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.length, 0);
  assert.ok(socket.sent.some((event) => event.type === "response.cancel"));

  socket.event({ type: "response.created", response: { id: "addressed" } });
  socket.event({ type: "response.output_audio.delta", delta: Buffer.from([3, 4]).toString("base64") });
  socket.event({ type: "conversation.item.input_audio_transcription.completed", transcript: "Ada, check that." });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.length, 1);
  await runtime.close();
});

test("passive permission survives transcript-before-response ordering", async () => {
  FakeSocket.instances = [];
  const audio = [];
  const runtime = makeRuntime({ onAudio: (bytes) => audio.push(bytes) });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Ada, are you there?",
  });
  socket.event({ type: "response.created", response: { id: "early-transcript" } });
  socket.event({ type: "response.output_audio.delta", delta: Buffer.from([5, 6]).toString("base64") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.length, 1);
  await runtime.close();
});

test("passive response waits for a late transcript after response.done", async () => {
  FakeSocket.instances = [];
  const audio = [];
  const runtime = makeRuntime({ onAudio: (bytes) => audio.push(bytes) });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  socket.event({ type: "response.created", response: { id: "late-transcript" } });
  socket.event({ type: "response.output_audio.delta", delta: Buffer.from([7, 8]).toString("base64") });
  socket.event({ type: "response.done", response: { id: "late-transcript" } });
  socket.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Ada, answer this.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.length, 1);
  await runtime.close();
});

test("realtime transcripts borrow recent Meet speaker labels", async () => {
  FakeSocket.instances = [];
  const transcripts = [];
  const runtime = makeRuntime({ mode: "active", onTranscript: (entry) => transcripts.push(entry) });
  await runtime.connect();
  runtime.appendCaption({ speaker: "Maya", text: "Ada, please inspect the webhook status." });
  FakeSocket.instances[0].event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "Ada, inspect the webhook status.",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(transcripts[0].speaker, "Maya");
  await runtime.close();
});

test("passive realtime follow-ups stay with the original speaker", async () => {
  FakeSocket.instances = [];
  const audio = [];
  const runtime = makeRuntime({ onAudio: (bytes) => audio.push(bytes) });
  await runtime.connect();
  const socket = FakeSocket.instances[0];

  runtime.appendCaption({ speaker: "Maya", text: "Ada, check the webhook." });
  socket.event({ type: "response.created", response: { id: "maya-addressed" } });
  socket.event({ type: "conversation.item.input_audio_transcription.completed", transcript: "Ada, check the webhook." });
  socket.event({ type: "response.done", response: { id: "maya-addressed" } });

  runtime.appendCaption({ speaker: "Lee", text: "What about the plugin?" });
  socket.event({ type: "response.created", response: { id: "lee-followup" } });
  socket.event({ type: "response.output_audio.delta", delta: Buffer.from([9]).toString("base64") });
  socket.event({ type: "conversation.item.input_audio_transcription.completed", transcript: "What about the plugin?" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(audio.length, 0);
  assert.ok(socket.sent.some((event) => event.type === "response.cancel" && event.response_id === "lee-followup"));
  await runtime.close();
});

test("provider-neutral realtime tools call the selected harness", async () => {
  FakeSocket.instances = [];
  const requests = [];
  const runtime = makeRuntime({
    mode: "active",
    harnessEnabled: true,
    onHarnessRequest: async (request) => {
      requests.push(request);
      return { output: "verified" };
    },
  });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  socket.event({
    type: "response.function_call_arguments.done",
    name: "ask_agent",
    call_id: "call-1",
    arguments: JSON.stringify({ question: "Check it", desired_action: "analyze" }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requests[0].question, "Check it");
  const output = socket.sent.find((event) => event.item?.type === "function_call_output");
  assert.equal(output.item.call_id, "call-1");
  assert.ok(socket.sent.some((event) => event.type === "response.create"));
  await runtime.close();
});

test("Grok provider uses its current speech-to-speech session shape", async () => {
  FakeSocket.instances = [];
  const runtime = makeRuntime({ provider: "grok" });
  await runtime.connect();
  const socket = FakeSocket.instances[0];
  assert.match(socket.url, /^wss:\/\/api\.x\.ai\/v1\/realtime/);
  assert.equal(socket.sent[0].session.audio.input.format.rate, 48_000);
  assert.equal(socket.sent[0].session.audio.input.transcription.model, "grok-transcribe");
  await runtime.close();
});
