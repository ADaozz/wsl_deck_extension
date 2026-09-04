import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
	type ShadowWorkspace,
	gitShowFile,
	runGit,
} from '../shadow/shadowWorkspaceManager';
import {
	advanceBaselineOverlay,
	isBaselineOverlayDeleted,
	readBaselineOverlay,
} from './baselineOverlay';
import type { ProposedChange } from './proposedChange';

function hashContent(content: string | Buffer | undefined): string {
	if (content === undefined) {
		return 'missing';
	}
	return crypto.createHash('sha256').update(content).digest('hex');
}

export async function baselineContentFor(
	shadow: ShadowWorkspace,
	relativePath: string,
): Promise<string | undefined> {
	const posix = relativePath.replace(/\\/g, '/');
	if (isBaselineOverlayDeleted(shadow, posix)) {
		return undefined;
	}
	const overlay = readBaselineOverlay(shadow, posix);
	if (overlay !== undefined) {
		return overlay;
	}
	if (shadow.kind === 'git-worktree' && shadow.baselineRef) {
		return gitShowFile(shadow.shadowCwd, shadow.baselineRef, posix);
	}
	const baselineRoot = path.join(
		shadow.shadowCwd,
		'..',
		`${path.basename(shadow.shadowCwd)}.baseline`,
	);
	const p = path.join(baselineRoot, posix);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	return fs.readFileSync(p, 'utf8');
}

/**
 * True when Main file content differs from the shadow baseline (user edited Main).
 */
export async function isMainConflicted(
	shadow: ShadowWorkspace,
	change: ProposedChange,
): Promise<boolean> {
	const baseline = await baselineContentFor(shadow, change.path);
	const baselineHash = hashContent(baseline);
	if (!fs.existsSync(change.mainPath)) {
		// Main missing: conflict only if baseline had the file (user deleted) and we're not accepting a delete.
		return baseline !== undefined && change.kind !== 'deleted';
	}
	const mainHash = hashContent(fs.readFileSync(change.mainPath));
	return mainHash !== baselineHash;
}

export async function cancelChange(
	shadow: ShadowWorkspace,
	change: ProposedChange,
): Promise<ProposedChange> {
	const rel = change.path.replace(/\\/g, '/');
	if (shadow.kind === 'git-worktree' && shadow.baselineRef) {
		const existed = await gitShowFile(shadow.shadowCwd, shadow.baselineRef, rel);
		if (existed === undefined) {
			if (fs.existsSync(change.shadowPath)) {
				fs.rmSync(change.shadowPath, { force: true });
			}
		} else {
			await runGit(shadow.shadowCwd, ['checkout', shadow.baselineRef, '--', rel]);
		}
	} else {
		const content = await baselineContentFor(shadow, rel);
		if (content === undefined) {
			if (fs.existsSync(change.shadowPath)) {
				fs.rmSync(change.shadowPath, { force: true });
			}
		} else {
			fs.mkdirSync(path.dirname(change.shadowPath), { recursive: true });
			fs.writeFileSync(change.shadowPath, content, 'utf8');
		}
	}
	return { ...change, state: 'rejected' };
}

export async function acceptChange(
	shadow: ShadowWorkspace,
	change: ProposedChange,
): Promise<ProposedChange> {
	if (change.state === 'accepted') {
		return change;
	}
	if (await isMainConflicted(shadow, change)) {
		return { ...change, state: 'conflicted' };
	}

	if (change.kind === 'deleted') {
		if (fs.existsSync(change.mainPath)) {
			fs.rmSync(change.mainPath, { force: true });
		}
		advanceBaselineOverlay(shadow, change.path, change.shadowPath, change.kind);
		return { ...change, state: 'accepted' };
	}

	if (!fs.existsSync(change.shadowPath)) {
		return { ...change, state: 'conflicted' };
	}

	fs.mkdirSync(path.dirname(change.mainPath), { recursive: true });
	fs.copyFileSync(change.shadowPath, change.mainPath);
	advanceBaselineOverlay(shadow, change.path, change.shadowPath, change.kind);
	return { ...change, state: 'accepted' };
}

export async function acceptAll(
	shadow: ShadowWorkspace,
	changes: ProposedChange[],
): Promise<ProposedChange[]> {
	const out: ProposedChange[] = [];
	for (const c of changes) {
		if (c.state !== 'pending' && c.state !== 'conflicted') {
			out.push(c);
			continue;
		}
		out.push(await acceptChange(shadow, c));
	}
	return out;
}

export async function cancelAll(
	shadow: ShadowWorkspace,
	changes: ProposedChange[],
): Promise<ProposedChange[]> {
	const out: ProposedChange[] = [];
	for (const c of changes) {
		if (c.state !== 'pending' && c.state !== 'conflicted') {
			out.push(c);
			continue;
		}
		out.push(await cancelChange(shadow, c));
	}
	return out;
}

/** Open VS Code native diff: baseline (left) vs shadow (right). */
export async function viewDiff(
	shadow: ShadowWorkspace,
	change: ProposedChange,
): Promise<void> {
	const baseline = await baselineContentFor(shadow, change.path);
	const tmpDir = path.join(os.tmpdir(), 'wsldeck-diff');
	fs.mkdirSync(tmpDir, { recursive: true });
	const safe = change.path.replace(/[^\w.-]+/g, '_');
	const leftPath = path.join(tmpDir, `${safe}.baseline`);
	const rightPath = path.join(tmpDir, `${safe}.shadow`);

	fs.writeFileSync(leftPath, baseline ?? '', 'utf8');
	if (fs.existsSync(change.shadowPath) && fs.statSync(change.shadowPath).isFile()) {
		fs.copyFileSync(change.shadowPath, rightPath);
	} else {
		fs.writeFileSync(rightPath, '', 'utf8');
	}

	const leftUri = vscode.Uri.file(leftPath);
	const rightUri = vscode.Uri.file(rightPath);
	const title =
		change.kind === 'added'
			? `${change.path} (empty ↔ shadow)`
			: `${change.path} (baseline ↔ shadow)`;
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}

/** Open VS Code native diff: Main (left) vs shadow (right) — for conflict review. */
export async function compareMain(
	_shadow: ShadowWorkspace,
	change: ProposedChange,
): Promise<void> {
	const tmpDir = path.join(os.tmpdir(), 'wsldeck-diff');
	fs.mkdirSync(tmpDir, { recursive: true });
	const safe = change.path.replace(/[^\w.-]+/g, '_');
	const leftPath = path.join(tmpDir, `${safe}.main`);
	const rightPath = path.join(tmpDir, `${safe}.shadow`);

	if (fs.existsSync(change.mainPath) && fs.statSync(change.mainPath).isFile()) {
		fs.copyFileSync(change.mainPath, leftPath);
	} else {
		fs.writeFileSync(leftPath, '', 'utf8');
	}
	if (fs.existsSync(change.shadowPath) && fs.statSync(change.shadowPath).isFile()) {
		fs.copyFileSync(change.shadowPath, rightPath);
	} else {
		fs.writeFileSync(rightPath, '', 'utf8');
	}

	const leftUri = vscode.Uri.file(leftPath);
	const rightUri = vscode.Uri.file(rightPath);
	const title = `${change.path} (Main ↔ shadow)`;
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}
