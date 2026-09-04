import * as fs from 'node:fs';
import * as path from 'node:path';
import {
	type ShadowWorkspace,
	runGit,
	copyWorkspace,
} from '../shadow/shadowWorkspaceManager';
import {
	type ChangeKind,
	type ProposedChange,
	changeIdForPath,
} from './proposedChange';
import { filterTrackedChanges, isIgnoredChangePath } from './changePathFilter';
import {
	baselineOverlayPath,
	isBaselineOverlayDeleted,
	readBaselineOverlay,
} from './baselineOverlay';

/**
 * Parse `git diff --numstat` lines into path + line counts.
 * Binary files show `-` for both counts → treat as 0/0.
 */
export function parseNumstat(stdout: string): Array<{
	path: string;
	additions: number;
	deletions: number;
}> {
	const rows: Array<{ path: string; additions: number; deletions: number }> = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trimEnd();
		if (!trimmed) {
			continue;
		}
		const parts = trimmed.split('\t');
		if (parts.length < 3) {
			continue;
		}
		const [addRaw, delRaw, ...pathParts] = parts;
		const filePath = pathParts.join('\t').replace(/\\/g, '/');
		// Rename format: old => new
		const arrow = filePath.indexOf(' => ');
		const normalized =
			arrow >= 0 ? filePath.slice(arrow + 4).replace(/^{|}$/g, '').trim() : filePath;
		rows.push({
			path: normalized,
			additions: addRaw === '-' ? 0 : Number.parseInt(addRaw, 10) || 0,
			deletions: delRaw === '-' ? 0 : Number.parseInt(delRaw, 10) || 0,
		});
	}
	return rows;
}

/** Preserve terminal UI states; reopen accepted rows when shadow edits continue. */
function stateFromPrevious(
	prev: ProposedChange | undefined,
	shadow: ShadowWorkspace,
	rel: string,
	shadowPath: string,
): ProposedChange['state'] {
	if (prev?.state === 'conflicted') {
		return 'conflicted';
	}
	if (prev?.state === 'accepted') {
		const overlayPath = baselineOverlayPath(shadow, rel);
		const hasOverlay =
			fs.existsSync(overlayPath) || isBaselineOverlayDeleted(shadow, rel);
		if (!hasOverlay) {
			return 'accepted';
		}
		if (isBaselineOverlayDeleted(shadow, rel)) {
			return fs.existsSync(shadowPath) ? 'pending' : 'accepted';
		}
		if (!fs.existsSync(shadowPath)) {
			return 'pending';
		}
		const shadowBytes = fs.readFileSync(shadowPath);
		const overlayBytes = fs.readFileSync(overlayPath);
		return shadowBytes.equals(overlayBytes) ? 'accepted' : 'pending';
	}
	return 'pending';
}

function classifyKind(
	statusCode: string,
	existsInShadow: boolean,
	existedInBaseline: boolean,
): ChangeKind {
	const code = statusCode.trim()[0] ?? 'M';
	if (code === 'A' || code === '?' || (existsInShadow && !existedInBaseline)) {
		return 'added';
	}
	if (code === 'D' || (!existsInShadow && existedInBaseline)) {
		return 'deleted';
	}
	if (code === 'R') {
		return 'renamed';
	}
	return 'modified';
}

/**
 * Detect proposed changes by comparing shadow working tree to baseline.
 * Does not use provider fileChanged events.
 */
export async function detectProposedChanges(
	shadow: ShadowWorkspace,
	options?: { previous?: ProposedChange[]; turnId?: string },
): Promise<ProposedChange[]> {
	const previousByPath = new Map(
		(options?.previous ?? []).map((c) => [c.path, c] as const),
	);

	if (shadow.kind === 'git-worktree' && shadow.baselineRef) {
		return detectGitChanges(shadow, previousByPath, options?.turnId);
	}
	return detectCopyChanges(shadow, previousByPath, options?.turnId);
}

