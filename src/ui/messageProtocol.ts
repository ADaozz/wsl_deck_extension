import type { AgentEvent, ToolMetadata } from '../agent/agentEvents';

/** Providers known to the UI selector (extensible later). */
export type ProviderId = string;

export interface ProviderOption {
	id: ProviderId;
	displayName: string;
}

/** Model ids are free-form strings from config / provider — not a TS enum. */
export interface ModelOption {
	id: string;
	label: string;
	/** Longer hint (reasoning menu: shown after the short id). */
	description?: string;
}

export interface ConversationMessage {
	id: string;
	role: 'user' | 'agent' | 'system';
	text: string;
	streaming?: boolean;
	/** Collapsible thinking stream (not mixed into `text`) */
	thought?: string;
	thoughtStreaming?: boolean;
	/** Provider display name stamped at turn start (Codex / Cursor) */
	agentLabel?: string;
	/** Tool rows frozen onto this turn's agent message when the turn ends */
	activities?: ActivityItem[];
	/** Provider turn id — binds diff cards and activity to this agent reply */
	turnId?: string;
}

export type ActivityStatus = 'running' | 'completed' | 'failed';

/**
 * In-flight / recent tool row. Labels come only from ToolMetadata strings.
 */
export interface ActivityItem {
	id: string;
	/** Raw name from agent metadata */
	name: string;
	/** Display category — prefer ACP `title` (e.g. "Read File") */
	label: string;
	/** Secondary kind from ACP when present (e.g. "read") */
	kind?: string;
	detail?: string;
	status: ActivityStatus;
	outcome?: string;
	/** Provider-assigned fold bucket. */
	activityGroup?: 'commands' | 'tools';
	/** Diff stats stamped after file-mutating tools (workspace-relative path in `detail`). */
	changeAdditions?: number;
	changeDeletions?: number;
	/** Provider signal that this row may have changed workspace files. */
	mutatesWorkspace?: boolean;
}

export interface ChangeRevisionCard {
	id: string;
	turnId: string;
	agentMsgId?: string;
	at: number;
	additions: number;
	deletions: number;
}

export interface ProposedChangeCard {
	id: string;
	path: string;
	kind: string;
	additions: number;
	deletions: number;
	state: 'pending' | 'accepted' | 'rejected' | 'conflicted';
	createdAt: number;
	updatedAt: number;
	revisions: ChangeRevisionCard[];
}

export interface SlashCommandInfo {
	id: string;
	/** e.g. /model */
	command: string;
	description: string;
}

export interface ResumeOption {
	sessionId: string;
	title: string;
	providerSessionId?: string;
	updatedAt: number;
}

export interface PermissionOptionView {
	optionId: string;
	label: string;
	kind?: string;
}

export interface PendingPermissionCard {
	requestId: string;
	title: string;
	detail?: string;
	options: PermissionOptionView[];
}

export interface AgentViewState {
	providers: ProviderOption[];
	selectedProviderId: ProviderId;
	models: ModelOption[];
	/** True while provider CLI model discovery is in flight. */
	modelsLoading?: boolean;
	/** Shown in model menu when discovery returns zero rows. */
	modelsError?: string;
	selectedModelId: string;
	/** agent | plan (slash /mode) */
	modes: ModelOption[];
	selectedModeId: string;
	/**
	 * Reasoning / effort levels for the current model.
	 * Picked right after /model (or model chip) — not a separate slash command.
	 */
	reasonings: ModelOption[];
	selectedReasoningId: string;
	/** Fast tier options (`fast` SDK param) after model / reasoning. */
	fasts: ModelOption[];
	selectedFastId: string;
	/** Resumes for the current agent in this workspace (newest first). */
	resumes: ResumeOption[];
	status: 'idle' | 'running' | 'waiting' | 'error';
	statusDetail?: string;
	messages: ConversationMessage[];
	/** Live tool activity from agent metadata (not a fixed catalog) */
	activities: ActivityItem[];
	/** In-flight permission request awaiting user choice */
	pendingPermission?: PendingPermissionCard;
	changes: ProposedChangeCard[];
	/** Set when no workspace folder is open — blocks Agent until resolved. */
	workspaceHint?: string;
	slashCommands: SlashCommandInfo[];
	sessionId: string;
	/** True when this view restored a persisted transcript */
	restoredFromPersist?: boolean;
	error?: string;
}

/** Webview → Extension */
export type WebviewToHostMessage =
	| { type: 'ready' }
	| { type: 'selectProvider'; providerId: ProviderId }
	| { type: 'selectModel'; modelId: string }
	| { type: 'selectMode'; modeId: string }
	| { type: 'selectReasoning'; reasoningId: string }
	| { type: 'selectFast'; fastId: string }
	| { type: 'requestModels' }
	| { type: 'newSession' }
	| { type: 'selectResume'; sessionId: string }
	| { type: 'sendPrompt'; text: string }
	| { type: 'cancel' }
	| { type: 'resolvePermission'; requestId: string; optionId: string }
	| { type: 'runInTerminal'; command: string }
	| { type: 'acceptChange'; changeId: string }
	| { type: 'rejectChange'; changeId: string }
	| { type: 'acceptAllChanges' }
	| { type: 'rejectAllChanges' }
	| { type: 'viewDiff'; changeId: string }
	| { type: 'viewRevisionDiff'; changeId: string; revisionId: string }
	| { type: 'compareMain'; changeId: string }
	| { type: 'openWorkspaceFolder' };

/** Extension → Webview */
export type HostToWebviewMessage =
	| { type: 'state'; state: AgentViewState }
	| { type: 'agentEvent'; event: AgentEvent }
	| { type: 'toast'; message: string }
	/** After model pick: open reasoning intensity menu (second Enter). */
	| { type: 'promptReasoning' };

export function activityFromTool(
	tool: ToolMetadata,
	status: ActivityStatus,
	outcome?: string,
): ActivityItem {
	const title = tool.title?.trim();
	const label = title && title.length > 0 ? title : tool.name;
	return {
		id: tool.toolCallId,
		name: tool.name,
		label,
		kind: tool.kind,
		detail: tool.detail,
		status,
		outcome,
		activityGroup: tool.activityGroup,
		mutatesWorkspace: tool.mutatesWorkspace,
	};
}

export const DEFAULT_SLASH_COMMANDS: SlashCommandInfo[] = [
	{ id: 'model', command: '/model', description: 'Switch model (Enter → reasoning when supported)' },
	{ id: 'mode', command: '/mode', description: 'Agent or Plan mode (ACP)' },
];
