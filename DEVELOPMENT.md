# WSLDeckExtension — VS Code 插件开发计划

## 1. 项目定位

**项目名：`WSLDeckExtension`**

目标不是替代 VS Code、Git、Codex 或 Cursor，而是给 VS Code 增加一层统一的 **WSL AI Agent 工作流**：

```text
VS Code
├── 原生 Editor
├── 原生 Git / SCM / Commit / Push
├── 原生 Terminal
│   └── WSL Terminal
│
└── WSLDeckExtension
    └── Agent View
        ├── Codex CLI
        ├── Cursor CLI
        ├── Conversation
        └── Proposed Changes
            ├── -XX +XXX
            ├── 查看 Diff
            ├── 取消
            └── 确认
```

核心状态模型固定为：

```text
Agent
  ↓
Shadow Workspace
  ↓
Proposed Changes
  │
  ├─ Cancel → 丢弃
  │
  └─ Accept
         ↓
   Main Workspace
         ↓
  VS Code 原生 Git
         ↓
 Commit / Push
```

---

# 2. 开发与运行环境

开发环境按 **Ubuntu + Node.js + TypeScript**。

建议：

```text
Ubuntu
Node.js 22 LTS+
npm
TypeScript
VS Code
Git
```

初始化：

```bash
sudo apt update
sudo apt install -y git curl build-essential

node --version
npm --version
git --version
```

插件开发依赖：

```bash
npm install -g yo generator-code @vscode/vsce
```

创建：

```bash
yo code
```

选择：

```text
New Extension (TypeScript)

Name: WSLDeckExtension
Identifier: wsldeck-extension
Language: TypeScript
Bundler: esbuild
Package Manager: npm
```

### 一个环境边界

你的**源码开发、编译、单元测试可以全部在 Ubuntu 完成**。

但：

```text
Windows VS Code
    ↓
wsl.exe
    ↓
Ubuntu
```

这一条涉及 Windows WSL，所以最终集成测试仍然需要：

```text
Windows
+ VS Code Desktop
+ WSL
+ Ubuntu
```

也就是说：

```text
Ubuntu             Windows + WSL
────────────       ───────────────
Coding             WSL Terminal
Build              cwd 映射
Unit Test          Codex/agent 实际启动
Git Test           VS Code UI
                   Secondary Sidebar
                   VSIX 验收
```

---

# 3. 技术原则

第一版就写进 `ARCHITECTURE.md`，后续不得轻易打破。

### 原则 1：不接管 Git

插件禁止自动：

```text
commit
push
pull
fetch
merge
rebase
修改 remote
修改 branch
修改用户 git config
```

Git 正常流程仍然是：

```text
VS Code Source Control
      ↓
Stage
      ↓
Commit
      ↓
Push
```

VS Code 自带 Git SCM Provider，WSLDeckExtension 不应该再实现第二套 Git SCM。([Visual Studio Code][1])

---

### 原则 2：Agent 不直接修改 Main Workspace

禁止：

```text
codex
  ↓
/project/src/...
```

改成：

```text
Main Workspace
      │
      └── create shadow
               ↓
        Agent Workspace
               ↓
          codex / agent
```

只有：

```text
Accept
```

才允许：

```text
Shadow → Main Workspace
```

---

### 原则 3：Accept / Cancel 与 Git 完全分离

```text
Cancel
=
不要 AI 的修改

Accept
=
将 AI 修改应用到 Workspace

Git Restore
=
恢复 Git 工作树

Commit
=
创建 Git 版本
```

四个行为互不等价。

---

### 原则 4：Agent Provider 可替换

核心层禁止出现：

```text
CodexChangeManager
CodexWorkspaceManager
CodexGitManager
```

应该是：

```text
AgentSessionManager
AgentProvider
ChangeTracker
ShadowWorkspaceManager
```

然后：

```text
AgentProvider
├── CodexProvider
└── CursorProvider
```

---

# 4. 推荐项目目录

第一版直接采用：

