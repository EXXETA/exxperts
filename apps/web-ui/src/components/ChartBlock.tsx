import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode, type Ref } from "react";
import { flushSync } from "react-dom";
import { niceTicks, type ChartData } from "./chart-block";
import { CopyImageButton, FigureSwitch, FigureTools } from "./figure-tools";

// A chart block drawn by our own code as SVG, in the theme's chart colours
// (--chart-1 to --chart-6, styles/01-base.css): a bar, line or pie chart,
// the values on hover or with the arrow keys, and Table to read the numbers.
// Loaded on the first chart, in its own chunk.

const HEIGHT = 220;
const FALLBACK_WIDTH = 560;
const PIE_SLICES = 6;
// The fewest letters a line of a pie's legend may hold for it to stay beside the ring, and how wide it grows there.
const BESIDE_LETTERS = 16;
const BESIDE_WIDTH = 400;
const TICK_CHAR = 6.4;
const CHART_VIEWS = [{ value: "chart", word: "Chart" }, { value: "table", word: "Table" }] as const;
const formats = new Map<number, Intl.NumberFormat>();

/** Numbers in the reader's own form, with at most `digits` after the point. */
function numberFormat(digits: number): Intl.NumberFormat {
	let format = formats.get(digits);
	if (!format) formats.set(digits, (format = new Intl.NumberFormat(undefined, { maximumFractionDigits: digits })));
	return format;
}

/** The digits after the point a round step needs (0.25: 2), at most twenty. */
function stepDigits(step: number): number {
	let digits = 0;
	while (digits < 20 && Math.abs(Number(step.toFixed(digits)) - step) > step * 1e-6) digits++;
	return digits;
}

const colour = (i: number) => `answer-chart-c${(i % PIE_SLICES) + 1}`;
const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/** How wide `font` sets a text, the page's own face loaded. With no canvas every text measures zero, so nothing wraps. */
function measurer(font: string): (text: string) => number {
	const context = document.createElement("canvas").getContext("2d");
	if (context) context.font = `${font} ${getComputedStyle(document.documentElement).getPropertyValue("--exx-font-sans")}`;
	return (text) => context?.measureText(text).width ?? 0;
}

/** `text` over as many lines as it needs, at least one, none wider than `room`; a word wider than that breaks where it must. */
function wrap(text: string, room: number, width: (text: string) => number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		const joined = line ? `${line} ${word}` : word;
		if (width(joined) <= room) {
			line = joined;
			continue;
		}
		if (line) lines.push(line);
		line = "";
		for (const letter of word) {
			if (line && width(line + letter) > room) {
				lines.push(line);
				line = "";
			}
			line += letter;
		}
	}
	if (line || !lines.length) lines.push(line);
	return lines;
}

/** The width the chart has, so its text stays at its own size on a phone. */
function useWidth(): [(element: HTMLDivElement | null) => void, number] {
	const [width, setWidth] = useState(FALLBACK_WIDTH);
	const observer = useRef<ResizeObserver | null>(null);
	const ref = useCallback((element: HTMLDivElement | null) => {
		observer.current?.disconnect();
		if (!element || typeof ResizeObserver === "undefined") return;
		observer.current = new ResizeObserver((entries) => {
			const next = Math.floor(entries[0]?.contentRect.width ?? 0);
			if (next > 0) setWidth(next);
		});
		observer.current.observe(element);
	}, []);
	useEffect(() => () => observer.current?.disconnect(), []);
	return [ref, width];
}

/** A bar from the zero line to its value, its far end rounded. */
function barPath(x: number, width: number, base: number, end: number): string {
	const r = Math.min(4, Math.abs(end - base), width / 2);
	const d = end < base ? 1 : -1;
	return `M${x} ${base}V${end + d * r}Q${x} ${end} ${x + r} ${end}H${x + width - r}Q${x + width} ${end} ${x + width} ${end + d * r}V${base}Z`;
}

