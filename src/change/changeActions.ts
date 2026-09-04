import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { SessionBaseline } from '../session/sessionBaseline';
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
	baseline: SessionBaseline,
	relativePath: string,
): Promise<string | undefined> {
	const posix = relativePath.replace(/\\/g, '/');
	if (isBaselineOverlayDeleted(baseline, posix)) {
		return undefined;
	}
	const overlay = readBaselineOverlay(baseline, posix);
	if (overlay !== undefined) {
		return overlay;
	}
	if (!baseline.baselineDir) {
		return undefined;
	}
	const p = path.join(baseline.baselineDir, posix);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	return fs.readFileSync(p, 'utf8');
}

/** True when Main differs from effective baseline (overlay or session start). */
export async function isMainConflicted(
	baseline: SessionBaseline,
	change: ProposedChange,
): Promise<boolean> {
	const effective = await baselineContentFor(baseline, change.path);
	const effectiveHash = hashContent(effective);
	if (!fs.existsSync(change.mainPath)) {
		return effective !== undefined && change.kind !== 'deleted';
	}
	const mainHash = hashContent(fs.readFileSync(change.mainPath));
	return mainHash !== effectiveHash;
}

export async function cancelChange(
	baseline: SessionBaseline,
	change: ProposedChange,
): Promise<ProposedChange> {
	const rel = change.path.replace(/\\/g, '/');
	const content = await baselineContentFor(baseline, rel);
	if (content === undefined) {
		if (fs.existsSync(change.mainPath)) {
			fs.rmSync(change.mainPath, { force: true });
		}
	} else {
		fs.mkdirSync(path.dirname(change.mainPath), { recursive: true });
		fs.writeFileSync(change.mainPath, content, 'utf8');
	}
	return { ...change, state: 'rejected' };
}

/** Keep = acknowledge agent edit on main (no file copy). */
export async function acceptChange(
	baseline: SessionBaseline,
	change: ProposedChange,
): Promise<ProposedChange> {
	if (change.state === 'accepted') {
		return change;
	}

	if (change.kind === 'deleted') {
		if (fs.existsSync(change.mainPath)) {
			fs.rmSync(change.mainPath, { force: true });
		}
		advanceBaselineOverlay(baseline, change.path, change.mainPath, change.kind);
		return { ...change, state: 'accepted' };
	}

	if (!fs.existsSync(change.mainPath)) {
		return { ...change, state: 'conflicted' };
	}

	advanceBaselineOverlay(baseline, change.path, change.mainPath, change.kind);
	return { ...change, state: 'accepted' };
}

export async function acceptAll(
	baseline: SessionBaseline,
	changes: ProposedChange[],
): Promise<ProposedChange[]> {
	const out: ProposedChange[] = [];
	for (const c of changes) {
		if (c.state !== 'pending' && c.state !== 'conflicted') {
			out.push(c);
			continue;
		}
		out.push(await acceptChange(baseline, c));
	}
	return out;
}

export async function cancelAll(
	baseline: SessionBaseline,
	changes: ProposedChange[],
): Promise<ProposedChange[]> {
	const out: ProposedChange[] = [];
	for (const c of changes) {
		if (c.state !== 'pending' && c.state !== 'conflicted') {
			out.push(c);
			continue;
		}
		out.push(await cancelChange(baseline, c));
	}
	return out;
}

/** Open VS Code native diff: baseline (left) vs current main (right). */
export async function viewDiff(
	baseline: SessionBaseline,
	change: ProposedChange,
): Promise<void> {
	const baselineText = await baselineContentFor(baseline, change.path);
	const tmpDir = path.join(os.tmpdir(), 'wsldeck-diff');
	fs.mkdirSync(tmpDir, { recursive: true });
	const safe = change.path.replace(/[^\w.-]+/g, '_');
	const leftPath = path.join(tmpDir, `${safe}.baseline`);
	const rightPath = path.join(tmpDir, `${safe}.main`);

	fs.writeFileSync(leftPath, baselineText ?? '', 'utf8');
	if (fs.existsSync(change.mainPath) && fs.statSync(change.mainPath).isFile()) {
		fs.copyFileSync(change.mainPath, rightPath);
	} else {
		fs.writeFileSync(rightPath, '', 'utf8');
	}

	const leftUri = vscode.Uri.file(leftPath);
	const rightUri = vscode.Uri.file(rightPath);
	const title =
		change.kind === 'added'
			? `${change.path} (empty ↔ workspace)`
			: `${change.path} (baseline ↔ workspace)`;
	await vscode.commands.executeCommand('vscode.diff', leftUri, rightUri, title);
}

/** Diff baseline vs current main for conflict review. */
export async function compareMain(
	baseline: SessionBaseline,
	change: ProposedChange,
): Promise<void> {
	await viewDiff(baseline, change);
}
