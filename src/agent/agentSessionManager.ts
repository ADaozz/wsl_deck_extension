import type { AgentEvent } from './agentEvents';
import type { AgentProvider, SendPromptOptions } from './agentProvider';
import type { AgentSession } from './agentSession';

interface ProviderSlot {
	provider: AgentProvider;
	session: AgentSession;
	abort?: AbortController;
}

/**
 * Per-provider sessions in one workspace.
 * Codex and Cursor each keep their own process/resume — never share a slot.
 * UI focuses one provider at a time; others stay alive until disposed.
 */
export class AgentSessionManager {
	private readonly providers = new Map<string, AgentProvider>();
	private readonly slots = new Map<string, ProviderSlot>();
	private readonly ensureInFlight = new Map<string, Promise<AgentSession>>();
	private focusedProviderId?: string;

	register(provider: AgentProvider): void {
		this.providers.set(provider.id, provider);
	}

	listProviders(): AgentProvider[] {
		return [...this.providers.values()];
	}

	getProvider(id: string): AgentProvider | undefined {
		return this.providers.get(id);
	}

	getFocusedProviderId(): string | undefined {
		return this.focusedProviderId;
	}

	getSession(providerId: string): AgentSession | undefined {
		return this.slots.get(providerId)?.session;
	}

	/** @deprecated use getSession(focused) — kept for call-site clarity */
	getActiveSession(): AgentSession | undefined {
		if (!this.focusedProviderId) {
			return undefined;
		}
		return this.getSession(this.focusedProviderId);
	}

	focus(providerId: string): void {
		if (!this.providers.has(providerId)) {
			throw new Error(`Unknown agent provider: ${providerId}`);
		}
		this.focusedProviderId = providerId;
	}

	async ensureSession(
		providerId: string,
		options?: {
			sessionId?: string;
			modelId?: string;
			workspaceCwd?: string;
			acpSpawnCwd?: string;
			resumeProviderSessionId?: string;
		},
	): Promise<AgentSession> {
		const inFlight = this.ensureInFlight.get(providerId);
		if (inFlight) {
			await inFlight;
			return this.ensureSession(providerId, options);
		}
		const operation = this.ensureSessionOnce(providerId, options);
		this.ensureInFlight.set(providerId, operation);
		try {
			return await operation;
		} finally {
			if (this.ensureInFlight.get(providerId) === operation) {
				this.ensureInFlight.delete(providerId);
			}
		}
	}

	private async ensureSessionOnce(
		providerId: string,
		options?: {
			sessionId?: string;
			modelId?: string;
			workspaceCwd?: string;
			acpSpawnCwd?: string;
			resumeProviderSessionId?: string;
		},
	): Promise<AgentSession> {
		const provider = this.providers.get(providerId);
		if (!provider) {
			throw new Error(`Unknown agent provider: ${providerId}`);
		}

		this.focusedProviderId = providerId;
		const existing = this.slots.get(providerId);
		if (
			existing &&
			existing.session.status !== 'CLOSED' &&
			existing.session.status !== 'FAILED' &&
			(!options?.sessionId || existing.session.id === options.sessionId)
		) {
			if (options?.modelId) {
				existing.session.modelId = options.modelId;
			}
			if (options?.workspaceCwd) {
				existing.session.workspaceCwd = options.workspaceCwd;
			}
			if (options?.acpSpawnCwd) {
				existing.session.acpSpawnCwd = options.acpSpawnCwd;
			}
			return existing.session;
		}

		if (existing) {
			this.slots.delete(providerId);
			existing.abort?.abort();
			await existing.provider.dispose(existing.session);
		}

		const session = await provider.createSession({
			sessionId: options?.sessionId,
			modelId: options?.modelId,
			linuxCwd: options?.workspaceCwd,
			workspaceFolder: options?.workspaceCwd,
			acpSpawnCwd: options?.acpSpawnCwd,
			resumeProviderSessionId: options?.resumeProviderSessionId,
		});
		if (options?.workspaceCwd && !session.workspaceCwd) {
			session.workspaceCwd = options.workspaceCwd;
		}
		if (options?.acpSpawnCwd && !session.acpSpawnCwd) {
			session.acpSpawnCwd = options.acpSpawnCwd;
		}
		this.slots.set(providerId, { provider, session });
		return session;
	}

