# 更新日志

本文件记录项目的所有重要变更。

格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [0.1.1] - 2026-09-04

补丁版 — 文档定位调整与未打开工作区时的体验修复。

### 变更

- **文档定位** — ARCHITECTURE / README / DEVELOPMENT §1 以 Linux-native Agent Runtime 为核心，Shadow 降级为变更安全层实现

### 修复

- 未打开工作区文件夹时，Doctor / 终端 / Agent 显示中文可操作提示
- Agent 侧栏展示「需要打开文件夹」引导页与「打开文件夹…」按钮；打开文件夹后 UI 自动刷新

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
