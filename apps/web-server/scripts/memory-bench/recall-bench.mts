// Recall bench — the run and the tables (memory v2, stream 41.4).
//
// The fold bench next door asks whether a fold is RIGHT. This one asks whether
// the room can still ANSWER. Per language it builds a real room in a temp home,
// Remembers the fixture's conversations into it, Memorizes them through the
// product's own run, and then reports, per question, WHERE the evidence ended
// up and whether the room's own `memory_recall` FINDS it with each of the
// fixture's three queries.
//
// This pass does not ask the room. The answer column reads "-" and the
// accuracy columns read "-" with it: the machinery for the asking is in
// recall-engine.mts (scoreAnswer, the forgetting table's answered/correct
// counts) and the next pass wires a room turn into it behind `--ask`.
//
// WHERE a question's evidence can sit now includes the CONVERSATION the room
// memorized: a fact that was said and never written down is in no note, in the
// core or in the archive, and the folded transcript still carries it. That
// place is retrieval's alone — nothing is in front of the room — so its rows
// are in the same tables as the archive's, and `--sources` restricts what a
// recall may read so one place can be measured without the others.
//
// What the run is EXPECTED to show depends on the recall under it. On 0.12.1
// `memory_recall` is a case-insensitive SUBSTRING search over the ARCHIVE
// alone: a literal query lands on archived evidence at rank 1 or close to it, a
// paraphrase or an umlaut/date variant mostly reads "none", and every
// conversation row reads "none" because the archive is all it can see. With the
// ranked search over all three sources under it, the paraphrases start landing
// and the conversation rows come back — which is what the tables are for.
//
// Judgment is never an exit code. The process exits non-zero only on a
// MECHANICAL failure: a fold the scripted model could not answer, a marker the
// fixture says it planted that no part of the room's memory carries although no
// fold archived it, a parser or an applier throwing. A room that retrieves
// badly is a table with "none" in it, which is the whole point of the table.
//
// Offline: no server, no provider, no network, no port. Run it from
// apps/web-server:
//   npx tsx scripts/memory-bench/recall-bench.mts
//   npx tsx scripts/memory-bench/recall-bench.mts --language de --sessions 6 --per-ability 1
//   npx tsx scripts/memory-bench/recall-bench.mts --sources notes,archive
//   npx tsx scripts/memory-bench/recall-bench.mts --out /tmp/recall.json --keep-home

import fs from "node:fs";
import {
	accuracyCell,
	archivedReasons,
	askConversationId,
	askPrompt,
	askRoom,
	budgetRowsInEvents,
	buildRunSummary,
	claimsFailed,
	claimsLine,
	conflictsSummary,
	createBenchRoom,
	backHistoryTokensFor,
	backHistoryWindow,
	DEFAULT_MEMORY_BUDGET_TOKENS,
	demotionScoreConstants,
	flushRoomMemoryUse,
	forgettingTable,
	ingestSessions,
	internalIdsLine,
	locateEvidenceInDetail,
	locationLabel,
	predictScriptedRoomAnswer,
	probeQuestion,
	answerTokens,
	numbersAndDatesIn,
	pad,
	prepareBenchHome,
	QUERY_KINDS,
	rankCell,
	RECALL_SOURCES,
	RETRIEVED_LOCATIONS,
	retrieve,
	retrievalRanks,
	scoreAnswer,
	createMaintenanceWorker,
	createRealIngest,
	setBenchModel,
	sizeLine,
	startBenchServer,
	startScriptedRoomGateway,
	useRealProviderRecords,
	writeScriptedProviderRecords,
	type BenchServer,
	type MaintenanceWorker,
	type RealIngest,
	worstLocation,
	writeRecallResults,
	type ConflictsSummary,
	type EvidenceLocation,
	type IngestStep,
	type InterleaveSummary,
	type QueryKind,
	type RecallResultRow,
	type RecallResultsFile,
	type RecallRunSummary,
	type RecallSource,
} from "./recall-engine.mjs";
import { buildRecallFixture, CONFLICT_SHAPES, type ConflictShape, type RecallAbility, type RecallFixture, type RecallLanguage, type RecallQuestion } from "./recall-fixtures.mjs";
import { judgeLabel, judgePrompt } from "./longmemeval-judge.mjs";

// --- The judge ---------------------------------------------------------------
//
// The scorer above is containment: a gold spelling occurs in the answer or it
// does not. That is the right default — it is free, it is deterministic, and a
// bench whose number moves because a judge was in a mood is not a bench — but
// containment calls a right answer wrong whenever the room says the right thing
// in words the fixture did not foresee. So a run may ask a MODEL for a second
// opinion, and the two are always printed side by side: the exact score is the
// number, the judge's is the second opinion on it, and neither replaces the
// other.
//
// The prompts are LongMemEval's own, character for character, ported in
// longmemeval-judge.mts — a judge everybody else's numbers were produced with
// is worth more than a better judge only we use. Our five abilities map onto
// its question types; an abstention goes down its abstention branch, whose
// "explanation" field is the one sentence that is true of every abstention
// question in the fixture.

/** Which LongMemEval template an ability is judged with. */
const JUDGE_TYPE_BY_ABILITY: Record<RecallAbility, string> = {
	extraction: "single-session-user",
	"multi-session": "multi-session",
	temporal: "temporal-reasoning",
	"knowledge-update": "knowledge-update",
	// Never read: an abstention takes the abstention branch, which ignores the type.
	abstention: "single-session-user",
};

/** What the abstention template is told the right answer is: there was nothing to find. */
const ABSTENTION_EXPLANATION = "the fact was never said";

/** One verdict on one answer. */
type JudgeCall = (input: { question: RecallQuestion; answer: string }) => Promise<{ model: string; label: boolean; promptTokens: number }>;

function createJudge(spec: string, worker: MaintenanceWorker): JudgeCall {
	const slash = spec.indexOf("/");
	if (slash < 1) throw new Error(`--judge must read provider/model, e.g. anthropic/claude-sonnet-5 — got "${spec}"`);
	const lock = { provider: spec.slice(0, slash), model: spec.slice(slash + 1) };
	return async ({ question, answer }) => {
		const abstention = question.ability === "abstention";
		const prompt = judgePrompt({
			questionType: JUDGE_TYPE_BY_ABILITY[question.ability],
			question: question.question,
			// Every spelling the fixture accepts, so the judge is shown the same
			// answer key the scorer holds rather than a narrower one.
			answer: abstention ? ABSTENTION_EXPLANATION : question.gold.join(" / "),
			hypothesis: answer,
			abstention,
		});
		const reply = await worker.call({
			prompt,
			modelLock: lock,
			label: "recall judge worker",
			triggerPrompt: "Answer yes or no now.",
			emptyTextError: "the judge produced no text",
			// Upstream's judge caps the reply at ten tokens and this one caps it
			// the same, so the label rule — "yes" anywhere in the reply — reads a
			// word and not an essay that happens to contain one.
			maxOutputTokens: 10,
		});
		return { model: spec, label: judgeLabel(reply.text), promptTokens: answerTokens(prompt) };
	};
}

// --- Arguments ---------------------------------------------------------------

interface BenchArgs {
	languages: RecallLanguage[];
	seed?: number;
	sessions?: number;
	perAbility?: number;
	out?: string;
	backHistory?: number;
	foldEvery?: number;
	showMemory: boolean;
	keepHome: boolean;
	ask: boolean;
	limit?: number;
	baseline?: "none" | "transcript";
	judge?: string;
	scriptedIngest: boolean;
	dryRun: boolean;
	realIngest: boolean;
	/**
	 * Which parts of the memory a recall may read, in the tool's own words.
	 * Undefined is the default and means all three — the run passes nothing and
	 * the tool decides, which is what a room does.
	 */
	sources?: RecallSource[];
	/**
	 * Ask the room between the folds: after every Memorize, every question whose
	 * evidence is in by then is asked once through the room's own recall, so the
	 * next Memorize's ranking has a record of what the room looked up. Without
	 * it the room is built in silence and asked only at the end.
	 */
	interleave: boolean;
	/**
	 * A results file of an interleaved run on the product BEFORE the ranking
	 * read use, to hold this run's forgetting numbers against. With it the gate
	 * is asserted; without it the numbers are only printed.
	 */
	gateBefore?: string;
	/**
	 * A planted pair the memory mishandled fails the run. Without it, and
	 * without --gate-before, a failed shape is printed in full and the run
	 * carries on, like every other finding.
	 */
	gateConflicts: boolean;
}

