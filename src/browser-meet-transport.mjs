import path from "node:path";
import { chromium } from "playwright";

const AUDIO_SAMPLE_RATE = 48_000;
const MEET_BROWSER_ARGS = Object.freeze([
  "--use-fake-ui-for-media-stream",
  "--autoplay-policy=no-user-gesture-required",
  "--disable-blink-features=AutomationControlled",
  "--disable-session-crashed-bubble",
  "--hide-crash-restore-bubble",
]);

// This script runs before Google Meet's application code. It gives Meet a Web
// Audio-backed microphone and taps remote WebRTC audio into 100 ms PCM frames.
const AUDIO_BRIDGE_SCRIPT = String.raw`
(() => {
  if (window.__meetingAgentBridgeInstalled) return;
  window.__meetingAgentBridgeInstalled = true;

  const SAMPLE_RATE = 48000;
  const FRAME_SAMPLES = 4800;
  const nativeGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  let context;
  let fakeMicrophone;
  let playbackGain;
  let playbackCursor = 0;
  let captureBus;
  let captureProcessor;
  let captureSink;
  let captureFrame = new Int16Array(FRAME_SAMPLES);
  let captureOffset = 0;
  const playbackSources = new Set();
  const attachedTrackIds = new Set();
  const remoteSources = new Map();

  function silenceMediaElement(element) {
    if (!(element instanceof HTMLMediaElement)) return;
    if (!element.muted) element.muted = true;
    if (element.volume !== 0) element.volume = 0;
  }

  function silenceMediaTree(root) {
    if (root instanceof HTMLMediaElement) silenceMediaElement(root);
    root?.querySelectorAll?.("audio,video").forEach(silenceMediaElement);
  }

  const playbackSilencer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      if (mutation.target instanceof HTMLMediaElement) silenceMediaElement(mutation.target);
      mutation.addedNodes.forEach((node) => silenceMediaTree(node));
    }
  });
  const startPlaybackSilencer = () => {
    silenceMediaTree(document);
    if (document.documentElement) {
      playbackSilencer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["muted", "volume"],
      });
    }
  };
  document.addEventListener("play", (event) => silenceMediaElement(event.target), true);
  document.addEventListener("volumechange", (event) => silenceMediaElement(event.target), true);
  if (document.documentElement) startPlaybackSilencer();
  else document.addEventListener("DOMContentLoaded", startPlaybackSilencer, { once: true });
  window.__meetingAgentSilencesLocalPlayback = true;

  function bytesToBase64(bytes) {
    let binary = "";
    for (let offset = 0; offset < bytes.length; offset += 8192) {
      binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
    }
    return btoa(binary);
  }

  async function ensureAudioGraph() {
    if (context) {
      if (context.state === "suspended") await context.resume().catch(() => {});
      return;
    }
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    if (context.state === "suspended") await context.resume().catch(() => {});
    fakeMicrophone = context.createMediaStreamDestination();
    playbackGain = context.createGain();
    playbackGain.connect(fakeMicrophone);
    playbackCursor = context.currentTime;
    window.__meetingAgentSampleRate = context.sampleRate;
    console.info("[meeting-agent] audio graph ready at " + context.sampleRate + " Hz");
  }

  async function attachRemoteTrack(track) {
    if (!track || track.kind !== "audio" || attachedTrackIds.has(track.id)) return;
    await ensureAudioGraph();
    if (!captureBus) {
      captureBus = context.createGain();
      captureBus.gain.value = 1;
      captureSink = context.createGain();
      captureSink.gain.value = 0;
      captureSink.connect(context.destination);
      try {
        const workletSource = 'class MeetingAgentPcmProcessor extends AudioWorkletProcessor {' +
          'constructor(){super();this.frame=new Int16Array(4800);this.offset=0;}' +
          'process(inputs){const samples=inputs[0]&&inputs[0][0];if(!samples)return true;' +
          'for(let i=0;i<samples.length;i++){const value=Math.max(-1,Math.min(1,samples[i]));' +
          'this.frame[this.offset++]=value<0?Math.round(value*32768):Math.round(value*32767);' +
          'if(this.offset===4800){this.port.postMessage(this.frame.buffer,[this.frame.buffer]);' +
          'this.frame=new Int16Array(4800);this.offset=0;}}return true;}}' +
          'registerProcessor("meeting-agent-pcm",MeetingAgentPcmProcessor);';
        const moduleUrl = URL.createObjectURL(new Blob([workletSource], { type: "text/javascript" }));
        await context.audioWorklet.addModule(moduleUrl);
        URL.revokeObjectURL(moduleUrl);
        captureProcessor = new AudioWorkletNode(context, "meeting-agent-pcm", {
          numberOfInputs: 1,
          numberOfOutputs: 1,
          outputChannelCount: [1],
        });
        captureProcessor.port.onmessage = (event) => {
          window.__meetingAgentAudioIn?.(bytesToBase64(new Uint8Array(event.data)));
        };
      } catch (error) {
        console.warn("[meeting-agent] AudioWorklet unavailable; using ScriptProcessor: " + error.message);
        captureProcessor = context.createScriptProcessor(2048, 1, 1);
        captureProcessor.onaudioprocess = (event) => {
          const samples = event.inputBuffer.getChannelData(0);
          for (let index = 0; index < samples.length; index += 1) {
            const clamped = Math.max(-1, Math.min(1, samples[index]));
            captureFrame[captureOffset++] = clamped < 0
              ? Math.round(clamped * 32768)
              : Math.round(clamped * 32767);
            if (captureOffset !== FRAME_SAMPLES) continue;
            const bytes = new Uint8Array(captureFrame.buffer.slice(0));
            window.__meetingAgentAudioIn?.(bytesToBase64(bytes));
            captureFrame = new Int16Array(FRAME_SAMPLES);
            captureOffset = 0;
          }
        };
      }
      captureBus.connect(captureProcessor);
      captureProcessor.connect(captureSink);
    }
    const source = context.createMediaStreamSource(new MediaStream([track]));
    source.connect(captureBus);
    remoteSources.set(track.id, source);
    attachedTrackIds.add(track.id);
    window.__meetingAgentPeerIn?.();
    track.addEventListener("ended", () => {
      remoteSources.get(track.id)?.disconnect();
      remoteSources.delete(track.id);
      attachedTrackIds.delete(track.id);
    }, { once: true });
    console.info("[meeting-agent] attached remote audio track to PCM capture");
  }

  const NativePeerConnection = window.RTCPeerConnection;
  if (NativePeerConnection) {
    window.RTCPeerConnection = new Proxy(NativePeerConnection, {
      construct(Target, args, NewTarget) {
        const connection = Reflect.construct(Target, args, NewTarget);
        connection.addEventListener("track", (event) => attachRemoteTrack(event.track));
        return connection;
      },
    });
  }

  navigator.mediaDevices.getUserMedia = async (constraints = {}) => {
    if (!constraints.audio) {
      // Meet may probe video independently before the pre-join camera control
      // settles. Return an empty stream instead of ever touching a camera.
      if (constraints.video) return new MediaStream();
      return nativeGetUserMedia(constraints);
    }
    await ensureAudioGraph();
    const outgoing = new MediaStream();
    // The meeting agent is intentionally audio-only. Never acquire or expose
    // a physical camera track, even if Meet requests one during pre-join.
    fakeMicrophone.stream.getAudioTracks().forEach((track) => outgoing.addTrack(track));
    return outgoing;
  };

  window.__meetingAgentStartCapture = async () => {
    await ensureAudioGraph();
  };

  window.__meetingAgentStartCaptions = () => {
    let lastSent = "";
    let lastCandidate = null;
    let wakeBuffer = null;
    let lastHumanSpeaker = "Meeting";
    let timer;
    const ignoredCaptionText = /^(?:(?:\d{1,2}:\d{2})(?:\s*[AP]M)?|Captions?|Meeting details|Share screen|Leave call|Turn (?:on|off)|More options|Chat with everyone|Meeting tools|Host controls|People|External participants joined|Jump to bottom|arrow_downward)$/i;
    const normalize = (value) => value?.replace(/\s+/g, " ").trim() ?? "";
    const mergeIncremental = (whole, previousFragment, nextFragment) => {
      if (!whole || !previousFragment) return nextFragment;
      if (nextFragment.startsWith(previousFragment)) {
        return whole.slice(0, Math.max(0, whole.length - previousFragment.length)) + nextFragment;
      }
      if (previousFragment.startsWith(nextFragment) || whole.endsWith(nextFragment)) return whole;
      let overlap = Math.min(whole.length, nextFragment.length);
      while (overlap > 0 && whole.slice(-overlap) !== nextFragment.slice(0, overlap)) overlap -= 1;
      return normalize(whole + " " + nextFragment.slice(overlap));
    };
    const emitCandidate = (candidate) => {
      if (!candidate || candidate.key === lastSent) return;
      lastSent = candidate.key;
      window.__meetingAgentCaptionIn?.({ speaker: candidate.speaker, text: candidate.text });
    };
    const inferSpeaker = (node, text) => {
      let element = node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      for (let depth = 0; element && depth < 6; depth += 1, element = element.parentElement) {
        const lines = String(element.innerText ?? "")
          .split(/\n+/)
          .map(normalize)
          .filter(Boolean);
        const textIndex = lines.findIndex((line) => line === text || line.endsWith(text));
        if (textIndex > 0) {
          const speaker = lines[textIndex - 1];
          if (speaker.length <= 80 && !ignoredCaptionText.test(speaker)) return speaker;
        }
      }
      return "Meeting";
    };
    const queueText = (rawText, node) => {
      const text = rawText?.replace(/\s+/g, " ").trim();
      const speaker = inferSpeaker(node, text);
      const agentName = normalize(window.__meetingAgentDisplayName);
      const normalizedSpeaker = normalize(speaker);
      const escapedAgentName = agentName.replace(/[\\^$.*+?()[\\]{}|]/g, "\\$&");
      const addressesAgent = Boolean(agentName && new RegExp("(^|[^A-Za-z0-9])" + escapedAgentName + "([^A-Za-z0-9]|$)", "i").test(text));
      const isAgentCaption =
        /^you$/i.test(normalizedSpeaker) ||
        (agentName && new RegExp("^" + escapedAgentName + "(?:\\s+Bot)?$", "i").test(normalizedSpeaker));
      if (
        !text ||
        text.length > 400 ||
        isAgentCaption ||
        ignoredCaptionText.test(text) ||
        /more_vert|visual_effects|frame_person|devices/i.test(text)
      ) return;
      if (speaker !== "Meeting") lastHumanSpeaker = speaker;
      const effectiveSpeaker = speaker === "Meeting" ? lastHumanSpeaker : speaker;
      if (wakeBuffer && effectiveSpeaker !== wakeBuffer.speaker) {
        clearTimeout(timer);
        emitCandidate(lastCandidate);
        wakeBuffer = null;
      }
      if (addressesAgent) {
        if (!wakeBuffer || effectiveSpeaker !== wakeBuffer.speaker) {
          wakeBuffer = { speaker: effectiveSpeaker, text, lastFragment: text };
        } else {
          wakeBuffer.text = mergeIncremental(wakeBuffer.text, wakeBuffer.lastFragment, text);
          wakeBuffer.lastFragment = text;
        }
      } else if (wakeBuffer && effectiveSpeaker === wakeBuffer.speaker) {
        wakeBuffer.text = mergeIncremental(wakeBuffer.text, wakeBuffer.lastFragment, text);
        wakeBuffer.lastFragment = text;
      }
      const candidateSpeaker = wakeBuffer?.speaker ?? effectiveSpeaker;
      const candidateText = wakeBuffer?.text ?? text;
      const key = candidateSpeaker + "\u0000" + candidateText;
      if (key === lastSent) return;
      if (key !== (lastCandidate?.key ?? "")) {
        lastCandidate = { key, speaker: candidateSpeaker, text: candidateText };
        console.info("[meeting-agent] caption candidate: " + candidateSpeaker + ": " + candidateText.slice(-240));
      }
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (
          !lastCandidate ||
          lastCandidate.key === lastSent
        ) return;
        emitCandidate(lastCandidate);
        wakeBuffer = null;
      }, 700);
    };
    window.__meetingAgentCaptionObserver?.disconnect();
    window.__meetingAgentCaptionObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        const candidates = [];
        if (mutation.type === "characterData") candidates.push(mutation.target);
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.TEXT_NODE) candidates.push(node);
          else if (node.nodeType === Node.ELEMENT_NODE && node.childElementCount === 0) {
            candidates.push(node);
          }
        }
        for (const node of candidates) {
          const rawText = node.nodeType === Node.TEXT_NODE ? node.nodeValue : node.textContent;
          const text = rawText?.replace(/\s+/g, " ").trim();
          if (text && text.length <= 400) queueText(text, node);
        }
      }
    });
    window.__meetingAgentCaptionObserver.observe(document.body, {
      childList: true,
      subtree: true,
      characterData: true,
    });
  };

  window.__meetingAgentPlayPcm = async (base64Pcm, sampleRate = SAMPLE_RATE) => {
    await ensureAudioGraph();
    const binary = atob(base64Pcm);
    const samples = new Float32Array(binary.length / 2);
    for (let index = 0; index < samples.length; index += 1) {
      let value = binary.charCodeAt(index * 2) | (binary.charCodeAt(index * 2 + 1) << 8);
      if (value >= 0x8000) value -= 0x10000;
      samples[index] = value / 32768;
    }
    const buffer = context.createBuffer(1, samples.length, sampleRate);
    buffer.copyToChannel(samples, 0);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(playbackGain);
    const startsAt = Math.max(context.currentTime + 0.015, playbackCursor);
    playbackCursor = startsAt + buffer.duration;
    playbackSources.add(source);
    source.addEventListener("ended", () => playbackSources.delete(source), { once: true });
    source.start(startsAt);
  };

  window.__meetingAgentClearPlayback = () => {
    for (const source of playbackSources) {
      try { source.stop(); } catch {}
    }
    playbackSources.clear();
    if (context) playbackCursor = context.currentTime;
  };
})();
`;

