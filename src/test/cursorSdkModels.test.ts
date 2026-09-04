import * as assert from 'node:assert';
import {
	buildBracketModelId,
	catalogToAgentModels,
	parseSdkModelList,
	reasoningOptionsForModel,
	fastOptionsForModel,
	variantToHyphenFlatId,
	modelIdWithReasoning,
	modelIdWithFast,
} from '../agent/providers/cursor/cursorSdkModels';

suite('Cursor SDK model catalog', () => {
	test('expands variants to hyphen and bracket flat ids', () => {
		const catalog = parseSdkModelList([
			{
				id: 'composer-2.5',
				displayName: 'Composer 2.5',
				parameters: [
					{
						id: 'fast',
						values: [{ value: 'false' }, { value: 'true', displayName: 'Fast' }],
					},
				],
				variants: [
					{
						displayName: 'Composer 2.5',
						params: [{ id: 'fast', value: 'false' }],
						isDefault: true,
					},
					{
						displayName: 'Composer 2.5 Fast',
						params: [{ id: 'fast', value: 'true' }],
					},
				],
			},
		]);
		assert.ok(catalog.byFlatId.has('composer-2.5'));
		assert.ok(catalog.byFlatId.has('composer-2.5-fast'));
		const listed = catalogToAgentModels(catalog);
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0]?.label, 'Composer 2.5');
		assert.strictEqual(listed[0]?.id, 'composer-2.5');
	});

	test('one menu row per base model for codex presets', () => {
		const catalog = parseSdkModelList([
			{
				id: 'gpt-5.3-codex',
				displayName: 'Codex 5.3',
				parameters: [
					{
						id: 'reasoning',
						values: [
							{ value: 'low' },
							{ value: 'high' },
							{ value: 'extra-high' },
						],
					},
					{
						id: 'fast',
						values: [{ value: 'false' }, { value: 'true' }],
					},
				],
				variants: [
					{
						displayName: 'Codex 5.3',
						params: [{ id: 'reasoning', value: 'low' }, { id: 'fast', value: 'true' }],
					},
					{
						displayName: 'Codex 5.3',
						params: [{ id: 'reasoning', value: 'low' }, { id: 'fast', value: 'false' }],
					},
					{
						displayName: 'Codex 5.3',
						params: [{ id: 'reasoning', value: 'high' }, { id: 'fast', value: 'true' }],
						isDefault: true,
					},
					{
						displayName: 'Codex 5.3',
						params: [{ id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'true' }],
					},
				],
			},
		]);
		const listed = catalogToAgentModels(catalog);
		assert.strictEqual(listed.length, 1);
		assert.strictEqual(listed[0]?.id, 'gpt-5.3-codex-high-fast');
		assert.strictEqual(
			reasoningOptionsForModel(catalog, listed[0]!.id).map((o) => o.id).join(','),
			'low,high,extra-high',
		);
		assert.deepStrictEqual(
			fastOptionsForModel(catalog, listed[0]!.id).map((o) => o.id),
			['false', 'true'],
		);
		const withReasoning = modelIdWithReasoning(catalog, listed[0]!.id, 'low');
		assert.strictEqual(withReasoning, 'gpt-5.3-codex-low-fast');
		const withFast = modelIdWithFast(catalog, 'gpt-5.3-codex-low-fast', 'false');
		assert.strictEqual(withFast, 'gpt-5.3-codex-low');
	});

	test('builds bracket override ids', () => {
		assert.strictEqual(
			buildBracketModelId('claude-opus-4-8', [
				{ id: 'effort', value: 'high' },
				{ id: 'fast', value: 'false' },
			]),
			'claude-opus-4-8[effort=high,fast=false]',
		);
	});

	test('hyphen id maps extra-high to xhigh', () => {
		assert.strictEqual(
			variantToHyphenFlatId('gpt-5.3-codex', [
				{ id: 'reasoning', value: 'extra-high' },
				{ id: 'fast', value: 'true' },
			]),
			'gpt-5.3-codex-xhigh-fast',
		);
	});

	test('hyphen id for thinking + effort', () => {
		assert.strictEqual(
			variantToHyphenFlatId('claude-opus-5', [
				{ id: 'thinking', value: 'true' },
				{ id: 'effort', value: 'high' },
			]),
			'claude-opus-5-thinking-high',
		);
	});
});
