/** One compact instruction is the entire backend-owned video workflow. */
export function buildTaskPrompt(input) {
    return [
        "直接完成下面的视频剪辑任务并把最终成片写入指定输出目录。不要提问，不要等待确认。",
        `参考视频：${input.referenceVideo.trim()}`,
        `素材目录：${input.assetsDir.trim()}`,
        `音频目录：${input.audioDir.trim()}`,
        `输出目录：${input.outputDir.trim()}`,
        `成片数量：${input.generateCount}`,
        `剪辑要求：${input.taskRequest.trim()}`,
        "按当前任务需要使用项目本地的 ClipSkills 和 HyperFrames skill，并通过已安装的 HyperFrames CLI 完成制作。",
        "本任务只做一次完整素材分析：先统一分析参考视频、素材目录和音频目录，并在当前 Session 内复用镜头分类、时间区间和选材结果；后续不得重新完整扫描或分析这些路径，只有单个候选镜头信息不足时才可局部检查。",
        ...(input.generateCount > 1 ? [
            "生成多条成片时，把首次分析结果分配为不同选材方案：优先使用不同源文件、不同时间区间、不同开场和镜头组织，禁止复用相同长片段或只换顺序；素材不足可少量复用，但不要重新分析或因此少交成片。",
        ] : []),
        "只做本次剪辑与渲染：不得安装依赖、更新 skill、运行 doctor、认证、recipe 或发布流程；不得检查工作台源码或创建测试工程。CLI 环境错误只重试一次，仍失败就原样报告错误并停止。",
    ].join("\n");
}