interface Tip {
	x: number;
	y: number;
	body: ReactNode;
	/** Over a pie's ring, so its words wrap to the ring's width. */
	overRing?: boolean;
}

/** What a value is being read from: a point of the drawing (or the arrow keys), or a row of a pie's legend. */
type HoverFrom = "point" | "legend";
type SetHover = (i: number | null, from?: HoverFrom) => void;

interface Drawn {
	svg: ReactNode;
	tip: Tip | null;
	/** How many points the arrow keys step through. */
	count: number;
	/** The drawing's height when it is not the usual one. */
	height?: number;
}

function axes(chart: ChartData, width: number): { left: number; right: number; top: number; bottom: number; ticks: number[]; tickText: (tick: number) => string; y: (value: number) => number } {
	const values = chart.series.flatMap((series) => series.values);
	const ticks = niceTicks(Math.min(...values), Math.max(...values));
	// Ticks read as precisely as their step needs, so close ones never share a label.
	const format = numberFormat(stepDigits(ticks[1] - ticks[0]));
	const tickText = (tick: number) => format.format(tick);
	const left = 10 + Math.max(...ticks.map((tick) => tickText(tick).length)) * TICK_CHAR;
	const top = 14;
	const bottom = HEIGHT - 28;
	const low = ticks[0];
	const high = ticks[ticks.length - 1];
	return { left, right: width - 12, top, bottom, ticks, tickText, y: (value) => bottom - ((value - low) / (high - low)) * (bottom - top) };
}

function tipLines(chart: ChartData, i: number): ReactNode {
	return (
		<>
			<b>{chart.labels[i]}</b>
			{chart.series.map((series, s) => (
				<span key={s} className="answer-chart-tip-row">
					{chart.series.length > 1 && <i className={`answer-chart-swatch ${colour(s)}`} />}
					{series.name} <strong>{numberFormat(chart.decimals).format(series.values[i])}</strong>
				</span>
			))}
		</>
	);
}

function grid(chart: ChartData, frame: ReturnType<typeof axes>, xs: (i: number) => number, band: number): ReactNode {
	const longest = Math.max(...chart.labels.map((label) => Math.min(label.length, 14)));
	const every = Math.max(1, Math.ceil((longest * TICK_CHAR + 10) / Math.max(band, 1)));
	return (
		<>
			{frame.ticks.map((tick) => (
				<g key={tick}>
					{tick !== 0 && <line className="answer-chart-grid" x1={frame.left} x2={frame.right} y1={frame.y(tick)} y2={frame.y(tick)} />}
					<text className="answer-chart-tick" x={frame.left - 8} y={frame.y(tick) + 4} textAnchor="end">{frame.tickText(tick)}</text>
				</g>
			))}
			{chart.labels.map((label, i) => (i % every === 0 ? <text key={i} className="answer-chart-tick" x={xs(i)} y={HEIGHT - 10} textAnchor="middle">{cut(label, 14)}</text> : null))}
			<line className="answer-chart-base" x1={frame.left} x2={frame.right} y1={frame.y(0)} y2={frame.y(0)} />
		</>
	);
}

