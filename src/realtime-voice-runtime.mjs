import WebSocket from "ws";
import { createAskAgentTool, utteranceAddressesAgent } from "./policy.mjs";

const OPEN = WebSocket.OPEN;

function transcriptText(event) {
  return String(
    event.transcript ?? event.text ?? event.delta ?? event.item?.content?.[0]?.transcript ?? "",
  ).trim();
}

function downsample48kTo24k(pcmBytes) {
  const input = new Int16Array(
    pcmBytes.buffer,
    pcmBytes.byteOffset,
    Math.floor(pcmBytes.byteLength / 2),
  );
  const output = Buffer.allocUnsafe(Math.floor(input.length / 2) * 2);
  for (let source = 0, target = 0; source + 1 < input.length; source += 2, target += 2) {
    output.writeInt16LE(Math.round((input[source] + input[source + 1]) / 2), target);
  }
  return output;
}

export const REALTIME_PROVIDERS = Object.freeze({
  openai: {
    id: "openai",
    defaultModel: "gpt-realtime-2.1",
    defaultVoice: "marin",
    inputRate: 24_000,
    outputRate: 24_000,
    url(model) {
      return `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(model)}`;
    },
    headers(apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    session({ model, voice, instructions, tools, reasoningEffort }) {
      return {
        type: "realtime",
        model,
        instructions,
        output_modalities: ["audio"],
        reasoning: { effort: reasoningEffort ?? "low" },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24_000 },
            transcription: { model: "gpt-4o-mini-transcribe" },
            turn_detection: {
              type: "server_vad",
              threshold: 0.72,
              prefix_padding_ms: 350,
              silence_duration_ms: 650,
              create_response: true,
              interrupt_response: true,
            },
          },
          output: {
            format: { type: "audio/pcm", rate: 24_000 },
            voice,
          },
        },
        tools,
      };
    },
    speakEvents(text) {
      return [{
        type: "response.create",
        response: {
          output_modalities: ["audio"],
          instructions: `Speak this operator-supplied message exactly and naturally, without adding commentary: ${text}`,
        },
      }];
    },
  },
  grok: {
    id: "grok",
    defaultModel: "grok-voice-latest",
    defaultVoice: "eve",
    inputRate: 48_000,
    outputRate: 48_000,
    url(model) {
      return `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(model)}`;
    },
    headers(apiKey) {
      return { Authorization: `Bearer ${apiKey}` };
    },
    session({ voice, instructions, tools, reasoningEffort }) {
      return {
        voice,
        instructions,
        reasoning: { effort: reasoningEffort ?? "high" },
        turn_detection: {
          type: "server_vad",
          threshold: 0.78,
          prefix_padding_ms: 350,
          silence_duration_ms: 750,
        },
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 48_000 },
            transcription: { model: "grok-transcribe" },
          },
          output: { format: { type: "audio/pcm", rate: 48_000 } },
        },
        tools,
      };
    },
    speakEvents(text, { interruptible = true } = {}) {
      return [{
        type: "conversation.item.create",
        item: {
          type: "force_message",
          role: "assistant",
          interruptible,
          content: [{ type: "output_text", text }],
        },
      }];
    },
  },
});

