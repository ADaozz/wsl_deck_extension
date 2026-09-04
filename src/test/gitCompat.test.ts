import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acceptChange, isMainConflicted } from '../change/changeActions';
import { testProposedChange } from './testProposedChange';
import { ShadowWorkspaceManager } from '../shadow/shadowWorkspaceManager';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

suite('Git compatibility (M11)', () => {
	test('Keep dirties main git status without touching index plumbing', async function () {
		this.timeout(20_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-git-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		fs.writeFileSync(path.join(main, 'hello.txt'), 'baseline\n', 'utf8');
		execFileSync('git', ['init'], { cwd: main });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: main });
		execFileSync('git', ['add', 'hello.txt'], { cwd: main });
		execFileSync('git', ['commit', '-m', 'init'], { cwd: main });
		const headBefore = git(main, ['rev-parse', 'HEAD']);

		const mgr = new ShadowWorkspaceManager();
		try {
			const shadow = await mgr.ensureShadow(main, 'git-compat-1');
			fs.writeFileSync(path.join(shadow.shadowCwd, 'hello.txt'), 'agent edit\n', 'utf8');

			const change = testProposedChange({
				path: 'hello.txt',
				additions: 1,
				deletions: 1,
				shadowPath: path.join(shadow.shadowCwd, 'hello.txt'),
				mainPath: path.join(main, 'hello.txt'),
			});

			const accepted = await acceptChange(shadow, change);
			assert.strictEqual(accepted.state, 'accepted');
			assert.strictEqual(fs.readFileSync(path.join(main, 'hello.txt'), 'utf8'), 'agent edit\n');

			const status = git(main, ['status', '--porcelain']);
			assert.ok(status.includes('hello.txt'), `expected dirty file in status, got: ${status}`);
			assert.strictEqual(git(main, ['rev-parse', 'HEAD']), headBefore, 'Keep must not create commits');

			const second = await acceptChange(shadow, { ...change, state: 'pending' });
			assert.strictEqual(second.state, 'accepted');
		} finally {
			await mgr.disposeAll();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('unicode and spaced paths keep + conflict gate', async function () {
		this.timeout(20_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-git-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		const rel = 'docs/测试 文件.md';
		const abs = path.join(main, rel);
		fs.mkdirSync(path.dirname(abs), { recursive: true });
		fs.writeFileSync(abs, 'baseline\n', 'utf8');
		execFileSync('git', ['init'], { cwd: main });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: main });
		execFileSync('git', ['add', '.'], { cwd: main });
		execFileSync('git', ['commit', '-m', 'init'], { cwd: main });

		const mgr = new ShadowWorkspaceManager();
		try {
			const shadow = await mgr.ensureShadow(main, 'git-compat-2');
			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'agent\n', 'utf8');

			const change = testProposedChange({
				path: rel,
				additions: 1,
				deletions: 1,
				shadowPath: path.join(shadow.shadowCwd, rel),
				mainPath: abs,
			});

			const accepted = await acceptChange(shadow, change);
			assert.strictEqual(accepted.state, 'accepted');

			fs.writeFileSync(abs, 'user edit\n', 'utf8');
			fs.writeFileSync(path.join(shadow.shadowCwd, rel), 'agent again\n', 'utf8');
			assert.strictEqual(await isMainConflicted(shadow, change), true);
			const conflicted = await acceptChange(shadow, { ...change, state: 'pending' });
			assert.strictEqual(conflicted.state, 'conflicted');
			assert.strictEqual(fs.readFileSync(abs, 'utf8'), 'user edit\n');
		} finally {
			await mgr.disposeAll();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});

	test('git add / reset / commit still work after Keep', async function () {
		this.timeout(20_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-git-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		fs.writeFileSync(path.join(main, 'app.ts'), 'v0\n', 'utf8');
		execFileSync('git', ['init'], { cwd: main });
		execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: main });
		execFileSync('git', ['config', 'user.name', 'Test'], { cwd: main });
		execFileSync('git', ['add', 'app.ts'], { cwd: main });
		execFileSync('git', ['commit', '-m', 'init'], { cwd: main });

		const mgr = new ShadowWorkspaceManager();
		try {
			const shadow = await mgr.ensureShadow(main, 'git-compat-3');
			fs.writeFileSync(path.join(shadow.shadowCwd, 'app.ts'), 'v1\n', 'utf8');
			await acceptChange(
				shadow,
				testProposedChange({
					path: 'app.ts',
					additions: 1,
					deletions: 1,
					shadowPath: path.join(shadow.shadowCwd, 'app.ts'),
					mainPath: path.join(main, 'app.ts'),
				}),
			);

			git(main, ['add', 'app.ts']);
			git(main, ['commit', '-m', 'keep from agent']);
			assert.strictEqual(fs.readFileSync(path.join(main, 'app.ts'), 'utf8'), 'v1\n');

			git(main, ['reset', '--hard', 'HEAD~1']);
			assert.strictEqual(fs.readFileSync(path.join(main, 'app.ts'), 'utf8'), 'v0\n');
		} finally {
			await mgr.disposeAll();
			fs.rmSync(root, { recursive: true, force: true });
		}
	});
});
