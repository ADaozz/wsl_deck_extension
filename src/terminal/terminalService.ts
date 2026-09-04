import * as vscode from 'vscode';
import { createWslTerminalOptions } from './wslTerminalProfile';
import { getWorkspaceContext } from '../workspace/workspaceContext';

const TERMINAL_NAME = 'WSLDeck WSL';

export async function openWslTerminal(): Promise<vscode.Terminal | undefined> {
	const ctx = getWorkspaceContext();
	if (!ctx.linuxCwd) {
		await vscode.window.showErrorMessage(
			`WSLDeck: ${ctx.error ?? 'Open a folder before starting a WSL terminal.'}`,
		);
		return undefined;
	}

	try {
		const existing = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME);
		if (existing) {
			existing.show(true);
			return existing;
		}
		return createWslDeckTerminal();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`WSLDeck: ${message}`);
		return undefined;
	}
}

function createWslDeckTerminal(): vscode.Terminal {
	const options = createWslTerminalOptions();
	const terminal = vscode.window.createTerminal(options as vscode.TerminalOptions);
	terminal.show(true);
	return terminal;
}

/**
 * Always open a **new** WSLDeck WSL terminal in the workspace cwd, then run the command.
 */
export async function runInWslTerminal(command: string): Promise<void> {
	const trimmed = command.trim();
	if (!trimmed) {
		return;
	}
	const ctx = getWorkspaceContext();
	if (!ctx.linuxCwd) {
		await vscode.window.showErrorMessage(
			`WSLDeck: ${ctx.error ?? 'Open a folder before running commands.'}`,
		);
		return;
	}

	try {
		const terminal = createWslDeckTerminal();
		// Brief delay so the shell can finish starting before sendText.
		await sleep(400);
		terminal.sendText(trimmed, true);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		await vscode.window.showErrorMessage(`WSLDeck: ${message}`);
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
