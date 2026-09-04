import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
	deleteSessionDeck,
	ensureDeckScaffold,
	materializeChanges,
	readSessionDeck,
	toPersistedChanges,
	writeSessionDeck,
} from '../state/workspaceDeckStore';
import { revisionIdForTurn } from '../change/proposedChange';
import { testProposedChange } from './testProposedChange';

suite('workspace .WSLDeck store', () => {
	test('scaffold writes gitignore and round-trips changes + permission', () => {
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-deck-'));
		try {
			ensureDeckScaffold(root);
			const gi = path.join(root, '.WSLDeck', '.gitignore');
			assert.ok(fs.existsSync(gi));
			assert.ok(fs.readFileSync(gi, 'utf8').includes('*'));

			const change = testProposedChange({
				path: 'src/a.ts',
				additions: 2,
				deletions: 1,
				shadowPath: '/shadow/src/a.ts',
				mainPath: '/main/src/a.ts',
				createdAt: 1_000,
				updatedAt: 2_000,
				revisions: [
					{
						id: revisionIdForTurn('turn-1'),
						turnId: 'turn-1',
						at: 1_500,
						additions: 2,
						deletions: 1,
						snapshotId: revisionIdForTurn('turn-1'),
					},
				],
			});
			writeSessionDeck(root, 'session-1', {
				changes: [change],
				pendingPermission: {
					requestId: 'perm-1',
					title: 'Delete file',
					options: [{ optionId: 'allow-once', label: 'Allow once', kind: 'allow_once' }],
				},
			});

			const loaded = readSessionDeck(root, 'session-1');
			assert.ok(loaded);
			assert.strictEqual(loaded!.version, 2);
			assert.strictEqual(loaded!.changes.length, 1);
			assert.strictEqual(loaded!.changes[0].path, 'src/a.ts');
			assert.strictEqual(loaded!.changes[0].createdAt, 1_000);
			assert.strictEqual(loaded!.changes[0].updatedAt, 2_000);
			assert.strictEqual(loaded!.changes[0].revisions?.length, 1);
			assert.strictEqual(loaded!.changes[0].revisions![0].turnId, 'turn-1');
			assert.strictEqual(loaded!.pendingPermission?.requestId, 'perm-1');

			const materialized = materializeChanges(loaded!.changes, '/main', '/shadow');
			assert.strictEqual(materialized[0].mainPath, path.join('/main', 'src/a.ts'));
			assert.strictEqual(materialized[0].shadowPath, path.join('/shadow', 'src/a.ts'));
			assert.strictEqual(materialized[0].revisions.length, 1);
			assert.strictEqual(materialized[0].createdAt, 1_000);

			assert.deepStrictEqual(toPersistedChanges(materialized)[0].state, 'pending');

			deleteSessionDeck(root, 'session-1');
			assert.strictEqual(readSessionDeck(root, 'session-1'), undefined);
		} finally {
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
