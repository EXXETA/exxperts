// Recent Context entries are `### RC-…` headings inside the `## Recent Context`
// section. Placeholder ("stub") entries are marked in the entry ID, never in the
// title — an ordinary session title that happens to mention "stub" is real
// memory and must count toward the RC caps. Three surfaces count these entries
// (checkpoint metrics, absorb intake, room status/audit); they all go through
// this module so the counting predicate can never diverge again.

export interface RecentContextIdAnalysis {
	ids: string[];
	numericIds: number[];
	duplicateIds: string[];
	malformedHeadings: string[];
	count: number;
}

export function isStubRecentContextId(id: string): boolean {
	return /stub/i.test(id);
}

export function analyzeRecentContextIds(markdown: string): RecentContextIdAnalysis {
	const recentStart = markdown.search(/^##\s+Recent Context\s*$/m);
	if (recentStart < 0) return { ids: [], numericIds: [], duplicateIds: [], malformedHeadings: [], count: 0 };
	const recent = markdown.slice(recentStart);
	const nextSection = recent.slice(1).search(/^##\s+/m);
	const body = nextSection >= 0 ? recent.slice(0, nextSection + 1) : recent;
	const ids: string[] = [];
	const numericIds: number[] = [];
	const malformedHeadings: string[] = [];
	const seen = new Set<string>();
	const duplicateIds = new Set<string>();
	for (const match of body.matchAll(/^###\s+(RC-[^\s|]+).*$/gm)) {
		const heading = match[0].trim();
		const id = match[1].trim();
		if (isStubRecentContextId(id)) continue;
		ids.push(id);
		if (seen.has(id)) duplicateIds.add(id);
		seen.add(id);
		const numeric = /^RC-(\d{4})$/.exec(id);
		if (numeric) numericIds.push(Number(numeric[1]));
		else malformedHeadings.push(heading);
	}
	return { ids, numericIds, duplicateIds: [...duplicateIds], malformedHeadings, count: ids.length };
}

export function countRecentContextEntries(markdown: string): number {
	return analyzeRecentContextIds(markdown).count;
}
