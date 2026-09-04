import { homedir } from 'node:os';
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
import { modelsFromConfigFallback } from '../../modelCatalog';
import { CursorAcpClient, parseAcpAvailableModels, parseCursorModelList } from './cursorAcpClient';
import {
	acpToolActivityGroup,
	acpToolCompletedOk,
	acpToolIdentity,
	acpToolMutatesWorkspace,
	acpTextChunk,
	extractAcpUpdate,
	normalizeAcpToolCallId,
	parseAcpPermissionRequest,
} from './cursorEvents';
import {
	parseAcpModeOptionIds,
	parseAcpReasoningOptions,
	reasoningToModelOption,
	type ReasoningOption,
} from '../../sessionConfigSlash';
import { filterAcpModeIds } from '../../../state/workspaceDeckStore';
import {
	catalogToAgentModels,
	fetchCursorSdkCatalog,
	modelIdWithFast,
	modelIdWithReasoning,
	fastOptionsForModel,
	reasoningOptionsForModel,
	type CursorSdkCatalog,
} from './cursorSdkModels';
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

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

type SessionHandle = AgentSession & {
	workspaceCwd?: string;
	acp?: CursorAcpClient;
	acpReady?: boolean;
	appliedModeId?: string;
	appliedReasoningId?: string;
	/** Last ACP configOptions from session/new|load (for UI catalogs). */
	lastConfigOptions?: unknown;
	lastModesField?: unknown;
	lastModelsPayload?: unknown;
	acpStartPromise?: Promise<CursorAcpClient>;
	cancelPromise?: Promise<void>;
};

export function cursorLoginMethod(initializeResult: unknown): string | undefined {
	if (!initializeResult || typeof initializeResult !== 'object') {
		return undefined;
	}
	const methods = (initializeResult as { authMethods?: Array<{ id?: unknown }> }).authMethods;
	if (!Array.isArray(methods)) {
		return undefined;
	}
	return methods.some((method) => method?.id === 'cursor_login')
		? 'cursor_login'
		: undefined;
}

export class CursorProvider implements AgentProvider {
	readonly id = 'cursor';
	readonly displayName = 'Cursor';
	private readonly handles = new Map<string, SessionHandle>();
	private sdkCatalog?: CursorSdkCatalog;
	private sdkFetchPromise?: Promise<CursorSdkCatalog | undefined>;
	/** Pending ACP permission RPC responses keyed by requestId */
	private readonly pendingPermissions = new Map<
		string,
		{ sessionId: string; respond: (result: unknown) => void }
	>();

	constructor(
		private readonly getSetting: <T>(key: string, defaultValue: T) => T,
		private readonly log?: AgentRawLog,
	) {}

	private shellApiKeyCache?: string;

	private resolveSdkApiKey(): string {
		const configured = this.getSetting('cursor.apiKey', '').trim();
		if (configured) {
			return configured;
		}
		return process.env.CURSOR_API_KEY?.trim() ?? '';
	}

	private async resolveApiKey(cliCtx?: LinuxCliContext): Promise<string> {
		const sdkKey = this.resolveSdkApiKey();
		if (sdkKey) {
			return sdkKey;
		}
		if (this.shellApiKeyCache) {
			return this.shellApiKeyCache;
		}
		const ctx = cliCtx ?? this.cliContext();
		if (ctx.host === 'local-windows' && !ctx.linuxCwd) {
			return '';
		}
		try {
			const env = await resolveLinuxAgentEnv(ctx);
			const fromLinux = env.CURSOR_API_KEY?.trim() ?? '';
			if (fromLinux) {
				this.shellApiKeyCache = fromLinux;
				return fromLinux;
			}
		} catch {
			// fall through
		}
		return '';
	}

	private async resolveAgentEnv(
		cliCtx: LinuxCliContext,
		overrides?: Record<string, string | undefined>,
	): Promise<LinuxAgentEnv> {
		const env = await resolveLinuxAgentEnv(cliCtx, overrides);
		if (shouldLogAgentEnv() && markAgentEnvLogged()) {
			this.log?.line('bridge', '--', `agent env: ${agentEnvForLog(env)}`);
		}
		return env;
	}

