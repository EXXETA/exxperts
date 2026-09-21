// Recall bench — the reusable pieces (memory v2, stream 41.4).
//
// The fold bench next door asks whether a fold is RIGHT. This one asks whether
// the room can still ANSWER afterwards: a fixture's conversations are
// Remembered into a real room's Recent Context and Memorized into its core
// notes through the product's own pipeline, and then, per question, the bench
// says WHERE the evidence ended up (core, archive, only in a conversation the
// room memorized, still waiting in Recent Context, or gone), whether the room's
// `memory_recall` tool FINDS it, and — next pass — whether the room answers
// right.
//
// Everything here is the machinery; the fixture is `recall-fixtures.mts`, the
// run and the tables are `recall-bench.mts`, and the LongMemEval adapter reuses
// these same exports. Two rules hold the file together:
//
//   - NOTHING is imitated. The room is scaffolded by
//     createPersistentAgentFromScaffoldInput, a Remember is a real approved
//     checkpoint write, a Memorize is a real absorb run and its approval, the
//     budget is the room's own setting through the real settings writer, and a
//     retrieval is the room's own recall tool executed in process. What the
//     bench scripts is only the MODEL: the fold replies come from the fold
//     bench's `exact` model, which answers with the operations the fixture
//     planted.
//   - The room's state modules read the home ONCE, when they are imported
//     (DEFAULT_PERSISTENT_ROOM_AGENTS_ROOT is a module-level const), so every
//     import of a state module here is a LAZY dynamic import behind
//     `stateModules()` and `prepareBenchHome` must be called before the first
//     engine call that touches a room. The type-only imports below are erased
//     at compile time and never evaluate a module.
//
// Offline: no server, no provider, no network, no port. Every run works in a
// temp home under os.tmpdir() and never reads or writes the real one.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { estimateTokens } from "../../src/token-estimate.js";
import type { ArchivedEntry, MemoryDocument, MemoryEntry } from "../../src/memory-entries.js";
import { NOTE_VALUE_WORDS, type ConflictNotePair } from "../../src/memory-duplicates.js";
import { exactFoldModel } from "./fold-models.mjs";
import { CONFLICT_SHAPES, stripRecallDirectives, type ConflictShape, type RecallAbility, type RecallPlant, type RecallQuestion, type RecallSession } from "./recall-fixtures.mjs";

// --- The bench's fixed points ------------------------------------------------

/**
 * The model lock the OFFLINE writes are stamped with — the thread a Remember
 * writes, the checkpoint it approves, the run a Memorize starts. Nothing calls
 * a provider for any of them; the lock is a record, and the record has to name
 * a model the room's active AI profile approves, or the product refuses the
 * write. So a run that later asks a REAL model sets this to that model first
 * (`setBenchModel`), and the default below is the scripted gateway's.
 */
export const BENCH_MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" } as const;

let currentBenchModel: { provider: string; model: string; label?: string } = { ...BENCH_MODEL };

/** The lock the offline writes stamp; set it before ingesting, never during. */
export function benchModel(): { provider: string; model: string; label?: string } {
	return currentBenchModel;
}

export function setBenchModel(lock: { provider: string; model: string; label?: string }): void {
	currentBenchModel = { ...lock };
}

/**
 * The room's memory budget for a bench run, and the back history it starts
 * with. Both numbers exist for one reason: the run must push the fixture's OWN
 * notes out to the archive by budget, not only by supersede, because "the note
 * was pushed out to make room" is the forgetting this bench is about.
 *
 * WHY A BACK HISTORY AT ALL. The product refuses a budget below 10k tokens
 * (MEMORY_BUDGET_MIN_TOKENS), and thirty conversations fold into one or two
 * thousand tokens of notes — two orders of magnitude under that floor — so no
 * budget a room may legally hold can be crossed by the fixture's material
 * alone. What crosses it is the room's BACK HISTORY: the notes a room that has
 * already been in use holds when the fixture's first conversation arrives.
 *
 * WHY ITS DATES ARE SPREAD. The demotion ranking leaves the least recently
 * touched note first (on the fixed sort of 0.12, outright; on the score that
 * replaced it, through the recency term, once use and kind and size are equal),
 * so a back history dated all on one old day is a block that is always shed
 * before anything the fixture planted — the budget would never reach the
 * fixture and the forgetting curve would be flat. The back history is therefore
 * spread EVENLY across a window that runs from thirty days before the first
 * conversation to the day of the last one, which puts its notes on the same
 * timeline as the folds: the budget then takes the oldest material of that
 * timeline, whichever it belongs to, and the earliest conversations' evidence
 * leaves alongside the back-history notes of the same weeks while the latest
 * conversations stay in core.
 *
 * WHY ITS NOTES ARE A LITTLE SMALLER THAN A PLANTED ONE. The score takes a
 * larger note before a smaller one worth the same, and a filler note two or
 * three times the size of a planted line would be shed first every time,
 * however old the planted line — the flat curve again, by size instead of by
 * date. So a back-history note is written just under the fixture's smallest
 * planted lines (about 21 estimated tokens against 18 to 38): the back history
 * never shelters a planted note behind its own bulk, the budget reaches the
 * fixture's notes by their dates, and under `--interleave` what keeps one of
 * them is whether the room looked it up.
 *
 * HOW THE SIZE IS PICKED. `backHistoryTokensFor` works it out from the run
 * rather than from a constant; the constant below is only the fallback for a
 * caller that seeds a room without a fixture. Write B for the budget and H for
 * the back history.
 * The first Memorize's pre-pass sheds H - B from the oldest end, and
 * `demoteToBudget` puts what a run just saved last, so each fold's own notes
 * are safe inside that fold and are ordinary material in the next one. The
 * fixture's notes are therefore only reached once the back history older than
 * the first fold's date is gone, which needs H - B to exceed the share of H
 * that lies before that date. Under that threshold the number of the fixture's
 * own notes in the archive barely moves with H (measured on the default
 * fixture: nine of them at 15k, 16k and 18k alike); over it the pre-pass clears
 * the whole older stretch in one step and every later fold eats into the
 * earliest conversations.
 *
 * The threshold is exact. The pre-pass leaves the NEWEST B tokens of the back
 * history standing, and the back history is spread evenly by count, so the
 * stretch newer than the first fold's date is (1-f)H, where f is that date's
 * place in the window. The fixture's notes are reached from the second fold on
 * exactly when (1-f)H >= B, which is H >= B/(1-f). `backHistoryTokensFor`
 * computes that with a margin. A run with only ONE fold is the case no H can
 * fix: a Memorize puts what it has just saved last, so its own notes are safe
 * inside it and there is no later fold to take them.
 */
export const DEFAULT_MEMORY_BUDGET_TOKENS = 10_000;
export const DEFAULT_BACK_HISTORY_TOKENS = 20_000;
/** How far before the first conversation the back history reaches back. */
export const DEFAULT_BACK_HISTORY_LEAD_DAYS = 30;
/** The topic the back history lives under; its notes never carry a fixture marker. */
export const BACK_HISTORY_TOPIC = "Background";
const BACK_HISTORY_MARKER = "BACKFILL";
/** Words per back-history note: just under the smallest planted line, so the filler never shelters a planted note by size. */
const BACK_HISTORY_NOTE_WORDS = 7;

/**
 * Where the evidence for a question sits once the room has been built.
 *
 * `none` and `gone` are kept apart on purpose. `none` is a question the fixture
 * planted NO evidence for — an abstention, whose right answer is "I don't
 * know"; nothing was ever there to lose. `gone` is a marker the fixture did
 * plant and no part of the room's memory carries any more, which is the fold
 * losing something. Filing the first under the second would make a column that
 * means "forgotten" read full on a run where nothing was forgotten at all.
 *
 * `conversation` is the fact the room was TOLD and never wrote down: no note
 * carries it, in the core or the archive, and nothing is waiting in Recent
 * Context — and the transcript the Remember closed and a Memorize folded still
 * says it, word for word. It is not forgetting: the room kept the conversation
 * and can read it back, but only by SEARCHING it, so it is the one place whose
 * answers are retrieval's alone.
 *
 * `dropped` is the same fact in a conversation the fold DROPPED whole: the
 * Remember wrote an entry, the Memorize judged that nothing in it outlived the
 * sitting and took no notes, and the transcript is all the room has of it.
 * It is kept apart from `conversation` because the product indexes the two
 * on different grounds (a folded conversation produced notes, a dropped one
 * produced none), so a table that merged them could not say which of the two
 * the search stopped reaching.
 */
export type EvidenceLocation = "core" | "archive" | "conversation" | "dropped" | "recent" | "gone" | "none";
export const EVIDENCE_LOCATIONS: readonly EvidenceLocation[] = ["core", "archive", "conversation", "dropped", "recent", "gone", "none"];

/** The column heading a location gets; `none` and `dropped` need words rather than their own name. */
export function locationLabel(location: EvidenceLocation): string {
	if (location === "none") return "no evidence";
	if (location === "dropped") return "conversation (no notes)";
	return location;
}

/** The three queries a question is retrieved with, in the fixture's own order. */
export type QueryKind = "literal" | "paraphrase" | "variant";
export const QUERY_KINDS: readonly QueryKind[] = ["literal", "paraphrase", "variant"];

/**
 * What one query reached, for one question: the row's 1-based position in the
 * results, `null` when the search came back without it, and `"n/a"` when the
 * question has no evidence recall has to answer for — nothing in the archive
 * and nothing left in a conversation alone, so nothing was asked of recall,
 * so the query neither found nor missed anything and the cell belongs in no
 * denominator. The three states are kept apart on purpose: a bench that wrote
 * "none" where it meant "never asked" would report the archive as failing at
 * questions the core answers without it.
 */
export type Rank = number | null | "n/a";
export const RANK_NOT_APPLICABLE = "n/a" as const;

// --- The temp home -----------------------------------------------------------

export interface BenchHome {
	/** The temp HOME every room of this run lives under. */
	home: string;
	/** The rooms root inside it. */
	root: string;
	/** Where a fixture thread's runtime keeps its session file; under the home, so it goes with it. */
	threadCwd: string;
}

let benchHome: BenchHome | null = null;

/**
 * The person's own home, read at import time — BEFORE `prepareBenchHome` puts
 * the temp one in the environment. A real-model run copies its provider records
 * out of here, and reading it later would read the temp home back.
 */
const realHomeDir = os.homedir();

/**
 * A temp HOME with the two AI-profile records a room's writes read, and the
 * environment the state modules will read when they are first imported. Call it
 * before anything else in this file; calling it twice hands back the same home.
 */
export function prepareBenchHome(label = "recall-bench"): BenchHome {
	if (benchHome) return benchHome;
	const home = fs.mkdtempSync(path.join(os.tmpdir(), `${label}-home-`));
	const appDir = path.join(home, ".exxperts", "app");
	fs.mkdirSync(appDir, { recursive: true });
	fs.writeFileSync(
		path.join(appDir, "openai-compatible-ai-profile.json"),
		JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: BENCH_MODEL.model }], maintenanceModel: BENCH_MODEL.model }, null, 2),
	);
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
	const root = path.join(appDir, "personalized-agents");
	const threadCwd = path.join(home, "thread-cwd");
	fs.mkdirSync(threadCwd, { recursive: true });
	process.env.HOME = home;
	process.env.USERPROFILE = home;
	process.env.EXXPERTS_CODING_AGENT_DIR = path.join(home, ".exxperts", "agent");
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;
	benchHome = { home, root, threadCwd };
	return benchHome;
}

function homeOrThrow(): BenchHome {
	if (!benchHome) throw new Error("prepareBenchHome() has to run before any room is touched: the state modules read the home when they are imported");
	return benchHome;
}

/**
 * The product modules the bench drives. Loaded once, on first use, so the temp
 * home is already in the environment when the rooms root is computed.
 */
async function stateModules() {
	homeOrThrow();
	return (loaded ??= load());
}

type StateModules = Awaited<ReturnType<typeof load>>;
let loaded: Promise<StateModules> | null = null;

async function load() {
	const absorbRun = await import("../../src/absorb-run.js");
	const absorbOps = await import("../../src/absorb-ops.js");
	const persistentAgents = await import("../../src/persistent-agents.js");
	const entries = await import("../../src/memory-entries.js");
	const store = await import("../../src/memory-entries-store.js");
	const settings = await import("../../src/persistent-room-maintenance-settings.js");
	const recallTool = await import("../../src/persistent-room-memory-recall-tool.js");
	const consolidation = await import("../../src/absorb-consolidation.js");
	const searchSources = await import("../../src/memory-search-sources.js");
	const duplicates = await import("../../src/memory-duplicates.js");
	return { absorbRun, absorbOps, persistentAgents, entries, store, settings, recallTool, consolidation, searchSources, duplicates };
}

// --- The room ----------------------------------------------------------------

export interface BenchRoom {
	roomId: string;
	roomDir: string;
	/** The budget the room was given, and the back history it was seeded with. */
	memoryBudgetTokens: number;
	backHistoryTokens: number;
	backHistoryNotes: number;
	/** The window the back history's dates were spread across; empty when none was seeded. */
	backHistoryFrom: string;
	backHistoryTo: string;
}

export interface CreateBenchRoomInput {
	/** The temp home from prepareBenchHome; passed in so a caller can never build a room in the real one by accident. */
	home: string;
	name?: string;
	memoryBudgetTokens?: number;
	/** 0 seeds no back history, and then nothing leaves the core by budget. */
	backHistoryTokens?: number;
	/**
	 * The window the back history's saved-on dates are spread across, evenly,
	 * oldest first. Build it from the fixture with `backHistoryWindow`; without
	 * it the back history is one undated block that the budget always sheds
	 * before the fixture's own notes.
	 */
	backHistoryWindow?: { from: string; to: string };
	/**
	 * Days no back-history note may be dated on: the days the folds run.
	 * `demoteToBudget` never takes a note saved on the run's OWN day, so a block
	 * of back history sharing a fold's date survives that fold whatever the
	 * budget says, and from then on sits permanently at the head of the demotion
	 * queue, absorbing every later fold's shed and shielding the fixture's own
	 * notes. Dating the back history off those days is what keeps the queue
	 * honest; the notes move one day earlier, so the timeline is unchanged.
	 */
	backHistoryAvoidDates?: readonly string[];
	/**
	 * Everything the fixture plants or accepts as an answer: its markers and
	 * every gold, trap and distractor spelling. The back history is filler whose
	 * only job is to be older and in the way, and a filler note that happened to
	 * carry one of these would answer a question by accident — a number the
	 * bench would then read as memory working. Nothing here may appear in it,
	 * and `createBenchRoom` throws if any does.
	 */
	forbiddenInBackHistory?: readonly string[];
	now?: Date;
}

/**
 * The window a fixture's back history is spread over: from `leadDays` before
 * the first conversation to the day of the last one. Nothing is dated after the
 * last conversation, so the back history can never outrank a folded note by
 * being newer than the whole timeline.
 */
export function backHistoryWindow(sessions: ReadonlyArray<{ date: string }>, leadDays = DEFAULT_BACK_HISTORY_LEAD_DAYS): { from: string; to: string } {
	const dates = sessions.map((session) => session.date).sort();
	const first = dates[0] ?? "2026-01-01";
	const last = dates[dates.length - 1] ?? first;
	return { from: shiftDays(first, -leadDays), to: last };
}

function shiftDays(date: string, days: number): string {
	return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
	return Math.round((Date.parse(`${to}T00:00:00.000Z`) - Date.parse(`${from}T00:00:00.000Z`)) / 86_400_000);
}

/**
 * How big the back history has to be for the budget to reach the fixture's own
 * notes: B / (1 - f), where f is the first fold's place in the window, times a
 * margin for the notes the folds add and for the unevenness of real session
 * dates. Clamped to between two and eight budgets — under two there is nothing
 * for the pre-pass to shed, and past eight the seeding write is large for no
 * further effect, which is what a run with a single fold would otherwise ask
 * for. `whyClamped` says when the number a run wanted was not the number it got.
 */
export function backHistoryTokensFor(input: { budgetTokens: number; window: { from: string; to: string }; firstFoldDate: string; margin?: number }): { tokens: number; fraction: number; whyClamped: string } {
	const span = Math.max(1, daysBetween(input.window.from, input.window.to));
	const fraction = Math.min(0.95, Math.max(0, daysBetween(input.window.from, input.firstFoldDate) / span));
	const wanted = Math.ceil((input.budgetTokens / (1 - fraction)) * (input.margin ?? 1.25));
	const floor = input.budgetTokens * 2;
	const ceiling = input.budgetTokens * 8;
	const tokens = Math.min(ceiling, Math.max(floor, wanted));
	const whyClamped = tokens === wanted ? "" : wanted > ceiling
		? `wanted ${wanted}, capped at eight budgets`
		: `wanted ${wanted}, raised to the two-budget floor`;
	return { tokens, fraction, whyClamped };
}

/**
 * A room the way the product makes one, with its memory budget set through the
 * real settings writer and a back history seeded through the real memory write.
 * The budget write also settles the room's budget question (the settle leaves a
 * budget the owner set alone), so nothing resizes it underneath the run.
 */
export async function createBenchRoom(input: CreateBenchRoomInput): Promise<BenchRoom> {
	const { root } = homeOrThrow();
	if (path.resolve(input.home) !== path.resolve(homeOrThrow().home)) throw new Error(`createBenchRoom was handed ${input.home}, and this run's home is ${homeOrThrow().home}`);
	const { persistentAgents, entries, store, settings } = await stateModules();
	const displayName = input.name ?? "Recall Bench Room";
	const created = persistentAgents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const roomId = created.agent.agentId;
	const roomDir = path.join(root, roomId);
	const memoryBudgetTokens = input.memoryBudgetTokens ?? DEFAULT_MEMORY_BUDGET_TOKENS;
	settings.writePersistentRoomMaintenanceSettings(roomId, { memoryBudgetTokens });

	const wanted = input.backHistoryTokens ?? DEFAULT_BACK_HISTORY_TOKENS;
	let backHistoryTokens = 0;
	let backHistoryNotes = 0;
	let backHistoryFrom = "";
	let backHistoryTo = "";
	if (wanted > 0) {
		const loadedDoc = store.loadMemoryDocument(roomId, { migrate: "in-memory", now: input.now ?? new Date() });
		const doc = entries.cloneDocument(loadedDoc.doc);
		const window = input.backHistoryWindow ?? { from: "2024-01-08", to: "2024-01-08" };
		const seeded = seedBackHistory(doc, wanted, window, new Set(input.backHistoryAvoidDates ?? []), entries);
		assertBackHistoryCarriesNothingOfTheFixture(seeded.seededTexts, input.forbiddenInBackHistory ?? []);
		store.writeMemoryDocument(roomId, seeded.doc, { why: "user_edit", snapshotLabel: "edit", operation: "add", now: input.now ?? new Date() });
		backHistoryTokens = seeded.tokens;
		backHistoryNotes = seeded.notes;
		backHistoryFrom = window.from;
		backHistoryTo = window.to;
	}
	return { roomId, roomDir, memoryBudgetTokens, backHistoryTokens, backHistoryNotes, backHistoryFrom, backHistoryTo };
}

/** The words the back history is written out of: a fixed list, indexed, so two runs seed the same bytes. */
const BACK_HISTORY_WORDS = [
	"quarterly", "handover", "supplier", "rollout", "invoice", "template", "calendar", "threshold",
	"onboarding", "retention", "signature", "workshop", "inventory", "forecast", "escalation", "dashboard",
	"milestone", "renewal", "attachment", "clearance", "provision", "allocation", "reminder", "checklist",
];

/**
 * The back history: plain factual notes under one topic, none pinned, none a
 * practice — so the demotion ranking judges them by their date alone. Notes are
 * added until the core render reaches `wantedTokens`, which is the one thing
 * that decides how many there are, and their saved-on dates are then spread
 * evenly across the window, oldest first. The dates live in the metadata
 * comment, which the context render strips, so dating a note costs it nothing
 * and the count is the same whatever window it is given.
 */
