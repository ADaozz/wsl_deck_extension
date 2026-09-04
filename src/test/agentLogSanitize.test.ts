import * as assert from 'node:assert';
import { sanitizeAgentLogLine } from '../agent/agentLogSanitize';

suite('agentLogSanitize', () => {
	test('escapes ASCII control characters', () => {
		assert.strictEqual(sanitizeAgentLogLine('a\x07b'), 'a\\x07b');
	});

	test('decodes UTF-16 LE stderr misread as latin1', () => {
		const raw = Buffer.from('warn: something failed', 'utf16le').toString('latin1');
		assert.strictEqual(sanitizeAgentLogLine(raw), 'warn: something failed');
	});

	test('preserves normal UTF-8 text', () => {
		assert.strictEqual(sanitizeAgentLogLine('HTTPS_PROXY=set'), 'HTTPS_PROXY=set');
	});

	test('does not misdecode large Unicode JSON with zero low-byte code units', () => {
		const line = JSON.stringify({
			jsonrpc: '2.0',
			result: `正常中文内容${'一'.repeat(8)}${' review output'.repeat(100)}`,
		});
		assert.strictEqual(sanitizeAgentLogLine(line), line);
	});
});
