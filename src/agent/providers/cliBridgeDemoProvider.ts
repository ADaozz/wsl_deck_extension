import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
	AgentAvailability,
	AgentModelInfo,
	AgentProvider,
	AgentSessionContext,
	SendPromptOptions,
} from '../agentProvider';
import type { AgentEvent } from '../agentEvents';
import { createAgentSession, type AgentSession } from '../agentSession';
import { runDemoTurn } from '../demoTurn';
import { modelsFromConfigFallback } from '../modelCatalog';

const execFileAsync = promisify(execFile);

function newId(prefix: string): string {
	return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

async function which(command: string): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync('bash', ['-lc', `command -v ${shellQuote(command)}`], {
			timeout: 5_000,
		});
		const path = stdout.trim();
		return path.length > 0 ? path : undefined;
	} catch {
		return undefined;
	}
}

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

function combineSignals(signals: AbortSignal[]): AbortSignal {
	if (signals.length === 1) {
		return signals[0];
	}
	const anyFn = (
		AbortSignal as typeof AbortSignal & {
			any?: (s: AbortSignal[]) => AbortSignal;
		}
	).any;
	if (typeof anyFn === 'function') {
		return anyFn(signals);
	}
	const controller = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			controller.abort();
			return controller.signal;
		}
		signal.addEventListener('abort', () => controller.abort(), { once: true });
	}
	return controller.signal;
}

export interface CliBridgeProviderOptions {
	id: string;
	displayName: string;
	executableSetting: string;
	defaultExecutable: string;
	/** Read settings; keys are relative to `wsldeck.` (e.g. `codex.executable`) */
	getSetting: <T>(key: string, defaultValue: T) => T;
}

/**
 * Temporary bridge used until real Codex/Cursor streams land (M4/M5).
 * Proves AgentProvider is swappable without baking CLI types into the UI.
 */
export class CliBridgeDemoProvider implements AgentProvider {
	readonly id: string;
	readonly displayName: string;
	private readonly executableSetting: string;
	private readonly defaultExecutable: string;
	private readonly getSetting: <T>(key: string, defaultValue: T) => T;
	private readonly controllers = new Map<string, AbortController>();

	constructor(options: CliBridgeProviderOptions) {
		this.id = options.id;
		this.displayName = options.displayName;
		this.executableSetting = options.executableSetting;
		this.defaultExecutable = options.defaultExecutable;
		this.getSetting = options.getSetting;
	}

	async detect(): Promise<AgentAvailability> {
		const exe = this.getSetting<string>(this.executableSetting, this.defaultExecutable);
		const path = await which(exe);
		if (path) {
			return {
				available: true,
				cliPresent: true,
				detail: `${path} (stream: demo bridge until M4/M5)`,
			};
		}
		return {
			available: true,
			cliPresent: false,
			detail: `"${exe}" not found — using demo bridge`,
		};
	}

	async listModels(_context: AgentSessionContext): Promise<AgentModelInfo[]> {
		return modelsFromConfigFallback((section) => this.getSetting<string[]>(section, []), this.id);
	}

	async createSession(context: AgentSessionContext): Promise<AgentSession> {
		return createAgentSession({
			id: context.sessionId ?? newId('session'),
			providerId: this.id,
			providerSessionId: context.resumeProviderSessionId,
			modelId: context.modelId,
		});
	}

	async *sendPrompt(
		session: AgentSession,
		prompt: string,
		options?: SendPromptOptions,
	): AsyncIterable<AgentEvent> {
		const controller = new AbortController();
		this.controllers.set(session.id, controller);
		const signal = options?.signal
			? combineSignals([options.signal, controller.signal])
			: controller.signal;

		session.status = 'RUNNING';
		const turnId = newId('turn');
		try {
			yield* runDemoTurn({
				sessionId: session.id,
				turnId,
				providerId: this.id,
				modelId: options?.modelId ?? session.modelId,
				prompt,
				signal,
			});
			session.status = 'READY';
		} catch (err) {
			const aborted = err instanceof Error && err.name === 'AbortError';
			session.status = aborted ? 'STOPPED' : 'FAILED';
			if (!aborted) {
				const message = err instanceof Error ? err.message : String(err);
				yield {
					type: 'session.failed',
					sessionId: session.id,
					turnId,
					timestamp: Date.now(),
					message,
				};
			}
			throw err;
		} finally {
			this.controllers.delete(session.id);
		}
	}

	async cancel(session: AgentSession): Promise<void> {
		this.controllers.get(session.id)?.abort();
		session.status = 'STOPPED';
	}

	async dispose(session: AgentSession): Promise<void> {
		await this.cancel(session);
		session.status = 'CLOSED';
		this.controllers.delete(session.id);
	}
}