function drawBars(chart: ChartData, width: number, hover: number | null, setHover: SetHover): Drawn {
	const frame = axes(chart, width);
	const n = chart.labels.length;
	const seriesCount = chart.series.length;
	const band = (frame.right - frame.left) / n;
	const group = Math.min(band * 0.62, 26 * seriesCount);
	const bar = group / seriesCount;
	const groupX = (i: number) => frame.left + band * i + (band - group) / 2;
	// Bars side by side keep a gap that shrinks with them, so a crowded chart still has every bar.
	const gap = seriesCount > 1 ? Math.min(2, bar * 0.2) : 0;
	const svg = (
		<>
			{grid(chart, frame, (i) => frame.left + band * (i + 0.5), band)}
			{chart.series.map((series, s) =>
				series.values.map((value, i) => (
					<path key={`${s}-${i}`} className={`answer-chart-bar ${colour(s)}${hover === i ? " on" : ""}`} d={barPath(groupX(i) + bar * s + gap / 2, bar - gap, frame.y(0), frame.y(value))} />
				)),
			)}
			{chart.labels.map((_, i) => (
				<rect key={i} className="answer-chart-hit" data-i={i} x={frame.left + band * i} y={frame.top} width={band} height={frame.bottom - frame.top} onPointerEnter={() => setHover(i)} />
			))}
		</>
	);
	const top = (i: number) => Math.min(...chart.series.map((series) => frame.y(Math.max(0, series.values[i]))));
	return { svg, tip: hover === null ? null : { x: frame.left + band * (hover + 0.5), y: top(hover), body: tipLines(chart, hover) }, count: n };
}

function drawLines(chart: ChartData, width: number, hover: number | null, setHover: SetHover): Drawn {
	const frame = axes(chart, width);
	const n = chart.labels.length;
	const step = n > 1 ? (frame.right - frame.left - 16) / (n - 1) : 0;
	const x = (i: number) => (n > 1 ? frame.left + 8 + step * i : (frame.left + frame.right) / 2);
	const svg = (
		<>
			{grid(chart, frame, x, n > 1 ? step : frame.right - frame.left)}
			{hover !== null && <line className="answer-chart-guide" x1={x(hover)} x2={x(hover)} y1={frame.top} y2={frame.bottom} />}
			{chart.series.map((series, s) => (
				<g key={s} className={colour(s)}>
					<path className="answer-chart-line" d={series.values.map((value, i) => `${i ? "L" : "M"}${x(i)} ${frame.y(value)}`).join("")} />
					{series.values.map((value, i) => (hover === i || n <= 24 ? <circle key={i} className={`answer-chart-point${hover === i ? " on" : ""}`} cx={x(i)} cy={frame.y(value)} r={hover === i ? 4.5 : 2.5} /> : null))}
				</g>
			))}
			{chart.labels.map((_, i) => {
				const half = n > 1 ? step / 2 : (frame.right - frame.left) / 2;
				const from = Math.max(frame.left, x(i) - half);
				return <rect key={i} className="answer-chart-hit" data-i={i} x={from} y={frame.top} width={Math.min(frame.right, x(i) + half) - from} height={frame.bottom - frame.top} onPointerEnter={() => setHover(i)} />;
			})}
		</>
	);
	const top = (i: number) => Math.min(...chart.series.map((series) => frame.y(series.values[i])));
	return { svg, tip: hover === null ? null : { x: x(hover), y: top(hover), body: tipLines(chart, hover) }, count: n };
}

/** A pie's slices: at most six, the smallest of a longer list joined as "Other". */
function slices(chart: ChartData): { label: string; value: number; index: number[] }[] {
	const all = chart.labels.map((label, i) => ({ label, value: chart.series[0].values[i], index: [i] }));
	if (all.length <= PIE_SLICES) return all;
	const kept = new Set([...all].sort((a, b) => b.value - a.value).slice(0, PIE_SLICES - 1));
	const rest = all.filter((slice) => !kept.has(slice));
	return [...all.filter((slice) => kept.has(slice)), { label: "Other", value: rest.reduce((sum, slice) => sum + slice.value, 0), index: rest.flatMap((slice) => slice.index) }];
}