export class RealtimeVoiceRuntime {
  constructor({
    provider,
    apiKey,
    model,
    voice,
    reasoningEffort,
    instructions,
    agentName,
    mode,
    harnessEnabled = false,
    onAudio,
    onBargeIn,
    onTranscript,
    onHarnessRequest,
    onStatus,
    onError,
    logger = console,
    WebSocketImpl = WebSocket,
    reconnect = true,
    reconnectMaxDelayMs = 30_000,
    maxBufferedAudioBytes,
    startupTimeoutMs = 15_000,
  }) {
    const config = typeof provider === "string" ? REALTIME_PROVIDERS[provider] : provider;
    if (!config) throw new Error(`Unsupported realtime provider: ${provider}`);
    if (!apiKey) throw new Error(`${config.id} realtime requires an API key`);
    this.provider = config;
    this.apiKey = apiKey;
    this.model = model ?? config.defaultModel;
    this.voice = voice ?? config.defaultVoice;
    this.reasoningEffort = reasoningEffort;
    this.instructions = instructions;
    this.agentName = agentName;
    this.mode = mode;
    this.harnessEnabled = harnessEnabled;
    this.onAudio = onAudio;
    this.onBargeIn = onBargeIn;
    this.onTranscript = onTranscript;
    this.onHarnessRequest = onHarnessRequest;
    this.onStatus = onStatus;
    this.onError = onError;
    this.logger = logger;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnect = reconnect;
    this.reconnectMaxDelayMs = reconnectMaxDelayMs;
    this.maxBufferedAudioBytes = maxBufferedAudioBytes ?? config.inputRate * 2 * 2;
    this.startupTimeoutMs = startupTimeoutMs;
    this.socket = null;
    this.connectPromise = null;
    this.closing = false;
    this.reconnectTimer = null;
    this.reconnectAttempts = 0;
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
    this.currentResponse = null;
    this.pendingResponsePermission = null;
    this.followupUntil = 0;
    this.forceNextResponse = false;
    this.transcriptionTimers = new Map();
    this.latestTranscriptions = new Map();
    this.conversationId = null;
    this.startup = null;
  }

  get connected() {
    return this.socket?.readyState === OPEN;
  }

  async connect() {
    if (this.connected) return;
    if (this.connectPromise) return this.connectPromise;
    this.closing = false;
    this.connectPromise = this.#open();
    try {
      await this.connectPromise;
    } finally {
      this.connectPromise = null;
    }
  }

  appendAudio(pcmBytes, { sampleRate = 48_000 } = {}) {
    if (!pcmBytes?.length || this.closing) return false;
    let audio = Buffer.from(pcmBytes);
    if (sampleRate === 48_000 && this.provider.inputRate === 24_000) {
      audio = downsample48kTo24k(audio);
    } else if (sampleRate !== this.provider.inputRate) {
      this.logger.warn?.(
        `[${this.provider.id}] ignored unsupported ${sampleRate}Hz audio; expected ${this.provider.inputRate}Hz`,
      );
      return false;
    }
    if (!this.connected) {
      this.#bufferAudio(audio);
      return false;
    }
    this.#send({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
    return true;
  }

  announce(text) {
    return this.speak(text, { interruptible: false });
  }

  async speak(text, options = {}) {
    if (!this.connected) throw new Error(`${this.provider.id} realtime is not connected`);
    this.forceNextResponse = true;
    for (const event of this.provider.speakEvents(String(text).slice(0, 2_000), options)) {
      this.#send(event);
    }
  }

