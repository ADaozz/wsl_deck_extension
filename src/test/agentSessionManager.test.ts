import * as assert from 'node:assert';
import type { AgentEvent } from '../agent/agentEvents';
import type { AgentProvider } from '../agent/agentProvider';
import { createAgentSession, type AgentSession } from '../agent/agentSession';
import { AgentSessionManager } from '../agent/agentSessionManager';

function mockProvider(id: string): AgentProvider {
	return {
		id,
		displayName: id,
		async detect() {
			return { available: true, detail: 'mock', cliPresent: false };
		},
		async listModels() {
			return [{ id: 'default', label: 'default' }];
		},
		async createSession(context) {
			return createAgentSession({
				id: context.sessionId ?? `${id}-${Date.now()}`,
				providerId: id,
				modelId: context.modelId,
			});
		},
		async *sendPrompt(session: AgentSession, _prompt: string): AsyncIterable<AgentEvent> {
			yield {
				type: 'agent.message.completed',
				sessionId: session.id,
				timestamp: Date.now(),
				text: 'ok',
			};
			yield {
				type: 'turn.completed',
				sessionId: session.id,
				timestamp: Date.now(),
			};
		},
		async cancel(session) {
			session.status = 'STOPPED';
		},
		async dispose(session) {
			session.status = 'CLOSED';
		},
	};
}

suite('AgentSessionManager per-provider sessions', () => {
	test('codex and cursor keep independent sessions (no shared process)', async () => {
		const manager = new AgentSessionManager();
		manager.register(mockProvider('codex'));
		manager.register(mockProvider('cursor'));

		const codex = await manager.ensureSession('codex', { modelId: 'default' });
		const cursor = await manager.ensureSession('cursor', { modelId: 'Auto' });
		assert.notStrictEqual(codex.id, cursor.id);
		assert.strictEqual(manager.getSession('codex')?.id, codex.id);
		assert.strictEqual(manager.getSession('cursor')?.id, cursor.id);

		// Switching focus must not dispose the other agent
		manager.focus('codex');
		assert.strictEqual(manager.getSession('cursor')?.status, 'READY');

		await manager.startNewSession('codex', { modelId: 'default' });
		assert.ok(manager.getSession('codex'));
		assert.strictEqual(manager.getSession('cursor')?.id, cursor.id);

		const replaced = createAgentSession({
			id: 'resume-1',
			providerId: 'codex',
			providerSessionId: 'thread-abc',
			modelId: 'default',
		});
		await manager.replaceSession('codex', replaced);
		assert.strictEqual(manager.getSession('codex')?.id, 'resume-1');
		assert.strictEqual(manager.getSession('codex')?.providerSessionId, 'thread-abc');
		assert.strictEqual(manager.getSession('cursor')?.id, cursor.id);

		await manager.disposeAll();
		assert.strictEqual(manager.getSession('codex'), undefined);
		assert.strictEqual(manager.getSession('cursor'), undefined);
	});

	test('ensureSession honors stable sessionId for baseline alignment', async () => {
		const manager = new AgentSessionManager();
		manager.register(mockProvider('codex'));
		const session = await manager.ensureSession('codex', {
			sessionId: 'session-fixed-1',
			modelId: 'default',
		});
		assert.strictEqual(session.id, 'session-fixed-1');
		const again = await manager.ensureSession('codex', {
			sessionId: 'session-fixed-1',
			modelId: 'default',
		});
		assert.strictEqual(again.id, 'session-fixed-1');
	});

	test('concurrent ensureSession calls share one provider creation', async () => {
		const manager = new AgentSessionManager();
		let creates = 0;
		const provider = mockProvider('cursor');
		provider.createSession = async (context) => {
			creates += 1;
			await new Promise<void>((resolve) => setTimeout(resolve, 10));
			return createAgentSession({
				id: context.sessionId ?? 'cursor-shared',
				providerId: 'cursor',
			});
		};
		manager.register(provider);

		const [first, second] = await Promise.all([
			manager.ensureSession('cursor', { sessionId: 'cursor-shared' }),
			manager.ensureSession('cursor', { sessionId: 'cursor-shared' }),
		]);
		assert.strictEqual(creates, 1);
		assert.strictEqual(first, second);
	});

	test('rejects concurrent prompts for the same provider', async () => {
		const manager = new AgentSessionManager();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const provider = mockProvider('codex');
		provider.sendPrompt = async function* (session): AsyncIterable<AgentEvent> {
			await gate;
			yield {
				type: 'turn.completed',
				sessionId: session.id,
				timestamp: Date.now(),
			};
		};
		manager.register(provider);
		await manager.ensureSession('codex');

		const first = manager.sendPrompt('first', { providerId: 'codex' })[Symbol.asyncIterator]();
		const firstNext = first.next();
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
		const second = manager.sendPrompt('second', { providerId: 'codex' })[Symbol.asyncIterator]();
		await assert.rejects(second.next(), /already running/);
		release();
		await firstNext;
	});
});
