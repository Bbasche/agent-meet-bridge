function clean(value) {
  return String(value ?? "").replace(/\s+/g, " ").trim();
}

function uniqueRecent(values, limit) {
  const seen = new Set();
  const result = [];
  for (let index = values.length - 1; index >= 0 && result.length < limit; index -= 1) {
    const value = clean(values[index]);
    const key = value.toLowerCase();
    if (!value || seen.has(key)) continue;
    seen.add(key);
    result.unshift(value);
  }
  return result;
}

export function buildMeetingContext(entries, { maxChars = 20_000, maxTurns = 80 } = {}) {
  const normalized = entries
    .map((entry) => ({
      speaker: clean(entry.speaker) || "Meeting",
      text: clean(entry.text),
      timestamp: entry.timestamp,
    }))
    .filter((entry) => entry.text);
  const participants = [...new Set(normalized.map((entry) => entry.speaker))];
  const questions = uniqueRecent(
    normalized.filter((entry) => /\?|\b(?:question|wondering|unclear|not sure)\b/i.test(entry.text))
      .map((entry) => `${entry.speaker}: ${entry.text}`),
    8,
  );
  const commitments = uniqueRecent(
    normalized.filter((entry) => /\b(?:we(?:'ll| will)|i(?:'ll| will)|need to|action item|follow up|decided|decision|owner|by (?:monday|tuesday|wednesday|thursday|friday|tomorrow|next week))\b/i.test(entry.text))
      .map((entry) => `${entry.speaker}: ${entry.text}`),
    10,
  );
  const recent = [];
  let used = 0;
  for (let index = normalized.length - 1; index >= 0 && recent.length < maxTurns; index -= 1) {
    const entry = normalized[index];
    const timestamp = entry.timestamp ? new Date(entry.timestamp).toISOString().slice(11, 19) : "";
    const line = `${timestamp ? `[${timestamp}] ` : ""}${entry.speaker}: ${entry.text}`;
    if (used + line.length > maxChars && recent.length) break;
    recent.unshift(line);
    used += line.length + 1;
  }
  return [
    `Participants heard: ${participants.join(", ") || "none yet"}`,
    questions.length ? `Recent questions or uncertainties:\n- ${questions.join("\n- ")}` : "Recent questions or uncertainties: none detected",
    commitments.length ? `Candidate decisions or commitments (verify against transcript):\n- ${commitments.join("\n- ")}` : "Candidate decisions or commitments: none detected",
    recent.length ? `Recent chronological transcript:\n${recent.join("\n")}` : "No recent transcript is available.",
  ].join("\n\n");
}
