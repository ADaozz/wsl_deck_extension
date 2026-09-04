import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { detectProposedChanges } from '../change/changeTracker';
import { testProposedChange } from './testProposedChange';
import { testSnapshotBaseline } from './testSessionBaseline';

suite('changeTracker', () => {
	test('detectSnapshotChanges ignores pre-session dirty files', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-chg-dirty-'));
		try {
			const main = path.join(root, 'main');
			fs.mkdirSync(main);
			fs.writeFileSync(path.join(main, 'dirty.txt'), 'user edit before session\n', 'utf8');
			fs.writeFileSync(path.join(main, 'clean.txt'), 'same\n', 'utf8');

			const baseline = testSnapshotBaseline(root, 'sess-dirty');
			const { baselineDir } = baseline;
			assert.ok(baselineDir);
			fs.writeFileSync(path.join(baselineDir, 'dirty.txt'), 'user edit before session\n', 'utf8');
			fs.writeFileSync(path.join(baselineDir, 'clean.txt'), 'same\n', 'utf8');

			// Agent only touches agent.txt
			fs.writeFileSync(path.join(main, 'agent.txt'), 'agent\n', 'utf8');

			const changes = await detectProposedChanges(baseline);
			assert.deepStrictEqual(
				changes.map((c) => c.path).sort(),
				['agent.txt'],
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('detectSnapshotChanges preserves accepted state on refresh', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-chg-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-copy-1');
			const { mainCwd, baselineDir } = baseline;
			assert.ok(baselineDir);

			fs.writeFileSync(path.join(mainCwd, 'a.txt'), 'agent edit\n', 'utf8');
			fs.writeFileSync(path.join(baselineDir, 'a.txt'), 'baseline\n', 'utf8');

			const previous = [
				testProposedChange({
					path: 'a.txt',
					additions: 1,
					deletions: 1,
					state: 'accepted',
					mainPath: path.join(mainCwd, 'a.txt'),
				}),
			];

			const changes = await detectProposedChanges(baseline, { previous });
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].state, 'accepted');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('detectSnapshotChanges preserves conflicted state on refresh', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-chg-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-copy-2');
			const { mainCwd, baselineDir } = baseline;
			assert.ok(baselineDir);

			fs.writeFileSync(path.join(mainCwd, 'b.txt'), 'current\n', 'utf8');
			fs.writeFileSync(path.join(baselineDir, 'b.txt'), 'baseline\n', 'utf8');

			const previous = [
				testProposedChange({
					path: 'b.txt',
					additions: 1,
					deletions: 1,
					state: 'conflicted',
					mainPath: path.join(mainCwd, 'b.txt'),
				}),
			];

			const changes = await detectProposedChanges(baseline, { previous });
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].state, 'conflicted');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
