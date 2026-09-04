import * as fs from 'node:fs';
import * as path from 'node:path';
import { detectExtensionHost, type ExtensionHostKind } from '../workspace/workspaceContext';
import { sessionDeckDir, ensureDeckScaffold } from '../state/workspaceDeckStore';
import { snapshotWorkspace } from './workspaceCopy';
import {
	gitHeadAt,
	gitHeadWsl,
	isGitRepoAt,
	isGitRepoWsl,
} from './sessionGit';

export type SessionBaselineKind = 'git' | 'snapshot';

export interface SessionBaseline {
	sessionId: string;
	mainCwd: string;
	mainLinuxCwd?: string;
	kind: SessionBaselineKind;
	baselineRef?: string;
	baselineDir?: string;
	/** Run git via WSL when local-windows. */
	useWslGit: boolean;
	gitLinuxCwd?: string;
	wslDistro?: string;
	createdAt: number;
}

export interface EnsureBaselineOptions {
	host?: ExtensionHostKind;
	mainLinuxCwd?: string;
	wslDistro?: string;
	/** When true, capture current main as baseline even if meta exists (resume safety). */
	recapture?: boolean;
}

interface BaselineMetaFile {
	version: 1;
	kind: SessionBaselineKind;
	baselineRef?: string;
	createdAt: number;
}

export function sessionBaselineMetaPath(mainCwd: string, sessionId: string): string {
	return path.join(sessionDeckDir(mainCwd, sessionId), 'baseline.json');
}

export function sessionBaselineSnapshotDir(mainCwd: string, sessionId: string): string {
	return path.join(sessionDeckDir(mainCwd, sessionId), 'baseline');
}

function writeBaselineMeta(mainCwd: string, sessionId: string, meta: BaselineMetaFile): void {
	ensureDeckScaffold(mainCwd);
	const dir = sessionDeckDir(mainCwd, sessionId);
	fs.mkdirSync(dir, { recursive: true });
	fs.writeFileSync(sessionBaselineMetaPath(mainCwd, sessionId), `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
}

function readBaselineMeta(mainCwd: string, sessionId: string): BaselineMetaFile | undefined {
	const file = sessionBaselineMetaPath(mainCwd, sessionId);
	if (!fs.existsSync(file)) {
		return undefined;
	}
	try {
		const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as BaselineMetaFile;
		if (!raw || raw.version !== 1 || !raw.kind) {
			return undefined;
		}
		return raw;
	} catch {
		return undefined;
	}
}

function baselineFromMeta(
	sessionId: string,
	mainCwd: string,
	meta: BaselineMetaFile,
	opts: EnsureBaselineOptions,
): SessionBaseline {
	const host = opts.host ?? detectExtensionHost();
	const mainLinux = opts.mainLinuxCwd;
	const useWslGit = host === 'local-windows' && Boolean(mainLinux?.trim());
	return {
		sessionId,
		mainCwd,
		mainLinuxCwd: mainLinux,
		kind: meta.kind,
		baselineRef: meta.baselineRef,
		baselineDir: sessionBaselineSnapshotDir(mainCwd, sessionId),
		useWslGit,
		gitLinuxCwd: useWslGit ? mainLinux : undefined,
		wslDistro: opts.wslDistro,
		createdAt: meta.createdAt,
	};
}

export class SessionBaselineManager {
	private readonly baselines = new Map<string, SessionBaseline>();

	get(sessionId: string): SessionBaseline | undefined {
		return this.baselines.get(sessionId);
	}

	async ensureBaseline(
		mainCwd: string,
		sessionId: string,
		opts?: EnsureBaselineOptions,
	): Promise<SessionBaseline> {
		const existing = this.baselines.get(sessionId);
		if (existing && existing.mainCwd === mainCwd && !opts?.recapture) {
			return existing;
		}

		if (!opts?.recapture) {
			const meta = readBaselineMeta(mainCwd, sessionId);
			if (meta) {
				const dir = sessionBaselineSnapshotDir(mainCwd, sessionId);
				if (fs.existsSync(dir)) {
					const baseline = baselineFromMeta(sessionId, mainCwd, meta, opts ?? {});
					this.baselines.set(sessionId, baseline);
					return baseline;
				}
			}
		}

		const host = opts?.host ?? detectExtensionHost();
		const mainLinux = opts?.mainLinuxCwd;
		const useWslGit = host === 'local-windows' && Boolean(mainLinux?.trim());
		const createdAt = Date.now();

		let baseline: SessionBaseline;

		const git =
			useWslGit && mainLinux
				? await isGitRepoWsl(mainLinux, opts?.wslDistro)
				: await isGitRepoAt(mainCwd);

		const snapshotDir = sessionBaselineSnapshotDir(mainCwd, sessionId);
		if (fs.existsSync(snapshotDir)) {
			fs.rmSync(snapshotDir, { recursive: true, force: true });
		}
		await snapshotWorkspace(mainCwd, snapshotDir);

		if (git) {
			const ref =
				useWslGit && mainLinux
					? await gitHeadWsl(mainLinux, opts?.wslDistro)
					: await gitHeadAt(mainCwd);
			if (!ref) {
				throw new Error('Cannot resolve git HEAD for session baseline metadata');
			}
			writeBaselineMeta(mainCwd, sessionId, {
				version: 1,
				kind: 'git',
				baselineRef: ref,
				createdAt,
			});
			baseline = {
				sessionId,
				mainCwd,
				mainLinuxCwd: mainLinux,
				kind: 'git',
				baselineRef: ref,
				baselineDir: snapshotDir,
				useWslGit,
				gitLinuxCwd: useWslGit ? mainLinux : undefined,
				wslDistro: opts?.wslDistro,
				createdAt,
			};
		} else {
			writeBaselineMeta(mainCwd, sessionId, {
				version: 1,
				kind: 'snapshot',
				createdAt,
			});
			baseline = {
				sessionId,
				mainCwd,
				mainLinuxCwd: mainLinux,
				kind: 'snapshot',
				baselineDir: snapshotDir,
				useWslGit,
				gitLinuxCwd: useWslGit ? mainLinux : undefined,
				wslDistro: opts?.wslDistro,
				createdAt,
			};
		}

		this.baselines.set(sessionId, baseline);
		return baseline;
	}

	disposeSession(sessionId: string): void {
		this.baselines.delete(sessionId);
	}

	disposeExcept(keep: Set<string>): void {
		for (const id of [...this.baselines.keys()]) {
			if (!keep.has(id)) {
				this.baselines.delete(id);
			}
		}
	}

	disposeAll(): void {
		this.baselines.clear();
	}
}
