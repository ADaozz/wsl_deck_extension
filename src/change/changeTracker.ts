import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionBaseline } from '../session/sessionBaseline';
import {
	type ChangeKind,
	type ProposedChange,
	changeIdForPath,
} from './proposedChange';
import { filterTrackedChanges, isIgnoredChangePath } from './changePathFilter';
import { isBinaryFile } from './changeFileStats';
import {
	baselineOverlayPath,
	isBaselineOverlayDeleted,
	readBaselineOverlay,
} from './baselineOverlay';

function stateFromPrevious(
	prev: ProposedChange | undefined,
	baseline: SessionBaseline,
	rel: string,
	mainPath: string,
): ProposedChange['state'] {
	if (prev?.state === 'conflicted') {
		return 'conflicted';
	}
	if (prev?.state === 'accepted') {
		const overlayPath = baselineOverlayPath(baseline, rel);
		const hasOverlay =
			fs.existsSync(overlayPath) || isBaselineOverlayDeleted(baseline, rel);
		if (!hasOverlay) {
			return 'accepted';
		}
		if (isBaselineOverlayDeleted(baseline, rel)) {
			return fs.existsSync(mainPath) ? 'pending' : 'accepted';
		}
		if (!fs.existsSync(mainPath)) {
			return 'pending';
		}
		const mainBytes = fs.readFileSync(mainPath);
		const overlayBytes = fs.readFileSync(overlayPath);
		return mainBytes.equals(overlayBytes) ? 'accepted' : 'pending';
	}
	return 'pending';
}

/**
 * Detect proposed changes by comparing main workspace to session-start snapshot.
 * Independent of git status — only files that differ from session baseline surface as cards.
 */
export async function detectProposedChanges(
	baseline: SessionBaseline,
	options?: { previous?: ProposedChange[]; turnId?: string },
): Promise<ProposedChange[]> {
	const previousByPath = new Map(
		(options?.previous ?? []).map((c) => [c.path, c] as const),
	);
	if (!baseline.baselineDir || !fs.existsSync(baseline.baselineDir)) {
		return filterTrackedChanges([...previousByPath.values()]);
	}
	return detectSnapshotChanges(baseline, previousByPath, options?.turnId);
}

async function detectSnapshotChanges(
	baseline: SessionBaseline,
	previousByPath: Map<string, ProposedChange>,
	turnId?: string,
): Promise<ProposedChange[]> {
	const compareRoot = baseline.baselineDir;
	if (!compareRoot || !fs.existsSync(compareRoot)) {
		return filterTrackedChanges([...previousByPath.values()]);
	}

	const mainFiles = listFilesRecursive(baseline.mainCwd);
	const baselineFiles = listFilesRecursive(compareRoot);
	const all = new Set([...mainFiles, ...baselineFiles]);
	const changes: ProposedChange[] = [];

	for (const rel of all) {
		if (isIgnoredChangePath(rel)) {
			continue;
		}
		const mainPath = path.join(baseline.mainCwd, rel);
		const baselinePath = path.join(compareRoot, rel);
		const inMain = fs.existsSync(mainPath) && fs.statSync(mainPath).isFile();
		const overlayDeleted = isBaselineOverlayDeleted(baseline, rel);
		const overlayText = readBaselineOverlay(baseline, rel);
		const inBaseline =
			!overlayDeleted &&
			(overlayText !== undefined ||
				(fs.existsSync(baselinePath) && fs.statSync(baselinePath).isFile()));

		if (!inMain && !inBaseline) {
			continue;
		}
		if (inMain && inBaseline) {
			if (isBinaryFile(mainPath)) {
				continue;
			}
			const a = fs.readFileSync(mainPath);
			const b =
				overlayText !== undefined
					? Buffer.from(overlayText, 'utf8')
					: fs.readFileSync(baselinePath);
			if (a.equals(b)) {
				continue;
			}
		}

		let kind: ChangeKind = 'modified';
		if (inMain && !inBaseline) {
			kind = 'added';
		} else if (!inMain && inBaseline) {
			kind = 'deleted';
		}

		const { additions, deletions } = inMain && isBinaryFile(mainPath)
			? { additions: 0, deletions: 0 }
			: roughLineDiff(
					inBaseline
						? overlayText !== undefined
							? overlayText
							: fs.readFileSync(baselinePath, 'utf8')
						: '',
					inMain ? fs.readFileSync(mainPath, 'utf8') : '',
				);

		const prev = previousByPath.get(rel);
		const ts = Date.now();
		changes.push({
			id: changeIdForPath(rel),
			turnId: turnId ?? prev?.turnId,
			path: rel,
			kind,
			additions,
			deletions,
			state: stateFromPrevious(prev, baseline, rel, mainPath),
			mainPath,
			createdAt: prev?.createdAt ?? ts,
			updatedAt: ts,
			revisions: prev?.revisions ?? [],
		});
	}

	return filterTrackedChanges(changes.sort((a, b) => a.path.localeCompare(b.path)));
}

function listFilesRecursive(root: string): string[] {
	if (!fs.existsSync(root)) {
		return [];
	}
	const out: string[] = [];
	const walk = (dir: string) => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.WSLDeck') {
				continue;
			}
			const abs = path.join(dir, entry.name);
			const rel = path.relative(root, abs).replace(/\\/g, '/');
			if (isIgnoredChangePath(rel)) {
				continue;
			}
			if (entry.isDirectory()) {
				walk(abs);
			} else if (entry.isFile()) {
				out.push(rel);
			}
		}
	};
	walk(root);
	return out;
}

export function roughLineDiff(before: string, after: string): { additions: number; deletions: number } {
	const b = before === '' ? [] : before.split(/\r?\n/);
	const a = after === '' ? [] : after.split(/\r?\n/);
	const deletions = Math.max(0, b.length - a.length);
	const additions = Math.max(0, a.length - b.length);
	const changed = Math.min(b.length, a.length);
	let mismatches = 0;
	for (let i = 0; i < changed; i++) {
		if (b[i] !== a[i]) {
			mismatches++;
		}
	}
	return { additions: additions + mismatches, deletions: deletions + mismatches };
}
