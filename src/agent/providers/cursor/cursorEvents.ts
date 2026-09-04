/**
 * Best-effort mapping from ACP session/update payloads.
 * Display labels come from `title` (e.g. "Read File"), never from a fixed tool enum.
 */

import type { PermissionOption } from '../../agentEvents';
import { toolCompletedOk } from '../../../ui/commandExitHeuristic';

export interface AcpSessionUpdate {
	sessionUpdate?: string;
	content?:
		| { type?: string; text?: string }
		| Array<{ type?: string; path?: string; oldText?: string; newText?: string; text?: string }>;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
	locations?: Array<{ path?: string }>;
	[key: string]: unknown;
}

export function extractAcpUpdate(params: unknown): AcpSessionUpdate | undefined {
	if (!params || typeof params !== 'object') {
		return undefined;
	}
	const p = params as { update?: AcpSessionUpdate; sessionUpdate?: string };
	if (p.update && typeof p.update === 'object') {
		return p.update;
	}
	return p as AcpSessionUpdate;
}

function firstString(...values: unknown[]): string | undefined {
	for (const v of values) {
		if (typeof v === 'string' && v.trim()) {
			return v.trim();
		}
	}
	return undefined;
}

function detailFromRawInput(raw: unknown): string | undefined {
	if (raw === null || raw === undefined) {
		return undefined;
	}
	if (typeof raw !== 'object') {
		const text = String(raw).trim();
		return text || undefined;
	}
	const o = raw as Record<string, unknown>;
	if (Object.keys(o).length === 0) {
		return undefined;
	}
	for (const key of ['command', 'path', 'filePath', 'file', 'query', 'pattern', 'url', 'target', 'uri']) {
		const value = o[key];
		if (typeof value === 'string' && value.trim()) {
			return value.trim();
		}
	}
	try {
		const json = JSON.stringify(raw);
		if (json === '{}' || json === '[]') {
			return undefined;
		}
		return json.length > 120 ? `${json.slice(0, 117)}…` : json;
	} catch {
		return undefined;
	}
}

export function acpTextChunk(update: AcpSessionUpdate): string | undefined {
	const content = update.content;
	if (!content || Array.isArray(content)) {
		return undefined;
	}
	return typeof content.text === 'string' ? content.text : undefined;
}

export function acpToolDetail(update: AcpSessionUpdate): string | undefined {
	if (Array.isArray(update.content)) {
		for (const block of update.content) {
			if (!block || typeof block !== 'object') {
				continue;
			}
			const row = block as { type?: string; path?: string };
			if (typeof row.path === 'string' && row.path.trim()) {
				return row.path.trim();
			}
		}
	}
	const fromLoc = update.locations?.find((l) => typeof l.path === 'string' && l.path.trim())?.path;
	if (fromLoc?.trim()) {
		return fromLoc.trim();
	}
	return detailFromRawInput(update.rawInput);
}

/** Normalize ACP toolCallId (may contain embedded newlines). */
export function normalizeAcpToolCallId(id: string | undefined): string {
	if (!id) {
		return '';
	}
	return id.replace(/\s+/g, '').trim();
}

/**
 * UI identity: **title** is the category/label ("Read File").
 * `kind` is secondary metadata only ("read").
 */
export function acpToolIdentity(update: AcpSessionUpdate): {
	name: string;
	title: string;
	kind?: string;
	detail?: string;
} {
	const title = firstString(update.title);
	const kind = firstString(update.kind);
	const detail = acpToolDetail(update);
	const genericKind = !kind || kind.toLowerCase() === 'tool' || kind.toLowerCase() === 'other';

	const label =
		title ||
		(!genericKind ? kind : undefined) ||
		(detail && detail.length <= 64 ? detail : undefined) ||
		(detail ? `${detail.slice(0, 61)}…` : undefined) ||
		'tool';

	return {
		name: label,
		title: label,
		kind: kind && !genericKind ? kind : undefined,
		detail,
	};
}

