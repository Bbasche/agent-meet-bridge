import crypto from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

const NOTION_API_ORIGIN = "https://api.notion.com";
const NOTION_VERSION = "2022-06-28";
const STATE_VERSION = 3;
const MAX_BATCH_ENTRIES = 20;
const MAX_NOTE_TEXT = 1_600;
const MAX_SPEAKER_TEXT = 80;
const MAX_IDEMPOTENCY_KEY = 128;
const MAX_MEETING_ID = 128;
const MAX_COMPLETED_KEYS = 256;
const MAX_RETRY_AFTER_MS = 5_000;

const SECTION_KINDS = Object.freeze({
  agenda: new Set(["agenda"]),
  running_notes: new Set(["note", "decision", "next_step"]),
  debrief: new Set(["outcome", "decision", "unresolved", "next_step"]),
});

const PUBLIC_ERROR_MESSAGES = Object.freeze({
  audit_write_failed: "The local notes audit could not be written.",
  auth_failed: "The Notion integration was not authorized for the configured page.",
  cursor_conflict: "The notes cursor conflicts with already recorded meeting state.",
  cursor_gap: "A notes update arrived out of order and writes stopped safely.",
  invalid_batch: "A meeting-note update failed schema validation.",
  invalid_meeting_id: "The configured meeting identity is invalid.",
  invalid_page_id: "The configured Notion page ID is invalid.",
  meeting_mismatch: "The persisted notes state belongs to a different meeting.",
  missing_meeting_id: "A stable meeting identity is required.",
  missing_page_id: "A fixed Notion page ID is required.",
  missing_state_root: "A private local notes-state root is required.",
  missing_token: "The Notion integration token is unavailable.",
  notion_rejected: "Notion rejected the notes update.",
  notion_write_uncertain: "A Notion write has an uncertain outcome and requires review.",
  rate_limited: "Notion rate-limited the notes update.",
  state_corrupt: "The local notes state could not be verified.",
  state_persist_failed: "The local notes cursor could not be persisted safely.",
  target_mismatch: "The persisted notes target does not match this meeting page.",
});

class NoteValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = "NoteValidationError";
    this.code = "invalid_batch";
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
}

function assertExactKeys(value, allowed, label) {
  const unexpected = Object.keys(value).filter((key) => !allowed.has(key));
  if (unexpected.length) throw new NoteValidationError(`${label} contains unsupported fields`);
}

function canonicalNotionPageId(value) {
  const compact = String(value ?? "").trim().toLocaleLowerCase().replaceAll("-", "");
  if (!/^[0-9a-f]{32}$/.test(compact)) return null;
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join("-");
}

function canonicalMeetingId(value) {
  const clean = String(value ?? "").trim();
  if (!clean || clean.length > MAX_MEETING_ID || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(clean)) {
    return null;
  }
  return clean;
}

function hashValue(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex");
}

function cleanSingleLine(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function isoTimestamp(value = new Date()) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new NoteValidationError("Meeting-note timestamp must be ISO-compatible");
  return parsed.toISOString();
}

function takeNotionNotesToken(environment = process.env) {
  const token = String(environment?.MEETING_AGENT_NOTION_TOKEN ?? "").trim();
  if (environment && Object.prototype.hasOwnProperty.call(environment, "MEETING_AGENT_NOTION_TOKEN")) {
    delete environment.MEETING_AGENT_NOTION_TOKEN;
  }
  return token;
}

function notionStateNamespacePath({ stateRoot, pageId, meetingId }) {
  const canonicalPage = canonicalNotionPageId(pageId);
  const canonicalMeeting = canonicalMeetingId(meetingId);
  if (!stateRoot || !canonicalPage || !canonicalMeeting) return null;
  return path.join(
    path.resolve(stateRoot),
    hashValue(canonicalPage),
    hashValue(canonicalMeeting),
  );
}

