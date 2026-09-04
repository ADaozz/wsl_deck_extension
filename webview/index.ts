import type {
	ActivityItem,
	AgentViewState,
	ConversationMessage,
	HostToWebviewMessage,
	ProposedChangeCard,
	WebviewToHostMessage,
} from '../src/ui/messageProtocol';
import { isCommandsActivity, isToolsActivity } from '../src/ui/activityGrouping';
import {
	activityExpandExtra,
	formatActivitySummary,
} from '../src/ui/activityDisplayFormat';
import { renderMarkdown } from './markdown';

function formatResumeUpdatedAt(updatedAt: number, now = Date.now()): string {
	if (!updatedAt || Number.isNaN(updatedAt)) {
		return '';
	}
	const d = new Date(updatedAt);
	const pad = (n: number) => String(n).padStart(2, '0');
	const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
	const mins = Math.floor(Math.max(0, now - updatedAt) / 60_000);
	if (mins < 1) {
		return `${stamp} · just now`;
	}
	if (mins < 60) {
		return `${stamp} · ${mins}m ago`;
	}
	const hours = Math.floor(mins / 60);
	if (hours < 48) {
		return `${stamp} · ${hours}h ago`;
	}
	return stamp;
}

declare function acquireVsCodeApi(): {
	postMessage(message: WebviewToHostMessage): void;
	getState(): unknown;
	setState(state: unknown): void;
};

const vscodeApi = acquireVsCodeApi();

let state: AgentViewState = {
	providers: [],
	selectedProviderId: 'codex',
	models: [],
	selectedModelId: 'default',
	modelsError: undefined,
	modes: [
		{ id: 'agent', label: 'Agent' },
		{ id: 'plan', label: 'Plan' },
	],
	selectedModeId: 'agent',
	reasonings: [],
	selectedReasoningId: 'medium',
	fasts: [],
	selectedFastId: 'false',
	resumes: [],
	status: 'idle',
	messages: [],
	activities: [],
	changes: [],
	slashCommands: [],
	sessionId: '',
};

let draft = '';
type MenuKind = 'none' | 'slash' | 'provider' | 'model' | 'mode' | 'reasoning' | 'fast' | 'resume';
let menuKind: MenuKind = 'none';
let menuFilter = '';
/** -1 = none highlighted until menu opens or pointer hovers a row */
let menuIndex = -1;
/** IME composition (Chinese/Japanese/Korean) — never destroy the textarea while true */
let composing = false;
let pendingState: AgentViewState | undefined;
/** Avoid spamming host while typing `/model …` filter text. */
let modelsFetchPending = false;
/** After Enter/click on a model row, open reasoning when host state catches up. */
let pendingReasoningAfterModel: string | undefined;
/** After reasoning pick, open fast tier menu when applicable. */
let pendingFastAfterReasoning = false;

function requestModelsIfNeeded(force = false): void {
	if (modelsFetchPending || state.modelsLoading) {
		return;
	}
	if (!force && state.models.length > 0) {
		return;
	}
	modelsFetchPending = true;
	post({ type: 'requestModels' });
}

function openModelMenu(filter = ''): void {
	const entering = menuKind !== 'model';
	const filterChanged = menuFilter !== filter;
	menuKind = 'model';
	menuFilter = filter;
	if (entering || state.models.length === 0) {
		requestModelsIfNeeded(state.models.length === 0);
	}
	if (entering) {
		syncMenuIndexToCurrent('model');
	} else if (filterChanged) {
		clampMenuIndex(currentMenuEntries());
	}
}

function openModeMenu(filter = ''): void {
	menuKind = 'mode';
	menuFilter = filter;
	syncMenuIndexToCurrent('mode');
}

function openReasoningMenu(filter = ''): void {
	menuKind = 'reasoning';
	menuFilter = filter;
	syncMenuIndexToCurrent('reasoning');
}

function openFastMenu(filter = ''): void {
	menuKind = 'fast';
	menuFilter = filter;
	syncMenuIndexToCurrent('fast');
}

function openResumeMenu(filter = ''): void {
	menuKind = 'resume';
	menuFilter = filter;
	syncMenuIndexToCurrent('resume');
}

function syncMenuIndexToCurrent(kind: MenuKind): void {
	const entries = currentMenuEntries();
	if (entries.length === 0) {
		menuIndex = -1;
		return;
	}
	let idx = 0;
	if (kind === 'model') {
		idx = entries.findIndex((e) => e.id === state.selectedModelId);
	} else if (kind === 'reasoning') {
		idx = entries.findIndex((e) => e.id === state.selectedReasoningId);
	} else if (kind === 'fast') {
		idx = entries.findIndex((e) => e.id === state.selectedFastId);
	} else if (kind === 'mode') {
		idx = entries.findIndex((e) => e.id === state.selectedModeId);
	} else if (kind === 'provider') {
		idx = entries.findIndex((e) => e.id === state.selectedProviderId);
	} else if (kind === 'resume') {
		idx = entries.findIndex((e) => e.id === state.sessionId);
	}
	menuIndex = idx >= 0 ? idx : 0;
}

function clampMenuIndex(entries: MenuEntry[]): void {
	if (entries.length === 0) {
		menuIndex = -1;
		return;
	}
	if (menuIndex < 0) {
		menuIndex = 0;
	} else if (menuIndex >= entries.length) {
		menuIndex = entries.length - 1;
	}
}

function scrollActiveMenuItemIntoView(): void {
	const menu = document.getElementById('menu');
	const active = menu?.querySelector('.menu-item.active');
	if (menu && active) {
		active.scrollIntoView({ block: 'nearest' });
	}
}

const THOUGHT_SCROLL_THRESHOLD = 24;
/** Agent message ids pinned to thought-body bottom while streaming. */
const thoughtAutoScrollIds = new Set<string>();

function isNearBottom(el: HTMLElement): boolean {
	return el.scrollHeight - el.clientHeight - el.scrollTop <= THOUGHT_SCROLL_THRESHOLD;
}

function scrollStreamingThoughtBodies(): void {
	for (const msg of state.messages) {
		if (!msg.thoughtStreaming) {
			thoughtAutoScrollIds.delete(msg.id);
			continue;
		}
		if (!thoughtAutoScrollIds.has(msg.id)) {
			thoughtAutoScrollIds.add(msg.id);
		}
		const body = document.querySelector(
			`details.thought[data-thought-id="${CSS.escape(msg.id)}"] .thought-body`,
		);
		if (!(body instanceof HTMLElement)) {
			continue;
		}
		if (thoughtAutoScrollIds.has(msg.id)) {
			body.scrollTop = body.scrollHeight;
		}
	}
}

