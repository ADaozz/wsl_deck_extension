<h1 align="center">WSLDeck</h1>

<p align="center">
  <strong>让 Codex、Cursor 等 Coding Agent 原生运行在 Linux/WSL 环境，同时保留完整的 VS Code 开发体验</strong><br/>
  Linux-native Agent · Codex & Cursor CLI · 可审查变更 · Keep / Cancel · Native Git
</p>

<p align="center">
  <a href="CHANGELOG.md"><img src="https://img.shields.io/badge/version-0.2.0-blue" alt="version 0.2.0" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green" alt="MIT" /></a>
  <img src="https://img.shields.io/badge/tests-97%20passing-brightgreen" alt="97 tests" />
  <img src="https://img.shields.io/badge/platform-WSL%20%7C%20Linux%20%7C%20Remote--WSL-informational" alt="platform" />
</p>

---

## 为什么需要 WSLDeck

Coding Agent 的日常动作——`grep`、`git`、`pytest`、`npm test`、`chmod`、`bash` 脚本——在 **Linux 语义**下最自然。在 Windows 本机直接跑 Agent，常碰到 PowerShell/CMD 与 bash 差异、路径转换、CRLF、权限与 quoting 等问题。

**WSLDeck** 让 Agent **原生运行在 Linux/WSL**：Linux shell、Linux 文件系统、Linux PATH 与工具链。你在 VS Code 里写代码、看 Diff、用 SCM；Agent 在 Linux 侧执行，语义更接近 Ubuntu 服务器、容器与常见生产环境。

```
Developer（VS Code / Windows UI）
        │
        ▼
WSLDeck Runtime Bridge
        │
        ▼
WSL / Linux（Agent 进程 · shell · 工具链）
        │
        ▼
Linux Workspace
```

### 变更如何被安全管理

AI 改代码不应是黑盒。WSLDeck 提供 **Change Safety Layer**：

- Agent **直接编辑**当前工作区文件
- 会话开始时记录 **baseline**（工作区快照到 `.WSLDeck/sessions/<id>/baseline/`），Diff 卡片只显示相对会话起点的变更（与 Git commit/status 无关）
- Diff 卡片 + 按轮次 **Revision** 历史、View Diff
- **Keep** 确认/收起卡片；**Cancel** 从 baseline **恢复**文件

**Linux-native Runtime** 是 WSLDeck 的核心价值——Agent 在 WSL 里跑 bash/git，与 VS Code 工作区路径对齐。

## 功能概览

| 模块 | 说明 |
|------|------|
| **Linux 运行时** | WSL 路径映射（`C:\` → `/mnt/c`、UNC）、工作区 cwd、**WSLDeck WSL** 终端、Doctor 环境检测；Windows 本机经 **Agent env resolver** 从 WSL login shell 注入 `PATH`/proxy |
| **Agent Provider** | 同一侧栏切换 Codex CLI 与 Cursor `agent acp`；按 Provider 独立会话与 Resume |
| **IDE 体验** | 对话、Tool Activity、Markdown、` ```bash ` Run in Terminal、Thought 流式自动滚动、逐条复制 |
| **变更安全** | Diff 卡片、Revision 栈、Keep（确认）/ Cancel（恢复 baseline） |

## 快速开始

### 环境要求

- VS Code **1.90+**
- **Linux/WSL 作为 Agent 执行环境**
  - **Remote-WSL**（推荐）：扩展与 CLI 均在 WSL 内
  - **Windows 本机 VS Code**：需 WSL + **打开文件夹**；Codex/Cursor 经 `wsl.exe --cd` 桥接执行，env 由 WSL login shell 探测（可用 `wsldeck.agent.env` 覆盖 proxy 等）
