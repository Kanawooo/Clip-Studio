import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import process from "node:process";

const projectRoot = path.resolve(import.meta.dirname, "..");
const stagingRoot = path.join(projectRoot, ".runtime", "release-staging");
const packageParent = path.join(stagingRoot, "package");
const packageRoot = path.join(packageParent, "Clip Studio");
const extractedRoot = path.join(stagingRoot, "extracted");
const zipPath = path.join(projectRoot, "Clip-Studio-Windows-x64.zip");
const auditScript = path.join(projectRoot, "scripts", "audit-release.mjs");
const npmCli = process.env.npm_execpath
  ? path.resolve(process.env.npm_execpath)
  : path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");

assertInside(stagingRoot, path.join(projectRoot, ".runtime"), "Release staging directory");
assertInside(packageRoot, stagingRoot, "Release package directory");
assertInside(extractedRoot, stagingRoot, "Release verification directory");

runNpm(["run", "build"], projectRoot);

await fs.rm(stagingRoot, { recursive: true, force: true });
await fs.mkdir(packageRoot, { recursive: true });

for (const relative of [
  "LICENSE",
  "README.md",
  "THIRD_PARTY_NOTICES.md",
  "install.bat",
  "install.ps1",
  "start.bat",
  "start.ps1",
]) {
  await copyFile(relative);
}
for (const relative of ["dist", path.join("web", "dist")]) {
  await copyTree(relative);
}
await copyTree(path.join(".pi", "skills"), (relative) => !isTestMaterial(relative));
for (const relative of [
  "scripts/download-runtime.ps1",
  "scripts/dpapi-secret.ps1",
  "scripts/patch-puppeteer-windows.mjs",
  "scripts/prewarm-whisper.mjs",
  "scripts/run-service.mjs",
  "scripts/runtime-manifest.psd1",
  "scripts/runtime-python-requirements.lock",
  "scripts/runtime-state.ps1",
]) {
  await copyFile(relative);
}

const sourcePackage = JSON.parse(await fs.readFile(path.join(projectRoot, "package.json"), "utf8"));
const releasePackage = {
  name: "clip-studio",
  version: sourcePackage.version,
  private: true,
  type: "module",
  description: "Clip Studio local AI video production runtime",
  engines: sourcePackage.engines,
  scripts: { start: "node dist/index.js" },
  license: sourcePackage.license,
  dependencies: sourcePackage.dependencies,
};
await writeJson(path.join(packageRoot, "package.json"), releasePackage);
await fs.copyFile(path.join(projectRoot, "package-lock.json"), path.join(packageRoot, "package-lock.json"));
runNpm(["install", "--package-lock-only", "--ignore-scripts", "--omit=dev", "--no-audit", "--no-fund"], packageRoot, {
  env: {
    ...process.env,
    npm_config_cache: path.join(projectRoot, ".runtime", "npm-cache"),
    npm_config_registry: "https://registry.npmjs.org/",
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  },
});
await pruneUnsupportedWindowsOptionalPackages(path.join(packageRoot, "package-lock.json"));

const artifacts = [];
for (const relative of await listFiles(packageRoot)) {
  if (!relative.startsWith("dist/") && !relative.startsWith("web/dist/")) continue;
  const absolute = path.join(packageRoot, ...relative.split("/"));
  const data = await fs.readFile(absolute);
  artifacts.push({
    path: relative,
    bytes: data.length,
    sha256: createHash("sha256").update(data).digest("hex"),
  });
}
const buildId = (await fs.readFile(path.join(packageRoot, "web", "dist", "build-id.txt"), "utf8")).trim();
await writeJson(path.join(packageRoot, "release-manifest.json"), {
  schemaVersion: 1,
  product: "Clip Studio",
  version: sourcePackage.version,
  platform: "win32-x64",
  buildId,
  generatedAt: new Date().toISOString(),
  artifacts,
});

runAudit(packageRoot);
await fs.rm(zipPath, { force: true });
createZip(packageParent, zipPath);

await fs.rm(extractedRoot, { recursive: true, force: true });
await fs.mkdir(extractedRoot, { recursive: true });
extractZip(zipPath, extractedRoot);
const topLevel = await fs.readdir(extractedRoot, { withFileTypes: true });
if (topLevel.length !== 1 || !topLevel[0].isDirectory() || topLevel[0].name !== "Clip Studio") {
  throw new Error("Release ZIP must contain one Clip Studio top-level directory");
}
const extractedPackage = path.join(extractedRoot, "Clip Studio");
runAudit(extractedPackage);

