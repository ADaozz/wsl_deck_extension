# WSLDeck 架构

首版边界文档。请勿轻易打破下列约束。

## 产品定义

**WSLDeck 是 VS Code 与 Linux-native AI Coding Agent 之间的工作流层。**

一句话：**让 AI Coding Agent 原生运行在 Linux/WSL 开发环境中，同时保留 VS Code 的桌面开发体验，并提供可审查、可撤销的 Agent 变更工作流。**

WSLDeck 不重新造 IDE，不重新造 Agent，也不重新造 Git。它把 VS Code 的交互体验与 Linux-native Agent 执行接起来。

判断功能是否属于主线，可用：

> WSLDeck 连接 VS Code UI 与 Linux-native Agent Runtime，并在变更进入用户工作区前提供审查与控制。

而不是：

> WSLDeck 是一个让 Agent 直接改工作区、再用 baseline Diff 卡片做审查与撤销的 VS Code 插件。

---

## 三层核心能力（优先级）

| 优先级 | 能力 | 说明 |
|--------|------|------|
| 1 | **Linux-native Agent Execution** | Agent 在 Linux shell、Linux 文件系统、Linux PATH 与工具链中运行 |
| 2 | **IDE-native Agent Experience** | 用户不离开 VS Code：对话、Tool Activity、终端、Diff、SCM |
| 3 | **Controlled Agent Changes** | AI 修改可检测、可 Diff、可 Keep / Cancel；会话 baseline + Main 直改 |

---

## 分层架构

```text
          VS Code
             │
             │  Editor / Diff / SCM / UI / 输入
             ▼
      WSLDeck Runtime Bridge
             │
             ▼
      Linux / WSL Environment
             │
     ┌───────┼────────┐
     │       │        │
   Codex   Cursor   Shell / Tools
     │       │        │
     └───────┼────────┘
             │
      Linux Workspace（执行上下文）
             │
      Agent Changes（检测）
             │
      Change Safety Layer
       ├── Session Baseline（Git HEAD 或 `.WSLDeck` 快照）
       ├── Change Tracking
       ├── Diff Review
       ├── Cancel（从 baseline 恢复 Main）
       └── Keep（确认/收起）
             │
             ▼
      Main Workspace（Agent 直接编辑）
             │
             ▼
      VS Code Native Git
```

### 各层职责

| 层 | 职责 |
|----|------|
| **VS Code** | Editor、Diff 视图、SCM、终端 UI、Problems、用户输入 |
| **WSLDeck** | Agent 编排、会话、Provider 桥接、变更审查 UI、WSL 路径/cwd 映射、**Agent env resolver**（Windows 本机注入 WSL login shell 环境） |
| **Linux / WSL** | Agent 进程、shell、文件系统、权限模型、工具链（grep、git、pytest、docker…） |
| **Codex / Cursor** | 推理与 Agent execution（CLI） |
| **Change Safety Layer** | 会话 baseline、跟踪、Diff、Keep（确认）/ Cancel（恢复 Main） |
| **Git** | 仍由 VS Code SCM 与用户掌控；WSLDeck 不 commit / push |

---

## 为什么 Linux-native 是核心

Coding Agent 的大量动作最终都是 Linux 语义下的操作：`grep`、`find`、`git`、`pytest`、`npm`、`chmod`、`bash` 等。

在 Windows 本机直接执行时，常遇到 PowerShell/CMD 与 bash 语义差异、路径转换、CRLF、权限模型、quoting、CLI 可用性等问题。Agent 若在 WSL 内运行，则 `cd ~/project && pytest` 就是正常 Linux 操作，无需让 Agent 理解 `wsl.exe -d Ubuntu --cd /home/neo/project bash -lc "..."`。

此外：

1. **工具链语义一致** — shell、PATH、脚本与 Linux 服务器/容器更接近（非「完全一致」，但执行模型更贴近生产 Linux）。
2. **VS Code 负责 UI，Linux 负责执行** — 架构上最清晰的分工。
3. **环境鸿沟更短** — 开发 Agent 与 Ubuntu/Debian/容器/K8s 等生产环境的距离更近。
4. **WSLDeck 的价值命名** — 项目名中的 WSL 回答「为什么需要 Linux 侧 Runtime」，而非仅「为什么需要 Diff 卡片」。

---

## 设计原则

### 1. 不接管 Git

扩展不得自动 commit / push / pull / fetch / merge / rebase，不得修改 remote、分支或用户 git config。

Git 归属权留在 VS Code Source Control。

### 2. 变更须经审查后再应用

Agent 产生的文件变更必须经 Change Safety Layer 检测与展示。Agent **直接编辑 Main**；会话开始时记录 baseline（Git HEAD 或 `.WSLDeck/sessions/<id>/baseline/` 快照）。**Keep** 确认/收起卡片；**Cancel** 从 baseline 恢复 Main 文件。

### 3. Keep / Cancel 不是 Git 操作

| 操作 | 含义 |
|------|------|
| Cancel | 从会话 baseline **快照**恢复 Main 文件（非 git checkout） |
| Keep | 确认/收起 Diff 卡片（Main 已是 Agent 改后内容；**不 commit**） |
| Git Restore | 恢复 Git 工作树 |
| Commit | 创建 Git 版本 |

### 4. Agent Provider 可插拔

核心命名保持 Provider 无关：

