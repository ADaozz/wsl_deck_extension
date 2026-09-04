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
import {
	agentEnvForLog,
	invalidateLinuxAgentEnvCache,
	probeWslHostGatewayIp,
	resolveLinuxAgentEnv,
} from '../workspace/linuxAgentEnvironment';
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
	linuxEnv: Record<string, string>,
): Promise<string | undefined> {
	const path = await resolveLinuxCommand(cliCtx, command, linuxEnv);
	if (!path) {
		return undefined;
	}
	try {
		const { stdout, stderr } = await runLinuxCli(cliCtx, [path, ...args], {
			timeout: 5_000,
			linuxEnv,
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

function proxyConfigured(env: Record<string, string>): boolean {
	return Boolean(
		env.HTTPS_PROXY?.trim() ||
			env.https_proxy?.trim() ||
			env.HTTP_PROXY?.trim() ||
			env.http_proxy?.trim() ||
			env.ALL_PROXY?.trim() ||
			env.all_proxy?.trim(),
	);
}

function proxyUsesLoopback(env: Record<string, string>): boolean {
	const keys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
	return keys.some((key) => {
		const value = env[key]?.trim();
		return Boolean(value && /(?:127\.0\.0\.1|localhost)/i.test(value));
	});
}

async function formatAgentEnvDetail(
	cliCtx: ReturnType<typeof mergeLinuxCliContext>,
	linuxEnv: Record<string, string>,
): Promise<{ detail: string; status: CheckStatus }> {
	const parts: string[] = [];
	if (cliCtx.host === 'local-windows' && cliCtx.linuxCwd) {
		const wslHost = await probeWslHostGatewayIp(cliCtx);
		if (wslHost) {
			parts.push(`WSL host=${wslHost}`);
		}
	}
	parts.push(agentEnvForLog(linuxEnv));
	if (cliCtx.host === 'local-windows' && proxyUsesLoopback(linuxEnv)) {
		parts.push('proxy 含 localhost，请改用 WSL host IP + 端口');
	}
	const proxy = proxyConfigured(linuxEnv);
	let status: CheckStatus = proxy || linuxEnv.PATH ? 'ok' : 'warn';
	if (cliCtx.host === 'local-windows' && proxyUsesLoopback(linuxEnv)) {
		status = 'warn';
	}
	return { detail: parts.join(', '), status };
}

export async function runDoctor(sessions?: AgentSessionManager): Promise<DoctorReport> {
	const checks: DoctorCheck[] = [];
	const ctx = getWorkspaceContext();
	const cliCtx = mergeLinuxCliContext(ctx);

	invalidateLinuxAgentEnvCache(cliCtx.distro);
	let linuxEnv: Record<string, string> = {};
	if (cliCtx.linuxCwd || cliCtx.host !== 'local-windows') {
		try {
			linuxEnv = await resolveLinuxAgentEnv(cliCtx);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			checks.push({
				name: 'Agent env',
				status: 'fail',
				detail: message,
			});
		}
	}

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

	if (Object.keys(linuxEnv).length > 0) {
		const { detail, status } = await formatAgentEnvDetail(cliCtx, linuxEnv);
		checks.push({
			name: 'Agent env',
			status,
			detail,
		});
	} else if (cliCtx.host === 'local-windows' && !cliCtx.linuxCwd) {
		checks.push({
			name: 'Agent env',
			status: 'warn',
			detail: '打开工作区后在 WSL login shell 内探测',
		});
	}

	if (cliCtx.linuxCwd || cliCtx.host !== 'local-windows') {
		const gitPath = await resolveLinuxCommand(cliCtx, 'git', linuxEnv);
		if (gitPath) {
			const version = await runVersionViaBridge(cliCtx, 'git', ['--version'], linuxEnv);
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

		const codexPath = await resolveLinuxCommand(cliCtx, codexExe, linuxEnv);
		checks.push(
			codexPath
				? { name: 'Codex CLI', status: 'ok', detail: formatLinuxCliDetail(codexPath, cliCtx) }
				: { name: 'Codex CLI', status: 'warn', detail: `"${codexExe}" not found in Linux environment` },
		);

		const cursorPath = await resolveLinuxCommand(cliCtx, cursorExe, linuxEnv);
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