async function matchingControl(page, name, { requireVisible = true } = {}) {
  const candidates = [
    page.getByRole("button", { name, exact: false }),
    page.getByText(name, { exact: true }),
  ];
  for (const matches of candidates) {
    const count = await matches.count();
    for (let index = 0; index < count; index += 1) {
      const candidate = matches.nth(index);
      if (!requireVisible || (await candidate.isVisible().catch(() => false))) return candidate;
    }
  }
  return null;
}

async function clickButton(page, names, { timeoutMs = 2_000 } = {}) {
  for (const name of names) {
    try {
      const control = await matchingControl(page, name);
      if (control) {
        await control.click({ timeout: timeoutMs });
        return true;
      }
    } catch {
      // Meet changes labels frequently; try the next accessible label.
    }
  }
  return false;
}

async function waitForButton(page, names, timeoutMs, { requireVisible = true } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const name of names) {
      const control = await matchingControl(page, name, { requireVisible });
      if (control) return control;
    }
    await page.waitForTimeout(500);
  }
  return null;
}

async function clickDomControl(page, names) {
  return page.evaluate((labels) => {
    const controls = [...document.querySelectorAll('button, [role="button"]')];
    const control = controls.find((element) => {
      const text = [
        element.getAttribute("aria-label"),
        element.getAttribute("data-tooltip"),
        element.textContent,
      ]
        .filter(Boolean)
        .join(" ")
        .replace(/\s+/g, " ")
        .trim();
      return labels.some((label) => text.includes(label));
    });
    if (!control) return false;
    control.click();
    return true;
  }, names);
}

