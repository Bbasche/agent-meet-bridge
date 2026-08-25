import path from "node:path";
import { access, mkdir, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { isDismissal, isFollowupCue, utteranceAddressesAgent } from "./policy.mjs";

function pcmRms(bytes) {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.byteLength / 2));
  if (!samples.length) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

function downsample48kTo16k(pcm) {
  const input = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const output = Buffer.allocUnsafe(Math.floor(input.length / 3) * 2);
  for (let source = 0, target = 0; source + 2 < input.length; source += 3, target += 2) {
    const sample = Math.round((input[source] + input[source + 1] + input[source + 2]) / 3);
    output.writeInt16LE(sample, target);
  }
  return output;
}

function wavBuffer(pcm, { sampleRate = 16_000, channels = 1 } = {}) {
  const header = Buffer.alloc(44);
  const bytesPerSample = 2;
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * channels * bytesPerSample, 28);
  header.writeUInt16LE(channels * bytesPerSample, 32);
  header.writeUInt16LE(bytesPerSample * 8, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function cleanWhisperText(text) {
  return String(text ?? "")
    .replace(/^\s*\[[^\]]*(?:blank|music|silence|noise)[^\]]*\]\s*$/gim, "")
    .replace(/^\s*\([^)]*(?:music|silence|noise)[^)]*\)\s*$/gim, "")
    .replace(/\s+/g, " ")
    .trim();
}

