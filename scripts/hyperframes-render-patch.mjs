const importLine = 'import { renderMap as clipRenderMap, extractionThreadArgs as clipThreadArgs, emitSourceFailures as clipSourceFailures } from "../../../.pi/skills/hyperframes/hyperframes-cli/scripts/render-support.mjs";';

function replaceOnce(source, before, after) {
  const count = source.split(before).length - 1;
  if (count !== 1) throw new Error(`Refusing unexpected HyperFrames render signature (${count} matches): ${before.slice(0, 90)}`);
  return source.replace(before, after);
}

function boundedBlock(source, start, end, list, mapper, indent = 4) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  if (from < 0 || to < 0) throw new Error(`Missing HyperFrames block: ${start}`);
  let block = source.slice(from, to);
  block = replaceOnce(block, `await Promise.all(\n${" ".repeat(indent)}${list}.map(${mapper}`, `await clipRenderMap(${list}, ${mapper}`);
  block = replaceOnce(block, `\n${" ".repeat(indent)}})\n${" ".repeat(indent - 2)});`, `\n${" ".repeat(indent)}});`);
  return source.slice(0, from) + block + source.slice(to);
}

/** Pure, pinned and idempotent. Test on isolated bytes; postinstall is the only
 * production writer. Existing browser/Whisper patches are kept by their owner. */
export function patchRenderSource(source, version) {
  if (version !== "0.8.4") throw new Error(`Unsupported HyperFrames render patch version ${version}`);
  const header = source.startsWith("#!") ? source.slice(0, source.indexOf("\n") + 1) : "";
  source = source.slice(header.length);
  if (source.startsWith(importLine + "\n")) {
    if (source.split(importLine).length !== 2 || !source.includes("clipSourceFailures(extractionResult, composition.videos);")
      || (source.match(/await clipRenderMap\(/g)?.length ?? 0) !== 6 || !source.includes("...clipThreadArgs()")
      || !source.includes('kind: "ffprobe_" + outcome.reason')
      || (source.match(/if \(process.env.CLIP_RENDER_QUEUE === "1"\) return false;/g)?.length ?? 0) !== 2)
      throw new Error("Incomplete HyperFrames render patch");
    return header + source;
  }
  let patched = boundedBlock(source, "  const metadataResults = await Promise.all(", "  const probedVideos =", "resolvedVideos", "async ({ video, videoPath }, index) => {");
  patched = boundedBlock(patched, "  const preparedExtractions = await Promise.all(", "  const uniqueWorks =", "resolvedVideos", "async ({ video, videoPath }, index) => {");
  patched = replaceOnce(patched,
    "  const directOutcomes = await Promise.all(\n    supersetPlan.direct.map(\n      async (miss) => [miss.work.dedupeKey, await executeDirectMiss(miss)]\n    )\n  );",
    "  const directOutcomes = await clipRenderMap(supersetPlan.direct,\n      async (miss) => [miss.work.dedupeKey, await executeDirectMiss(miss)]);" );
  patched = replaceOnce(patched,
    "  const supersetOutcomes = await Promise.all(\n    supersetPlan.groups.map((group) => executeSupersetGroup(group))\n  );",
    "  const supersetOutcomes = await clipRenderMap(supersetPlan.groups, (group) => executeSupersetGroup(group));");
  patched = boundedBlock(patched, "    const probeFailures = await Promise.all(", "    throwHdrProbeFailures(", "composition.videos", "async (v2) => {", 6);
  patched = boundedBlock(patched, "    const probed = await Promise.all(\n      composition.images.map", "    imageColorSpaces.push(...probed);", "composition.images", "async (img) => {", 6);
  const start = patched.indexOf("async function extractVideoFramesRange("), end = patched.indexOf("  const framePaths =", start);
  if (start < 0 || end < 0) throw new Error("Missing HyperFrames frame extraction signature");
  let block = replaceOnce(patched.slice(start, end), "  const args = [];", "  const args = [...clipThreadArgs()];");
  block = replaceOnce(block, '  args.push("-y", outputPattern);', '  args.push(...clipThreadArgs(), "-y", outputPattern);');
  patched = patched.slice(0, start) + block + patched.slice(end);
  patched = replaceOnce(patched, "    failureToEnforce = applyVideoExtractionFailurePolicy(extractionResult, extractionPolicy, log2);",
    "    clipSourceFailures(extractionResult, composition.videos);\n    failureToEnforce = applyVideoExtractionFailurePolicy(extractionResult, extractionPolicy, log2);");
  patched = replaceOnce(patched, "    const diagnostic = sanitizeFfprobeDiagnostic(outcome.stderr, filePath);",
    `    const diagnostic = sanitizeFfprobeDiagnostic(outcome.stderr, filePath);
    clipSourceFailures({ errors: [{ stage: "probe", source: filePath, videoId: filePath,
      kind: "ffprobe_" + outcome.reason,
      retryable: outcome.reason === "deadline" || /resource temporarily unavailable|device or resource busy|input\\/output error/i.test(outcome.stderr),
      error: "ffprobe " + outcome.reason + " with code " + outcome.exitCode + ": " + diagnostic }] });`);
  // Queue owns the shared recovery budget. Other CLI users retain native retry.
  patched = replaceOnce(patched, "function shouldRetryViaPinnedFallback(args) {",
    'function shouldRetryViaPinnedFallback(args) {\n  if (process.env.CLIP_RENDER_QUEUE === "1") return false;');
  patched = replaceOnce(patched, "function shouldAllowAdaptiveCaptureRetry(workerCount, _explicitlyConfigured) {",
    'function shouldAllowAdaptiveCaptureRetry(workerCount, _explicitlyConfigured) {\n  if (process.env.CLIP_RENDER_QUEUE === "1") return false;');
  return header + importLine + "\n" + patched;
}