async function waitAndClickDomControl(page, names, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await clickDomControl(page, names)) return true;
    await page.waitForTimeout(500);
  }
  return false;
}

async function pageIsInCall(page) {
  const text = await page.locator("body").innerText().catch(() => "");
  return text.includes("Meeting details") && text.includes("Share screen");
}

export function meetingPopulationFromSnapshot({ bodyText = "", ariaLabels = [] } = {}) {
  const body = String(bodyText).replace(/\s+/g, " ").trim();
  const labels = ariaLabels.map((label) => String(label).replace(/\s+/g, " ").trim());
  const ended = /\b(?:you left the meeting|meeting (?:has )?ended|return to home screen)\b/i.test(body);
  const alone = /\b(?:no one else is here|you(?:'re| are) the only one here|waiting for others to join)\b/i.test(body);
  let participantCount = null;
  for (const label of labels) {
    const match = label.match(/\b(?:participants?|people|show everyone)\s*(?:[:(]\s*)?(\d+)\s*\)?/i)
      ?? label.match(/\b(\d+)\s+(?:participants?|people)\b/i);
    if (match) participantCount = Math.max(participantCount ?? 0, Number(match[1]));
  }
  return { ended, alone, participantCount };
}

export function nextMeetingPresence(
  { seenOthers = false, aloneSince = null } = {},
  { ended = false, alone = false, participantCount = null } = {},
  { now = Date.now(), timeoutMs = 5 * 60_000 } = {},
) {
  if (ended) {
    return { seenOthers, aloneSince, shouldLeave: true, reason: "meeting-ended" };
  }
  if (!alone && (participantCount ?? 0) > 1) {
    return { seenOthers: true, aloneSince: null, shouldLeave: false, reason: null };
  }
  const aloneNow = alone || (seenOthers && participantCount === 1);
  if (!seenOthers || !aloneNow) {
    return { seenOthers, aloneSince: null, shouldLeave: false, reason: null };
  }
  const startedAt = aloneSince ?? now;
  const shouldLeave = now - startedAt >= timeoutMs;
  return {
    seenOthers,
    aloneSince: startedAt,
    shouldLeave,
    reason: shouldLeave ? "last-participant-left" : null,
  };
}

export class BrowserMeetTransport {
  constructor({
    meetingUrl,
    displayName,
    profileDir,
    headless = false,
    browserChannel = "chrome",
    admissionTimeoutMs = 5 * 60_000,
    aloneTimeoutMs = 5 * 60_000,
    presenceCheckIntervalMs = 5_000,
    logger = console,
    onAudio,
    onCaption,
    onAlone,
    onStatus,
    onFatal,
    autoReconnect = true,
    maxReconnectAttempts = 8,
  }) {
    this.meetingUrl = meetingUrl;
    this.displayName = displayName;
    this.profileDir = path.resolve(profileDir);
    this.headless = headless;
    this.browserChannel = browserChannel;
    this.admissionTimeoutMs = admissionTimeoutMs;
    this.aloneTimeoutMs = aloneTimeoutMs;
    this.presenceCheckIntervalMs = presenceCheckIntervalMs;
    this.logger = logger;
    this.onAudio = onAudio;
    this.onCaption = onCaption;
    this.onAlone = onAlone;
    this.onStatus = onStatus;
    this.onFatal = onFatal;
    this.autoReconnect = autoReconnect;
    this.maxReconnectAttempts = maxReconnectAttempts;
    this.context = null;
    this.page = null;
    this.presenceTimer = null;
    this.seenOthers = false;
    this.aloneSince = null;
    this.aloneTriggered = false;
    this.intentionalClose = false;
    this.hasJoined = false;
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.reconnecting = false;
    this.presenceCheckPending = false;
  }

  async #checkPresence() {
    if (!this.page || this.page.isClosed() || this.aloneTriggered || this.presenceCheckPending) return;
    this.presenceCheckPending = true;
    try {
      const snapshot = await this.page.evaluate(() => {
        if (!document.body) return { bodyText: "", ariaLabels: [] };
        const signalPattern = /\b(?:you left the meeting|meeting (?:has )?ended|return to home screen|no one else is here|you(?:'re| are) the only one here|waiting for others to join)\b/i;
        const signals = [];
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let inspected = 0;
        while (signals.length < 20 && inspected < 20_000) {
          const node = walker.nextNode();
          if (!node) break;
          inspected += 1;
          const text = String(node.nodeValue ?? "").replace(/\s+/g, " ").trim();
          if (text.length <= 160 && signalPattern.test(text)) signals.push(text);
        }
        const ariaLabels = [];
        const labeled = document.querySelectorAll(
          '[aria-label*="participant" i], [aria-label*="people" i], [aria-label*="everyone" i]',
        );
        for (let index = 0; index < labeled.length && ariaLabels.length < 100; index += 1) {
          const label = labeled[index].getAttribute("aria-label");
          if (label && label.length <= 200) ariaLabels.push(label);
        }
        return { bodyText: signals.join(" "), ariaLabels };
      }).catch(() => null);
      if (!snapshot) return;
      const now = Date.now();
      const next = nextMeetingPresence(
        { seenOthers: this.seenOthers, aloneSince: this.aloneSince },
        meetingPopulationFromSnapshot(snapshot),
        { now, timeoutMs: this.aloneTimeoutMs },
      );
      this.seenOthers = next.seenOthers;
      this.aloneSince = next.aloneSince;
      if (!next.shouldLeave) return;
      this.aloneTriggered = true;
      await this.onAlone?.({
        reason: next.reason,
        aloneForMs: next.aloneSince === null ? 0 : now - next.aloneSince,
      });
    } finally {
      this.presenceCheckPending = false;
    }
  }

  #startPresenceMonitor() {
    if (!this.onAlone || this.aloneTimeoutMs <= 0) return;
    clearInterval(this.presenceTimer);
    this.presenceTimer = setInterval(() => {
      this.#checkPresence().catch((error) => {
        this.logger.warn?.(`[meet] presence check failed: ${error.message}`);
      });
    }, this.presenceCheckIntervalMs);
    this.presenceTimer.unref?.();
  }

  async join() {
    this.intentionalClose = false;
    await this.#joinOnce();
    this.hasJoined = true;
    this.reconnectAttempts = 0;
    await this.onStatus?.({ state: "joined" });
  }

  #scheduleReconnect(reason) {
    if (
      this.intentionalClose || !this.autoReconnect || !this.hasJoined ||
      this.reconnectTimer || this.reconnecting
    ) return;
    const attempt = ++this.reconnectAttempts;
    if (attempt > this.maxReconnectAttempts) {
      this.onStatus?.({ state: "failed", reason });
      this.onFatal?.(new Error(`Google Meet browser recovery failed after ${this.maxReconnectAttempts} attempts`));
      return;
    }
    const delay = Math.min(30_000, 1_000 * (2 ** Math.min(attempt - 1, 5)));
    this.onStatus?.({ state: "reconnecting", reason, attempt, delayMs: delay });
    this.logger.warn?.(`[meet] browser disconnected; rejoining in ${delay}ms (attempt ${attempt})`);
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      this.reconnecting = true;
      let recovered = false;
      try {
        await this.#joinOnce();
        recovered = true;
        this.reconnectAttempts = 0;
        await this.onStatus?.({ state: "joined", recovered: true });
      } catch (error) {
        this.logger.warn?.(`[meet] rejoin failed: ${error.message}`);
        await this.context?.close().catch(() => {});
        this.context = null;
        this.page = null;
      } finally {
        this.reconnecting = false;
      }
      if (!recovered) this.#scheduleReconnect("rejoin-failed");
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async #joinOnce() {
    const launchOptions = {
      headless: this.headless,
      args: [...MEET_BROWSER_ARGS],
      viewport: { width: 1280, height: 850 },
      permissions: ["microphone"],
    };
    if (this.browserChannel && this.browserChannel !== "chromium") {
      launchOptions.channel = this.browserChannel;
    }
    const launchedContext = await chromium.launchPersistentContext(this.profileDir, launchOptions);
    this.context = launchedContext;
    launchedContext.once("close", () => {
      if (this.context !== launchedContext) return;
      this.context = null;
      this.page = null;
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
      this.#scheduleReconnect("browser-closed");
    });
    await this.context.addInitScript({ content: AUDIO_BRIDGE_SCRIPT });
    await this.context.exposeFunction("__meetingAgentAudioIn", async (base64Pcm) => {
      await this.onAudio?.(Buffer.from(base64Pcm, "base64"));
    });
    await this.context.exposeFunction("__meetingAgentCaptionIn", async (caption) => {
      this.seenOthers = true;
      this.aloneSince = null;
      await this.onCaption?.(caption);
    });
    await this.context.exposeFunction("__meetingAgentPeerIn", async () => {
      this.seenOthers = true;
      this.aloneSince = null;
    });
    const restoredPages = this.context.pages();
    this.page = restoredPages[0] ?? (await this.context.newPage());
    for (const stalePage of restoredPages.slice(1)) {
      await stalePage.close().catch(() => {});
    }
    this.page.on("console", (message) => {
      if (message.text().includes("[meeting-agent]")) this.logger.debug?.(message.text());
    });
    this.page.on("pageerror", (error) => this.logger.error?.(`[meet] ${error.message}`));
    this.page.on("crash", () => {
      this.logger.warn?.("[meet] renderer crashed");
      launchedContext.close().catch(() => {});
    });

    await this.page.goto(this.meetingUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.page.evaluate((displayName) => {
      window.__meetingAgentDisplayName = displayName;
    }, this.displayName);
    for (const selector of [
      'input[aria-label="Your name"]',
      'input[placeholder="Your name"]',
      'input[type="text"]',
    ]) {
      const input = this.page.locator(selector).first();
      if ((await input.count()) && (await input.isVisible().catch(() => false))) {
        await input.fill(this.displayName);
        break;
      }
    }

    await clickDomControl(this.page, ["Continue without microphone and camera"]);
    await clickDomControl(this.page, ["Not now"]);
    await clickDomControl(this.page, ["Turn off camera"]);
    await clickDomControl(this.page, ["Turn on microphone"]);
    const leaveNames = ["Leave call", "Hang up", "End call"];
    const joinNames = [
      "Switch here",
      "Join here too",
      "Ask to join",
      "Join now",
      "Join meeting",
      "Rejoin",
    ];
    let leave = await waitForButton(this.page, leaveNames, 1_500, { requireVisible: false });
    if (!leave && (await pageIsInCall(this.page))) leave = true;
    if (!leave) {
      const join = await waitForButton(this.page, joinNames, 15_000);
      if (!join) {
        const pageText = (await this.page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 500);
        throw new Error(`Google Meet join button was not found. Page: ${pageText}`);
      }
      await join.click({ force: true });
      await this.page.waitForTimeout(5_000);
      leave = await waitForButton(this.page, leaveNames, 2_000, {
        requireVisible: false,
      });
      if (!leave && (await pageIsInCall(this.page))) leave = true;
      const stillPrejoin = !leave && (await waitForButton(this.page, joinNames, 1_000));
      if (stillPrejoin) {
        await stillPrejoin.click({ force: true });
        await this.page.waitForTimeout(5_000);
        leave = await waitForButton(this.page, leaveNames, 2_000, { requireVisible: false });
        if (!leave && (await waitForButton(this.page, joinNames, 1_000))) {
          throw new Error("Google Meet remained on the pre-join screen after two trusted Join clicks");
        }
      }
    }
    if (!leave) {
      this.logger.warn?.("Meet did not expose an in-call toolbar; continuing while admission settles.");
    }
    const cameraIsOn = await matchingControl(this.page, "Turn off camera", {
      requireVisible: false,
    });
    if (cameraIsOn) {
      await this.page.keyboard.press("Meta+e");
      await this.page.waitForTimeout(500);
    }
    const cameraStillOn = await matchingControl(this.page, "Turn off camera", {
      requireVisible: false,
    });
    if (cameraStillOn) throw new Error("Google Meet camera could not be turned off");
    await this.page.evaluate(() => window.__meetingAgentStartCapture());
    let captionsAlreadyOn = await matchingControl(this.page, "Turn off captions", {
      requireVisible: false,
    });
    if (!captionsAlreadyOn) {
      const captionsButton = await matchingControl(this.page, "Turn on captions", {
        requireVisible: false,
      });
      if (captionsButton) await captionsButton.click({ force: true });
      else await this.page.keyboard.press("c");
      await this.page.waitForTimeout(1_000);
      captionsAlreadyOn = await matchingControl(this.page, "Turn off captions", {
        requireVisible: false,
      });
    }
    if (!captionsAlreadyOn) this.logger.warn?.("Meet captions could not be confirmed as enabled.");
    await this.page.evaluate(() => window.__meetingAgentStartCaptions());
    const sampleRate = await this.page.evaluate(() => window.__meetingAgentSampleRate);
    if (sampleRate !== AUDIO_SAMPLE_RATE) {
      throw new Error(`Chromium opened audio at ${sampleRate} Hz; ${AUDIO_SAMPLE_RATE} Hz is required`);
    }
    this.#startPresenceMonitor();
  }

  async playAudio(pcmBytes, sampleRate = AUDIO_SAMPLE_RATE) {
    if (!this.page || this.page.isClosed()) return;
    await this.page.evaluate(
      ({ base64Pcm, sampleRate }) => window.__meetingAgentPlayPcm(base64Pcm, sampleRate),
      { base64Pcm: Buffer.from(pcmBytes).toString("base64"), sampleRate },
    );
  }

  async clearPlayback() {
    if (!this.page || this.page.isClosed()) return;
    await this.page.evaluate(() => window.__meetingAgentClearPlayback());
  }

  async close() {
    this.intentionalClose = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    clearInterval(this.presenceTimer);
    this.presenceTimer = null;
    try {
      await clickButton(this.page, ["Leave call", "Hang up", "End call"]);
    } finally {
      await this.context?.close();
      this.context = null;
      this.page = null;
    }
  }
}

