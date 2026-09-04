import * as assert from 'node:assert';
import {
	isBenignCommandExitCode,
	toolCompletedOk,
} from '../ui/commandExitHeuristic';

suite('command exit heuristic', () => {
	test('rg exit 1 is benign', () => {
		assert.strictEqual(isBenignCommandExitCode('rg add_todo src/', 1), true);
		assert.strictEqual(isBenignCommandExitCode('grep -R foo .', 1), true);
		assert.strictEqual(isBenignCommandExitCode('git grep needle', 1), true);
	});

	test('rg exit 2 is not benign', () => {
		assert.strictEqual(isBenignCommandExitCode('rg add_todo src/', 2), false);
	});

	test('failed search tools without exit code are treated as ok', () => {
		assert.strictEqual(toolCompletedOk('rg pattern', 'failed', undefined), true);
		assert.strictEqual(toolCompletedOk('npm test', 'failed', undefined), false);
		assert.strictEqual(toolCompletedOk('rg pattern', 'failed', 1), true);
	});
});