function seedBackHistory(doc: MemoryDocument, wantedTokens: number, window: { from: string; to: string }, avoid: ReadonlySet<string>, entries: StateModules["entries"]): { doc: MemoryDocument; tokens: number; notes: number; seededTexts: string[] } {
	let topic = doc.topics.find((candidate) => candidate.section === "Deep Memory" && candidate.title === BACK_HISTORY_TOPIC);
	if (!topic) {
		topic = { section: "Deep Memory", title: BACK_HISTORY_TOPIC, heading: `### ${BACK_HISTORY_TOPIC}`, intro: "", entries: [] };
		doc.topics.unshift(topic);
	}
	const seeded: MemoryEntry[] = [];
	while (entries.reviewTargetTokens(doc) < wantedTokens) {
		const count = seeded.length + 1;
		const number = doc.nextEntryNumber;
		doc.nextEntryNumber = number + 1;
		// Seven words come to about 21 estimated tokens with the marker, just
		// under the smallest planted line; see the note on size above the constants.
		const words = Array.from({ length: BACK_HISTORY_NOTE_WORDS }, (_, i) => BACK_HISTORY_WORDS[(count * 7 + i * 5) % BACK_HISTORY_WORDS.length]);
		const entry: MemoryEntry = {
			id: entries.formatEntryId(number),
			kind: "fact",
			saved: window.from,
			pinned: false,
			text: `- ${BACK_HISTORY_MARKER}-${String(count).padStart(4, "0")} ${words.join(" ")}.`,
		};
		topic.entries.push(entry);
		seeded.push(entry);
		if (seeded.length > 5_000) throw new Error("the back history never reached its size; the note shape or the token estimate changed");
	}
	const span = Math.max(0, Math.round((Date.parse(`${window.to}T00:00:00.000Z`) - Date.parse(`${window.from}T00:00:00.000Z`)) / 86_400_000));
	const last = Math.max(1, seeded.length - 1);
	seeded.forEach((entry, index) => {
		let day = Math.round((index * span) / last);
		while (day > 0 && avoid.has(shiftDays(window.from, day))) day -= 1;
		entry.saved = shiftDays(window.from, day);
	});
	return { doc, tokens: entries.reviewTargetTokens(doc), notes: seeded.length, seededTexts: seeded.map((entry) => entry.text) };
}

/**
 * The back history against the fixture's own words.
 *
 * Compared as WHOLE TOKENS after `normalizeForScoring`, which is the reading
 * the scorer judges an answer in — so a filler note that carried a gold value
 * in another spelling is caught here rather than quietly inflating a score
 * later, while a value that merely occurs inside a longer word is not. The
 * difference matters: a gold value of "3" is inside "BACKFILL-0003" as
 * characters and is not in it as a fact, and a check that could not tell the
 * two apart would refuse every back history there is.
 */
function assertBackHistoryCarriesNothingOfTheFixture(noteTexts: readonly string[], forbidden: readonly string[]): void {
	const wanted = forbidden.map((value) => ({ value, tokens: scoringTokens(value) })).filter((row) => row.tokens.length > 0);
	if (wanted.length === 0) return;
	for (const text of noteTexts) {
		const tokens = scoringTokens(text);
		const hit = wanted.find((row) => carriesTokenRun(tokens, row.tokens));
		if (hit) throw new Error(`the back history carries "${hit.value}", which the fixture plants or accepts as an answer: ${text.slice(0, 120)}`);
	}
}

/** One text as the scorer reads it, split into whole words and numbers. */
function scoringTokens(text: string): string[] {
	return normalizeForScoring(text).match(SCORING_TOKEN) ?? [];
}

/**
 * One token: a whole ISO date, or a run of letters and digits. The date comes
 * first and stays in one piece, because a date split into "2026", "05" and "19"
 * would answer a question whose gold value is 19.
 */
const SCORING_TOKEN = /\d{4}-\d{2}-\d{2}|[\p{L}\p{N}]+/gu;

/** Where these tokens occur in that order, side by side, in the haystack; -1 when they do not. */
function tokenRunIndex(haystack: readonly string[], needle: readonly string[]): number {
	if (needle.length === 0 || needle.length > haystack.length) return -1;
	for (let at = 0; at + needle.length <= haystack.length; at++) {
		let all = true;
		for (let i = 0; i < needle.length; i++) if (haystack[at + i] !== needle[i]) { all = false; break; }
		if (all) return at;
	}
	return -1;
}

/** Whether these tokens occur in that order, side by side, in the haystack. */
function carriesTokenRun(haystack: readonly string[], needle: readonly string[]): boolean {
	return tokenRunIndex(haystack, needle) >= 0;
}

// --- Remember and Memorize ---------------------------------------------------

/** One conversation into the room's Recent Context. Returns the Recent Context id the write assigned. */
export type RememberFn = (input: { roomId: string; session: RecallSession; now: Date }) => Promise<{ rcId: string }>;

/** One Memorize over everything waiting in Recent Context, approved. */
export type MemorizeFn = (input: { roomId: string; now: Date; directiveBlockFor: (rcId: string) => string | undefined }) => Promise<MemorizeOutcome>;

export interface MemorizeOutcome {
	/** The Recent Context ids the run was given, in the order it folded them. */
	sessions: string[];
	/**
	 * What the run made of each of them, in the run's own words: `folded`,
	 * `dropped`, `skipped` or `failed`. A folded and a dropped conversation
	 * were both memorized, which is what the claim audit counts; the other two
	 * are still waiting in Recent Context.
	 */
	outcomes: Array<{ id: string; outcome: string }>;
	folded: number;
	skipped: number;
	/**
	 * The conversations the memory refused, with the sentence the card shows.
	 * Against a scripted model that answers with the planted operations, a
	 * refusal is the FIXTURE's problem — a planted note the memory cannot
	 * accept — so it is reported rather than thrown: the run carries on, the
	 * conversation stays in Recent Context where a refused fold leaves it, and
	 * the caller decides what a disagreement costs. `RECALL_BENCH_DUMP=1`
	 * prints what was refused, in the memory's own words.
	 */
	failures: Array<{ id: string; reason: string }>;
	/** Operations the folds actually applied, summed over the run's sessions. */
	opsApplied: number;
	/**
	 * Adds the memory refused as a repeat of a note it already holds, which the
	 * scripted fold then left out of its second answer, the way the refusal
	 * asks. A real fold's own retry is the model's business and counts nothing
	 * here.
	 */
	twinsRefused: number;
}

/** The directive lines a session carries, and the body line each one is about. */
function directiveBlockOf(session: RecallSession): string {
	const lines = session.recentContextEntry.split(/\r\n?|\n/);
	const block: string[] = [];
	for (let i = 0; i < lines.length; i++) {
		if (!DIRECTIVE_LINE.test(lines[i])) continue;
		block.push(lines[i].trim());
		for (let j = i + 1; j < lines.length; j++) {
			if (!lines[j].trim() || DIRECTIVE_LINE.test(lines[j])) continue;
			block.push(lines[j].trimEnd());
			break;
		}
	}
	// A conversation that plants nothing is a conversation that changes nothing:
	// the scripted fold is told to drop it, which is what a fold of small talk
	// does and what keeps a plantless session from reading as a refusal.
	if (block.length === 0) return `<!-- plant: id=${session.id} op=drop reason="nothing in this conversation outlives it" -->\n- Nothing durable.`;
	return block.join("\n");
}

const DIRECTIVE_LINE = /^\s*<!--\s*plant:/;

/**
 * THE ONE PLACE the directives and the product part company. The checkpoint
 * gate refuses an approved Recent Context entry that carries an HTML comment,
 * on purpose — a hidden rc_metadata line would be a forged receipt — so the
 * fixture's `<!-- plant: ... -->` lines can never reach the room's memory. The
 * entry is written through the fixture's own `stripRecallDirectives`, and the
 * directives are handed to the SCRIPTED FOLD instead, on its prompt: the same
 * split the fold bench makes between its annotated and its plain sessions.
 */

/** The conversation id one fixture session is remembered under; derived from its own id, so two runs of one seed write the same records. */
function conversationIdOf(session: RecallSession): string {
	// Prefixed because a thread id is at least eight characters.
	return `c_recall_${session.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

/**
 * The conversation itself, on a thread whose SESSION FILE holds the turns —
 * the same shape a person's conversation has.
 *
 * It matters beyond tidiness. A checkpoint event names the session file of the
 * conversation it closed, and that name is how the room's search reaches a
 * folded transcript at all; a thread written with display items alone leaves
 * the event without one, and every conversation of the run is then unsearchable
 * — which would make the `conversation` location impossible to reach and the
 * bench blind to the difference between a fact the room kept and one it lost.
 * The turns go in through the product's own session manager, so the transcript
 * the search reads is the transcript the compressor read.
 */
async function writeConversationThread(input: { roomId: string; conversationId: string; session: RecallSession; model: { provider: string; model: string; label?: string }; now: Date }): Promise<Array<{ kind: string; id: string; text: string }>> {
	const { persistentAgents } = await stateModules();
	const { threadCwd } = homeOrThrow();
	const items = input.session.turns.map((turn, index) => ({ kind: turn.role === "user" ? "user" : "assistant", id: `${turn.role[0]}${index + 1}`, text: turn.text }));
	const write = persistentAgents.writePersistentAgentThread(
		input.roomId,
		input.conversationId,
		{ state: "active", origin: "home", model: input.model, items },
		{ createRuntime: ({ model }) => persistentAgents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: input.roomId, threadId: input.conversationId, model, cwd: threadCwd }) },
	);
	if (write.thread.runtime.kind !== "pi-session-jsonl") throw new Error(`${input.conversationId} was written without a session file, so nothing could ever search its transcript`);
	const manager = persistentAgents.openPersistentAgentPiSessionManager(input.roomId, write.thread.runtime, threadCwd);
	input.session.turns.forEach((turn, index) => {
		// The session's own clock, a millisecond per turn: two runs of one seed
		// write the same file, which a wall clock would not.
		const timestamp = input.now.getTime() + index;
		if (turn.role === "user") {
			manager.appendMessage({ role: "user", content: turn.text, timestamp } as any);
			return;
		}
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: turn.text }],
			api: "responses" as any,
			provider: input.model.provider as any,
			model: input.model.model,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp,
		} as any);
	});
	return items;
}

/**
 * A Remember, through the real checkpoint write: a thread carrying the
 * conversation's turns, a checkpoint proposal built from the memory file as it
 * stands, and the approved entry written the way the product writes it — the
 * next Recent Context id, the rc_metadata provenance line, the Chronos stamp.
 * The conversation id is derived from the session id, so two runs of one seed
 * write the same records.
 */
export const scriptedRemember: RememberFn = async ({ roomId, session, now }) => {
	const { persistentAgents, consolidation } = await stateModules();
	const { threadCwd } = homeOrThrow();
	const conversationId = conversationIdOf(session);
	const items = await writeConversationThread({ roomId, conversationId, session, model: benchModel(), now });
	const l1b = readL1b(roomId);
	const source = persistentAgents.buildPersistentAgentCheckpointTranscriptSource({ agentId: roomId, conversationId, l1b, legacyItems: items, runtimeCwd: threadCwd }).source;
	const approvedRecentContext = stripRecallDirectives(session.recentContextEntry);
	const parsed = persistentAgents.parseCheckpointApprovalRequest(
		{ conversationId, model: benchModel(), density: "compact", proposal: { agentId: roomId, conversationId, sessionId: null, writesMemory: false, source }, approvedRecentContext },
		roomId,
	);
	persistentAgents.writeApprovedCheckpoint(parsed.request, parsed.warnings, now, { runtimeCwd: threadCwd });
	// The write assigned the id; the newest block of Recent Context is this one.
	const blocks = consolidation.recentContextSessions(consolidation.extractRecentContextForAbsorb(readL1b(roomId)).recentContext);
	const rcId = blocks[blocks.length - 1]?.id;
	if (!rcId) throw new Error(`the Remember of ${session.id} left nothing in Recent Context`);
	return { rcId };
};

/** The section separator the fold prompt is assembled with; the scripted model reads its sections back the same way. */
const PROMPT_SECTION_SPLIT = "\n\n---\n\n";
const SESSION_MATERIAL_HEADING = "## Material: The Session To Fold";

/** Which Recent Context entry this fold prompt is about, read off the prompt's own material. */
function sessionIdFromPrompt(prompt: string): string {
	const parts = prompt.split(PROMPT_SECTION_SPLIT);
	const material = parts.find((part) => part.trimStart().startsWith(SESSION_MATERIAL_HEADING));
	if (!material) throw new Error(`the fold prompt carries no "${SESSION_MATERIAL_HEADING}" section`);
	const id = /^###\s+(RC-[A-Za-z0-9_-]+)/m.exec(material)?.[1];
	if (!id) throw new Error(`the fold prompt's session material carries no "### RC-" heading: ${material.slice(0, 160)}`);
	return id;
}

/** The prompt with this session's plant directives appended to its material, where the scripted model reads them. */
function promptWithDirectives(prompt: string, directiveBlockFor: (rcId: string) => string | undefined): string {
	const parts = prompt.split(PROMPT_SECTION_SPLIT);
	const at = parts.findIndex((part) => part.trimStart().startsWith(SESSION_MATERIAL_HEADING));
	const rcId = sessionIdFromPrompt(prompt);
	const block = directiveBlockFor(rcId);
	if (!block) throw new Error(`the run asked to fold ${rcId}, which this bench has no planted operations for`);
	parts[at] = `${parts[at].trimEnd()}\n\n${block}\n`;
	return parts.join(PROMPT_SECTION_SPLIT);
}

const RETRY_NOTICE_HEADING = "## Retry Notice";
/** A refusal that calls an add a repeat: `op 3 (add): this says what note "m-0031" under "Topic" already says …`, or what an earlier add of the same reply already says. */
const TWIN_REFUSAL_LINE = /^-\s*op (\d+) \(add\): .*already says/;
const JSON_FENCE = /```json\n([\s\S]*?)\n```/;

/**
 * The scripted fold's answer to a Retry Notice, the way the refusal asks. An
 * add the memory refused as a repeat of a note it already holds is left out
 * of the second reply and everything else is answered as before: the fixture
 * planted the sentence twice on purpose, and leaving the second out is what a
 * fold that reads its refusal does. Every other refusal is answered as before,
 * so a fixture the memory genuinely disagrees with still fails twice and is
 * reported. A reply whose every operation was a repeat drops the session,
 * which is the one shape a fold with nothing left to say may take.
 */
function answerTwinRefusals(prompt: string, reply: string): { reply: string; leftOut: number } {
	const notice = prompt.indexOf(RETRY_NOTICE_HEADING);
	if (notice < 0) return { reply, leftOut: 0 };
	const refused = new Set<number>();
	for (const line of prompt.slice(notice).split(/\r?\n/)) {
		const match = TWIN_REFUSAL_LINE.exec(line.trim());
		if (match) refused.add(Number(match[1]) - 1);
	}
	if (refused.size === 0) return { reply, leftOut: 0 };
	const fence = JSON_FENCE.exec(reply);
	if (!fence || fence.index === undefined) return { reply, leftOut: 0 };
	const parsed = JSON.parse(fence[1]) as { ops?: unknown[] };
	const before = Array.isArray(parsed.ops) ? parsed.ops : [];
	const kept = before.filter((_, index) => !refused.has(index));
	const leftOut = before.length - kept.length;
	if (leftOut === 0) return { reply, leftOut: 0 };
	const ops = kept.length > 0 ? kept : [{ op: "drop", reason: "everything this conversation settled is in memory already" }];
	const narrative = reply.slice(0, fence.index).trimEnd();
	return { reply: `${narrative}\n\n\`\`\`json\n${JSON.stringify({ ops }, null, 2)}\n\`\`\``, leftOut };
}

/** The states a run is still working in; the client polls exactly these. */
const WORKING_RUN_STATES = new Set(["prepass", "folding", "budget"]);

/**
 * A Memorize, through the real run and the real approval: one fold call per
 * waiting conversation, the budget pass, then one write. The only scripted part
 * is the reply, which is the fold bench's `exact` model answering with the
 * operations the fixture planted.
 */
export const scriptedMemorize: MemorizeFn = async ({ roomId, now, directiveBlockFor }) => {
	const { absorbRun } = await stateModules();
	let twinsRefused = 0;
	const started = absorbRun.startAbsorbRun({
		agentId: roomId,
		assessmentMarkdown: BENCH_ASSESSMENT,
		guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: [] },
		model: benchModel(),
		generate: async (prompt: string) => {
			// RECALL_BENCH_DUMP=1: what the memory refused, in its own words. A
			// refusal only ever shows up as a failed session otherwise, and the
			// reason a fixture's planted operation was refused is the fixture's
			// business rather than the room's.
			if (process.env.RECALL_BENCH_DUMP && prompt.includes("## Retry Notice")) {
				console.log(`\n--- ${sessionIdFromPrompt(prompt)} was refused ---\n${prompt.slice(prompt.indexOf("## Retry Notice"))}`);
			}
			const answered = answerTwinRefusals(prompt, exactFoldModel(promptWithDirectives(prompt, directiveBlockFor)));
			twinsRefused += answered.leftOut;
			return { text: answered.reply };
		},
		now: () => now,
	});
	return settleAndApprove({ absorbRun, roomId, runId: started.runId, now, timeoutMs: 120_000, twinsRefused: () => twinsRefused });
};

/**
 * The half of a Memorize that is the same whoever answered the folds: poll the
 * run the way the client polls it, approve it, and report what each
 * conversation came to. A refused conversation is a row, never a throw — it
 * stays in Recent Context, which is where a refused fold leaves it.
 */
