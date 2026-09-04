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
import type { ShadowWorkspace } from '../shadow/shadowWorkspaceManager';

function makeCopyShadow(root: string, sessionId: string): ShadowWorkspace {
	const mainCwd = path.join(root, 'main');
	const shadowCwd = path.join(root, 'shadow');
	const baselineRoot = path.join(root, 'shadow.baseline');
	fs.mkdirSync(mainCwd, { recursive: true });
	fs.mkdirSync(shadowCwd, { recursive: true });
	fs.mkdirSync(baselineRoot, { recursive: true });
	return {
		sessionId,
		mainCwd,
		shadowCwd,
		kind: 'copy',
		createdAt: Date.now(),
	};
}

suite('changeRevisions', () => {
	test('multi-turn edits produce one card with stacked revisions', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-rev-'));
		try {
			const shadow = makeCopyShadow(root, 'sess-rev-1');
			const rel = 'src/foo.ts';
			fs.mkdirSync(path.dirname(path.join(shadow.mainCwd, rel)), { recursive: true });
			fs.mkdirSync(path.dirname(path.join(root, 'shadow.baseline', rel)), { recursive: true });
			fs.mkdirSync(path.dirname(path.join(shadow.shadowCwd, rel)), { recursive: true });
			fs.writeFileSync(path.join(shadow.mainCwd, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(root, 'shadow.baseline', rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'turn1\n', 'utf8');

			const turn1 = 'turn-aaa111';
			let changes = await detectProposedChanges(shadow, { turnId: turn1 });
			changes = await enrichChangesWithRevisions(shadow, [], changes, {
				turnId: turn1,
				mainCwd: shadow.mainCwd,
				sessionId: shadow.sessionId,
				now: 1_000,
			});
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].revisions.length, 1);
			assert.strictEqual(changes[0].revisions[0].turnId, turn1);

			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'turn2\n', 'utf8');
			const turn2 = 'turn-bbb222';
			const detected2 = await detectProposedChanges(shadow, { previous: changes, turnId: turn2 });
			changes = await enrichChangesWithRevisions(shadow, changes, detected2, {
				turnId: turn2,
				mainCwd: shadow.mainCwd,
				sessionId: shadow.sessionId,
				now: 2_000,
			});
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].id, changeIdForPath(rel));
			assert.strictEqual(changes[0].revisions.length, 2);
			assert.strictEqual(changes[0].revisions[0].turnId, turn1);
			assert.strictEqual(changes[0].revisions[1].turnId, turn2);
			assert.strictEqual(changes[0].updatedAt, 2_000);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('same turn refresh updates revision in place', async () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-rev-'));
		try {
			const shadow = makeCopyShadow(root, 'sess-rev-2');
			const rel = 'a.txt';
			fs.writeFileSync(path.join(shadow.mainCwd, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(root, 'shadow.baseline', rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'edit v1\n', 'utf8');

			const turnId = 'turn-same';
			let detected = await detectProposedChanges(shadow, { turnId });
			let changes = await enrichChangesWithRevisions(shadow, [], detected, {
				turnId,
				mainCwd: shadow.mainCwd,
				sessionId: shadow.sessionId,
				now: 5_000,
			});
			assert.strictEqual(changes[0].revisions.length, 1);
			const firstAt = changes[0].revisions[0].at;

			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'edit v2 longer\n', 'utf8');
			detected = await detectProposedChanges(shadow, { previous: changes, turnId });
			changes = await enrichChangesWithRevisions(shadow, changes, detected, {
				turnId,
				mainCwd: shadow.mainCwd,
				sessionId: shadow.sessionId,
				now: 6_000,
			});
			assert.strictEqual(changes[0].revisions.length, 1);
			assert.strictEqual(changes[0].revisions[0].turnId, turnId);
			assert.strictEqual(changes[0].revisions[0].at, 6_000);
			assert.notStrictEqual(changes[0].revisions[0].at, firstAt);
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
			const shadow = makeCopyShadow(root, 'sess-rev-keep');
			const rel = 'file.txt';
			fs.writeFileSync(path.join(shadow.mainCwd, rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(root, 'shadow.baseline', rel), 'base\n', 'utf8');
			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'keep me\n', 'utf8');

			const turn1 = 'turn-keep-1';
			let changes = await enrichChangesWithRevisions(
				shadow,
				[],
				await detectProposedChanges(shadow, { turnId: turn1 }),
				{ turnId: turn1, mainCwd: shadow.mainCwd, sessionId: shadow.sessionId, now: 100 },
			);
			const kept = await acceptChange(shadow, changes[0]);
			assert.strictEqual(kept.state, 'accepted');

			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'after keep\n', 'utf8');
			const turn2 = 'turn-keep-2';
			changes = await enrichChangesWithRevisions(
				shadow,
				[kept],
				await detectProposedChanges(shadow, { previous: [kept], turnId: turn2 }),
				{ turnId: turn2, mainCwd: shadow.mainCwd, sessionId: shadow.sessionId, now: 200 },
			);
			assert.strictEqual(changes.length, 1);
			assert.strictEqual(changes[0].revisions.length, 2);
			assert.strictEqual(changes[0].state, 'pending');
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
