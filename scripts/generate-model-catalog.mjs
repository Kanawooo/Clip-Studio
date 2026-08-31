import { promises as fs } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = path.resolve(import.meta.dirname, "..");
const outputPath = path.join(projectRoot, "dist", "model-catalog.json");
const modelModule = await import(pathToFileURL(path.join(projectRoot, "dist", "pi", "model.js")).href);
const models = [...await modelModule.listBuiltinModels()].sort((left, right) => (
  left.providerName.localeCompare(right.providerName)
  || left.provider.localeCompare(right.provider)
  || left.model.localeCompare(right.model)
));
if (models.length === 0) throw new Error("Pi returned an empty built-in model catalog");

const artifact = {
  schemaVersion: 1,
  packages: {
    piAi: await packageVersion("@earendil-works", "pi-ai"),
    piCodingAgent: await packageVersion("@earendil-works", "pi-coding-agent"),
  },
  models,
};

await fs.mkdir(path.dirname(outputPath), { recursive: true });
const temporary = `${outputPath}.${process.pid}.tmp`;
await fs.writeFile(temporary, `${JSON.stringify(artifact)}\n`, "utf8");
await fs.rm(outputPath, { force: true });
await fs.rename(temporary, outputPath);
console.log(`[models] generated ${models.length} built-in models`);

async function packageVersion(scope, name) {
  const filePath = path.join(projectRoot, "node_modules", scope, name, "package.json");
  const value = JSON.parse(await fs.readFile(filePath, "utf8"));
  if (typeof value.version !== "string" || !value.version) throw new Error(`Missing version for ${scope}/${name}`);
  return value.version;
}