function parseArgs(argv: string[]): BenchArgs {
	const args: BenchArgs = { languages: ["de", "en"], showMemory: false, keepHome: false, ask: false, scriptedIngest: false, dryRun: false, realIngest: false, interleave: false, gateConflicts: false };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const next = () => {
			const value = argv[++i];
			if (value === undefined) throw new Error(`${flag} needs a value`);
			return value;
		};
		if (flag === "--language") {
			const value = next();
			if (value === "both") args.languages = ["de", "en"];
			else if (value === "de" || value === "en") args.languages = [value];
			else throw new Error("--language must be de, en, or both");
		} else if (flag === "--seed") args.seed = Number(next());
		else if (flag === "--sessions") args.sessions = Number(next());
		else if (flag === "--per-ability") args.perAbility = Number(next());
		else if (flag === "--out") args.out = next();
		else if (flag === "--back-history") args.backHistory = Number(next());
		else if (flag === "--fold-every") args.foldEvery = Number(next());
		else if (flag === "--ask") args.ask = true;
		else if (flag === "--scripted-ingest") args.scriptedIngest = true;
		else if (flag === "--dry-run") args.dryRun = true;
		else if (flag === "--real-ingest") args.realIngest = true;
		else if (flag === "--limit") args.limit = Number(next());
		else if (flag === "--baseline") {
			const value = next();
			if (value !== "none" && value !== "transcript") throw new Error("--baseline must be none or transcript");
			args.baseline = value;
		} else if (flag === "--sources") {
			const wanted = next().split(",").map((word) => word.trim()).filter((word) => word.length > 0);
			const unknown = wanted.filter((word) => !RECALL_SOURCES.includes(word as RecallSource));
			if (unknown.length > 0) throw new Error(`--sources takes ${RECALL_SOURCES.join(", ")} — got ${unknown.join(", ")}`);
			if (wanted.length === 0) throw new Error("--sources needs at least one of notes, archive, conversations");
			args.sources = [...new Set(wanted as RecallSource[])];
		} else if (flag === "--judge") args.judge = next();
		else if (flag === "--interleave") args.interleave = true;
		else if (flag === "--gate-before") args.gateBefore = next();
		else if (flag === "--gate-conflicts") args.gateConflicts = true;
		else if (flag === "--show-memory") args.showMemory = true;
		else if (flag === "--keep-home") args.keepHome = true;
		else throw new Error(`Unknown flag: ${flag}`);
	}
	return args;
}

// --- One language ------------------------------------------------------------

interface MarkerRow {
	marker: string;
	location: EvidenceLocation;
	ranks: Record<QueryKind, number | null>;
	/** How this marker was found in the room: by its code, by its words, or not at all. */
	how: "code" | "wording" | null;
	/**
	 * The CONTROL query: the marker's own reference code. Every planted sentence
	 * carries it, so a marker the archive holds must come back at rank 1 for it.
	 * It is not one of the fixture's three queries and never enters a result row
	 * — it is there so that a table of "none" can be read: it separates a
	 * retrieval that cannot find what it holds from a question whose words the
	 * archived note never carried.
	 */
	control: number | null;
}

/**
 * A question resting on several sentences, for the question lines: how many
 * it rests on, whether recall was asked for any of them at all, and per query
 * whether every one recall was asked for came back within that many. A
 * question that quotes two sentences has earned both of them in the first two
 * results; one of them at rank 1 and the other nowhere is half an answer.
 */
interface MultiLineRow {
	id: string;
	markers: number;
	applicable: boolean;
	within: Record<QueryKind, boolean>;
}

interface LanguageRun {
	summary: RecallRunSummary;
	steps: IngestStep[];
	rows: RecallResultRow[];
	roomId: string;
	mechanical: string[];
	/** The planted pairs the memory mishandled, one line each; an exit code only under --gate-before or --gate-conflicts. */
	conflictFailures: string[];
}

