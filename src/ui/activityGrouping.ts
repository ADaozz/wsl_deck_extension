import type { ToolMetadata } from '../agent/agentEvents';
import type { ActivityItem } from './messageProtocol';

/** UI fold buckets — assigned by providers from event structure, not tool-name enums. */
export type ActivityGroup = 'commands' | 'tools';

export function isCommandsActivity(item: ActivityItem): boolean {
	if (item.activityGroup === 'commands') {
		return true;
	}
	if (item.activityGroup === 'tools') {
		return false;
	}
	return legacyCommandsActivity(item);
}

export function isToolsActivity(item: ActivityItem): boolean {
	if (item.activityGroup === 'tools') {
		return true;
	}
	if (item.activityGroup === 'commands') {
		return false;
	}
	return !legacyCommandsActivity(item);
}

/** Row may have changed files — use for diff stat stamping, not tool-name matching. */
export function isFileMutatingActivity(item: ActivityItem): boolean {
	if (item.mutatesWorkspace) {
		return true;
	}
	const kind = item.kind?.trim().toLowerCase();
	if (kind === 'edit' || kind === 'delete' || kind === 'write') {
		return true;
	}
	const detail = item.detail?.trim();
	if (detail && detailLooksLikePath(detail)) {
		return true;
	}
	return isFileChangeToolName(item.name);
}

/** @deprecated use isFileMutatingActivity */
export function isEditActivity(item: ActivityItem): boolean {
	return isFileMutatingActivity(item);
}

function detailLooksLikePath(detail: string): boolean {
	return (
		detail.includes('/') ||
		detail.includes('\\') ||
		/\.[a-z0-9]{1,8}$/i.test(detail)
	);
}

export function activityPathHint(item: ActivityItem): string | undefined {
	const detail = item.detail?.trim();
	if (!detail) {
		return undefined;
	}
	return detail.replace(/\\/g, '/');
}

export function isFileChangeToolName(name: string): boolean {
	const n = name.trim().toLowerCase();
	return n === 'file_change' || n === 'filechange' || n.includes('file_change');
}

/**
 * Re-scan workspace after any tool completes.
 * File add/delete/modify is detected from disk — not from tool title/kind enums.
 */
export function shouldRefreshChangesForTool(_tool: ToolMetadata): boolean {
	return true;
}

function legacyCommandsActivity(item: ActivityItem): boolean {
	const name = item.name.trim().toLowerCase().replace(/-/g, '_');
	if (name.includes('command') && name.includes('exec')) {
		return true;
	}
	if (name === 'shell' || name.startsWith('shell_') || name.endsWith('_shell')) {
		return true;
	}
	const kind = item.kind?.trim().toLowerCase();
	if (kind === 'shell' || kind === 'execute' || kind === 'terminal') {
		return true;
	}
	return false;
}
