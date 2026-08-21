import { appendFile, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

function cleanText(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function markdownEscape(value) {
  return cleanText(value).replace(/([\\`*_{}[\]()#+.!|>-])/g, "\\$1");
}

export class TranscriptStore {
  constructor({ rootDir, sessionId, metadata }) {
    this.sessionDir = path.join(rootDir, sessionId);
    this.jsonlPath = path.join(this.sessionDir, "transcript.jsonl");
    this.markdownPath = path.join(this.sessionDir, "transcript.md");
    this.metadataPath = path.join(this.sessionDir, "session.json");
    this.privateJsonlPath = path.join(this.sessionDir, "private.jsonl");
    this.privateMarkdownPath = path.join(this.sessionDir, "private.md");
    this.contextPath = path.join(this.sessionDir, "context.md");
    this.debriefPath = path.join(this.sessionDir, "debrief.md");
    this.metadata = metadata;
    this.roomQueue = Promise.resolve();
    this.privateQueue = Promise.resolve();
    this.contextQueue = Promise.resolve();
  }

  async initialize() {
    await mkdir(this.sessionDir, { recursive: true });
    await writeFile(this.metadataPath, `${JSON.stringify(this.metadata, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await writeFile(
      this.markdownPath,
      `# ${markdownEscape(this.metadata.agentName)} meeting transcript\n\nStarted ${this.metadata.startedAt}\n\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(this.jsonlPath, "", { flag: "wx", mode: 0o600 });
    await writeFile(
      this.privateMarkdownPath,
      `# ${markdownEscape(this.metadata.agentName)} private sidecar\n\nStarted ${this.metadata.startedAt}\n\n`,
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(this.privateJsonlPath, "", { flag: "wx", mode: 0o600 });
    await writeFile(
      this.contextPath,
      `# ${markdownEscape(this.metadata.agentName)} live meeting context\n\nNo meeting speech has been captured yet.\n`,
      { flag: "wx", mode: 0o600 },
    );
  }

  async append(entry) {
    const timestamp = entry.timestamp ?? new Date().toISOString();
    const speaker = cleanText(entry.speaker) || "Unknown speaker";
    const text = cleanText(entry.text);
    if (!text) return;
    const record = { ...entry, timestamp, speaker, text };
    const operation = async () => {
      await appendFile(this.jsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const time = new Date(timestamp).toLocaleTimeString("en-ZA", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      await appendFile(
        this.markdownPath,
        `- ${time} **${markdownEscape(speaker)}:** ${markdownEscape(text)}\n`,
        { mode: 0o600 },
      );
    };
    const pending = this.roomQueue.then(operation, operation);
    this.roomQueue = pending.catch(() => {});
    return pending;
  }

  async appendPrivate(entry) {
    const timestamp = entry.timestamp ?? new Date().toISOString();
    const speaker = cleanText(entry.speaker) || "Unknown speaker";
    const text = cleanText(entry.text);
    if (!text) return;
    const record = { ...entry, timestamp, speaker, text, visibility: "private" };
    const operation = async () => {
      await appendFile(this.privateJsonlPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
      const time = new Date(timestamp).toLocaleTimeString("en-ZA", {
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
      });
      await appendFile(
        this.privateMarkdownPath,
        `- ${time} **${markdownEscape(speaker)}:** ${markdownEscape(text)}\n`,
        { mode: 0o600 },
      );
    };
    const pending = this.privateQueue.then(operation, operation);
    this.privateQueue = pending.catch(() => {});
    return pending;
  }

  async writeDebrief(text) {
    const content = String(text ?? "").trim();
    if (!content) throw new Error("Debrief cannot be empty");
    await writeFile(this.debriefPath, `${content}\n`, { mode: 0o600 });
  }

  async writeContext(text) {
    const content = String(text ?? "").trim();
    if (!content) throw new Error("Meeting context cannot be empty");
    const operation = () => writeFile(this.contextPath, `${content}\n`, { mode: 0o600 });
    const pending = this.contextQueue.then(operation, operation);
    this.contextQueue = pending.catch(() => {});
    return pending;
  }

  async flush() {
    await Promise.all([this.roomQueue, this.privateQueue, this.contextQueue]);
  }
}
