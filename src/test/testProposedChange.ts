import { changeIdForPath, type ProposedChange } from '../change/proposedChange';

/** Minimal ProposedChange for tests — fills revision/timestamp defaults. */
export function testProposedChange(
	partial: Partial<ProposedChange> & Pick<ProposedChange, 'path' | 'shadowPath' | 'mainPath'>,
): ProposedChange {
	const now = Date.now();
	const path = partial.path;
	return {
		id: changeIdForPath(path),
		kind: 'modified',
		additions: 0,
		deletions: 0,
		state: 'pending',
		createdAt: now,
		updatedAt: now,
		revisions: [],
		...partial,
	};
}
