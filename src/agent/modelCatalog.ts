/**
 * Model id helpers. Live catalogs come from provider CLIs
 * (`codex debug models`, `agent --list-models`) — not a fixed TS enum.
 */

import { toReasoningOption, type ReasoningOption } from './sessionConfigSlash';

export function pickModelId(
	models: { id: string }[],
	preferred?: string,
): string {
	if (preferred && models.some((m) => m.id === preferred)) {
		return preferred;
	}
	return models[0]?.id ?? 'default';
}

/** Parse `/model <id>` from a chat line. */
export function parseModelSlash(
	text: string,
): { kind: 'list' } | { kind: 'set'; modelId: string } | undefined {
	const trimmed = text.trim();
	const match = /^\/model(?:\s+(.+))?$/i.exec(trimmed);
	if (!match) {
		return undefined;
	}
	const rest = match[1]?.trim();
	if (!rest) {
		return { kind: 'list' };
	}
	return { kind: 'set', modelId: rest };
}

/** Parse `codex debug models` JSON catalog. */
export function parseCodexDebugModelsJson(
	raw: string,
): { id: string; label: string }[] {
	return parseCodexModelCatalog(raw).map((m) => ({ id: m.id, label: m.label }));
}

export interface CodexModelCatalogEntry {
	id: string;
	label: string;
	reasoningLevels: ReasoningOption[];
}

/** Full Codex catalog including per-model reasoning / effort levels. */
export function parseCodexModelCatalog(raw: string): CodexModelCatalogEntry[] {
	const parsed = JSON.parse(raw) as {
		models?: Array<{
			slug?: string;
			display_name?: string;
			visibility?: string;
			supported_reasoning_levels?: Array<{ effort?: string; description?: string }>;
		}>;
	};
	const models = Array.isArray(parsed.models) ? parsed.models : [];
	const out: CodexModelCatalogEntry[] = [];
	for (const m of models) {
		const id = typeof m.slug === 'string' ? m.slug.trim() : '';
		if (!id) {
			continue;
		}
		if (m.visibility === 'hide') {
			continue;
		}
		const label =
			typeof m.display_name === 'string' && m.display_name.trim()
				? m.display_name.trim()
				: id;
		const reasoningLevels: ReasoningOption[] = [];
		for (const level of m.supported_reasoning_levels ?? []) {
			const effort = typeof level.effort === 'string' ? level.effort.trim() : '';
			if (!effort) {
				continue;
			}
			const desc =
				typeof level.description === 'string' && level.description.trim()
					? level.description.trim()
					: undefined;
			reasoningLevels.push(toReasoningOption(effort, desc));
		}
		out.push({ id, label, reasoningLevels });
	}
	return out;
}

export function codexReasoningLevelsForModel(
	catalog: CodexModelCatalogEntry[],
	modelId: string,
): ReasoningOption[] {
	const match = catalog.find((m) => m.id === modelId);
	return match?.reasoningLevels ?? [];
}

/** Optional settings fallback only when CLI discovery fails. */
export function modelsFromConfigFallback(
	getModels: (section: string) => string[] | undefined,
	providerId: string,
): { id: string; label: string }[] {
	const key = providerId === 'cursor' ? 'cursor.models' : 'codex.models';
	const configured = (getModels(key) ?? [])
		.map((m) => m.trim())
		.filter((m) => m.length > 0);
	return configured.map((id) => ({ id, label: id }));
}