async function settleAndApprove(input: { absorbRun: StateModules["absorbRun"]; roomId: string; runId: string; now: Date; timeoutMs: number; twinsRefused?: () => number }): Promise<MemorizeOutcome> {
	const { absorbRun, roomId, runId, now } = input;
	let run = absorbRun.getAbsorbRun(roomId, runId);
	const deadline = Date.now() + input.timeoutMs;
	// A fold that is waiting a provider out is not a Memorize that hangs: the
	// time the waiting took is added to the limit, so an hour's wait inside a
	// fold does not read as a run that never settled.
	const busyAtStart = providerBusyMs();
	const waitedAtStart = providerWaitedMs;
	const gaveUpAtStart = providerGaveUpCount;
	while (WORKING_RUN_STATES.has(run.state)) {
		if (Date.now() > deadline + (providerBusyMs() - busyAtStart)) {
			const sentence = `the Memorize of ${roomId} was still in state "${run.state}" after ${Math.round(input.timeoutMs / 1000)} seconds`;
			// With provider trouble inside this Memorize, the limit reached is the
			// provider's failure, not the pipeline's: the instance is marked and
			// the run goes on.
			if (providerWaitedMs > waitedAtStart) {
				const gaveUp = new ProviderGaveUpError(`the Memorize of ${roomId}`, `${sentence} while the provider was being waited out`, 1);
				providerGaveUpCount += 1;
				lastProviderGiveUp = gaveUp;
				providerGaveUpInThisUnit = true;
				throw gaveUp;
			}
			throw new Error(sentence);
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
		run = absorbRun.getAbsorbRun(roomId, runId);
	}
	// The run itself turns a fold the provider gave up on into a conversation
	// left waiting and carries on, which is right for a person's room and wrong
	// for a measurement: a room missing the conversations of a provider's bad
	// hours would be scored as if it had been told them. So a give-up inside
	// this Memorize ends it unapproved, with the error the caller marks the
	// instance by.
	if (providerGaveUpCount > gaveUpAtStart && lastProviderGiveUp) throw lastProviderGiveUp;
	if (run.state !== "ready") throw new Error(`a Memorize whose folds are all answered ends ready for approval, and this one ended "${run.state}"${run.error ? `: ${run.error}` : ""}`);
	absorbRun.approveAbsorbRun(roomId, runId, now);
	const summed = run.sessions.reduce((total, session) => {
		const summary = session.summary;
		return total + (summary ? summary.added + summary.updated + summary.superseded + summary.closed : 0);
	}, 0);
	return {
		sessions: run.sessions.map((session) => session.id),
		outcomes: run.sessions.map((session) => ({ id: session.id, outcome: session.outcome })),
		folded: run.sessions.filter((session) => session.outcome === "folded").length,
		skipped: run.sessions.filter((session) => session.outcome === "skipped").length,
		failures: run.sessions
			.filter((session) => session.outcome === "failed")
			.map((session) => ({ id: session.id, reason: session.reason ?? "no reason given" })),
		opsApplied: summed,
		twinsRefused: input.twinsRefused?.() ?? 0,
	};
}

/** The assessment a Memorize's fold prompts carry: the person's first approval point, fixed for the bench. */
const BENCH_ASSESSMENT = [
	"## Absorb assessment",
	"",
	"Every waiting conversation is to be folded.",
	"",
	"### What to remember",
	"- Names, dates, numbers and decisions the person will ask about again.",
	"",
	"### What to forget",
	"- Small talk, tool trouble, and anything a later conversation replaced.",
	"",
	"### What changes in stable memory",
	"- Deep Memory: the newer state replaces the note that carries the older one.",
	"- Recent Context: every folded conversation leaves it.",
	"",
	"### Needs your judgment",
	"- None",
].join("\n");

// --- Ingest ------------------------------------------------------------------

export interface IngestStep {
	/** The session this fold ran after, in the fixture's order. */
	afterSession: string;
	/** The Recent Context ids this Memorize folded. */
	sessions: string[];
	folded: number;
	skipped: number;
	failed: number;
	opsApplied: number;
	/** Adds this Memorize refused as repeats and the scripted fold then left out. */
	twinsRefused: number;
	/** Rows in the room's archive after this fold, and how many of them left because of the budget. */
	archiveRows: number;
	archivedByBudget: number;
	/** The core's size after this fold, against the room's budget. */
	memoryTokens: number;
	notesInCore: number;
}

export interface IngestReport {
	remembered: number;
	/**
	 * The Recent Context id each fixture session was written as. The ids are the
	 * room's own, and the room starts counting again once a Memorize has emptied
	 * Recent Context — so two sessions folded by two different Memorizes can
	 * carry the same id, which is the file's truth and not a collision: an id is
	 * only ever asked about while its conversation is still waiting.
	 */
	rcIdBySession: Record<string, string>;
	steps: IngestStep[];
	foldEvery: number;
	/** Conversations the memory refused, across every fold of this ingest. */
	failures: Array<{ session: string; rcId: string; reason: string }>;
	/** Adds refused as repeats and left out, summed over every fold of this ingest. */
	twinsRefused: number;
	/** The claim audit, taken once after the last Memorize; both defect counts are zero on a sound pipeline. */
	claims: ClaimAudit;
}

/**
 * Whether the room's search index holds exactly the conversations the room
 * memorized, each under the conversation it was. `memorized` is the number of
 * conversations whose final outcome was folded or dropped: the room was told
 * them and a Memorize took them out of Recent Context, with notes or without.
 * `unindexed` are memorized conversations with no conversation document at
 * all, which a question can therefore never reach by searching. `misassigned`
 * are conversations the index holds under the wrong name: a document whose
 * conversation was never memorized, or whose Recent Context id is not the one
 * that conversation was Remembered under, which is a fold that took another
 * conversation's transcript. Both counts are defects of the pipeline, never
 * of the model, and the bench treats a non-zero one as a mechanical failure.
 */
export interface ClaimAudit {
	memorized: number;
	unindexed: number;
	misassigned: number;
}

/** The audit as one line: `claims: N memorized, N unindexed, N misassigned`. */
export function claimsLine(claims: ClaimAudit): string {
	return `claims: ${claims.memorized} memorized, ${claims.unindexed} unindexed, ${claims.misassigned} misassigned`;
}

/** Whether the audit found a defect: a memorized conversation the index lacks, or one it files under the wrong name. */
export function claimsFailed(claims: ClaimAudit): boolean {
	return claims.unindexed > 0 || claims.misassigned > 0;
}

/**
 * The audit, read off a FRESH corpus so the documents are the ones the last
 * Memorize left behind. `misassigned` counts conversations rather than chunks:
 * a long conversation filed under the wrong id is one wrong claim, however
 * many documents it was cut into.
 */
async function auditClaims(input: { roomId: string; sessions: readonly RecallSession[]; rcIdBySession: Record<string, string>; finalOutcomeBySession: ReadonlyMap<string, string> }): Promise<ClaimAudit> {
	const docs = (await roomCorpus(input.roomId, { fresh: true })).docs.filter((document) => document.source === "conversation");
	const rcIdByConversation = new Map<string, string>();
	for (const session of input.sessions) {
		const outcome = input.finalOutcomeBySession.get(session.id);
		if (outcome !== "folded" && outcome !== "dropped") continue;
		rcIdByConversation.set(conversationIdOf(session), input.rcIdBySession[session.id] ?? "");
	}
	const indexed = new Set<string>();
	const misassigned = new Set<string>();
	for (const document of docs) {
		const conversation = String(document.meta?.conversationId ?? "");
		const rcId = String(document.meta?.rcId ?? "");
		const expected = rcIdByConversation.get(conversation);
		if (expected !== undefined) indexed.add(conversation);
		if (expected === undefined || expected !== rcId) misassigned.add(`${rcId}@${conversation}`);
	}
	let unindexed = 0;
	for (const conversation of rcIdByConversation.keys()) if (!indexed.has(conversation)) unindexed += 1;
	return { memorized: rcIdByConversation.size, unindexed, misassigned: misassigned.size };
}

export interface IngestSessionsInput {
	roomId: string;
	sessions: readonly RecallSession[];
	remember?: RememberFn;
	memorize?: MemorizeFn;
	/** Memorize after every N conversations, and once more at the end. */
	foldEvery?: number;
	/** The clock a session's writes are stamped with; the default is the session's own date at 09:00Z. */
	now?: (session: RecallSession) => Date;
	/**
	 * Called after every Memorize, once its step is on record, with the ids of
	 * every conversation ingested so far. It is where a run that wants the room
	 * USED between folds — asked about what it holds, so the next fold's ranking
	 * has something to read — does the asking.
	 */
	afterFold?: (state: { ingestedSessionIds: string[]; step: IngestStep }) => Promise<void>;
}

/**
 * The room, built the way a person builds one: the conversations Remembered in
 * date order, and a Memorize every `foldEvery` of them and once more at the
 * end. Every write is stamped with the SESSION'S date, not today's, so the
 * saved-on and archived-on dates in the room are the fixture's — which is what
 * the temporal questions are asked against.
 *
 * THE STAMPS ARE STRICTLY INCREASING. A Remember is stamped at the later of
 * its session's own clock (the date at 09:00Z, or what `now` gives) and one
 * minute after the previous stamp; a Memorize one minute after the last
 * Remember it folds; the next Remember one minute after that Memorize. It
 * matters because a Recent Context id is handed out again once a Memorize
 * has emptied the section, and the index tells the uses of one id apart by
 * TIME: a Remember and a Memorize of one day that share a second let the
 * newest-checkpoint rule hand a fold another conversation's transcript, which
 * is what the first real run showed. The product now writes the conversation's
 * name into the fold record, and the fallback rule for records without a name
 * takes the oldest unclaimed Remember; the bench stops producing ties so that
 * fallback is exercised on a clean clock and the claim audit reads zero on the
 * pipeline rather than on luck. A day holds at most a few dozen stamps, so a
 * session's saved-on DAY never moves.
 */
export async function ingestSessions(input: IngestSessionsInput): Promise<IngestReport> {
	const remember = input.remember ?? scriptedRemember;
	const memorize = input.memorize ?? scriptedMemorize;
	const foldEvery = input.foldEvery ?? 7;
	const clock = input.now ?? ((session: RecallSession) => new Date(`${session.date}T09:00:00.000Z`));
	const ordered = [...input.sessions].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
	const rcIdBySession: Record<string, string> = {};
	const sessionByRcId = new Map<string, string>();
	const blockByRcId = new Map<string, string>();
	/** The last outcome any Memorize reported for each session; a session folded in a later step stays folded. */
	const finalOutcomeBySession = new Map<string, string>();
	const steps: IngestStep[] = [];
	const failures: IngestReport["failures"] = [];
	let sinceFold = 0;
	/** The last stamp written, in milliseconds; every later write is at least a minute after it. */
	let lastStampMs = Number.NEGATIVE_INFINITY;
	const STAMP_STEP_MS = 60_000;

	for (const [index, session] of ordered.entries()) {
		const now = new Date(Math.max(clock(session).getTime(), lastStampMs + STAMP_STEP_MS));
		lastStampMs = now.getTime();
		const { rcId } = await remember({ roomId: input.roomId, session, now });
		rcIdBySession[session.id] = rcId;
		sessionByRcId.set(rcId, session.id);
		blockByRcId.set(rcId, directiveBlockOf(session));
		sinceFold += 1;
		const last = index === ordered.length - 1;
		if (sinceFold < foldEvery && !last) continue;
		sinceFold = 0;
		// The fold is stamped a minute after the conversation that triggered it,
		// so a note's saved-on date is the day of the conversation it came from.
		const foldNow = new Date(lastStampMs + STAMP_STEP_MS);
		lastStampMs = foldNow.getTime();
		const outcome = await memorize({ roomId: input.roomId, now: foldNow, directiveBlockFor: (id) => blockByRcId.get(id) });
		for (const failure of outcome.failures) failures.push({ session: sessionByRcId.get(failure.id) ?? failure.id, rcId: failure.id, reason: failure.reason });
		for (const reported of outcome.outcomes) {
			const sessionId = sessionByRcId.get(reported.id);
			if (sessionId) finalOutcomeBySession.set(sessionId, reported.outcome);
		}
		const after = await roomSizes(input.roomId);
		const step: IngestStep = {
			afterSession: session.id,
			sessions: outcome.sessions,
			folded: outcome.folded,
			skipped: outcome.skipped,
			failed: outcome.failures.length,
			opsApplied: outcome.opsApplied,
			twinsRefused: outcome.twinsRefused,
			archiveRows: after.archiveRows,
			archivedByBudget: after.archivedByBudget,
			memoryTokens: after.memoryTokens,
			notesInCore: after.notesInCore,
		};
		steps.push(step);
		if (input.afterFold) await input.afterFold({ ingestedSessionIds: ordered.slice(0, index + 1).map((done) => done.id), step });
	}
	const claims = await auditClaims({ roomId: input.roomId, sessions: ordered, rcIdBySession, finalOutcomeBySession });
	return { remembered: ordered.length, rcIdBySession, steps, foldEvery, failures, twinsRefused: steps.reduce((total, step) => total + step.twinsRefused, 0), claims };
}

// --- Where the evidence sits -------------------------------------------------

function readL1b(roomId: string): string {
	const { root } = homeOrThrow();
	return fs.readFileSync(path.join(root, roomId, "L1b", "current.md"), "utf-8");
}

/** How a marker was found: by the reference code its sentence carries, or by the words of that sentence. */
export type LocatedBy = "code" | "wording";

export interface EvidenceLocationDetail {
	location: EvidenceLocation;
	/** null when the marker was not found at all. */
	how: LocatedBy | null;
	/** The note or entry that carried it, verbatim; absent when nothing did. */
	text?: string;
}

/** The words the product reads as a value: month and weekday names and negations, German and English, lowercased. */
const VALUE_WORDS = new Set(NOTE_VALUE_WORDS);

/** A number, or a word the product reads as a value: the tokens a supersede pair differs in. */
function isValueToken(word: string): boolean {
	return /^\d+$/.test(word) || VALUE_WORDS.has(word);
}

/**
 * A planted line's own distinctive words. The reference code is scaffolding a
 * careful model drops as noise, and the fact is what the room needed, so a note
 * that kept the point without the code still counts. Short words are ignored
 * because they carry no subject; the same rule the fold bench scores by.
 */
function distinctiveWords(text: string): string[] {
	return String(text ?? "")
		.toLowerCase()
		.replace(/\(ref [^)]*\)/g, "")
		.replace(/[^\p{L}\p{N} ]+/gu, " ")
		.split(/\s+/)
		// A NUMBER is kept whatever its length: it is short by nature and is often
		// the only thing two otherwise identical notes disagree about. A token
		// that mixes letters and digits is not a number — a reference code like
		// "REC-D07" splits into "rec" and "d07", and requiring "d07" would mean
		// requiring the very code a real fold drops. A month name, a weekday or
		// a negation is kept the same way: "Mai" is three letters and is the
		// whole difference between a note and the one that replaced it.
		.filter((word) => word.length >= 4 || isValueToken(word));
}

/** Whether a note says a planted line: nearly all of the line's distinctive words are in it. */
export function carriesWording(noteText: string, plantedLine: string): boolean {
	const wanted = distinctiveWords(plantedLine);
	if (wanted.length === 0) return false;
	const haystack = ` ${distinctiveWords(noteText).join(" ")} `;
	const has = (word: string) => haystack.includes(` ${word} `);
	// THE VALUES ALL HAVE TO BE THERE. Two notes of a supersede pair say the
	// same thing about the same subject and differ in one value — "the review
	// period is 12 months" against "the review period is 24 months", "renews on
	// 1 June" against "renews on 1 July", so on words alone they agree to four
	// fifths and the wrong one can be picked as the note a marker lives in. A
	// number is short, is dropped by the four-letter rule, and is the entire
	// difference; a month, a weekday or a negation is the same kind of word,
	// which is how the product itself tells a conflict from a duplicate. So
	// the values are kept whatever their length and every one of them must
	// match.
	const values = wanted.filter(isValueToken);
	if (values.some((value) => !has(value))) return false;
	const words = wanted.filter((word) => !isValueToken(word));
	if (words.length === 0) return values.length > 0;
	return words.filter(has).length / words.length >= 0.8;
}

/**
 * The room's own searchable corpus, through the product's own document layer:
 * its notes, its archived rows and the transcripts of the conversations it
 * memorized. `fresh` drops the cached one first, which is what a caller that
 * has just WRITTEN to the room wants — the cache is keyed on file mtimes, and
 * an mtime is a whole millisecond, so a read straight after a write can
 * otherwise answer out of the corpus the write invalidated.
 */
async function roomCorpus(roomId: string, options: { fresh?: boolean } = {}) {
	const { searchSources } = await stateModules();
	const { threadCwd } = homeOrThrow();
	if (options.fresh) searchSources.invalidateRoomCorpus(roomId);
	return searchSources.loadRoomCorpus(roomId, { runtimeCwd: threadCwd });
}

/** Only the memorized transcripts, folded and dropped alike: the documents a question can reach that no note carries. */
async function conversationCorpus(roomId: string, options: { fresh?: boolean } = {}) {
	return (await roomCorpus(roomId, options)).docs.filter((document) => document.source === "conversation");
}

/**
 * Model-free: the marker is looked for in the core's notes, in the archive's
 * rows, in the Recent Context entries no Memorize has folded yet, and last in
 * the conversations the room memorized. A marker the core still carries reads
 * `core` even when an older version of the same note is in the archive — the
 * room can read it without asking for anything. `conversation` is the fact the
 * room was told and never wrote down: no note anywhere says it and the folded
 * transcript still does. `gone` means no part of the room's memory carries it
 * any more, transcripts included.
 *
 * THE CODE IS NOT THE FACT. A scripted fold copies the planted sentence word
 * for word, so its reference code survives and the code alone finds it. A real
 * fold writes the point in its own words and drops the code, and a bench that
 * only looked for codes would report a memory that worked perfectly as a memory
 * that lost everything. So a marker no code finds is looked for again by the
 * distinctive words of the sentence that planted it, and the result says WHICH
 * of the two found it — `wording` is not a weaker answer, it is the answer for
 * a memory that paraphrased.
 */
