# Clip Studio

Clip Studio 是一个本地视频制作入口。填写参考视频、素材目录、音频目录、输出目录、成片数量和剪辑要求后，Pi 会调用项目内的 ClipSkills 与 HyperFrames，通过 CLI 完成视频制作。

## 功能

- 固定输入参考视频、素材目录、音频目录和输出目录
- 一次提交 1–20 条成片
- 多模态主模型直接理解参考画面和素材
- 每个任务使用一个原生 Pi Session 和一次任务提示
- 一个任务统一分析一次素材，后续成片复用本次分析结果
- 多条成片分配不同源文件和时间区间
- 展示任务状态、当前说明、耗时和有效成片
- 查看历史任务的状态与成片

## 系统要求

Clip Studio 支持 Windows 10 和 Windows 11 x64。首次安装使用 HTTPS 网络下载固定版本的本地运行组件。视频制作期间连接用户配置的模型服务。

## 安装与启动

将完整目录解压到英文路径，例如 `D:\Clip Studio`，然后双击 [start.bat](start.bat)。安装目录允许空格。参考视频、素材、音频和输出路径支持中文与空格。

首次启动会自动运行 [install.bat](install.bat)，安装并验证以下组件：

- Node.js 与锁定的 Pi、HyperFrames 生产依赖
- FFmpeg 与 FFprobe
- Git Bash
- Python、librosa、NumPy 与 SoundFile
- whisper.cpp 与 `small.en` 模型
- Chrome Headless Shell

运行组件保存在 `.runtime/`。生产发行包已经包含后端和前端构建结果。环境验证完成后，服务会打开 [http://127.0.0.1:8787](http://127.0.0.1:8787)。

## 模型设置

“模型设置”支持内置模型和自定义模型服务。主模型需要通过真实文本连接与图片输入测试。服务端保存模型能力凭证，并在创建任务时校验凭证与当前模型配置。

启用“记住密钥”后，API Key 使用 Windows 当前用户凭据加密并保存到 `.runtime/`。任务接口返回脱敏后的模型配置。

## 制作视频

1. 选择参考视频。
2. 选择素材目录、音频目录和输出目录。
3. 填写成片数量和剪辑要求。
4. 点击“开始制作”。

Pi 在当前 Session 中选择任务需要的 ClipSkills 和 HyperFrames skill，完成剪辑判断、工程制作和 CLI 渲染。输出目录中的新增或修改视频经过 FFprobe 验证后进入结果区。

同一时间运行一个制作任务。停止按钮会终止当前 Pi Session。新的制作要求通过新建任务提交。

## 本地数据

| 路径 | 内容 |
| --- | --- |
| `.runtime/` | 本地运行组件、安装状态、加密设置和服务日志 |
| `.runtime/whisper/models/` | Whisper `small.en` 模型 |
| `data/tasks/` | 任务状态、Pi Session 和任务工作区 |
| 用户选择的输出目录 | 最终成片 |

## 执行结构

```text
固定任务表单 → 本地 HTTP/SSE → 一个 Pi Session
                                 ├─ ClipSkills：剪辑判断
                                 └─ HyperFrames：工程与 CLI 渲染
```

本地服务负责 HTTP、SSE、Pi Session 创建、模型配置、任务状态和输出验证。Pi 负责视频分析、剪辑决策、技能选择、工程制作和渲染。

## 许可证

Clip Studio 使用 [MIT License](LICENSE)。第三方组件及项目内技能的许可证与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
