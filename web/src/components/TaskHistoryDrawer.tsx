import { Clock3, X } from "lucide-react";
import type { Task, TaskStatus } from "../types/api.ts";

interface TaskHistoryDrawerProps {
  open: boolean;
  tasks: Task[];
  selectedTaskId: string | null;
  onClose(): void;
  onSelect(taskId: string): void;
}

const STATUS_LABELS: Record<TaskStatus, string> = {
  pending: "准备中",
  running: "制作中",
  completed: "已完成",
  failed: "失败",
  aborted: "已停止",
};

export function TaskHistoryDrawer(props: TaskHistoryDrawerProps) {
  if (!props.open) return null;

  return (
    <div className="drawer-layer" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && props.onClose()}>
      <aside className="drawer history-drawer" role="dialog" aria-modal="true" aria-labelledby="history-title">
        <header className="drawer-header">
          <div className="drawer-title"><span><Clock3 size={18} /></span><div><p className="eyebrow">任务</p><h2 id="history-title">历史任务</h2></div></div>
          <button className="icon-button" type="button" onClick={props.onClose} aria-label="关闭历史任务"><X size={18} /></button>
        </header>

        <div className="drawer-body history-list">
          {props.tasks.length === 0 ? (
            <div className="history-empty"><Clock3 size={22} /><strong>还没有历史任务</strong><p>开始制作后，任务会显示在这里。</p></div>
          ) : props.tasks.map((task) => (
            <button
              className={`history-item${props.selectedTaskId === task.id ? " selected" : ""}`}
              type="button"
              key={task.id}
              aria-pressed={props.selectedTaskId === task.id}
              onClick={() => props.onSelect(task.id)}
            >
              <span className="history-item-top">
                <span className={`history-status status-${task.status}`}><i aria-hidden="true" />{STATUS_LABELS[task.status]}</span>
                <time dateTime={task.createdAt}>{formatTaskTime(task.createdAt)}</time>
              </span>
              <strong>{task.input.taskRequest}</strong>
              <span className="history-item-meta">要求 {task.input.generateCount} 条 · 成片 {task.outputs.length} 条</span>
            </button>
          ))}
        </div>
      </aside>
    </div>
  );
}

function formatTaskTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间未知";
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}
