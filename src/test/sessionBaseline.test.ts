import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { SessionBaselineManager } from '../session/sessionBaseline';
import { sessionBaselineSnapshotDir } from '../session/sessionBaseline';

suite('sessionBaseline', () => {
	test('ensureBaseline captures git HEAD for git repos', async function () {
		this.timeout(15_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-baseline-git-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		fs.writeFileSync(path.join(main, 'a.txt'), 'x\n', 'utf8');
		execFileSync('git', ['init'], { cwd: main });
		execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: main });
		execFileSync('git', ['config', 'user.name', 'T'], { cwd: main });
		execFileSync('git', ['add', 'a.txt'], { cwd: main });
		execFileSync('git', ['commit', '-m', 'init'], { cwd: main });
		const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: main, encoding: 'utf8' }).trim();

		const mgr = new SessionBaselineManager();
		const baseline = await mgr.ensureBaseline(main, 'sess-git');
		assert.strictEqual(baseline.kind, 'git');
		assert.strictEqual(baseline.baselineRef, head);
		assert.ok(baseline.baselineDir);
		assert.ok(fs.existsSync(path.join(baseline.baselineDir!, 'a.txt')));
		fs.rmSync(root, { recursive: true, force: true });
	});

	test('ensureBaseline snapshots tree for non-git repos', async function () {
		this.timeout(15_000);
		const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wsldeck-baseline-snap-'));
		const main = path.join(root, 'main');
		fs.mkdirSync(main);
		fs.writeFileSync(path.join(main, 'hello.txt'), 'baseline\n', 'utf8');

		const mgr = new SessionBaselineManager();
		const baseline = await mgr.ensureBaseline(main, 'sess-snap');
		assert.strictEqual(baseline.kind, 'snapshot');
		const snap = sessionBaselineSnapshotDir(main, 'sess-snap');
		assert.ok(fs.existsSync(path.join(snap, 'hello.txt')));
		fs.rmSync(root, { recursive: true, force: true });
	});
});
