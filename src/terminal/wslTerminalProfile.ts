import * as vscode from 'vscode';
import { getWorkspaceContext } from '../workspace/workspaceContext';
import { buildWslExeArgs } from '../workspace/wslPathResolver';

export const WSL_TERMINAL_PROFILE_ID = 'wsldeck.wslTerminal';

export function createWslTerminalOptions(): vscode.TerminalOptions | vscode.ExtensionTerminalOptions {
	const ctx = getWorkspaceContext();

	if (!ctx.linuxCwd) {
		throw new Error(ctx.error ?? 'Cannot resolve WSL cwd for current workspace');
	}

	const name = 'WSLDeck WSL';

	// Already inside WSL (or native Linux): use default shell + Linux cwd.
	if (ctx.host === 'wsl-remote' || ctx.host === 'local-linux') {
		return {
			name,
			cwd: ctx.linuxCwd,
			iconPath: new vscode.ThemeIcon('terminal-linux'),
		};
	}

	// Windows local host: launch wsl.exe into the mapped Linux path.
	if (ctx.host === 'local-windows') {
		return {
			name,
			shellPath: 'wsl.exe',
			shellArgs: buildWslExeArgs(ctx.linuxCwd, ctx.distro),
			iconPath: new vscode.ThemeIcon('terminal-linux'),
		};
	}

	throw new Error(`WSL terminal is not supported in this environment (${ctx.host})`);
}

export function registerWslTerminalProfile(context: vscode.ExtensionContext): void {
	context.subscriptions.push(
		vscode.window.registerTerminalProfileProvider(WSL_TERMINAL_PROFILE_ID, {
			provideTerminalProfile(): vscode.ProviderResult<vscode.TerminalProfile> {
				try {
					const options = createWslTerminalOptions();
					return new vscode.TerminalProfile(options as vscode.TerminalOptions);
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					void vscode.window.showErrorMessage(`WSLDeck: ${message}`);
					return undefined;
				}
			},
		}),
	);
}