function bindThoughtScrollPins(): void {
	for (const el of Array.from(document.querySelectorAll('.thought-body'))) {
		el.addEventListener(
			'scroll',
			() => {
				const details = el.closest('details.thought');
				const id = details?.getAttribute('data-thought-id');
				if (!id) {
					return;
				}
				const msg = state.messages.find((m) => m.id === id);
				if (!msg?.thoughtStreaming) {
					return;
				}
				if (isNearBottom(el as HTMLElement)) {
					thoughtAutoScrollIds.add(id);
				} else {
					thoughtAutoScrollIds.delete(id);
				}
			},
			{ passive: true },
		);
	}
}

/** Confirm model from menu row; reasoning step opens after host applies selection. */
function confirmModelPick(modelId: string): void {
	post({ type: 'selectModel', modelId });
	pendingReasoningAfterModel = modelId;
	draft = '';
	const input = document.getElementById('input') as HTMLTextAreaElement | null;
	if (input) {
		input.value = '';
	}
}

function resumeLabel(): string {
	const current = state.resumes.find((r) => r.sessionId === state.sessionId);
	if (current) {
		return current.title;
	}
	return state.sessionId ? 'Current' : 'Resume';
}

function requireElement(id: string): HTMLElement {
	const el = document.getElementById(id);
	if (!el) {
		throw new Error(`#${id} missing`);
	}
	return el;
}

const appRoot = requireElement('app');

function post(message: WebviewToHostMessage): void {
	vscodeApi.postMessage(message);
}

function escapeHtml(text: string): string {
	return text
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;');
}

/** Expanded tool rows (default collapsed). Survives re-render. */
const expandedActivityIds = new Set<string>();
const expandedThoughtIds = new Set<string>();
/** Per-turn changes panel `<details>` open state survives re-render. */
const openChangesPanelIds = new Set<string>();
const expandedChangeIds = new Set<string>();

function changesForAgentMessage(
	all: ProposedChangeCard[],
	message: ConversationMessage,
): ProposedChangeCard[] {
	return all.filter((c) => {
		if (c.revisions.some((r) => r.agentMsgId === message.id)) {
			return true;
		}
		if (message.turnId && c.revisions.some((r) => r.turnId === message.turnId)) {
			return true;
		}
		return false;
	});
}

function shouldUseLegacyChangesFallback(): boolean {
	if (state.changes.length === 0) {
		return false;
	}
	const hasRevisionBinding = state.changes.some(
		(c) => c.revisions.some((r) => r.agentMsgId || r.turnId),
	);
	const hasMessageTurn = state.messages.some((m) => m.role === 'agent' && m.turnId);
	return !hasRevisionBinding && !hasMessageTurn;
}

