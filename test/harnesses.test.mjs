import test from "node:test";
import assert from "node:assert/strict";
import { ClaudeCodeHarness } from "../src/harnesses/claude-code-harness.mjs";
import { CursorHarness } from "../src/harnesses/cursor-harness.mjs";
import { HermesHarness } from "../src/harnesses/hermes-harness.mjs";
import { GenericCliHarness } from "../src/harnesses/generic-cli-harness.mjs";
import { PiHarness } from "../src/harnesses/pi-harness.mjs";
import { createHarness, HARNESS_PROVIDERS } from "../src/harnesses/registry.mjs";

test("harness registry exposes provider-neutral adapters", () => {
  assert.deepEqual(HARNESS_PROVIDERS, ["codex", "claude", "cursor", "hermes", "pi", "generic"]);
  assert.equal(createHarness({ provider: "claude", workspace: "/tmp" }).id, "claude");
  assert.equal(createHarness({ provider: "cursor", workspace: "/tmp" }).id, "cursor");
});

test("Pi preserves its JSON session and constrains read-only tools", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return {
      stdout: [
        JSON.stringify({ type: "session", version: 3, id: "pi-session-1", cwd: request.cwd }),
        JSON.stringify({
          type: "message_end",
          message: { role: "assistant", content: [{ type: "text", text: `reply-${calls.length}` }] },
        }),
      ].join("\n"),
      stderr: "",
      code: 0,
    };
  };
  const harness = new PiHarness({ workspace: "/tmp/workspace", runner });
  await harness.start({ name: "Ada", instructions: "Meeting role" });
  const first = await harness.ask({ prompt: "Inspect this", allowWrites: false });
  assert.equal(first.text, "reply-1");
  assert.equal(first.contextId, "pi-session-1");
  assert.ok(calls[0].args.includes("read,grep,find,ls"));
  assert.ok(calls[0].args.includes("--no-extensions"));
  await harness.ask({ prompt: "Follow-up", allowWrites: false });
  assert.ok(calls[1].args.includes("--session"));
  assert.ok(calls[1].args.includes("pi-session-1"));
});

test("Pi write tools require bridge and private-turn authorization", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return {
      stdout: [
        JSON.stringify({ type: "session", id: "pi-session-2" }),
        JSON.stringify({ type: "turn_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } }),
      ].join("\n"),
      stderr: "",
      code: 0,
    };
  };
  const harness = new PiHarness({ workspace: "/tmp/workspace", allowWrites: true, runner });
  await harness.start();
  await harness.ask({ prompt: "Analyze", allowWrites: false });
  await harness.ask({ prompt: "Prototype", allowWrites: true });
  assert.ok(calls[0].args.includes("read,grep,find,ls"));
  assert.ok(calls[1].args.includes("read,bash,edit,write,grep,find,ls"));
});

test("generic CLI uses argument arrays and can carry JSON context", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return {
      stdout: JSON.stringify({ text: "GENERIC_READY", contextId: "context-2" }),
      stderr: "",
      code: 0,
    };
  };
  const harness = new GenericCliHarness({
    command: "custom-agent",
    args: ["ask", "--session", "{context}", "--prompt", "{prompt}"],
    output: "json",
    contextId: "context-1",
    workspace: "/tmp/workspace",
    runner,
  });
  await harness.start({ instructions: "Meeting role" });
  const result = await harness.ask({ prompt: "Question" });
  assert.equal(result.text, "GENERIC_READY");
  assert.equal(result.contextId, "context-2");
  assert.equal(calls[0].command, "custom-agent");
  assert.ok(calls[0].args.includes("context-1"));
  assert.equal(calls[0].input, undefined);
});

test("generic CLI does not echo malformed provider output", async () => {
  const harness = new GenericCliHarness({
    command: "custom-agent",
    output: "json",
    workspace: "/tmp/workspace",
    runner: async () => ({ stdout: "private-meeting-content", stderr: "", code: 0 }),
  });
  await harness.start();
  await assert.rejects(
    harness.ask({ prompt: "Question" }),
    (error) => error.message === "Generic harness returned invalid JSON",
  );
});

