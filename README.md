# Clip Studio

本地运行的 AI 视频制作工具。选择参考视频、素材和音频，填写数量与剪辑要求，由 Pi 调用 ClipSkills 和 HyperFrames 完成制作。

[下载 Windows 版](https://github.com/Kanawooo/Clip-Studio/releases/latest) · [快速开始](#快速开始) · [制作视频](#制作视频) · [源码开发](#源码开发)

## 主要功能

- 参考视频提供剪辑风格，成片时长按编排后的主音频确定。
- 一次制作 **1–20 条视频**，多条成片优先使用不同素材、时间区间和开场。
- 同一任务分析一次素材，后续成片沿用分析结果。
- 根据本机资源安排并行渲染，完成后检查视频与音频时长。
- 查看制作状态、耗时和成片；历史任务可回看，失败后可在原任务中继续。

## 快速开始

适用于 **Windows 10 / 11 x64**。首次安装需要网络，制作时需要可用的多模态模型服务与 API Key。

1. 从 [GitHub Releases](https://github.com/Kanawooo/Clip-Studio/releases/latest) 下载 `Clip-Studio-Windows-x64.zip`。
2. 完整解压到英文路径，例如 `D:\Clip Studio`，进入文件夹。
3. 双击 [start.bat](start.bat)。程序会检查已有环境、下载缺失组件，并打开 [本地页面](http://127.0.0.1:8787)。

安装目录允许空格；参考视频、素材、音频和输出路径支持中文与空格。下载版已包含前后端构建结果。

<details>
<summary>首次启动会准备哪些组件？</summary>

首次启动会按需调用 [install.bat](install.bat)，检查以下组件：

| 组件 | 用途 |
| --- | --- |
| Node.js、Pi、HyperFrames | 运行本地服务、AI 任务与渲染工具 |
| FFmpeg / FFprobe | 视频抽帧、编解码与成片检查 |
| Git Bash | 执行剪辑命令 |
| Python、librosa、NumPy、SoundFile | 音频分析与处理 |
| whisper.cpp、`small.en` 模型 | 音频转写 |
| Chrome Headless Shell | 渲染视频工程 |

通过兼容性检查的本机组件直接复用；新下载的组件保存在程序目录。下载优先使用镜像或公共 GitHub 加速来源，失败时有限换源并回退官方，文件按哈希或依赖锁文件校验。

缺失 FFmpeg 时，按官方元数据下载 BtbN 最新 Release；后续启动复用已安装版本。

</details>

## 模型设置

主模型需要同时支持**文本和图片输入**，用于理解参考画面、筛选素材和做剪辑判断。

1. 打开“模型设置”，选择内置服务商或自定义服务。
2. 填写 API Key，选择模型；自定义服务还需填写服务商和 Base URL。
3. 点击“测试连接、图片与思考能力”，通过后保存设置。

连接测试会发送真实文本请求；图片能力优先读取模型能力信息，无法确认时再发图片请求。测试和制作会产生所选模型服务的用量费用。

勾选“在这台电脑上记住主模型密钥”后，密钥通过 Windows 当前用户凭据加密，保存在程序目录的 `.runtime/` 中。

## 制作视频

打开“新建任务”，填写以下内容：

| 输入 | 填写内容 |
| --- | --- |
| 参考视频 | 用于参考风格、节奏和画面组织的视频 |
| 素材目录 | 待剪辑的拍摄素材所在文件夹 |
| 音频目录 | 配音、录音或音乐所在文件夹 |
| 输出目录 | 最终成片的保存位置，请与素材、音频目录分开 |
| 生成数量 | 1–20 条 |
| 剪辑要求 | 可写风格、选材等要求；留空时默认模仿参考视频并筛掉无意义画面 |

点击“开始制作”，即可查看状态、耗时和已完成视频。正式成片经过验证后显示在结果区，可播放或打开输出目录。

同一时间运行一个任务。点击“停止”可中止制作；失败或停止后，点击“重试 / 继续制作”沿用原任务、有效成片和已有工作文件。修改制作要求时，新建任务提交。

<details>
<summary>素材怎样分析和复用？</summary>

- 参考视频按每秒一帧检查，长素材按每三秒一帧初筛，候选片段再查看细节。
- 抽帧按实际画面比例生成宫格图，模型批量看图并记录选材时间点。
- 同一任务的多条成片复用本次分析，候选信息不足时局部补看。
- 新任务可复用未变化素材的抽帧、宫格图和匹配配置的音频转写；画面由模型重新查看，并按当前参考视频重新选材。

</details>

## 本地数据

| 路径 | 内容 |
| --- | --- |
| `.runtime/` | 下载的运行组件、安装状态、项目 Python 环境、加密设置和服务日志 |
| `.runtime/whisper/models/` | Whisper `small.en` 模型 |
| `.runtime/media-cache/v1/` | 素材信息、抽帧、宫格图与转写缓存 |
| `data/tasks/` | 任务状态、Pi Session 和任务工作区 |
| 用户选择的输出目录 | 最终成片 |

## 源码开发

需要 **Node.js 22.19.0 或更高版本**。仓库包含前后端源码、两套项目技能，以及安装、构建和打包脚本。

```powershell
git clone https://github.com/Kanawooo/Clip-Studio.git
cd Clip-Studio
npm ci
npm --prefix web ci
npm run build
```

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 启动前后端开发服务 |
| `npm run build` | 构建后端 `dist/` 与前端 `web/dist/` |
| `npm run package:release` | 构建、检查并生成 Windows ZIP |

首次准备视频制作环境可运行 `start.bat`，由安装器检查并补齐剪辑组件。

### 项目结构

```text
前端表单 → 本地服务（HTTP / SSE）→ Pi Session → 成片
                                  ├─ ClipSkills：选材、音频分析与剪辑判断
                                  └─ HyperFrames：工程编排与 CLI 渲染
```

前端使用 React + Vite，本地服务使用 Node.js + TypeScript。首次制作创建一个原生 Pi Session 并提交一次任务提示，Pi 按需读取项目技能。服务端管理模型设置、任务状态与输出验证，界面通过 SSE 接收更新。

## 许可证

Clip Studio 使用 [MIT License](LICENSE)。第三方组件及项目内技能的许可证与来源见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
