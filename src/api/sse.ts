import { randomUUID } from "node:crypto";
import type { ServerResponse } from "node:http";
import type { TaskStatus } from "../tasks/types.js";

export type SseEventPayload =
  | { type: "task"; timestamp: string; status: TaskStatus; statusText: string; error?: string }
  | { type: "status"; timestamp: string; message: string }
  | { type: "output"; timestamp: string; index: number };

export type SseEvent = SseEventPayload & { id: string };
export type SseListener = (event: SseEvent) => void;

const MAX_BUFFERED_EVENTS = 100;

/** Per-task SSE hub with bounded reconnect replay. */
export class SseHub {
  private readonly instanceId = randomUUID();
  private readonly listeners = new Set<SseListener>();
  private readonly events: SseEvent[] = [];
  private nextId = 1;

  subscribe(listener: SseListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(payload: SseEventPayload): SseEvent {
    const event: SseEvent = { ...payload, id: `${this.instanceId}:${this.nextId++}` };
    this.events.push(event);
    if (this.events.length > MAX_BUFFERED_EVENTS) this.events.shift();
    for (const listener of this.listeners) {
      try { listener(event); } catch { /* one disconnected client cannot affect a task */ }
    }
    return event;
  }

  attach(res: ServerResponse, lastEventId?: string): void {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 3000\n\n");

    const replayAfter = lastEventId?.startsWith(`${this.instanceId}:`)
      ? Number(lastEventId.slice(this.instanceId.length + 1))
      : 0;
    for (const event of this.events) {
      if (Number(event.id.slice(this.instanceId.length + 1)) > replayAfter) writeEvent(res, event);
    }

    const unsubscribe = this.subscribe((event) => writeEvent(res, event));
    const heartbeat = setInterval(() => res.write(`: ping ${Date.now()}\n\n`), 15_000);
    heartbeat.unref?.();
    res.once("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
  }
}

function writeEvent(res: ServerResponse, event: SseEvent): void {
  res.write(`id: ${event.id}\n`);
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}