function drawPie(chart: ChartData, width: number, hover: number | null, setHover: SetHover, from: HoverFrom = "point"): Drawn {
	const parts = slices(chart);
	const total = parts.reduce((sum, slice) => sum + slice.value, 0);
	// Every name shows in full, over the lines it needs. The legend sits beside the ring unless a line there would hold too little (a phone): then it goes under it.
	const besideOuter = Math.min(HEIGHT / 2 - 12, width / 4);
	const besideX = 2 * besideOuter + 40;
	const stacked = Math.floor((Math.min(width - 12, besideX + BESIDE_WIDTH) - besideX - 58) / TICK_CHAR) < BESIDE_LETTERS;
	const legendWidth = Math.min(width - 24, 300);
	const outer = stacked ? Math.min(HEIGHT / 2 - 12, (width - 24) / 2) : besideOuter;
	const inner = outer * 0.58;
	const cx = stacked ? width / 2 : outer + 12;
	const legendX = stacked ? (width - legendWidth) / 2 : besideX;
	// The share sits beside its name, not at the far edge of a wide card.
	const legendRight = stacked ? legendX + legendWidth : Math.min(width - 12, legendX + BESIDE_WIDTH);
	const measure = measurer(TICK_WORDS.font);
	const names = parts.map((slice) => wrap(slice.label, legendRight - legendX - 58, measure));
	const legendRows = names.reduce<number[]>((tops, lines, i) => [...tops, tops[i] + 22 + (lines.length - 1) * TICK_WORDS.line], [0]);
	const legendHeight = legendRows[parts.length];
	const besideHeight = Math.max(HEIGHT, legendHeight + 8);
	const cy = stacked ? outer + 12 : besideHeight / 2;
	const legendTop = stacked ? cy + outer + 26 : cy - legendHeight / 2;
	const height = stacked ? legendTop + legendHeight + 4 : besideHeight;
	const point = (angle: number, r: number) => [cx + r * Math.cos(angle), cy + r * Math.sin(angle)];
	let angle = -Math.PI / 2;
	const drawn = parts.map((slice, i) => {
		const sweep = (slice.value / total) * Math.PI * 2;
		const start = angle;
		const end = (angle += sweep);
		const middle = start + sweep / 2;
		// A slice that is the whole pie is drawn as two halves: an arc cannot end where it starts.
		const ring = (a: number, b: number) => {
			const large = b - a > Math.PI ? 1 : 0;
			const [x1, y1] = point(a, outer);
			const [x2, y2] = point(b, outer);
			const [x3, y3] = point(b, inner);
			const [x4, y4] = point(a, inner);
			return `M${x1} ${y1}A${outer} ${outer} 0 ${large} 1 ${x2} ${y2}L${x3} ${y3}A${inner} ${inner} 0 ${large} 0 ${x4} ${y4}Z`;
		};
		const d = sweep >= Math.PI * 2 - 1e-9 ? ring(start, start + Math.PI) + ring(start + Math.PI, end) : ring(start, end);
		const [tx, ty] = point(middle, (outer + inner) / 2);
		return { slice, i, d, tx, ty };
	});
	// A legend row's top: a value read there shows by its row, which may be all of the chart in view.
	const rowY = (i: number) => legendTop + legendRows[i] + 1;
	const svg = (
		<>
			{drawn.map(({ i, d }) => (
				<path key={i} className={`answer-chart-slice ${colour(i)}${hover === i ? " on" : ""}`} d={d} data-i={i} onPointerEnter={() => setHover(i)} />
			))}
			<text className="answer-chart-total" x={cx} y={cy + 5} textAnchor="middle">{numberFormat(chart.decimals).format(total)}</text>
			{drawn.map(({ i, slice }) => {
				const y = rowY(i) + 14;
				const x = legendX;
				const right = legendRight;
				return (
					<g key={`l${i}`} className={`answer-chart-legend${hover === i ? " on" : ""}`} onPointerEnter={() => setHover(i, "legend")}>
						<rect className={colour(i)} x={x} y={y - 9} width={10} height={10} rx={2} />
						{names[i].map((line, n) => <text key={n} className="answer-chart-tick" x={x + 16} y={y + n * TICK_WORDS.line}>{line}</text>)}
						<text className="answer-chart-tick" x={right} y={y} textAnchor="end">{Math.round((slice.value / total) * 100)}%</text>
						<rect className="answer-chart-hit" x={x - 4} y={y - 14} width={Math.max(0, right + 4 - x)} height={20 + (names[i].length - 1) * TICK_WORDS.line} />
					</g>
				);
			})}
		</>
	);
	// Read from a legend beside the ring, the value shows in the ring's hole and covers no other row.
	const overRing = from === "legend" && !stacked;
	const tip = hover === null || !drawn[hover] ? null : {
		x: overRing ? cx : from === "legend" ? legendX + 60 : drawn[hover].tx,
		y: overRing ? cy + 30 : from === "legend" ? rowY(hover) : drawn[hover].ty,
		overRing,
		body: (
			<>
				<b>{drawn[hover].slice.label}</b>
				<span className="answer-chart-tip-row">{chart.series[0].name} <strong>{numberFormat(chart.decimals).format(drawn[hover].slice.value)}</strong> · {Math.round((drawn[hover].slice.value / total) * 100)}%</span>
			</>
		),
	};
	return { svg, tip, count: parts.length, height };
}

