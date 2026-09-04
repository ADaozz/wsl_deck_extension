import * as assert from 'node:assert';
import { activityExpandExtra, formatActivitySummary } from '../ui/activityDisplayFormat';
import type { ActivityItem } from '../ui/messageProtocol';

suite('activity display format', () => {
	test('grep summary quotes pattern without kind/status noise', () => {
		const item: ActivityItem = {
			id: '1',
			name: 'grep',
			label: 'grep',
			kind: 'search',
			detail: 'add_todo',
			status: 'completed',
			outcome: 'completed',
		};
		assert.strictEqual(formatActivitySummary(item), 'grep "add_todo"');
		assert.strictEqual(activityExpandExtra(item), undefined);
	});

	test('edit summary includes diff stats when present', () => {
		const item: ActivityItem = {
			id: '2',
			name: 'Edit',
			label: 'Edit',
			kind: 'edit',
			detail: 'src/foo.py',
			status: 'completed',
			changeAdditions: 3,
			changeDeletions: 1,
		};
		assert.strictEqual(formatActivitySummary(item, []), 'Edit "foo.py" +3 -1');
	});

	test('dedupes detail already embedded in label', () => {
		const item: ActivityItem = {
			id: '3',
			name: 'pytask',
			label: 'pytask',
			detail: 'pytask',
			status: 'completed',
			outcome: 'completed',
		};
		assert.strictEqual(formatActivitySummary(item), 'pytask');
	});
});
