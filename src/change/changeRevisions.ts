import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vscode from 'vscode';
import * as os from 'node:os';
import { sessionDeckDir } from '../state/workspaceDeckStore';
import {
	type ChangeRevision,
	type ProposedChange,
	revisionIdForTurn,
} from './proposedChange';
import { baselineContentFor } from './changeActions';
import type { ShadowWorkspace } from '../shadow/shadowWorkspaceManager';
import { roughLineDiff } from './changeTracker';

export function sessionSnapshotsDir(mainCwd: string, sessionId: string): string {
	return path.join(sessionDeckDir(mainCwd, sessionId), 'snapshots');
}

export function revisionSnapshotPath(
	mainCwd: string,
	sessionId: string,
	snapshotId: string,
	relativePath: string,
): string {
	const rel = relativePath.replace(/\\/g, '/');
	return path.join(sessionSnapshotsDir(mainCwd, sessionId), snapshotId, rel);
}

export function writeRevisionSnapshot(
	mainCwd: string,
	sessionId: string,
	snapshotId: string,
	relativePath: string,
	sourcePath: string,
): void {
	const dest = revisionSnapshotPath(mainCwd, sessionId, snapshotId, relativePath);
	if (!fs.existsSync(sourcePath) || !fs.statSync(sourcePath).isFile()) {
		if (fs.existsSync(dest)) {
			fs.rmSync(dest, { force: true });
		}
		return;
	}
	fs.mkdirSync(path.dirname(dest), { recursive: true });
	fs.copyFileSync(sourcePath, dest);
}

export function readRevisionSnapshot(
	mainCwd: string,
	sessionId: string,
	snapshotId: string,
	relativePath: string,
): string | undefined {
	const p = revisionSnapshotPath(mainCwd, sessionId, snapshotId, relativePath);
	if (!fs.existsSync(p) || !fs.statSync(p).isFile()) {
		return undefined;
	}
	return fs.readFileSync(p, 'utf8');
}

async function turnStartContent(
	shadow: ShadowWorkspace,
	change: ProposedChange,
	prevRevisions: ChangeRevision[],
	mainCwd: string,
	sessionId: string,
): Promise<string> {
	const last = prevRevisions[prevRevisions.length - 1];
	if (last?.snapshotId) {
		const snap = readRevisionSnapshot(mainCwd, sessionId, last.snapshotId, change.path);
		if (snap !== undefined) {
			return snap;
		}
	}
	const baseline = await baselineContentFor(shadow, change.path);
	return baseline ?? '';
}

/**
 * Merge detected rows with previous deck state: one card per path, append/update revision per turn.
 */
