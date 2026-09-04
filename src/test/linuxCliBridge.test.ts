import * as assert from 'node:assert';
import {
	buildLinuxCliLaunch,
	LinuxCliBridgeError,
	mergeLinuxCliContext,
} from '../workspace/linuxCliBridge';

suite('linuxCliBridge', () => {
	test('local-windows builds wsl.exe launch with distro, cd, and argv', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-windows', linuxCwd: '/mnt/c/project', distro: 'Ubuntu-24.04' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['codex', 'debug', 'models']);
		assert.strictEqual(launch.executable, process.platform === 'win32' ? 'wsl.exe' : 'wsl');
		assert.deepStrictEqual(launch.args, [
			'-d',
			'Ubuntu-24.04',
			'--cd',
			'/mnt/c/project',
			'--',
			'codex',
			'debug',
			'models',
		]);
	});

	test('local-windows passes env through wsl env wrapper', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-windows', linuxCwd: '/mnt/c/project' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['agent', 'acp'], {
			CURSOR_API_KEY: 'test-key',
		});
		assert.strictEqual(launch.executable, process.platform === 'win32' ? 'wsl.exe' : 'wsl');
		assert.ok(launch.args.includes('env'));
		assert.ok(launch.args.includes('CURSOR_API_KEY=test-key'));
		assert.ok(launch.args.includes('agent'));
		assert.ok(launch.args.includes('acp'));
	});

	test('local-linux passes argv through without wsl.exe', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-linux', linuxCwd: '/home/neo/project' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['codex', 'debug', 'models']);
		assert.strictEqual(launch.executable, 'codex');
		assert.deepStrictEqual(launch.args, ['debug', 'models']);
	});

	test('wsl-remote passes argv through without wsl.exe', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'wsl-remote', linuxCwd: '/home/neo/project', distro: 'Ubuntu-24.04' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['agent', '--list-models']);
		assert.strictEqual(launch.executable, 'agent');
		assert.deepStrictEqual(launch.args, ['--list-models']);
	});

	test('local-windows without linuxCwd throws', () => {
		const ctx = mergeLinuxCliContext({ host: 'local-windows' });
		assert.throws(() => buildLinuxCliLaunch(ctx, ['codex', 'debug', 'models']), LinuxCliBridgeError);
	});
});
