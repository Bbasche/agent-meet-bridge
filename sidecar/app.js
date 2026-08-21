const params = new URLSearchParams(window.location.search);
const session = params.get("session") ?? "";
const messages = document.querySelector("#messages");
const conversation = document.querySelector("#conversation");
const composer = document.querySelector("#composer");
const input = document.querySelector("#message-input");
const send = document.querySelector("#send");
const dictate = document.querySelector("#dictate");
const errorBox = document.querySelector("#composer-error");
const scrollTail = document.querySelector("#scroll-tail");
const shareDialog = document.querySelector("#share-dialog");
const shareForm = document.querySelector("#share-form");
const shareText = document.querySelector("#share-text");
const shareCount = document.querySelector("#share-count");
const toast = document.querySelector("#toast");
const agendaPanel = document.querySelector("#agenda-panel");
const agendaText = document.querySelector("#agenda-text");
const saveAgenda = document.querySelector("#save-agenda");
let desiredAction = "analyze";
let currentAgentName = "Meeting employee";
let shouldFollowTail = true;
let toastTimer;
let privateTurnPending = false;
let lastTimelineSignature = "";
let renderingTimeline = false;

function api(path, options = {}) {
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "x-meeting-agent-session": session,
      ...options.headers,
    },
  }).then(async (response) => {
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
    return body;
  });
}

function showToast(message) {
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 3500);
}

function scrollToTail({ force = false } = {}) {
  if (force || shouldFollowTail) conversation.scrollTop = conversation.scrollHeight;
}

function messageRow(role, text, { pending = false, speaker, visibility = "private", timestamp } = {}) {
  const row = document.createElement("li");
  row.className = `message-row message-row--${role}`;
  const article = document.createElement("article");
  article.className = `message message--${role}`;
  if (pending) {
    article.className = "tool-trace";
    article.setAttribute("role", "status");
    article.innerHTML = '<span class="tool-trace__spinner" aria-hidden="true"></span><span><strong>Working in Codex</strong><br />Using the ongoing task privately</span><button class="tool-trace__stop" type="button">Stop</button>';
  } else {
    const context = document.createElement("div");
    context.className = "message-context";
    const author = document.createElement("strong");
    author.textContent = speaker ?? (role === "user" ? "You" : currentAgentName);
    const scope = document.createElement("span");
    scope.className = `message-scope message-scope--${visibility}`;
    scope.textContent = visibility === "call" ? "Call" : "Private";
    context.append(author, scope);
    if (timestamp) {
      const time = document.createElement("time");
      time.dateTime = timestamp;
      time.textContent = new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      });
      context.append(time);
    }
    const paragraph = document.createElement("p");
    paragraph.textContent = text;
    article.append(context, paragraph);
  }
  row.append(article);
  messages.append(row);
  if (!renderingTimeline) scrollToTail({ force: role === "user" });
  return row;
}

function renderTimeline(callEntries = [], privateEntries = []) {
  const timeline = [
    ...callEntries.map((entry) => ({
      role: entry.speaker === currentAgentName ? "call-agent" : "call",
      speaker: entry.speaker ?? "Meeting",
      text: entry.text,
      timestamp: entry.timestamp,
      visibility: "call",
    })),
    ...privateEntries.map((entry) => ({
      role: entry.role === "user" ? "user" : "assistant",
      speaker: entry.role === "user" ? "You" : currentAgentName,
      text: entry.text,
      timestamp: entry.timestamp,
      visibility: "private",
    })),
  ].sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));

  const signature = JSON.stringify(timeline);
  if (signature === lastTimelineSignature) return;
  lastTimelineSignature = signature;
  const wasFollowingTail = shouldFollowTail;
  const previousScrollTop = conversation.scrollTop;

  renderingTimeline = true;
  messages.replaceChildren();
  if (!timeline.length) {
    messageRow("assistant", "The call transcript and your private conversation will appear here together.", {
      speaker: currentAgentName,
      visibility: "private",
    });
    renderingTimeline = false;
    return;
  }
  for (const entry of timeline) {
    const row = messageRow(entry.role, entry.text, entry);
    if (entry.visibility === "private" && entry.role === "assistant") {
      addAssistantActions(row, entry.text);
    }
  }
  renderingTimeline = false;
  requestAnimationFrame(() => {
    if (wasFollowingTail) {
      shouldFollowTail = true;
      scrollToTail({ force: true });
      scrollTail.hidden = true;
    } else {
      conversation.scrollTop = previousScrollTop;
      scrollTail.hidden = false;
    }
  });
}

