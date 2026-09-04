import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { acceptChange, cancelChange, isMainConflicted } from '../change/changeActions';
import { testProposedChange } from './testProposedChange';
import { testGitBaseline } from './testSessionBaseline';
import { gitHeadAt } from '../session/sessionGit';

function git(cwd: string, args: string[]): string {
	return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

suite('Git compatibility (M11)', () => {
	test('Keep acknowledges agent edit on main without new commit', async function () {
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
		const baselineRef = (await gitHeadAt(main))!;

		const baseline = testGitBaseline(main, 'git-compat-1', baselineRef);
		fs.writeFileSync(path.join(main, 'hello.txt'), 'agent edit\n', 'utf8');

		const change = testProposedChange({
			path: 'hello.txt',
			additions: 1,
			deletions: 1,
			mainPath: path.join(main, 'hello.txt'),
		});

		const accepted = await acceptChange(baseline, change);
		assert.strictEqual(accepted.state, 'accepted');
		assert.strictEqual(fs.readFileSync(path.join(main, 'hello.txt'), 'utf8'), 'agent edit\n');

		const status = git(main, ['status', '--porcelain']);
		assert.ok(status.includes('hello.txt'), `expected dirty file in status, got: ${status}`);
		assert.strictEqual(git(main, ['rev-parse', 'HEAD']), headBefore, 'Keep must not create commits');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('Cancel restores file from session baseline', async function () {
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
		const baselineRef = (await gitHeadAt(main))!;
		const baseline = testGitBaseline(main, 'git-compat-cancel', baselineRef);

		fs.writeFileSync(path.join(main, 'app.ts'), 'v1\n', 'utf8');
		await cancelChange(
			baseline,
			testProposedChange({
				path: 'app.ts',
				mainPath: path.join(main, 'app.ts'),
			}),
		);
		assert.strictEqual(fs.readFileSync(path.join(main, 'app.ts'), 'utf8'), 'v0\n');
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('unicode paths keep + overlay baseline', async function () {
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
		const baselineRef = (await gitHeadAt(main))!;
		const baseline = testGitBaseline(main, 'git-compat-2', baselineRef);

		fs.writeFileSync(abs, 'agent\n', 'utf8');
		const change = testProposedChange({
			path: rel,
			additions: 1,
			deletions: 1,
			mainPath: abs,
		});

		const accepted = await acceptChange(baseline, change);
		assert.strictEqual(accepted.state, 'accepted');

		fs.writeFileSync(abs, 'user edit\n', 'utf8');
		assert.strictEqual(await isMainConflicted(baseline, change), true);
		fs.rmSync(root, { recursive: true, force: true });
	});
});
