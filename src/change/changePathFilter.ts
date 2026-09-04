/** Paths never shown as proposed-change cards (build artifacts, deck state, caches). */
const IGNORED_SEGMENTS = new Set([
	'.WSLDeck',
	'.git',
	'node_modules',
	'.vscode-test',
	'dist',
	'out',
	'build',
	'.next',
	'coverage',
	'.cursor',
	'.venv',
	'venv',
	'.artifacts',
	'.run',
	'target',
]);

const IGNORED_SUFFIXES = ['.map', '.vsix'];

/**
 * True when a repo-relative path should not surface as a proposed change card.
 */
export function isIgnoredChangePath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, '/').replace(/^\.\/+/, '');
	if (!normalized || normalized === '.') {
		return true;
	}
	const parts = normalized.split('/');
	for (const part of parts) {
		if (IGNORED_SEGMENTS.has(part)) {
			return true;
		}
	}
	const base = parts[parts.length - 1] ?? '';
	if (IGNORED_SUFFIXES.some((s) => base.endsWith(s))) {
		return true;
	}
	// VS Code test user-data cache blobs
	if (parts.includes('Cache_Data')) {
		return true;
	}
	return false;
}

export function filterTrackedChanges<T extends { path: string }>(changes: T[]): T[] {
	return changes.filter((c) => !isIgnoredChangePath(c.path));
}
