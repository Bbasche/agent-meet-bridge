import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { access, mkdir, rename, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const modelPath = path.join(root, "data/models/ggml-small.en.bin");
const ttsPath = path.join(root, "data/bin/meeting-tts");
const ttsSource = path.join(root, "scripts/meeting-tts.swift");
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.en.bin";
const withWhisper = process.argv.includes("--with-whisper");

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)));
  });
}

async function commandExists(command) {
  return new Promise((resolve) => {
    const child = spawn("/usr/bin/which", [command], { stdio: "ignore" });
    child.once("error", () => resolve(false));
    child.once("exit", (code) => resolve(code === 0));
  });
}

const requiredCommands = withWhisper ? ["whisper-cli", "ffmpeg", "swiftc"] : ["swiftc"];
for (const command of requiredCommands) {
  if (!(await commandExists(command))) {
    const hint = command === "whisper-cli" ? "Install it with: brew install whisper-cpp" : `Install ${command} first.`;
    throw new Error(`${command} is required. ${hint}`);
  }
}

await mkdir(path.dirname(ttsPath), { recursive: true });

if (withWhisper) {
  await mkdir(path.dirname(modelPath), { recursive: true });
  try {
    await access(modelPath);
    console.log(`✓ Whisper model: ${modelPath}`);
  } catch {
    console.log("Downloading Whisper small.en model (about 466 MB)…");
    const response = await fetch(modelUrl);
    if (!response.ok || !response.body) throw new Error(`Model download failed (${response.status})`);
    const total = Number(response.headers.get("content-length") ?? 0);
    let received = 0;
    let lastPercent = -1;
    const progress = new Transform({
      transform(chunk, encoding, callback) {
        received += chunk.length;
        const percent = total ? Math.floor((received / total) * 100) : 0;
        if (percent >= lastPercent + 5) {
          lastPercent = percent;
          process.stdout.write(`${percent}% `);
        }
        callback(null, chunk);
      },
    });
    const partial = `${modelPath}.download`;
    await pipeline(Readable.fromWeb(response.body), progress, createWriteStream(partial, { mode: 0o600 }));
    await rename(partial, modelPath);
    process.stdout.write("\n");
    console.log(`✓ Whisper model: ${modelPath}`);
  }
}

const [sourceStat, binaryStat] = await Promise.all([
  stat(ttsSource),
  stat(ttsPath).catch(() => null),
]);
if (!binaryStat || binaryStat.mtimeMs < sourceStat.mtimeMs) {
  console.log("Building local AVFoundation speech renderer…");
  await run("swiftc", [ttsSource, "-o", ttsPath]);
}
console.log(`✓ Local speech renderer: ${ttsPath}`);
console.log(`Local voice runtime is ready${withWhisper ? " with optional Whisper audio input" : " for Meet captions"}.`);
