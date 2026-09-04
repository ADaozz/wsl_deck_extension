import * as fs from 'node:fs';
import * as path from 'node:path';
import { sessionDeckDir } from '../state/workspaceDeckStore';
import type { SessionBaseline } from '../session/sessionBaseline';

/** Per-path baseline snapshots updated after each successful Keep. */
export function baselineOverlayRoot(baseline: SessionBaseline): string {
	return path.join(sessionDeckDir(baseline.mainCwd, baseline.sessionId), 'baseline-overlay');
}

export function baselineOverlayPath(baseline: SessionBaseline, relativePath: string): string {
	return path.join(baselineOverlayRoot(baseline), relativePath.replace(/\\/g, '/'));
}

export function readBaselineOverlay(
	baseline: SessionBaseline,
	relativePath: string,
): string | undefined {
	const p = baselineOverlayPath(baseline, relativePath);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	return fs.readFileSync(p, 'utf8');
}

/** Marker file meaning the path was deleted at last Keep. */
export function isBaselineOverlayDeleted(
	baseline: SessionBaseline,
	relativePath: string,
): boolean {
	return fs.existsSync(`${baselineOverlayPath(baseline, relativePath)}.__deleted__`);
}

export function advanceBaselineOverlay(
	baseline: SessionBaseline,
	relativePath: string,
	mainPath: string,
	kind: 'added' | 'modified' | 'deleted' | 'renamed',
): void {
	const rel = relativePath.replace(/\\/g, '/');
	const root = baselineOverlayRoot(baseline);
	const overlayPath = path.join(root, rel);
	const deletedMarker = `${overlayPath}.__deleted__`;

	if (kind === 'deleted') {
		if (fs.existsSync(overlayPath)) {
			fs.rmSync(overlayPath, { force: true });
		}
		fs.mkdirSync(path.dirname(deletedMarker), { recursive: true });
		fs.writeFileSync(deletedMarker, '', 'utf8');
		return;
	}

	if (fs.existsSync(deletedMarker)) {
		fs.rmSync(deletedMarker, { force: true });
	}
	if (!fs.existsSync(mainPath)) {
		return;
	}
	fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
	fs.copyFileSync(mainPath, overlayPath);
}