function addAssistantActions(row, text) {
  const actions = document.createElement("div");
  actions.className = "message-meta";
  const share = document.createElement("button");
  share.className = "message-action";
  share.type = "button";
  share.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5h8m-8 4h5m-8 7v-3a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2h-4l-4 3v-3H7a2 2 0 0 1-2-2Z" /></svg><span>Share with room</span>';
  share.addEventListener("click", () => {
    shareText.value = text.slice(0, 2000);
    updateShareCount();
    shareDialog.showModal();
    shareText.focus();
  });
  const copy = document.createElement("button");
  copy.className = "message-action";
  copy.type = "button";
  copy.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V5H5v11h3" /></svg><span>Copy</span>';
  copy.addEventListener("click", async () => {
    await navigator.clipboard.writeText(text);
    showToast("Copied private answer");
  });
  actions.append(share, copy);
  row.querySelector("article").append(actions);
  if (!renderingTimeline) requestAnimationFrame(() => scrollToTail());
}

async function loadPrivateHistory() {
  try {
    const result = await api("/api/private/messages");
    if (!result.messages?.length) return;
    messages.replaceChildren();
    for (const entry of result.messages) {
      const row = messageRow(entry.role === "user" ? "user" : "assistant", entry.text);
      if (entry.role === "assistant") addAssistantActions(row, entry.text);
    }
    scrollToTail({ force: true });
  } catch (error) {
    showToast("Private history could not be restored");
  }
}

async function refreshState() {
  try {
    const [state, privateHistory] = await Promise.all([
      api("/api/state"),
      api("/api/private/messages"),
    ]);
    currentAgentName = state.agentName;
    document.querySelector("#agent-name").textContent = state.agentName;
    document.querySelector("#avatar-initial").textContent = state.agentName.slice(0, 1).toUpperCase();
    document.querySelector("#share-agent-name").textContent = state.agentName;
    document.querySelector("#write-status").textContent = state.allowWrites ? "Prototype writes allowed" : "Codex is read-only";
    const status = document.querySelector("#meeting-status");
    const dot = document.querySelector(".presence-dot");
    status.textContent = state.meetingStatus === "joined"
      ? `${state.mode} · ${state.runtime === "local" ? "Local voice" : state.runtime ?? "Voice"} · In meeting`
      : "Connecting to meeting";
    dot.dataset.state = state.meetingStatus === "joined" ? "online" : "offline";
    agendaPanel.hidden = false;
    if (document.activeElement !== agendaText) agendaText.value = state.agenda ?? "";
    if (!state.codexConnected) {
      errorBox.textContent = "Connect a Codex task to use the private sidecar.";
      errorBox.hidden = false;
    }
    if (!privateTurnPending) renderTimeline(state.transcript, privateHistory.messages);
  } catch (error) {
    document.querySelector("#meeting-status").textContent = "Sidecar disconnected";
    document.querySelector(".presence-dot").dataset.state = "offline";
  }
}

composer.addEventListener("submit", async (event) => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || send.getAttribute("aria-busy") === "true") return;
  errorBox.hidden = true;
  privateTurnPending = true;
  messageRow("user", message, { speaker: "You", visibility: "private" });
  input.value = "";
  input.style.height = "auto";
  const pending = messageRow("assistant", "", { pending: true });
  pending.querySelector(".tool-trace__stop").addEventListener("click", async () => {
    try {
      await api("/api/private/stop", { method: "POST", body: "{}" });
      showToast("Stopping the private Codex turn");
    } catch (error) {
      showToast(error.message);
    }
  });
  send.setAttribute("aria-busy", "true");
  send.querySelector("span").textContent = "Working";
  try {
    const result = await api("/api/private/messages", {
      method: "POST",
      body: JSON.stringify({ message, desired_action: desiredAction }),
    });
    pending.remove();
    const row = messageRow("assistant", result.message);
    addAssistantActions(row, result.message);
  } catch (error) {
    pending.remove();
    errorBox.textContent = `${error.message}. Your message is still visible above; retry when ready.`;
    errorBox.hidden = false;
    input.value = message;
    input.focus();
  } finally {
    privateTurnPending = false;
    send.removeAttribute("aria-busy");
    send.querySelector("span").textContent = "Send";
    await refreshState();
  }
});

