import * as assert from 'node:assert';
import { formatAgentLogLine } from '../agent/agentRawLog';
import {
	codexItemActivityGroup,
	codexItemCompletedOk,
	codexItemDetail,
	codexItemToolName,
	parseCodexJsonLine,
} from '../agent/providers/codex/codexEvents';
import { buildCodexExecArgs } from '../agent/providers/codex/codexProcess';
import { parseCursorModelList, parseAcpAvailableModels } from '../agent/providers/cursor/cursorAcpClient';
import { cursorLoginMethod } from '../agent/providers/cursor/cursorProvider';
import {
	acpTextChunk,
	acpToolMutatesWorkspace,
	acpToolActivityGroup,
	acpToolDetail,
	acpToolIdentity,
	extractAcpUpdate,
	normalizeAcpToolCallId,
	parseAcpPermissionRequest,
} from '../agent/providers/cursor/cursorEvents';
import { activityFromTool } from '../ui/messageProtocol';
import { isCommandsActivity } from '../ui/activityGrouping';

suite('real provider parsers', () => {
	test('formats raw agent log lines', () => {
		const line = formatAgentLogLine('codex', '<<', '{"type":"thread.started"}');
		assert.match(line, /\[codex\] << \{"type":"thread\.started"\}/);
	});
	test('parses Codex JSONL tool and message items', () => {
		const started = parseCodexJsonLine(
			'{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}',
		);
		assert.ok(started?.item);
		assert.strictEqual(codexItemToolName(started.item), 'command_execution');
		assert.strictEqual(codexItemDetail(started.item), 'bash -lc ls');
		assert.strictEqual(codexItemActivityGroup(started.item), 'commands');
		const read = parseCodexJsonLine(
			'{"type":"item.started","item":{"id":"item_2","type":"read","path":"src/a.py"}}',
		);
		assert.ok(read?.item);
		assert.strictEqual(codexItemActivityGroup(read.item), 'tools');
		assert.ok(
			isCommandsActivity(
				activityFromTool(
					{
						toolCallId: '1',
						name: 'command_execution',
						detail: 'bash -lc ls',
						activityGroup: 'commands',
					},
					'completed',
				),
			),
		);

		const msg = parseCodexJsonLine(
			'{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"hello"}}',
		);
		assert.strictEqual(msg?.item?.text, 'hello');
	});

	test('codexItemCompletedOk treats rg exit 1 as success', () => {
		assert.strictEqual(
			codexItemCompletedOk({
				type: 'command_execution',
				command: 'rg needle src/',
				status: 'failed',
				exit_code: 1,
			}),
			true,
		);
		assert.strictEqual(
			codexItemCompletedOk({
				type: 'command_execution',
				command: 'npm test',
				status: 'failed',
				exit_code: 1,
			}),
			false,
		);
	});

	test('builds Codex exec / resume argv', () => {
		const args = buildCodexExecArgs({ prompt: 'hi', modelId: 'gpt-5', cwd: '/tmp/proj' });
		assert.deepStrictEqual(args.slice(0, 8), [
			'exec',
			'--json',
			'-m',
			'gpt-5',
			'-C',
			'/tmp/proj',
			'--skip-git-repo-check',
			'--approve-for-me',
		]);
		assert.strictEqual(args[8], 'hi');

		const withReasoning = buildCodexExecArgs({
			prompt: 'hi',
			modelId: 'gpt-5.6-sol',
			reasoningId: 'high',
		});
		assert.ok(withReasoning.includes('-c'));
		assert.ok(withReasoning.some((a) => a.includes('model_reasoning_effort="high"')));
		assert.ok(withReasoning.includes('--approve-for-me'));
		assert.ok(!withReasoning.includes('--sandbox'));
		const resume = buildCodexExecArgs({
			prompt: 'again',
			resumeId: 'thread-1',
			modelId: 'gpt-5.4-mini',
			cwd: '/tmp/shadow',
		});
		assert.deepStrictEqual(resume.slice(0, 10), [
			'exec',
			'--json',
			'-m',
			'gpt-5.4-mini',
			'-C',
			'/tmp/shadow',
			'--skip-git-repo-check',
			'--approve-for-me',
			'resume',
			'thread-1',
		]);
		assert.strictEqual(resume[10], 'again');
	});

	test('parses Cursor --list-models output', () => {
		const models = parseCursorModelList(
			'Available models\n\nauto - Auto\ncomposer-2.5 - Composer 2.5\n',
		);
		assert.deepStrictEqual(models, [
			{ id: 'auto', label: 'Auto' },
			{ id: 'composer-2.5', label: 'Composer 2.5' },
		]);
	});

	test('parses Cursor bare model ids and ACP availableModels', () => {
		const bare = parseCursorModelList('Available models:\ngpt-5.1\nclaude-4-sonnet\n');
		assert.ok(bare.some((m) => m.id === 'gpt-5.1'));
		assert.ok(bare.some((m) => m.id === 'claude-4-sonnet'));

		const acp = parseAcpAvailableModels({
			models: {
				availableModels: [
					{ modelId: 'composer-2', name: 'Composer 2' },
					{ id: 'auto', name: 'Auto' },
				],
			},
		});
		assert.deepStrictEqual(acp, [
			{ id: 'composer-2', label: 'Composer 2' },
			{ id: 'auto', label: 'Auto' },
		]);
	});

	test('selects cursor_login only when initialize advertises it', () => {
		assert.strictEqual(
			cursorLoginMethod({ authMethods: [{ id: 'cursor_login' }] }),
			'cursor_login',
		);
		assert.strictEqual(cursorLoginMethod({ authMethods: [{ id: 'api_key' }] }), undefined);
		assert.strictEqual(cursorLoginMethod(undefined), undefined);
	});

	test('extracts ACP session update wrapper', () => {
		const update = extractAcpUpdate({
			update: { sessionUpdate: 'agent_message_chunk', content: { text: 'Hi' } },
		});
		assert.strictEqual(update?.sessionUpdate, 'agent_message_chunk');
		assert.strictEqual(acpTextChunk(update!), 'Hi');
	});

	test('acpToolIdentity uses ACP title as label', () => {
		const id = acpToolIdentity({
			sessionUpdate: 'tool_call',
			toolCallId: 'call-a\nfc_b',
			title: 'Read File',
			kind: 'read',
			status: 'pending',
			rawInput: {},
		});
		assert.strictEqual(id.title, 'Read File');
		assert.strictEqual(id.name, 'Read File');
		assert.strictEqual(id.kind, 'read');
		assert.strictEqual(id.detail, undefined);
		assert.strictEqual(normalizeAcpToolCallId('call-a\nfc_b'), 'call-afc_b');
		assert.strictEqual(
			acpToolIdentity({ kind: 'tool', rawInput: { path: 'src/x.ts' } }).name,
			'src/x.ts',
		);
	});

	test('acpToolActivityGroup detects shell commands and tool rows', () => {
		assert.strictEqual(
			acpToolActivityGroup({
				kind: 'shell',
				title: 'Run command',
				rawInput: { command: 'pytest -q' },
			}),
			'commands',
		);
		assert.strictEqual(
			acpToolActivityGroup({
				kind: 'read',
				title: 'Read File',
				rawInput: { path: 'src/x.ts' },
				toolCallId: 'call-1',
			}),
			'tools',
		);
		assert.ok(
			isCommandsActivity(
				activityFromTool(
					{
						toolCallId: '2',
						name: 'Run command',
						title: 'Run command',
						kind: 'shell',
						detail: 'pytest -q',
						activityGroup: 'commands',
					},
					'completed',
				),
			),
		);
	});

	test('acpToolMutatesWorkspace detects diff content on delete', () => {
		assert.strictEqual(
			acpToolMutatesWorkspace({
				status: 'completed',
				content: [
					{
						type: 'diff',
						path: '/tmp/shadow/测试.md',
						oldText: '/tmp/shadow/测试.md',
						newText: '',
					},
				],
			}),
			true,
		);
	});

	test('acpToolDetail reads path from completed diff content', () => {
		assert.strictEqual(
			acpToolDetail({
				content: [
					{
						type: 'diff',
						path: '/tmp/shadow/测试.md',
						oldText: '-- /dev/null',
						newText: '++ b//tmp/shadow/测试.md\nline1\nline2',
					},
				],
			}),
			'/tmp/shadow/测试.md',
		);
	});

	test('parses ACP permission request title and options', () => {
		const parsed = parseAcpPermissionRequest({
			sessionId: 's1',
			toolCall: {
				toolCallId: 'call-x\nfc_y',
				title: 'Delete `/home/neo/project/test.txt`',
				kind: 'edit',
				status: 'pending',
			},
			options: [
				{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
				{ optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
				{ optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
			],
		});
		assert.strictEqual(parsed.title, 'Delete `/home/neo/project/test.txt`');
		assert.strictEqual(parsed.kind, 'edit');
		assert.strictEqual(parsed.options.length, 3);
		assert.strictEqual(parsed.options[0].optionId, 'allow-once');
	});
});