const DRAW = { bar: drawBars, line: drawLines, pie: drawPie } as const;

// Words set over lines, with the step between their lines: the fonts of
// .answer-chart-copy-title, .answer-chart-copy-note and .answer-chart-tick
// in styles/14-answer-content.css, which must change together with these.
const COPY_TITLE = { font: "700 14.5px", line: 19 };
const COPY_NOTE = { font: "12.5px", line: 16 };
const TICK_WORDS = { font: "11px", line: 15 };

/**
 * What Copy image takes: the drawing with the chart's title, note and series
 * names whole above it, wrapped in the words' real widths, so the picture
 * says what it shows away from the answer. Several series get their colours
 * beside their names; one series (a pie's too) is named on a line of its own.
 */
function CopyPicture({ chart, width, height, drawing, svgRef }: { chart: ChartData; width: number; height: number; drawing: ReactNode; svgRef: Ref<SVGSVGElement> }) {
	const head: ReactNode[] = [];
	const room = width - 24;
	let y = 0;
	const stack = (text: string, { font, line }: { font: string; line: number }, className: string, gap: number) => {
		wrap(text, room, measurer(font)).forEach((words, i) => {
			y += i ? line : gap;
			head.push(<text key={head.length} className={className} x={12} y={y}>{words}</text>);
		});
	};
	if (chart.title) stack(chart.title, COPY_TITLE, "answer-chart-copy-title", 22);
	if (chart.note) stack(chart.note, COPY_NOTE, "answer-chart-copy-note", 18);
	if (chart.series.length === 1) {
		stack(chart.series[0].name, TICK_WORDS, "answer-chart-tick", 20);
	} else {
		const measure = measurer(TICK_WORDS.font);
		let x = 12;
		y += 22;
		chart.series.forEach((series, s) => {
			// A name too wide for a row takes the rows it needs, alone: its size outruns the row, so the next name starts on the next.
			const size = 30 + measure(series.name);
			if (x > 12 && x + size > width - 12) {
				x = 12;
				y += 18;
			}
			const names = wrap(series.name, room - 14, measure);
			head.push(
				<g key={`series${s}`}>
					<rect className={colour(s)} x={x} y={y - 9} width={9} height={9} rx={2} />
					{names.map((words, i) => <text key={i} className="answer-chart-tick" x={x + 14} y={y + i * TICK_WORDS.line}>{words}</text>)}
				</g>,
			);
			y += (names.length - 1) * TICK_WORDS.line;
			x += size;
		});
	}
	const top = y ? y + 10 : 0;
	return (
		<svg ref={svgRef} className="answer-chart-copy" aria-hidden="true" width={width} height={height + top} viewBox={`0 0 ${width} ${height + top}`}>
			{head}
			<g transform={`translate(0 ${top})`}>{drawing}</g>
		</svg>
	);
}