```text
WSLDeckExtension/
├── package.json
├── package-lock.json
├── tsconfig.json
├── eslint.config.mjs
├── README.md
├── ARCHITECTURE.md
│
├── media/
│   ├── icon.svg
│   └── agent-view.css
│
├── src/
│   ├── extension.ts
│   │
│   ├── workspace/
│   │   ├── workspaceContext.ts
│   │   ├── workspaceResolver.ts
│   │   └── wslPathResolver.ts
│   │
│   ├── terminal/
│   │   ├── wslTerminalProfile.ts
│   │   └── terminalService.ts
│   │
│   ├── agent/
│   │   ├── agentProvider.ts
│   │   ├── agentSession.ts
│   │   ├── agentSessionManager.ts
│   │   │
│   │   └── providers/
│   │       ├── codex/
│   │       │   ├── codexProvider.ts
│   │       │   ├── codexProcess.ts
│   │       │   └── codexEvents.ts
│   │       │
│   │       └── cursor/
│   │           ├── cursorProvider.ts
│   │           ├── cursorAcpClient.ts
│   │           └── cursorEvents.ts
│   │
│   ├── changes/
│   │   ├── change.ts
│   │   ├── changeTracker.ts
│   │   ├── diffService.ts
│   │   ├── patchService.ts
│   │   └── changeCoordinator.ts
│   │
│   ├── shadow/
│   │   ├── shadowWorkspace.ts
│   │   ├── shadowWorkspaceManager.ts
│   │   └── gitWorktreeBackend.ts
│   │
│   ├── git/
│   │   ├── gitRunner.ts
│   │   └── gitRepository.ts
│   │
│   ├── ui/
│   │   ├── agentViewProvider.ts
│   │   ├── messageProtocol.ts
│   │   └── serializers.ts
│   │
│   └── state/
│       ├── extensionState.ts
│       └── sessionStore.ts
│
├── webview/
│   ├── index.ts
│   ├── app.ts
│   ├── conversation.ts
│   ├── changeCard.ts
│   └── styles.css
│
└── test/
    ├── unit/
    └── integration/
```

---

# 5. Milestone 0 — 项目骨架

目标：

> 插件可以启动、调试、打包，不做任何 Agent 功能。

实现：

```text
extension.ts
package.json
TypeScript
ESLint
esbuild
VS Code Extension Test
```

注册命令：

```text
WSLDeck: Show
WSLDeck: Doctor
```

`Doctor` 第一版检查：

```text
Workspace
Git
WSL
codex
agent
```

输出例如：

```text
WSLDeck Environment

Workspace     ✓
Git           ✓ 2.51
WSL           ✓ Ubuntu
Codex CLI     ✓
Cursor CLI    ✓
```

### 验收

```bash
npm run compile
npm test
vsce package
```

全部通过。

---

# 6. Milestone 1 — WSL Terminal

这是第一个真正功能。

目标：

```text
Terminal
  +
  ├─ PowerShell
  ├─ Command Prompt
  └─ WSL
```

并确保 cwd 是当前 Workspace。

例如：

```text
D:\projects\demo
```

创建：

```text
WSL Terminal
```

进入：

```bash
/mnt/d/projects/demo
```

而不是：

```bash
~
```

实现：

```text
wslPathResolver
      ↓
TerminalProfileProvider
      ↓
WSL Terminal
```

至少处理：

```text
C:\project
↓
/mnt/c/project
```

以及：

```text
\\wsl.localhost\Ubuntu\home\neo\project
↓
/home/neo/project
```

### 验收

打开任意项目：

```bash
pwd
```

必须等于项目目录。

此外：

```text
cd
环境变量
Ctrl+C
输入历史
shell
```

全部使用 VS Code 原生 Terminal，不自己实现 PTY UI。

---

# 7. Milestone 2 — Agent UI 骨架

现在开始右侧对话栏。

建议使用：

```text
WebviewViewProvider
```

因为你需要：

```text
聊天
流式文本
输入框
Change Card
按钮
状态
Provider Selector
```

原生 TreeView 不适合。

VS Code 官方也把 Webview View 定位为侧栏/Panel 中复杂自定义 UI 的机制。([Visual Studio Code][2])

