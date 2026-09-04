import * as assert from 'node:assert';
import { isBashFenceLang, isRunnableCommand } from '../ui/runCommandHeuristic';

suite('markdown run commands', () => {
	test('inline `` heuristic stays disabled', () => {
		assert.strictEqual(isRunnableCommand('python3 dp_knapsack.py'), false);
		assert.strictEqual(isRunnableCommand('ls -la'), false);
		assert.strictEqual(isRunnableCommand('foo'), false);
	});

	test('isBashFenceLang accepts bash only', () => {
		assert.strictEqual(isBashFenceLang('bash'), true);
		assert.strictEqual(isBashFenceLang('BASH'), true);
		assert.strictEqual(isBashFenceLang('bash run'), true);
		assert.strictEqual(isBashFenceLang('sh'), false);
		assert.strictEqual(isBashFenceLang('shell'), false);
		assert.strictEqual(isBashFenceLang('javascript'), false);
		assert.strictEqual(isBashFenceLang(undefined), false);
		assert.strictEqual(isBashFenceLang(''), false);
	});
});
