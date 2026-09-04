import type { AgentProvider } from '../agentProvider';
import type { AgentRawLog } from '../agentRawLog';
import type { CliBridgeProviderOptions } from './cliBridgeDemoProvider';
import { CodexProvider } from './codex/codexProvider';
import { CursorProvider } from './cursor/cursorProvider';

export function createCodexProvider(
	getSetting: CliBridgeProviderOptions['getSetting'],
	log?: AgentRawLog,
): AgentProvider {
	return new CodexProvider(getSetting, log);
}

export function createCursorProvider(
	getSetting: CliBridgeProviderOptions['getSetting'],
	log?: AgentRawLog,
): AgentProvider {
	return new CursorProvider(getSetting, log);
}
