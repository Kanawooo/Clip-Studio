import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

const resources = path.resolve(import.meta.dirname, "../resources");
const file = "gsap-3.14.2.min.js";
const digest = "ecfee15040cfabcb76889161ac067b6c11ee38d31f087f2248e43c0c3f2c706b";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, target) => { const relative = path.relative(root, target); return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`)); };
const scriptPattern = /(<script\b[^>]*\bsrc\s*=\s*["'])(https:\/\/(?:cdn\.jsdelivr\.net\/npm\/gsap@3\.14\.2\/dist\/gsap\.min\.js|cdnjs\.cloudflare\.com\/ajax\/libs\/gsap\/3\.14\.2\/gsap\.min\.js))(["'][^>]*>)/gi;
const localPattern = /<script\b[^>]*\bsrc\s*=\s*["']assets\/vendor\/gsap-3\.14\.2\.min\.js["']/i;

async function verifyProjectResource(project) {
  const root = await fs.realpath(project), target = path.join(root, "assets/vendor", file);
  if (!inside(root, await fs.realpath(target)) || hash(await fs.readFile(target)) !== digest)
    throw new Error("工程本地动画库与固定版本不符，未覆盖原文件");
}

export async function verifyGsapResource() {
  const bytes = await fs.readFile(path.join(resources, file));
  if (hash(bytes) !== digest || !bytes.toString("utf8", 0, 120).includes("GSAP 3.14.2"))
    throw new Error("本地 GSAP 3.14.2 资源校验失败，请修复安装组件；任务不下载或替换动画库版本");
  return bytes;
}

export async function localizeGsap(html, project) {
  scriptPattern.lastIndex = 0;
  if (!scriptPattern.test(html)) {
    if (localPattern.test(html)) await verifyProjectResource(project);
    return html;
  }
  const root = await fs.realpath(project), target = path.join(root, "assets/vendor", file);
  let ancestor = path.dirname(target);
  while (true) {
    try { if (!inside(root, await fs.realpath(ancestor))) throw new Error("动画资源目录通过链接越界"); break; }
    catch (error) { if (error.code !== "ENOENT") throw error; ancestor = path.dirname(ancestor); }
  }
  const bytes = await verifyGsapResource();
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx" });
    try { await fs.link(temporary, target); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  } finally { await fs.rm(temporary, { force: true }); }
  await verifyProjectResource(root);
  scriptPattern.lastIndex = 0;
  // Library location only: IDs, timing, source ranges and visual content stay identical.
  return html.replace(scriptPattern, `$1assets/vendor/${file}$3`);
}

export async function prepareRenderComposition(row, project) {
  const original = await fs.readFile(row.composition, "utf8"), normalized = await localizeGsap(original, project);
  const verify = () => localPattern.test(normalized) ? verifyProjectResource(project) : Promise.resolve();
  if (normalized === original) return { file: row.composition, verify, dispose: async () => {} };
  const target = path.join(path.dirname(row.composition), `.clip-render-${randomUUID()}.html`);
  if (!inside(await fs.realpath(project), await fs.realpath(path.dirname(target)))) throw new Error("渲染副本目录越界");
  await fs.writeFile(target, normalized, { flag: "wx" });
  return { file: target, verify, dispose: () => fs.rm(target, { force: true }) };
}
