import type { AgentEvent, ToolMetadata } from './agentEvents';

export interface DemoTurnOptions {
	sessionId: string;
	turnId: string;
	providerId: string;
	modelId?: string;
	prompt: string;
	signal: AbortSignal;
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(abortError());
			return;
		}
		const timer = setTimeout(() => resolve(), ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(abortError());
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

function abortError(): Error {
	const err = new Error('Aborted');
	err.name = 'AbortError';
	return err;
}

/**
 * M2 demo stream. Tool names/details are free-form strings on purpose —
 * they mimic agent metadata, not a closed enum the UI knows about.
 */
export async function* runDemoTurn(options: DemoTurnOptions): AsyncGenerator<AgentEvent> {
	const { sessionId, turnId, providerId, modelId, prompt, signal } = options;
	const now = () => Date.now();
	const modelLabel = modelId?.trim() || 'default';

	yield {
		type: 'session.started',
		sessionId,
		turnId,
		timestamp: now(),
		providerId,
	};

	const tools: ToolMetadata[] = [
		{
			toolCallId: `${turnId}-t1`,
			name: 'grep',
			detail: 'pattern=WorkspaceContext path=src/',
		},
		{
			toolCallId: `${turnId}-t2`,
			name: 'WebSearch',
			title: 'Web search',
			detail: 'vscode WebviewViewProvider terminal cwd',
		},
		{
			toolCallId: `${turnId}-t3`,
			name: 'Read',
			detail: 'src/workspace/wslPathResolver.ts',
		},
	];

	for (const tool of tools) {
		if (signal.aborted) {
			throw abortError();
		}
		yield { type: 'tool.started', sessionId, turnId, timestamp: now(), tool };
		await sleep(350, signal);
		yield {
			type: 'tool.completed',
			sessionId,
			turnId,
			timestamp: now(),
			tool,
			ok: true,
			outcome: 'done',
		};
	}

	const reply =
		`（M3 Provider · ${providerId} · ${modelLabel}）经 AgentProvider 抽象输出；工具活动来自元数据。\n` +
		`你的问题：${prompt.trim()}\n` +
		`Codex exec --json / Cursor ACP 将在 M4/M5 替换当前 demo bridge。`;

	let built = '';
	for (const chunk of reply.match(/.{1,18}/gs) ?? [reply]) {
		if (signal.aborted) {
			throw abortError();
		}
		built += chunk;
		yield {
			type: 'agent.message.delta',
			sessionId,
			turnId,
			timestamp: now(),
			text: chunk,
		};
		await sleep(40, signal);
	}

	yield {
		type: 'agent.message.completed',
		sessionId,
		turnId,
		timestamp: now(),
		text: built,
	};

	yield { type: 'turn.completed', sessionId, turnId, timestamp: now() };
}
