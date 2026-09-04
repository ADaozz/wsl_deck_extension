import * as assert from 'node:assert';
import { toolDisplayLabel } from '../agent/agentEvents';
import { activityFromTool } from '../ui/messageProtocol';

suite('tool metadata display', () => {
	test('uses title when present, otherwise raw name — no tool enum', () => {
		assert.strictEqual(
			toolDisplayLabel({ toolCallId: '1', name: 'grep' }),
			'grep',
		);
		assert.strictEqual(
			toolDisplayLabel({
				toolCallId: '2',
				name: 'WebSearch',
				title: 'Web search',
			}),
			'Web search',
		);
	});

	test('activityFromTool preserves free-form name and detail', () => {
		const item = activityFromTool(
			{
				toolCallId: 'abc',
				name: 'some_future_tool_xyz',
				detail: 'query=hello',
			},
			'running',
		);
		assert.strictEqual(item.name, 'some_future_tool_xyz');
		assert.strictEqual(item.label, 'some_future_tool_xyz');
		assert.strictEqual(item.detail, 'query=hello');
		assert.strictEqual(item.status, 'running');
	});
});
