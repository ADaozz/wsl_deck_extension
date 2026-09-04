import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	enrichChangesWithRevisions,
	readRevisionSnapshot,
	writeRevisionSnapshot,
} from '../change/changeRevisions';
import { acceptChange } from '../change/changeActions';
import { detectProposedChanges } from '../change/changeTracker';
import { changeIdForPath, revisionIdForTurn } from '../change/proposedChange';
import { testSnapshotBaseline } from './testSessionBaseline';

suite('changeRevisions', () => {
	test('multi-turn edits produce one card with stacked revisions', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-rev-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-rev-1');
			const rel = 'src/foo.ts';
			assert.ok(baseline.baselineDir);
			fs.mkdirSync(path.dirname(path.join(baseline.mainCwd, rel)), { recursive: true });
			fs.mkdirSync(path.dirname(path.join(baseline.baselineDir, rel)), { recursive: true });
			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(baseline.baselineDir, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'turn1\n', 'utf8');

			const turn1 = 'turn-aaa111';
			let changes = await detectProposedChanges(baseline, { turnId: turn1 });
			changes = await enrichChangesWithRevisions(baseline, [], changes, {
				turnId: turn1,
				mainCwd: baseline.mainCwd,
				sessionId: baseline.sessionId,
				now: 1_000,
			});
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].revisions.length, 1);

			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'turn2\n', 'utf8');
			const turn2 = 'turn-bbb222';
			const detected2 = await detectProposedChanges(baseline, { previous: changes, turnId: turn2 });
			changes = await enrichChangesWithRevisions(baseline, changes, detected2, {
				turnId: turn2,
				mainCwd: baseline.mainCwd,
				sessionId: baseline.sessionId,
				now: 2_000,
			});
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].id, changeIdForPath(rel));
			assert.strictEqual(changes[0].revisions.length, 2);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('same turn refresh updates revision in place', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-rev-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-rev-2');
			const rel = 'a.txt';
			assert.ok(baseline.baselineDir);
			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(baseline.baselineDir, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'edit v1\n', 'utf8');

			const turnId = 'turn-same';
			let detected = await detectProposedChanges(baseline, { turnId });
			let changes = await enrichChangesWithRevisions(baseline, [], detected, {
				turnId,
				mainCwd: baseline.mainCwd,
				sessionId: baseline.sessionId,
				now: 5_000,
			});
			assert.strictEqual(changes[0].revisions.length, 1);

			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'edit v2 longer\n', 'utf8');
			detected = await detectProposedChanges(baseline, { previous: changes, turnId });
			changes = await enrichChangesWithRevisions(baseline, changes, detected, {
				turnId,
				mainCwd: baseline.mainCwd,
				sessionId: baseline.sessionId,
				now: 6_000,
			});
			assert.strictEqual(changes[0].revisions.length, 1);
			assert.strictEqual(changes[0].revisions[0].at, 6_000);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('writeRevisionSnapshot round-trips via readRevisionSnapshot', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-snap-'));
		try {
			const mainCwd = path.join(root, 'main');
			fs.mkdirSync(mainCwd, { recursive: true });
			const src = path.join(root, 'src.txt');
			fs.writeFileSync(src, 'snapshot body\n', 'utf8');
			const snapshotId = revisionIdForTurn('turn-x');
			writeRevisionSnapshot(mainCwd, 'sess-snap', snapshotId, 'src.txt', src);
			assert.strictEqual(
				readRevisionSnapshot(mainCwd, 'sess-snap', snapshotId, 'src.txt'),
				'snapshot body\n',
			);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('Keep then new turn adds a new revision', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-rev-keep-'));
		try {
			const baseline = testSnapshotBaseline(root, 'sess-rev-keep');
			const rel = 'file.txt';
			assert.ok(baseline.baselineDir);
			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'keep me\n', 'utf8');
			fs.writeFileSync(path.join(baseline.baselineDir, rel), 'base\n', 'utf8');

			const turn1 = 'turn-keep-1';
			let changes = await enrichChangesWithRevisions(
				baseline,
				[],
				await detectProposedChanges(baseline, { turnId: turn1 }),
				{ turnId: turn1, mainCwd: baseline.mainCwd, sessionId: baseline.sessionId, now: 100 },
			);
			const kept = await acceptChange(baseline, changes[0]);
			assert.strictEqual(kept.state, 'accepted');

			fs.writeFileSync(path.join(baseline.mainCwd, rel), 'after keep\n', 'utf8');
			const turn2 = 'turn-keep-2';
			changes = await enrichChangesWithRevisions(
				baseline,
				[kept],
				await detectProposedChanges(baseline, { previous: [kept], turnId: turn2 }),
				{ turnId: turn2, mainCwd: baseline.mainCwd, sessionId: baseline.sessionId, now: 200 },
			);
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].revisions.length, 2);
			assert.strictEqual(changes[0].state, 'pending');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
