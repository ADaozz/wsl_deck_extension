import type { ModelListItem, ModelParameterDefinition, ModelParameterValue } from '@cursor/sdk';
import {
	REASONING_LEVEL_DESCRIPTIONS,
	toReasoningOption,
	type ReasoningOption,
} from '../../sessionConfigSlash';

/** Flat selectable model row (CLI / ACP model id + UI label). */
export interface CursorSdkModelEntry {
	/** Flat id passed to ACP / CLI (`composer-2.5-fast` or bracket override). */
	id: string;
	label: string;
	baseId: string;
	params: Array<{ id: string; value: string }>;
}

export interface CursorSdkCatalog {
	models: CursorSdkModelEntry[];
	byFlatId: Map<string, CursorSdkModelEntry>;
	baseParameters: Map<string, ModelParameterDefinition[]>;
	baseDisplayNames: Map<string, string>;
	/** Default preset flat id per SDK base model id. */
	defaultFlatIdByBase: Map<string, string>;
	fetchedAt: number;
}

const REASONING_PARAM_IDS = ['effort', 'reasoning', 'thinking', 'reasoning_effort'] as const;

export function reasoningParamId(
	parameters: ModelParameterDefinition[] | undefined,
): (typeof REASONING_PARAM_IDS)[number] | undefined {
	for (const id of REASONING_PARAM_IDS) {
		if (parameters?.some((p) => p.id === id)) {
			return id;
		}
	}
	return undefined;
}

export function hasFastParameter(parameters: ModelParameterDefinition[] | undefined): boolean {
	return !!parameters?.some((p) => p.id === 'fast' && (p.values?.length ?? 0) > 1);
}

function paramValueToHyphenSegment(paramId: string, value: string): string | undefined {
	if (!value || value === 'none') {
		return undefined;
	}
	if (paramId === 'thinking') {
		return value === 'true' ? 'thinking' : undefined;
	}
	if (paramId === 'fast') {
		return value === 'true' ? 'fast' : undefined;
	}
	if (paramId === 'reasoning' || paramId === 'effort' || paramId === 'reasoning_effort') {
		if (value === 'extra-high') {
			return 'xhigh';
		}
		return value;
	}
	return value;
}

/** Build CLI-style bracket override id (always valid per Cursor CLI). */
export function buildBracketModelId(
	baseId: string,
	params: Array<{ id: string; value: string }>,
): string {
	if (params.length === 0) {
		return baseId;
	}
	const inner = [...params]
		.sort((a, b) => a.id.localeCompare(b.id))
		.map((p) => `${p.id}=${formatParamValue(p.value)}`)
		.join(',');
	return `${baseId}[${inner}]`;
}

function formatParamValue(value: string): string {
	if (value === 'true' || value === 'false') {
		return value;
	}
	if (/^[\w.+:-]+$/.test(value)) {
		return value;
	}
	return `"${value.replace(/"/g, '\\"')}"`;
}

/** Best-effort hyphen preset id to align with `agent --list-models` rows. */
export function variantToHyphenFlatId(
	baseId: string,
	params: ModelParameterValue[],
): string {
	const map = new Map(params.map((p) => [p.id, p.value]));
	let id = baseId;
	const thinking = map.get('thinking');
	if (thinking === 'true') {
		id += '-thinking';
	}
	const effort = map.get('effort') ?? map.get('reasoning') ?? map.get('reasoning_effort');
	if (effort) {
		const seg = paramValueToHyphenSegment('reasoning', effort);
		if (seg) {
			id += `-${seg}`;
		}
	}
	if (map.get('fast') === 'true') {
		id += '-fast';
	}
	return id;
}

function normalizeParams(params: ModelParameterValue[]): Array<{ id: string; value: string }> {
	return params.map((p) => ({ id: p.id, value: p.value }));
}

