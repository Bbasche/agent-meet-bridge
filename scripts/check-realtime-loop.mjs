import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { REALTIME_PROVIDERS, RealtimeVoiceRuntime } from "../src/realtime-voice-runtime.mjs";

const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
await once(server, "listening");
const address = server.address();
if (!address || typeof address === "string") throw new Error("Loopback WebSocket server did not bind");

const provider = {
  ...REALTIME_PROVIDERS.openai,
  id: "loopback",
  url: () => `ws://127.0.0.1:${address.port}/realtime`,
};

let inputBytes = 0;
let toolOutput = null;
let sawAuthorization = false;
let resolveFinished;
let rejectFinished;
const finished = new Promise((resolve, reject) => {
  resolveFinished = resolve;
  rejectFinished = reject;
});

server.on("connection", (socket, request) => {
  sawAuthorization = request.headers.authorization === "Bearer loopback-key";
  socket.on("message", (wire) => {
    try {
      const event = JSON.parse(wire.toString());
      if (event.type === "session.update") {
        assert.equal(event.session.audio.input.format.rate, 24_000);
        assert.equal(event.session.tools[0].name, "ask_agent");
        socket.send(JSON.stringify({ type: "session.updated", session: { id: "loopback-session" } }));
        return;
      }
      if (event.type === "input_audio_buffer.append") {
        inputBytes += Buffer.from(event.audio, "base64").length;
        socket.send(JSON.stringify({
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "Ada, inspect the repository status.",
        }));
        socket.send(JSON.stringify({ type: "response.created", response: { id: "tool-response" } }));
        socket.send(JSON.stringify({
          type: "response.function_call_arguments.done",
          name: "ask_agent",
          call_id: "loopback-call",
          arguments: JSON.stringify({ question: "Inspect the repository status.", desired_action: "analyze" }),
        }));
        return;
      }
      if (event.type === "conversation.item.create" && event.item?.type === "function_call_output") {
        toolOutput = JSON.parse(event.item.output);
        return;
      }
      if (event.type === "response.create" && toolOutput) {
        socket.send(JSON.stringify({ type: "response.created", response: { id: "spoken-response" } }));
        socket.send(JSON.stringify({
          type: "response.output_audio.delta",
          delta: Buffer.from([1, 2, 3, 4]).toString("base64"),
        }));
        socket.send(JSON.stringify({
          type: "response.output_audio_transcript.done",
          transcript: "The repository is ready.",
        }));
        socket.send(JSON.stringify({ type: "response.done", response: { id: "spoken-response" } }));
      }
    } catch (error) {
      rejectFinished(error);
    }
  });
});

const transcripts = [];
const audio = [];
const harnessRequests = [];
const statuses = [];
const runtime = new RealtimeVoiceRuntime({
  provider,
  apiKey: "loopback-key",
  agentName: "Ada",
  mode: "passive",
  instructions: "Loopback integration check",
  harnessEnabled: true,
  reconnect: false,
  startupTimeoutMs: 2_000,
  onAudio: (chunk) => audio.push(Buffer.from(chunk)),
  onTranscript: (entry) => {
    transcripts.push(entry);
    if (entry.kind === "assistant") resolveFinished();
  },
  onHarnessRequest: async (request) => {
    harnessRequests.push(request);
    return { output: "The repository is ready." };
  },
  onStatus: (status) => statuses.push(status.state),
  onError: rejectFinished,
});

try {
  await runtime.connect();
  runtime.appendAudio(Buffer.alloc(9_600, 1), { sampleRate: 48_000 });
  await Promise.race([
    finished,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Realtime loopback timed out")), 3_000)),
  ]);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(sawAuthorization, true);
  assert.equal(inputBytes, 4_800, "48 kHz PCM should be downsampled to 24 kHz");
  assert.equal(harnessRequests.length, 1);
  assert.equal(harnessRequests[0].desired_action, "analyze");
  assert.equal(toolOutput.output, "The repository is ready.");
  assert.equal(Buffer.concat(audio).length, 4);
  assert.ok(transcripts.some((entry) => entry.kind === "speech" && entry.text.includes("Ada")));
  assert.ok(transcripts.some((entry) => entry.kind === "assistant" && entry.text === "The repository is ready."));
  assert.ok(statuses.includes("connected"));
  console.log("✓ Realtime loopback: WebSocket + PCM + wake gate + harness tool + spoken output");
} finally {
  await runtime.close();
  await new Promise((resolve) => server.close(resolve));
}
