import { useEffect, useRef, useState } from "react";
import { fmtMemoryDay } from "../memory-surface-copy";

// One save of a room's memory as the server records it (/api/memory rooms'
// `series`): the moment, what kind of save it was, and the size of the two
// layers the chart stacks — lasting notes (deep) under remembered
// conversations (recent). Sizes are token estimates; the chart shows them in
// the "20k" shape and never as a count.
export interface GrowthPoint {
	ts: number;
	tokens: number;
	added: number;
	title: string | null;
	kind: "checkpoint" | "absorb" | "review";
	consolidated: number;
	recent: number;
}

/** A size in the "20k" shape the budget bar uses; small sizes keep one decimal so 400 reads as 0.4k, not 0k. */
function fmtK(n: number): string {
	if (n <= 0) return "0";
	if (n < 1000) return `${Math.max(0.1, Math.round(n / 100) / 10)}k`;
	return `${Math.round(n / 1000)}k`;
}

const KIND_WORD: Record<GrowthPoint["kind"], string> = { checkpoint: "Remember", absorb: "Memorize", review: "Review" };

/** The hover line for one save: "14 Sep · Remember · 18k, under the 20k budget". */
export function growthPointHoverLine(point: GrowthPoint, budgetTokens: number | null): string {
	const total = point.consolidated + point.recent;
	const head = `${fmtMemoryDay(point.ts)} · ${KIND_WORD[point.kind]} · ${fmtK(total)}`;
	if (!(budgetTokens && budgetTokens > 0)) return head;
	return `${head}, ${total <= budgetTokens ? "under" : "above"} the ${fmtK(budgetTokens)} budget`;
}