/** True when ACP payload includes on-disk file diff content or provider file-mutation kind. */
export function acpToolMutatesWorkspace(update: AcpSessionUpdate): boolean {
	if (Array.isArray(update.content)) {
		for (const block of update.content) {
			if (block && typeof block === 'object' && block.type === 'diff') {
				return true;
			}
		}
	}
	const kind = firstString(update.kind)?.toLowerCase();
	if (kind === 'edit' || kind === 'delete' || kind === 'write') {
		return true;
	}
	return false;
}

/** ACP tool rows → UI fold bucket. */
export function acpToolActivityGroup(update: AcpSessionUpdate): 'commands' | 'tools' | undefined {
	if (update.rawInput && typeof update.rawInput === 'object') {
		const raw = update.rawInput as Record<string, unknown>;
		if (typeof raw.command === 'string' && raw.command.trim()) {
			return 'commands';
		}
	}
	const kind = firstString(update.kind)?.toLowerCase();
	if (kind === 'shell' || kind === 'execute' || kind === 'terminal') {
		return 'commands';
	}
	if (update.toolCallId || update.title || update.kind || update.sessionUpdate) {
		return 'tools';
	}
	if (Array.isArray(update.content) && update.content.length > 0) {
		return 'tools';
	}
	return undefined;
}

export function parseAcpPermissionRequest(params: unknown): {
	toolCallId?: string;
	title?: string;
	kind?: string;
	detail?: string;
	options: PermissionOption[];
} {
	if (!params || typeof params !== 'object') {
		return { options: [] };
	}
	const p = params as {
		toolCall?: AcpSessionUpdate;
		options?: Array<{ optionId?: string; name?: string; kind?: string }>;
	};
	const toolCall = p.toolCall && typeof p.toolCall === 'object' ? p.toolCall : undefined;
	const identity = toolCall ? acpToolIdentity(toolCall) : undefined;
	const options: PermissionOption[] = [];
	if (Array.isArray(p.options)) {
		for (const opt of p.options) {
			if (!opt || typeof opt !== 'object') {
				continue;
			}
			const optionId = typeof opt.optionId === 'string' ? opt.optionId.trim() : '';
			const name = typeof opt.name === 'string' ? opt.name.trim() : '';
			if (!optionId || !name) {
				continue;
			}
			options.push({
				optionId,
				name,
				kind: typeof opt.kind === 'string' ? opt.kind : undefined,
			});
		}
	}
	return {
		toolCallId: typeof toolCall?.toolCallId === 'string' ? toolCall.toolCallId : undefined,
		title: identity?.title,
		kind: identity?.kind ?? firstString(toolCall?.kind),
		detail: identity?.detail,
		options,
	};
}

function acpCommandFromUpdate(update: AcpSessionUpdate): string | undefined {
	if (update.rawInput && typeof update.rawInput === 'object') {
		const raw = update.rawInput as Record<string, unknown>;
		if (typeof raw.command === 'string' && raw.command.trim()) {
			return raw.command.trim();
		}
	}
	return undefined;
}

function acpExitCodeFromUpdate(update: AcpSessionUpdate): number | undefined {
	for (const key of ['exitCode', 'exit_code', 'returnCode', 'return_code']) {
		const top = update[key];
		if (typeof top === 'number' && Number.isFinite(top)) {
			return top;
		}
	}
	if (update.rawInput && typeof update.rawInput === 'object') {
		const raw = update.rawInput as Record<string, unknown>;
		for (const key of ['exitCode', 'exit_code', 'returnCode', 'return_code']) {
			const value = raw[key];
			if (typeof value === 'number' && Number.isFinite(value)) {
				return value;
			}
		}
	}
	return undefined;
}

export function acpToolCompletedOk(update: AcpSessionUpdate): boolean {
	const status = typeof update.status === 'string' ? update.status : undefined;
	return toolCompletedOk(acpCommandFromUpdate(update), status, acpExitCodeFromUpdate(update));
}
