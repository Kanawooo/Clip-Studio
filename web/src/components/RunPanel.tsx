import { CircleCheck, CircleStop, FolderOpen, LoaderCircle, OctagonAlert, Video } from "lucide-react";
import { useEffect, useState } from "react";
import { getTaskOutputVideoUrl, revealTaskOutput } from "../api/tasks.ts";
import type { Task, TaskStatus } from "../types/api.ts";

interface RunPanelProps {
  task: Task | null;
  blockedByRunningTask?: boolean;
  aborting: boolean;
  onAbort(): void;
  onError(message: string): void;
}

const STATUS: Record<TaskStatus, { label: string; icon: typeof LoaderCircle }> = {
  pending: { label: "准备中", icon: LoaderCircle },
  running: { label: "制作中", icon: LoaderCircle },
  completed: { label: "已完成", icon: CircleCheck },
  failed: { label: "失败", icon: OctagonAlert },
  aborted: { label: "已停止", icon: CircleStop },
};

export function RunPanel({ task, blockedByRunningTask = false, aborting, onAbort, onError }: RunPanelProps) {
  const elapsed = useTaskElapsed(task);

  if (!task) {
    return (
      <section className="run-panel empty-run" aria-label="任务状态">
        <Video size={24} aria-hidden="true" />
        <strong>{blockedByRunningTask ? "已有任务正在制作" : "等待开始制作"}</strong>
        <p>{blockedByRunningTask ? "从历史任务打开当前任务，可查看进度或停止制作。" : "填写路径与要求后，Pi 会直接制作并输出成片。"}</p>
      </section>
    );
  }

  const status = STATUS[task.status];
  const StatusIcon = status.icon;
  const active = task.status === "pending" || task.status === "running";
  const reveal = async () => {
    try { await revealTaskOutput(task.id); }
    catch (error) { onError(error instanceof Error ? error.message : "无法打开输出目录"); }
  };

  return (
    <section className={`run-panel status-${task.status}`} aria-label="任务状态">
      <div className="run-status">
        <div className="status-title">
          <div className="status-title-main">
            <span className="status-icon"><StatusIcon className={active ? "spin" : ""} size={20} /></span>
            <div>
              <p className="eyebrow">当前任务</p>
              <h2>{status.label}</h2>
            </div>
          </div>
          <span className="elapsed-time">耗时 {elapsed}</span>
        </div>
        <p className="status-message" role="status">{task.statusText}</p>
        {task.error ? <p className="task-error">{task.error}</p> : null}
        <div className="run-actions">
          {active ? (
            <button className="stop-button" type="button" disabled={aborting} onClick={onAbort}>
              <CircleStop size={17} />{aborting ? "正在停止…" : "停止"}
            </button>
          ) : null}
          <button className="secondary-button" type="button" onClick={() => void reveal()}>
            <FolderOpen size={17} />打开输出目录
          </button>
        </div>
      </div>

      {task.outputs.length > 0 ? (
        <div className="outputs-section">
          <div className="outputs-heading">
            <h3>成片</h3>
            <span>{task.outputs.length} 条</span>
          </div>
          <div className="outputs-grid">
            {task.outputs.map((output, index) => (
              <article className="output-card" key={output.id}>
                <video controls preload="metadata" src={getTaskOutputVideoUrl(task.id, index)} />
                <div>
                  <strong>成片 {index + 1}</strong>
                  <span title={output.path}>{output.path}</span>
                </div>
              </article>
            ))}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function useTaskElapsed(task: Task | null): string {
  const active = task?.status === "pending" || task?.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active, task?.id]);

  if (!task) return "00:00:00";
  const startedAt = Date.parse(task.createdAt);
  const finishedAt = active ? now : Date.parse(task.finishedAt ?? "");
  if (!Number.isFinite(startedAt) || !Number.isFinite(finishedAt)) return "--:--:--";
  return formatElapsed(Math.max(0, finishedAt - startedAt));
}

function formatElapsed(milliseconds: number): string {
  const totalSeconds = Math.floor(milliseconds / 1_000);
  const hours = Math.floor(totalSeconds / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return [hours, minutes, seconds].map((value) => String(value).padStart(2, "0")).join(":");
}
