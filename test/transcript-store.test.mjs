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
  await store.writeContext("# Live context\n\n- Decision candidate");
  await store.writeDebrief("# Debrief\n\n- Decision captured");
  assert.equal(
    await readFile(store.contextPath, "utf8"),
    "# Live context\n\n- Decision candidate\n",
  );
  assert.equal(
    await readFile(store.debriefPath, "utf8"),
    "# Debrief\n\n- Decision captured\n",
  );
});

test("concurrent room appends preserve one authoritative order", async (t) => {
  const rootDir = await mkdtemp(path.join(os.tmpdir(), "agent-meet-bridge-order-test-"));
  t.after(() => rm(rootDir, { recursive: true, force: true }));
  const store = new TranscriptStore({
    rootDir,
    sessionId: "session-order",
    metadata: { agentName: "Atlas", startedAt: "2026-08-21T00:00:00.000Z" },
  });
  await store.initialize();
  await Promise.all([
    store.append({ speaker: "A", text: "first", timestamp: "2026-08-21T00:00:01.000Z" }),
    store.append({ speaker: "B", text: "second", timestamp: "2026-08-21T00:00:02.000Z" }),
    store.append({ speaker: "C", text: "third", timestamp: "2026-08-21T00:00:03.000Z" }),
  ]);
  await store.flush();
  const records = (await readFile(store.jsonlPath, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(records.map((record) => record.text), ["first", "second", "third"]);
  const markdown = await readFile(store.markdownPath, "utf8");
  assert.ok(markdown.indexOf("first") < markdown.indexOf("second"));
  assert.ok(markdown.indexOf("second") < markdown.indexOf("third"));
});
