import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildWslExeArgs } from '../workspace/wslPathResolver';
import type { SessionBaseline } from './sessionBaseline';

const execFileAsync = promisify(execFile);
const WSL_EXECUTABLE = process.platform === 'win32' ? 'wsl.exe' : 'wsl';

async function runNative(
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

export async function runWslCommand(
	linuxCwd: string,
	argv: string[],
	distro?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	if (process.platform !== 'win32') {
		return runNative(linuxCwd, argv[0], argv.slice(1));
	}
	if (!argv[0]) {
		return { stdout: '', stderr: 'empty argv', code: 1 };
	}
	const wslArgs = [...buildWslExeArgs(linuxCwd, distro), '--', ...argv];
	try {
		const { stdout, stderr } = await execFileAsync(WSL_EXECUTABLE, wslArgs, {
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

export async function runWslGit(
	linuxCwd: string,
	args: string[],
	distro?: string,
): Promise<{ stdout: string; stderr: string; code: number }> {
	return runWslCommand(linuxCwd, ['git', ...args], distro);
}

function gitCwd(baseline: SessionBaseline): string {
	return baseline.gitLinuxCwd ?? baseline.mainLinuxCwd ?? baseline.mainCwd;
}

export async function runGitForBaseline(
	baseline: SessionBaseline,
	args: string[],
): Promise<{ stdout: string; stderr: string; code: number }> {
	const cwd = gitCwd(baseline);
	if (baseline.useWslGit && baseline.mainLinuxCwd) {
		return runWslGit(cwd, args, baseline.wslDistro);
	}
	return runNative(cwd, 'git', args);
}

export async function isGitRepoAt(mainCwd: string): Promise<boolean> {
	const result = await runNative(mainCwd, 'git', ['rev-parse', '--is-inside-work-tree']);
	return result.code === 0 && result.stdout.trim() === 'true';
}

export async function isGitRepoWsl(linuxCwd: string, distro?: string): Promise<boolean> {
	const result = await runWslGit(linuxCwd, ['rev-parse', '--is-inside-work-tree'], distro);
	return result.code === 0 && result.stdout.trim() === 'true';
}

export async function gitHeadAt(mainCwd: string): Promise<string | undefined> {
	const result = await runNative(mainCwd, 'git', ['rev-parse', 'HEAD']);
	if (result.code !== 0) {
		return undefined;
	}
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : undefined;
}

export async function gitHeadWsl(linuxCwd: string, distro?: string): Promise<string | undefined> {
	const result = await runWslGit(linuxCwd, ['rev-parse', 'HEAD'], distro);
	if (result.code !== 0) {
		return undefined;
	}
	const sha = result.stdout.trim();
	return sha.length > 0 ? sha : undefined;
}

export async function gitShowFileForBaseline(
	baseline: SessionBaseline,
	ref: string,
	relativePath: string,
): Promise<string | undefined> {
	const posix = relativePath.replace(/\\/g, '/');
	const result = await runGitForBaseline(baseline, ['show', `${ref}:${posix}`]);
	if (result.code !== 0) {
		return undefined;
	}
	return result.stdout;
}
