/**
 * Parse Codex `exec --json` JSONL lines into loose records.
 * Keep tolerant — CLI schema evolves; UI must not depend on Codex field names.
 */

import { toolCompletedOk } from '../../../ui/commandExitHeuristic';

export interface CodexJsonLine {
	type?: string;
	thread_id?: string;
	item?: {
		id?: string;
		type?: string;
		text?: string;
		command?: string;
		status?: string;
		query?: string;
		server?: string;
		tool?: string;
		[key: string]: unknown;
	};
	error?: { message?: string };
	message?: string;
	[key: string]: unknown;
}

export function parseCodexJsonLine(line: string): CodexJsonLine | undefined {
	const trimmed = line.trim();
	if (!trimmed) {
		return undefined;
	}
	try {
		return JSON.parse(trimmed) as CodexJsonLine;
	} catch {
		return undefined;
	}
}

export function codexItemToolName(item: NonNullable<CodexJsonLine['item']>): string {
	if (item.type === 'mcp_tool_call') {
		const server = typeof item.server === 'string' ? item.server : undefined;
		const tool = typeof item.tool === 'string' ? item.tool : undefined;
		if (server && tool) {
			return `${server}/${tool}`;
		}
		return tool ?? server ?? 'mcp_tool_call';
	}
	if (typeof item.type === 'string' && item.type.length > 0) {
		return item.type;
	}
	return 'tool';
}

export function codexItemDetail(item: NonNullable<CodexJsonLine['item']>): string | undefined {
	if (typeof item.command === 'string' && item.command.trim()) {
		return item.command.trim();
	}
	for (const key of ['path', 'file_path', 'filePath', 'file']) {
		const value = item[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	if (typeof item.query === 'string' && item.query.trim()) {
		return item.query.trim();
	}
	if (typeof item.text === 'string' && item.type !== 'agent_message') {
		const t = item.text.trim();
		return t.length > 120 ? `${t.slice(0, 117)}…` : t;
	}
	return undefined;
}

/** Codex JSONL item → UI fold bucket (provider schema, not a tool-name enum). */
export function codexItemActivityGroup(
	item: NonNullable<CodexJsonLine['item']>,
): 'commands' | 'tools' | undefined {
	if (typeof item.type === 'string') {
		const type = item.type.trim().toLowerCase();
		if (type === 'agent_message' || type === 'reasoning') {
			return undefined;
		}
	}
	if (typeof item.command === 'string' && item.command.trim()) {
		return 'commands';
	}
	if (typeof item.type === 'string' && item.type.trim()) {
		const type = item.type.trim().toLowerCase().replace(/-/g, '_');
		if (type.includes('command') && type.includes('exec')) {
			return 'commands';
		}
		if (type === 'shell' || type.startsWith('shell_') || type.endsWith('_shell')) {
			return 'commands';
		}
	}
	return 'tools';
}

/** Non-shell Codex items may change workspace files — confirmed on disk via shadow diff. */
export function codexItemMutatesWorkspace(
	item: NonNullable<CodexJsonLine['item']>,
): boolean {
	return codexItemActivityGroup(item) === 'tools';
}

function codexItemCommand(item: NonNullable<CodexJsonLine['item']>): string | undefined {
	if (typeof item.command === 'string' && item.command.trim()) {
		return item.command.trim();
	}
	return undefined;
}

function codexItemExitCode(item: NonNullable<CodexJsonLine['item']>): number | undefined {
	for (const key of ['exit_code', 'exitCode', 'return_code', 'returnCode']) {
		const value = item[key];
		if (typeof value === 'number' && Number.isFinite(value)) {
			return value;
		}
	}
	return undefined;
}

/** Map Codex item completion to UI ok — rg/grep exit 1 is not a failure. */
export function codexItemCompletedOk(item: NonNullable<CodexJsonLine['item']>): boolean {
	const status = typeof item.status === 'string' ? item.status : undefined;
	return toolCompletedOk(codexItemCommand(item), status, codexItemExitCode(item));
}
