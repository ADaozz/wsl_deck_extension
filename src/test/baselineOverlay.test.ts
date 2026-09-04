import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { acceptChange, isMainConflicted } from '../change/changeActions';
import { detectProposedChanges } from '../change/changeTracker';
import { testProposedChange } from './testProposedChange';
import { testSnapshotBaseline } from './testSessionBaseline';

suite('baseline overlay after Keep', () => {
	test('second Keep does not false-conflict after baseline advances', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-overlay-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-overlay-1');
			const { mainCwd, baselineDir } = baseline;
			assert.ok(baselineDir);

			fs.writeFileSync(path.join(mainCwd, 'a.txt'), 'agent v1\n', 'utf8');
			fs.writeFileSync(path.join(baselineDir, 'a.txt'), 'baseline\n', 'utf8');

			const change = testProposedChange({
				path: 'a.txt',
				additions: 1,
				deletions: 1,
				mainPath: path.join(mainCwd, 'a.txt'),
			});

			const first = await acceptChange(baseline, change);
			assert.strictEqual(first.state, 'accepted');
			assert.strictEqual(fs.readFileSync(path.join(mainCwd, 'a.txt'), 'utf8'), 'agent v1\n');

			const second = await acceptChange(baseline, { ...change, state: 'pending' });
			assert.strictEqual(second.state, 'accepted');
			assert.strictEqual(await isMainConflicted(baseline, change), false);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('accepted row reopens as pending when agent edits main again', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-overlay-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-overlay-2');
			const { mainCwd, baselineDir } = baseline;
			assert.ok(baselineDir);

			fs.writeFileSync(path.join(mainCwd, 'b.txt'), 'edit1\n', 'utf8');
			fs.writeFileSync(path.join(baselineDir, 'b.txt'), 'base\n', 'utf8');

			const change = testProposedChange({
				path: 'b.txt',
				additions: 1,
				deletions: 1,
				mainPath: path.join(mainCwd, 'b.txt'),
			});
			const accepted = await acceptChange(baseline, change);
			assert.strictEqual(accepted.state, 'accepted');

			fs.writeFileSync(path.join(mainCwd, 'b.txt'), 'edit2\n', 'utf8');
			const refreshed = await detectProposedChanges(baseline, { previous: [accepted] });
			assert.strictEqual(refreshed.length, 1);
			assert.strictEqual(refreshed[0].state, 'pending');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
