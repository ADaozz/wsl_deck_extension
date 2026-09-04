import type { ConversationMessage, ProviderId } from '../ui/messageProtocol';

/** Legacy single-session key (migrated into v2/v3). */
export const SESSION_STATE_KEY_V1 = 'wsldeck.activeSession.v1';

/** Workspace session store (v2 single-per-provider → migrated to v3 multi-resume). */
export const SESSION_STATE_KEY = 'wsldeck.providerSessions.v2';

export const MAX_RESUMES_PER_PROVIDER = 30;

export interface PersistedAgentSession {
	version: 1;
	sessionId: string;
	/** Provider-native id for CLI `--resume` / ACP session/load */
	providerSessionId?: string;
	providerId: ProviderId;
	modelId: string;
	messages: ConversationMessage[];
	updatedAt: number;
	/** Short label for /resume picker */
	title?: string;
}

/** Per-provider multi-resume lane inside one workspace. */
export interface PersistedProviderLane {
	activeSessionId: string;
	sessions: PersistedAgentSession[];
}

export interface PersistedWorkspaceSessions {
	version: 3;
	selectedProviderId: ProviderId;
	byProvider: Record<string, PersistedProviderLane>;
	updatedAt: number;
}

/** @deprecated v2 shape — one active session per provider */
interface PersistedWorkspaceSessionsV2 {
	version: 2;
	selectedProviderId: ProviderId;
	byProvider: Record<string, PersistedAgentSession>;
	updatedAt: number;
}

export function sanitizeMessagesForPersist(messages: ConversationMessage[]): ConversationMessage[] {
	return messages
		.filter((m) => m.role !== 'system' || m.text.trim().length > 0)
		.map((m) => {
			const thought = m.thought?.trim();
			return {
				id: m.id,
				role: m.role,
				text: m.text,
				agentLabel: m.agentLabel,
				...(m.turnId ? { turnId: m.turnId } : {}),
				...(thought ? { thought } : {}),
				activities: m.activities?.map((a) => ({
					id: a.id,
					name: a.name,
					label: a.label,
					kind: a.kind,
					detail: a.detail,
					status: a.status === 'running' ? ('completed' as const) : a.status,
					outcome: a.outcome,
					activityGroup: a.activityGroup,
					mutatesWorkspace: a.mutatesWorkspace,
					changeAdditions: a.changeAdditions,
					changeDeletions: a.changeDeletions,
				})),
			};
		});
}

export function sessionTitleFromMessages(
	messages: ConversationMessage[],
	fallback?: string,
): string {
	const firstUser = messages.find((m) => m.role === 'user' && m.text.trim());
	if (firstUser) {
		const oneLine = firstUser.text.replace(/\s+/g, ' ').trim();
		return oneLine.length > 48 ? `${oneLine.slice(0, 45)}…` : oneLine;
	}
	if (fallback?.trim()) {
		const id = fallback.trim();
		return id.length > 20 ? `Resume ${id.slice(0, 8)}…` : `Resume ${id}`;
	}
	return 'New session';
}

export function isPersistedAgentSession(value: unknown): value is PersistedAgentSession {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as PersistedAgentSession;
	return (
		v.version === 1 &&
		typeof v.sessionId === 'string' &&
		typeof v.providerId === 'string' &&
		typeof v.modelId === 'string' &&
		Array.isArray(v.messages) &&
		typeof v.updatedAt === 'number'
	);
}

export function isPersistedProviderLane(value: unknown): value is PersistedProviderLane {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as PersistedProviderLane;
	return (
		typeof v.activeSessionId === 'string' &&
		Array.isArray(v.sessions) &&
		v.sessions.every((s) => isPersistedAgentSession(s))
	);
}

export function isPersistedWorkspaceSessions(value: unknown): value is PersistedWorkspaceSessions {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as PersistedWorkspaceSessions;
	return (
		v.version === 3 &&
		typeof v.selectedProviderId === 'string' &&
		typeof v.byProvider === 'object' &&
		v.byProvider !== null &&
		typeof v.updatedAt === 'number'
	);
}