function isSilentReply(text) {
  const clean = String(text ?? "").replace(/^[\s[(]+|[\s.)\]]+$/g, "").trim();
  return (
    /^(?:silence|no response|no reply)$/i.test(clean) ||
    /\b(?:remain(?:s|ing)?|stay(?:s|ing)?|keep(?:s|ing)?|will stay|i(?:'ll| will) stay)\s+(?:completely\s+)?(?:silent|quiet)\b/i.test(clean) ||
    /\b(?:does not|doesn't|will not|won't) respond\b/i.test(clean)
  );
}

const CAPTION_DEDUPE_WINDOW_MS = 8_000;

function captionDedupeTokens(text, { wakeName = "" } = {}) {
  const normalized = String(text ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[’]/g, "'")
    .replace(/\bwon't\b/g, "will not")
    .replace(/\b(?:can't|cant|cannot)\b/g, "can not")
    .replace(/\b(?:don't|dont)\b/g, "do not")
    .replace(/\b(?:doesn't|doesnt)\b/g, "does not")
    .replace(/\b(?:didn't|didnt)\b/g, "did not")
    .replace(/\b(?:isn't|isnt)\b/g, "is not")
    .replace(/\b(?:aren't|arent)\b/g, "are not")
    .replace(/\b(?:wasn't|wasnt)\b/g, "was not")
    .replace(/\b(?:weren't|werent)\b/g, "were not")
    .replace(/\b(?:couldn't|couldnt)\b/g, "could not")
    .replace(/\b(?:wouldn't|wouldnt)\b/g, "would not")
    .replace(/\b(?:shouldn't|shouldnt)\b/g, "should not")
    .replace(/\b(?:haven't|havent)\b/g, "have not")
    .replace(/\b(?:hasn't|hasnt)\b/g, "has not")
    .replace(/\b(?:hadn't|hadnt)\b/g, "had not")
    .replace(/\b(?:mustn't|mustnt)\b/g, "must not")
    .replace(/\bain't\b/g, "not")
    .replace(/[']/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const wakeTokens = String(wakeName ?? "")
    .normalize("NFKD")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  while (["okay", "ok", "hey", "well"].includes(normalized[0])) normalized.shift();
  if (
    wakeTokens.length &&
    wakeTokens.every((token, index) => normalized[index] === token)
  ) {
    normalized.splice(0, wakeTokens.length);
  }
  return normalized;
}

function textHasCapitalizedToken(text, expectedToken) {
  const words = String(text ?? "").match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.some((word) => (
    word.toLocaleLowerCase() === expectedToken &&
    word[0] === word[0].toLocaleUpperCase() &&
    word[0] !== word[0].toLocaleLowerCase()
  ));
}

/**
 * Detect two near-identical finalized caption hypotheses without treating a
 * natural follow-up as a duplicate. Meet can finalize the same speech through
 * multiple caption nodes with small ASR corrections (for example
 * "Billy" -> "Willie") or a leading discourse word added/removed.
 */
function captionsAreSemanticDuplicates(leftText, rightText, { wakeName = "" } = {}) {
  const left = captionDedupeTokens(leftText, { wakeName });
  const right = captionDedupeTokens(rightText, { wakeName });
  if (!left.length || !right.length) return false;

  const leftFolded = left.join(" ");
  const rightFolded = right.join(" ");
  if (leftFolded === rightFolded) return true;

  // A similarity score must never erase a meaning reversal. For non-identical
  // hypotheses containing negation, prefer a duplicate response over silently
  // collapsing "can" into "cannot" (or moving a negation between clauses).
  const negations = new Set(["not", "no", "never", "without", "unable", "neither", "nor"]);
  if (left.some((token) => negations.has(token)) || right.some((token) => negations.has(token))) {
    return false;
  }

  // Outside exact wake/filler normalization, allow only one bounded
  // proper-name correction. A broad token-overlap score can erase a single
  // content-word reversal (approve/reject, enable/disable), which is unsafe at
  // the response boundary. Meet's observed duplicate changed only the
  // capitalized addressee name (Billy -> Willie).
  if (left.length !== right.length || left.length < 5) return false;
  const changed = [];
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) changed.push(index);
  }
  if (changed.length !== 1) return false;
  const index = changed[0];
  const leftToken = left[index];
  const rightToken = right[index];
  const correctionContexts = new Set(["tell", "ask", "call", "called", "name", "named", "contact", "invite"]);
  if (
    index === 0 ||
    !correctionContexts.has(left[index - 1]) ||
    left[index - 1] !== right[index - 1] ||
    !textHasCapitalizedToken(leftText, leftToken) ||
    !textHasCapitalizedToken(rightText, rightToken)
  ) return false;
  const phoneticName = (token) => token.replace(/(?:ie|y)$/u, "i");
  const leftName = phoneticName(leftToken);
  const rightName = phoneticName(rightToken);
  return Math.min(leftName.length, rightName.length) >= 4 &&
    leftName.slice(1) === rightName.slice(1);
}

function commandExists(command) {
  const finder = process.platform === "win32" ? "where" : "which";
  return spawnSync(finder, [command], { stdio: "ignore" }).status === 0;
}

export class LocalCodexVoiceRuntime {
  constructor({
    agentName = "Agent",
    mode = "passive",
    modelPath,
    utteranceDir,
    whisperCommand = "whisper-cli",
    ttsCommand,
    ttsVoice = "en-GB",
    ttsRate = 0.54,
    transcriptSource = "meet-captions",
    energyThreshold = 420,
    silenceFrames = 7,
    minSpeechFrames = 3,
    maxSpeechFrames = 300,
    followupWindowMs = 15_000,
    whisperPrompt,
    onUserTurn,
    onAudio,
    onBargeIn,
    onTranscript,
    onStatus,
    logger = console,
  }) {
    this.agentName = agentName;
    this.mode = mode;
    this.modelPath = path.resolve(modelPath);
    this.utteranceDir = path.resolve(utteranceDir);
    this.whisperCommand = whisperCommand;
    this.ttsCommand = path.resolve(ttsCommand);
    this.ttsVoice = ttsVoice;
    this.ttsRate = ttsRate;
    this.transcriptSource = transcriptSource;
    this.energyThreshold = energyThreshold;
    this.silenceFramesRequired = silenceFrames;
    this.minSpeechFrames = minSpeechFrames;
    this.maxSpeechFrames = maxSpeechFrames;
    this.followupWindowMs = followupWindowMs;
    this.whisperPrompt = whisperPrompt ?? `${agentName}, meeting, agenda, technology, engineering, API, Codex.`;
    this.onUserTurn = onUserTurn;
    this.onAudio = onAudio;
    this.onBargeIn = onBargeIn;
    this.onTranscript = onTranscript;
    this.onStatus = onStatus;
    this.logger = logger;
    this.connected = false;
    this.closing = false;
    this.preRoll = [];
    this.speechFrames = [];
    this.trailingSilenceFrames = 0;
    this.followupUntil = 0;
    this.followupSpeaker = null;
    this.queue = Promise.resolve();
    this.responseQueue = Promise.resolve();
    this.sequence = 0;
    this.generation = 0;
    this.lastLoudAt = 0;
    this.audioFrameCount = 0;
    this.audioPeakRms = 0;
    this.recentCaptions = [];
    this.children = new Set();
  }

  async connect() {
    if (this.transcriptSource === "local-whisper") {
      if (!commandExists(this.whisperCommand)) {
        throw new Error(`${this.whisperCommand} is unavailable; run npm run setup:local -- --with-whisper`);
      }
      if (!commandExists("ffmpeg")) {
        throw new Error("ffmpeg is unavailable; install it before using local-whisper input");
      }
      await access(this.modelPath);
    }
    await access(this.ttsCommand);
    await mkdir(this.utteranceDir, { recursive: true });
    this.connected = true;
    this.closing = false;
    await this.onStatus?.({ state: "connected", provider: "local-codex" });
  }

  appendAudio(pcmBytes) {
    if (this.transcriptSource !== "local-whisper") return false;
    if (!this.connected || this.closing || !pcmBytes?.length) return false;
    const frame = Buffer.from(pcmBytes);
    const rms = pcmRms(frame);
    this.audioFrameCount += 1;
    this.audioPeakRms = Math.max(this.audioPeakRms, rms);
    if (process.env.MEETING_AGENT_AUDIO_DEBUG === "1" && this.audioFrameCount % 50 === 0) {
      this.logger.info?.(
        `[local voice] input peak RMS ${Math.round(this.audioPeakRms)} (threshold ${this.energyThreshold})`,
      );
      this.audioPeakRms = 0;
    }
    const loud = rms >= this.energyThreshold;
    if (loud) this.lastLoudAt = Date.now();
    if (!this.speechFrames.length) {
      this.preRoll.push(frame);
      if (this.preRoll.length > 3) this.preRoll.shift();
      if (!loud) return true;
      this.speechFrames = this.preRoll.splice(0);
      this.trailingSilenceFrames = 0;
      this.generation += 1;
      this.onBargeIn?.();
      return true;
    }

    this.speechFrames.push(frame);
    this.trailingSilenceFrames = loud ? 0 : this.trailingSilenceFrames + 1;
    if (
      this.trailingSilenceFrames >= this.silenceFramesRequired ||
      this.speechFrames.length >= this.maxSpeechFrames
    ) {
      const frames = this.speechFrames.splice(0);
      this.trailingSilenceFrames = 0;
      this.queue = this.queue
        .then(() => this.#processUtterance(frames))
        .catch((error) => this.logger.error?.(`[local voice] ${error.message}`));
    }
    return true;
  }

  appendCaption(caption) {
    if (!this.connected || this.closing) return false;
    const text = typeof caption === "object" && caption ? caption.text : caption;
    const speaker = typeof caption === "object" && caption
      ? String(caption.speaker ?? "Meeting").replace(/\s+/g, " ").trim().slice(0, 80) || "Meeting"
      : "Meeting";
    const clean = String(text ?? "").replace(/\s+/g, " ").trim();
    if (!clean) return false;
    const now = Date.now();
    const speakerKey = speaker.toLocaleLowerCase();
    this.recentCaptions = this.recentCaptions.filter(
      (recent) => now - recent.at < CAPTION_DEDUPE_WINDOW_MS,
    );
    if (this.recentCaptions.some(
      (recent) => recent.speakerKey === speakerKey && captionsAreSemanticDuplicates(
        recent.text,
        clean,
        { wakeName: this.agentName },
      ),
    )) {
      return true;
    }
    this.recentCaptions.push({ speakerKey, text: clean, at: now });
    this.queue = this.queue
      .then(() => this.#handleTranscript(clean, { speaker }))
      .catch((error) => this.logger.error?.(`[local voice] caption failed: ${error.message}`));
    return true;
  }

  announce(text) {
    return this.speak(text);
  }

  async speak(text) {
    if (!this.connected) throw new Error("Local voice runtime is not connected");
    const clean = String(text ?? "").trim().slice(0, 2_000);
    if (!clean) return;
    const generation = ++this.generation;
    const basename = path.join(this.utteranceDir, `${String(++this.sequence).padStart(4, "0")}-agent`);
    const audioPath = `${basename}.caf`;
    await this.#run(this.ttsCommand, [
      "--output", audioPath,
      "--voice", this.ttsVoice,
      "--rate", String(this.ttsRate),
      clean,
    ]);
    const pcm = await this.#run("ffmpeg", [
      "-v", "error", "-i", audioPath, "-f", "s16le", "-acodec", "pcm_s16le", "-ac", "1", "-ar", "24000", "pipe:1",
    ], { binary: true, maxBytes: 20 * 1024 * 1024 });
    if (!this.closing && generation === this.generation) {
      await this.onAudio?.(pcm, { sampleRate: 24_000, numChannels: 1 });
    }
  }

  async close() {
    this.closing = true;
    this.connected = false;
    this.generation += 1;
    for (const child of this.children) child.kill("SIGTERM");
    this.children.clear();
    await this.onStatus?.({ state: "closed", provider: "local-codex" });
  }

  async #processUtterance(frames) {
    if (this.closing || frames.length < this.minSpeechFrames) return;
    const basename = path.join(this.utteranceDir, `${String(++this.sequence).padStart(4, "0")}-meeting`);
    const wavPath = `${basename}.wav`;
    const pcm16k = downsample48kTo16k(Buffer.concat(frames));
    await writeFile(wavPath, wavBuffer(pcm16k), { mode: 0o600 });
    const output = await this.#run(this.whisperCommand, [
      "-m", this.modelPath,
      "-l", "en",
      "-nt",
      "-np",
      "--prompt", this.whisperPrompt,
      wavPath,
    ]);
    const text = cleanWhisperText(output.toString("utf8"));
    await this.#handleTranscript(text);
  }

  async #handleTranscript(text, { speaker = "Meeting" } = {}) {
    if (!text || this.closing) return;
    await this.onTranscript?.({ speaker, text, kind: "speech", role: "user" });

    const dismissed = isDismissal(text);
    const addressed = utteranceAddressesAgent(text, this.agentName) && !dismissed;
    if (addressed) {
      this.followupUntil = Date.now() + this.followupWindowMs;
      this.followupSpeaker = speaker;
    } else if (speaker !== "Meeting" && this.followupSpeaker && speaker !== this.followupSpeaker) {
      this.followupUntil = 0;
      this.followupSpeaker = null;
    }
    const sameSpeaker = speaker === "Meeting" || speaker === this.followupSpeaker;
    const inFollowup = !dismissed && sameSpeaker && isFollowupCue(text) && Date.now() < this.followupUntil;
    if (this.mode === "passive" && !addressed && !inFollowup) return;
    if (!this.onUserTurn) return;
    this.responseQueue = this.responseQueue
      .then(() => this.#respond({ text, addressed, inFollowup }))
      .catch((error) => this.logger.error?.(`[local voice] response failed: ${error.message}`));
  }

  async #respond({ text, addressed, inFollowup }) {
    if (this.closing) return;
    const result = await this.onUserTurn({ text, addressed, inFollowup, mode: this.mode });
    const reply = String(result?.text ?? result ?? "").trim();
    if (!reply || isSilentReply(reply)) return;
    if (!(await this.#waitForQuiet())) {
      this.logger.warn?.("[local voice] skipped a stale answer because the meeting did not yield the floor");
      return;
    }
    await this.onTranscript?.({ speaker: this.agentName, text: reply, kind: "assistant", role: "assistant" });
    await this.speak(reply);
  }

  async #waitForQuiet({ quietMs = 500, maxWaitMs = 15_000 } = {}) {
    const deadline = Date.now() + maxWaitMs;
    while (!this.closing && (this.speechFrames.length || Date.now() - this.lastLoudAt < quietMs)) {
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return !this.closing;
  }

  #run(command, args, { binary = false, maxBytes = 2 * 1024 * 1024 } = {}) {
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
      this.children.add(child);
      const stdout = [];
      const stderr = [];
      let size = 0;
      child.stdout.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) child.kill("SIGTERM");
        else stdout.push(chunk);
      });
      child.stderr.on("data", (chunk) => stderr.push(chunk));
      child.once("error", reject);
      child.once("close", (code, signal) => {
        this.children.delete(child);
        if (size > maxBytes) {
          reject(new Error(`${command} output exceeded ${maxBytes} bytes`));
        } else if (code === 0) {
          const output = Buffer.concat(stdout);
          resolve(binary ? output : output);
        } else if (this.closing && signal) {
          resolve(Buffer.alloc(0));
        } else {
          reject(new Error(`${command} failed (${code ?? signal}): ${Buffer.concat(stderr).toString("utf8").trim()}`));
        }
      });
    });
  }
}

export {
  captionsAreSemanticDuplicates,
  cleanWhisperText,
  downsample48kTo16k,
  isSilentReply,
  pcmRms,
  wavBuffer,
};