UI：

```text
┌─────────────────────────────┐
│ WSLDeck                     │
│                             │
│ Agent: Codex ▼              │
│                             │
│ ─────────────────────────── │
│                             │
│ User                        │
│ 帮我修改这个接口            │
│                             │
│ Agent                       │
│ 已完成修改……                │
│                             │
│ M UserService.java          │
│ █ -12              +38 █    │
│                             │
│ [Diff]    [取消] [确认]     │
│                             │
│ ─────────────────────────── │
│ [输入消息................]  │
│                         ▶   │
└─────────────────────────────┘
```

### Secondary Sidebar 限制

这里不要走 VS Code 私有 API。

VS Code 官方当前仍说明：扩展贡献的 View **不能默认直接指定 Secondary Sidebar**；用户可以将 View 拖到 Secondary Sidebar，VS Code 会记忆布局。([Visual Studio Code][3])

所以第一版：

```text
WSLDeck View
    ↓
用户第一次 Move View
    ↓
Secondary Side Bar
```

之后保持右侧。

不要依赖内部 undocumented command 强制移动。

---

# 8. Milestone 3 — Agent Provider API

先不要接任何具体 CLI。

定义统一接口。

例如概念接口：

```ts
interface AgentProvider {
    readonly id: string;
    readonly displayName: string;

    detect(): Promise<AgentAvailability>;

    createSession(
        context: AgentSessionContext
    ): Promise<AgentSession>;

    sendPrompt(
        session: AgentSession,
        prompt: string
    ): AsyncIterable<AgentEvent>;

    cancel(
        session: AgentSession
    ): Promise<void>;

    dispose(
        session: AgentSession
    ): Promise<void>;
}
```

统一事件：

```text
session.started
agent.message.delta
agent.message.completed
tool.started
tool.completed
permission.requested
turn.completed
session.failed
```

Change 不属于这里。

禁止：

```text
agent.fileChanged
```

作为真实 Change 数据源。

文件变化必须由 Change Engine 判断。

---

# 9. Milestone 4 — Codex Provider

第一支持对象：

```text
codex
```

当前 Codex CLI 官方支持 Linux，并可以直接通过 `codex` 启动。([GitHub][4])

对于自定义 Chat UI，不建议解析 Codex TUI 的 ANSI 内容。

第一阶段优先验证：

```text
codex exec --json
```

以及：

```text
codex exec resume ...
```

作为结构化 Agent bridge。

当前 Codex 的 headless `exec --json` / resume 能够提供 JSONL 与 thread id，但 CLI 这一层仍处于快速演进状态，因此它应该被严格封装在 `CodexProvider` 内，禁止 UI 直接依赖 Codex JSON 字段。([GitHub][5])

设计：

```text
Webview
   ↓
AgentSessionManager
   ↓
CodexProvider
   ↓
child_process.spawn()
   ↓
codex exec --json
```

### 验收

支持：

```text
新会话
输入 prompt
流式输出
终止
继续下一轮
错误展示
CLI 不存在提示
```

暂时**不处理 Change Accept**。

---

# 10. Milestone 5 — Cursor Provider

第二 Provider：

```text
agent
```

Cursor 当前 Linux/WSL CLI 入口就是：

```bash
agent
```

并且官方提供：

```bash
agent acp
```

作为自定义客户端集成接口。([Cursor][6])

这里建议**直接 ACP**，不要解析 Cursor TUI。

结构：

```text
CursorProvider
       ↓
agent acp
       ↓
stdio
       ↓
JSON-RPC 2.0
```

ACP 已提供：

```text
initialize
authenticate
session/new
session/load
session/prompt
session/update
session/request_permission
session/cancel
```

因此它非常适合 WSLDeckExtension。([Cursor][7])

### 验收

Provider 下拉：

```text
Agent
├─ Codex
└─ Cursor
```

切换后：

```text
相同 UI
相同 Session model
相同 Change Engine
```

---

# 11. Milestone 6 — Shadow Workspace

