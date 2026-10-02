import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { redactSecrets } from "../security.js";

/** Observe the native request, without consuming bodies or logging URLs/headers.
 * Unsupported fetch adapters keep their own transport. Retries remain Pi-owned. */
export function observeRequestFailure(agent: Pick<AgentSession["agent"], "streamFunction">, secret?: string) {
  const original = agent.streamFunction;
  let status: number | undefined, transportCause: string | undefined;
  const safe = (value: string) => redactSecrets(value, [secret]).replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 1200);
  const causeText = (error: unknown): string => {
    const parts: string[] = [];
    let current: unknown = error;
    const seen = new Set<unknown>();
    while (current && typeof current === "object" && !seen.has(current) && parts.length < 3) {
      seen.add(current);
      const value = current as { message?: unknown; code?: unknown; cause?: unknown };
      const message = typeof value.message === "string" ? value.message : "";
      const code = typeof value.code === "string" && /^[A-Z_0-9]{1,60}$/.test(value.code) ? value.code : "";
      if (message || code) parts.push(safe([code, message].filter(Boolean).join(": ")));
      current = value.cause;
    }
    return parts.join("；");
  };
  agent.streamFunction = (model, context, options) => {
    status = undefined; transportCause = undefined;
    const native = options ?? {};
    const observed = { ...native, onResponse: async (...args: Parameters<NonNullable<typeof native.onResponse>>) => {
      status = args[0].status;
      return native.onResponse?.(...args);
    } };
    // These pinned adapters explicitly support fetch injection. Do not inject
    // into Google/Vertex or interfere with native WebSocket selection.
    if (["openai-completions", "anthropic-messages"].includes(model.api)) {
      const fetch = native.fetch ?? globalThis.fetch;
      observed.fetch = async (...args: Parameters<typeof fetch>) => {
        try {
          const response = await fetch(...args);
          status = response.status; transportCause = undefined;
          return response;
        } catch (error) {
          status = undefined; transportCause = causeText(error) || "网络传输失败，底层未提供详细原因";
          throw error;
        }
      };
    }
    return original(model, context, observed);
  };
  return {
    describe(reason: string) {
      const detail = transportCause ?? (status !== undefined && status >= 400 ? `上游 HTTP ${status}` : undefined);
      if (detail) return safe(!reason.includes(detail) ? `${reason}；${detail}` : reason);
      return safe(/^(?:Connection error|Request timed out\.?|This operation was aborted)$/i.test(reason)
        ? `${reason}；SDK 未提供更详细的底层原因` : reason);
    },
    dispose() { agent.streamFunction = original; },
  };
}
