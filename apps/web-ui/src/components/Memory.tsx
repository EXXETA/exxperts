import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../api";
import { MarkdownRenderer } from "./Markdown";

// Room memory telemetry, read from /api/memory (read-only). Rooms remember
// through the checkpoint architecture: L1b is the durable memory document,
// grown by approval-gated checkpoints. This view surfaces what that memory
// holds, how big it is, and how it grew — it never mutates memory.

interface GrowthPoint {
	ts: number;
	tokens: number;
	added: number;
	title: string | null;
	kind: "checkpoint" | "absorb" | "review";
	consolidated: number;
	recent: number;
}

interface Payoff {
	turns: number;
	totalCost: number;
	costPerTurn: number;
	cacheHitRate: number;
}

interface RoomSummary {
	id: string;
	displayName: string;
	description?: string;
	/** the room has a parked conversation to resume (the Rooms "standby" chip) */
	standbyThread?: boolean;
	l1bTokens: number;
	areas: number;
	checkpoints: number;
	lastCheckpointAt: number | null;
	lastReviewAt: number | null;
	lastReviewTokenDelta: number;
	recentContextBacklog: number;
	needsAbsorb: boolean;
	series: GrowthPoint[];
	sessions: number;
	sessionsCap: number;
	topics: string[];
	knows: string[];
	composition: { deep: number; active: number; recent: number; chronos: number };
	payoff: Payoff | null;
}

interface RecentSession {
	title: string;
	tokens: number;
	ts: number | null;
	/** approval time of the checkpoint that admitted this entry (ISO), when a record exists */
	approvedAt: string | null;
	/** the entry's full saved text, word for word */
	content: string;
	/** the gate-written checkpoint id, the key for the conversation endpoint */
	checkpointId: string | null;
	/** the source conversation is still stored, so the receipt can open it */
	conversation: boolean;
}

// The stored conversation behind a receipt, sanitized server-side. Composite
// display items arrive folded into system text; tool args/results are capped.
interface TranscriptItem {
	kind: "user" | "assistant" | "tool" | "system";
	text?: string;
	name?: string;
	status?: string;
	args?: string;
	result?: string;
	truncated?: boolean;
}

type TranscriptResult =
	| { stored: true; checkpointId: string; threadId: string; closedAt: number | null; items: TranscriptItem[]; itemsTotal: number }
	| { stored: false; reason: string };

interface MemoryHistoryEvent {
	ts: number;
	kind: "checkpoint" | "learn" | "review";
	/** the event record's own id — the key for the event-diff endpoint */
	id?: string | null;
	/** the event's archived snapshot is still stored, so a diff can be shown */
	diffable?: boolean;
	title?: string | null;
	sessions?: number | null;
	deepTokensBefore?: number | null;
	deepTokensAfter?: number | null;
	tokenDelta?: number | null;
}

// The memory as it was at a past moment, from a recorded archive snapshot —
// carrying the same shapes the live view renders (map, sessions, composition)
// so the past looks exactly like the present, just older.
interface Snapshot {
	at: number;
	basis: "archive" | "current";
	boundaryTs: number | null;
	content: string;
	estimatedTokens: number;
	memoryMap: MemoryMapRow[];
	areas: Record<string, string>;
	recentSessions: RecentSession[];
	composition: { deep: number; active: number; recent: number; chronos: number };
}

// Before/after snapshot texts for one Learn/Review, from the archive chain,
// split into memory sections BEFORE diffing so nothing gets mislabeled.
interface EventSectionDiff {
	section: string;
	beforeText: string;
	afterText: string;
	beforeTokens: number;
	afterTokens: number;
}

interface EventDiff {
	kind: "learn" | "review";
	eventId: string;
	approvedAt: string;
	sections: EventSectionDiff[];
	afterBasis: "next-archive" | "current";
	afterVerified: boolean | null;
}

interface Overview {
	generatedAt: number;
	totals: {
		rooms: number;
		l1bTokens: number;
		checkpoints: number;
		recentContextBacklog: number;
		roomsNeedingAbsorb: number;
		composition: { deep: number; active: number; recent: number; chronos: number };
	};
	rooms: RoomSummary[];
}

interface MemoryMapRow {
	area: string;
	words: number;
	estimatedTokens: number;
}

interface RoomDetail extends RoomSummary {
	l1aExists: boolean;
	memoryMap: MemoryMapRow[];
	recentSessions: RecentSession[];
	history: MemoryHistoryEvent[];
	maturity: { level: number; label: string; consolidatedPct: number };
}

interface DigestRoomChange {
	id: string;
	displayName: string;
	newCheckpoints: number;
	newReviews: number;
	addedChars: number;
	title: string | null;
	learned: GrowthPoint[];
}

interface Digest {
	since: number;
	generatedAt: number;
	totals: { newCheckpoints: number; newReviews: number; roomsChanged: number; addedChars: number; topRoom: string | null };
	rooms: DigestRoomChange[];
}

interface SearchHit {
	roomId: string;
	room: string;
	area: string;
	snippet: string;
}

// Per-room budget share + weekly deep delta, from /api/memory/room-memory.
// Same measured sources as the overview; only the budget (from room settings)
// and the recorded weekly deep-memory change are used here — every other
// figure on this page comes from the overview/detail payloads directly.
interface RoomMemoryInfo {
	id: string;
	totalTokens: number;
	deepTokens: number;
	recentTokens: number;
	otherTokens: number;
	budgetTokens: number;
	budgetCustomized: boolean;
	weekly: { recorded: boolean; events: number; deepDelta: number; wholeHistory: boolean };
}

const LAST_VISIT_KEY = "exx.memory.lastVisit";

function fmtTok(n: number): string {
	if (n < 1000) return String(n);
	if (n < 10_000) return (n / 1000).toFixed(1) + "k";
	if (n < 1_000_000) return Math.round(n / 1000) + "k";
	return (n / 1_000_000).toFixed(1) + "M";
}

function fmtInt(n: number): string {
	return n.toLocaleString();
}

/** Signed token delta, e.g. "+1.2k" / "-340". */
function fmtDelta(n: number): string {
	return (n < 0 ? "-" : "+") + fmtTok(Math.abs(n));
}