export async function locateEvidenceInDetail(input: { roomId: string; markers: readonly string[]; plants?: readonly RecallPlant[] }): Promise<Record<string, EvidenceLocationDetail>> {
	const { entries, store } = await stateModules();
	const l1b = readL1b(input.roomId);
	const doc = entries.parseMemoryDocument(l1b);
	const coreNotes = doc.topics.flatMap((topic) => topic.entries.map((entry) => entry.text));
	const recentBlocks = doc.recentContext.split(/\n(?=###\s)/);
	const archiveNotes = store.readArchive(input.roomId).map((entry) => entry.text);
	// The memorized transcripts, one LINE at a time rather than one chunk: a
	// chunk is as many turns as fit, and what a room quotes back out of one is
	// the sentence that answers, so the sentence is what the locator keeps. The
	// conversations the fold took notes from and the ones it dropped are two
	// places, searched in that order, because the product indexes them on
	// different grounds and the table has to say which of the two a search
	// stopped reaching.
	const conversationDocs = await conversationCorpus(input.roomId, { fresh: true });
	const linesOf = (dropped: boolean) => conversationDocs.filter((document) => (document.meta?.outcome === "dropped") === dropped).flatMap((document) => document.text.split(/\r?\n/));
	const conversationLines = linesOf(false);
	const droppedLines = linesOf(true);
	const lineByMarker = new Map((input.plants ?? []).map((plant) => [plant.marker, plant.line] as const));
	const places: Array<[EvidenceLocation, string[]]> = [["core", coreNotes], ["recent", recentBlocks], ["archive", archiveNotes], ["conversation", conversationLines], ["dropped", droppedLines]];
	const out: Record<string, EvidenceLocationDetail> = {};
	// One place at a time, and inside a place the code before the words. A
	// transcript keeps every reference code while a fold rewords the note it
	// made of it, so trying the code across every place first would file a
	// fact that IS in core, in the fold's own words, under the conversation
	// it came from; the core would read empty and the conversation source
	// would be credited with answers the memory gave.
	for (const marker of input.markers) {
		let found: EvidenceLocationDetail = { location: "gone", how: null };
		const line = lineByMarker.get(marker);
		for (const [location, texts] of places) {
			const byCode = texts.find((text) => text.includes(marker));
			if (byCode !== undefined) { found = { location, how: "code", text: byCode }; break; }
			const byWording = line ? texts.find((text) => carriesWording(text, line)) : undefined;
			if (byWording !== undefined) { found = { location, how: "wording", text: byWording }; break; }
		}
		out[marker] = found;
	}
	return out;
}

/** Where each marker sits, without how it was found: the shape most callers want. */
export async function locateEvidence(input: { roomId: string; markers: readonly string[]; plants?: readonly RecallPlant[] }): Promise<Record<string, EvidenceLocation>> {
	const detailed = await locateEvidenceInDetail(input);
	const out: Record<string, EvidenceLocation> = {};
	for (const [marker, detail] of Object.entries(detailed)) out[marker] = detail.location;
	return out;
}

/**
 * Why each of these markers left the core, for the notes the archive holds:
 * `budget` for a note pushed out to make room, `superseded` for one a later
 * conversation replaced, `done` for a finished item. A marker the archive does
 * not hold is absent from the result. A marker the fold reworded is matched by
 * the words of its planted line, the same fallback `locateEvidenceInDetail` uses.
 */
export async function archivedReasons(input: { roomId: string; markers: readonly string[]; plants?: readonly RecallPlant[] }): Promise<Record<string, string>> {
	const { store } = await stateModules();
	const archive = store.readArchive(input.roomId);
	const lineByMarker = new Map((input.plants ?? []).map((plant) => [plant.marker, plant.line] as const));
	const out: Record<string, string> = {};
	for (const marker of input.markers) {
		const line = lineByMarker.get(marker);
		const row = archive.find((entry) => entry.text.includes(marker)) ?? (line ? archive.find((entry) => carriesWording(entry.text, line)) : undefined);
		if (row) out[marker] = row.why;
	}
	return out;
}

/** The worst place any of a question's evidence sits: a question is only as answerable as its hardest piece. */
export function worstLocation(locations: readonly EvidenceLocation[]): EvidenceLocation {
	const order: EvidenceLocation[] = ["core", "recent", "archive", "conversation", "dropped", "gone", "none"];
	return locations.reduce<EvidenceLocation>((worst, location) => (order.indexOf(location) > order.indexOf(worst) ? location : worst), "core");
}

// --- Retrieval ---------------------------------------------------------------

/** The sources a recall may be restricted to, spelled the way the tool spells them. */
export type RecallSource = "notes" | "archive" | "conversations";
export const RECALL_SOURCES: readonly RecallSource[] = ["notes", "archive", "conversations"];

export interface RetrievalHit {
	/** 1-based position of the first returned row carrying the marker; null when none does. */
	rank: number | null;
	matches: number;
	returned: number;
	outcome: string;
	/**
	 * Where the rank was read: `rows` is the tool's own result list, in the
	 * order it scored them, and `text` is the envelope it rendered, which is all
	 * a tool that lists no rows gives a reader. The two are kept apart because a
	 * rank read off a rendered envelope is a rank read off whatever fitted.
	 */
	readFrom: "rows" | "text";
	/** The source the answering row came from, when the tool named one. */
	source?: string;
}

const RECALL_ENVELOPE_OPEN = /^\[MEMORY (?:ARCHIVE|RECALL):/;
const RECALL_ENVELOPE_CLOSE = /^\[\/MEMORY (?:ARCHIVE|RECALL)\]$/;

/**
 * The rows the recall tool handed back, in the order it handed them back, read
 * off the TEXT — the envelope the room itself reads. It is the fallback: a tool
 * that lists its results in `details.rows` is read there instead, because a
 * rendered envelope holds what FITTED and says nothing about what scored.
 *
 * The envelope's preamble is dropped and the blocks are split on the blank line
 * between them. Both envelopes are parsed, the archive-only one of 0.12.1 and
 * the grouped one that replaced it, so a run says the same thing either side of
 * that change; under the grouped one a source heading is a block of its own,
 * which is why a rank off the text is only ever a fallback.
 */
function returnedNotes(text: string): string[] {
	const lines = text.split("\n");
	if (!RECALL_ENVELOPE_OPEN.test(lines[0] ?? "")) return [];
	let close = -1;
	for (let at = lines.length - 1; at >= 0; at--) {
		if (RECALL_ENVELOPE_CLOSE.test(lines[at].trim())) { close = at; break; }
	}
	return lines
		.slice(2, close < 0 ? undefined : close)
		.join("\n")
		.split("\n\n")
		.filter((block) => block.trim().length > 0);
}

/** One row of the tool's own result list, as much of it as the bench reads. */
interface RecallResultRowFromTool {
	id?: unknown;
	source?: unknown;
	rcId?: unknown;
	text?: unknown;
}

/**
 * Which of the tool's rows is the evidence's own document: the row whose text
 * carries the marker, or the words of the line that planted it. A row names its
 * document and need not carry its words, so the text is taken from the row when
 * it has one and looked up in the room's corpus by id when it has not — by the
 * id as written and by the id without the conversation it ends in, since a
 * conversation row names its chunk AND the conversation it came from.
 */
async function firstRowCarrying(roomId: string, rows: readonly RecallResultRowFromTool[], marker: string, plantedLine?: string): Promise<{ at: number; source?: string }> {
	const corpus = await roomCorpus(roomId);
	const byId = new Map<string, string>();
	for (const document of corpus.docs) {
		byId.set(document.id, document.text);
		const at = document.id.indexOf("@");
		if (at > 0) byId.set(document.id.slice(0, at), document.text);
	}
	const textOf = (row: RecallResultRowFromTool): string => {
		if (typeof row.text === "string" && row.text.length > 0) return row.text;
		const id = typeof row.id === "string" ? row.id : "";
		const at = id.indexOf("@");
		return byId.get(id) ?? (at > 0 ? byId.get(id.slice(0, at)) ?? "" : "");
	};
	for (const [index, row] of rows.entries()) {
		const text = textOf(row);
		if (!text) continue;
		if (text.includes(marker) || (plantedLine !== undefined && carriesWording(text, plantedLine))) {
			return { at: index, ...(typeof row.source === "string" ? { source: row.source } : {}) };
		}
	}
	return { at: -1 };
}

/**
 * `memory_recall` as this bench calls it: the tool's own execute takes the
 * signal, the progress callback and the extension context a room's turn hands
 * it, and reads none of the three — it is a read of the room's own files. So
 * the bench calls it with the arguments it uses, through this narrow view of
 * the signature, rather than inventing an extension context to satisfy a
 * parameter nothing looks at.
 */
type RecallExecute = (
	toolCallId: string,
	params: { query: string; topic?: string; maxResults?: number; sources?: readonly string[] },
) => Promise<{ content?: Array<{ type: string; text?: string }>; details?: Record<string, unknown> }>;

/** One call of the room's own recall tool, and the three things the bench reads off it. */
async function executeRecall(input: { roomId: string; query: string; maxResults?: number; sources?: readonly RecallSource[] }): Promise<{
	details: { outcome?: string; matches?: number; returned?: number; rows?: unknown };
	text: string;
	rows: RecallResultRowFromTool[] | null;
}> {
	const { recallTool } = await stateModules();
	const tool = recallTool.createPersistentRoomMemoryRecallTool({ roomId: input.roomId });
	const execute = tool.execute as unknown as RecallExecute;
	const result = await execute("recall-bench", {
		query: input.query,
		...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
		...(input.sources === undefined ? {} : { sources: [...input.sources] }),
	});
	const details = (result.details ?? {}) as { outcome?: string; matches?: number; returned?: number; rows?: unknown };
	const text = result.content?.[0]?.text ?? "";
	const rows = Array.isArray(details.rows) ? (details.rows as RecallResultRowFromTool[]) : null;
	return { details, text, rows };
}

/**
 * The room's own `memory_recall`, executed in process against the room's own
 * memory.
 *
 * THE RANK IS READ OFF THE TOOL'S OWN ROW LIST where it has one: `details.rows`
 * is every row the search scored, in score order, which is the order the room
 * would have read them in. The envelope is the fallback for a tool that lists
 * no rows — it renders what FITTED, so a rank taken from it is a rank among the
 * results that were printed, and the two are not the same claim.
 *
 * The document is recognised the way it is recognised everywhere else: by its
 * reference code where it still carries one, and by the words of its planted
 * line where a fold has rewritten it. A code-only test would report a note the
 * search really did return as missing, purely because the fold paraphrased it.
 */
export async function retrieve(input: { roomId: string; query: string; marker?: string; plantedLine?: string; maxResults?: number; sources?: readonly RecallSource[] }): Promise<RetrievalHit> {
	const { details, text, rows } = await executeRecall(input);
	if (rows) {
		const found = input.marker === undefined
			? { at: -1 }
			: await firstRowCarrying(input.roomId, rows, input.marker, input.plantedLine);
		return {
			rank: found.at >= 0 ? found.at + 1 : null,
			matches: details.matches ?? rows.length,
			returned: details.returned ?? rows.filter((row) => (row as { shown?: unknown }).shown !== false).length,
			outcome: details.outcome ?? "unknown",
			readFrom: "rows",
			...(found.source === undefined ? {} : { source: found.source }),
		};
	}
	const notes = returnedNotes(text);
	const at = input.marker
		? notes.findIndex((note) => note.includes(input.marker!) || (input.plantedLine !== undefined && carriesWording(note, input.plantedLine)))
		: -1;
	return {
		rank: at >= 0 ? at + 1 : null,
		matches: details.matches ?? 0,
		returned: details.returned ?? notes.length,
		outcome: details.outcome ?? "unknown",
		readFrom: "text",
	};
}

/**
 * One question asked of the room the way a person asks it between two
 * Memorizes: ONE recall call with the question's literal query, and every piece
 * of its evidence looked for in the rows that one call handed back. It is one
 * call and not one per marker because the room's use sidecar counts what a
 * recall SHOWED, and a question with two pieces of evidence is still one
 * question — two calls would count every row it returned twice. Per marker it
 * says the rank the row came back at and the source the tool named for it,
 * which is how a caller tells a note still in the core from an archived one.
 */
export async function probeQuestion(input: { roomId: string; question: RecallQuestion; plants?: readonly RecallPlant[]; maxResults?: number; sources?: readonly RecallSource[] }): Promise<{
	perMarker: Array<{ marker: string; rank: number | null; source?: string }>;
	returned: number;
}> {
	const lineByMarker = new Map((input.plants ?? []).map((plant) => [plant.marker, plant.line] as const));
	const markers = [...new Set(input.question.evidence.map((evidence) => evidence.marker))];
	const { details, text, rows } = await executeRecall({ roomId: input.roomId, query: input.question.queries.literal, ...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }), ...(input.sources === undefined ? {} : { sources: input.sources }) });
	const perMarker: Array<{ marker: string; rank: number | null; source?: string }> = [];
	for (const marker of markers) {
		if (rows) {
			const found = await firstRowCarrying(input.roomId, rows, marker, lineByMarker.get(marker));
			perMarker.push({ marker, rank: found.at >= 0 ? found.at + 1 : null, ...(found.source === undefined ? {} : { source: found.source }) });
			continue;
		}
		const notes = returnedNotes(text);
		const line = lineByMarker.get(marker);
		const at = notes.findIndex((note) => note.includes(marker) || (line !== undefined && carriesWording(note, line)));
		perMarker.push({ marker, rank: at >= 0 ? at + 1 : null });
	}
	return { perMarker, returned: details.returned ?? (rows ? rows.filter((row) => (row as { shown?: unknown }).shown !== false).length : returnedNotes(text).length) };
}

/**
 * The room's use sidecar written out now, so the next Memorize's ranking reads
 * what the probes since the last one showed. The product coalesces the writes
 * on a short timer, which a bench that folds straight after asking would
 * outrun. Loaded on demand and never required: a product without the sidecar
 * has nothing to flush, and the same bench file runs on it — that is the run
 * the "before" tables come from — so the answer says whether there was one.
 */
export async function flushRoomMemoryUse(roomId: string): Promise<boolean> {
	homeOrThrow();
	let module: { flushMemoryUse?: (agentId?: string) => void } | null = null;
	try {
		module = (await import("../../src/memory-use.js")) as { flushMemoryUse?: (agentId?: string) => void };
	} catch {
		return false;
	}
	if (typeof module?.flushMemoryUse !== "function") return false;
	module.flushMemoryUse(roomId);
	return true;
}

/**
 * The constants the product's demotion score is made of, or null on a product
 * whose ranking is the fixed sort — printed so a results file can be read
 * against the score that produced it.
 */
export async function demotionScoreConstants(): Promise<Record<string, number> | null> {
	const { entries } = await stateModules();
	const constants = (entries as { DEMOTION_SCORE?: unknown }).DEMOTION_SCORE;
	return constants && typeof constants === "object" ? { ...(constants as Record<string, number>) } : null;
}

/**
 * The rows the room's own Memorize records said it moved out BY BUDGET, read
 * off the absorb event records under the room, and how many of them say why in
 * a sentence. A card that lists a note without a reason is what the reason
 * column exists to rule out, so the two counts are reported side by side.
 */
export function budgetRowsInEvents(roomId: string): { rows: number; withReason: number; events: number } {
	const { root } = homeOrThrow();
	const dir = path.join(root, roomId, "events", "absorb");
	let rows = 0;
	let withReason = 0;
	let events = 0;
	if (!fs.existsSync(dir)) return { rows, withReason, events };
	for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
		let record: { run?: { archived?: Array<{ why?: unknown; reason?: unknown }> } };
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as typeof record;
		} catch {
			continue;
		}
		events += 1;
		for (const archived of record.run?.archived ?? []) {
			if (archived.why !== "budget") continue;
			rows += 1;
			if (typeof archived.reason === "string" && archived.reason.trim().length > 0) withReason += 1;
		}
	}
	return { rows, withReason, events };
}

/**
 * The rows the room's own Memorize records say left the core because a later
 * conversation replaced them AND say why: a superseded text whose old and new
 * value disagree carries the reason the card shows ("1 July (saved 14 Sep)
 * replaces 1 June (saved 2 Jun); the newer date decides"). A superseded text
 * that merely rewords carries none and is not in this list.
 */
export function conflictRowsInEvents(roomId: string): Array<{ id: string; reason: string }> {
	const { root } = homeOrThrow();
	const dir = path.join(root, roomId, "events", "absorb");
	const rows: Array<{ id: string; reason: string }> = [];
	if (!fs.existsSync(dir)) return rows;
	for (const name of fs.readdirSync(dir).filter((file) => file.endsWith(".json")).sort()) {
		let record: { run?: { archived?: Array<{ id?: unknown; why?: unknown; reason?: unknown }> } };
		try {
			record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as typeof record;
		} catch {
			continue;
		}
		for (const archived of record.run?.archived ?? []) {
			if (archived.why !== "superseded" || typeof archived.id !== "string") continue;
			if (typeof archived.reason !== "string" || archived.reason.trim().length === 0) continue;
			rows.push({ id: archived.id, reason: archived.reason });
		}
	}
	return rows;
}

/**
 * The pairs of notes in the room's core that disagree on a value, by the
 * product's own predicate: the conflicts a run left standing as both. The
 * back history's filler notes are left out first: each carries its own
 * reference number, which is a value, and every twenty-fourth of them repeats
 * the words of another, so the product rightly lists those as disagreeing,
 * and they are the bench's scaffolding rather than anything a conversation
 * said. Left in, they would also fill the predicate's ceiling of thirty pairs
 * before any planted note was reached.
 */
export async function conflictPairsInCore(roomId: string): Promise<ConflictNotePair[]> {
	const { entries, duplicates } = await stateModules();
	const doc = entries.parseMemoryDocument(readL1b(roomId));
	for (const topic of doc.topics) topic.entries = topic.entries.filter((entry) => !entry.text.includes(`${BACK_HISTORY_MARKER}-`));
	return duplicates.findConflictingNotePairs(doc);
}

/**
 * The places a question's evidence has to be SEARCHED for: the archive, a
 * conversation the room kept and never wrote a note from, and a conversation
 * it kept and took no notes from at all. Everything else is either in front
 * of the room already or nowhere at all, and recall is asked nothing about it.
 */
export const RETRIEVED_LOCATIONS: ReadonlySet<EvidenceLocation> = new Set<EvidenceLocation>(["archive", "conversation", "dropped"]);

export interface QuestionRanks {
	ranks: Record<QueryKind, Rank>;
	/** Every evidence marker's own ranks, as the three queries reached it. */
	perMarker: Array<{ marker: string; location: EvidenceLocation; ranks: Record<QueryKind, number | null> }>;
	/** Whether any of this question's evidence is somewhere recall has to answer for. */
	applicable: boolean;
	/** Recall calls this question cost: one per query kind per evidence marker. */
	calls: number;
}

/**
 * A question's three queries against its evidence, one recall call per query
 * per marker.
 *
 * THE QUESTION'S RANK, per query kind: the BEST rank the query reaches across
 * the evidence markers RECALL HAS TO ANSWER FOR — the ones in the archive, and
 * the ones the room only ever heard and kept in a conversation. Those are the
 * markers the room cannot read without searching for them; a note the core
 * still holds is already in front of it. So a question with none of them is
 * `"n/a"` and counts in no denominator, and a question with several is credited
 * with the one the query actually surfaces, since one row quoted back is what a
 * recall answer is built from.
 *
 * The per-marker ranks are handed back beside it, each with where its evidence
 * sits, because the retrieval table reads markers and not questions.
 */
export async function retrievalRanks(input: { roomId: string; question: RecallQuestion; locations: Record<string, EvidenceLocation>; plants?: readonly RecallPlant[]; maxResults?: number; sources?: readonly RecallSource[] }): Promise<QuestionRanks> {
	const markers = [...new Set(input.question.evidence.map((evidence) => evidence.marker))];
	const lineByMarker = new Map((input.plants ?? []).map((plant) => [plant.marker, plant.line] as const));
	const perMarker = markers.map((marker) => ({
		marker,
		location: input.locations[marker] ?? ("gone" as EvidenceLocation),
		ranks: { literal: null, paraphrase: null, variant: null } as Record<QueryKind, number | null>,
	}));
	const retrieved = perMarker.filter((row) => RETRIEVED_LOCATIONS.has(row.location));
	const ranks = { literal: RANK_NOT_APPLICABLE, paraphrase: RANK_NOT_APPLICABLE, variant: RANK_NOT_APPLICABLE } as Record<QueryKind, Rank>;
	let calls = 0;
	for (const kind of QUERY_KINDS) {
		const query = input.question.queries[kind];
		for (const row of perMarker) {
			const hit = await retrieve({
				roomId: input.roomId,
				query,
				marker: row.marker,
				...(lineByMarker.get(row.marker) === undefined ? {} : { plantedLine: lineByMarker.get(row.marker)! }),
				...(input.maxResults === undefined ? {} : { maxResults: input.maxResults }),
				...(input.sources === undefined ? {} : { sources: input.sources }),
			});
			calls += 1;
			row.ranks[kind] = hit.rank;
		}
		if (retrieved.length === 0) continue;
		const found = retrieved.map((row) => row.ranks[kind]).filter((rank): rank is number => rank !== null);
		ranks[kind] = found.length === 0 ? null : Math.min(...found);
	}
	return { ranks, perMarker, applicable: retrieved.length > 0, calls };
}

// --- Scoring an answer -------------------------------------------------------

/** The not-known formulations an abstention may be written in, in both languages. */
const ABSTENTION_PHRASES = [
	"weiss ich nicht",
	"nicht bekannt",
	"keine ahnung",
	"keine information",
	"keine angabe",
	"nie besprochen",
	"nicht besprochen",
	"dazu steht nichts",
	"dazu liegt mir nichts",
	"liegt mir nicht vor",
	"steht nicht in meinem gedaechtnis",
	// The bare form, so "wurde nicht erwaehnt" and "nie erwaehnt" both land.
	"nicht erwaehnt",
	"kam nie zur sprache",
	"kann ich nicht sagen",
	"i don't know",
	"i do not know",
	"not known",
	"no information",
	"no record",
	"no information on",
	"never came up",
	"not sure",
	"don't have that",
	"do not have that",
	"don't have any",
	"wasn't mentioned",
	"was not mentioned",
	"i can't tell",
	"i cannot tell",
	"nothing in my memory",
	// The wordings the real runs used and the list did not hold.
	"nothing in memory",
	"nothing in what i have",
	"not on record",
	"no note",
	"nicht notiert",
	"nicht hinterlegt",
	"nicht festgehalten",
	"liegt nichts vor",
	"finde ich nichts",
];

/**
 * The plain negations of both languages, as the scorer's tokens spell them. An
 * apostrophe is no part of a token, so "don't" reads as "don" followed by "t";
 * the three contractions are therefore matched as that pair and never as the
 * stem alone.
 */
const NEGATION_TOKENS = new Set(["no", "not", "nothing", "never", "nowhere", "nicht", "nichts", "nirgends", "kein", "keine", "keinem"]);
const NEGATION_CONTRACTIONS = new Set(["don", "doesn", "isn"]);

/**
 * Whether an answer says that something is not known. The phrase list is
 * evidence of it and so is a plain negation, read in what is left of the
 * answer once the fixture's own facts are taken out: a room that says "no
 * deputy has been named yet" has said so as plainly as one that says "I do
 * not know". Whether the answer ALSO invented something is the other half of
 * the abstention rule and is not decided here.
 */
function saysNotKnown(answer: string, known: readonly string[]): boolean {
	const normalized = normalizeForScoring(answer);
	if (ABSTENTION_PHRASES.some((phrase) => normalized.includes(phrase))) return true;
	const tokens = withoutKnownFacts(answer, known).split(" ");
	return tokens.some((token, at) => NEGATION_TOKENS.has(token) || (NEGATION_CONTRACTIONS.has(token) && tokens[at + 1] === "t"));
}

/**
 * The wordings with which an answer names the MECHANISM instead of the fact:
 * where something sits, or that it was looked for. The room is told to keep
 * the mechanism out of what it says, on a hit and on a miss alike, so a run
 * counts the answers that carry one of these. Both languages, in the scorer's
 * own spelling, matched as whole tokens side by side.
 */
export const NARRATION_PHRASES: readonly string[] = [
	"in my memory",
	"in memory",
	"in my notes",
	"in the notes",
	"in the archive",
	"on record",
	"let me check",
	"in meiner erinnerung",
	"in der erinnerung",
	"in meinem gedaechtnis",
	"in den notizen",
	"in den aktiven notizen",
	"laut den notizen",
	"im archiv",
	"festgehalten",
];

/** The first mechanism wording an answer carries, or null when it names none. Counted per run and never a gate. */
export function narratesMechanism(answer: string): string | null {
	const tokens = scoringTokens(answer);
	return NARRATION_PHRASES.find((phrase) => tokenRunIndex(tokens, scoringTokens(phrase)) >= 0) ?? null;
}

/**
 * An id of the room's own bookkeeping inside an answer: a conversation's
 * `RC-0004` or a note's `m-0031`. The room is told to name a conversation or a
 * note by its date and what it was about, because a person cannot read the id.
 * A whole token only: no letter, digit or underscore on either side, so
 * "(RC-0003)" and "m-0031." count and "ARC-0004", "form-0031", "RC-00045" and
 * "RC-0004x" do not. Three or four digits: the product writes four, and three
 * is an id a model shortened. `RC` is read in either case, because the product
 * reads it so itself (the drop lines and the memory panel take "rc-0004" and
 * write it back in capitals) and "rc-0004" means nothing else in a sentence;
 * `m-` is lowercase only, which is the one spelling the product writes and
 * reads, and "M-1200" is how a part or a road is written.
 */
const INTERNAL_ID = /(?<![\p{L}\p{N}_])(?:[Rr][Cc]|m)-\d{3,4}(?![\p{L}\p{N}_])/u;

/** The first internal id an answer cites, as the answer wrote it, or null when it cites none. Counted per run and never a gate. */
export function citesInternalId(answer: string): string | null {
	return INTERNAL_ID.exec(answer)?.[0] ?? null;
}

