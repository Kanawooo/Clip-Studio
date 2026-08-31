import { promises as fs } from "node:fs";
import path from "node:path";

const projectRoot = path.resolve(import.meta.dirname, "..");
for (const relative of ["dist", path.join("web", "dist")]) {
  const target = path.join(projectRoot, relative);
  const parent = path.dirname(target);
  const resolved = path.resolve(target);
  if (path.dirname(resolved) !== path.resolve(parent)) throw new Error(`Unsafe build output: ${resolved}`);
  await fs.rm(resolved, { recursive: true, force: true });
}
