import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api";
import {
	allRoomsFactsLine,
	ASOF_ERROR,
	ASOF_READING,
	asOfChip,
	asOfSentence,
	BACK_TO_TODAY_LABEL,
	CONVERSATION_GONE,
	fmtMemoryDay,
	fmtMemoryMoment,
	FULL_MEMORY_PANEL_SUB,
	GROWTH_SUB,
	HISTORY_ASOF_TAIL,
	inMemorySinceLine,
	MEMORIZED_SUB,
	memorizedConversationsTitle,
	memoryFullLine,
	memoryHistoryRows,
	memoryPercentFull,
	MEMORY_TAB_HISTORY_SUB,
	MEMORY_TAB_LEGEND,
	memoryTopicName,
	memoryUsageTitle,
	OPEN_CONVERSATION_LABEL,
	OPEN_IN_ROOM_SETTINGS_LABEL,
	roomMemoryFactsLine,
	TOPICS_PANEL_EMPTY,
	TOPICS_PANEL_SUB,
	TOPICS_PANEL_TITLE,
	topicPanelSub,
	topicRowLine,
	WAITING_PANEL_EMPTY,
	WAITING_PANEL_NONE_YET,
	WAITING_PANEL_SUB,
	WAITING_PANEL_TITLE,
	YOU_ARE_VIEWING_HERE,
	type MemorySaveEvent,
} from "../memory-surface-copy";
import { MarkdownRenderer } from "./Markdown";
import { MemoryChangeFold } from "./memory-change-fold";
import { MemoryGrowthChart, type GrowthPoint } from "./memory-growth-chart";

// The cross-room reading of memory, from /api/memory (read-only). This page
// says what each room remembers and how full its memory is, in the same words
// Room settings uses and against the same limit — the numbers here and the
// room's own limit line are one measurement, taken server-side of the context
// render. Nothing on this page writes: editing a note, and taking a save back,
// belong beside the notes themselves in Room settings.

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
	/** how many notes this room holds, across how many topics */
	notes: number;
	noteTopics: number;
	/** the room's memory against its own limit — the same numbers the limit shows */
	memoryLimit: { budgetTokens: number; reviewTargetEstimatedTokens: number; overBudget: boolean } | null;
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
	/** ts is an exact instant; false = date-only (UTC midnight), render no finer than days */
	tsPrecise: boolean;
	/** approval time of the save that admitted this text (ISO), when a record exists */
	approvedAt: string | null;
	/** the full saved text, word for word */
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

// One conversation the room has kept, memorized or still waiting, as
// /api/memory/rooms/:id/conversations lists them (newest first). `conversation`
// says whether its stored text still exists to open.
interface KeptConversation {
	checkpointId: string;
	title: string;
	approvedAt: string | number | null;
	waiting: boolean;
	conversation: boolean;
}

/** A kept conversation's saved day; the record carries an instant, which the row says as a day. */
function fmtKeptDay(value: string | number | null): string {
	if (value === null) return "";
	const ts = typeof value === "number" ? value : Date.parse(value);
	return Number.isFinite(ts) ? fmtMemoryDay(ts) : fmtMemoryDay(value);
}


// The room's notes as the "Full memory" panel reads them: today's, or the
// stored copy of a past moment (`/snapshot?view=notes&at=`). `boundaryTs` is
// the next recorded change after that moment, null when nothing came after;
// `topics` lists that moment's topics with the text each held.
interface NotesSnapshot {
	at: number;
	basis: "archive" | "current";
	boundaryTs: number | null;
	content: string;
	topics: { section: string; topic: string; notes: number; content: string }[];
}

// One topic row as the Topics list draws it, from today's document or from a
// past moment's copy; `content` is set only for the copy, so opening the row
// needs no fetch.
interface TopicRow {
	section: string;
	topic: string;
	notes: number;
	content?: string;
}


