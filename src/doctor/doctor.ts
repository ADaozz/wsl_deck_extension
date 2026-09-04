import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import type { AgentSessionManager } from '../agent/agentSessionManager';
import { getWorkspaceContext } from '../workspace/workspaceContext';

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

async function which(command: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('bash', ['-lc', `command -v ${shellQuote(command)}`], {
			timeout: 5_000,
		});
		const path = stdout.trim();
		return path.length > 0 ? path : undefined;
	} catch {
		return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

async function runVersion(command: string, args: string[]): Promise<string | undefined> {
	try {
		const { stdout, stderr } = await execFileAsync(command, args, { timeout: 5_000 });
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
			detail: 'No folder open',
		});
	}

	const gitPath = await which('git');
	if (gitPath) {
		const version = await runVersion('git', ['--version']);
		checks.push({
			name: 'Git',
			status: 'ok',
			detail: version?.replace(/^git version\s+/i, '') ?? gitPath,
		});
	} else {
		checks.push({ name: 'Git', status: 'fail', detail: 'not found' });
	}

	const wslPath = await which('wsl.exe');
	const wslAlt = wslPath ?? (await which('wsl'));
	if (wslAlt) {
		let distro = 'available';
		try {
			const { stdout } = await execFileAsync(wslAlt, ['-l', '-q'], { timeout: 5_000 });
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
	} else {
		const codexExe = config.get<string>('codex.executable', 'codex');
		const cursorExe = config.get<string>('cursor.executable', 'agent');

		const codexPath = await which(codexExe);
		checks.push(
			codexPath
				? { name: 'Codex CLI', status: 'ok', detail: codexPath }
				: { name: 'Codex CLI', status: 'warn', detail: `"${codexExe}" not found` },
		);

		const cursorPath = await which(cursorExe);
		checks.push(
			cursorPath
				? { name: 'Cursor CLI', status: 'ok', detail: cursorPath }
				: { name: 'Cursor CLI', status: 'warn', detail: `"${cursorExe}" not found` },
		);
	}

	const ctx = getWorkspaceContext();
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