/** The line a run prints under its narration count, or null when nobody was asked. Reported, never a gate. */
export function internalIdsLine(summary: Pick<RecallRunSummary, "internalIds">): string | null {
	const counted = summary.internalIds;
	return counted ? `internal ids: ${counted.citing} of ${counted.answers} answers cite an internal id (RC-0004, m-0031) · reported, never a gate` : null;
}

/**
 * The numbers up to sixty, written out, in both languages — including the
 * German article forms (`ein`, `einer`, `einem`), because "einen Tag" and "1
 * Tag" are the same answer, and the German compounds ("einundzwanzig"), which
 * are one word. English compounds are two ("twenty-one") and are joined by
 * their own pass in `normalizeForScoring` before this table is consulted.
 *
 * Sixty is where a fixture's counts, days and hours stop being written out and
 * start being written in digits; nothing above it has ever needed a word.
 */
const GERMAN_UNITS = ["null", "ein", "zwei", "drei", "vier", "fuenf", "sechs", "sieben", "acht", "neun", "zehn", "elf", "zwoelf"];
const GERMAN_TEENS = ["dreizehn", "vierzehn", "fuenfzehn", "sechzehn", "siebzehn", "achtzehn", "neunzehn"];
const GERMAN_TENS: Array<[string, number]> = [["zwanzig", 20], ["dreissig", 30], ["vierzig", 40], ["fuenfzig", 50], ["sechzig", 60]];
const ENGLISH_UNITS = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten", "eleven", "twelve"];
const ENGLISH_TEENS = ["thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"];
const ENGLISH_TENS: Array<[string, number]> = [["twenty", 20], ["thirty", 30], ["forty", 40], ["fifty", 50], ["sixty", 60]];

function buildNumberWords(): Record<string, string> {
	const words: Record<string, string> = {};
	GERMAN_UNITS.forEach((word, value) => { words[word] = String(value); });
	ENGLISH_UNITS.forEach((word, value) => { words[word] = String(value); });
	GERMAN_TEENS.forEach((word, index) => { words[word] = String(index + 13); });
	ENGLISH_TEENS.forEach((word, index) => { words[word] = String(index + 13); });
	for (const [word, value] of [...GERMAN_TENS, ...ENGLISH_TENS]) words[word] = String(value);
	// The article forms and the plural of one, which a German answer uses where
	// the fixture writes a digit.
	for (const form of ["eins", "eine", "einen", "einer", "einem"]) words[form] = "1";
	// The German compounds: nine units against five tens, each one word.
	for (const [ten, value] of GERMAN_TENS) {
		for (let unit = 1; unit <= 9; unit++) words[`${GERMAN_UNITS[unit]}und${ten}`] = String(value + unit);
	}
	return words;
}

const NUMBER_WORDS: Record<string, string> = buildNumberWords();

/** `twenty-one`, `twenty one`: English writes its compounds as two words, so they are joined before the table is read. */
const ENGLISH_COMPOUND = new RegExp(`\\b(${ENGLISH_TENS.map(([word]) => word).join("|")})[\\s-]+(${ENGLISH_UNITS.slice(1, 10).join("|")})\\b`, "g");

const MONTH_NUMBERS: Record<string, number> = {
	januar: 1, january: 1, jan: 1,
	februar: 2, february: 2, feb: 2,
	maerz: 3, march: 3, mar: 3, mrz: 3,
	april: 4, apr: 4,
	mai: 5, may: 5,
	juni: 6, june: 6, jun: 6,
	juli: 7, july: 7, jul: 7,
	august: 8, aug: 8,
	september: 9, sept: 9, sep: 9,
	oktober: 10, october: 10, okt: 10, oct: 10,
	november: 11, nov: 11,
	dezember: 12, december: 12, dez: 12, dec: 12,
};

/** The quarter a word names, by its stem: German declines the ordinal ("drittes", "dritten"), English does not. */
const QUARTER_STEMS: Record<string, string> = {
	erste: "1", first: "1",
	zweite: "2", second: "2",
	dritte: "3", third: "3",
	vierte: "4", fourth: "4",
};

const MONTH_NAMES = Object.keys(MONTH_NUMBERS).sort((a, b) => b.length - a.length).join("|");

function isoDate(year: string, month: number, day: string): string {
	return `${year}-${String(month).padStart(2, "0")}-${String(Number(day)).padStart(2, "0")}`;
}

/**
 * One canonical form for the answers a room gives and the answers a fixture
 * calls right: case folded, umlauts and ß written out (so "weiß", "weiss" and
 * "weiss" meet), every way of writing one date reduced to YYYY-MM-DD, quarters
 * to q3, the numbers one to twelve in both languages to digits, and thousands
 * separators dropped. Nothing here is language detection: both languages'
 * words are in one table, because a room answers in the language it was asked
 * in and the bench must not care.
 */
