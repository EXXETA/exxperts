// LongMemEval's instances, mapped (memory v2, stream 41.4).
//
// The PURE half of the adapter next door: what an instance is, how its haystack
// is ordered, how it becomes the conversations a room is built from, how a
// sample is chosen, and what one line of the hypothesis file looks like.
// Nothing here reads a file, spawns anything, prepares a home, calls a model or
// parses argv, and nothing it imports does either — so a smoke, a check or
// another script can import one of these functions without running a benchmark.
//
// The adapter itself runs its main at module scope, which is the right shape
// for a command and the wrong shape for a library, and that split is the whole
// reason this file exists.
//
// The two imports below are the only ones allowed here. One is type-only and is
// erased at compile time; the other is the judge's frozen list of question-type
// names. `recall-engine.mts` in particular is NOT imported: its state modules
// read the home when they are first imported, so the ORDER of that import is
// part of a run's correctness, and it has no business in a module something
// picks up for a single pure function.

import type { RecallQuestion, RecallSession } from "./recall-fixtures.mjs";
import { LONGMEMEVAL_QUESTION_TYPES } from "./longmemeval-judge.mjs";

// --- The data ----------------------------------------------------------------

/** One LongMemEval instance, with the fields this adapter reads. */
export interface LongMemEvalInstance {
	question_id: string;
	question_type: string;
	question: string;
	answer: string;
	question_date: string;
	haystack_dates: string[];
	haystack_session_ids: string[];
	haystack_sessions: Array<Array<{ role: string; content: string; has_answer?: boolean }>>;
	answer_session_ids?: string[];
}

/**
 * `2023/04/10 (Mon) 23:07` as the two pieces everything downstream wants: the
 * day a session is dated in the room, and the time it started, which is the
 * only thing that orders two sessions of one day. The weekday is decoration and
 * is never read — a date that disagreed with it would still be the date.
 */
export function parseLongMemEvalDate(raw: string): { date: string; time: string } {
	const match = /^(\d{4})\/(\d{2})\/(\d{2})(?:\s*\([A-Za-z]{3}\))?(?:\s+(\d{2}:\d{2}))?/.exec(String(raw ?? "").trim());
	if (!match) throw new Error(`a LongMemEval date reads "2023/04/10 (Mon) 23:07", and this one reads "${raw}"`);
	return { date: `${match[1]}-${match[2]}-${match[3]}`, time: match[4] ?? "00:00" };
}

// --- One instance, one room --------------------------------------------------

export interface MappedInstance {
	questionId: string;
	questionType: string;
	/** `_abs` in the id: the question whose right answer is that it cannot be answered. */
	abstention: boolean;
	question: string;
	/** The gold answer, which is a RUBRIC for a preference question and an EXPLANATION for an abstention. */
	gold: string;
	askDate: string;
	sessions: RecallSession[];
}

/**
 * The instance as conversations a room can be built from.
 *
 * The haystack is NOT stored in chronological order, and a room is built in the
 * order things were said — the fold's own dating, the budget's demotion
 * ranking and every temporal question depend on it — so the sessions are sorted
 * by their parsed date and time, ties broken by their position in the file so
 * that two runs of one instance build the same room.
 *
 * A turn is a user turn or an assistant turn, and there is no third kind: both
 * published files carry `user` and `assistant` and nothing else (counted over
 * every turn of both). Anything else is folded to an assistant turn rather than
 * dropped, because a turn silently missing from a conversation would move the
 * answer without saying so, while a turn on the other side of the conversation
 * is at worst mislabelled and still there to be read.
 *
 * `plants` is empty and stays empty: a plant is our fixture's answer key, and
 * LongMemEval's key is one gold string per instance, scored by a judge. Nothing
 * in this file may plant a marker, because a marker is what the scripted
 * Remember and the scripted fold read, and the adapter never uses either —
 * every run there goes through the REAL ingest, scripted gateway or not.
 */
