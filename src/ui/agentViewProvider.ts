import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { AgentEvent } from '../agent/agentEvents';
import { AgentSessionManager } from '../agent/agentSessionManager';
import { createAgentSession } from '../agent/agentSession';
import { parseModelSlash, pickModelId } from '../agent/modelCatalog';
import {
	CURSOR_REASONING_FALLBACK,
	parseModeSlash,
	reasoningToModelOption,
} from '../agent/sessionConfigSlash';
import type { CodexProvider } from '../agent/providers/codex/codexProvider';
import type { CursorProvider } from '../agent/providers/cursor/cursorProvider';
import type { ReasoningOption } from '../agent/sessionConfigSlash';
import {
	acceptAll,
	acceptChange,
	cancelAll,
	cancelChange,
	compareMain,
	viewDiff,
} from '../change/changeActions';
import { detectProposedChanges } from '../change/changeTracker';
import { enrichChangesWithRevisions, viewRevisionDiff } from '../change/changeRevisions';
import type { ProposedChange } from '../change/proposedChange';
import { normalizeActivityForDisplay, rewriteShadowPathsInText } from './activityDisplay';
import { shadowSessionDir } from '../shadow/shadowPaths';
import { ShadowWorkspaceManager } from '../shadow/shadowWorkspaceManager';
import {
	isNoteworthySession,
	migrateToWorkspaceSessions,
	sanitizeMessagesForPersist,
	sessionTitleFromMessages,
	upsertProviderSession,
	SESSION_STATE_KEY,
	SESSION_STATE_KEY_V1,
	type PersistedAgentSession,
	type PersistedProviderLane,
	type PersistedWorkspaceSessions,
} from '../state/sessionStore';
import {
	ACP_MODES,
	type AgentModeId,
	deleteSessionDeck,
	listSessionDeckIds,
	listShadowSessionIds,
	materializeChanges,
	readResumeIndex,
	readSessionDeck,
	setResumeIndexActive,
	upsertResumeEntry,
	writeSessionDeck,
} from '../state/workspaceDeckStore';
import { getWorkspaceContext, NO_WORKSPACE_FOLDER_HINT } from '../workspace/workspaceContext';
import { runInWslTerminal } from '../terminal/terminalService';
import {
	activityFromTool,
	DEFAULT_SLASH_COMMANDS,
	type ActivityItem,
	type AgentViewState,
	type ConversationMessage,
	type HostToWebviewMessage,
	type ModelOption,
	type PendingPermissionCard,
	type ProposedChangeCard,
	type ResumeOption,
	type WebviewToHostMessage,
} from './messageProtocol';
import {
	activityPathHint,
	isFileMutatingActivity,
	shouldRefreshChangesForTool,
} from './activityGrouping';

const VIEW_TYPE = 'wsldeck.agentView';

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

interface ProviderUiLane {
	sessionId: string;
	providerSessionId?: string;
	modelId: string;
	modeId: AgentModeId;
	reasoningId: string;
	/** Live catalog from provider CLI (`/model` / chip). Empty until fetched. */
	models: ModelOption[];
	modelsLoading?: boolean;
	modelsError?: string;
	reasonings: ModelOption[];
	/** Fast tier (Cursor SDK `fast` param) after reasoning when applicable. */
	fasts: ModelOption[];
	fastId: string;
	/** All resumes for this agent in the workspace (includes active). */
	resumes: PersistedAgentSession[];
	messages: ConversationMessage[];
	activities: ActivityItem[];
	pendingPermission?: PendingPermissionCard;
	changes: ProposedChange[];
	status: AgentViewState['status'];
	error?: string;
	restoredFromPersist: boolean;
	/** Latest provider turn id for revision grouping */
	activeTurnId?: string;
}

/**
 * Each agent (Codex / Cursor) keeps an independent lane in this workspace:
 * own transcript, own model, own resume id — switching agents does not share process.
 */
export class AgentViewProvider implements vscode.WebviewViewProvider {
	public static readonly viewType = VIEW_TYPE;

	private view?: vscode.WebviewView;
	private selectedProviderId: string;
	private readonly lanes = new Map<string, ProviderUiLane>();
	private readonly shadows = new ShadowWorkspaceManager();
	private statusDetail?: string;
	private statusFlashToken = 0;
	/** Debounced workspaceState + resume index writes (not every UI tick). */
	private persistTimer: ReturnType<typeof setTimeout> | undefined;
	private persistWantsPrune = false;
	private legacyShadowsCleaned = false;
	/** Bumped on Stop / new turn so in-flight handlePrompt ignores late events. */
	private readonly runTokens = new Map<string, number>();

	constructor(
		private readonly context: vscode.ExtensionContext,
		private readonly sessions: AgentSessionManager,
	) {
		const cfg = vscode.workspace.getConfiguration('wsldeck');
		this.selectedProviderId = cfg.get<string>('agent.defaultProvider', 'codex');
		this.restoreAll();
		this.ensureLane(this.selectedProviderId);
		this.sessions.focus(this.selectedProviderId);
		context.subscriptions.push(
			vscode.workspace.onDidChangeWorkspaceFolders(() => {
				this.pushState();
			}),
		);
	}

