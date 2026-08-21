import { commandExists, runProcess } from "./process-runner.mjs";

const READ_TOOLS = "read,grep,find,ls";
const WRITE_TOOLS = "read,bash,edit,write,grep,find,ls";

function messageText(message) {
  if (!message || message.role !== "assistant") return "";
  if (typeof message.content === "string") return message.content.trim();
  if (!Array.isArray(message.content)) return "";
  return message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
    .trim();
}

export class PiHarness {
  constructor({
    command = "pi",
    sessionId,
    workspace,
    allowWrites = false,
    model,
    provider,
    runner = runProcess,
  } = {}) {
    this.id = "pi";
    this.command = command;
    this.sessionId = sessionId ?? null;
    this.workspace = workspace;
    this.allowWrites = allowWrites;
    this.model = model;
    this.provider = provider;
    this.runner = runner;
    this.currentChild = null;
    this.instructions = "";
    this.name = "Agent Meet Bridge";
  }

  get capabilities() {
    return { durable: true, repository: true, read: true, write: this.allowWrites, interrupt: true };
  }

  async start({ name = "Agent", instructions = "" } = {}) {
    if (this.runner === runProcess && !commandExists(this.command)) {
      throw new Error(`${this.command} is not installed`);
    }
    this.name = `${name} · meeting`;
    this.instructions = instructions;
    return this.getState();
  }

  async ask({ prompt, allowWrites = false, timeoutMs } = {}) {
    const writeTurn = this.allowWrites && allowWrites;
    const args = [
      "--mode", "json",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--tools", writeTurn ? WRITE_TOOLS : READ_TOOLS,
    ];
    if (this.sessionId) args.push("--session", this.sessionId);
    else args.push("--name", this.name);
    if (this.model) args.push("--model", this.model);
    if (this.provider) args.push("--provider", this.provider);
    if (this.instructions) args.push("--append-system-prompt", this.instructions);
    // Pi's parser treats a bare `--` as an extension flag, not an option
    // terminator. Bridge prompts always begin with ordinary text, so pass the
    // complete prompt as the final positional message.
    args.push(prompt);

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

    let answer = "";
    let deltaText = "";
    let rawEvent = null;
    for (const line of result.stdout.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      rawEvent = event;
      if (event.type === "session" && event.id) this.sessionId = event.id;
      if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
        deltaText += event.assistantMessageEvent.delta ?? "";
      }
      if (event.type === "message_end") answer = messageText(event.message) || answer;
      if (event.type === "turn_end") answer = messageText(event.message) || answer;
    }
    answer = answer || deltaText.trim();
    if (!this.sessionId) throw new Error("Pi did not return a durable session ID");
    if (!answer) throw new Error("Pi did not return an assistant message");
    return { text: answer, contextId: this.sessionId, raw: rawEvent ?? result };
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
