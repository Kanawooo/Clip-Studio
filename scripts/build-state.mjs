import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

const STATE_VERSION = 2;
const BUILD_REQUIRED_EXIT = 10;
const BUILD_OUTPUTS = ["dist/index.js", "dist/model-catalog.json", "web/dist/index.html", "web/dist/build-id.txt"];
const INPUT_DIRECTORIES = ["src", "web/src", "web/public"];
const INPUT_FILES = [
  "package.json",
  "tsconfig.json",
  "web/package.json",
  "web/tsconfig.json",
  "web/vite.config.ts",
  "web/index.html",
  "scripts/build-state.mjs",
  "scripts/generate-model-catalog.mjs",
];

const [action, ...rawArgs] = process.argv.slice(2);
const args = parseArgs(rawArgs);
const projectRoot = path.resolve(requiredArg(args, "project-root"));
const statePath = path.resolve(requiredArg(args, "state"));

try {
  if (action === "check") {
    const current = await buildState(projectRoot);
    const outputHashes = await hashExistingFiles(projectRoot, BUILD_OUTPUTS);
    const stored = await readStoredState(statePath);
    if (outputHashes
      && stored?.version === STATE_VERSION
      && stored.fingerprint === current.fingerprint
      && JSON.stringify(stored.outputHashes) === JSON.stringify(outputHashes)) {
      console.log("current");
      process.exit(0);
    }
    console.log("build-required");
    process.exit(BUILD_REQUIRED_EXIT);
  }

  if (action === "write") {
    const outputHashes = await hashExistingFiles(projectRoot, BUILD_OUTPUTS);
    if (!outputHashes) {
      throw new Error("Build outputs are missing; refusing to record a successful build");
    }
    const state = await buildState(projectRoot);
    await atomicWriteJson(statePath, {
      version: STATE_VERSION,
      generatedAt: new Date().toISOString(),
      ...state,
      outputHashes,
    });
    console.log(state.fingerprint);
    process.exit(0);
  }

  throw new Error("Usage: build-state.mjs <check|write> --project-root <path> --state <path>");
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

function parseArgs(values) {
  const output = new Map();
  for (let index = 0; index < values.length; index += 2) {
    const key = values[index];
    const value = values[index + 1];
    if (!key?.startsWith("--") || value === undefined) {
      throw new Error(`Invalid argument: ${key ?? ""}`);
    }
    output.set(key.slice(2), value);
  }
  return output;
}

function requiredArg(values, name) {
  const value = values.get(name);
  if (!value) throw new Error(`Missing --${name}`);
  return value;
}

async function buildState(root) {
  const files = [];
  for (const relativeDir of INPUT_DIRECTORIES) {
    await collectFiles(root, relativeDir, files);
  }
  for (const relativeFile of INPUT_FILES) {
    if (await fileExists(path.join(root, relativeFile))) files.push(normalizeRelative(relativeFile));
  }

  const inputs = [];
  for (const relativeFile of [...new Set(files)].sort()) {
    const absolute = path.join(root, ...relativeFile.split("/"));
    inputs.push({ path: relativeFile, sha256: await sha256File(absolute) });
  }
  if (inputs.length === 0) throw new Error("No build inputs were found");
  const fingerprint = createHash("sha256").update(JSON.stringify(inputs)).digest("hex");
  return { fingerprint, inputs };
}

async function collectFiles(root, relativeDir, output) {
  const absoluteDir = path.join(root, relativeDir);
  let entries;
  try {
    entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error(`Build input cannot be a symbolic link: ${path.join(relativeDir, entry.name)}`);
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) await collectFiles(root, relative, output);
    else if (entry.isFile()) output.push(normalizeRelative(relative));
  }
}

function normalizeRelative(value) {
  return value.split(path.sep).join("/");
}

async function sha256File(filePath) {
  return createHash("sha256").update(await fs.readFile(filePath)).digest("hex");
}

async function hashExistingFiles(root, files) {
  const entries = [];
  for (const relative of files) {
    const absolute = path.join(root, relative);
    if (!(await fileExists(absolute))) return undefined;
    entries.push([normalizeRelative(relative), await sha256File(absolute)]);
  }
  return Object.fromEntries(entries);
}

async function fileExists(filePath) {
  try {
    return (await fs.stat(filePath)).isFile();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function readStoredState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

async function atomicWriteJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await fs.rename(temporary, filePath);
}
