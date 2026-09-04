import * as assert from 'node:assert';
import {
	agentEnvForLog,
	filterHostEnv,
	mergeLinuxAgentEnvLayers,
	parsePrintenv0,
} from '../workspace/linuxAgentEnvironment';

suite('linuxAgentEnvironment', () => {
	test('parsePrintenv0 parses NUL-delimited entries and allowlist', () => {
		const raw = Buffer.from(
			'PATH=/usr/bin\0HOME=/home/neo\0SECRET=hidden\0HTTPS_PROXY=http://proxy:8080\0',
		);
		const env = parsePrintenv0(raw);
		assert.strictEqual(env.PATH, '/usr/bin');
		assert.strictEqual(env.HOME, '/home/neo');
		assert.strictEqual(env.HTTPS_PROXY, 'http://proxy:8080');
		assert.strictEqual(env.SECRET, undefined);
	});

	test('parsePrintenv0 keeps LC_ and NODE_ prefixes', () => {
		const raw = Buffer.from('LC_TIME=C\0NODE_OPTIONS=--max-old-space-size=4096\0');
		const env = parsePrintenv0(raw);
		assert.strictEqual(env.LC_TIME, 'C');
		assert.strictEqual(env.NODE_OPTIONS, '--max-old-space-size=4096');
	});

	test('filterHostEnv applies allowlist to process env shape', () => {
		const env = filterHostEnv({
			PATH: '/bin',
			RANDOM_WINDOWS_VAR: 'x',
			http_proxy: 'http://127.0.0.1:7890',
		});
		assert.strictEqual(env.PATH, '/bin');
		assert.strictEqual(env.http_proxy, 'http://127.0.0.1:7890');
		assert.strictEqual(env.RANDOM_WINDOWS_VAR, undefined);
	});

	test('mergeLinuxAgentEnvLayers: settings override probe, caller overrides settings', () => {
		const base = { PATH: '/usr/bin', HTTPS_PROXY: 'http://probe:8080' };
		const configured = { HTTPS_PROXY: 'http://settings:9090' };
		const merged = mergeLinuxAgentEnvLayers(base, configured, {
			HTTPS_PROXY: 'http://override:3128',
		});
		assert.strictEqual(merged.PATH, '/usr/bin');
		assert.strictEqual(merged.HTTPS_PROXY, 'http://override:3128');

		const fromSettings = mergeLinuxAgentEnvLayers(base, configured);
		assert.strictEqual(fromSettings.HTTPS_PROXY, 'http://settings:9090');

		const cleared = mergeLinuxAgentEnvLayers(base, configured, { HTTPS_PROXY: '' });
		assert.strictEqual(cleared.HTTPS_PROXY, undefined);
	});

	test('caller can remove Cursor API keys from both probed and configured env', () => {
		const fromProbe = mergeLinuxAgentEnvLayers(
			{ CURSOR_API_KEY: 'probe-key' },
			{},
			{ CURSOR_API_KEY: undefined },
		);
		assert.strictEqual(fromProbe.CURSOR_API_KEY, undefined);

		const fromSettings = mergeLinuxAgentEnvLayers(
			{},
			{ CURSOR_API_KEY: 'settings-key' },
			{ CURSOR_API_KEY: undefined },
		);
		assert.strictEqual(fromSettings.CURSOR_API_KEY, undefined);
	});

	test('ACP overrides can disable browser login while clearing API keys', () => {
		const merged = mergeLinuxAgentEnvLayers(
			{ CURSOR_API_KEY: 'probe-key' },
			{ NO_OPEN_BROWSER: '0' },
			{ CURSOR_API_KEY: undefined, NO_OPEN_BROWSER: '1' },
		);
		assert.strictEqual(merged.CURSOR_API_KEY, undefined);
		assert.strictEqual(merged.NO_OPEN_BROWSER, '1');
	});

	test('agentEnvForLog masks secrets and summarizes PATH', () => {
		const summary = agentEnvForLog({
			PATH: '/a:/b:/c',
			HOME: '/home/neo',
			HTTPS_PROXY: 'http://proxy',
			CURSOR_API_KEY: 'sk-secret',
		});
		assert.ok(summary.includes('HTTPS_PROXY=set'));
		assert.ok(summary.includes('PATH=3 dirs'));
		assert.ok(summary.includes('HOME=/home/neo'));
		assert.ok(summary.includes('CURSOR_API_KEY=set'));
		assert.ok(!summary.includes('sk-secret'));
	});
});
