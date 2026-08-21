import { ClaudeCodeHarness } from "./claude-code-harness.mjs";
import { CodexHarness } from "./codex-harness.mjs";
import { HermesHarness } from "./hermes-harness.mjs";
import { GenericCliHarness } from "./generic-cli-harness.mjs";
import { PiHarness } from "./pi-harness.mjs";
import { commandExists } from "./process-runner.mjs";

export const HARNESS_PROVIDERS = Object.freeze(["codex", "claude", "hermes", "pi", "generic"]);

export function detectHarnesses() {
  return {
    codex: commandExists("codex"),
    claude: commandExists("claude"),
    hermes: commandExists("hermes"),
    pi: commandExists("pi"),
    cursor: commandExists("cursor"),
  };
}

export function createHarness({ provider = "codex", ...options } = {}) {
  if (provider === "codex") return new CodexHarness(options);
  if (provider === "claude") return new ClaudeCodeHarness(options);
  if (provider === "hermes") return new HermesHarness(options);
  if (provider === "pi") return new PiHarness(options);
  if (provider === "generic") return new GenericCliHarness(options);
  throw new Error(`Unsupported harness: ${provider}. Choose ${HARNESS_PROVIDERS.join(", ")}.`);
}
