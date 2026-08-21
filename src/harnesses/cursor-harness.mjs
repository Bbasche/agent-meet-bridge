import { commandExists, runProcess } from "./process-runner.mjs";

export class CursorHarness {
  constructor({
    command = "cursor-agent",
    sessionId,
    workspace,
    allowWrites = false,
    model,
    runner = runProcess,
  } = {}) {
    this.id = "cursor";
    this.command = command;
    this.sessionId = sessionId ?? null;
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.model = model;
    this.runner = runner;
    this.currentChild = null;
    this.instructions = "";
  }

  get capabilities() {
    return {
      durable: true,
      repository: true,
      read: true,
      write: this.allowWrites,
      interrupt: true,
      note: this.allowWrites
        ? "Private prototype turns use Cursor Agent mode with --force; scope the workspace and permissions carefully."
        : "Read-only turns use Cursor Ask mode.",
    };
  }

  async start({ instructions = "" } = {}) {
    if (this.runner === runProcess && !commandExists(this.command)) {
      throw new Error(`${this.command} is not installed`);
    }
    this.instructions = instructions;
    return this.getState();
  }

  async ask({ prompt, allowWrites = false, timeoutMs } = {}) {
    const writeTurn = this.allowWrites && allowWrites;
    const fullPrompt = [this.instructions, prompt].filter(Boolean).join("\n\n");
    const args = [
      "--mode", writeTurn ? "agent" : "ask",
      "--print",
      "--output-format", "json",
    ];
    if (writeTurn) args.push("--force");
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (this.model) args.push("--model", this.model);
    args.push(fullPrompt);

    let result;
    try {
      result = await this.runner({
        command: this.command,
        args,
        cwd: this.workspace,
        timeoutMs,
        onSpawn: (child) => { this.currentChild = child; },
      });
    } finally {
      this.currentChild = null;
    }

    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error("Cursor returned invalid JSON");
    }
    if (payload.is_error || payload.subtype === "error") {
      throw new Error("Cursor turn failed");
    }
    const text = String(payload.result ?? "").trim();
    if (!text) throw new Error("Cursor did not return an assistant message");
    this.sessionId = payload.session_id ?? this.sessionId;
    return { text, contextId: this.sessionId, raw: payload };
  }

  async interrupt() {
    if (!this.currentChild) return false;
    this.currentChild.kill("SIGTERM");
    return true;
  }

  async close() {
    await this.interrupt();
  }

  getState() {
    return { provider: this.id, contextId: this.sessionId, capabilities: this.capabilities };
  }
}
