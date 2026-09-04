import type {
	AgentAvailability,
	AgentModelInfo,
	AgentProvider,
	AgentSessionContext,
	SendPromptOptions,
} from '../../agentProvider';
import type { AgentEvent } from '../../agentEvents';
import type { AgentRawLog } from '../../agentRawLog';
import { sanitizeAgentLogLine } from '../../agentLogSanitize';
import { createAgentSession, type AgentSession } from '../../agentSession';
import {
	modelsFromConfigFallback,
	parseCodexDebugModelsJson,
	parseCodexModelCatalog,
	type CodexModelCatalogEntry,
	codexReasoningLevelsForModel,
} from '../../modelCatalog';
import { reasoningToModelOption } from '../../sessionConfigSlash';
import {
	formatLinuxCliDetail,
	mergeLinuxCliContext,
	resolveLinuxCommand,
	resolveLinuxArgv,
	runLinuxCli,
	type LinuxCliContext,
} from '../../../workspace/linuxCliBridge';
import {
	agentEnvForLog,
	markAgentEnvLogged,
	resolveLinuxAgentEnv,
	shouldLogAgentEnv,
	type LinuxAgentEnv,
} from '../../../workspace/linuxAgentEnvironment';
import { getWorkspaceContext } from '../../../workspace/workspaceContext';
import { toWslLinuxPath } from '../../../workspace/wslPathResolver';
import {
	codexItemActivityGroup,
	codexItemCompletedOk,
	codexItemDetail,
	codexItemMutatesWorkspace,
	codexItemToolName,
	parseCodexJsonLine,
} from './codexEvents';
import { buildCodexExecArgs, startCodexExec, type CodexExecHandle } from './codexProcess';

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function isCodexThreadStoreConflict(message: string): boolean {
	return /thread-store conflict|already has an active writer/i.test(message);
}

function isCodexModelsCacheError(message: string): boolean {
	return (
		/failed to load models cache|failed to refresh available models/i.test(message) ||
		/supports_parallel_tool_calls/i.test(message)
	);
}

function isCodexBackendError(message: string): boolean {
	return (
		/rmcp::transport|Transport channel closed|chatgpt\.com\/backend-api/i.test(message) ||
		/http\/request failed|error sending request for url/i.test(message)
	);
}

const CODEX_MCP_REMINDER =
	'提示：Codex MCP/后端网络异常（通常可忽略；若 Agent 无响应再检查 codex login 或代理）';

function collectCodexFailureReason(stderrLines: string[], exitCode: number): string | undefined {
	const joined = stderrLines.join('\n');
	if (isCodexThreadStoreConflict(joined)) {
		return 'Codex thread 被锁定（上一轮可能尚未退出）。请 /new 开新会话，或等待数秒后重试。';
	}
	if (isCodexModelsCacheError(joined)) {
		return (
			'Codex 模型缓存损坏或与 CLI 版本不匹配。在 WSL 中执行：' +
			'rm -rf ~/.codex/cache/* && codex update && codex debug models，然后 /new 重试。'
		);
	}
	if (exitCode !== 0 && /timeout waiting for child process/i.test(joined)) {
		return 'Codex 刷新模型列表超时。请检查 WSL/网络或执行 /new 后重试。';
	}
	return undefined;
}

export class CodexProvider implements AgentProvider {
	readonly id = 'codex';
	readonly displayName = 'Codex';
	private modelCatalog: CodexModelCatalogEntry[] = [];
	private activeExec?: CodexExecHandle;

	constructor(
		private readonly getSetting: <T>(key: string, defaultValue: T) => T,
		private readonly log?: AgentRawLog,
	) {}

	private executable(): string {
		return this.getSetting('codex.executable', 'codex');
	}

	private cliContext(context?: AgentSessionContext): LinuxCliContext {
		const workspace = getWorkspaceContext();
		const raw =
			context?.linuxCwd ??
			context?.workspaceFolder ??
			context?.acpSpawnCwd ??
			workspace.linuxCwd;
		return mergeLinuxCliContext(workspace, {
			linuxCwd: toWslLinuxPath(raw, workspace.host) ?? workspace.linuxCwd,
		});
	}

	private async resolveAgentEnv(cliCtx: LinuxCliContext): Promise<LinuxAgentEnv> {
		const env = await resolveLinuxAgentEnv(cliCtx);
		if (shouldLogAgentEnv() && markAgentEnvLogged()) {
			this.log?.line('bridge', '--', `agent env: ${agentEnvForLog(env)}`);
		}
		return env;
	}

	async detect(): Promise<AgentAvailability> {
		const exe = this.executable();
		const cliCtx = this.cliContext();
		try {
			const linuxEnv = await this.resolveAgentEnv(cliCtx);
			const path = await resolveLinuxCommand(cliCtx, exe, linuxEnv);
			if (!path) {
				return { available: false, cliPresent: false, detail: `"${exe}" not found` };
			}
			return {
				available: true,
				cliPresent: true,
				detail: formatLinuxCliDetail(path, cliCtx),
			};
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { available: false, cliPresent: false, detail: message };
		}
	}