export default function ChartBlock({ chart }: { chart: ChartData }) {
	const [view, setView] = useState<"chart" | "table">("chart");
	const [hovered, setHovered] = useState<{ i: number; from: HoverFrom } | null>(null);
	const hover = hovered?.i ?? null;
	const setHover: SetHover = (i, from = "point") => setHovered(i === null ? null : { i, from });
	const [measure, width] = useWidth();
	const [copying, setCopying] = useState(false);
	const copyRef = useRef<SVGSVGElement | null>(null);
	const drawn = DRAW[chart.kind](chart, width, hover, setHover, hovered?.from);
	// The copy's picture is drawn for the click alone: the PNG reads its styles and shape at once, before it awaits anything.
	// Its drawing is its own: no value being read.
	const copied = copying ? DRAW[chart.kind](chart, width, null, setHover) : null;
	const copyPicture = () => {
		flushSync(() => setCopying(true));
		queueMicrotask(() => setCopying(false));
		return copyRef.current;
	};
	const onKeyDown = (event: KeyboardEvent<SVGSVGElement>) => {
		const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
		if (!step) return;
		event.preventDefault();
		setHover(hover === null ? (step > 0 ? 0 : drawn.count - 1) : (hover + step + drawn.count) % drawn.count);
	};
	const tipX = drawn.tip ? Math.max(70, Math.min(width - 70, drawn.tip.x)) : 0;
	const label = `${chart.kind === "bar" ? "Bar" : chart.kind === "line" ? "Line" : "Pie"} chart${chart.title ? `: ${chart.title}` : ""}`;
	return (
		<figure className="figure-card answer-chart-card" aria-label={label}>
			<div className="answer-chart-head">
				{/* First, so the words flow around the tools and take the full width below them. */}
				<FigureTools copy={view === "chart" && <CopyImageButton svg={copyPicture} />}>
					<FigureSwitch options={CHART_VIEWS} value={view} onChange={setView} />
				</FigureTools>
				<div className="answer-chart-heading">
					{chart.title && <div className="answer-chart-title">{chart.title}</div>}
					{chart.note && <div className="answer-chart-note">{chart.note}</div>}
				</div>
			</div>
			{chart.kind !== "pie" && chart.series.length > 1 && view === "chart" && (
				<div className="answer-chart-legend-row">
					{chart.series.map((series, s) => <span key={s}><i className={`answer-chart-swatch ${colour(s)}`} />{series.name}</span>)}
				</div>
			)}
			{view === "chart" ? (
				<div className="answer-chart-body" ref={measure}>
					<svg className={`answer-chart-svg answer-chart-kind-${chart.kind}${hover !== null ? " focus" : ""}`} width={width} height={drawn.height ?? HEIGHT} viewBox={`0 0 ${width} ${drawn.height ?? HEIGHT}`} role="img" aria-label={label} tabIndex={0} onKeyDown={onKeyDown} onPointerLeave={() => setHover(null)} onBlur={() => setHover(null)}>
						{drawn.svg}
					</svg>
					{drawn.tip && <div className={`answer-chart-tip${drawn.tip.overRing ? " answer-chart-tip-ring" : ""}`} style={{ left: tipX, top: drawn.tip.y }}>{drawn.tip.body}</div>}
					{copied && <CopyPicture chart={chart} width={width} height={copied.height ?? HEIGHT} drawing={copied.svg} svgRef={copyRef} />}
				</div>
			) : (
				<div className="answer-chart-table md-table-frame">
					<div className="md-table-scroll">
						<table>
							<thead>
								<tr><th>{chart.labelName}</th>{chart.series.map((series, s) => <th key={s}>{series.name}</th>)}</tr>
							</thead>
							<tbody>
								{chart.labels.map((labelText, i) => (
									<tr key={i}><td>{labelText}</td>{chart.series.map((series, s) => <td key={s}>{numberFormat(chart.decimals).format(series.values[i])}</td>)}</tr>
								))}
							</tbody>
						</table>
					</div>
				</div>
			)}
		</figure>
	);
}
