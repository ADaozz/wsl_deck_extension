import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ShadowWorkspace } from '../shadow/shadowWorkspaceManager';

/** Per-path baseline snapshots updated after each successful Keep. */
export function baselineOverlayRoot(shadow: ShadowWorkspace): string {
	return path.join(
		shadow.shadowCwd,
		'..',
		`${path.basename(shadow.shadowCwd)}.baseline-overlay`,
	);
}

export function baselineOverlayPath(shadow: ShadowWorkspace, relativePath: string): string {
	return path.join(baselineOverlayRoot(shadow), relativePath.replace(/\\/g, '/'));
}

export function readBaselineOverlay(
	shadow: ShadowWorkspace,
	relativePath: string,
): string | undefined {
	const p = baselineOverlayPath(shadow, relativePath);
	if (!fs.existsSync(p)) {
		return undefined;
	}
	return fs.readFileSync(p, 'utf8');
}

/** Marker file meaning the path was deleted at last Keep. */
export function isBaselineOverlayDeleted(shadow: ShadowWorkspace, relativePath: string): boolean {
	return fs.existsSync(`${baselineOverlayPath(shadow, relativePath)}.__deleted__`);
}

export function advanceBaselineOverlay(
	shadow: ShadowWorkspace,
	relativePath: string,
	shadowPath: string,
	kind: 'added' | 'modified' | 'deleted' | 'renamed',
): void {
	const rel = relativePath.replace(/\\/g, '/');
	const root = baselineOverlayRoot(shadow);
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
	if (!fs.existsSync(shadowPath)) {
		return;
	}
	fs.mkdirSync(path.dirname(overlayPath), { recursive: true });
	fs.copyFileSync(shadowPath, overlayPath);
}
