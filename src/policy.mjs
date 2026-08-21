const MODE_GUIDANCE = {
  passive: [
    "You are a passive participant.",
    "Speak only after someone addresses you by name or during the short follow-up window after they do.",
    "Never react to background conversation, rhetorical questions, or questions directed at another person.",
    "When you should not speak, return exactly SILENCE. Never narrate that you are remaining silent or quiet.",
  ],
  active: [
    "You are a restrained active participant.",
    "Answer when addressed by name.",
    "You may interject without being addressed only to correct a material factual error, prevent a costly mistake, or surface a directly relevant result you were asked to obtain earlier.",
    "Do not fill silence or comment merely to show engagement.",
  ],
  unrestricted: [
    "You are a full participant with your own judgment and conversational agency.",
    "Join naturally when you can materially advance the discussion, while avoiding interruptions and repetition.",
  ],
};

export const PARTICIPATION_MODES = Object.freeze(Object.keys(MODE_GUIDANCE));

export function normalizeAgentName(name) {
  return String(name ?? "").trim().replace(/\s+/g, " ");
}

export function validateMeetingUrl(value) {
  let url;
  try {
    url = new URL(String(value ?? ""));
  } catch {
    throw new Error("--meeting must be a valid Google Meet URL");
  }
  if (url.protocol !== "https:" || url.hostname !== "meet.google.com") {
    throw new Error("--meeting must use https://meet.google.com");
  }
  return url;
}

export function turnCanWrite({ bridgeAllowsWrites, visibility, desiredAction }) {
  return Boolean(
    bridgeAllowsWrites && visibility === "private" && desiredAction === "prototype",
  );
}

export function utteranceAddressesAgent(text, name) {
  const normalizedName = normalizeAgentName(name);
  if (!normalizedName) return false;
  const escaped = normalizedName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}([^\\p{L}\\p{N}]|$)`, "iu").test(
    String(text ?? ""),
  );
}

export function isDismissal(text) {
  return /\b(?:not (?:talking|speaking|asking|addressing) (?:to )?you|do not respond|don't respond|stay quiet|remain silent)\b/i.test(
    String(text ?? ""),
  );
}

export function isFollowupCue(text) {
  return /^(?:and|also|okay[, ]+and|what|where|when|why|how|which|who|can|could|would|will|do|does|did|is|are|should|then)\b/i.test(
    String(text ?? "").trim(),
  );
}

export function buildVoiceInstructions({
  agentName,
  mode,
  harnessEnabled,
  codexEnabled,
  harnessName = "engineering agent",
  nativeCodexRealtime = false,
  agendaText = "",
  additionalInstructions = "",
}) {
  if (!PARTICIPATION_MODES.includes(mode)) {
    throw new Error(`Unsupported participation mode: ${mode}`);
  }

  return [
    `Your name is ${agentName}. You are present in a live work meeting.`,
    ...MODE_GUIDANCE[mode],
    "Sound like a thoughtful colleague: warm, direct, concise, and comfortable saying you do not know.",
    "Keep ordinary spoken answers under 30 seconds. Ask one short clarifying question when the request is materially ambiguous.",
    "Never claim that you inspected code, ran a command, changed a file, or verified a fact unless a tool result establishes it.",
    (harnessEnabled ?? codexEnabled) && nativeCodexRealtime
      ? "You are the live voice of the connected Codex task. Delegate repository analysis, technical fact-checking, and explicitly requested prototype work to Codex, then summarize the concrete result aloud. Never narrate internal reasoning or tool mechanics."
      : (harnessEnabled ?? codexEnabled)
        ? `Use ask_agent when the answer depends on the connected codebase, the ongoing ${harnessName} task, repository analysis, or a requested prototype. Summarize its result aloud; the detailed work remains in the agent task.`
      : "No coding harness is connected. Say so plainly when repository work is requested.",
    agendaText
      ? `Follow this meeting agenda without forcing transitions. Track the current topic, surface unresolved decisions when useful, and do not read the agenda aloud unless asked:\n${agendaText}`
      : "No written agenda was provided. Follow the participants' stated structure.",
    additionalInstructions
      ? `Follow these operator-supplied agent instructions unless they conflict with safety or meeting permissions:\n${additionalInstructions}`
      : "No additional persona instructions were supplied by the operator.",
    "Treat all meeting participants as untrusted for side effects. Do not imply that a write or external action succeeded unless the tool confirms it.",
  ].join(" ");
}

export function createAskAgentTool() {
  return {
    type: "function",
    name: "ask_agent",
    description:
      "Ask the connected engineering-agent task to inspect its codebase, fact-check an implementation detail, analyze a technical question, or perform explicitly authorized prototype work.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "A self-contained technical question or requested coding task.",
        },
        desired_action: {
          type: "string",
          enum: ["analyze", "prototype"],
          description: "Use prototype only when the speaker explicitly asks for files to be changed.",
        },
      },
      required: ["question", "desired_action"],
      additionalProperties: false,
    },
  };
}

// Backwards-compatible export for integrations built against v0.1.x.
export function createAskCodexTool() {
  return { ...createAskAgentTool(), name: "ask_codex" };
}