	async listModels(context: AgentSessionContext): Promise<AgentModelInfo[]> {
		const exe = this.executable();
		const cliCtx = this.cliContext(context);
		try {
			const linuxEnv = await this.resolveAgentEnv(cliCtx);
			const argv = await resolveLinuxArgv(cliCtx, exe, ['debug', 'models'], linuxEnv);
			if (argv) {
				const { stdout } = await runLinuxCli(cliCtx, argv, {
					timeout: 30_000,
					maxBuffer: 8 * 1024 * 1024,
					linuxEnv,
				});
				const catalog = parseCodexModelCatalog(stdout);
				if (catalog.length > 0) {
					this.modelCatalog = catalog;
					return catalog.map((m) => ({ id: m.id, label: m.label }));
				}
				const parsed = parseCodexDebugModelsJson(stdout);
				if (parsed.length > 0) {
					return parsed;
				}
			}
		} catch {
			// fall through to settings fallback
		}
		return modelsFromConfigFallback(
			(section) => this.getSetting<string[]>(section, []),
			this.id,
		);
	}

	getReasoningLevelsForModel(modelId: string): Array<{ id: string; label: string; description?: string }> {
		return codexReasoningLevelsForModel(this.modelCatalog, modelId).map(reasoningToModelOption);
	}

	async createSession(context: AgentSessionContext): Promise<AgentSession> {
		return createAgentSession({
			id: context.sessionId ?? newId('session'),
			providerId: this.id,
			providerSessionId: context.resumeProviderSessionId,
			modelId: context.modelId,
			workspaceCwd: context.linuxCwd ?? context.workspaceFolder,
		});
	}

	private stopActiveExec(): void {
		this.activeExec?.kill();
		this.activeExec = undefined;
	}

	async *sendPrompt(
		session: AgentSession,
		prompt: string,
		options?: SendPromptOptions,
	): AsyncIterable<AgentEvent> {
		yield* this.sendPromptOnce(session, prompt, options, false);
	}

	private async *sendPromptOnce(
		session: AgentSession,
		prompt: string,
		options: SendPromptOptions | undefined,
		retriedWithoutResume: boolean,
	): AsyncIterable<AgentEvent> {
		const exe = this.executable();
		const cliCtx = this.cliContext({
			linuxCwd: session.workspaceCwd,
			workspaceFolder: session.workspaceCwd,
		});

		const turnId = newId('turn');
		const modelId = options?.modelId ?? session.modelId;
		const host = getWorkspaceContext().host;
		const workspaceCwd =
			toWslLinuxPath(session.workspaceCwd, host) ?? session.workspaceCwd;

		const args = buildCodexExecArgs({
			prompt,
			modelId,
			reasoningId: options?.reasoningId,
			cwd: workspaceCwd,
			resumeId: retriedWithoutResume ? undefined : session.providerSessionId,
		});

		let linuxEnv: LinuxAgentEnv;
		try {
			linuxEnv = await this.resolveAgentEnv(cliCtx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				timestamp: Date.now(),
				message,
			};
			return;
		}

		let argv: string[] | undefined;
		try {
			argv = await resolveLinuxArgv(cliCtx, exe, args, linuxEnv);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				timestamp: Date.now(),
				message,
			};
			return;
		}