interface Overview {
	generatedAt: number;
	totals: {
		rooms: number;
		l1bTokens: number;
		notes: number;
		noteTopics: number;
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
	memoryTopics: { section: "Deep Memory" | "Active Items"; topic: string; notes: number }[];
	recentSessions: RecentSession[];
	history: MemorySaveEvent[];
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

const LAST_VISIT_KEY = "exx.memory.lastVisit";

/** Absolute short date for receipts, e.g. "12 Jul". */
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

function fmtAgo(ts: number | null): string {
	if (!ts) return "–";
	const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
	if (s < 60) return s + "s ago";
	if (s < 3600) return Math.round(s / 60) + "m ago";
	if (s < 86400) return Math.round(s / 3600) + "h ago";
	return Math.round(s / 86400) + "d ago";
}

// Day-granularity "ago" for rows whose timestamp is only a calendar date
// (parsed as UTC midnight): hour wording from a date-only fact would be
// invented precision, so these compare calendar days and never render finer.
function fmtAgoDay(ts: number): string {
	const d = new Date(ts);
	const now = new Date();
	const days = Math.round((Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000);
	if (days <= 0) return "today";
	if (days === 1) return "yesterday";
	return days + "d ago";
}

/**
 * How full one room's memory is, as a percent of the limit its owner set, split
 * into what fills it. The two notes segments are measured against the limit
 * because that is what the limit counts; waiting conversations sit beside them
 * because they are what Memorize will turn into notes, and the legend says so.
 * The whole bar is the limit, so a room at 40% shows 60% empty.
 */
function MemoryFullBar({ room }: { room: RoomSummary }) {
	const limit = room.memoryLimit;
	if (!limit || limit.budgetTokens <= 0) return null;
	const percent = memoryPercentFull(limit.reviewTargetEstimatedTokens, limit.budgetTokens);
	const width = (tokens: number) => `${Math.max(0, Math.min(100, (tokens / limit.budgetTokens) * 100))}%`;
	return (
		<div className="mem-full">
			<div className="mem-full-line">
				<span>{memoryFullLine(percent)}</span>
				{limit.overBudget && <strong className="over">above its budget</strong>}
			</div>
			<div
				className="mem-comp-bar"
				role="meter"
				aria-valuenow={Math.min(percent, 100)}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label={`${room.displayName}: ${memoryFullLine(percent)}`}
				title={memoryUsageTitle(limit.reviewTargetEstimatedTokens, limit.budgetTokens)}
			>
				<div className="mem-comp-seg durable" style={{ width: width(room.composition.deep) }} />
				<div className="mem-comp-seg items" style={{ width: width(room.composition.active) }} />
				<div className="mem-comp-seg recent" style={{ width: width(room.composition.recent) }} />
			</div>
		</div>
	);
}

export function Memory({ onMaintain, maintainBlocked, onOpenMemorySettings }: { onMaintain?: (target: { agentId: string; displayName: string }) => void; maintainBlocked?: (agentId: string) => string | null; onOpenMemorySettings?: (target: { agentId: string; displayName: string }) => void } = {}) {
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
	const [tab, setTab] = useState<"overview" | "hivemind">("overview");
	const searchSeq = useRef(0);
	const detailRef = useRef<HTMLElement>(null);
	// The reading panel's mode: null = the default waiting-conversations list;
	// one topic's actual content (click-to-read); or the stored conversation a
	// receipt points at.
	type Panel =
		| { kind: "area"; area: string; content: string; full?: true }
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
	// One "What changed" open at a time, keyed by room and row so another
	// room's list never inherits it.
	const [changeOpen, setChangeOpen] = useState<string | null>(null);
	// Every conversation the selected room has kept, for the memorized fold
	// under the waiting list; null until the room's list has arrived.
	const [conversations, setConversations] = useState<KeptConversation[] | null>(null);
	// The past moment being viewed (epoch ms of a point on the growth graph),
	// null = today. While set, the Topics list, the reading panel and the
	// History block all describe the stored copy of that moment.
	const [asOf, setAsOf] = useState<number | null>(null);
	const [snap, setSnap] = useState<
		| { at: number; state: "loading" | "error"; data?: undefined }
		| { at: number; state: "ready"; data: NotesSnapshot }
		| null
	>(null);

	// Expanding a card loads its detail below the grid — bring it into view so
	// the click visibly "goes somewhere".
	useEffect(() => {
		if (detail) detailRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
		panelReq.current++;
		setPanel(null);
		setPanelFull(false);
		setReceiptIdx(null);
		setHistAll(false);
	}, [detail?.id]);

	// Back to today the moment another room is picked, before the fetch effect
	// below runs: its cleanup marks any request in flight stale, so the new
	// room can never render the old room's copy.
	useEffect(() => {
		setAsOf(null);
		setSnap(null);
	}, [selected]);

	// The reading panel and the open receipt describe one moment; moving to
	// another (or back to today) would relabel content fetched under the old
	// one, so both close instead, and the panel reopens on the copy.
	useEffect(() => {
		panelReq.current++;
		setPanel(null);
		setPanelFull(false);
		setReceiptIdx(null);
	}, [asOf]);

	useEffect(() => {
		if (!selected || asOf === null) return;
		const roomId = selected;
		const at = asOf;
		// The cleanup cancels the debounce timer, but a fetch that already
		// fired keeps running: `stale` makes sure a slower older response (or
		// one from a room this view already left) can never install itself
		// over the moment picked since.
		let stale = false;
		setSnap({ at, state: "loading" });
		const timer = setTimeout(() => {
			apiFetch(`/api/memory/rooms/${encodeURIComponent(roomId)}/snapshot?view=notes&at=${at}`)
				.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
				.then((d: NotesSnapshot) => { if (!stale) setSnap({ at, state: "ready", data: { ...d, at, topics: Array.isArray(d.topics) ? d.topics : [] } }); })
				.catch(() => { if (!stale) setSnap({ at, state: "error" }); });
		}, 250);
		return () => { stale = true; clearTimeout(timer); };
	}, [asOf, selected]);

	// The copy the view is rendering, once it has arrived for the picked moment.
	const past = asOf !== null && snap?.state === "ready" && snap.at === asOf ? snap.data : null;
	const leaveAsOf = () => { setAsOf(null); setSnap(null); };

	// Each panel starts with its tools folded, its tail collapsed, and (when
	// the panel closes entirely) back in the normal layout.
	useEffect(() => {
		setOpenTools(new Set());
		setTrAll(false);
		if (!panel) setPanelFull(false);
	}, [panel]);

	// Esc leaves full screen without closing the panel.
	useEffect(() => {
		if (!panelFull) return;
		const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setPanelFull(false); };
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, [panelFull]);

	// One topic in the reading panel, word for word. The server reads it out of
	// the same document the room carries into a conversation; a past moment's
	// row already carries its text, so it opens without a fetch.
	const openTopic = (row: TopicRow) => {
		if (!detail) return;
		const req = ++panelReq.current;
		if (asOf !== null) {
			if (row.content !== undefined) setPanel({ kind: "area", area: memoryTopicName(row.topic), content: row.content });
			return;
		}
		const topic = row.topic;
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/area?name=${encodeURIComponent(topic)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (req === panelReq.current && d && typeof d.content === "string") setPanel({ kind: "area", area: memoryTopicName(d.area), content: d.content }); })
			.catch(() => {});
	};

	// Everything the room carries into a conversation, in the reading panel:
	// its notes and open items as the room reads them, nothing else. While a
	// past moment is viewed, the panel's resting state already is that copy.
	const openFullMemory = () => {
		if (!detail) return;
		const req = ++panelReq.current;
		if (asOf !== null) { setPanel(null); return; }
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/snapshot?view=notes&at=${Date.now()}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d: NotesSnapshot | null) => { if (req === panelReq.current && d && typeof d.content === "string") setPanel({ kind: "area", area: "Full memory", content: d.content, full: true }); })
			.catch(() => {});
	};

