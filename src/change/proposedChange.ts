export type ChangeKind = 'added' | 'modified' | 'deleted' | 'renamed';

export type ChangeState = 'pending' | 'accepted' | 'rejected' | 'conflicted';

export interface ChangeRevision {
	id: string;
	turnId: string;
	agentMsgId?: string;
	/** Unix ms — last refresh for this turn revision */
	at: number;
	additions: number;
	deletions: number;
	/** Snapshot folder id under `.WSLDeck/sessions/<id>/snapshots/` */
	snapshotId?: string;
}

export interface ProposedChange {
	id: string;
	turnId?: string;
	/** Path relative to workspace root, posix-style */
	path: string;
	kind: ChangeKind;
	additions: number;
	deletions: number;
	state: ChangeState;
	/** Absolute path in main workspace */
	mainPath: string;
	/** First time this path appeared in the session deck */
	createdAt: number;
	/** Last detectProposedChanges refresh */
	updatedAt: number;
	revisions: ChangeRevision[];
}

export function changeIdForPath(relativePath: string): string {
	return `chg-${relativePath.replace(/[^\w.-]+/g, '_')}`;
}

export function revisionIdForTurn(turnId: string): string {
	const safe = turnId.replace(/[^a-zA-Z0-9._-]+/g, '_').slice(0, 64);
	return `rev-${safe}`;
}

export function emptyRevisions(): ChangeRevision[] {
	return [];
}
