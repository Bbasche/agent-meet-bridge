import { commandExists, runProcess } from "./process-runner.mjs";
import { buildWorkspaceContext } from "../workspace-context.mjs";

export class HermesHarness {
  constructor({
    command = "hermes",
    sessionId,
    workspace,
    allowWrites = false,
    model,
    provider,
    runner = runProcess,
  } = {}) {
    this.id = "hermes";
    this.command = command;
    this.sessionId = sessionId ?? null;
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.model = model;
    this.provider = provider;
    this.runner = runner;
    this.currentChild = null;
    this.started = Boolean(sessionId);
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
        ? "Hermes one-shot tool approvals are bypassed; enable only for trusted private prototype turns."
        : "Read-only meetings use a bounded, secret-filtered repository context pack with Hermes safe mode.",
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
    const workspaceContext = writeTurn ? "" : await buildWorkspaceContext({
      workspace: this.workspace,
      query: prompt,
    });
    const combinedPrompt = [this.instructions, prompt, workspaceContext].filter(Boolean).join("\n\n");
    const args = ["--in", this.workspace, "--no-restore-cwd"];
    if (this.model) args.push("--model", this.model);
    if (this.provider) args.push("--provider", this.provider);
    if (this.sessionId) args.push("--resume", this.sessionId);
    if (!writeTurn) args.push("--safe-mode");
    args.push("--oneshot", combinedPrompt);
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
    await this.#refreshSessionId(timeoutMs).catch(() => {});
    this.started = true;
    return { text: result.stdout.trim(), contextId: this.sessionId, raw: result };
  }

  async #refreshSessionId(timeoutMs) {
    const listed = await this.runner({
      command: this.command,
      args: ["sessions", "list", "--workspace", this.workspace, "--limit", "1"],
      cwd: this.workspace,
      timeoutMs: Math.min(timeoutMs ?? 30_000, 30_000),
    });
    const lines = listed.stdout.trim().split(/\r?\n/).reverse();
    for (const line of lines) {
      const match = line.match(/\b(\d{8}_\d{6}_[a-z0-9]+)\s*$/i);
      if (match) {
        this.sessionId = match[1];
        return;
      }
    }
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
