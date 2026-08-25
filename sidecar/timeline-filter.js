const DEFAULT_DISPLAY_DEDUPE_WINDOW_MS = 8_000;
const MAX_TRACKED_SIGNATURES = 200;

const meetChromeToken = /^(?:more_vert|mic(?:_none|_off)?|keep_outline|person_add|domain_disabled|keyboard_arrow_up|summarize_auto_\d+|close|check)$/i;
const meetChromeText = /^(?:[AP]M|You|\d+|Got it|Loading(?:\.\.\.)?|Reframe|Backgrounds and effects|Summarize captions|Close|Admit \d+ guests?|Pin .+ to your main screen|Mute(?: this participant's microphone)?|More options for .+|You can't (?:turn on|unmute) .+|.+ (?:joined|has left) (?:this call|the meeting))$/i;

function visibleCallEntries(entries = [], { dedupeWindowMs = DEFAULT_DISPLAY_DEDUPE_WINDOW_MS } = {}) {
  const boundedWindowMs = Math.max(0, Math.min(Number(dedupeWindowMs) || 0, 60_000));
  const lastSeenBySignature = new Map();
  return entries.filter((entry) => {
    const speaker = String(entry.speaker ?? "Meeting").trim();
    const text = String(entry.text ?? "").replace(/\s+/g, " ").trim();
    if (!text) return false;
    if (meetChromeToken.test(speaker) || meetChromeToken.test(text)) return false;
    if (speaker === "Got it" || meetChromeText.test(text)) return false;
    if (/[?!]$/.test(speaker) && /^(?:You|.+ joined)$/i.test(text)) return false;

    const timestamp = Date.parse(String(entry.timestamp ?? ""));
    if (!Number.isFinite(timestamp)) return true;
    const signature = `${speaker.toLocaleLowerCase()}\u0000${text.toLocaleLowerCase()}`;
    const previousTimestamp = lastSeenBySignature.get(signature);
    if (
      Number.isFinite(previousTimestamp) &&
      timestamp >= previousTimestamp &&
      timestamp - previousTimestamp <= boundedWindowMs
    ) return false;
    lastSeenBySignature.delete(signature);
    lastSeenBySignature.set(signature, timestamp);
    while (lastSeenBySignature.size > MAX_TRACKED_SIGNATURES) {
      lastSeenBySignature.delete(lastSeenBySignature.keys().next().value);
    }
    return true;
  });
}

export {
  DEFAULT_DISPLAY_DEDUPE_WINDOW_MS,
  visibleCallEntries,
};
