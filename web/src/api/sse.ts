import { getTask } from "./tasks.ts";
import type { Task, TaskEvent } from "../types/api.ts";

export function connectTaskEvents(
  taskId: string,
  handlers: {
    onEvent(event: TaskEvent): void;
    onTerminal(task: Task): void;
    onError(error: Error): void;
  },
): () => void {
  let closed = false;
  let checking = false;
  const source = new EventSource(`/api/tasks/${encodeURIComponent(taskId)}/events`);
  const close = () => {
    if (closed) return;
    closed = true;
    source.close();
  };

  source.onmessage = (message) => {
    if (closed) return;
    try { handlers.onEvent(JSON.parse(message.data) as TaskEvent); }
    catch { handlers.onError(new Error("收到无法识别的任务状态")); }
  };
  source.onerror = () => {
    if (closed || checking) return;
    checking = true;
    void getTask(taskId).then((task) => {
      if (closed) return;
      if (task.status === "completed" || task.status === "failed" || task.status === "aborted") {
        handlers.onTerminal(task);
        close();
      }
    }).catch(() => undefined).finally(() => { checking = false; });
  };
  return close;
}
