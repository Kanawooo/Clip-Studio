import type { CreateTaskInput } from "../tasks/types.js";

export interface TaskExecutionPaths {
  workspace: string;
  mediaCacheScript: string;
  renderQueueScript: string;
}

/** One compact instruction is the entire backend-owned video workflow. */
export function buildTaskPrompt(input: CreateTaskInput, paths: TaskExecutionPaths): string {
  return [
    "直接完成下面的视频剪辑任务并把最终成片写入指定输出目录。不要提问，不要等待确认。",
    `参考视频：${input.referenceVideo.trim()}`,
    `素材目录：${input.assetsDir.trim()}`,
    `音频目录：${input.audioDir.trim()}`,
    `输出目录：${input.outputDir.trim()}`,
    `成片数量：${input.generateCount}`,
    `剪辑要求：${input.taskRequest.trim()}`,
    "按当前任务需要使用项目本地的 ClipSkills 和 HyperFrames skill，并通过已安装的 HyperFrames CLI 完成制作。",
    `项目脚本必须使用绝对入口：素材索引 ${paths.mediaCacheScript}；渲染队列 ${paths.renderQueueScript}。渲染清单固定写入 ${paths.workspace}/render-manifest.json；不得从任务工作目录使用相对 .pi 路径。`,
    "本任务只做一次完整素材分析：先统一分析参考视频、素材目录和音频目录，并在当前 Session 内复用镜头分类、时间区间和选材结果；后续不得重新完整扫描或分析这些路径，只有单个候选镜头信息不足时才可局部检查。",
    "使用 ClipSkills 本地素材索引复用未变化文件的基础观察；参考视频每秒检查，长素材每三秒初筛，候选区间再定点细看；本次参考的剪辑选择重新判断。",
    "工程完成后按 HyperFrames 项目技能的渲染清单调用本地队列 CLI，等待全部成片完成并验证。",
    ...(input.generateCount > 1 ? [
      "生成多条成片时，把首次分析结果分配为不同选材方案：优先使用不同源文件、不同时间区间、不同开场和镜头组织，禁止复用相同长片段或只换顺序；素材不足可少量复用，但不要重新分析或因此少交成片。",
    ] : []),
    "只做本次剪辑与渲染：不得安装依赖、更新 skill、运行 doctor、认证、recipe 或发布流程；不得检查工作台源码或创建测试工程。CLI 环境错误只重试一次，仍失败就原样报告错误并停止。",
  ].join("\n");
}

/** One short Pi turn for an explicit retry under the original task ID. */
export function buildResumePrompt(
  input: CreateTaskInput,
  restoredSession: boolean,
  verifiedOutputs: string[],
  paths: TaskExecutionPaths,
): string {
  const context = restoredSession ? "继续上次的视频任务，不重做已完成步骤。" : [
    "继续原视频任务；先从工作目录现有文件恢复已完成步骤。",
    `参考视频：${input.referenceVideo.trim()}`,
    `素材目录：${input.assetsDir.trim()}`,
    `音频目录：${input.audioDir.trim()}`,
    `输出目录：${input.outputDir.trim()}`,
    `成片数量：${input.generateCount}`,
    `剪辑要求：${input.taskRequest.trim()}`,
  ].join("\n");
  return [
    context,
    `已验证成片：${verifiedOutputs.length ? verifiedOutputs.join("；") : "暂无"}。`,
    "检查当前任务工作目录的素材索引、工程和渲染清单；从最早未完成步骤继续，只补缺失成片。素材基础信息复用有效缓存，本次参考的选材判断保持原任务要求。",
    `已有 ${paths.workspace}/render-manifest.json 时直接续跑清单。渲染队列必须使用绝对入口 ${paths.renderQueueScript}，素材索引必须使用绝对入口 ${paths.mediaCacheScript}；不得读取 Session 日志、其他任务、Trellis 或程序实现来猜测命令。`,
    "仅通过项目本地 ClipSkills / HyperFrames 及其 CLI 工作，不安装依赖、不更新技能、不执行认证、doctor、发布或测试工程；直接完成并输出，失败时说明实际错误。",
  ].join("\n");
}
