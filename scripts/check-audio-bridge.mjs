import http from "node:http";
import { chromium } from "playwright";
import { AUDIO_BRIDGE_SCRIPT } from "../src/browser-meet-transport.mjs";

const server = http.createServer((_request, response) => {
  response.writeHead(200, { "content-type": "text/html" });
  response.end("<!doctype html><title>Audio bridge check</title>");
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();

let browser;
try {
  browser = await chromium.launch({
    channel: process.env.MEETING_AGENT_BROWSER_CHANNEL ?? "chrome",
    headless: true,
    args: ["--autoplay-policy=no-user-gesture-required"],
  });
  const context = await browser.newContext();
  await context.addInitScript({ content: AUDIO_BRIDGE_SCRIPT });
  let resolveFrame;
  let frameCount = 0;
  let peakRms = 0;
  const frame = new Promise((resolve) => { resolveFrame = resolve; });
  await context.exposeFunction("__meetingAgentAudioIn", (base64) => {
    const bytes = Buffer.from(base64, "base64");
    const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 2);
    let sum = 0;
    for (const sample of samples) sum += sample * sample;
    const rms = Math.sqrt(sum / samples.length);
    frameCount += 1;
    peakRms = Math.max(peakRms, rms);
    if (bytes.length === 9_600 && rms > 100) resolveFrame({ bytes: bytes.length, rms });
  });
  await context.exposeFunction("__meetingAgentPeerIn", () => {});
  const page = await context.newPage();
  page.on("console", (message) => console.log(`[browser] ${message.text()}`));
  page.on("pageerror", (error) => console.error(`[browser] ${error.message}`));
  await page.goto(`http://127.0.0.1:${address.port}`);
  await page.evaluate(async () => {
    const receiver = new RTCPeerConnection();
    const audio = new AudioContext({ sampleRate: 48_000 });
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    const destination = audio.createMediaStreamDestination();
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain).connect(destination);
    oscillator.start();
    await audio.resume();
    const trackEvent = new Event("track");
    Object.defineProperty(trackEvent, "track", { value: destination.stream.getAudioTracks()[0] });
    receiver.dispatchEvent(trackEvent);
    window.__audioBridgeCheck = { receiver, audio, oscillator, destination };
  });
  const result = await Promise.race([
    frame,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`No non-silent 100ms PCM frame arrived (${frameCount} frames, peak RMS ${Math.round(peakRms)})`)), 15_000)),
  ]);
  console.log(`✓ Remote WebRTC audio capture: ${result.bytes} bytes, RMS ${Math.round(result.rms)}`);
} finally {
  await browser?.close();
  await new Promise((resolve) => server.close(resolve));
}
