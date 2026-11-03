/**
 * The chart block: a ```chart fence of plain data that the answer draws as a
 * bar, line or pie chart (ChartBlock.tsx). The model writes it in this form,
 * the one its standing instructions show:
 *
 *     type: bar                      bar, line or pie
 *     title: Requests refused        optional
 *     note: Today, example numbers   optional, the line under the title
 *     Hour, Refused, Served          the labels' name, then one name per series
 *     09:00, 12, 140                 a label, then one number per series
 *     10:00, 30, 152
 *
 * Cells are split at commas; a cell in double quotes may hold one ("" is a
 * quote). Numbers are plain: an optional sign, digits, an optional point,
 * and small enough to draw. A pie has one series of numbers that are not
 * negative. Anything else is not a chart, and the block shows as its code.
 */

export const CHART_KINDS = ["bar", "line", "pie"] as const;
export type ChartKind = (typeof CHART_KINDS)[number];

export interface ChartSeries {
	name: string;
	values: number[];
}

export interface ChartData {
	kind: ChartKind;
	title?: string;
	note?: string;
	/** What the labels are, the header's first cell ("Hour"). */
	labelName: string;
	labels: string[];
	series: ChartSeries[];
	/** The most digits any number has after its point, so each shows as precisely as it was written. */
	decimals: number;
}

export type ChartRead = { ok: true; chart: ChartData } | { ok: false; reason: string };

export const MAX_CHART_ROWS = 60;
export const MAX_CHART_SERIES = 6;
const MAX_PIE_SLICES = 12;
const SETTING = /^(type|title|note)\s*:\s*(.*)$/i;
const NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/;
// What a number format shows at most after the point.
const MAX_DECIMALS = 20;

/** The cells of one line: split at commas outside double quotes, each trimmed; null when a quote is left open. */
function cells(line: string): string[] | null {
	const out: string[] = [];
	let cell = "";
	let quoted = false;
	let wasQuoted = false;
	for (let i = 0; i < line.length; i++) {
		const c = line[i];
		if (quoted) {
			if (c === '"' && line[i + 1] === '"') {
				cell += '"';
				i++;
			} else if (c === '"') quoted = false;
			else cell += c;
		} else if (c === '"' && cell.trim() === "") {
			quoted = wasQuoted = true;
			cell = "";
		} else if (c === ",") {
			out.push(wasQuoted ? cell : cell.trim());
			cell = "";
			wasQuoted = false;
		} else cell += c;
	}
	if (quoted) return null;
	out.push(wasQuoted ? cell : cell.trim());
	return out;
}

const fail = (reason: string): ChartRead => ({ ok: false, reason });

/** Reads a chart block's text; never throws. */
export function readChart(text: string): ChartRead {
	const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
	const settings: Record<string, string> = {};
	let at = 0;
	for (; at < lines.length; at++) {
		const setting = SETTING.exec(lines[at]);
		if (!setting) break;
		const key = setting[1].toLowerCase();
		if (key in settings) return fail(`"${key}" is given twice`);
		settings[key] = setting[2].trim();
	}
	const kind = settings.type?.toLowerCase();
	if (!kind) return fail('no "type:" line');
	if (!CHART_KINDS.includes(kind as ChartKind)) return fail(`"${settings.type}" is not bar, line or pie`);
	const header = at < lines.length ? cells(lines[at]) : null;
	if (!header || header.length < 2) return fail("no header row: the labels' name, then a name per series");
	const seriesCount = header.length - 1;
	if (seriesCount > MAX_CHART_SERIES) return fail(`more than ${MAX_CHART_SERIES} series`);
	if (kind === "pie" && seriesCount !== 1) return fail("a pie has one series");
	const rows = lines.slice(at + 1);
	if (rows.length === 0) return fail("no rows");
	if (rows.length > (kind === "pie" ? MAX_PIE_SLICES : MAX_CHART_ROWS)) return fail("too many rows");
	const labels: string[] = [];
	const series: ChartSeries[] = header.slice(1).map((name, i) => ({ name: name || `Series ${i + 1}`, values: [] }));
	let decimals = 0;
	for (const [n, line] of rows.entries()) {
		const row = cells(line);
		if (!row || row.length !== header.length) return fail(`row ${n + 1} has ${row?.length ?? "an open quote and no"} cells, the header ${header.length}`);
		labels.push(row[0]);
		for (let s = 0; s < seriesCount; s++) {
			const cell = row[s + 1];
			if (!NUMBER.test(cell)) return fail(`row ${n + 1}: "${cell}" is not a number`);
			series[s].values.push(Number(cell));
			const point = cell.indexOf(".");
			if (point >= 0) decimals = Math.max(decimals, cell.length - point - 1);
		}
	}
	// The sizes added up bound every number, the axis's range and a pie's total: finite, or nothing can be placed; so must the axis's round steps be.
	const values = series.flatMap((one) => one.values);
	if (!Number.isFinite(values.reduce((sum, value) => sum + Math.abs(value), 0))) return fail("a number is too big to draw");
	if (kind !== "pie" && !niceTicks(Math.min(...values), Math.max(...values)).every(Number.isFinite)) return fail("a number is too big to draw");
	if (kind === "pie") {
		if (values.some((value) => value < 0)) return fail("a pie's numbers cannot be negative");
		if (values.reduce((sum, value) => sum + value, 0) <= 0) return fail("a pie's numbers add up to nothing");
	}
	return { ok: true, chart: { kind: kind as ChartKind, title: settings.title || undefined, note: settings.note || undefined, labelName: header[0] || "Label", labels, series, decimals: Math.min(decimals, MAX_DECIMALS) } };
}

/** About five round steps from the lowest to the highest value, zero always in range. */
export function niceTicks(low: number, high: number, count = 5): number[] {
	const lo = Math.min(0, low);
	const hi = Math.max(0, high);
	if (lo === hi) return [0, 1];
	const raw = (hi - lo) / count;
	const power = 10 ** Math.floor(Math.log10(raw));
	const step = [1, 2, 2.5, 5, 10].map((f) => f * power).find((s) => s >= raw) ?? 10 * power;
	const first = Math.floor(lo / step) * step;
	const ticks: number[] = [];
	// Counted, not stepped: near the largest numbers a step can be lost to rounding.
	for (let i = 0; i <= count * 2 + 2; i++) {
		const v = first + step * i;
		if (!(v < hi + step * 0.999)) break;
		ticks.push(Number(v.toPrecision(12)));
	}
	return ticks;
}
