import * as fs from 'node:fs';
import * as path from 'node:path';

const SKIP_DIR_NAMES = new Set([
	'.git',
	'node_modules',
	'.venv',
	'venv',
	'dist',
	'out',
	'build',
	'.next',
	'coverage',
	'.vscode-test',
	'.WSLDeck',
]);

export function ensureDir(dir: string): void {
	fs.mkdirSync(dir, { recursive: true });
}

export async function copyWorkspace(src: string, dest: string): Promise<void> {
	ensureDir(dest);
	await fs.promises.cp(src, dest, {
		recursive: true,
		filter: (source) => {
			const base = path.basename(source);
			if (SKIP_DIR_NAMES.has(base)) {
				return false;
			}
			return true;
		},
	});
}

/** Snapshot main tree into session baseline — skips `.WSLDeck` and avoids cp-into-self. */
export async function snapshotWorkspace(src: string, dest: string): Promise<void> {
	ensureDir(dest);
	const walk = async (dir: string): Promise<void> => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			if (SKIP_DIR_NAMES.has(entry.name)) {
				continue;
			}
			const abs = path.join(dir, entry.name);
			const rel = path.relative(src, abs).replace(/\\/g, '/');
			const target = path.join(dest, rel);
			if (entry.isDirectory()) {
				ensureDir(target);
				await walk(abs);
			} else if (entry.isFile()) {
				ensureDir(path.dirname(target));
				await fs.promises.copyFile(abs, target);
			}
		}
	};
	await walk(src);
}
