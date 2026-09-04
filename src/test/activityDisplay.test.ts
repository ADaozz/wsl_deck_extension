import * as assert from 'node:assert';
import {
	normalizeActivityForDisplay,
	rewriteShadowPathsInText,
	shadowPathToWorkspaceRelative,
} from '../ui/activityDisplay';
import type { ActivityItem } from '../ui/messageProtocol';

suite('activity display paths', () => {
	const shadow =
		'/home/neo/.local/share/wsldeck-extension/workspaces/e2dd977539cb9a6d/session-mtlc3gbi-726pry';

	test('shadow file path becomes workspace-relative', () => {
		const file = `${shadow}/pytask-cli/pyproject.toml`;
		assert.strictEqual(shadowPathToWorkspaceRelative(file, shadow), 'pytask-cli/pyproject.toml');
	});

	test('shadow root becomes dot', () => {
		assert.strictEqual(shadowPathToWorkspaceRelative(shadow, shadow), '.');
	});

	test('does not treat ..generated as escaping shadow', () => {
		const file = `${shadow}/..generated/out.ts`;
		assert.strictEqual(shadowPathToWorkspaceRelative(file, shadow), '..generated/out.ts');
	});

	test('rewrites shadow cd command and strips prefix', () => {
		const cmd = `cd ${shadow}/pytask-cli && python3 -m pytest -q`;
		assert.strictEqual(rewriteShadowPathsInText(cmd, shadow), 'python3 -m pytest -q');
	});

	test('preserves non-shadow cd commands', () => {
		assert.strictEqual(
			rewriteShadowPathsInText('cd packages/api && npm test', shadow),
			'cd packages/api && npm test',
		);
		assert.strictEqual(
			rewriteShadowPathsInText('cd /tmp/work && rm -rf build', shadow),
			'cd /tmp/work && rm -rf build',
		);
	});

	test('does not rewrite shadow sibling prefix', () => {
		const sibling = `${shadow}-old/file.ts`;
		assert.strictEqual(rewriteShadowPathsInText(sibling, shadow), sibling);
	});

	test('strips exact shadow cwd cd prefix', () => {
		const cmd = `cd ${shadow} && python3 -m pytest -q`;
		assert.strictEqual(rewriteShadowPathsInText(cmd, shadow), 'python3 -m pytest -q');
	});

	test('handles quoted shadow cd with spaces', () => {
		const cmd = `cd '${shadow}/dir with space' && pytest`;
		assert.strictEqual(rewriteShadowPathsInText(cmd, shadow), 'pytest');
	});

	test('normalizeActivityForDisplay rewrites activity rows', () => {
		const item: ActivityItem = {
			id: '1',
			name: 'Edit',
			label: `Edit '${shadow}/pytask-cli/pyproject.toml'`,
			kind: 'edit',
			detail: `${shadow}/pytask-cli/pyproject.toml`,
			status: 'completed',
			outcome: 'completed',
		};
		const normalized = normalizeActivityForDisplay(item, shadow);
		assert.strictEqual(normalized.label, "Edit 'pytask-cli/pyproject.toml'");
		assert.strictEqual(normalized.detail, 'pytask-cli/pyproject.toml');
	});

	test('permission-like non-shadow command detail is preserved', () => {
		const detail = 'cd /tmp/work && rm -rf node_modules';
		assert.strictEqual(rewriteShadowPathsInText(detail, shadow), detail);
	});
});
