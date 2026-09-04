import * as fs from 'node:fs';
import * as path from 'node:path';
import type { PendingPermissionCard } from '../ui/messageProtocol';
import {
	type ChangeKind,
	type ChangeState,
	type ProposedChange,
	changeIdForPath,
} from '../change/proposedChange';
import { filterTrackedChanges } from '../change/changePathFilter';
import { MAX_RESUMES_PER_PROVIDER } from './sessionStore';

export const WSLDECK_DIR_NAME = '.WSLDeck';

export type AgentModeId = 'agent' | 'plan';

export interface PersistedChangeRevision {
	id: string;
	turnId: string;
	agentMsgId?: string;
	at: number;
	additions: number;
	deletions: number;
	snapshotId?: string;
}

export interface PersistedChangeRecord {
	id: string;
	path: string;
	kind: ChangeKind;
	additions: number;
	deletions: number;
	state: ChangeState;
	turnId?: string;
	createdAt?: number;
	updatedAt?: number;
	revisions?: PersistedChangeRevision[];
}

export interface SessionDeckFile {
	version: 1 | 2;
	sessionId: string;
	updatedAt: number;
	changes: PersistedChangeRecord[];
	pendingPermission?: PendingPermissionCard | null;
}

/** WSLDeck-created resume index entry (no transcript body). */
export interface ResumeIndexEntry {
	sessionId: string;
	providerSessionId?: string;
	providerId: string;
	modelId: string;
	title: string;
	updatedAt: number;
	modeId?: AgentModeId;
	reasoningId?: string;
}

export interface ResumeIndexProviderLane {
	activeSessionId: string;
	sessions: ResumeIndexEntry[];
}

export interface ResumeIndexFile {
	version: 1;
	byProvider: Record<string, ResumeIndexProviderLane>;
	updatedAt: number;
}

function sanitizeSessionId(sessionId: string): string {
	return sessionId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 80);
}

export function deckRoot(mainCwd: string): string {
	return path.join(mainCwd, WSLDECK_DIR_NAME);
}

export function resumeIndexPath(mainCwd: string): string {
	return path.join(deckRoot(mainCwd), 'resumes.json');
}

export function sessionDeckDir(mainCwd: string, sessionId: string): string {
	return path.join(deckRoot(mainCwd), 'sessions', sanitizeSessionId(sessionId));
}

export function sessionDeckFilePath(mainCwd: string, sessionId: string): string {
	return path.join(sessionDeckDir(mainCwd, sessionId), 'ui.json');
}

/** Ensure `.WSLDeck` exists and ignores itself from the user's git. */
export function ensureDeckScaffold(mainCwd: string): void {
	const root = deckRoot(mainCwd);
	fs.mkdirSync(root, { recursive: true });
	const gi = path.join(root, '.gitignore');
	if (!fs.existsSync(gi)) {
		fs.writeFileSync(gi, '# WSLDeck local session UI — do not commit\n*\n!.gitignore\n', 'utf8');
	}
}

export function emptyResumeIndex(): ResumeIndexFile {
	return { version: 1, byProvider: {}, updatedAt: Date.now() };
}

export function readResumeIndex(mainCwd: string): ResumeIndexFile {
	const file = resumeIndexPath(mainCwd);
	if (!fs.existsSync(file)) {
		return emptyResumeIndex();
	}
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as ResumeIndexFile;
		if (!raw || raw.version !== 1 || typeof raw.byProvider !== 'object') {
			return emptyResumeIndex();
		}
		return raw;
	} catch {
		return emptyResumeIndex();
	}
}