async function runLanguage(fixture: RecallFixture, args: BenchArgs, home: string, server: BenchServer | null, ingestPair: RealIngest | null, scriptedRoom: boolean, judge: JudgeCall | null, known: readonly string[]): Promise<LanguageRun> {
	const language = fixture.language;
	const mechanical: string[] = [];
	const warnings: string[] = [];
	console.log(`\n=== ${language} · seed ${fixture.seed} · ${fixture.sessions.length} conversations · ${fixture.questions.length} questions ===`);

	// The back history is sized from THIS run: the budget only reaches the
	// fixture's own notes once the stretch of back history newer than the first
	// fold outweighs the budget itself, and where the first fold falls depends
	// on the session dates and on --fold-every.
	const dates = [...fixture.sessions].map((session) => session.date).sort();
	const foldEvery = args.foldEvery ?? 7;
	const firstFoldDate = dates[Math.min(foldEvery, dates.length) - 1] ?? dates[dates.length - 1];
	// The days the folds will run on, which the back history is dated off.
	const foldDates = dates.filter((_, index) => (index + 1) % foldEvery === 0 || index === dates.length - 1);
	const window = backHistoryWindow(fixture.sessions);
	// With one fold no back history can push a planted note out (a Memorize
	// protects what it just saved), so a run that short takes the floor rather
	// than the very large size the arithmetic would otherwise ask for.
	const oneFold = dates.length <= foldEvery;
	const sized = oneFold
		? { tokens: DEFAULT_MEMORY_BUDGET_TOKENS * 2, fraction: 1, whyClamped: "one fold, so the floor" }
		: backHistoryTokensFor({ budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS, window, firstFoldDate });
	// Nothing the fixture plants or accepts as an answer may appear in the
	// filler; `createBenchRoom` throws if it does.
	const forbiddenInBackHistory = [
		...new Set([
			...fixture.sessions.flatMap((session) => session.plants.map((plant) => plant.marker)),
			...fixture.questions.flatMap((question) => [...question.gold, ...(question.trap ?? []), ...(question.distractor ?? [])]),
		]),
	];
	const room = await createBenchRoom({
		home,
		name: `Recall Bench ${language.toUpperCase()}`,
		backHistoryWindow: window,
		backHistoryAvoidDates: foldDates,
		backHistoryTokens: args.backHistory ?? sized.tokens,
		forbiddenInBackHistory,
	});
	console.log(`back history: ${room.backHistoryNotes} notes, ${room.backHistoryTokens} tokens, dated evenly across ${room.backHistoryFrom}..${room.backHistoryTo}`);
	console.log(
		`budget ${room.memoryBudgetTokens} tokens · first fold ${Math.round(sized.fraction * 100)}% into the window` +
			`${args.backHistory === undefined ? "" : " · size overridden on the command line"}${sized.whyClamped ? ` · ${sized.whyClamped}` : ""}`,
	);
	if (oneFold) {
		console.log("one fold only: a Memorize puts what it has just saved last, so no planted note can leave by budget in this run — pass --fold-every to see the curve at this size");
	}
	// Where every planted marker sits is worked out after the ingest; the plants
	// are needed before it, because an interleaved probe recognises a note by
	// the words of its planted line where a fold has rewritten it.
	const plants = fixture.sessions.flatMap((session) => session.plants);

	// --- the use between the folds ---------------------------------------------
	// With --interleave the room is ASKED after every Memorize: every question
	// whose evidence is in by then, once per fold from that fold on, through the
	// room's own recall with the question's literal query. A question is asked
	// again at every later fold because that is what repeated real use looks
	// like — the room is asked about the same things more than once — and the
	// hits add up in the room's use sidecar the way they would over weeks. The
	// probe records, per marker, whether it ever came back from the NOTES, which
	// is "asked while in core": the room looked it up while the budget could
	// still have taken it. Abstention questions plant nothing and are not
	// asked; there is no marker to read a rank for.
	const askedQuestionIds = new Set<string>();
	const askedInCore = new Set<string>();
	const askedAllInCore = new Set<string>();
	// The planted pairs' questions are not asked between the folds: what they
	// measure is what the fold made of the pair, and a probe that touched the
	// pair's notes would move the ranking the interleave table is about.
	// The questions without a hint are not asked between the folds either: a
	// probe with their literal query is the hint the class is there to withhold.
	const askable = fixture.questions.filter((question) => question.evidence.length > 0 && !question.shape && !question.noHint);
	let interleaveProbes = 0;
	let sidecarWritten: boolean | null = null;
	const afterFold = async ({ ingestedSessionIds }: { ingestedSessionIds: string[] }): Promise<void> => {
		const done = new Set(ingestedSessionIds);
		for (const question of askable) {
			if (!question.evidence.every((evidence) => done.has(evidence.sessionId))) continue;
			const probe = await probeQuestion({ roomId: room.roomId, question, plants, ...(args.sources === undefined ? {} : { sources: args.sources }) });
			interleaveProbes += 1;
			askedQuestionIds.add(question.id);
			let everyMarkerFromNotes = probe.perMarker.length > 0;
			for (const row of probe.perMarker) {
				// The tool names the source in its own word; the older envelope
				// fallback names none, and then nothing is claimed about the core.
				const fromNotes = row.rank !== null && (row.source === "note" || row.source === "notes");
				if (fromNotes) askedInCore.add(row.marker);
				else everyMarkerFromNotes = false;
			}
			if (everyMarkerFromNotes) askedAllInCore.add(question.id);
		}
		// The sidecar is written on a short timer; the next Memorize is seconds
		// away and must read what these probes showed.
		sidecarWritten = await flushRoomMemoryUse(room.roomId);
	};

	// A Memorize protects what it has just saved, so a run with ONE fold can
	// never archive the fixture's own notes by budget however tight the room is:
	// the forgetting curve needs a second fold to have something older than
	// today to take. `--fold-every` is how a short run gets one.
	const ingest = await ingestSessions({
		roomId: room.roomId,
		sessions: fixture.sessions,
		...(args.foldEvery === undefined ? {} : { foldEvery: args.foldEvery }),
		...(ingestPair ? { remember: ingestPair.remember, memorize: ingestPair.memorize } : {}),
		...(args.interleave ? { afterFold } : {}),
	});

	console.log(`${pad("fold after", 12)}${pad("sessions", 9, true)}${pad("failed", 7, true)}${pad("ops", 5, true)}${pad("notes", 7, true)}${pad("archive", 9, true)}${pad("budget", 8, true)}${pad("tokens", 8, true)}`);
	for (const step of ingest.steps) {
		console.log(
			pad(step.afterSession, 12) +
				pad(step.sessions.length, 9, true) +
				pad(step.failed, 7, true) +
				pad(step.opsApplied, 5, true) +
				pad(step.notesInCore, 7, true) +
				pad(step.archiveRows, 9, true) +
				pad(step.archivedByBudget, 8, true) +
				pad(step.memoryTokens, 8, true),
		);
	}

	// A conversation the scripted fold answered and the memory still refused is
	// a fixture the product cannot accept — mechanical, because the operations
	// were the fixture's own. `RECALL_BENCH_DUMP=1` prints what was refused.
	for (const failure of ingest.failures) mechanical.push(`${failure.session} (${failure.rcId}) was refused although the scripted fold answered with the planted operations: ${failure.reason}`);

	// The claim audit: every conversation the room memorized is in its search
	// index, under the conversation it was. It is printed on every run and it
	// is a gate at zero without any flag, because a memorized conversation the
	// index lacks, or one filed under another conversation's name, is a defect
	// of the pipeline under the tables and not a finding about the memory: the
	// retrieval numbers below would be measuring a room that was never told
	// what the fixture says it was told.
	console.log(claimsLine(ingest.claims));
	if (claimsFailed(ingest.claims)) mechanical.push(`${language}: ${claimsLine(ingest.claims)}; every memorized conversation is indexed under its own name, so both defect counts are zero on a sound pipeline`);

	// Where every planted marker sits now, and where each question's evidence is.
	const markers = [...new Set(plants.map((plant) => plant.marker))];
	const detail = await locateEvidenceInDetail({ roomId: room.roomId, markers, plants });
	const located: Record<string, EvidenceLocation> = {};
	for (const [marker, row] of Object.entries(detail)) located[marker] = row.location;
	const byWording = Object.values(detail).filter((row) => row.how === "wording").length;
	if (ingestPair || byWording > 0) {
		console.log(`located: ${Object.values(detail).filter((row) => row.how === "code").length} of ${markers.length} planted notes by their reference code, ${byWording} by the words of their planted line, ${Object.values(detail).filter((row) => row.how === null).length} not at all`);
	}
	const archivedByBudget = ingest.steps.at(-1)?.archivedByBudget ?? 0;
	const archiveRows = ingest.steps.at(-1)?.archiveRows ?? 0;
	for (const marker of markers) {
		// The fixture disagreement that is mechanical: the fixture says it planted
		// this and no part of the room's memory carries it. A note the budget took
		// is in the ARCHIVE, a conversation a fold refused is still in RECENT
		// CONTEXT, and a fact the Remember never wrote down is still in the
		// CONVERSATION the Memorize folded — so nothing a Memorize does can make a
		// planted marker vanish, and "gone" means the plant never landed at all.
		if (located[marker] !== "gone") continue;
		const saidNotNoted = plants.some((plant) => plant.marker === marker && plant.noted === false);
		const sentence = saidNotNoted
			? `${marker} was said in a conversation and never written down, and the transcript that was folded does not carry it either — a folded conversation is searchable, so this one was never indexed`
			: `${marker} was planted and is in no part of the room's memory, and the archive holds ${archiveRows} row(s) that could have taken it`;
		// Under a SCRIPTED ingest this is mechanical: the fold answered with the
		// fixture's own operations, so a marker that vanished is a disagreement.
		// Under a REAL ingest it is a finding about the model — a fold may judge
		// a point not worth keeping, and the wording fallback has already had its
		// say — so it is printed and the run still passes.
		if (ingestPair) warnings.push(sentence);
		else mechanical.push(sentence);
	}
	for (const warning of warnings.slice(0, 8)) console.log(`note: ${warning}`);
	if (warnings.length > 8) console.log(`note: … and ${warnings.length - 8} more planted notes the ingest did not keep`);

	const rows: RecallResultRow[] = [];
	/** One row per evidence marker, for the retrieval table: what that marker on its own retrieves, where it sits. */
	const markerRows: MarkerRow[] = [];
	/** What each question's evidence retrieved, kept for the scripted ceiling. */
	const perMarkerByQuestion = new Map<string, Array<{ marker: string; location: EvidenceLocation; literalRank: number | null; text?: string }>>();
	/** The questions resting on several sentences, and whether each query brought every retrieved one back within that many. */
	const multiLine: MultiLineRow[] = [];
	for (const question of fixture.questions) {
		const locations = question.evidence.map((evidence) => located[evidence.marker] ?? "gone");
		// A question the fixture planted no evidence for is an abstention: there
		// was never anything to lose, which is not the same as having lost it.
		const location: EvidenceLocation = locations.length === 0 ? "none" : worstLocation(locations);
		const { ranks, perMarker, calls } = await retrievalRanks({ roomId: room.roomId, question, locations: located, plants, ...(args.sources === undefined ? {} : { sources: args.sources }) });
		perMarkerByQuestion.set(question.id, perMarker.map((row) => ({ marker: row.marker, location: row.location, literalRank: row.ranks.literal, ...(detail[row.marker]?.text === undefined ? {} : { text: detail[row.marker]!.text! }) })));
		// The retrieval tables are the abilities': a planted pair's question is
		// counted in the conflicts block and enters no marker row.
		if (!question.shape && !question.noHint && perMarker.length >= 2) {
			const retrieved = perMarker.filter((row) => RETRIEVED_LOCATIONS.has(row.location));
			multiLine.push({
				id: question.id,
				markers: perMarker.length,
				applicable: retrieved.length > 0,
				within: Object.fromEntries(QUERY_KINDS.map((kind) => [kind, retrieved.every((row) => row.ranks[kind] !== null && row.ranks[kind]! <= perMarker.length)])) as Record<QueryKind, boolean>,
			});
		}
		for (const marker of question.shape || question.noHint ? [] : perMarker) {
			const control = await retrieve({ roomId: room.roomId, query: marker.marker, marker: marker.marker, ...(args.sources === undefined ? {} : { sources: args.sources }) });
			markerRows.push({ marker: marker.marker, location: marker.location, how: detail[marker.marker]?.how ?? null, ranks: marker.ranks, control: control.rank });
		}
		// The replaced value of a knowledge-update question is not evidence — the
		// question asks for what holds NOW — but where it ended up decides how
		// close the room is to a plausible wrong answer, so it is carried beside
		// the row rather than mixed into it.
		const trapPlaces = (question.trapEvidence ?? []).map((evidence) => located[evidence.marker] ?? "gone");
		rows.push({
			id: question.id,
			ability: question.ability,
			language,
			location,
			...(trapPlaces.length === 0 ? {} : { trapLocation: worstLocation(trapPlaces) }),
			ranks,
			answered: null,
			locatedBy: question.evidence.map((evidence) => detail[evidence.marker]?.how ?? null),
			answerTokens: 0,
			recallCalls: 0,
			probeCalls: calls,
			judge: null,
			...(args.interleave ? { askedWhileInCore: askedAllInCore.has(question.id) } : {}),
			...(question.shape ? { shape: question.shape } : {}),
			...(question.noHint ? { noHint: true as const } : {}),
		});
	}
	/** The abilities' rows, which every table below is made of, and the planted pairs' rows, which the conflicts block is. */
	const abilityRows = rows.filter((row) => !row.shape && !row.noHint);
	const shapeRows = rows.filter((row) => row.shape);
	/** The questions without a hint: a column of their own in the forgetting table, a line of their own under it, and no ability table. */
	const noHintRows = rows.filter((row) => row.noHint);

	// --- the ask -------------------------------------------------------------
	// Each question in its own fresh conversation on the SAME room, through the
	// real turn. Nothing about the room changes between questions: a turn reads
	// memory and never writes it, so the order the questions are asked in cannot
	// move a number.
	if (server) {
		const asked = args.limit === undefined ? fixture.questions : fixture.questions.slice(0, args.limit);
		console.log(`\nasking ${asked.length} of ${fixture.questions.length} questions on ${room.roomId}...`);
		for (const [index, question] of asked.entries()) {
			const row = rows.find((candidate) => candidate.id === question.id)!;
			const turn = await askRoom({ server, roomId: room.roomId, conversationId: askConversationId(question), prompt: askPrompt(question) });
			const scored = scoreAnswer({ question, answer: turn.answer, known });
			row.answered = scored.correct;
			row.why = scored.why;
			row.answer = turn.answer;
			row.answerTokens = answerTokens(turn.answer);
			row.recallCalls = turn.recallCalls;
			row.usage = turn.usage;
			if ((index + 1) % 10 === 0 || index === asked.length - 1) console.log(`  ${index + 1}/${asked.length}`);
		}

		// The second opinion, on the answers there now are. It runs after every
		// question has been asked rather than inside the loop above, so a judge
		// that fails takes the judge's column with it and leaves the run's own
		// numbers standing.
		if (judge) {
			const judged = rows.filter((row) => row.answered !== null);
			console.log(`judging ${judged.length} answer(s)...`);
			for (const [index, row] of judged.entries()) {
				const question = fixture.questions.find((candidate) => candidate.id === row.id)!;
				row.judge = await judge({ question, answer: row.answer ?? "" });
				if ((index + 1) % 10 === 0 || index === judged.length - 1) console.log(`  ${index + 1}/${judged.length}`);
			}
		}
		// THE SCRIPTED CEILING, held exactly. The scripted room quotes what it
		// can see and nothing else, so what it can answer is decided by the
		// room's files, and the bench works it out from them without asking
		// anything. A question that scored differently from its prediction is a
		// mechanical failure IN EITHER DIRECTION: one that missed a question it
		// should have reached means the wiring lost something, and one that
		// reached a question it should not have means an answer came from
		// somewhere other than this room's memory.
		if (scriptedRoom) {
			const divergent: string[] = [];
			let reachable = 0;
			for (const question of asked) {
				const row = rows.find((candidate) => candidate.id === question.id)!;
				const predicted = predictScriptedRoomAnswer({ question, evidence: perMarkerByQuestion.get(question.id) ?? [] });
				const expected = scoreAnswer({ question, answer: predicted, known }).correct;
				if (expected) reachable += 1;
				if (row.answered !== expected) divergent.push(`${question.id} (${question.ability}, ${row.location}): the ceiling says ${expected ? "reachable" : "out of reach"} and the room answered ${row.answered ? "right" : "wrong"}`);
			}
			if (divergent.length === 0) console.log(`ceiling: reached (${reachable}/${asked.length} per language)`);
			else for (const line of divergent) mechanical.push(`the scripted room diverged from its own ceiling — ${line}`);
		}
	}

	// The retrieval path's own check: a note the archive holds is found by a
	// search for the reference code its own sentence carries, or the bench is
	// not measuring retrieval at all.
	for (const row of markerRows) {
		// Only where the note still CARRIES its code: a note a fold rewrote in its
		// own words has no code to search for, and reporting that as a retrieval
		// failure would blame the search for the fold's paraphrase.
		if (row.location === "archive" && row.how === "code" && row.control === null) mechanical.push(`${row.marker} is archived and a search for "${row.marker}" did not return it`);
	}

	console.log("");
	// The location column is as wide as the widest label it prints: fourteen
	// where every row sits in one of the short-named places, wider only when a
	// row reads "conversation (no notes)", so a run without one prints the
	// table it always printed.
	const locationWidth = columnWidth(abilityRows.map((row) => row.location));
	console.log(`${pad("question", 24)}${pad("ability", 17)}${pad("location", locationWidth)}${pad("trap", 9)}${pad("literal", 9, true)}${pad("paraphr.", 10, true)}${pad("variant", 9, true)}${pad("answered", 10, true)}`);
	for (const row of abilityRows) {
		console.log(
			pad(row.id, 24) +
				pad(row.ability, 17) +
				pad(locationLabel(row.location), locationWidth) +
				pad(row.trapLocation ?? "–", 9) +
				pad(rankCell(row.ranks.literal), 9, true) +
				pad(rankCell(row.ranks.paraphrase), 10, true) +
				pad(rankCell(row.ranks.variant), 9, true) +
				pad(row.answered === null ? "-" : row.answered ? "yes" : "no", 10, true),
		);
	}
	// The questions without a hint, listed after the abilities' and named as
	// what they are, so the rows above read as they always did.
	for (const row of noHintRows) {
		console.log(`${pad(row.id, 24)}${pad("no hint", 17)}${pad(locationLabel(row.location), locationWidth)}${pad("–", 9)}${pad(rankCell(row.ranks.literal), 9, true)}${pad(rankCell(row.ranks.paraphrase), 10, true)}${pad(rankCell(row.ranks.variant), 9, true)}${pad(row.answered === null ? "-" : row.answered ? "yes" : "no", 10, true)}`);
	}

	console.log("");
	printForgetting([...abilityRows, ...noHintRows]);
	printNoHint(noHintRows);
	printSupersedes(abilityRows);
	// The planted pairs, judged off the room's files, whether or not the room
	// was asked; a pair this size holds only half of is said so and not judged.
	const wholeShapes = CONFLICT_SHAPES.filter((shape) => plants.filter((plant) => plant.shape === shape).length === 2);
	const conflicts = wholeShapes.length > 0 ? await conflictsSummary({ roomId: room.roomId, plants, twinsRefused: ingest.twinsRefused }) : null;
	const conflictFailures: string[] = [];
	if (conflicts) {
		printConflicts(conflicts, shapeRows, CONFLICT_SHAPES.filter((shape) => !wholeShapes.includes(shape)));
		for (const verdict of conflicts.shapes) if (!verdict.ok) conflictFailures.push(`${language}: ${verdict.shape}: ${verdict.detail}`);
	}
	console.log("");
	printRetrieval(markerRows);
	printQuestionRetrieval(abilityRows, multiLine);

	const summary = await buildRunSummary({ roomId: room.roomId, language, seed: fixture.seed, sessions: fixture.sessions.length, rows, backHistoryNotes: room.backHistoryNotes, backHistoryTokens: room.backHistoryTokens, markers, plants, locations: located });
	summary.conflicts = conflicts;
	summary.claims = ingest.claims;
	if (args.interleave) {
		// "Then archived" is the archive's own `budget` reason and nothing else:
		// a note a later conversation replaced left the core because it was
		// replaced, which no ranking decides, and it leaves the same way on every
		// product this bench runs against.
		const reasons = await archivedReasons({ roomId: room.roomId, markers, plants });
		const askedMarkers = new Set(askable.filter((question) => askedQuestionIds.has(question.id)).flatMap((question) => question.evidence.map((evidence) => evidence.marker)));
		const openItemMarkers = [...new Set(fixture.questions.filter((question) => question.openItem).flatMap((question) => question.evidence.map((evidence) => evidence.marker)))];
		const budget = budgetRowsInEvents(room.roomId);
		summary.interleave = {
			askedQuestions: askedQuestionIds.size,
			askedMarkers: askedMarkers.size,
			askedMarkersStillInCore: [...askedInCore].filter((marker) => located[marker] === "core").length,
			askedThenArchived: [...askedInCore].filter((marker) => located[marker] === "archive" && reasons[marker] === "budget").length,
			askedThenGone: [...askedInCore].filter((marker) => (located[marker] ?? "gone") === "gone").length,
			openItemMarkers: openItemMarkers.length,
			openItemMarkersInCore: openItemMarkers.filter((marker) => located[marker] === "core").length,
			budgetRowsInEvents: budget.rows,
			budgetRowsWithReason: budget.withReason,
		};
		console.log("");
		printInterleave(summary.interleave, { probes: interleaveProbes, folds: ingest.steps.length, askedInCore: askedInCore.size, sidecarWritten, events: budget.events });
	} else {
		summary.interleave = null;
	}
	console.log("");
	console.log(sizeLine(summary));
	if (!server) console.log(`ask: skipped (no --ask)${archivedByBudget === 0 ? " · nothing left the core by budget in this run" : ""}`);
	else {
		const answered = abilityRows.filter((row) => row.answered !== null);
		const cost = answered.reduce((total, row) => total + (row.usage?.cost ?? 0), 0);
		const tokens = answered.reduce((total, row) => total + (row.usage?.total ?? 0), 0);
		console.log(`ask: ${answered.filter((row) => row.answered).length}/${answered.length} right · the room called memory_recall ${answered.reduce((total, row) => total + row.recallCalls, 0)} times · ${tokens} tokens${cost > 0 ? ` · $${cost.toFixed(4)}` : ""}`);
		const wrong = answered.filter((row) => !row.answered).slice(0, 5);
		for (const row of wrong) console.log(`  ${pad(row.id, 12)}${pad(row.location, 9)}${row.why ?? ""}`);
		if (answered.filter((row) => !row.answered).length > wrong.length) console.log(`  … and ${answered.filter((row) => !row.answered).length - wrong.length} more`);
		// Beside the score and never a gate: how many of the answers name the
		// mechanism, which the room is told to keep out of what it says.
		if (summary.narrates) console.log(`narrates: ${summary.narrates.narrating} of ${summary.narrates.answers} answers name the mechanism (memory, notes, archive, a search) · reported, never a gate`);
		// Under it, and no gate either: how many cite an id only the tools can read.
		const idsLine = internalIdsLine(summary);
		if (idsLine) console.log(idsLine);
		printJudge(abilityRows);
	}
	if (args.showMemory) {
		const { readFileSync } = await import("node:fs");
		const path = await import("node:path");
		console.log(`\n--- ${room.roomId} L1b ---\n${readFileSync(path.join(room.roomDir, "L1b", "current.md"), "utf-8")}`);
		console.log(`--- ${room.roomId} archive ---\n${readFileSync(path.join(room.roomDir, "L1b", "archive", "entries.md"), "utf-8")}`);
	}
	return { summary, steps: ingest.steps, rows, roomId: room.roomId, mechanical, conflictFailures };
}

