import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseNumstat } from '../change/changeTracker';
import { changeIdForPath } from '../change/proposedChange';
import {
	acceptChange,
	cancelChange,
	isMainConflicted,
} from '../change/changeActions';
import { testProposedChange } from './testProposedChange';
import { repoIdFromMainCwd } from '../shadow/shadowPaths';
import { ShadowWorkspaceManager } from '../shadow/shadowWorkspaceManager';

suite('Shadow + Change Engine', () => {
	test('repoIdFromMainCwd is stable and short', () => {
		const a = repoIdFromMainCwd('/home/neo/project/Foo');
		const b = repoIdFromMainCwd('/home/neo/project/Foo');
		const c = repoIdFromMainCwd('/home/neo/project/Bar');
		assert.strictEqual(a, b);
		assert.notStrictEqual(a, c);
		assert.strictEqual(a.length, 16);
	});

	test('parseNumstat handles text and binary rows', () => {
		const rows = parseNumstat(
			['10\t2\tsrc/a.ts', '-\t-\timg.png', '1\t0\tpath with\tweird', ''].join('\n'),
		);
		assert.strictEqual(rows.length, 3);
		assert.deepStrictEqual(rows[0], { path: 'src/a.ts', additions: 10, deletions: 2 });
		assert.deepStrictEqual(rows[1], { path: 'img.png', additions: 0, deletions: 0 });
		assert.strictEqual(rows[2].path, 'path with\tweird');
	});

	test('changeIdForPath is filesystem-safe', () => {
		const id = changeIdForPath('src/foo bar.ts');
		assert.ok(id.startsWith('chg-'));
		assert.ok(!id.includes(' '));
	});

	test('git worktree shadow + accept/cancel conflict gate', async function () {
		this.timeout(20_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-shadow-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		fs.writeFileSync(path.join(main, 'hello.txt'), 'baseline\n', 'utf8');
		execFileSync('git', ['init'], { cwd: main });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: main });
		execFileSync('git', ['add', 'hello.txt'], { cwd: main });
		execFileSync('git', ['commit', '-m', 'init'], { cwd: main });

		const mgr = new ShadowWorkspaceManager();
		try {
			const shadow = await mgr.ensureShadow(main, 'sess-test-1');
			assert.strictEqual(shadow.kind, 'git-worktree');
			assert.ok(
				shadow.shadowCwd.includes(`${path.sep}wsldeck-extension${path.sep}workspaces${path.sep}`),
			);
			assert.ok(!shadow.shadowCwd.includes(`${path.sep}.WSLDeck${path.sep}`));
			assert.ok(fs.existsSync(shadow.shadowCwd));
			assert.ok(shadow.baselineRef);

			// Reattach must not wipe edits
			fs.writeFileSync(path.join(shadow.shadowCwd, 'hello.txt'), 'shadow edit\n', 'utf8');
			mgr['shadows'].delete('sess-test-1');
			const again = await mgr.ensureShadow(main, 'sess-test-1');
			assert.strictEqual(
				fs.readFileSync(path.join(again.shadowCwd, 'hello.txt'), 'utf8'),
				'shadow edit\n',
			);

			const change = testProposedChange({
				path: 'hello.txt',
				additions: 1,
				deletions: 1,
				shadowPath: path.join(shadow.shadowCwd, 'hello.txt'),
				mainPath: path.join(main, 'hello.txt'),
			});

			assert.strictEqual(await isMainConflicted(shadow, change), false);
			const accepted = await acceptChange(shadow, change);
			assert.strictEqual(accepted.state, 'accepted');
			assert.strictEqual(fs.readFileSync(path.join(main, 'hello.txt'), 'utf8'), 'shadow edit\n');

			fs.writeFileSync(path.join(main, 'hello.txt'), 'user edit\n', 'utf8');
			fs.writeFileSync(path.join(shadow.shadowCwd, 'hello.txt'), 'shadow again\n', 'utf8');
			const conflicted = await acceptChange(shadow, {
				...change,
				state: 'pending',
			});
			assert.strictEqual(conflicted.state, 'conflicted');
			assert.strictEqual(fs.readFileSync(path.join(main, 'hello.txt'), 'utf8'), 'user edit\n');

			fs.writeFileSync(path.join(main, 'hello.txt'), 'baseline\n', 'utf8');
			const cancelled = await cancelChange(shadow, { ...change, state: 'pending' });
			assert.strictEqual(cancelled.state, 'rejected');
			assert.strictEqual(
				fs.readFileSync(path.join(shadow.shadowCwd, 'hello.txt'), 'utf8'),
				'baseline\n',
			);

			await mgr.disposeShadow('sess-test-1');
			assert.ok(!fs.existsSync(shadow.shadowCwd));
		} finally {
			await mgr.disposeAll();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
