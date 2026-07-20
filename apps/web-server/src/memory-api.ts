/**
 * Read-only room-memory telemetry.
 *
 * Rooms remember through the persistent-agent checkpoint architecture: each
 * room's durable memory is the `L1b/current.md` document, grown through
 * approval-gated checkpoints (see checkpoint-compression / absorb-consolidation).
 * Nothing here mutates memory — it only *reads and aggregates* what checkpoints
 * already record, so the app can finally show the user the memory it builds.
 *
 * Sources, all already on disk:
 *  - `L1b/current.md`            → current memory size + topic map (structuralReviewMetrics)
 *  - `events/checkpoint/*.json`  → the growth history (one record per checkpoint)
 *  - PersistentAgentStatus        → recent-context backlog + absorb readiness
 */

import fs from "node:fs";
import path from "node:path";
import {
	createPersistentAgentInstance,
	fingerprintL1bSource,
	listPersistentAgents,
	type AbsorbEventRecord,
	type CheckpointEventRecord,
	type StructuralReviewEventRecord,
	type PersistentAgentStatus,
} from "./persistent-agents.js";
import { buildStructuralReviewMemoryMap, extractStructuralReviewSourceParts, structuralReviewMetrics, type StructuralReviewMemoryMapRow } from "./structural-review.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

export interface MemoryGrowthPoint {
	/** epoch ms of the event that produced this L1b state */
	ts: number;
	/** measured L1b size after the event (estimated tokens) */
	tokens: number;
	/** chars the checkpoint added (the session folded into memory); 0 for absorbs */
	added: number;
	/** title of what was learned, when recorded */
	title: string | null;
	/** which kind of event produced this point */
	kind: "checkpoint" | "absorb" | "review";
	/** Deep Memory section tokens at this event (measured from the snapshot) */
	consolidated: number;
	/** recent-context (pending) tokens at this event */
	recent: number;
}

/**
 * Payoff signals — the join of memory with the usage log. All measured, no
 * causal claim: L1b is injected every turn (footprintTokens), and because it's
 * a stable prompt block it's cached, so most of it comes back as cheap
 * cacheRead rather than fresh input. `costPerTurn` / `cacheRatio` are read
 * straight from usage.jsonl for this room.
 */
export interface RoomPayoff {
	turns: number;
	totalCost: number;
	costPerTurn: number;
	/**
	 * Cache hit rate: cacheRead / (cacheRead + input) over this room's turns —
	 * the fraction of each turn's read context served from cache rather than as
	 * fresh input. NOTE: this covers the whole stable prompt (system prompt +
	 * tools + memory + history), not the memory block alone.
	 */
	cacheHitRate: number;
}

export interface RoomMemorySummary {
	id: string;
	displayName: string;
	description?: string;
	/**
	 * The room has a parked conversation waiting to be resumed — the exact
	 * condition behind the Rooms page's "standby" chip. False for a settled
	 * room (which shows no state chip anywhere).
	 */
	standbyThread: boolean;
	/** measured tokens of L1b — this is what's injected into every turn */
	l1bTokens: number;
	/** number of top-level memory areas (from the memory map) */
	areas: number;
	checkpoints: number;
	lastCheckpointAt: number | null;
	/** when this room's deep memory was last reviewed/pruned, if ever */
	lastReviewAt: number | null;
	/** deep-memory token change from that last review (negative = pruned) */
	lastReviewTokenDelta: number;
	/** recent-context entries waiting to be absorbed into durable memory */
	recentContextBacklog: number;
	/** the room is ready for a consolidation pass */
	needsAbsorb: boolean;
	/** L1b size after each checkpoint, oldest → newest (drives the sparkline) */
	series: MemoryGrowthPoint[];
	/** number of Recent Context session entries (awaiting absorb) */
	sessions: number;
	/** hard cap on recent sessions before a Learn is required */
	sessionsCap: number;
	/** recent (pending, not-yet-consolidated) session titles, newest first */
	topics: string[];
	/** key things the room knows (bold phrases from durable memory) */
	knows: string[];
	/** token split of this room's memory by layer */
	composition: MemoryComposition;
	/** measured usage payoff for this room, or null if it has no logged turns */
	payoff: RoomPayoff | null;
}

/** Memory token split by layer. "Deep memory" in the UI means `deep` ONLY. */
export interface MemoryComposition {
	/** the Deep Memory section — distilled knowledge */
	deep: number;
	/** Active Items — open threads and tasks */
	active: number;
	/** Recent Context — session summaries not yet absorbed */
	recent: number;
	/** Chronos — the chronological timeline spine */
	chronos: number;
}

/** A Recent Context session, sized in tokens (same unit as the memory map). */
export interface RecentSession {
	title: string;
	tokens: number;
	ts: number | null;
	/**
	 * True when `ts` is the exact approval instant (from rc_metadata or the
	 * checkpoint record). False when it is only the heading's YYYY-MM-DD date
	 * (hand-edited or pre-schema entries) — a date parses to UTC midnight, so
	 * hour-level "ago" wording from it would be invented precision; the UI must
	 * not render finer than days for these.
	 */
	tsPrecise: boolean;
	/**
	 * When the checkpoint that admitted this entry was approved (ISO). Null when
	 * no event record matches (hand-edited files, pre-schema rooms) — the UI
	 * shows a receipt only for entries that truly have one.
	 */
	approvedAt: string | null;
	/**
	 * The entry's full text (without its heading line), so the user can READ
	 * what the room saved, not just its title. Recent Context is the only
	 * memory area whose map row has no click-to-read; this fills that hole.
	 */
	content: string;
	/** the gate-written checkpoint id — the key for the conversation endpoint */
	checkpointId: string | null;
	/**
	 * The source conversation's closed-thread file is still on disk, so the
	 * receipt can offer "open the conversation". False when the record has no
	 * runtime boundary or the thread file is gone — the UI never shows a link
	 * it can't honour.
	 */
	conversation: boolean;
}

/**
 * One memory-changing event for the room's history timeline, composed from the
 * immutable event records under events/. Read-only provenance: nothing here is
 * derived from model output.
 */
export interface MemoryHistoryEvent {
	ts: number;
	kind: "checkpoint" | "learn" | "review";
	/** the event record's own id (checkpointId / absorbId / structuralReviewId) */
	id?: string | null;
	/**
	 * A before/after diff can be served for this event: its archived snapshot
	 * is still on disk. Only set for learn/review — the UI never offers "what
	 * changed" it can't honour.
	 */
	diffable?: boolean;
	/** checkpoint: the kept session's title (older records may lack it) */
	title?: string | null;
	/** learn: how many Recent Context sessions were consolidated */
	sessions?: number | null;
	/** learn: deep-memory size before/after, estimated tokens */
	deepTokensBefore?: number | null;
	deepTokensAfter?: number | null;
	/** review: deep-memory token delta (negative = trimmed) */
	tokenDelta?: number | null;
}

export interface MemoryOverview {
	generatedAt: number;
	totals: {
		rooms: number;
		l1bTokens: number;
		checkpoints: number;
		recentContextBacklog: number;
		roomsNeedingAbsorb: number;
		/** cross-room memory composition by layer */
		composition: MemoryComposition;
	};
	rooms: RoomMemorySummary[];
}

