import { createInterface } from 'node:readline';
import type { AgentRawLog } from '../../agentRawLog';
import { spawnLinuxCli, killLinuxCliChild, type LinuxCliContext } from '../../../workspace/linuxCliBridge';

type Pending = {
	resolve: (value: unknown) => void;
	reject: (err: Error) => void;
};

export type AcpNotificationHandler = (
	method: string,
	params: unknown,
	respond: (result: unknown) => void,
) => void;

export type AcpStartOptions = {
	cliCtx: LinuxCliContext;
	argv: string[];
	linuxEnv?: Record<string, string | undefined>;
	env?: Record<string, string | undefined>;
};

/**
 * Minimal JSON-RPC 2.0 client over agent acp stdio (newline-delimited).
 */
export class CursorAcpClient {
	private child?: import('node:child_process').ChildProcessWithoutNullStreams;
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private onNotification?: AcpNotificationHandler;

	constructor(private readonly log?: AgentRawLog) {}

	setNotificationHandler(handler: AcpNotificationHandler): void {
		this.onNotification = handler;
	}

	async start(options: AcpStartOptions): Promise<void> {
		if (this.child) {
			return;
		}
		const child = spawnLinuxCli(options.cliCtx, options.argv, {
			linuxEnv: options.linuxEnv,
			env: options.env,
		}) as import('node:child_process').ChildProcessWithoutNullStreams;
		this.child = child;

		this.log?.section(`cursor acp · ${options.argv.join(' ')}`);
		if (options.cliCtx.linuxCwd) {
			this.log?.line('cursor', '--', `linux cwd=${options.cliCtx.linuxCwd}`);
		}

		const rl = createInterface({ input: child.stdout });
		rl.on('line', (line) => {
			this.log?.line('cursor', '<<', line);
			this.onLine(line);
		});

		const errRl = createInterface({ input: child.stderr });
		errRl.on('line', (line) => {
			this.log?.line('cursor', '!!', line);
		});

		child.on('error', (err) => {
			this.log?.line('cursor', '!!', `spawn error: ${err.message}`);
			for (const p of this.pending.values()) {
				p.reject(err);
			}
			this.pending.clear();
		});
		child.on('close', (code) => {
			this.log?.line('cursor', '--', `acp exit ${code ?? '?'}`);
			const err = new Error('Cursor ACP process exited');
			for (const p of this.pending.values()) {
				p.reject(err);
			}
			this.pending.clear();
			this.child = undefined;
		});
	}

	async request(method: string, params?: unknown, timeoutMs?: number): Promise<unknown> {
		if (!this.child?.stdin) {
			throw new Error('ACP client not started');
		}
		const id = this.nextId++;
		const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
		this.log?.line('cursor', '>>', payload.trimEnd());
		return await new Promise((res, rej) => {
			let timer: ReturnType<typeof setTimeout> | undefined;
			const pending: Pending = {
				resolve: (value) => {
					if (timer) {
						clearTimeout(timer);
					}
					this.pending.delete(id);
					res(value);
				},
				reject: (err) => {
					if (timer) {
						clearTimeout(timer);
					}
					this.pending.delete(id);
					rej(err);
				},
			};
			this.pending.set(id, pending);
			if (timeoutMs !== undefined && timeoutMs > 0) {
				timer = setTimeout(() => {
					pending.reject(new Error(`ACP request timed out: ${method}`));
				}, timeoutMs);
			}
			this.child!.stdin.write(payload, (err) => {
				if (err) {
					pending.reject(err);
				}
			});
		});
	}

	notify(method: string, params?: unknown): void {
		if (!this.child?.stdin) {
			return;
		}
		const payload = JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n';
		this.log?.line('cursor', '>>', payload.trimEnd());
		this.child.stdin.write(payload);
	}

