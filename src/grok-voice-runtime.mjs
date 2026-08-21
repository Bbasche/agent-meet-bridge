import { RealtimeVoiceRuntime } from "./realtime-voice-runtime.mjs";

// Kept as a public compatibility wrapper for v0.1.x integrations.
export class GrokVoiceRuntime extends RealtimeVoiceRuntime {
  constructor({ codexEnabled, onCodexRequest, ...options }) {
    super({
      ...options,
      provider: "grok",
      harnessEnabled: options.harnessEnabled ?? codexEnabled,
      onHarnessRequest: options.onHarnessRequest ?? onCodexRequest,
    });
  }
}