function formatChangeTime(at: number): string {
	if (!at || Number.isNaN(at)) {
		return '';
	}
	const d = new Date(at);
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function turnShortLabel(turnId: string): string {
	if (!turnId) {
		return '';
	}
	return turnId.length <= 8 ? turnId : `…${turnId.slice(-6)}`;
}
/** Ephemeral toast text (host → webview). */
let toastMessage = '';
let toastUntil = 0;

const CHANGE_ICONS = {
	diff: '<svg class="change-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 2h5v12H2V2zm7 0h5v12H9V2zM3 4h3v2H3V4zm0 6h3v2H3v-2zm7-6h3v2h-3V4zm0 6h3v2h-3v-2z"/></svg>',
	check:
		'<svg class="change-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M6.2 11.2 3.4 8.4l1-1 1.8 1.8 4.4-4.4 1 1-5.4 5.4z"/></svg>',
	x: '<svg class="change-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="m4.5 4.5 3 3 3-3 1 1-3 3 3 3-1 1-3-3-3 3-1-1 3-3-3-3 1-1z"/></svg>',
	compare:
		'<svg class="change-icon" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M2 4h5v1H3v6h4v1H2V4zm12 0v8h-5v-1h4V5H9V4h5z"/></svg>',
} as const;

const COPY_MSG_ICON =
	'<svg class="msg-copy-icon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" focusable="false" aria-hidden="true"><path fill-rule="evenodd" clip-rule="evenodd" d="M15.1006 1.78516C16.793 1.78556 18.165 3.15808 18.165 4.85059V10.8838C18.1649 12.5762 16.7929 13.9478 15.1006 13.9482H13.998V15.0508C13.9976 16.7431 12.626 18.1151 10.9336 18.1152H4.90039C3.20789 18.1152 1.83537 16.7432 1.83496 15.0508V9.01758C1.83496 7.32482 3.20764 5.95215 4.90039 5.95215H6.00195V4.85059C6.00195 3.15783 7.37463 1.78516 9.06738 1.78516H15.1006ZM4.90039 7.28223C3.94218 7.28223 3.16504 8.05936 3.16504 9.01758V15.0508C3.16544 16.0087 3.94243 16.7852 4.90039 16.7852H10.9336C11.8914 16.785 12.6676 16.0086 12.668 15.0508V9.01758C12.668 8.05945 11.8917 7.28237 10.9336 7.28223H4.90039ZM9.06738 3.11523C8.10917 3.11523 7.33203 3.89237 7.33203 4.85059V5.95215H10.9336C12.6262 5.95229 13.998 7.32491 13.998 9.01758V12.6182H15.1006C16.0584 12.6178 16.8348 11.8416 16.835 10.8838V4.85059C16.835 3.89262 16.0585 3.11564 15.1006 3.11523H9.06738Z" fill="currentColor"></path></svg>';

function messageCopyText(message: ConversationMessage): string {
	return message.text ?? '';
}

function canCopyMessage(message: ConversationMessage): boolean {
	if (message.role !== 'user' && message.role !== 'agent') {
		return false;
	}
	if (message.role === 'agent' && message.streaming) {
		return false;
	}
	return messageCopyText(message).trim().length > 0;
}

function renderMessageCopyFooter(message: ConversationMessage): string {
	if (!canCopyMessage(message)) {
		return '';
	}
	return `<div class="msg-footer">
  <button type="button" class="msg-copy-btn" data-action="copyMessage" data-message-id="${escapeHtml(message.id)}" title="Copy message" aria-label="Copy message">${COPY_MSG_ICON}</button>
</div>`;
}

async function copyMessageToClipboard(messageId: string): Promise<void> {
	const message = state.messages.find((m) => m.id === messageId);
	const text = message ? messageCopyText(message) : '';
	if (!text.trim()) {
		showToast('Nothing to copy');
		return;
	}
	try {
		await navigator.clipboard.writeText(text);
		showToast('✓ Copied');
		return;
	} catch {
		// Fallback for environments without clipboard API permission.
	}
	const ta = document.createElement('textarea');
	ta.value = text;
	ta.setAttribute('readonly', '');
	ta.style.position = 'fixed';
	ta.style.left = '-9999px';
	document.body.appendChild(ta);
	ta.select();
	try {
		document.execCommand('copy');
		showToast('✓ Copied');
	} catch {
		showToast('Copy failed');
	} finally {
		document.body.removeChild(ta);
	}
}

function changeIconBtn(
	action: string,
	id: string,
	title: string,
	icon: string,
	className = '',
	extraAttrs = '',
): string {
	return `<button type="button" class="change-icon-btn ${className}" data-action="${escapeHtml(action)}" data-id="${escapeHtml(id)}"${extraAttrs ? ` ${extraAttrs}` : ''} title="${escapeHtml(title)}" aria-label="${escapeHtml(title)}">${icon}</button>`;
}

function changeRowActions(c: ProposedChangeCard): string {
	const parts: string[] = [];
	if (c.state === 'pending' || c.state === 'conflicted') {
		parts.push(changeIconBtn('viewDiff', c.id, 'View Diff', CHANGE_ICONS.diff));
	}
	if (c.state === 'conflicted') {
		parts.push(
			changeIconBtn('compareMain', c.id, 'Compare Main', CHANGE_ICONS.compare),
			changeIconBtn('rejectChange', c.id, 'Cancel', CHANGE_ICONS.x, 'danger'),
			changeIconBtn('acceptChange', c.id, 'Retry Keep', CHANGE_ICONS.check, 'accent'),
		);
	} else if (c.state === 'pending') {
		parts.push(
			changeIconBtn('rejectChange', c.id, 'Cancel', CHANGE_ICONS.x, 'danger'),
			changeIconBtn('acceptChange', c.id, 'Keep', CHANGE_ICONS.check, 'accent'),
		);
	}
	return parts.join('');
}

function renderRevisionRow(c: ProposedChangeCard, rev: ProposedChangeCard['revisions'][number], isLatest: boolean): string {
	const latestMark = isLatest ? ' · latest' : '';
	return `<div class="change-revision-row">
  <span class="change-revision-turn" title="${escapeHtml(rev.turnId)}">${escapeHtml(turnShortLabel(rev.turnId))}</span>
  <span class="change-revision-at">${escapeHtml(formatChangeTime(rev.at))}</span>
  <span class="change-revision-stats"><span class="del">-${rev.deletions}</span><span class="add">+${rev.additions}</span>${escapeHtml(latestMark)}</span>
  ${changeIconBtn('viewRevisionDiff', c.id, 'View revision diff', CHANGE_ICONS.diff, '', ` data-revision-id="${escapeHtml(rev.id)}"`)}
</div>`;
}

function renderChangeRow(c: ProposedChangeCard): string {
	const kindMark = c.kind ? c.kind.slice(0, 1).toUpperCase() : '?';
	const stateClass = c.state && c.state !== 'pending' ? ` is-${c.state}` : '';
	const stateSuffix =
		c.state === 'accepted'
			? ' · accepted'
			: c.state === 'rejected'
				? ' · cancelled'
				: c.state === 'conflicted'
					? ' · conflict'
					: '';
	const updatedLabel = c.updatedAt ? ` · updated ${formatChangeTime(c.updatedAt)}` : '';
	const sinceLabel =
		c.createdAt && c.updatedAt && c.createdAt !== c.updatedAt
			? ` · since ${formatChangeTime(c.createdAt)}`
			: '';
	const conflictWarn =
		c.state === 'conflicted'
			? `<span class="change-warn" title="Main Workspace 已发生变化 — 不会覆盖。可先 Compare Main，或自行对齐后 Retry Keep。" aria-label="Conflict">⚠</span>`
			: '';
	const historyOpen = expandedChangeIds.has(c.id) ? ' open' : '';
	const historyBlock =
		c.revisions.length > 0
			? `<details class="change-history" data-change-id="${escapeHtml(c.id)}"${historyOpen}>
  <summary class="change-history-summary">${c.revisions.length} edit${c.revisions.length === 1 ? '' : 's'}</summary>
  <div class="change-revisions">${c.revisions.map((rev, i) => renderRevisionRow(c, rev, i === c.revisions.length - 1)).join('')}</div>
</details>`
			: '';
	return `<div class="change-card${stateClass}" data-id="${escapeHtml(c.id)}">
  <div class="change-row">
    <span class="change-kind" aria-hidden="true">${escapeHtml(kindMark)}</span>
    <span class="change-path" title="${escapeHtml(c.path)}">${escapeHtml(c.path)}<span class="change-meta">${escapeHtml(updatedLabel + sinceLabel)}</span>${stateSuffix ? `<span class="change-state">${escapeHtml(stateSuffix)}</span>` : ''}</span>
    ${conflictWarn}
    <span class="change-row-actions">${changeRowActions(c)}</span>
    <span class="change-row-stats"><span class="del">-${c.deletions}</span><span class="add">+${c.additions}</span></span>
  </div>
  ${historyBlock}
</div>`;
}

function renderChangesPanel(changes: ProposedChangeCard[], panelId: string): string {
	if (changes.length === 0) {
		return '';
	}
	const actionable = changes.filter((c) => c.state === 'pending' || c.state === 'conflicted');
	const acceptedCount = changes.filter((c) => c.state === 'accepted').length;
	const statsSource = actionable.length > 0 ? actionable : changes;
	const deletions = statsSource.reduce((sum, c) => sum + c.deletions, 0);
	const additions = statsSource.reduce((sum, c) => sum + c.additions, 0);
	const sessionActionable = state.changes.filter(
		(c) => c.state === 'pending' || c.state === 'conflicted',
	);
	const showBulk =
		actionable.length > 0 &&
		actionable.length === sessionActionable.length &&
		actionable.every((c) => sessionActionable.some((s) => s.id === c.id));
	const bulk = showBulk
		? `<span class="changes-bulk">
  ${changeIconBtn('rejectAllChanges', '', 'Cancel All', CHANGE_ICONS.x, 'danger')}
  ${changeIconBtn('acceptAllChanges', '', 'Keep All', CHANGE_ICONS.check, 'accent')}
</span>`
		: '';
	const openAttr = openChangesPanelIds.has(panelId) ? ' open' : '';
	const titleParts: string[] = [];
	if (actionable.length > 0) {
		titleParts.push(`${actionable.length} to review`);
	}
	if (acceptedCount > 0) {
		titleParts.push(`${acceptedCount} kept`);
	}
	if (titleParts.length === 0) {
		titleParts.push(`${changes.length} file${changes.length === 1 ? '' : 's'}`);
	}
	return `<details class="changes-panel" data-panel-id="${escapeHtml(panelId)}"${openAttr}>
  <summary class="changes-summary">
    <span class="changes-caret" aria-hidden="true"></span>
    <span class="changes-title">${escapeHtml(titleParts.join(' · '))}</span>
    <span class="changes-totals"><span class="del">-${deletions}</span><span class="add">+${additions}</span></span>
    ${bulk}
  </summary>
  <div class="changes-list">${changes.map(renderChangeRow).join('')}</div>
</details>`;
}

function bindChangeHistoryToggles(): void {
	for (const el of Array.from(document.querySelectorAll('details.change-history'))) {
		el.addEventListener('toggle', () => {
			const id = el.getAttribute('data-change-id');
			if (!id) {
				return;
			}
			if ((el as HTMLDetailsElement).open) {
				expandedChangeIds.add(id);
			} else {
				expandedChangeIds.delete(id);
			}
		});
	}
}

function bindChangesPanelToggle(): void {
	for (const panel of Array.from(document.querySelectorAll('details.changes-panel'))) {
		panel.addEventListener('toggle', () => {
			const id = panel.getAttribute('data-panel-id');
			if (!id) {
				return;
			}
			if ((panel as HTMLDetailsElement).open) {
				openChangesPanelIds.add(id);
			} else {
				openChangesPanelIds.delete(id);
			}
		});
	}
}

function progressMark(item: ActivityItem): string {
	if (item.status === 'running') {
		return '●';
	}
	if (item.status === 'failed') {
		return '✕';
	}
	return '✓';
}

function renderActivityLine(item: ActivityItem): string {
	const summary = formatActivitySummary(item, state.changes);
	const extra = activityExpandExtra(item, state.changes);
	if (!extra) {
		return `<div class="progress-line ${escapeHtml(item.status)}">
  <span class="progress-mark" aria-hidden="true">${progressMark(item)}</span>
  <span class="progress-line-text">${escapeHtml(summary)}</span>
</div>`;
	}
	const open = expandedActivityIds.has(item.id) ? ' open' : '';
	return `<details class="progress-item progress-line-item ${escapeHtml(item.status)}" data-activity-id="${escapeHtml(item.id)}"${open}>
  <summary class="progress-summary progress-line-summary">
    <span class="progress-caret" aria-hidden="true"></span>
    <span class="progress-mark" aria-hidden="true">${progressMark(item)}</span>
    <span class="progress-line-text">${escapeHtml(summary)}</span>
  </summary>
  <div class="progress-expand">${escapeHtml(extra)}</div>
</details>`;
}

function renderActivityGroup(
	items: ActivityItem[],
	groupId: string,
	agentRunning: boolean,
	noun: string,
): string {
	if (items.length === 0) {
		return '';
	}
	const anyRunning = items.some((i) => i.status === 'running');
	const failed = items.some((i) => i.status === 'failed');
	const groupMark = anyRunning || agentRunning ? '●' : failed ? '✕' : '✓';
	const preferOpen = agentRunning || anyRunning;
	const open = preferOpen ? ' open' : '';
	const openAttr = preferOpen ? ' open' : '';
	return `<details class="progress-group${open}" data-activity-id="${escapeHtml(groupId)}"${openAttr}>
  <summary class="progress-summary progress-group-summary">
    <span class="progress-caret" aria-hidden="true"></span>
    <span class="progress-mark" aria-hidden="true">${groupMark}</span>
    <span class="progress-label">${items.length} ${noun}${items.length === 1 ? '' : 's'}</span>
  </summary>
  <div class="progress-group-body">${items.map(renderActivityLine).join('')}</div>
</details>`;
}

function renderActivities(rows: ActivityItem[], agentMsgId: string, agentRunning: boolean): string {
	if (rows.length === 0) {
		if (!agentRunning) {
			return '';
		}
		return `<div class="progress"><div class="progress-line running">
  <span class="progress-mark" aria-hidden="true">●</span>
  <span class="progress-line-text">Working…</span>
</div></div>`;
	}
	const tools = rows.filter(isToolsActivity);
	const commands = rows.filter(isCommandsActivity);
	const parts: string[] = [];
	if (tools.length > 0) {
		parts.push(renderActivityGroup(tools, `${agentMsgId}:tools`, agentRunning, 'tool'));
	}
	if (commands.length > 0) {
		parts.push(renderActivityGroup(commands, `${agentMsgId}:commands`, agentRunning, 'command'));
	}
	if (agentRunning) {
		parts.push(`<div class="progress-line running progress-tail">
  <span class="progress-mark" aria-hidden="true">●</span>
  <span class="progress-line-text">Working…</span>
</div>`);
	}
	return `<div class="progress">${parts.join('')}</div>`;
}

function roleLabel(message: ConversationMessage): string {
	if (message.role === 'user') {
		return 'You';
	}
	if (message.role === 'agent') {
		if (message.agentLabel?.trim()) {
			return message.agentLabel.trim();
		}
		const p = state.providers.find((x) => x.id === state.selectedProviderId);
		return p?.displayName ?? state.selectedProviderId ?? 'Agent';
	}
	return 'System';
}

function avatarLetter(message: ConversationMessage): string {
	if (message.role === 'user') {
		return 'Y';
	}
	if (message.role === 'agent') {
		const label = roleLabel(message);
		return (label[0] ?? 'A').toUpperCase();
	}
	return 'S';
}

function renderThought(message: ConversationMessage): string {
	const thought = message.thought?.trim();
	if (!thought) {
		return '';
	}
	const preferOpen = Boolean(message.thoughtStreaming) || expandedThoughtIds.has(message.id);
	const streaming = message.thoughtStreaming ? ' streaming' : '';
	const open = preferOpen ? ' open' : '';
	const openAttr = preferOpen ? ' open' : '';
	return `<details class="thought${streaming}${open}" data-thought-id="${escapeHtml(message.id)}"${openAttr}>
  <summary class="thought-summary">
    <span class="thought-caret" aria-hidden="true"></span>
    <span class="thought-label">${message.thoughtStreaming ? 'Thinking…' : 'Thought'}</span>
  </summary>
  <div class="thought-body">${escapeHtml(message.thought ?? '')}</div>
</details>`;
}

function renderMessage(message: ConversationMessage, activitiesHtml = ''): string {
	if (message.role === 'system') {
		return `<div class="msg system"><div class="msg-body">${escapeHtml(message.text)}</div></div>`;
	}
	const thoughtHtml = message.role === 'agent' ? renderThought(message) : '';
	const body =
		message.role === 'agent'
			? message.text.trim() || message.streaming
				? `<div class="msg-body md${message.streaming ? ' streaming' : ''}">${
						message.text.trim() ? renderMarkdown(message.text) : '<span class="msg-placeholder">…</span>'
					}</div>`
				: ''
			: `<div class="msg-body${message.streaming ? ' streaming' : ''}">${escapeHtml(message.text)}</div>`;
	return `<div class="msg ${escapeHtml(message.role)}">
  <div class="avatar" aria-hidden="true">${escapeHtml(avatarLetter(message))}</div>
  <div class="msg-col">
    <div class="msg-role">${escapeHtml(roleLabel(message))}</div>
    ${message.role === 'agent' ? activitiesHtml : ''}
    ${thoughtHtml}
    ${body}
    ${renderMessageCopyFooter(message)}
  </div>
</div>`;
}

function renderTranscript(): string {
	if (state.messages.length === 0) {
		return `<div class="empty">
  <div class="empty-title">WSLDeck</div>
  <div class="empty-body">Ask anything. Use <b>+</b> / <b>Resume</b> for sessions, <b>/model</b> (Enter → reasoning), <b>/mode</b>. Tool rows come from live metadata.</div>
</div>`;
	}

	const parts: string[] = [];
	const lastAgentId = [...state.messages].reverse().find((m) => m.role === 'agent')?.id;
	const legacyChangesFallback = shouldUseLegacyChangesFallback();

	const progressForAgent = (message: ConversationMessage): string => {
		const frozen = message.activities ?? [];
		const live =
			message.id === lastAgentId && state.activities.length > 0 ? state.activities : [];
		const rows = frozen.length > 0 ? frozen : live;
		const agentRunning =
			message.id === lastAgentId &&
			(state.status === 'running' || state.status === 'waiting');
		return renderActivities(rows, message.id, agentRunning);
	};

	for (let i = 0; i < state.messages.length; i++) {
		const message = state.messages[i];
		const prev = state.messages[i - 1];

		if (message.role === 'system') {
			parts.push(renderMessage(message));
			continue;
		}

		if (message.role === 'user') {
			parts.push('<div class="turn">');
			parts.push(renderMessage(message));
			if (state.messages[i + 1]?.role !== 'agent') {
				parts.push('</div>');
			}
			continue;
		}

		if (message.role === 'agent') {
			if (prev?.role !== 'user') {
				parts.push('<div class="turn">');
			}
			parts.push(renderMessage(message, progressForAgent(message)));
			let turnChanges = changesForAgentMessage(state.changes, message);
			if (legacyChangesFallback && message.id === lastAgentId) {
				turnChanges = state.changes;
			}
			parts.push(renderChangesPanel(turnChanges, message.id));
			parts.push('</div>');
		}
	}

	if (state.pendingPermission) {
		const perm = state.pendingPermission;
		const buttons = perm.options
			.map((o) => {
				const reject = (o.kind ?? '').includes('reject') || /reject/i.test(o.label);
				const cls = reject ? 'secondary' : 'pill';
				return `<button type="button" class="${cls}" data-action="resolvePermission" data-request-id="${escapeHtml(perm.requestId)}" data-option-id="${escapeHtml(o.optionId)}">${escapeHtml(o.label)}</button>`;
			})
			.join('');
		parts.push(`<div class="permission-card">
  <div class="permission-eyebrow">Permission required</div>
  <div class="permission-title">${escapeHtml(perm.title)}</div>
  ${perm.detail ? `<div class="permission-detail">${escapeHtml(perm.detail)}</div>` : ''}
  <div class="permission-actions">${buttons}</div>
</div>`);
	}

	return parts.join('');
}

interface MenuEntry {
	id: string;
	title: string;
	description?: string;
	current?: boolean;
	run: () => void;
}

function currentMenuEntries(): MenuEntry[] {
	const q = menuFilter.toLowerCase();

	if (menuKind === 'provider') {
		return state.providers
			.filter((p) => !q || p.displayName.toLowerCase().includes(q) || p.id.toLowerCase().includes(q))
			.map((p) => ({
				id: p.id,
				title: p.displayName,
				description: p.id,
				current: p.id === state.selectedProviderId,
				run: () => {
					post({ type: 'selectProvider', providerId: p.id });
					menuKind = 'none';
					render();
				},
			}));
	}

	if (menuKind === 'model') {
		if (state.modelsLoading || (state.models.length === 0 && modelsFetchPending)) {
			return [
				{
					id: '_loading',
					title: 'Fetching models from CLI…',
					run: () => undefined,
				},
			];
		}
		if (state.models.length === 0) {
			return [
				{
					id: '_empty',
					title: 'No models discovered',
					description: state.modelsError || 'Run /model or check CLI / API key',
					run: () => {
						requestModelsIfNeeded(true);
					},
				},
			];
		}
		return state.models
			.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
			.map((m) => ({
				id: m.id,
				title: m.label,
				current: m.id === state.selectedModelId,
				run: () => {
					confirmModelPick(m.id);
					focusInput();
				},
			}));
	}

	if (menuKind === 'mode') {
		return state.modes
			.filter((m) => !q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q))
			.map((m) => ({
				id: m.id,
				title: m.label,
				description: m.id,
				current: m.id === state.selectedModeId,
				run: () => {
					post({ type: 'selectMode', modeId: m.id });
					draft = '';
					menuKind = 'none';
					render();
					focusInput();
				},
			}));
	}

	if (menuKind === 'reasoning') {
		if (state.reasonings.length === 0) {
			return [
				{
					id: '_empty',
					title: 'No reasoning levels',
					description: 'This provider has no effort options',
					run: () => {
						menuKind = 'none';
						render();
					},
				},
			];
		}
		return state.reasonings
			.filter(
				(m) =>
					!q ||
					m.label.toLowerCase().includes(q) ||
					m.id.toLowerCase().includes(q) ||
					(m.description?.toLowerCase().includes(q) ?? false),
			)
			.map((m) => ({
				id: m.id,
				title: m.label,
				description: m.description,
				current: m.id === state.selectedReasoningId,
				run: () => {
					post({ type: 'selectReasoning', reasoningId: m.id });
					pendingFastAfterReasoning = true;
					draft = '';
					focusInput();
				},
			}));
	}

	if (menuKind === 'fast') {
		if (state.fasts.length === 0) {
			return [
				{
					id: '_empty',
					title: 'No speed tiers',
					run: () => {
						menuKind = 'none';
						render();
					},
				},
			];
		}
		return state.fasts
			.filter(
				(m) =>
					!q ||
					m.label.toLowerCase().includes(q) ||
					m.id.toLowerCase().includes(q) ||
					(m.description?.toLowerCase().includes(q) ?? false),
			)
			.map((m) => ({
				id: m.id,
				title: m.label,
				description: m.description,
				current: m.id === state.selectedFastId,
				run: () => {
					post({ type: 'selectFast', fastId: m.id });
					draft = '';
					menuKind = 'none';
					render();
					focusInput();
				},
			}));
	}

	if (menuKind === 'resume') {
		const items = state.resumes.filter(
			(r) =>
				!q ||
				r.title.toLowerCase().includes(q) ||
				r.sessionId.toLowerCase().includes(q) ||
				(r.providerSessionId && r.providerSessionId.toLowerCase().includes(q)),
		);
		if (items.length === 0) {
			return [
				{
					id: '_empty',
					title: 'No resumes in this workspace yet',
					description: 'Chat once, then New to archive',
					run: () => undefined,
				},
			];
		}
		return items.map((r) => ({
			id: r.sessionId,
			title: r.title,
			description: formatResumeUpdatedAt(r.updatedAt),
			current: r.sessionId === state.sessionId,
			run: () => {
				post({ type: 'selectResume', sessionId: r.sessionId });
				menuKind = 'none';
				render();
			},
		}));
	}

	if (menuKind === 'slash') {
		const cmds = state.slashCommands.filter((c) => {
			const hay = `${c.command} ${c.description}`.toLowerCase();
			return !q || hay.includes(q.replace(/^\//, ''));
		});
		return cmds.map((c) => ({
			id: c.id,
			title: c.command,
			description: c.description,
			run: () => {
				if (c.command === '/model') {
					draft = '/model ';
					openModelMenu('');
					render();
					focusInput();
					return;
				}
				if (c.command === '/mode') {
					draft = '/mode ';
					openModeMenu('');
					render();
					focusInput();
					return;
				}
				draft = `${c.command} `;
				menuKind = 'none';
				render();
				focusInput();
			},
		}));
	}

	return [];
}

function renderMenu(): string {
	if (menuKind === 'none') {
		return `<div class="menu-pop hidden" id="menu"></div>`;
	}
	const entries = currentMenuEntries();
	if (entries.length === 0) {
		return `<div class="menu-pop" id="menu"><div class="menu-title">No matches</div></div>`;
	}
	const title =
		menuKind === 'model'
			? 'Model'
			: menuKind === 'mode'
				? 'Mode'
				: menuKind === 'reasoning'
					? 'Reasoning'
					: menuKind === 'fast'
						? 'Speed'
						: menuKind === 'provider'
						? 'Agent'
						: menuKind === 'resume'
							? 'Resume'
							: 'Commands';
	const items = entries
		.map((e, i) => {
			const active = menuIndex >= 0 && i === menuIndex ? ' active' : '';
			const current = e.current ? ' current' : '';
			const body =
				menuKind === 'reasoning' && e.description
					? `<span class="menu-item-label reasoning-label">
  <strong class="menu-item-key">${escapeHtml(e.title)}</strong>
  <span class="menu-item-hint">${escapeHtml(e.description)}</span>
</span>`
					: `<span><strong>${escapeHtml(e.title)}</strong>${e.description ? ` <span class="desc">${escapeHtml(e.description)}</span>` : ''}</span>`;
			return `<button type="button" class="menu-item${menuKind === 'reasoning' ? ' reasoning-row' : ''}${active}${current}" data-menu-index="${i}">
  ${body}
  ${e.current ? '<span class="check">✓</span>' : ''}
</button>`;
		})
		.join('');
	return `<div class="menu-pop" id="menu"><div class="menu-title">${title}</div>${items}</div>`;
}

function providerLabel(): string {
	return (
		state.providers.find((p) => p.id === state.selectedProviderId)?.displayName ??
		state.selectedProviderId
	);
}

function modelLabel(): string {
	return (
		state.models.find((m) => m.id === state.selectedModelId)?.label ?? state.selectedModelId
	);
}

function focusInput(): void {
	const input = document.getElementById('input') as HTMLTextAreaElement | null;
	input?.focus();
	if (input && !composing) {
		const len = input.value.length;
		input.setSelectionRange(len, len);
	}
}

function bindActivityToggles(): void {
	for (const el of Array.from(document.querySelectorAll('details.progress-item, details.progress-group'))) {
		el.addEventListener('toggle', () => {
			const id = el.getAttribute('data-activity-id');
			if (!id) {
				return;
			}
			// Command groups auto-collapse when the agent finishes; don't persist open state.
			if (el.classList.contains('progress-group')) {
				return;
			}
			if ((el as HTMLDetailsElement).open) {
				expandedActivityIds.add(id);
			} else {
				expandedActivityIds.delete(id);
			}
		});
	}
}

function bindThoughtToggles(): void {
	for (const el of Array.from(document.querySelectorAll('details.thought'))) {
		el.addEventListener('toggle', () => {
			const id = el.getAttribute('data-thought-id');
			if (!id) {
				return;
			}
			if ((el as HTMLDetailsElement).open) {
				expandedThoughtIds.add(id);
			} else {
				expandedThoughtIds.delete(id);
			}
		});
	}
}

function bindRunCommands(): void {
	for (const el of Array.from(document.querySelectorAll('button.run-cmd'))) {
		el.addEventListener('click', (ev) => {
			ev.preventDefault();
			ev.stopPropagation();
			const encoded = el.getAttribute('data-run-cmd');
			if (!encoded) {
				return;
			}
			try {
				const command = decodeURIComponent(encoded);
				post({ type: 'runInTerminal', command });
			} catch {
				// ignore bad encoding
			}
		});
	}
}

function bindMenuClicks(): void {
	const entries = currentMenuEntries();
	for (const el of Array.from(document.querySelectorAll('[data-menu-index]'))) {
		el.addEventListener('mouseenter', () => {
			const idx = Number(el.getAttribute('data-menu-index'));
			if (!Number.isNaN(idx) && menuIndex !== idx) {
				menuIndex = idx;
				for (const row of Array.from(document.querySelectorAll('[data-menu-index]'))) {
					row.classList.toggle(
						'active',
						Number(row.getAttribute('data-menu-index')) === menuIndex,
					);
				}
			}
		});
		el.addEventListener('click', () => {
			const idx = Number(el.getAttribute('data-menu-index'));
			entries[idx]?.run();
		});
	}
}

/** Update slash/provider/model menu without recreating the textarea (IME-safe). */
function patchMenu(): void {
	if (menuKind !== 'none') {
		clampMenuIndex(currentMenuEntries());
	}
	const footer = document.querySelector('.footer');
	if (!footer) {
		return;
	}
	const existing = document.getElementById('menu');
	const wrap = document.createElement('div');
	wrap.innerHTML = renderMenu();
	const next = wrap.firstElementChild;
	if (!next) {
		return;
	}
	if (existing) {
		existing.replaceWith(next);
	} else {
		footer.insertBefore(next, footer.firstChild);
	}
	bindMenuClicks();
	bindActivityToggles();
	bindThoughtToggles();
	bindRunCommands();
	scrollActiveMenuItemIntoView();
}

function captureDraftFromDom(): void {
	const input = document.getElementById('input') as HTMLTextAreaElement | null;
	if (input) {
		draft = input.value;
	}
}

function applyHostState(next: AgentViewState): void {
	captureDraftFromDom();
	const wasActive = state.status === 'running' || state.status === 'waiting';
	const isActive = next.status === 'running' || next.status === 'waiting';
	if (wasActive && !isActive) {
		for (const id of expandedActivityIds) {
			if (id.endsWith(':commands') || id.endsWith(':tools')) {
				expandedActivityIds.delete(id);
			}
		}
	}
	const prevChangeCount = state.changes.length;
	state = next;
	if (
		next.changes.length > prevChangeCount &&
		(next.status === 'running' || next.status === 'waiting')
	) {
		const lastAgent = [...next.messages].reverse().find((m) => m.role === 'agent');
		if (lastAgent) {
			openChangesPanelIds.add(lastAgent.id);
		}
	}
	if (!next.modelsLoading) {
		modelsFetchPending = false;
	}
	if (pendingReasoningAfterModel && state.selectedModelId === pendingReasoningAfterModel) {
		const picked = pendingReasoningAfterModel;
		pendingReasoningAfterModel = undefined;
		if (picked !== 'auto' && picked !== 'auto-smart' && state.reasonings.length > 0) {
			openReasoningMenu('');
		} else if (picked !== 'auto' && picked !== 'auto-smart' && state.fasts.length > 0) {
			openFastMenu('');
		} else {
			menuKind = 'none';
			menuIndex = -1;
		}
	}
	if (pendingFastAfterReasoning) {
		pendingFastAfterReasoning = false;
		if (state.fasts.length > 0) {
			openFastMenu('');
		} else {
			menuKind = 'none';
			menuIndex = -1;
		}
	}
	if (menuKind !== 'none') {
		focusInput();
	}
	render();
	patchFeedbackBar();
}

function updateSlashMenuFromDraft(): void {
	const value = draft;
	if (menuKind === 'provider') {
		return;
	}

	const modelCmd = /^\/model(?:\s+(.*))?$/i.exec(value);
	if (modelCmd) {
		openModelMenu(modelCmd[1] ?? '');
		return;
	}

	const modeCmd = /^\/mode(?:\s+(.*))?$/i.exec(value);
	if (modeCmd) {
		openModeMenu(modeCmd[1] ?? '');
		return;
	}

	if (value === '/') {
		menuKind = 'slash';
		menuFilter = '';
		menuIndex = -1;
		return;
	}

	if (/^\/[a-z]*$/i.test(value)) {
		menuKind = 'slash';
		menuFilter = value.slice(1);
		menuIndex = -1;
		return;
	}

	if (
		menuKind === 'slash' ||
		menuKind === 'model' ||
		menuKind === 'mode'
	) {
		menuKind = 'none';
		menuFilter = '';
		menuIndex = -1;
	}
}

/** Arrow / Enter / Escape for any open menu (document-level so focus survives render). */
function handleMenuKeyboard(ev: KeyboardEvent): boolean {
	if (composing || ev.isComposing || ev.keyCode === 229) {
		return false;
	}
	const entriesNow = currentMenuEntries();
	if (menuKind === 'none' || entriesNow.length === 0) {
		return false;
	}
	if (ev.key === 'ArrowDown') {
		menuIndex = menuIndex < 0 ? 0 : (menuIndex + 1) % entriesNow.length;
		patchMenu();
		return true;
	}
	if (ev.key === 'ArrowUp') {
		menuIndex =
			menuIndex < 0
				? entriesNow.length - 1
				: (menuIndex - 1 + entriesNow.length) % entriesNow.length;
		patchMenu();
		return true;
	}
	if (ev.key === 'Enter' && !ev.shiftKey) {
		clampMenuIndex(entriesNow);
		entriesNow[menuIndex]?.run();
		return true;
	}
	if (ev.key === 'Escape') {
		menuKind = 'none';
		menuIndex = -1;
		pendingReasoningAfterModel = undefined;
		pendingFastAfterReasoning = false;
		patchMenu();
		return true;
	}
	return false;
}

function resolveFeedbackText(): string {
	if (toastMessage && Date.now() < toastUntil) {
		return toastMessage;
	}
	if (state.error?.trim()) {
		return state.error.trim();
	}
	if (state.modelsError?.trim()) {
		return state.modelsError.trim();
	}
	if (state.status === 'running') {
		return state.statusDetail?.trim() || `${providerLabel()} working…`;
	}
	if (state.status === 'waiting') {
		return state.statusDetail?.trim() || 'Waiting for permission…';
	}
	if (state.statusDetail?.trim()) {
		if (state.modelsLoading) {
			return state.statusDetail.trim();
		}
	}
	return '';
}

function patchFeedbackBar(): void {
	const bar = document.getElementById('feedback');
	if (!bar) {
		return;
	}
	const text = resolveFeedbackText();
	bar.textContent = text;
	bar.classList.toggle('hidden', !text);
	bar.classList.toggle('error', state.status === 'error' || Boolean(state.error));
}

function showToast(message: string): void {
	toastMessage = message;
	toastUntil = Date.now() + 6000;
	patchFeedbackBar();
}

function renderFeedbackBar(): string {
	const text = resolveFeedbackText();
	if (!text) {
		return `<div class="feedback-bar hidden" id="feedback" role="status" aria-live="polite"></div>`;
	}
	const cls = state.status === 'error' ? 'feedback-bar error' : 'feedback-bar';
	return `<div class="${cls}" id="feedback" role="status" aria-live="polite">${escapeHtml(text)}</div>`;
}

function render(): void {
	const running = state.status === 'running' || state.status === 'waiting';

	appRoot.innerHTML = `
  <div class="scroll" id="scroll">${renderTranscript()}</div>
  <div class="footer">
    ${renderMenu()}
    ${renderFeedbackBar()}
    <div class="composer">
      <textarea id="input" rows="2" placeholder="Ask Agent…  (/model · Enter→reasoning · /mode)" ${running ? 'disabled' : ''}>${escapeHtml(draft)}</textarea>
      <div class="composer-toolbar">
        <div class="picker-row">
          <button type="button" class="composer-btn" id="newBtn" title="New session" aria-label="New session" ${running ? 'disabled' : ''}>
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" focusable="false" class="icon" aria-hidden="true">
              <path fill="currentColor" d="M10 3.5a.75.75 0 0 1 .75.75v5h5a.75.75 0 0 1 0 1.5h-5v5a.75.75 0 0 1-1.5 0v-5h-5a.75.75 0 0 1 0-1.5h5v-5A.75.75 0 0 1 10 3.5Z"/>
            </svg>
          </button>
          <button type="button" class="chip agent" id="providerChip" title="Switch agent" ${running ? 'disabled' : ''}>
            <span class="chip-label">${escapeHtml(providerLabel())}</span>
            <span class="chip-caret">▾</span>
          </button>
          <button type="button" class="chip model" id="modelChip" title="Switch model (/model)" ${running ? 'disabled' : ''}>
            <span class="chip-label">${escapeHtml(modelLabel())}</span>
            <span class="chip-caret">▾</span>
          </button>
          <button type="button" class="chip resume" id="resumeChip" title="Resume a session in this workspace" ${running ? 'disabled' : ''}>
            <span class="chip-label">${escapeHtml(resumeLabel())}</span>
            <span class="chip-caret">▾</span>
          </button>
        </div>
        <div class="composer-actions">
          ${
						running
							? `<button type="button" class="stop" id="cancel" title="Stop" aria-label="Stop"><span class="stop-icon" aria-hidden="true"></span></button>`
							: `<button class="send" id="send" title="Send" aria-label="Send">↑</button>`
					}
        </div>
      </div>
    </div>
  </div>`;

	const scroll = document.getElementById('scroll');
	if (scroll) {
		scroll.scrollTop = scroll.scrollHeight;
	}
	requestAnimationFrame(() => {
		scrollStreamingThoughtBodies();
		const scrollEl = document.getElementById('scroll');
		if (scrollEl && state.messages.some((m) => m.thoughtStreaming)) {
			scrollEl.scrollTop = scrollEl.scrollHeight;
		}
	});

	const input = document.getElementById('input') as HTMLTextAreaElement | null;
	if (input) {
		input.addEventListener('compositionstart', () => {
			composing = true;
		});
		input.addEventListener('compositionend', () => {
			composing = false;
			draft = input.value;
			updateSlashMenuFromDraft();
			patchMenu();
			if (pendingState) {
				const queued = pendingState;
				pendingState = undefined;
				applyHostState(queued);
				focusInput();
			}
		});
		input.addEventListener('input', () => {
			draft = input.value;
			// During IME composition, do not touch the DOM — rebuilding kills 中文输入.
			if (composing) {
				return;
			}
			const prevKind = menuKind;
			const prevFilter = menuFilter;
			const prevIndex = menuIndex;
			updateSlashMenuFromDraft();
			if (
				menuKind !== prevKind ||
				menuFilter !== prevFilter ||
				menuIndex !== prevIndex ||
				menuKind !== 'none'
			) {
				patchMenu();
			}
		});
	}

	document.getElementById('providerChip')?.addEventListener('click', () => {
		captureDraftFromDom();
		menuKind = menuKind === 'provider' ? 'none' : 'provider';
		menuFilter = '';
		menuIndex = -1;
		patchMenu();
	});

	document.getElementById('modelChip')?.addEventListener('click', () => {
		captureDraftFromDom();
		if (menuKind === 'model') {
			menuKind = 'none';
			menuFilter = '';
			menuIndex = -1;
		} else {
			openModelMenu('');
		}
		patchMenu();
	});

	document.getElementById('resumeChip')?.addEventListener('click', () => {
		captureDraftFromDom();
		if (menuKind === 'resume') {
			menuKind = 'none';
			menuFilter = '';
			menuIndex = -1;
		} else {
			openResumeMenu('');
		}
		patchMenu();
	});

	document.getElementById('newBtn')?.addEventListener('click', () => {
		captureDraftFromDom();
		menuKind = 'none';
		menuFilter = '';
		menuIndex = -1;
		post({ type: 'newSession' });
		patchMenu();
	});

	bindMenuClicks();
	bindActivityToggles();
	bindThoughtToggles();
	bindThoughtScrollPins();
	bindRunCommands();

	const send = document.getElementById('send');
	const cancel = document.getElementById('cancel');

	const submit = () => {
		if (!input || running || composing) {
			return;
		}
		const text = input.value.trim();
		if (!text) {
			return;
		}
		draft = '';
		menuKind = 'none';
		input.value = '';
		post({ type: 'sendPrompt', text });
		patchMenu();
	};

	send?.addEventListener('click', submit);
	cancel?.addEventListener('click', () => post({ type: 'cancel' }));
	input?.addEventListener('keydown', (ev) => {
		if (composing || ev.isComposing || ev.keyCode === 229) {
			return;
		}
		if (handleMenuKeyboard(ev)) {
			ev.preventDefault();
			return;
		}
		if (ev.key === 'Enter' && !ev.shiftKey) {
			ev.preventDefault();
			submit();
		}
	});

	bindChangesPanelToggle();
	bindChangeHistoryToggles();

	for (const el of Array.from(appRoot.querySelectorAll('[data-action]'))) {
		el.addEventListener('click', (ev) => {
			ev.stopPropagation();
			const action = el.getAttribute('data-action');
			const id = el.getAttribute('data-id') ?? '';
			if (action === 'resolvePermission') {
				const requestId = el.getAttribute('data-request-id') ?? '';
				const optionId = el.getAttribute('data-option-id') ?? '';
				if (requestId && optionId) {
					post({ type: 'resolvePermission', requestId, optionId });
				}
				return;
			}
			if (action === 'viewDiff') {
				post({ type: 'viewDiff', changeId: id });
			} else if (action === 'acceptChange') {
				post({ type: 'acceptChange', changeId: id });
			} else if (action === 'rejectChange') {
				post({ type: 'rejectChange', changeId: id });
			} else if (action === 'acceptAllChanges') {
				post({ type: 'acceptAllChanges' });
			} else if (action === 'rejectAllChanges') {
				post({ type: 'rejectAllChanges' });
			} else if (action === 'compareMain') {
				post({ type: 'compareMain', changeId: id });
			} else if (action === 'viewRevisionDiff') {
				const revisionId = el.getAttribute('data-revision-id') ?? '';
				if (revisionId) {
					post({ type: 'viewRevisionDiff', changeId: id, revisionId });
				}
			} else if (action === 'copyMessage') {
				const messageId = el.getAttribute('data-message-id') ?? '';
				if (messageId) {
					void copyMessageToClipboard(messageId);
				}
			}
		});
	}
}

window.addEventListener('message', (event: MessageEvent<HostToWebviewMessage>) => {
	const message = event.data;
	if (!message || typeof message !== 'object') {
		return;
	}
	if (message.type === 'state') {
		if (composing) {
			pendingState = message.state;
			return;
		}
		applyHostState(message.state);
		return;
	}
	if (message.type === 'toast') {
		showToast(message.message);
		return;
	}
});

render();
post({ type: 'ready' });

document.addEventListener(
	'keydown',
	(ev) => {
		if (handleMenuKeyboard(ev)) {
			ev.preventDefault();
			ev.stopPropagation();
		}
	},
	true,
);
