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

function compactEnv(env?: Record<string, string | undefined>): string[] {
	if (!env) {
		return [];
	}
	const out: string[] = [];
	for (const [key, value] of Object.entries(env)) {
		if (value === undefined || value === '') {
			continue;
		}
		out.push(`${key}=${value}`);
	}
	return out;
}

/**
 * Build host launch spec for a Linux argv vector.
 * local-windows → wsl.exe [-d distro] --cd linuxCwd -- [env ...] argv...
 */
export function buildLinuxCliLaunch(
	ctx: LinuxCliContext,
	argv: string[],
	env?: Record<string, string | undefined>,
): CliLaunchSpec {
	if (argv.length === 0 || !argv[0]) {
		throw new LinuxCliBridgeError('Empty argv for Linux CLI launch');
	}

	if (usesWslCliBridge(ctx)) {
		const linuxCwd = assertLinuxCwd(ctx);
		const wslArgs = [...buildWslExeArgs(linuxCwd, ctx.distro)];
		const inner: string[] = [];
		const envArgs = compactEnv(env);
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

export async function resolveLinuxCommand(
	ctx: LinuxCliContext,
	command: string,
): Promise<string | undefined> {
	const name = command.trim();
	if (!name) {
		return undefined;
	}

	try {
		if (usesWslCliBridge(ctx)) {
			const launch = buildLinuxCliLaunch(ctx, [
				'bash',
				'-lc',
				`command -v ${shellQuote(name)}`,
			]);
			const { stdout } = await execFileAsync(launch.executable, launch.args, {
				timeout: 5_000,
				windowsHide: true,
			});
			const path = stdout.trim();
			return path.length > 0 ? path : undefined;
		}

		if (ctx.host === 'other-remote') {
			const { stdout } = await execFileAsync(
				'bash',
				['-lc', `command -v ${shellQuote(name)}`],
				{ timeout: 5_000 },
			);
			const path = stdout.trim();
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
		const path = stdout.trim();
		return path.length > 0 ? path : undefined;
	} catch {
		return undefined;
	}
}

export interface RunLinuxCliOptions {
	timeout?: number;
	maxBuffer?: number;
}

export async function runLinuxCli(
	ctx: LinuxCliContext,
	argv: string[],
	opts?: RunLinuxCliOptions,
	env?: Record<string, string | undefined>,
): Promise<{ stdout: string; stderr: string }> {
	const launch = buildLinuxCliLaunch(ctx, argv, env);
	const spawnOpts: Parameters<typeof execFileAsync>[2] = {
		timeout: opts?.timeout ?? 30_000,
		maxBuffer: opts?.maxBuffer ?? 8 * 1024 * 1024,
		windowsHide: true,
	};
	if (!usesWslCliBridge(ctx) && ctx.linuxCwd) {
		spawnOpts.cwd = ctx.linuxCwd;
	}
	const { stdout, stderr } = await execFileAsync(launch.executable, launch.args, spawnOpts);
	return { stdout: stdout.toString(), stderr: stderr.toString() };
}

export interface SpawnLinuxCliOptions {
	signal?: AbortSignal;
	env?: Record<string, string | undefined>;
}

export function spawnLinuxCli(
	ctx: LinuxCliContext,
	argv: string[],
	opts?: SpawnLinuxCliOptions,
): ChildProcess {
	const launch = buildLinuxCliLaunch(ctx, argv, opts?.env);
	const spawnOpts: SpawnOptions = {
		stdio: ['pipe', 'pipe', 'pipe'],
		windowsHide: true,
		env: { ...process.env, ...opts?.env },
	};
	if (!usesWslCliBridge(ctx) && ctx.linuxCwd) {
		spawnOpts.cwd = ctx.linuxCwd;
	}
	const child = spawn(launch.executable, launch.args, spawnOpts);

	if (opts?.signal) {
		const onAbort = () => {
			child.kill('SIGTERM');
			setTimeout(() => {
				if (!child.killed) {
					child.kill('SIGKILL');
				}
			}, 2_000).unref();
		};
		if (opts.signal.aborted) {
			onAbort();
		} else {
			opts.signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	return child;
}
