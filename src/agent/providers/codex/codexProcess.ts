import { createInterface } from 'node:readline';
import { spawnLinuxCli, type LinuxCliContext } from '../../../workspace/linuxCliBridge';

export interface SpawnCodexExecOptions {
	cliCtx: LinuxCliContext;
	argv: string[];
	signal?: AbortSignal;
	onStdoutLine: (line: string) => void;
	onStderrLine?: (line: string) => void;
}

export async function runCodexExec(options: SpawnCodexExecOptions): Promise<number> {
	const child = spawnLinuxCli(options.cliCtx, options.argv, { signal: options.signal });
	child.stdin?.end();

	const out = createInterface({ input: child.stdout! });
	out.on('line', (line) => options.onStdoutLine(line));

	const err = createInterface({ input: child.stderr! });
	err.on('line', (line) => options.onStderrLine?.(line));

	return await new Promise<number>((resolve, reject) => {
		child.on('error', reject);
		child.on('close', (code: number | null) => resolve(code ?? 1));
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
