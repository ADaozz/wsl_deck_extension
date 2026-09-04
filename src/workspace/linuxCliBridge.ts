import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWslExeArgs } from './wslPathResolver';

export type LinuxCliHostKind = 'local-windows' | 'local-linux' | 'wsl-remote' | 'other-remote';

const execFileAsync = promisify(execFile);

export interface CliLaunchSpec {
	executable: string;
	args: string[];
}

export interface LinuxCliContext {
	host: LinuxCliHostKind;
	linuxCwd?: string;
	distro?: string;
}

export class LinuxCliBridgeError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'LinuxCliBridgeError';
	}
}

const WSL_EXECUTABLE = process.platform === 'win32' ? 'wsl.exe' : 'wsl';

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function mergeLinuxCliContext(
	workspace: { host: LinuxCliHostKind; linuxCwd?: string; distro?: string },
	overrides?: { linuxCwd?: string },
): LinuxCliContext {
	return {
		host: workspace.host,
		distro: workspace.distro,
		linuxCwd: overrides?.linuxCwd ?? workspace.linuxCwd,
	};
}

export function usesWslCliBridge(ctx: LinuxCliContext): boolean {
	return ctx.host === 'local-windows';
}

function assertLinuxCwd(ctx: LinuxCliContext): string {
	const cwd = ctx.linuxCwd?.trim();
	if (!cwd) {
		throw new LinuxCliBridgeError(
			'未打开工作区文件夹。请使用「文件 → 打开文件夹…」打开项目目录后再使用 WSLDeck。',
		);
	}
	return cwd;
}

function compactEnv(
	env?: Record<string, string | undefined>,
	unsetEnvKeys?: string[],
): string[] {
	const out: string[] = [];
	for (const key of unsetEnvKeys ?? []) {
		if (key.trim()) {
			out.push('-u', key);
		}
	}
	if (!env) {
		return out;
	}
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || value === '') {
			continue;
		}
		out.push(`${key}=${value}`);
	}
	return out;
}

function applyUnsetEnvKeys(
	env: Record<string, string | undefined>,
	unsetEnvKeys?: string[],
): Record<string, string | undefined> {
	if (!unsetEnvKeys?.length) {
		return env;
	}
	const out = { ...env };
	for (const key of unsetEnvKeys) {
		delete out[key];
	}
	return out;
}

/** Merge resolved Linux agent env with per-invocation overrides. */
export function mergeCliLaunchEnv(
	linuxEnv?: Record<string, string | undefined>,
	extra?: Record<string, string | undefined>,
): Record<string, string | undefined> | undefined {
	if (!linuxEnv && !extra) {
		return undefined;
	}
	const merged: Record<string, string | undefined> = { ...linuxEnv, ...extra };
	for (const key of Object.keys(merged)) {
		if (merged[key] === undefined || merged[key] === '') {
			delete merged[key];
		}
	}
	return Object.keys(merged).length > 0 ? merged : undefined;
}

/**
 * Build host launch spec for a Linux argv vector.
 * local-windows → wsl.exe [-d distro] --cd linuxCwd -- [env ...] argv...
 * Linux process env comes only from linuxEnv/extra — not Windows process.env.
 */
export function buildLinuxCliLaunch(
	ctx: LinuxCliContext,
	argv: string[],
	env?: Record<string, string | undefined>,
	unsetEnvKeys?: string[],
): CliLaunchSpec {
	if (argv.length === 0 || !argv[0]) {
		throw new LinuxCliBridgeError('Empty argv for Linux CLI launch');
	}

	if (usesWslCliBridge(ctx)) {
		const linuxCwd = assertLinuxCwd(ctx);
		const wslArgs = [...buildWslExeArgs(linuxCwd, ctx.distro)];
		const inner: string[] = [];
		const envArgs = compactEnv(env, unsetEnvKeys);
		if (envArgs.length > 0) {
			inner.push('env', ...envArgs);
		}
		inner.push(...argv);
		wslArgs.push('--', ...inner);
		return { executable: WSL_EXECUTABLE, args: wslArgs };
	}

	return { executable: argv[0], args: argv.slice(1) };
}

export function formatLinuxCliDetail(path: string, ctx: LinuxCliContext): string {
	if (usesWslCliBridge(ctx)) {
		return `${path} (via wsl.exe)`;
	}
	return path;
}

function commandLookupArgv(name: string): string[] {
	return ['bash', '-c', `command -v ${shellQuote(name)}`];
}