function validateMeetingNoteBatch(value) {
  if (!isPlainObject(value)) throw new NoteValidationError("Meeting-note batch must be an object");
  assertExactKeys(value, new Set(["cursor", "idempotencyKey", "section", "entries"]), "Meeting-note batch");

  if (!Number.isSafeInteger(value.cursor) || value.cursor < 1) {
    throw new NoteValidationError("Meeting-note cursor must be a positive integer");
  }
  const idempotencyKey = String(value.idempotencyKey ?? "");
  if (
    !idempotencyKey ||
    idempotencyKey.length > MAX_IDEMPOTENCY_KEY ||
    !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)
  ) {
    throw new NoteValidationError("Meeting-note idempotency key is invalid");
  }
  const section = Object.hasOwn(SECTION_KINDS, value.section) ? value.section : null;
  if (!section) throw new NoteValidationError("Meeting-note section is invalid");
  if (!Array.isArray(value.entries) || value.entries.length < 1 || value.entries.length > MAX_BATCH_ENTRIES) {
    throw new NoteValidationError(`Meeting-note entries must contain 1-${MAX_BATCH_ENTRIES} items`);
  }

  const entries = value.entries.map((entry) => {
    if (!isPlainObject(entry)) throw new NoteValidationError("Meeting-note entry must be an object");
    assertExactKeys(entry, new Set(["timestamp", "speaker", "text", "kind"]), "Meeting-note entry");
    const timestamp = isoTimestamp(entry.timestamp);
    const speaker = cleanSingleLine(entry.speaker);
    if (!speaker || speaker.length > MAX_SPEAKER_TEXT) {
      throw new NoteValidationError(`Meeting-note speaker must be 1-${MAX_SPEAKER_TEXT} characters`);
    }
    const text = cleanSingleLine(entry.text);
    if (!text || text.length > MAX_NOTE_TEXT) {
      throw new NoteValidationError(`Meeting-note text must be 1-${MAX_NOTE_TEXT} characters`);
    }
    const kind = String(entry.kind ?? "");
    if (!SECTION_KINDS[section].has(kind)) {
      throw new NoteValidationError(`Meeting-note kind is invalid for ${section}`);
    }
    return { timestamp, speaker, text, kind };
  });

  return { cursor: value.cursor, idempotencyKey, section, entries };
}

function meetingIdempotencyKey(meetingId, cursor, section) {
  const canonicalMeeting = canonicalMeetingId(meetingId);
  if (!canonicalMeeting) throw new NoteValidationError("Meeting identity is invalid");
  return `meeting-${hashValue(canonicalMeeting).slice(0, 24)}:${section}:${cursor}`;
}

