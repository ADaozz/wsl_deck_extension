import { activityPathHint, isFileMutatingActivity } from './activityGrouping';
import type { ActivityItem, ProposedChangeCard } from './messageProtocol';

function changeStatsForItem(
	item: ActivityItem,
	changes: ProposedChangeCard[],
): { additions: number; deletions: number } | undefined {
	if (item.changeAdditions !== undefined && item.changeDeletions !== undefined) {
		return { additions: item.changeAdditions, deletions: item.changeDeletions };
	}
	const hint = activityPathHint(item);
	if (!hint) {
		return undefined;
	}
	const norm = hint.replace(/\\/g, '/');
	const base = norm.split('/').pop() ?? norm;
	const change = changes.find(
		(c) =>
			c.path === norm ||
			c.path.endsWith(`/${norm}`) ||
			c.path === base ||
			c.path.endsWith(`/${base}`),
	);
	if (!change) {
		return undefined;
	}
	return { additions: change.additions, deletions: change.deletions };
}

function quoteShort(value: string): string {
	return `"${value.replace(/"/g, '\\"')}"`;
}

/** One-line activity summary — avoids repeating kind/status/detail in expand body. */
export function formatActivitySummary(
	item: ActivityItem,
	changes: ProposedChangeCard[] = [],
): string {
	const detail = item.detail?.trim();
	const label = item.label.trim();

	if (isFileMutatingActivity(item) && detail) {
		const file = detail.split('/').pop() || detail;
		const stats = changeStatsForItem(item, changes);
		const statsStr = stats ? ` +${stats.additions} -${stats.deletions}` : '';
		return `${label} ${quoteShort(file)}${statsStr}`;
	}

	if (detail) {
		const normDetail = detail.toLowerCase();
		const normLabel = label.toLowerCase();
		if (normDetail === normLabel || normLabel.includes(normDetail)) {
			return label;
		}
		if (normDetail.includes(normLabel) && detail.length <= 96) {
			return quoteShort(detail);
		}
		if (detail.length <= 96 && !detail.includes('\n')) {
			return `${label} ${quoteShort(detail)}`;
		}
	}

	return label;
}

/** Expand body only when summary cannot hold the full detail (long / multiline). */
export function activityExpandExtra(
	item: ActivityItem,
	changes: ProposedChangeCard[] = [],
): string | undefined {
	const detail = item.detail?.trim();
	if (!detail) {
		return undefined;
	}
	const summary = formatActivitySummary(item, changes);
	if (detail.includes('\n') || detail.length > 96) {
		if (summary.includes(detail)) {
			return undefined;
		}
		return detail;
	}
	return undefined;
}
