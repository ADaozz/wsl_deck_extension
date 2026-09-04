import * as assert from 'node:assert';
import * as vscode from 'vscode';
import { runDoctor } from '../doctor/doctor';

suite('WSLDeck M0/M1', () => {
	test('extension activates and registers commands', async () => {
		const ext = vscode.extensions.getExtension('wsldeck.wsldeck-extension');
		assert.ok(ext, 'extension should be present');
		await ext.activate();
		assert.strictEqual(ext.isActive, true);

		const commands = await vscode.commands.getCommands(true);
		assert.ok(commands.includes('wsldeck.show'));
		assert.ok(commands.includes('wsldeck.doctor'));
		assert.ok(commands.includes('wsldeck.openWslTerminal'));
		assert.ok(commands.includes('wsldeck.show'));
	});

	test('doctor returns a structured report', async () => {
		const report = await runDoctor();
		assert.ok(report.text.includes('WSLDeck Environment'));
		assert.ok(report.checks.some((c) => c.name === 'Workspace'));
		assert.ok(report.checks.some((c) => c.name === 'Git'));
		assert.ok(report.checks.some((c) => c.name === 'WSL'));
		assert.ok(report.checks.some((c) => c.name === 'Codex CLI' || c.name === 'Codex'));
		assert.ok(report.checks.some((c) => c.name === 'Cursor CLI' || c.name === 'Cursor'));
		assert.ok(report.checks.some((c) => c.name === 'WSL cwd'));
	});
});
