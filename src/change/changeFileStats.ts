import * as fs from 'node:fs';

const BINARY_SUFFIXES = [
	'.tar.gz',
	'.tgz',
	'.zip',
	'.jar',
	'.war',
	'.ear',
	'.gz',
	'.bz2',
	'.xz',
	'.7z',
	'.rar',
	'.png',
	'.jpg',
	'.jpeg',
	'.gif',
	'.webp',
	'.ico',
	'.pdf',
	'.exe',
	'.dll',
	'.so',
	'.dylib',
	'.class',
	'.woff',
	'.woff2',
	'.ttf',
	'.eot',
	'.mp4',
	'.mp3',
	'.avi',
	'.mov',
	'.sqlite',
	'.db',
];

/** Max bytes read when sniffing file content for line stats. */
const SNIFF_BYTES = 8192;

/** Files larger than this are treated as binary for diff stat display. */
const MAX_TEXT_STAT_BYTES = 512 * 1024;

export function isBinaryChangePath(relPath: string): boolean {
	const normalized = relPath.replace(/\\/g, '/').toLowerCase();
	for (const suffix of BINARY_SUFFIXES) {
		if (normalized.endsWith(suffix)) {
			return true;
		}
	}
	return false;
}

export function isBinaryFile(absPath: string): boolean {
	try {
		const stat = fs.statSync(absPath);
		if (!stat.isFile()) {
			return true;
		}
		if (stat.size > MAX_TEXT_STAT_BYTES) {
			return true;
		}
		if (isBinaryChangePath(absPath)) {
			return true;
		}
		const fd = fs.openSync(absPath, 'r');
		try {
			const buf = Buffer.alloc(Math.min(SNIFF_BYTES, stat.size));
			const read = fs.readSync(fd, buf, 0, buf.length, 0);
			return buf.subarray(0, read).includes(0);
		} finally {
			fs.closeSync(fd);
		}
	} catch {
		return true;
	}
}

/** Line stats for UI badges; binary/large files report 0/0 instead of reading whole file. */
export function lineStatsForFile(absPath: string): { additions: number; deletions: number } {
	if (isBinaryFile(absPath)) {
		return { additions: 0, deletions: 0 };
	}
	try {
		const text = fs.readFileSync(absPath, 'utf8');
		const lines = text.length === 0 ? 0 : text.split(/\r?\n/).length;
		return { additions: lines, deletions: 0 };
	} catch {
		return { additions: 0, deletions: 0 };
	}
}