	/**
	 * Replace the live session for one provider (dispose previous process).
	 * Used when switching resumes in the same workspace.
	 */
	async replaceSession(providerId: string, session: AgentSession): Promise<AgentSession> {
		await this.disposeProvider(providerId);
		this.bindRestoredSession(providerId, session);
		return session;
	}

	/**
	 * Start a fresh session for one provider only.
	 * Other agents' sessions/resume ids in this workspace are untouched.
	 */
	async startNewSession(
		providerId: string,
		options?: { sessionId?: string; modelId?: string; workspaceCwd?: string },
	): Promise<AgentSession> {
		await this.disposeProvider(providerId);
		return this.ensureSession(providerId, options);
	}

	async *sendPrompt(
		prompt: string,
		options?: {
			providerId?: string;
			modelId?: string;
			modeId?: string;
			reasoningId?: string;
			signal?: AbortSignal;
		},
	): AsyncIterable<AgentEvent> {
		const providerId = options?.providerId ?? this.focusedProviderId;
		if (!providerId) {
			throw new Error('No focused agent provider');
		}
		const slot = this.slots.get(providerId);
		if (!slot) {
			throw new Error(`No session for provider: ${providerId}`);
		}
		if (slot.abort && !slot.abort.signal.aborted) {
			throw new Error(`Agent provider ${providerId} is already running`);
		}

		const controller = new AbortController();
		slot.abort = controller;
		const signal = combineSignals(
			[controller.signal, options?.signal].filter(Boolean) as AbortSignal[],
		);

		const sendOptions: SendPromptOptions = {
			modelId: options?.modelId ?? slot.session.modelId,
			modeId: options?.modeId,
			reasoningId: options?.reasoningId,
			signal,
		};

		try {
			yield* slot.provider.sendPrompt(slot.session, prompt, sendOptions);
		} finally {
			if (slot.abort === controller) {
				slot.abort = undefined;
			}
		}
	}

	async cancel(providerId?: string): Promise<void> {
		const id = providerId ?? this.focusedProviderId;
		if (!id) {
			return;
		}
		const slot = this.slots.get(id);
		if (!slot) {
			return;
		}
		slot.abort?.abort();
		await slot.provider.cancel(slot.session);
	}

	async resolvePermission(
		providerId: string,
		requestId: string,
		optionId: string,
	): Promise<void> {
		const slot = this.slots.get(providerId);
		if (!slot?.provider.resolvePermission) {
			throw new Error(`Provider ${providerId} does not support permissions`);
		}
		await slot.provider.resolvePermission(slot.session, requestId, optionId);
	}

	async disposeProvider(providerId: string): Promise<void> {
		const inFlight = this.ensureInFlight.get(providerId);
		if (inFlight) {
			try {
				await inFlight;
			} catch {
				// A failed create has no live slot to dispose.
			}
		}
		const slot = this.slots.get(providerId);
		if (!slot) {
			return;
		}
		this.slots.delete(providerId);
		slot.abort?.abort();
		await slot.provider.dispose(slot.session);
	}

	async disposeAll(): Promise<void> {
		const ids = [...this.slots.keys()];
		for (const id of ids) {
			await this.disposeProvider(id);
		}
		this.focusedProviderId = undefined;
	}

	/** Attach a restored session for a provider without disposing others. */
	bindRestoredSession(providerId: string, session: AgentSession): void {
		const provider = this.providers.get(providerId);
		if (!provider) {
			return;
		}
		this.slots.set(providerId, { provider, session });
		this.focusedProviderId = providerId;
	}
}

export function combineSignals(signals: AbortSignal[]): AbortSignal {
	if (signals.length === 0) {
		return new AbortController().signal;
	}
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