function classifyRunningNoteKind(text) {
  const clean = cleanSingleLine(text);
  if (/\b(?:not|never|no decision|no action|without)\b/i.test(clean)) return "note";
  if (/\b(?:we (?:decided|agreed)|the decision is|decision:)\b/i.test(clean)) return "decision";
  if (/\b(?:action item|next step|follow[- ]?up|i(?:'ll| will)|we (?:need to|will)|owner:)\b/i.test(clean)) {
    return "next_step";
  }
  return "note";
}

function meetingNoteBatchFromTranscript({ meetingId, cursor, entry }) {
  const text = cleanSingleLine(entry?.text).slice(0, MAX_NOTE_TEXT);
  return validateMeetingNoteBatch({
    cursor,
    idempotencyKey: meetingIdempotencyKey(meetingId, cursor, "running_notes"),
    section: "running_notes",
    entries: [{
      timestamp: entry?.timestamp,
      speaker: cleanSingleLine(entry?.speaker).slice(0, MAX_SPEAKER_TEXT),
      text,
      kind: classifyRunningNoteKind(text),
    }],
  });
}

function stripListPrefix(line) {
  return cleanSingleLine(line)
    .replace(/^#{1,6}\s+/, "")
    .replace(/^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)/, "")
    .trim();
}

function meetingAgendaBatch({ meetingId, cursor, agendaText, timestamp = new Date() }) {
  const lines = String(agendaText ?? "")
    .split(/\r?\n/)
    .map(stripListPrefix)
    .filter((line) => line && !/^agenda:?$/i.test(line))
    .slice(0, MAX_BATCH_ENTRIES);
  const items = lines.length ? lines : ["No written agenda was provided."];
  return validateMeetingNoteBatch({
    cursor,
    idempotencyKey: meetingIdempotencyKey(meetingId, cursor, "agenda"),
    section: "agenda",
    entries: items.map((text) => ({
      timestamp: isoTimestamp(timestamp),
      speaker: "Agenda",
      text: text.slice(0, MAX_NOTE_TEXT),
      kind: "agenda",
    })),
  });
}

function debriefKindForHeading(value) {
  const heading = cleanSingleLine(value).toLocaleLowerCase().replace(/:$/, "");
  if (/^(?:outcome|summary)$/.test(heading)) return "outcome";
  if (/^decisions?$/.test(heading)) return "decision";
  if (/^(?:unresolved(?: questions?)?|open questions?)$/.test(heading)) return "unresolved";
  if (/^(?:action items?|next steps?)$/.test(heading)) return "next_step";
  return null;
}

function meetingDebriefBatch({ meetingId, cursor, debriefText, timestamp = new Date() }) {
  const entries = [];
  let currentKind = "outcome";
  for (const rawLine of String(debriefText ?? "").split(/\r?\n/)) {
    if (entries.length >= MAX_BATCH_ENTRIES) break;
    const headingMatch = rawLine.match(/^\s*#{1,6}\s+(.+?)\s*$/);
    if (headingMatch) {
      const headingKind = debriefKindForHeading(headingMatch[1]);
      if (headingKind) currentKind = headingKind;
      continue;
    }
    let text = stripListPrefix(rawLine);
    if (!text || /^meeting debrief:?$/i.test(text)) continue;
    const inlineKind = text.match(/^(Outcome|Summary|Decision|Unresolved(?: question)?|Open question|Action item|Next step)\s*:\s*(.+)$/i);
    if (inlineKind) {
      currentKind = debriefKindForHeading(inlineKind[1]) ?? currentKind;
      text = cleanSingleLine(inlineKind[2]);
    }
    if (!text) continue;
    entries.push({
      timestamp: isoTimestamp(timestamp),
      speaker: "Debrief",
      text: text.slice(0, MAX_NOTE_TEXT),
      kind: currentKind,
    });
  }
  if (!entries.length) {
    entries.push({
      timestamp: isoTimestamp(timestamp),
      speaker: "Debrief",
      text: "No generated debrief content was available; review the saved local transcript.",
      kind: "outcome",
    });
  }
  return validateMeetingNoteBatch({
    cursor,
    idempotencyKey: meetingIdempotencyKey(meetingId, cursor, "debrief"),
    section: "debrief",
    entries,
  });
}

function publicMeetingDebriefFromTranscript({ transcript = [], reason = "meeting-ended" } = {}) {
  const publicEntries = Array.isArray(transcript)
    ? transcript
      .filter((entry) => (
        isPlainObject(entry) &&
        entry.visibility !== "private" &&
        !String(entry.kind ?? "").startsWith("private-")
      ))
      .map((entry) => ({
        speaker: cleanSingleLine(entry.speaker).slice(0, MAX_SPEAKER_TEXT) || "Meeting",
        text: cleanSingleLine(entry.text).slice(0, MAX_NOTE_TEXT),
      }))
      .filter((entry) => entry.text)
      .slice(-200)
    : [];
  const unique = (entries, limit) => {
    const seen = new Set();
    return entries.filter((entry) => {
      const key = `${entry.speaker.toLocaleLowerCase()}\u0000${entry.text.toLocaleLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(-limit);
  };
  const decisions = unique(
    publicEntries.filter((entry) => classifyRunningNoteKind(entry.text) === "decision"),
    6,
  );
  const nextSteps = unique(
    publicEntries.filter((entry) => classifyRunningNoteKind(entry.text) === "next_step"),
    6,
  );
  const unresolved = unique(
    publicEntries.filter((entry) => /\?\s*$/.test(entry.text)),
    4,
  );
  const safeReason = cleanSingleLine(reason).replace(/[^A-Za-z0-9._ -]/g, "").slice(0, 80) || "meeting-ended";
  const lines = [
    "# Meeting debrief",
    "## Outcome",
    `${publicEntries.length} public transcript ${publicEntries.length === 1 ? "entry was" : "entries were"} captured before ${safeReason}.`,
  ];
  const appendSection = (heading, entries) => {
    if (!entries.length) return;
    lines.push(`## ${heading}`, ...entries.map((entry) => `- ${entry.speaker}: ${entry.text}`));
  };
  appendSection("Decisions", decisions);
  appendSection("Unresolved questions", unresolved);
  appendSection("Next steps", nextSteps);
  return lines.join("\n");
}

function textFragment(content, { bold = false } = {}) {
  return {
    type: "text",
    text: { content },
    ...(bold ? { annotations: { bold: true } } : {}),
  };
}

function headingBlock(content, level = 2) {
  const type = `heading_${level}`;
  return {
    object: "block",
    type,
    [type]: { rich_text: [textFragment(content)], color: "default", is_toggleable: false },
  };
}

function bulletBlock(prefix, text) {
  return {
    object: "block",
    type: "bulleted_list_item",
    bulleted_list_item: {
      rich_text: [textFragment(prefix, { bold: Boolean(prefix) }), textFragment(text)],
      color: "default",
    },
  };
}

function todoBlock(prefix, text) {
  return {
    object: "block",
    type: "to_do",
    to_do: {
      rich_text: [textFragment(prefix, { bold: true }), textFragment(text)],
      checked: false,
      color: "default",
    },
  };
}

function localTime(timestamp) {
  return new Date(timestamp).toLocaleTimeString("en-ZA", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "Africa/Johannesburg",
  });
}

function noteBlocks(batch) {
  if (batch.section === "agenda") {
    return [
      headingBlock("Agenda"),
      ...batch.entries.map((entry) => bulletBlock("", entry.text)),
      headingBlock("Running notes"),
    ];
  }
  if (batch.section === "running_notes") {
    return batch.entries.map((entry) => {
      const prefix = `${entry.kind === "decision" ? "Decision · " : entry.kind === "next_step" ? "Next step · " : ""}${localTime(entry.timestamp)} · ${entry.speaker}: `;
      return entry.kind === "next_step"
        ? todoBlock(prefix, entry.text)
        : bulletBlock(prefix, entry.text);
    });
  }

  const blocks = [headingBlock("Debrief")];
  const groups = [
    ["outcome", "Outcome"],
    ["decision", "Decisions"],
    ["unresolved", "Unresolved questions"],
    ["next_step", "Next steps"],
  ];
  for (const [kind, heading] of groups) {
    const entries = batch.entries.filter((entry) => entry.kind === kind);
    if (!entries.length) continue;
    blocks.push(headingBlock(heading, 3));
    for (const entry of entries) {
      blocks.push(kind === "next_step" ? todoBlock("", entry.text) : bulletBlock("", entry.text));
    }
  }
  return blocks;
}

function retryAfterDelayMs(
  response,
  { now = Date.now(), fallbackMs = 250, maxMs = MAX_RETRY_AFTER_MS } = {},
) {
  const cap = Math.max(0, Math.min(Number(maxMs) || 0, 30_000));
  const fallback = Math.max(0, Math.min(Number(fallbackMs) || 0, cap));
  const raw = response?.headers?.get?.("retry-after");
  if (typeof raw !== "string" || !raw.trim()) return fallback;
  const value = raw.trim();
  let delay;
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    delay = !Number.isFinite(seconds) || seconds >= cap / 1_000
      ? cap
      : seconds * 1_000;
  } else if (/^[A-Za-z]{3},\s.+\sGMT$/i.test(value)) {
    const date = Date.parse(value);
    const current = now instanceof Date ? now.getTime() : Number(now);
    delay = Number.isFinite(date) && Number.isFinite(current) ? Math.max(0, date - current) : Number.NaN;
  } else {
    delay = Number.NaN;
  }
  return Number.isFinite(delay) && delay >= 0 ? Math.min(Math.round(delay), cap) : fallback;
}

function configurationError({ enabled, pageId, meetingId, token, stateRoot, fetchImpl }) {
  if (!enabled) return null;
  if (!String(pageId ?? "").trim()) return "missing_page_id";
  if (!canonicalNotionPageId(pageId)) return "invalid_page_id";
  if (!String(meetingId ?? "").trim()) return "missing_meeting_id";
  if (!canonicalMeetingId(meetingId)) return "invalid_meeting_id";
  if (!String(token ?? "").trim()) return "missing_token";
  if (!stateRoot) return "missing_state_root";
  if (typeof fetchImpl !== "function") return "notion_rejected";
  return null;
}

export class NotionNotesSink {
  #token;
  #fetch;
  #pageId;
  #meetingId;
  #targetHash;
  #meetingHash;
  #namespaceHash;
  #namespaceDir;
  #statePath;
  #auditPath;
  #queue = Promise.resolve();
  #initialized = false;
  #configurationError;
  #completedKeys = new Map();
  #lastCursor = 0;
  #writtenEntries = 0;
  #lastSyncedAt = null;
  #inflight = null;
  #blockedReason = null;
  #status;
  #errorCode = null;

  constructor({
    enabled = false,
    pageId,
    meetingId,
    token,
    stateRoot,
    fetchImpl = globalThis.fetch,
    requestTimeoutMs = 10_000,
    maxSafeRetries = 1,
    retryDelayMs = 250,
    maxRetryAfterMs = MAX_RETRY_AFTER_MS,
    logger = console,
    now = () => new Date(),
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  } = {}) {
    this.enabled = Boolean(enabled);
    this.#pageId = canonicalNotionPageId(pageId);
    this.#meetingId = canonicalMeetingId(meetingId);
    this.#targetHash = this.#pageId ? hashValue(this.#pageId) : null;
    this.#meetingHash = this.#meetingId ? hashValue(this.#meetingId) : null;
    this.#namespaceHash = this.#targetHash && this.#meetingHash
      ? hashValue(`${this.#targetHash}:${this.#meetingHash}`)
      : null;
    this.#token = String(token ?? "").trim();
    this.#fetch = fetchImpl;
    this.#namespaceDir = notionStateNamespacePath({ stateRoot, pageId, meetingId });
    this.#statePath = this.#namespaceDir ? path.join(this.#namespaceDir, "state.json") : null;
    this.#auditPath = this.#namespaceDir ? path.join(this.#namespaceDir, "audit.jsonl") : null;
    this.requestTimeoutMs = Math.max(250, Math.min(Number(requestTimeoutMs) || 10_000, 30_000));
    this.maxSafeRetries = Math.max(0, Math.min(Number(maxSafeRetries) || 0, 3));
    this.retryDelayMs = Math.max(0, Math.min(Number(retryDelayMs) || 0, 2_000));
    this.maxRetryAfterMs = Math.max(0, Math.min(Number(maxRetryAfterMs) || 0, 30_000));
    this.logger = logger;
    this.now = now;
    this.sleep = sleep;
    this.#configurationError = configurationError({ enabled, pageId, meetingId, token, stateRoot, fetchImpl });
    this.#status = !this.enabled ? "disabled" : this.#configurationError ? "error" : "starting";
    this.#errorCode = this.#configurationError;
  }

  getState() {
    return {
      enabled: this.enabled,
      configured: this.enabled && !this.#configurationError,
      status: this.#status,
      target: this.#pageId ? `page …${this.#pageId.slice(-6)}` : null,
      meeting: this.#meetingHash ? `meeting …${this.#meetingHash.slice(-6)}` : null,
      namespace: this.#namespaceHash?.slice(0, 16) ?? null,
      lastCursor: this.#lastCursor,
      writtenEntries: this.#writtenEntries,
      lastSyncedAt: this.#lastSyncedAt,
      pendingReview: Boolean(this.#blockedReason || this.#inflight),
      error: this.#errorCode
        ? {
            code: this.#errorCode,
            message: PUBLIC_ERROR_MESSAGES[this.#errorCode] ?? "Notion notes stopped safely.",
          }
        : null,
    };
  }

  async initialize() {
    if (this.#initialized) return this.getState();
    this.#initialized = true;
    if (!this.enabled) return this.getState();

    if (!this.#namespaceDir) {
      this.#status = "error";
      this.#errorCode = this.#configurationError ?? "state_corrupt";
      return this.getState();
    }

    try {
      await mkdir(this.#namespaceDir, { recursive: true, mode: 0o700 });
      await chmod(this.#namespaceDir, 0o700);
      const persisted = await this.#readPersistedState();
      if (persisted) this.#restoreState(persisted);
      if (this.#blockedReason || this.#inflight) {
        this.#status = "error";
        this.#errorCode = this.#blockedReason ?? "notion_write_uncertain";
        return this.getState();
      }
      if (this.#configurationError) {
        this.#status = "error";
        this.#errorCode = this.#configurationError;
        await this.#persistState();
        await this.#audit("configuration_error", { code: this.#configurationError });
        return this.getState();
      }
      this.#status = "ready";
      this.#errorCode = null;
      await this.#persistState();
      await this.#audit("initialized");
    } catch {
      this.#status = "error";
      this.#errorCode = "state_corrupt";
      this.#blockedReason = "state_corrupt";
      this.logger.warn?.("[notion notes] disabled because local state could not be verified");
    }
    return this.getState();
  }

  capture(batch) {
    const operation = async () => {
      try {
        if (!this.#initialized) await this.initialize();
        return await this.#capture(batch);
      } catch {
        this.#status = "error";
        this.#errorCode = "state_persist_failed";
        this.#blockedReason = "state_persist_failed";
        this.logger.warn?.("[notion notes] update stopped safely after a local persistence failure");
        return { ok: false, status: "error", error: this.getState().error };
      }
    };
    const pending = this.#queue.then(operation, operation);
    this.#queue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  async flush() {
    await this.#queue;
  }

  async #capture(rawBatch) {
    if (!this.enabled) return { ok: false, status: "disabled" };
    if (this.#configurationError || this.#blockedReason || this.#inflight) {
      return { ok: false, status: "error", error: this.getState().error };
    }

    let batch;
    try {
      batch = validateMeetingNoteBatch(rawBatch);
    } catch (error) {
      this.#status = "error";
      this.#errorCode = error.code === "invalid_batch" ? error.code : "invalid_batch";
      await this.#persistState();
      await this.#audit("validation_error", {
        code: this.#errorCode,
        cursor: Number.isSafeInteger(rawBatch?.cursor) ? rawBatch.cursor : null,
      });
      return { ok: false, status: "rejected", error: this.getState().error };
    }

    const keyHash = hashValue(batch.idempotencyKey);
    if (this.#completedKeys.has(keyHash)) {
      const completedCursor = this.#completedKeys.get(keyHash);
      if (completedCursor !== batch.cursor) {
        this.#status = "error";
        this.#errorCode = "cursor_conflict";
        this.#blockedReason = "cursor_conflict";
        await this.#persistState();
        await this.#audit("cursor_error", {
          code: "cursor_conflict",
          cursor: batch.cursor,
          completedCursor,
          keyHash: keyHash.slice(0, 16),
        }).catch(() => {});
        return { ok: false, status: "error", error: this.getState().error };
      }
      await this.#audit("duplicate", { cursor: batch.cursor, keyHash: keyHash.slice(0, 16) });
      return {
        ok: true,
        status: "duplicate",
        cursor: this.#lastCursor,
        writtenEntries: this.#writtenEntries,
      };
    }

    const expectedCursor = this.#lastCursor + 1;
    if (batch.cursor !== expectedCursor) {
      const code = batch.cursor > expectedCursor ? "cursor_gap" : "cursor_conflict";
      this.#status = "error";
      this.#errorCode = code;
      this.#blockedReason = code;
      await this.#persistState();
      await this.#audit("cursor_error", {
        code,
        cursor: batch.cursor,
        expectedCursor,
        keyHash: keyHash.slice(0, 16),
      }).catch(() => {});
      return { ok: false, status: "error", error: this.getState().error };
    }

    this.#status = "syncing";
    this.#errorCode = null;
    this.#inflight = {
      cursor: batch.cursor,
      keyHash,
      section: batch.section,
      entryCount: batch.entries.length,
      startedAt: this.now().toISOString(),
    };
    await this.#audit("attempt", {
      cursor: batch.cursor,
      keyHash: keyHash.slice(0, 16),
      section: batch.section,
      entryCount: batch.entries.length,
    });
    await this.#persistState();

    const body = JSON.stringify({ children: noteBlocks(batch) });
    let response;
    for (let attempt = 0; attempt <= this.maxSafeRetries; attempt += 1) {
      try {
        response = await this.#request(body);
      } catch {
        return this.#markUncertain(batch, keyHash);
      }
      if (response.status !== 429 || attempt >= this.maxSafeRetries) break;
      const delayMs = retryAfterDelayMs(response, {
        now: this.now(),
        fallbackMs: this.retryDelayMs,
        maxMs: this.maxRetryAfterMs,
      });
      await this.#audit("safe_retry", {
        code: "rate_limited",
        cursor: batch.cursor,
        keyHash: keyHash.slice(0, 16),
        delayMs,
      });
      if (delayMs) await this.sleep(delayMs);
    }

    if (!response.ok) return this.#handleRejectedResponse(response.status, batch, keyHash);

    this.#completedKeys.set(keyHash, batch.cursor);
    while (this.#completedKeys.size > MAX_COMPLETED_KEYS) {
      this.#completedKeys.delete(this.#completedKeys.keys().next().value);
    }
    this.#lastCursor = batch.cursor;
    this.#writtenEntries += batch.entries.length;
    this.#lastSyncedAt = this.now().toISOString();
    this.#inflight = null;
    this.#status = "ready";
    this.#errorCode = null;
    try {
      await this.#persistState();
    } catch {
      this.#status = "error";
      this.#errorCode = "state_persist_failed";
      this.#blockedReason = "state_persist_failed";
      return { ok: false, status: "uncertain", error: this.getState().error };
    }
    try {
      await this.#audit("success", {
        cursor: batch.cursor,
        keyHash: keyHash.slice(0, 16),
        section: batch.section,
        entryCount: batch.entries.length,
      });
    } catch {
      this.#status = "error";
      this.#errorCode = "audit_write_failed";
      this.#blockedReason = "audit_write_failed";
      await this.#persistState().catch(() => {});
      return { ok: false, status: "error", error: this.getState().error };
    }
    return {
      ok: true,
      status: "written",
      cursor: this.#lastCursor,
      writtenEntries: this.#writtenEntries,
    };
  }

  async #request(body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    timeout.unref?.();
    try {
      return await this.#fetch(`${NOTION_API_ORIGIN}/v1/blocks/${this.#pageId}/children`, {
        method: "PATCH",
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${this.#token}`,
          "Content-Type": "application/json",
          "Notion-Version": NOTION_VERSION,
        },
        body,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async #handleRejectedResponse(status, batch, keyHash) {
    this.#inflight = null;
    if (status === 429) {
      this.#status = "error";
      this.#errorCode = "rate_limited";
      this.#blockedReason = "rate_limited";
      await this.#persistState();
      await this.#audit("error", {
        code: this.#errorCode,
        cursor: batch.cursor,
        keyHash: keyHash.slice(0, 16),
      });
      return { ok: false, status: "error", error: this.getState().error };
    }

    const errorCode = status === 401 || status === 403
      ? "auth_failed"
      : status >= 500
        ? "notion_write_uncertain"
        : "notion_rejected";
    this.#status = "error";
    this.#errorCode = errorCode;
    this.#blockedReason = errorCode;
    if (errorCode === "notion_write_uncertain") {
      this.#inflight = {
        cursor: batch.cursor,
        keyHash,
        section: batch.section,
        entryCount: batch.entries.length,
        startedAt: this.now().toISOString(),
      };
    }
    await this.#persistState();
    await this.#audit("error", {
      code: errorCode,
      cursor: batch.cursor,
      keyHash: keyHash.slice(0, 16),
      httpStatus: status,
    });
    return { ok: false, status: "error", error: this.getState().error };
  }

  async #markUncertain(batch, keyHash) {
    this.#status = "error";
    this.#errorCode = "notion_write_uncertain";
    this.#blockedReason = "notion_write_uncertain";
    await this.#persistState();
    await this.#audit("error", {
      code: this.#errorCode,
      cursor: batch.cursor,
      keyHash: keyHash.slice(0, 16),
    }).catch(() => {});
    return { ok: false, status: "uncertain", error: this.getState().error };
  }

  async #readPersistedState() {
    try {
      return JSON.parse(await readFile(this.#statePath, "utf8"));
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }

  #restoreState(persisted) {
    if (!isPlainObject(persisted) || persisted.version !== STATE_VERSION) {
      throw new Error("Unsupported notes state");
    }
    if (persisted.targetHash !== this.#targetHash) {
      this.#blockedReason = "target_mismatch";
      this.#errorCode = "target_mismatch";
      return;
    }
    if (persisted.meetingHash !== this.#meetingHash) {
      this.#blockedReason = "meeting_mismatch";
      this.#errorCode = "meeting_mismatch";
      return;
    }
    this.#lastCursor = Number.isSafeInteger(persisted.lastCursor) && persisted.lastCursor >= 0
      ? persisted.lastCursor
      : 0;
    this.#writtenEntries = Number.isSafeInteger(persisted.writtenEntries) && persisted.writtenEntries >= 0
      ? persisted.writtenEntries
      : 0;
    this.#lastSyncedAt = typeof persisted.lastSyncedAt === "string" ? persisted.lastSyncedAt : null;
    this.#completedKeys = new Map(
      Array.isArray(persisted.completedKeys)
        ? persisted.completedKeys
          .filter((value) => (
            isPlainObject(value) &&
            /^[0-9a-f]{64}$/.test(value.keyHash) &&
            Number.isSafeInteger(value.cursor) &&
            value.cursor >= 1
          ))
          .slice(-MAX_COMPLETED_KEYS)
          .map((value) => [value.keyHash, value.cursor])
        : [],
    );
    this.#inflight = isPlainObject(persisted.inflight) ? persisted.inflight : null;
    this.#blockedReason = typeof persisted.blockedReason === "string"
      ? persisted.blockedReason
      : this.#blockedReason;
    this.#errorCode = typeof persisted.errorCode === "string" ? persisted.errorCode : this.#errorCode;
  }

  async #persistState() {
    if (!this.#statePath) throw new Error("Notes state path is unavailable");
    const state = {
      version: STATE_VERSION,
      targetHash: this.#targetHash,
      meetingHash: this.#meetingHash,
      lastCursor: this.#lastCursor,
      writtenEntries: this.#writtenEntries,
      lastSyncedAt: this.#lastSyncedAt,
      completedKeys: [...this.#completedKeys].map(([keyHash, cursor]) => ({ keyHash, cursor })),
      inflight: this.#inflight,
      blockedReason: this.#blockedReason,
      errorCode: this.#errorCode,
    };
    const temporaryPath = `${this.#statePath}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`;
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    await rename(temporaryPath, this.#statePath);
    await chmod(this.#statePath, 0o600);
  }

  async #audit(event, details = {}) {
    if (!this.#auditPath) throw new Error("Notes audit path is unavailable");
    const record = {
      timestamp: this.now().toISOString(),
      event,
      ...details,
    };
    await appendFile(this.#auditPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    await chmod(this.#auditPath, 0o600);
  }
}

export {
  MAX_BATCH_ENTRIES,
  MAX_NOTE_TEXT,
  MAX_RETRY_AFTER_MS,
  canonicalMeetingId,
  canonicalNotionPageId,
  classifyRunningNoteKind,
  meetingAgendaBatch,
  meetingDebriefBatch,
  meetingNoteBatchFromTranscript,
  notionStateNamespacePath,
  publicMeetingDebriefFromTranscript,
  retryAfterDelayMs,
  takeNotionNotesToken,
  validateMeetingNoteBatch,
};