export function normalizeForScoring(text: string): string {
	let out = String(text ?? "").toLowerCase();
	out = out.replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/é|è|ê/g, "e");
	// Dates, longest shape first: "1. Juni 2026", "1 June 2026", "11th July 2026",
	// "June 1, 2026", "1.6.2026", "01/06/2026". An English ordinal suffix is part
	// of the day and has to be eaten with it, or the whole date falls through.
	out = out.replace(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\.?\\s+(${MONTH_NAMES})\\.?\\s+(\\d{4})\\b`, "g"), (_all, day: string, month: string, year: string) => isoDate(year, MONTH_NUMBERS[month], day));
	out = out.replace(new RegExp(`\\b(${MONTH_NAMES})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,?\\s+(\\d{4})\\b`, "g"), (_all, month: string, day: string, year: string) => isoDate(year, MONTH_NUMBERS[month], day));
	out = out.replace(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/g, (_all, day: string, month: string, year: string) => isoDate(year, Number(month), day));
	out = out.replace(/\b(\d{1,2})\/(\d{1,2})\/(\d{4})\b/g, (_all, day: string, month: string, year: string) => isoDate(year, Number(month), day));
	// Quarters: "q3", "3. Quartal", "drittes/dritten Quartal", "third quarter".
	out = out.replace(/\bq\s*([1-4])\b/g, (_all, n: string) => `q${n}`);
	out = out.replace(/\b(erste|zweite|dritte|vierte|first|second|third|fourth)[a-z]{0,2}\.?\s+(?:quartal|quarter)\b/g, (_all, stem: string) => `q${QUARTER_STEMS[stem]}`);
	out = out.replace(/\b([1-4])\.?\s+(?:quartal|quarter)\b/g, (_all, n: string) => `q${n}`);
	// The numbers up to sixty, written out in either language: the English
	// compounds are two words and are joined first, then every word is looked up.
	out = out.replace(ENGLISH_COMPOUND, (_all, ten: string, unit: string) => String(Number(NUMBER_WORDS[ten] ?? 0) + Number(NUMBER_WORDS[unit] ?? 0)));
	out = out.replace(/\b[a-z]+\b/g, (word) => NUMBER_WORDS[word] ?? word);
	// Thousands separators, after the dates: 1.000, 1,000 and 1 000 all read 1000.
	for (let pass = 0; pass < 3; pass++) out = out.replace(/(\d)[.,  ](\d{3})(?!\d)/g, "$1$2");
	// The short forms a person writes money and shares in. "55k" is 55000 and
	// "1.5k" is 1500; the currency and the percent sign each become ONE token,
	// and a currency written in front of its number moves behind it, so "€55,000",
	// "55k EUR" and "55.000 Euro" come out as the same two tokens.
	out = out.replace(/\b(\d+)(?:[.,](\d))?k\b/g, (_all, whole: string, tenth: string | undefined) => String(Number(whole) * 1000 + (tenth ? Number(tenth) * 100 : 0)));
	// The code may be written against its number with no space at all —
	// "EUR55,000" — so the trailing boundary cannot be required: what follows is
	// a digit, which is a word character, and `\b` would refuse the whole match.
	out = out.replace(/€|\beuros?\b|\beur(?![a-z])/g, " eur ");
	out = out.replace(/%|\bpercent\b|\bprozent\b|\bpct(?![a-z])/g, " pct ");
	out = out.replace(/\b(eur|pct)\s+(\d+)/g, "$2 $1");
	return out.replace(/\s+/g, " ").trim();
}

/**
 * Whether an answer carries a value, compared as WHOLE TOKENS. Containment on
 * raw text cannot tell "19" from "119", "5 hours" from "15 hours", or a gold
 * number from the same digits inside a date; token runs can, and the tokens
 * already read "4471-8890" and "4471 8890" as the same two, so there is no
 * second reading to keep in step with the first.
 */
function containsValue(answer: string, value: string): boolean {
	return tokenRunIndex(scoringTokens(answer), scoringTokens(value)) >= 0;
}

/**
 * The numbers and dates a text carries: what a room can say back without having
 * invented it. A planted line's numbers are facts the room was told, so an
 * abstention that repeats one is quoting.
 */
export function numbersAndDatesIn(text: string): string[] {
	return [...new Set(scoringTokens(text).filter((token) => /\d/.test(token)))];
}

/** The earliest token at which any of these values occurs, and which one it was. */
function earliestOf(answer: string, values: readonly string[]): { at: number; found: string | null } {
	const tokens = scoringTokens(answer);
	let at = -1;
	let found: string | null = null;
	for (const value of values) {
		const hit = tokenRunIndex(tokens, scoringTokens(value));
		if (hit < 0) continue;
		if (at < 0 || hit < at) { at = hit; found = value; }
	}
	return { at, found };
}

/** The words that put two things in an order, in both languages. */
const ORDER_WORDS = new Set(["first", "earlier", "before", "prior", "earliest", "zuerst", "frueher", "vor", "eher", "zunaechst", "erst"]);

/** How far the nearest order word is from the token run starting here, in tokens; null when there is none within reach. */
function orderWordDistance(tokens: readonly string[], at: number, length: number, within = 3): number | null {
	if (at < 0) return null;
	let nearest: number | null = null;
	for (let i = 0; i < tokens.length; i++) {
		if (!ORDER_WORDS.has(tokens[i])) continue;
		const distance = i < at ? at - i : i >= at + length ? i - (at + length - 1) : 0;
		if (distance <= within && (nearest === null || distance < nearest)) nearest = distance;
	}
	return nearest;
}

/** The hedges a room puts in front of a guess. */
const HEDGE_WORDS = new Set(["believe", "think", "probably", "maybe", "perhaps", "guess", "guessing", "vermutlich", "wahrscheinlich", "vielleicht", "glaube", "schaetze", "moeglicherweise"]);

/**
 * The fixture's own facts taken out of an answer, so that what is left is what
 * the room ADDED. Everything the fixture ever plants or accepts — the date the
 * question was asked on, every gold, trap and distractor spelling of every
 * question, every number and date inside a planted line — is known, and a room
 * that says one of them back is quoting, not inventing.
 */
function withoutKnownFacts(answer: string, known: readonly string[]): string {
	let tokens = scoringTokens(answer);
	for (const value of known) {
		const needle = scoringTokens(value);
		if (needle.length === 0) continue;
		for (;;) {
			const at = tokenRunIndex(tokens, needle);
			if (at < 0) break;
			tokens = [...tokens.slice(0, at), ...tokens.slice(at + needle.length)];
		}
	}
	return tokens.join(" ");
}

/**
 * Whether an abstention invented something.
 *
 * A room that is asked about something it was never told should say so, and a
 * careful one often says the date it was asked on back while it does — "As of
 * 21 July 2026, nothing in my memory says…". An earlier version of this scorer
 * called any two-digit number an invention and marked those answers wrong,
 * which punished exactly the answers that are most careful about what they do
 * and do not know. So a number is only an invention when the fixture never gave
 * it to the room: the question's own trap spellings, or its `trapPattern` still
 * matching once every known fact has been taken out of the answer.
 *
 * A hedge is judged on the answer AS WRITTEN. "I don't know, but I believe it
 * was the Radisson" is a guess dressed as an abstention, and so is "I'm not
 * sure, probably 2026-11-30" even when that date is a fact the room holds — the
 * room was not asked for it and is guessing that it is the answer.
 */
function abstentionInvention(input: { question: RecallQuestion; answer: string; known: readonly string[] }): string | null {
	const { question, answer } = input;
	const trap = (question.trap ?? []).filter((value) => value.trim().length > 0);
	const hitTrap = trap.find((value) => containsValue(answer, value));
	if (hitTrap) return `names "${hitTrap}", which was never said in this room`;
	const pattern = question.trapPattern ? new RegExp(question.trapPattern, "i") : null;
	const known = [...input.known, question.askDate];
	if (pattern && pattern.test(withoutKnownFacts(answer, known))) return `names a specific of its own (${question.trapPattern})`;
	const tokens = scoringTokens(answer);
	const hedgeAt = tokens.findIndex((token) => HEDGE_WORDS.has(token));
	if (hedgeAt >= 0) {
		const after = tokens.slice(hedgeAt + 1, hedgeAt + 6);
		const guessed = trap.some((value) => tokenRunIndex(after, scoringTokens(value)) >= 0) || (pattern !== null && pattern.test(after.join(" ")));
		if (guessed) return `hedges a guess ("${tokens[hedgeAt]}") at a value it does not hold`;
		// A hedge followed by a number is a guess at a value whatever the question
		// asked for: an amount, a count or a date offered after "probably" is an
		// invention on a question the room holds nothing for, and a question's own
		// trap is shaped for its own subject and would let it through. Numbers
		// only: a capitalised word after a hedge is as often a known name as a
		// guessed one. Judged on the answer as written, like the rule above.
		const number = after.find((token) => /\d/.test(token));
		if (number !== undefined) return `hedges a guess ("${tokens[hedgeAt]}") at a number ("${number}") it does not hold`;
	}
	return null;
}

/**
 * Whether an answer is right, and why in one clause. Gold values are
 * ALTERNATIVES: a question's answer key lists the acceptable ways to say the
 * one thing, and an answer carrying any of them is right — an answer key that
 * demanded every phrasing at once would score a right answer wrong.
 *
 * Two abilities are scored differently, because for them a plausible answer is
 * the failure: `knowledge-update` is wrong when it gives the value a later
 * conversation replaced and no gold value with it, and `abstention` is right
 * only when the room invents nothing AND says it does not know. Inventing
 * nothing is the gate; saying so is read generously, off the phrase list or
 * off a plain negation (see `saysNotKnown`), because an honest "nothing on
 * that" comes in more wordings than any list holds.
 *
 * `known` is everything the fixture plants or accepts anywhere; only the
 * abstention rule reads it, and only to tell a quoted fact from an invented one.
 */
export function scoreAnswer(input: { question: RecallQuestion; answer: string; known?: readonly string[] }): { correct: boolean; why: string } {
	const { question, answer } = input;
	const gold = question.gold.filter((value) => value.trim().length > 0);
	const trap = (question.trap ?? []).filter((value) => value.trim().length > 0);
	// The fixture's spellings of the WRONG option of an order question.
	const distractor = (question.distractor ?? []).filter((value) => value.trim().length > 0);
	if (question.ability === "abstention") {
		const abstains = saysNotKnown(answer, [...(input.known ?? []), question.askDate]);
		const invented = abstentionInvention({ question, answer, known: input.known ?? [] });
		if (invented) return { correct: false, why: abstains ? `says it does not know and ${invented}` : `does not say it does not know and ${invented}` };
		if (!abstains) return { correct: false, why: "the question has no answer in this room's memory and the answer does not say so" };
		return { correct: true, why: "says it does not know, and invents nothing" };
	}
	const hitTrap = trap.find((value) => containsValue(answer, value));
	const goldAt = earliestOf(answer, gold);
	if (hitTrap && !goldAt.found) return { correct: false, why: `carries the replaced value "${hitTrap}" and no current one` };
	if (!goldAt.found) return { correct: false, why: gold.length === 0 ? "the question plants no gold value" : `carries none of ${gold.map((value) => `"${value}"`).join(", ")}` };
	// ORDER QUESTIONS. An answer that names both options only counts when it
	// says which came first, and saying it first is not saying it. "Between A
	// and B, B was settled first" names A first and means the opposite; "Not B:
	// A came first" names B first and means what it says. What separates them is
	// which option the ORDER WORD belongs to, so that is what is read: the gold
	// option has to sit within three tokens of one, and the wrong option within
	// three tokens of none. An answer that names both and puts no order word
	// beside either is not scored either way — it is a sentence for the judge.
	if (distractor.length > 0) {
		const distractorAt = earliestOf(answer, distractor);
		if (distractorAt.found) {
			const tokens = scoringTokens(answer);
			const goldNear = orderWordDistance(tokens, goldAt.at, scoringTokens(goldAt.found).length);
			const otherNear = orderWordDistance(tokens, distractorAt.at, scoringTokens(distractorAt.found).length);
			if (goldNear !== null && otherNear === null) return { correct: true, why: `puts the order word beside "${goldAt.found}"` };
			return { correct: false, why: "names both options without a clear order; left to --judge" };
		}
	}
	return { correct: true, why: `carries "${goldAt.found}"${hitTrap ? " (and the replaced value too)" : ""}` };
}

// --- Results -----------------------------------------------------------------

export interface RecallResultRow {
	id: string;
	ability: RecallAbility;
	language: string;
	/** The worst place this question's evidence sits. */
	location: EvidenceLocation;
	ranks: Record<QueryKind, Rank>;
	/** null until a pass asks the room; true or false once one does. */
	answered: boolean | null;
	/** What the room said, kept so a number can always be read back against its answer. */
	answer?: string;
	/** Why the scorer called it right or wrong, in one clause. */
	why?: string;
	/** How this question's evidence was found: by its reference code, by the words of its planted line, or not at all. */
	locatedBy?: Array<LocatedBy | null>;
	/**
	 * Where the value a later conversation REPLACED sits, for a knowledge-update
	 * question. The evidence is the new value; this is the old one, and it is
	 * reported beside it because a supersede that left the old value in the core
	 * did not take — the room can still read it, and a plausible wrong answer is
	 * one sentence away.
	 */
	trapLocation?: EvidenceLocation;
	answerTokens: number;
	/** `memory_recall` calls the ROOM made while answering. */
	recallCalls: number;
	/** Recall calls the BENCH made probing retrieval, which no room paid for. */
	probeCalls?: number;
	/** What the turn cost the room, as the server reported it. */
	usage?: { input: number; output: number; total: number; cost: number };
	/**
	 * A second opinion on the answer: the scorer's verdict is containment, and
	 * containment calls a right answer wrong when it says the right thing in
	 * unforeseen words. `label` is the judge's yes, `promptTokens` is what
	 * asking it cost, and `model` is who was asked — a verdict nobody can trace
	 * back to a model is not a verdict. Null until a judge model is asked, and
	 * it never replaces the exact score: both are reported side by side.
	 */
	judge?: { model: string; label: boolean; promptTokens: number } | null;
	/**
	 * Under `--interleave`: whether this question was asked, between two
	 * Memorizes, while every piece of its evidence was still a note in the
	 * core — a recall that returned it from the notes, not from the archive.
	 * Absent on a run that did not interleave.
	 */
	askedWhileInCore?: boolean;
	/** The question of a planted pair: counted in the conflicts block and in no ability table. */
	shape?: ConflictShape;
	/** A question without a hint: counted in the "no hint" column and in no ability table. */
	noHint?: true;
}

/** One planted pair's verdict: what the memory made of it, in one line. */
export interface ConflictShapeVerdict {
	shape: ConflictShape;
	ok: boolean;
	detail: string;
}

/**
 * What a run made of the notes that say one thing twice, or nearly: the
 * conflicts it found (rows a Memorize superseded with a reason, plus the pairs
 * still disagreeing in the final core), how many it resolved, how many it left
 * standing as both, the repeats it refused as twins, and one verdict per
 * planted pair the run held whole.
 */
export interface ConflictsSummary {
	found: number;
	supersededWithReason: number;
	leftAsBoth: number;
	twinsRefused: number;
	shapes: ConflictShapeVerdict[];
}

/**
 * What an interleaved run found out about forgetting: the markers the room
 * looked up while they were still notes, and where they are at the end. The
 * "demoted" here is the archive's own `budget` reason; a note a later
 * conversation replaced left the core for its own reason and is not counted.
 */
export interface InterleaveSummary {
	/** Questions asked at least once between folds; markers those questions cite. */
	askedQuestions: number;
	askedMarkers: number;
	/** Markers a probe returned from the core notes at least once, by where they are now. */
	askedMarkersStillInCore: number;
	askedThenArchived: number;
	askedThenGone: number;
	/** The markers the fixture planted as open items, and how many are still in the core. */
	openItemMarkers: number;
	openItemMarkersInCore: number;
	/** Rows the room's Memorize records moved out by budget, and how many of them say why. */
	budgetRowsInEvents: number;
	budgetRowsWithReason: number;
}

export interface RecallRunSummary {
	language: string;
	seed: number;
	sessions: number;
	questions: number;
	notesInCore: number;
	archiveRows: number;
	archivedByBudget: number;
	/**
	 * Rows per reason, the archive's own word: budget, superseded, done, user,
	 * stale, duplicate. Optional because a caller that builds this summary from
	 * its own reads of the room's files — the bench's smoke does — has the two
	 * counts above and owes nothing further.
	 */
	archiveByWhy?: Record<string, number>;
	/** The fixture's OWN planted notes in the archive, per reason: the forgetting the bench is about. */
	evidenceByWhy?: Record<string, number>;
	/**
	 * Documents of folded conversations in the room's searchable corpus, and how
	 * many of the fixture's planted markers no note carries and a conversation
	 * still does. The second number is the size of what the room can only answer
	 * by searching what it was told.
	 */
	conversationDocs?: number;
	conversationMarkers?: number;
	memoryTokens: number;
	memoryBudgetTokens: number;
	backHistoryNotes: number;
	/** What the back history was seeded at, before any of it was shed. */
	backHistoryTokens?: number;
	answerTokensMedian: number;
	answerTokensTotal: number;
	/** The forgetting an interleaved run watched; null when the run did not interleave. */
	interleave?: InterleaveSummary | null;
	/** What the run made of the planted pairs; null when the fixture planted none whole. */
	conflicts?: ConflictsSummary | null;
	/** The ingest's claim audit; absent on a summary built without an ingest. */
	claims?: ClaimAudit;
	/**
	 * The questions without a hint: how many the run held, how many were asked
	 * and how many of those were right. Absent when the run held none. It is the
	 * row a before and an after of the room's instructions can differ in, and it
	 * is reported, never gated.
	 */
	noHint?: { questions: number; answered: number; correct: number };
	/**
	 * How many of the answers name the mechanism (see `narratesMechanism`), out
	 * of how many answers. Absent when nobody was asked. Reported beside the
	 * score, never gated.
	 */
	narrates?: { answers: number; narrating: number };
	/**
	 * How many of the answers cite an internal id (see `citesInternalId`), out
	 * of how many answers. Absent when nobody was asked. Reported under the
	 * narration count, never gated.
	 */
	internalIds?: { answers: number; citing: number };
}

/** The room's own numbers, read off its files. */
export async function roomSizes(roomId: string): Promise<{ notesInCore: number; archiveRows: number; archivedByBudget: number; archiveByWhy: Record<string, number>; memoryTokens: number; memoryBudgetTokens: number }> {
	const { entries, store, settings } = await stateModules();
	const doc = entries.parseMemoryDocument(readL1b(roomId));
	const archive: ArchivedEntry[] = store.readArchive(roomId);
	const archiveByWhy: Record<string, number> = {};
	for (const entry of archive) archiveByWhy[entry.why] = (archiveByWhy[entry.why] ?? 0) + 1;
	return {
		notesInCore: doc.topics.reduce((total, topic) => total + topic.entries.length, 0),
		archiveRows: archive.length,
		archivedByBudget: archive.filter((entry) => entry.why === "budget").length,
		archiveByWhy,
		memoryTokens: entries.reviewTargetTokens(doc),
		memoryBudgetTokens: settings.readPersistentRoomMaintenanceSettings(roomId).memoryBudgetTokens,
	};
}

function median(values: number[]): number {
	if (values.length === 0) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2);
}

/** What one answer costs the room, in the estimate the product speaks in. */
export function answerTokens(answer: string): number {
	return estimateTokens(answer ?? "");
}

export async function buildRunSummary(input: { roomId: string; language: string; seed: number; sessions: number; rows: readonly RecallResultRow[]; backHistoryNotes: number; backHistoryTokens?: number; markers: readonly string[]; plants?: readonly RecallPlant[]; locations?: Record<string, EvidenceLocation> }): Promise<RecallRunSummary> {
	const sizes = await roomSizes(input.roomId);
	const tokens = input.rows.filter((row) => row.answered !== null).map((row) => row.answerTokens);
	const evidenceByWhy: Record<string, number> = {};
	for (const why of Object.values(await archivedReasons({ roomId: input.roomId, markers: input.markers, ...(input.plants ? { plants: input.plants } : {}) }))) evidenceByWhy[why] = (evidenceByWhy[why] ?? 0) + 1;
	// The locations the caller already worked out are taken as given; a caller
	// that has none is not made to do without the number.
	const located = input.locations ?? (await locateEvidence({ roomId: input.roomId, markers: input.markers, ...(input.plants ? { plants: input.plants } : {}) }));
	const conversationMarkers = input.markers.filter((marker) => located[marker] === "conversation" || located[marker] === "dropped").length;
	const conversationDocs = (await roomCorpus(input.roomId)).counts.conversation;
	const noHintRows = input.rows.filter((row) => row.noHint);
	const answers = input.rows.filter((row) => row.answered !== null && typeof row.answer === "string");
	return {
		...(noHintRows.length === 0 ? {} : { noHint: { questions: noHintRows.length, answered: noHintRows.filter((row) => row.answered !== null).length, correct: noHintRows.filter((row) => row.answered === true).length } }),
		...(answers.length === 0 ? {} : { narrates: { answers: answers.length, narrating: answers.filter((row) => narratesMechanism(row.answer ?? "") !== null).length } }),
		...(answers.length === 0 ? {} : { internalIds: { answers: answers.length, citing: answers.filter((row) => citesInternalId(row.answer ?? "") !== null).length } }),
		conversationDocs,
		conversationMarkers,
		language: input.language,
		seed: input.seed,
		sessions: input.sessions,
		questions: input.rows.length,
		notesInCore: sizes.notesInCore,
		archiveRows: sizes.archiveRows,
		archivedByBudget: sizes.archivedByBudget,
		archiveByWhy: sizes.archiveByWhy,
		evidenceByWhy,
		memoryTokens: sizes.memoryTokens,
		memoryBudgetTokens: sizes.memoryBudgetTokens,
		backHistoryNotes: input.backHistoryNotes,
		...(input.backHistoryTokens === undefined ? {} : { backHistoryTokens: input.backHistoryTokens }),
		answerTokensMedian: median(tokens),
		answerTokensTotal: tokens.reduce((total, value) => total + value, 0),
	};
}

/**
 * The conflicts block of a run, read off the room's files: the archive by the
 * planted lines' reference codes first and their words second, the core by
 * the locator, the Memorize records for the reasons, and the product's own
 * pair predicate over the final core. Per planted pair the run held whole:
 *   - duplicate: exactly one note carries the sentence, the second member's
 *     code reached no note (its add was refused and left out), the ingest
 *     refused at least one repeat, and no row was superseded for it;
 *   - conflict-long, conflict-short, moved-event: the newer wording is a note
 *     (in the core, or moved out by budget afterwards, which is the ordinary
 *     forgetting of a long run and not the conflict's doing), the older
 *     wording is an archive row that reads `superseded` and never `duplicate`,
 *     and that row's id has a reason in the records naming the older and the
 *     newer value in the notes' own spelling;
 *   - decoy: both wordings are notes and no pair in the final core names
 *     either, so two events with two numbers and two dates stayed two.
 * A pair the fixture holds only half of is not judged; the caller says so.
 */
export async function conflictsSummary(input: { roomId: string; plants: readonly RecallPlant[]; twinsRefused: number }): Promise<ConflictsSummary> {
	const { store, duplicates } = await stateModules();
	const archive = store.readArchive(input.roomId);
	const reasons = conflictRowsInEvents(input.roomId);
	const pairs = await conflictPairsInCore(input.roomId);
	const shapes: ConflictShapeVerdict[] = [];
	/** The archive row that carries a planted line: by its code, else by its words with every value word of the line present, which is what tells a supersede pair's two rows apart. */
	const archiveRowOf = (plant: RecallPlant): ArchivedEntry | undefined => {
		const byCode = archive.find((row) => row.text.includes(plant.marker));
		if (byCode) return byCode;
		const values = duplicates.noteValueTokens(plant.line);
		return archive.find((row) => carriesWording(row.text, plant.line) && values.every((value) => duplicates.noteValueTokens(row.text).includes(value)));
	};
	const namesPlant = (text: string, plant: RecallPlant) => text.includes(plant.marker) || carriesWording(text, plant.line);
	for (const shape of CONFLICT_SHAPES) {
		const members = input.plants.filter((plant) => plant.shape === shape);
		if (members.length !== 2) continue;
		const [older, newer] = members;
		const detail = await locateEvidenceInDetail({ roomId: input.roomId, markers: [older.marker, newer.marker], plants: input.plants });
		const olderAt = detail[older.marker];
		const newerAt = detail[newer.marker];
		const olderRow = archiveRowOf(older);
		const newerRow = archiveRowOf(newer);
		/** Where a note is, in the words the line reads: "in the core" or "in the archive by budget"; null when it is no note at all. */
		const noteSays = (at: EvidenceLocationDetail, row: ArchivedEntry | undefined): string | null => {
			if (at.location === "core") return "in the core";
			if (at.location === "archive" && row?.why === "budget") return "in the archive by budget";
			return null;
		};
		if (shape === "duplicate") {
			const carrying = [...(await coreNoteTexts(input.roomId)), ...archive.map((row) => row.text)].filter((text) => carriesWording(text, older.line));
			const secondLanded = newerAt.how === "code";
			const superseded = reasons.some((row) => row.id === olderRow?.id || row.id === newerRow?.id) || olderRow?.why === "superseded" || newerRow?.why === "superseded";
			const problems: string[] = [];
			if (carrying.length !== 1) problems.push(`${carrying.length} notes carry the sentence, not one`);
			if (secondLanded) problems.push(`the second add landed as a note of its own (${newerAt.location})`);
			if (input.twinsRefused < 1) problems.push("the ingest refused no repeat");
			if (superseded) problems.push("a row was superseded for it");
			shapes.push({
				shape,
				ok: problems.length === 0,
				detail: problems.length === 0 ? `one note carries the sentence, the second add was refused as a repeat and left out (${newer.marker} reads ${newerAt.location}, found by ${newerAt.how ?? "nothing"})` : problems.join("; "),
			});
			continue;
		}
		if (shape === "decoy") {
			const olderNote = noteSays(olderAt, olderRow);
			const newerNote = noteSays(newerAt, newerRow);
			const paired = pairs.filter((pair) => [pair.a.text, pair.b.text].some((text) => namesPlant(text, older) || namesPlant(text, newer)));
			const problems: string[] = [];
			if (!olderNote) problems.push(`${older.marker} is no note (${olderAt.location}${olderRow ? `, ${olderRow.why}` : ""})`);
			if (!newerNote) problems.push(`${newer.marker} is no note (${newerAt.location}${newerRow ? `, ${newerRow.why}` : ""})`);
			if (paired.length > 0) problems.push(`${paired.length} pair(s) in the core name it: ${paired.map((pair) => duplicates.conflictNoteSentence(pair)).join(" | ")}`);
			if (olderRow?.why === "superseded" || newerRow?.why === "superseded") problems.push("one member was superseded");
			shapes.push({ shape, ok: problems.length === 0, detail: problems.length === 0 ? `both stay (${older.marker} ${olderNote}, ${newer.marker} ${newerNote}), no pair names either` : problems.join("; ") });
			continue;
		}
		// The three conflict shapes.
		const newerNote = noteSays(newerAt, newerRow);
		const reason = olderRow ? reasons.find((row) => row.id === olderRow.id) : undefined;
		const values = duplicates.conflictValuePairs(older.line, newer.line);
		const named = reason ? values.every((pair) => reason.reason.includes(pair.older) && reason.reason.includes(pair.newer)) : false;
		const problems: string[] = [];
		if (!newerNote) problems.push(`the newer wording ${newer.marker} is no note (${newerAt.location}${newerRow ? `, ${newerRow.why}` : ""})`);
		if (!olderRow) problems.push(`the older wording ${older.marker} is not in the archive (${olderAt.location})`);
		else if (olderRow.why !== "superseded") problems.push(`the older wording ${older.marker} left as ${olderRow.why}, not superseded`);
		if (olderRow && olderRow.why === "superseded") {
			if (!reason) problems.push(`the superseded row ${olderRow.id} has no reason in the Memorize records`);
			else if (!named) problems.push(`the reason on ${olderRow.id} does not name ${values.map((pair) => `${pair.older} and ${pair.newer}`).join(", ")}: "${reason.reason}"`);
		}
		shapes.push({
			shape,
			ok: problems.length === 0,
			detail: problems.length === 0 ? `${newer.marker} ${newerNote}, ${older.marker} superseded as ${olderRow?.id}: "${reason?.reason ?? ""}"` : problems.join("; "),
		});
	}
	return {
		found: reasons.length + pairs.length,
		supersededWithReason: reasons.length,
		leftAsBoth: pairs.length,
		twinsRefused: input.twinsRefused,
		shapes,
	};
}

/** The texts of the notes the core holds, through the product's own parser. */
async function coreNoteTexts(roomId: string): Promise<string[]> {
	const { entries } = await stateModules();
	return entries.parseMemoryDocument(readL1b(roomId)).topics.flatMap((topic) => topic.entries.map((entry) => entry.text));
}

/** `26 by budget · 10 superseded`, in the archive's own words, largest first. */
function reasonBreakdown(byWhy: Record<string, number>): string {
	const rows = Object.entries(byWhy).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
	return rows.length === 0 ? "none" : rows.map(([why, count]) => `${count} ${why === "budget" ? "by budget" : why}`).join(" · ");
}

/** The size story as one line: what the room holds, and what asking it cost. */
export function sizeLine(summary: RecallRunSummary): string {
	return [
		`${summary.sessions} conversations`,
		`${summary.notesInCore} notes in core, off a ${summary.backHistoryNotes}-note, ${summary.backHistoryTokens ?? 0}-token back history`,
		`${summary.archiveRows} rows in archive (${reasonBreakdown(summary.archiveByWhy ?? { budget: summary.archivedByBudget })})`,
		...(summary.evidenceByWhy ? [`${Object.values(summary.evidenceByWhy).reduce((total, count) => total + count, 0)} planted notes among them (${reasonBreakdown(summary.evidenceByWhy)})`] : []),
		...(summary.conversationDocs === undefined ? [] : [`${summary.conversationDocs} conversation documents searchable, ${summary.conversationMarkers ?? 0} planted facts only in them`]),
		`memory ${summary.memoryTokens}/${summary.memoryBudgetTokens} tokens`,
		`answer tokens median ${summary.answerTokensMedian}`,
		`total ${summary.answerTokensTotal}`,
	].join(" · ");
}

// --- The forgetting table ----------------------------------------------------

export interface ForgettingCell {
	count: number;
	answered: number;
	correct: number;
	/** null while no answer has been scored for this cell. */
	accuracy: number | null;
}

export interface ForgettingTable {
	abilities: RecallAbility[];
	locations: EvidenceLocation[];
	cell: (ability: RecallAbility, location: EvidenceLocation) => ForgettingCell;
	byAbility: (ability: RecallAbility) => ForgettingCell;
	byLocation: (location: EvidenceLocation) => ForgettingCell;
	total: ForgettingCell;
	/** The questions without a hint, which sit in a column of their own and in no cell above. */
	noHint: ForgettingCell;
}

function cellOf(rows: readonly RecallResultRow[]): ForgettingCell {
	const answered = rows.filter((row) => row.answered !== null);
	const correct = answered.filter((row) => row.answered === true);
	return { count: rows.length, answered: answered.length, correct: correct.length, accuracy: answered.length === 0 ? null : correct.length / answered.length };
}

/**
 * Accuracy per ability × location, with the totals down each edge. The
 * locations are always all four, even when a run put nothing in one of them: a
 * column of zeros is the finding that nothing was forgotten that way.
 */
export function forgettingTable(allRows: readonly RecallResultRow[]): ForgettingTable {
	// The no-hint questions are counted in their own column and left out of
	// every cell, edge and total the abilities are read off.
	const rows = allRows.filter((row) => !row.noHint);
	const abilities = [...new Set(rows.map((row) => row.ability))].sort();
	const locations = [...EVIDENCE_LOCATIONS];
	return {
		abilities,
		locations,
		cell: (ability, location) => cellOf(rows.filter((row) => row.ability === ability && row.location === location)),
		byAbility: (ability) => cellOf(rows.filter((row) => row.ability === ability)),
		byLocation: (location) => cellOf(rows.filter((row) => row.location === location)),
		total: cellOf(rows),
		noHint: cellOf(allRows.filter((row) => row.noHint)),
	};
}

// --- The results file --------------------------------------------------------

export interface RecallResultsFile {
	/** The bench and the fixture this file came out of; bumped when a field's meaning changes. */
	bench: "recall";
	schemaVersion: 1;
	label: string;
	runs: Array<{ summary: RecallRunSummary; steps: IngestStep[]; rows: RecallResultRow[] }>;
}

/**
 * The results, written so that two runs of one seed against the scripted models
 * produce BYTE-IDENTICAL files: nothing in the body is a clock reading, and
 * there is no `generatedAt` at all. The default path carries the date in its
 * NAME, which is the one place a date belongs; `--out` overrides it so a
 * reviewer can diff two runs without renaming anything.
 */
export function writeRecallResults(input: { label: string; runs: RecallResultsFile["runs"]; out?: string; today?: string }): string {
	const file: RecallResultsFile = { bench: "recall", schemaVersion: 1, label: input.label, runs: input.runs };
	const target = input.out ?? path.join(resultsDir(), `recall-${input.label}-${input.today ?? localDay()}.json`);
	fs.mkdirSync(path.dirname(target), { recursive: true });
	fs.writeFileSync(target, `${JSON.stringify(file, null, 2)}\n`);
	return target;
}

/**
 * Today where the run happened, not in UTC: a run at nine in the evening in
 * Europe would otherwise name its file with tomorrow's date, and the person
 * looking for it reads the clock on the wall.
 */
export function localDay(now = new Date()): string {
	return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Where a run's results land by default: beside the bench, in a directory of its own. */
export function resultsDir(): string {
	return path.join(fileURLToPath(new URL(".", import.meta.url)), "results");
}

// --- Printing ----------------------------------------------------------------

export function pad(value: string | number, width: number, right = false): string {
	const text = String(value);
	return right ? text.padStart(width) : text.padEnd(width);
}

/** A rank as a table reads it: the position, "none" when the query came back without it, "n/a" when nothing was asked of recall. */
export function rankCell(rank: Rank): string {
	return rank === RANK_NOT_APPLICABLE ? "n/a" : rank === null ? "none" : String(rank);
}

/** An accuracy as a table reads it, or a dash while nothing has been answered. */
export function accuracyCell(cell: ForgettingCell): string {
	if (cell.count === 0) return "-";
	if (cell.accuracy === null) return `${cell.count}/-`;
	return `${cell.correct}/${cell.answered} ${Math.round(cell.accuracy * 100)}%`;
}

// --- Asking the room ---------------------------------------------------------
//
// Everything below is the `--ask` half: the room answers the fixture's
// questions the way it answers a person, which means through the real server
// and the real WebSocket turn — the room's own system prompt, its own memory
// render, its own `memory_recall` tool. Nothing here reimplements a turn.
//
// What a run scripts is again only the MODEL: an OpenAI-compatible gateway on a
// random port whose first leg calls `memory_recall` with the question's literal
// query and whose second leg quotes back the lines that carry the question's
// evidence markers, wherever they reached it from — the tool's results or the
// memory in its own system prompt. That is a room that reads perfectly and
// invents nothing, so the accuracy it scores is the accuracy the MEMORY allows,
// which is the number this bench exists for. A real model goes in the same
// place and is measured against the same ceiling.

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import http from "node:http";
import type { AddressInfo } from "node:net";

import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "../smoke-server-process.js";

const benchScriptsDir = fileURLToPath(new URL(".", import.meta.url));
const webServerDir = path.resolve(benchScriptsDir, "..", "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

/** The provider id the scripted room model is served under; a real run uses its own profile instead. */
export const SCRIPTED_PROVIDER_ID = "openai-compatible";

// --- The scripted room model -------------------------------------------------

export interface ScriptedRoomGateway {
	port: number;
	/** Chat completions the room asked for, in order. */
	calls: number;
	/** Completions the `fail` option answered with an error instead. */
	failed: number;
	close(): Promise<void>;
}

/**
 * A provider that says no, on cue: every completion whose request body carries
 * `marker` is answered with an HTTP 500 and a JSON error body, `times` times
 * or always. It is how a smoke makes a checkpoint fail without a provider,
 * and what it exercises is the bench's own waiting, not the runtime's: the
 * runtime turns the 500 into a worker turn that stopped on "error", which is
 * the shape the real failure had.
 */
export interface ScriptedGatewayFailure {
	marker: string;
	times: number | "all";
	/** Instead of a 500, no answer at all: the request is held open until the gateway closes, the way a provider that has stopped talking looks to a worker with a time limit. */
	hang?: boolean;
}

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

/** Every line of text the request carries, the system prompt and the tool results alike. */
function requestLines(parsed: { messages?: Array<{ content?: unknown }> }): string[] {
	const texts: string[] = [];
	for (const message of parsed.messages ?? []) {
		const content = message?.content;
		if (typeof content === "string") texts.push(content);
		else if (Array.isArray(content)) for (const part of content) if (typeof (part as { text?: string })?.text === "string") texts.push((part as { text: string }).text);
	}
	return texts.join("\n").split(/\r?\n/);
}

/** A planted sentence's own words with its reference code taken out: what a careful fold keeps. */
function withoutMarkerCode(line: string): string {
	return line.replace(/\b[A-Z]{2,}-[A-Z]?\d+\b/g, "").replace(/\s{2,}/g, " ").replace(/^\s*[-*+]\s*/, "").trim();
}

/** The lines of this prompt that carry a planted sentence: a reference code inside a sentence. */
function plantedLinesIn(lines: readonly string[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const line of lines) {
		if (!/\b[A-Z]{2,}-[A-Z]?\d+\b/.test(line)) continue;
		const text = line.replace(/^\s*[-*+]\s*/, "").trim();
		if (!text || text.startsWith("<!--") || text.startsWith("#") || seen.has(text)) continue;
		seen.add(text);
		out.push(text);
	}
	return out;
}

/** The lines under one `## ` heading of a maintenance prompt, up to the next one. */
function sectionLines(lines: readonly string[], heading: string): string[] {
	const start = lines.findIndex((line) => line.trim().startsWith(`## ${heading}`));
	if (start < 0) return [];
	const rest = lines.slice(start + 1);
	const end = rest.findIndex((line) => /^##\s/.test(line.trim()));
	return end < 0 ? rest : rest.slice(0, end);
}

/**
 * The scripted answer to a maintenance prompt, or null when this is an ordinary
 * room turn. A Remember's compression is answered with the fields contract and
 * the conversation's own sentences; a fold is answered with one `add` per
 * planted sentence, its reference code removed — so a run driven this way puts
 * the facts in memory in words that no code search can find, which is exactly
 * the shape a real model's ingest leaves behind.
 */
function maintenanceReply(lines: readonly string[], body: string): string | null {
	if (body.includes("Produce the checkpoint compression fields now.")) {
		// Only the TRANSCRIPT's sentences: the same prompt also carries the whole
		// current memory, and compressing that back into a Recent Context entry
		// would be a draft the size of the room.
		const transcript = sectionLines(lines, "Material: Frozen Active-Thread Transcript Snapshot");
		const planted = plantedLinesIn(transcript).slice(0, 8).map((line) => line.slice(0, 300));
		const bullets = planted.length > 0 ? planted : ["Nothing durable was settled."];
		return [
			"TITLE: What this sitting settled",
			"SESSION_ARC: The conversation settled the points below and nothing else that outlives it.",
			"BODY:",
			...bullets.map((line) => `- ${line}`),
			"PARKED: None",
		].join("\n");
	}
	if (body.includes("Fold this session into memory now.")) {
		const facts = plantedLinesIn(sectionLines(lines, "Material: The Session To Fold")).slice(0, 6).map(withoutMarkerCode).filter((line) => line.length > 0);
		const ops = facts.length === 0
			? [{ op: "drop", reason: "nothing in this conversation outlives it" }]
			: facts.map((line) => ({ op: "add", topic: "Bench Notes", kind: "fact", text: `- ${line}` }));
		return `This conversation leaves ${ops.length} change${ops.length === 1 ? "" : "s"} behind.\n\n\`\`\`json\n${JSON.stringify({ ops }, null, 2)}\n\`\`\``;
	}
	return null;
}

/** What a room says when its memory holds no answer, in the language it was asked in. */
function notKnownSentence(language: string): string {
	return language === "de" ? "Das weiss ich nicht; dazu liegt mir nichts vor." : "I don't know; that was not mentioned in anything I hold.";
}

/**
 * The scripted room: leg one calls `memory_recall` with the question's own
 * literal query, and with the sources the run restricted it to; leg two answers
 * by quoting, verbatim, the first line of the turn that carries each of the
 * question's evidence markers — from the tool's results when the search
 * returned them, out of the archive or out of a conversation the room kept,
 * from the memory in the system prompt when the core still holds them. A question whose evidence reached neither is
 * answered with "I don't know", which is the right answer to a question about
 * something the room no longer has and the wrong answer to everything else.
 */
export async function startScriptedRoomGateway(input: { questions: readonly RecallQuestion[]; plants?: readonly RecallPlant[]; sources?: readonly RecallSource[]; fail?: ScriptedGatewayFailure }): Promise<ScriptedRoomGateway> {
	const lineByMarker = new Map((input.plants ?? []).map((plant) => [plant.marker, plant.line] as const));
	let calls = 0;
	let failed = 0;
	/** Requests held open by a hang on cue, so closing the gateway can end them. */
	const hung = new Set<http.ServerResponse>();
	const server = http.createServer((req, res) => {
		if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
			res.writeHead(404).end();
			return;
		}
		let body = "";
		req.on("data", (chunk) => { body += chunk; });
		req.on("end", () => {
			calls += 1;
			// The failure on cue, before anything is read off the request: a
			// provider that is down does not answer the question it was asked.
			if (input.fail && body.includes(input.fail.marker) && (input.fail.times === "all" || failed < input.fail.times)) {
				failed += 1;
				if (input.fail.hang) {
					// Held open, never answered: the worker's own limit is what ends it.
					hung.add(res);
					res.on("close", () => hung.delete(res));
					return;
				}
				res.writeHead(500, { "content-type": "application/json" });
				res.end(JSON.stringify({ error: { message: `scripted provider failure ${failed}`, type: "server_error", code: "scripted_failure" } }));
				return;
			}
			let parsed: { messages?: Array<{ role?: string; content?: unknown }>; model?: string } = {};
			try { parsed = JSON.parse(body); } catch { /* an unreadable body is answered like an unknown question */ }
			const messages = parsed.messages ?? [];
			const lines = requestLines(parsed);
			const userText = messages.filter((message) => message.role === "user").map((message) => (typeof message.content === "string" ? message.content : Array.isArray(message.content) ? message.content.map((part) => (part as { text?: string })?.text ?? "").join(" ") : "")).join("\n");
			// The question in flight, found by its own words in the ask.
			const question = [...input.questions].sort((a, b) => b.question.length - a.question.length).find((candidate) => userText.includes(candidate.question));
			const hasToolResults = messages.some((message) => message.role === "tool");
			const base = { id: `recall_${calls}`, object: "chat.completion.chunk", created: 1, model: String(parsed.model ?? "room-model") };
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			// The two MAINTENANCE prompts, when a run drives the real ingest against
			// this gateway instead of a provider. They are answered the way a
			// careful model answers them — the facts kept, the fixture's reference
			// codes DROPPED, which is what a real fold does and what the wording
			// fallback in `locateEvidenceInDetail` exists for.
			const maintenance = maintenanceReply(lines, body);
			if (maintenance !== null) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: maintenance }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 2400, completion_tokens: estimateTokens(maintenance), total_tokens: 2400 + estimateTokens(maintenance) } }));
				res.write("data: [DONE]\n\n");
				res.end();
				return;
			}
			if (!hasToolResults && question) {
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: `call_${calls}`, type: "function", function: { name: "memory_recall", arguments: "" } }] }, finish_reason: null }] }));
				// The literal query, and the sources the run restricted it to when it
				// restricted them: the room asks for what the run is measuring.
				const callArguments = JSON.stringify({ query: question.queries.literal, ...(input.sources === undefined ? {} : { sources: [...input.sources] }), maxResults: 10 });
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: callArguments } }] }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 1200, completion_tokens: 30, total_tokens: 1230 } }));
			} else {
				const quoted: string[] = [];
				for (const evidence of question?.evidence ?? []) {
					// By the reference code where the note still carries it, and by
					// the planted sentence's words where a fold has rewritten it —
					// a room reads its memory, not the bench's scaffolding.
					const planted = lineByMarker.get(evidence.marker);
					const line = lines.find((row) => row.includes(evidence.marker)) ?? (planted ? lines.find((row) => carriesWording(row, planted)) : undefined);
					if (line && !quoted.includes(line.trim())) quoted.push(line.trim());
				}
				const answer = quoted.length > 0 ? quoted.join(" ") : notKnownSentence(question?.language ?? "en");
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: answer }, finish_reason: null }] }));
				res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1400, completion_tokens: estimateTokens(answer), total_tokens: 1400 + estimateTokens(answer) } }));
			}
			res.write("data: [DONE]\n\n");
			res.end();
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
	const port = (server.address() as AddressInfo).port;
	return {
		port,
		get calls() { return calls; },
		get failed() { return failed; },
		close: () => new Promise<void>((resolve) => {
			for (const res of hung) res.destroy();
			hung.clear();
			server.close(() => resolve());
		}),
	};
}

