// The date labels under the Memory growth chart. The x axis is spaced by save
// count, not by time, so a busy room puts dozens of saves in a few pixels:
// the axis names the first and the last day and, between them, the first
// save of each new month ("Aug", with the year when it changes), skipping a
// month that would crowd its neighbour. A room that spans less than about a
// month keeps only its first and last day.

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Below this span the months add nothing the first and last day don't say. */
export const AXIS_MONTHS_MIN_SPAN_MS = 28 * 24 * 60 * 60 * 1000;
/** A month label closer than this to the label before or after it is left out. */
export const AXIS_MIN_LABEL_GAP_PX = 40;
/** The first and last day labels ("14 Sep") reach this far in from their anchor at the edge. */
const DAY_LABEL_REACH_PX = 20;

export interface GrowthAxisTick {
	/** Index of the save the label belongs to. */
	index: number;
	/** Where the label is anchored, in chart pixels. */
	x: number;
	label: string;
	anchor: "start" | "middle" | "end";
	kind: "first" | "month" | "last";
}

function dayLabel(ts: number): string {
	const at = new Date(ts);
	return `${at.getDate()} ${MONTHS[at.getMonth()]}`;
}

/**
 * The axis labels for saves at `timestamps` (oldest first), placed at
 * `xOf(index)`. The first day sits at `firstX` (start-anchored) and the last
 * at `lastX` (end-anchored), as the chart draws them; saves without a time
 * (ts <= 0) are passed over.
 */
export function growthAxisTicks(timestamps: readonly number[], xOf: (index: number) => number, firstX: number, lastX: number, minGapPx: number = AXIS_MIN_LABEL_GAP_PX): GrowthAxisTick[] {
	const dated = timestamps.map((ts, index) => ({ ts, index })).filter((point) => point.ts > 0);
	if (dated.length === 0) return [];
	const first = dated[0]!;
	const last = dated[dated.length - 1]!;
	const ticks: GrowthAxisTick[] = [{ index: first.index, x: firstX, label: dayLabel(first.ts), anchor: "start", kind: "first" }];
	const lastTick: GrowthAxisTick | null = last.ts !== first.ts ? { index: last.index, x: lastX, label: dayLabel(last.ts), anchor: "end", kind: "last" } : null;
	if (lastTick && last.ts - first.ts >= AXIS_MONTHS_MIN_SPAN_MS) {
		let previous = new Date(first.ts);
		let labelledYear = previous.getFullYear();
		let placedX = firstX + DAY_LABEL_REACH_PX;
		for (const point of dated.slice(1)) {
			const at = new Date(point.ts);
			const newMonth = at.getFullYear() !== previous.getFullYear() || at.getMonth() !== previous.getMonth();
			previous = at;
			if (!newMonth) continue;
			const x = xOf(point.index);
			// The day labels grow inward from the edges, so they count as sitting
			// a little further in than their anchors.
			if (x - placedX < minGapPx || lastX - DAY_LABEL_REACH_PX - x < minGapPx) continue;
			const year = at.getFullYear();
			ticks.push({ index: point.index, x, label: year !== labelledYear ? `${MONTHS[at.getMonth()]} ${year}` : MONTHS[at.getMonth()]!, anchor: "middle", kind: "month" });
			labelledYear = year;
			placedX = x;
		}
	}
	if (lastTick) ticks.push(lastTick);
	return ticks;
}
