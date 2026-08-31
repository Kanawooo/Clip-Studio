export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly payload?: unknown) {
    super(message);
    this.name = "ApiError";
  }
}

export type TransportFailure = "timeout" | "network" | "aborted";

export class TransportError extends Error {
  constructor(readonly failure: TransportFailure, message: string, readonly cause?: unknown) {
    super(message);
    this.name = "TransportError";
  }
}

export interface RequestJsonOptions extends RequestInit {
  timeoutMs?: number;
}

export async function requestJson<T>(path: string, options: RequestJsonOptions = {}): Promise<T> {
  const { timeoutMs, signal: outerSignal, ...requestOptions } = options;
  const headers = new Headers(options.headers);
  if (options.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(outerSignal?.reason);
  if (outerSignal?.aborted) abortFromCaller();
  else outerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = timeoutMs === undefined ? undefined : window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  let response: Response;
  try {
    response = await fetch(path, { ...requestOptions, headers, signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new TransportError("timeout", "本地服务响应超时", error);
    if (outerSignal?.aborted || isAbortError(error)) {
      throw new TransportError("aborted", "请求已取消", error);
    }
    const detail = error instanceof Error ? error.message : "无法连接本地服务";
    throw new TransportError("network", `无法连接本地服务：${detail}`, error);
  } finally {
    if (timeout !== undefined) window.clearTimeout(timeout);
    outerSignal?.removeEventListener("abort", abortFromCaller);
  }

  const contentType = response.headers.get("content-type") ?? "";
  const data: unknown = contentType.includes("application/json")
    ? await response.json()
    : await response.text();
  if (!response.ok) {
    const message = typeof data === "object" && data && "error" in data && typeof data.error === "string"
      ? data.error
      : typeof data === "string" && data.trim() ? data : `请求失败（${response.status}）`;
    throw new ApiError(response.status, message, data);
  }
  return data as T;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException
    ? error.name === "AbortError"
    : Boolean(error && typeof error === "object" && "name" in error && error.name === "AbortError");
}
