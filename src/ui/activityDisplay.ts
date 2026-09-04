import * as path from 'node:path';
import type { ActivityItem } from './messageProtocol';

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** True when `rel` escapes the shadow root (not a same-root segment like `..generated`). */
function relativeEscapesShadow(rel: string): boolean {
	return rel === '..' || rel.startsWith(`..${path.sep}`) || rel.startsWith('../');
}

/** Map an absolute path under the shadow cwd to a workspace-relative path. */
export function shadowPathToWorkspaceRelative(absPath: string, shadowCwd: string): string {
	const normShadow = path.resolve(shadowCwd);
	const normPath = path.resolve(absPath);
	if (normPath === normShadow) {
		return '.';
	}
	const rel = path.relative(normShadow, normPath);
	if (!rel || relativeEscapesShadow(rel) || path.isAbsolute(rel)) {
		return absPath;
	}
	return rel.split(path.sep).join('/');
}

/** Shadow path segment: exact root or root + `/child…`, never a sibling prefix like `session-old`. */
function shadowPathPattern(normShadow: string): RegExp {
	const escaped = escapeRegExp(normShadow);
	return new RegExp(
		escaped + '(?:/[^\\s\'"`&;|)]*)?(?=[\\s\'"`&;|)]|$|&&)',
		'g',
	);
}

/** Strip `cd <shadow…> &&` only when cd target is under the shadow cwd. */
function stripShadowCdPrefix(text: string, normShadow: string): string {
	const escaped = escapeRegExp(normShadow);
	const quoted = new RegExp(
		`\\bcd\\s+(['"])${escaped}(?:/[^'"]*)?\\1\\s*&&\\s*`,
		'g',
	);
	const bare = new RegExp(`\\bcd\\s+${escaped}(?:/[^\\s'";&|)]*)?\\s*&&\\s*`, 'g');
	return text.replace(quoted, '').replace(bare, '');
}

/** Replace shadow absolute paths in free-form tool text (labels, commands, paths). */
export function rewriteShadowPathsInText(text: string, shadowCwd: string): string {
	const trimmed = text.trim();
	if (!trimmed || !shadowCwd.trim()) {
		return text;
	}
	const normShadow = path.resolve(shadowCwd);
	let result = stripShadowCdPrefix(text, normShadow);
	result = result.replace(shadowPathPattern(normShadow), (match) =>
		shadowPathToWorkspaceRelative(match, normShadow),
	);
	return result;
}

export function normalizeActivityForDisplay(
	item: ActivityItem,
	shadowCwd?: string,
): ActivityItem {
	if (!shadowCwd?.trim()) {
		return item;
	}
	return {
		...item,
		label: rewriteShadowPathsInText(item.label, shadowCwd),
		name: rewriteShadowPathsInText(item.name, shadowCwd),
		detail: item.detail ? rewriteShadowPathsInText(item.detail, shadowCwd) : item.detail,
	};
}