- 请确保 [Codex CLI](https://github.com/openai/codex) 和/或 [Cursor CLI](https://cursor.com/docs/cli) 已加入 **WSL 内** `PATH`
- 已打开文件夹作为工作区（Windows 路径如 `C:\project` 会自动映射为 `/mnt/c/project`）

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
# 在扩展视图 → ··· → 从 VSIX 安装 → 选择 wsldeck-extension-0.1.3.vsix
```

### 首次使用

1. 点击活动栏 **WSLDeck** 图标 → 打开 **Agent**
2. 选择 **Codex** 或 **Cursor**，点选模型芯片，输入提示词
3. Agent 在 Linux 环境执行；在每条 Agent 回复下方审查变更
4. 对每个文件 **Keep** 或 **Cancel**（同一面板内可批量操作）

若 CLI、WSL 工作目录或 Git 异常，运行 **WSLDeck: Doctor** 做健康检查。

## 命令

| 命令 | 说明 |
|------|------|
| `WSLDeck: Show` | 聚焦 Agent 视图 |
| `WSLDeck: Doctor` | 健康检查（工作区、Agent env、Git、WSL、CLI） |
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

### 常用设置

| 设置项 | 默认值 | 说明 |
|--------|--------|------|
| `wsldeck.agent.defaultProvider` | `codex` | `codex` \| `cursor` |
| `wsldeck.codex.executable` | `codex` | 可执行文件路径或名称 |
| `wsldeck.cursor.executable` | `agent` | Cursor CLI |
| `wsldeck.cursor.apiKey` | — | Cursor SDK 模型目录 API key；不用于 ACP 会话认证 |
| `wsldeck.agent.env` | `{}` | 注入/覆盖 WSL 内 Agent 环境变量（见下文 **代理配置**） |
| `wsldeck.agent.logEnv` | `false` | 首次 CLI 启动时在 Agent Log 打印 env 摘要（密钥打码） |

完整配置见 [package.json](package.json) 中的 `contributes.configuration`。

### Windows 本机 + WSL：代理 / 梯子

在 **Windows 本机 VS Code**（非 Remote-WSL）下，Codex/Cursor 经 `wsl.exe` 在 WSL 里运行。WSL 与 Windows 之间有 **NAT**：在 WSL 或 `wsldeck.agent.env` 里写 `127.0.0.1:端口` **指向的是 WSL 自身**，访问不到 Windows 上监听的梯子。

**正确做法**：用 WSL 看到的 **Windows 宿主机 IP** + 梯子端口。

#### 1. 查宿主机 IP

运行 **WSLDeck: Doctor**，在 **Agent env** 行找：

```text
WSL host=<宿主机IP>, HTTPS_PROXY=set, ...
```

`WSL host=` 后面的 IP 即 **你这台机器** 的 Windows 宿主机地址（每人不同；与 WSL 里 `ip route | grep default` 的网关一致）。

或在 WSL 终端手动查：

```bash
ip route | grep default | awk '{print $3}'
```

#### 2. 填写代理（推荐：VS Code 设置）

在工作区或用户 `settings.json` 中（将 `宿主机IP`、`代理端口` 替换为 Doctor **WSL host** 所示 IP 与 Windows 梯子监听端口）：

```json
{
  "wsldeck.agent.env": {
    "HTTP_PROXY": "http://宿主机IP:代理端口",
    "HTTPS_PROXY": "http://宿主机IP:代理端口",
    "NO_PROXY": "localhost,127.0.0.1"
  },
  "wsldeck.agent.logEnv": false
}
```

改完后重新运行 **WSLDeck: Doctor** 确认 **Agent env** 含 `HTTPS_PROXY=set`，且 **没有** `proxy 含 localhost` 警告。

#### 3. 或：写在 WSL login shell（无需 settings）

在 WSL 的 `~/.profile` 或 `~/.bashrc`（需保证 `bash -lc` 能读到）：

```bash
export WIN_HOST=$(ip route | grep -m1 '^default' | awk '{print $3}')
export HTTP_PROXY="http://${WIN_HOST}:代理端口"
export HTTPS_PROXY="http://${WIN_HOST}:代理端口"
export NO_PROXY="localhost,127.0.0.1"
```

WSLDeck 会探测 login shell 的 env 并注入 Codex/Cursor；`wsldeck.agent.env` 优先级更高，可覆盖探测结果。

#### 4. 调试 env

需要确认 Agent 实际拿到的 env 时，临时开启：

```json
{
  "wsldeck.agent.logEnv": true
}
```

发送一条 prompt 后打开 **WSLDeck: Show Agent Log**，查看首次 `-- agent env:` 行（不含密钥明文）。

#### 说明

| 场景 | 代理怎么配 |
|------|------------|
| **Windows 本机 VS Code + WSL 桥接** | 用 `WSL host` IP，**勿**在 `wsldeck.agent.env` 里写 `127.0.0.1` |
| **Remote-WSL** | 与 WSL 终端相同；通常可直接 `127.0.0.1`（扩展与 CLI 均在 WSL 内） |
| **Linux 本机** | 使用系统/终端 env 即可 |

WSLDeck **不会**自动同步 Windows 系统代理设置；需按上表在 WSL env 或 `wsldeck.agent.env` 中显式配置。

#### Cursor ACP 认证说明

- 使用 Cursor 前先在同一个 Linux / WSL 环境运行 **`agent login`**。
- WSLDeck 复用 CLI 保存的登录状态；当 `initialize` 返回 `cursor_login` 时，按协议执行 **`initialize` → `authenticate(cursor_login)` → `session/new|load`**。这里的 `authenticate` 只加载已有 CLI 凭据，不会重新拉起登录。
- ACP 进程固定设置 `NO_OPEN_BROWSER=1`，不会自动打开认证网页；凭据失效时请在终端手动重新运行 `agent login`。
- 启动 `agent acp` 时会清除 `CURSOR_API_KEY`，避免 API key 覆盖 CLI 登录态；`wsldeck.cursor.apiKey` 和环境变量中的 key 仅用于 SDK 模型目录。

若日志出现 `Authentication required` 或 `Failed to open browser for login`，请确认登录命令与插件使用的是**同一个 WSL 发行版和用户**：

```bash
whoami
agent status
agent login   # 仅在 status 显示 Not logged in 时执行
```

Windows 本机 VS Code 还需确认 `wsldeck.wsl.distribution` 指向执行上述命令的发行版。登录完成后执行 **Developer: Reload Window** 重载扩展。配置文件中残留的用户信息不代表 token 仍然有效，以 `agent status` 为准。

#### Provider 运行说明

- Cursor 和 Codex 各自维护独立 session；切换 Provider 不会丢失后台回复或工具事件。
- 同一 Provider 一次只允许一个 Prompt，防止两个进程同时写工作区或覆盖 resume 状态。
- Cursor ACP 意外退出或初始化失败后会清理旧进程，并在下一次调用时重新建立连接。

## 架构原则

高层约束（详见 [ARCHITECTURE.md](ARCHITECTURE.md)）：

1. **不接管 Git** — 不自动 commit/push；VS Code SCM 仍是唯一真相源
2. **变更须审查与控制** — Agent 直接编辑 Main；会话 baseline 对比检测；Keep 确认、Cancel 恢复
3. **Provider 可插拔** — 共享 `AgentProvider`、`ChangeTracker`；隔离策略可演进
4. **工具 UI 由元数据驱动** — 无硬编码 tool 枚举

开发说明：[DEVELOPMENT.md](DEVELOPMENT.md)

## 开发

```bash
npm install
npm run compile      # 类型检查 + esbuild
npm test             # 97 项测试（@vscode/test-electron）
npm run watch        # esbuild + tsc 监听
npm run lint
```

Git 兼容性手动清单：[docs/git-compat-checklist.md](docs/git-compat-checklist.md)

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

[MIT](LICENSE)
