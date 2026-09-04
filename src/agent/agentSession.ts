export type AgentSessionStatus =
	| 'CREATING'
	| 'READY'
	| 'RUNNING'
	| 'WAITING'
	| 'STOPPED'
	| 'FAILED'
	| 'CLOSED';

export interface AgentSession {
	readonly id: string;
	readonly providerId: string;
	/** Native id for CLI resume / ACP session/load when available */
	providerSessionId?: string;
	modelId?: string;
	/** Linux / local cwd for the agent process */
	workspaceCwd?: string;
	/** Cwd for spawning CLI/ACP child processes (workspace root). */
	acpSpawnCwd?: string;
	status: AgentSessionStatus;
	createdAt: number;
}

export function createAgentSession(params: {
	id: string;
	providerId: string;
	providerSessionId?: string;
	modelId?: string;
	workspaceCwd?: string;
	acpSpawnCwd?: string;
}): AgentSession {
	return {
		id: params.id,
		providerId: params.providerId,
		providerSessionId: params.providerSessionId,
		modelId: params.modelId,
		workspaceCwd: params.workspaceCwd,
		acpSpawnCwd: params.acpSpawnCwd,
		status: 'READY',
		createdAt: Date.now(),
	};
}
