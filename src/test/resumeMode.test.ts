import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	filterAcpModeIds,
	formatResumeUpdatedAt,
	readResumeIndex,
	upsertResumeEntry,
} from '../state/workspaceDeckStore';
import {
	CURSOR_REASONING_FALLBACK,
	parseAcpModeOptionIds,
	parseAcpReasoningOptions,
	parseModeSlash,
} from '../agent/sessionConfigSlash';
import { parseModelSlash } from '../agent/modelCatalog';

suite('resume index + mode/reasoning slash', () => {
	test('upsertResumeEntry sorts by updatedAt desc and truncates', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-resume-'));
		try {
			upsertResumeEntry(root, 'cursor', {
				sessionId: 'a',
				providerId: 'cursor',
				modelId: 'auto',
				title: 'old',
				updatedAt: 100,
			});
			upsertResumeEntry(root, 'cursor', {
				sessionId: 'b',
				providerId: 'cursor',
				modelId: 'auto',
				title: 'new',
				updatedAt: 200,
			});
			upsertResumeEntry(root, 'cursor', {
				sessionId: 'a',
				providerId: 'cursor',
				modelId: 'auto',
				title: 'old-updated',
				updatedAt: 300,
			});
			const lane = readResumeIndex(root).byProvider.cursor;
			assert.ok(lane);
			assert.strictEqual(lane!.sessions[0].sessionId, 'a');
			assert.strictEqual(lane!.sessions[0].title, 'old-updated');
			assert.strictEqual(lane!.sessions[1].sessionId, 'b');
			assert.ok(formatResumeUpdatedAt(Date.now()).includes('just now'));
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('filterAcpModeIds drops ask', () => {
		assert.deepStrictEqual(filterAcpModeIds(['agent', 'plan', 'ask']), ['agent', 'plan']);
		assert.deepStrictEqual(filterAcpModeIds(['ask']), ['agent', 'plan']);
	});

	test('parseModeSlash and model slash', () => {
		assert.deepStrictEqual(parseModeSlash('/mode'), { kind: 'list' });
		assert.deepStrictEqual(parseModeSlash('/mode plan'), { kind: 'set', value: 'plan' });
		assert.deepStrictEqual(parseModelSlash('/model'), { kind: 'list' });
	});

	test('parseAcpReasoningOptions from configOptions', () => {
		const opts = parseAcpReasoningOptions([
			{
				id: 'reasoning',
				category: 'reasoning',
				options: [
					{ value: 'low', name: 'Low' },
					{ value: 'high', name: 'High' },
				],
			},
		]);
		assert.deepStrictEqual(opts.map((o) => o.id), ['low', 'high']);
		assert.ok(CURSOR_REASONING_FALLBACK.length >= 3);
	});

	test('parseAcpModeOptionIds reads modes + configOptions', () => {
		const ids = parseAcpModeOptionIds(
			[
				{
					id: 'mode',
					category: 'mode',
					options: [
						{ value: 'agent' },
						{ value: 'plan' },
						{ value: 'ask' },
					],
				},
			],
			{ availableModes: [{ id: 'agent' }, { id: 'plan' }] },
		);
		assert.ok(ids.includes('agent'));
		assert.ok(ids.includes('plan'));
		assert.ok(ids.includes('ask'));
		assert.deepStrictEqual(filterAcpModeIds(ids), ['agent', 'plan']);
	});
});