export async function enrichChangesWithRevisions(
	shadow: ShadowWorkspace,
	previous: ProposedChange[],
	detected: ProposedChange[],
	ctx: {
		turnId?: string;
		agentMsgId?: string;
		mainCwd: string;
		sessionId: string;
		now?: number;
	},
): Promise<ProposedChange[]> {
	const now = ctx.now ?? Date.now();
	const prevByPath = new Map(previous.map((c) => [c.path, c] as const));
	const out: ProposedChange[] = [];

	for (const row of detected) {
		const prev = prevByPath.get(row.path);
		const createdAt = prev?.createdAt ?? now;
		const revisions = [...(prev?.revisions ?? [])];
		let updatedAt = now;

		if (ctx.turnId && ctx.mainCwd && ctx.sessionId) {
			const snapshotId = revisionIdForTurn(ctx.turnId);
			const existingIdx = revisions.findIndex((r) => r.turnId === ctx.turnId);
			const startText = await turnStartContent(
				shadow,
				row,
				existingIdx >= 0 ? revisions.slice(0, existingIdx) : revisions,
				ctx.mainCwd,
				ctx.sessionId,
			);
			const endText = fs.existsSync(row.shadowPath) && fs.statSync(row.shadowPath).isFile()
				? fs.readFileSync(row.shadowPath, 'utf8')
				: '';
			const { additions, deletions } = roughLineDiff(startText, endText);

			writeRevisionSnapshot(
				ctx.mainCwd,
				ctx.sessionId,
				snapshotId,
				row.path,
				row.shadowPath,
			);

			const revision: ChangeRevision = {
				id: snapshotId,
				turnId: ctx.turnId,
				agentMsgId: ctx.agentMsgId,
				at: now,
				additions,
				deletions,
				snapshotId,
			};

			if (existingIdx >= 0) {
				revisions[existingIdx] = revision;
			} else {
				revisions.push(revision);
			}
			revisions.sort((a, b) => a.at - b.at);
		} else if (prev) {
			updatedAt = prev.updatedAt;
		}

		out.push({
			...row,
			createdAt,
			updatedAt,
			revisions,
		});
	}

	// Keep accepted-only cards that disappeared from detect but have revision history.
	for (const prev of previous) {
		if (out.some((c) => c.path === prev.path)) {
			continue;
		}
		if (prev.state === 'accepted' && prev.revisions.length > 0) {
			out.push({ ...prev, updatedAt: prev.updatedAt });
		}
	}

	return out.sort((a, b) => a.path.localeCompare(b.path));
}

export function revisionBaselineContent(
	shadow: ShadowWorkspace,
	change: ProposedChange,
	revision: ChangeRevision,
	mainCwd: string,
	sessionId: string,
): Promise<string | undefined> {
	const idx = change.revisions.findIndex((r) => r.id === revision.id);
	const prior = idx > 0 ? change.revisions[idx - 1] : undefined;
	if (prior?.snapshotId) {
		const text = readRevisionSnapshot(mainCwd, sessionId, prior.snapshotId, change.path);
		if (text !== undefined) {
			return Promise.resolve(text);
		}
	}
	return baselineContentFor(shadow, change.path);
}

export function revisionEndSnapshotPath(
	mainCwd: string,
	sessionId: string,
	revision: ChangeRevision,
	relativePath: string,
): string | undefined {
	if (!revision.snapshotId) {
		return undefined;
	}
	const p = revisionSnapshotPath(mainCwd, sessionId, revision.snapshotId, relativePath);
	return fs.existsSync(p) ? p : undefined;
}

/** Diff for one revision: prior snapshot (or baseline) vs this revision snapshot. */
export async function viewRevisionDiff(
	shadow: ShadowWorkspace,
	change: ProposedChange,
	revision: ChangeRevision,
	mainCwd: string,
	sessionId: string,
): Promise<void> {
	const leftContent =
		(await revisionBaselineContent(shadow, change, revision, mainCwd, sessionId)) ?? '';
	const rightPath = revisionEndSnapshotPath(mainCwd, sessionId, revision, change.path);
	const tmpDir = path.join(os.tmpdir(), 'wsldeck-diff');
	fs.mkdirSync(tmpDir, { recursive: true });
	const safe = change.path.replace(/[^\w.-]+/g, '_');
	const leftPath = path.join(tmpDir, `${safe}.${revision.id}.before`);
	const rightTmp = path.join(tmpDir, `${safe}.${revision.id}.after`);

	fs.writeFileSync(leftPath, leftContent, 'utf8');
	if (rightPath && fs.existsSync(rightPath)) {
		fs.copyFileSync(rightPath, rightTmp);
	} else if (fs.existsSync(change.shadowPath)) {
		fs.copyFileSync(change.shadowPath, rightTmp);
	} else {
		fs.writeFileSync(rightTmp, '', 'utf8');
	}

	const turnShort = revision.turnId.slice(-6);
	const title = `${change.path} (turn …${turnShort})`;
	await vscode.commands.executeCommand(
		'vscode.diff',
		vscode.Uri.file(leftPath),
		vscode.Uri.file(rightTmp),
		title,
	);
}