test("Claude Code preserves one session and constrains read-only tools", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return {
      stdout: JSON.stringify({ result: `reply-${calls.length}`, session_id: "11111111-1111-4111-8111-111111111111" }),
      stderr: "",
      code: 0,
    };
  };
  const harness = new ClaudeCodeHarness({
    workspace: "/tmp/workspace",
    sessionId: "11111111-1111-4111-8111-111111111111",
    runner,
  });
  await harness.start({ instructions: "Meeting role" });
  const result = await harness.ask({ prompt: "Inspect this", allowWrites: false });
  assert.equal(result.text, "reply-1");
  assert.deepEqual(calls[0].args.slice(0, 5), ["-p", "--output-format", "json", "--no-chrome", "--resume"]);
  assert.ok(calls[0].args.includes("dontAsk"));
  assert.ok(calls[0].args.includes("Read,Glob,Grep,WebSearch,WebFetch"));
  assert.deepEqual(calls[0].args.slice(-2), ["--", "Inspect this"]);
});

test("Cursor uses Ask mode unless a private prototype turn is authorized", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    return {
      stdout: JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: `reply-${calls.length}`,
        session_id: "cursor-session-1",
      }),
      stderr: "",
      code: 0,
    };
  };
  const harness = new CursorHarness({
    workspace: "/tmp/workspace",
    allowWrites: true,
    runner,
  });
  await harness.start({ instructions: "Meeting role" });
  const read = await harness.ask({ prompt: "Inspect this", allowWrites: false });
  assert.equal(read.text, "reply-1");
  assert.equal(read.contextId, "cursor-session-1");
  assert.deepEqual(calls[0].args.slice(0, 5), ["--mode", "ask", "--print", "--output-format", "json"]);
  assert.equal(calls[0].args.includes("--force"), false);

  await harness.ask({ prompt: "Prototype this", allowWrites: true });
  assert.deepEqual(calls[1].args.slice(0, 2), ["--mode", "agent"]);
  assert.ok(calls[1].args.includes("--force"));
  assert.ok(calls[1].args.includes("--resume"));
  assert.ok(calls[1].args.includes("cursor-session-1"));
});

test("Hermes rolls its durable resume ID forward and defaults to safe mode", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.args[0] === "sessions") {
      return {
        stdout: "Title Workspace Last Active ID\nQuestion repo just now 20260821_190000_abc123\n",
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "HERMES_READY\n", stderr: "", code: 0 };
  };
  const harness = new HermesHarness({ workspace: "/tmp/workspace", runner });
  await harness.start({ instructions: "Meeting role" });
  const first = await harness.ask({ prompt: "Question", allowWrites: false });
  assert.equal(first.text, "HERMES_READY");
  assert.equal(first.contextId, "20260821_190000_abc123");
  assert.ok(calls[0].args.includes("--safe-mode"));
  await harness.ask({ prompt: "Follow-up", allowWrites: false });
  assert.ok(calls[2].args.includes("--resume"));
  assert.ok(calls[2].args.includes("20260821_190000_abc123"));
});

test("Hermes repository tools require bridge and turn write permission", async () => {
  const calls = [];
  const runner = async (request) => {
    calls.push(request);
    if (request.args[0] === "sessions") return { stdout: "", stderr: "", code: 0 };
    return { stdout: "done", stderr: "", code: 0 };
  };
  const harness = new HermesHarness({ workspace: "/tmp/workspace", allowWrites: true, runner });
  await harness.start();
  await harness.ask({ prompt: "Analyze", allowWrites: false });
  await harness.ask({ prompt: "Prototype", allowWrites: true });
  assert.ok(calls[0].args.includes("--safe-mode"));
  assert.equal(calls[2].args.includes("--safe-mode"), false);
});