// --- The tables --------------------------------------------------------------

/** The width of a location column: fourteen, or a space more than the widest label among these locations. */
function columnWidth(locations: readonly EvidenceLocation[]): number {
	return Math.max(14, ...locations.map((location) => locationLabel(location).length + 1));
}

/** Accuracy per ability × location: which forgetting costs which ability its answers. */
function printForgetting(rows: readonly RecallResultRow[]): void {
	const table = forgettingTable(rows);
	// Each column as wide as its own label needs, so the short-named places
	// keep the width they had and only "conversation (no notes)" takes more.
	const width = (location: EvidenceLocation) => columnWidth([location]);
	// The questions without a hint sit in a last column of their own, after
	// "all", which therefore counts what it always counted. They are extraction
	// questions, so the cell stands on that row and on the bottom one; a run
	// that holds none prints the table without the column.
	const noHint = table.noHint.count > 0;
	console.log(`${pad("ability", 17)}${table.locations.map((location) => pad(locationLabel(location), width(location), true)).join("")}${pad("all", 14, true)}${noHint ? pad("no hint", 14, true) : ""}`);
	for (const ability of table.abilities) {
		console.log(
			pad(ability, 17) +
				table.locations.map((location) => pad(accuracyCell(table.cell(ability, location)), width(location), true)).join("") +
				pad(accuracyCell(table.byAbility(ability)), 14, true) +
				(noHint ? pad(ability === "extraction" ? accuracyCell(table.noHint) : "-", 14, true) : ""),
		);
	}
	console.log(
		pad("all", 17) +
			table.locations.map((location) => pad(accuracyCell(table.byLocation(location)), width(location), true)).join("") +
			pad(accuracyCell(table.total), 14, true) +
			(noHint ? pad(accuracyCell(table.noHint), 14, true) : ""),
	);
}

