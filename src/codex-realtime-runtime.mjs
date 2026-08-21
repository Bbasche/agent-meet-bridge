import { utteranceAddressesAgent } from "./policy.mjs";

const REALTIME_METHODS = Object.freeze({
  start: "thread/realtime/start",
  stop: "thread/realtime/stop",
  audio: "thread/realtime/appendAudio",
  speech: "thread/realtime/appendSpeech",
  voices: "thread/realtime/listVoices",
});

const REALTIME_NOTIFICATIONS = Object.freeze({
  started: "thread/realtime/started",
  transcriptDelta: "thread/realtime/transcript/delta",
  transcriptDone: "thread/realtime/transcript/done",
  outputAudio: "thread/realtime/outputAudio/delta",
  error: "thread/realtime/error",
  closed: "thread/realtime/closed",
});

function isUserRole(role) {
  return role === "user" || role === "input";
}

function isAssistantRole(role) {
  return role === "assistant" || role === "output";
}

export class CodexRealtimeVoiceRuntime {
  constructor({
    codex,
    threadId,
    instructions,
    agentName = "Agent",
    mode = "passive",
    voice = "marin",
    version = "v2",
    resumeThread = true,
    maxInflightAudio = 20,
    followupWindowMs = 45_000,
    startupTimeoutMs = 15_000,
    onAudio,
    onBargeIn,
    onTranscript,
    onStatus,
    logger = console,
  }) {
    if (!codex) throw new Error("A Codex app-server client is required");
    if (!threadId) throw new Error("A Codex task ID is required for realtime voice");
    this.codex = codex;
    this.threadId = threadId;
    this.instructions = instructions;
    this.agentName = agentName;
    this.mode = mode;
    this.voice = voice;
    this.version = version;
    this.resumeThread = resumeThread;
    this.maxInflightAudio = maxInflightAudio;
    this.followupWindowMs = followupWindowMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.onAudio = onAudio;
    this.onBargeIn = onBargeIn;
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.logger = logger;
    this.connected = false;
    this.closing = false;
    this.inflightAudio = new Set();
    this.unsubscribe = [];
    this.followupUntil = 0;
    this.passiveDecisionKnown = mode !== "passive";
    this.passiveOutputAllowed = mode !== "passive";
    this.bufferedOutputAudio = [];
    this.forcedSpeech = false;
    this.userSpeechActive = false;
    this.droppedAudioFrames = 0;
    this.startup = null;
  }

  async listVoices() {
    await this.codex.start();
    return this.codex.request(REALTIME_METHODS.voices, {});
  }

