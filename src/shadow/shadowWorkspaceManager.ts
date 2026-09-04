import { execFile } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { promisify } from 'node:util';
import { ensureDir, ensureShadowParent, shadowSessionDir } from './shadowPaths';

const execFileAsync = promisify(execFile);

export type ShadowKind = 'git-worktree' | 'copy';

export interface ShadowWorkspace {
	sessionId: string;
	mainCwd: string;
	shadowCwd: string;
	kind: ShadowKind;
	/** Git commit SHA at shadow creation (git-worktree only). */
	baselineRef?: string;
	createdAt: number;
}

async function run(
	cwd: string,
	command: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, {
			cwd,
			encoding: 'utf8',
			maxBuffer: 16 * 1024 * 1024,
		});
		return { stdout: stdout ?? '', stderr: stderr ?? '', code: 0 };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string; message?: string };
		return {
			stdout: e.stdout ?? '',
			stderr: e.stderr ?? e.message ?? String(err),
			code: typeof e.code === 'number' ? e.code : 1,
		};
	}
}

export async function isGitRepo(cwd: string): Promise<boolean> {
	const result = await run(cwd, 'git', ['rev-parse', '--is-inside-work-tree']);
	return result.code === 0 && result.stdout.trim() === 'true';
}

export async function gitHead(cwd: string): Promise<string | undefined> {
	const result = await run(cwd, 'git', ['rev-parse', 'HEAD']);
	if (result.code !== 0) {
		return undefined;
	}
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : undefined;
}

function copyBaselineRoot(shadowCwd: string): string {
	return path.join(path.dirname(shadowCwd), `${path.basename(shadowCwd)}.baseline`);
}

/**
 * Create or reuse a shadow workspace for one agent session.
 * Prefer git worktree; fall back to a filtered directory copy.
 * Existing on-disk shadows are reattached (Resume / reload) — not wiped.
 */
export class ShadowWorkspaceManager {
	private readonly shadows = new Map<string, ShadowWorkspace>();

	get(sessionId: string): ShadowWorkspace | undefined {
		return this.shadows.get(sessionId);
	}

	listSessionIds(): string[] {
		return [...this.shadows.keys()];
	}

	async ensureShadow(mainCwd: string, sessionId: string): Promise<ShadowWorkspace> {
		const existing = this.shadows.get(sessionId);
		if (existing && existing.mainCwd === mainCwd && fs.existsSync(existing.shadowCwd)) {
			return existing;
		}
		if (existing) {
			this.shadows.delete(sessionId);
		}

		const shadowCwd = ensureShadowParent(mainCwd, sessionId);

		if (fs.existsSync(shadowCwd)) {
			const reattached = await this.tryReattach(mainCwd, sessionId, shadowCwd);
			if (reattached) {
				this.shadows.set(sessionId, reattached);
				return reattached;
			}
			await this.removeShadowDir(mainCwd, shadowCwd);
		}

		const git = await isGitRepo(mainCwd);
		if (git) {
			const baselineRef = await gitHead(mainCwd);
			if (!baselineRef) {
				throw new Error('Cannot resolve git HEAD for shadow worktree');
			}
			const add = await run(mainCwd, 'git', [
				'worktree',
				'add',
				'--detach',
				shadowCwd,
				baselineRef,
			]);
			if (add.code !== 0) {
				throw new Error(`git worktree add failed: ${add.stderr || add.stdout}`);
			}
			const shadow: ShadowWorkspace = {
				sessionId,
				mainCwd,
				shadowCwd,
				kind: 'git-worktree',
				baselineRef,
				createdAt: Date.now(),
			};
			this.shadows.set(sessionId, shadow);
			return shadow;
		}

		await copyWorkspace(mainCwd, shadowCwd);
		const baselineRoot = copyBaselineRoot(shadowCwd);
		if (fs.existsSync(baselineRoot)) {
			fs.rmSync(baselineRoot, { recursive: true, force: true });
		}
		await copyWorkspace(mainCwd, baselineRoot);
		const shadow: ShadowWorkspace = {
			sessionId,
			mainCwd,
			shadowCwd,
			kind: 'copy',
			createdAt: Date.now(),
		};
		this.shadows.set(sessionId, shadow);
		return shadow;
	}

	private async tryReattach(
		mainCwd: string,
		sessionId: string,
		shadowCwd: string,
	): Promise<ShadowWorkspace | undefined> {
		if (await isGitRepo(shadowCwd)) {
			await run(mainCwd, 'git', ['worktree', 'repair']);
			const baselineRef = await gitHead(shadowCwd);
			if (!baselineRef) {
				return undefined;
			}
			return {
				sessionId,
				mainCwd,
				shadowCwd,
				kind: 'git-worktree',
				baselineRef,
				createdAt: Date.now(),
			};
		}

		const baselineRoot = copyBaselineRoot(shadowCwd);
		if (fs.existsSync(baselineRoot) || fs.existsSync(shadowCwd)) {
			if (!fs.existsSync(baselineRoot) && fs.existsSync(mainCwd)) {
				await copyWorkspace(mainCwd, baselineRoot);
			}
			return {
				sessionId,
				mainCwd,
				shadowCwd,
				kind: 'copy',
				createdAt: Date.now(),
			};
		}
		return undefined;
	}