/** `2/2` right of asked, or a dash while nobody was asked. */
function noHintScore(block: RecallRunSummary["noHint"]): string {
	return !block || block.answered === 0 ? "-" : `${block.correct}/${block.answered}`;
}

/**
 * The questions without a hint in one line: how many, where their sentences
 * sit, what each kind of query finds when the bench asks recall for them, and
 * how many the room got right when it was asked. The score is the number a
 * before and an after of the room's instructions are compared on, because
 * nothing in the question or in the notes tells the room to search; the three
 * query counts say whether a search, once made, could have found the sentence.
 */
function printNoHint(rows: readonly RecallResultRow[]): void {
	if (rows.length === 0) return;
	const places = [...new Set(rows.map((row) => locationLabel(row.location)))].join(", ");
	const found = QUERY_KINDS.map((kind) => `${kind} ${rows.filter((row) => typeof row.ranks[kind] === "number").length}/${rows.length}`).join(", ");
	const answered = rows.filter((row) => row.answered !== null);
	const score = answered.length === 0 ? "not asked" : `${answered.filter((row) => row.answered).length}/${answered.length} right`;
	console.log(`no hint: ${rows.length} question(s) in ${places} · recall finds ${found} · ${score}`);
}

/**
 * Where the values a later conversation replaced ended up. A supersede is only
 * finished when the old value has left the core: while it is still there the
 * room reads both, and the wrong one is as close to hand as the right one.
 */
function printSupersedes(rows: readonly RecallResultRow[]): void {
	const replaced = rows.filter((row) => row.trapLocation !== undefined);
	if (replaced.length === 0) return;
	const archived = replaced.filter((row) => row.trapLocation === "archive").length;
	const inCore = replaced.filter((row) => row.trapLocation === "core").length;
	console.log(`supersedes: ${archived} of ${replaced.length} replaced values are in the archive, ${inCore} still in core`);
}

/**
 * What the run made of the notes that say one thing twice, or nearly. The
 * first line counts: the conflicts found (rows a Memorize superseded with a
 * reason, plus the pairs still disagreeing in the final core), how many were
 * resolved with a reason, how many stand as both, and the repeats the fold
 * refused as twins. Then one line per planted pair, `ok` or `FAIL` with the
 * detail read off the room's files; a pair this size holds only half of reads
 * `n/a`. When the room was asked, the last line is the pairs' own score.
 */
function printConflicts(conflicts: ConflictsSummary, shapeRows: readonly RecallResultRow[], absent: readonly ConflictShape[]): void {
	console.log(`conflicts: ${conflicts.found} found, ${conflicts.supersededWithReason} superseded with a reason, ${conflicts.leftAsBoth} left as both, ${conflicts.twinsRefused} repeats refused as twins`);
	for (const verdict of conflicts.shapes) console.log(`  ${pad(verdict.shape, 16)}${pad(verdict.ok ? "ok" : "FAIL", 6)}${verdict.detail}`);
	for (const shape of absent) console.log(`  ${pad(shape, 16)}${pad("n/a", 6)}the pair is not in this run; a run of more sessions holds it`);
	const answered = shapeRows.filter((row) => row.answered !== null);
	if (answered.length > 0) console.log(`  ${answered.filter((row) => row.answered).length} of ${shapeRows.length} right`);
}

/**
 * What each kind of query finds, one row per EVIDENCE MARKER and not per
 * question, split by where that marker sits. `rank 1` is the row the room would
 * read first; `found` is anywhere in the results; `none` is a query that came
 * back without it. A marker still in the core needs no recall at all, so its
 * "none" is not a miss — the row is there to show how much of the fixture never
 * had to be retrieved. The `conversation` rows are the other end of that: a
 * fact the room was told and never wrote down is reachable ONLY here, so a
 * "none" in those rows is the whole answer lost. A marker appears once per
 * question that cites it, because a marker two questions lean on is retrieved
 * twice.
 *
 * The code control is a search for the marker's own reference code, and it
 * applies to a conversation the same way it applies to an archived note: the
 * transcript kept the sentence, code and all, so a control that misses there
 * says the search cannot reach the transcript rather than that the question's
 * words were never in it.
 */
function printRetrieval(rows: readonly MarkerRow[]): void {
	const locations = [...new Set(rows.map((row) => row.location))].sort();
	// As wide as the widest place this run has markers in, and fourteen otherwise.
	const locationWidth = columnWidth(locations);
	console.log(`${pad("query", 12)}${pad("location", locationWidth)}${pad("markers", 9, true)}${pad("rank 1", 8, true)}${pad("found", 8, true)}${pad("none", 8, true)}`);
	const line = (label: string, location: string, ranks: Array<number | null>, markers: number) => {
		console.log(
			pad(label, 12) +
				pad(location, locationWidth) +
				pad(markers, 9, true) +
				pad(ranks.filter((rank) => rank === 1).length, 8, true) +
				pad(ranks.filter((rank) => rank !== null).length, 8, true) +
				pad(ranks.filter((rank) => rank === null).length, 8, true),
		);
	};
	for (const kind of QUERY_KINDS) {
		for (const location of locations) {
			const here = rows.filter((row) => row.location === location);
			if (here.length === 0) continue;
			line(kind, locationLabel(location), here.map((row) => row.ranks[kind]), here.length);
		}
	}
	for (const location of locations) {
		// The control is a search for a reference code, so it only means anything
		// for the notes that still carry one.
		const here = rows.filter((row) => row.location === location && row.how === "code");
		if (here.length === 0) continue;
		line("code (ctrl)", locationLabel(location), here.map((row) => row.control), here.length);
	}
	const reworded = rows.filter((row) => row.how === "wording").length;
	if (reworded > 0) console.log(`${pad("", 12)}${pad("", 14)}${pad(reworded, 9, true)} notes were found by their words rather than their code, so no code control applies to them`);
}

/**
 * The same three queries read as QUESTIONS rather than markers: how many of the
 * questions recall was actually asked about — the ones whose evidence is in the
 * archive or in a conversation the room kept — the query answered. A question
 * whose evidence the core still holds asked recall nothing and is in neither
 * number. Which of the two places each question's own evidence sits in is in
 * the first table, on the question's own row.
 *
 * The literal and the variant line say in addition how the questions resting
 * on SEVERAL sentences did: those two queries quote every sentence such a
 * question rests on, so the bar for them is every retrieved sentence within
 * as many results as the question has sentences. The paraphrase asks in other
 * words and is held to no such bar.
 */
function printQuestionRetrieval(rows: readonly RecallResultRow[], multiLine: readonly MultiLineRow[] = []): void {
	const applicable = rows.filter((row) => row.ranks.literal !== "n/a");
	const several = multiLine.filter((row) => row.applicable);
	const counts = [...new Set(several.map((row) => row.markers))];
	const bar = counts.length === 1 ? `rank ${counts[0]}` : "their line count";
	for (const kind of QUERY_KINDS) {
		const found = applicable.filter((row) => typeof row.ranks[kind] === "number");
		const first = applicable.filter((row) => row.ranks[kind] === 1);
		const tail = kind === "paraphrase" || several.length === 0 ? "" : `; multi-line questions: ${several.filter((row) => row.within[kind]).length} of ${several.length} within ${bar}`;
		console.log(`${pad(kind, 12)}${pad(`${found.length}/${applicable.length}`, 10, true)} questions answered from the archive or a conversation, ${first.length} of them at rank 1${tail}`);
	}
}

/**
 * The judge's accuracy per ability, BESIDE the exact score and never instead of
 * it. The last column is the one to read: where the two disagree is where
 * containment and a reader would part company, and it is the only reason to pay
 * for a judge at all.
 */
