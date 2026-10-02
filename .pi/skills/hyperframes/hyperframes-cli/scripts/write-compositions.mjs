#!/usr/bin/env node
// Mechanical serialization of Pi's decisions. No model calls or generated-script execution.
import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { mediaAccess, taskInput, taskOutput } from "../../../clip-skills/scripts/media-cache.mjs";
import { attribute, publicError, validateAudio } from "./render-queue.mjs";
import { localizeGsap } from "./render-resources.mjs";

const inside = (root, file) => {
  const relative = path.relative(root, file);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
const escape = (value) => String(value).replace(/&/g, "&amp;").replace(/</g, "&lt;")
  .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

export function fillTemplate(template, values = {}) {
  if (!values || typeof values !== "object" || Array.isArray(values)) throw new Error("values 必须是对象");
  return template.replace(/\{\{(?:(json|html):)?([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_match, mode, name) => {
    if (!Object.hasOwn(values, name)) throw new Error(`values.${name} 缺失`);
    const value = values[name];
    if (mode === "json") {
      const json = JSON.stringify(value);
      if (json === undefined) throw new Error(`values.${name} 不是有效 JSON 数据`);
      return json.replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
    }
    if (mode === "html") {
      if (typeof value !== "string") throw new Error(`values.${name} 的 html 内容必须是字符串`);
      return value;
    }
    if (!["string", "number", "boolean"].includes(typeof value)) throw new Error(`values.${name} 需要文本、数字或布尔值；数据对象使用 json 标记`);
    return escape(value);
  });
}

async function checkMedia(html, project, access) {
  for (const match of html.matchAll(/<(video|audio|img|source)\b[^>]*>/gi)) {
    const src = attribute(match[0], "src");
    if (!src || /^(data|blob):/i.test(src)) continue;
    if (/^(https?|ftp):/i.test(src)) throw new Error("工程媒体必须来自本任务已选路径或工作目录");
    const file = src.startsWith("file://") ? fileURLToPath(src) : path.resolve(project, src);
    await access.file(file, match[1].toLowerCase() === "audio" ? "audio" : undefined);
  }
}

export async function writeCompositions(options) {
  const workspace = await fs.realpath(options.workspace);
  const access = await mediaAccess(workspace);
  const manifest = JSON.parse(await fs.readFile(await taskInput(workspace, path.resolve(workspace, options.manifest)), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.rows) || !manifest.rows.length) throw new Error("工程清单需要 version:1 和非空 rows");
  if (typeof manifest.project !== "string" || path.isAbsolute(manifest.project)
    || !inside(workspace, path.resolve(workspace, manifest.project))) throw new Error("project 必须是任务工作目录中的相对工程路径");
  const project = path.resolve(workspace, manifest.project);
  await taskOutput(workspace, path.join(project, ".path-check"));
  const fps = manifest.fps ?? 30;
  if (!Number.isFinite(fps) || fps <= 0 || fps > 240) throw new Error("fps 无效");
  let contract = { workspace, audioDir: access.audio };
  // The backend-owned silent requirement is outside Pi's writable workspace.
  const contractFile = path.join(workspace, "..", "delivery", "contract.json");
  try {
    const actual = await fs.realpath(contractFile);
    if (!inside(path.dirname(contractFile), actual)) throw new Error("任务交付契约路径越界");
    const stored = JSON.parse(await fs.readFile(actual, "utf8"));
    if (stored.version === 1 && stored.taskId === access.policy.taskId && stored.workspace
      && (await fs.realpath(stored.workspace)) === workspace) contract = { ...contract, silentDuration: stored.silentDuration };
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const prepared = [], names = new Set(), ids = new Set();
  for (const [index, row] of manifest.rows.entries()) {
    try {
      if (!row || typeof row.composition !== "string" || path.isAbsolute(row.composition)
        || path.extname(row.composition).toLowerCase() !== ".html"
        || !inside(project, path.resolve(project, row.composition))) throw new Error("composition 必须是工程中的相对 HTML 文件");
      const file = await taskOutput(workspace, path.resolve(project, row.composition));
      const name = process.platform === "win32" ? file.toLowerCase() : file;
      if (names.has(name)) throw new Error("composition 重复");
      names.add(name);
      let html;
      if (row.content !== undefined) {
        if (typeof row.content !== "string" || row.template !== undefined || row.values !== undefined) throw new Error("content 必须是 HTML 字符串，不能同时填写 template/values");
        html = row.content;
      } else {
        const template = row.template ?? manifest.template;
        if (typeof template !== "string") throw new Error("需要 content 或工作目录中的 template 文件");
        html = fillTemplate(await fs.readFile(await taskInput(workspace, path.resolve(workspace, template)), "utf8"), row.values);
      }
      const root = html.match(/<[a-z][^>]*\bdata-composition-id\s*=[^>]*>/i)?.[0];
      const id = root && attribute(root, "data-composition-id");
      if (!id || ids.has(id)) throw new Error("工程根需要唯一 data-composition-id");
      ids.add(id);
      await checkMedia(html, project, access);
      await validateAudio(row, file, project, contract, fps, html);
      const existing = await fs.readFile(file, "utf8").catch((error) => error.code === "ENOENT" ? undefined : Promise.reject(error));
      // Legacy identical adoption keeps its original engineering digest.
      if (existing !== html) html = await localizeGsap(html, project);
      if (existing !== undefined && existing !== html) throw new Error("已有工程内容不同，未覆盖；请用原生 edit 修正或选择新 composition 文件名");
      prepared.push({ index, file, html, existing: existing !== undefined });
    } catch (error) { throw new Error(`rows[${index}]：${publicError(error.message)}`); }
  }
  const saved = [], skipped = [], failed = [];
  for (const item of prepared) {
    const sha256 = createHash("sha256").update(item.html).digest("hex");
    if (item.existing) { skipped.push({ row: item.index, file: item.file, sha256 }); continue; }
    const temporary = `${item.file}.${randomUUID()}.tmp`;
    try {
      await fs.writeFile(await taskOutput(workspace, temporary), item.html, { flag: "wx" });
      // Atomic no-replace publication, including a concurrently-created destination.
      await fs.link(temporary, await taskOutput(workspace, item.file));
      saved.push({ row: item.index, file: item.file, sha256 });
    } catch (error) { failed.push({ row: item.index, file: item.file, error: publicError(error.message) }); }
    finally { await fs.rm(temporary, { force: true }).catch((error) => failed.push({ row: item.index, file: item.file, error: `临时文件清理失败：${publicError(error.message)}` })); }
  }
  return { saved, skipped, failed };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
      process.stdout.write("write-compositions.mjs --workspace <任务工作目录> --manifest <工程JSON>\nJSON: {version:1,project,template?,rows:[{composition,values?,content?,mainAudio}]}\n");
    } else {
      const options = {};
      for (let index = 0; index < args.length; index += 2) {
        if (!["--workspace", "--manifest"].includes(args[index]) || !args[index + 1]
          || Object.hasOwn(options, args[index].slice(2))) throw new Error("需要 --workspace 和 --manifest，不能重复或添加未知参数");
        options[args[index].slice(2)] = args[index + 1];
      }
      if (!options.workspace || !options.manifest) throw new Error("需要 --workspace 和 --manifest");
      const result = await writeCompositions(options);
      process.stdout.write(JSON.stringify(result) + "\n");
      if (result.failed.length) { process.stderr.write("工程写入未全部成功：" + result.failed.map((row) => `rows[${row.row}]：${row.error}`).join("；") + "\n"); process.exitCode = 1; }
    }
  } catch (error) { process.stderr.write(`write-compositions: ${publicError(error.message)}\n`); process.exitCode = 1; }
}