// --- The server --------------------------------------------------------------

export interface BenchServer {
	port: number;
	baseUrl: string;
	model: { provider: string; model: string };
	stop(): Promise<void>;
	/** Everything the server printed, for a failure that needs explaining. */
	output: string[];
}

/**
 * The product's own web server, spawned on the bench's temp home. The keys of
 * the machine this runs on are stripped from its environment, so a run can only
 * reach the provider its temp home was given.
 */
export async function startBenchServer(input: { home: string; model: { provider: string; model: string }; port?: number }): Promise<BenchServer> {
	// A random port is a guess, and a machine running two of these at once (or
	// anything else on that number) makes the guess wrong. One retry on a fresh
	// port is the difference between a run that starts and a run that reports a
	// bench failure for something that has nothing to do with the bench.
	try {
		return await startBenchServerOnce(input);
	} catch (error) {
		if (!/EADDRINUSE|address already in use|port .* in use/i.test((error as Error).message)) throw error;
		console.log(`server: port was already in use, trying another one`);
		return startBenchServerOnce({ ...input, port: undefined });
	}
}

async function startBenchServerOnce(input: { home: string; model: { provider: string; model: string }; port?: number }): Promise<BenchServer> {
	const home = homeOrThrow();
	if (path.resolve(input.home) !== path.resolve(home.home)) throw new Error(`startBenchServer was handed ${input.home}, and this run's home is ${home.home}`);
	const port = input.port ?? 39000 + Math.floor(Math.random() * 2000);
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) delete env[key];
	env.HOME = home.home;
	env.USERPROFILE = home.home;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = path.join(home.home, ".exxperts", "agent");
	const child = spawn("npx", ["tsx", "src/index.ts"], { shell: process.platform === "win32", ...SMOKE_SERVER_SPAWN_TREE_OPTIONS, cwd: webServerDir, env });
	const output: string[] = [];
	child.stdout.on("data", (chunk) => output.push(String(chunk)));
	child.stderr.on("data", (chunk) => output.push(String(chunk)));
	const baseUrl = `http://127.0.0.1:${port}`;
	const deadline = Date.now() + 60_000;
	for (;;) {
		if (child.exitCode != null) throw new Error(`the server exited with code ${child.exitCode} before it was ready: ${output.join("").slice(-800)}`);
		if (/EADDRINUSE/.test(output.join(""))) throw new Error(`EADDRINUSE: port ${port} is already in use`);
		if (Date.now() > deadline) throw new Error(`the server never became ready: ${output.join("").slice(-800)}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) break;
		} catch { /* not up yet */ }
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	return { port, baseUrl, model: input.model, output, stop: () => stopSmokeServer(child) };
}

/**
 * The provider records the server reads: the model catalogue, the key, and the
 * two AI-profile files. `baseUrl` points the provider at the scripted gateway;
 * a real run copies the machine's own records instead (`useRealProviderRecords`).
 */
export function writeScriptedProviderRecords(input: { gatewayPort: number; modelId?: string }): { provider: string; model: string } {
	const home = homeOrThrow();
	const agentDir = path.join(home.home, ".exxperts", "agent");
	const appDir = path.join(home.home, ".exxperts", "app");
	const modelId = input.modelId ?? BENCH_MODEL.model;
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(
		path.join(agentDir, "models.json"),
		JSON.stringify({ providers: { [SCRIPTED_PROVIDER_ID]: { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${input.gatewayPort}/v1`, api: "openai-completions", models: [{ id: modelId, name: "Room Model", contextWindow: 128_000, maxTokens: 16_384 }] } } }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [SCRIPTED_PROVIDER_ID]: { type: "api_key", key: "synthetic-recall-bench-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(
		path.join(appDir, `${SCRIPTED_PROVIDER_ID}-ai-profile.json`),
		JSON.stringify({ profileId: SCRIPTED_PROVIDER_ID, providerId: SCRIPTED_PROVIDER_ID, label: "Synthetic Gateway", roomModels: [{ modelId, label: "Room Model" }], maintenanceModel: modelId }, null, 2),
		{ mode: 0o600 },
	);
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: SCRIPTED_PROVIDER_ID }, null, 2), { mode: 0o600 });
	return { provider: SCRIPTED_PROVIDER_ID, model: modelId };
}

/**
 * The machine's own provider records, COPIED into the temp home read-only: the
 * model catalogue and the signed-in credentials, so a real-model run reaches
 * the provider the person is already signed in to. Nothing is ever written
 * back, and no key is ever printed — the copy is read, never echoed.
 */
export function useRealProviderRecords(input: { spec: string }): { provider: string; model: string } {
	const home = homeOrThrow();
	const slash = input.spec.indexOf("/");
	if (slash < 1) throw new Error(`the model must read provider/model, e.g. anthropic/claude-sonnet-5 — got "${input.spec}"`);
	const provider = input.spec.slice(0, slash);
	const model = input.spec.slice(slash + 1);
	const realAgentDir = path.join(realHomeDir, ".exxperts", "agent");
	const agentDir = path.join(home.home, ".exxperts", "agent");
	const appDir = path.join(home.home, ".exxperts", "app");
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	for (const file of ["models.json", "auth.json"]) {
		const from = path.join(realAgentDir, file);
		if (!fs.existsSync(from)) throw new Error(`${from} is not there, so this machine has nothing signed in to copy; sign the provider in under AI setup first`);
		fs.copyFileSync(from, path.join(agentDir, file));
		fs.chmodSync(path.join(agentDir, file), 0o600);
	}
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: provider }, null, 2), { mode: 0o600 });
	return { provider, model };
}

// --- One turn ----------------------------------------------------------------

export interface AskTurn {
	answer: string;
	/**
	 * Set when the provider ended the room's turn: an assistant message that
	 * stopped on "error" or "aborted". The turn still ends the way every turn
	 * ends, with no text in it, so without this an answer the provider never
	 * gave reads as an empty answer the room did give.
	 */
	providerError?: string;
	/** Tool calls the turn made, by name, in order. */
	toolCalls: string[];
	recallCalls: number;
	usage: { input: number; output: number; total: number; cost: number };
}

type Frame = Record<string, any>;

/**
 * One question, in its own fresh conversation on the room, through the real
 * turn: the conversation is made the room's active thread the way the launcher
 * makes one, the prompt goes over the WebSocket, and the answer is read off the
 * `message_end` frames — the authoritative full messages, which carry the
 * assistant's text and every tool call by name.
 */
export async function askRoom(input: { server: BenchServer; roomId: string; conversationId: string; prompt: string; timeoutMs?: number }): Promise<AskTurn> {
	// A turn that has just ended is still being written down when the next one
	// starts: the socket's close and the room's own bookkeeping land after
	// `agent_end`, and a conversation made active in that window can be overtaken
	// by the previous one's last write. A person types between turns and never
	// sees it; this harness does not, so it asks again rather than calling it a
	// failure — the same courtesy the room's other smokes extend.
	let lastError: Error | null = null;
	for (let attempt = 1; attempt <= 6; attempt++) {
		try {
			return await askOnce(input);
		} catch (error) {
			lastError = error as Error;
			if (!/requires the current activeThread|still running|is cancelling/.test(lastError.message)) throw lastError;
			await new Promise((resolve) => setTimeout(resolve, 200 * attempt));
		}
	}
	throw lastError ?? new Error("the room never accepted the turn");
}

