import { lstatSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

export interface TaskPathOptions {
  projectRoot: string;
  tasksDir?: string;
  workspace: string;
  referenceVideo: string;
  assetsDir: string;
  audioDir: string;
  outputDir: string;
}

export interface TaskPaths {
  projectRoot: string;
  workspace: string;
  referenceVideo: string;
  assetsDir: string;
  audioDir: string;
  outputDir: string;
  skillRoots: string[];
}

const PROTECTED_PROJECT_ENTRIES = [
  "src", "web", "scripts", "dist", "node_modules", "tests", "data", ".runtime",
  ".pi", ".git", ".trellis", ".codex", ".agents",
];

/** Resolve existing links, including a link in the nearest existing parent of a future file. */
export function effectivePath(value: string): string {
  const target = path.resolve(value);
  let existing = target;
  while (true) {
    try {
      lstatSync(existing);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(existing);
      if (parent === existing) throw error;
      existing = parent;
      continue;
    }
    // An existing but dangling link must fail here, not be treated as a
    // not-yet-created file under its apparent parent.
    return path.resolve(realpathSync.native(existing), path.relative(existing, target));
  }
}

export function pathInside(root: string, candidate: string): boolean {
  const leftPath = effectivePath(root);
  const rightPath = effectivePath(candidate);
  const left = process.platform === "win32" ? leftPath.toLowerCase() : leftPath;
  const right = process.platform === "win32" ? rightPath.toLowerCase() : rightPath;
  const relative = path.relative(left, right);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function sameFilePath(left: string, right: string): boolean {
  return pathInside(left, right) && pathInside(right, left);
}

function overlaps(left: string, right: string): boolean {
  return pathInside(left, right) || pathInside(right, left);
}

function mustBe(value: string, type: "file" | "directory", label: string): void {
  try {
    const stat = statSync(value);
    if (type === "file" ? !stat.isFile() : !stat.isDirectory()) throw new Error(`${label}不是${type === "file" ? "文件" : "目录"}：${value}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`${label}不存在：${value}`);
    throw error;
  }
}

/** One preflight is run before mkdir; the second checks the paths actually created. */
export function resolveTaskPaths(options: TaskPathOptions): TaskPaths {
  const projectRoot = effectivePath(options.projectRoot);
  const tasksDir = effectivePath(options.tasksDir ?? path.join(projectRoot, "data", "tasks"));
  const workspace = effectivePath(options.workspace);
  const taskDir = effectivePath(path.dirname(options.workspace));
  const referenceVideo = effectivePath(options.referenceVideo);
  const assetsDir = effectivePath(options.assetsDir);
  const audioDir = effectivePath(options.audioDir);
  const outputDir = effectivePath(options.outputDir);
  const protectedRoots = PROTECTED_PROJECT_ENTRIES.map((entry) => effectivePath(path.join(projectRoot, entry)));
  if (!pathInside(tasksDir, taskDir) || !pathInside(taskDir, workspace) || sameFilePath(taskDir, tasksDir)) {
    throw new Error("当前任务工作目录不在任务目录内。请检查任务目录的链接目标。");
  }
  mustBe(options.referenceVideo, "file", "参考视频");
  mustBe(options.assetsDir, "directory", "素材目录");
  mustBe(options.audioDir, "directory", "音频目录");
  for (const [label, directory] of [["素材目录", assetsDir], ["音频目录", audioDir]] as const) {
    if (pathInside(directory, projectRoot) || protectedRoots.some((root) => overlaps(directory, root))
      || overlaps(directory, tasksDir)) {
      throw new Error(`${label}与程序目录或任务目录重叠：${directory}`);
    }
  }
  if ((pathInside(projectRoot, referenceVideo)
    && (sameFilePath(path.dirname(referenceVideo), projectRoot)
      || protectedRoots.some((root) => pathInside(root, referenceVideo))))
    || pathInside(tasksDir, referenceVideo)) {
    throw new Error(`参考视频位于程序目录或任务目录内：${referenceVideo}`);
  }
  if (overlaps(outputDir, assetsDir) || overlaps(outputDir, audioDir)
    || pathInside(outputDir, referenceVideo) || overlaps(outputDir, taskDir)
    || protectedRoots.some((root) => overlaps(outputDir, root)) || overlaps(outputDir, tasksDir)) {
    throw new Error(`输出目录与只读输入、程序实现或任务目录重叠：${outputDir}`);
  }
  try {
    const stat = statSync(options.outputDir);
    if (!stat.isDirectory()) throw new Error(`输出目录不是目录：${options.outputDir}`);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return {
    projectRoot, workspace, referenceVideo, assetsDir, audioDir, outputDir,
    skillRoots: [
      effectivePath(path.join(projectRoot, ".pi", "skills", "clip-skills")),
      effectivePath(path.join(projectRoot, ".pi", "skills", "hyperframes")),
    ],
  };
}
