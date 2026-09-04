import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acceptChange, isMainConflicted } from '../change/changeActions';
import { detectProposedChanges } from '../change/changeTracker';
import { testProposedChange } from './testProposedChange';
import type { ShadowWorkspace } from '../shadow/shadowWorkspaceManager';

suite('baseline overlay after Keep', () => {
	test('second Keep does not false-conflict after baseline advances', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-overlay-'));
		try {
			const mainCwd = path.join(root, 'main');
			const shadowCwd = path.join(root, 'shadow');
			const baselineRoot = path.join(root, 'shadow.baseline');
			fs.mkdirSync(mainCwd, { recursive: true });
			fs.mkdirSync(shadowCwd, { recursive: true });
			fs.mkdirSync(baselineRoot, { recursive: true });

			fs.writeFileSync(path.join(mainCwd, 'a.txt'), 'baseline\n', 'utf8');
			fs.writeFileSync(path.join(baselineRoot, 'a.txt'), 'baseline\n', 'utf8');
			fs.writeFileSync(path.join(shadowCwd, 'a.txt'), 'shadow v1\n', 'utf8');

			const shadow: ShadowWorkspace = {
				sessionId: 'sess-overlay-1',
				mainCwd,
				shadowCwd,
				kind: 'copy',
				createdAt: Date.now(),
			};

			const change = testProposedChange({
				path: 'a.txt',
				additions: 1,
				deletions: 1,
				shadowPath: path.join(shadowCwd, 'a.txt'),
				mainPath: path.join(mainCwd, 'a.txt'),
			});

			const first = await acceptChange(shadow, change);
			assert.strictEqual(first.state, 'accepted');
			assert.strictEqual(fs.readFileSync(path.join(mainCwd, 'a.txt'), 'utf8'), 'shadow v1\n');

			const second = await acceptChange(shadow, { ...change, state: 'pending' });
			assert.strictEqual(second.state, 'accepted');
			assert.strictEqual(await isMainConflicted(shadow, change), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('accepted row reopens as pending when agent edits shadow again', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-overlay-'));
		try {
			const mainCwd = path.join(root, 'main');
			const shadowCwd = path.join(root, 'shadow');
			const baselineRoot = path.join(root, 'shadow.baseline');
			fs.mkdirSync(mainCwd, { recursive: true });
			fs.mkdirSync(shadowCwd, { recursive: true });
			fs.mkdirSync(baselineRoot, { recursive: true });

			fs.writeFileSync(path.join(mainCwd, 'b.txt'), 'base\n', 'utf8');
			fs.writeFileSync(path.join(baselineRoot, 'b.txt'), 'base\n', 'utf8');
			fs.writeFileSync(path.join(shadowCwd, 'b.txt'), 'edit1\n', 'utf8');

			const shadow: ShadowWorkspace = {
				sessionId: 'sess-overlay-2',
				mainCwd,
				shadowCwd,
				kind: 'copy',
				createdAt: Date.now(),
			};

			const change = testProposedChange({
				path: 'b.txt',
				additions: 1,
				deletions: 1,
				shadowPath: path.join(shadowCwd, 'b.txt'),
				mainPath: path.join(mainCwd, 'b.txt'),
			});
			const accepted = await acceptChange(shadow, change);
			assert.strictEqual(accepted.state, 'accepted');

			fs.writeFileSync(path.join(shadowCwd, 'b.txt'), 'edit2\n', 'utf8');
			const refreshed = await detectProposedChanges(shadow, { previous: [accepted] });
			assert.strictEqual(refreshed.length, 1);
			assert.strictEqual(refreshed[0].state, 'pending');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
