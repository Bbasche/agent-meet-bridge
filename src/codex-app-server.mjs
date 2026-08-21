import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const INTERACTIVE_SOURCE_KINDS = ["cli", "vscode", "appServer", "exec"];

export class CodexAppServer {
  constructor({ command = "codex", experimentalApi = false, logger = console } = {}) {
    this.command = command;
    this.experimentalApi = experimentalApi;
    this.logger = logger;
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.currentRun = null;
    this.queue = Promise.resolve();
    this.notificationListeners = new Map();
    this.loadedThreads = new Set();
  }

  async start() {
    if (this.child) return;

    const args = ["app-server"];
    if (this.experimentalApi) args.push("--enable", "realtime_conversation");
    args.push("--listen", "stdio://");
    this.child = spawn(this.command, args, {
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    const stdout = createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.#onLine(line));
    this.child.stderr.on("data", (chunk) => {
      const message = chunk.toString().trim();
      if (message) this.logger.debug?.(`[codex] ${message}`);
    });
    this.child.once("exit", (code, signal) => {
      const error = new Error(`Codex app-server exited (${code ?? signal ?? "unknown"})`);
      for (const { reject } of this.pending.values()) reject(error);
      this.pending.clear();
      if (this.currentRun) this.currentRun.reject(error);
      this.currentRun = null;
      this.loadedThreads.clear();
      this.child = null;
    });

    await this.request("initialize", {
      clientInfo: {
        name: "meeting-agent",
        title: "Agent Meet Bridge",
        version: "0.1.0",
      },
      capabilities: { experimentalApi: this.experimentalApi },
    });
    this.notify("initialized");
  }

  async listThreads({ limit = 30, cwd, searchTerm } = {}) {
    await this.start();
    const params = {
      limit,
      sortKey: "updated_at",
      sortDirection: "desc",
      sourceKinds: INTERACTIVE_SOURCE_KINDS,
    };
    if (cwd) params.cwd = cwd;
    if (searchTerm) params.searchTerm = searchTerm;
    const result = await this.request("thread/list", params);
    return result.data ?? [];
  }

  async startThread(params = {}) {
    await this.start();
    const result = await this.request("thread/start", params);
    if (result.thread?.id) this.loadedThreads.add(result.thread.id);
    return result;
  }

  async ensureThread(threadId) {
    await this.start();
    if (this.loadedThreads.has(threadId)) return;
    await this.request("thread/resume", { threadId });
    this.loadedThreads.add(threadId);
  }

  async ask({ threadId, prompt, cwd, allowWrites = false, timeoutMs = 15 * 60_000 }) {
    const task = async () => this.#askOnce({ threadId, prompt, cwd, allowWrites, timeoutMs });
    const result = this.queue.then(task, task);
    this.queue = result.catch(() => undefined);
    return result;
  }

  async interrupt() {
    const run = this.currentRun;
    if (!run?.threadId || !run.turnId) return false;
    await this.request("turn/interrupt", { threadId: run.threadId, turnId: run.turnId });
    return true;
  }

  async #askOnce({ threadId, prompt, cwd, allowWrites, timeoutMs }) {
    await this.ensureThread(threadId);

    const sandboxPolicy = allowWrites
      ? {
          type: "workspaceWrite",
          writableRoots: [cwd],
          networkAccess: false,
        }
      : { type: "readOnly", access: { type: "fullAccess" } };

    const runPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        if (this.currentRun?.threadId === threadId) this.currentRun = null;
        reject(new Error("Codex turn timed out"));
      }, timeoutMs);
      timeout.unref?.();
      this.currentRun = {
        threadId,
        turnId: null,
        text: "",
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      };
    });

    try {
      const result = await this.request("turn/start", {
        threadId,
        input: [{ type: "text", text: prompt }],
        cwd,
        approvalPolicy: "never",
        sandboxPolicy,
        personality: "friendly",
      });
      if (this.currentRun) this.currentRun.turnId = result.turn?.id ?? null;
    } catch (error) {
      this.currentRun?.reject(error);
      this.currentRun = null;
      throw error;
    }

    return runPromise;
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.child?.stdin.writable) {
      return Promise.reject(new Error("Codex app-server is not running"));
    }
    const id = this.nextId++;
    const promise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, timeoutMs);
      timeout.unref?.();
      this.pending.set(id, {
        resolve: (value) => {
          clearTimeout(timeout);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timeout);
          reject(error);
        },
      });
    });
    this.#send({ method, id, params });
    return promise;
  }

  notify(method, params) {
    const message = { method };
    if (params !== undefined) message.params = params;
    this.#send(message);
  }

  onNotification(method, listener) {
    const listeners = this.notificationListeners.get(method) ?? new Set();
    listeners.add(listener);
    this.notificationListeners.set(method, listeners);
    return () => {
      listeners.delete(listener);
      if (!listeners.size) this.notificationListeners.delete(method);
    };
  }

  stop() {
    this.child?.kill("SIGTERM");
    this.child = null;
  }

  #send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.logger.debug?.(`[codex:unparsed] ${line}`);
      return;
    }

    if (message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.#declineServerRequest(message);
      return;
    }

    this.#onNotification(message);
  }

  #declineServerRequest(message) {
    if (message.method === "tool/requestUserInput") {
      this.#send({ id: message.id, result: { answers: {} } });
      return;
    }
    this.#send({ id: message.id, result: { decision: "decline" } });
  }

  #onNotification(message) {
    for (const listener of this.notificationListeners.get(message.method) ?? []) {
      try {
        listener(message.params ?? {});
      } catch (error) {
        this.logger.error?.(`[codex] notification listener failed: ${error.message}`);
      }
    }
    const run = this.currentRun;
    if (!run) return;
    const params = message.params ?? {};
    if (params.threadId && params.threadId !== run.threadId) return;

    if (message.method === "item/agentMessage/delta") {
      run.text += params.delta ?? "";
      return;
    }

    if (message.method === "item/completed" && params.item?.type === "agentMessage") {
      run.text = params.item.text ?? run.text;
      return;
    }

    if (message.method === "turn/completed") {
      const turn = params.turn ?? {};
      if (run.turnId && turn.id && turn.id !== run.turnId) return;
      this.currentRun = null;
      if (turn.status === "interrupted") {
        run.reject(new Error("Codex turn was interrupted"));
      } else if (turn.status === "failed" || turn.error) {
        run.reject(new Error(turn.error?.message ?? "Codex turn failed"));
      } else {
        run.resolve({
          threadId: run.threadId,
          turnId: turn.id ?? run.turnId,
          text: run.text.trim(),
          status: turn.status ?? "completed",
        });
      }
    }
  }
}
