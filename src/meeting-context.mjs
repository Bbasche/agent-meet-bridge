function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

const QUESTION_PATTERN = /\?|\b(?:question|wondering|unclear|not sure)\b/i;
const COMMITMENT_PATTERN = /\b(?:we(?:'ll| will)|i(?:'ll| will)|need to|action item|follow up|decided|decision|owner|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b/i;

function normalizeEntry(entry) {
  return {
    speaker: clean(entry?.speaker) || "Meeting",
    text: clean(entry?.text),
    timestamp: entry?.timestamp,
  };
}

function rememberUnique(list, value, limit) {
  const key = value.toLowerCase();
  const existing = list.findIndex((item) => item.key === key);
  if (existing >= 0) list.splice(existing, 1);
  list.push({ key, value });
  if (list.length > limit) list.splice(0, list.length - limit);
}

function chronologicalLines(entries, { maxChars, maxTurns }) {
  const recent = [];
  let used = 0;
  for (let index = entries.length - 1; index >= 0 && recent.length < maxTurns; index -= 1) {
    const entry = entries[index];
    const date = entry.timestamp ? new Date(entry.timestamp) : null;
    const timestamp = date && !Number.isNaN(date.valueOf()) ? date.toISOString().slice(11, 19) : "";
    const line = `${timestamp ? `[${timestamp}] ` : ""}${entry.speaker}: ${entry.text}`;
    if (used + line.length > maxChars && recent.length) break;
    recent.unshift(line.slice(0, Math.max(0, maxChars - used)));
    used += line.length + 1;
  }
  return recent;
}

export class MeetingContextAccumulator {
  constructor(entries = [], {
    recentLimit = 500,
    questionMemory = 80,
    commitmentMemory = 120,
    participantLimit = 100,
  } = {}) {
    this.recentLimit = recentLimit;
    this.questionMemory = questionMemory;
    this.commitmentMemory = commitmentMemory;
    this.participantLimit = participantLimit;
    this.participants = new Map();
    this.questions = [];
    this.commitments = [];
    this.recent = [];
    this.entriesSeen = 0;
    for (const entry of entries) this.add(entry);
  }

  add(entry) {
    const normalized = normalizeEntry(entry);
    if (!normalized.text) return false;
    this.entriesSeen += 1;
    const participantKey = normalized.speaker.toLowerCase();
    if (this.participants.has(participantKey)) this.participants.delete(participantKey);
    this.participants.set(participantKey, normalized.speaker);
    while (this.participants.size > this.participantLimit) {
      this.participants.delete(this.participants.keys().next().value);
    }
    const labeled = `${normalized.speaker}: ${normalized.text}`;
    if (QUESTION_PATTERN.test(normalized.text)) rememberUnique(this.questions, labeled, this.questionMemory);
    if (COMMITMENT_PATTERN.test(normalized.text)) rememberUnique(this.commitments, labeled, this.commitmentMemory);
    this.recent.push(normalized);
    if (this.recent.length > this.recentLimit) {
      this.recent.splice(0, this.recent.length - this.recentLimit);
    }
    return true;
  }

  snapshot({
    maxChars = 20_000,
    maxTurns = 80,
    questionLimit = 12,
    commitmentLimit = 20,
  } = {}) {
    const participants = [...this.participants.values()];
    const questions = this.questions.slice(-questionLimit).map((item) => item.value);
    const commitments = this.commitments.slice(-commitmentLimit).map((item) => item.value);
    const summarySections = [
      `Turns captured: ${this.entriesSeen}`,
      `Participants heard: ${participants.join(", ") || "none yet"}`,
      questions.length ? `Recent questions or uncertainties retained across the call:\n- ${questions.join("\n- ")}` : "",
      commitments.length
        ? `Candidate decisions or commitments retained across the call (verify against transcript):\n- ${commitments.join("\n- ")}`
        : "",
    ].filter(Boolean);
    const transcriptReserve = Math.min(1_000, Math.max(80, Math.floor(maxChars * 0.3)));
    const summaryBudget = Math.max(0, maxChars - transcriptReserve - 40);
    const summary = summarySections.join("\n\n").slice(0, summaryBudget);
    const transcriptBudget = Math.max(40, maxChars - summary.length - 40);
    const recent = chronologicalLines(this.recent, { maxChars: transcriptBudget, maxTurns });
    const context = [
      summary,
      recent.length ? `Recent chronological transcript:\n${recent.join("\n")}` : "No recent transcript is available.",
    ].join("\n\n");
    return context.slice(0, maxChars);
  }
}

export function buildMeetingContext(entries, options = {}) {
  return new MeetingContextAccumulator(entries).snapshot(options);
}
