import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { TranscriptStore } from "../src/transcript-store.mjs";

test("automatic debrief is saved beside the meeting transcript", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-meet-bridge-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TranscriptStore({
    rootDir,
    sessionId: "session-1",
    metadata: { agentName: "Atlas", startedAt: "2026-08-21T00:00:00.000Z" },
  });
  await store.initialize();
  await store.writeDebrief("# Debrief\n\n- Decision captured");
  assert.equal(
    await readFile(store.debriefPath, "utf8"),
    "# Debrief\n\n- Decision captured\n",
  );
});