	respond(id: number, result: unknown): void {
		if (!this.child?.stdin) {
			return;
		}
		const payload = JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n';
		this.log?.line('cursor', '>>', payload.trimEnd());
		this.child.stdin.write(payload);
	}

	async dispose(): Promise<void> {
		const child = this.child;
		this.child = undefined;
		this.pending.clear();
		if (!child) {
			return;
		}
		child.stdin?.end();
		killLinuxCliChild(child);
	}

	private onLine(line: string): void {
		const trimmed = line.trim();
		if (!trimmed) {
			return;
		}
		let msg: {
			id?: number;
			method?: string;
			params?: unknown;
			result?: unknown;
			error?: { message?: string };
		};
		try {
			msg = JSON.parse(trimmed);
		} catch {
			return;
		}

		if (msg.id !== undefined && (msg.result !== undefined || msg.error !== undefined)) {
			const waiter = this.pending.get(msg.id);
			if (!waiter) {
				return;
			}
			this.pending.delete(msg.id);
			if (msg.error) {
				waiter.reject(new Error(msg.error.message ?? 'ACP error'));
			} else {
				waiter.resolve(msg.result);
			}
			return;
		}

		if (msg.method) {
			const respond = (result: unknown) => {
				if (msg.id !== undefined) {
					this.respond(msg.id, result);
				}
			};
			this.onNotification?.(msg.method, msg.params, respond);
		}
	}
}

export function parseCursorModelList(stdout: string): { id: string; label: string }[] {
	const models: { id: string; label: string }[] = [];
	const seen = new Set<string>();
	for (const line of stdout.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.toLowerCase().startsWith('available models')) {
			continue;
		}
		// "id - Name" or "id — Name" or "id: Name"
		const match =
			/^(\S+)\s+[-–—:]\s+(.+)$/.exec(trimmed) ||
			/^(\S+)\s{2,}(.+)$/.exec(trimmed);
		if (match) {
			const id = match[1];
			if (seen.has(id)) {
				continue;
			}
			seen.add(id);
			models.push({ id, label: match[2].trim() });
			continue;
		}
		// Bare id line
		if (/^[\w.\[\]=,+-]+$/.test(trimmed) && !seen.has(trimmed)) {
			seen.add(trimmed);
			models.push({ id: trimmed, label: trimmed });
		}
	}
	return models;
}

/** Models from ACP session/new|load `models.availableModels` or configOptions. */
export function parseAcpAvailableModels(payload: unknown): { id: string; label: string }[] {
	const out: { id: string; label: string }[] = [];
	const seen = new Set<string>();
	const push = (id: string, label?: string) => {
		const tid = id.trim();
		if (!tid || seen.has(tid)) {
			return;
		}
		seen.add(tid);
		out.push({ id: tid, label: (label ?? tid).trim() || tid });
	};

	if (payload && typeof payload === 'object') {
		const root = payload as {
			models?: {
				availableModels?: Array<{ modelId?: string; name?: string; id?: string }>;
			};
			configOptions?: unknown;
			availableModels?: Array<{ modelId?: string; name?: string; id?: string }>;
		};
		const lists = [
			root.models?.availableModels,
			root.availableModels,
		];
		for (const list of lists) {
			if (!Array.isArray(list)) {
				continue;
			}
			for (const m of list) {
				const id = m.modelId ?? m.id;
				if (typeof id === 'string') {
					push(id, typeof m.name === 'string' ? m.name : undefined);
				}
			}
		}
		if (Array.isArray(root.configOptions)) {
			for (const raw of root.configOptions) {
				if (!raw || typeof raw !== 'object') {
					continue;
				}
				const opt = raw as {
					id?: string;
					category?: string;
					options?: Array<{ value?: string; name?: string }>;
				};
				if (opt.category !== 'model' && opt.id !== 'model') {
					continue;
				}
				for (const o of opt.options ?? []) {
					if (typeof o.value === 'string') {
						push(o.value, o.name);
					}
				}
			}
		}
	}
	return out;
}