	async disposeShadow(sessionId: string): Promise<void> {
		const shadow = this.shadows.get(sessionId);
		if (!shadow) {
			return;
		}
		this.shadows.delete(sessionId);
		await this.removeShadowDir(shadow.mainCwd, shadow.shadowCwd);
	}

	/** Drop a session shadow even if it is only on disk (not in the in-memory map). */
	async disposeSession(mainCwd: string, sessionId: string): Promise<void> {
		const mapped = this.shadows.get(sessionId);
		if (mapped) {
			await this.disposeShadow(sessionId);
			return;
		}
		const shadowCwd = shadowSessionDir(mainCwd, sessionId);
		if (fs.existsSync(shadowCwd)) {
			await this.removeShadowDir(mainCwd, shadowCwd);
		}
	}

	/** Dispose shadows whose session ids are not retained. */
	async disposeExcept(keepSessionIds: Set<string>): Promise<void> {
		for (const id of [...this.shadows.keys()]) {
			if (!keepSessionIds.has(id)) {
				await this.disposeShadow(id);
			}
		}
	}

	async disposeAll(): Promise<void> {
		const ids = [...this.shadows.keys()];
		for (const id of ids) {
			await this.disposeShadow(id);
		}
	}

	/**
	 * Remove legacy in-workspace shadows (`<main>/.WSLDeck/shadows/*`) that make
	 * VS Code SCM / Diff treat agent worktrees as Main Workspace changes.
	 */
	async disposeLegacyInWorkspaceShadows(mainCwd: string): Promise<number> {
		const legacyRoot = path.join(mainCwd, '.WSLDeck', 'shadows');
		if (!fs.existsSync(legacyRoot)) {
			return 0;
		}
		let removed = 0;
		const entries = fs.readdirSync(legacyRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory() || entry.name.endsWith('.baseline')) {
				continue;
			}
			const shadowCwd = path.join(legacyRoot, entry.name);
			await this.removeShadowDir(mainCwd, shadowCwd);
			const baseline = copyBaselineRoot(shadowCwd);
			if (fs.existsSync(baseline)) {
				fs.rmSync(baseline, { recursive: true, force: true });
			}
			removed += 1;
		}
		try {
			const left = fs.readdirSync(legacyRoot);
			if (left.length === 0) {
				fs.rmdirSync(legacyRoot);
			}
		} catch {
			// ignore
		}
		return removed;
	}

	private async removeShadowDir(mainCwd: string, shadowCwd: string): Promise<void> {
		const baselineRoot = copyBaselineRoot(shadowCwd);
		const overlayRoot = path.join(
			path.dirname(shadowCwd),
			`${path.basename(shadowCwd)}.baseline-overlay`,
		);
		if (fs.existsSync(overlayRoot)) {
			fs.rmSync(overlayRoot, { recursive: true, force: true });
		}
		if (fs.existsSync(baselineRoot)) {
			fs.rmSync(baselineRoot, { recursive: true, force: true });
		}
		if (!fs.existsSync(shadowCwd)) {
			return;
		}
		if (mainCwd && (await isGitRepo(mainCwd))) {
			const removed = await run(mainCwd, 'git', ['worktree', 'remove', '--force', shadowCwd]);
			if (removed.code === 0) {
				return;
			}
		}
		fs.rmSync(shadowCwd, { recursive: true, force: true });
	}
}

const SKIP_DIR_NAMES = new Set([
	'.git',
	'node_modules',
	'.venv',
	'venv',
	'dist',
	'out',
	'build',
	'.next',
	'coverage',
	'.vscode-test',
	'.WSLDeck',
]);

export async function copyWorkspace(src: string, dest: string): Promise<void> {
	ensureDir(dest);
	await fs.promises.cp(src, dest, {
		recursive: true,
		filter: (source) => {
			const base = path.basename(source);
			if (SKIP_DIR_NAMES.has(base)) {
				return false;
			}
			return true;
		},
	});
}

/** Read file content at a git revision (empty string if missing). */
export async function gitShowFile(
	repoCwd: string,
	ref: string,
	relativePath: string,
): Promise<string | undefined> {
	const result = await run(repoCwd, 'git', ['show', `${ref}:${relativePath.replace(/\\/g, '/')}`]);
	if (result.code !== 0) {
		return undefined;
	}
	return result.stdout;
}

export async function runGit(
	cwd: string,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	return run(cwd, 'git', args);
}
