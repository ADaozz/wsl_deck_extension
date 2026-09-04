import * as assert from 'node:assert';
import {
	buildLinuxCliLaunch,
	LinuxCliBridgeError,
	mergeLinuxCliContext,
	runLinuxCli,
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
		const launch = buildLinuxCliLaunch(ctx, ['/home/neo/.local/bin/agent', 'acp'], {
			CURSOR_API_KEY: 'test-key',
		});
		assert.strictEqual(launch.executable, process.platform === 'win32' ? 'wsl.exe' : 'wsl');
		assert.ok(launch.args.includes('env'));
		assert.ok(launch.args.includes('CURSOR_API_KEY=test-key'));
		assert.ok(launch.args.includes('/home/neo/.local/bin/agent'));
		assert.ok(launch.args.includes('acp'));
	});

	test('local-windows unsets stale CURSOR_API_KEY via env -u', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-windows', linuxCwd: '/mnt/c/project' },
		);
		const launch = buildLinuxCliLaunch(
			ctx,
			['/home/neo/.local/bin/agent', 'acp'],
			{ PATH: '/home/neo/.local/bin:/usr/bin' },
			['CURSOR_API_KEY'],
		);
		assert.ok(launch.args.includes('-u'));
		assert.ok(launch.args.includes('CURSOR_API_KEY'));
	});

	test('local-windows passes HTTPS_PROXY from resolved agent env', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-windows', linuxCwd: '/mnt/d/vue/demo' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['/usr/local/bin/codex', 'exec'], {
			PATH: '/home/neo/.local/bin:/usr/bin',
			HTTPS_PROXY: 'http://127.0.0.1:7890',
		});
		assert.ok(launch.args.includes('HTTPS_PROXY=http://127.0.0.1:7890'));
		assert.ok(launch.args.includes('PATH=/home/neo/.local/bin:/usr/bin'));
		assert.ok(launch.args.includes('/usr/local/bin/codex'));
	});

	test('local-linux passes argv through without wsl.exe', () => {
		const ctx = mergeLinuxCliContext(
			{ host: 'local-linux', linuxCwd: '/home/neo/project' },
		);
		const launch = buildLinuxCliLaunch(ctx, ['codex', 'debug', 'models']);
		assert.strictEqual(launch.executable, 'codex');
		assert.deepStrictEqual(launch.args, ['debug', 'models']);
	});

	test('local-linux removes an API key from the spawned process environment', async () => {
		const ctx = mergeLinuxCliContext({ host: 'local-linux', linuxCwd: process.cwd() });
		const { stdout } = await runLinuxCli(
			ctx,
			[
				process.execPath,
				'-e',
				'process.stdout.write(process.env.CURSOR_API_KEY ?? "unset")',
			],
			{
				linuxEnv: { CURSOR_API_KEY: 'test-key' },
				unsetEnvKeys: ['CURSOR_API_KEY'],
			},
		);
		assert.strictEqual(stdout, 'unset');
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
