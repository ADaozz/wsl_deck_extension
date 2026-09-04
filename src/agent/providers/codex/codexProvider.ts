import type {
	AgentAvailability,
	AgentModelInfo,
	AgentProvider,
	AgentSessionContext,
	SendPromptOptions,
} from '../../agentProvider';
import type { AgentEvent } from '../../agentEvents';
import type { AgentRawLog } from '../../agentRawLog';
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
	runLinuxCli,
	type LinuxCliContext,
} from '../../../workspace/linuxCliBridge';
import { getWorkspaceContext } from '../../../workspace/workspaceContext';
import {
	codexItemActivityGroup,
	codexItemCompletedOk,
	codexItemDetail,
	codexItemMutatesWorkspace,
	codexItemToolName,
	parseCodexJsonLine,
} from './codexEvents';
import { buildCodexExecArgs, runCodexExec } from './codexProcess';

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export class CodexProvider implements AgentProvider {
	readonly id = 'codex';
	readonly displayName = 'Codex';
	private modelCatalog: CodexModelCatalogEntry[] = [];

	constructor(
		private readonly getSetting: <T>(key: string, defaultValue: T) => T,
		private readonly log?: AgentRawLog,
	) {}

	private executable(): string {
		return this.getSetting('codex.executable', 'codex');
	}

	private cliContext(context?: AgentSessionContext): LinuxCliContext {
		const workspace = getWorkspaceContext();
		return mergeLinuxCliContext(workspace, {
			linuxCwd:
				context?.linuxCwd ??
				context?.workspaceFolder ??
				context?.acpSpawnCwd ??
				workspace.linuxCwd,
		});
	}

	async detect(): Promise<AgentAvailability> {
		const exe = this.executable();
		const cliCtx = this.cliContext();
		try {
			const path = await resolveLinuxCommand(cliCtx, exe);
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
			const path = await resolveLinuxCommand(cliCtx, exe);
			if (path) {
				const { stdout } = await runLinuxCli(cliCtx, [exe, 'debug', 'models'], {
					timeout: 30_000,
					maxBuffer: 8 * 1024 * 1024,
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

	async *sendPrompt(
		session: AgentSession,
		prompt: string,
		options?: SendPromptOptions,
	): AsyncIterable<AgentEvent> {
		const exe = this.executable();
		const cliCtx = this.cliContext({
			linuxCwd: session.workspaceCwd,
			workspaceFolder: session.workspaceCwd,
		});

		let codexPath: string | undefined;
		try {
			codexPath = await resolveLinuxCommand(cliCtx, exe);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			yield {
				type: 'session.failed',
				sessionId: session.id,
				timestamp: Date.now(),
				message,
			};
			return;
		}

		if (!codexPath) {
			yield {
				type: 'session.failed',
				sessionId: session.id,
				timestamp: Date.now(),
				message: `Codex CLI not found ("${exe}")`,
			};
			return;
		}

		const turnId = newId('turn');
		const modelId = options?.modelId ?? session.modelId;
		const workspaceCwd = session.workspaceCwd;

		session.status = 'RUNNING';
		yield {
			type: 'session.started',
			sessionId: session.id,
			turnId,
			timestamp: Date.now(),
			providerId: this.id,
		};

		const args = buildCodexExecArgs({
			prompt,
			modelId,
			reasoningId: options?.reasoningId,
			cwd: workspaceCwd,
			resumeId: session.providerSessionId,
		});
		const argv = [exe, ...args];

		this.log?.section(`codex exec · session ${session.id}`);
		this.log?.show?.(true);
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
		let agentText = '';

		const push = (event: AgentEvent) => {
			queue.push(event);
			wake?.();
		};

		const runPromise = runCodexExec({
			cliCtx,
			argv,
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
						agentText = item.text;
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
				this.log?.line('codex', '!!', line);
			},
		})
			.then((code) => {
				exitCode = code;
				this.log?.line('codex', '--', `exit ${code}`);
			})
			.catch((err: unknown) => {
				runError = err instanceof Error ? err : new Error(String(err));
			})
			.finally(() => {
				done = true;
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

		if (options?.signal?.aborted) {
			session.status = 'STOPPED';
			const err = new Error('Aborted');
			err.name = 'AbortError';
			throw err;
		}
		if (runError) {
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
		if (exitCode !== 0 && !agentText) {
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				message: `codex exited with code ${exitCode}`,
			};
			return;
		}
		session.status = 'READY';
	}

	async cancel(session: AgentSession): Promise<void> {
		session.status = 'STOPPED';
	}

	async dispose(session: AgentSession): Promise<void> {
		session.status = 'CLOSED';
	}
}

function usesWslBridgeLog(ctx: LinuxCliContext): boolean {
	return ctx.host === 'local-windows';
}