  async close() {
    this.closing = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    for (const timer of this.transcriptionTimers.values()) clearTimeout(timer);
    this.transcriptionTimers.clear();
    clearTimeout(this.currentResponse?.cleanupTimer);
    this.startup?.reject(new Error(`${this.provider.id} realtime closed before session readiness`));
    this.startup = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && socket.readyState < 2) socket.close(1000, "meeting ended");
    await this.onStatus?.({ state: "closed", provider: this.provider.id });
  }

  async #open() {
    await this.onStatus?.({ state: "connecting", provider: this.provider.id });
    const url = new URL(this.provider.url(this.model));
    if (this.provider.id === "grok" && this.conversationId) {
      url.searchParams.set("conversation_id", this.conversationId);
    }
    const socket = new this.WebSocketImpl(url.toString(), {
      headers: this.provider.headers(this.apiKey),
    });
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onAudio?.(Buffer.from(data), { sampleRate: this.provider.outputRate, numChannels: 1 });
        return;
      }
      let event;
      try {
        event = JSON.parse(data.toString());
      } catch {
        this.logger.warn?.(`[${this.provider.id}] ignored an invalid JSON event`);
        return;
      }
      this.#handleEvent(event).catch((error) => {
        this.logger.error?.(`[${this.provider.id}] ${error.message}`);
        this.onError?.(error);
      });
    });
    socket.on("error", (error) => this.logger.error?.(`[${this.provider.id}] ${error.message}`));
    socket.on("close", (code, reason) => this.#handleClose(socket, code, reason));
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const ready = new Promise((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error(`${this.provider.id} realtime session was not acknowledged`)),
        this.startupTimeoutMs,
      );
      timeout.unref?.();
      this.startup = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
    });
    try {
      this.#send({
        type: "session.update",
        session: this.provider.session({
          model: this.model,
          voice: this.voice,
          instructions: this.instructions,
          tools: this.harnessEnabled ? [createAskAgentTool()] : [],
          reasoningEffort: this.reasoningEffort,
        }),
      });
      await ready;
      this.reconnectAttempts = 0;
      this.#flushAudio();
      await this.onStatus?.({ state: "connected", provider: this.provider.id });
    } finally {
      this.startup = null;
    }
  }

  #handleClose(socket, code, reason) {
    if (this.socket !== socket) return;
    this.socket = null;
    this.startup?.reject(new Error(`${this.provider.id} realtime disconnected before session readiness`));
    if (this.closing) return;
    this.onStatus?.({ state: "reconnecting", provider: this.provider.id });
    this.logger.warn?.(`[${this.provider.id}] disconnected (${code}) ${reason.toString()}`);
    if (!this.reconnect) return;
    const attempt = ++this.reconnectAttempts;
    const delay = Math.min(this.reconnectMaxDelayMs, 500 * (2 ** Math.min(attempt - 1, 6)));
    const jitter = Math.floor(Math.random() * Math.min(500, delay / 4));
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.connect().catch((error) => {
        this.logger.error?.(`[${this.provider.id}] reconnect failed: ${error.message}`);
        if (!this.closing) this.#scheduleReconnect();
      });
    }, delay + jitter);
    this.reconnectTimer.unref?.();
  }

  #scheduleReconnect() {
    const socket = this.socket;
    if (socket) this.#handleClose(socket, 1006, Buffer.from("reconnect failed"));
    else {
      this.socket = { close() {}, readyState: 3 };
      this.#handleClose(this.socket, 1006, Buffer.from("reconnect failed"));
    }
  }

  #bufferAudio(audio) {
    this.audioBuffer.push(audio);
    this.audioBufferBytes += audio.length;
    while (this.audioBufferBytes > this.maxBufferedAudioBytes && this.audioBuffer.length) {
      this.audioBufferBytes -= this.audioBuffer.shift().length;
    }
  }

  #flushAudio() {
    for (const audio of this.audioBuffer) {
      this.#send({ type: "input_audio_buffer.append", audio: audio.toString("base64") });
    }
    this.audioBuffer = [];
    this.audioBufferBytes = 0;
  }

  async #handleEvent(event) {
    if (event.type === "error") {
      const error = new Error(event.error?.message ?? JSON.stringify(event));
      this.startup?.reject(error);
      throw error;
    }
    if (event.type === "session.created" || event.type === "session.updated") {
      this.conversationId = event.session?.conversation_id ?? event.session?.id ?? this.conversationId;
      if (event.type === "session.updated") this.startup?.resolve();
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      await this.onBargeIn?.();
      return;
    }
    if (
      event.type === "conversation.item.input_audio_transcription.completed" ||
      event.type === "conversation.item.input_audio_transcription.done"
    ) {
      await this.#handleInputTranscript(transcriptText(event));
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.updated") {
      const key = event.item_id ?? "current";
      this.latestTranscriptions.set(key, transcriptText(event));
      clearTimeout(this.transcriptionTimers.get(key));
      const timer = setTimeout(() => {
        this.transcriptionTimers.delete(key);
        const text = this.latestTranscriptions.get(key);
        this.latestTranscriptions.delete(key);
        this.#handleInputTranscript(text).catch((error) => this.logger.error?.(`[${this.provider.id}] ${error.message}`));
      }, 300);
      timer.unref?.();
      this.transcriptionTimers.set(key, timer);
      return;
    }
    if (event.type === "response.created") {
      const forced = this.forceNextResponse;
      this.forceNextResponse = false;
      const predecided = forced || this.mode !== "passive" || this.pendingResponsePermission !== null;
      const allowed = forced || this.mode !== "passive" || this.pendingResponsePermission === true;
      this.pendingResponsePermission = null;
      clearTimeout(this.currentResponse?.cleanupTimer);
      this.currentResponse = {
        id: event.response?.id,
        decided: predecided,
        allowed,
        done: false,
        bufferedAudio: [],
        pendingCalls: [],
        cleanupTimer: null,
      };
      if (predecided && !allowed && this.connected) {
        this.#send({ type: "response.cancel", response_id: this.currentResponse.id });
      }
      return;
    }
    if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
      const audio = Buffer.from(event.delta ?? event.audio ?? "", "base64");
      if (!audio.length) return;
      if (!this.currentResponse || this.currentResponse.allowed) {
        await this.onAudio?.(audio, { sampleRate: this.provider.outputRate, numChannels: 1 });
      } else if (!this.currentResponse.decided) {
        this.currentResponse.bufferedAudio.push(audio);
      }
      return;
    }
    if (event.type === "response.output_audio_transcript.done" || event.type === "response.audio_transcript.done") {
      const text = transcriptText(event);
      if (text && (!this.currentResponse || this.currentResponse.allowed)) {
        await this.onTranscript?.({ speaker: this.agentName, text, kind: "assistant" });
      }
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      await this.#handleFunctionCall(event);
      return;
    }
    if (event.type === "response.done") {
      if (!this.currentResponse) return;
      this.currentResponse.done = true;
      if (this.currentResponse.decided) {
        this.currentResponse = null;
      } else {
        const response = this.currentResponse;
        response.cleanupTimer = setTimeout(() => {
          if (this.currentResponse === response) this.currentResponse = null;
        }, 2_000);
        response.cleanupTimer.unref?.();
      }
    }
  }

  async #handleInputTranscript(text) {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    await this.onTranscript?.({ speaker: "Meeting", text: clean, kind: "speech" });
    if (this.mode !== "passive") return;
    const directlyAddressed = utteranceAddressesAgent(clean, this.agentName);
    if (directlyAddressed) this.followupUntil = Date.now() + 45_000;
    const allowed = directlyAddressed || Date.now() < this.followupUntil;
    if (this.currentResponse && !this.currentResponse.decided) {
      clearTimeout(this.currentResponse.cleanupTimer);
      this.currentResponse.decided = true;
      this.currentResponse.allowed = allowed;
      if (allowed) {
        for (const audio of this.currentResponse.bufferedAudio) {
          await this.onAudio?.(audio, { sampleRate: this.provider.outputRate, numChannels: 1 });
        }
        for (const call of this.currentResponse.pendingCalls) await this.#handleFunctionCall(call);
      } else if (this.connected) {
        this.#send({ type: "response.cancel", response_id: this.currentResponse.id });
      }
      this.currentResponse.bufferedAudio = [];
      this.currentResponse.pendingCalls = [];
      if (this.currentResponse.done) this.currentResponse = null;
    } else if (!this.currentResponse) {
      // Providers do not guarantee whether transcription or response.created
      // arrives first, so carry this decision into the next response.
      this.pendingResponsePermission = allowed;
    }
  }

  async #handleFunctionCall(event) {
    if (!["ask_agent", "ask_codex"].includes(event.name) || !this.onHarnessRequest) return;
    if (this.mode === "passive" && this.currentResponse && !this.currentResponse.decided) {
      this.currentResponse.pendingCalls.push(event);
      return;
    }
    if (this.mode === "passive" && !this.currentResponse?.allowed) return;
    let output;
    try {
      output = await this.onHarnessRequest(JSON.parse(event.arguments));
    } catch (error) {
      output = { error: error.message };
    }
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "function_call_output",
        call_id: event.call_id,
        output: JSON.stringify(output),
      },
    });
    this.forceNextResponse = true;
    this.#send({ type: "response.create" });
  }

  #send(message) {
    if (!this.connected) throw new Error(`${this.provider.id} realtime is not connected`);
    this.socket.send(JSON.stringify(message));
  }
}