function isPersistedWorkspaceSessionsV2(value: unknown): value is PersistedWorkspaceSessionsV2 {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const v = value as PersistedWorkspaceSessionsV2;
	return (
		v.version === 2 &&
		typeof v.selectedProviderId === 'string' &&
		typeof v.byProvider === 'object' &&
		v.byProvider !== null &&
		typeof v.updatedAt === 'number'
	);
}

function wrapSessionAsLane(session: PersistedAgentSession): PersistedProviderLane {
	return {
		activeSessionId: session.sessionId,
		sessions: [session],
	};
}

/** Migrate v1/v2 blobs → v3 multi-resume per provider. */
export function migrateToWorkspaceSessions(
	raw: unknown,
	fallbackProviderId: string,
): PersistedWorkspaceSessions | undefined {
	if (isPersistedWorkspaceSessions(raw)) {
		return raw;
	}
	if (isPersistedWorkspaceSessionsV2(raw)) {
		const byProvider: Record<string, PersistedProviderLane> = {};
		for (const [providerId, session] of Object.entries(raw.byProvider)) {
			if (isPersistedAgentSession(session)) {
				byProvider[providerId] = wrapSessionAsLane(session);
			}
		}
		return {
			version: 3,
			selectedProviderId: raw.selectedProviderId || fallbackProviderId,
			byProvider,
			updatedAt: raw.updatedAt,
		};
	}
	if (isPersistedAgentSession(raw)) {
		return {
			version: 3,
			selectedProviderId: raw.providerId || fallbackProviderId,
			byProvider: { [raw.providerId]: wrapSessionAsLane(raw) },
			updatedAt: raw.updatedAt,
		};
	}
	return undefined;
}

/** Whether a session is worth keeping in the resume list. */
export function isNoteworthySession(session: {
	messages: ConversationMessage[];
	providerSessionId?: string;
}): boolean {
	return Boolean(session.providerSessionId) || session.messages.some((m) => m.text.trim());
}

/** Upsert session into lane history; set as active; trim to max. */
export function upsertProviderSession(
	lane: PersistedProviderLane,
	session: PersistedAgentSession,
	max = MAX_RESUMES_PER_PROVIDER,
): PersistedProviderLane {
	const sessions = [...lane.sessions];
	const idx = sessions.findIndex((s) => s.sessionId === session.sessionId);
	const next = {
		...session,
		title: session.title || sessionTitleFromMessages(session.messages, session.providerSessionId),
	};
	if (idx >= 0) {
		sessions[idx] = next;
	} else {
		sessions.unshift(next);
	}
	sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	return {
		activeSessionId: session.sessionId,
		sessions: sessions.slice(0, max),
	};
}

/** Parse `/resume` or `/resume <id|index|title>`. */
export function parseResumeSlash(
	text: string,
): { kind: 'list' } | { kind: 'set'; query: string } | undefined {
	const trimmed = text.trim();
	const match = /^\/resume(?:\s+(.+))?$/i.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const rest = match[1]?.trim();
	if (!rest) {
		return { kind: 'list' };
	}
	return { kind: 'set', query: rest };
}

/** Resolve a resume query against known sessions (id, provider id, 1-based index, title). */
export function findResumeSession(
	sessions: PersistedAgentSession[],
	query: string,
): PersistedAgentSession | undefined {
	const q = query.trim();
	if (!q) {
		return undefined;
	}
	const bySessionId = sessions.find((s) => s.sessionId === q);
	if (bySessionId) {
		return bySessionId;
	}
	const byProviderId = sessions.find((s) => s.providerSessionId === q);
	if (byProviderId) {
		return byProviderId;
	}
	const asIndex = Number(q);
	if (Number.isInteger(asIndex) && asIndex >= 1 && asIndex <= sessions.length) {
		// List is newest-first; index 1 = most recent
		return sessions[asIndex - 1];
	}
	const lower = q.toLowerCase();
	return sessions.find(
		(s) =>
			(s.title && s.title.toLowerCase().includes(lower)) ||
			s.sessionId.toLowerCase().includes(lower) ||
			(s.providerSessionId && s.providerSessionId.toLowerCase().includes(lower)),
	);
}