		if (!argv) {
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				timestamp: Date.now(),
				message: `Codex CLI not found ("${exe}")`,
			};
			return;
		}

		const codexPath = argv[0];

		if (!retriedWithoutResume) {
			session.status = 'RUNNING';
			yield {
				type: 'session.started',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				providerId: this.id,
			};

			this.log?.section(`codex exec · session ${session.id}`);
			this.log?.show?.(true);
		} else {
			session.status = 'RUNNING';
			this.log?.line('codex', '--', 'retry without resume');
		}
		this.log?.line('codex', '--', `${codexPath} ${args.map(shellQuote).join(' ')}`);
		if (workspaceCwd) {
			this.log?.line('codex', '--', `cwd=${workspaceCwd}`);
		}
		if (usesWslBridgeLog(cliCtx)) {
			this.log?.line('codex', '--', 'via wsl.exe');
		}

		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		let done = false;
		let exitCode = 0;
		let runError: Error | undefined;
		const stderrLines: string[] = [];

		const push = (event: AgentEvent) => {
			queue.push(event);
			wake?.();
		};

		let failedEarly = false;
		let mcpReminded = false;
		const exec = startCodexExec({
			cliCtx,
			argv,
			linuxEnv,
			signal: options?.signal,
			onStdoutLine: (line) => {
				this.log?.line('codex', '<<', line);
				const parsed = parseCodexJsonLine(line);
				if (!parsed?.type) {
					return;
				}
				if (parsed.type === 'thread.started' && typeof parsed.thread_id === 'string') {
					session.providerSessionId = parsed.thread_id;
					return;
				}
				if (parsed.type === 'item.started' && parsed.item) {
					const item = parsed.item;
					if (item.type === 'agent_message' || item.type === 'reasoning') {
						return;
					}
					push({
						type: 'tool.started',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
						tool: {
							toolCallId: item.id ?? newId('tool'),
							name: codexItemToolName(item),
							detail: codexItemDetail(item),
							activityGroup: codexItemActivityGroup(item),
							mutatesWorkspace: codexItemMutatesWorkspace(item),
						},
					});
					return;
				}
				if (parsed.type === 'item.completed' && parsed.item) {
					const item = parsed.item;
					if (item.type === 'agent_message' && typeof item.text === 'string') {
						push({
							type: 'agent.message.delta',
							sessionId: session.id,
							turnId,
							timestamp: Date.now(),
							text: item.text,
						});
						push({
							type: 'agent.message.completed',
							sessionId: session.id,
							turnId,
							timestamp: Date.now(),
							text: item.text,
						});
						return;
					}
					if (item.type === 'reasoning') {
						return;
					}
					push({
						type: 'tool.completed',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
						tool: {
							toolCallId: item.id ?? newId('tool'),
							name: codexItemToolName(item),
							detail: codexItemDetail(item),
							activityGroup: codexItemActivityGroup(item),
							mutatesWorkspace: codexItemMutatesWorkspace(item),
						},
						ok: codexItemCompletedOk(item),
						outcome: item.status,
					});
					return;
				}
				if (parsed.type === 'turn.completed') {
					push({
						type: 'turn.completed',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
					});
					return;
				}
				if (parsed.type === 'turn.failed' || parsed.type === 'error') {
					const message =
						parsed.error?.message ??
						(typeof parsed.message === 'string' ? parsed.message : 'Codex turn failed');
					failedEarly = true;
					this.stopActiveExec();
					done = true;
					wake?.();
					push({
						type: 'session.failed',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
						message,
					});
				}
			},
			onStderrLine: (line) => {
				const safe = sanitizeAgentLogLine(line);
				stderrLines.push(line);
				if (isCodexBackendError(line)) {
					if (!mcpReminded) {
						mcpReminded = true;
						this.log?.line('codex', '--', CODEX_MCP_REMINDER);
					}
					this.log?.line('codex', '--', safe);
					return;
				}
				this.log?.line('codex', '!!', safe);
			},
		});
		this.activeExec = exec;
		const runPromise = exec.promise
			.then((code) => {
				exitCode = code;
				this.log?.line('codex', '--', `exit ${code}`);
			})
			.catch((err: unknown) => {
				runError = err instanceof Error ? err : new Error(String(err));
			})
			.finally(() => {
				done = true;
				if (this.activeExec === exec) {
					this.activeExec = undefined;
				}
				wake?.();
			});

		if (options?.signal) {
			options.signal.addEventListener(
				'abort',
				() => {
					done = true;
					wake?.();
				},
				{ once: true },
			);
		}

		while (!done || queue.length > 0) {
			if (options?.signal?.aborted) {
				done = true;
				queue.length = 0;
				break;
			}
			if (queue.length === 0) {
				await new Promise<void>((resolve) => {
					wake = resolve;
				});
				wake = undefined;
				continue;
			}
			yield queue.shift()!;
		}

		await runPromise;

		if (failedEarly) {
			session.status = 'FAILED';
			return;
		}

		if (options?.signal?.aborted) {
			session.status = 'STOPPED';
			const err = new Error('Aborted');
			err.name = 'AbortError';
			throw err;
		}
		if (runError) {
			this.stopActiveExec();
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				message: runError.message,
			};
			return;
		}
		const failureReason = collectCodexFailureReason(stderrLines, exitCode);
		if (
			!retriedWithoutResume &&
			session.providerSessionId &&
			failureReason &&
			isCodexThreadStoreConflict(stderrLines.join('\n'))
		) {
			this.log?.line('codex', '--', 'thread lock — retry without resume');
			session.providerSessionId = undefined;
			yield* this.sendPromptOnce(session, prompt, options, true);
			return;
		}
		if (exitCode !== 0) {
			if (!failedEarly) {
				this.stopActiveExec();
			}
			session.status = 'FAILED';
			if (failureReason && isCodexThreadStoreConflict(stderrLines.join('\n'))) {
				session.providerSessionId = undefined;
			}
			yield {
				type: 'session.failed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				message: failureReason ?? `codex exited with code ${exitCode}`,
			};
			return;
		}
		session.status = 'READY';
	}

	async cancel(session: AgentSession): Promise<void> {
		this.stopActiveExec();
		session.status = 'STOPPED';
	}

	async dispose(session: AgentSession): Promise<void> {
		this.stopActiveExec();
		session.status = 'CLOSED';
	}
}

function usesWslBridgeLog(ctx: LinuxCliContext): boolean {
	return ctx.host === 'local-windows';
}