export function writeResumeIndex(mainCwd: string, index: ResumeIndexFile): void {
	ensureDeckScaffold(mainCwd);
	const payload: ResumeIndexFile = {
		version: 1,
		byProvider: index.byProvider,
		updatedAt: Date.now(),
	};
	fs.writeFileSync(resumeIndexPath(mainCwd), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/** Insert/update one resume; sort by updatedAt desc; truncate. */
export function upsertResumeEntry(
	mainCwd: string,
	providerId: string,
	entry: ResumeIndexEntry,
	max = MAX_RESUMES_PER_PROVIDER,
): ResumeIndexFile {
	const index = readResumeIndex(mainCwd);
	const lane = index.byProvider[providerId] ?? {
		activeSessionId: entry.sessionId,
		sessions: [],
	};
	const sessions = [...lane.sessions];
	const idx = sessions.findIndex((s) => s.sessionId === entry.sessionId);
	const next: ResumeIndexEntry = {
		...entry,
		providerId,
		title: entry.title || 'New session',
	};
	if (idx >= 0) {
		sessions[idx] = { ...sessions[idx], ...next };
	} else {
		sessions.unshift(next);
	}
	sessions.sort((a, b) => b.updatedAt - a.updatedAt);
	index.byProvider[providerId] = {
		activeSessionId: entry.sessionId,
		sessions: sessions.slice(0, max),
	};
	writeResumeIndex(mainCwd, index);
	return index;
}

export function setResumeIndexActive(
	mainCwd: string,
	providerId: string,
	sessionId: string,
): void {
	const index = readResumeIndex(mainCwd);
	const lane = index.byProvider[providerId];
	if (!lane) {
		return;
	}
	lane.activeSessionId = sessionId;
	writeResumeIndex(mainCwd, index);
}

/** Drop resume entries not in keep set. */
export function pruneResumeIndex(
	mainCwd: string,
	providerId: string,
	keepSessionIds: Set<string>,
): void {
	const index = readResumeIndex(mainCwd);
	const lane = index.byProvider[providerId];
	if (!lane) {
		return;
	}
	lane.sessions = lane.sessions.filter((s) => keepSessionIds.has(s.sessionId));
	if (!keepSessionIds.has(lane.activeSessionId) && lane.sessions[0]) {
		lane.activeSessionId = lane.sessions[0].sessionId;
	}
	writeResumeIndex(mainCwd, index);
}

export function toPersistedChanges(changes: ProposedChange[]): PersistedChangeRecord[] {
	return filterTrackedChanges(
		changes.map((c) => ({
			id: c.id || changeIdForPath(c.path),
			path: c.path.replace(/\\/g, '/'),
			kind: c.kind,
			additions: c.additions,
			deletions: c.deletions,
			state: c.state,
			turnId: c.turnId,
			createdAt: c.createdAt,
			updatedAt: c.updatedAt,
			revisions: c.revisions.map((r) => ({
				id: r.id,
				turnId: r.turnId,
				agentMsgId: r.agentMsgId,
				at: r.at,
				additions: r.additions,
				deletions: r.deletions,
				snapshotId: r.snapshotId,
			})),
		})),
	);
}

export function materializeChanges(
	records: PersistedChangeRecord[],
	mainCwd: string,
	deckUpdatedAt?: number,
): ProposedChange[] {
	const fallbackTs = deckUpdatedAt ?? Date.now();
	return filterTrackedChanges(records).map((r) => {
		const rel = r.path.replace(/\\/g, '/');
		return {
			id: r.id || changeIdForPath(rel),
			path: rel,
			kind: r.kind,
			additions: r.additions,
			deletions: r.deletions,
			state: r.state,
			turnId: r.turnId,
			createdAt: r.createdAt ?? fallbackTs,
			updatedAt: r.updatedAt ?? r.createdAt ?? fallbackTs,
			revisions: (r.revisions ?? []).map((rev) => ({
				id: rev.id,
				turnId: rev.turnId,
				agentMsgId: rev.agentMsgId,
				at: rev.at,
				additions: rev.additions,
				deletions: rev.deletions,
				snapshotId: rev.snapshotId,
			})),
			mainPath: path.join(mainCwd, rel),
		};
	});
}

export function writeSessionDeck(
	mainCwd: string,
	sessionId: string,
	data: {
		changes: ProposedChange[];
		pendingPermission?: PendingPermissionCard;
	},
): void {
	ensureDeckScaffold(mainCwd);
	const dir = sessionDeckDir(mainCwd, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	const payload: SessionDeckFile = {
		version: 2,
		sessionId,
		updatedAt: Date.now(),
		changes: toPersistedChanges(data.changes),
		pendingPermission: data.pendingPermission ?? null,
	};
	fs.writeFileSync(sessionDeckFilePath(mainCwd, sessionId), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

export function readSessionDeck(mainCwd: string, sessionId: string): SessionDeckFile | undefined {
	const file = sessionDeckFilePath(mainCwd, sessionId);
	if (!fs.existsSync(file)) {
		return undefined;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as SessionDeckFile;
		if (!raw || (raw.version !== 1 && raw.version !== 2) || !Array.isArray(raw.changes)) {
			return undefined;
		}
		return raw;
	} catch {
		return undefined;
	}
}

export function deleteSessionDeck(mainCwd: string, sessionId: string): void {
	const dir = sessionDeckDir(mainCwd, sessionId);
	if (!fs.existsSync(dir)) {
		return;
	}
	fs.rmSync(dir, { recursive: true, force: true });
}

export function listSessionDeckIds(mainCwd: string): string[] {
	const dir = path.join(deckRoot(mainCwd), 'sessions');
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs
		.readdirSync(dir, { withFileTypes: true })
		.filter((e) => e.isDirectory())
		.map((e) => e.name);
}
/** Fixed ACP modes exposed in WSLDeck (intersection; no ask). */
export const ACP_MODES: Array<{ id: AgentModeId; label: string }> = [
	{ id: 'agent', label: 'Agent' },
	{ id: 'plan', label: 'Plan' },
];

export function filterAcpModeIds(ids: string[]): AgentModeId[] {
	const allowed = new Set<AgentModeId>(['agent', 'plan']);
	const out: AgentModeId[] = [];
	for (const id of ids) {
		if (allowed.has(id as AgentModeId) && !out.includes(id as AgentModeId)) {
			out.push(id as AgentModeId);
		}
	}
	return out.length > 0 ? out : ['agent', 'plan'];
}

export function formatResumeUpdatedAt(updatedAt: number, now = Date.now()): string {
	if (!updatedAt || Number.isNaN(updatedAt)) {
		return '';
	}
	const d = new Date(updatedAt);
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const delta = Math.max(0, now - updatedAt);
	const mins = Math.floor(delta / 60_000);
	if (mins < 1) {
		return `${stamp} · just now`;
	}
	if (mins < 60) {
		return `${stamp} · ${mins}m ago`;
	}
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		return `${stamp} · ${hours}h ago`;
	}
	return stamp;
}