async function askOnce(input: { server: BenchServer; roomId: string; conversationId: string; prompt: string; timeoutMs?: number }): Promise<AskTurn> {
	const { server, roomId, conversationId } = input;
	const put = await authedFetch(`${server.baseUrl}/api/persistent-agents/${roomId}/threads/${conversationId}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ state: "active", origin: "launcher", model: server.model, items: [] }),
	});
	if (put.status !== 200) throw new Error(`making ${conversationId} the room's active conversation returned ${put.status}: ${(await put.text()).slice(0, 300)}`);

	const WebSocketImpl: any = (await import("ws")).default;
	const socket = new WebSocketImpl(
		`${server.baseUrl.replace("http", "ws")}/ws?persistentAgentId=${encodeURIComponent(roomId)}&conversationId=${encodeURIComponent(conversationId)}&modelProvider=${encodeURIComponent(server.model.provider)}&model=${encodeURIComponent(server.model.model)}&reattach=1`,
		{ headers: { ...SMOKE_AUTH_HEADERS } },
	);
	const frames: Frame[] = [];
	socket.addEventListener("message", (event: { data: unknown }) => {
		try { frames.push(JSON.parse(String(event.data))); } catch { /* a frame that is not JSON is not a frame this bench reads */ }
	});
	try {
		await new Promise<void>((resolve, reject) => {
			socket.addEventListener("open", () => resolve());
			socket.addEventListener("error", () => reject(new Error("the WebSocket did not connect")));
		});
		socket.send(JSON.stringify({ type: "prompt", text: input.prompt }));
		const deadline = Date.now() + (input.timeoutMs ?? 180_000);
		for (;;) {
			if (frames.some((frame) => frame.type === "event" && frame.event?.type === "agent_end")) break;
			const error = frames.find((frame) => frame.type === "error");
			if (error) throw new Error(`the room refused the turn: ${error.message}`);
			if (Date.now() > deadline) throw new Error(`the turn did not end in time; frames: ${frames.map((frame) => frame.event?.type ?? frame.type).join(", ")}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		return readTurn(frames);
	} finally {
		// The socket is closed and the room is given the moment its own
		// bookkeeping takes, so the next question starts on a settled room.
		try { socket.close(); } catch { /* the turn is over either way */ }
		await new Promise((resolve) => setTimeout(resolve, 120));
	}
}

/** The answer, the tool calls and the usage, read off one turn's frames. */
function readTurn(frames: readonly Frame[]): AskTurn {
	const messages = frames.filter((frame) => frame.type === "event" && frame.event?.type === "message_end").map((frame) => frame.event.message);
	const texts: string[] = [];
	const toolCalls: string[] = [];
	for (const message of messages) {
		if (message?.role !== "assistant") continue;
		for (const part of message.content ?? []) {
			if (part?.type === "text" && typeof part.text === "string" && part.text.trim()) texts.push(part.text.trim());
			if (part?.type === "toolCall" && typeof part.name === "string") toolCalls.push(part.name);
		}
	}
	const usage = frames.filter((frame) => frame.type === "usage_turn").reduce<{ input: number; output: number; total: number; cost: number }>(
		(total, frame) => ({
			input: total.input + (Number(frame.input) || 0),
			output: total.output + (Number(frame.output) || 0),
			total: total.total + (Number(frame.totalTokens) || 0),
			cost: total.cost + (Number(frame.cost) || 0),
		}),
		{ input: 0, output: 0, total: 0, cost: 0 },
	);
	const ended = messages.find((message) => message?.role === "assistant" && (message.stopReason === "error" || message.stopReason === "aborted"));
	const providerError = ended ? String(ended.errorMessage ?? "").trim() || `the turn stopped on "${ended.stopReason}" without a message` : undefined;
	return { answer: texts.join("\n\n"), toolCalls, recallCalls: toolCalls.filter((name) => name === "memory_recall").length, usage, ...(providerError ? { providerError } : {}) };
}

/**
 * What the SCRIPTED room will answer, worked out from the room's own files
 * rather than from the turn: the same rule the gateway's second leg follows —
 * quote the note behind each piece of evidence the turn can actually see, and
 * say "I don't know" when it can see none.
 *
 * A piece of evidence is visible when the core or Recent Context still holds
 * it, because those are in the room's system prompt, or when it is in the
 * archive or in a conversation the room kept AND the one recall the room makes
 * with the question's literal query brought that document back — a line the
 * room only ever heard is reachable on exactly the terms an archived note is,
 * which is that the search returned it. Everything else is out of reach, and a
 * question whose gold value is not
 * in the text that IS in reach — an interval between two dates, say, which is
 * arithmetic over the quoted lines — is one the scripted room cannot answer.
 *
 * So `scoreAnswer` applied to this prediction is the scripted CEILING for that
 * question, and a run can hold the room to it exactly.
 */
export function predictScriptedRoomAnswer(input: {
	question: RecallQuestion;
	evidence: ReadonlyArray<{ marker: string; location: EvidenceLocation; literalRank: number | null; text?: string }>;
}): string {
	const quoted: string[] = [];
	for (const piece of input.evidence) {
		// In front of the room, or brought back by the one recall it makes: an
		// archived note and a line of a conversation it kept are reachable on the
		// same terms, which is that the literal query returned the document.
		const reachable = piece.location === "core"
			|| piece.location === "recent"
			|| (RETRIEVED_LOCATIONS.has(piece.location) && piece.literalRank !== null);
		const line = piece.text?.trim();
		if (!reachable || !line || quoted.includes(line)) continue;
		quoted.push(line);
	}
	return quoted.length > 0 ? quoted.join(" ") : notKnownSentence(input.question.language);
}

/** The ask, in the language the question is in: the date the room is asked on, then the question. */
export function askPrompt(question: RecallQuestion): string {
	return question.language === "de" ? `Heute ist ${question.askDate}. ${question.question}` : `Today is ${question.askDate}. ${question.question}`;
}

/** A conversation id for one question: derived from its own id, and long enough for the thread rule. */
export function askConversationId(question: RecallQuestion): string {
	return `c_ask_${question.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

// --- The worker one real call is made through ---------------------------------
//
// Every call this bench makes to a real model goes through the SAME isolated
// worker the product's own maintenance calls use: the checkpoint compression, a
// fold, a judge's verdict, a baseline's one big prompt. One helper for all of
// them, so no caller can quietly build a second, different way of reaching a
// provider and then report its numbers beside the product's.
//
// No server is needed. The registry is built from the provider records in this
// run's temp home, which `useRealProviderRecords` copied there.

/** One call, with the fields the worker names; the result is the worker's own, usage and truncation included. */
export interface MaintenanceWorkerCall {
	prompt: string;
	modelLock: { provider: string; model: string };
	/** What the failure messages call this worker, e.g. "memorize fold worker". */
	label: string;
	triggerPrompt: string;
	emptyTextError: string;
	signal?: AbortSignal;
	timeoutMs?: number;
	/**
	 * A ceiling on the reply, in tokens. The worker takes the model's own
	 * `maxTokens`, which is the right answer for a fold or a compression and the
	 * wrong one for a judge: upstream's judge asks for "yes or no only" and caps
	 * the reply at ten, and a judge that is free to write an essay is a judge
	 * whose label reads the word "yes" somewhere in the essay. The cap is
	 * applied by handing the worker the model with this `maxTokens`.
	 */
	maxOutputTokens?: number;
}

// --- Waiting a provider out ----------------------------------------------------
//
// The worker makes ONE attempt, on purpose: a retry there would restart a
// long maintenance reply from its first token inside the product, where the
// caller has the better-informed retry. A bench is that caller. A run of fifty
// instances is hours of calls, and the one thing that ends it early is a
// provider that says no for a while: a subscription's usage window closing for
// the rest of the hour, or a 5xx that clears in a minute. Both are waited out
// here, on a schedule that adds up to just under two hours, and only then does
// the call give up, with an error a caller can tell apart from every other one.

/** The waits between attempts: one minute, five, fifteen, thirty, sixty. Six attempts in all. */
const PROVIDER_RETRY_SCHEDULE_MS: readonly number[] = [1, 5, 15, 30, 60].map((minutes) => minutes * 60_000);

/** The schedule a run uses: the one above, or the milliseconds a smoke put in RECALL_BENCH_RETRY_SCHEDULE_MS. */
function providerRetrySchedule(): readonly number[] {
	const raw = process.env.RECALL_BENCH_RETRY_SCHEDULE_MS?.trim();
	if (!raw) return PROVIDER_RETRY_SCHEDULE_MS;
	const waits = raw.split(",").map((piece) => Number(piece.trim()));
	if (waits.length === 0 || waits.some((wait) => !Number.isFinite(wait) || wait < 0)) throw new Error(`RECALL_BENCH_RETRY_SCHEDULE_MS reads "10,10,10", milliseconds between attempts, and it reads "${raw}"`);
	return waits;
}

/** The limit one worker call of the bench's ingest gets, or the milliseconds a smoke put in RECALL_BENCH_WORKER_TIMEOUT_MS. */
function benchWorkerTimeoutMs(productMs: number): number {
	const raw = process.env.RECALL_BENCH_WORKER_TIMEOUT_MS?.trim();
	if (!raw) return productMs;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`RECALL_BENCH_WORKER_TIMEOUT_MS reads milliseconds, and it reads "${raw}"`);
	return ms;
}

/** The limit a Memorize of the bench's ingest has to settle in, or the milliseconds a smoke put in RECALL_BENCH_SETTLE_TIMEOUT_MS. */
function benchSettleTimeoutMs(defaultMs: number): number {
	const raw = process.env.RECALL_BENCH_SETTLE_TIMEOUT_MS?.trim();
	if (!raw) return defaultMs;
	const ms = Number(raw);
	if (!Number.isFinite(ms) || ms <= 0) throw new Error(`RECALL_BENCH_SETTLE_TIMEOUT_MS reads milliseconds, and it reads "${raw}"`);
	return ms;
}

/** A wait as the line prints it: whole minutes when it is minutes, seconds when it is seconds, milliseconds otherwise. */
function waitLabel(ms: number): string {
	if (ms > 0 && ms % 60_000 === 0) return `${ms / 60_000} min`;
	if (ms > 0 && ms % 1000 === 0) return `${ms / 1000} s`;
	return `${ms} ms`;
}

/**
 * The provider kept failing through every wait of the schedule. `label` is the
 * worker or the step that was being retried, `lastMessage` the provider's last
 * word on it, so an instance can be marked failed with a sentence that says
 * which step, which worker and what the provider said.
 */
export class ProviderGaveUpError extends Error {
	readonly label: string;
	readonly lastMessage: string;
	readonly attempts: number;
	constructor(label: string, lastMessage: string, attempts: number) {
		super(`${label} gave up after ${attempts} attempt${attempts === 1 ? "" : "s"}; the last error was: ${lastMessage}`);
		this.name = "ProviderGaveUpError";
		this.label = label;
		this.lastMessage = lastMessage;
		this.attempts = attempts;
	}
}

/**
 * A worker turn the provider ended, as the runtime reports one: its error
 * class carries `stopReason` "error" (the provider's HTTP failure, a refused
 * request) or "aborted" (a stalled stream stopped at its limit). Read by name
 * rather than by class so the runtime module, which reads the home when it is
 * imported, is not imported here.
 */
function isProviderTurnError(error: unknown): error is Error & { stopReason: "error" | "aborted"; providerMessage?: string } {
	const candidate = error as { name?: unknown; stopReason?: unknown } | null;
	return !!candidate && candidate.name === "IsolatedPersistentAgentWorkerTurnError" && (candidate.stopReason === "error" || candidate.stopReason === "aborted");
}

/**
 * `attempt`, waited out on the schedule when the provider says no: an
 * `IsolatedPersistentAgentWorkerTurnError` with stopReason "error" or "aborted"
 * is retried after 1, 5, 15, 30 and 60 minutes, six attempts in all, and then
 * becomes a `ProviderGaveUpError`. Every wait prints one line. Any other error
 * propagates at once, because a prompt the parser refused or a model that is
 * not there will not be fixed by waiting. `retryOn` widens the rule for a
 * caller whose failure is not the worker's class, the room's own turn for one;
 * `signal` stops the waiting when the caller itself asked for the abort.
 */
/** Every millisecond this process has spent waiting a provider out, the waits and the failed attempts alike; a caller with a time limit of its own adds what was waited inside it. */
let providerWaitedMs = 0;
/** When each attempt still in flight started: a call that is hanging has cost its time already, before its limit stops it. */
const attemptsInFlight = new Set<number>();

/** What the provider has cost so far: the waits, the failed attempts, and the attempts still running. A limit of the caller's own is measured beside this, never against it. */
function providerBusyMs(): number {
	const now = Date.now();
	let inFlight = 0;
	for (const startedAt of attemptsInFlight) inFlight += now - startedAt;
	return providerWaitedMs + inFlight;
}
/** How often the schedule ran out, and the last time's error; a Memorize reads them to know a fold inside it gave up. */
let providerGaveUpCount = 0;
let lastProviderGiveUp: ProviderGaveUpError | null = null;
/** True from a give-up until the caller starts its next unit of work: the rest of that unit fails at once instead of waiting two hours per call. */
let providerGaveUpInThisUnit = false;

/**
 * The start of a unit of work the waiting is budgeted per, an instance of the
 * adapter for one: after the schedule ran out once inside a unit, every later
 * provider failure of that unit gives up at its first attempt, because a room
 * already marked failed is not worth another two hours per call; the next unit
 * gets the whole schedule again.
 */
export function startProviderRetryUnit(): void {
	providerGaveUpInThisUnit = false;
}

export async function withProviderRetry<T>(label: string, attempt: (attemptNumber: number) => Promise<T>, options?: { retryOn?: (error: unknown) => boolean; signal?: AbortSignal }): Promise<T> {
	const schedule = providerGaveUpInThisUnit ? [] : providerRetrySchedule();
	const attempts = schedule.length + 1;
	const retryable = options?.retryOn ?? isProviderTurnError;
	let lastMessage = "";
	for (let number = 1; number <= attempts; number++) {
		const startedAt = Date.now();
		attemptsInFlight.add(startedAt);
		try {
			return await attempt(number);
		} catch (error) {
			if (!retryable(error) || options?.signal?.aborted) throw error;
			// A call that hung until its limit stopped it cost that whole limit, and
			// a Memorize with its own limit must not read that time as its own.
			providerWaitedMs += Date.now() - startedAt;
			const provider = (error as { providerMessage?: unknown }).providerMessage;
			lastMessage = typeof provider === "string" && provider.trim() ? provider.trim() : (error as Error).message;
			if (number === attempts) break;
			const wait = schedule[number - 1];
			console.log(`provider error on ${label} (${lastMessage}): waiting ${waitLabel(wait)} before attempt ${number + 1} of ${attempts}`);
			providerWaitedMs += wait;
			await new Promise((resolve) => setTimeout(resolve, wait));
		} finally {
			attemptsInFlight.delete(startedAt);
		}
	}
	const gaveUp = new ProviderGaveUpError(label, lastMessage, attempts);
	providerGaveUpCount += 1;
	lastProviderGiveUp = gaveUp;
	providerGaveUpInThisUnit = true;
	throw gaveUp;
}

export interface MaintenanceWorker {
	call(input: MaintenanceWorkerCall): Promise<Awaited<ReturnType<typeof import("../../src/persistent-agent-worker-runtime.js").runIsolatedPersistentAgentWorker>>>;
	/** The model's context window as the registry reports it, and null when it declares none. */
	contextWindow(modelLock: { provider: string; model: string }): number | null;
	/** Everything this worker spent, summed as the product records it. */
	usage(): { input: number; output: number; totalTokens: number; cost: number; calls: number };
}

/**
 * The worker, built once per run. The registry it reads is the temp home's, so
 * a caller can only reach the provider that home was given, and a model that is
 * not there or not signed in fails with a sentence that says which.
 */
export async function createMaintenanceWorker(): Promise<MaintenanceWorker> {
	homeOrThrow();
	const { AuthStorage, getAgentDir, ModelRegistry } = await import("@exxeta/exxperts-runtime");
	const { runIsolatedPersistentAgentWorker } = await import("../../src/persistent-agent-worker-runtime.js");
	const { stripProviderSearchFromModel } = await import("../../../../pi-package/extensions/web-search/native-provider-search.js");
	const registry = ModelRegistry.create(AuthStorage.create());
	const spent = { input: 0, output: 0, totalTokens: 0, cost: 0, calls: 0 };
	const found = (modelLock: { provider: string; model: string }) => {
		const model = registry.find(modelLock.provider, modelLock.model);
		if (!model) throw new Error(`model not found: ${modelLock.provider}/${modelLock.model} — check the id, or sign the provider in first`);
		return model;
	};
	return {
		call: async (input) => {
			const model = found(input.modelLock);
			if (!registry.hasConfiguredAuth(model)) throw new Error(`provider not connected: ${input.modelLock.provider} — sign in first, then rerun`);
			// Waited out here, once for every caller: the checkpoint and the fold of
			// an ingest, a baseline's one big prompt and a judge's verdict all come
			// through this call, so none of them can end a run on a provider's bad
			// hour. The worker itself still makes one attempt per call.
			const result = await withProviderRetry(input.label, () => runIsolatedPersistentAgentWorker({
				workerSystemPrompt: input.prompt,
				triggerPrompt: input.triggerPrompt,
				modelLock: input.modelLock,
				resolveExpectedModel: () => {
					const resolved = stripProviderSearchFromModel(model);
					return input.maxOutputTokens ? { ...resolved, maxTokens: input.maxOutputTokens } : resolved;
				},
				workerLabel: input.label,
				emptyTextError: input.emptyTextError,
				cwd: repoRoot,
				agentDir: getAgentDir(),
				modelRegistry: registry,
				// A single-shot transform either way: reasoning tokens would count
				// against the output cap and starve the reply itself.
				thinkingLevel: "low",
				...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
				...(input.signal ? { signal: input.signal } : {}),
			}), { signal: input.signal });
			spent.calls += 1;
			spent.input += result.usage?.input ?? 0;
			spent.output += result.usage?.output ?? 0;
			spent.totalTokens += result.usage?.totalTokens ?? 0;
			spent.cost += result.usage?.cost ?? 0;
			return result;
		},
		contextWindow: (modelLock) => {
			const window = found(modelLock).contextWindow;
			return typeof window === "number" && window > 0 ? window : null;
		},
		usage: () => ({ ...spent }),
	};
}

// --- The real ingest ---------------------------------------------------------
//
// The scripted pair above answers the fold with the operations the fixture
// planted, which makes the room deterministic and the run free. This pair
// answers with a MODEL, through the same isolated worker the product's own
// maintenance calls use — the checkpoint worker for a Remember, the fold worker
// for a Memorize — so the room a real-model run measures was written the way a
// person's room is written, in the model's own words.
//
// That is also why `locateEvidenceInDetail` looks for a planted line by its
// words as well as by its code: a real fold keeps the point and drops the
// reference code, and everything downstream of the ingest has to survive that.
//
// No server is needed. The registry is built from the provider records in this
// run's temp home, which `useRealProviderRecords` copied there.

export interface RealIngest {
	remember: RememberFn;
	memorize: MemorizeFn;
	/** Everything the ingest's workers spent, summed as the product records it. */
	usage(): { input: number; output: number; totalTokens: number; cost: number; calls: number };
}

/**
 * The Remember and the Memorize a real model performs.
 *
 * `roomModel` is the lock the room's own conversations carry; the checkpoint
 * and the fold each run on the model the ACTIVE PROFILE assigns to them, which
 * is what the product does — a profile may compress a checkpoint on the room's
 * model and fold on a larger one, and a bench that ignored that would measure a
 * pipeline nobody runs.
 */
export async function createRealIngest(input: { roomModel: { provider: string; model: string; label?: string } }): Promise<RealIngest> {
	const { persistentAgents, absorbRun, absorbOps, consolidation } = await stateModules();
	const profiles = await import("../../src/persistent-agent-ai-profiles.js");
	const profileState = await import("../../src/persistent-agent-ai-profile-state.js");
	const profileId = profileState.readPersistentAgentAiProfileState().profileId;
	const checkpointModel = profiles.resolveCheckpointModelLockForProfile(profileId, input.roomModel);
	const foldModel = profiles.getAbsorbModelLock(profileId);
	const worker = await createMaintenanceWorker();

	/** One worker call, the way every maintenance call in the product makes one. */
	const callWorker = (prompt: string, modelLock: { provider: string; model: string }, label: string, triggerPrompt: string, emptyTextError: string, options?: { signal?: AbortSignal; timeoutMs?: number }) =>
		worker.call({
			prompt,
			modelLock,
			label,
			triggerPrompt,
			emptyTextError,
			// The fold brings the product's own limit; the checkpoint, which the
			// product runs without one, gets the same limit here, because a call
			// that never comes back would otherwise hold a run of hours forever.
			// A smoke shrinks both through the hook.
			timeoutMs: benchWorkerTimeoutMs(options?.timeoutMs ?? absorbRun.ABSORB_FOLD_TIMEOUT_MS),
			...(options?.signal ? { signal: options.signal } : {}),
		});

	/**
	 * A Remember as the product performs one: the conversation's turns on a
	 * thread, the compression worker drafting the Recent Context entry from
	 * them, and then the SAME approval write a person's click performs. The
	 * plant directives never reach it — the draft is the model's.
	 */
	const remember: RememberFn = async ({ roomId, session, now }) => {
		const { threadCwd } = homeOrThrow();
		const conversationId = conversationIdOf(session);
		const items = await writeConversationThread({ roomId, conversationId, session, model: input.roomModel, now });
		const proposal = await persistentAgents.buildCheckpointProposal(
			{ agentId: roomId, conversationId, model: input.roomModel, density: "standard", items, runtimeCwd: threadCwd },
			(prompt, modelLock) => callWorker(prompt, modelLock, "checkpoint compression worker", "Produce the checkpoint compression fields now.", "checkpoint compression worker produced no text"),
		);
		const parsed = persistentAgents.parseCheckpointApprovalRequest(
			{
				conversationId,
				model: proposal.process.model,
				density: proposal.density,
				proposal: { agentId: roomId, conversationId, sessionId: null, writesMemory: false, source: proposal.source, process: proposal.process },
				approvedRecentContext: proposal.proposedRecentContext,
			},
			roomId,
		);
		persistentAgents.writeApprovedCheckpoint(parsed.request, parsed.warnings, now, { runtimeCwd: threadCwd });
		const blocks = consolidation.recentContextSessions(consolidation.extractRecentContextForAbsorb(readL1b(roomId)).recentContext);
		const rcId = blocks[blocks.length - 1]?.id;
		if (!rcId) throw new Error(`the Remember of ${session.id} left nothing in Recent Context`);
		return { rcId };
	};

	/**
	 * A Memorize as the product performs one: the real run, one fold call per
	 * waiting conversation on the profile's fold model, the product's own single
	 * retry of a refused reply, and then the approval write. A conversation the
	 * memory still refuses is a failure ROW — the run carries on and the
	 * conversation stays in Recent Context, which is where a refused fold leaves
	 * it, and which is the honest outcome to report rather than to throw.
	 */
	const memorize: MemorizeFn = async ({ roomId, now }) => {
		const started = absorbRun.startAbsorbRun({
			agentId: roomId,
			assessmentMarkdown: BENCH_ASSESSMENT,
			guidance: { pin: [], drop: [], corrections: [], topics: [], instructions: [] },
			model: foldModel,
			generate: (prompt: string, modelLock: { provider: string; model: string }, options: { signal?: AbortSignal; timeoutMs?: number }) =>
				callWorker(prompt, modelLock, "memorize fold worker", absorbOps.FOLD_TRIGGER_PROMPT, "the fold worker produced no text", options),
			now: () => now,
		});
		return settleAndApprove({ absorbRun, roomId, runId: started.runId, now, timeoutMs: benchSettleTimeoutMs(20 * 60_000) });
	};

	return { remember, memorize, usage: () => worker.usage() };
}
