import { Play } from "lucide-react";
import { useState } from "react";
import { pickPath } from "../api/tasks.ts";
import type { TaskDraft } from "../types/api.ts";
import { PathPickerField } from "./PathPickerField.tsx";

interface TaskComposerProps {
  draft: TaskDraft;
  disabled: boolean;
  submitting: boolean;
  settingsReady: boolean;
  onChange(draft: TaskDraft): void;
  onSubmit(): void;
  onError(message: string): void;
}

export function TaskComposer(props: TaskComposerProps) {
  const [picking, setPicking] = useState<"referenceVideo" | "assetsDir" | "audioDir" | "outputDir" | null>(null);
  const update = <K extends keyof TaskDraft>(key: K, value: TaskDraft[K]) => {
    props.onChange({ ...props.draft, [key]: value });
  };

  const choose = async (key: "referenceVideo" | "assetsDir" | "audioDir" | "outputDir", type: "file" | "directory", title: string) => {
    if (picking) return;
    setPicking(key);
    try {
      const result = await pickPath(type, title, props.draft[key]);
      if (!result.cancelled && result.path) update(key, result.path);
    } catch (error) {
      props.onError(error instanceof Error ? error.message : "无法打开路径选择窗口");
    } finally {
      setPicking(null);
    }
  };

  return (
    <section className="card composer-card" aria-labelledby="new-task-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">视频任务</p>
          <h1 id="new-task-title" tabIndex={-1}>选择素材，直接制作</h1>
          <p className="heading-copy">提供路径、数量和剪辑要求，Pi 会执行到成片输出。</p>
        </div>
      </div>

      <div className="field-group brief-field">
        <label htmlFor="task-request">剪辑要求</label>
        <textarea
          id="task-request"
          value={props.draft.taskRequest}
          disabled={props.disabled}
          onChange={(event) => update("taskRequest", event.target.value)}
          placeholder="例如：模仿参考视频的节奏和画面组织，筛掉误拍、晃动、空镜头和没有意义的素材，制作一条完整成片。"
          rows={7}
        />
        <span className="field-hint">可留空；留空时会默认模仿参考视频并筛掉无意义画面。</span>
      </div>

      <div className="paths-grid">
        <PathPickerField
          id="reference-video"
          label="参考视频"
          kind="file"
          value={props.draft.referenceVideo}
          placeholder="选择需要模仿的视频"
          disabled={props.disabled}
          pickDisabled={picking !== null}
          picking={picking === "referenceVideo"}
          onChange={(value) => update("referenceVideo", value)}
          onPick={() => void choose("referenceVideo", "file", "选择参考视频")}
        />
        <PathPickerField
          id="assets-directory"
          label="素材目录"
          kind="directory"
          value={props.draft.assetsDir}
          placeholder="选择拍摄素材所在目录"
          disabled={props.disabled}
          pickDisabled={picking !== null}
          picking={picking === "assetsDir"}
          onChange={(value) => update("assetsDir", value)}
          onPick={() => void choose("assetsDir", "directory", "选择素材目录")}
        />
        <PathPickerField
          id="audio-directory"
          label="音频目录"
          kind="directory"
          value={props.draft.audioDir}
          placeholder="选择音乐或录音所在目录"
          disabled={props.disabled}
          pickDisabled={picking !== null}
          picking={picking === "audioDir"}
          onChange={(value) => update("audioDir", value)}
          onPick={() => void choose("audioDir", "directory", "选择音频目录")}
        />
        <PathPickerField
          id="output-directory"
          label="输出目录"
          kind="directory"
          value={props.draft.outputDir}
          placeholder="选择成片保存位置"
          disabled={props.disabled}
          pickDisabled={picking !== null}
          picking={picking === "outputDir"}
          onChange={(value) => update("outputDir", value)}
          onPick={() => void choose("outputDir", "directory", "选择输出目录")}
        />
      </div>

      <div className="composer-footer">
        <div className="count-control">
          <label htmlFor="generate-count">生成数量</label>
          <input
            id="generate-count"
            type="number"
            min={1}
            max={20}
            disabled={props.disabled}
            value={props.draft.generateCount}
            onChange={(event) => update("generateCount", Math.max(1, Number.parseInt(event.target.value, 10) || 1))}
          />
        </div>
        <button
          className="primary-button start-button"
          type="button"
          disabled={props.disabled || props.submitting}
          onClick={props.onSubmit}
        >
          <Play size={18} fill="currentColor" />
          {props.submitting ? "正在准备…" : props.settingsReady ? "开始制作" : "先配置模型"}
        </button>
      </div>
    </section>
  );
}
