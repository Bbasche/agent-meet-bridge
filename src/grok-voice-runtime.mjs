import WebSocket from "ws";
import { createAskCodexTool, utteranceAddressesAgent } from "./policy.mjs";

const OPEN = WebSocket.OPEN;

function eventTranscript(event) {
  return String(event.transcript ?? event.text ?? event.item?.content?.[0]?.transcript ?? "").trim();
}

export class GrokVoiceRuntime {
  constructor({
    apiKey,
    model = "grok-voice-latest",
    voice = "eve",
    instructions,
    agentName,
    mode,
    codexEnabled = false,
    onAudio,
    onBargeIn,
    onTranscript,
    onCodexRequest,
    logger = console,
  }) {
    this.apiKey = apiKey;
    this.model = model;
    this.voice = voice;
    this.instructions = instructions;
    this.agentName = agentName;
    this.mode = mode;
    this.codexEnabled = codexEnabled;
    this.onAudio = onAudio;
    this.onBargeIn = onBargeIn;
    this.onTranscript = onTranscript;
    this.onCodexRequest = onCodexRequest;
    this.logger = logger;
    this.socket = null;
    this.currentResponse = null;
    this.lastPassiveDecision = false;
    this.followupUntil = 0;
    this.forceNextResponse = false;
  }

  async connect() {
    if (this.socket) return;
    const url = `wss://api.x.ai/v1/realtime?model=${encodeURIComponent(this.model)}`;
    const socket = new WebSocket(url, {
      headers: { Authorization: `Bearer ${this.apiKey}` },
    });
    this.socket = socket;
    socket.on("message", (data, isBinary) => {
      if (isBinary) {
        this.onAudio?.(Buffer.from(data));
        return;
      }
      this.#handleEvent(JSON.parse(data.toString())).catch((error) => this.logger.error(error));
    });
    socket.on("error", (error) => this.logger.error?.(`[grok] ${error.message}`));
    socket.on("close", (code, reason) => {
      this.logger.warn?.(`[grok] disconnected (${code}) ${reason.toString()}`);
      this.socket = null;
    });
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    this.#send({
      type: "session.update",
      session: {
        voice: this.voice,
        instructions: this.instructions,
        reasoning: { effort: "high" },
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
        tools: this.codexEnabled ? [createAskCodexTool()] : [],
      },
    });
  }

  appendAudio(pcmBytes) {
    if (this.socket?.readyState !== OPEN) return;
    this.#send({ type: "input_audio_buffer.append", audio: Buffer.from(pcmBytes).toString("base64") });
  }

  announce(text) {
    this.speak(text, { interruptible: false });
  }

  speak(text, { interruptible = true } = {}) {
    this.forceNextResponse = true;
    this.#send({
      type: "conversation.item.create",
      item: {
        type: "force_message",
        role: "assistant",
        interruptible,
        content: [{ type: "output_text", text }],
      },
    });
  }

  close() {
    this.socket?.close(1000, "meeting ended");
    this.socket = null;
  }

  async #handleEvent(event) {
    if (event.type === "error") {
      this.logger.error?.(`[grok] ${event.error?.message ?? JSON.stringify(event)}`);
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      await this.onBargeIn?.();
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed") {
      const text = eventTranscript(event);
      if (text) await this.onTranscript?.({ speaker: "Meeting", text, kind: "speech" });
      if (this.mode === "passive") {
        const directlyAddressed = utteranceAddressesAgent(text, this.agentName);
        if (directlyAddressed) this.followupUntil = Date.now() + 45_000;
        this.lastPassiveDecision = directlyAddressed || Date.now() < this.followupUntil;
        if (this.currentResponse && !this.currentResponse.decided) {
          this.currentResponse.decided = true;
          this.currentResponse.allowed = this.lastPassiveDecision;
          if (this.currentResponse.allowed) {
            for (const audio of this.currentResponse.bufferedAudio) await this.onAudio?.(audio);
          } else {
            this.#send({ type: "response.cancel" });
          }
          this.currentResponse.bufferedAudio = [];
        }
      }
      return;
    }
    if (event.type === "response.created") {
      const forced = this.forceNextResponse;
      this.forceNextResponse = false;
      this.currentResponse = {
        id: event.response?.id,
        decided: forced || this.mode !== "passive",
        allowed: forced || this.mode !== "passive",
        bufferedAudio: [],
      };
      return;
    }
    if (event.type === "response.output_audio.delta" || event.type === "response.audio.delta") {
      const audio = Buffer.from(event.delta ?? event.audio ?? "", "base64");
      if (!audio.length) return;
      if (!this.currentResponse || this.currentResponse.allowed) await this.onAudio?.(audio);
      else if (!this.currentResponse.decided) this.currentResponse.bufferedAudio.push(audio);
      return;
    }
    if (event.type === "response.output_audio_transcript.done") {
      const text = eventTranscript(event);
      if (text && (!this.currentResponse || this.currentResponse.allowed)) {
        await this.onTranscript?.({ speaker: this.agentName, text, kind: "assistant" });
      }
      return;
    }
    if (event.type === "response.function_call_arguments.done") {
      await this.#handleFunctionCall(event);
      return;
    }
    if (event.type === "response.done") this.currentResponse = null;
  }

  async #handleFunctionCall(event) {
    if (event.name !== "ask_codex" || !this.onCodexRequest) return;
    if (this.mode === "passive" && !this.currentResponse?.allowed) return;
    let output;
    try {
      output = await this.onCodexRequest(JSON.parse(event.arguments));
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
    // The post-tool response belongs to the already-authorized user turn. It
    // must not wait for another wake-name transcript before speaking.
    this.forceNextResponse = true;
    this.#send({ type: "response.create" });
  }

  #send(message) {
    if (this.socket?.readyState !== OPEN) throw new Error("Grok Voice is not connected");
    this.socket.send(JSON.stringify(message));
  }
}
