import * as vscode from 'vscode';
import { distroFromRemoteAuthority, resolveToWslPath } from './wslPathResolver';

export type ExtensionHostKind = 'local-windows' | 'local-linux' | 'wsl-remote' | 'other-remote';

export interface WorkspaceContext {
	host: ExtensionHostKind;
	/** First workspace folder fsPath, if any */
	workspaceFsPath?: string;
	/** Linux path to use as WSL cwd */
	linuxCwd?: string;
	/** Preferred / detected WSL distro */
	distro?: string;
	pathKind?: 'linux' | 'windows' | 'unc-wsl';
	error?: string;
}

export function detectExtensionHost(): ExtensionHostKind {
	const remoteName = vscode.env.remoteName;
	if (remoteName === 'wsl') {
		return 'wsl-remote';
	}
	if (remoteName) {
		return 'other-remote';
	}
	if (process.platform === 'win32') {
		return 'local-windows';
	}
	if (process.platform === 'linux') {
		return 'local-linux';
	}
	return 'other-remote';
}

export function getPreferredDistro(): string | undefined {
	const configured = vscode.workspace
		.getConfiguration('wsldeck')
		.get<string>('wsl.distribution', '')
		.trim();
	if (configured) {
		return configured;
	}

	const folder = vscode.workspace.workspaceFolders?.[0];
	if (folder?.uri.scheme === 'vscode-remote') {
		return distroFromRemoteAuthority(folder.uri.authority);
	}

	return undefined;
}

export function getWorkspaceContext(): WorkspaceContext {
	const host = detectExtensionHost();
	const folder = vscode.workspace.workspaceFolders?.[0];
	const distro = getPreferredDistro();

	if (!folder) {
		return {
			host,
			distro,
			error: 'No folder open',
		};
	}

	const workspaceFsPath = folder.uri.fsPath;
	const resolved = resolveToWslPath(workspaceFsPath);
	if (!resolved.ok) {
		return {
			host,
			workspaceFsPath,
			distro,
			error: resolved.reason,
		};
	}

	return {
		host,
		workspaceFsPath,
		linuxCwd: resolved.linuxPath,
		distro,
		pathKind: resolved.kind,
	};
}
