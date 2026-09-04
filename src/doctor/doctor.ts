import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AgentSessionManager } from '../agent/agentSessionManager';
import {
	formatLinuxCliDetail,
	mergeLinuxCliContext,
	resolveLinuxCommand,
	runLinuxCli,
} from '../workspace/linuxCliBridge';
import { getWorkspaceContext, NO_WORKSPACE_FOLDER_HINT } from '../workspace/workspaceContext';

const execFileAsync = promisify(execFile);

export type CheckStatus = 'ok' | 'warn' | 'fail';

export interface DoctorCheck {
	name: string;
	status: CheckStatus;
	detail: string;
}

export interface DoctorReport {
	ok: boolean;
	checks: DoctorCheck[];
	text: string;
}

async function resolveWslExecutable(): Promise<string | undefined> {
	if (process.platform === 'win32') {
		try {
			const { stdout } = await execFileAsync('where', ['wsl.exe'], {
				timeout: 5_000,
				windowsHide: true,
			});
			const line = stdout.trim().split(/\r?\n/)[0]?.trim();
			return line || 'wsl.exe';
		} catch {
			return undefined;
		}
	}
	return resolveLinuxCommand({ host: 'local-linux' }, 'wsl');
}

async function runVersionViaBridge(
	cliCtx: ReturnType<typeof mergeLinuxCliContext>,
	command: string,
	args: string[],
): Promise<string | undefined> {
	const path = await resolveLinuxCommand(cliCtx, command);
	if (!path) {
		return undefined;
	}
	try {
		const { stdout, stderr } = await runLinuxCli(cliCtx, [command, ...args], {
			timeout: 5_000,
		});
		const text = (stdout || stderr).trim().split('\n')[0] ?? '';
		return text || undefined;
	} catch {
		return undefined;
	}
}

function mark(status: CheckStatus): string {
	switch (status) {
		case 'ok':
			return '✓';
		case 'warn':
			return '!';
		case 'fail':
			return '✗';
	}
}

function formatReport(checks: DoctorCheck[]): string {
	const width = Math.max(...checks.map((c) => c.name.length), 10);
	const lines = ['WSLDeck Environment', ''];
	for (const check of checks) {
		const pad = ' '.repeat(width - check.name.length + 2);
		const detail = check.detail ? `  ${check.detail}` : '';
		lines.push(`${check.name}${pad}${mark(check.status)}${detail}`);
	}
	return lines.join('\n');
}

export async function runDoctor(sessions?: AgentSessionManager): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const ctx = getWorkspaceContext();
	const cliCtx = mergeLinuxCliContext(ctx);

	const folders = vscode.workspace.workspaceFolders;
	if (folders && folders.length > 0) {
		checks.push({
			name: 'Workspace',
			status: 'ok',
			detail: folders.map((f) => f.uri.fsPath).join(', '),
		});
	} else {
		checks.push({
			name: 'Workspace',
			status: 'fail',
			detail: NO_WORKSPACE_FOLDER_HINT,
		});
	}

	if (cliCtx.linuxCwd || cliCtx.host !== 'local-windows') {
		const gitPath = await resolveLinuxCommand(cliCtx, 'git');
		if (gitPath) {
			const version = await runVersionViaBridge(cliCtx, 'git', ['--version']);
			checks.push({
				name: 'Git',
				status: 'ok',
				detail: version?.replace(/^git version\s+/i, '') ?? formatLinuxCliDetail(gitPath, cliCtx),
			});
		} else {
			checks.push({ name: 'Git', status: 'fail', detail: 'not found in Linux environment' });
		}
	} else {
		checks.push({
			name: 'Git',
			status: 'warn',
			detail: '打开工作区后在 WSL 内检测',
		});
	}

	const wslAlt = await resolveWslExecutable();
	if (wslAlt) {
		let distro = 'available';
		try {
			const { stdout } = await execFileAsync(wslAlt, ['-l', '-q'], {
				timeout: 5_000,
				windowsHide: true,
			});
			const first = stdout
				.replace(/\0/g, '')
				.split(/\r?\n/)
				.map((s) => s.trim())
				.find((s) => s.length > 0);
			if (first) {
				distro = first;
			}
		} catch {
			// listing may fail inside pure Linux; still mark WSL binary present
		}
		checks.push({ name: 'WSL', status: 'ok', detail: distro });
	} else if (process.platform === 'linux') {
		checks.push({
			name: 'WSL',
			status: 'warn',
			detail: 'Linux host (no wsl.exe; OK for Ubuntu-side build)',
		});
	} else {
		checks.push({ name: 'WSL', status: 'fail', detail: 'wsl.exe not found' });
	}

	const config = vscode.workspace.getConfiguration('wsldeck');

	if (sessions) {
		for (const provider of sessions.listProviders()) {
			const availability = await provider.detect();
			checks.push({
				name: provider.displayName,
				status: availability.cliPresent === false ? 'warn' : availability.available ? 'ok' : 'fail',
				detail: availability.detail,
			});
		}
	} else if (cliCtx.linuxCwd || cliCtx.host !== 'local-windows') {
		const codexExe = config.get<string>('codex.executable', 'codex');
		const cursorExe = config.get<string>('cursor.executable', 'agent');

		const codexPath = await resolveLinuxCommand(cliCtx, codexExe);
		checks.push(
			codexPath
				? { name: 'Codex CLI', status: 'ok', detail: formatLinuxCliDetail(codexPath, cliCtx) }
				: { name: 'Codex CLI', status: 'warn', detail: `"${codexExe}" not found in Linux environment` },
		);

		const cursorPath = await resolveLinuxCommand(cliCtx, cursorExe);
		checks.push(
			cursorPath
				? { name: 'Cursor CLI', status: 'ok', detail: formatLinuxCliDetail(cursorPath, cliCtx) }
				: { name: 'Cursor CLI', status: 'warn', detail: `"${cursorExe}" not found in Linux environment` },
		);
	} else {
		checks.push({
			name: 'Codex CLI',
			status: 'warn',
			detail: '打开工作区后在 WSL 内检测',
		});
		checks.push({
			name: 'Cursor CLI',
			status: 'warn',
			detail: '打开工作区后在 WSL 内检测',
		});
	}

	if (ctx.linuxCwd) {
		const hostLabel = ctx.host;
		const mapped =
			ctx.workspaceFsPath && ctx.workspaceFsPath !== ctx.linuxCwd
				? `${ctx.workspaceFsPath} → ${ctx.linuxCwd}`
				: ctx.linuxCwd;
		checks.push({
			name: 'WSL cwd',
			status: 'ok',
			detail: `${mapped} (${hostLabel})`,
		});
	} else {
		checks.push({
			name: 'WSL cwd',
			status: 'fail',
			detail: ctx.error ?? 'unavailable',
		});
	}

	const ok = checks.every((c) => c.status !== 'fail');
	return {
		ok,
		checks,
		text: formatReport(checks),
	};
}
