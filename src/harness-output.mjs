export function boundedHarnessText(value, maxChars = 20_000) {
  const clean = String(value ?? "").trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars)}\n\n[Output truncated]` : clean;
}

export function spokenHarnessText(value, maxWords = 120) {
  const words = String(value ?? "").trim().split(/\s+/).filter(Boolean);
  return words.length > maxWords ? `${words.slice(0, maxWords).join(" ")} …` : words.join(" ");
}

export function roomHarnessAnalysisText({ text, question }) {
  const detail = boundedHarnessText(text);
  if (!detail) return "";
  const questionLabel = question ? ` for “${String(question).slice(0, 240)}”` : "";
  return `Room-request analysis${questionLabel}:\n\n${detail}`;
}
