/**
 * Raw agent CLI / ACP I/O for the Output channel.
 * Shows unfiltered lines — not UI-friendly summaries.
 */
export interface AgentRawLog {
	/** Section header, e.g. start of a turn */
	section(title: string): void;
	/** One raw line with stream tag */
	line(source: string, stream: '>>' | '<<' | '!!' | '--', text: string): void;
	/** Reveal the Output channel (optional UX) */
	show?(preserveFocus?: boolean): void;
}

export function formatAgentLogLine(
	source: string,
	stream: '>>' | '<<' | '!!' | '--',
	text: string,
): string {
	const stamp = new Date().toISOString().slice(11, 23);
	return `[${stamp}] [${source}] ${stream} ${text}`;
}

export function createAgentRawLog(handlers: {
	appendLine: (line: string) => void;
	show?: (preserveFocus?: boolean) => void;
}): AgentRawLog {
	return {
		section(title) {
			handlers.appendLine('');
			handlers.appendLine(`── ${title} ──`);
		},
		line(source, stream, text) {
			handlers.appendLine(formatAgentLogLine(source, stream, text));
		},
		show: handlers.show,
	};
}