	private async ensureSdkCatalog(force = false): Promise<CursorSdkCatalog | undefined> {
		if (!force && this.sdkCatalog) {
			return this.sdkCatalog;
		}
		const key = this.resolveSdkApiKey() || (await this.resolveApiKey());
		if (!key) {
			this.log?.line('cursor', '--', 'SDK models: no API key (set wsldeck.cursor.apiKey or CURSOR_API_KEY)');
			return undefined;
		}
		if (!force && this.sdkFetchPromise) {
			return this.sdkFetchPromise;
		}
		this.sdkFetchPromise = (async () => {
			try {
				const catalog = await fetchCursorSdkCatalog(key);
				this.sdkCatalog = catalog;
				this.log?.line('cursor', '--', `SDK models: ${catalog.models.length} variants`);
				return catalog;
			} catch (err) {
				this.log?.line(
					'cursor',
					'!!',
					`SDK models.list failed: ${err instanceof Error ? err.message : String(err)}`,
				);
				return undefined;
			} finally {
				this.sdkFetchPromise = undefined;
			}
		})();
		return this.sdkFetchPromise;
	}

	getReasoningLevelsForModel(modelId: string): Array<{
		id: string;
		label: string;
		description?: string;
	}> {
		if (modelId === 'auto' || modelId === 'auto-smart') {
			return [];
		}
		if (this.sdkCatalog) {
			return reasoningOptionsForModel(this.sdkCatalog, modelId).map(reasoningToModelOption);
		}
		return [];
	}

	getFastOptionsForModel(modelId: string): Array<{
		id: string;
		label: string;
		description?: string;
	}> {
		if (modelId === 'auto' || modelId === 'auto-smart') {
			return [];
		}
		if (this.sdkCatalog) {
			return fastOptionsForModel(this.sdkCatalog, modelId).map(reasoningToModelOption);
		}
		return [];
	}

	resolveModelWithReasoning(flatModelId: string, reasoningValue: string): string | undefined {
		if (!this.sdkCatalog) {
			return undefined;
		}
		return modelIdWithReasoning(this.sdkCatalog, flatModelId, reasoningValue);
	}

	resolveModelWithFast(flatModelId: string, fastValue: string): string | undefined {
		if (!this.sdkCatalog) {
			return undefined;
		}
		return modelIdWithFast(this.sdkCatalog, flatModelId, fastValue);
	}

	usesSdkModelCatalog(): boolean {
		return !!this.sdkCatalog;
	}

	private executable(): string {
		return this.getSetting('cursor.executable', 'agent');
	}

	private cliContext(context?: AgentSessionContext | SessionHandle): LinuxCliContext {
		const workspace = getWorkspaceContext();
		const handle = context as SessionHandle | undefined;
		const sessionCtx = context as AgentSessionContext | undefined;
		const raw =
			handle?.workspaceCwd ??
			handle?.acpSpawnCwd ??
			sessionCtx?.linuxCwd ??
			sessionCtx?.workspaceFolder ??
			sessionCtx?.acpSpawnCwd ??
			workspace.linuxCwd;
		return mergeLinuxCliContext(workspace, {
			linuxCwd: toWslLinuxPath(raw, workspace.host) ?? workspace.linuxCwd,
		});
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
		const byId = new Map<string, AgentModelInfo>();
		const addAll = (rows: AgentModelInfo[]) => {
			for (const m of rows) {
				if (!byId.has(m.id)) {
					byId.set(m.id, m);
				}
			}
		};

		const sdk = await this.ensureSdkCatalog();
		if (sdk) {
			addAll(catalogToAgentModels(sdk));
			if (byId.size > 0) {
				return [...byId.values()];
			}
		}

		// Fallback: ACP session catalog, then CLI, then settings.
		for (const handle of this.handles.values()) {
			addAll(parseAcpAvailableModels(handle.lastModelsPayload));
			addAll(parseAcpAvailableModels({ configOptions: handle.lastConfigOptions }));
		}

		const exe = this.executable();
		const cliCtx = this.cliContext(context);
		try {
			const linuxEnv = await this.resolveAgentEnv(cliCtx);
			const argv = await resolveLinuxArgv(cliCtx, exe, ['--list-models'], linuxEnv);
			if (argv) {
				const { stdout } = await runLinuxCli(cliCtx, argv, {
					timeout: 90_000,
					maxBuffer: 8 * 1024 * 1024,
					linuxEnv,
				});
				addAll(parseCursorModelList(stdout));
			}
		} catch {
			// fall through
		}

		if (byId.size === 0) {
			addAll(
				modelsFromConfigFallback(
					(section) => this.getSetting<string[]>(section, []),
					this.id,
				),
			);
		}
		return [...byId.values()];
	}