function printJudge(rows: readonly RecallResultRow[]): void {
	const judged = rows.filter((row) => row.judge);
	if (judged.length === 0) return;
	const cell = (correct: number, total: number) => (total === 0 ? "-" : `${correct}/${total} ${Math.round((correct / total) * 100)}%`);
	const line = (label: string, here: readonly RecallResultRow[]) => {
		console.log(
			pad(label, 17) +
				pad(cell(here.filter((row) => row.answered === true).length, here.length), 14, true) +
				pad(cell(here.filter((row) => row.judge?.label === true).length, here.length), 14, true) +
				pad(here.filter((row) => (row.answered === true) !== (row.judge?.label === true)).length, 9, true),
		);
	};
	console.log("");
	console.log(`judge ${judged[0].judge?.model} · a second opinion beside the exact score, never instead of it`);
	console.log(`${pad("ability", 17)}${pad("exact", 14, true)}${pad("judge", 14, true)}${pad("differ", 9, true)}`);
	for (const ability of [...new Set(judged.map((row) => row.ability))].sort()) line(ability, judged.filter((row) => row.ability === ability));
	line("all", judged);
	console.log(`${judged.length} verdict(s) · ${judged.reduce((total, row) => total + (row.judge?.promptTokens ?? 0), 0)} prompt tokens asked of the judge`);
}

/**
 * What the room did with the notes it was asked about between the folds. The
 * first block is the forgetting: of the markers a probe returned from the core
 * at least once, how many are still there, how many the budget moved out
 * afterwards, how many are nowhere. The second is the two protections the
 * ranking promises: open items stay, and every row a Memorize moved out by
 * budget says why. The header line says how much asking it took, and whether
 * the product under the run has a use sidecar at all — a product without one
 * is the "before" of the gate, and the probes there record nothing.
 */
function printInterleave(summary: InterleaveSummary, detail: { probes: number; folds: number; askedInCore: number; sidecarWritten: boolean | null; events: number }): void {
	const sidecar = detail.sidecarWritten === null ? "no fold ran, so nothing was asked" : detail.sidecarWritten ? "the room's use sidecar was written after every fold" : "this product keeps no use sidecar, so the probes recorded nothing (the before of the gate)";
	console.log(`interleaved: ${summary.askedQuestions} questions asked over ${detail.folds} fold(s), ${detail.probes} recall call(s) in all · ${sidecar}`);
	console.log(`${pad("", 30)}${pad("markers", 9, true)}`);
	const line = (label: string, value: number) => console.log(`${pad(label, 30)}${pad(value, 9, true)}`);
	line("asked (evidence of a question)", summary.askedMarkers);
	line("asked while in core", detail.askedInCore);
	line("  still in core", summary.askedMarkersStillInCore);
	line("  then archived by budget", summary.askedThenArchived);
	line("  then gone", summary.askedThenGone);
	line("open items planted", summary.openItemMarkers);
	line("  still in core", summary.openItemMarkersInCore);
	console.log(`${pad("", 30)}${pad("rows", 9, true)}`);
	line(`moved out by budget (${detail.events} Memorize record(s))`, summary.budgetRowsInEvents);
	line("  with a reason", summary.budgetRowsWithReason);
}

/**
 * The gate an interleaved run is held to against a run BEFORE the ranking read
 * use, per language:
 *   (a) of the markers the room looked up while they were in the core, the
 *       ones the budget moved out or lost afterwards are at most half of what
 *       they were before;
 *   (b) every open item the fixture planted is still in the core;
 *   (d) every row a Memorize moved out by budget says why.
 * (c), the order of the score's own terms, is the ranking smoke's. Each line
 * says which language, which number, and what was expected.
 */
function forgettingGate(after: RecallRunSummary, before: RecallRunSummary | undefined): string[] {
	const failures: string[] = [];
	const now = after.interleave;
	if (!now) return [`${after.language}: this run did not interleave, so there is no forgetting to gate; pass --interleave with --gate-before`];
	const was = before?.interleave;
	if (!was) return [`${after.language}: the before file holds no interleaved run for this language; run it with --interleave --language ${after.language}`];
	const demotedNow = now.askedThenArchived + now.askedThenGone;
	const demotedBefore = was.askedThenArchived + was.askedThenGone;
	if (demotedNow * 2 > demotedBefore) failures.push(`${after.language}: (a) ${demotedNow} marker(s) the room had looked up were moved out or lost afterwards, against ${demotedBefore} before; at most half, ${Math.floor(demotedBefore / 2)}, was expected`);
	if (now.openItemMarkersInCore !== now.openItemMarkers) failures.push(`${after.language}: (b) ${now.openItemMarkersInCore} of ${now.openItemMarkers} open items are still in the core; all of them were expected to be`);
	if (now.budgetRowsWithReason !== now.budgetRowsInEvents) failures.push(`${after.language}: (d) ${now.budgetRowsWithReason} of ${now.budgetRowsInEvents} rows moved out by budget say why in the Memorize records; every one was expected to`);
	return failures;
}

/** The before file, read once; a file that is not an interleaved results file is said so in one line. */
function readBeforeResults(file: string): RecallResultsFile {
	let parsed: RecallResultsFile;
	try {
		parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as RecallResultsFile;
	} catch (error) {
		throw new Error(`--gate-before ${file} could not be read: ${error instanceof Error ? error.message : String(error)}`);
	}
	if (parsed?.bench !== "recall" || !Array.isArray(parsed.runs)) throw new Error(`--gate-before ${file} is not a recall bench results file`);
	return parsed;
}

// --- The scorer's own cases --------------------------------------------------

/**
 * The answer scorer, against cases written by hand. It runs on every run
 * because in THIS pass nothing asks the room, so nothing else exercises
 * scoreAnswer at all — and a scorer the next pass has to trust with the
 * accuracy numbers cannot be dead code until then. A case that disagrees is
 * mechanical: the scorer, not a room, got it wrong.
 */
function scorerCases(): string[] {
	const ask = (over: Partial<RecallQuestion>): RecallQuestion => ({
		id: "self-check",
		ability: "extraction",
		language: "de",
		question: "?",
		gold: [],
		evidence: [],
		queries: { literal: "", paraphrase: "", variant: "" },
		askDate: "2026-06-01",
		...over,
	});
	const cases: Array<[string, Partial<RecallQuestion>, string, boolean]> = [
		["a date in another shape", { gold: ["1. Juni 2026"] }, "Der Termin ist am 2026-06-01.", true],
		["an umlaut written out", { gold: ["Grünstraße 12"] }, "In der Gruenstrasse 12.", true],
		["a thousands separator", { gold: ["42.000"] }, "Es sind 42000 Euro.", true],
		["a number without its separator", { gold: ["4471-8890"] }, "Die Nummer ist 4471 8890.", true],
		["a number written as a word", { gold: ["3"] }, "Es sind drei Stück.", true],
		["a declined quarter", { gold: ["Q3"] }, "Im dritten Quartal.", true],
		["a quarter in the other language", { gold: ["Q3"] }, "In the third quarter.", true],
		["a value that is simply wrong", { gold: ["14:30"] }, "Um 09:00 Uhr.", false],
		["the replaced value alone", { ability: "knowledge-update", gold: ["99"], trap: ["14:30"] }, "Um 14:30 Uhr.", false],
		["the current value beside the replaced one", { ability: "knowledge-update", gold: ["99"], trap: ["14:30"] }, "Jetzt 99, vorher 14:30.", true],
		["a not-known in German", { ability: "abstention" }, "Das weiß ich nicht.", true],
		["a not-known in English", { ability: "abstention" }, "I don't know, it wasn't mentioned.", true],
		["a not-known that invents a number anyway", { ability: "abstention", trapPattern: "\\d{3,}" }, "Ich weiß es nicht, vielleicht 0171 2233445.", false],
		["an answer where none was possible", { ability: "abstention" }, "Die Nummer ist 0171 2233445.", false],
		["a not-known that says back the date it was asked on", { ability: "abstention", askDate: "2026-07-21" }, "Stand 21. Juli 2026 liegt mir dazu keine Angabe vor.", true],
		["a gold number that is the tail of a longer one", { gold: ["19"] }, "found 119 dormant accounts", false],
		["a gold count that is the tail of a longer count", { gold: ["5 hours"] }, "the run took 15 hours", false],
		["a gold number that is a day inside a date", { ability: "knowledge-update", gold: ["19"], trap: ["12"] }, "found 12 dormant accounts on 2026-05-19", false],
		["a number written out above twelve", { gold: ["30 days"] }, "paid thirty days net", true],
		["an English ordinal date", { gold: ["2026-07-11"] }, "It was 11th July 2026.", true],
		["a sum written with a k", { gold: ["55000 EUR"] }, "The ceiling is 55k EUR.", true],
		["a sum written with a currency sign in front", { gold: ["55000 EUR"] }, "The ceiling is €55,000.", true],
		["a sum written the German way", { gold: ["55000 EUR"] }, "Die Grenze liegt bei 55.000 €.", true],
		["a sum with the currency code against its number", { gold: ["55,000 EUR"] }, "The ceiling is EUR55,000.", true],
		["a sum with the currency code in front of its number", { gold: ["55,000 EUR"] }, "The ceiling is EUR 55,000.", true],
		["a sum with the currency sign behind its number", { gold: ["55,000 EUR"] }, "The ceiling is 55,000€.", true],
		["a German article standing in for one", { gold: ["1 Tag"] }, "Es dauerte einen Tag.", true],
		["a not-known that hedges a guess", { ability: "abstention", trap: ["Radisson"] }, "I don't know for certain, but I believe it was the Radisson", false],
		["a not-known that says back a fact it holds", { ability: "abstention", trapPattern: "\\d{2,}" }, "I don't know the address; the contract renews on 2026-11-30 but no office was ever given", true],
		["a not-known written as not sure", { ability: "abstention" }, "I'm not sure, that was never mentioned", true],
		["a not-known written as no information", { ability: "abstention" }, "I don't have that information", true],
		["a not-known written as keine Ahnung", { ability: "abstention" }, "Keine Ahnung", true],
		["a not-known written as nie besprochen", { ability: "abstention" }, "Das wurde nie besprochen", true],
		["an order answered by putting the wrong option next to the order word", { ability: "temporal", gold: ["wider audit window"], distractor: ["higher contract ceiling"] }, "Between the wider audit window and the higher contract ceiling, the higher contract ceiling was settled first", false],
		["an order answered by naming the wrong option only to rule it out", { ability: "temporal", gold: ["audit window"], distractor: ["contract ceiling"] }, "Not the contract ceiling: the audit window came first", true],
		["a not-known that says back the date and invents a number too", { ability: "abstention", askDate: "2026-07-21", trapPattern: "\\d{2,}" }, "Stand 21. Juli 2026 liegt mir keine Angabe vor, vielleicht 0171 2233445.", false],
		["an order question answered the right way round", { ability: "temporal", gold: ["die Prüfung"], distractor: ["die Übergabe"] }, "Zuerst die Prüfung, danach die Übergabe.", true],
		["an order question answered the wrong way round", { ability: "temporal", gold: ["die Prüfung"], distractor: ["die Übergabe"] }, "Zuerst die Übergabe, danach die Prüfung.", false],
		["an order question that names only the right option", { ability: "temporal", gold: ["die Prüfung"], distractor: ["die Übergabe"] }, "Die Prüfung kam zuerst.", true],
		["a not-known in words no list holds", { ability: "abstention", trap: ["Radisson"] }, "No hotel was ever named for that weekend.", true],
		["a not-known written with a contraction", { ability: "abstention" }, "That isn't something we ever settled.", true],
		["a German not-known in words no list holds", { ability: "abstention" }, "Eine Vertretung ist bisher nirgends benannt.", true],
		["a negation beside an invented specific", { ability: "abstention", trap: ["Radisson"] }, "It was not the usual place, it was the Radisson.", false],
	];
	const wrong: string[] = [];
	for (const [label, over, answer, want] of cases) {
		const scored = scoreAnswer({ question: ask(over), answer, known: ["2026-11-30"] });
		if (scored.correct !== want) wrong.push(`the scorer called ${label} ${scored.correct ? "right" : "wrong"} (${scored.why})`);
	}
	console.log(`scorer: ${cases.length - wrong.length}/${cases.length} of its own cases`);
	return wrong;
}

