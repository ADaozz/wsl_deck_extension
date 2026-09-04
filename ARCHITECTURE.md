# WSLDeckExtension Architecture

First-version boundaries. Do not break these lightly.

## Core flow

```text
Agent
  ↓
Shadow Workspace
  ↓
Proposed Changes
  │
  ├─ Cancel → discard
  │
  └─ Accept → Main Workspace → VS Code native Git → Commit / Push
```

## Principles

### 1. Do not take over Git

The extension must never auto commit / push / pull / fetch / merge / rebase,
and must never mutate remotes, branches, or user git config.

Git ownership stays with VS Code Source Control.

### 2. Agents never write Main Workspace directly

Agents run inside a Shadow Workspace. Only Accept may apply changes to Main.

### 3. Accept / Cancel are not Git operations

| Action | Meaning |
| --- | --- |
| Cancel | Discard AI proposed change |
| Accept | Apply AI change into workspace |
| Git Restore | Restore Git working tree |
| Commit | Create a Git version |

### 4. Agent providers are replaceable

Core names stay provider-agnostic:

- `AgentSessionManager`
- `AgentProvider`
- `ChangeTracker`
- `ShadowWorkspaceManager`

Providers:

- `CodexProvider` — `codex exec --json` / `codex exec resume <thread_id>`
- `CursorProvider` — `agent acp` (JSON-RPC: initialize → authenticate → session/new|load → session/prompt)

Each provider keeps its **own** session + resume id inside a workspace.
Switching Agent never shares or steals the other provider's process.

UI never imports Codex/Cursor process types. Change detection comes from the
Change Engine (shadow baseline vs current), never from provider-specific
"file changed" events as the source of truth.

### 5. Tool / activity UI is metadata-driven

Agent activity rows (grep, web search, shell, …) MUST render from
`tool.started` / `tool.completed` metadata strings (`name`, optional `title`,
`detail`). Do not maintain an application-level enum of known tools.
