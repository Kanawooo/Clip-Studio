import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { isOutputReadUnavailable, readOutput, videoContentHash, videoProbeFailure } from "./outputs.js";
import type { Task, TaskDelivery, TaskOutput } from "./types.js";

interface DeliveryInputIdentity {
  path: string;
  size: number;
  mtimeMs: number;
  sha256: string;
}

interface DeliveryReceipt {
  version: 1;
  index: number;
  output: string;
  bytes: number;
  sha256: string;
  duration: number;
  audioTarget: number;
  silent: boolean;
  rowSignature: string;
  inputs: DeliveryInputIdentity[];
}

export interface DeliveryScan {
  outputs: TaskOutput[];
  failures: string[];
}

export interface DeliveryProof {
  receiptMtimeMs: number;
  receiptSize: number;
  outputMtimeMs: number;
  outputSize: number;
  inputStamp: string;
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function same(left: string, right: string): boolean {
  const a = path.resolve(left), b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function validDelivery(value: unknown, count: number, taskId: string): value is TaskDelivery {
  if (!value || typeof value !== "object") return false;
  const delivery = value as Partial<TaskDelivery>;
  return delivery.version === 1 && Array.isArray(delivery.slots) && delivery.slots.length === count
    && delivery.slots.every((slot, index) => typeof slot === "string"
      && slot.startsWith(`Clip-Studio-${taskId}-${index + 1}-`)
      && /^[a-f0-9]{8}\.mp4$/i.test(slot.slice(`Clip-Studio-${taskId}-${index + 1}-`.length)))
    && new Set(delivery.slots.map((slot) => slot.toLowerCase())).size === count;
}

function explicitSilentDuration(request: string): number | undefined {
  // This is deliberately a narrow, explicit exception, not intent inference.
  const match = request.match(/(?:制作|做|输出|生成)?\s*(?:无声|静音|silent)\s*(?:视频|成片|片)?\s*(\d+(?:\.\d+)?)\s*(秒|分钟|分|s(?:ec(?:ond)?s?)?|min(?:ute)?s?)(?![a-z])/i);
  if (!match) return undefined;
  const duration = Number(match[1]) * (/^(?:分钟|分|min)/i.test(match[2]!) ? 60 : 1);
  return Number.isFinite(duration) && duration > 0 ? duration : undefined;
}

/** Only TaskManager writes the contract, outside Pi's native writable workspace. */
export async function prepareDelivery(task: Task, taskDir: string, workspace: string): Promise<void> {
  if (!task.delivery) {
    const slots: string[] = [];
    for (let index = 0; index < task.input.generateCount; index += 1) {
      let name: string;
      do { name = `Clip-Studio-${task.id}-${index + 1}-${randomUUID().slice(0, 8)}.mp4`; }
      while (await readOutput("交付槽位/stat", path.join(task.input.outputDir, name),
        () => fs.stat(path.join(task.input.outputDir, name))).then(() => true, (error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return false;
        throw error;
      }));
      slots.push(name);
    }
    task.delivery = { version: 1, slots };
  }
  if (!validDelivery(task.delivery, task.input.generateCount, task.id)) throw new Error("任务交付槽位无效");
  const directory = path.join(taskDir, "delivery");
  await fs.mkdir(directory, { recursive: true });
  const contract = {
    version: 1, taskId: task.id, slots: task.delivery.slots,
    workspace: path.resolve(workspace), outputDir: path.resolve(task.input.outputDir),
    audioDir: path.resolve(task.input.audioDir),
    silentDuration: explicitSilentDuration(task.input.taskRequest) ?? null,
  };
  const file = path.join(directory, "contract.json");
  const existing = await readOutput("交付契约/read", file, () => fs.readFile(file, "utf8")).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
  if (existing) {
    const saved = JSON.parse(existing) as typeof contract;
    if (JSON.stringify(saved) !== JSON.stringify(contract)) throw new Error("任务交付契约与原任务不一致，已停止以避免覆盖成片");
    return;
  }
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(contract, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

/** Read-only projection used by live SSE, retry, and persisted task recovery. */
export async function scanDeliveredOutputs(
  task: Task, taskDir: string, cache?: Map<number, DeliveryProof>, force = false, signal?: AbortSignal,
): Promise<DeliveryScan> {
  if (!validDelivery(task.delivery, task.input.generateCount, task.id)) throw new Error("任务交付槽位无效");
  const read = <T>(operation: string, file: string, action: () => Promise<T>) => readOutput(operation, file, action, { signal });
  const outputRoot = await read("输出目录/realpath", task.input.outputDir, () => fs.realpath(task.input.outputDir));
  const deliveryPath = path.join(taskDir, "delivery");
  const deliveryDir = await read("交付目录/realpath", deliveryPath, () => fs.realpath(deliveryPath));
  const proofs = new Map(cache);
  const outputs: TaskOutput[] = [];
  const failures: string[] = [];
  for (const [index, slot] of task.delivery.slots.entries()) {
    const output = path.join(outputRoot, slot);
    const receiptFile = path.join(deliveryDir, `${index + 1}.json`);
    let receipt: DeliveryReceipt;
    let receiptStat;
    try {
      const receiptReal = await read("完成凭据/realpath", receiptFile, () => fs.realpath(receiptFile));
      if (!inside(deliveryDir, receiptReal)) throw new Error("完成凭据路径越界");
      receiptStat = await read("完成凭据/stat", receiptReal, () => fs.stat(receiptReal));
      receipt = JSON.parse(await read("完成凭据/read", receiptReal, () => fs.readFile(receiptReal, "utf8"))) as DeliveryReceipt;
    } catch (error) {
      if (signal?.aborted || isOutputReadUnavailable(error)) throw error;
      proofs.delete(index);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") failures.push(`第 ${index + 1} 条完成凭据无效：${String(error)}`);
      continue;
    }
    let receiptOutput: string | undefined;
    try {
      if (typeof receipt.output === "string") {
        receiptOutput = await read("凭据输出/realpath", receipt.output, () => fs.realpath(receipt.output)).catch((error) => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
          throw error;
        });
      }
    } catch (error) {
      if (signal?.aborted || isOutputReadUnavailable(error)) throw error;
      proofs.delete(index);
      failures.push(`第 ${index + 1} 条凭据输出无法读取：${String(error)}`);
      continue;
    }
    const invalid = [
      receipt.version !== 1 && "版本无效",
      receipt.index !== index + 1 && "序号无效",
      (!receiptOutput || !same(receiptOutput, output)) && "文件名不符",
      (!Number.isFinite(receipt.audioTarget) || receipt.audioTarget <= 0) && "主音频时长无效",
      (!Number.isFinite(receipt.duration) || receipt.duration <= 0) && "成片时长无效",
      !/^[a-f0-9]{64}$/i.test(receipt.sha256 ?? "") && "文件哈希无效",
      !Array.isArray(receipt.inputs) && "输入文件列表无效",
    ].filter(Boolean);
    if (invalid.length) {
      failures.push(`第 ${index + 1} 条完成凭据无效：${invalid.join("、")}`);
      proofs.delete(index);
      continue;
    }
    try {
      const real = await read("正式成片/realpath", output, () => fs.realpath(output));
      if (!inside(outputRoot, real) || !same(real, output)) throw new Error("成片路径越界");
      const stat = await read("正式成片/stat", real, () => fs.stat(real));
      if (!stat.isFile() || stat.size !== receipt.bytes) throw new Error("成片文件已变化");
      const sourceStamps: string[] = [];
      for (const input of receipt.inputs) {
        if (!input || typeof input.path !== "string" || !/^[a-f0-9]{64}$/i.test(input.sha256)) throw new Error("音频/工程身份无效");
        const sourceStat = await read("工程或音频/stat", input.path, () => fs.stat(input.path));
        if (!sourceStat.isFile() || sourceStat.size !== input.size || sourceStat.mtimeMs !== input.mtimeMs) {
          throw new Error("音频或工程文件已变化");
        }
        sourceStamps.push(`${input.path}:${sourceStat.size}:${sourceStat.mtimeMs}`);
      }
      const inputStamp = sourceStamps.join("|");
      const cached = proofs.get(index);
      if (force || !cached || cached.receiptMtimeMs !== receiptStat.mtimeMs
        || cached.receiptSize !== receiptStat.size || cached.outputMtimeMs !== stat.mtimeMs
        || cached.outputSize !== stat.size || cached.inputStamp !== inputStamp) {
        const probeFailure = await videoProbeFailure(real);
        if (probeFailure) throw new Error(probeFailure);
        if (await videoContentHash(real, signal) !== receipt.sha256) throw new Error("成片内容已变化");
        proofs.set(index, {
          receiptMtimeMs: receiptStat.mtimeMs, receiptSize: receiptStat.size,
          outputMtimeMs: stat.mtimeMs, outputSize: stat.size, inputStamp,
        });
      }
      outputs.push({ id: `delivery-${index + 1}`, path: real });
    } catch (error) {
      if (signal?.aborted || isOutputReadUnavailable(error)) throw error;
      proofs.delete(index);
      failures.push(`第 ${index + 1} 条成片无法复用：${String(error)}`);
    }
  }
  signal?.throwIfAborted();
  if (cache) { cache.clear(); for (const [index, proof] of proofs) cache.set(index, proof); }
  return { outputs, failures };
}