	dispose(): void {
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
			this.persistTimer = undefined;
			this.persistAll({ prune: false });
		}
		void this.shadows.disposeAll();
	}

	/** One-shot: drop old in-workspace worktrees that spam SCM Diff. */
	private async cleanupLegacyShadowsOnce(): Promise<void> {
		if (this.legacyShadowsCleaned) {
			return;
		}
		this.legacyShadowsCleaned = true;
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		try {
			const n = await this.shadows.disposeLegacyInWorkspaceShadows(main);
			if (n > 0) {
				this.post({
					type: 'toast',
					message: `Cleaned ${n} legacy in-workspace shadow(s) (fixes Diff spam).`,
				});
			}
		} catch {
			// ignore
		}
	}

	private get extensionUri(): vscode.Uri {
		return this.context.extensionUri;
	}

	private lane(providerId = this.selectedProviderId): ProviderUiLane {
		return this.ensureLane(providerId);
	}

	private ensureLane(providerId: string): ProviderUiLane {
		let lane = this.lanes.get(providerId);
		if (!lane) {
			const preferred = vscode.workspace
				.getConfiguration('wsldeck')
				.get<string>('agent.defaultModel', '')
				?.trim();
			lane = {
				sessionId: newId('session'),
				modelId: preferred || 'default',
				modeId: 'agent',
				reasoningId: 'medium',
				fastId: 'false',
				models: [],
				reasonings: [],
				fasts: [],
				resumes: [],
				messages: [],
				activities: [],
				changes: [],
				status: 'idle',
				restoredFromPersist: false,
			};
			this.lanes.set(providerId, lane);
		}
		return lane;
	}

	resolveWebviewView(
		webviewView: vscode.WebviewView,
		_context: vscode.WebviewViewResolveContext,
		_token: vscode.CancellationToken,
	): void {
		this.view = webviewView;
		webviewView.webview.options = {
			enableScripts: true,
			localResourceRoots: [
				vscode.Uri.joinPath(this.extensionUri, 'media'),
				vscode.Uri.joinPath(this.extensionUri, 'dist'),
			],
		};
		webviewView.webview.html = this.getHtml(webviewView.webview);

		webviewView.webview.onDidReceiveMessage((raw: WebviewToHostMessage) => {
			void this.onMessage(raw);
		});

		webviewView.onDidDispose(() => {
			if (this.persistTimer) {
				clearTimeout(this.persistTimer);
				this.persistTimer = undefined;
			}
			this.persistAll({ prune: true });
			this.view = undefined;
			void this.sessions.cancel(this.selectedProviderId);
		});

		void this.cleanupLegacyShadowsOnce();
	}

	async reveal(): Promise<void> {
		await vscode.commands.executeCommand(`${VIEW_TYPE}.focus`);
	}

	/** Main workspace path (never mutated by the agent until Accept). */
	private mainCwd(): string | undefined {
		return getWorkspaceContext().linuxCwd;
	}

	/** @deprecated alias — prefer mainCwd / shadowCwd explicitly */
	private workspaceCwd(): string | undefined {
		return this.mainCwd();
	}

	private toChangeCards(changes: ProposedChange[]): ProposedChangeCard[] {
		return changes.map((c) => ({
			id: c.id,
			path: c.path,
			kind: c.kind,
			additions: c.additions,
			deletions: c.deletions,
			state: c.state,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
			revisions: c.revisions.map((r) => ({
				id: r.id,
				turnId: r.turnId,
				agentMsgId: r.agentMsgId,
				at: r.at,
				additions: r.additions,
				deletions: r.deletions,
			})),
		}));
	}

	private async ensureShadowCwd(sessionId: string): Promise<string | undefined> {
		const main = this.mainCwd();
		if (!main) {
			return undefined;
		}
		const shadow = await this.shadows.ensureShadow(main, sessionId);
		return shadow.shadowCwd;
	}

	private activityShadowCwd(sessionId: string): string | undefined {
		const main = this.mainCwd();
		if (!main) {
			return undefined;
		}
		return this.shadows.get(sessionId)?.shadowCwd ?? shadowSessionDir(main, sessionId);
	}

	private normalizeActivity(item: ActivityItem, sessionId: string): ActivityItem {
		return normalizeActivityForDisplay(item, this.activityShadowCwd(sessionId));
	}

	private async refreshChanges(
		lane: ProviderUiLane,
		ctx?: { turnId?: string; agentMsgId?: string },
	): Promise<void> {
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		let shadow = this.shadows.get(lane.sessionId);
		if (!shadow) {
			try {
				await this.ensureShadowCwd(lane.sessionId);
				shadow = this.shadows.get(lane.sessionId);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				this.post({ type: 'toast', message: `Shadow workspace failed: ${message}` });
				return;
			}
		}
		if (!shadow) {
			this.post({
				type: 'toast',
				message: 'Shadow workspace unavailable — cannot detect file changes.',
			});
			return;
		}
		try {
			const turnId = ctx?.turnId ?? lane.activeTurnId;
			const detected = await detectProposedChanges(shadow, {
				previous: lane.changes,
				turnId,
			});
			lane.changes = await enrichChangesWithRevisions(shadow, lane.changes, detected, {
				turnId,
				agentMsgId: ctx?.agentMsgId,
				mainCwd: main,
				sessionId: lane.sessionId,
			});
			this.stampChangeStatsOnActivities(lane);
			this.persistLaneDeck(lane);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'toast', message: `Change detect failed: ${message}` });
		}
	}

	private stampChangeStatsOnActivities(lane: ProviderUiLane): void {
		if (lane.changes.length === 0) {
			return;
		}
		const stamp = (items: ActivityItem[]) => {
			for (const item of items) {
				if (!isFileMutatingActivity(item)) {
					continue;
				}
				const hint = activityPathHint(item);
				if (!hint) {
					continue;
				}
				const norm = hint.replace(/\\/g, '/');
				const base = norm.split('/').pop() ?? norm;
				const change = lane.changes.find(
					(c) =>
						c.path === norm ||
						c.path.endsWith(`/${norm}`) ||
						c.path === base ||
						c.path.endsWith(`/${base}`),
				);
				if (change) {
					item.changeAdditions = change.additions;
					item.changeDeletions = change.deletions;
				}
			}
		};
		stamp(lane.activities);
		for (const msg of lane.messages) {
			if (msg.activities) {
				stamp(msg.activities);
			}
		}
	}

	/** Write change cards + pending permission under `<main>/.WSLDeck/sessions/<id>/ui.json`. */
	private persistLaneDeck(lane: ProviderUiLane): void {
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		try {
			writeSessionDeck(main, lane.sessionId, {
				changes: lane.changes,
				pendingPermission: lane.pendingPermission,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.post({ type: 'toast', message: `WSLDeck save failed: ${message}` });
		}
	}

	/** Restore change/permission cards from `.WSLDeck`; reattach shadow only if it already exists. */
	private async restoreLaneDeck(lane: ProviderUiLane): Promise<void> {
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		const disk = readSessionDeck(main, lane.sessionId);
		if (!disk) {
			return;
		}
		const existingShadow = shadowSessionDir(main, lane.sessionId);
		const legacyShadow = path.join(main, '.WSLDeck', 'shadows', lane.sessionId);
		const shadowOnDisk =
			fs.existsSync(existingShadow) || fs.existsSync(legacyShadow);
		if (shadowOnDisk) {
			try {
				await this.ensureShadowCwd(lane.sessionId);
			} catch {
				// Still show persisted cards with best-effort paths.
			}
		}
		const shadow = this.shadows.get(lane.sessionId);
		const shadowCwd = shadow?.shadowCwd ?? path.join(main, '.WSLDeck', '.shadow-pending');
		lane.changes = materializeChanges(disk.changes, main, shadowCwd, disk.updatedAt);
		lane.pendingPermission = disk.pendingPermission ?? undefined;
		if (shadow) {
			try {
				const detected = await detectProposedChanges(shadow, {
					previous: lane.changes,
				});
				const merged = await enrichChangesWithRevisions(shadow, lane.changes, detected, {
					mainCwd: main,
					sessionId: lane.sessionId,
				});
				if (lane.changes.length > 20 && merged.length < lane.changes.length / 4) {
					lane.changes = merged;
					this.persistLaneDeck(lane);
				} else {
					lane.changes = merged.length > 0 ? merged : lane.changes;
				}
			} catch {
				// keep disk snapshot
			}
		} else if (lane.changes.length > 0) {
			const hasHistory = lane.changes.some((c) => c.revisions.length > 0);
			if (!hasHistory) {
				lane.changes = [];
				this.persistLaneDeck(lane);
			}
		}
	}

	private async hydrateAllDecks(): Promise<void> {
		for (const lane of this.lanes.values()) {
			await this.restoreLaneDeck(lane);
		}
	}

	private modelsFor(providerId: string): ModelOption[] {
		return this.ensureLane(providerId).models;
	}

	private async refreshModels(providerId: string, opts?: { force?: boolean }): Promise<ModelOption[]> {
		const lane = this.ensureLane(providerId);
		if (!opts?.force && lane.models.length > 0 && !lane.modelsLoading) {
			return lane.models;
		}
		const provider = this.sessions.getProvider(providerId);
		if (!provider) {
			return lane.models;
		}
		lane.modelsLoading = true;
		lane.modelsError = undefined;
		if (providerId === this.selectedProviderId) {
			this.statusDetail = 'Fetching models…';
			this.pushState();
		}
		try {
			const listed = await provider.listModels({
				linuxCwd: this.workspaceCwd(),
				workspaceFolder: this.workspaceCwd(),
				modelId: lane.modelId,
			});
			lane.models = listed.map((m) => ({ id: m.id, label: m.label || m.id }));
			if (lane.models.length === 0) {
				lane.modelsError =
					providerId === 'cursor'
						? 'No models — set wsldeck.cursor.apiKey or CURSOR_API_KEY, or check agent CLI'
						: 'No models — check codex CLI or wsldeck.codex.models fallback';
			}
			lane.modelId = pickModelId(lane.models, lane.modelId);
			const session = this.sessions.getSession(providerId);
			if (session) {
				session.modelId = lane.modelId;
			}
			return lane.models;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (providerId === this.selectedProviderId) {
				this.flashStatus(`Model list failed: ${message}`);
			}
			return lane.models;
		} finally {
			lane.modelsLoading = false;
			if (providerId === this.selectedProviderId && this.statusDetail === 'Fetching models…') {
				this.statusDetail = undefined;
			}
		}
	}

	private cursorUsesSdkCatalog(): boolean {
		const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
		return !!provider?.usesSdkModelCatalog?.();
	}

	private async ensureProviderSession(providerId: string, lane: ProviderUiLane) {
		const main = this.mainCwd();
		const shadowCwd = await this.ensureShadowCwd(lane.sessionId);
		const session = await this.sessions.ensureSession(providerId, {
			sessionId: lane.sessionId,
			modelId: lane.modelId,
			workspaceCwd: shadowCwd ?? main,
			acpSpawnCwd: main,
			resumeProviderSessionId: lane.providerSessionId,
		});
		if (providerId === 'cursor' && !this.cursorUsesSdkCatalog()) {
			const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
			if (provider && typeof provider.warmSessionCatalog === 'function') {
				try {
					await provider.warmSessionCatalog(session.id);
				} catch {
					// catalog stays at CLI / fallback
				}
			}
		}
		this.mergeCursorCatalogIntoLane(providerId, lane, session.id);
		return session;
	}

	/** Pull ACP models/reasoning into the lane after Cursor session/new|load. */
	private mergeCursorCatalogIntoLane(
		providerId: string,
		lane: ProviderUiLane,
		sessionId: string,
	): void {
		if (providerId !== 'cursor') {
			return;
		}
		const provider = this.sessions.getProvider(providerId) as CursorProvider | undefined;
		if (
			provider &&
			typeof provider.usesSdkModelCatalog === 'function' &&
			provider.usesSdkModelCatalog()
		) {
			this.refreshReasoningCatalog(lane);
			this.refreshFastCatalog(lane);
			return;
		}
		if (!provider || typeof provider.getSessionConfigCatalog !== 'function') {
			return;
		}
		const catalog = provider.getSessionConfigCatalog(sessionId);
		if (catalog.models.length > 0) {
			const byId = new Map(lane.models.map((m) => [m.id, m]));
			for (const m of catalog.models) {
				if (!byId.has(m.id)) {
					byId.set(m.id, { id: m.id, label: m.label || m.id });
				}
			}
			lane.models = [...byId.values()];
			lane.modelId = pickModelId(lane.models, lane.modelId);
		}
		this.refreshReasoningCatalog(lane);
		this.refreshFastCatalog(lane);
	}

	private async applyFastSelection(fastId: string): Promise<void> {
		const lane = this.lane();
		this.refreshFastCatalog(lane);
		const match = lane.fasts.find((f) => f.id === fastId || f.label === fastId);
		if (!match) {
			this.post({
				type: 'toast',
				message: `Unknown speed tier "${fastId}".`,
			});
			this.pushState();
			return;
		}
		lane.fastId = match.id;
		if (this.selectedProviderId === 'cursor') {
			const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
			const session = this.sessions.getSession('cursor');
			if (provider && session && typeof provider.resolveModelWithFast === 'function') {
				const resolved = provider.resolveModelWithFast(lane.modelId, match.id);
				if (resolved) {
					lane.modelId = resolved;
					session.modelId = resolved;
					if (!this.cursorUsesSdkCatalog()) {
						try {
							await provider.applyModelSelection(session.id, resolved);
						} catch {
							// keep prior ACP model
						}
					}
				}
			}
		}
		this.writeResumeIndexForLane(this.selectedProviderId, lane);
		this.flashStatus(`Speed · ${match.label}`);
	}

	private getState(): AgentViewState {
		const lane = this.lane();
		const workspaceCtx = getWorkspaceContext();
		this.refreshReasoningCatalog(lane);
		this.refreshFastCatalog(lane);
		return {
			providers: this.sessions.listProviders().map((p) => ({
				id: p.id,
				displayName: p.displayName,
			})),
			selectedProviderId: this.selectedProviderId,
			models: this.modelsFor(this.selectedProviderId),
			modelsLoading: lane.modelsLoading,
			modelsError: lane.modelsError,
			selectedModelId: lane.modelId,
			modes: ACP_MODES.map((m) => ({ id: m.id, label: m.label })),
			selectedModeId: lane.modeId,
			reasonings: lane.reasonings,
			selectedReasoningId: lane.reasoningId,
			fasts: lane.fasts,
			selectedFastId: lane.fastId,
			resumes: this.resumeOptions(this.selectedProviderId),
			status: lane.status,
			statusDetail: this.statusDetail,
			messages: lane.messages.map((m) => ({
				...m,
				activities: m.activities?.map((a) => this.normalizeActivity(a, lane.sessionId)),
			})),
			activities: lane.activities.map((a) => this.normalizeActivity(a, lane.sessionId)),
			pendingPermission: lane.pendingPermission
				? {
						...lane.pendingPermission,
						title: rewriteShadowPathsInText(
							lane.pendingPermission.title,
							this.activityShadowCwd(lane.sessionId) ?? '',
						),
						detail: lane.pendingPermission.detail
							? rewriteShadowPathsInText(
									lane.pendingPermission.detail,
									this.activityShadowCwd(lane.sessionId) ?? '',
								)
							: lane.pendingPermission.detail,
					}
				: undefined,
			changes: this.toChangeCards(lane.changes),
			workspaceHint: workspaceCtx.linuxCwd ? undefined : (workspaceCtx.error ?? NO_WORKSPACE_FOLDER_HINT),
			slashCommands: DEFAULT_SLASH_COMMANDS,
			sessionId: lane.sessionId,
			restoredFromPersist: lane.restoredFromPersist,
			error: lane.error,
		};
	}

	private refreshReasoningCatalog(lane: ProviderUiLane): void {
		const providerId = this.selectedProviderId;
		if (providerId === 'cursor') {
			if (lane.modelId === 'auto' || lane.modelId === 'auto-smart') {
				lane.reasonings = [];
			} else {
				const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
				const sdkLevels =
					provider && typeof provider.getReasoningLevelsForModel === 'function'
						? provider.getReasoningLevelsForModel(lane.modelId)
						: [];
				if (sdkLevels.length > 0) {
					lane.reasonings = sdkLevels;
				} else {
					const session = this.sessions.getSession('cursor');
					const catalog =
						provider &&
						session &&
						typeof provider.getSessionConfigCatalog === 'function'
							? provider.getSessionConfigCatalog(session.id)
							: {
									modes: ['agent', 'plan'] as string[],
									reasonings: [] as ReasoningOption[],
									models: [] as Array<{ id: string; label: string }>,
								};
					const rawReasonings: ReasoningOption[] =
						catalog.reasonings.length > 0
							? catalog.reasonings
							: CURSOR_REASONING_FALLBACK;
					lane.reasonings = rawReasonings.map(reasoningToModelOption);
				}
			}
		} else if (providerId === 'codex') {
			const provider = this.sessions.getProvider('codex') as CodexProvider | undefined;
			lane.reasonings =
				provider && typeof provider.getReasoningLevelsForModel === 'function'
					? provider.getReasoningLevelsForModel(lane.modelId)
					: [];
		} else {
			lane.reasonings = [];
		}
		if (lane.reasonings.length > 0 && !lane.reasonings.some((r) => r.id === lane.reasoningId)) {
			lane.reasoningId = lane.reasonings[0]?.id ?? lane.reasoningId;
		}
	}

	private refreshFastCatalog(lane: ProviderUiLane): void {
		const providerId = this.selectedProviderId;
		if (providerId === 'cursor') {
			if (lane.modelId === 'auto' || lane.modelId === 'auto-smart') {
				lane.fasts = [];
			} else {
				const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
				lane.fasts =
					provider && typeof provider.getFastOptionsForModel === 'function'
						? provider.getFastOptionsForModel(lane.modelId)
						: [];
			}
		} else {
			lane.fasts = [];
		}
		if (lane.fasts.length > 0 && !lane.fasts.some((f) => f.id === lane.fastId)) {
			lane.fastId = lane.fasts[0]?.id ?? lane.fastId;
		}
	}

	private resumeOptions(providerId: string): ResumeOption[] {
		const lane = this.ensureLane(providerId);
		const main = this.mainCwd();
		const fromDisk = main ? readResumeIndex(main).byProvider[providerId]?.sessions ?? [] : [];
		const byId = new Map(lane.resumes.map((s) => [s.sessionId, s]));
		const options: ResumeOption[] = fromDisk
			.slice()
			.sort((a, b) => b.updatedAt - a.updatedAt)
			.map((e) => {
				const local = byId.get(e.sessionId);
				return {
					sessionId: e.sessionId,
					title:
						e.title ||
						sessionTitleFromMessages(local?.messages ?? [], e.providerSessionId),
					providerSessionId: e.providerSessionId ?? local?.providerSessionId,
					updatedAt: e.updatedAt,
				};
			});
		if (!options.some((r) => r.sessionId === lane.sessionId)) {
			options.unshift({
				sessionId: lane.sessionId,
				title: sessionTitleFromMessages(lane.messages, lane.providerSessionId),
				providerSessionId: lane.providerSessionId,
				updatedAt: Date.now(),
			});
			options.sort((a, b) => b.updatedAt - a.updatedAt);
		}
		return options;
	}

	private writeResumeIndexForLane(providerId: string, lane: ProviderUiLane): void {
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		const snap = this.snapshotLaneSession(providerId, lane);
		if (!isNoteworthySession(snap) && !lane.providerSessionId) {
			return;
		}
		upsertResumeEntry(main, providerId, {
			sessionId: lane.sessionId,
			providerSessionId: lane.providerSessionId,
			providerId,
			modelId: lane.modelId,
			title: snap.title || 'New session',
			updatedAt: Date.now(),
			modeId: lane.modeId,
			reasoningId: lane.reasoningId,
		});
	}

	private snapshotLaneSession(providerId: string, lane: ProviderUiLane): PersistedAgentSession {
		return {
			version: 1,
			sessionId: lane.sessionId,
			providerSessionId: lane.providerSessionId,
			providerId,
			modelId: lane.modelId,
			messages: sanitizeMessagesForPersist(lane.messages),
			updatedAt: Date.now(),
			title: sessionTitleFromMessages(lane.messages, lane.providerSessionId),
		};
	}

	/** Sync active lane into resume history when it is worth keeping. */
	private archiveActiveIfNeeded(providerId: string): void {
		const lane = this.ensureLane(providerId);
		const snap = this.snapshotLaneSession(providerId, lane);
		if (!isNoteworthySession(snap)) {
			return;
		}
		const wrapped = upsertProviderSession(
			{ activeSessionId: lane.sessionId, sessions: lane.resumes },
			snap,
		);
		lane.resumes = wrapped.sessions;
		this.writeResumeIndexForLane(providerId, lane);
	}

	private post(message: HostToWebviewMessage): void {
		void this.view?.webview.postMessage(message);
	}

	private pushState(): void {
		this.post({ type: 'state', state: this.getState() });
		this.schedulePersist({ prune: false });
	}

	/** Debounce disk/workspaceState writes; prune only when explicitly requested. */
	private schedulePersist(opts?: { prune?: boolean }): void {
		if (opts?.prune) {
			this.persistWantsPrune = true;
		}
		if (this.persistTimer) {
			clearTimeout(this.persistTimer);
		}
		this.persistTimer = setTimeout(() => {
			this.persistTimer = undefined;
			const prune = this.persistWantsPrune;
			this.persistWantsPrune = false;
			this.persistAll({ prune });
		}, 500);
	}

	private flashStatus(message: string, ms = 1000): void {
		const token = ++this.statusFlashToken;
		this.statusDetail = message;
		this.pushState();
		setTimeout(() => {
			if (this.statusFlashToken !== token) {
				return;
			}
			if (this.statusDetail === message) {
				this.statusDetail = undefined;
				this.pushState();
			}
		}, ms);
	}

	private restoreAll(): void {
		const v2raw = this.context.workspaceState.get(SESSION_STATE_KEY);
		const v1raw = this.context.workspaceState.get(SESSION_STATE_KEY_V1);
		const store = migrateToWorkspaceSessions(v2raw ?? v1raw, this.selectedProviderId);
		const main = this.mainCwd();
		const resumeIndex = main ? readResumeIndex(main) : undefined;

		if (!store && !resumeIndex) {
			return;
		}

		if (store) {
			this.selectedProviderId = store.selectedProviderId;
		}

		const providerIds = new Set<string>([
			...Object.keys(store?.byProvider ?? {}),
			...Object.keys(resumeIndex?.byProvider ?? {}),
		]);

		for (const providerId of providerIds) {
			const providerLane = store?.byProvider[providerId];
			const diskLane = resumeIndex?.byProvider[providerId];
			const msgById = new Map(
				(providerLane?.sessions ?? []).map((s) => [s.sessionId, s] as const),
			);

			const indexSessions = diskLane?.sessions ?? [];
			const resumes: PersistedAgentSession[] = (
				indexSessions.length > 0
					? indexSessions
					: (providerLane?.sessions ?? []).map((s) => ({
							sessionId: s.sessionId,
							providerSessionId: s.providerSessionId,
							providerId,
							modelId: s.modelId,
							title: s.title ?? 'New session',
							updatedAt: s.updatedAt,
						}))
			)
				.slice()
				.sort((a, b) => b.updatedAt - a.updatedAt)
				.map((e) => {
					const local = msgById.get(e.sessionId);
					return {
						version: 1 as const,
						sessionId: e.sessionId,
						providerSessionId: e.providerSessionId ?? local?.providerSessionId,
						providerId,
						modelId: e.modelId || local?.modelId || 'default',
						messages: sanitizeMessagesForPersist(local?.messages ?? []),
						updatedAt: e.updatedAt,
						title: e.title || local?.title,
					};
				});

			const activeId =
				diskLane?.activeSessionId ??
				providerLane?.activeSessionId ??
				resumes[0]?.sessionId;
			const active = resumes.find((s) => s.sessionId === activeId) ?? resumes[0];
			if (!active) {
				continue;
			}

			const diskEntry = indexSessions.find((s) => s.sessionId === active.sessionId);
			const lane: ProviderUiLane = {
				sessionId: active.sessionId,
				providerSessionId: active.providerSessionId,
				modelId: active.modelId || 'default',
				modeId: diskEntry?.modeId === 'plan' ? 'plan' : 'agent',
				reasoningId: diskEntry?.reasoningId || 'medium',
				fastId: 'false',
				models: [],
				reasonings: [],
				fasts: [],
				resumes,
				messages: sanitizeMessagesForPersist(active.messages),
				activities: [],
				changes: [],
				status: 'idle',
				restoredFromPersist: active.messages.length > 0,
				error: undefined,
			};
			this.lanes.set(providerId, lane);
			this.sessions.bindRestoredSession(
				providerId,
				createAgentSession({
					id: lane.sessionId,
					providerId,
					providerSessionId: lane.providerSessionId,
					modelId: lane.modelId,
					workspaceCwd: this.mainCwd(),
				}),
			);
		}

		this.sessions.focus(this.selectedProviderId);
		const focused = this.lane();
		if (focused.restoredFromPersist) {
			this.statusDetail = `Restored · ${this.selectedProviderId} · ${focused.modelId}`;
		}
		void this.hydrateAllDecks();
	}

	private persistAll(opts?: { prune?: boolean }): void {
		const focused = this.sessions.getSession(this.selectedProviderId);
		if (focused) {
			const lane = this.lane();
			lane.sessionId = focused.id;
			lane.providerSessionId = focused.providerSessionId;
			if (focused.modelId) {
				lane.modelId = focused.modelId;
			}
		}

		const byProvider: Record<string, PersistedProviderLane> = {};
		for (const [providerId, lane] of this.lanes) {
			const snap = this.snapshotLaneSession(providerId, lane);
			const retained = lane.resumes.filter(
				(s) => s.sessionId === lane.sessionId || isNoteworthySession(s),
			);
			const wrapped = upsertProviderSession(
				{ activeSessionId: lane.sessionId, sessions: retained },
				snap,
			);
			wrapped.sessions = wrapped.sessions.filter(
				(s) => s.sessionId === lane.sessionId || isNoteworthySession(s),
			);
			lane.resumes = wrapped.sessions;
			byProvider[providerId] = {
				activeSessionId: lane.sessionId,
				sessions: wrapped.sessions,
			};
			this.writeResumeIndexForLane(providerId, lane);
		}

		const payload: PersistedWorkspaceSessions = {
			version: 3,
			selectedProviderId: this.selectedProviderId,
			byProvider,
			updatedAt: Date.now(),
		};
		void this.context.workspaceState.update(SESSION_STATE_KEY, payload);
		void this.context.workspaceState.update(SESSION_STATE_KEY_V1, undefined);
		if (opts?.prune) {
			void this.pruneOrphanSessionArtifacts();
		}
	}

	/** Drop shadow + .WSLDeck session UI for resumes that fell out of the retention window. */
	private async pruneOrphanSessionArtifacts(): Promise<void> {
		const main = this.mainCwd();
		if (!main) {
			return;
		}
		const keep = new Set<string>();
		for (const lane of this.lanes.values()) {
			keep.add(lane.sessionId);
			for (const s of lane.resumes) {
				keep.add(s.sessionId);
			}
		}
		await this.shadows.disposeExcept(keep);
		const onDisk = new Set([...listSessionDeckIds(main), ...listShadowSessionIds(main)]);
		for (const id of onDisk) {
			if (!keep.has(id)) {
				deleteSessionDeck(main, id);
				await this.shadows.disposeSession(main, id);
			}
		}
	}

	private async switchProvider(providerId: string): Promise<void> {
		if (providerId === this.selectedProviderId) {
			return;
		}
		// Fast path: do not create shadows / ACP sessions on agent switch.
		this.schedulePersist({ prune: false });
		this.selectedProviderId = providerId;
		const lane = this.ensureLane(providerId);
		this.sessions.focus(providerId);
		await this.restoreLaneDeck(lane);
		const label = this.sessions.getProvider(providerId)?.displayName ?? providerId;
		void this.refreshModels(providerId).then(() => {
			if (this.selectedProviderId === providerId) {
				this.refreshReasoningCatalog(lane);
				this.pushState();
			}
		});
		this.flashStatus(`Agent · ${label}`);
	}

	private async startNewSession(note?: string): Promise<void> {
		const providerId = this.selectedProviderId;
		const lane = this.lane(providerId);
		if (lane.status === 'running') {
			this.post({ type: 'toast', message: 'Stop the agent before starting a new session.' });
			return;
		}
		this.archiveActiveIfNeeded(providerId);
		lane.providerSessionId = undefined;
		lane.changes = [];
		const newSessionId = newId('session');
		lane.sessionId = newSessionId;
		const session = await this.sessions.startNewSession(providerId, {
			sessionId: newSessionId,
			modelId: lane.modelId,
			workspaceCwd: this.mainCwd(),
		});
		lane.providerSessionId = session.providerSessionId;
		const shadowCwd = await this.ensureShadowCwd(lane.sessionId);
		session.workspaceCwd = shadowCwd ?? this.mainCwd();
		lane.messages = [];
		lane.activities = [];
		lane.pendingPermission = undefined;
		lane.error = undefined;
		lane.status = 'idle';
		lane.restoredFromPersist = false;
		this.persistLaneDeck(lane);
		this.flashStatus(note ?? 'New session');
	}

	private async switchResume(sessionId: string): Promise<void> {
		const providerId = this.selectedProviderId;
		const lane = this.lane(providerId);
		if (lane.status === 'running') {
			this.post({ type: 'toast', message: 'Stop the agent before switching resume.' });
			return;
		}
		if (sessionId === lane.sessionId) {
			this.flashStatus('Already on this resume');
			return;
		}
		const target = lane.resumes.find((s) => s.sessionId === sessionId);
		if (!target) {
			this.post({ type: 'toast', message: `Unknown resume "${sessionId}".` });
			return;
		}

		this.archiveActiveIfNeeded(providerId);

		this.persistLaneDeck(lane);
		// Keep previous session shadow — Resume must remain Keep-capable.

		lane.sessionId = target.sessionId;
		lane.providerSessionId = target.providerSessionId;
		lane.modelId = target.modelId || lane.modelId;
		lane.messages = sanitizeMessagesForPersist(target.messages);
		lane.activities = [];
		lane.changes = [];
		lane.pendingPermission = undefined;
		lane.error = undefined;
		lane.status = 'idle';
		lane.restoredFromPersist = lane.messages.length > 0;

		const shadowCwd = await this.ensureShadowCwd(lane.sessionId);
		await this.sessions.replaceSession(
			providerId,
			createAgentSession({
				id: lane.sessionId,
				providerId,
				providerSessionId: lane.providerSessionId,
				modelId: lane.modelId,
				workspaceCwd: shadowCwd ?? this.mainCwd(),
			}),
		);
		await this.restoreLaneDeck(lane);

		const main = this.mainCwd();
		if (main) {
			setResumeIndexActive(main, providerId, lane.sessionId);
			const entry = readResumeIndex(main).byProvider[providerId]?.sessions.find(
				(s) => s.sessionId === lane.sessionId,
			);
			if (entry?.modeId === 'plan' || entry?.modeId === 'agent') {
				lane.modeId = entry.modeId;
			}
			if (entry?.reasoningId) {
				lane.reasoningId = entry.reasoningId;
			}
		}

		const title = target.title || sessionTitleFromMessages(target.messages, target.providerSessionId);
		this.flashStatus(`Resume · ${title}`);
		this.pushState();
	}

	private async onMessage(message: WebviewToHostMessage): Promise<void> {
		switch (message.type) {
			case 'ready':
				await this.hydrateAllDecks();
				this.pushState();
				await this.refreshModels(this.selectedProviderId, {
					force: this.lane().models.length === 0,
				});
				this.pushState();
				return;
			case 'selectProvider':
				await this.switchProvider(message.providerId);
				return;
			case 'selectModel':
				await this.applyModelSelection(message.modelId);
				return;
			case 'selectMode':
				await this.applyModeSelection(message.modeId);
				return;
			case 'selectReasoning':
				await this.applyReasoningSelection(message.reasoningId);
				return;
			case 'selectFast':
				await this.applyFastSelection(message.fastId);
				return;
			case 'requestModels':
				await this.refreshModels(this.selectedProviderId);
				this.pushState();
				return;
			case 'newSession':
				await this.startNewSession();
				return;
			case 'selectResume':
				await this.switchResume(message.sessionId);
				return;
			case 'openWorkspaceFolder':
				await vscode.commands.executeCommand('workbench.action.files.openFolder');
				return;
			case 'sendPrompt':
				await this.handlePrompt(message.text);
				return;
			case 'cancel':
				await this.cancelActiveTurn();
				return;
			case 'resolvePermission':
				await this.resolvePermission(message.requestId, message.optionId);
				return;
			case 'runInTerminal':
				await runInWslTerminal(message.command);
				return;
			case 'acceptChange':
				await this.handleAcceptChange(message.changeId);
				return;
			case 'rejectChange':
				await this.handleRejectChange(message.changeId);
				return;
			case 'acceptAllChanges':
				await this.handleAcceptAll();
				return;
			case 'rejectAllChanges':
				await this.handleRejectAll();
				return;
			case 'viewDiff':
				await this.handleViewDiff(message.changeId);
				return;
			case 'viewRevisionDiff':
				await this.handleViewRevisionDiff(message.changeId, message.revisionId);
				return;
			case 'compareMain':
				await this.handleCompareMain(message.changeId);
				return;
		}
	}

	private async handleAcceptChange(changeId: string): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		const change = lane.changes.find((c) => c.id === changeId);
		if (!shadow || !change) {
			this.post({ type: 'toast', message: 'Change not found.' });
			return;
		}
		if (change.state !== 'pending' && change.state !== 'conflicted') {
			return;
		}
		const updated = await acceptChange(shadow, change);
		lane.changes = lane.changes.map((c) => (c.id === changeId ? updated : c));
		if (updated.state === 'conflicted') {
			this.post({
				type: 'toast',
				message: `Conflict: ${updated.path} changed in Main since baseline.`,
			});
		}
		this.persistLaneDeck(lane);
		this.pushState();
	}

	private async handleRejectChange(changeId: string): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		const change = lane.changes.find((c) => c.id === changeId);
		if (!shadow || !change) {
			this.post({ type: 'toast', message: 'Change not found.' });
			return;
		}
		await cancelChange(shadow, change);
		await this.refreshChanges(lane);
		this.pushState();
	}

	private async handleAcceptAll(): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		if (!shadow) {
			return;
		}
		lane.changes = await acceptAll(shadow, lane.changes);
		const conflicts = lane.changes.filter((c) => c.state === 'conflicted').length;
		if (conflicts > 0) {
			this.post({ type: 'toast', message: `${conflicts} file(s) conflicted in Main.` });
		}
		this.persistLaneDeck(lane);
		this.pushState();
	}

	private async handleRejectAll(): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		if (!shadow) {
			return;
		}
		await cancelAll(shadow, lane.changes);
		await this.refreshChanges(lane);
		this.pushState();
	}

	private async handleViewDiff(changeId: string): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		const change = lane.changes.find((c) => c.id === changeId);
		if (!shadow || !change) {
			this.post({ type: 'toast', message: 'Change not found.' });
			return;
		}
		await viewDiff(shadow, change);
	}

	private async handleViewRevisionDiff(changeId: string, revisionId: string): Promise<void> {
		const lane = this.lane();
		const main = this.mainCwd();
		const shadow = this.shadows.get(lane.sessionId);
		const change = lane.changes.find((c) => c.id === changeId);
		const revision = change?.revisions.find((r) => r.id === revisionId);
		if (!main || !shadow || !change || !revision) {
			this.post({ type: 'toast', message: 'Revision not found.' });
			return;
		}
		await viewRevisionDiff(shadow, change, revision, main, lane.sessionId);
	}

	private async handleCompareMain(changeId: string): Promise<void> {
		const lane = this.lane();
		const shadow = this.shadows.get(lane.sessionId);
		const change = lane.changes.find((c) => c.id === changeId);
		if (!shadow || !change) {
			this.post({ type: 'toast', message: 'Change not found.' });
			return;
		}
		await compareMain(shadow, change);
	}

	private async applyModelSelection(modelId: string): Promise<void> {
		const lane = this.lane();
		let models = this.modelsFor(this.selectedProviderId);
		if (models.length === 0) {
			models = await this.refreshModels(this.selectedProviderId, { force: true });
		}
		const match = models.find((m) => m.id === modelId || m.label === modelId);
		if (!match) {
			this.post({
				type: 'toast',
				message: `Unknown model "${modelId}". Try /model to list options.`,
			});
			this.pushState();
			return;
		}
		lane.modelId = match.id;
		const session = this.sessions.getSession(this.selectedProviderId);
		if (session) {
			session.modelId = match.id;
		}
		if (
			this.selectedProviderId === 'cursor' &&
			!this.cursorUsesSdkCatalog() &&
			match.id !== 'auto' &&
			match.id !== 'auto-smart'
		) {
			try {
				await this.ensureProviderSession('cursor', lane);
				const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
				if (provider && session && typeof provider.applyModelSelection === 'function') {
					await provider.applyModelSelection(session.id, match.id);
				}
			} catch {
				// keep CLI / fallback catalogs
			}
		}
		if (this.selectedProviderId === 'codex' && lane.models.length === 0) {
			await this.refreshModels('codex', { force: true });
		}
		this.refreshReasoningCatalog(lane);
		this.refreshFastCatalog(lane);
		this.flashStatus(`Model · ${match.label}`);
	}

	private async applyModeSelection(modeId: string): Promise<void> {
		const lane = this.lane();
		if (modeId !== 'agent' && modeId !== 'plan') {
			this.post({ type: 'toast', message: `Unknown mode "${modeId}". Use /mode agent|plan.` });
			return;
		}
		lane.modeId = modeId;
		this.writeResumeIndexForLane(this.selectedProviderId, lane);
		this.flashStatus(`Mode · ${modeId}`);
	}

	private async applyReasoningSelection(reasoningId: string): Promise<void> {
		const lane = this.lane();
		this.refreshReasoningCatalog(lane);
		const match = lane.reasonings.find((r) => r.id === reasoningId || r.label === reasoningId);
		if (!match) {
			this.post({
				type: 'toast',
				message: `Unknown reasoning "${reasoningId}".`,
			});
			this.pushState();
			return;
		}
		lane.reasoningId = match.id;
		if (this.selectedProviderId === 'cursor') {
			const provider = this.sessions.getProvider('cursor') as CursorProvider | undefined;
			const session = this.sessions.getSession('cursor');
			if (
				provider &&
				session &&
				typeof provider.resolveModelWithReasoning === 'function'
			) {
				const resolved = provider.resolveModelWithReasoning(lane.modelId, match.id);
				if (resolved) {
					lane.modelId = resolved;
					session.modelId = resolved;
					if (!this.cursorUsesSdkCatalog()) {
						try {
							await provider.applyModelSelection(session.id, resolved);
						} catch {
							// keep prior ACP model
						}
					}
				}
			}
		}
		this.refreshFastCatalog(lane);
		this.writeResumeIndexForLane(this.selectedProviderId, lane);
		this.flashStatus(`Reasoning · ${match.label}`);
	}

	private bumpRunToken(providerId: string): number {
		const next = (this.runTokens.get(providerId) ?? 0) + 1;
		this.runTokens.set(providerId, next);
		return next;
	}

	private async cancelActiveTurn(): Promise<void> {
		const providerId = this.selectedProviderId;
		this.bumpRunToken(providerId);
		const lane = this.lane(providerId);
		lane.pendingPermission = undefined;
		lane.status = 'idle';
		lane.activities = lane.activities.map((a) =>
			a.status === 'running' ? { ...a, status: 'completed', outcome: 'cancelled' } : a,
		);
		const streaming = [...lane.messages].reverse().find((m) => m.role === 'agent' && m.streaming);
		if (streaming) {
			streaming.streaming = false;
			streaming.thoughtStreaming = false;
			if (!streaming.text.trim()) {
				streaming.text = '（已取消）';
			}
		}
		try {
			await this.sessions.cancel(providerId);
		} catch {
			// still flip UI to idle
		}
		await this.refreshChanges(lane);
		this.persistLaneDeck(lane);
		this.flashStatus('Cancelled');
	}

	private async resolvePermission(requestId: string, optionId: string): Promise<void> {
		const lane = this.lane();
		if (lane.pendingPermission?.requestId !== requestId) {
			this.post({ type: 'toast', message: 'Permission request is no longer active.' });
			return;
		}
		try {
			await this.sessions.resolvePermission(this.selectedProviderId, requestId, optionId);
			lane.pendingPermission = undefined;
			lane.status = 'running';
			this.statusDetail = `Permission · ${optionId}`;
			this.persistLaneDeck(lane);
			this.pushState();
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			lane.pendingPermission = undefined;
			lane.error = message;
			this.persistLaneDeck(lane);
			this.post({
				type: 'toast',
				message: `${message} (permission card cleared — ask the agent again if needed)`,
			});
			this.pushState();
		}
	}

	private async handlePrompt(text: string): Promise<void> {
		const prompt = text.trim();
		if (!prompt) {
			return;
		}
		if (!getWorkspaceContext().linuxCwd) {
			this.post({ type: 'toast', message: NO_WORKSPACE_FOLDER_HINT });
			return;
		}
		const providerId = this.selectedProviderId;
		const lane = this.lane(providerId);
		if (lane.status === 'running' || lane.status === 'waiting') {
			this.post({ type: 'toast', message: 'Agent is already running.' });
			return;
		}

		const modelSlash = parseModelSlash(prompt);
		if (modelSlash) {
			if (modelSlash.kind === 'list') {
				const models = await this.refreshModels(providerId, { force: true });
				this.post({
					type: 'toast',
					message:
						models.length > 0
							? `Models for ${providerId}: ${models.map((m) => m.label).join(', ')}`
							: `No models discovered for ${providerId}. Check CLI / settings fallback.`,
				});
				this.flashStatus(`/model · ${models.length} options`);
				this.pushState();
				return;
			}
			await this.applyModelSelection(modelSlash.modelId);
			return;
		}

		const modeSlash = parseModeSlash(prompt);
		if (modeSlash) {
			if (modeSlash.kind === 'list') {
				this.post({
					type: 'toast',
					message: 'Modes: agent, plan',
				});
				this.flashStatus('/mode · agent | plan');
				return;
			}
			await this.applyModeSelection(modeSlash.value);
			return;
		}

		const runToken = this.bumpRunToken(providerId);
		const stillThisRun = () => this.runTokens.get(providerId) === runToken;

		const userMsgId = newId('user');
		lane.messages.push({
			id: userMsgId,
			role: 'user',
			text: prompt,
		});
		lane.activities = [];
		lane.pendingPermission = undefined;
		lane.error = undefined;
		lane.status = 'running';
		this.statusDetail = `${providerId} · ${lane.modelId} · ${lane.modeId}${
			lane.reasoningId ? ` · ${lane.reasoningId}` : ''
		}`;
		this.pushState();

		const agentMsgId = newId('agent');
		const agentLabel =
			this.sessions.getProvider(providerId)?.displayName ?? providerId;
		lane.messages.push({
			id: agentMsgId,
			role: 'agent',
			text: '',
			streaming: true,
			agentLabel,
		});
		this.pushState();

		const freezeTurnActivities = () => {
			if (!stillThisRun()) {
				return;
			}
			const agentMsg = lane.messages.find((m) => m.id === agentMsgId);
			if (agentMsg) {
				agentMsg.activities = lane.activities.map((a) => ({
					...a,
					status: a.status === 'running' ? 'completed' : a.status,
				}));
				agentMsg.thoughtStreaming = false;
				if (lane.activeTurnId) {
					agentMsg.turnId = lane.activeTurnId;
				}
			}
			lane.activities = [];
			lane.pendingPermission = undefined;
			this.persistLaneDeck(lane);
		};

		try {
			const session = await this.ensureProviderSession(providerId, lane);
			if (!stillThisRun()) {
				return;
			}
			lane.sessionId = session.id;
			lane.providerSessionId = session.providerSessionId;

			let promptFailed = false;
			for await (const event of this.sessions.sendPrompt(prompt, {
				providerId,
				modelId: lane.modelId,
				modeId: lane.modeId,
				reasoningId: lane.reasoningId || undefined,
			})) {
				if (!stillThisRun()) {
					break;
				}
				if (this.selectedProviderId !== providerId) {
					continue;
				}
				this.applyEvent(lane, event, agentMsgId);
				if (event.type === 'tool.completed' && shouldRefreshChangesForTool(event.tool)) {
					void this.refreshChanges(lane, {
						turnId: event.turnId,
						agentMsgId,
					}).then(() => {
						if (stillThisRun()) {
							this.pushState();
						}
					});
				}
				this.post({ type: 'agentEvent', event });
				this.pushState();
				if (event.type === 'session.failed') {
					promptFailed = true;
					break;
				}
			}
			if (!stillThisRun()) {
				return;
			}
			lane.providerSessionId = session.providerSessionId;
			freezeTurnActivities();
			const finishedMsg = lane.messages.find((m) => m.id === agentMsgId);
			if (finishedMsg) {
				finishedMsg.streaming = false;
				finishedMsg.thoughtStreaming = false;
			}
			await this.refreshChanges(lane, { agentMsgId, turnId: lane.activeTurnId });
			if (promptFailed) {
				lane.status = 'error';
				this.statusDetail = lane.error;
				this.pushState();
				this.persistLaneDeck(lane);
				return;
			}
			if (this.selectedProviderId === providerId) {
				lane.status = 'idle';
				this.statusDetail = undefined;
				this.pushState();
			} else {
				lane.status = 'idle';
				this.schedulePersist({ prune: false });
			}
		} catch (err) {
			if (!stillThisRun()) {
				return;
			}
			const aborted = err instanceof Error && err.name === 'AbortError';
			const msg = lane.messages.find((m) => m.id === agentMsgId);
			if (msg) {
				msg.streaming = false;
				if (aborted && !msg.text.trim()) {
					msg.text = '（已取消）';
				}
			}
			freezeTurnActivities();
			const failedMsg = lane.messages.find((m) => m.id === agentMsgId);
			if (failedMsg) {
				failedMsg.streaming = false;
				failedMsg.thoughtStreaming = false;
			}
			await this.refreshChanges(lane, { agentMsgId, turnId: lane.activeTurnId });
			lane.status = aborted ? 'idle' : 'error';
			if (!aborted) {
				lane.error = err instanceof Error ? err.message : String(err);
			}
			if (this.selectedProviderId === providerId) {
				this.statusDetail = aborted ? undefined : lane.error;
				this.pushState();
			} else {
				this.schedulePersist({ prune: false });
			}
		}
	}

	private applyEvent(lane: ProviderUiLane, event: AgentEvent, agentMsgId: string): void {
		if ('turnId' in event && event.turnId) {
			lane.activeTurnId = event.turnId;
			const msg = lane.messages.find((m) => m.id === agentMsgId);
			if (msg) {
				msg.turnId = event.turnId;
			}
		}
		switch (event.type) {
			case 'tool.started': {
				const item = this.mergeActivity(
					lane.activities.find((a) => a.id === event.tool.toolCallId),
					activityFromTool(event.tool, 'running'),
				);
				const idx = lane.activities.findIndex((a) => a.id === item.id);
				if (idx >= 0) {
					lane.activities[idx] = item;
				} else {
					lane.activities.push(item);
				}
				return;
			}
			case 'tool.completed': {
				const item = this.mergeActivity(
					lane.activities.find((a) => a.id === event.tool.toolCallId),
					activityFromTool(
						event.tool,
						event.ok === false ? 'failed' : 'completed',
						event.outcome,
					),
				);
				const idx = lane.activities.findIndex((a) => a.id === item.id);
				if (idx >= 0) {
					lane.activities[idx] = item;
				} else {
					lane.activities.push(item);
				}
				return;
			}
			case 'agent.message.delta': {
				const msg = lane.messages.find((m) => m.id === agentMsgId);
				if (msg) {
					msg.text += event.text;
					msg.streaming = true;
					if (msg.thoughtStreaming) {
						msg.thoughtStreaming = false;
					}
				}
				return;
			}
			case 'agent.message.completed': {
				const msg = lane.messages.find((m) => m.id === agentMsgId);
				if (msg) {
					msg.text = event.text;
					msg.streaming = lane.status === 'running' || lane.status === 'waiting';
					msg.thoughtStreaming = false;
				}
				return;
			}
			case 'agent.thought.delta': {
				const msg = lane.messages.find((m) => m.id === agentMsgId);
				if (msg) {
					msg.thought = (msg.thought ?? '') + event.text;
					msg.thoughtStreaming = true;
				}
				return;
			}
			case 'session.failed': {
				lane.error = event.message;
				lane.status = 'error';
				lane.pendingPermission = undefined;
				const msg = lane.messages.find((m) => m.id === agentMsgId);
				if (msg) {
					msg.streaming = false;
					msg.thoughtStreaming = false;
				}
				lane.activities = lane.activities.map((a) =>
					a.status === 'running'
						? { ...a, status: 'failed', outcome: event.message }
						: a,
				);
				const session = this.sessions.getSession(this.selectedProviderId);
				if (session && !session.providerSessionId) {
					lane.providerSessionId = undefined;
				} else if (
					session?.providerSessionId &&
					/thread-store conflict|already has an active writer/i.test(event.message)
				) {
					session.providerSessionId = undefined;
					lane.providerSessionId = undefined;
				}
				return;
			}
			case 'permission.requested': {
				lane.pendingPermission = {
					requestId: event.requestId,
					title: event.tool?.title || event.message,
					detail: event.tool?.detail,
					options: event.options.map((o) => ({
						optionId: o.optionId,
						label: o.name,
						kind: o.kind,
					})),
				};
				lane.status = 'waiting';
				this.statusDetail = event.message;
				this.persistLaneDeck(lane);
				return;
			}
			default:
				return;
		}
	}

	/** Prefer a concrete ACP title over later generic "tool" / kind-only updates. */
	private mergeActivity(prev: ActivityItem | undefined, next: ActivityItem): ActivityItem {
		if (!prev) {
			return next;
		}
		const nextGeneric =
			!next.label ||
			next.label === 'tool' ||
			(next.kind !== undefined && next.label === next.kind);
		const prevConcrete = Boolean(prev.label && prev.label !== 'tool');
		return {
			...next,
			label: nextGeneric && prevConcrete ? prev.label : next.label,
			name: nextGeneric && prevConcrete ? prev.name : next.name,
			kind: next.kind ?? prev.kind,
			detail: next.detail ?? prev.detail,
			activityGroup: next.activityGroup ?? prev.activityGroup,
			mutatesWorkspace: next.mutatesWorkspace ?? prev.mutatesWorkspace,
			changeAdditions: next.changeAdditions ?? prev.changeAdditions,
			changeDeletions: next.changeDeletions ?? prev.changeDeletions,
		};
	}

	private getHtml(webview: vscode.Webview): string {
		const scriptUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js'),
		);
		const styleUri = webview.asWebviewUri(
			vscode.Uri.joinPath(this.extensionUri, 'media', 'agent-view.css'),
		);
		const nonce = getNonce();
		const csp = [
			`default-src 'none'`,
			`style-src ${webview.cspSource}`,
			`script-src 'nonce-${nonce}'`,
		].join('; ');

		return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>WSLDeck</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
	}
}

function getNonce(): string {
	const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
	let value = '';
	for (let i = 0; i < 32; i++) {
		value += chars.charAt(Math.floor(Math.random() * chars.length));
	}
	return value;
}
