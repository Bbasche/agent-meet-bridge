import { RealtimeVoiceRuntime } from "./realtime-voice-runtime.mjs";

export class OpenAIRealtimeVoiceRuntime extends RealtimeVoiceRuntime {
  constructor(options) {
    super({ ...options, provider: "openai" });
  }
}
