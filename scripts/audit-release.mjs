import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const releaseRoot = path.join(projectRoot, ".runtime", "release-staging");
const sourceRoot = path.resolve(process.argv[2] ?? path.join(releaseRoot, "package", "Clip Studio"));
assertInside(sourceRoot, releaseRoot, "Release audit path");

const requiredFiles = [
  ".pi/skills/SOURCES.md",
  ".pi/skills/clip-skills/SKILL.md",
  ".pi/skills/hyperframes/hyperframes/SKILL.md",
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "dist/index.js",
  "dist/model-catalog.json",
  "install.bat",
  "install.ps1",
  "package-lock.json",
  "package.json",
  "release-manifest.json",
  "scripts/download-runtime.ps1",
  "scripts/dpapi-secret.ps1",
  "scripts/patch-puppeteer-windows.mjs",
  "scripts/prewarm-whisper.mjs",
  "scripts/run-service.mjs",
  "scripts/runtime-manifest.psd1",
  "scripts/runtime-python-requirements.lock",
  "scripts/runtime-state.ps1",
  "start.bat",
  "start.ps1",
  "web/dist/build-id.txt",
  "web/dist/index.html",
];
const allowedPrefixes = [".pi/skills/", "dist/", "scripts/", "web/dist/"];
const allowedExact = new Set(requiredFiles);
const forbiddenNames = [
  /^\.env(?:\.|$)/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$/i,
  /^(?:credentials?|secrets?)(?:\.|$)/i,
];
const secretPatterns = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["OpenAI-style key", /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ["AWS access key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{30,}\b/],
  ["Slack token", /\bxox[baprs]-[0-9A-Za-z-]{20,}\b/],
  ["live Stripe secret", /\bsk_live_[0-9A-Za-z]{16,}\b/],
];

const entries = await walk(sourceRoot);
const files = entries.filter((entry) => entry.type === "file");
const relatives = files.map((entry) => entry.relative);
const findings = [];

for (const entry of entries) {
  if (entry.type === "symlink") findings.push(`${entry.relative}: symbolic links are not allowed`);
}
for (const relative of relatives) {
  if (!allowedExact.has(relative) && !allowedPrefixes.some((prefix) => relative.startsWith(prefix))) {
    findings.push(`${relative}: file is outside the release allowlist`);
  }
  if (isTestMaterial(relative)) findings.push(`${relative}: test material is not allowed`);
  if (forbiddenNames.some((pattern) => pattern.test(path.posix.basename(relative)))) {
    findings.push(`${relative}: credential filename is not allowed`);
  }
}
for (const required of requiredFiles) {
  if (!relatives.includes(required)) findings.push(`${required}: required release file is missing`);
}

const privatePaths = [projectRoot, os.homedir()].flatMap((value) => [value, value.replaceAll("\\", "/")]);
for (const entry of files) {
  const content = await fs.readFile(entry.absolute);
  if (content.includes(0)) continue;
  const text = content.toString("utf8");
  const lowerText = text.toLowerCase();
  for (const privatePath of privatePaths) {
    if (privatePath && lowerText.includes(privatePath.toLowerCase())) {
      findings.push(`${entry.relative}: local absolute path`);
    }
  }
  for (const [label, pattern] of secretPatterns) {
    if (pattern.test(text)) findings.push(`${entry.relative}: ${label}`);
  }
}

const packageJson = await readJson(path.join(sourceRoot, "package.json"));
const dependencyNames = Object.keys(packageJson.dependencies ?? {}).sort();
const expectedDependencies = ["@earendil-works/pi-ai", "@earendil-works/pi-coding-agent", "hyperframes"];
if (JSON.stringify(dependencyNames) !== JSON.stringify(expectedDependencies)) {
  findings.push(`package.json: unexpected production dependencies (${dependencyNames.join(", ")})`);
}
if (Object.keys(packageJson.devDependencies ?? {}).length > 0) findings.push("package.json: development dependencies are present");
if (JSON.stringify(Object.keys(packageJson.scripts ?? {}).sort()) !== JSON.stringify(["start"])) {
  findings.push("package.json: release scripts must contain only start");
}

const packageLock = await readJson(path.join(sourceRoot, "package-lock.json"));
const lockRoot = packageLock.packages?.[""];
if (!lockRoot || Object.keys(lockRoot.devDependencies ?? {}).length > 0) {
  findings.push("package-lock.json: root development dependencies are present");
}
for (const [packagePath, record] of Object.entries(packageLock.packages ?? {})) {
  if (record?.dev === true) findings.push(`package-lock.json: development package is present (${packagePath})`);
}
for (const unsupported of ["node_modules/@img/sharp-wasm32", "node_modules/@emnapi/runtime"]) {
  if (packageLock.packages?.[unsupported]) {
    findings.push(`package-lock.json: Windows-unsupported optional package is present (${unsupported})`);
  }
}
if (!packageLock.packages?.["node_modules/@img/sharp-win32-x64"]) {
  findings.push("package-lock.json: Windows x64 Sharp runtime is missing");
}

const releaseManifest = await readJson(path.join(sourceRoot, "release-manifest.json"));
if (releaseManifest.schemaVersion !== 1 || releaseManifest.product !== "Clip Studio" || releaseManifest.platform !== "win32-x64") {
  findings.push("release-manifest.json: identity is invalid");
}
const artifactPaths = [];
for (const artifact of releaseManifest.artifacts ?? []) {
  const relative = normalize(String(artifact.path ?? ""));
  artifactPaths.push(relative);
  if (!relative.startsWith("dist/") && !relative.startsWith("web/dist/")) {
    findings.push(`release-manifest.json: invalid artifact path ${relative}`);
    continue;
  }
  const absolute = path.join(sourceRoot, ...relative.split("/"));
  try {
    const stat = await fs.stat(absolute);
    const hash = createHash("sha256").update(await fs.readFile(absolute)).digest("hex");
    if (!stat.isFile() || stat.size !== artifact.bytes || hash !== artifact.sha256) {
      findings.push(`release-manifest.json: artifact mismatch ${relative}`);
    }
  } catch {
    findings.push(`release-manifest.json: artifact missing ${relative}`);
  }
}
const builtFiles = relatives.filter((relative) => relative.startsWith("dist/") || relative.startsWith("web/dist/")).sort();
if (JSON.stringify([...new Set(artifactPaths)].sort()) !== JSON.stringify(builtFiles)) {
  findings.push("release-manifest.json: artifact list does not exactly cover the build output");
}

if (findings.length > 0) throw new Error(`Release audit failed:\n${findings.join("\n")}`);
const bytes = (await Promise.all(files.map(async (entry) => (await fs.stat(entry.absolute)).size))).reduce((sum, size) => sum + size, 0);
console.log(JSON.stringify({ sourceRoot, files: files.length, bytes, findings: 0 }, null, 2));

function assertInside(candidate, parent, label) {
  const relative = path.relative(parent, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${parent}`);
  }
}

function isTestMaterial(file) {
  const segments = file.toLowerCase().split("/");
  return segments.some((segment) => ["test", "tests", "test-corpus", "__tests__"].includes(segment))
    || /\.(test|spec)\.[^/]+$/i.test(file);
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, "utf8"));
}

async function walk(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      const relative = normalize(path.relative(root, absolute));
      if (entry.isSymbolicLink()) output.push({ type: "symlink", absolute, relative });
      else if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) output.push({ type: "file", absolute, relative });
    }
  }
  return output.sort((left, right) => left.relative.localeCompare(right.relative));
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
