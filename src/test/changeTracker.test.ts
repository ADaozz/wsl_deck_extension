import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProposedChanges } from '../change/changeTracker';
import { testProposedChange } from './testProposedChange';
import type { ShadowWorkspace } from '../shadow/shadowWorkspaceManager';

suite('changeTracker', () => {
	test('detectCopyChanges preserves accepted state on refresh', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-chg-'));
		try {
			const mainCwd = path.join(root, 'main');
			const shadowCwd = path.join(root, 'shadow');
			const baselineRoot = path.join(root, 'shadow.baseline');
			fs.mkdirSync(mainCwd, { recursive: true });
			fs.mkdirSync(shadowCwd, { recursive: true });
			fs.mkdirSync(baselineRoot, { recursive: true });

			fs.writeFileSync(path.join(mainCwd, 'a.txt'), 'main\n', 'utf8');
			fs.writeFileSync(path.join(baselineRoot, 'a.txt'), 'baseline\n', 'utf8');
			fs.writeFileSync(path.join(shadowCwd, 'a.txt'), 'shadow edit\n', 'utf8');

			const shadow: ShadowWorkspace = {
				sessionId: 'sess-copy-1',
				mainCwd,
				shadowCwd,
				kind: 'copy',
				createdAt: Date.now(),
			};

			const previous = [
				testProposedChange({
					path: 'a.txt',
					additions: 1,
					deletions: 1,
					state: 'accepted',
					shadowPath: path.join(shadowCwd, 'a.txt'),
					mainPath: path.join(mainCwd, 'a.txt'),
				}),
			];

			const changes = await detectProposedChanges(shadow, { previous });
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].state, 'accepted');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('detectCopyChanges preserves conflicted state on refresh', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-chg-'));
		try {
			const mainCwd = path.join(root, 'main');
			const shadowCwd = path.join(root, 'shadow');
			const baselineRoot = path.join(root, 'shadow.baseline');
			fs.mkdirSync(mainCwd, { recursive: true });
			fs.mkdirSync(shadowCwd, { recursive: true });
			fs.mkdirSync(baselineRoot, { recursive: true });

			fs.writeFileSync(path.join(mainCwd, 'b.txt'), 'user edit\n', 'utf8');
			fs.writeFileSync(path.join(baselineRoot, 'b.txt'), 'baseline\n', 'utf8');
			fs.writeFileSync(path.join(shadowCwd, 'b.txt'), 'shadow edit\n', 'utf8');

			const shadow: ShadowWorkspace = {
				sessionId: 'sess-copy-2',
				mainCwd,
				shadowCwd,
				kind: 'copy',
				createdAt: Date.now(),
			};

			const previous = [
				testProposedChange({
					path: 'b.txt',
					additions: 1,
					deletions: 1,
					state: 'conflicted',
					shadowPath: path.join(shadowCwd, 'b.txt'),
					mainPath: path.join(mainCwd, 'b.txt'),
				}),
			];

			const changes = await detectProposedChanges(shadow, { previous });
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].state, 'conflicted');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