export function mapInstance(instance: LongMemEvalInstance): MappedInstance {
	const dates = instance.haystack_dates ?? [];
	const sessions = instance.haystack_sessions ?? [];
	if (dates.length !== sessions.length) throw new Error(`${instance.question_id} carries ${dates.length} haystack date(s) and ${sessions.length} session(s)`);
	const ordered = sessions
		.map((turns, index) => ({ turns, index, ...parseLongMemEvalDate(dates[index]), sessionId: instance.haystack_session_ids?.[index] ?? `${index}` }))
		.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.index - b.index);
	const width = String(ordered.length).length;
	return {
		questionId: instance.question_id,
		questionType: instance.question_type,
		abstention: instance.question_id.includes("_abs"),
		question: instance.question,
		gold: instance.answer,
		askDate: parseLongMemEvalDate(instance.question_date).date,
		sessions: ordered.map((session, position) => ({
			// Numbered in the order the room is built in: `ingestSessions` breaks a
			// tie between two sessions of one day by their id, so the id has to
			// carry the ordering the date cannot.
			id: `S${String(position + 1).padStart(width, "0")}`,
			date: session.date,
			title: `${session.date} ${session.time} · ${session.sessionId}`,
			turns: session.turns.map((turn) => ({ role: turn.role === "user" ? ("user" as const) : ("assistant" as const), text: String(turn.content ?? "") })),
			// The real Remember never reads this — the checkpoint worker drafts the
			// Recent Context entry from the thread's own turns — and the real
			// Memorize folds what that draft wrote. It is a valid one-liner rather
			// than an empty string so that nothing downstream has to special-case
			// a session with no draft at all.
			recentContextEntry: `- ${session.date} ${session.time}: a conversation of ${session.turns.length} turns.`,
			plants: [],
		})),
	};
}

/**
 * The instance as a question the engine's own ask machinery takes. `ability`
 * and `queries` exist because the type asks for them: nothing in the adapter
 * scores an ability, and the queries are only what the scripted gateway
 * searches the archive with on its first leg.
 */
export function benchQuestion(mapped: MappedInstance): RecallQuestion {
	return {
		id: mapped.questionId,
		ability: mapped.abstention ? "abstention" : "extraction",
		language: "en",
		question: mapped.question,
		gold: mapped.abstention ? [] : [mapped.gold],
		evidence: [],
		queries: { literal: mapped.question, paraphrase: mapped.question, variant: mapped.question },
		askDate: mapped.askDate,
	};
}

// --- Choosing the instances --------------------------------------------------

/** A small deterministic generator, so `--seed` means the same sample on every machine. */
function seededRandom(seed: number): () => number {
	let state = (seed >>> 0) || 0x9e3779b9;
	return () => {
		state = (state + 0x6d2b79f5) >>> 0;
		let t = state;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function shuffled<T>(items: readonly T[], random: () => number): T[] {
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(random() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

/**
 * `N` instances, spread across the six question types as evenly as the pools
 * allow. A flat random sample would take the types in the proportions the
 * benchmark happens to hold — a third of it is multi-session — and a small
 * sample would then say nothing at all about the types it missed.
 *
 * Abstention ids stay in the pool of their own type: they ARE questions of that
 * type, whose right answer is that the haystack does not hold one, and pulling
 * them into a pool of their own would take them out of the type they test.
 *
 * A type with fewer instances than its share hands the remainder back, and the
 * types that still have spare take it, in the canonical order, so `--sample N`
 * returns N instances whenever the data holds N.
 */
export function stratifiedSample(instances: readonly LongMemEvalInstance[], size: number, seed: number): LongMemEvalInstance[] {
	const pools = new Map<string, LongMemEvalInstance[]>();
	const order: string[] = [];
	for (const type of LONGMEMEVAL_QUESTION_TYPES) {
		pools.set(type, []);
		order.push(type);
	}
	for (const instance of instances) {
		if (!pools.has(instance.question_type)) {
			pools.set(instance.question_type, []);
			order.push(instance.question_type);
		}
		pools.get(instance.question_type)!.push(instance);
	}
	const random = seededRandom(seed);
	const shuffledPools = new Map(order.map((type) => [type, shuffled([...pools.get(type)!].sort((a, b) => a.question_id.localeCompare(b.question_id)), random)] as const));
	const wanted = Math.min(size, instances.length);
	const taken = new Map<string, number>(order.map((type) => [type, 0]));
	for (let assigned = 0; assigned < wanted; ) {
		let placed = 0;
		for (const type of order) {
			if (assigned >= wanted) break;
			if (taken.get(type)! >= shuffledPools.get(type)!.length) continue;
			taken.set(type, taken.get(type)! + 1);
			assigned += 1;
			placed += 1;
		}
		if (placed === 0) break;
	}
	// Back into the file's own order, so a sample reads like a slice of the data.
	const chosen = new Set(order.flatMap((type) => shuffledPools.get(type)!.slice(0, taken.get(type)!).map((instance) => instance.question_id)));
	return instances.filter((instance) => chosen.has(instance.question_id));
}

// --- The hypothesis file -----------------------------------------------------

/**
 * ONE line of the hypothesis file, and nothing but the two fields upstream
 * reads: `evaluate_qa.py` takes the file with one `json.loads` per line, and a
 * third key in these lines would make a file only our own tools can score. The
 * newline belongs to whoever joins the lines, so that a caller can never write
 * a trailing blank line into a file something else counts.
 */
export function hypothesisLine(input: { questionId: string; hypothesis: string }): string {
	return JSON.stringify({ question_id: input.questionId, hypothesis: input.hypothesis });
}