这是项目最关键阶段。

实现：

```text
ShadowWorkspaceManager
```

第一版强烈建议 Git 项目使用：

```text
git worktree
```

但工作目录由 **WSLDeckExtension** 管，而不是 Codex/Cursor 管。

例如：

```text
Project

/home/neo/projects/demo
```

创建：

```text
~/.local/share/wsldeck-extension/
└── workspaces/
    └── <repo-id>/
        └── <session-id>/
```

Agent：

```text
cwd =
~/.local/share/wsldeck-extension/workspaces/.../
```

而不是 Main Workspace。

### 验收核心

Agent 修改：

```text
A.java
B.java
```

此时 Main：

```bash
git status
```

必须：

```text
没有出现 Agent 修改
```

这是硬门槛。

---

# 12. Milestone 7 — Change Detection

开始生成你要求的小卡片。

定义：

```ts
interface ProposedChange {
    id: string;
    turnId: string;

    path: string;

    kind:
        | 'added'
        | 'modified'
        | 'deleted'
        | 'renamed';

    additions: number;
    deletions: number;

    state:
        | 'pending'
        | 'accepted'
        | 'rejected'
        | 'conflicted';
}
```

检测来源：

```text
Shadow baseline
      ↓
git diff
      ↓
Current Shadow
```

统计：

```text
git diff --numstat
```

例如：

```text
38  12  UserService.java
```

UI：

```text
┌────────────────────────────────┐
│ M  UserService.java            │
│                                │
│ -12                       +38  │
│                                │
│ [查看 Diff]    [取消] [确认]   │
└────────────────────────────────┘
```

一个 Turn：

```text
Agent response
   │
   ├─ User.java       -2 +8
   ├─ Service.java   -12 +38
   └─ UserDTO.java     0 +61
```

必须显示三张卡。

---

# 13. Milestone 8 — Diff Viewer

点击：

```text
查看 Diff
```

使用 VS Code 原生 Diff Editor。

不要自己在 Webview 重新实现代码 Diff。

数据：

```text
LEFT
Shadow baseline

RIGHT
Agent result
```

打开：

```text
vscode.diff
```

达到：

```text
VS Code 原生语法高亮
原生滚动
原生 diff navigation
```

这能减少大量 UI 工作。

---

# 14. Milestone 9 — Accept / Cancel

这是 MVP 的核心完成点。

## Cancel

```text
Pending Change
      ↓
Cancel
      ↓
恢复 Shadow 中该文件 baseline
      ↓
Main Workspace 不变化
```

状态：

```text
REJECTED
```

---

## Accept

```text
Pending Change
      ↓
Accept
      ↓
生成 patch
      ↓
检查 Main Workspace
      ↓
apply
      ↓
Main Workspace Changed
```

此后：

```bash
git status
```

才应该出现：

```text
modified: UserService.java
```

但：

```bash
git log
```

完全不变化。

没有 commit。

---

# 15. Milestone 10 — 冲突检测

不能直接：

```text
git apply --force
```

假设：

```text
S0
│
├─ Agent 修改
│
└─ 用户同时修改 Main Workspace
```

Accept 时必须执行：

```text
baseline
Agent result
Main current
```

三方判断。

冲突则：

```text
CONFLICTED
```

卡片：

```text
┌────────────────────────────┐
│ ! UserService.java         │
│                            │
│ Main Workspace 已发生变化 │
│                            │
│ [比较] [解决冲突]          │
└────────────────────────────┘
```

绝不覆盖用户工作。

---

# 16. Milestone 11 — Git 兼容性验收

专门做一轮。

必须验证：

```text
git status
git diff
git add
git reset
git commit
git branch
git checkout/switch
git pull
git push
```

以及 VS Code：

```text
Source Control
Stage
Commit
Sync
Push
Branch
```

全部正常。

插件不得：

```text
修改 .git/index
修改 remote
修改 branch
阻塞 push
创建自动 commit
```

---

# 17. Milestone 12 — Session 生命周期

之后再加入：

