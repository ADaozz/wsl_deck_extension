import type { AgentEvent } from './agentEvents';
import type { AgentSession } from './agentSession';

export interface AgentAvailability {
	available: boolean;
	/** Executable path or short reason */
	detail: string;
	/** When false, provider may still run a local bridge (e.g. demo) */
	cliPresent?: boolean;
}

export interface AgentModelInfo {
	/** Free-form model id from provider / settings — not a TS enum */
	id: string;
	label: string;
}

export interface AgentSessionContext {
	workspaceFolder?: string;
	linuxCwd?: string;
	/** Cwd for spawning long-lived CLI/ACP processes (usually workspace root). */
	acpSpawnCwd?: string;
	modelId?: string;
	/** Stable WSLDeck resume / shadow id (must match UI lane.sessionId). */
	sessionId?: string;
	/** Opaque resume id from a previous provider session */
	resumeProviderSessionId?: string;
}

export interface SendPromptOptions {
	modelId?: string;
	/** ACP session mode: agent | plan */
	modeId?: string;
	/** ACP reasoning / effort level id */
	reasoningId?: string;
	signal?: AbortSignal;
}

/**
 * Replaceable agent backend. UI and session manager depend only on this surface.
 * Codex / Cursor specifics stay inside their provider packages.
 */
export interface AgentProvider {
	readonly id: string;
	readonly displayName: string;

	detect(): Promise<AgentAvailability>;

	listModels(context: AgentSessionContext): Promise<AgentModelInfo[]>;

	createSession(context: AgentSessionContext): Promise<AgentSession>;

	sendPrompt(
		session: AgentSession,
		prompt: string,
		options?: SendPromptOptions,
	): AsyncIterable<AgentEvent>;

	cancel(session: AgentSession): Promise<void>;

	dispose(session: AgentSession): Promise<void>;

	/** Resolve a pending ACP / CLI permission card (optional). */
	resolvePermission?(
		session: AgentSession,
		requestId: string,
		optionId: string,
	): Promise<void>;
}