export async function openBotProfile({ profileDir, browserChannel = "chrome" }) {
  const options = {
    headless: false,
    viewport: { width: 1180, height: 820 },
  };
  if (browserChannel && browserChannel !== "chromium") options.channel = browserChannel;
  const context = await chromium.launchPersistentContext(path.resolve(profileDir), options);
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto("https://meet.google.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });
  return context;
}

export async function inspectBotProfile({ profileDir, browserChannel = "chrome" }) {
  const options = {
    headless: true,
    viewport: { width: 1180, height: 820 },
  };
  if (browserChannel && browserChannel !== "chromium") options.channel = browserChannel;
  const context = await chromium.launchPersistentContext(path.resolve(profileDir), options);
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto("https://meet.google.com/", {
      waitUntil: "domcontentloaded",
      timeout: 60_000,
    });
    await page.waitForTimeout(1_000);
    const currentUrl = page.url();
    const bodyText = await page.locator("body").innerText().catch(() => "");
    const account = bodyText.match(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/)?.[0] ?? null;
    return {
      signedIn: !new URL(currentUrl).hostname.endsWith("accounts.google.com"),
      account,
      currentUrl,
    };
  } finally {
    await context.close();
  }
}

export { AUDIO_BRIDGE_SCRIPT, AUDIO_SAMPLE_RATE, MEET_BROWSER_ARGS };
