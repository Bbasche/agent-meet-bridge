import { commandExists, runProcess } from "./process-runner.mjs";

function interpolate(value, replacements) {
  return String(value).replace(/\{(prompt|context|workspace)\}/g, (_, key) => replacements[key] ?? "");
}

export class GenericCliHarness {
  constructor({
    command,
    args = [],
    output = "text",
    contextId,
    workspace,
    allowWrites = false,
    runner = runProcess,
  } = {}) {
    if (!command) throw new Error("Generic CLI harness requires --harness-command");
    this.id = "generic";
    this.command = command;
    this.args = args;
    this.output = output;
    this.contextId = contextId ?? null;
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.runner = runner;
    this.currentChild = null;
    this.instructions = "";
  }

  get capabilities() {
    return {
      durable: Boolean(this.contextId || this.args.some((arg) => arg.includes("{context}"))),
      repository: true,
      read: true,
      write: this.allowWrites,
      interrupt: true,
      note: "The operator-supplied executable owns its sandbox and permission enforcement.",
    };
  }

  async start({ instructions = "" } = {}) {
    if (this.runner === runProcess && !commandExists(this.command)) {
      throw new Error(`${this.command} is not installed`);
    }
    this.instructions = instructions;
    return this.getState();
  }

  async ask({ prompt, timeoutMs } = {}) {
    const fullPrompt = [this.instructions, prompt].filter(Boolean).join("\n\n");
    const replacements = {
      prompt: fullPrompt,
      context: this.contextId ?? "",
      workspace: this.workspace,
    };
    const hasPromptArg = this.args.some((arg) => arg.includes("{prompt}"));
    const args = this.args.map((arg) => interpolate(arg, replacements));
    let result;
    try {
      result = await this.runner({
        command: this.command,
        args,
        cwd: this.workspace,
        input: hasPromptArg ? undefined : fullPrompt,
        timeoutMs,
        onSpawn: (child) => { this.currentChild = child; },
      });
    } finally {
      this.currentChild = null;
    }
    if (this.output === "json") {
      let payload;
      try {
        payload = JSON.parse(result.stdout);
      } catch {
        throw new Error("Generic harness returned invalid JSON");
      }
      this.contextId = payload.contextId ?? payload.session_id ?? payload.thread_id ?? this.contextId;
      return { text: String(payload.text ?? payload.result ?? "").trim(), contextId: this.contextId, raw: payload };
    }
    return { text: result.stdout.trim(), contextId: this.contextId, raw: result };
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
    return { provider: this.id, contextId: this.contextId, capabilities: this.capabilities };
  }
}
