/**
 * Unified agent stream events.
 *
 * Tool / activity display MUST come from provider metadata strings
 * (name, title, detail). Do not introduce enums of known tools
 * (grep, web_search, …) — providers invent new tools over time.
 */

export type AgentEventType =
	| 'session.started'
	| 'agent.message.delta'
	| 'agent.message.completed'
	| 'agent.thought.delta'
	| 'tool.started'
	| 'tool.completed'
	| 'permission.requested'
	| 'turn.completed'
	| 'session.failed';

/** Free-form tool identity from the running agent — never an app-level enum. */
export interface ToolMetadata {
	/** Opaque id for correlating started/completed */
	toolCallId: string;
	/**
	 * Raw tool / function name from the agent (e.g. "grep", "WebSearch", "shell").
	 * Display this when no title is provided.
	 */
	name: string;
	/** Optional human label supplied by the provider (ACP `title`, e.g. "Read File") */
	title?: string;
	/** Optional secondary kind from provider (ACP `kind`, e.g. "read") */
	kind?: string;
	/** Optional one-line context: path, query, command snippet, etc. */
	detail?: string;
	/** When set, UI may fold related rows together (e.g. shell commands). */
	activityGroup?: 'commands' | 'tools';
	/** Provider signal: tool may have changed files on disk (ACP diff content, etc.). */
	mutatesWorkspace?: boolean;
	/** Pass-through bag for provider-specific fields (UI may ignore unknown keys) */
	extras?: Record<string, unknown>;
}

export interface AgentEventBase {
	type: AgentEventType;
	sessionId: string;
	turnId?: string;
	timestamp: number;
}

export interface SessionStartedEvent extends AgentEventBase {
	type: 'session.started';
	providerId: string;
}

export interface MessageDeltaEvent extends AgentEventBase {
	type: 'agent.message.delta';
	text: string;
}

export interface MessageCompletedEvent extends AgentEventBase {
	type: 'agent.message.completed';
	text: string;
}

export interface ThoughtDeltaEvent extends AgentEventBase {
	type: 'agent.thought.delta';
	text: string;
}

export interface ToolStartedEvent extends AgentEventBase {
	type: 'tool.started';
	tool: ToolMetadata;
}

export interface ToolCompletedEvent extends AgentEventBase {
	type: 'tool.completed';
	tool: ToolMetadata;
	/** Optional short result summary from metadata — not a typed enum */
	outcome?: string;
	ok?: boolean;
}

export interface PermissionOption {
	optionId: string;
	/** Button label from agent, e.g. "Allow once" */
	name: string;
	kind?: string;
}

export interface PermissionRequestedEvent extends AgentEventBase {
	type: 'permission.requested';
	requestId: string;
	/** Free-form description / tool title from the agent */
	message: string;
	tool?: ToolMetadata;
	options: PermissionOption[];
}

export interface TurnCompletedEvent extends AgentEventBase {
	type: 'turn.completed';
}

export interface SessionFailedEvent extends AgentEventBase {
	type: 'session.failed';
	message: string;
}

export type AgentEvent =
	| SessionStartedEvent
	| MessageDeltaEvent
	| MessageCompletedEvent
	| ThoughtDeltaEvent
	| ToolStartedEvent
	| ToolCompletedEvent
	| PermissionRequestedEvent
	| TurnCompletedEvent
	| SessionFailedEvent;

export function toolDisplayLabel(tool: ToolMetadata): string {
	const title = tool.title?.trim();
	if (title) {
		return title;
	}
	return tool.name;
}