/** Absolute short date for history rows and receipts, e.g. "12 Jul". */
function fmtDayShort(ts: number): string {
	return new Date(ts).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Receipt timestamp, e.g. "12 Jul at 14:02". */
function fmtWhen(iso: string): string {
	const ts = Date.parse(iso);
	if (!Number.isFinite(ts)) return iso;
	const time = new Date(ts).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
	return `${fmtDayShort(ts)} at ${time}`;
}

/** One history row's text. States what the records prove, nothing more. */
function historyText(e: MemoryHistoryEvent): string {
	if (e.kind === "checkpoint") return e.title ? `kept "${e.title}"` : "kept a session summary";
	if (e.kind === "learn") {
		const base = e.sessions ? `consolidated ${e.sessions} session${e.sessions === 1 ? "" : "s"} into deep memory` : "consolidated recent sessions into deep memory";
		const sized = e.deepTokensBefore != null && e.deepTokensAfter != null ? `${base}, deep memory ${fmtTok(e.deepTokensBefore)} to ${fmtTok(e.deepTokensAfter)} tok` : base;
		return sized;
	}
	if (e.tokenDelta == null) return "memory structure reviewed";
	if (e.tokenDelta < 0) return `review trimmed ${fmtTok(-e.tokenDelta)} tok from deep memory`;
	if (e.tokenDelta > 0) return `review reorganized deep memory, ${fmtDelta(e.tokenDelta)} tok`;
	return "structure reviewed, size unchanged";
}

// --- tiny line differ for "What changed" (no dependency) --------------------

interface DiffLine {
	type: "same" | "add" | "del";
	text: string;
}

/**
 * Line diff of two snapshot texts: common prefix/suffix trimmed, then an LCS
 * walk over the middle. Memory documents are a few thousand lines at most; if
 * the changed middle is ever too large for the table, an honest coarse diff
 * (everything removed, everything added) beats a frozen tab.
 */
function diffLines(beforeText: string, afterText: string): DiffLine[] {
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

interface DiffHunk {
	lines: DiffLine[];
}

/**
 * Group each contiguous changed region into one removed block followed by one
 * added block (instead of alternating line by line), so a replacement reads
 * as "this went out, this came in" while staying the complete diff.
 */
function coalesceRuns(lines: DiffLine[]): DiffLine[] {
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
function diffHunks(lines: DiffLine[]): DiffHunk[] {
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

function fmtAgo(ts: number | null): string {
	if (!ts) return "–";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return s + "s ago";
	if (s < 3600) return Math.round(s / 60) + "m ago";
	if (s < 86400) return Math.round(s / 3600) + "h ago";
	return Math.round(s / 86400) + "d ago";
}

// Memory size over the event history (checkpoints + absorbs). Green dots mark
// consolidations (absorbs) so you can see recent context fold into durable.
function GrowthChart({ series, height = 56 }: { series: GrowthPoint[]; height?: number }) {
	const W = 320;
	const H = height;
	// Deep + recent only — the same accounting as every other figure.
	const v = (s: GrowthPoint) => s.consolidated + s.recent;
	const max = Math.max(...series.map(v), 1);
	const step = series.length > 1 ? W / (series.length - 1) : W;
	const xy = (s: GrowthPoint, i: number): [number, number] => [i * step, H - 3 - (v(s) / max) * (H - 8)];
	const line = series.map((s, i) => xy(s, i).map((v) => v.toFixed(1)).join(",")).join(" ");
	return (
		<svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: `${H}px`, color: "var(--muted)" }} role="img" aria-label="Memory size over time">
			<polyline points={line} fill="none" stroke="currentColor" strokeWidth={2} vectorEffect="non-scaling-stroke" />
		</svg>
	);
}

// Expanded view: total memory over the event history (oldest → newest), a filled
// area split into deep memory and recent sessions. Every event is a point — a dot
// for a checkpoint, a filled circle for a Learn, a hollow circle for a Review.
// Hover any point for its stored details (when, compression, before → after).
function BreakdownChart({ series, height = 300, markerTs = null, onPickTs }: { series: GrowthPoint[]; height?: number; markerTs?: number | null; onPickTs?: (ts: number | null) => void }) {
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
	const padL = 58; // fits the "1.7k tok" top label
	const padT = 12;
	const padB = 38; // two label rows under the axis: event ticks, then date anchors
	const iW = W - padL - 12;
	const iH = H - padT - padB;
	const n = series.length;
	const max = Math.max(...series.map((s) => s.consolidated + s.recent), 1);
	const X = (i: number) => padL + (n > 1 ? (i / (n - 1)) * iW : iW / 2);
	const Y = (v: number) => padT + iH - (v / max) * iH;
	const tot = (s: GrowthPoint) => s.consolidated + s.recent;
	// Linear between events; the chart ends AT the last event — drawing past it
	// would invent time that hasn't happened.
	const linePts = (val: (s: GrowthPoint) => number) => series.map((s, i) => `${X(i).toFixed(1)},${Y(val(s)).toFixed(1)}`);
	const band = (lo: (s: GrowthPoint) => number, hi: (s: GrowthPoint) => number) => {
		const top = linePts(hi);
		const bot = linePts(lo).reverse();
		return `M ${top.join(" L ")} L ${bot.join(" L ")} Z`;
	};
	const ticks = [0, max];
	const kTok = (v: number) => (v >= 1000 ? (v / 1000).toFixed(1) + "k" : String(Math.round(v)));
	const fmtDay = (ts: number) => {
		const d = new Date(ts);
		const now = new Date();
		if (d.toDateString() === now.toDateString()) return "today";
		return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) });
	};
	const firstTs = series.find((s) => s.ts > 0)?.ts;
	const lastTs = [...series].reverse().find((s) => s.ts > 0)?.ts;

	// Time-travel cursor: where the viewed moment sits on the event axis,
	// interpolated by time between the two bracketing events, clamped to the
	// drawn range (the chart ends at the last event).
	const markerX = (() => {
		if (markerTs == null || n === 0) return null;
		let j = 0;
		while (j < n && !(series[j].ts > markerTs)) j++;
		if (j === 0) return X(0);
		if (j >= n) return X(n - 1);
		const t0 = series[j - 1].ts;
		const t1 = series[j].ts;
		const f = t1 > t0 ? Math.min(1, Math.max(0, (markerTs - t0) / (t1 - t0))) : 0;
		return X(j - 1) + (X(j) - X(j - 1)) * f;
	})();

	// Human-readable detail for a point, from the real stored event values.
	const info = (i: number): { title: string; when: string | null; lines: string[] } => {
		const s = series[i];
		const prev = i > 0 ? series[i - 1] : null;
		const when = s.ts ? fmtAgo(s.ts) : null;
		if (s.kind === "absorb") {
			const recentBefore = prev ? prev.recent : s.recent;
			const deepAdded = prev ? Math.max(0, s.consolidated - prev.consolidated) : 0;
			const ratio = deepAdded > 0 ? Math.round(recentBefore / deepAdded) : null;
			const lines = [`Folded ~${kTok(recentBefore)} tok of recent sessions into deep memory`];
			if (ratio && ratio > 1) lines.push(`Compressed about ${ratio}:1`);
			if (prev) lines.push(`Deep memory ${kTok(prev.consolidated)} → ${kTok(s.consolidated)} tok`);
			lines.push(`Recent sessions ${prev ? `${kTok(prev.recent)} → ` : ""}${kTok(s.recent)} tok`);
			return { title: "Learn", when, lines };
		}
		if (s.kind === "review") {
			const trimmed = Math.abs(s.added || (prev ? tot(prev) - tot(s) : 0));
			const lines = [`Trimmed ~${kTok(trimmed)} tok from deep memory`];
			if (prev) lines.push(`Deep memory ${kTok(prev.consolidated)} → ${kTok(s.consolidated)} tok`);
			lines.push(`Recent sessions ${kTok(s.recent)} tok`);
			return { title: "Review Memory", when, lines };
		}
		const addedRecent = prev ? Math.max(0, s.recent - prev.recent) : s.recent;
		const lines: string[] = [];
		if (s.title) lines.push(`“${s.title}”`);
		if (addedRecent > 0) lines.push(`+${kTok(addedRecent)} tok recent memory`);
		lines.push(`Deep memory ${kTok(s.consolidated)} tok · Recent sessions ${kTok(s.recent)} tok`);
		return { title: "Session saved", when, lines };
	};

	const onEnter = (i: number, e: React.MouseEvent) => {
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect) return;
		setHover({ i, x: e.clientX - rect.left, y: e.clientY - rect.top });
	};

	// The chart is the time-travel control: memory states are discrete (one
	// per event), so a click snaps the viewing line to the nearest recorded
	// state. The state after event i is any moment before event i+1 — we pass
	// the event's own timestamp; the last event's state is today (null).
	const markerIdx = (() => {
		if (markerTs == null) return n - 1;
		let j = 0;
		while (j < n && !(series[j].ts > markerTs)) j++;
		return Math.max(0, j - 1);
	})();
	const pickIndex = (idx: number) => {
		if (!onPickTs) return;
		const clamped = Math.max(0, Math.min(n - 1, idx));
		onPickTs(clamped >= n - 1 ? null : series[clamped].ts);
	};
	const onPlotClick = (e: React.MouseEvent) => {
		if (!onPickTs || n < 2) return;
		const rect = wrapRef.current?.getBoundingClientRect();
		if (!rect) return;
		// The svg is drawn at the container's real width, so px = viewBox units.
		const x = e.clientX - rect.left;
		pickIndex(Math.round(((x - padL) / iW) * (n - 1)));
	};
	const onPlotKey = (e: React.KeyboardEvent) => {
		if (!onPickTs || n < 2) return;
		if (e.key === "ArrowLeft") { e.preventDefault(); pickIndex(markerIdx - 1); }
		if (e.key === "ArrowRight") { e.preventDefault(); pickIndex(markerIdx + 1); }
		if (e.key === "Escape" || e.key === "Home" || e.key === "End") { e.preventDefault(); onPickTs(null); }
	};

	return (
		<div className="mem-chart" ref={wrapRef}>
			<svg
				viewBox={`0 0 ${W} ${H}`}
				style={{ width: "100%", height: `${H}px`, display: "block", cursor: onPickTs && n >= 2 ? "crosshair" : undefined }}
				role={onPickTs && n >= 2 ? "slider" : "img"}
				aria-label={onPickTs && n >= 2 ? "Memory over time. Click or use arrow keys to view the memory as it was after an earlier event." : "Memory over time"}
				{...(onPickTs && n >= 2 ? { tabIndex: 0, "aria-valuemin": 0, "aria-valuemax": n - 1, "aria-valuenow": markerIdx, onClick: onPlotClick, onKeyDown: onPlotKey } : {})}
			>
				{ticks.map((tv, i) => (
					<g key={i}>
						<line x1={padL} y1={Y(tv).toFixed(1)} x2={W - 6} y2={Y(tv).toFixed(1)} stroke="var(--border-soft)" strokeWidth={0.5} />
						<text x={padL - 6} y={Y(tv) + 3} textAnchor="end" fontSize={9} fill="var(--muted)" fontFamily="var(--exx-font-mono)">{tv === max ? `${kTok(tv)} tok` : kTok(tv)}</text>
					</g>
				))}
				{firstTs && <text x={padL} y={H - 6} textAnchor="start" fontSize={9} fill="var(--dim)" fontFamily="var(--exx-font-mono)">{fmtDay(firstTs)}</text>}
				{lastTs && lastTs !== firstTs && <text x={W - 8} y={H - 6} textAnchor="end" fontSize={9} fill="var(--dim)" fontFamily="var(--exx-font-mono)">{fmtDay(lastTs)}</text>}
				{/* Foreground-based fills so the chart reads in both themes (the old
				    paper fills vanished on a light background). */}
				<path d={band(() => 0, (s) => s.consolidated)} fill="var(--fg)" opacity={0.18} />
				<path d={band((s) => s.consolidated, (s) => s.consolidated + s.recent)} fill="var(--exx-plan)" opacity={0.8} />
				{/* The deep-memory boundary is a real (thin) line so the Learn/Review
				    markers visibly sit ON it, mirroring the session dots on the total. */}
				<polyline points={linePts((s) => s.consolidated).join(" ")} fill="none" stroke="var(--fg-soft)" strokeWidth={1} opacity={0.7} vectorEffect="non-scaling-stroke" />
				<polyline points={linePts(tot).join(" ")} fill="none" stroke="var(--fg-soft)" strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
				{/* Sessions dot the total line; Learn/Review get a labelled full-height
				    tick with their marker on the DEEP-MEMORY boundary — the layer those
				    two events actually change. */}
				{series.map((s, i) => {
					if (s.kind === "checkpoint") return null;
					const x = X(i).toFixed(1);
					const on = hover?.i === i;
					// Learn/Review change BOTH layers, so they mark both lines: the
					// deep boundary (where knowledge lands) and the total (compression).
					// Shape carries the protocol: filled diamond = Learn, hollow = Review.
					const xNum = X(i);
					const mark = (cyNum: number) => {
						const r = on ? 6.5 : 5.5;
						const d = `M ${xNum.toFixed(1)} ${(cyNum - r).toFixed(1)} L ${(xNum + r).toFixed(1)} ${cyNum.toFixed(1)} L ${xNum.toFixed(1)} ${(cyNum + r).toFixed(1)} L ${(xNum - r).toFixed(1)} ${cyNum.toFixed(1)} Z`;
						return s.kind === "absorb"
							? <path d={d} fill="var(--fg)" stroke="var(--bg)" strokeWidth={1.25} />
							: <path d={d} fill="var(--bg)" stroke="var(--fg)" strokeWidth={1.75} />;
					};
					const anchor = xNum > W - 40 ? "end" : xNum < padL + 30 ? "start" : "middle";
					return (
						<g key={`ev-${i}`}>
							<line x1={x} y1={Y(tot(s)).toFixed(1)} x2={x} y2={padT + iH} stroke="var(--fg-soft)" strokeWidth={1} strokeDasharray="3 3" opacity={0.55} />
							{mark(Y(s.consolidated))}
							{Y(tot(s)) - Y(s.consolidated) < -8 && mark(Y(tot(s)))}
							<text x={x} y={H - 20} textAnchor={anchor} fontSize={9} fill="var(--muted)" fontFamily="var(--exx-font-mono)">{s.kind === "absorb" ? "Learn" : "Review"}</text>
						</g>
					);
				})}
				{series.map((s, i) => {
					const x = X(i).toFixed(1);
					const on = hover?.i === i;
					return (
						<g key={`hit-${i}`} onMouseEnter={(e) => onEnter(i, e)} onMouseMove={(e) => onEnter(i, e)} onMouseLeave={() => setHover((h) => (h?.i === i ? null : h))} style={{ cursor: "pointer" }}>
							{/* Hit areas on BOTH lines for Learn/Review — they draw a marker on each. */}
							<circle cx={x} cy={Y(tot(s)).toFixed(1)} r={12} fill="transparent" />
							{s.kind !== "checkpoint" && <circle cx={x} cy={Y(s.consolidated).toFixed(1)} r={12} fill="transparent" />}
							{s.kind === "checkpoint" && <circle cx={x} cy={Y(tot(s)).toFixed(1)} r={on ? 4.5 : 3} fill="var(--fg)" />}
						</g>
					);
				})}
				{markerX !== null && (
					<g>
						<line x1={markerX.toFixed(1)} y1={padT} x2={markerX.toFixed(1)} y2={padT + iH} stroke="var(--exx-plan)" strokeWidth={2} />
						<text x={markerX.toFixed(1)} y={padT - 2} textAnchor="middle" fontSize={9} fill="var(--exx-plan)" fontFamily="var(--exx-font-mono)">viewing</text>
					</g>
				)}
			</svg>
			{hover && (() => {
				const nfo = info(hover.i);
				const below = hover.y < 96;
				return (
					<div className="mem-tip" style={{ left: `${hover.x}px`, top: `${hover.y}px`, transform: `translate(-50%, ${below ? "16px" : "calc(-100% - 16px)"})` }}>
						<div className="mem-tip-head"><span className="mem-tip-title">{nfo.title}</span>{nfo.when && <span className="mem-tip-when">{nfo.when}</span>}</div>
						{nfo.lines.map((l, k) => <div key={k} className="mem-tip-line">{l}</div>)}
					</div>
				);
			})()}
		</div>
	);
}