input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 170)}px`;
});
input.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
    event.preventDefault();
    composer.requestSubmit();
  }
});

document.querySelectorAll("[data-action]").forEach((button) => {
  button.addEventListener("click", () => {
    desiredAction = button.dataset.action;
    document.querySelectorAll("[data-action]").forEach((candidate) => {
      const selected = candidate === button;
      candidate.classList.toggle("is-selected", selected);
      candidate.setAttribute("aria-pressed", String(selected));
    });
  });
});

conversation.addEventListener("scroll", () => {
  const distance = conversation.scrollHeight - conversation.scrollTop - conversation.clientHeight;
  shouldFollowTail = distance < 72;
  scrollTail.hidden = shouldFollowTail;
});
scrollTail.addEventListener("click", () => {
  shouldFollowTail = true;
  scrollToTail({ force: true });
});

function updateShareCount() {
  shareCount.textContent = `${shareText.value.length.toLocaleString()} / 2,000`;
}
shareText.addEventListener("input", updateShareCount);
document.querySelector("#close-share").addEventListener("click", () => shareDialog.close());
document.querySelector("#cancel-share").addEventListener("click", () => shareDialog.close());
shareDialog.addEventListener("click", (event) => {
  if (event.target === shareDialog) shareDialog.close();
});
shareForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const text = shareText.value.trim();
  if (!text) return;
  const submit = shareForm.querySelector(".primary-button");
  submit.setAttribute("aria-busy", "true");
  submit.textContent = "Sending…";
  try {
    await api("/api/speak", { method: "POST", body: JSON.stringify({ text }) });
    shareDialog.close();
    showToast(`Sent to ${currentAgentName}’s meeting audio`);
  } catch (error) {
    showToast(error.message);
  } finally {
    submit.removeAttribute("aria-busy");
    submit.textContent = "Speak in meeting";
  }
});

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
if (!SpeechRecognition) {
  dictate.remove();
} else {
  const recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = document.documentElement.lang || "en";
  let committed = "";
  dictate.addEventListener("click", () => {
    if (dictate.getAttribute("aria-pressed") === "true") recognition.stop();
    else {
      committed = input.value.trim();
      recognition.start();
    }
  });
  recognition.addEventListener("start", () => {
    dictate.setAttribute("aria-pressed", "true");
    dictate.querySelector("span").textContent = "Listening";
  });
  recognition.addEventListener("result", (event) => {
    let spoken = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      spoken += event.results[index][0].transcript;
    }
    input.value = [committed, spoken].filter(Boolean).join(" ");
    input.dispatchEvent(new Event("input"));
  });
  recognition.addEventListener("end", () => {
    dictate.setAttribute("aria-pressed", "false");
    dictate.querySelector("span").textContent = "Dictate";
    input.focus();
  });
  recognition.addEventListener("error", (event) => {
    errorBox.textContent = `Dictation stopped: ${event.error}. You can keep typing privately.`;
    errorBox.hidden = false;
  });
}

refreshState();
setInterval(refreshState, 1_000);
input.focus();

saveAgenda.addEventListener("click", async () => {
  const text = agendaText.value.trim();
  if (!text) {
    showToast("Paste the meeting agenda first");
    agendaText.focus();
    return;
  }
  saveAgenda.setAttribute("aria-busy", "true");
  saveAgenda.textContent = "Saving…";
  try {
    await api("/api/agenda", { method: "POST", body: JSON.stringify({ text }) });
    showToast(`Agenda updated for ${state.agentName}`);
  } catch (error) {
    showToast(error.message);
  } finally {
    saveAgenda.removeAttribute("aria-busy");
    saveAgenda.textContent = "Save agenda";
  }
});