/** How developed a room's memory is — a heuristic from size + consolidations. */
export interface RoomMaturity {
	/** 0..3 */
	level: number;
	/** Forming | Practiced | Established | Deep */
	label: string;
	/** durable ÷ (durable + recent): how much memory is consolidated */
	consolidatedPct: number;
}

export interface RoomMemoryDetail extends RoomMemorySummary {
	l1aExists: boolean;
	/** the memory map: composition by area, with measured token weight */
	memoryMap: StructuralReviewMemoryMapRow[];
	/** the Recent Context sessions, newest first — sized in tokens */
	recentSessions: RecentSession[];
	/** the room's memory changelog, newest first, capped */
	history: MemoryHistoryEvent[];
	/** how developed this room's memory is */
	maturity: RoomMaturity;
}

const MATURITY_LABELS = ["Forming", "Practiced", "Established", "Deep"];

function roomMaturity(summary: RoomMemorySummary): RoomMaturity {
	const { deep, recent } = summary.composition;
	// Depth grows with consolidations and deep knowledge; recent-only memory
	// counts less because it hasn't been distilled yet.
	const score = summary.checkpoints + deep / 200;
	const level = score < 2 ? 0 : score < 6 ? 1 : score < 15 ? 2 : 3;
	return {
		level,
		label: MATURITY_LABELS[level],
		consolidatedPct: deep + recent > 0 ? deep / (deep + recent) : 0,
	};
}

// --- disk readers (defensive: a room may have no checkpoints or no L1b yet) ---

function readEventRecords<T extends { approvedAt: string }>(id: string, pickDir: (instance: ReturnType<typeof createPersistentAgentInstance>) => string): T[] {
	let dir: string;
	try {
		dir = pickDir(createPersistentAgentInstance(id));
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return []; // no events of this kind yet
	}
	const records: T[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as T);
		} catch {
			// skip an unreadable/partial record rather than failing the whole room
		}
	}
	// A record with a malformed approvedAt would sort unpredictably and ship an
	// unparseable timestamp to the UI; drop it rather than guess.
	const usable = records.filter((r) => Number.isFinite(Date.parse(r.approvedAt)));
	usable.sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
	return usable;
}

function readCheckpoints(id: string): CheckpointEventRecord[] {
	return readEventRecords<CheckpointEventRecord>(id, (instance) => instance.checkpointEventDir());
}

// --- per-room usage join (read from the same usage.jsonl the dashboard uses) ---

interface UsageRow {
	ts: number;
	agent: string;
	input: number;
	cacheRead: number;
	cost: number;
}

/** Aggregate usage.jsonl per room (agent). Read once per request, defensively. */
function loadPayoffByRoom(): Map<string, RoomPayoff> {
	const file = productAppStatePath("usage.jsonl");
	const acc = new Map<string, { turns: number; cost: number; input: number; cacheRead: number }>();
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return new Map(); // no usage logged yet
	}
	for (const line of text.split("\n")) {
		if (!line) continue;
		let row: UsageRow;
		try {
			row = JSON.parse(line) as UsageRow;
		} catch {
			continue;
		}
		if (!row || typeof row.agent !== "string" || typeof row.ts !== "number") continue;
		let a = acc.get(row.agent);
		if (!a) acc.set(row.agent, (a = { turns: 0, cost: 0, input: 0, cacheRead: 0 }));
		a.turns += 1;
		a.cost += row.cost ?? 0;
		a.input += row.input ?? 0;
		a.cacheRead += row.cacheRead ?? 0;
	}
	const out = new Map<string, RoomPayoff>();
	for (const [room, a] of acc) {
		out.set(room, {
			turns: a.turns,
			totalCost: a.cost,
			costPerTurn: a.turns > 0 ? a.cost / a.turns : 0,
			cacheHitRate: a.cacheRead + a.input > 0 ? a.cacheRead / (a.cacheRead + a.input) : 0,
		});
	}
	return out;
}

interface RoomL1bInfo {
	metrics: ReturnType<typeof structuralReviewMetrics> | null;
	composition: MemoryComposition;
	/** session titles in document order (oldest → newest) */
	sessionTitles: string[];
	/** key phrases (bold) from durable memory */
	knows: string[];
}

/** Structural section names — never useful as "knows about" chips. */
const KNOWS_STRUCTURAL = new Set(["deep memory", "active items", "recent context", "chronos", "memory"]);

/**
 * Pull distinct key phrases from durable memory as "knows about" chips: bold
 * phrases first (the strongest signal), then section headings as a fallback so
 * memories written without bold still get chips.
 */
function extractKnows(durable: string): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	const push = (raw: string) => {
		const phrase = raw.replace(/[\s.,;:]+$/, "").replace(/^[\s.,;:]+/, "").trim();
		const key = phrase.toLowerCase();
		if (phrase.length < 2 || phrase.length > 44 || seen.has(key) || KNOWS_STRUCTURAL.has(key)) return;
		seen.add(key);
		out.push(phrase);
	};
	for (const m of durable.matchAll(/\*\*([^*]+)\*\*/g)) {
		if (out.length >= 10) break;
		push(m[1]);
	}
	if (out.length < 4) {
		for (const m of durable.matchAll(/^#{2,6}\s+(.+?)\s*$/gm)) {
			if (out.length >= 10) break;
			push(m[1]);
		}
	}
	return out;
}

/** Body of one top-level (##) section, or null if absent. */
function topSectionBody(src: string, name: string): string | null {
	const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
	for (let i = 0; i < headings.length; i++) {
		if (headings[i][1].trim().toLowerCase() !== name.toLowerCase()) continue;
		const start = (headings[i].index ?? 0) + headings[i][0].length;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
		return src.slice(start, end);
	}
	return null;
}