const zip = await fs.readFile(zipPath);
const result = {
  zipPath,
  bytes: zip.length,
  sha256: createHash("sha256").update(zip).digest("hex"),
  files: (await listFiles(extractedPackage)).length,
};
console.log(JSON.stringify(result, null, 2));

async function copyFile(relative) {
  const source = path.join(projectRoot, ...normalize(relative).split("/"));
  const destination = path.join(packageRoot, ...normalize(relative).split("/"));
  await fs.mkdir(path.dirname(destination), { recursive: true });
  await fs.copyFile(source, destination);
}

async function copyTree(relativeRoot, include = () => true) {
  const sourceRoot = path.join(projectRoot, relativeRoot);
  const pending = [sourceRoot];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const source = path.join(current, entry.name);
      const projectRelative = normalize(path.relative(projectRoot, source));
      if (!include(projectRelative)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Release input cannot be a symbolic link: ${projectRelative}`);
      if (entry.isDirectory()) pending.push(source);
      else if (entry.isFile()) await copyFile(projectRelative);
    }
  }
}

function runAudit(target) {
  execFileSync(process.execPath, [auditScript, target], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
}

function runNpm(args, cwd, options = {}) {
  execFileSync(process.execPath, [npmCli, ...args], {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    ...options,
  });
}

function createZip(source, destination) {
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[IO.Compression.ZipFile]::CreateFromDirectory('${powerShellLiteral(source)}', '${powerShellLiteral(destination)}', [IO.Compression.CompressionLevel]::Optimal, $false)`,
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
}

function extractZip(source, destination) {
  const command = [
    "Add-Type -AssemblyName System.IO.Compression.FileSystem",
    `[IO.Compression.ZipFile]::ExtractToDirectory('${powerShellLiteral(source)}', '${powerShellLiteral(destination)}')`,
  ].join("; ");
  execFileSync("powershell.exe", ["-NoProfile", "-Command", command], { cwd: projectRoot, stdio: "inherit", windowsHide: true });
}

async function listFiles(root) {
  const output = [];
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of await fs.readdir(current, { withFileTypes: true })) {
      const absolute = path.join(current, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Release tree cannot contain a symbolic link: ${absolute}`);
      if (entry.isDirectory()) pending.push(absolute);
      else if (entry.isFile()) output.push(normalize(path.relative(root, absolute)));
    }
  }
  return output.sort();
}

function isTestMaterial(file) {
  const segments = normalize(file).toLowerCase().split("/");
  return segments.some((segment) => ["test", "tests", "test-corpus", "__tests__"].includes(segment))
    || /\.(test|spec)\.[^/]+$/i.test(file);
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function pruneUnsupportedWindowsOptionalPackages(lockPath) {
  const lock = JSON.parse(await fs.readFile(lockPath, "utf8"));
  const packages = lock.packages ?? {};
  const unsupportedParents = [
    "node_modules/@img/sharp-freebsd-wasm32",
    "node_modules/@img/sharp-webcontainers-wasm32",
  ];
  for (const parent of unsupportedParents) {
    if (packages[parent]?.dependencies?.["@img/sharp-wasm32"] !== "0.35.3") {
      throw new Error(`Unexpected Sharp optional dependency graph at ${parent}`);
    }
    delete packages[parent].dependencies["@img/sharp-wasm32"];
    if (Object.keys(packages[parent].dependencies).length === 0) delete packages[parent].dependencies;
  }
  for (const omitted of ["node_modules/@img/sharp-wasm32", "node_modules/@emnapi/runtime"]) {
    if (!packages[omitted]) throw new Error(`Expected Windows-unsupported optional package is missing: ${omitted}`);
    delete packages[omitted];
  }
  if (!packages["node_modules/@img/sharp-win32-x64"]) {
    throw new Error("Windows x64 Sharp runtime is missing from the release lockfile");
  }
  await writeJson(lockPath, lock);
}

function assertInside(candidate, parent, label) {
  const relative = path.relative(parent, candidate);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside ${parent}`);
  }
}

function powerShellLiteral(value) {
  return value.replaceAll("'", "''");
}

function normalize(value) {
  return value.replaceAll("\\", "/");
}
