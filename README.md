<h1 align="center">WSLDeck</h1>

<p align="center">
  <strong>面向 VS Code 的统一 WSL AI Agent 工作流</strong><br/>
  Codex & Cursor CLI · 影子工作区 · 确认后再 Keep
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.1.0-blue" alt="version 0.1.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/tests-77%20passing-brightgreen" alt="77 tests" />
  <img src="https://img.shields.io/badge/platform-WSL%20%7C%20Linux%20%7C%20Remote--WSL-informational" alt="platform" />
</p>

---

## 为什么需要 WSLDeck

AI 编程 Agent 很强，但直接改你的仓库有风险。**WSLDeck** 让 Agent 在**影子工作区（Shadow）**里编辑，把每次文件变更展示为可审查的 Diff 卡片，只有你点击 **Keep** 后才会写入**主工作区（Main）**。

Git 仍由你掌控 — WSLDeck 不会自动 commit、push，也不会操作 remote。

```
Agent（Codex / Cursor）
        ↓
影子工作区  ──检测──▶  Diff 卡片（Keep / Cancel）
        ↓                              ↓
   （隔离编辑）                    主工作区
```

## 功能概览

| 模块 | 说明 |
|------|------|
| **Provider** | 同一 Agent 侧栏内切换 Codex CLI 与 Cursor `agent acp` |
| **变更审查** | 按文件卡片展示，支持每轮 revision 历史、时间戳、View Diff |
| **安全机制** | Main 相对 baseline 有变动时触发冲突拦截；Keep 后 baseline 前进 |
| **会话** | 按 Provider 独立会话、Resume 选择器，状态持久化于 `.WSLDeck/` |
| **终端** | **WSLDeck WSL** 配置 — Windows 下 `wsl.exe --cd`，WSL 内原生 shell |
| **体验** | Markdown 渲染、` ```bash ` 一键 Run in Terminal、逐条复制、Thought 流式自动滚动 |

## 快速开始

### 环境要求

- VS Code **1.90+**（推荐 Remote - WSL）
- [Codex CLI](https://github.com/openai/codex) 和/或 [Cursor CLI](https://cursor.com/docs/cli) 已加入 `PATH`
- 已打开一个文件夹作为工作区（Remote-WSL 时使用 WSL 路径）

### 从源码安装

```bash
git clone https://github.com/ADaozz/wsl_deck_extension.git
cd wsl_deck_extension
npm install
npm run compile
```

**方式 A — F5：** 用 VS Code 打开项目 → 运行 **Extension Development Host**。

**方式 B — VSIX：**

```bash
npm test
npx vsce package
# 在扩展视图 → ··· → 从 VSIX 安装 → 选择 wsldeck-extension-0.1.0.vsix
```

### 首次使用

1. 点击活动栏 **WSLDeck** 图标 → 打开 **Agent**
2. 选择 **Codex** 或 **Cursor**，点选模型芯片，输入提示词
3. 在每条 Agent 回复下方的折叠面板中审查变更
4. 对每个文件 **Keep** 或 **Cancel**（同一面板内待处理项可批量操作）

若 CLI、WSL 工作目录或 Git 异常，可在命令面板运行 **WSLDeck: Doctor** 做健康检查。

## 命令

| 命令 | 说明 |
|------|------|
| `WSLDeck: Show` | 聚焦 Agent 视图 |
| `WSLDeck: Doctor` | 健康检查（工作区、Git、WSL、CLI） |
| `WSLDeck: Open WSL Terminal` | 在工作区 cwd 打开 WSL 终端 |
| `WSLDeck: Show Agent Log` | 打开 Agent 日志输出 |

## 输入框快捷指令

| 输入 | 作用 |
|------|------|
| `/model` | 切换模型（仅当前 Provider） |
| `/mode` | Agent / Plan 模式 |
| `/new` | 为当前 Provider 新建会话 |
| **Enter** | 发送（若刚打开模型菜单则先确认选择） |

## 配置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `wsldeck.agent.defaultProvider` | `codex` | `codex` \| `cursor` |
| `wsldeck.codex.executable` | `codex` | 可执行文件路径或名称 |
| `wsldeck.cursor.executable` | `agent` | Cursor CLI |
| `wsldeck.cursor.apiKey` | — | 或使用环境变量 `CURSOR_API_KEY` |
| `wsldeck.shadow.root` | — | 默认：`~/.local/share/wsldeck-extension` |

完整配置见 [package.json](package.json) 中的 `contributes.configuration`。

## 架构原则

高层约束（请勿轻易打破）：

1. **不接管 Git** — 不自动 commit/push；VS Code SCM 仍是唯一真相源
2. **Agent 不直接写 Main** — 影子工作区 → 审查 → Keep
3. **Provider 可插拔** — 共享 `AgentProvider`、`ChangeTracker`、`ShadowWorkspaceManager`
4. **工具 UI 由元数据驱动** — 无硬编码 tool 枚举

详细设计：[ARCHITECTURE.md](ARCHITECTURE.md) · 开发说明：[DEVELOPMENT.md](DEVELOPMENT.md)

## 开发

```bash
npm install
npm run compile      # 类型检查 + esbuild
npm test             # 77 项测试（@vscode/test-electron）
npm run watch        # esbuild + tsc 监听
npm run lint
```

Git 兼容性手动清单：[docs/git-compat-checklist.md](docs/git-compat-checklist.md)

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