/** Read a room's L1b once and derive everything: total, composition, sessions. */
function readRoomL1bInfo(id: string): RoomL1bInfo {
	let l1b: string;
	try {
		l1b = createPersistentAgentInstance(id).readL1b();
	} catch {
		return { metrics: null, composition: { deep: 0, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [] };
	}
	const metrics = structuralReviewMetrics(l1b);
	try {
		const parts = extractStructuralReviewSourceParts(l1b);
		const durable = structuralReviewMetrics(parts.sourceReviewTargetL1b).estimatedTokens;
		const deepBody = topSectionBody(parts.sourceReviewTargetL1b, "Deep Memory");
		const deep = deepBody !== null ? structuralReviewMetrics(deepBody).estimatedTokens : durable;
		return {
			metrics,
			composition: {
				deep,
				active: Math.max(0, durable - deep),
				recent: structuralReviewMetrics(parts.preservedRecentContext).estimatedTokens,
				chronos: structuralReviewMetrics(parts.preservedChronos).estimatedTokens,
			},
			sessionTitles: recentContextSessions(parts.preservedRecentContext).map((s) => s.title),
			knows: extractKnows(parts.sourceReviewTargetL1b),
		};
	} catch {
		// Legacy/malformed topology — everything counts as deep.
		return { metrics, composition: { deep: metrics.estimatedTokens, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [] };
	}
}

/**
 * Split the Recent Context section into its individual sessions. Each entry is
 * a `### RC-#### | STATUS | date | Title` subsection; we surface a human title
 * and the session's current token size (same unit as the memory map).
 */
function recentContextSessions(recentContext: string): Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> {
	const headings = Array.from(recentContext.matchAll(/^###\s+(.+?)\s*$/gm));
	const out: Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> = [];
	for (let i = 0; i < headings.length; i++) {
		const start = headings[i].index ?? 0;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? recentContext.length) : recentContext.length;
		const body = recentContext.slice(start, end);
		// Heading like "RC-0004 | OPEN | 2026-07-07 | Finalized reading list". Prefer
		// the trailing human title; take the date from the entry itself (not a
		// guessed checkpoint), so any "ago" we show is factual.
		const cells = headings[i][1].split("|").map((s) => s.trim()).filter(Boolean);
		const title = cells.length >= 4 ? cells.slice(3).join(" | ") : headings[i][1].trim();
		const id = cells.length > 0 && /^RC-\d+$/i.test(cells[0]) ? cells[0].toUpperCase() : null;
		let ts: number | null = null;
		const dateMatch = headings[i][1].match(/\d{4}-\d{2}-\d{2}/);
		if (dateMatch) {
			const parsed = Date.parse(dateMatch[0]);
			if (Number.isFinite(parsed)) ts = parsed;
		}
		// The provenance join key is the checkpoint_id from the rc_metadata
		// comment the gate wrote into the entry. RC-#### labels are REUSED after
		// a consolidation clears Recent Context, so joining on the label can
		// attach a consolidated record's receipt to an unrelated hand-added
		// entry; checkpoint ids are unique per event. No metadata, no receipt.
		const rawBody = body.slice(headings[i][0].length);
		const meta = rawBody.match(/<!--\s*rc_metadata:([\s\S]*?)-->/);
		const cpMatch = meta ? meta[1].match(/checkpoint_id=([^;\s]+)/) : null;
		const checkpointId = cpMatch ? cpMatch[1] : null;
		// The gate also stamps the exact approval instant into rc_metadata.
		// Prefer it over the heading's day: the heading date parses to UTC
		// midnight, which turns a memory saved this afternoon into "15h ago".
		let tsPrecise = false;
		const approvedMatch = meta ? meta[1].match(/approved_at=([^;\s]+)/) : null;
		if (approvedMatch) {
			const parsed = Date.parse(approvedMatch[1]);
			if (Number.isFinite(parsed)) {
				ts = parsed;
				tsPrecise = true;
			}
		}
		// Strip the rc_metadata identity comment (and any other HTML comment)
		// from the readable text, like cleanAreaBody does for the area reader.
		const content = rawBody.replace(/<!--[\s\S]*?-->/g, "").trim();
		out.push({ id, checkpointId, title, tokens: structuralReviewMetrics(body).estimatedTokens, ts, tsPrecise, content });
	}
	return out;
}

/**
 * The full memory composition — everything the room carries, not just the
 * prune-target. `buildStructuralReviewMemoryMap` covers only Deep Memory +
 * Active Items (that map exists to prune stable memory); it deliberately omits
 * Recent Context (the un-absorbed session summaries — usually the bulk) and
 * Chronos (the timeline). We add those back. Recent Context stays a single
 * summarised row — the per-session detail lives in `recentSessions`.
 */
function buildFullMemoryMap(l1b: string): StructuralReviewMemoryMapRow[] {
	try {
		const parts = extractStructuralReviewSourceParts(l1b);
		// Top-level rows only — parent aggregates already include their subsections,
		// so keeping the "Parent / Child" rows too would double-count.
		const rows = buildStructuralReviewMemoryMap(parts.sourceReviewTargetL1b).filter((r) => !r.area.includes(" / "));
		const rc = structuralReviewMetrics(parts.preservedRecentContext);
		if (rc.estimatedTokens > 0) {
			const n = recentContextSessions(parts.preservedRecentContext).length;
			rows.push({ area: `Recent sessions · ${n} · not yet learned`, words: rc.words, estimatedTokens: rc.estimatedTokens });
		}
		const chronos = structuralReviewMetrics(parts.preservedChronos);
		if (chronos.estimatedTokens > 0) {
			rows.push({ area: "Timeline", words: chronos.words, estimatedTokens: chronos.estimatedTokens });
		}
		return rows;
	} catch {
		// Legacy/malformed topology — fall back to the review-target-only map.
		return structuralReviewMetrics(l1b).memoryMap;
	}
}

/** Read a room's L1b once and return its Recent Context sessions (doc order). */
function readRoomSessions(id: string): Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> {
	try {
		const parts = extractStructuralReviewSourceParts(createPersistentAgentInstance(id).readL1b());
		return recentContextSessions(parts.preservedRecentContext);
	} catch {
		return [];
	}
}

/**
 * Per-layer sizes measured at an event, from the event's stored snapshot.
 * `deep` is the Deep Memory section ONLY (events record per-section metrics);
 * older records without topLevel fall back to the coarser non-recent figure.
 */
function eventLayers(result: CheckpointEventRecord["result"]): { deep: number; recent: number } {
	const tl = result.sections?.topLevel;
	const deepSection = tl?.find((s) => s.title?.trim().toLowerCase() === "deep memory");
	return {
		deep: deepSection ? deepSection.estimatedTokens : (result.sections?.nonRecentContext?.estimatedTokens ?? result.estimatedTokens),
		recent: result.sections?.recentContext?.estimatedTokens ?? 0,
	};
}

function growthPoint(record: CheckpointEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: record.checkpoint.approvedEntry.chars,
		title: record.checkpoint.approvedEntry.title ?? null,
		kind: "checkpoint",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

/** Absorb (consolidation) events — read like checkpoints, for the growth series. */
function readAbsorbs(id: string): AbsorbEventRecord[] {
	let dir: string;
	try {
		dir = createPersistentAgentInstance(id).absorbEventDir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: AbsorbEventRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as AbsorbEventRecord);
		} catch {
			// skip an unreadable record
		}
	}
	return records;
}

function absorbPoint(record: AbsorbEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: 0,
		title: "Learn",
		kind: "absorb",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

function readReviews(id: string): StructuralReviewEventRecord[] {
	let dir: string;
	try {
		dir = createPersistentAgentInstance(id).structuralReviewEventDir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(dir);
	} catch {
		return [];
	}
	const records: StructuralReviewEventRecord[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(dir, file), "utf-8")) as StructuralReviewEventRecord);
		} catch {
			// skip an unreadable record
		}
	}
	return records;
}

