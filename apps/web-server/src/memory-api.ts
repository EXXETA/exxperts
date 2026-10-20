/**
 * Room-memory telemetry: reads and aggregates what L1b/current.md, the event records and the usage log already
 * hold. It never writes the memory file; the one write is settleMemoryBudget's one-time budget setting.
 */

import fs from "node:fs";
import path from "node:path";
import {
	createPersistentAgentInstance,
	fingerprintL1bSource,
	listPersistentAgents,
	reviewTargetEstimatedTokensFromL1b,
	type AbsorbEventRecord,
	type CheckpointEventRecord,
	type ReviewEventRecord,
	type StructuralReviewEventRecord,
	type PersistentAgentStatus,
} from "./persistent-agents.js";
import { buildMemoryMap, extractMemorySourceParts, memoryMetrics, type MemoryMapRow } from "./memory-shape.js";
import { ARCHIVE_REASONS, archiveIndex, isMigratedMemoryDocument, MEMORY_ACTIVE_ITEMS_TOPIC, MEMORY_GENERAL_TOPIC, MEMORY_SECTIONS, migrateMemoryDocument, parseMemoryDocument, renderMemoryContext, renderMemoryDocument, type ArchiveIndex, type ArchiveReason, type MemoryDocument, type MemoryEntry, type MemoryTopic } from "./memory-entries.js";
import { readPersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { readArchive, settleMemoryBudget, type MemoryEditEventRecord } from "./memory-entries-store.js";
import { productAppStatePath } from "../../../pi-package/product-state-paths.js";

export interface MemoryGrowthPoint {
	/** epoch ms of the event that produced this L1b state */
	ts: number;
	/** measured L1b size after the event (estimated tokens) */
	tokens: number;
	/** checkpoint: the chars the session added; review: the token delta; 0 for a Memorize */
	added: number;
	title: string | null;
	kind: "checkpoint" | "absorb" | "review";
	/** Deep Memory and Active Items tokens at this event, from its snapshot */
	consolidated: number;
	/** recent-context (pending) tokens at this event */
	recent: number;
}

/** Payoff signals from usage.jsonl, measured, no causal claim: memory is a stable prompt block, so most of it comes back as cache reads. */
export interface RoomPayoff {
	turns: number;
	totalCost: number;
	costPerTurn: number;
	/** cacheRead / (cacheRead + input) over this room's turns; it covers the whole stable prompt, not the memory block alone. */
	cacheHitRate: number;
}

export interface RoomMemorySummary {
	id: string;
	displayName: string;
	description?: string;
	/** A parked conversation waits to be resumed: the condition behind the Rooms page's "standby" chip. */
	standbyThread: boolean;
	/** measured tokens of L1b — this is what's injected into every turn */
	l1bTokens: number;
	notes: number;
	noteTopics: number;
	/** The memory against its limit, measured with the numerator the limit itself uses, so this and Room settings agree. */
	memoryLimit: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean } | null;
	areas: number;
	checkpoints: number;
	lastCheckpointAt: number | null;
	lastReviewAt: number | null;
	/** the last review's token change (negative = pruned) */
	lastReviewTokenDelta: number;
	recentContextBacklog: number;
	needsAbsorb: boolean;
	/** Memory size after each checkpoint, Memorize and Review, oldest first: the Memory growth chart's points. */
	series: MemoryGrowthPoint[];
	sessions: number;
	/** the newest four waiting conversation titles, newest first */
	topics: string[];
	/** key things the room knows (bold phrases from durable memory) */
	knows: string[];
	composition: MemoryComposition;
	/** measured usage payoff for this room, or null if it has no logged turns */
	payoff: RoomPayoff | null;
}

export interface MemoryComposition {
	deep: number;
	active: number;
	recent: number;
	chronos: number;
}

/** A Recent Context session, sized in tokens (same unit as the memory map). */
export interface RecentSession {
	title: string;
	tokens: number;
	ts: number | null;
	/** False when `ts` is only the heading's date, parsed as UTC midnight: the UI must not render finer than days. */
	tsPrecise: boolean;
	/** When the checkpoint that admitted this entry was approved (ISO); null when no event record matches, and the UI then shows no receipt. */
	approvedAt: string | null;
	/** The entry's full text without its heading line, so the person can read what the room saved. */
	content: string;
	/** the gate-written checkpoint id — the key for the conversation endpoint */
	checkpointId: string | null;
	/** The source conversation's thread file is still on disk, so the receipt can offer to open it. */
	conversation: boolean;
}

/** One memory-changing event for the room's history, composed from the event records under events/, never from model output. */
export interface MemoryHistoryEvent {
	ts: number;
	/** `user_edit` is a Memory pane change, `migrate` the one-time write that gave entry ids, `undo` a Memorize or Review save taken back. */
	kind: "checkpoint" | "learn" | "review" | "user_edit" | "migrate" | "undo";
	/** the event record's own id: checkpointId, absorbId, reviewId, structuralReviewId or memoryEditId */
	id?: string | null;
	/** The record id under the name the undo route takes; undo serves Memorize and Review rows only. */
	saveId?: string | null;
	/** A before/after diff can be served: the archived snapshot is still on disk (Memorize, Review and memory edits). */
	diffable?: boolean;
	/** checkpoint: the kept session's title (older records may lack it) */
	title?: string | null;
	/** learn: how many Recent Context sessions were consolidated */
	sessions?: number | null;
	/** learn: the Deep Memory and Active Items size before and after, estimated tokens */
	deepTokensBefore?: number | null;
	deepTokensAfter?: number | null;
	/** review: the Deep Memory and Active Items token delta (negative = trimmed) */
	tokenDelta?: number | null;
	topicsTidied?: number | null;
	notesChanged?: number | null;
	entryId?: string | null;
	/** user_edit: what was done to it (add | edit | pin | unpin | move | status | delete | restore | archive_delete) */
	operation?: string | null;
	/** user_edit archive_delete: the topic the deleted note had, so the row can name it */
	topic?: string | null;
	entriesAssigned?: number | null;
	/** undo: which save was taken back, of which kind, and when it had been saved */
	undoneSaveId?: string | null;
	undoneKind?: "memorize" | "review" | null;
	undoneAt?: string | null;
	/** learn/review: a later undo took this save back; the row stays and says so. */
	undone?: boolean;
}

export interface MemoryOverview {
	generatedAt: number;
	totals: {
		rooms: number;
		l1bTokens: number;
		notes: number;
		noteTopics: number;
		checkpoints: number;
		recentContextBacklog: number;
		roomsNeedingAbsorb: number;
		composition: MemoryComposition;
	};
	rooms: RoomMemorySummary[];
}

/** How developed a room's memory is: a heuristic from its Remember saves and its Deep Memory size. */
export interface RoomMaturity {
	/** 0..3 */
	level: number;
	/** Forming | Practiced | Established | Deep */
	label: string;
	/** deep ÷ (deep + recent): how much memory is consolidated */
	consolidatedPct: number;
}

export interface RoomMemoryDetail extends RoomMemorySummary {
	l1aExists: boolean;
	memoryMap: MemoryMapRow[];
	/** the room's topics with their note counts, in document order */
	memoryTopics: MemoryTopicRow[];
	/** the Recent Context sessions, newest first — sized in tokens */
	recentSessions: RecentSession[];
	/** the room's memory changelog, newest first, capped */
	history: MemoryHistoryEvent[];
	maturity: RoomMaturity;
}

const MATURITY_LABELS = ["Forming", "Practiced", "Established", "Deep"];

function roomMaturity(summary: RoomMemorySummary): RoomMaturity {
	const { deep, recent } = summary.composition;
	// Depth grows with Remember saves and Deep Memory's size; waiting conversations add no size until Memorize distills them.
	const score = summary.checkpoints + deep / 200;
	const level = score < 2 ? 0 : score < 6 ? 1 : score < 15 ? 2 : 3;
	return {
		level,
		label: MATURITY_LABELS[level],
		consolidatedPct: deep + recent > 0 ? deep / (deep + recent) : 0,
	};
}

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
		return [];
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