// --- Baselines ---------------------------------------------------------------

/**
 * The floor and the ceiling either side of a room's memory.
 *
 * `none` is the floor: the same questions, on a room with NO memory at all — a
 * second scaffolded room in the same home that nothing was ever remembered
 * into. Whatever it scores is what the questions give away by themselves, and
 * every point a room scores above it is a point its memory earned. It runs
 * through the same server and the same turn, so nothing but the memory differs.
 *
 * `transcript` is the ceiling: every conversation's turns, rendered plain in
 * one prompt, with the question after them — no memory, no retrieval, no
 * forgetting, just the whole past in the context window. It is the answer a
 * room would give if a context window were free, and the number beside it is
 * the reason one is not: the prompt's size, and whether it would fit at all.
 */
async function runNoMemoryBaseline(fixture: RecallFixture, args: BenchArgs, home: string, server: BenchServer): Promise<void> {
	const room = await createBenchRoom({ home, name: `Recall Baseline ${fixture.language.toUpperCase()}`, backHistoryTokens: 0 });
	const asked = args.limit === undefined ? fixture.questions : fixture.questions.slice(0, args.limit);
	let right = 0;
	for (const question of asked) {
		const turn = await askRoom({ server, roomId: room.roomId, conversationId: `c_base_${question.id.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`, prompt: askPrompt(question) });
		if (scoreAnswer({ question, answer: turn.answer }).correct) right += 1;
	}
	console.log(`baseline none (${fixture.language}): ${right}/${asked.length} right on a room that was never told anything`);
}

/** The whole past in one prompt: what it would cost, and whether it would fit. */
function transcriptBaselinePrompt(fixture: RecallFixture, question: RecallQuestion): string {
	const transcript = fixture.sessions
		.map((session) => [`## ${session.date} — ${session.title}`, "", ...session.turns.map((turn) => `${turn.role === "user" ? "User" : "Assistant"}: ${turn.text}`)].join("\n"))
		.join("\n\n");
	const ask = askPrompt(question);
	return fixture.language === "de"
		? `Hier sind alle bisherigen Gespräche, in zeitlicher Reihenfolge.\n\n${transcript}\n\n---\n\n${ask}`
		: `Here is every conversation so far, in order.\n\n${transcript}\n\n---\n\n${ask}`;
}

function reportTranscriptBaseline(fixture: RecallFixture, args: BenchArgs): void {
	const asked = args.limit === undefined ? fixture.questions : fixture.questions.slice(0, args.limit);
	const sizes = asked.map((question) => answerTokens(transcriptBaselinePrompt(fixture, question)));
	const largest = Math.max(...sizes);
	const windows: Array<[string, number]> = [["a 128k window", 128_000], ["a 200k window", 200_000], ["a 1M window", 1_000_000]];
	const verdict = windows.map(([label, size]) => `${largest > size * 0.9 ? "does not fit" : "fits"} ${label}`).join(" · ");
	console.log(`baseline transcript (${fixture.language}): one prompt of ${largest} tokens carries all ${fixture.sessions.length} conversations — ${verdict}`);
	console.log("  (a 90% fill is the ceiling used: the answer, the system prompt and the tools need the rest)");
	if (!process.env.RECALL_BENCH_MODEL) console.log("  no model configured, so the size is reported and nothing is asked; set RECALL_BENCH_MODEL to score it");
}

// --- Main --------------------------------------------------------------------

const args = parseArgs(process.argv.slice(2));
const realSpec = process.env.RECALL_BENCH_MODEL?.trim();
// The temp home is made INSIDE the try below, so that the finally takes it down
// on every path out: a fixture that throws, a provider that is not on this
// machine, a port that is taken, a dry run that stops before any of it. The
// exit hook is the belt to that brace — `process.exit` does not run a finally.
const home = prepareBenchHome("recall-bench").home;
process.on("exit", () => {
	if (!args.keepHome) fs.rmSync(home, { recursive: true, force: true });
});
if (args.gateBefore !== undefined && !args.interleave) throw new Error("--gate-before holds an interleaved run against an earlier one; pass --interleave with it");
console.log(`Recall bench · ${args.ask ? (realSpec ? `asking ${realSpec}` : "asking the scripted room model") : "retrieval only, no --ask"}${args.interleave ? " · interleaved (the room is asked between the folds)" : ""} · ${args.sources ? `recall reads ${args.sources.join(", ")} only` : "recall reads every source"} · home ${args.keepHome ? home : "(temp)"}`);
// The score the product under this run ranks its notes by, so a results file
// can be read against the constants that produced it; a product on the fixed
// sort of 0.12 has none and says so.
const scoreConstants = await demotionScoreConstants();
console.log(scoreConstants ? `score constants: ${Object.entries(scoreConstants).map(([name, value]) => `${name} ${value}`).join(" · ")}` : "score constants: none (fixed sort)");

const fixtures = args.languages.map((language) =>
	buildRecallFixture({
		language,
		...(args.seed === undefined ? {} : { seed: args.seed }),
		...(args.sessions === undefined ? {} : { sessions: args.sessions }),
		...(args.perAbility === undefined ? {} : { questionsPerAbility: args.perAbility }),
	}),
);

if (args.dryRun && !args.ask) {
	// Without --ask there is nothing to price, but --dry-run still means "tell me
	// what you would do and do none of it" — it used to mean "run the whole
	// bench", which is the one thing the flag exists to prevent.
	const sessions = fixtures[0]?.sessions.length ?? 0;
	const questions = fixtures.reduce((total, fixture) => total + fixture.questions.length, 0);
	console.log(`dry run: would build ${fixtures.length} room(s) of ${sessions} conversations each, fold every ${args.foldEvery ?? 7}, and probe retrieval for ${questions} question(s); nobody would be asked anything (no --ask)`);
	console.log("dry run: nothing was built and nothing was spawned; drop --dry-run to run it");
	process.exit(0);
}

