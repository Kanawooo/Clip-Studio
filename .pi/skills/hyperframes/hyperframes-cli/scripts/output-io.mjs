// Internal read-only verification support. Not a Pi CLI or a renderer.
const retryCodes = new Set(["UNKNOWN", "EBUSY", "EAGAIN", "EMFILE", "ENFILE", "EIO"]);
const readCalls = new Set(["realpath", "readlink", "stat", "lstat", "fstat", "open", "read", "readdir", "scandir"]);
export const OUTPUT_READ_FAILURE_LIMIT = 10;
export const OUTPUT_READ_FAILURE_WINDOW_MS = 15_000;

export class OutputReadUnavailable extends Error {
  constructor(operation, file, cause, attempts) {
    super(`输出验证读取暂不可用（${operation}，${cause.code}/${cause.syscall}，尝试 ${attempts} 次）：${cause.message}`, { cause });
    this.name = "OutputReadUnavailable";
    this.operation = operation;
    this.path = file;
    this.code = cause.code;
    this.syscall = cause.syscall;
    this.errno = cause.errno;
    this.attempts = attempts;
  }
}

function retryableFsError(error) {
  return error instanceof Error && retryCodes.has(error.code) && readCalls.has(error.syscall);
}

export function isOutputReadUnavailable(error) {
  return error instanceof OutputReadUnavailable;
}

export function outputReadRecoveryExhausted(count, firstFailureAt, now = Date.now()) {
  return count >= OUTPUT_READ_FAILURE_LIMIT || now - firstFailureAt >= OUTPUT_READ_FAILURE_WINDOW_MS;
}

export function waitForOutputRead(ms, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const stopped = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener("abort", stopped); resolve(); }, ms);
    signal?.addEventListener("abort", stopped, { once: true });
  });
}

/** Only callers' fixed, read-only operations belong here; never writes/processes. */
export async function readOutput(operation, file, read, { signal } = {}) {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    signal?.throwIfAborted();
    try {
      const value = await read();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (!retryableFsError(error)) throw error;
      if (attempt === 3) throw new OutputReadUnavailable(operation, file, error, attempt);
      await waitForOutputRead(attempt === 1 ? 100 : 300, signal);
    }
  }
  throw new Error("输出读取尝试次数无效");
}

/** For forced verification/recovery only; normal work has no fixed delay. */
export async function recoverOutputRead(read, { signal } = {}) {
  let count = 0, firstFailureAt;
  while (true) {
    signal?.throwIfAborted();
    try {
      const value = await read();
      signal?.throwIfAborted();
      return value;
    } catch (error) {
      signal?.throwIfAborted();
      if (!isOutputReadUnavailable(error)) throw error;
      firstFailureAt ??= Date.now();
      count += 1;
      if (outputReadRecoveryExhausted(count, firstFailureAt)) {
        throw new Error(`输出验证连续读取失败（${count} 轮）：${error.message}`, { cause: error });
      }
      await waitForOutputRead(1_000, signal);
    }
  }
}
