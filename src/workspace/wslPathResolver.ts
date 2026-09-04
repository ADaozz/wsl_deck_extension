/**
 * Pure path helpers: Windows / UNC / Linux → WSL Linux absolute path.
 * No vscode dependency — unit-testable on Ubuntu CI.
 */

export type ResolvedWslPath =
	| { ok: true; linuxPath: string; kind: 'linux' | 'windows' | 'unc-wsl' }
	| { ok: false; reason: string };

const WINDOWS_DRIVE = /^[A-Za-z]:[\\/]/;
const UNC_WSL = /^\\\\(wsl\.localhost|wsl\$)\\([^\\/]+)(?:[\\/](.*))?$/i;

function toPosixSeparators(path: string): string {
	return path.replace(/\\/g, '/');
}

function stripTrailingSlash(path: string): string {
	if (path.length > 1 && path.endsWith('/')) {
		return path.slice(0, -1);
	}
	return path;
}

export type WslPathHostKind = 'local-windows' | 'local-linux' | 'wsl-remote' | 'other-remote';

/**
 * Convert a host filesystem path to a Linux path for WSL CLI / Agent cwd.
 * On local-windows, Windows paths (e.g. workspace under D:\) become /mnt/...
 * On other hosts, returns the path unchanged (already Linux inside WSL/remote).
 */
export function toWslLinuxPath(
	input: string | undefined,
	host: WslPathHostKind,
): string | undefined {
	if (!input?.trim()) {
		return undefined;
	}
	if (host !== 'local-windows') {
		return stripTrailingSlash(input.trim());
	}
	const resolved = resolveToWslPath(input);
	return resolved.ok ? resolved.linuxPath : undefined;
}

/**
 * Convert a workspace / filesystem path into a Linux path usable inside WSL.
 *
 * Examples:
 * - `C:\\project` → `/mnt/c/project`
 * - `\\\\wsl.localhost\\Ubuntu-24.04\\home\\neo\\project` → `/home/neo/project`
 * - `/home/neo/project` → `/home/neo/project`
 */
export function resolveToWslPath(input: string): ResolvedWslPath {
	const raw = input.trim();
	if (!raw) {
		return { ok: false, reason: 'Empty path' };
	}

	// Already a Linux absolute path (Remote-WSL fsPath)
	if (raw.startsWith('/') && !raw.startsWith('//')) {
		return { ok: true, linuxPath: stripTrailingSlash(raw), kind: 'linux' };
	}

	// UNC: \\wsl.localhost\Distro\... or \\wsl$\Distro\...
	const unc = UNC_WSL.exec(raw);
	if (unc) {
		const rest = unc[3] ?? '';
		const linuxPath = '/' + toPosixSeparators(rest).replace(/^\/+/, '');
		return {
			ok: true,
			linuxPath: stripTrailingSlash(linuxPath === '/' && rest === '' ? '/' : linuxPath || '/'),
			kind: 'unc-wsl',
		};
	}

	// Windows drive path
	if (WINDOWS_DRIVE.test(raw)) {
		const drive = raw[0].toLowerCase();
		const rest = toPosixSeparators(raw.slice(2)).replace(/^\/+/, '');
		const linuxPath = `/mnt/${drive}${rest ? `/${rest}` : ''}`;
		return { ok: true, linuxPath: stripTrailingSlash(linuxPath), kind: 'windows' };
	}

	// Forward-slash Windows path: C:/project
	const forwardDrive = /^([A-Za-z]):\/(.*)$/.exec(raw);
	if (forwardDrive) {
		const drive = forwardDrive[1].toLowerCase();
		const rest = forwardDrive[2].replace(/^\/+/, '');
		const linuxPath = `/mnt/${drive}${rest ? `/${rest}` : ''}`;
		return { ok: true, linuxPath: stripTrailingSlash(linuxPath), kind: 'windows' };
	}

	return {
		ok: false,
		reason: `Unsupported path for WSL mapping: ${raw}`,
	};
}

/**
 * Extract WSL distro from remote authority like `wsl+Ubuntu-24.04`.
 */
export function distroFromRemoteAuthority(remoteAuthority: string | undefined): string | undefined {
	if (!remoteAuthority) {
		return undefined;
	}
	const match = /^wsl\+(.+)$/i.exec(remoteAuthority);
	return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Build `wsl.exe` args so the shell starts in `linuxCwd`.
 */
export function buildWslExeArgs(linuxCwd: string, distro?: string): string[] {
	const args: string[] = [];
	if (distro && distro.trim().length > 0) {
		args.push('-d', distro.trim());
	}
	args.push('--cd', linuxCwd);
	return args;
}

const DEFAULT_ROUTE_GATEWAY = /^\d{1,3}(?:\.\d{1,3}){3}$/;

/** Parse Windows host gateway IP from `ip route` default line or bare IP stdout. */
export function parseDefaultRouteGateway(ipRouteOutput: string): string | undefined {
	for (const raw of ipRouteOutput.trim().split(/\r?\n/)) {
		const line = raw.trim();
		if (!line) {
			continue;
		}
		if (DEFAULT_ROUTE_GATEWAY.test(line)) {
			return line;
		}
		const match = /^default\s+via\s+(\S+)/i.exec(line);
		if (match?.[1] && DEFAULT_ROUTE_GATEWAY.test(match[1])) {
			return match[1];
		}
	}
	return undefined;
}