- `AgentSessionManager`
- `AgentProvider`
- `ChangeTracker`
- `SessionBaselineManager`（会话开始时捕获 Git HEAD 或文件树快照）

已接入 Provider：

- `CodexProvider` — `codex exec --json` / `codex exec resume <thread_id>`
- `CursorProvider` — `agent acp`（复用 `agent login`；JSON-RPC：initialize → authenticate(cursor_login) → session/new|load → session/prompt）

每个 Provider 在工作区内维护**独立**会话与 resume id；切换 Agent 不共享、不抢占另一 Provider 的进程。

Provider 生命周期约束：

- 同一 Provider 的 session 创建与 Cursor ACP 初始化必须复用 in-flight 操作，不能重复启动进程。
- 同一 Provider 同时只允许一个 Prompt；Cursor 与 Codex 可各自运行，但事件始终归档到所属 lane。
- ACP 子进程退出、初始化失败或 dispose 时必须清理 ready 状态并 reject pending RPC；下一次调用可安全重连。
- Cancel 在 Provider 内去重，单个 turn 只发送一次 `session/cancel`。

UI 不直接依赖 Codex/Cursor 进程类型。变更检测以 Change Engine（Main vs session baseline）为准，不以 Provider 专有「文件已改」事件为唯一真相源。

### 5. Tool / Activity UI 由元数据驱动

Agent 活动行（grep、web search、shell…）必须从 `tool.started` / `tool.completed` 元数据（`name`、可选 `title`、`detail`）渲染。**不得**维护应用级「已知工具」枚举。

---

## 目标抽象 vs 当前实现

长期更稳定的抽象方向（文档化，非 v0.1.0 承诺）：

```text
AgentRuntime
AgentProvider
WorkspaceEnvironment
ChangeTracker
ChangeBaseline      ← 会话开始时的工作区快照
ChangeApplicator

ChangeBaseline（策略）
├── GitHeadStrategy         ← 当前默认（Git 仓库）
├── SnapshotStrategy        ← 当前默认（非 Git）
├── GitWorktreeStrategy     ← 未来可能
└── ContainerWorkspaceStrategy ← 未来可能
```

**当前默认**：Agent → Main（直接编辑）→ ChangeTracker（Main vs baseline）→ Review → Keep / Cancel

`SessionBaselineManager` 对应：

```text
ChangeBaseline
        ↑
GitHeadBaseline | SnapshotBaseline（当前实现）
```

---

## 代码映射（v0.1.0）

| 架构层 | 源码 |
|--------|------|
| Runtime Bridge | [`src/workspace/linuxCliBridge.ts`](src/workspace/linuxCliBridge.ts)、[`src/workspace/linuxAgentEnvironment.ts`](src/workspace/linuxAgentEnvironment.ts)、[`src/workspace/wslPathResolver.ts`](src/workspace/wslPathResolver.ts)、[`src/workspace/workspaceContext.ts`](src/workspace/workspaceContext.ts)、[`src/terminal/wslTerminalProfile.ts`](src/terminal/wslTerminalProfile.ts)、[`src/terminal/terminalService.ts`](src/terminal/terminalService.ts) |
| Agent Provider | [`src/agent/providers/providerFactory.ts`](src/agent/providers/providerFactory.ts)、[`src/agent/providers/codex/`](src/agent/providers/codex/)、[`src/agent/providers/cursor/`](src/agent/providers/cursor/) |
| 会话与编排 | [`src/agent/agentSessionManager.ts`](src/agent/agentSessionManager.ts)、[`src/state/sessionStore.ts`](src/state/sessionStore.ts) |
| Change Engine | [`src/change/changeTracker.ts`](src/change/changeTracker.ts)、[`src/change/changeRevisions.ts`](src/change/changeRevisions.ts)、[`src/change/changeActions.ts`](src/change/changeActions.ts)、[`src/change/baselineOverlay.ts`](src/change/baselineOverlay.ts) |
| Session Baseline | [`src/session/sessionBaseline.ts`](src/session/sessionBaseline.ts)、[`src/session/sessionGit.ts`](src/session/sessionGit.ts)、[`src/session/workspaceCopy.ts`](src/session/workspaceCopy.ts) |
| IDE 集成 | [`src/ui/agentViewProvider.ts`](src/ui/agentViewProvider.ts)、[`webview/`](webview/)、[`media/agent-view.css`](media/agent-view.css) |
| 健康检查 | [`src/doctor/doctor.ts`](src/doctor/doctor.ts) |

### Agent env 与代理（Windows 本机）

`local-windows` 下 Linux 进程 env **仅**来自 [`linuxAgentEnvironment.ts`](src/workspace/linuxAgentEnvironment.ts) 对 WSL login shell 的一次探测 + `wsldeck.agent.env` 覆盖，**不**继承 Windows `process.env`。WSL NAT 下 proxy 须指向 Doctor 显示的 **WSL host**（默认路由网关），不能写 `127.0.0.1`。配置步骤见 [README — 代理 / 梯子](README.md#配置)。

---

## 能力层级小结

```text
Linux Native Runtime          ← 产品核心（为什么叫 WSLDeck）
        >
VS Code Integration           ← 第二核心（为什么不离开 IDE）
        >
Controlled Agent Changes      ← 第三核心（变更如何被管理）
        >
Session Baseline（实现细节）  ← Git HEAD 或 `.WSLDeck` 快照
```