	async createSession(context: AgentSessionContext): Promise<AgentSession> {
		const session = createAgentSession({
			id: context.sessionId ?? newId('session'),
			providerId: this.id,
			providerSessionId: context.resumeProviderSessionId,
			modelId: context.modelId,
			workspaceCwd: context.linuxCwd ?? context.workspaceFolder,
			acpSpawnCwd:
				context.acpSpawnCwd ?? context.workspaceFolder ?? context.linuxCwd ?? homedir(),
		}) as SessionHandle;
		this.handles.set(session.id, session);
		return session;
	}

	private resolveAcpSpawnCwd(session: SessionHandle): string {
		return session.acpSpawnCwd ?? homedir();
	}

	private resolveAcpSessionCwd(session: SessionHandle): string {
		const raw = session.workspaceCwd ?? this.resolveAcpSpawnCwd(session);
		const host = getWorkspaceContext().host;
		return toWslLinuxPath(raw, host) ?? raw;
	}

	private async acpLinuxEnv(
		cliCtx: LinuxCliContext,
	): Promise<{ env: LinuxAgentEnv; unsetEnvKeys: string[] }> {
		// ACP reuses `agent login`; never let an API key override the CLI credential store.
		return {
			env: await this.resolveAgentEnv(cliCtx, {
				CURSOR_API_KEY: undefined,
				NO_OPEN_BROWSER: '1',
			}),
			unsetEnvKeys: ['CURSOR_API_KEY'],
		};
	}

	private async stopAcp(handle: SessionHandle): Promise<void> {
		if (!handle.acp) {
			handle.acpReady = false;
			return;
		}
		await handle.acp.dispose();
		handle.acp = undefined;
		handle.acpReady = false;
	}

	private async ensureAcp(session: SessionHandle): Promise<CursorAcpClient> {
		if (session.acp && session.acpReady && session.acp.isRunning()) {
			return session.acp;
		}
		if (session.acpStartPromise) {
			return session.acpStartPromise;
		}
		const startPromise = this.startAcp(session);
		session.acpStartPromise = startPromise;
		try {
			return await startPromise;
		} catch (err) {
			await this.stopAcp(session);
			throw err;
		} finally {
			if (session.acpStartPromise === startPromise) {
				session.acpStartPromise = undefined;
			}
		}
	}

	private async startAcp(session: SessionHandle): Promise<CursorAcpClient> {
		if (session.acp) {
			await this.stopAcp(session);
		}
		const exe = this.executable();
		const cliCtx = this.cliContext(session);
		const { env: linuxEnv, unsetEnvKeys } = await this.acpLinuxEnv(cliCtx);
		const argv = await resolveLinuxArgv(cliCtx, exe, ['acp'], linuxEnv);
		if (!argv) {
			throw new Error(`Cursor CLI not found ("${exe}")`);
		}
		const client = new CursorAcpClient(this.log);
		session.acp = client;
		const sessionCwd = this.resolveAcpSessionCwd(session);
		await client.start({
			cliCtx,
			argv,
			linuxEnv,
			unsetEnvKeys,
		});
		this.log?.line('cursor', '--', `${formatLinuxCliDetail(argv[0], cliCtx)} acp`);
		if (sessionCwd) {
			this.log?.line('cursor', '--', `session cwd=${sessionCwd}`);
		}

		const initialized = await client.request('initialize', {
			protocolVersion: 1,
			clientCapabilities: {
				fs: { readTextFile: false, writeTextFile: false },
				terminal: false,
			},
			clientInfo: { name: 'wsldeck-extension', version: '0.0.1' },
		});
		const loginMethod = cursorLoginMethod(initialized);
		if (loginMethod) {
			await client.request('authenticate', { methodId: loginMethod }, 60_000);
			this.log?.line('cursor', '--', 'authenticated with agent login credentials');
		}

		if (session.providerSessionId) {
			try {
				const loaded = (await client.request('session/load', {
					sessionId: session.providerSessionId,
					cwd: sessionCwd,
					mcpServers: [],
				})) as {
					sessionId?: string;
					configOptions?: unknown;
					modes?: unknown;
					models?: unknown;
				};
				session.lastConfigOptions = loaded.configOptions;
				session.lastModesField = loaded.modes;
				session.lastModelsPayload = loaded;
			} catch {
				const created = (await client.request('session/new', {
					cwd: sessionCwd,
					mcpServers: [],
				})) as {
					sessionId?: string;
					configOptions?: unknown;
					modes?: unknown;
					models?: unknown;
				};
				session.providerSessionId = created.sessionId;
				session.lastConfigOptions = created.configOptions;
				session.lastModesField = created.modes;
				session.lastModelsPayload = created;
			}
		} else {
			const created = (await client.request('session/new', {
				cwd: sessionCwd,
				mcpServers: [],
			})) as {
				sessionId?: string;
				configOptions?: unknown;
				modes?: unknown;
				models?: unknown;
			};
			session.providerSessionId = created.sessionId;
			session.lastConfigOptions = created.configOptions;
			session.lastModesField = created.modes;
			session.lastModelsPayload = created;
		}

		session.acpReady = true;
		return client;
	}

