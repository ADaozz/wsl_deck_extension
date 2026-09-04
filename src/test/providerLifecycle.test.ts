import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodexProvider } from '../agent/providers/codex/codexProvider';
import { CursorAcpClient } from '../agent/providers/cursor/cursorAcpClient';

suite('provider lifecycle', () => {
	test('Codex reports a non-zero exit even after partial agent text', async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-codex-exit-'));
		const executable = path.join(dir, 'fake-codex');
		fs.writeFileSync(
			executable,
			'#!/bin/sh\nprintf \'%s\\n\' \'{"type":"thread.started","thread_id":"thread-1"}\' \'{"type":"item.completed","item":{"type":"agent_message","text":"partial"}}\'\nexit 7\n',
			{ mode: 0o755 },
		);
		try {
			const provider = new CodexProvider((key, fallback) =>
				key === 'codex.executable' ? executable as typeof fallback : fallback,
			);
			const session = await provider.createSession({ linuxCwd: process.cwd() });
			const events = [];
			for await (const event of provider.sendPrompt(session, 'hello')) {
				events.push(event);
			}
			assert.ok(events.some((event) => event.type === 'agent.message.delta'));
			assert.ok(events.some((event) => event.type === 'session.failed'));
			assert.strictEqual(session.status, 'FAILED');
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('Codex marks the session failed when its executable cannot be resolved', async () => {
		const provider = new CodexProvider((key, fallback) =>
			key === 'codex.executable'
				? '/tmp/wsldeck-command-that-does-not-exist' as typeof fallback
				: fallback,
		);
		const session = await provider.createSession({ linuxCwd: process.cwd() });
		const events = [];
		for await (const event of provider.sendPrompt(session, 'hello')) {
			events.push(event);
		}
		assert.ok(events.some((event) => event.type === 'session.failed'));
		assert.strictEqual(session.status, 'FAILED');
	});

	test('disposing Cursor ACP rejects outstanding RPC requests', async () => {
		const client = new CursorAcpClient();
		await client.start({
			cliCtx: { host: 'local-linux', linuxCwd: process.cwd() },
			argv: [process.execPath, '-e', 'process.stdin.resume()'],
		});
		assert.strictEqual(client.isRunning(), true);
		const pending = client.request('test/hangs');
		await client.dispose();
		await assert.rejects(pending, /client disposed/);
		assert.strictEqual(client.isRunning(), false);
	});
});
