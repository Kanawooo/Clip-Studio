import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const args = new Map();
for (let index = 2; index < process.argv.length; index += 1) {
  const flag = process.argv[index];
  if (!flag?.startsWith("--")) continue;
  if (flag === "--verify") {
    args.set("verify", "true");
    continue;
  }
  args.set(flag.slice(2), process.argv[index + 1]);
  index += 1;
}

const cli = requiredPath(args.get("cli"), "--cli");
const model = args.get("model") || "small.en";
const verify = args.get("verify") === "true";
const expectedModelPath = path.join(
  process.env.HYPERFRAMES_WHISPER_MODELS_DIR || path.resolve(import.meta.dirname, "..", ".runtime", "whisper", "models"),
  `ggml-${model}.bin`,
);

const reused = modelReady(expectedModelPath, model);
if (reused && !verify) {
  console.log(JSON.stringify({ ok: true, model, reused: true }));
  process.exit(0);
}

const workRoot = mkdtempSync(path.join(tmpdir(), "clip-studio-whisper-prewarm-"));
const audioPath = path.join(workRoot, "silence.wav");
const outputDir = path.join(workRoot, "output");
mkdirSync(outputDir, { recursive: true });
try {
  writeSilentWav(audioPath, 1);
  const result = spawnSync(process.execPath, [
    cli,
    "transcribe",
    audioPath,
    "--dir",
    outputDir,
    "--engine",
    "whisper",
    "--model",
    model,
    "--language",
    "en",
    "--timeout",
    "300000",
    "--json",
  ], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 1_800_000,
    windowsHide: true,
  });
  if (result.error || result.status !== 0 || !modelReady(expectedModelPath, model)) {
    throw new Error(commandFailure(result, model));
  }
  console.log(JSON.stringify({
    ok: true,
    model,
    reused,
    transcriptionVerified: true,
  }));
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`Whisper model preparation failed: ${message}`);
  process.exitCode = 1;
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}

function modelReady(filePath, model) {
  if (!existsSync(filePath)) return false;
  const minimumBytes = model === "small.en" ? 400_000_000 : 10_000_000;
  try {
    return statSync(filePath).size >= minimumBytes;
  } catch {
    return false;
  }
}

function commandFailure(result, model) {
  const details = [result.error?.message, result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim())
    .join("\n")
    .trim();
  const suffix = details ? `: ${details.slice(-4000)}` : "";
  return `HyperFrames did not prepare the ${model} model${suffix}`;
}

function requiredPath(value, flag) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${flag} requires a path`);
  }
  return path.resolve(value);
}

function writeSilentWav(filePath, seconds) {
  const sampleRate = 16_000;
  const channels = 1;
  const bitsPerSample = 16;
  const dataSize = sampleRate * channels * (bitsPerSample / 8) * seconds;
  const buffer = Buffer.alloc(44 + dataSize);
  buffer.write("RIFF", 0, "ascii");
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8, "ascii");
  buffer.write("fmt ", 12, "ascii");
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
  buffer.writeUInt16LE(channels * (bitsPerSample / 8), 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36, "ascii");
  buffer.writeUInt32LE(dataSize, 40);
  writeFileSync(filePath, buffer);
}
