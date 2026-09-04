import * as assert from 'node:assert';
import { filterTrackedChanges, isIgnoredChangePath } from '../change/changePathFilter';
import { parseCodexModelCatalog, codexReasoningLevelsForModel } from '../agent/modelCatalog';

suite('change path filter + codex reasoning catalog', () => {
	test('ignores deck, build, and test cache paths', () => {
		assert.ok(isIgnoredChangePath('.WSLDeck/resumes.json'));
		assert.ok(isIgnoredChangePath('WSLDeckExtension/out/agent/foo.js'));
		assert.ok(isIgnoredChangePath('WSLDeckExtension/.vscode-test/user-data/Cache/Cache_Data/x'));
		assert.ok(isIgnoredChangePath('.artifacts/output.tar.gz'));
		assert.ok(isIgnoredChangePath('.run/App.run.xml'));
		assert.ok(!isIgnoredChangePath('WSLDeckExtension/src/agent/agentSessionManager.ts'));
	});

	test('filterTrackedChanges drops ignored rows', () => {
		const rows = filterTrackedChanges([
			{ path: 'src/a.ts' },
			{ path: 'out/b.js' },
			{ path: '.WSLDeck/x' },
		]);
		assert.deepStrictEqual(rows.map((r) => r.path), ['src/a.ts']);
	});

	test('parseCodexModelCatalog extracts reasoning levels', () => {
		const catalog = parseCodexModelCatalog(
			JSON.stringify({
				models: [
					{
						slug: 'gpt-5.6-sol',
						display_name: 'GPT-5.6 Sol',
						visibility: 'show',
						supported_reasoning_levels: [
							{ effort: 'low', description: 'Low' },
							{ effort: 'high', description: 'High' },
						],
					},
				],
			}),
		);
		assert.strictEqual(catalog.length, 1);
		const levels = codexReasoningLevelsForModel(catalog, 'gpt-5.6-sol');
		assert.deepStrictEqual(levels.map((l) => l.id), ['low', 'high']);
		assert.strictEqual(levels[0]?.label, 'low');
		assert.strictEqual(levels[0]?.description, 'Fast responses with lighter reasoning');
		assert.strictEqual(levels[1]?.description, 'Greater reasoning depth for complex problems');
	});
});
