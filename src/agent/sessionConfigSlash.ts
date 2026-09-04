/**
 * Slash helpers for /model and /mode.
 * Reasoning intensity is a second step after model pick (not its own slash).
 */

export type SlashListOrSet =
	| { kind: 'list' }
	| { kind: 'set'; value: string };

export function parseNamedSlash(command: string, text: string): SlashListOrSet | undefined {
	const trimmed = text.trim();
	const re = new RegExp(`^/${command}(?:\\s+(.+))?$`, 'i');
	const match = re.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const rest = match[1]?.trim();
	if (!rest) {
		return { kind: 'list' };
	}
	return { kind: 'set', value: rest };
}

export function parseModeSlash(text: string): SlashListOrSet | undefined {
	return parseNamedSlash('mode', text);
}

/** Cursor-style effort id → human description (fallback when ACP/Codex omit detail). */
export const REASONING_LEVEL_DESCRIPTIONS: Readonly<Record<string, string>> = {
	low: 'Fast responses with lighter reasoning',
	medium: 'Balances speed and reasoning depth for everyday tasks',
	high: 'Greater reasoning depth for complex problems',
	xhigh: 'Extra high reasoning depth for complex problems',
	max: 'Maximum reasoning depth for the hardest problems',
	ultra: 'Maximum reasoning with automatic task delegation',
};

export interface ReasoningOption {
	id: string;
	label: string;
	description: string;
}

export function reasoningDescriptionForId(id: string, fallbackName?: string): string {
	const key = id.trim().toLowerCase();
	const known = REASONING_LEVEL_DESCRIPTIONS[key];
	if (known) {
		return known;
	}
	const name = fallbackName?.trim();
	if (name && name.toLowerCase() !== key) {
		return name;
	}
	return key;
}

/** UI row: bold short id + smaller description after a gap. */
export function toReasoningOption(id: string, fallbackName?: string): ReasoningOption {
	const normalized = id.trim().toLowerCase();
	return {
		id: normalized,
		label: normalized,
		description: reasoningDescriptionForId(normalized, fallbackName),
	};
}

/** Map reasoning row → webview ModelOption (short label + long description). */
export function reasoningToModelOption(r: ReasoningOption): {
	id: string;
	label: string;
	description: string;
} {
	return { id: r.id, label: r.label, description: r.description };
}

/** ACP configOptions → reasoning level choices. */
export function parseAcpReasoningOptions(configOptions: unknown): ReasoningOption[] {
	if (!Array.isArray(configOptions)) {
		return [];
	}
	const out: ReasoningOption[] = [];
	for (const raw of configOptions) {
		if (!raw || typeof raw !== 'object') {
			continue;
		}
		const opt = raw as {
			id?: string;
			category?: string;
			name?: string;
			options?: Array<{ value?: string; name?: string }>;
		};
		const id = (opt.id ?? '').toLowerCase();
		const category = (opt.category ?? '').toLowerCase();
		const name = (opt.name ?? '').toLowerCase();
		const isReasoning =
			category === 'reasoning' ||
			id.includes('reason') ||
			id.includes('effort') ||
			name.includes('reasoning') ||
			name.includes('effort');
		if (!isReasoning || !Array.isArray(opt.options)) {
			continue;
		}
		for (const o of opt.options) {
			const value = typeof o.value === 'string' ? o.value.trim() : '';
			if (!value) {
				continue;
			}
			out.push(toReasoningOption(value, typeof o.name === 'string' ? o.name : undefined));
		}
	}
	return out;
}

export function parseAcpModeOptionIds(configOptions: unknown, modesField?: unknown): string[] {
	const ids: string[] = [];
	if (modesField && typeof modesField === 'object') {
		const m = modesField as { availableModes?: Array<{ id?: string }> };
		for (const mode of m.availableModes ?? []) {
			if (typeof mode.id === 'string' && mode.id.trim()) {
				ids.push(mode.id.trim());
			}
		}
	}
	if (Array.isArray(configOptions)) {
		for (const raw of configOptions) {
			if (!raw || typeof raw !== 'object') {
				continue;
			}
			const opt = raw as {
				id?: string;
				category?: string;
				options?: Array<{ value?: string }>;
			};
			if (opt.category !== 'mode' && opt.id !== 'mode') {
				continue;
			}
			for (const o of opt.options ?? []) {
				if (typeof o.value === 'string' && o.value.trim()) {
					ids.push(o.value.trim());
				}
			}
		}
	}
	return ids;
}

/** Cursor-oriented fallback when ACP has not yet returned reasoning options. */
export const CURSOR_REASONING_FALLBACK: ReasoningOption[] = (
	['low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
).map((id) => toReasoningOption(id));
