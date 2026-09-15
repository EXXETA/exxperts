// A tiny line differ for "What changed" on a memory history row: no
// dependency, pure functions, the same walk the Memory tab used before the
// notes-first reshape. The two texts are one topic's notes before and after a
// save, so the documents are short and the table stays small.

export interface DiffLine {
	type: "same" | "add" | "del";
	text: string;
}

/**
 * Line diff of two snapshot texts: common prefix/suffix trimmed, then an LCS
 * walk over the middle. Memory documents are a few thousand lines at most; if
 * the changed middle is ever too large for the table, an honest coarse diff
 * (everything removed, everything added) beats a frozen tab.
 */
export function diffLines(beforeText: string, afterText: string): DiffLine[] {
	const a = beforeText.split("\n");
	const b = afterText.split("\n");
	let start = 0;
	while (start < a.length && start < b.length && a[start] === b[start]) start++;
	let endA = a.length;
	let endB = b.length;
	while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) { endA--; endB--; }
	const midA = a.slice(start, endA);
	const midB = b.slice(start, endB);
	let mid: DiffLine[];
	if (midA.length * midB.length > 1_000_000) {
		mid = [...midA.map((text) => ({ type: "del" as const, text })), ...midB.map((text) => ({ type: "add" as const, text }))];
	} else {
		const m = midA.length;
		const n = midB.length;
		const w = n + 1;
		const dp = new Uint32Array((m + 1) * w);
		for (let i = m - 1; i >= 0; i--) {
			for (let j = n - 1; j >= 0; j--) {
				dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
			}
		}
		mid = [];
		let i = 0;
		let j = 0;
		while (i < m && j < n) {
			if (midA[i] === midB[j]) { mid.push({ type: "same", text: midA[i] }); i++; j++; }
			else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) { mid.push({ type: "del", text: midA[i] }); i++; }
			else { mid.push({ type: "add", text: midB[j] }); j++; }
		}
		while (i < m) mid.push({ type: "del", text: midA[i++] });
		while (j < n) mid.push({ type: "add", text: midB[j++] });
	}
	return [
		...a.slice(0, start).map((text) => ({ type: "same" as const, text })),
		...mid,
		...a.slice(endA).map((text) => ({ type: "same" as const, text })),
	];
}

/**
 * Word diff of one note's text before and after: both sides split on
 * whitespace and walked by the line differ, one token per line. The tokens
 * come back in order with their type, so the old text can strike its removed
 * words and the new text mark its added ones.
 */
export function diffWords(beforeText: string, afterText: string): DiffLine[] {
	const tokens = (text: string) => text.split(/\s+/).filter((t) => t.length > 0).join("\n");
	const a = tokens(beforeText);
	const b = tokens(afterText);
	if (a === "" && b === "") return [];
	return diffLines(a, b).filter((t) => t.text.length > 0);
}

/**
 * A note's text as one plain line for the change view: the list marker and
 * emphasis marks a stored note may carry are dropped, whitespace collapsed.
 */
export function plainNoteText(text: string): string {
	return text
		.replace(/^\s*(?:[-*+]|\d+[.)])\s+/, "")
		.replace(/(\*\*|__)(.+?)\1/g, "$2")
		.replace(/`([^`]*)`/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}

export interface DiffHunk {
	lines: DiffLine[];
}

/**
 * Group each contiguous changed region into one removed block followed by one
 * added block (instead of alternating line by line), so a replacement reads
 * as "this went out, this came in" while staying the complete diff.
 */
export function coalesceRuns(lines: DiffLine[]): DiffLine[] {
	const out: DiffLine[] = [];
	let dels: DiffLine[] = [];
	let adds: DiffLine[] = [];
	const flush = () => { out.push(...dels, ...adds); dels = []; adds = []; };
	for (const line of lines) {
		if (line.type === "del") dels.push(line);
		else if (line.type === "add") adds.push(line);
		else { flush(); out.push(line); }
	}
	flush();
	return out;
}

/** Changed lines with two lines of context, split into hunks. */
export function diffHunks(lines: DiffLine[]): DiffHunk[] {
	const CONTEXT = 2;
	const changed: number[] = [];
	for (let i = 0; i < lines.length; i++) if (lines[i].type !== "same") changed.push(i);
	if (changed.length === 0) return [];
	const ranges: Array<[number, number]> = [];
	for (const i of changed) {
		const lo = Math.max(0, i - CONTEXT);
		const hi = Math.min(lines.length - 1, i + CONTEXT);
		const last = ranges[ranges.length - 1];
		if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
		else ranges.push([lo, hi]);
	}
	return ranges.map(([lo, hi]) => ({ lines: lines.slice(lo, hi + 1) }));
}
