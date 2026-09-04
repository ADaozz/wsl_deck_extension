import { homedir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

export interface SpawnCodexExecOptions {
	executable: string;
	args: string[];
	cwd?: string;
	env?: NodeJS.ProcessEnv;
	signal?: AbortSignal;
	onStdoutLine: (line: string) => void;
	onStderrLine?: (line: string) => void;
}

export async function runCodexExec(options: SpawnCodexExecOptions): Promise<number> {
	const child = spawn(options.executable, options.args, {
		cwd: options.cwd,
		env: { ...process.env, HOME: homedir(), ...options.env },
		stdio: ['pipe', 'pipe', 'pipe'],
	});
	child.stdin.end();

	const onAbort = () => {
		child.kill('SIGTERM');
		setTimeout(() => {
			if (!child.killed) {
				child.kill('SIGKILL');
			}
		}, 2_000).unref();
	};
	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener('abort', onAbort, { once: true });
		}
	}

	const out = createInterface({ input: child.stdout });
	out.on('line', (line) => options.onStdoutLine(line));

	const err = createInterface({ input: child.stderr });
	err.on('line', (line) => options.onStderrLine?.(line));

	return await new Promise<number>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code) => resolve(code ?? 1));
	});
}

export function buildCodexExecArgs(params: {
	prompt: string;
	modelId?: string;
	reasoningId?: string;
	cwd?: string;
	resumeId?: string;
}): string[] {
	const args: string[] = ['exec'];
	// Global `codex exec` flags must precede subcommands like `resume`.
	args.push('--json');
	if (params.modelId && params.modelId !== 'default') {
		args.push('-m', params.modelId);
	}
	if (params.reasoningId) {
		args.push('-c', `model_reasoning_effort="${params.reasoningId}"`);
	}
	if (params.cwd) {
		args.push('-C', params.cwd);
	}
	args.push('--skip-git-repo-check');
	args.push('--approve-for-me');
	if (params.resumeId) {
		args.push('resume', params.resumeId);
	}
	args.push(params.prompt);
	return args;
}
