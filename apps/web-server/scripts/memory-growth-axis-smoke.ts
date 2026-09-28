// The Memory growth chart's date axis (apps/web-ui/src/memory-growth-axis.ts).
// The x axis is spaced by save count, so the labels must not follow the saves:
// the first and last day, and the first save of each new month between them,
// with the year only when it changes, a month left out when it would crowd
// its neighbour, and only the two days for a room younger than about a month.

import { AXIS_MIN_LABEL_GAP_PX, growthAxisTicks } from "../../web-ui/src/memory-growth-axis.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const DAY = 24 * 60 * 60 * 1000;
const at = (year: number, month: number, day: number, hour = 12) => new Date(year, month - 1, day, hour).getTime();
// The chart's geometry: saves spread evenly between the two edges.
function axis(timestamps: number[], width = 900) {
	const padL = 40;
	const right = width - 52;
	const X = (i: number) => padL + (timestamps.length > 1 ? (i / (timestamps.length - 1)) * (right - padL) : (right - padL) / 2);
	return growthAxisTicks(timestamps, X, padL, right + 6);
}
const labels = (ticks: ReturnType<typeof growthAxisTicks>) => ticks.map((tick) => tick.label);

// 1. A heavily used room: 120 saves over three months, evenly by count.
{
	const saves: number[] = [];
	for (let i = 0; i < 120; i += 1) saves.push(at(2026, 7, 3) + Math.round((i / 119) * (at(2026, 9, 27) - at(2026, 7, 3))));
	const ticks = axis(saves);
	assert(ticks.length < 10, `a busy room gets a handful of labels, not one per save, got ${ticks.length}`);
	assert(JSON.stringify(labels(ticks)) === JSON.stringify(["3 Jul", "Aug", "Sep", "27 Sep"]), `first day, each new month, last day, got ${JSON.stringify(labels(ticks))}`);
	assert(ticks[0]!.anchor === "start" && ticks[ticks.length - 1]!.anchor === "end" && ticks.slice(1, -1).every((tick) => tick.anchor === "middle"), "the day labels hug the edges, the months are centred");
	const aug = ticks.find((tick) => tick.label === "Aug")!;
	assert(new Date(saves[aug.index]!).getMonth() === 7 && new Date(saves[aug.index - 1]!).getMonth() === 6, "a month label sits at the first save of that month");
	console.log("  ok  a busy room over three months: first day, Aug, Sep, last day");
}

// 2. A light room: three saves within a week keeps only the first and last day.
{
	const ticks = axis([at(2026, 9, 20), at(2026, 9, 22), at(2026, 9, 26)]);
	assert(JSON.stringify(labels(ticks)) === JSON.stringify(["20 Sep", "26 Sep"]), `a young room shows its first and last day, got ${JSON.stringify(labels(ticks))}`);
	// Crossing a month boundary inside a few days adds no month either.
	const short = axis([at(2026, 8, 29), at(2026, 9, 1), at(2026, 9, 3)]);
	assert(JSON.stringify(labels(short)) === JSON.stringify(["29 Aug", "3 Sep"]), `a span under a month gets no month label, got ${JSON.stringify(labels(short))}`);
	const single = axis([at(2026, 9, 20)]);
	assert(JSON.stringify(labels(single)) === JSON.stringify(["20 Sep"]), `one save shows its day once, got ${JSON.stringify(labels(single))}`);
	assert(axis([0, 0]).length === 0, "saves without a time give no labels");
	console.log("  ok  a light room keeps its first and last day only");
}

// 3. Bunching: months whose first saves sit close together by count.
{
	// 100 saves in June, then one each in July, August and September, then 20 in October.
	const saves: number[] = [];
	for (let i = 0; i < 100; i += 1) saves.push(at(2026, 6, 1) + i * 6 * 60 * 60 * 1000);
	saves.push(at(2026, 7, 10), at(2026, 8, 10), at(2026, 9, 10));
	for (let i = 0; i < 20; i += 1) saves.push(at(2026, 10, 1) + i * DAY);
	const ticks = axis(saves);
	const xs = ticks.map((tick) => tick.x);
	for (let i = 2; i < xs.length - 1; i += 1) assert(xs[i]! - xs[i - 1]! >= AXIS_MIN_LABEL_GAP_PX, `month labels keep their distance, got ${JSON.stringify(ticks.map((tick) => [tick.label, Math.round(tick.x)]))}`);
	const months = ticks.filter((tick) => tick.kind === "month").map((tick) => tick.label);
	assert(months.length >= 1 && months.length < 4, `bunched months are thinned, got ${JSON.stringify(months)}`);
	assert(months[0] === "Jul", `the first month of a bunch is the one kept, got ${JSON.stringify(months)}`);
	console.log(`  ok  bunched months are thinned to ${JSON.stringify(months)}`);
}

// 4. The year appears when it changes, and only then.
{
	const saves: number[] = [];
	for (let i = 0; i < 60; i += 1) saves.push(at(2026, 11, 1) + Math.round((i / 59) * (at(2027, 2, 20) - at(2026, 11, 1))));
	const months = axis(saves, 1400).filter((tick) => tick.kind === "month").map((tick) => tick.label);
	assert(JSON.stringify(months) === JSON.stringify(["Dec", "Jan 2027", "Feb"]), `the year shows when it changes, got ${JSON.stringify(months)}`);
	console.log("  ok  the year shows when it changes: Dec, Jan 2027, Feb");
}

console.log("memory-growth-axis smoke: ok");