function reviewPoint(record: StructuralReviewEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: record.structuralReview?.reviewTargetEstimatedTokenDelta ?? 0,
		title: "Review",
		kind: "review",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

/** Merged growth series: checkpoints + Learn (absorb) + Review (prune), oldest → newest. */
function growthSeries(id: string, checkpoints: CheckpointEventRecord[]): MemoryGrowthPoint[] {
	const points = [...checkpoints.map(growthPoint), ...readAbsorbs(id).map(absorbPoint), ...readReviews(id).map(reviewPoint)];
	// A record with a malformed approvedAt parses to ts 0 — as a chart point it
	// would render a clickable moment at the epoch whose snapshot fetch can
	// only fail (`at <= 0` is rejected), so it stays out of the series.
	return points.filter((p) => p.ts > 0).sort((a, b) => a.ts - b.ts);
}

function summarizeRoom(status: PersistentAgentStatus, payoffByRoom: Map<string, RoomPayoff>): RoomMemorySummary {
	const info = readRoomL1bInfo(status.id);
	const checkpoints = readCheckpoints(status.id);
	const lastCheckpointAt = status.memoryStatus.lastCheckpointAt
		? Date.parse(status.memoryStatus.lastCheckpointAt) || null
		: (checkpoints.length ? growthPoint(checkpoints[checkpoints.length - 1]).ts : null);
	const reviews = readReviews(status.id).map(reviewPoint).sort((a, b) => a.ts - b.ts);
	const lastReview = reviews.length ? reviews[reviews.length - 1] : null;
	return {
		id: status.id,
		displayName: status.displayName?.trim() || status.id,
		description: status.description,
		standbyThread: (status.runtime.state === "standby" || status.runtime.state === "active") && !!status.runtime.activeThreadId,
		// Total = sum of the composition parts, so the bar and the total always
		// reconcile (no separately-rounded whole-file estimate that can drift).
		l1bTokens: info.composition.deep + info.composition.active + info.composition.recent + info.composition.chronos,
		areas: info.metrics?.memoryMap.length ?? status.l1b.sections.length,
		checkpoints: checkpoints.length,
		lastCheckpointAt,
		recentContextBacklog: status.memoryStatus.recentContextCount,
		needsAbsorb: status.status === "needs_absorb",
		series: growthSeries(status.id, checkpoints),
		lastReviewAt: lastReview ? lastReview.ts : null,
		lastReviewTokenDelta: lastReview ? lastReview.added : 0,
		sessions: info.sessionTitles.length,
		sessionsCap: status.memoryStatus.recentContextHardCap || 10,
		topics: info.sessionTitles.slice(-4).reverse(),
		knows: info.knows.filter((k) => {
			const kl = k.toLowerCase();
			return kl !== (status.displayName ?? "").toLowerCase() && kl !== status.id.toLowerCase();
		}).slice(0, 6),
		composition: info.composition,
		payoff: payoffByRoom.get(status.id) ?? null,
	};
}

// --- public builders (called by the routes) ---

export function buildMemoryOverview(): MemoryOverview {
	// listPersistentAgents() returns active (non-archived) rooms only.
	const payoffByRoom = loadPayoffByRoom();
	const rooms = listPersistentAgents().map((status) => summarizeRoom(status, payoffByRoom));
	// Heaviest memory first — that's where the signal is.
	rooms.sort((a, b) => b.l1bTokens - a.l1bTokens);
	return {
		generatedAt: Date.now(),
		totals: {
			rooms: rooms.length,
			l1bTokens: rooms.reduce((sum, r) => sum + r.l1bTokens, 0),
			checkpoints: rooms.reduce((sum, r) => sum + r.checkpoints, 0),
			recentContextBacklog: rooms.reduce((sum, r) => sum + r.recentContextBacklog, 0),
			roomsNeedingAbsorb: rooms.filter((r) => r.needsAbsorb).length,
			composition: {
				deep: rooms.reduce((sum, r) => sum + r.composition.deep, 0),
				active: rooms.reduce((sum, r) => sum + r.composition.active, 0),
				recent: rooms.reduce((sum, r) => sum + r.composition.recent, 0),
				chronos: rooms.reduce((sum, r) => sum + r.composition.chronos, 0),
			},
		},
		rooms,
	};
}

// --- local memory search: grep the durable memory, no model involved --------

export interface MemorySearchHit {
	roomId: string;
	room: string;
	/** nearest markdown heading above the match — the memory area */
	area: string;
	snippet: string;
}

/** Case-insensitive substring search over each room's L1b, section-aware. */
export function searchMemory(query: string, roomId?: string, limit = 25): MemorySearchHit[] {
	const q = query.trim().toLowerCase();
	if (!q) return [];
	const hits: MemorySearchHit[] = [];
	const rooms = listPersistentAgents().filter((s) => !roomId || s.id === roomId);
	for (const status of rooms) {
		let l1b: string;
		try {
			l1b = createPersistentAgentInstance(status.id).readL1b();
		} catch {
			continue; // no L1b to search
		}
		const room = status.displayName?.trim() || status.id;
		let area = "Start of memory";
		for (const rawLine of l1b.split("\n")) {
			const line = rawLine.trim();
			if (!line) continue;
			// Skip document metadata (schema comments etc.) — internals, not memory.
			if (line.startsWith("<!--")) continue;
			const heading = line.match(/^#{1,6}\s*(.+)$/);
			if (heading) {
				area = heading[1].trim();
				continue;
			}
			if (line.toLowerCase().includes(q)) {
				hits.push({ roomId: status.id, room, area, snippet: line.length > 240 ? line.slice(0, 240) + "…" : line });
				if (hits.length >= limit) return hits;
			}
		}
	}
	return hits;
}

// --- hivemind retrieval: assemble cross-room memory context for a question ---

const ASK_BUDGET_TOKENS = 12000;

const ASK_STOPWORDS = new Set(
	"the a an and or but of to in on for with is are was were be been being what which who whom whose how why when where do does did my your our their its about across into from at by as this that these those i you we they it me us them can could should would will".split(" "),
);

/** Content words from a question — used to rank rooms when memory exceeds budget. */
function queryTerms(question: string): string[] {
	return [...new Set((question.toLowerCase().match(/[a-z0-9]{3,}/g) ?? []))].filter((t) => !ASK_STOPWORDS.has(t));
}

/** Keep a room label safe as a prompt delimiter (no newlines / heading marks). */
function safeRoomLabel(name: string): string {
	return name.replace(/[\r\n#]+/g, " ").replace(/\s+/g, " ").trim() || "room";
}

export interface MemoryAskContext {
	context: string;
	/** room display names in scope for this answer */
	sources: string[];
}

/**
 * Gather memory across ALL rooms to answer a question (the "hivemind").
 * Hybrid: if every room's memory fits the budget, include it all (best
 * synthesis). Otherwise rank rooms by how well they match the question's
 * content words and include the most relevant, truncating to fit. Always
 * returns non-empty context when any memory exists. Read-only.
 */
export function buildMemoryAskContext(question: string, budgetTokens = ASK_BUDGET_TOKENS, roomIds?: string[]): MemoryAskContext {
	const scope = roomIds && roomIds.length ? new Set(roomIds) : null;
	const blocks: Array<{ room: string; text: string; tokens: number }> = [];
	for (const status of listPersistentAgents()) {
		if (scope && !scope.has(status.id)) continue;
		let text = "";
		try {
			const parts = extractStructuralReviewSourceParts(createPersistentAgentInstance(status.id).readL1b());
			text = `## Durable memory\n\n${parts.sourceReviewTargetL1b.trim()}\n\n## Recent sessions\n\n${parts.preservedRecentContext.trim()}`;
		} catch {
			try { text = createPersistentAgentInstance(status.id).readL1b(); } catch { continue; }
		}
		if (!text.trim()) continue;
		blocks.push({ room: safeRoomLabel(status.displayName?.trim() || status.id), text, tokens: structuralReviewMetrics(text).estimatedTokens });
	}
	if (blocks.length === 0) return { context: "", sources: [] };

	const render = (chosen: Array<{ room: string; text: string }>) => chosen.map((b) => `# Exxpert: ${b.room}\n\n${b.text}`).join("\n\n---\n\n");

	const total = blocks.reduce((sum, b) => sum + b.tokens, 0);
	if (total <= budgetTokens) {
		return { context: render(blocks), sources: blocks.map((b) => b.room) };
	}

	// Over budget — rank rooms by term-frequency match to the question.
	const terms = queryTerms(question);
	const scored = blocks
		.map((b) => {
			const lc = b.text.toLowerCase();
			const score = terms.reduce((s, t) => s + (lc.split(t).length - 1), 0);
			return { ...b, score };
		})
		.sort((a, z) => z.score - a.score || z.tokens - a.tokens);

	const picked: Array<{ room: string; text: string }> = [];
	let used = 0;
	for (const b of scored) {
		if (b.score === 0 && picked.length > 0) break; // once we have relevant rooms, don't pad with irrelevant ones
		const remaining = budgetTokens - used;
		if (remaining <= 250) break;
		if (b.tokens <= remaining) {
			picked.push({ room: b.room, text: b.text });
			used += b.tokens;
		} else {
			// truncate this room to fit the remaining budget rather than skip it
			picked.push({ room: b.room, text: b.text.slice(0, remaining * 4) + "\n\n…(truncated)" });
			used = budgetTokens;
			break;
		}
	}
	// Guarantee non-empty: if nothing scored/fit, include the largest room truncated.
	if (picked.length === 0) {
		const big = [...blocks].sort((a, z) => z.tokens - a.tokens)[0];
		picked.push({ room: big.room, text: big.text.slice(0, budgetTokens * 4) + "\n\n…(truncated)" });
	}
	return { context: render(picked), sources: picked.map((b) => b.room) };
}

// --- catch-up digest: what each room learned since a given timestamp --------

export interface DigestRoomChange {
	id: string;
	displayName: string;
	newCheckpoints: number;
	newReviews: number;
	addedChars: number;
	/** best-available human title of the most recent thing learned (or null) */
	title: string | null;
	/** the checkpoints since `since`, newest first — what was folded into memory */
	learned: MemoryGrowthPoint[];
}

export interface MemoryDigest {
	since: number;
	generatedAt: number;
	totals: { newCheckpoints: number; newReviews: number; roomsChanged: number; addedChars: number; topRoom: string | null };
	rooms: DigestRoomChange[];
}

export function buildMemoryDigest(sinceMs: number): MemoryDigest {
	const changes: DigestRoomChange[] = [];
	for (const status of listPersistentAgents()) {
		const points = readCheckpoints(status.id).map(growthPoint).filter((p) => p.ts >= sinceMs);
		const reviewsSince = readReviews(status.id).map(reviewPoint).filter((p) => p.ts >= sinceMs);
		if (points.length === 0 && reviewsSince.length === 0) continue;
		points.sort((a, b) => b.ts - a.ts); // newest first
		// Prefer the newest recent-context session title (a real, human label)
		// over the checkpoint's approvedEntry.title, which is often absent.
		const sessions = readRoomSessions(status.id);
		const title = (sessions.length ? sessions[sessions.length - 1].title : null) || points[0]?.title || null;
		changes.push({
			id: status.id,
			displayName: status.displayName?.trim() || status.id,
			newCheckpoints: points.length,
			newReviews: reviewsSince.length,
			addedChars: points.reduce((sum, p) => sum + p.added, 0),
			title,
			learned: points,
		});
	}
	// Biggest mover first.
	changes.sort((a, b) => b.addedChars - a.addedChars);
	return {
		since: sinceMs,
		generatedAt: Date.now(),
		totals: {
			newCheckpoints: changes.reduce((sum, c) => sum + c.newCheckpoints, 0),
			newReviews: changes.reduce((sum, c) => sum + c.newReviews, 0),
			roomsChanged: changes.length,
			addedChars: changes.reduce((sum, c) => sum + c.addedChars, 0),
			topRoom: changes[0]?.displayName ?? null,
		},
		rooms: changes,
	};
}

// --- read one memory area's content (for the click-to-read memory map) ------

export interface MemoryAreaContent {
	area: string;
	/** the section's body markdown, without its heading or schema comments */
	content: string;
}

/** Strip schema/HTML comments and a single leading heading line. */
function cleanAreaBody(text: string): string {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^\s*#{1,6}\s+.+$/m, "")
		.trim();
}

/**
 * Return the raw text of one memory area so the user can READ their memory,
 * not just measure it. Read-only. Areas match the memory map's top-level rows:
 * review-target sections (Deep Memory, Active Items, …) plus "Timeline".
 */
export function readMemoryArea(id: string, areaName: string): MemoryAreaContent | null {
	let l1b: string;
	try {
		l1b = createPersistentAgentInstance(id).readL1b();
	} catch {
		return null;
	}
	let parts: ReturnType<typeof extractStructuralReviewSourceParts>;
	try {
		parts = extractStructuralReviewSourceParts(l1b);
	} catch {
		return null;
	}
	if (areaName.trim().toLowerCase() === "timeline") {
		return { area: "Timeline", content: cleanAreaBody(parts.preservedChronos) };
	}
	// Split the review target into its top-level (##) sections and match by name.
	const src = parts.sourceReviewTargetL1b;
	const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
	for (let i = 0; i < headings.length; i++) {
		const name = headings[i][1].trim();
		if (name.toLowerCase() !== areaName.trim().toLowerCase()) continue;
		const start = (headings[i].index ?? 0) + headings[i][0].length;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
		return { area: name, content: cleanAreaBody(src.slice(start, end)) };
	}
	return null;
}

// --- read a memory's source conversation (for the provenance receipt) -------

/**
 * A stored conversation item, sanitized for the wire. Thread files carry the
 * app's own display items (kind user | assistant | tool | system, plus a few
 * composite kinds we fold into system text); tool args/results can be large,
 * so both are capped with an explicit truncation flag.
 */
export interface TranscriptWireItem {
	kind: "user" | "assistant" | "tool" | "system";
	text?: string;
	/** tool only */
	name?: string;
	status?: string;
	args?: string;
	result?: string;
	/** some field on this item was cut to fit the wire caps */
	truncated?: boolean;
}

export interface ConversationTranscript {
	stored: true;
	checkpointId: string;
	threadId: string;
	/** when the checkpoint closed this conversation (epoch ms), if recorded */
	closedAt: number | null;
	items: TranscriptWireItem[];
	/** renderable items in the stored thread; > items.length only when capped */
	itemsTotal: number;
}

export type ConversationTranscriptResult = ConversationTranscript | {
	stored: false;
	/** no-record: unknown checkpoint id; no-thread: the conversation file is gone */
	reason: "no-record" | "no-thread";
};

const TRANSCRIPT_TEXT_CAP = 20_000;
const TRANSCRIPT_ARGS_CAP = 2_000;
const TRANSCRIPT_RESULT_CAP = 6_000;
const TRANSCRIPT_ITEMS_CAP = 400;

function capped(text: string, cap: number): { text: string; truncated: boolean } {
	return text.length > cap ? { text: text.slice(0, cap) + "\n…", truncated: true } : { text, truncated: false };
}

/** One stored thread item → wire item, or null for empty/unknown items. */
function transcriptWireItem(raw: any): TranscriptWireItem | null {
	if (!raw || typeof raw !== "object") return null;
	const kind = String(raw.kind ?? "");
	if (kind === "user" || kind === "assistant" || kind === "system") {
		const body = capped(String(raw.text ?? "").trim(), TRANSCRIPT_TEXT_CAP);
		if (!body.text) return null;
		return { kind, text: body.text, ...(body.truncated ? { truncated: true } : {}) };
	}
	if (kind === "tool") {
		const item: TranscriptWireItem = {
			kind: "tool",
			name: String(raw.name ?? "tool").slice(0, 200) || "tool",
			status: String(raw.status ?? "").slice(0, 80),
		};
		let truncated = false;
		if (raw.args !== undefined) {
			let argsText: string;
			try { argsText = JSON.stringify(raw.args, null, 2) ?? ""; } catch { argsText = String(raw.args); }
			const c = capped(argsText, TRANSCRIPT_ARGS_CAP);
			item.args = c.text;
			truncated = truncated || c.truncated;
		}
		if (raw.result !== undefined) {
			let resultText: string;
			if (typeof raw.result === "string") resultText = raw.result;
			else { try { resultText = JSON.stringify(raw.result, null, 2) ?? ""; } catch { resultText = String(raw.result); } }
			const c = capped(resultText, TRANSCRIPT_RESULT_CAP);
			item.result = c.text;
			truncated = truncated || c.truncated;
		}
		if (truncated) item.truncated = true;
		return item;
	}
	// Composite display kinds fold into readable system text — the transcript
	// stays honest ("a consult happened, here is what was asked and answered")
	// without the UI needing to know every display-cache shape.
	if (kind === "consult") {
		const room = String(raw.targetDisplayName ?? raw.targetRoomId ?? "another exxpert").trim();
		const exchanges: any[] = Array.isArray(raw.exchanges) && raw.exchanges.length
			? raw.exchanges
			: [{ question: raw.question, answer: raw.answer }];
		const parts = exchanges.map((x) => `**Asked:** ${String(x?.question ?? "").trim()}\n\n${String(x?.answer ?? "").trim()}`);
		const body = capped(`Consulted **${room}**\n\n${parts.join("\n\n")}`.trim(), TRANSCRIPT_TEXT_CAP);
		return { kind: "system", text: body.text, ...(body.truncated ? { truncated: true } : {}) };
	}
	if (kind === "approval") {
		const title = String(raw.title ?? "").trim() || "Approval";
		const message = String(raw.message ?? "").trim();
		const body = capped(`${title}${message ? `: ${message}` : ""}${raw.done ? " (resolved)" : ""}`, TRANSCRIPT_TEXT_CAP);
		return { kind: "system", text: body.text, ...(body.truncated ? { truncated: true } : {}) };
	}
	if (kind === "task") {
		const title = String(raw.title ?? "").trim() || "Specialist task";
		const summary = String(raw.summary ?? "").trim();
		const body = capped(`Specialist task: **${title}**${summary ? `\n\n${summary}` : ""}`, TRANSCRIPT_TEXT_CAP);
		return { kind: "system", text: body.text, ...(body.truncated ? { truncated: true } : {}) };
	}
	return null; // a future display kind — skipped, counted in itemsTotal
}

/**
 * The conversation a checkpoint receipt points at, read from the room's own
 * closed-thread file (write-once after the boundary). The chain is exactly
 * what the records prove: checkpoint id → event record →
 * runtimeBoundary.closedThreadId → runtime/threads/<id>.json. Read-only; a
 * missing link returns stored:false rather than a guess.
 */
export function readConversationTranscript(id: string, checkpointIdRaw: string): ConversationTranscriptResult | null {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return null;
	}
	let record: CheckpointEventRecord;
	try {
		// The path helper validates the id (rejects separators/traversal).
		record = JSON.parse(fs.readFileSync(instance.checkpointEventRecordPath(checkpointIdRaw), "utf-8")) as CheckpointEventRecord;
	} catch {
		return { stored: false, reason: "no-record" };
	}
	const threadId = record.runtimeBoundary?.closedThreadId;
	if (!threadId) return { stored: false, reason: "no-thread" };
	let thread: { items?: unknown[]; closedAt?: number };
	try {
		thread = JSON.parse(fs.readFileSync(instance.runtimeThreadPath(threadId), "utf-8"));
	} catch {
		return { stored: false, reason: "no-thread" };
	}
	const rawItems = Array.isArray(thread.items) ? thread.items : [];
	const items: TranscriptWireItem[] = [];
	// itemsTotal counts the RENDERABLE items in the stored thread, so
	// itemsTotal > items.length means exactly one thing: the cap cut the tail
	// (the UI's truncation note must never fire for merely-skipped internals).
	let renderable = 0;
	for (const raw of rawItems) {
		const item = transcriptWireItem(raw);
		if (!item) continue;
		renderable++;
		if (items.length < TRANSCRIPT_ITEMS_CAP) items.push(item);
	}
	return {
		stored: true,
		checkpointId: record.checkpointId,
		threadId,
		closedAt: typeof thread.closedAt === "number" ? thread.closedAt : (record.runtimeBoundary?.closedAt ?? null),
		items,
		itemsTotal: renderable,
	};
}

// --- what a Learn/Review changed: before/after from the archive chain -------

/**
 * Every gate event archives the L1b it replaced (paths.archivedL1bRelPath), so
 * the archives form a chain of recorded states: the state AFTER event N is the
 * archive of the next event, or today's document when N is the latest. Nothing
 * is reconstructed — only recorded snapshots are served.
 */
interface ArchiveChainLink {
	ts: number;
	archivedRelPath: string;
}

/** An event record's archived-snapshot rel path, tolerating older records. */
function archivedRelPathOf(instance: ReturnType<typeof createPersistentAgentInstance>, record: { paths?: { archivedL1bRelPath?: string }; archivedL1bPath?: string }): string | null {
	if (record.paths?.archivedL1bRelPath) return record.paths.archivedL1bRelPath;
	// Deprecated absolute-path field on older records — usable only when it
	// still resolves inside the room's root.
	if (record.archivedL1bPath) {
		try {
			return instance.rootRelativePath(record.archivedL1bPath);
		} catch {
			return null;
		}
	}
	return null;
}

/** All archived snapshots across the three event kinds, oldest first, existing files only. */
function archiveChain(id: string): ArchiveChainLink[] {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return [];
	}
	const links: ArchiveChainLink[] = [];
	const push = (record: { approvedAt: string; paths?: { archivedL1bRelPath?: string }; archivedL1bPath?: string }) => {
		const ts = Date.parse(record.approvedAt);
		if (!Number.isFinite(ts)) return; // NaN would perturb the sort
		const rel = archivedRelPathOf(instance, record);
		if (!rel) return;
		try {
			if (fs.existsSync(instance.resolveRootRelativePath(rel))) links.push({ ts, archivedRelPath: rel });
		} catch {
			// unresolvable path — skip the link rather than fail the chain
		}
	};
	for (const record of readCheckpoints(id)) push(record);
	for (const record of readEventRecords<AbsorbEventRecord>(id, (i) => i.absorbEventDir())) push(record);
	for (const record of readEventRecords<StructuralReviewEventRecord>(id, (i) => i.structuralReviewEventDir())) push(record);
	links.sort((a, b) => a.ts - b.ts);
	return links;
}

/** Strip schema/HTML comments (rc_metadata etc.) from a snapshot for reading/diffing. */
function stripDocComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

/** One memory section's before/after texts for the change view. */
export interface MemoryEventSectionDiff {
	section: string;
	/** the section's text before the event, comments stripped ("" if absent) */
	beforeText: string;
	/** the section's text in the next recorded state ("" if absent) */
	afterText: string;
	beforeTokens: number;
	afterTokens: number;
}

export interface MemoryEventDiff {
	kind: "learn" | "review";
	eventId: string;
	approvedAt: string;
	/**
	 * The changed sections only, document order, each carrying its full
	 * before/after text. Splitting happens BEFORE diffing, so a change can
	 * never be attributed to the wrong section.
	 */
	sections: MemoryEventSectionDiff[];
	/** where the after side came from: the next event's archive, or today's document */
	afterBasis: "next-archive" | "current";
	/**
	 * The after side hashes to the fingerprint this record stored at write
	 * time — the diff shows exactly what this event changed. False means the
	 * memory also changed outside the gate before the next recorded state;
	 * null when the record carries no fingerprint to check against.
	 */
	afterVerified: boolean | null;
}

/**
 * A document's sections for the change view: the review-target's top-level
 * sections plus Recent sessions and Timeline, named like the memory map.
 */
function diffSectionsOf(raw: string): Array<{ name: string; text: string }> {
	try {
		const parts = extractStructuralReviewSourceParts(raw);
		const out: Array<{ name: string; text: string }> = [];
		const src = parts.sourceReviewTargetL1b;
		const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
		for (let i = 0; i < headings.length; i++) {
			const start = (headings[i].index ?? 0) + headings[i][0].length;
			const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
			out.push({ name: headings[i][1].trim(), text: stripDocComments(src.slice(start, end)) });
		}
		out.push({ name: "Recent sessions", text: stripDocComments(parts.preservedRecentContext).replace(/^\s*#{1,6}\s+.+$/m, "").trim() });
		out.push({ name: "Timeline", text: cleanAreaBody(parts.preservedChronos) });
		return out;
	} catch {
		// Legacy/malformed topology — one honest whole-document section.
		return [{ name: "Memory", text: stripDocComments(raw) }];
	}
}

/**
 * What a Learn or Review actually changed: the event's own archived snapshot
 * against the next recorded state. Read-only; null when the event or its
 * archive is gone (the UI only offers the diff for `diffable` events).
 */
export function readMemoryEventDiff(id: string, kind: "learn" | "review", eventIdRaw: string): MemoryEventDiff | null {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return null;
	}
	let record: AbsorbEventRecord | StructuralReviewEventRecord;
	try {
		// The path helpers validate the event id (rejects separators/traversal).
		const file = kind === "learn" ? instance.absorbEventRecordPath(eventIdRaw) : instance.structuralReviewEventRecordPath(eventIdRaw);
		record = JSON.parse(fs.readFileSync(file, "utf-8"));
	} catch {
		return null;
	}
	const ts = Date.parse(record.approvedAt);
	if (!Number.isFinite(ts)) return null;
	const beforeRel = archivedRelPathOf(instance, record);
	if (!beforeRel) return null;
	let beforeRaw: string;
	try {
		beforeRaw = fs.readFileSync(instance.resolveRootRelativePath(beforeRel), "utf-8");
	} catch {
		return null;
	}
	// The state after this event is the next recorded snapshot: the earliest
	// strictly-later archive, or today's document when this is the latest event.
	const next = archiveChain(id).find((link) => link.ts > ts);
	let afterRaw: string | null = null;
	let afterBasis: MemoryEventDiff["afterBasis"] = "current";
	if (next) {
		try {
			afterRaw = fs.readFileSync(instance.resolveRootRelativePath(next.archivedRelPath), "utf-8");
			afterBasis = "next-archive";
		} catch {
			afterRaw = null;
		}
	}
	if (afterRaw === null) {
		try {
			afterRaw = instance.readL1b();
			afterBasis = "current";
		} catch {
			return null;
		}
	}
	const storedFingerprint = record.result?.l1bFingerprint?.value;
	const afterVerified = storedFingerprint ? fingerprintL1bSource(afterRaw).value === storedFingerprint : null;
	// Split first, diff per section: pair the two sides by section name (after
	// side's order wins, before-only sections appended) and keep only the
	// sections whose text actually differs.
	const beforeSections = diffSectionsOf(beforeRaw);
	const afterSections = diffSectionsOf(afterRaw);
	const beforeByName = new Map(beforeSections.map((s) => [s.name, s.text]));
	const afterByName = new Map(afterSections.map((s) => [s.name, s.text]));
	const names = [...afterSections.map((s) => s.name), ...beforeSections.filter((s) => !afterByName.has(s.name)).map((s) => s.name)];
	const sections: MemoryEventSectionDiff[] = [];
	for (const name of names) {
		const beforeText = beforeByName.get(name) ?? "";
		const afterText = afterByName.get(name) ?? "";
		if (beforeText === afterText) continue;
		sections.push({
			section: name,
			beforeText,
			afterText,
			beforeTokens: structuralReviewMetrics(beforeText).estimatedTokens,
			afterTokens: structuralReviewMetrics(afterText).estimatedTokens,
		});
	}
	return {
		kind,
		eventId: kind === "learn" ? (record as AbsorbEventRecord).absorbId : (record as StructuralReviewEventRecord).structuralReviewId,
		approvedAt: record.approvedAt,
		sections,
		afterBasis,
		afterVerified,
	};
}

// --- time travel: the memory as it was at a past moment ---------------------

export interface MemorySnapshot {
	/** the requested moment (epoch ms) */
	at: number;
	/**
	 * archive: the state recorded just before the first event after `at` —
	 * exactly what the memory held at that moment. current: `at` is after the
	 * last recorded event, so this is today's document.
	 */
	basis: "archive" | "current";
	/** the boundary event's approval time (epoch ms) for archive snapshots */
	boundaryTs: number | null;
	/** the full snapshot text, comments stripped (the "Read all" document) */
	content: string;
	estimatedTokens: number;
	/** the memory map of that moment — same rows and measuring as the live map */
	memoryMap: StructuralReviewMemoryMapRow[];
	/** readable body per map area of that moment, keyed by area name */
	areas: Record<string, string>;
	/** the Recent Context sessions of that moment, newest first, with receipts */
	recentSessions: RecentSession[];
	/** token split by layer at that moment */
	composition: MemoryComposition;
}

/**
 * Everything the detail view shows about a memory document, derived from one
 * snapshot text with the exact same code paths as the live view — so a past
 * state renders like today's, and the map can never disagree with the content.
 */
function deriveSnapshotView(id: string, raw: string): Pick<MemorySnapshot, "content" | "estimatedTokens" | "memoryMap" | "areas" | "recentSessions" | "composition"> {
	const areas: Record<string, string> = {};
	let recentSessions: RecentSession[] = [];
	let composition: MemoryComposition;
	try {
		const parts = extractStructuralReviewSourceParts(raw);
		const src = parts.sourceReviewTargetL1b;
		const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
		for (let i = 0; i < headings.length; i++) {
			const start = (headings[i].index ?? 0) + headings[i][0].length;
			const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
			areas[headings[i][1].trim()] = cleanAreaBody(src.slice(start, end));
		}
		areas["Timeline"] = cleanAreaBody(parts.preservedChronos);
		recentSessions = sessionsWithReceipts(id, recentContextSessions(parts.preservedRecentContext));
		const durable = structuralReviewMetrics(src).estimatedTokens;
		const deepBody = topSectionBody(src, "Deep Memory");
		const deep = deepBody !== null ? structuralReviewMetrics(deepBody).estimatedTokens : durable;
		composition = {
			deep,
			active: Math.max(0, durable - deep),
			recent: structuralReviewMetrics(parts.preservedRecentContext).estimatedTokens,
			chronos: structuralReviewMetrics(parts.preservedChronos).estimatedTokens,
		};
	} catch {
		// Legacy/malformed topology — everything counts as deep, no session split.
		composition = { deep: structuralReviewMetrics(raw).estimatedTokens, active: 0, recent: 0, chronos: 0 };
	}
	return {
		content: stripDocComments(raw),
		estimatedTokens: structuralReviewMetrics(raw).estimatedTokens,
		memoryMap: buildFullMemoryMap(raw),
		areas,
		recentSessions,
		composition,
	};
}

/**
 * The room's memory as it was at `at`, from the archive chain: every gate
 * event stored the document it replaced, so the state at any past moment is
 * the archive of the first event after that moment (or today's document when
 * no later event exists). Recorded snapshots only — nothing reconstructed.
 */
export function readMemorySnapshotAt(id: string, at: number): MemorySnapshot | null {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return null;
	}
	const next = archiveChain(id).find((link) => link.ts > at);
	if (next) {
		let raw: string;
		try {
			raw = fs.readFileSync(instance.resolveRootRelativePath(next.archivedRelPath), "utf-8");
		} catch {
			return null;
		}
		return { at, basis: "archive", boundaryTs: next.ts, ...deriveSnapshotView(id, raw) };
	}
	let raw: string;
	try {
		raw = instance.readL1b();
	} catch {
		return null;
	}
	return { at, basis: "current", boundaryTs: null, ...deriveSnapshotView(id, raw) };
}

/**
 * Provenance join for a set of Recent Context sessions: a gated entry names
 * its admitting event in the rc_metadata comment (checkpoint_id, unique per
 * event). RC-#### labels are reused after consolidations, so they are display
 * only, never a join key; an entry without the metadata (hand-edited files)
 * honestly gets no receipt, even if it reuses a consolidated entry's label.
 * The receipt offers "open the conversation" only while the closed-thread
 * file the record names is actually on disk. Returns newest first.
 */
function sessionsWithReceipts(id: string, sessions: Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }>): RecentSession[] {
	const receiptByCheckpoint = new Map<string, { approvedAt: string; conversation: boolean }>();
	for (const record of readCheckpoints(id)) {
		if (!record.checkpointId) continue;
		let conversation = false;
		const threadId = record.runtimeBoundary?.closedThreadId;
		if (threadId) {
			try {
				conversation = fs.existsSync(createPersistentAgentInstance(id).runtimeThreadPath(threadId));
			} catch {
				conversation = false;
			}
		}
		receiptByCheckpoint.set(record.checkpointId, { approvedAt: record.approvedAt, conversation });
	}
	return [...sessions]
		.reverse()
		.map((s) => {
			const receipt = s.checkpointId ? receiptByCheckpoint.get(s.checkpointId) : undefined;
			// An entry whose rc_metadata carries no approval instant can still
			// borrow the receipt's: the checkpoint record's approvedAt is the
			// same fact, recorded by the same gate.
			let ts = s.ts;
			let tsPrecise = s.tsPrecise;
			if (!tsPrecise && receipt) {
				const parsed = Date.parse(receipt.approvedAt);
				if (Number.isFinite(parsed)) {
					ts = parsed;
					tsPrecise = true;
				}
			}
			return { title: s.title, tokens: s.tokens, ts, tsPrecise, approvedAt: receipt?.approvedAt ?? null, content: s.content, checkpointId: s.checkpointId, conversation: receipt?.conversation ?? false };
		});
}

/** History entries returned per room — plenty for the timeline, bounded for the wire. */
const MEMORY_HISTORY_CAP = 40;

/**
 * The room's memory changelog, composed from the immutable event records. Every
 * entry is a change the user approved (or auto-applied under their setting);
 * newest first, capped.
 */
function buildMemoryHistory(id: string): MemoryHistoryEvent[] {
	const events: MemoryHistoryEvent[] = [];
	// Records carry no entry title today (approvedEntry.title is forward-compat,
	// never written); while the RC entry is still in the L1b, its heading
	// supplies one. The join is the entry's checkpoint_id from its rc_metadata
	// comment, unique per event, so a title can only come from the exact entry
	// this record admitted (false provenance is worse than none).
	const titleByCheckpoint = new Map<string, string>();
	for (const s of readRoomSessions(id)) if (s.checkpointId) titleByCheckpoint.set(s.checkpointId, s.title);
	// "What changed" is offered only while the event's archived snapshot is
	// still on disk — never a control the server can't honour.
	const diffable = (record: { paths?: { archivedL1bRelPath?: string }; archivedL1bPath?: string }): boolean => {
		try {
			const instance = createPersistentAgentInstance(id);
			const rel = archivedRelPathOf(instance, record);
			return rel ? fs.existsSync(instance.resolveRootRelativePath(rel)) : false;
		} catch {
			return false;
		}
	};
	for (const record of readCheckpoints(id)) {
		const fallback = record.checkpointId ? titleByCheckpoint.get(record.checkpointId) : undefined;
		events.push({ ts: Date.parse(record.approvedAt), kind: "checkpoint", id: record.checkpointId ?? null, title: record.checkpoint?.approvedEntry?.title ?? fallback ?? null });
	}
	for (const record of readEventRecords<AbsorbEventRecord>(id, (instance) => instance.absorbEventDir())) {
		const absorb = record.absorb;
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: "learn",
			id: record.absorbId ?? null,
			diffable: Boolean(record.absorbId) && diffable(record),
			sessions: absorb ? Math.max(0, absorb.recentContextEntryCountBefore - absorb.recentContextEntryCountAfter) : null,
			deepTokensBefore: absorb?.stableMemoryEstimatedTokensBefore ?? null,
			deepTokensAfter: absorb?.stableMemoryEstimatedTokensAfter ?? null,
		});
	}
	for (const record of readEventRecords<StructuralReviewEventRecord>(id, (instance) => instance.structuralReviewEventDir())) {
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: "review",
			id: record.structuralReviewId ?? null,
			diffable: Boolean(record.structuralReviewId) && diffable(record),
			tokenDelta: record.structuralReview?.reviewTargetEstimatedTokenDelta ?? null,
		});
	}
	return events.filter((e) => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts).slice(0, MEMORY_HISTORY_CAP);
}

export function buildRoomMemory(status: PersistentAgentStatus): RoomMemoryDetail {
	const summary = summarizeRoom(status, loadPayoffByRoom());
	let memoryMap: StructuralReviewMemoryMapRow[] = [];
	try {
		memoryMap = buildFullMemoryMap(createPersistentAgentInstance(status.id).readL1b());
	} catch {
		memoryMap = []; // no L1b to map
	}
	// Newest first, each carrying its own recorded date (or null) — no guessed
	// checkpoint pairing, so any time shown belongs to that session.
	const recentSessions = sessionsWithReceipts(status.id, readRoomSessions(status.id));
	return {
		...summary,
		l1aExists: status.l1a.exists,
		memoryMap,
		recentSessions,
		history: buildMemoryHistory(status.id),
		maturity: roomMaturity(summary),
	};
}