function resolveBaseId(catalog: CursorSdkCatalog, flatModelId: string): string {
	const entry = catalog.byFlatId.get(flatModelId);
	if (entry) {
		return entry.baseId;
	}
	const stripped = flatModelId.replace(/\[.*$/, '');
	if (catalog.baseDisplayNames.has(stripped)) {
		return stripped;
	}
	for (const [baseId, flatId] of catalog.defaultFlatIdByBase) {
		if (flatId === flatModelId || flatId === stripped) {
			return baseId;
		}
	}
	return stripped;
}

function entryForModel(catalog: CursorSdkCatalog, flatModelId: string): CursorSdkModelEntry | undefined {
	const direct = catalog.byFlatId.get(flatModelId);
	if (direct) {
		return direct;
	}
	const baseId = resolveBaseId(catalog, flatModelId);
	const defaultFlat = catalog.defaultFlatIdByBase.get(baseId);
	if (defaultFlat) {
		return catalog.byFlatId.get(defaultFlat);
	}
	return catalog.byFlatId.get(baseId);
}

export function parseSdkModelList(items: ModelListItem[]): CursorSdkCatalog {
	const models: CursorSdkModelEntry[] = [];
	const byFlatId = new Map<string, CursorSdkModelEntry>();
	const baseParameters = new Map<string, ModelParameterDefinition[]>();
	const baseDisplayNames = new Map<string, string>();
	const defaultFlatIdByBase = new Map<string, string>();

	const addEntry = (
		flatId: string,
		label: string,
		baseId: string,
		params: Array<{ id: string; value: string }>,
	) => {
		const tid = flatId.trim();
		if (!tid || byFlatId.has(tid)) {
			return;
		}
		const entry: CursorSdkModelEntry = {
			id: tid,
			label: label.trim() || tid,
			baseId,
			params,
		};
		models.push(entry);
		byFlatId.set(tid, entry);
	};

	for (const item of items) {
		baseParameters.set(item.id, item.parameters ?? []);
		baseDisplayNames.set(item.id, item.displayName);

		const variants = item.variants ?? [];
		let defaultFlatId: string | undefined;

		if (variants.length === 0) {
			addEntry(item.id, item.displayName, item.id, []);
			defaultFlatId = item.id;
		} else {
			for (const variant of variants) {
				const params = normalizeParams(variant.params);
				const hyphenId = variantToHyphenFlatId(item.id, variant.params);
				const bracketId = buildBracketModelId(item.id, params);
				const label = item.displayName;
				addEntry(hyphenId, label, item.id, params);
				if (bracketId !== hyphenId) {
					addEntry(bracketId, label, item.id, params);
				}
				if (variant.isDefault) {
					defaultFlatId = hyphenId;
				}
			}
			if (!defaultFlatId) {
				const first = variants[0];
				defaultFlatId = variantToHyphenFlatId(item.id, first.params);
			}
		}

		if (defaultFlatId) {
			defaultFlatIdByBase.set(item.id, defaultFlatId);
		}

		for (const alias of item.aliases ?? []) {
			const preset = defaultFlatIdByBase.get(item.id) ?? item.id;
			addEntry(alias, item.displayName, item.id, byFlatId.get(preset)?.params ?? []);
		}
	}

	models.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
	return {
		models,
		byFlatId,
		baseParameters,
		baseDisplayNames,
		defaultFlatIdByBase,
		fetchedAt: Date.now(),
	};
}

/** One menu row per SDK base model (default preset flat id). */
export function catalogToAgentModels(
	catalog: CursorSdkCatalog,
): Array<{ id: string; label: string }> {
	const out: Array<{ id: string; label: string }> = [];
	for (const [baseId, displayName] of catalog.baseDisplayNames) {
		const flatId = catalog.defaultFlatIdByBase.get(baseId) ?? baseId;
		let listId = flatId;
		if (baseId === 'default') {
			listId = catalog.byFlatId.has('auto') ? 'auto' : flatId;
		}
		out.push({ id: listId, label: displayName });
	}
	return out.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
}

function optionsForParam(
	def: ModelParameterDefinition,
	paramId: string,
): ReasoningOption[] {
	const out: ReasoningOption[] = [];
	for (const v of def.values ?? []) {
		const value = v.value?.trim();
		if (!value || value === 'none') {
			continue;
		}
		if (paramId === 'thinking' && value !== 'true' && value !== 'false') {
			continue;
		}
		const label =
			v.displayName?.trim() ||
			REASONING_LEVEL_DESCRIPTIONS[value.toLowerCase()] ||
			value;
		out.push(toReasoningOption(value, label));
	}
	if (out.length === 0 && paramId === 'thinking') {
		return [toReasoningOption('false', 'Off'), toReasoningOption('true', 'On')];
	}
	return out;
}

export function reasoningOptionsForModel(
	catalog: CursorSdkCatalog,
	flatModelId: string,
): ReasoningOption[] {
	const baseId = resolveBaseId(catalog, flatModelId);
	const params = catalog.baseParameters.get(baseId);
	const paramId = reasoningParamId(params);
	if (!paramId || !params) {
		return [];
	}
	const def = params.find((p) => p.id === paramId);
	if (!def) {
		return [];
	}
	return optionsForParam(def, paramId);
}

export function fastOptionsForModel(
	catalog: CursorSdkCatalog,
	flatModelId: string,
): ReasoningOption[] {
	const baseId = resolveBaseId(catalog, flatModelId);
	const params = catalog.baseParameters.get(baseId);
	const def = params?.find((p) => p.id === 'fast');
	if (!def || (def.values?.length ?? 0) <= 1) {
		return [];
	}
	return optionsForParam(def, 'fast').map((o) =>
		o.id === 'true'
			? toReasoningOption('true', o.label || 'Fast')
			: toReasoningOption('false', o.label || 'Standard'),
	);
}

export function modelIdWithParam(
	catalog: CursorSdkCatalog,
	flatModelId: string,
	paramId: string,
	value: string,
): string | undefined {
	const entry = entryForModel(catalog, flatModelId);
	const baseId = entry?.baseId ?? resolveBaseId(catalog, flatModelId);
	const params = [...(entry?.params ?? [])];
	const idx = params.findIndex((p) => p.id === paramId);
	if (idx >= 0) {
		params[idx] = { id: paramId, value };
	} else {
		params.push({ id: paramId, value });
	}
	const hyphen = variantToHyphenFlatId(
		baseId,
		params.map((p) => ({ id: p.id, value: p.value })),
	);
	if (catalog.byFlatId.has(hyphen)) {
		return hyphen;
	}
	const bracket = buildBracketModelId(baseId, params);
	if (catalog.byFlatId.has(bracket)) {
		return bracket;
	}
	return hyphen;
}

export function modelIdWithReasoning(
	catalog: CursorSdkCatalog,
	flatModelId: string,
	reasoningValue: string,
): string | undefined {
	const baseId = resolveBaseId(catalog, flatModelId);
	const paramId = reasoningParamId(catalog.baseParameters.get(baseId));
	if (!paramId) {
		return undefined;
	}
	return modelIdWithParam(catalog, flatModelId, paramId, reasoningValue);
}

export function modelIdWithFast(
	catalog: CursorSdkCatalog,
	flatModelId: string,
	fastValue: string,
): string | undefined {
	if (!hasFastParameter(catalog.baseParameters.get(resolveBaseId(catalog, flatModelId)))) {
		return undefined;
	}
	return modelIdWithParam(catalog, flatModelId, 'fast', fastValue);
}

export async function fetchCursorSdkCatalog(apiKey: string): Promise<CursorSdkCatalog> {
	// CJS require — VSIX ships node_modules/@cursor/sdk (see .vscodeignore).
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const { Cursor } = require('@cursor/sdk') as typeof import('@cursor/sdk');
	const models = await Cursor.models.list({ apiKey: apiKey.trim() });
	return parseSdkModelList(models);
}