// The room's memory over its saves (oldest → newest): a filled area split into
// lasting notes and remembered conversations, one mark per save — a dot for a
// Remember, a filled diamond for a Memorize, a hollow diamond for a Review —
// and a dashed line where the room's memory budget sits, so a curve climbing
// toward it is visible before the bar says "over". Hover a mark for its line;
// with `onPick`, a click on a mark hands its moment up, and `markerTs` draws
// a vertical line where the moment being viewed sits.
export function MemoryGrowthChart({ series, budgetTokens, height = 300, markerTs = null, onPick }: { series: GrowthPoint[]; budgetTokens: number | null; height?: number; markerTs?: number | null; onPick?: (ts: number | null) => void }) {
	const wrapRef = useRef<HTMLDivElement>(null);
	const [hover, setHover] = useState<{ i: number; x: number; y: number } | null>(null);
	// Draw at the container's real width so the chart fills the card instead of
	// letterboxing a fixed-aspect viewBox in the middle.
	const [W, setW] = useState(960);
	useEffect(() => {
		const el = wrapRef.current;
		if (!el) return;
		const update = () => setW(Math.max(360, Math.round(el.clientWidth)));
		update();
		const ro = new ResizeObserver(update);
		ro.observe(el);
		return () => ro.disconnect();
	}, []);
	const H = height;
	const padL = 40; // fits a "120k" axis label
	const padT = 14;
	const padB = 38; // two label rows under the axis: save kinds, then date anchors
	const padR = 52; // room for the "budget" label at the line's right end
	const iW = W - padL - padR;
	const iH = H - padT - padB;
	const n = series.length;
	const budget = budgetTokens && budgetTokens > 0 ? budgetTokens : null;
	const tot = (s: GrowthPoint) => s.consolidated + s.recent;
	// The budget line must fit on the chart even while every save sits under it.
	const max = Math.max(...series.map(tot), budget ?? 0, 1);
	const X = (i: number) => padL + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
	const Y = (v: number) => padT + iH - (v / max) * iH;
	// Linear between saves; the chart ends AT the last save — drawing past it
	// would invent time that hasn't happened.
	const linePts = (val: (s: GrowthPoint) => number) => series.map((s, i) => `${X(i).toFixed(1)},${Y(val(s)).toFixed(1)}`);
	const band = (lo: (s: GrowthPoint) => number, hi: (s: GrowthPoint) => number) => {
		const top = linePts(hi);
		const bot = linePts(lo).reverse();
		return `M ${top.join(" L ")} L ${bot.join(" L ")} Z`;
	};
	const ticks = [0, max];
	const firstTs = series.find((s) => s.ts > 0)?.ts;
	const lastTs = [...series].reverse().find((s) => s.ts > 0)?.ts;

	const onEnter = (i: number, e: React.MouseEvent) => {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect) return;
		setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
	};

	// Where the viewed moment sits on the save axis: on its save when it is
	// one, between the two bracketing saves otherwise, and never past the last
	// save, since the chart ends there.
	const markerX = (() => {
		if (markerTs === null || n === 0) return null;
		let j = 0;
		while (j < n && !(series[j].ts > markerTs)) j++;
		if (j === 0) return X(0);
		if (j >= n) return X(n - 1);
		const t0 = series[j - 1].ts;
		const t1 = series[j].ts;
		const f = t1 > t0 ? Math.min(1, Math.max(0, (markerTs - t0) / (t1 - t0))) : 0;
		return X(j - 1) + (X(j) - X(j - 1)) * f;
	})();

	return (
		<div className="mem-chart" ref={wrapRef}>
			<svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: `${H}px`, display: "block" }} role="img" aria-label="Memory over time">
				{ticks.map((tv, i) => (
					<g key={i}>
						<line x1={padL} y1={Y(tv).toFixed(1)} x2={W - padR + 6} y2={Y(tv).toFixed(1)} stroke="var(--border-soft)" strokeWidth={0.5} />
						<text x={padL - 6} y={Y(tv) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--exx-font-mono)">{fmtK(tv)}</text>
					</g>
				))}
				{firstTs && <text x={padL} y={H - 6} textAnchor="start" fontSize={9} fill="var(--dim)" fontFamily="var(--exx-font-mono)">{fmtMemoryDay(firstTs)}</text>}
				{lastTs && lastTs !== firstTs && <text x={W - padR + 6} y={H - 6} textAnchor="end" fontSize={9} fill="var(--dim)" fontFamily="var(--exx-font-mono)">{fmtMemoryDay(lastTs)}</text>}
				{/* Foreground-based fills so the chart reads in both themes. */}
				<path d={band(() => 0, (s) => s.consolidated)} fill="var(--fg)" opacity={0.18} />
				<path d={band((s) => s.consolidated, tot)} fill="var(--exx-plan)" opacity={0.8} />
				{/* The lasting-notes boundary is a real (thin) line so the Memorize/Review
				    marks visibly sit ON it, mirroring the Remember dots on the total. */}
				<polyline points={linePts((s) => s.consolidated).join(" ")} fill="none" stroke="var(--fg-soft)" strokeWidth={1} opacity={0.7} vectorEffect="non-scaling-stroke" />
				<polyline points={linePts(tot).join(" ")} fill="none" stroke="var(--fg-soft)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
				{/* The room's memory budget, where the bar turns "over". */}
				{budget !== null && (
					<g>
						<line x1={padL} y1={Y(budget).toFixed(1)} x2={W - padR + 6} y2={Y(budget).toFixed(1)} stroke="var(--muted)" strokeWidth={1} strokeDasharray="5 4" vectorEffect="non-scaling-stroke" />
						<text x={W - padR + 10} y={Y(budget) + 3} textAnchor="start" fontSize={9} fill="var(--muted)" fontFamily="var(--exx-font-mono)">budget</text>
					</g>
				)}
				{/* Remembers dot the total line; Memorize/Review get a labelled full-height
				    tick with their mark on the lasting-notes boundary — the layer those
				    two saves actually change — and on the total when the two lines part. */}
				{series.map((s, i) => {
					if (s.kind === "checkpoint") return null;
					const x = X(i).toFixed(1);
					const on = hover?.i === i;
					const xNum = X(i);
					// Shape carries the kind: filled diamond = Memorize, hollow = Review.
					const mark = (cyNum: number) => {
						const r = on ? 6.5 : 5.5;
						const d = `M ${xNum.toFixed(1)} ${(cyNum - r).toFixed(1)} L ${(xNum + r).toFixed(1)} ${cyNum.toFixed(1)} L ${xNum.toFixed(1)} ${(cyNum + r).toFixed(1)} L ${(xNum - r).toFixed(1)} ${cyNum.toFixed(1)} Z`;
						return s.kind === "absorb"
							? <path d={d} fill="var(--fg)" stroke="var(--bg)" strokeWidth={1.25} />
							: <path d={d} fill="var(--bg)" stroke="var(--fg)" strokeWidth={1.75} />;
					};
					const anchor = xNum > W - padR - 30 ? "end" : xNum < padL + 30 ? "start" : "middle";
					return (
						<g key={`ev-${i}`}>
							<line x1={x} y1={Y(tot(s)).toFixed(1)} x2={x} y2={padT + iH} stroke="var(--fg-soft)" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
							{mark(Y(s.consolidated))}
							{Y(tot(s)) - Y(s.consolidated) < -8 && mark(Y(tot(s)))}
							<text x={x} y={H - 20} textAnchor={anchor} fontSize={9} fill="var(--muted)" fontFamily="var(--exx-font-mono)">{KIND_WORD[s.kind]}</text>
						</g>
					);
				})}
				{/* The moment being viewed, when one is: a line over the whole plot at its save. */}
				{markerX !== null && (
					<line x1={markerX.toFixed(1)} y1={padT} x2={markerX.toFixed(1)} y2={padT + iH} stroke="var(--exx-plan)" strokeWidth={2} pointerEvents="none" />
				)}
				{series.map((s, i) => {
					const x = X(i).toFixed(1);
					const on = hover?.i === i;
					return (
						<g
							key={`hit-${i}`}
							style={onPick ? { cursor: "pointer" } : undefined}
							onClick={onPick ? () => onPick(s.ts) : undefined}
							onMouseEnter={(e) => onEnter(i, e)}
							onMouseMove={(e) => onEnter(i, e)}
							onMouseLeave={() => setHover((h) => (h?.i === i ? null : h))}
						>
							{/* Hit areas on BOTH lines for Memorize/Review, which draw a mark on each. */}
							<circle cx={x} cy={Y(tot(s)).toFixed(1)} r={12} fill="transparent" />
							{s.kind !== "checkpoint" && <circle cx={x} cy={Y(s.consolidated).toFixed(1)} r={12} fill="transparent" />}
							{s.kind === "checkpoint" && <circle cx={x} cy={Y(tot(s)).toFixed(1)} r={on ? 4.5 : 3} fill="var(--fg)" />}
						</g>
					);
				})}
			</svg>
			{hover && (() => {
				const below = hover.y < 60;
				return (
					<div className="mem-tip" style={{ left: `${hover.x}px`, top: `${hover.y}px`, transform: `translate(-50%, ${below ? "16px" : "calc(-100% - 16px)"})` }}>
						<div className="mem-tip-line">{growthPointHoverLine(series[hover.i], budget)}</div>
					</div>
				);
			})()}
		</div>
	);
}