export function Memory({ onMaintain, maintainBlocked }: { onMaintain?: (target: { agentId: string; displayName: string }) => void; maintainBlocked?: (agentId: string) => string | null } = {}) {
	const [data, setData] = useState<Overview | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [detail, setDetail] = useState<RoomDetail | null>(null);
	const [digest, setDigest] = useState<Digest | null>(null);
	const [query, setQuery] = useState("");
	const [hits, setHits] = useState<SearchHit[] | null>(null);
	const [searching, setSearching] = useState(false);
	const [askMode, setAskMode] = useState<"ask" | "find">("ask");
	const [ask, setAsk] = useState("");
	const [messages, setMessages] = useState<Array<{ role: "user" | "assistant"; text: string; sources?: string[] }>>([]);
	const [scope, setScope] = useState<Set<string>>(new Set()); // empty = all rooms
	const [asking, setAsking] = useState(false);
	const [askError, setAskError] = useState<string | null>(null);
	const [loadError, setLoadError] = useState(false);
	const [memInfo, setMemInfo] = useState<Record<string, RoomMemoryInfo>>({});
	const [tab, setTab] = useState<"overview" | "hivemind">("overview");
	const searchSeq = useRef(0);
	const detailRef = useRef<HTMLElement>(null);
	// The reading panel's mode: null = the default Recent sessions list; an
	// area's actual content (click-to-read memory map); or the stored
	// conversation a receipt points at.
	type Panel =
		| { kind: "area"; area: string; content: string }
		| { kind: "transcript"; cp: string; title: string; state: "loading" | "error"; data?: undefined }
		| { kind: "transcript"; cp: string; title: string; state: "ready"; data: TranscriptResult };
	const [panel, setPanel] = useState<Panel | null>(null);
	// Every panel open/close intent bumps this; a fetch started under an older
	// intent finds the mismatch on resolve and drops its response, so a slow
	// area/full-memory read can never override what the user did since.
	const panelReq = useRef(0);
	// Reading panel expanded to a full-screen overlay (Esc or ✕ to leave).
	const [panelFull, setPanelFull] = useState(false);
	// Folded tool calls the user has opened in the transcript (item indexes).
	const [openTools, setOpenTools] = useState<Set<number>>(new Set());
	// Long transcripts render their tail only on request.
	const [trAll, setTrAll] = useState(false);
	// Provenance receipt fold, one open at a time (index into recentSessions).
	const [receiptIdx, setReceiptIdx] = useState<number | null>(null);
	const [histAll, setHistAll] = useState(false);
	// "What changed" fold on history rows, one open at a time (event id), with
	// a per-room cache so re-opening a row doesn't refetch.
	const [diffOpen, setDiffOpen] = useState<string | null>(null);
	const [diffFull, setDiffFull] = useState(false);
	const [diffs, setDiffs] = useState<Record<string, { state: "loading" } | { state: "error" } | { state: "ready"; data: EventDiff }>>({});

	// Expanding a card loads its detail below the grid — bring it into view so
	// the click visibly "goes somewhere".
	useEffect(() => {
		if (detail) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
		panelReq.current++;
		setPanel(null);
		setPanelFull(false);
		setReceiptIdx(null);
		setHistAll(false);
		setDiffOpen(null);
		setDiffFull(false);
		setDiffs({});
		setTtValue(null);
	}, [detail?.id]);

	// Each panel starts with its tools folded, its tail collapsed, and (when
	// the panel closes entirely) back in the normal layout.
	useEffect(() => {
		setOpenTools(new Set());
		setTrAll(false);
		if (!panel) setPanelFull(false);
	}, [panel]);

	// Esc leaves full screen without closing the panel or the diff fold.
	useEffect(() => {
		if (!panelFull && !diffFull) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { setPanelFull(false); setDiffFull(false); } };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [panelFull, diffFull]);

	const openArea = (rowArea: string) => {
		if (!detail) return;
		const req = ++panelReq.current;
		// The Recent sessions row toggles back to the default panel (its full
		// list already lives there).
		if (rowArea.startsWith("Recent sessions")) { setPanel(null); return; }
		// In past mode the section is read from the snapshot itself, so what
		// you read can never drift from the map you clicked.
		if (past) {
			const content = past.areas[rowArea];
			if (typeof content === "string") setPanel({ kind: "area", area: rowArea, content });
			return;
		}
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/area?name=${encodeURIComponent(rowArea)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (req === panelReq.current && d && typeof d.content === "string") setPanel({ kind: "area", area: d.area, content: d.content }); })
			.catch(() => {});
	};

	// The whole memory document, end to end, in the reading panel. Today's
	// document comes from the same snapshot reader (now resolves to current).
	const openFullMemory = () => {
		if (!detail) return;
		const req = ++panelReq.current;
		if (past) { setPanel({ kind: "area", area: "Full memory", content: past.content }); return; }
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/snapshot?at=${Date.now()}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d: Snapshot | null) => { if (req === panelReq.current && d && typeof d.content === "string") setPanel({ kind: "area", area: "Full memory", content: d.content }); })
			.catch(() => {});
	};

	// Open the stored conversation behind a receipt in the reading panel. The
	// in-flight guard keys on the checkpoint id (titles are not unique), so an
	// out-of-order response can never land under another session's receipt.
	const openConversation = (s: RecentSession) => {
		if (!detail || !s.checkpointId) return;
		panelReq.current++;
		const cp = s.checkpointId;
		setPanel({ kind: "transcript", cp, title: s.title, state: "loading" });
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/conversation?checkpoint=${encodeURIComponent(cp)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
			.then((d: TranscriptResult) => setPanel((p) => (p?.kind === "transcript" && p.cp === cp ? { kind: "transcript", cp, title: s.title, state: "ready", data: d } : p)))
			.catch(() => setPanel((p) => (p?.kind === "transcript" && p.cp === cp ? { kind: "transcript", cp, title: s.title, state: "error" } : p)));
	};

	// Toggle "What changed" on a Learn/Review history row.
	const toggleDiff = (e: MemoryHistoryEvent) => {
		if (!detail || !e.id || (e.kind !== "learn" && e.kind !== "review")) return;
		const key = e.id;
		if (diffOpen === key) { setDiffOpen(null); setDiffFull(false); return; }
		setDiffOpen(key);
		// A cached error is not a cache hit — re-opening the row retries the
		// fetch instead of pinning "couldn't read" until the next room switch.
		if (diffs[key] && diffs[key].state !== "error") return;
		setDiffs((prev) => ({ ...prev, [key]: { state: "loading" } }));
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/event-diff?kind=${e.kind}&event=${encodeURIComponent(key)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
			.then((d: EventDiff) => setDiffs((prev) => ({ ...prev, [key]: { state: "ready", data: d } })))
			.catch(() => setDiffs((prev) => ({ ...prev, [key]: { state: "error" } })));
	};

	// The open row's diff, computed once per fetched snapshot pair — not per
	// render (the differ walks the whole documents).
	const openDiffState = diffOpen ? diffs[diffOpen] : undefined;
	const openDiffSections = useMemo(
		() => (openDiffState?.state === "ready"
			? openDiffState.data.sections.map((sec) => ({ ...sec, hunks: diffHunks(coalesceRuns(diffLines(sec.beforeText, sec.afterText))) }))
			: null),
		[openDiffState],
	);

	// Time travel: the picked past moment (null = today). Scrubbing puts the
	// WHOLE detail view into past mode — map, sessions and vitals render the
	// snapshot's data, so the cards can never disagree with each other.
	const [ttValue, setTtValue] = useState<number | null>(null);
	const [snap, setSnap] = useState<
		| { at: number; state: "loading" | "error"; data?: undefined }
		| { at: number; state: "ready"; data: Snapshot }
		| null
	>(null);
	const setTimeTravel = (v: number | null) => {
		setTtValue(v);
		if (v === null) setSnap(null);
	};
	// Leave the past the moment another room is picked — before the fetch
	// effect below, so its cleanup marks any stale request and the new room
	// can never render the old room's snapshot.
	useEffect(() => {
		setTtValue(null);
		setSnap(null);
	}, [selected]);
	// The reading panel and the open receipt fold describe one viewing basis;
	// moving to another moment (or back to today) would relabel content that
	// was fetched under the old one, so both close instead.
	useEffect(() => {
		panelReq.current++;
		setPanel(null);
		setReceiptIdx(null);
	}, [ttValue]);
	useEffect(() => {
		if (!selected || ttValue === null) return;
		const roomId = selected;
		const at = ttValue;
		// The cleanup cancels the debounce timer, but a fetch that already
		// fired keeps running — `stale` makes sure a slower older response (or
		// one from a room this view already left) can never install itself
		// over the moment picked since.
		let stale = false;
		setSnap((s) => (s?.state === "ready" ? s : { at, state: "loading" }));
		const timer = setTimeout(() => {
			apiFetch(`/api/memory/rooms/${encodeURIComponent(roomId)}/snapshot?at=${at}`)
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
				.then((d: Snapshot) => { if (!stale) setSnap({ at, state: "ready", data: d }); })
				.catch(() => { if (!stale) setSnap({ at, state: "error" }); });
		}, 250);
		return () => { stale = true; clearTimeout(timer); };
	}, [ttValue, selected]);
	// The snapshot the view is currently rendering (null = today). While a new
	// scrub position loads, the previous snapshot keeps the view stable.
	const past = ttValue !== null && snap?.state === "ready" ? snap.data : null;

	// "What changed since you were last here." Read the stored last-visit, diff
	// against it, and only stamp now() AFTER a successful fetch (so a failure or
	// an early navigate-away doesn't silently burn the catch-up window).
	useEffect(() => {
		let cancelled = false;
		let since = Date.now() - 7 * 24 * 3600 * 1000;
		try {
			const raw = Number(localStorage.getItem(LAST_VISIT_KEY));
			if (Number.isFinite(raw) && raw > 0) since = raw;
		} catch { /* storage unavailable — fall back to 7-day window */ }
		apiFetch(`/api/memory/digest?since=${since}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => {
				if (cancelled || !d) return;
				setDigest(d);
				try { localStorage.setItem(LAST_VISIT_KEY, String(Date.now())); } catch { /* ignore */ }
			})
			.catch(() => {});
		return () => { cancelled = true; };
	}, []);

	// Poll the overview like the Dashboard polls usage; memory changes only on
	// checkpoint/absorb, so a slow refresh is plenty.
	useEffect(() => {
		let cancelled = false;
		const load = () =>
			apiFetch("/api/memory/overview")
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
				.then((d) => { if (!cancelled) { setData(d); setLoadError(false); } })
				.catch(() => { if (!cancelled) setLoadError(true); });
		load();
		const id = setInterval(load, 8000);
		return () => { cancelled = true; clearInterval(id); };
	}, []);

	// Budget share + weekly deep delta per room. Memory changes only through
	// Learn/Review/checkpoint events, so a slow poll is plenty.
	useEffect(() => {
		let cancelled = false;
		const load = () =>
			apiFetch("/api/memory/room-memory")
				.then((r) => (r.ok ? r.json() : null))
				.then((d: { rooms?: RoomMemoryInfo[] } | null) => {
					if (cancelled || !d || !Array.isArray(d.rooms)) return;
					const map: Record<string, RoomMemoryInfo> = {};
					for (const room of d.rooms) map[room.id] = room;
					setMemInfo(map);
				})
				.catch(() => {});
		load();
		const id = setInterval(load, 30000);
		return () => { cancelled = true; clearInterval(id); };
	}, []);

	// Fetch the selected room's detail (memory map + recent sessions).
	useEffect(() => {
		if (!selected) { setDetail(null); return; }
		let cancelled = false;
		apiFetch(`/api/memory/rooms/${encodeURIComponent(selected)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (!cancelled) setDetail(d); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [selected]);

	// Accepts an explicit question so suggestion chips don't race a stale `ask`.
	// Keeps a short conversation so follow-ups have context, and honours the
	// selected room scope (empty = all rooms).
	const runAsk = (override?: string) => {
		const q = (override ?? ask).trim();
		if (!q || asking) return;
		const history = messages.map((m) => ({ role: m.role, content: m.text }));
		setMessages((prev) => [...prev, { role: "user", text: q }]);
		setAsk("");
		setAsking(true);
		setAskError(null);
		const rooms = scope.size > 0 ? [...scope] : undefined;
		const ctrl = new AbortController();
		const timer = setTimeout(() => ctrl.abort(), 65_000);
		apiFetch("/api/memory/ask", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ question: q, rooms, history }),
			signal: ctrl.signal,
		})
			.then((r) => r.json())
			.then((d) => {
				if (d.ok) setMessages((prev) => [...prev, { role: "assistant", text: d.answer, sources: d.sources ?? [] }]);
				else setAskError(d.message || "Couldn't answer that.");
			})
			.catch((e) => setAskError(e?.name === "AbortError" ? "That took too long. Try again." : "Request failed. Is the app still running?"))
			.finally(() => { clearTimeout(timer); setAsking(false); });
	};

	const toggleScopeRoom = (id: string) => {
		setScope((prev) => {
			const next = new Set(prev);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});
	};

	const runSearch = () => {
		const q = query.trim();
		if (!q) { setHits(null); return; }
		const seq = ++searchSeq.current;
		setSearching(true);
		apiFetch(`/api/memory/search?q=${encodeURIComponent(q)}`)
			.then((r) => (r.ok ? r.json() : { hits: [] }))
			.then((d) => { if (seq === searchSeq.current) setHits(d.hits ?? []); })
			.catch(() => { if (seq === searchSeq.current) setHits([]); })
			.finally(() => { if (seq === searchSeq.current) setSearching(false); });
	};

	if (!data) return <div className="dashboard"><div className="sub">{loadError ? "Couldn't load memory. Retrying…" : "Loading…"}</div></div>;

	const t = data.totals;
	// One consistent "sessions" figure everywhere: the parsed per-room count.
	const toAbsorb = data.rooms.reduce((sum, r) => sum + r.sessions, 0);

	const caughtUp = digest && digest.totals.newCheckpoints === 0;
	const scopeLabel = scope.size === 0 ? "all exxperts" : `${scope.size} exxpert${scope.size === 1 ? "" : "s"}`;

	return (
		<div className="dashboard">
			<div className="mem-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} onClick={() => setTab("overview")}>Overview</button>
				<button type="button" role="tab" aria-selected={tab === "hivemind"} className={tab === "hivemind" ? "active" : ""} onClick={() => setTab("hivemind")}>HiveMind</button>
			</div>

			{tab === "hivemind" && (
				<>
					<section className="dash-section">
						<div className="dash-section-head">
							<div className="dash-section-label">HiveMind</div>
							<div className="dash-toggles">
								{askMode === "ask" && messages.length > 0 && (
									<button type="button" className="mem-close" onClick={() => { setMessages([]); setAskError(null); }}>New chat</button>
								)}
								<div className="range-toggle" role="group" aria-label="Query mode">
									<button type="button" className={askMode === "ask" ? "active" : ""} aria-pressed={askMode === "ask"} onClick={() => setAskMode("ask")}>Ask</button>
									<button type="button" className={askMode === "find" ? "active" : ""} aria-pressed={askMode === "find"} onClick={() => setAskMode("find")}>Find text</button>
								</div>
								<span className="mem-measured" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>{askMode === "ask" ? `Read-only · ${scopeLabel}` : "Local · no model"}</span>
							</div>
						</div>
						<div className="chart-block">
							<div className="sub" style={{ marginBottom: 10 }}>{askMode === "ask" ? "Chat across the exxperts you pick. Answers are grounded in your memory, and cite the exxpert each fact comes from." : "Find exact text across every exxpert's memory. Local, no model."}</div>
							{askMode === "ask" && data.rooms.length > 1 && (
								<div className="mem-scope">
									<span className="mem-scope-label">Exxperts</span>
									<button type="button" className={`mem-scope-chip${scope.size === 0 ? " active" : ""}`} onClick={() => setScope(new Set())}>All exxperts</button>
									{data.rooms.map((r) => (
										<button key={r.id} type="button" className={`mem-scope-chip${scope.has(r.id) ? " active" : ""}`} onClick={() => toggleScopeRoom(r.id)}>{r.displayName}</button>
									))}
								</div>
							)}
							{askMode === "ask" && messages.length > 0 && (
								<div className="mem-thread">
									{messages.map((m, i) => (
										m.role === "user" ? (
											<div key={i} className="mem-turn-user">{m.text}</div>
										) : (
											<div key={i} className="mem-answer">
												<div className="md assistant-markdown"><MarkdownRenderer>{m.text}</MarkdownRenderer></div>
												{(() => {
													const cited = (m.sources ?? []).filter((s) => m.text.toLowerCase().includes(s.toLowerCase()));
													const shown = cited.length > 0 ? cited : (m.sources ?? []);
													if (shown.length === 0) return null;
													return (
														<div className="mem-source-chips">
															<span className="mem-source-label">{cited.length > 0 ? "Cited" : `Searched ${shown.length} exxpert${shown.length === 1 ? "" : "s"}`}</span>
															{shown.map((s) => <span key={s} className="mem-source-chip">{s}</span>)}
														</div>
													);
												})()}
											</div>
										)
									))}
								</div>
							)}
							<div className="mem-search">
								{askMode === "ask" ? (
									<input className="mem-search-input" type="text" placeholder={messages.length ? "Ask a follow-up…" : "Ask a question across your exxperts' memory…"} value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runAsk(); }} />
								) : (
									<input className="mem-search-input" type="search" placeholder="Find exact text across every exxpert…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") runSearch(); }} />
								)}
								<button type="button" className="mem-search-btn" onClick={() => (askMode === "ask" ? runAsk() : runSearch())} disabled={askMode === "ask" && asking}>
									{askMode === "ask" ? (asking ? "Thinking…" : messages.length ? "Send" : "Ask") : "Find"}
								</button>
							</div>
							{askMode === "ask" ? (
								<>
									{messages.length === 0 && !asking && !askError && (
										<div className="mem-suggest">
											{["What am I working on right now?", "Summarize what's changed lately", "Who and what have I mentioned?"].map((s) => (
												<button key={s} type="button" className="mem-suggest-chip" onClick={() => { setAsk(s); runAsk(s); }}>{s}</button>
											))}
										</div>
									)}
									{asking && <div className="sub" style={{ marginTop: 12 }}>Reading your memory across {scopeLabel}…</div>}
									{askError && <div className="sub" style={{ marginTop: 12, color: "var(--fg-soft)" }}>{askError}</div>}
								</>
							) : (
								hits !== null && (
									<div style={{ marginTop: 12 }}>
										{searching && <div className="sub">Searching…</div>}
										{!searching && hits.length === 0 && <div className="sub">No matches found.</div>}
										{!searching && hits.map((h, i) => (
											<button key={i} type="button" className="mem-hit" onClick={() => { setSelected(h.roomId); setTab("overview"); }}>
												<div className="mem-hit-head">{h.room} · <span className="mem-hit-area">{h.area}</span></div>
												<div className="mem-hit-snip">{h.snippet}</div>
											</button>
										))}
									</div>
								)
							)}
						</div>
					</section>
				</>
			)}

			{tab === "overview" && (
				<>
					{digest && !caughtUp && (
						<section className="dash-section">
							<div className="mem-digest">
								<div className="mem-digest-body">
									<div className="mem-digest-title">Since you were last here</div>
									<div className="sub">
										<strong>{digest.totals.newCheckpoints}</strong> new session{digest.totals.newCheckpoints === 1 ? "" : "s"}
										{digest.totals.newReviews > 0 && <> and <strong>{digest.totals.newReviews}</strong> review{digest.totals.newReviews === 1 ? "" : "s"}</>} across{" "}
										<strong>{digest.totals.roomsChanged}</strong> exxpert{digest.totals.roomsChanged === 1 ? "" : "s"}
										{digest.since > 0 && <> · in the last {fmtAgo(digest.since).replace(" ago", "")}</>}
									</div>
									{digest.rooms.length > 0 && (
										<div className="mem-digest-rooms">
											{digest.rooms.slice(0, 3).map((r) => (
												<button key={r.id} type="button" className="mem-digest-room" onClick={() => setSelected(r.id)}>
													<span className="mem-digest-room-name">{r.displayName}</span>
													<span className="mem-digest-room-meta">
														{r.newCheckpoints} session{r.newCheckpoints === 1 ? "" : "s"}
														{r.newReviews > 0 && <>, {r.newReviews} review{r.newReviews === 1 ? "" : "s"}</>}
														{r.title ? ` · ${r.title}` : ""}
													</span>
												</button>
											))}
										</div>
									)}
								</div>
							</div>
						</section>
					)}

					<section className="dash-section">
						<div className="dash-section-label">At a glance</div>
						<div className="mem-glance">
							<div className="mem-glance-nums">
								<div className="mem-g" title="Measured from the memory documents on disk, converted to tokens. Token counts are always approximate. Each model's tokenizer splits text differently."><div className="v">{fmtTok(t.l1bTokens)} tok</div><div className="k">memory (est.)</div></div>
								<div className="mem-g"><div className="v">{t.checkpoints.toLocaleString()}</div><div className="k">sessions</div></div>
								<div className="mem-g"><div className="v">{toAbsorb}</div><div className="k">to learn</div></div>
								<div className="mem-g"><div className="v">{t.rooms}</div><div className="k">exxperts</div></div>
							</div>
							{(() => {
								// Durable = consolidated knowledge (incl. the small chronos index);
								// Recent = pending absorb. Total = their sum, so it reconciles.
								const c = t.composition;
								const deep = c.deep;
								const total = deep + c.recent;
								if (total <= 0) return null;
								return (
									<div className="mem-composition">
										<div className="mem-comp-bar" role="img" aria-label="Memory: deep vs pending">
											<div className="mem-comp-seg durable" style={{ width: `${(deep / total) * 100}%` }} title={`Deep memory ${fmtInt(deep)}`} />
											<div className="mem-comp-seg recent" style={{ width: `${(c.recent / total) * 100}%` }} title={`Recent ${fmtInt(c.recent)}`} />
										</div>
										<div className="mem-comp-legend">
											<span><span className="sw durable" />Deep memory <b>{fmtInt(deep)} tok</b></span>
											<span><span className="sw recent" />Recent sessions <b>{fmtInt(c.recent)} tok</b></span>
										</div>
									</div>
								);
							})()}
						</div>
					</section>

					{onMaintain && data.rooms.some((r) => r.needsAbsorb) && (
						<section className="dash-section">
							<div className="mem-absorb-callout">
								<div className="mem-absorb-body">
									<div className="mem-digest-title">Ready to learn</div>
									<div className="sub">These exxperts have recent sessions waiting to be learned into deep memory. Learn runs the model and shows you the proposed update before anything is written. Rooms with automatic memory maintenance apply clean updates on their own.</div>
								</div>
								<div className="mem-absorb-rooms">
									{data.rooms.filter((r) => r.needsAbsorb).map((r) => {
										const blocked = maintainBlocked?.(r.id) ?? null;
										return (
											<button key={r.id} type="button" className="mem-review-btn" disabled={!!blocked} title={blocked ?? undefined} onClick={() => onMaintain({ agentId: r.id, displayName: r.displayName })}>
												{r.displayName}: learn →
											</button>
										);
									})}
								</div>
							</div>
						</section>
					)}

					<section className="dash-section">
						<div className="dash-section-label">Exxperts</div>
						{data.rooms.length === 0 && <div className="sub">No exxperts yet. Create one to start building memory.</div>}
						<div className="mem-cards">
							{data.rooms.map((r) => {
								const isSel = selected === r.id;
								return (
									<button key={r.id} type="button" className={`mem-card${isSel ? " sel" : ""}`} aria-expanded={isSel} onClick={() => setSelected(isSel ? null : r.id)}>
										<div className="mem-card-head"><div className="mem-card-name">{r.displayName}</div>{r.needsAbsorb && <span className="mem-pill">to learn</span>}</div>
										<div className="mem-card-stats">
											<div className="st" title={`Everything this exxpert carries: deep memory ${fmtInt(r.composition.deep)} tok, recent sessions ${fmtInt(r.composition.recent)} tok, active items and timeline ${fmtInt(r.composition.active + r.composition.chronos)} tok.`}>
												<div className="v">{fmtTok(r.l1bTokens)} tok</div><div className="k">Total memory</div>
											</div>
											<div className="st"><div className="v">{r.checkpoints}</div><div className="k">Sessions</div></div>
											<div className="st"><div className="v">{r.sessions}<span className="mem-st-cap">/{r.sessionsCap}</span></div><div className="k">To learn</div></div>
										</div>
																					<div className="mem-card-spark">
												{r.series.length >= 2 ? <GrowthChart series={r.series} height={38} /> : <span className="mem-card-empty">{r.checkpoints > 0 ? "First memory saved. The curve appears with the next one" : "No memories yet. Have a session with this exxpert"}</span>}
											</div>
											{(() => {
												// Deep vs to-learn at a glance — same palette as the big chart.
												// Hidden until the exxpert has had a session: a bar of the seeded
												// template would contradict the "no memories yet" empty state.
												const deep = r.composition.deep;
												const pend = r.composition.recent;
												const total = deep + pend;
												if (total <= 0 || r.checkpoints === 0) return null;
												return (
													<div className="mem-card-comp" title={`Deep memory ${fmtInt(deep)} tok · to learn ${fmtInt(pend)} tok`}>
														<div className="mem-comp-bar mem-comp-bar-mini" role="img" aria-label="Deep memory vs to-learn split">
															<div className="mem-comp-seg durable" style={{ width: `${(deep / total) * 100}%` }} />
															<div className="mem-comp-seg recent" style={{ width: `${(pend / total) * 100}%` }} />
														</div>
													</div>
												);
											})()}
										<div className="mem-card-foot">
											<span>{r.lastCheckpointAt ? `last memory ${fmtAgo(r.lastCheckpointAt)}` : ""}</span>
											<span className="mem-card-hint">{isSel ? "Expanded ▾" : "Expand ▸"}</span>
										</div>
									</button>
								);
							})}
						</div>
					</section>

					{detail && (
						<section className="dash-section mem-detail-section" ref={detailRef}>
							<div className="dash-section-head mem-detail-head">
								<div className="mem-detail-hero">
									<div className="mem-detail-name">
										<h1>{detail.displayName}</h1>
										{/* Exactly the Rooms page's chips: standby while a parked
										    conversation waits, ready to learn when Learn is due,
										    and no chip at all for a settled room. */}
										{detail.standbyThread
											? <span className="mem-pill" title="This exxpert has a conversation parked to resume.">standby</span>
											: detail.needsAbsorb
												? <span className="mem-pill" title="Recent sessions are waiting to be learned into deep memory.">ready to learn</span>
												: null}
									</div>
									{detail.description && <div className="sub">{detail.description}</div>}
									{(() => {
										const first = detail.series[0]?.ts;
										const learns = detail.series.filter((s) => s.kind === "absorb").length;
										const reviews = detail.series.filter((s) => s.kind === "review").length;
										const now = new Date();
										const since = first
											? new Date(first).toLocaleDateString(undefined, { month: "short", day: "numeric", ...(new Date(first).getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })
											: null;
										return (
											<div className="sub mem-detail-strip">
												{since && <>Remembering since {since} · </>}
												{detail.checkpoints} session{detail.checkpoints === 1 ? "" : "s"} · {learns} learn{learns === 1 ? "" : "s"} · {reviews} review{reviews === 1 ? "" : "s"}
											</div>
										);
									})()}
								</div>
								{/* The state pill carries the why (tooltip), so no note here. */}
								<div className="mem-detail-actions">
									{onMaintain && (() => {
										const blocked = maintainBlocked?.(detail.id) ?? null;
										return (
											<button type="button" className="mem-review-btn" disabled={!!blocked} title={blocked ?? "Open Maintain to teach this room its recent sessions or review its long-term memory. You approve changes before they are saved."} onClick={() => onMaintain({ agentId: detail.id, displayName: detail.displayName })}>
												Maintain →
											</button>
										);
									})()}
									<button type="button" className="mem-close" onClick={() => setSelected(null)}>Close ×</button>
								</div>
							</div>
								{ttValue !== null && (
									<div className="mem-tt-banner mem-tt-banner-global">
										<span>
											{snap?.state === "error" ? "Couldn't read a snapshot for that moment right now."
												: !past ? "Reading the stored snapshot…"
												: past.basis === "archive"
													? <>Viewing this exxpert's memory as it was on <strong>{fmtWhen(new Date(past.at).toISOString())}</strong> ({fmtTok(past.estimatedTokens)} tok then). It has changed since{past.boundaryTs ? <>; the next change came {fmtDayShort(past.boundaryTs)}</> : null}.</>
													: <>No recorded change after that moment, so this is today's memory. Click further left on the curve to see an earlier state.</>}
										</span>
										<button type="button" className="mem-close" onClick={() => setTimeTravel(null)}>Back to today</button>
									</div>
								)}
								{(() => {
									// Vitals strip: measured figures, written plainly between the hero
									// and the chart — no card, part of the exxpert's "headline".
									// Total, deep and recent come from the same composition the cards
									// and charts use; the budget (room settings) and the weekly deep
									// delta (recorded events only, never extrapolated) come from
									// /api/memory/room-memory. Distillation is measured across the
									// Learn events themselves: each Learn's stored snapshots say how
									// many recent-session tokens were folded and how much new deep
									// memory came out. No estimates beyond the token unit itself.
									const learnFolds = detail.series.reduce(
										(acc, s, i) => {
											if (s.kind !== "absorb" || i === 0) return acc;
											const prev = detail.series[i - 1];
											acc.folded += Math.max(0, prev.recent - s.recent);
											acc.gained += s.consolidated - prev.consolidated;
											return acc;
										},
										{ folded: 0, gained: 0 },
									);
									const ratio = learnFolds.folded > 0 && learnFolds.gained > 0 && learnFolds.folded > learnFolds.gained
										? Math.round(learnFolds.folded / learnFolds.gained)
										: null;
									const learnCount = detail.series.filter((s) => s.kind === "absorb").length;
									const last = detail.series[detail.series.length - 1];
									if (!last || detail.checkpoints === 0) return null;
									const other = detail.composition.active + detail.composition.chronos;
									const mem = memInfo[detail.id];
									const w = mem?.weekly;
									const pct = mem ? Math.round((detail.l1bTokens / mem.budgetTokens) * 100) : 0;
									const over = pct > 100;
									// Past mode: sizes come from the snapshot ("then"); figures that
									// cannot be re-derived for a past day (distillation, 7-day
									// change, budget) stay visible but marked as today's.
									const comp = past ? past.composition : detail.composition;
									const totalTok = past ? comp.deep + comp.active + comp.recent + comp.chronos : detail.l1bTokens;
									const sessCount = past ? past.recentSessions.length : detail.sessions;
									const otherTok = past ? comp.active + comp.chronos : other;
									const then = past ? " then" : "";
									return (
										<div className="mem-vitals-strip">
											<div className="mem-glance-nums">
												<div className="mem-g" title="This exxpert's whole memory, injected into every turn so it never re-explains what it already knows.">
													<div className="v">~{fmtTok(totalTok)} tok</div>
													<div className="k">{past ? "total memory then" : "total memory, in every turn"}</div>
												</div>
												<div className="mem-g" title="The Deep Memory section: distilled knowledge this exxpert has learned.">
													<div className="v">{fmtTok(comp.deep)} tok</div>
													<div className="k">deep memory{then}</div>
												</div>
												<div className="mem-g" title="Session memories this exxpert hasn't learned into deep memory yet. Listed in full under Recent sessions below.">
													<div className="v">{fmtTok(comp.recent)} tok</div>
													<div className="k">{sessCount} recent session{sessCount === 1 ? "" : "s"}{then}</div>
												</div>
												{otherTok > 0 && (
													<div className="mem-g" title={`Active items ${fmtInt(comp.active)} tok and timeline ${fmtInt(comp.chronos)} tok. Both are broken out in the Memory map below.`}>
														<div className="v">{fmtTok(otherTok)} tok</div>
														<div className="k">active items and timeline{then}</div>
													</div>
												)}
												{ratio && (
													<div className={`mem-g${past ? " mem-g-today" : ""}`} title={`Measured across ${learnCount} Learn${learnCount === 1 ? "" : "s"}: ${fmtTok(learnFolds.folded)} tok of recent sessions became ${fmtTok(learnFolds.gained)} tok of new deep memory.`}>
														<div className="v">{ratio}:1</div>
														<div className="k">distilled across {learnCount} learn{learnCount === 1 ? "" : "s"}</div>
													</div>
												)}
												{w && (
													<div className={`mem-g${past ? " mem-g-today" : ""}`} title={w.recorded && w.events > 0 ? `Deep-memory change measured over ${w.events} recorded event${w.events === 1 ? "" : "s"} in the last 7 days${w.wholeHistory ? "; this exxpert's whole history is within the week" : ""}.` : "Deep-memory change over the last 7 days, from recorded events only."}>
														{w.recorded && w.events > 0
															? <div className="v">{fmtDelta(w.deepDelta)} tok</div>
															: <div className="v mem-g-quiet">{w.recorded ? "no change recorded" : "no history yet"}</div>}
														<div className="k">deep memory, last 7 days</div>
													</div>
												)}
											</div>
											{mem && (
												<div className={`mem-budget${past ? " mem-g-today" : ""}`} title="This exxpert's memory against its advisory budget from room settings. The budget is a ceiling, not a goal. Today's figure, not time-travelled.">
													<div className="mem-budget-line">
														<span>Memory budget</span>
														<strong className={over ? "over" : ""}>{pct}% of {fmtTok(mem.budgetTokens)} tok{mem.budgetCustomized ? "" : " (default)"}</strong>
													</div>
													<div className="mem-budget-meter" role="meter" aria-valuenow={Math.min(pct, 100)} aria-valuemin={0} aria-valuemax={100} aria-label="Memory used against this exxpert's budget">
														<div className={`mem-budget-fill${over ? " over" : ""}`} style={{ width: `${Math.min(100, pct)}%` }} />
													</div>
												</div>
											)}
											{past && <div className="mem-today-note">Figures with the dotted edge are today's; distillation, the 7-day change and the budget cannot be re-derived for a past day.</div>}
										</div>
									);
								})()}
								<div className="chart-block mem-detail-graph">
									<div className="chart-head"><h2>Learning curve</h2></div>
									<div className="sub" style={{ marginBottom: 8 }}>How this exxpert's memory has grown, event by event. Hover any point for details.{detail.series.length >= 2 ? " Click anywhere on the curve to view the memory as it was then." : ""}</div>
									{detail.series.length >= 2 ? (
										<>
											<BreakdownChart series={detail.series} height={300} markerTs={past ? past.at : null} onPickTs={setTimeTravel} />
											<div className="mem-comp-legend" style={{ marginTop: 8 }}>
												<span><span className="sw" style={{ background: "var(--fg)", opacity: 0.35 }} />Deep memory</span>
												<span><span className="sw" style={{ background: "var(--exx-plan)" }} />Recent sessions</span>
												<span><span className="mem-dot cp" />Checkpoint</span>
												<span><span className="mem-dot learn" />Learn</span>
												<span><span className="mem-dot review" />Review</span>
											</div>
										</>
									) : <div className="sub">No sessions yet.</div>}
									{(() => {
										const lastLearn = [...detail.series].reverse().find((s) => s.kind === "absorb");
										if (!lastLearn && !detail.lastReviewAt) return null;
										return (
											<div className="sub" style={{ marginTop: 8 }}>
												{lastLearn && <>Last learned {fmtAgo(lastLearn.ts)}.</>}
												{detail.lastReviewAt && <>{lastLearn ? " " : ""}Last memory review {fmtAgo(detail.lastReviewAt)}{detail.lastReviewTokenDelta < 0 ? `, trimmed ${-detail.lastReviewTokenDelta} tok from deep memory` : detail.lastReviewTokenDelta > 0 ? `, +${detail.lastReviewTokenDelta} tok` : ""}.</>}
											</div>
										);
									})()}
									
								</div>
								
							<div className="chart-grid">
								<div className="chart-block">
									<div className="dash-section-head" style={{ marginBottom: 0 }}>
										<div className="chart-head mem-head-row"><h2>Memory map</h2>{past && <span className="mem-asof">as of {fmtDayShort(past.at)}</span>}</div>
										<div className="mem-panel-actions">
											<button type="button" className="mem-close" onClick={openFullMemory}>Read all →</button>
										</div>
									</div>
									<div className="sub" style={{ marginBottom: 6 }}>{past ? "Composition that day, same measuring as today. Click a section to read what it held." : "Composition by estimated token weight. Click a section to read what's inside."}</div>
									{(past ? past.memoryMap : detail.memoryMap).length === 0 && <div className="sub">No structured memory yet.</div>}
									{(() => {
										const rows = past ? past.memoryMap : detail.memoryMap;
										const mx = Math.max(1, ...rows.map((m) => m.estimatedTokens));
										return rows.map((m) => {
											const isRc = m.area.startsWith("Recent sessions");
											const selArea = isRc ? panel === null : panel?.kind === "area" && panel.area === m.area;
											return (
												<div
													key={m.area}
													role="button"
													tabIndex={0}
													aria-pressed={selArea}
													className={`bar-row bar-row-static mem-map-row${isRc ? " mem-map-rc" : ""}${selArea ? " mem-map-sel" : ""}`}
													onClick={() => openArea(m.area)}
													onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); openArea(m.area); } }}
												>
													<div className="name">{isRc ? `Recent sessions ${past ? past.recentSessions.length : detail.sessions}/${detail.sessionsCap}` : m.area}</div>
													<div className="bar-track"><div className="bar-fill" style={{ width: `${(m.estimatedTokens / mx) * 100}%` }} /></div>
													<div className="pct">{fmtTok(m.estimatedTokens)} tok</div>
													<div className="num">{m.words} word{m.words === 1 ? "" : "s"}</div>
												</div>
											);
										});
									})()}
								</div>
								<div className="chart-block">
									{(() => {
										// The reading panel: recent sessions by default, an area's
										// content, or the stored conversation behind a receipt. One
										// body, rendered inline here and again inside the
										// full-screen overlay when expanded.
										const panelHead = (title: string, caption: string, asOf = false) => (
											<>
												<div className="dash-section-head" style={{ marginBottom: 0 }}>
													<div className="chart-head mem-head-row"><h2>{title}</h2>{asOf && past && <span className="mem-asof">as of {fmtDayShort(past.at)}</span>}</div>
													<div className="mem-panel-actions">
														<button type="button" className="mem-close" onClick={() => setPanelFull(!panelFull)}>{panelFull ? "Exit full screen" : "Full screen ⤢"}</button>
														<button type="button" className="mem-close" onClick={() => { panelReq.current++; setPanel(null); }}>Back ×</button>
													</div>
												</div>
												<div className="sub" style={{ marginBottom: 6 }}>{caption}</div>
											</>
										);
										const body = panel?.kind === "transcript" ? (
											<>
												{panelHead("Conversation", `The conversation "${panel.title}" was saved from, as stored on your machine. Read-only.`)}
												{panel.state === "loading" && <div className="sub">Opening the conversation…</div>}
												{panel.state === "error" && <div className="sub">Couldn't read this conversation right now.</div>}
												{panel.state === "ready" && !panel.data.stored && <div className="sub">This conversation is no longer stored.</div>}
												{panel.state === "ready" && panel.data.stored && (() => {
													const data = panel.data;
													const shown = trAll ? data.items : data.items.slice(0, 40);
													return (
														<div className="mem-tr">
															{shown.map((it, i) => {
																if (it.kind === "tool") {
																	const open = openTools.has(i);
																	return (
																		<div key={i} className="mem-tr-tool">
																			<button
																				type="button"
																				className="mem-tr-tool-line"
																				aria-expanded={open}
																				onClick={() => setOpenTools((prev) => { const next = new Set(prev); if (open) next.delete(i); else next.add(i); return next; })}
																			>
																				<span className="mem-tr-caret">{open ? "▾" : "▸"}</span>
																				<span className="mem-tr-tool-name">{it.name}</span>
																				{it.status && <span className="mem-tr-tool-status">{it.status}</span>}
																			</button>
																			{open && (
																				<div className="mem-tr-tool-detail">
																					{it.args && <pre className="mem-tr-pre">{it.args}</pre>}
																					{it.result && <pre className="mem-tr-pre">{it.result}</pre>}
																					{it.truncated && <div className="mem-tr-note">Long values are shortened in this view.</div>}
																				</div>
																			)}
																		</div>
																	);
																}
																if (it.kind === "user") {
																	return (
																		<div key={i} className="mem-tr-user">
																			<span className="mem-tr-who">You</span>
																			<div className="mem-tr-text">{it.text}</div>
																		</div>
																	);
																}
																return (
																	<div key={i} className={it.kind === "system" ? "mem-tr-system" : "mem-tr-assistant"}>
																		<div className="md assistant-markdown"><MarkdownRenderer>{it.text ?? ""}</MarkdownRenderer></div>
																	</div>
																);
															})}
															{!trAll && data.items.length > shown.length && (
																<button type="button" className="mem-hist-more" onClick={() => setTrAll(true)}>Show all {data.items.length} items</button>
															)}
															{data.itemsTotal > data.items.length && (
																<div className="mem-tr-note">Showing the first {data.items.length} of {data.itemsTotal} stored items.</div>
															)}
														</div>
													);
												})()}
											</>
										) : panel?.kind === "area" ? (
											<>
												{panelHead(panel.area, past ? `What this exxpert held in ${panel.area} that day, word for word. Read-only.` : `What this exxpert holds in ${panel.area}, word for word. Read-only.`, true)}
												<div className="mem-area-content md assistant-markdown">
													<MarkdownRenderer>{panel.content || "*This section is empty right now.*"}</MarkdownRenderer>
												</div>
											</>
										) : (
											<>
												<div className="dash-section-head" style={{ marginBottom: 0 }}>
													<div className="chart-head mem-head-row"><h2>Recent sessions</h2>{past && <span className="mem-asof">as of {fmtDayShort(past.at)}</span>}</div>
													<div className="mem-panel-actions">
														<button type="button" className="mem-close" onClick={() => setPanelFull(!panelFull)}>{panelFull ? "Exit full screen" : "Full screen ⤢"}</button>
													</div>
												</div>
												<div className="sub" style={{ marginBottom: 6 }}>{past ? "What was waiting to be learned that day. Newest first." : "Memories from recent sessions your exxpert hasn't learned from yet. Newest first."}</div>
												{(past ? past.recentSessions : detail.recentSessions).length === 0 && (
													<div className="sub">{past ? "No sessions were waiting to be learned that day." : detail.checkpoints > 0 ? "All caught up. Your exxpert has learned every recent session into deep memory." : "No memories yet. This exxpert hasn't had a session."}</div>
												)}
												<div className="mem-learned">
													{(past ? past.recentSessions : detail.recentSessions).map((s, i) => (
														<div key={i} className="mem-li">
															<div className="mem-li-txt">{s.title}</div>
															<div className="mem-li-src">
																{fmtTok(s.tokens)} tok{s.ts ? ` · ${fmtAgo(s.ts)}` : ""}
																{(s.content || s.approvedAt) && (
																	<button
																		type="button"
																		className="mem-prov-toggle"
																		aria-expanded={receiptIdx === i}
																		onClick={() => setReceiptIdx(receiptIdx === i ? null : i)}
																	>
																		{receiptIdx === i ? "Hide details" : "Details"}
																	</button>
																)}
															</div>
															{receiptIdx === i && (
																// Details = what the room saved, word for word, plus the
																// receipt. The receipt states only what the checkpoint event
																// record proves: the exact time the entry passed the gate —
																// and it opens the stored conversation only while the
																// closed-thread file actually exists.
																<div className="mem-prov-open">
																	{s.content && (
																		<div className="mem-prov-body md assistant-markdown">
																			<MarkdownRenderer>{s.content}</MarkdownRenderer>
																		</div>
																	)}
																	{s.approvedAt && (
																		<div className="mem-prov">
																			saved to memory {fmtWhen(s.approvedAt)} through the checkpoint gate
																			{s.conversation && s.checkpointId && (
																				<>
																					{" · "}
																					<button type="button" className="mem-prov-link" onClick={() => openConversation(s)}>open the conversation</button>
																				</>
																			)}
																		</div>
																	)}
																</div>
															)}
														</div>
													))}
												</div>
											</>
										);
										if (panelFull) {
											return (
												<>
													<div className="sub">Reading in full screen.</div>
													<div className="mem-fullscreen" role="dialog" aria-modal="true" aria-label="Memory reading panel, full screen">
														<div className="mem-fullscreen-inner chart-block">{body}</div>
													</div>
												</>
											);
										}
										return body;
									})()}
								</div>
							</div>
							{(detail.history ?? []).length > 0 && (
								<div className="chart-block mem-history">
									<div className="chart-head"><h2>Memory history</h2></div>
									<div className="sub" style={{ marginBottom: 6 }}>How this exxpert's memory has changed, from its own event records. Newest first. Read-only.{ttValue !== null ? " Events after the viewed moment had not happened yet." : ""}</div>
									{(histAll ? detail.history : detail.history.slice(0, 10)).map((e, i, arr) => (
										<div key={i} className={`mem-hist-item${ttValue !== null && e.ts > ttValue ? " mem-hist-future" : ""}`}>
											{ttValue !== null && e.ts <= ttValue && (i === 0 || arr[i - 1].ts > ttValue) && (
												<div className="mem-youare">you are viewing here</div>
											)}
											<div className="mem-hist-row" title={fmtWhen(new Date(e.ts).toISOString())}>
												<span className="mem-hist-date">{fmtDayShort(e.ts)}</span>
												<span className="mem-hist-kind">{e.kind === "checkpoint" ? "Checkpoint" : e.kind === "learn" ? "Learn" : "Review"}</span>
												<span className="mem-hist-what">{historyText(e)}</span>
												{e.diffable && e.id && (e.kind === "learn" || e.kind === "review") && (
													<button type="button" className="mem-prov-toggle mem-hist-details" aria-expanded={diffOpen === e.id} onClick={() => toggleDiff(e)}>
														{diffOpen === e.id ? "Hide details" : "Details"}
													</button>
												)}
											</div>
											{e.id != null && diffOpen === e.id && (() => {
												// Before/after from the event's own stored snapshots —
												// changed lines with context, grouped by memory section.
												const st = diffs[e.id!];
												if (!st || st.state === "loading") return <div className="sub mem-diff-note">Reading the stored snapshots…</div>;
												if (st.state === "error") return <div className="sub mem-diff-note">Couldn't read the snapshots for this event right now.</div>;
												const sections = openDiffSections ?? [];
												const body = (
													<div className="mem-diff">
														<div className="mem-diff-meta">
															<span className="sub">
																What this {e.kind === "learn" ? "Learn" : "Review"} changed, grouped by memory section from its stored before/after snapshots. Removed lines are struck, added lines marked +.
																{st.data.afterVerified === false ? " The after side is the next recorded state, which may include changes beyond this event." : ""}
															</span>
															<button type="button" className="mem-close" onClick={() => setDiffFull(!diffFull)}>{diffFull ? "Exit full screen" : "Full screen \u2922"}</button>
														</div>
														{sections.length === 0 && <div className="sub">The memory text is unchanged.</div>}
														{sections.map((sec, k) => (
															<div key={k} className="mem-diff-hunk">
																<div className="mem-diff-sec">
																	<span>{sec.section}</span>
																	<span className="mem-diff-sec-tok">{fmtTok(sec.beforeTokens)} to {fmtTok(sec.afterTokens)} tok</span>
																</div>
																<div className="mem-diff-lines">
																	{sec.hunks.map((h, hk) => (
																		<div key={hk} className="mem-diff-hunk-lines">
																			{h.lines.map((l, j) => (
																				<div key={j} className={`mem-diff-line ${l.type}`}>
																					<span className="mem-diff-mark">{l.type === "add" ? "+" : l.type === "del" ? "\u2212" : " "}</span>
																					<span className="mem-diff-text">{l.text || " "}</span>
																				</div>
																			))}
																		</div>
																	))}
																</div>
															</div>
														))}
													</div>
												);
												if (diffFull) {
													return (
														<>
															<div className="sub mem-diff-note">Reading in full screen.</div>
															<div className="mem-fullscreen" role="dialog" aria-modal="true" aria-label="Memory change, full screen">
																<div className="mem-fullscreen-inner chart-block">{body}</div>
															</div>
														</>
													);
												}
												return body;
											})()}
										</div>
									))}
									{detail.history.length > 10 && (
										<button type="button" className="mem-hist-more" onClick={() => setHistAll((v) => !v)}>
											{histAll ? "Show fewer" : `Show all ${detail.history.length}`}
										</button>
									)}
								</div>
							)}
						</section>
					)}
				</>
			)}

		</div>
	);
}
