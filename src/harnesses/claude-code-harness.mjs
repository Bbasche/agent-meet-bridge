import { randomUUID } from "node:crypto";
import { commandExists, runProcess } from "./process-runner.mjs";

const READ_TOOLS = "Read,Glob,Grep,WebSearch,WebFetch";

export class ClaudeCodeHarness {
  constructor({
    command = "claude",
    sessionId,
    workspace,
    allowWrites = false,
    model,
    maxBudgetUsd,
    runner = runProcess,
  } = {}) {
    this.id = "claude";
    this.command = command;
    this.sessionId = sessionId ?? randomUUID();
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.model = model;
    this.maxBudgetUsd = maxBudgetUsd;
    this.runner = runner;
    this.started = Boolean(sessionId);
    this.currentChild = null;
    this.instructions = "";
  }

  get capabilities() {
    return { durable: true, repository: true, read: true, write: this.allowWrites, interrupt: true };
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
    const args = ["-p", "--output-format", "json", "--no-chrome"];
    if (this.started) args.push("--resume", this.sessionId);
    else args.push("--session-id", this.sessionId);
    if (this.model) args.push("--model", this.model);
    if (this.maxBudgetUsd !== undefined) args.push("--max-budget-usd", String(this.maxBudgetUsd));
    if (this.instructions && !this.started) args.push("--append-system-prompt", this.instructions);
    if (writeTurn) {
      args.push("--permission-mode", "acceptEdits");
    } else {
      args.push("--permission-mode", "dontAsk", "--tools", READ_TOOLS);
    }
    // --tools is variadic in Claude Code, so terminate option parsing before
    // the positional prompt or it will be swallowed as another tool name.
    args.push("--", prompt);
    let result;
    try {
      result = await this.runner({
        command: this.command,
        args,
        cwd: this.workspace,
        timeoutMs,
        onSpawn: (child) => { this.currentChild = child; },
      });
    } catch (error) {
      if (!error.result?.stdout) throw error;
      result = error.result;
    }
    this.currentChild = null;
    let payload;
    try {
      payload = JSON.parse(result.stdout);
    } catch {
      throw new Error(`Claude Code returned invalid JSON: ${result.stdout.slice(0, 500)}`);
    }
    if (payload.is_error) throw new Error(payload.result || "Claude Code turn failed");
    this.sessionId = payload.session_id ?? this.sessionId;
    this.started = true;
    return { text: String(payload.result ?? "").trim(), contextId: this.sessionId, raw: payload };
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