	// Open the stored conversation behind a receipt, or behind a memorized
	// conversation's row, in the reading panel. The in-flight guard keys on the
	// checkpoint id (titles are not unique), so an out-of-order response can
	// never land under another row.
	const openConversation = (s: { checkpointId: string | null; title: string }) => {
		if (!detail || !s.checkpointId) return;
		panelReq.current++;
		const cp = s.checkpointId;
		setPanel({ kind: "transcript", cp, title: s.title, state: "loading" });
		apiFetch(`/api/memory/rooms/${encodeURIComponent(detail.id)}/conversation?checkpoint=${encodeURIComponent(cp)}`)
			.then((r) => (r.ok ? r.json() : Promise.reject(new Error("bad status"))))
			.then((d: TranscriptResult) => setPanel((p) => (p?.kind === "transcript" && p.cp === cp ? { kind: "transcript", cp, title: s.title, state: "ready", data: d } : p)))
			.catch(() => setPanel((p) => (p?.kind === "transcript" && p.cp === cp ? { kind: "transcript", cp, title: s.title, state: "error" } : p)));
	};

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

	// Fetch the selected room's detail (topics + waiting conversations).
	useEffect(() => {
		if (!selected) { setDetail(null); return; }
		let cancelled = false;
		apiFetch(`/api/memory/rooms/${encodeURIComponent(selected)}`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (!cancelled) setDetail(d); })
			.catch(() => {});
		return () => { cancelled = true; };
	}, [selected]);

	// The room's kept conversations, read once per room; cleared first so one
	// room's rows never sit under another room's heading.
	useEffect(() => {
		setConversations(null);
		if (!selected) return;
		let cancelled = false;
		apiFetch(`/api/memory/rooms/${encodeURIComponent(selected)}/conversations`)
			.then((r) => (r.ok ? r.json() : null))
			.then((d) => { if (!cancelled && d && Array.isArray(d.conversations)) setConversations(d.conversations); })
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
	// One consistent waiting figure everywhere: the parsed per-room count.
	const waiting = data.rooms.reduce((sum, r) => sum + r.sessions, 0);

	const caughtUp = digest && digest.totals.newCheckpoints === 0;
	const scopeLabel = scope.size === 0 ? "all exxperts" : `${scope.size} exxpert${scope.size === 1 ? "" : "s"}`;

	return (
		<div className="dashboard">
			<div className="mem-tabs" role="tablist">
				<button type="button" role="tab" aria-selected={tab === "overview"} className={tab === "overview" ? "active" : ""} title="What each room knows" onClick={() => setTab("overview")}>Overview</button>
				<button type="button" role="tab" aria-selected={tab === "hivemind"} className={tab === "hivemind" ? "active" : ""} title="Ask questions across all your rooms' memory" onClick={() => setTab("hivemind")}>HiveMind</button>
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
									<button type="button" className={askMode === "ask" ? "active" : ""} aria-pressed={askMode === "ask"} title="Ask a question — the AI answers from memory" onClick={() => setAskMode("ask")}>Ask</button>
									<button type="button" className={askMode === "find" ? "active" : ""} aria-pressed={askMode === "find"} title="Search memory for exact text — local, no model" onClick={() => setAskMode("find")}>Find text</button>
								</div>
								<span className="mem-measured" style={{ color: "var(--muted)", borderColor: "var(--border)" }}>{askMode === "ask" ? `Read-only · ${scopeLabel}` : "Local · no model"}</span>
							</div>
						</div>
						<div className="chart-block">
							<div className="sub" style={{ marginBottom: 10 }}>{askMode === "ask" ? "Chat across the exxperts you pick. Answers are grounded in your memory, and cite the exxpert each fact comes from." : "Find exact text across every exxpert's memory. Local, no model."}</div>
							{askMode === "ask" && data.rooms.length > 1 && (
								<div className="mem-scope">
									<span className="mem-scope-label">Exxperts</span>
									<button type="button" className={`mem-scope-chip${scope.size === 0 ? " active" : ""}`} title="Answer from every room's memory" onClick={() => setScope(new Set())}>All exxperts</button>
									{data.rooms.map((r) => (
										<button key={r.id} type="button" className={`mem-scope-chip${scope.has(r.id) ? " active" : ""}`} title={`Include or exclude ${r.displayName}'s memory`} onClick={() => toggleScopeRoom(r.id)}>{r.displayName}</button>
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
										<strong>{digest.totals.newCheckpoints}</strong> new conversation{digest.totals.newCheckpoints === 1 ? "" : "s"} remembered
										{digest.totals.newReviews > 0 && <> and <strong>{digest.totals.newReviews}</strong> tidy{digest.totals.newReviews === 1 ? "" : " runs"}</>} across{" "}
										<strong>{digest.totals.roomsChanged}</strong> exxpert{digest.totals.roomsChanged === 1 ? "" : "s"}
										{digest.since > 0 && <> · in the last {fmtAgo(digest.since).replace(" ago", "")}</>}
									</div>
									{digest.rooms.length > 0 && (
										<div className="mem-digest-rooms">
											{digest.rooms.slice(0, 3).map((r) => (
												<button key={r.id} type="button" className="mem-digest-room" onClick={() => setSelected(r.id)}>
													<span className="mem-digest-room-name">{r.displayName}</span>
													<span className="mem-digest-room-meta">
														{r.newCheckpoints} conversation{r.newCheckpoints === 1 ? "" : "s"}
														{r.newReviews > 0 && <>, {r.newReviews} tidy{r.newReviews === 1 ? "" : " runs"}</>}
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
							<div className="sub">{allRoomsFactsLine({ rooms: t.rooms, notes: t.notes, waiting })}</div>
							<div className="mem-comp-legend mem-glance-legend">
								<span><span className="sw durable" />{MEMORY_TAB_LEGEND[0]}</span>
								<span><span className="sw items" />{MEMORY_TAB_LEGEND[1]}</span>
								<span><span className="sw recent" />{MEMORY_TAB_LEGEND[2]}</span>
							</div>
						</div>
					</section>

					{onMaintain && data.rooms.some((r) => r.needsAbsorb) && (
						<section className="dash-section">
							<div className="mem-absorb-callout">
								<div className="mem-absorb-body">
									<div className="mem-digest-title">Ready to memorize</div>
									<div className="sub">These rooms have remembered conversations waiting to become notes. Memorize turns them into lasting notes and shows you what it keeps before anything is saved.</div>
								</div>
								<div className="mem-absorb-rooms">
									{data.rooms.filter((r) => r.needsAbsorb).map((r) => {
										const blocked = maintainBlocked?.(r.id) ?? null;
										return (
											<button key={r.id} type="button" className="mem-review-btn" disabled={!!blocked} title={blocked ?? `Turn ${r.displayName}'s remembered conversations into notes`} onClick={() => onMaintain({ agentId: r.id, displayName: r.displayName })}>
												{r.displayName}: memorize →
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
										<div className="mem-card-head"><div className="mem-card-name">{r.displayName}</div>{r.needsAbsorb && <span className="mem-pill">to memorize</span>}</div>
										<MemoryFullBar room={r} />
										<div className="mem-card-facts">{roomMemoryFactsLine({ notes: r.notes, waiting: r.sessions, lastMemorizedAt: r.lastCheckpointAt })}</div>
										<div className="mem-card-foot">
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
										    conversation waits, ready to memorize when Memorize is due,
										    and no chip at all for a settled room. */}
										{detail.standbyThread
											? <span className="mem-pill" title="This room has a conversation parked to resume.">standby</span>
											: detail.needsAbsorb
												? <span className="mem-pill" title="Remembered conversations are waiting to become notes.">ready to memorize</span>
												: null}
									</div>
									{detail.description && <div className="sub">{detail.description}</div>}
									{(() => {
										// Today's facts, led by the day the room's memory began: its
										// first recorded save, when there is one.
										const facts = roomMemoryFactsLine({ notes: detail.notes, waiting: detail.sessions, lastMemorizedAt: detail.lastCheckpointAt });
										const since = detail.series[0]?.ts;
										return <div className="sub mem-detail-strip">{since ? inMemorySinceLine(since, facts) : facts}</div>;
									})()}
								</div>
								{/* The state pill carries the why (tooltip), so no note here. */}
								<div className="mem-detail-actions">
									{/* This page is the cross-room view; editing a note belongs to
									    the room, so the link hands the person over to its pane. */}
									{onOpenMemorySettings && (
										<button type="button" className="mem-review-btn" title="Open this room's memory settings, where you can read, edit, restore and undo" onClick={() => onOpenMemorySettings({ agentId: detail.id, displayName: detail.displayName })}>
											{OPEN_IN_ROOM_SETTINGS_LABEL} →
										</button>
									)}
									{onMaintain && (() => {
										const blocked = maintainBlocked?.(detail.id) ?? null;
										return (
											<button type="button" className="mem-review-btn" disabled={!!blocked} title={blocked ?? "Open Maintain to turn this room's waiting conversations into notes, or to tidy the notes it has. You approve changes before they are saved."} onClick={() => onMaintain({ agentId: detail.id, displayName: detail.displayName })}>
												Maintain →
											</button>
										);
									})()}
									<button type="button" className="mem-close" onClick={() => setSelected(null)}>Close ×</button>
								</div>
							</div>
							<div className="mem-detail-full"><MemoryFullBar room={detail} /></div>

							{asOf !== null && (
								<div className="mem-tt-banner mem-tt-banner-global">
									<span>{snap?.state === "error" ? ASOF_ERROR : !past ? ASOF_READING : asOfSentence(asOf, past.boundaryTs)}</span>
									<button type="button" className="mem-close" onClick={leaveAsOf}>{BACK_TO_TODAY_LABEL}</button>
								</div>
							)}

							<div className="chart-block mem-detail-graph">
								<div className="chart-head"><h2>Memory growth</h2></div>
								{detail.series.length >= 2 && <div className="sub" style={{ marginBottom: 8 }}>{GROWTH_SUB}</div>}
								{detail.series.length >= 2 ? (
									<>
										<MemoryGrowthChart series={detail.series} budgetTokens={detail.memoryLimit?.budgetTokens ?? null} height={300} markerTs={asOf} onPick={setAsOf} />
										<div className="mem-comp-legend" style={{ marginTop: 8 }}>
											<span><span className="sw" style={{ background: "var(--fg)", opacity: 0.35 }} />Lasting notes</span>
											<span><span className="sw" style={{ background: "var(--exx-plan)" }} />Remembered conversations</span>
											<span><span className="mem-dot cp" />Remember</span>
											<span><span className="mem-dot learn" />Memorize</span>
											<span><span className="mem-dot review" />Review</span>
											{detail.memoryLimit && detail.memoryLimit.budgetTokens > 0 && <span><span className="sw budget" />Budget</span>}
										</div>
									</>
								) : <div className="sub">No saves yet.</div>}
								{(() => {
									const lastLearn = [...detail.series].reverse().find((s) => s.kind === "absorb");
									if (!lastLearn && !detail.lastReviewAt) return null;
									return (
										<div className="sub" style={{ marginTop: 8 }}>
											{lastLearn && <>Last memorized {fmtAgo(lastLearn.ts)}.</>}
											{detail.lastReviewAt && <>{lastLearn ? " " : ""}Last memory review {fmtAgo(detail.lastReviewAt)}.</>}
										</div>
									);
								})()}
							</div>

							<div className="chart-grid">
								<div className="chart-block">
									<div className="dash-section-head" style={{ marginBottom: 0 }}>
										<div className="chart-head mem-head-row"><h2>{TOPICS_PANEL_TITLE}</h2>{asOf !== null && <span className="mem-asof">{asOfChip(asOf)}</span>}</div>
										<div className="mem-panel-actions">
											<button type="button" className="mem-close" title="Read everything this room carries into a conversation" onClick={openFullMemory}>Full memory →</button>
										</div>
									</div>
									<div className="sub" style={{ marginBottom: 6 }}>{TOPICS_PANEL_SUB}</div>
									{(() => {
										// Today's topics, or the ones the viewed moment's copy holds;
										// while that copy is still being read, the list waits empty
										// rather than showing today's under a past date.
										const topicRows: TopicRow[] = asOf === null ? detail.memoryTopics : (past?.topics ?? []);
										const settled = asOf === null || past !== null;
										return (
											<>
												{settled && topicRows.length === 0 && <div className="sub">{TOPICS_PANEL_EMPTY}</div>}
												{topicRows.map((row) => {
													const name = memoryTopicName(row.topic);
													const isOpen = panel?.kind === "area" && !panel.full && panel.area === name;
													// The open topic's row closes it again: the panel returns to its
													// resting state, today's waiting list or the viewed moment's full memory.
													const toggleTopic = () => { if (isOpen) { panelReq.current++; setPanel(null); } else openTopic(row); };
													return (
														<div
															key={`${row.section}-${row.topic}`}
															role="button"
															tabIndex={0}
															aria-pressed={isOpen}
															className={`bar-row bar-row-static mem-map-row${isOpen ? " mem-map-sel" : ""}`}
															onClick={toggleTopic}
															onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleTopic(); } }}
														>
															<div className="name">{topicRowLine(name, row.notes)}</div>
														</div>
													);
												})}
											</>
										);
									})()}
								</div>
								<div className="chart-block mem-reading-block">
									{(() => {
										// The reading panel: the waiting conversations by default, one
										// topic's text, or the stored conversation behind a receipt. One
										// body, rendered inline here and again inside the
										// full-screen overlay when expanded.
										// While a past moment is viewed, every panel carries its chip, and
										// Back returns to that moment's full memory (the panel's resting
										// state then), which itself has nowhere to go back to.
										const panelHead = (title: string, caption: string, back = true) => (
											<>
												<div className="dash-section-head" style={{ marginBottom: 0 }}>
													<div className="chart-head mem-head-row"><h2>{title}</h2>{asOf !== null && <span className="mem-asof">{asOfChip(asOf)}</span>}</div>
													<div className="mem-panel-actions">
														<button type="button" className="mem-close" onClick={() => setPanelFull(!panelFull)}>{panelFull ? "Exit full screen" : "Full screen ⤢"}</button>
														{back && <button type="button" className="mem-close" onClick={() => { panelReq.current++; setPanel(null); }}>Back ×</button>}
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
												{panelHead(panel.area, panel.full ? FULL_MEMORY_PANEL_SUB : topicPanelSub(panel.area))}
												<div className="mem-area-content md assistant-markdown">
													<MarkdownRenderer>{panel.content || (panel.full ? "*This room has no notes yet.*" : "*This topic is empty right now.*")}</MarkdownRenderer>
												</div>
											</>
										) : asOf !== null ? (
											<>
												{/* The resting panel of a past moment is its full memory; the
												    waiting list is today's and stays out of this mode. */}
												{panelHead("Full memory", FULL_MEMORY_PANEL_SUB, false)}
												{snap?.state === "error" ? (
													<div className="sub">{ASOF_ERROR}</div>
												) : !past ? (
													<div className="sub">{ASOF_READING}</div>
												) : (
													<div className="mem-area-content md assistant-markdown">
														<MarkdownRenderer>{past.content || "*This room has no notes yet.*"}</MarkdownRenderer>
													</div>
												)}
											</>
										) : (
											<>
												<div className="dash-section-head" style={{ marginBottom: 0 }}>
													<div className="chart-head mem-head-row"><h2>{WAITING_PANEL_TITLE}</h2></div>
													<div className="mem-panel-actions">
														<button type="button" className="mem-close" onClick={() => setPanelFull(!panelFull)}>{panelFull ? "Exit full screen" : "Full screen ⤢"}</button>
													</div>
												</div>
												<div className="sub" style={{ marginBottom: 6 }}>{WAITING_PANEL_SUB}</div>
												{detail.recentSessions.length === 0 && (
													<div className="sub">{detail.checkpoints > 0 ? WAITING_PANEL_EMPTY : WAITING_PANEL_NONE_YET}</div>
												)}
												<div className="mem-learned">
													{detail.recentSessions.map((s, i) => (
														<div key={i} className="mem-li">
															<div className="mem-li-txt">{s.title}</div>
															<div className="mem-li-src">
																{s.ts ? (s.tsPrecise ? fmtAgo(s.ts) : fmtAgoDay(s.ts)) : "saved"}
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
																// record proves: the exact time it passed the gate —
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
																			saved to memory {fmtWhen(s.approvedAt)} through Remember
																			{s.conversation && s.checkpointId && (
																				<>
																					{" · "}
																					<button type="button" className="mem-prov-link" onClick={() => openConversation(s)}>{OPEN_CONVERSATION_LABEL}</button>
																				</>
																			)}
																		</div>
																	)}
																</div>
															)}
														</div>
													))}
												</div>
												{(() => {
													// The conversations already turned into notes, under the
													// waiting ones. Each opens as it was stored while its file
													// still exists; the fold stays away when there are none.
													const memorized = (conversations ?? []).filter((c) => !c.waiting);
													if (memorized.length === 0) return null;
													return (
														<details className="mem-memorized">
															<summary>{memorizedConversationsTitle(memorized.length)}</summary>
															<div className="sub" style={{ marginBottom: 6 }}>{MEMORIZED_SUB}</div>
															<div className="mem-learned">
																{memorized.map((c) => (
																	<div key={c.checkpointId} className="mem-li">
																		<div className="mem-li-txt">{c.title}</div>
																		<div className="mem-li-src">
																			{fmtKeptDay(c.approvedAt)}
																			{" · "}
																			{c.conversation
																				? <button type="button" className="mem-prov-link" onClick={() => openConversation(c)}>{OPEN_CONVERSATION_LABEL}</button>
																				: <span className="mem-memorized-gone">{CONVERSATION_GONE}</span>}
																		</div>
																	</div>
																))}
															</div>
														</details>
													);
												})()}
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
							{(() => {
								// The same rows Room settings lists, in the same words, with
								// nothing to press: this page is the cross-room reading of a
								// room's memory, and taking a save back belongs beside the
								// notes it would put back.
								const rows = memoryHistoryRows(detail.history ?? []);
								if (rows.length === 0) return null;
								return (
									<div className="chart-block mem-history">
										<div className="dash-section-head" style={{ marginBottom: 0 }}>
											<div className="chart-head"><h2>History</h2></div>
											{onOpenMemorySettings && (
												<div className="mem-panel-actions">
													<button type="button" className="mem-close" onClick={() => onOpenMemorySettings({ agentId: detail.id, displayName: detail.displayName })}>{OPEN_IN_ROOM_SETTINGS_LABEL} →</button>
												</div>
											)}
										</div>
										<div className="sub" style={{ marginBottom: 6 }}>{MEMORY_TAB_HISTORY_SUB}{asOf !== null ? HISTORY_ASOF_TAIL : ""}</div>
										{(histAll ? rows : rows.slice(0, 10)).map((row, i, shown) => (
											<div key={row.key} className={`mem-hist-item${asOf !== null && row.ts > asOf ? " mem-hist-future" : ""}`}>
												{asOf !== null && row.ts <= asOf && (i === 0 || shown[i - 1].ts > asOf) && (
													<div className="mem-youare">{YOU_ARE_VIEWING_HERE}</div>
												)}
												<div className="mem-hist-row">
													<span className="mem-hist-date">{fmtMemoryMoment(row.ts)}</span>
													<span className="mem-hist-what">{row.words}</span>
													{row.undone && <span className="mem-hist-undone">undone</span>}
													{row.diffable && (
														<MemoryChangeFold roomId={detail.id} row={row} quiet="mem-close" open={changeOpen === `${detail.id}:${row.key}`} onToggle={() => setChangeOpen((open) => (open === `${detail.id}:${row.key}` ? null : `${detail.id}:${row.key}`))} />
													)}
												</div>
											</div>
										))}
										{rows.length > 10 && (
											<button type="button" className="mem-hist-more" onClick={() => setHistAll((v) => !v)}>
												{histAll ? "Show fewer" : `Show all ${rows.length}`}
											</button>
										)}
									</div>
								);
							})()}
						</section>
					)}
				</>
			)}

		</div>
	);
}
