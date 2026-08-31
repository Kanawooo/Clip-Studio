import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
const packageRoot = path.join(projectRoot, "node_modules", "@puppeteer", "browsers");
const packageJsonPath = path.join(packageRoot, "package.json");
const expectedVersion = "3.2.1";
const before = "opts.detached ??= true;";
const after = "opts.detached ??= process.platform !== 'win32';";
const hyperFramesRoot = path.join(projectRoot, "node_modules", "hyperframes");
const hyperFramesPackagePath = path.join(hyperFramesRoot, "package.json");
const hyperFramesCliPath = path.join(hyperFramesRoot, "dist", "cli.js");
const expectedHyperFramesVersion = "0.8.4";
const modelDirBefore = 'MODELS_DIR = join21(homedir5(), ".cache", "hyperframes", "whisper", "models");';
const modelDirAfter = 'MODELS_DIR = process.env["HYPERFRAMES_WHISPER_MODELS_DIR"] || join21(homedir5(), ".cache", "hyperframes", "whisper", "models");';

let packageJson;
try {
  packageJson = JSON.parse(await readFile(packageJsonPath, "utf8"));
} catch (error) {
  throw new Error(`Unable to inspect @puppeteer/browsers: ${error instanceof Error ? error.message : String(error)}`);
}
if (packageJson.version !== expectedVersion) {
  throw new Error(`Unsupported @puppeteer/browsers version ${String(packageJson.version)}; expected ${expectedVersion}`);
}

for (const relativePath of [path.join("lib", "launch.js"), path.join("src", "launch.ts")]) {
  const filePath = path.join(packageRoot, relativePath);
  const source = await readFile(filePath, "utf8");
  if (source.includes(after)) continue;
  const occurrences = source.split(before).length - 1;
  if (occurrences !== 1 || !source.includes("windowsHide: true")) {
    throw new Error(`Refusing to patch unexpected @puppeteer/browsers file: ${relativePath}`);
  }
  await writeFile(filePath, source.replace(before, after), "utf8");
}

let hyperFramesPackage;
try {
  hyperFramesPackage = JSON.parse(await readFile(hyperFramesPackagePath, "utf8"));
} catch (error) {
  throw new Error(`Unable to inspect HyperFrames: ${error instanceof Error ? error.message : String(error)}`);
}
if (hyperFramesPackage.version !== expectedHyperFramesVersion) {
  throw new Error(`Unsupported HyperFrames version ${String(hyperFramesPackage.version)}; expected ${expectedHyperFramesVersion}`);
}
const hyperFramesCli = await readFile(hyperFramesCliPath, "utf8");
if (!hyperFramesCli.includes(modelDirAfter)) {
  const occurrences = hyperFramesCli.split(modelDirBefore).length - 1;
  if (occurrences !== 1) {
    throw new Error("Refusing to patch an unexpected HyperFrames model directory implementation");
  }
  await writeFile(hyperFramesCliPath, hyperFramesCli.replace(modelDirBefore, modelDirAfter), "utf8");
}

console.log("[postinstall] Clip Studio Windows rendering and transcription paths are configured.");