export async function resolveLinuxCommand(
	ctx: LinuxCliContext,
	command: string,
	linuxEnv?: Record<string, string | undefined>,
): Promise<string | undefined> {
	const name = command.trim();
	if (!name) {
		return undefined;
	}

	const launchEnv = mergeCliLaunchEnv(linuxEnv);

	try {
		if (usesWslCliBridge(ctx)) {
			const launch = buildLinuxCliLaunch(ctx, commandLookupArgv(name), launchEnv);
			const { stdout } = await execFileAsync(launch.executable, launch.args, {
				timeout: 5_000,
				windowsHide: true,
			});
			const path = stdout.toString().trim();
			return path.length > 0 ? path : undefined;
		}

		if (launchEnv) {
			const launch = buildLinuxCliLaunch(ctx, commandLookupArgv(name), launchEnv);
			const spawnOpts: Parameters<typeof execFileAsync>[2] = {
				timeout: 5_000,
				env: { ...process.env, ...launchEnv },
			};
			if (ctx.linuxCwd) {
				spawnOpts.cwd = ctx.linuxCwd;
			}
			const { stdout } = await execFileAsync(launch.executable, launch.args, spawnOpts);
			const path = stdout.toString().trim();
			return path.length > 0 ? path : undefined;
		}

		if (ctx.host === 'other-remote') {
			const { stdout } = await execFileAsync(
				'bash',
				['-lc', `command -v ${shellQuote(name)}`],
				{ timeout: 5_000 },
			);
			const path = stdout.toString().trim();
			return path.length > 0 ? path : undefined;
		}

		const { stdout } = await execFileAsync(
			'bash',
			['-lc', `command -v ${shellQuote(name)}`],
			{
				timeout: 5_000,
				cwd: ctx.linuxCwd,
			},
		);
		const path = stdout.toString().trim();
		return path.length > 0 ? path : undefined;
	} catch {
		return undefined;
	}
}

/** Resolve command to an absolute Linux path and build argv (required for wsl.exe non-login PATH). */
export async function resolveLinuxArgv(
	ctx: LinuxCliContext,
	command: string,
	args: string[] = [],
	linuxEnv?: Record<string, string | undefined>,
): Promise<string[] | undefined> {
	const resolved = await resolveLinuxCommand(ctx, command, linuxEnv);
	if (!resolved) {
		return undefined;
	}
	return [resolved, ...args];
}

export interface RunLinuxCliOptions {
	timeout?: number;
	maxBuffer?: number;
	linuxEnv?: Record<string, string | undefined>;
	env?: Record<string, string | undefined>;
	unsetEnvKeys?: string[];
}

export async function runLinuxCli(
	ctx: LinuxCliContext,
	argv: string[],
	opts?: RunLinuxCliOptions,
): Promise<{ stdout: string; stderr: string }> {
	const launchEnv = mergeCliLaunchEnv(opts?.linuxEnv, opts?.env);
	const launch = buildLinuxCliLaunch(ctx, argv, launchEnv, opts?.unsetEnvKeys);
	const spawnOpts: Parameters<typeof execFileAsync>[2] = {
		timeout: opts?.timeout ?? 30_000,
		maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
		windowsHide: true,
	};
	if (!usesWslCliBridge(ctx)) {
		if (launchEnv || opts?.unsetEnvKeys?.length) {
			spawnOpts.env = applyUnsetEnvKeys(
				{ ...process.env, ...launchEnv },
				opts?.unsetEnvKeys,
			);
		}
		if (ctx.linuxCwd) {
			spawnOpts.cwd = ctx.linuxCwd;
		}
	}
	const { stdout, stderr } = await execFileAsync(launch.executable, launch.args, spawnOpts);
	return { stdout: stdout.toString(), stderr: stderr.toString() };
}

export interface SpawnLinuxCliOptions {
	signal?: AbortSignal;
	linuxEnv?: Record<string, string | undefined>;
	env?: Record<string, string | undefined>;
	unsetEnvKeys?: string[];
}

/** Terminate a CLI child (wsl.exe tree on Windows). Idempotent. */
export function killLinuxCliChild(child: ChildProcess): void {
	if (child.killed || child.exitCode !== null || child.signalCode !== null) {
		return;
	}
	const pid = child.pid;
	if (pid === undefined) {
		return;
	}
	if (process.platform === 'win32') {
		try {
			spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
				windowsHide: true,
				stdio: 'ignore',
			});
			return;
		} catch {
			// fall through to signal kill
		}
	}
	try {
		child.kill('SIGTERM');
	} catch {
		// ignore
	}
	setTimeout(() => {
		if (!child.killed && child.exitCode === null) {
			try {
				child.kill('SIGKILL');
			} catch {
				// ignore
			}
		}
	}, 2_000).unref();
}

export function spawnLinuxCli(
	ctx: LinuxCliContext,
	argv: string[],
	opts?: SpawnLinuxCliOptions,
): ChildProcess {
	const launchEnv = mergeCliLaunchEnv(opts?.linuxEnv, opts?.env);
	const launch = buildLinuxCliLaunch(ctx, argv, launchEnv, opts?.unsetEnvKeys);
	const spawnOpts: SpawnOptions = {
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
	};
	if (usesWslCliBridge(ctx)) {
		// Force wsl.exe diagnostics to UTF-8; otherwise localized Windows warnings
		// may arrive as UTF-16LE and be corrupted before readline can sanitize them.
		spawnOpts.env = { ...process.env, WSL_UTF8: '1' };
	} else {
		spawnOpts.env = applyUnsetEnvKeys(
			launchEnv ? { ...process.env, ...launchEnv } : { ...process.env },
			opts?.unsetEnvKeys,
		);
		if (ctx.linuxCwd) {
			spawnOpts.cwd = ctx.linuxCwd;
		}
	}
	const child = spawn(launch.executable, launch.args, spawnOpts);

	if (opts?.signal) {
		const onAbort = () => {
			killLinuxCliChild(child);
		};
		if (opts.signal.aborted) {
			onAbort();
		} else {
			opts.signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	return child;
}
