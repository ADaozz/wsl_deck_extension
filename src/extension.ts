import * as vscode from 'vscode';
import { createAgentRawLog } from './agent/agentRawLog';
import { AgentSessionManager } from './agent/agentSessionManager';
import {
	createCodexProvider,
	createCursorProvider,
} from './agent/providers/providerFactory';
import { runDoctor } from './doctor/doctor';
import { openWslTerminal, runInWslTerminal } from './terminal/terminalService';
import { registerWslTerminalProfile } from './terminal/wslTerminalProfile';
import { AgentViewProvider } from './ui/agentViewProvider';

function vscodeSettingReader(
	key: string,
	defaultValue: unknown,
): unknown {
	return vscode.workspace.getConfiguration('wsldeck').get(key, defaultValue);
}

export function activate(context: vscode.ExtensionContext): void {
	const doctorOutput = vscode.window.createOutputChannel('WSLDeck');
	const agentOutput = vscode.window.createOutputChannel('WSLDeck Agent');
	context.subscriptions.push(doctorOutput, agentOutput);

	const agentLog = createAgentRawLog({
		appendLine: (line) => agentOutput.appendLine(line),
		show: (preserveFocus) => agentOutput.show(preserveFocus ?? true),
	});

	const sessions = new AgentSessionManager();
	const getSetting = <T>(key: string, defaultValue: T): T =>
		vscodeSettingReader(key, defaultValue) as T;

	sessions.register(createCodexProvider(getSetting, agentLog));
	sessions.register(createCursorProvider(getSetting, agentLog));

	const agentView = new AgentViewProvider(context, sessions);
	context.subscriptions.push(
		vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, agentView, {
			webviewOptions: { retainContextWhenHidden: true },
		}),
	);

	context.subscriptions.push({
		dispose: () => {
			agentView.dispose();
			void sessions.disposeAll();
		},
	});

	registerWslTerminalProfile(context);

	context.subscriptions.push(
		vscode.commands.registerCommand('wsldeck.show', async () => {
			await agentView.reveal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('wsldeck.showAgentLog', () => {
			agentOutput.show(false);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('wsldeck.doctor', async () => {
			doctorOutput.show(true);
			doctorOutput.appendLine('');
			doctorOutput.appendLine('Running WSLDeck Doctor…');
			const report = await runDoctor(sessions);
			doctorOutput.appendLine(report.text);
			await vscode.window.showInformationMessage(
				report.ok
					? 'WSLDeck Doctor: environment looks good.'
					: 'WSLDeck Doctor: some checks failed. See Output.',
			);
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('wsldeck.openWslTerminal', async () => {
			await openWslTerminal();
		}),
	);

	context.subscriptions.push(
		vscode.commands.registerCommand('wsldeck.runInTerminal', async (command?: string) => {
			if (typeof command === 'string') {
				await runInWslTerminal(command);
			}
		}),
	);
}

export function deactivate(): void {
	// no-op
}