  async connect() {
    if (this.connected) return;
    this.closing = false;
    this.#subscribe();
    await this.codex.start();
    if (this.resumeThread) {
      if (this.codex.ensureThread) await this.codex.ensureThread(this.threadId);
      else await this.codex.request("thread/resume", { threadId: this.threadId }, 60_000);
    }
    const started = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex realtime did not start")), this.startupTimeoutMs);
      timeout.unref?.();
      this.startup = {
        resolve: () => { clearTimeout(timeout); resolve(); },
        reject: (error) => { clearTimeout(timeout); reject(error); },
      };
    });
    try {
      await this.codex.request(REALTIME_METHODS.start, {
        threadId: this.threadId,
        outputModality: "audio",
        version: this.version,
        voice: this.voice,
        transport: { type: "websocket" },
        prompt: this.instructions,
        includeStartupContext: true,
        clientManagedHandoffs: false,
        codexResponsesAsItems: true,
        flushTranscriptTailOnSessionEnd: true,
      }, 60_000);
      await started;
      this.connected = true;
      await this.onStatus?.({ state: "connected", provider: "codex", voice: this.voice });
    } finally {
      this.startup = null;
    }
  }

  appendAudio(pcmBytes, { sampleRate = 48_000, numChannels = 1 } = {}) {
    if (!this.connected || this.closing || !pcmBytes?.length) return false;
    if (this.inflightAudio.size >= this.maxInflightAudio) {
      this.droppedAudioFrames += 1;
      if (this.droppedAudioFrames === 1 || this.droppedAudioFrames % 100 === 0) {
        this.logger.warn?.(`[codex realtime] dropped ${this.droppedAudioFrames} audio frame(s) under backpressure`);
      }
      return false;
    }
    const bytes = Buffer.from(pcmBytes);
    const samplesPerChannel = Math.floor(bytes.length / 2 / numChannels);
    const request = this.codex.request(REALTIME_METHODS.audio, {
      threadId: this.threadId,
      audio: {
        data: bytes.toString("base64"),
        sampleRate,
        numChannels,
        samplesPerChannel,
      },
    }, 5_000).catch((error) => {
      if (!this.closing) this.logger.error?.(`[codex realtime] audio append failed: ${error.message}`);
    }).finally(() => this.inflightAudio.delete(request));
    this.inflightAudio.add(request);
    return true;
  }

  announce(text) {
    return this.speak(text);
  }

  async speak(text) {
    if (!this.connected) throw new Error("Codex realtime is not connected");
    const clean = String(text ?? "").trim();
    if (!clean) return;
    this.forcedSpeech = true;
    this.bufferedOutputAudio = [];
    await this.codex.request(REALTIME_METHODS.speech, {
      threadId: this.threadId,
      text: clean,
    });
  }

  async close() {
    if (this.closing) return;
    this.closing = true;
    this.connected = false;
    this.bufferedOutputAudio = [];
    this.#unsubscribe();
    try {
      await this.codex.request(REALTIME_METHODS.stop, { threadId: this.threadId }, 10_000);
    } catch (error) {
      if (this.codex.child) this.logger.warn?.(`[codex realtime] stop failed: ${error.message}`);
    }
    await this.onStatus?.({ state: "closed", provider: "codex" });
  }

  #subscribe() {
    if (this.unsubscribe.length) return;
    const on = (method, listener) => this.unsubscribe.push(this.codex.onNotification(method, listener));
    on(REALTIME_NOTIFICATIONS.started, (params) => this.#forThisThread(params, () => {
      this.connected = true;
      this.startup?.resolve();
    }));
    on(REALTIME_NOTIFICATIONS.transcriptDelta, (params) => this.#forThisThread(params, () => {
      this.#handleTranscriptDelta(params).catch((error) => this.logger.error?.(error));
    }));
    on(REALTIME_NOTIFICATIONS.transcriptDone, (params) => this.#forThisThread(params, () => {
      this.#handleTranscriptDone(params).catch((error) => this.logger.error?.(error));
    }));
    on(REALTIME_NOTIFICATIONS.outputAudio, (params) => this.#forThisThread(params, () => {
      this.#handleOutputAudio(params).catch((error) => this.logger.error?.(error));
    }));
    on(REALTIME_NOTIFICATIONS.error, (params) => this.#forThisThread(params, () => {
      this.logger.error?.(`[codex realtime] ${params.message}`);
      this.startup?.reject(new Error(params.message));
      this.onStatus?.({ state: "error", provider: "codex", message: params.message });
    }));
    on(REALTIME_NOTIFICATIONS.closed, (params) => this.#forThisThread(params, () => {
      this.connected = false;
      if (!this.closing) {
        this.logger.warn?.(`[codex realtime] disconnected${params.reason ? `: ${params.reason}` : ""}`);
        this.onStatus?.({ state: "disconnected", provider: "codex", message: params.reason ?? null });
      }
    }));
  }

  #unsubscribe() {
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  #forThisThread(params, action) {
    if (params.threadId === this.threadId) action();
  }

  async #handleTranscriptDelta({ role }) {
    if (!isUserRole(role) || this.userSpeechActive) return;
    this.userSpeechActive = true;
    this.bufferedOutputAudio = [];
    if (this.mode === "passive" && !this.forcedSpeech) {
      this.passiveDecisionKnown = false;
      this.passiveOutputAllowed = false;
    }
    await this.onBargeIn?.();
  }

  async #handleTranscriptDone({ role, text }) {
    const clean = String(text ?? "").trim();
    if (!clean) return;
    if (isUserRole(role)) {
      this.userSpeechActive = false;
      if (this.mode === "passive") {
        const addressed = utteranceAddressesAgent(clean, this.agentName);
        if (addressed) this.followupUntil = Date.now() + this.followupWindowMs;
        this.passiveOutputAllowed = addressed || Date.now() < this.followupUntil;
        this.passiveDecisionKnown = true;
        if (this.passiveOutputAllowed) await this.#flushBufferedAudio();
        else this.bufferedOutputAudio = [];
      }
      await this.onTranscript?.({ speaker: "Meeting", text: clean, kind: "speech", role: "user" });
      return;
    }
    if (isAssistantRole(role)) {
      const allowed = this.mode !== "passive" || this.forcedSpeech || this.passiveOutputAllowed;
      if (allowed) {
        await this.onTranscript?.({ speaker: this.agentName, text: clean, kind: "assistant", role: "assistant" });
      }
      this.forcedSpeech = false;
      this.bufferedOutputAudio = [];
    }
  }

  async #handleOutputAudio({ audio }) {
    const bytes = Buffer.from(audio?.data ?? "", "base64");
    if (!bytes.length) return;
    const chunk = {
      bytes,
      sampleRate: audio.sampleRate ?? 24_000,
      numChannels: audio.numChannels ?? 1,
    };
    if (this.mode !== "passive" || this.forcedSpeech || this.passiveOutputAllowed) {
      await this.onAudio?.(chunk.bytes, chunk);
      return;
    }
    if (!this.passiveDecisionKnown) this.bufferedOutputAudio.push(chunk);
  }

  async #flushBufferedAudio() {
    const chunks = this.bufferedOutputAudio.splice(0);
    for (const chunk of chunks) await this.onAudio?.(chunk.bytes, chunk);
  }
}

export { REALTIME_METHODS, REALTIME_NOTIFICATIONS };