interface UsageRow {
	ts: number;
	agent: string;
	input: number;
	cacheRead: number;
	cost: number;
}

function loadPayoffByRoom(): Map<string, RoomPayoff> {
	const file = productAppStatePath("usage.jsonl");
	const acc = new Map<string, { turns: number; cost: number; input: number; cacheRead: number }>();
	let text: string;
	try {
		text = fs.readFileSync(file, "utf-8");
	} catch {
		return new Map();
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
	metrics: ReturnType<typeof memoryMetrics> | null;
	composition: MemoryComposition;
	/** session titles in document order (oldest → newest) */
	sessionTitles: string[];
	knows: string[];
	/** the room's topics with their note counts, in document order */
	topics: MemoryTopicRow[];
}

/** Structural section names — never useful as "knows about" chips. */
const KNOWS_STRUCTURAL = new Set(["deep memory", "active items", "recent context", "chronos", "memory"]);

/** Distinct key phrases as "knows about" chips: bold phrases first, section headings as a fallback. */
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

/** What the model reads: every size here is measured on this render, never the raw file, so the Memory tab and the room's limit (reviewTargetEstimatedTokensFromL1b) agree. */
function memoryContextRender(l1b: string): string {
	try {
		return renderMemoryContext(l1b);
	} catch {
		return l1b; // unparsable topology: the raw file is the only honest reading
	}
}

export interface MemoryTopicRow {
	section: "Deep Memory" | "Active Items";
	topic: string;
	notes: number;
}

function topicRowsOf(doc: MemoryDocument): MemoryTopicRow[] {
	return doc.topics
		.filter((topic) => topic.entries.length > 0)
		.map((topic) => ({ section: topic.section, topic: topic.title, notes: topic.entries.length }));
}

function readRoomTopics(l1b: string): MemoryTopicRow[] {
	try {
		return topicRowsOf(parseMemoryDocument(l1b));
	} catch {
		return [];
	}
}

function readRoomL1bInfo(id: string): RoomL1bInfo {
	let stored: string;
	try {
		stored = createPersistentAgentInstance(id).readL1b();
	} catch {
		return { metrics: null, composition: { deep: 0, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [], topics: [] };
	}
	const topics = readRoomTopics(stored);
	const l1b = memoryContextRender(stored);
	const metrics = memoryMetrics(l1b);
	try {
		const parts = extractMemorySourceParts(l1b);
		const durable = memoryMetrics(parts.sourceReviewTargetL1b).estimatedTokens;
		const deepBody = topSectionBody(parts.sourceReviewTargetL1b, "Deep Memory");
		const deep = deepBody !== null ? memoryMetrics(deepBody).estimatedTokens : durable;
		return {
			metrics,
			composition: {
				deep,
				active: Math.max(0, durable - deep),
				recent: memoryMetrics(parts.preservedRecentContext).estimatedTokens,
				chronos: memoryMetrics(parts.preservedChronos).estimatedTokens,
			},
			sessionTitles: recentContextSessions(parts.preservedRecentContext).map((s) => s.title),
			knows: extractKnows(parts.sourceReviewTargetL1b),
			topics,
		};
	} catch {
		return { metrics, composition: { deep: metrics.estimatedTokens, active: 0, recent: 0, chronos: 0 }, sessionTitles: [], knows: [], topics };
	}
}

/** The Recent Context sessions, one per `### RC-#### | STATUS | date | Title` subsection, sized in the memory map's unit. */
function recentContextSessions(recentContext: string): Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> {
	const headings = Array.from(recentContext.matchAll(/^###\s+(.+?)\s*$/gm));
	const out: Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> = [];
	for (let i = 0; i < headings.length; i++) {
		const start = headings[i].index ?? 0;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? recentContext.length) : recentContext.length;
		const body = recentContext.slice(start, end);
		// Heading like "RC-0004 | OPEN | 2026-07-07 | Finalized reading list"; the date comes from the entry itself, so any "ago" is factual.
		const cells = headings[i][1].split("|").map((s) => s.trim()).filter(Boolean);
		const title = cells.length >= 4 ? cells.slice(3).join(" | ") : headings[i][1].trim();
		const id = cells.length > 0 && /^RC-\d+$/i.test(cells[0]) ? cells[0].toUpperCase() : null;
		let ts: number | null = null;
		const dateMatch = headings[i][1].match(/\d{4}-\d{2}-\d{2}/);
		if (dateMatch) {
			const parsed = Date.parse(dateMatch[0]);
			if (Number.isFinite(parsed)) ts = parsed;
		}
		// The join key is the rc_metadata checkpoint_id, never the RC label: labels are reused after a consolidation clears Recent Context. No metadata, no receipt.
		const rawBody = body.slice(headings[i][0].length);
		const meta = rawBody.match(/<!--\s*rc_metadata:([\s\S]*?)-->/);
		const cpMatch = meta ? meta[1].match(/checkpoint_id=([^;\s]+)/) : null;
		const checkpointId = cpMatch ? cpMatch[1] : null;
		// The approval instant in rc_metadata beats the heading's day, which parses to UTC midnight.
		let tsPrecise = false;
		const approvedMatch = meta ? meta[1].match(/approved_at=([^;\s]+)/) : null;
		if (approvedMatch) {
			const parsed = Date.parse(approvedMatch[1]);
			if (Number.isFinite(parsed)) {
				ts = parsed;
				tsPrecise = true;
			}
		}
		const content = rawBody.replace(/<!--[\s\S]*?-->/g, "").trim();
		out.push({ id, checkpointId, title, tokens: memoryMetrics(body).estimatedTokens, ts, tsPrecise, content });
	}
	return out;
}

/** The full memory composition: `buildMemoryMap` covers only Deep Memory and Active Items, so Recent Context (one summary row) and Chronos are added back. */
function buildFullMemoryMap(stored: string): MemoryMapRow[] {
	const l1b = memoryContextRender(stored);
	try {
		const parts = extractMemorySourceParts(l1b);
		// Top-level rows only — parent aggregates already include their subsections,
		// so keeping the "Parent / Child" rows too would double-count.
		const rows = buildMemoryMap(parts.sourceReviewTargetL1b).filter((r) => !r.area.includes(" / "));
		const rc = memoryMetrics(parts.preservedRecentContext);
		if (rc.estimatedTokens > 0) {
			const n = recentContextSessions(parts.preservedRecentContext).length;
			rows.push({ area: `Recent sessions · ${n} · not yet memorized`, words: rc.words, estimatedTokens: rc.estimatedTokens });
		}
		const chronos = memoryMetrics(parts.preservedChronos);
		if (chronos.estimatedTokens > 0) {
			rows.push({ area: "Timeline", words: chronos.words, estimatedTokens: chronos.estimatedTokens });
		}
		return rows;
	} catch {
		return memoryMetrics(l1b).memoryMap;
	}
}

function readRoomSessions(id: string): Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }> {
	try {
		const parts = extractMemorySourceParts(memoryContextRender(createPersistentAgentInstance(id).readL1b()));
		return recentContextSessions(parts.preservedRecentContext);
	} catch {
		return [];
	}
}

/** Per-layer sizes at an event, from its stored snapshot; older records without topLevel fall back to the non-recent figure. */
function eventLayers(result: CheckpointEventRecord["result"]): { deep: number; recent: number } {
	// The lasting layer counts Deep Memory and Active Items, as the memory meter does, so a chart point and the bar beside it agree.
	const tl = result.sections?.topLevel;
	const deepSection = tl?.find((s) => s.title?.trim().toLowerCase() === "deep memory");
	const activeSection = tl?.find((s) => s.title?.trim().toLowerCase() === "active items");
	return {
		deep: deepSection ? deepSection.estimatedTokens + (activeSection?.estimatedTokens ?? 0) : (result.sections?.nonRecentContext?.estimatedTokens ?? result.estimatedTokens),
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
		title: "Memorize",
		kind: "absorb",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

function readRecordsIn<T>(dir: () => string): T[] {
	let folder: string;
	try {
		folder = dir();
	} catch {
		return [];
	}
	let files: string[];
	try {
		files = fs.readdirSync(folder);
	} catch {
		return [];
	}
	const records: T[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		try {
			records.push(JSON.parse(fs.readFileSync(path.join(folder, file), "utf-8")) as T);
		} catch {
			// skip an unreadable record
		}
	}
	return records;
}

/** The whole-rewrite Reviews of older versions, still on disk in rooms that ran them. */
function readReviews(id: string): StructuralReviewEventRecord[] {
	return readRecordsIn<StructuralReviewEventRecord>(() => createPersistentAgentInstance(id).structuralReviewEventDir());
}

/** The note-by-note Review saves. */
function readReviewRuns(id: string): ReviewEventRecord[] {
	return readRecordsIn<ReviewEventRecord>(() => createPersistentAgentInstance(id).reviewEventDir());
}

function reviewRunPoint(record: ReviewEventRecord): MemoryGrowthPoint {
	const layers = eventLayers(record.result);
	return {
		ts: Date.parse(record.approvedAt) || 0,
		tokens: record.result.estimatedTokens,
		added: record.review?.reviewTargetEstimatedTokenDelta ?? 0,
		title: "Review",
		kind: "review",
		consolidated: layers.deep,
		recent: layers.recent,
	};
}

/** Every Review point, old shape and new, for the growth series and the "last review" line. */
function reviewPoints(id: string): MemoryGrowthPoint[] {
	return [...readReviews(id).map(reviewPoint), ...readReviewRuns(id).map(reviewRunPoint)];
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

function growthSeries(id: string, checkpoints: CheckpointEventRecord[]): MemoryGrowthPoint[] {
	const points = [...checkpoints.map(growthPoint), ...readAbsorbs(id).map(absorbPoint), ...reviewPoints(id)];
	// A malformed approvedAt parses to ts 0: as a chart point it would be a clickable moment whose snapshot fetch fails (`at <= 0` is rejected).
	return points.filter((p) => p.ts > 0).sort((a, b) => a.ts - b.ts);
}

/** The room's memory against its limit: from the status when it carries it, else measured through the same numerator. */
function roomMemoryLimit(status: PersistentAgentStatus): RoomMemorySummary["memoryLimit"] {
	if (status.memoryBudget) return status.memoryBudget;
	try {
		const tokens = reviewTargetEstimatedTokensFromL1b(createPersistentAgentInstance(status.id).readL1b());
		settleMemoryBudget(status.id);
		const budgetTokens = readPersistentRoomMaintenanceSettings(status.id).memoryBudgetTokens;
		return { budgetTokens, reviewTargetEstimatedTokens: tokens, overBudget: tokens > budgetTokens };
	} catch {
		return null; // no memory file yet — the surfaces show no fullness rather than a made-up one
	}
}

function summarizeRoom(status: PersistentAgentStatus, payoffByRoom: Map<string, RoomPayoff>): RoomMemorySummary {
	const info = readRoomL1bInfo(status.id);
	const checkpoints = readCheckpoints(status.id);
	const lastCheckpointAt = status.memoryStatus.lastCheckpointAt
		? Date.parse(status.memoryStatus.lastCheckpointAt) || null
		: (checkpoints.length ? growthPoint(checkpoints[checkpoints.length - 1]).ts : null);
	const reviews = reviewPoints(status.id).sort((a, b) => a.ts - b.ts);
	const lastReview = reviews.length ? reviews[reviews.length - 1] : null;
	return {
		id: status.id,
		displayName: status.displayName?.trim() || status.id,
		description: status.description,
		standbyThread: (status.runtime.state === "standby" || status.runtime.state === "active") && !!status.runtime.activeThreadId,
		// Total = sum of the composition parts, so the bar and the total always
		// reconcile (no separately-rounded whole-file estimate that can drift).
		l1bTokens: info.composition.deep + info.composition.active + info.composition.recent + info.composition.chronos,
		notes: info.topics.reduce((sum, topic) => sum + topic.notes, 0),
		noteTopics: info.topics.length,
		memoryLimit: roomMemoryLimit(status),
		areas: info.metrics?.memoryMap.length ?? status.l1b.sections.length,
		checkpoints: checkpoints.length,
		lastCheckpointAt,
		recentContextBacklog: status.memoryStatus.recentContextCount,
		needsAbsorb: status.status === "needs_absorb",
		series: growthSeries(status.id, checkpoints),
		lastReviewAt: lastReview ? lastReview.ts : null,
		lastReviewTokenDelta: lastReview ? lastReview.added : 0,
		sessions: info.sessionTitles.length,
		topics: info.sessionTitles.slice(-4).reverse(),
		knows: info.knows.filter((k) => {
			const kl = k.toLowerCase();
			return kl !== (status.displayName ?? "").toLowerCase() && kl !== status.id.toLowerCase();
		}).slice(0, 6),
		composition: info.composition,
		payoff: payoffByRoom.get(status.id) ?? null,
	};
}

export function buildMemoryOverview(): MemoryOverview {
	// listPersistentAgents() returns active (non-archived) rooms only.
	const payoffByRoom = loadPayoffByRoom();
	const rooms = listPersistentAgents().map((status) => summarizeRoom(status, payoffByRoom));
	rooms.sort((a, b) => b.l1bTokens - a.l1bTokens);
	return {
		generatedAt: Date.now(),
		totals: {
			rooms: rooms.length,
			l1bTokens: rooms.reduce((sum, r) => sum + r.l1bTokens, 0),
			notes: rooms.reduce((sum, r) => sum + r.notes, 0),
			noteTopics: rooms.reduce((sum, r) => sum + r.noteTopics, 0),
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
			continue;
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
	sources: string[];
	/** the display names of the rooms with memory that `include` kept out */
	leftOut: string[];
}

/** Memory across rooms for a question: all of it when it fits the budget, else the rooms ranked by the question's words, truncated to fit. Never empty while a room in scope that `include` keeps has memory. */
export function buildMemoryAskContext(question: string, budgetTokens = ASK_BUDGET_TOKENS, roomIds?: string[], include?: (roomId: string) => boolean): MemoryAskContext {
	const scope = roomIds && roomIds.length ? new Set(roomIds) : null;
	const blocks: Array<{ room: string; text: string; tokens: number }> = [];
	const leftOut: string[] = [];
	for (const status of listPersistentAgents()) {
		if (scope && !scope.has(status.id)) continue;
		let text = "";
		try {
			const parts = extractMemorySourceParts(createPersistentAgentInstance(status.id).readL1b());
			text = `## Durable memory\n\n${parts.sourceReviewTargetL1b.trim()}\n\n## Recent sessions\n\n${parts.preservedRecentContext.trim()}`;
		} catch {
			try { text = createPersistentAgentInstance(status.id).readL1b(); } catch { continue; }
		}
		if (!text.trim()) continue;
		if (include && !include(status.id)) { leftOut.push(safeRoomLabel(status.displayName?.trim() || status.id)); continue; }
		blocks.push({ room: safeRoomLabel(status.displayName?.trim() || status.id), text, tokens: memoryMetrics(text).estimatedTokens });
	}
	if (blocks.length === 0) return { context: "", sources: [], leftOut };

	const render = (chosen: Array<{ room: string; text: string }>) => chosen.map((b) => `# Exxpert: ${b.room}\n\n${b.text}`).join("\n\n---\n\n");

	const total = blocks.reduce((sum, b) => sum + b.tokens, 0);
	if (total <= budgetTokens) {
		return { context: render(blocks), sources: blocks.map((b) => b.room), leftOut };
	}

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
		if (b.score === 0 && picked.length > 0) break;
		const remaining = budgetTokens - used;
		if (remaining <= 250) break;
		if (b.tokens <= remaining) {
			picked.push({ room: b.room, text: b.text });
			used += b.tokens;
		} else {
			picked.push({ room: b.room, text: b.text.slice(0, remaining * 4) + "\n\n…(truncated)" });
			used = budgetTokens;
			break;
		}
	}
	if (picked.length === 0) {
		const big = [...blocks].sort((a, z) => z.tokens - a.tokens)[0];
		picked.push({ room: big.room, text: big.text.slice(0, budgetTokens * 4) + "\n\n…(truncated)" });
	}
	return { context: render(picked), sources: picked.map((b) => b.room), leftOut };
}

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
		const reviewsSince = reviewPoints(status.id).filter((p) => p.ts >= sinceMs);
		if (points.length === 0 && reviewsSince.length === 0) continue;
		points.sort((a, b) => b.ts - a.ts);
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

export interface MemoryAreaContent {
	area: string;
	/** the section's body markdown, without its heading or schema comments */
	content: string;
}

function cleanAreaBody(text: string): string {
	return text
		.replace(/<!--[\s\S]*?-->/g, "")
		.replace(/^\s*#{1,6}\s+.+$/m, "")
		.trim();
}

/** The text of one memory area, so the person can read memory, not just measure it: a top-level section, "Timeline", or a topic. */
export function readMemoryArea(id: string, areaName: string): MemoryAreaContent | null {
	let l1b: string;
	try {
		l1b = memoryContextRender(createPersistentAgentInstance(id).readL1b());
	} catch {
		return null;
	}
	let parts: ReturnType<typeof extractMemorySourceParts>;
	try {
		parts = extractMemorySourceParts(l1b);
	} catch {
		return null;
	}
	if (areaName.trim().toLowerCase() === "timeline") {
		return { area: "Timeline", content: cleanAreaBody(parts.preservedChronos) };
	}
	const src = parts.sourceReviewTargetL1b;
	const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
	for (let i = 0; i < headings.length; i++) {
		const name = headings[i][1].trim();
		if (name.toLowerCase() !== areaName.trim().toLowerCase()) continue;
		const start = (headings[i].index ?? 0) + headings[i][0].length;
		const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
		return { area: name, content: cleanAreaBody(src.slice(start, end)) };
	}
	// A topic, not a whole section: only the body under its `###` heading, never a neighbouring topic's text.
	const topicHeadings = Array.from(src.matchAll(/^###\s+(.+?)\s*$/gm));
	for (let i = 0; i < topicHeadings.length; i++) {
		const name = topicHeadings[i][1].trim();
		if (name.toLowerCase() !== areaName.trim().toLowerCase()) continue;
		const start = (topicHeadings[i].index ?? 0) + topicHeadings[i][0].length;
		const nextTopic = topicHeadings[i + 1]?.index ?? src.length;
		const nextSection = headings.map((h) => h.index ?? src.length).find((index) => index > start) ?? src.length;
		return { area: name, content: cleanAreaBody(src.slice(start, Math.min(nextTopic, nextSection))) };
	}
	return null;
}

/** A stored conversation item for the wire; composite kinds fold into system text, and long fields are capped with a flag. */
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
	// Composite display kinds fold into readable system text, so the UI need not know every display shape.
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
	return null; // a future display kind: skipped, and not counted in itemsTotal
}

/** The conversation a checkpoint receipt points at: checkpoint id, event record, closedThreadId, the thread file. A missing link is stored:false, never a guess. */
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
	// itemsTotal counts renderable items only, so itemsTotal > items.length means the cap cut the tail, never that internals were skipped.
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

/** Every recorded memory write archives the L1b it replaced, so the state after write N is the next write's archive, or today's document; only recorded snapshots are served. */
interface ArchiveChainLink {
	ts: number;
	archivedRelPath: string;
}

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

/** All archived snapshots across every recorded write, oldest first, existing files only. */
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
	for (const record of readEventRecords<ReviewEventRecord>(id, (i) => i.reviewEventDir())) push(record);
	for (const record of readEventRecords<StructuralReviewEventRecord>(id, (i) => i.structuralReviewEventDir())) push(record);
	// The memory edits: an archive delete records no snapshot, so it adds no link; every other edit does.
	for (const record of readEventRecords<MemoryEditEventRecord>(id, (i) => i.memoryEditEventDir())) push(record);
	links.sort((a, b) => a.ts - b.ts);
	return links;
}

function stripDocComments(text: string): string {
	return text.replace(/<!--[\s\S]*?-->/g, "").trim();
}

export interface MemoryEventSectionDiff {
	section: string;
	/** the section's text before the event, comments stripped ("" if absent) */
	beforeText: string;
	/** the section's text in the next recorded state ("" if absent) */
	afterText: string;
	beforeTokens: number;
	afterTokens: number;
}

/** The history rows a diff can be served for: the two maintenance saves and the memory edits that snapshot the file they replace. */
export type MemoryEventDiffKind = "learn" | "review" | "user_edit" | "migrate" | "undo";

export const MEMORY_EVENT_DIFF_KINDS: readonly MemoryEventDiffKind[] = ["learn", "review", "user_edit", "migrate", "undo"];

export type MemoryNoteChangeKind = "added" | "archived" | "updated" | "moved" | "pinned" | "unpinned" | "closed" | "reopened";

/** One note's row in the change view: `from` names the topic a moved note came from; `why` is the archive reason, `reason` what the ranking saw or which value replaced which. */
export interface MemoryNoteChange {
	id: string;
	change: MemoryNoteChangeKind;
	before?: string;
	after?: string;
	from?: string;
	why?: ArchiveReason;
	reason?: string;
}

/** One topic's rows in the change view, named the way the change view names topics. */
export interface MemoryEventTopicDiff {
	section: string;
	changes: MemoryNoteChange[];
}

export interface MemoryEventDiff {
	kind: MemoryEventDiffKind;
	/** the record's own id: absorbId, reviewId, structuralReviewId or memoryEditId */
	eventId: string;
	approvedAt: string;
	/** True when both sides parsed into notes and `topics` lists changes note by note; false falls back to `sections`. */
	notes: boolean;
	/** The changed topics, after side's order first, before-only topics appended; empty when `notes` is false. */
	topics: MemoryEventTopicDiff[];
	/** The waiting conversations that left and arrived between the two sides, by title, in document order. */
	conversations: { left: string[]; joined: string[] };
	/** The line view, only when `notes` is false: changed sections, split before diffing so a change is never attributed to the wrong topic. */
	sections?: MemoryEventSectionDiff[];
	/** where the after side came from: the next event's archive, or today's document */
	afterBasis: "next-archive" | "current";
	/** Whether the after side hashes to the fingerprint the record stored; false means memory also changed outside the gate, null that there is nothing to check against. */
	afterVerified: boolean | null;
}

/** The change view's names for the parts of memory that are not topics. */
const WAITING_CONVERSATIONS_SECTION = "Waiting conversations";
const TIMELINE_SECTION = "Timeline";
/** An Active Items topic that shares its title with a Deep Memory topic reads "<Topic> · open items". */
const OPEN_ITEMS_SUFFIX = " · open items";

interface DiffSection {
	name: string;
	text: string;
}

/** A topic's notes as a person reads them: its intro and its entries, the metadata comments gone. */
function topicNotesText(topic: MemoryTopic): string {
	return [topic.intro, ...topic.entries.map((entry) => entry.text)]
		.map((part) => part.trim())
		.filter(Boolean)
		.join("\n\n");
}

/** Both sides split into the change view's sections with one naming: a topic by its heading, an Active Items topic sharing a Deep Memory title as "<Topic> · open items". */
function diffSectionsOf(beforeRaw: string, afterRaw: string): { before: DiffSection[]; after: DiffSection[] } {
	let docs: [MemoryDocument, MemoryDocument];
	try {
		docs = [parseMemoryDocument(beforeRaw), parseMemoryDocument(afterRaw)];
	} catch {
		return {
			before: [{ name: "Memory", text: stripDocComments(beforeRaw) }],
			after: [{ name: "Memory", text: stripDocComments(afterRaw) }],
		};
	}
	const deepTitles = new Set(docs.flatMap((doc) => doc.topics.filter((topic) => topic.section === "Deep Memory").map((topic) => topic.title)));
	const sectionsOf = (doc: MemoryDocument): DiffSection[] => {
		const out: DiffSection[] = [];
		for (const topic of doc.topics) {
			const name = topic.section === "Active Items" && deepTitles.has(topic.title) ? `${topic.title}${OPEN_ITEMS_SUFFIX}` : topic.title;
			out.push({ name, text: topicNotesText(topic) });
		}
		for (const other of [...doc.otherSections].sort((a, b) => a.index - b.index)) out.push({ name: other.title, text: cleanAreaBody(other.text) });
		out.push({ name: WAITING_CONVERSATIONS_SECTION, text: cleanAreaBody(doc.recentContext) });
		out.push({ name: TIMELINE_SECTION, text: cleanAreaBody(doc.chronos) });
		return out;
	};
	return { before: sectionsOf(docs[0]), after: sectionsOf(docs[1]) };
}

function changeViewTopicName(topic: MemoryTopic, deepTitles: ReadonlySet<string>): string {
	return topic.section === "Active Items" && deepTitles.has(topic.title) ? `${topic.title}${OPEN_ITEMS_SUFFIX}` : topic.title;
}

/** One value of a record's archived rows, keyed by entry id; a `-vN` archive id maps to its entry id, an exact row wins over a versioned one. */
function archivedRowValuesOf<R extends { id?: unknown }, T>(rows: ReadonlyArray<R> | undefined, valueOf: (row: R) => T | undefined): Map<string, T> {
	const out = new Map<string, T>();
	const versioned = new Map<string, T>();
	for (const row of rows ?? []) {
		const id = typeof row.id === "string" ? row.id : "";
		const value = valueOf(row);
		if (!id || value === undefined) continue;
		const match = /^(.*)-v\d+$/.exec(id);
		if (match) {
			if (!versioned.has(match[1])) versioned.set(match[1], value);
		} else if (!out.has(id)) {
			out.set(id, value);
		}
	}
	for (const [id, value] of versioned) if (!out.has(id)) out.set(id, value);
	return out;
}

function archivedReasonsOf(rows: ReadonlyArray<{ id?: unknown; why?: unknown }> | undefined): Map<string, ArchiveReason> {
	return archivedRowValuesOf(rows, (row: { why?: unknown }) => ARCHIVE_REASONS.find((known) => known === row.why));
}

/** The words a record's archived rows carry, by each row's own id; a `-vN` id stays as it is, so an updated note finds its own superseded versions. */
function rankingReasonsOf(rows: ReadonlyArray<{ id?: unknown; reason?: unknown }> | undefined): Map<string, string> {
	const out = new Map<string, string>();
	for (const row of rows ?? []) {
		const id = typeof row.id === "string" ? row.id : "";
		const reason = typeof row.reason === "string" ? row.reason.trim() : "";
		if (id && reason && !out.has(id)) out.set(id, reason);
	}
	return out;
}

/** The reason on the highest `-vN` row of one note: the version this save superseded, when the save said why. */
function supersededReasonOf(id: string, reasons: ReadonlyMap<string, string> | undefined): string | undefined {
	if (!reasons) return undefined;
	const prefix = `${id}-v`;
	let best: { version: number; reason: string } | undefined;
	for (const [key, reason] of reasons) {
		if (!key.startsWith(prefix) || !/^\d+$/.test(key.slice(prefix.length))) continue;
		const version = Number(key.slice(prefix.length));
		if (!best || version > best.version) best = { version, reason };
	}
	return best?.reason;
}

/** A note's text as the pairing compares it: the "(saved …)" stamps off, whitespace collapsed. */
function comparableNoteText(text: string): string {
	return text.replace(/ ?\(saved [^)]*\)/g, "").replace(/\s+/g, " ").trim();
}

interface IndexedEntry {
	entry: MemoryEntry;
	topic: string;
}

/** Both sides paired note by note; a side without entry ids is migrated in memory as its save migrated it. Null when a side does not parse or neither has topics. */
export function diffNotesOf(
	beforeRaw: string,
	afterRaw: string,
	opts: { fallbackSaved: string; archivedWhy?: ReadonlyMap<string, ArchiveReason>; archivedWhyByText?: ReadonlyMap<string, ArchiveReason>; archivedReason?: ReadonlyMap<string, string> },
): { topics: MemoryEventTopicDiff[]; conversations: MemoryEventDiff["conversations"] } | null {
	let docs: [MemoryDocument, MemoryDocument];
	try {
		docs = [beforeRaw, afterRaw].map((raw) => {
			const doc = parseMemoryDocument(raw);
			return isMigratedMemoryDocument(raw) ? doc : migrateMemoryDocument(doc, { fallbackSaved: opts.fallbackSaved }).doc;
		}) as [MemoryDocument, MemoryDocument];
	} catch {
		return null;
	}
	const [before, after] = docs;
	if (before.topics.length === 0 && after.topics.length === 0) return null;
	// A side that had no ids is paired by what each note says, its own topic first: the migration's numbering matches the save only while its rules stay the same. An unmatched note gets an id no side holds.
	if (!isMigratedMemoryDocument(beforeRaw) || !isMigratedMemoryDocument(afterRaw)) {
		const keyed = isMigratedMemoryDocument(beforeRaw) ? before : after;
		const other = keyed === before ? after : before;
		const byText = new Map<string, Array<{ id: string; topic: string }>>();
		for (const topic of keyed.topics) for (const entry of topic.entries) {
			if (!entry.id) continue;
			const key = comparableNoteText(entry.text);
			if (!byText.has(key)) byText.set(key, []);
			byText.get(key)!.push({ id: entry.id, topic: topic.title });
		}
		const claimed = new Set<string>();
		let unpaired = 0;
		for (const topic of other.topics) for (const entry of topic.entries) {
			const candidates = (byText.get(comparableNoteText(entry.text)) ?? []).filter((c) => !claimed.has(c.id));
			const pick = candidates.find((c) => c.topic === topic.title) ?? candidates[0];
			if (pick) { claimed.add(pick.id); entry.id = pick.id; }
			else entry.id = `unpaired-${++unpaired}`;
		}
	}
	const deepTitles = new Set(docs.flatMap((doc) => doc.topics.filter((topic) => topic.section === "Deep Memory").map((topic) => topic.title)));
	const indexOf = (doc: MemoryDocument): Map<string, IndexedEntry> => {
		const out = new Map<string, IndexedEntry>();
		for (const topic of doc.topics) {
			const name = changeViewTopicName(topic, deepTitles);
			for (const entry of topic.entries) if (entry.id && !out.has(entry.id)) out.set(entry.id, { entry, topic: name });
		}
		return out;
	};
	const beforeById = indexOf(before);
	const afterById = indexOf(after);
	const rowsByTopic = new Map<string, MemoryNoteChange[]>();
	for (const doc of [after, before]) for (const topic of doc.topics) {
		const name = changeViewTopicName(topic, deepTitles);
		if (!rowsByTopic.has(name)) rowsByTopic.set(name, []);
	}
	const text = (entry: MemoryEntry) => entry.text.trim();
	for (const [id, { entry, topic }] of afterById) {
		const was = beforeById.get(id);
		if (!was) {
			rowsByTopic.get(topic)!.push({ id, change: "added", after: text(entry) });
			continue;
		}
		const textBefore = text(was.entry);
		const textAfter = text(entry);
		const reworded = comparableNoteText(textBefore) !== comparableNoteText(textAfter);
		// A save that superseded the note said why when the two texts disagreed
		// on a value; the words sit on the version row this save archived.
		const reason = reworded ? supersededReasonOf(id, opts.archivedReason) : undefined;
		if (was.topic !== topic) {
			rowsByTopic.get(topic)!.push(
				reworded
					? { id, change: "updated", before: textBefore, after: textAfter, from: was.topic, ...(reason ? { reason } : {}) }
					: { id, change: "moved", after: textAfter, from: was.topic },
			);
		} else if (reworded) {
			rowsByTopic.get(topic)!.push({ id, change: "updated", before: textBefore, after: textAfter, ...(reason ? { reason } : {}) });
		} else if (was.entry.pinned !== entry.pinned) {
			rowsByTopic.get(topic)!.push({ id, change: entry.pinned ? "pinned" : "unpinned", before: textBefore, after: textAfter });
		} else if ((was.entry.status === "done") !== (entry.status === "done")) {
			rowsByTopic.get(topic)!.push({ id, change: entry.status === "done" ? "closed" : "reopened", before: textBefore, after: textAfter });
		}
	}
	for (const [id, { entry, topic }] of beforeById) {
		if (afterById.has(id)) continue;
		// The reason by the note's id first; a note the pairing could not give its
		// recorded id (a side that had none) is looked up by what it says instead.
		const why = opts.archivedWhy?.get(id) ?? opts.archivedWhyByText?.get(comparableNoteText(entry.text));
		const reason = opts.archivedReason?.get(id);
		rowsByTopic.get(topic)!.push({ id, change: "archived", before: text(entry), ...(why ? { why } : {}), ...(reason ? { reason } : {}) });
	}
	const topics: MemoryEventTopicDiff[] = [];
	for (const [section, changes] of rowsByTopic) if (changes.length) topics.push({ section, changes });
	const conversationsOf = (doc: MemoryDocument) => recentContextSessions(doc.recentContext).map((session) => ({ key: session.checkpointId ?? session.title, title: session.title }));
	const beforeConversations = conversationsOf(before);
	const afterConversations = conversationsOf(after);
	const beforeKeys = new Set(beforeConversations.map((c) => c.key));
	const afterKeys = new Set(afterConversations.map((c) => c.key));
	return {
		topics,
		conversations: {
			left: beforeConversations.filter((c) => !afterKeys.has(c.key)).map((c) => c.title),
			joined: afterConversations.filter((c) => !beforeKeys.has(c.key)).map((c) => c.title),
		},
	};
}

/** What a history row changed: the record's archived snapshot against the next recorded state. Null when the record or its archive is gone. */
export function readMemoryEventDiff(id: string, kind: MemoryEventDiffKind, eventIdRaw: string): MemoryEventDiff | null {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return null;
	}
	let record: AbsorbEventRecord | ReviewEventRecord | StructuralReviewEventRecord | MemoryEditEventRecord | null = null;
	// The path helpers validate the event id (no separators or traversal). A review is looked for under events/review and events/structural-review.
	const files = kind === "learn"
		? [() => instance.absorbEventRecordPath(eventIdRaw)]
		: kind === "review"
			? [() => instance.reviewEventRecordPath(eventIdRaw), () => instance.structuralReviewEventRecordPath(eventIdRaw)]
			: [() => instance.memoryEditEventRecordPath(eventIdRaw)];
	for (const file of files) {
		try {
			record = JSON.parse(fs.readFileSync(file(), "utf-8"));
			break;
		} catch {
			// absent or unreadable — try the next place this kind is recorded
		}
	}
	if (!record) return null;
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
	// A memory-edit record carries no fingerprint, so its after side is unverified. Older records fingerprinted the raw file, newer ones the context render, so both are checked.
	const storedFingerprint = "result" in record ? record.result?.l1bFingerprint?.value : undefined;
	const afterVerified = storedFingerprint
		? [fingerprintL1bSource(afterRaw).value, fingerprintL1bSource(memoryContextRender(afterRaw)).value].includes(storedFingerprint)
		: null;
	// The record's archived rows say why a note left: under `run` for Memorize and Review, on the record for a hand delete.
	const archivedRows = "run" in record ? record.run?.archived : "archived" in record ? record.archived : undefined;
	const archivedWhy = archivedReasonsOf(archivedRows);
	// The rows the budget took say what the ranking saw, and a superseded
	// version says which value replaced which; the others carry no such words.
	const archivedReason = rankingReasonsOf(archivedRows);
	// The room's archive knows every note that left and why, by its text: the
	// fallback for a note whose recorded id the pairing could not recover.
	const archivedWhyByText = new Map<string, ArchiveReason>();
	try {
		for (const entry of readArchive(id)) if (!archivedWhyByText.has(comparableNoteText(entry.text))) archivedWhyByText.set(comparableNoteText(entry.text), entry.why);
	} catch {
		// an unreadable archive costs the reason words, not the change view
	}
	const paired = diffNotesOf(beforeRaw, afterRaw, { fallbackSaved: new Date(ts).toISOString().slice(0, 10), archivedWhy, archivedWhyByText, archivedReason });
	let sections: MemoryEventSectionDiff[] | undefined;
	if (!paired) {
		const { before: beforeSections, after: afterSections } = diffSectionsOf(beforeRaw, afterRaw);
		const beforeByName = new Map(beforeSections.map((s) => [s.name, s.text]));
		const afterByName = new Map(afterSections.map((s) => [s.name, s.text]));
		const names = [...afterSections.map((s) => s.name), ...beforeSections.filter((s) => !afterByName.has(s.name)).map((s) => s.name)];
		sections = [];
		for (const name of names) {
			const beforeText = beforeByName.get(name) ?? "";
			const afterText = afterByName.get(name) ?? "";
			if (beforeText === afterText) continue;
			sections.push({
				section: name,
				beforeText,
				afterText,
				beforeTokens: memoryMetrics(beforeText).estimatedTokens,
				afterTokens: memoryMetrics(afterText).estimatedTokens,
			});
		}
	}
	// A memory-edit record says which of its three kinds it is; the history row
	// derives its kind the same way, so the two always agree.
	const recordKind: MemoryEventDiffKind = "memoryEditId" in record
		? (record.kind === "migrate" ? "migrate" : record.kind === "undo" ? "undo" : "user_edit")
		: kind;
	const eventId = "absorbId" in record
		? record.absorbId
		: "reviewId" in record
			? record.reviewId
			: "structuralReviewId" in record
				? record.structuralReviewId
				: record.memoryEditId;
	return {
		kind: recordKind,
		eventId,
		approvedAt: record.approvedAt,
		notes: paired !== null,
		topics: paired?.topics ?? [],
		conversations: paired?.conversations ?? { left: [], joined: [] },
		...(sections ? { sections } : {}),
		afterBasis,
		afterVerified,
	};
}

export interface MemorySnapshot {
	/** the requested moment (epoch ms) */
	at: number;
	/** archive: the state recorded just before the first event after `at`; current: `at` is after the last event, so today's document. */
	basis: "archive" | "current";
	/** the boundary event's approval time (epoch ms) for archive snapshots */
	boundaryTs: number | null;
	/** the full snapshot text, comments stripped */
	content: string;
	estimatedTokens: number;
	/** the memory map of that moment — same rows and measuring as the live map */
	memoryMap: MemoryMapRow[];
	/** readable body per map area of that moment, keyed by area name */
	areas: Record<string, string>;
	/** the Recent Context sessions of that moment, newest first, with receipts */
	recentSessions: RecentSession[];
	composition: MemoryComposition;
}

/** One snapshot through the live view's code paths, so a past state reads like today's. */
function deriveSnapshotView(id: string, stored: string): Pick<MemorySnapshot, "content" | "estimatedTokens" | "memoryMap" | "areas" | "recentSessions" | "composition"> {
	// A stored snapshot is measured and read the same way today's memory is:
	// through the context render, never the raw file.
	const raw = memoryContextRender(stored);
	const areas: Record<string, string> = {};
	let recentSessions: RecentSession[] = [];
	let composition: MemoryComposition;
	try {
		const parts = extractMemorySourceParts(raw);
		const src = parts.sourceReviewTargetL1b;
		const headings = Array.from(src.matchAll(/^##\s+(.+?)\s*$/gm));
		for (let i = 0; i < headings.length; i++) {
			const start = (headings[i].index ?? 0) + headings[i][0].length;
			const end = i + 1 < headings.length ? (headings[i + 1].index ?? src.length) : src.length;
			areas[headings[i][1].trim()] = cleanAreaBody(src.slice(start, end));
		}
		areas["Timeline"] = cleanAreaBody(parts.preservedChronos);
		recentSessions = sessionsWithReceipts(id, recentContextSessions(parts.preservedRecentContext));
		const durable = memoryMetrics(src).estimatedTokens;
		const deepBody = topSectionBody(src, "Deep Memory");
		const deep = deepBody !== null ? memoryMetrics(deepBody).estimatedTokens : durable;
		composition = {
			deep,
			active: Math.max(0, durable - deep),
			recent: memoryMetrics(parts.preservedRecentContext).estimatedTokens,
			chronos: memoryMetrics(parts.preservedChronos).estimatedTokens,
		};
	} catch {
		composition = { deep: memoryMetrics(raw).estimatedTokens, active: 0, recent: 0, chronos: 0 };
	}
	return {
		content: stripDocComments(raw),
		estimatedTokens: memoryMetrics(raw).estimatedTokens,
		memoryMap: buildFullMemoryMap(raw),
		areas,
		recentSessions,
		composition,
	};
}

/** The memory as it was at `at`: the archive of the first event after that moment, or today's document; recorded snapshots only. */
export function readMemorySnapshotAt(id: string, at: number): MemorySnapshot | null {
	const state = readRecordedStateAt(id, at);
	if (!state) return null;
	return { at, basis: state.basis, boundaryTs: state.boundaryTs, ...deriveSnapshotView(id, state.raw) };
}

/** The bytes at `at` from the archive chain; `at` undefined asks for today's document. */
function readRecordedStateAt(id: string, at: number | undefined): { raw: string; basis: MemorySnapshot["basis"]; boundaryTs: number | null } | null {
	let instance: ReturnType<typeof createPersistentAgentInstance>;
	try {
		instance = createPersistentAgentInstance(id);
	} catch {
		return null;
	}
	const next = at === undefined ? undefined : archiveChain(id).find((link) => link.ts > at);
	if (next) {
		try {
			return { raw: fs.readFileSync(instance.resolveRootRelativePath(next.archivedRelPath), "utf-8"), basis: "archive", boundaryTs: next.ts };
		} catch {
			return null;
		}
	}
	try {
		return { raw: instance.readL1b(), basis: "current", boundaryTs: null };
	} catch {
		return null;
	}
}

export interface MemoryNotesTopic extends MemoryTopicRow {
	/** the topic's body as the notes view renders it, its archive pointer line included */
	content: string;
}

export interface MemoryNotesView {
	/** the requested moment (epoch ms); now for today's view */
	at: number;
	/** archive: the state recorded just before the first write after `at`; current: today's document */
	basis: MemorySnapshot["basis"];
	/** the boundary write's approval time (epoch ms) for archive views */
	boundaryTs: number | null;
	/** the notes view text: "## Notes" and "## Open items", pointer lines included */
	content: string;
	/** that moment's topics in the order the document has them */
	topics: MemoryNotesTopic[];
}

/** The notes view's headings, in the engine's words and in the words a person reads. */
const NOTES_VIEW_SECTIONS: ReadonlyArray<{ section: MemoryTopicRow["section"]; engine: string; words: string; implicitTopic: string }> = [
	{ section: "Deep Memory", engine: "## Deep Memory", words: "## Notes", implicitTopic: MEMORY_GENERAL_TOPIC },
	{ section: "Active Items", engine: "## Active Items", words: "## Open items", implicitTopic: MEMORY_ACTIVE_ITEMS_TOPIC },
];

/** A memory document as the room reads it at the start of a conversation (notes and open items, context render, archive pointers; no pair days), with the headings in a person's words. Pure. */
export function notesViewOf(raw: string, index?: ArchiveIndex): Pick<MemoryNotesView, "content" | "topics"> {
	const doc = parseMemoryDocument(raw);
	const rendered = renderMemoryDocument(doc, "context", { sections: MEMORY_SECTIONS, archiveIndex: index }).trim();
	const lines = rendered
		.split(/\r?\n/)
		.map((line) => NOTES_VIEW_SECTIONS.find(({ engine }) => line.trimEnd() === engine)?.words ?? line)
		// The archive pointer line names the tool the room uses; a person reads what the room does instead.
		.map((line) => line.replace(/; use memory_recall to read them\._$/, ". The room reads them when a question needs them._"));
	// Each topic's share of the view: the lines under its `###` heading, or,
	// before the first heading of a section, the section's implicit topic.
	const bodies = new Map<string, string[]>();
	let section: (typeof NOTES_VIEW_SECTIONS)[number] | undefined;
	let body: string[] | undefined;
	for (const line of lines) {
		const heading = NOTES_VIEW_SECTIONS.find(({ words }) => line.trimEnd() === words);
		if (heading) {
			section = heading;
			body = [];
			bodies.set(`${section.section}\n${section.implicitTopic}`, body);
			continue;
		}
		const topic = /^###\s+(.+?)\s*$/.exec(line);
		if (topic && section) {
			body = [];
			bodies.set(`${section.section}\n${topic[1]}`, body);
			continue;
		}
		body?.push(line);
	}
	const topics = topicRowsOf(doc).map((row) => ({ ...row, content: (bodies.get(`${row.section}\n${row.topic}`) ?? []).join("\n").trim() }));
	return { content: lines.join("\n"), topics };
}

/** The room's notes view: today's file, or with `at` the recorded state then; the Memory tab's "Full memory" panel and its view of a past moment read it. */
export function readMemoryNotesView(id: string, at?: number): MemoryNotesView | null {
	const state = readRecordedStateAt(id, at);
	if (!state) return null;
	let index: ArchiveIndex | undefined;
	try {
		index = archiveIndex(readArchive(id));
	} catch {
		index = undefined; // an unreadable archive costs the pointer lines, not the notes
	}
	return { at: at ?? Date.now(), basis: state.basis, boundaryTs: state.boundaryTs, ...notesViewOf(state.raw, index) };
}

/** Receipts for Recent Context sessions, joined on the rc_metadata checkpoint_id, never the reused RC label; an entry without it gets none. Newest first. */
function sessionsWithReceipts(id: string, sessions: Array<{ id: string | null; checkpointId: string | null; title: string; tokens: number; ts: number | null; tsPrecise: boolean; content: string }>): RecentSession[] {
	const receiptByCheckpoint = new Map<string, { approvedAt: string; conversation: boolean }>();
	for (const record of readCheckpoints(id)) {
		if (!record.checkpointId) continue;
		receiptByCheckpoint.set(record.checkpointId, { approvedAt: record.approvedAt, conversation: conversationStored(id, record) });
	}
	return [...sessions]
		.reverse()
		.map((s) => {
			const receipt = s.checkpointId ? receiptByCheckpoint.get(s.checkpointId) : undefined;
			// An entry without an approval instant borrows the checkpoint record's, the same fact from the same gate.
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

function conversationStored(id: string, record: CheckpointEventRecord): boolean {
	const threadId = record.runtimeBoundary?.closedThreadId;
	if (!threadId) return false;
	try {
		return fs.existsSync(createPersistentAgentInstance(id).runtimeThreadPath(threadId));
	} catch {
		return false;
	}
}

/** Conversation rows returned per room — every one a room has kept, bounded for the wire. */
const MEMORY_CONVERSATIONS_CAP = 200;

export interface MemoryConversationRow {
	checkpointId: string;
	title: string;
	approvedAt: string;
	/** still among the waiting conversations of today's file — not memorized yet */
	waiting: boolean;
	/** the closed-thread file exists, so the conversation can be opened */
	conversation: boolean;
}

/** Every conversation the room has kept, newest first, one row per checkpoint record; `conversation` is decided as the receipts decide it. */
export function listMemoryConversations(id: string): MemoryConversationRow[] {
	const waitingTitles = new Map<string, string>();
	for (const s of readRoomSessions(id)) if (s.checkpointId) waitingTitles.set(s.checkpointId, s.title);
	const rows: MemoryConversationRow[] = [];
	for (const record of readCheckpoints(id)) {
		if (!record.checkpointId) continue;
		const storedTitle = record.checkpoint?.approvedEntry?.title?.trim();
		rows.push({
			checkpointId: record.checkpointId,
			title: storedTitle || waitingTitles.get(record.checkpointId) || "Conversation",
			approvedAt: record.approvedAt,
			waiting: waitingTitles.has(record.checkpointId),
			conversation: conversationStored(id, record),
		});
	}
	return rows.reverse().slice(0, MEMORY_CONVERSATIONS_CAP);
}

/** History entries returned per room — plenty for the timeline, bounded for the wire. */
const MEMORY_HISTORY_CAP = 40;

function buildMemoryHistory(id: string): MemoryHistoryEvent[] {
	const events: MemoryHistoryEvent[] = [];
	// Older records carry no title; while their entry is still in the file its heading supplies one, joined on checkpoint_id so a title never comes from another entry.
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
	// An undone save's row stays and carries the mark: a timeline that drops it would show memory changing for no visible reason.
	const memoryEdits = readEventRecords<MemoryEditEventRecord>(id, (instance) => instance.memoryEditEventDir());
	const undoneSaveIds = new Set(memoryEdits.filter((record) => record.kind === "undo" && record.undoneSaveId).map((record) => String(record.undoneSaveId)));
	for (const record of readCheckpoints(id)) {
		const fallback = record.checkpointId ? titleByCheckpoint.get(record.checkpointId) : undefined;
		events.push({ ts: Date.parse(record.approvedAt), kind: "checkpoint", id: record.checkpointId ?? null, saveId: record.checkpointId ?? null, title: record.checkpoint?.approvedEntry?.title ?? fallback ?? null });
	}
	for (const record of readEventRecords<AbsorbEventRecord>(id, (instance) => instance.absorbEventDir())) {
		const absorb = record.absorb;
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: "learn",
			id: record.absorbId ?? null,
			saveId: record.absorbId ?? null,
			diffable: Boolean(record.absorbId) && diffable(record),
			sessions: absorb ? Math.max(0, absorb.recentContextEntryCountBefore - absorb.recentContextEntryCountAfter) : null,
			deepTokensBefore: absorb?.stableMemoryEstimatedTokensBefore ?? null,
			deepTokensAfter: absorb?.stableMemoryEstimatedTokensAfter ?? null,
			...(record.absorbId && undoneSaveIds.has(record.absorbId) ? { undone: true } : {}),
		});
	}
	// Note-level Review saves and the older whole-rewrite ones: both are reviews to a person.
	for (const record of readEventRecords<ReviewEventRecord>(id, (instance) => instance.reviewEventDir())) {
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: "review",
			id: record.reviewId ?? null,
			saveId: record.reviewId ?? null,
			diffable: Boolean(record.reviewId) && diffable(record),
			tokenDelta: record.review?.reviewTargetEstimatedTokenDelta ?? null,
			topicsTidied: record.review?.topicsTidied ?? null,
			notesChanged: record.review?.notesChanged ?? null,
			...(record.reviewId && undoneSaveIds.has(record.reviewId) ? { undone: true } : {}),
		});
	}
	for (const record of readEventRecords<StructuralReviewEventRecord>(id, (instance) => instance.structuralReviewEventDir())) {
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: "review",
			id: record.structuralReviewId ?? null,
			saveId: record.structuralReviewId ?? null,
			diffable: Boolean(record.structuralReviewId) && diffable(record),
			tokenDelta: record.structuralReview?.reviewTargetEstimatedTokenDelta ?? null,
			...(record.structuralReviewId && undoneSaveIds.has(record.structuralReviewId) ? { undone: true } : {}),
		});
	}
	for (const record of memoryEdits) {
		events.push({
			ts: Date.parse(record.approvedAt),
			kind: record.kind === "migrate" ? "migrate" : record.kind === "undo" ? "undo" : "user_edit",
			id: record.memoryEditId ?? null,
			saveId: record.memoryEditId ?? null,
			diffable: Boolean(record.memoryEditId) && diffable(record),
			entryId: record.entryId ?? null,
			operation: record.entryOperation ?? null,
			...(record.entryOperation === "archive_delete" ? { topic: record.edit?.topic ?? null } : {}),
			entriesAssigned: record.entriesAssigned ?? null,
			...(record.kind === "undo" ? { undoneSaveId: record.undoneSaveId ?? null, undoneKind: record.undoneKind ?? null, undoneAt: record.undoneAt ?? null } : {}),
		});
	}
	return events.filter((e) => Number.isFinite(e.ts)).sort((a, b) => b.ts - a.ts).slice(0, MEMORY_HISTORY_CAP);
}

export function buildRoomMemoryHistory(agentId: string): MemoryHistoryEvent[] {
	return buildMemoryHistory(agentId);
}

export function buildRoomMemory(status: PersistentAgentStatus): RoomMemoryDetail {
	const summary = summarizeRoom(status, loadPayoffByRoom());
	let memoryMap: MemoryMapRow[] = [];
	let memoryTopics: MemoryTopicRow[] = [];
	try {
		const stored = createPersistentAgentInstance(status.id).readL1b();
		memoryMap = buildFullMemoryMap(stored);
		memoryTopics = readRoomTopics(stored);
	} catch {
		memoryMap = [];
	}
	// Newest first, each with its own recorded date, so any time shown belongs to that session.
	const recentSessions = sessionsWithReceipts(status.id, readRoomSessions(status.id));
	return {
		...summary,
		l1aExists: status.l1a.exists,
		memoryMap,
		memoryTopics,
		recentSessions,
		history: buildMemoryHistory(status.id),
		maturity: roomMaturity(summary),
	};
}

// The app's ids are padded to four digits at least (RC-0001, m-0012): a real "m-150" in the person's words stays.
const MEMORY_ID = String.raw`(?:RC-\d{4,}|m-\d{4,})(?:\s*[\u2013\u2014-]\s*(?:RC-\d{4,}|m-\d{4,}))?`;

/** An answer from memory as the person reads it: the engine's ids (RC-0001, m-0012) taken out with the separator or brackets that held them, so "Room · RC-0001" reads "Room". */
export function withoutMemoryIds(text: string): string {
	return text
		.replace(new RegExp(String.raw`\s*\(\s*${MEMORY_ID}(?:\s*,\s*${MEMORY_ID})*\s*\)`, "g"), "")
		.replace(new RegExp(String.raw`\s*\[\s*${MEMORY_ID}(?:\s*,\s*${MEMORY_ID})*\s*\]`, "g"), "")
		.replace(new RegExp(String.raw`\s*[·,;]\s*${MEMORY_ID}(?:\s*,\s*${MEMORY_ID})*`, "g"), "")
		.replace(new RegExp(String.raw`[ \t]*\b${MEMORY_ID}\b`, "g"), "");
}