let gateway: Awaited<ReturnType<typeof startScriptedRoomGateway>> | null = null;
let server: BenchServer | null = null;
let ingestPair: RealIngest | null = null;
let judge: JudgeCall | null = null;
if (args.ask) {
	const questions = fixtures.flatMap((fixture) => fixture.questions);
	const asked = args.limit === undefined ? questions.length : Math.min(args.limit, questions.length / fixtures.length) * fixtures.length;
	if (args.judge && !realSpec) console.log(`judge: ${args.judge} needs a real model: the scripted gateway answers by quoting and would only ever agree with itself. Set RECALL_BENCH_MODEL to judge; every row's judge field stays null and the scorer's own verdict is the number.`);
	if (realSpec) {
		const lock = useRealProviderRecords({ spec: realSpec });
		// Every write is stamped with the model the room will answer with: a
		// room's active AI profile has to approve the lock on its own records.
		setBenchModel(lock);
		const sessions = fixtures[0]?.sessions.length ?? 0;
		const folds = Math.max(1, Math.ceil(sessions / (args.foldEvery ?? 7)));
		if (args.dryRun) {
			// A dry run prices the work and stops: no worker is built, no server is
			// spawned, and not one call is made. It is the number to read before
			// deciding to spend anything.
		} else if (args.scriptedIngest) {
			console.log("ingest: SCRIPTED under a real model — the room is written by the fixture's own operations, so every language's room is the same room a free run builds, and only the answering is the model's");
		} else {
			ingestPair = await createRealIngest({ roomModel: lock });
		}
		if (!args.scriptedIngest) {
			const foldPrompt = DEFAULT_MEMORY_BUDGET_TOKENS + 1_500;
			const checkpointPrompt = DEFAULT_MEMORY_BUDGET_TOKENS + 800;
			console.log(`estimate: ingest ≈ ${sessions} checkpoint call(s) of ~${checkpointPrompt} prompt tokens + ${sessions} fold call(s) of ~${foldPrompt} across ${folds} Memorize run(s) ≈ ${Math.round((sessions * (checkpointPrompt + foldPrompt)) / 1000)}k prompt tokens per language`);
		}
		const perCall = fixtures[0] ? Math.round(fixtures[0].sessions.length * 40 + 12_000) : 12_000;
		console.log(`estimate: asking ≈ ${asked} question(s) × 2 calls ≈ ${asked * 2} calls of roughly ${perCall} prompt tokens each ≈ ${(asked * 2 * perCall / 1000).toFixed(0)}k prompt tokens${args.baseline === "none" ? ", and the same again for the baseline" : ""}`);
		console.log("estimate: the room's memory is about " + DEFAULT_MEMORY_BUDGET_TOKENS + " tokens, which is the bulk of every prompt; the real total is printed after the run");
		if (args.dryRun) {
			console.log("dry run: nothing was called and nothing was spawned; drop --dry-run to run it");
			process.exit(0);
		}
		server = await startBenchServer({ home, model: lock });
	} else {
		gateway = await startScriptedRoomGateway({ questions, plants: fixtures.flatMap((fixture) => fixture.sessions.flatMap((session) => session.plants)), ...(args.sources === undefined ? {} : { sources: args.sources }) });
		const lock = writeScriptedProviderRecords({ gatewayPort: gateway.port });
		setBenchModel(lock);
		// `--real-ingest` without a real model drives the REAL Remember and the
		// REAL Memorize — the checkpoint worker, the absorb run, the approval
		// writes — against this gateway instead of a provider. It is how the real
		// ingest path is exercised for free, and it is the one offline run where
		// the notes reach memory without their reference codes, so the wording
		// fallback is on the hook too.
		if (args.realIngest) {
			ingestPair = await createRealIngest({ roomModel: lock });
			console.log("ingest: REAL (the checkpoint worker and the absorb run), answered by the scripted gateway rather than a provider");
		}
		if (args.dryRun) {
			console.log("dry run: nothing was called and nothing was spawned; drop --dry-run to run it");
			process.exit(0);
		}
		server = await startBenchServer({ home, model: lock });
	}
	console.log(`server: ${server.baseUrl} · model ${server.model.provider}/${server.model.model}`);
	if (args.judge && realSpec) {
		judge = createJudge(args.judge, await createMaintenanceWorker());
		console.log(`judge: ${args.judge}, on LongMemEval's own templates`);
	}
}
if (args.judge && !args.ask) console.log(`judge: ${args.judge} has nothing to judge without --ask; this pass locates and retrieves and asks nobody`);

if (args.ask && !realSpec) {
	// So that nobody reads the scripted number as a wiring failure: the scripted
	// room QUOTES what reached it and does nothing else, and two abilities ask
	// for more than quoting.
	console.log("scripted ceiling: the scripted room quotes the lines that reached it and computes nothing, so it cannot reach every question —");
	console.log("  multi-session: one turn makes ONE recall call with one literal query, so only one of a question's two archived notes comes back;");
	console.log("  temporal: an interval between two dates (\"9 Tage\") is arithmetic over the quoted lines, which a quoting model never does.");
	console.log("  Both are ceilings of the scripted model, not of the memory; a real model is expected to beat them on the same room.");
}

const runs: Array<{ summary: RecallRunSummary; steps: IngestStep[]; rows: RecallResultRow[] }> = [];
let mechanicalFailures: string[] = scorerCases();
/** The planted pairs the memory mishandled, across the languages; an exit code only when a gate asked for one. */
const conflictFailures: string[] = [];
/**
 * Everything the fixture plants or accepts as an answer, gathered once: every
 * gold, trap and distractor spelling, every ask date, and every number and date
 * inside a planted line. The abstention rule reads it to tell a fact the room
 * was told from one it made up.
 */
const known = [
	...new Set([
		...fixtures.flatMap((fixture) => fixture.questions.flatMap((question) => [...question.gold, ...(question.trap ?? []), ...(question.distractor ?? []), question.askDate])),
		...fixtures.flatMap((fixture) => fixture.sessions.flatMap((session) => session.plants.flatMap((plant) => numbersAndDatesIn(plant.line)))),
	]),
];
try {
	for (const fixture of fixtures) {
		const run = await runLanguage(fixture, args, home, server, ingestPair, !realSpec, judge, known);
		runs.push({ summary: run.summary, steps: run.steps, rows: run.rows });
		mechanicalFailures = [...mechanicalFailures, ...run.mechanical];
		conflictFailures.push(...run.conflictFailures);
		if (args.baseline === "none" && server) await runNoMemoryBaseline(fixture, args, home, server);
		if (args.baseline === "transcript") reportTranscriptBaseline(fixture, args);
	}
} finally {
	if (server) await server.stop();
	if (gateway) await gateway.close();
	// A run's home is a room's worth of files (about 16 MB with the runtime's
	// session store); it goes with the run unless the reader asked to keep it.
	if (!args.keepHome) fs.rmSync(home, { recursive: true, force: true });
}

const label = args.languages.join("-");
const written = writeRecallResults({ label, runs, ...(args.out === undefined ? {} : { out: args.out }) });
console.log(`\nresults: ${written}`);
if (args.keepHome) console.log(`home kept: ${home}`);
if (gateway) console.log(`the scripted room model answered ${gateway.calls} completions`);
if (ingestPair) {
	const spent = ingestPair.usage();
	console.log(`ingest cost: ${spent.calls} worker call(s) · in ${spent.input} tok · out ${spent.output} tok${spent.cost > 0 ? ` · $${spent.cost.toFixed(4)}` : ""}`);
}

// The forgetting gate: this run's interleaved numbers against the before file,
// per language. It is the one place a judgment number IS an exit code, and only
// when the reader asked for it with --gate-before.
if (args.gateBefore !== undefined) {
	let before: RecallResultsFile;
	try {
		before = readBeforeResults(args.gateBefore);
	} catch (error) {
		console.log(`\nforgetting gate: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
	const gateFailures: string[] = [];
	console.log("");
	for (const run of runs) {
		const earlier = before.runs.find((candidate) => candidate.summary.language === run.summary.language)?.summary;
		console.log(`median answer tokens before/after (${run.summary.language}): ${earlier?.answerTokensMedian ?? "-"}/${run.summary.answerTokensMedian}`);
		// Reported beside the gate and never part of it: the no-hint score is the
		// row a change to the room's instructions can move.
		if (run.summary.noHint || earlier?.noHint) console.log(`no hint right before/after (${run.summary.language}): ${noHintScore(earlier?.noHint)} before, ${noHintScore(run.summary.noHint)} after · reported, never a gate`);
		gateFailures.push(...forgettingGate(run.summary, earlier));
	}
	if (gateFailures.length === 0) console.log(`forgetting gate: passed for ${runs.map((run) => run.summary.language).join(", ")} against ${args.gateBefore}`);
	else {
		console.log(`forgetting gate: FAILED (${gateFailures.length}) against ${args.gateBefore}`);
		for (const failure of gateFailures) console.log(`  ${failure}`);
		process.exitCode = 1;
	}
}

// The conflicts gate: a planted pair the memory mishandled is printed in full
// on every run, and is an exit code only when the reader asked for one, with
// --gate-conflicts or with --gate-before.
if (conflictFailures.length > 0 && (args.gateConflicts || args.gateBefore !== undefined)) {
	console.log(`\nconflicts gate: FAILED (${conflictFailures.length})`);
	for (const failure of conflictFailures) console.log(`  ${failure}`);
	process.exitCode = 1;
} else if (args.gateConflicts) {
	console.log(`\nconflicts gate: passed for ${runs.map((run) => run.summary.language).join(", ")}`);
}

if (mechanicalFailures.length > 0) {
	console.log(`\n${mechanicalFailures.length} mechanical failure(s): the bench and the room disagree about what was planted or what was found. Judgment numbers above are not the reason for this exit code.`);
	for (const failure of mechanicalFailures) console.log(`  ${failure}`);
	process.exit(1);
}
