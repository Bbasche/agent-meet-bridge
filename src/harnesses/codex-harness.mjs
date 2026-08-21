import { CodexAppServer } from "../codex-app-server.mjs";

export class CodexHarness {
  constructor({ command = "codex", threadId, workspace, allowWrites = false, experimentalApi = false, logger = console } = {}) {
    this.id = "codex";
    this.threadId = threadId ?? null;
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.client = new CodexAppServer({ command, experimentalApi, logger });
    this.created = false;
  }

  get capabilities() {
    return { durable: true, repository: true, read: true, write: this.allowWrites, interrupt: true };
  }

  async start({ name = "Agent", instructions = "" } = {}) {
    await this.client.start();
    if (this.threadId) {
      await this.client.ensureThread(this.threadId);
      return this.getState();
    }
    const started = await this.client.startThread({
      cwd: this.workspace,
      approvalPolicy: "never",
      sandbox: this.allowWrites ? "workspace-write" : "read-only",
      personality: "friendly",
      developerInstructions: instructions,
    });
    this.threadId = started.thread.id;
    this.created = true;
    await this.client.request("thread/name/set", {
      threadId: this.threadId,
      name: `${name} · meeting ${new Date().toISOString().slice(0, 10)}`,
    });
    return this.getState();
  }

  async ask({ prompt, allowWrites = false, timeoutMs } = {}) {
    if (!this.threadId) throw new Error("Codex harness has not started");
    const result = await this.client.ask({
      threadId: this.threadId,
      prompt,
      cwd: this.workspace,
      allowWrites: this.allowWrites && allowWrites,
      timeoutMs,
    });
    return { text: result.text, contextId: this.threadId, raw: result };
  }

  interrupt() {
    return this.client.interrupt();
  }

  async close() {
    this.client.stop();
  }

  getState() {
    return {
      provider: this.id,
      contextId: this.threadId,
      created: this.created,
      capabilities: this.capabilities,
    };
  }
}
