import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";
import { createReadToolDefinition } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/tools/read.js";
import { sheet } from "../.pi/skills/clip-skills/scripts/media-cache.mjs";

// Opt-in local benchmark. It reads an existing task view and writes only to an
// isolated temporary directory; no video source, shared cache or model call.
const baseline = process.env.CLIP_MEDIA_BASELINE_VIEW_DIR;
test("paired native Pi read benchmark against an existing cached contact sheet", { skip: !baseline }, async (t) => {
  const entry = JSON.parse(readFileSync(path.join(baseline!, "entry.json"), "utf8"));
  const page = entry.sheets[0];
  const oldPath = path.join(baseline!, page.name);
  const frames = entry.frames.filter((frame: { at: number }) => frame.at >= page.firstSecond && frame.at <= page.lastSecond)
    .map((frame: { at: number; name: string }) => ({ at: frame.at, path: path.join(baseline!, frame.name) }));
  assert.ok(frames.length > 0 && frames.length <= 25);
  const directory = mkdtempSync(path.join(tmpdir(), "clip-native-image-benchmark-"));
  const output = path.join(directory, "native-overview.jpg");
  const project = path.resolve(import.meta.dirname, "..");
  const ffmpeg = path.join(project, ".runtime", "ffmpeg", "bin", "ffmpeg.exe");
  try {
    assert.ok(existsSync(ffmpeg));
    const generated = await sheet(frames, output, entry.geometry.aspect, "sample", 2000, { ffmpeg });
    const reader = createReadToolDefinition(directory);
    const readImage = async (file: string) => {
      const result = await reader.execute("local-image-benchmark", { path: file });
      const image = result.content.find((item: { type: string }) => item.type === "image");
      assert.ok(image && image.type === "image");
      return { mimeType: image.mimeType, base64Bytes: Buffer.byteLength(image.data),
        decodedBytes: Buffer.from(image.data, "base64").byteLength };
    };
    const before = await readImage(oldPath), after = await readImage(output);
    assert.equal(after.mimeType, "image/jpeg");
    assert.ok(generated.width <= 2000 && generated.height <= 2000);
    t.diagnostic(JSON.stringify({ frameCount: frames.length, oldFileBytes: statSync(oldPath).size,
      newFileBytes: statSync(output).size, width: generated.width, height: generated.height,
      before, after, readPayloadReduction: 1 - after.base64Bytes / before.base64Bytes,
      ...(process.env.CLIP_MEDIA_KEEP_BENCHMARK_DIR === "1" ? { output } : {}) }));
  } finally {
    if (process.env.CLIP_MEDIA_KEEP_BENCHMARK_DIR !== "1") {
      const relative = path.relative(tmpdir(), directory);
      assert.equal(relative.startsWith("..") || path.isAbsolute(relative), false);
      rmSync(directory, { recursive: true, force: true });
    }
  }
});
