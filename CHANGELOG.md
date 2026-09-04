# 更新日志

本文件记录项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.2.0] - 2026-09-04

### BREAKING

- **移除 Shadow Workspace** — Agent 直接在 Main 工作区编辑；会话开始时记录 baseline（Git HEAD 或 `.WSLDeck/sessions/<id>/baseline/` 快照）。Diff 卡片对比 Main vs baseline；**Keep** 仅确认/收起；**Cancel** 从 baseline 恢复 Main。删除 `wsldeck.shadow.root` 设置。激活时自动删除遗留 `.WSLDeck/shadows`；可手动清理旧版 `~/.local/share/wsldeck-extension/` 目录。

### 变更

- **Cursor ACP 认证** — 要求先在目标 Linux / WSL 发行版运行 `agent login`；收到 `cursor_login` capability 后调用 `authenticate(cursor_login)` 加载 CLI 凭据。ACP 固定清除 `CURSOR_API_KEY` 并设置 `NO_OPEN_BROWSER=1`，不会自动拉起登录网页。
- **Provider 生命周期** — 同一 Provider 的 session/ACP 初始化去重，同一 Provider 禁止并发 Prompt；Cursor 与 Codex 仍可维护相互独立的会话。

### 修复

- **Windows Shadow 创建** — （已 superseded）此前 Shadow 路径修复；现改为无 Shadow 架构。
- **Cursor ACP 稳定性** — 修复 ACP 空闲退出后下一轮必然失败、初始化失败遗留进程、dispose 后 RPC 永久 pending，以及 Stop 重复发送 `session/cancel`。
- **Cursor 后台运行** — 切换到另一 Provider 后，原 Provider 的回复、工具事件和错误仍写入自己的 lane，不再丢失。
- **Cursor/Codex 并发** — 修复快速模型切换、目录预热和 Prompt 可能重复创建 session 或 ACP 进程的问题。
- **Codex 失败判定** — 非零退出即使已有部分回答也会报告失败；环境解析或 CLI 定位失败时同步更新 session 状态。
- **Agent Log 编码** — Windows→WSL 启动设置 `WSL_UTF8=1`，过滤纯 NUL stderr，并避免把大型 Unicode JSON 误判为 UTF-16LE。

### 测试

- 97 项自动化测试；新增 Provider 生命周期、并发会话、Codex 部分输出后失败、ACP pending RPC 回收、无浏览器认证环境及大型 Unicode JSON 回归覆盖。

## [0.1.3] - 2026-09-04

Windows 本机 VS Code 下 Codex/Cursor 继承 WSL login shell 环境（PATH、proxy、NVM 等）。

### 新增

- **Agent Environment Resolver** — [`linuxAgentEnvironment.ts`](src/workspace/linuxAgentEnvironment.ts)：一次 `bash -lc printenv -0` 探测并缓存；经 `wsl ... env KEY=val` 注入 CLI
- **`wsldeck.agent.env`** — 覆盖自动探测的 env（如 `HTTPS_PROXY`）
- **`wsldeck.agent.logEnv`** — 首次 CLI 启动时在 Agent Log 打印 env 摘要（密钥打码）
- Doctor **Agent env** 行：PATH/proxy 摘要、**WSL host** 宿主机 IP（NAT 下配 proxy）；检测 `127.0.0.1` proxy 并警告

### 变更

- `resolveLinuxCommand` 使用 resolved `PATH` + `bash -c command -v`，不再单独 `bash -lc` 探测
- Cursor API key 从 resolved env / 设置读取，移除 `bash -lc printf CURSOR_API_KEY`

[0.2.0]: https://github.com/ADaozz/wsl_deck_extension/releases/tag/v0.2.0
[0.1.3]: https://github.com/ADaozz/wsl_deck_extension/releases/tag/v0.1.3

## [0.1.2] - 2026-09-04

Windows 本机 VS Code 下 Codex/Cursor CLI 经 WSL 桥接执行。

### 新增

- **Linux CLI 桥接** — [`linuxCliBridge.ts`](src/workspace/linuxCliBridge.ts)：`local-windows` 时经 `wsl.exe --cd` 启动 Codex/Cursor（与 WSL 终端同一套路径/distro 逻辑）

### 修复

- Windows 本机 VS Code 无法发现 WSL 内 `codex` / `agent`、模型列表为空
- Doctor 在 WSL 桥接模式下显示 `(via wsl.exe)` 详情

[0.1.2]: https://github.com/ADaozz/wsl_deck_extension/releases/tag/v0.1.2

## [0.1.1] - 2026-09-04

补丁版 — 文档定位调整与未打开工作区时的体验修复。

### 变更

- **文档定位** — ARCHITECTURE / README / DEVELOPMENT §1 以 Linux-native Agent Runtime 为核心，Shadow 降级为变更安全层实现

### 修复

- 未打开工作区文件夹时，Doctor / 终端 / Agent 显示中文可操作提示
- Agent 侧栏展示「需要打开文件夹」引导页与「打开文件夹…」按钮；打开文件夹后 UI 自动刷新
- **VSIX** — 打包包含 `@cursor/sdk` 等运行时 JS 依赖（排除 `@cursor/sdk-*` 平台原生二进制），修复 `Cannot find package '@cursor/sdk'`

[0.1.1]: https://github.com/ADaozz/wsl_deck_extension/releases/tag/v0.1.1

## [0.1.0] - 2026-09-04

首个公开发布版 — 统一的 WSL AI Agent 工作流，变更需审查确认后再 Keep。

### 新增

- **Agent 视图** — 同一侧栏内集成 Codex CLI（`exec --json` / resume）与 Cursor CLI（`agent acp`）
- **影子工作区** — Agent 在 shadow 副本中编辑；仅 **Keep** 后写入 Main 工作区
- **变更提案** — 按路径展示 Diff 卡片，支持 Keep / Cancel、冲突检测、Keep All / Cancel All
- **Revision 栈** — 每个文件一张卡片，含轮次历史、时间戳及逐 revision 的 Diff
- **会话 Deck** — 卡片与 Resume 索引持久化于 `.WSLDeck/sessions/<id>/ui.json`
- **多会话 Resume** — 同一工作区内按 Provider 独立会话
- **斜杠命令** — `/model`、`/mode`，以及 Provider 与 Resume 选择器
- **WSL 终端配置** — `WSLDeck WSL`，Windows 下自动 `--cd` 映射
- **Doctor** — 工作区、Git、WSL 与 CLI 健康检查
- **Markdown 体验** — Agent 回复 Markdown 渲染；` ```bash ` 代码块支持 **Run in Terminal**
- **复制** — 每条 user/agent 消息底部独立复制按钮（原始文本）
- **Thought 流** — 可折叠思考面板，流式输出时自动滚动

### 修复

- Keep All 后不再在已接受行上残留 Keep 按钮
- Keep 后 baseline 覆盖，避免重复 Keep 时出现误报冲突
- Codex「运行中却显示 idle」— 命令执行期间显示 working 指示
- Diff 卡片绑定到产生它的对话轮次（不再总挂在最新一轮）
- Keep/Cancel 后隐藏 View Diff；新增文件支持 empty ↔ shadow Diff

### 测试

- 77 项自动化测试（变更引擎、Git 兼容、Provider、Deck 存储、Revision）

[0.1.0]: https://github.com/ADaozz/wsl_deck_extension/releases/tag/v0.1.0