```text
Session
├─ provider
├─ providerSessionId
├─ workspace
├─ shadowWorkspace
├─ turns[]
└─ status
```

状态：

```text
CREATING
READY
RUNNING
WAITING
STOPPED
FAILED
CLOSED
```

一个项目允许：

```text
Codex Session 1
Codex Session 2
Cursor Session 3
```

但第一版建议：

> **一个 Workspace 同时只允许一个可写 Agent Session。**

避免两个 Shadow 同时 Accept 同一文件导致复杂冲突。

后面再开放并发。

---

# 18. package.json 的基本贡献点

初期需要：

```text
commands
terminal profiles
viewsContainers
views
configuration
menus
```

配置建议：

```text
wsldeck.agent.defaultProvider
wsldeck.codex.executable
wsldeck.cursor.executable
wsldeck.wsl.distribution
wsldeck.shadow.root
```

不要把：

```text
API Key
Token
Password
```

存入普通 Settings JSON。

---

# 19. Extension Host 需要专门处理

因为这是一个：

```text
Windows VS Code
+
WSL
+
CLI
```

插件，所以必须把执行位置纳入设计。

VS Code Desktop 在 Remote/WSL 场景下可能同时存在 local 和 remote Extension Host，并通过 `extensionKind` 决定插件运行位置。([Visual Studio Code][8])

WSLDeckExtension 必须测试：

```text
普通 Windows Workspace
D:\project

以及

Remote WSL Workspace
/home/user/project
```

不能假定：

```text
process.platform
cwd
CLI 路径
```

始终在同一机器。

这是 M1 就要解决的问题，不要留到最后。

---

# 20. 测试体系

建议从一开始分三层。

## Unit

```text
wslPathResolver
diff parser
numstat parser
session state
provider event parser
patch validation
```

---

## Integration

创建临时 Git repo：

```text
baseline
↓
shadow worktree
↓
修改文件
↓
detect
↓
accept/reject
↓
assert workspace
```

重点测试：

```text
新增文件
删除文件
修改文件
rename
binary
中文路径
空格路径
用户 dirty workspace
同文件冲突
```

---

## E2E

Windows + VS Code + WSL：

```text
启动 VS Code
打开项目
创建 WSL Terminal
打开 Agent
Codex 修改
生成 Card
Accept
SCM 出现修改
Commit
Push
```

Cursor 再重复一次。

---

# 21. 推荐开发顺序

不要同时开发全部功能。

| 阶段  | 内容                        | 优先级 |
| --- | ------------------------- | --: |
| M0  | Extension Skeleton        |  P0 |
| M1  | Workspace + WSL Terminal  |  P0 |
| M2  | Agent Webview UI          |  P0 |
| M3  | AgentProvider abstraction |  P0 |
| M4  | Codex Provider            |  P0 |
| M5  | Shadow Workspace          |  P0 |
| M6  | Change Detection + Card   |  P0 |
| M7  | Diff Viewer               |  P0 |
| M8  | Accept / Cancel           |  P0 |
| M9  | Conflict Detection        |  P0 |
| M10 | Cursor ACP Provider       |  P1 |
| M11 | Session Persistence       |  P1 |
| M12 | Multi-session             |  P2 |

这里我会把 **Cursor 放在第二 Provider，但 Provider abstraction 必须在 Codex 之前完成**。

这样才能证明：

```text
Codex ≠ 核心
```

---

# 22. MVP 的明确边界

第一版 **必须有**：

```text
✓ WSL Terminal
✓ 当前 Workspace cwd
✓ WSLDeck Agent View
✓ Codex CLI
✓ Cursor CLI
✓ Provider selector
✓ 对话
✓ Shadow Workspace
✓ 文件级 Change Card
✓ -XX / +XXX
✓ 原生 Diff
✓ 单文件 Accept
✓ 单文件 Cancel
✓ Accept All
✓ Cancel All
✓ 冲突阻止覆盖
✓ VS Code Git 正常
✓ Commit 正常
✓ Push 正常
```

第一版 **暂缓**：