async function detectGitChanges(
	shadow: ShadowWorkspace,
	previousByPath: Map<string, ProposedChange>,
	turnId?: string,
): Promise<ProposedChange[]> {
	const baseline = shadow.baselineRef!;
	const [diffResult, statusResult] = await Promise.all([
		runGit(shadow.shadowCwd, ['diff', '--numstat', baseline]),
		runGit(shadow.shadowCwd, ['status', '--porcelain=v1', '-uall']),
	]);

	const numstat = parseNumstat(diffResult.stdout);
	const numstatByPath = new Map(numstat.map((r) => [r.path, r] as const));

	const statusPaths = new Map<string, string>();
	for (const line of statusResult.stdout.split('\n')) {
		if (!line || line.length < 4) {
			continue;
		}
		const code = line.slice(0, 2);
		let filePath = line.slice(3).replace(/\\/g, '/');
		const renameArrow = filePath.indexOf(' -> ');
		if (renameArrow >= 0) {
			filePath = filePath.slice(renameArrow + 4);
		}
		statusPaths.set(filePath, code);
	}

	// Untracked files may be missing from `git diff baseline`.
	for (const [rel] of statusPaths) {
		if (!numstatByPath.has(rel)) {
			const abs = path.join(shadow.shadowCwd, rel);
			let additions = 0;
			if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
				const text = fs.readFileSync(abs, 'utf8');
				additions = text.length === 0 ? 0 : text.split(/\r?\n/).length;
			}
			numstatByPath.set(rel, { path: rel, additions, deletions: 0 });
		}
	}

	const paths = new Set([...numstatByPath.keys(), ...statusPaths.keys()]);
	const changes: ProposedChange[] = [];

	for (const rel of paths) {
		if (isIgnoredChangePath(rel)) {
			continue;
		}
		const stats = numstatByPath.get(rel) ?? { path: rel, additions: 0, deletions: 0 };
		const shadowPath = path.join(shadow.shadowCwd, rel);
		const mainPath = path.join(shadow.mainCwd, rel);
		const existsInShadow = fs.existsSync(shadowPath);
		const baselineCheck = await runGit(shadow.shadowCwd, [
			'cat-file',
			'-e',
			`${baseline}:${rel.replace(/\\/g, '/')}`,
		]);
		const existedInBaseline = baselineCheck.code === 0;
		const kind = classifyKind(
			statusPaths.get(rel) ?? '',
			existsInShadow,
			existedInBaseline,
		);

		let additions = stats.additions;
		let deletions = stats.deletions;
		if (kind === 'deleted' && deletions === 0 && existedInBaseline) {
			const show = await runGit(shadow.shadowCwd, [
				'show',
				`${baseline}:${rel.replace(/\\/g, '/')}`,
			]);
			if (show.code === 0 && show.stdout) {
				deletions = show.stdout.split(/\r?\n/).length;
			}
		}
		if (kind === 'added' && additions === 0 && existsInShadow) {
			const text = fs.readFileSync(shadowPath, 'utf8');
			additions = text.length === 0 ? 0 : text.split(/\r?\n/).length;
		}

		const prev = previousByPath.get(rel);
		const ts = Date.now();
		const state = stateFromPrevious(prev, shadow, rel, shadowPath);

		if (!existsInShadow && !existedInBaseline) {
			continue;
		}
		if (
			kind === 'modified' &&
			additions === 0 &&
			deletions === 0 &&
			!(statusPaths.get(rel) ?? '').trim()
		) {
			continue;
		}

		changes.push({
			id: changeIdForPath(rel),
			turnId: turnId ?? prev?.turnId,
			path: rel,
			kind,
			additions,
			deletions,
			state,
			shadowPath,
			mainPath,
			createdAt: prev?.createdAt ?? ts,
			updatedAt: ts,
			revisions: prev?.revisions ?? [],
		});
	}

	return filterTrackedChanges(changes.sort((a, b) => a.path.localeCompare(b.path)));
}

async function detectCopyChanges(
	shadow: ShadowWorkspace,
	previousByPath: Map<string, ProposedChange>,
	turnId?: string,
): Promise<ProposedChange[]> {
	const baselineRoot = path.join(shadow.shadowCwd, '..', `${path.basename(shadow.shadowCwd)}.baseline`);
	const compareRoot = baselineRoot;
	if (!fs.existsSync(compareRoot)) {
		// Never snapshot current shadow as baseline — that erases all pending diffs.
		if (fs.existsSync(shadow.mainCwd)) {
			try {
				await copyWorkspace(shadow.mainCwd, compareRoot);
			} catch {
				return filterTrackedChanges([...previousByPath.values()]);
			}
		} else {
			return filterTrackedChanges([...previousByPath.values()]);
		}
	}

	const shadowFiles = listFilesRecursive(shadow.shadowCwd);
	const baselineFiles = listFilesRecursive(compareRoot);
	const all = new Set([...shadowFiles, ...baselineFiles]);
	const changes: ProposedChange[] = [];

	for (const rel of all) {
		if (isIgnoredChangePath(rel)) {
			continue;
		}
		const shadowPath = path.join(shadow.shadowCwd, rel);
		const baselinePath = path.join(compareRoot, rel);
		const mainPath = path.join(shadow.mainCwd, rel);
		const inShadow = fs.existsSync(shadowPath) && fs.statSync(shadowPath).isFile();
		const overlayDeleted = isBaselineOverlayDeleted(shadow, rel);
		const overlayText = readBaselineOverlay(shadow, rel);
		const inBaseline =
			!overlayDeleted &&
			(overlayText !== undefined ||
				(fs.existsSync(baselinePath) && fs.statSync(baselinePath).isFile()));

		if (!inShadow && !inBaseline) {
			continue;
		}
		if (inShadow && inBaseline) {
			const a = fs.readFileSync(shadowPath);
			const b =
				overlayText !== undefined
					? Buffer.from(overlayText, 'utf8')
					: fs.readFileSync(baselinePath);
			if (a.equals(b)) {
				continue;
			}
		}

		let kind: ChangeKind = 'modified';
		if (inShadow && !inBaseline) {
			kind = 'added';
		} else if (!inShadow && inBaseline) {
			kind = 'deleted';
		}

		const { additions, deletions } = roughLineDiff(
			inBaseline
				? overlayText !== undefined
					? overlayText
					: fs.readFileSync(baselinePath, 'utf8')
				: '',
			inShadow ? fs.readFileSync(shadowPath, 'utf8') : '',
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
			state: stateFromPrevious(prev, shadow, rel, shadowPath),
			shadowPath,
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
	// Cheap estimate: not a real LCS — good enough for card badges.
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
