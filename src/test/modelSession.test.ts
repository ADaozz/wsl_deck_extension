import * as assert from 'node:assert';
import {
	modelsFromConfigFallback,
	parseCodexDebugModelsJson,
	parseModelSlash,
	pickModelId,
} from '../agent/modelCatalog';
import {
	findResumeSession,
	isNoteworthySession,
	isPersistedAgentSession,
	migrateToWorkspaceSessions,
	parseResumeSlash,
	sanitizeMessagesForPersist,
	sessionTitleFromMessages,
	upsertProviderSession,
} from '../state/sessionStore';

suite('model catalog + session persist', () => {
	test('settings fallback is last resort, not a fixed enum', () => {
		const models = modelsFromConfigFallback((section) => {
			if (section === 'cursor.models') {
				return ['Auto', 'composer-2'];
			}
			return undefined;
		}, 'cursor');
		assert.deepStrictEqual(
			models.map((m) => m.id),
			['Auto', 'composer-2'],
		);
	});

	test('parses codex debug models JSON and skips hide', () => {
		const models = parseCodexDebugModelsJson(
			JSON.stringify({
				models: [
					{ slug: 'gpt-5.6-sol', display_name: 'GPT-5.6-Sol', visibility: 'list' },
					{ slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
					{ slug: 'gpt-5.5', display_name: 'GPT-5.5', visibility: 'list' },
				],
			}),
		);
		assert.deepStrictEqual(models, [
			{ id: 'gpt-5.6-sol', label: 'GPT-5.6-Sol' },
			{ id: 'gpt-5.5', label: 'GPT-5.5' },
		]);
	});

	test('parseModelSlash lists or sets', () => {
		assert.deepStrictEqual(parseModelSlash('/model'), { kind: 'list' });
		assert.deepStrictEqual(parseModelSlash('/model gpt-5'), {
			kind: 'set',
			modelId: 'gpt-5',
		});
		assert.strictEqual(parseModelSlash('hello'), undefined);
	});

	test('pickModelId falls back safely', () => {
		assert.strictEqual(pickModelId([{ id: 'a' }, { id: 'b' }], 'b'), 'b');
		assert.strictEqual(pickModelId([{ id: 'a' }], 'missing'), 'a');
	});

	test('persisted session round-trip shape', () => {
		const messages = sanitizeMessagesForPersist([
			{ id: '1', role: 'user', text: 'hi', streaming: true },
			{
				id: '2',
				role: 'agent',
				text: 'hello',
				streaming: false,
				thought: 'Let me think…',
				thoughtStreaming: true,
			},
		]);
		assert.strictEqual(messages[0].streaming, undefined);
		assert.strictEqual(messages[1].thought, 'Let me think…');
		assert.strictEqual(messages[1].thoughtStreaming, undefined);
		const payload = {
			version: 1 as const,
			sessionId: 's1',
			providerId: 'codex',
			modelId: 'default',
			messages,
			updatedAt: 1,
		};
		assert.strictEqual(isPersistedAgentSession(payload), true);
		assert.strictEqual(isPersistedAgentSession({}), false);
	});

	test('migrates v1/v2 into v3 multi-resume store', () => {
		const v1 = {
			version: 1 as const,
			sessionId: 's1',
			providerId: 'codex',
			modelId: 'default',
			messages: [{ id: '1', role: 'user' as const, text: 'hi' }],
			updatedAt: 1,
		};
		const v3 = migrateToWorkspaceSessions(v1, 'cursor');
		assert.ok(v3);
		assert.strictEqual(v3.version, 3);
		assert.strictEqual(v3.selectedProviderId, 'codex');
		assert.strictEqual(v3.byProvider.codex.activeSessionId, 's1');
		assert.strictEqual(v3.byProvider.codex.sessions.length, 1);

		const v2 = {
			version: 2 as const,
			selectedProviderId: 'cursor',
			byProvider: {
				cursor: {
					version: 1 as const,
					sessionId: 'c1',
					providerId: 'cursor',
					modelId: 'auto',
					messages: [],
					updatedAt: 2,
				},
			},
			updatedAt: 2,
		};
		const fromV2 = migrateToWorkspaceSessions(v2, 'codex');
		assert.ok(fromV2);
		assert.strictEqual(fromV2.version, 3);
		assert.strictEqual(fromV2.byProvider.cursor.activeSessionId, 'c1');
	});

	test('upsert + find resume supports new/switch', () => {
		const a = {
			version: 1 as const,
			sessionId: 's1',
			providerSessionId: 'thread-1',
			providerId: 'codex',
			modelId: 'default',
			messages: [{ id: '1', role: 'user' as const, text: 'fix the bug in auth' }],
			updatedAt: 10,
		};
		const b = {
			version: 1 as const,
			sessionId: 's2',
			providerSessionId: 'thread-2',
			providerId: 'codex',
			modelId: 'default',
			messages: [{ id: '2', role: 'user' as const, text: 'write tests' }],
			updatedAt: 20,
		};
		assert.strictEqual(isNoteworthySession(a), true);
		let lane = upsertProviderSession({ activeSessionId: a.sessionId, sessions: [] }, a);
		lane = upsertProviderSession(lane, b);
		assert.strictEqual(lane.activeSessionId, 's2');
		assert.strictEqual(lane.sessions.length, 2);
		assert.strictEqual(findResumeSession(lane.sessions, 'thread-1')?.sessionId, 's1');
		assert.strictEqual(findResumeSession(lane.sessions, '1')?.sessionId, 's2');
		assert.ok(findResumeSession(lane.sessions, 'auth')?.sessionId === 's1');
		assert.deepStrictEqual(parseResumeSlash('/resume'), { kind: 'list' });
		assert.deepStrictEqual(parseResumeSlash('/resume thread-2'), {
			kind: 'set',
			query: 'thread-2',
		});
		assert.strictEqual(sessionTitleFromMessages(a.messages), 'fix the bug in auth');
	});
});
