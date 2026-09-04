import * as assert from 'node:assert';
import {
	buildWslExeArgs,
	distroFromRemoteAuthority,
	parseDefaultRouteGateway,
	resolveToWslPath,
	toWslLinuxPath,
} from '../workspace/wslPathResolver';

suite('wslPathResolver', () => {
	test('maps Windows drive paths to /mnt/<drive>', () => {
		const a = resolveToWslPath('D:\\projects\\demo');
		assert.deepStrictEqual(a, {
			ok: true,
			linuxPath: '/mnt/d/projects/demo',
			kind: 'windows',
		});

		const b = resolveToWslPath('C:/project');
		assert.deepStrictEqual(b, {
			ok: true,
			linuxPath: '/mnt/c/project',
			kind: 'windows',
		});
	});

	test('maps \\\\wsl.localhost and \\\\wsl$ UNC paths', () => {
		const a = resolveToWslPath('\\\\wsl.localhost\\Ubuntu-24.04\\home\\neo\\project');
		assert.deepStrictEqual(a, {
			ok: true,
			linuxPath: '/home/neo/project',
			kind: 'unc-wsl',
		});

		const b = resolveToWslPath('\\\\wsl$\\Ubuntu\\home\\neo\\project\\WSLDeckExtension');
		assert.deepStrictEqual(b, {
			ok: true,
			linuxPath: '/home/neo/project/WSLDeckExtension',
			kind: 'unc-wsl',
		});
	});

	test('keeps Linux absolute paths', () => {
		const a = resolveToWslPath('/home/neo/project');
		assert.deepStrictEqual(a, {
			ok: true,
			linuxPath: '/home/neo/project',
			kind: 'linux',
		});
	});

	test('parses remote authority distro', () => {
		assert.strictEqual(distroFromRemoteAuthority('wsl+Ubuntu-24.04'), 'Ubuntu-24.04');
		assert.strictEqual(distroFromRemoteAuthority(undefined), undefined);
	});

	test('builds wsl.exe args with --cd', () => {
		assert.deepStrictEqual(buildWslExeArgs('/mnt/d/projects/demo', 'Ubuntu-24.04'), [
			'-d',
			'Ubuntu-24.04',
			'--cd',
			'/mnt/d/projects/demo',
		]);
		assert.deepStrictEqual(buildWslExeArgs('/home/neo/project'), ['--cd', '/home/neo/project']);
	});

	test('toWslLinuxPath converts Windows paths on local-windows only', () => {
		const shadow =
			'C:\\Users\\Administrator\\.local\\share\\wsldeck-extension\\workspaces\\abc\\session-1';
		assert.strictEqual(
			toWslLinuxPath(shadow, 'local-windows'),
			'/mnt/c/Users/Administrator/.local/share/wsldeck-extension/workspaces/abc/session-1',
		);
		assert.strictEqual(toWslLinuxPath('/home/neo/project', 'local-windows'), '/home/neo/project');
		assert.strictEqual(toWslLinuxPath('/home/neo/shadow', 'wsl-remote'), '/home/neo/shadow');
		assert.strictEqual(toWslLinuxPath(undefined, 'local-windows'), undefined);
	});

	test('parseDefaultRouteGateway reads default route gateway IP', () => {
		assert.strictEqual(
			parseDefaultRouteGateway('default via 172.24.96.1 dev eth0 proto kernel\n'),
			'172.24.96.1',
		);
		assert.strictEqual(parseDefaultRouteGateway('172.24.96.1\n'), '172.24.96.1');
		assert.strictEqual(parseDefaultRouteGateway(''), undefined);
	});
});
