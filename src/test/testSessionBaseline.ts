import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SessionBaseline } from '../session/sessionBaseline';
import { sessionBaselineSnapshotDir } from '../session/sessionBaseline';

const SKIP = new Set(['.git', 'node_modules', '.venv', 'venv', 'dist', 'out', 'build', '.next', 'coverage', '.vscode-test', '.WSLDeck']);

function snapshotMainSync(mainCwd: string, baselineDir: string): void {
	if (fs.existsSync(baselineDir)) {
		fs.rmSync(baselineDir, { recursive: true, force: true });
	}
	fs.mkdirSync(baselineDir, { recursive: true });
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (SKIP.has(entry.name)) {
				continue;
			}
			const abs = path.join(dir, entry.name);
			const rel = path.relative(mainCwd, abs).replace(/\\/g, '/');
			const target = path.join(baselineDir, rel);
			if (entry.isDirectory()) {
				fs.mkdirSync(target, { recursive: true });
				walk(abs);
			} else if (entry.isFile()) {
				fs.mkdirSync(path.dirname(target), { recursive: true });
				fs.copyFileSync(abs, target);
			}
		}
	};
	walk(mainCwd);
}

export function testSnapshotBaseline(
	root: string,
	sessionId: string,
	mainSubdir = 'main',
): SessionBaseline {
	const mainCwd = path.join(root, mainSubdir);
	const baselineDir = sessionBaselineSnapshotDir(mainCwd, sessionId);
	fs.mkdirSync(baselineDir, { recursive: true });
	return {
		sessionId,
		mainCwd,
		kind: 'snapshot',
		baselineDir,
		useWslGit: false,
		createdAt: Date.now(),
	};
}

/** Git repo baseline — diff/cancel use session-start snapshot, not git HEAD. */
export function testGitBaseline(
	mainCwd: string,
	sessionId: string,
	baselineRef: string,
): SessionBaseline {
	const baselineDir = sessionBaselineSnapshotDir(mainCwd, sessionId);
	snapshotMainSync(mainCwd, baselineDir);
	return {
		sessionId,
		mainCwd,
		kind: 'git',
		baselineRef,
		baselineDir,
		useWslGit: false,
		createdAt: Date.now(),
	};
}