```text
× 多 Agent 并发写
× Agent 自动 commit
× Agent 自动 push
× 自己实现 Git SCM
× 自己实现代码编辑器
× 自己实现 Terminal emulator
× Git 历史时间线
× Change checkpoint
× Agent branch
× Cloud sync
× 自定义模型 Gateway
```

---

# 23. 第一周可以直接这样执行

### Day 1

```text
初始化 WSLDeckExtension
TypeScript / esbuild / test
extension activation
Doctor command
```

### Day 2

```text
WorkspaceContext
WSLPathResolver
WSL Terminal Profile
cwd 验收
```

### Day 3

```text
WSLDeck Webview View
输入框
消息列表
Provider selector
UI/Extension message protocol
```

### Day 4

```text
AgentProvider
AgentSession
AgentEvent
CodexProvider
codex exec --json spike
```

### Day 5

```text
Codex 多轮 session
streaming
cancel
error handling
CLI detection
```

第一周结束的 Demo 应该只做到：

```text
打开 VS Code 项目
       ↓
打开 WSLDeck
       ↓
选择 Codex
       ↓
输入问题
       ↓
Linux Codex CLI 运行
       ↓
右侧显示回答
```

**第一周不要做 Accept/Cancel。**

因为必须先证明：

```text
VS Code
  ↕
Agent View
  ↕
Provider API
  ↕
WSL CLI
```

这条基础链路稳定。

---

# 24. 第二阶段的核心验收 Demo

真正决定项目架构是否成立的是这个场景：

```text
1. git status
   → clean

2. WSLDeck → Codex
   → “修改 UserService”

3. Codex 完成

4. git status
   → 仍然 clean

5. WSLDeck 显示：

   UserService.java
   -12 +38
   [取消] [确认]

6. 点击 Diff
   → VS Code 原生 Diff

7. 点击确认

8. git status
   → M UserService.java

9. VS Code Source Control
   → M UserService.java

10. VS Code Commit

11. VS Code Push

12. Remote 正常更新
```

再做一次：

```text
Codex 修改
↓
Change Card
↓
取消
↓
git status 不发生任何变化
```

**这两个 Demo 通过，就可以认为 WSLDeckExtension 的核心架构成立。**

最后建议把项目开发主线定成：

```text
M0 Extension
      ↓
M1 WSL
      ↓
M2 Agent UI
      ↓
M3 Provider
      ↓
M4 Codex
      ↓
M5 Shadow Workspace
      ↓
M6 Proposed Changes
      ↓
M7 Accept / Cancel
      ↓
M8 Git Compatibility
      ↓
M9 Cursor ACP
      ↓
M10 Polish
```

其中最不能妥协的是 **Shadow Workspace、Provider Independence、Native Git Ownership** 三个边界。它们决定后续加 Cursor、其他 CLI、多人仓库、Push/Pull 时是否会推翻前面的实现。

[1]: https://code.visualstudio.com/api/extension-guides/scm-provider?utm_source=chatgpt.com "Source Control API | Visual Studio Code Extension API"
[2]: https://code.visualstudio.com/api/extension-guides/webview?utm_source=chatgpt.com "Webview API | Visual Studio Code Extension API"
[3]: https://code.visualstudio.com/api/ux-guidelines/sidebars?utm_source=chatgpt.com "Sidebars | Visual Studio Code Extension API"
[4]: https://github.com/openai/codex?ref=winstall&utm_source=chatgpt.com "GitHub - openai/codex at winstall · GitHub"
[5]: https://github.com/openai/codex/issues/15538?utm_source=chatgpt.com "codex exec resume silently starts a new thread when given an ephemeral session id · Issue #15538 · openai/codex · GitHub"
[6]: https://prod.cursor.com/docs/cli/overview?utm_source=chatgpt.com "Cursor CLI | Cursor Docs"
[7]: https://prod.cursor.com/docs/cli/acp?utm_source=chatgpt.com "ACP | Cursor Docs"
[8]: https://code.visualstudio.com/api/advanced-topics/extension-host?utm_source=chatgpt.com "Extension Host | Visual Studio Code Extension API"

