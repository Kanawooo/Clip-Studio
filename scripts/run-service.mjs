import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverScript = path.resolve(process.argv[2] ?? path.join(projectRoot, "dist", "index.js"));
const logDir = path.join(projectRoot, ".runtime", "logs");
const latestLog = path.join(logDir, "service-latest.log");
const previousLog = path.join(logDir, "service-previous.log");

await fs.mkdir(logDir, { recursive: true });
await fs.rm(previousLog, { force: true });
try {
  await fs.rename(latestLog, previousLog);
} catch (error) {
  if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
}

const log = createWriteStream(latestLog, { flags: "a", encoding: "utf8" });
writeLog("runner", `starting service with ${process.execPath}`);

const child = spawn(process.execPath, [serverScript], {
  cwd: projectRoot,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
  windowsHide: true,
});

pipeLines(child.stdout, process.stdout, "stdout");
pipeLines(child.stderr, process.stderr, "stderr");

let forwardedSignal = false;
for (const signal of ["SIGINT", "SIGTERM", "SIGBREAK"]) {
  process.once(signal, () => {
    forwardedSignal = true;
    writeLog("runner", `forwarding ${signal}`);
    try {
      child.kill(signal);
    } catch {
      child.kill();
    }
  });
}

child.once("error", (error) => {
  const message = safeLine(error instanceof Error ? error.message : String(error));
  process.stderr.write(`[service-runner] unable to start backend: ${message}\n`);
  writeLog("runner", `spawn failed: ${message}`);
  log.end(() => process.exit(1));
});

child.once("exit", (code, signal) => {
  const exitCode = typeof code === "number" ? code : forwardedSignal ? 0 : 1;
  writeLog("runner", `service exited with code ${String(code)}${signal ? ` signal ${signal}` : ""}`);
  log.end(() => process.exit(exitCode));
});

function pipeLines(stream, target, channel) {
  let buffered = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk) => {
    buffered += chunk;
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      emit(buffered.slice(0, newline).replace(/\r$/, ""));
      buffered = buffered.slice(newline + 1);
    }
  });
  stream.once("end", () => {
    if (buffered) emit(buffered);
  });

  function emit(line) {
    const safe = safeLine(line);
    target.write(`${safe}\n`);
    writeLog(channel, safe);
  }
}

function writeLog(channel, message) {
  log.write(`${new Date().toISOString()} ${channel} ${safeLine(message)}\n`);
}

function safeLine(value) {
  return String(value)
    .replace(/\b(?:sk|key|token)-[A-Za-z0-9._-]{8,}\b/gi, "[REDACTED]")
    .replace(/((?:api[_ -]?key|authorization|bearer|credential|secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/([?&](?:api_?key|access_?token|token|key)=)[^&\s]+/gi, "$1[REDACTED]")
    .replace(/("(?:apiKey|accessToken|token|secret)"\s*:\s*")[^"]+("?)/gi, "$1[REDACTED]$2")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 8_000);
}
