import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { isBinaryChangePath, isBinaryFile, lineStatsForFile } from '../change/changeFileStats';
import { isIgnoredChangePath } from '../change/changePathFilter';

suite('changeFileStats', () => {
	test('isBinaryChangePath detects archives', () => {
		assert.ok(isBinaryChangePath('foo/bar.tar.gz'));
		assert.ok(!isBinaryChangePath('src/main.java'));
	});

	test('lineStatsForFile returns zero for binary content', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-stats-'));
		try {
			const file = path.join(dir, 'blob.bin');
			fs.writeFileSync(file, Buffer.from([0, 1, 2, 3, 0, 5]));
			assert.deepStrictEqual(lineStatsForFile(file), { additions: 0, deletions: 0 });
			assert.ok(isBinaryFile(file));
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('lineStatsForFile counts text lines', () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wd-stats-'));
		try {
			const file = path.join(dir, 'a.txt');
			fs.writeFileSync(file, 'one\ntwo\nthree');
			assert.deepStrictEqual(lineStatsForFile(file), { additions: 3, deletions: 0 });
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	test('isIgnoredChangePath skips artifacts and run configs', () => {
		assert.ok(isIgnoredChangePath('.artifacts/pkg.tar.gz'));
		assert.ok(isIgnoredChangePath('.run/App.run.xml'));
	});
});
