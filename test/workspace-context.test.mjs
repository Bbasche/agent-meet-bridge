import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildWorkspaceContext } from "../src/workspace-context.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("workspace context selects relevant code while excluding secret-shaped files", async () => {
  const context = await buildWorkspaceContext({
    workspace: root,
    query: "How does RealtimeVoiceRuntime convert audio sample rates?",
    maxSelectedFiles: 4,
  });
  assert.match(context, /src\/realtime-voice-runtime\.mjs/);
  assert.match(context, /downsample48kTo24k/);
  assert.doesNotMatch(context, /\n\.env\.example\n/);
});
