import { createReadStream, promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import path from "node:path";

const execFileAsync = promisify(execFile);

/**
 * Output discovery. No artifact database: snapshot the outputDir before the
 * task, rescan after the task, and report new/changed video files.
 */

const VIDEO_EXTENSIONS = new Set([".mp4", ".mov", ".webm", ".mkv"]);

export interface VideoFileInfo {
  path: string;
  mtimeMs: number;
  size: number;
}

export type VideoSnapshot = Map<string, VideoFileInfo>;

function normalizePathKey(filePath: string): string {
  const absolute = path.resolve(filePath);
  return process.platform === "win32" ? absolute.toLowerCase() : absolute;
}

function isVideoFile(filePath: string): boolean {
  return VIDEO_EXTENSIONS.has(path.extname(filePath).toLowerCase());
}

export async function scanVideoFiles(rootDir: string): Promise<VideoFileInfo[]> {
  const found: VideoFileInfo[] = [];

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isVideoFile(entry.name)) {
        try {
          const stat = await fs.stat(fullPath);
          found.push({ path: fullPath, mtimeMs: stat.mtimeMs, size: stat.size });
        } catch (error) {
          if (!isMissing(error)) throw error;
          // File disappeared between readdir and stat.
        }
      }
    }
  }

  await walk(path.resolve(rootDir));
  return found;
}

export async function filterPlayableVideoFiles(files: string[]): Promise<string[]> {
  const playable: string[] = [];
  for (const filePath of files) {
    try {
      const { stdout } = await execFileAsync(
        process.env.HYPERFRAMES_FFPROBE_PATH?.trim() || "ffprobe",
        [
          "-v",
          "error",
          "-select_streams",
          "v:0",
          "-show_entries",
          "stream=codec_type",
          "-of",
          "default=noprint_wrappers=1:nokey=1",
          filePath,
        ],
        { timeout: 30_000, maxBuffer: 1_000_000 },
      );
      if (stdout.trim() === "video") playable.push(filePath);
    } catch (error) {
      if (isProcessExit(error)) continue;
      throw error;
    }
  }
  return playable;
}

/**
 * Wait briefly for a renderer to finish replacing a file before probing it.
 * Pi waits for foreground commands, but a renderer can still finalize an
 * output asynchronously. A short settle window avoids accepting a partial
 * file without adding a fixed delay to normal completed renders.
 */
export async function waitForStableVideoFiles(
  files: string[],
  options: { settleMs?: number; timeoutMs?: number } = {},
): Promise<string[]> {
  const settleMs = Math.max(1, options.settleMs ?? 250);
  const timeoutMs = Math.max(settleMs, options.timeoutMs ?? 5_000);
  let snapshot = await statVideoFiles(files);
  if (snapshot.length === 0) return [];
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) return [];
    await new Promise((resolve) => setTimeout(resolve, Math.min(settleMs, remaining)));
    const next = await statVideoFiles(snapshot.map((file) => file.path));
    if (next.length === snapshot.length && next.every((file, index) => (
      file.path === snapshot[index].path
      && file.size === snapshot[index].size
      && file.mtimeMs === snapshot[index].mtimeMs
    ))) {
      return next.map((file) => file.path);
    }
    snapshot = next;
    if (snapshot.length === 0) return [];
  }
}

async function statVideoFiles(files: string[]): Promise<VideoFileInfo[]> {
  const found: VideoFileInfo[] = [];
  for (const filePath of files) {
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) found.push({ path: filePath, mtimeMs: stat.mtimeMs, size: stat.size });
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return found;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function isProcessExit(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (typeof error.code === "number" || error.code === 1);
}

export async function snapshotOutputDir(outputDir: string): Promise<VideoSnapshot> {
  const snapshot: VideoSnapshot = new Map();
  const files = await scanVideoFiles(outputDir);
  for (const file of files) {
    snapshot.set(normalizePathKey(file.path), file);
  }
  return snapshot;
}

export function diffVideoOutputs(before: VideoSnapshot, after: VideoSnapshot): string[] {
  const outputs = new Map<string, VideoFileInfo>();

  for (const [key, info] of after) {
    const previous = before.get(key);
    if (!previous || previous.mtimeMs !== info.mtimeMs || previous.size !== info.size) {
      outputs.set(key, info);
    }
  }

  return [...outputs.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((info) => info.path);
}

/**
 * Return a stable content identity for a finished output. This is a technical
 * delivery check only; it does not inspect or judge the video contents.
 */
export async function videoContentHash(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  const stream = createReadStream(filePath);
  return new Promise((resolve, reject) => {
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.once("error", reject);
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}