	private requestCancel(handle: SessionHandle): Promise<void> {
		if (handle.cancelPromise) {
			return handle.cancelPromise;
		}
		if (!handle.acp || !handle.providerSessionId || !handle.acp.isRunning()) {
			return Promise.resolve();
		}
		const cancelPromise = handle.acp
			.request(
				'session/cancel',
				{ sessionId: handle.providerSessionId },
				10_000,
			)
			.then(() => undefined)
			.catch(() => undefined)
			.finally(() => {
				if (handle.cancelPromise === cancelPromise) {
					handle.cancelPromise = undefined;
				}
			});
		handle.cancelPromise = cancelPromise;
		return cancelPromise;
	}

	/** Open ACP early so model/reasoning catalogs are available before the first prompt. */
	async warmSessionCatalog(sessionId: string): Promise<void> {
		if (this.sdkCatalog) {
			return;
		}
		const handle = this.handles.get(sessionId);
		if (!handle) {
			return;
		}
		await this.ensureAcp(handle);
	}

	/** Apply model in ACP and refresh reasoning options for that model. */
	async applyModelSelection(sessionId: string, modelId: string): Promise<void> {
		if (this.sdkCatalog) {
			return;
		}
		const handle = this.handles.get(sessionId);
		if (!handle) {
			return;
		}
		const client = await this.ensureAcp(handle);
		if (!handle.providerSessionId) {
			return;
		}
		try {
			const result = (await client.request('session/set_config_option', {
				sessionId: handle.providerSessionId,
				configId: 'model',
				value: modelId,
			})) as { configOptions?: unknown; models?: unknown };
			if (result.configOptions !== undefined) {
				handle.lastConfigOptions = result.configOptions;
			}
			if (result.models !== undefined) {
				handle.lastModelsPayload = result;
			}
		} catch (err) {
			this.log?.line(
				'cursor',
				'!!',
				`set model failed: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/** Expose last ACP catalogs for the UI (mode / reasoning / models). */
	getSessionConfigCatalog(sessionId: string): {
		modes: string[];
		reasonings: ReasoningOption[];
		models: Array<{ id: string; label: string }>;
	} {
		const handle = this.handles.get(sessionId);
		const modeIds = filterAcpModeIds(
			parseAcpModeOptionIds(handle?.lastConfigOptions, handle?.lastModesField),
		);
		const reasonings = parseAcpReasoningOptions(handle?.lastConfigOptions);
		const models = [
			...parseAcpAvailableModels(handle?.lastModelsPayload),
			...parseAcpAvailableModels({ configOptions: handle?.lastConfigOptions }),
		];
		return { modes: modeIds, reasonings, models };
	}

	private async applySessionConfig(
		client: CursorAcpClient,
		handle: SessionHandle,
		options?: SendPromptOptions,
	): Promise<void> {
		const sessionId = handle.providerSessionId;
		if (!sessionId) {
			return;
		}
		const modeId = options?.modeId;
		if (modeId && modeId !== handle.appliedModeId) {
			try {
				await client.request('session/set_config_option', {
					sessionId,
					configId: 'mode',
					value: modeId,
				});
				handle.appliedModeId = modeId;
			} catch (err) {
				this.log?.line(
					'cursor',
					'!!',
					`set mode failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
		const reasoningId = options?.reasoningId;
		const modelId = options?.modelId;
		const modelEncodesReasoning =
			!!this.sdkCatalog && !!modelId && this.sdkCatalog.byFlatId.has(modelId);
		if (reasoningId && reasoningId !== handle.appliedReasoningId && !modelEncodesReasoning) {
			const configId = this.guessReasoningConfigId(handle.lastConfigOptions);
			try {
				await client.request('session/set_config_option', {
					sessionId,
					configId,
					value: reasoningId,
				});
				handle.appliedReasoningId = reasoningId;
			} catch (err) {
				this.log?.line(
					'cursor',
					'!!',
					`set reasoning failed: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}
	}

	private guessReasoningConfigId(configOptions: unknown): string {
		if (Array.isArray(configOptions)) {
			for (const raw of configOptions) {
				if (!raw || typeof raw !== 'object') {
					continue;
				}
				const opt = raw as { id?: string; category?: string; name?: string };
				const id = (opt.id ?? '').toLowerCase();
				const category = (opt.category ?? '').toLowerCase();
				const name = (opt.name ?? '').toLowerCase();
				if (
					category === 'reasoning' ||
					id.includes('reason') ||
					id.includes('effort') ||
					name.includes('reasoning') ||
					name.includes('effort')
				) {
					return opt.id ?? 'reasoning';
				}
			}
		}
		return 'reasoning';
	}

	async *sendPrompt(
		session: AgentSession,
		prompt: string,
		options?: SendPromptOptions,
	): AsyncIterable<AgentEvent> {
		const handle = (this.handles.get(session.id) as SessionHandle | undefined) ?? (session as SessionHandle);
		if (!handle.acpSpawnCwd && session.acpSpawnCwd) {
			handle.acpSpawnCwd = session.acpSpawnCwd;
		}
		this.handles.set(session.id, handle);

		const turnId = newId('turn');
		session.status = 'RUNNING';
		if (options?.modelId) {
			session.modelId = options.modelId;
		}

		yield {
			type: 'session.started',
			sessionId: session.id,
			turnId,
			timestamp: Date.now(),
			providerId: this.id,
		};

		this.log?.section(`cursor prompt · session ${session.id}`);
		this.log?.show?.(true);

		const queue: AgentEvent[] = [];
		let wake: (() => void) | undefined;
		let promptDone = false;
		let promptError: Error | undefined;

		const push = (event: AgentEvent) => {
			queue.push(event);
			wake?.();
		};

		let client: CursorAcpClient;
		try {
			client = await this.ensureAcp(handle);
			if (options?.modelId) {
				await this.applyModelSelection(session.id, options.modelId);
			}
			await this.applySessionConfig(client, handle, options);
		} catch (err) {
			await this.stopAcp(handle);
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				message: err instanceof Error ? err.message : String(err),
			};
			return;
		}

		client.setNotificationHandler((method, params, respond) => {
			if (method === 'session/request_permission') {
				const parsed = parseAcpPermissionRequest(params);
				const requestId = newId('perm');
				const toolCallId =
					normalizeAcpToolCallId(parsed.toolCallId) || newId('tool');
				const title = parsed.title || 'Permission required';
				const toolMeta = {
					toolCallId,
					name: title,
					title,
					kind: parsed.kind,
					detail: parsed.detail,
				};
				push({
					type: 'tool.started',
					sessionId: session.id,
					turnId,
					timestamp: Date.now(),
					tool: toolMeta,
				});
				this.pendingPermissions.set(requestId, {
					sessionId: session.id,
					respond,
				});
				push({
					type: 'permission.requested',
					sessionId: session.id,
					turnId,
					timestamp: Date.now(),
					requestId,
					message: title,
					tool: toolMeta,
					options: parsed.options,
				});
				return;
			}
			if (method === 'cursor/ask_question') {
				respond({ outcome: { outcome: 'skipped', reason: 'WSLDeck auto-skip' } });
				return;
			}
			if (method === 'cursor/create_plan') {
				respond({ outcome: { outcome: 'accepted' } });
				return;
			}
			if (method !== 'session/update') {
				return;
			}
			const update = extractAcpUpdate(params);
			if (!update) {
				return;
			}
			const kind = update.sessionUpdate ?? '';
			if (kind === 'agent_thought_chunk') {
				const text = acpTextChunk(update);
				if (!text) {
					return;
				}
				push({
					type: 'agent.thought.delta',
					sessionId: session.id,
					turnId,
					timestamp: Date.now(),
					text,
				});
				return;
			}
			if (kind === 'agent_message_chunk') {
				const text = acpTextChunk(update);
				if (!text) {
					return;
				}
				push({
					type: 'agent.message.delta',
					sessionId: session.id,
					turnId,
					timestamp: Date.now(),
					text,
				});
				return;
			}
			if (kind === 'tool_call' || kind === 'tool_call_update') {
				const toolCallId =
					normalizeAcpToolCallId(
						typeof update.toolCallId === 'string' ? update.toolCallId : undefined,
					) || newId('tool');
				const identity = acpToolIdentity(update);
				const status = typeof update.status === 'string' ? update.status : '';
				const toolMeta = {
					toolCallId,
					name: identity.title,
					title: identity.title,
					kind: identity.kind,
					detail: identity.detail,
					activityGroup: acpToolActivityGroup(update),
					mutatesWorkspace: acpToolMutatesWorkspace(update),
				};
				if (status === 'completed' || status === 'failed') {
					push({
						type: 'tool.completed',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
						tool: toolMeta,
						ok: acpToolCompletedOk(update),
						outcome: status,
					});
					return;
				}
				if (kind === 'tool_call' || status === 'pending' || status === 'in_progress' || !status) {
					push({
						type: 'tool.started',
						sessionId: session.id,
						turnId,
						timestamp: Date.now(),
						tool: toolMeta,
					});
				}
			}
		});

		const onAbort = () => {
			this.rejectPendingPermissions(session.id, 'Aborted');
			void this.requestCancel(handle);
			promptDone = true;
			wake?.();
		};
		if (options?.signal) {
			if (options.signal.aborted) {
				onAbort();
			} else {
				options.signal.addEventListener('abort', onAbort, { once: true });
			}
		}

		const promptParams: Record<string, unknown> = {
			sessionId: handle.providerSessionId,
			prompt: [{ type: 'text', text: prompt }],
		};
		if (options?.modelId && options.modelId !== 'default' && options.modelId !== 'Auto') {
			promptParams._meta = { model: options.modelId };
		}

		const promptPromise = client
			.request('session/prompt', promptParams)
			.then(() => undefined)
			.catch((err: unknown) => {
				promptError = err instanceof Error ? err : new Error(String(err));
			})
			.finally(() => {
				promptDone = true;
				wake?.();
			});

		const abortWait =
			options?.signal &&
			new Promise<void>((resolve) => {
				if (options.signal!.aborted) {
					resolve();
					return;
				}
				options.signal!.addEventListener('abort', () => resolve(), { once: true });
			});

		let assembled = '';
		while (!promptDone || queue.length > 0) {
			if (options?.signal?.aborted) {
				promptDone = true;
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
			const event = queue.shift()!;
			if (event.type === 'agent.message.delta') {
				assembled += event.text;
			}
			yield event;
		}

		await Promise.race([promptPromise, abortWait ?? promptPromise]);

		if (options?.signal?.aborted) {
			session.status = 'STOPPED';
			const err = new Error('Aborted');
			err.name = 'AbortError';
			throw err;
		}

		if (assembled) {
			yield {
				type: 'agent.message.completed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				text: assembled,
			};
		}

		if (promptError) {
			await this.stopAcp(handle);
			session.status = 'FAILED';
			yield {
				type: 'session.failed',
				sessionId: session.id,
				turnId,
				timestamp: Date.now(),
				message: promptError.message,
			};
			return;
		}

		yield {
			type: 'turn.completed',
			sessionId: session.id,
			turnId,
			timestamp: Date.now(),
		};
		session.status = 'READY';
	}

	async cancel(session: AgentSession): Promise<void> {
		const handle = this.handles.get(session.id) as SessionHandle | undefined;
		this.rejectPendingPermissions(session.id, 'Cancelled');
		if (handle) {
			await this.requestCancel(handle);
		}
		session.status = 'STOPPED';
	}

	async resolvePermission(
		session: AgentSession,
		requestId: string,
		optionId: string,
	): Promise<void> {
		const pending = this.pendingPermissions.get(requestId);
		if (!pending || pending.sessionId !== session.id) {
			throw new Error(`Unknown permission request: ${requestId}`);
		}
		this.pendingPermissions.delete(requestId);
		pending.respond({
			outcome: { outcome: 'selected', optionId },
		});
	}

	async dispose(session: AgentSession): Promise<void> {
		const handle = this.handles.get(session.id) as SessionHandle | undefined;
		this.rejectPendingPermissions(session.id, 'Session closed');
		if (handle?.acp) {
			await handle.acp.dispose();
			handle.acp = undefined;
			handle.acpReady = false;
		}
		this.handles.delete(session.id);
		session.status = 'CLOSED';
	}

	private rejectPendingPermissions(sessionId: string, reason: string): void {
		for (const [requestId, pending] of [...this.pendingPermissions.entries()]) {
			if (pending.sessionId !== sessionId) {
				continue;
			}
			this.pendingPermissions.delete(requestId);
			try {
				pending.respond({
					outcome: { outcome: 'selected', optionId: 'reject-once' },
				});
			} catch {
				this.log?.line('cursor', '!!', `permission reject failed: ${reason}`);
			}
		}
	}
}
