import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as vscode from 'vscode';
import { buildWslExeArgs, parseDefaultRouteGateway } from './wslPathResolver';

const execFileAsync = promisify(execFile);

const WSL_EXECUTABLE = process.platform === 'win32' ? 'wsl.exe' : 'wsl';

export type AgentEnvHostKind = 'local-windows' | 'local-linux' | 'wsl-remote' | 'other-remote';

export interface AgentEnvContext {
	host: AgentEnvHostKind;
	linuxCwd?: string;
	distro?: string;
}

const ALLOWED_ENV_KEYS = new Set([
	'PATH',
	'HOME',
	'USER',
	'LOGNAME',
	'SHELL',
	'LANG',
	'LC_ALL',
	'LC_CTYPE',
	'LC_MESSAGES',
	'HTTP_PROXY',
	'HTTPS_PROXY',
	'ALL_PROXY',
	'NO_PROXY',
	'http_proxy',
	'https_proxy',
	'all_proxy',
	'no_proxy',
	'NVM_DIR',
	'NVM_BIN',
	'CODEX_HOME',
	'CURSOR_API_KEY',
]);

export type LinuxAgentEnv = Record<string, string>;

interface CacheEntry {
	env: LinuxAgentEnv;
	at: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(ctx: AgentEnvContext): string {
	return [ctx.host, ctx.distro ?? '', ctx.linuxCwd ?? ''].join('|');
}

function isAllowedEnvKey(key: string): boolean {
	if (ALLOWED_ENV_KEYS.has(key)) {
		return true;
	}
	if (key.startsWith('LC_')) {
		return true;
	}
	if (key.startsWith('NODE_')) {
		return true;
	}
	return false;
}

/** Parse NUL-delimited output from `printenv -0`. */
export function parsePrintenv0(raw: Buffer | string): LinuxAgentEnv {
	const buf = typeof raw === 'string' ? Buffer.from(raw, 'utf8') : raw;
	const out: LinuxAgentEnv = {};
	let start = 0;
	for (let i = 0; i <= buf.length; i++) {
		if (i < buf.length && buf[i] !== 0) {
			continue;
		}
		if (i <= start) {
			start = i + 1;
			continue;
		}
		const chunk = buf.subarray(start, i).toString('utf8');
		start = i + 1;
		const eq = chunk.indexOf('=');
		if (eq <= 0) {
			continue;
		}
		const key = chunk.slice(0, eq);
		const value = chunk.slice(eq + 1);
		if (isAllowedEnvKey(key)) {
			out[key] = value;
		}
	}
	return out;
}

export function filterHostEnv(source: NodeJS.ProcessEnv): LinuxAgentEnv {
	const out: LinuxAgentEnv = {};
	for (const [key, value] of Object.entries(source)) {
		if (value === undefined || !isAllowedEnvKey(key)) {
			continue;
		}
		out[key] = value;
	}
	return out;
}

function readConfiguredAgentEnv(): LinuxAgentEnv {
	const configured = vscode.workspace.getConfiguration('wsldeck').get<Record<string, string>>('agent.env', {});
	const out: LinuxAgentEnv = {};
	for (const [key, value] of Object.entries(configured ?? {})) {
		if (typeof value === 'string' && value.length > 0) {
			out[key] = value;
		}
	}
	return out;
}

function mergeAgentEnv(
	base: LinuxAgentEnv,
	overrides?: Record<string, string | undefined>,
): LinuxAgentEnv {
	return mergeLinuxAgentEnvLayers(base, readConfiguredAgentEnv(), overrides);
}

/** Merge probe/host env → settings → caller overrides (exported for tests). */
export function mergeLinuxAgentEnvLayers(
	base: LinuxAgentEnv,
	configured: LinuxAgentEnv,
	overrides?: Record<string, string | undefined>,
): LinuxAgentEnv {
	const merged: LinuxAgentEnv = { ...base };
	for (const [key, value] of Object.entries(configured)) {
		merged[key] = value;
	}
	if (overrides) {
		for (const [key, value] of Object.entries(overrides)) {
			if (value === undefined || value === '') {
				delete merged[key];
			} else {
				merged[key] = value;
			}
		}
	}
	return merged;
}

function pathLooksMinimal(pathValue: string | undefined): boolean {
	if (!pathValue?.trim()) {
		return true;
	}
	const parts = pathValue.split(':').filter(Boolean);
	return parts.length <= 4;
}

async function probeViaLoginShell(ctx: AgentEnvContext): Promise<LinuxAgentEnv> {
	if (ctx.host === 'local-windows') {
		if (!ctx.linuxCwd?.trim()) {
			return {};
		}
		const wslArgs = [...buildWslExeArgs(ctx.linuxCwd, ctx.distro), '--', 'bash', '-lc', 'printenv -0'];
		const { stdout } = await execFileAsync(WSL_EXECUTABLE, wslArgs, {
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
			windowsHide: true,
			encoding: 'buffer',
		});
		return parsePrintenv0(stdout as Buffer);
	}

	if (ctx.host === 'other-remote') {
		const { stdout } = await execFileAsync('bash', ['-lc', 'printenv -0'], {
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
			encoding: 'buffer',
		});
		return parsePrintenv0(stdout as Buffer);
	}

	const { stdout } = await execFileAsync(
		'bash',
		['-lc', 'printenv -0'],
		{
			timeout: 15_000,
			maxBuffer: 4 * 1024 * 1024,
			encoding: 'buffer',
			cwd: ctx.linuxCwd,
		},
	);
	return parsePrintenv0(stdout as Buffer);
}

/** Windows host IP as seen from WSL (default route gateway). local-windows only. */
export async function probeWslHostGatewayIp(ctx: AgentEnvContext): Promise<string | undefined> {
	if (ctx.host !== 'local-windows' || !ctx.linuxCwd?.trim()) {
		return undefined;
	}
	const wslArgs = [
		...buildWslExeArgs(ctx.linuxCwd, ctx.distro),
		'--',
		'bash',
		'-c',
		"ip route | grep -m1 '^default' | awk '{print $3}'",
	];
	try {
		const { stdout } = await execFileAsync(WSL_EXECUTABLE, wslArgs, {
			timeout: 5_000,
			maxBuffer: 256 * 1024,
			windowsHide: true,
		});
		return parseDefaultRouteGateway(stdout.toString());
	} catch {
		return undefined;
	}
}

export function invalidateLinuxAgentEnvCache(distro?: string): void {
	if (!distro) {
		cache.clear();
		return;
	}
	for (const key of [...cache.keys()]) {
		if (key.includes(`|${distro}|`)) {
			cache.delete(key);
		}
	}
}

export async function probeLinuxLoginEnv(ctx: AgentEnvContext): Promise<LinuxAgentEnv> {
	return probeViaLoginShell(ctx);
}

export async function resolveLinuxAgentEnv(
	ctx: AgentEnvContext,
	overrides?: Record<string, string | undefined>,
): Promise<LinuxAgentEnv> {
	const key = cacheKey(ctx);
	const hit = cache.get(key);
	if (hit && !overrides) {
		return mergeAgentEnv(hit.env, overrides);
	}

	let base: LinuxAgentEnv;
	if (ctx.host === 'local-windows' || ctx.host === 'other-remote') {
		base = await probeViaLoginShell(ctx);
	} else {
		base = filterHostEnv(process.env);
		if (pathLooksMinimal(base.PATH)) {
			try {
				base = await probeViaLoginShell(ctx);
			} catch {
				// keep filtered host env
			}
		}
	}

	if (!overrides) {
		cache.set(key, { env: base, at: Date.now() });
	}
	return mergeAgentEnv(base, overrides);
}

const SECRET_KEYS = new Set(['CURSOR_API_KEY', 'OPENAI_API_KEY']);

export function agentEnvForLog(env: LinuxAgentEnv): string {
	const parts: string[] = [];
	const proxyKeys = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
	for (const key of proxyKeys) {
		const value = env[key];
		if (value?.trim()) {
			parts.push(`${key}=set`);
		}
	}
	if (env.PATH) {
		const segments = env.PATH.split(':').filter(Boolean);
		parts.push(`PATH=${segments.length} dirs`);
	}
	if (env.HOME) {
		parts.push(`HOME=${env.HOME}`);
	}
	if (env.NVM_DIR) {
		parts.push('NVM=set');
	}
	for (const key of SECRET_KEYS) {
		if (env[key]?.trim()) {
			parts.push(`${key}=set`);
		}
	}
	const count = Object.keys(env).length;
	return parts.length > 0 ? `${parts.join(', ')} (${count} keys)` : `${count} keys`;
}

export function shouldLogAgentEnv(): boolean {
	return vscode.workspace.getConfiguration('wsldeck').get<boolean>('agent.logEnv', false);
}

let envLoggedOnce = false;

export function markAgentEnvLogged(): boolean {
	if (envLoggedOnce) {
		return false;
	}
	envLoggedOnce = true;
	return true;
}

export function resetAgentEnvLogFlag(): void {
	envLoggedOnce = false;
}
