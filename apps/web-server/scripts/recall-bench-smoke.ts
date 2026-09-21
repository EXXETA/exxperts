// The recall bench's own smoke (memory v2, stream 41.4).
//
// The bench in scripts/memory-bench measures a room's forgetting: it builds a
// real room out of a fixture's conversations, says WHERE each question's
// evidence ended up, and asks the room's own `memory_recall` for it. A bench is
// only worth its numbers if the machinery under them is honest, so this smoke
// drives the bench's own pieces over a small fixed fixture — six conversations
// and one question per ability, in both languages, each language in its own
// room — and pins the things a number could quietly lie about:
//
//   - the ingest really writes the room's files: notes with ids in
//     L1b/current.md, and rows in L1b/archive/entries.md whose reason is
//     `budget`, read back through the product's own parsers rather than grepped;
//   - locate tells core from archive, says HOW it found each marker, and calls
//     a marker `gone` only when no part of the room's memory carries it — which
//     this smoke proves by taking an archived row out of the file by hand;
//   - the three rank states stay apart: a number, `null` for a query that came
//     back without the note, and `"n/a"` for a question with nothing in the
//     archive to ask recall for. A question nobody could have retrieved must
//     never be counted as a retrieval that failed, and a question with no
//     evidence at all sits in `none` ("no evidence") rather than in `gone`;
//   - retrieval is reported as it actually behaves on 0.12.1, which is a
//     case-insensitive substring search: a query whose words the archived note
//     carries comes back at rank 1, a paraphrase comes back with nothing;
//   - the answer scorer cannot be fooled into calling a replaced value, an
//     invented specific, or a differently spelled date right or wrong — and,
//     in its own block, cannot be fooled by the answers a containment test
//     scores BACKWARDS: a gold number found inside a longer one, a value
//     spelled the way a room would actually write it, a guess dressed as a
//     not-known, and an order question answered by naming both options;
//   - the room's own score is held to the CEILING its memory allows, read off
//     the room's files and then asked through the room's real turn;
//   - the LongMemEval judge is upstream's: its prompts, its verdict, and a
//     hypothesis file of the two fields it reads;
//   - the fixture plants two extraction questions per language as open items,
//     and an interleaved run of the bench — the room asked between the folds,
//     in a child process — reports what it asked, keeps every open item, gives
//     a reason for every row a Memorize moved out, and passes its own results
//     as the before of the forgetting gate;
//   - an honest abstention in words no phrase list holds scores right, on the
//     real answers that were once rejected, and a negation beside a guess or an
//     invented number stays wrong;
//   - the questions without a hint exist in both languages, share no word with
//     their planted sentences beyond the entity, sit in a folded conversation,
//     and are counted in a column of their own and in no ability table;
//   - the answers that name the mechanism are counted per run, beside the score.
//
// Offline, and no provider: nothing here reaches the network, and the one model
// in the run is a scripted gateway on loopback. It is NOT portless. The
// scripted-ceiling section spawns the product's own web server on a random
// loopback port through smoke-server-process.ts, the way the route smokes do,
// because the only honest way to read a ceiling off a room is to ask the room
// through its own turn. The server and the gateway are stopped in the finally
// block, and everything happens in a temp HOME under os.tmpdir() that the same
// block removes.

import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
	archivedReasons,
	askConversationId,
	askPrompt,
	askRoom,
	backHistoryTokensFor,
	backHistoryWindow,
	buildRunSummary,
	carriesWording,
	createBenchRoom,
	DEFAULT_MEMORY_BUDGET_TOKENS,
	forgettingTable,
	ingestSessions,
	locateEvidence,
	locateEvidenceInDetail,
	locationLabel,
	predictScriptedRoomAnswer,
	prepareBenchHome,
	QUERY_KINDS,
	RANK_NOT_APPLICABLE,
	retrievalRanks,
	retrieve,
	scoreAnswer,
	setBenchModel,
	sizeLine,
	startBenchServer,
	startScriptedRoomGateway,
	worstLocation,
	writeScriptedProviderRecords,
	type BenchServer,
	type EvidenceLocation,
	type RecallResultRow,
	type RecallRunSummary,
	type ScriptedRoomGateway,
} from "./memory-bench/recall-engine.mjs";
import { buildRecallFixture, CONFLICT_SHAPES, handWrittenQueries, OPEN_ITEM_QUESTIONS_PER_LANGUAGE, plantedWording, RECALL_ABILITIES, RECALL_FIXTURE_DEFAULTS, variantWording, type ConflictShape, type RecallLanguage, type RecallQuestion } from "./memory-bench/recall-fixtures.mjs";
// The claim audit, the dropped-conversation place and the fixture's readers of
// it are read off the modules as a whole rather than imported by name: a named
// import of something a tree does not export stops the file from loading, and
// this smoke is run red against such a tree first, where the honest failure is
// the first assertion that needs the missing piece and not a loader error.
import * as engineModule from "./memory-bench/recall-engine.mjs";
import * as fixturesModule from "./memory-bench/recall-fixtures.mjs";
import { judgeLabel, judgePrompt, LONGMEMEVAL_JUDGE_TEMPLATES } from "./memory-bench/longmemeval-judge.mjs";
import { benchQuestion, hypothesisLine, mapInstance, parseLongMemEvalDate, stratifiedSample, type LongMemEvalInstance } from "./memory-bench/longmemeval-map.mjs";

/** Small on purpose: the smoke pins the machinery, not the size of a run. */
const SESSIONS = 6;
const QUESTIONS_PER_ABILITY = 1;
/**
 * Questions whose answer was SAID and never NOTED, on top of the five
 * abilities' own. They are counted apart because that is how the fixture counts
 * them: asking for one does not take a question away from any ability.
 */
const SAID_NOT_NOTED = 1;
const LANGUAGES: readonly RecallLanguage[] = ["de", "en"];
/**
 * A Memorize every two conversations rather than once at the end. It is what
 * makes the forgetting the bench measures HAPPEN at this size: a Memorize puts
 * what it has just saved last in the demotion ranking, so a run with one fold
 * can never push a planted note out however tight the room is, and the only
 * thing in the archive would be the one note a later conversation replaced.
 * With three folds the early conversations' notes leave the core by BUDGET,
 * which is the forgetting that costs a room its answers — and it is what lets
 * this smoke ask the real retrieval question, on a note whose own words are
 * what the query is made of.
 */
const FOLD_EVERY = 2;

const { claimsFailed, claimsLine, RETRIEVED_LOCATIONS } = engineModule;
const { droppedIn, droppedQuestions } = fixturesModule;

let passes = 0;

function pass(label: string): void {
	passes += 1;
	console.log(`  ok ${label}`);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// The state modules read the home when they are imported, so the home comes
// first and every import that touches a room is dynamic and comes after it —
// the same order the bench's own run uses.
const { home, threadCwd } = prepareBenchHome("recall-bench-smoke");
const entries = await import("../src/memory-entries.js");
const store = await import("../src/memory-entries-store.js");
const searchSources = await import("../src/memory-search-sources.js");
const duplicates = await import("../src/memory-duplicates.js");

/** The pair of one shape in a fixture, older member first, or nothing when the fixture holds it only in part. */
function pairOf(fixture: ReturnType<typeof buildRecallFixture>, shape: ConflictShape): [RecallQuestion["evidence"][number] & { line: string }, RecallQuestion["evidence"][number] & { line: string }] | null {
	const members = fixture.sessions.flatMap((session) => session.plants.filter((plant) => plant.shape === shape).map((plant) => ({ sessionId: session.id, marker: plant.marker, line: plant.line })));
	return members.length === 2 ? [members[0], members[1]] : null;
}

/** What one language's room left behind, for the tables at the end. */
interface LanguageRun {
	language: RecallLanguage;
	rows: RecallResultRow[];
	summary: RecallRunSummary;
}

/** The ceiling section's two processes, held out here so the finally can stop them whatever fails. */
let gateway: ScriptedRoomGateway | null = null;
let server: BenchServer | null = null;

try {
	const runs: LanguageRun[] = [];
	const fixtures = new Map<RecallLanguage, ReturnType<typeof buildRecallFixture>>();

	for (const language of LANGUAGES) {
		const fixture = buildRecallFixture({ language, sessions: SESSIONS, questionsPerAbility: QUESTIONS_PER_ABILITY, conversationQuestions: SAID_NOT_NOTED });
		fixtures.set(language, fixture);
		// The room the bench's own run builds: a back history dated evenly across
		// the fixture's timeline and off the days the folds run, sized so the
		// first fold already puts the room over its budget. Without the dating the
		// back history is one undated block that the budget always sheds first,
		// and nothing the fixture planted would ever leave the core.
		const sessionDates = fixture.sessions.map((session) => session.date).sort();
		const foldDates = sessionDates.filter((_, index) => (index + 1) % FOLD_EVERY === 0 || index === sessionDates.length - 1);
		const firstFoldDate = sessionDates[Math.min(FOLD_EVERY, sessionDates.length) - 1] ?? sessionDates[sessionDates.length - 1];
		const window = backHistoryWindow(fixture.sessions);
		const sized = backHistoryTokensFor({ budgetTokens: DEFAULT_MEMORY_BUDGET_TOKENS, window, firstFoldDate });
		const room = await createBenchRoom({
			home,
			name: `Recall Bench Smoke ${language.toUpperCase()}`,
			backHistoryWindow: window,
			backHistoryAvoidDates: foldDates,
			backHistoryTokens: sized.tokens,
		});
		const currentPath = path.join(room.roomDir, "L1b", "current.md");
		const archivePath = path.join(room.roomDir, "L1b", "archive", "entries.md");

		// --- 1. The ingest writes the room's files -------------------------------
		const ingest = await ingestSessions({ roomId: room.roomId, sessions: fixture.sessions, foldEvery: FOLD_EVERY });
		assert(
			ingest.failures.length === 0,
			`${language}: the scripted folds answer with the fixture's own operations, so nothing should be refused, and ${ingest.failures.length} conversation(s) were: ${ingest.failures.map((failure) => `${failure.session} (${failure.reason})`).join("; ")}`,
		);
		assert(ingest.remembered === fixture.sessions.length, `${language}: ${fixture.sessions.length} conversations were handed to the ingest and ${ingest.remembered} were remembered`);

		// The product's own entry parser, not a grep: a note the file renders but
		// the parser does not see is a note the room cannot read either.
		const doc = entries.parseMemoryDocument(fs.readFileSync(currentPath, "utf-8"));
		const notes = doc.topics.flatMap((topic) => topic.entries);
		assert(notes.length > 0, `${language}: ${fixture.sessions.length} folded conversations left no notes at all in L1b/current.md`);
		const withoutId = notes.filter((note) => !/^m-\d{4}/.test(note.id));
		assert(withoutId.length === 0, `${language}: ${withoutId.length} of the ${notes.length} notes in L1b/current.md carry no entry id: ${withoutId.map((note) => note.text.slice(0, 40)).join(" | ")}`);
		pass(`${language}: the ingest leaves ${notes.length} notes in L1b/current.md, every one of them with an entry id`);

		// The archive parser reports the reason; a row that says `budget` is a note
		// the room pushed out to stay inside its budget, which is the forgetting
		// the bench is about. Reading `why` off the parsed row rather than the file
		// keeps the check on the meaning instead of on the comment's spelling.
		const archive = store.readArchive(room.roomId);
		const byBudget = archive.filter((row) => row.why === "budget");
		assert(byBudget.length > 0, `${language}: the back history should push notes out on every fold, and none of the ${archive.length} archive rows reads why=budget (reasons seen: ${[...new Set(archive.map((row) => row.why))].join(", ") || "none"})`);
		pass(`${language}: ${byBudget.length} of the ${archive.length} rows in L1b/archive/entries.md read why=budget`);

		// --- 1b. The claim audit reads zero -------------------------------------
		// Every conversation the ingest memorized is in the room's search index,
		// under the conversation it was. The report carries the audit, taken once
		// after the last Memorize, and at this size nothing is left waiting, so
		// all of the conversations are memorized and both defect counts are zero.
		assert(ingest.claims, `${language}: the ingest report carries a claim audit, and this one carries ${JSON.stringify(ingest.claims)}`);
		assert(
			ingest.claims.memorized === fixture.sessions.length && ingest.claims.unindexed === 0 && ingest.claims.misassigned === 0,
			`${language}: ${fixture.sessions.length} conversations were memorized and every one is indexed under its own name, so the audit reads ${fixture.sessions.length} memorized, 0 unindexed, 0 misassigned, and it reads "${claimsLine(ingest.claims)}"`,
		);
		assert(claimsLine(ingest.claims) === `claims: ${fixture.sessions.length} memorized, 0 unindexed, 0 misassigned`, `${language}: the claims line reads "claims: N memorized, N unindexed, N misassigned", and it reads "${claimsLine(ingest.claims)}"`);
		assert(!claimsFailed(ingest.claims) && claimsFailed({ memorized: 3, unindexed: 1, misassigned: 0 }) && claimsFailed({ memorized: 3, unindexed: 0, misassigned: 1 }), `${language}: an audit fails on either defect count and on nothing else`);
		pass(`${language}: the ingest's claim audit reads "${claimsLine(ingest.claims)}"`);

		// --- 2. Locate tells core from archive, and gone from both ---------------
		// The plants go in with the markers, so locate may fall back on the words
		// of a planted line when the reference code is gone. Under a SCRIPTED
		// ingest the fold copies the planted sentence word for word, so the code
		// is still there and every marker must be found BY CODE — if one of these
		// reads `wording`, the scripted fold stopped being word for word and the
		// bench's control over its own material is gone.
		const plants = fixture.sessions.flatMap((session) => session.plants);
		const plantedMarkers = [...new Set(plants.map((plant) => plant.marker))];
		const detail = await locateEvidenceInDetail({ roomId: room.roomId, markers: plantedMarkers, plants });
		const located: Record<string, EvidenceLocation> = {};
		for (const [marker, row] of Object.entries(detail)) located[marker] = row.location;
		// One exception, planted on purpose: the second member of the duplicate
		// pair is the same sentence said again, the memory refuses its add as a
		// repeat, the scripted fold leaves it out, and so no note ever carries
		// its code. Its WORDS are in the first member's note, which is where the
		// locator finds it: by wording, in whatever place that note is.
		const duplicatePair = pairOf(fixture, "duplicate");
		assert(duplicatePair, `${language}: ${SESSIONS} sessions hold the duplicate pair whole, and the fixture holds it only in part`);
		const repeated = duplicatePair[1].marker;
		const notByCode = plantedMarkers.filter((marker) => marker !== repeated && detail[marker]?.how !== "code");
		assert(notByCode.length === 0, `${language}: a scripted fold copies the planted sentence word for word, so every marker is found by its reference code, and ${notByCode.length} were not: ${notByCode.map((marker) => `${marker}=${detail[marker]?.how ?? "not found"}`).join(", ")}`);
		assert(detail[repeated]?.how === "wording", `${language}: ${repeated} is the duplicate's second member, whose add the memory refuses as a repeat, so it is found by the words its twin's note carries, and the locator said how="${detail[repeated]?.how ?? "not found"}" in ${detail[repeated]?.location ?? "nowhere"}`);
		pass(`${language}: locate reports how="code" for ${plantedMarkers.length - 1} planted markers and how="wording" for ${repeated}, the repeat the fold left out`);
		const evidenceMarkers = [...new Set(fixture.questions.flatMap((question) => question.evidence.map((evidence) => evidence.marker)))];
		const evidencePlaces = evidenceMarkers.map((marker) => located[marker] ?? "gone");
		assert(evidencePlaces.includes("core"), `${language}: no evidence marker is still in the core; the fixture's newest facts should be (${evidenceMarkers.map((marker, at) => `${marker}=${evidencePlaces[at]}`).join(", ")})`);
		assert(evidencePlaces.includes("archive"), `${language}: no evidence marker is in the archive; a replaced fact should be (${evidenceMarkers.map((marker, at) => `${marker}=${evidencePlaces[at]}`).join(", ")})`);
		const vanished = plantedMarkers.filter((marker) => (located[marker] ?? "gone") === "gone");
		assert(vanished.length === 0, `${language}: ${vanished.length} planted marker(s) are in no part of the room's memory although nothing removed them: ${vanished.join(", ")}`);
		pass(`${language}: every one of the ${plantedMarkers.length} planted markers is somewhere in the room, with evidence in both the core and the archive`);

		// --- 3. Retrieval, on a note the budget really took ----------------------
		// The marker this section turns on is a PLANTED note the budget pushed out
		// of the core, not the one a later conversation replaced: forgetting by
		// budget is what the bench is about, and it is the only case where the
		// archived note's own words are the words its question's literal query is
		// made of. So the query here is the fixture's literal query and nothing
		// else — no falling back on the marker's reference code, which would only
		// ever prove that the archive can be searched for scaffolding. A question
		// resting on several sentences quotes every one of them, so its note may
		// be quoted by the hand-written part or by the sentence appended for it;
		// a question resting on one is taken first when this size holds one, and
		// the bar is as many results as the question has sentences.
		const reasons = await archivedReasons({ roomId: room.roomId, markers: plantedMarkers, plants });
		const questionOf = (marker: string) => fixture.questions.find((candidate) => candidate.evidence.some((evidence) => evidence.marker === marker));
		const lineOfMarker = (marker: string) => plants.find((plant) => plant.marker === marker)?.line ?? "";
		const quotesNote = (question: RecallQuestion, marker: string, noteText: string): boolean => {
			const hand = handWrittenQueries(fixture, question).literal;
			if (noteText.toLowerCase().includes(hand.toLowerCase())) return true;
			const wording = plantedWording(lineOfMarker(marker));
			return question.evidence.length >= 2 && question.queries.literal.includes(wording) && carriesWording(noteText, wording);
		};
		const archivedCandidates = evidenceMarkers.filter((marker) => {
			if ((located[marker] ?? "gone") !== "archive" || reasons[marker] !== "budget") return false;
			const question = questionOf(marker);
			const row = archive.find((entry) => entry.text.includes(marker));
			return Boolean(question && row && quotesNote(question, marker, row.text));
		});
		const archivedMarker = [...archivedCandidates].sort((a, b) => (questionOf(a)?.evidence.length ?? 0) - (questionOf(b)?.evidence.length ?? 0))[0];
		assert(
			archivedMarker,
			`${language}: this section needs a planted note the BUDGET archived whose own text carries its question's literal query, and none of ${evidenceMarkers.length} evidence marker(s) is one — ${evidenceMarkers.map((marker) => `${marker}=${located[marker] ?? "gone"}/${reasons[marker] ?? "-"}`).join(", ")}. Say so rather than falling back on the reference code: the fixture size or the fold interval has to change.`,
		);
		const archivedRow = archive.find((row) => row.text.includes(archivedMarker));
		assert(archivedRow, `${language}: ${archivedMarker} reads as archived and no archive row carries it`);
		const archivedQuestion = fixture.questions.find((question) => question.evidence.some((evidence) => evidence.marker === archivedMarker));
		assert(archivedQuestion, `${language}: no question cites ${archivedMarker} although it came out of the questions' own evidence`);
		const foundQuery = archivedQuestion.queries.literal;
		/** The bar: a question quoting N sentences has earned every one of them within the first N results. */
		const archivedBar = archivedQuestion.evidence.length;
		const hit = await retrieve({ roomId: room.roomId, query: foundQuery, marker: archivedMarker });
		assert(hit.rank !== null && hit.rank <= archivedBar, `${language}: the literal query "${foundQuery}" quotes the archived note's own words, so it must hand that note back within the ${archivedBar} sentence(s) it quotes, and ${archivedMarker} came back at rank ${hit.rank === null ? "none" : hit.rank} (outcome ${hit.outcome}, ${hit.returned} note(s) returned)`);
		pass(`${language}: ${archivedMarker}, a planted note the budget took, comes back at rank ${hit.rank} for its question's own literal query, which quotes ${archivedBar} sentence(s)`);

		// --- The rows the tables are built from, through the engine's own rule ----
		// `retrievalRanks` credits a question with the BEST rank its ARCHIVED
		// evidence reaches, and says `"n/a"` when none of its evidence is in the
		// archive at all. The smoke takes that verdict as given and checks it
		// against the marker rows the same call hands back, so the question's
		// number can never drift away from the markers it was made of.
		const rows: RecallResultRow[] = [];
		const ranksByQuestion = new Map<string, Awaited<ReturnType<typeof retrievalRanks>>>();
		for (const question of fixture.questions) {
			const found = await retrievalRanks({ roomId: room.roomId, question, locations: located });
			ranksByQuestion.set(question.id, found);
			const places: EvidenceLocation[] = question.evidence.map((evidence) => located[evidence.marker] ?? "gone");
			// The replaced value is NOT evidence — the question asks what holds now
			// — so it rides beside the row rather than inside its location, which
			// is the shape the bench's own table reads.
			const trapPlaces: EvidenceLocation[] = (question.trapEvidence ?? []).map((evidence) => located[evidence.marker] ?? "gone");
			rows.push({
				id: question.id,
				ability: question.ability,
				language,
				// A question the fixture planted no evidence for never had anything
				// to lose, which is not the same as having lost it.
				location: places.length === 0 ? "none" : worstLocation(places),
				...(trapPlaces.length === 0 ? {} : { trapLocation: worstLocation(trapPlaces) }),
				ranks: found.ranks,
				locatedBy: question.evidence.map((evidence) => detail[evidence.marker]?.how ?? null),
				answered: null,
				answerTokens: 0,
				recallCalls: 0,
				probeCalls: found.calls,
			});
		}

		// The replaced value of a knowledge-update question belongs in the
		// ARCHIVE. That is what makes the question a test at all: the room has to
		// answer with the value that replaced it while the old one is still
		// somewhere it can read. A supersede that left the old value in the CORE
		// did not take — the room would be one sentence away from a plausible
		// wrong answer — so the row's own trap column is read, and the archive's
		// reason beside it, because "archived" and "archived BY the supersede"
		// are not the same claim.
		const updateQuestion = fixture.questions.find((question) => question.ability === "knowledge-update");
		assert(updateQuestion, `${language}: the fixture holds no knowledge-update question`);
		const updateRow = rows.find((row) => row.id === updateQuestion.id);
		assert(updateRow, `${language}: no row was built for ${updateQuestion.id}`);
		const trapMarkers = (updateQuestion.trapEvidence ?? []).map((evidence) => evidence.marker);
		assert(trapMarkers.length > 0, `${language}: ${updateQuestion.id} is a knowledge-update question and names no trapEvidence, so nothing says where the value it replaced ended up`);
		assert(
			updateRow.trapLocation === "archive",
			`${language}: ${updateQuestion.id}'s replaced value should sit in the archive and its row reads "${updateRow.trapLocation ?? "nothing at all"}" (${trapMarkers.map((marker) => `${marker}=${located[marker] ?? "gone"}`).join(", ")})`,
		);
		assert(updateRow.location !== updateRow.trapLocation || updateRow.location === "archive", `${language}: ${updateQuestion.id}'s current value and the one it replaced cannot both be reported from "${updateRow.location}" unless that place is the archive`);
		const trapReasons = await archivedReasons({ roomId: room.roomId, markers: trapMarkers, plants });
		const notSuperseded = trapMarkers.filter((marker) => trapReasons[marker] !== "superseded");
		assert(
			notSuperseded.length === 0,
			`${language}: the value ${updateQuestion.id} replaced left the core because a later conversation replaced it, so the archive's reason is "superseded"; ${notSuperseded.map((marker) => `${marker}=${trapReasons[marker] ?? "not in the archive"}`).join(", ")}`,
		);
		pass(`${language}: ${updateQuestion.id}'s row reports trapLocation "archive" for ${trapMarkers.join(", ")}, and the archive's own reason for it is superseded`);

		// The same question again, through the engine's rank rule rather than a
		// single retrieve: its evidence is in the archive, so recall is what has
		// to answer for it.
		const archivedRanks = ranksByQuestion.get(archivedQuestion.id);
		assert(archivedRanks, `${language}: ${archivedQuestion.id} was not among the questions the ranks were taken for`);
		assert(archivedRanks.applicable, `${language}: ${archivedQuestion.id} has ${archivedMarker} in the archive, so its ranks apply, and the engine called them not applicable`);
		const archivedMarkerRow = archivedRanks.perMarker.find((row) => row.marker === archivedMarker);
		assert(archivedMarkerRow, `${language}: the ranks for ${archivedQuestion.id} carry no row for ${archivedMarker}`);
		assert(archivedMarkerRow.location === "archive", `${language}: the ranks put ${archivedMarker} in "${archivedMarkerRow.location}" and locate puts it in the archive`);
		assert(
			typeof archivedMarkerRow.ranks.literal === "number" && archivedMarkerRow.ranks.literal <= archivedBar,
			`${language}: the literal query "${archivedQuestion.queries.literal}" quotes the archived note's own words, so ${archivedMarker} comes back within the ${archivedBar} sentence(s) ${archivedQuestion.id} quotes, and the engine reported ${String(archivedMarkerRow.ranks.literal)}`,
		);
		const bestRetrieved = Math.min(...archivedRanks.perMarker.filter((row) => row.location === "archive" || row.location === "conversation").map((row) => row.ranks.literal).filter((rank): rank is number => rank !== null));
		assert(
			archivedRanks.ranks.literal === bestRetrieved,
			`${language}: the question's literal rank is the best its archived markers reach, and the question reads ${String(archivedRanks.ranks.literal)} against the markers' best ${bestRetrieved}`,
		);
		pass(`${language}: ${archivedQuestion.id}'s literal query reports rank ${String(archivedMarkerRow.ranks.literal)} for the archived ${archivedMarker}, within the ${archivedBar} sentence(s) it quotes and with no reference code anywhere in the query`);

		// The assertion that was INVERTED rather than deleted. On 0.12.1
		// `memory_recall` was a case-insensitive substring search over the
		// archive, so a query that said the same thing in other words found
		// nothing and this line asserted the null. Under the ranked search the
		// paraphrase lands, which is the whole point of that work, so the line now
		// asserts the landing — and still asserts that a miss would be a miss and
		// never "not applicable", because that distinction is what the table is
		// read with.
		// The two are asserted in this order because the second is the stronger
		// claim: a rank that is not "n/a" was a question recall was asked, and a
		// rank that is a number is one it answered.
		const paraphraseRank = archivedRanks.ranks.paraphrase;
		assert(paraphraseRank !== RANK_NOT_APPLICABLE, `${language}: a paraphrase that found nothing is a miss and must not be filed as "not applicable"`);
		assert(
			typeof paraphraseRank === "number",
			`${language}: the paraphrase "${archivedQuestion.queries.paraphrase}" asks for ${archivedMarker} in other words, which a ranked search reaches, and it came back as ${String(paraphraseRank)}`,
		);
		pass(`${language}: ${archivedQuestion.id}'s paraphrase query reaches ${archivedMarker} at rank ${String(paraphraseRank)} — words, not a substring`);

		// The abstention question: nothing was ever planted for it, so recall was
		// never asked anything and there is no miss to report. Its three ranks are
		// "n/a" and its bucket is `none`, rendered "no evidence" — a question with
		// nothing to find must never swell the column that means "forgotten".
		const abstention = fixture.questions.find((question) => question.ability === "abstention");
		assert(abstention, `${language}: the fixture holds no abstention question`);
		assert(abstention.evidence.length === 0, `${language}: the abstention question should plant no evidence and cites ${abstention.evidence.length}`);
		const abstentionRanks = ranksByQuestion.get(abstention.id);
		assert(abstentionRanks, `${language}: ${abstention.id} was not among the questions the ranks were taken for`);
		assert(!abstentionRanks.applicable, `${language}: ${abstention.id} has no evidence in the archive and the engine called its ranks applicable`);
		for (const kind of QUERY_KINDS) {
			assert(abstentionRanks.ranks[kind] === RANK_NOT_APPLICABLE, `${language}: ${abstention.id} asked recall for nothing, so its ${kind} rank is "${RANK_NOT_APPLICABLE}" and it reads ${String(abstentionRanks.ranks[kind])}`);
		}
		const abstentionRow = rows.find((row) => row.id === abstention.id);
		assert(abstentionRow, `${language}: no row was built for ${abstention.id}`);
		assert(abstentionRow.location === "none", `${language}: ${abstention.id} planted no evidence, so its bucket is "none" and it reads "${abstentionRow.location}"`);
		assert(locationLabel("none") === "no evidence", `the "none" bucket is written "no evidence" in a table and reads "${locationLabel("none")}"`);
		pass(`${language}: ${abstention.id} reports "${RANK_NOT_APPLICABLE}" for all three query kinds and sits in the "none" bucket, rendered "${locationLabel("none")}"`);

		// --- 3c. The fact the room was TOLD and never wrote down -----------------
		// A `noted: false` plant stands in a conversation, marker and all, and in
		// no Recent Context entry — so no fold ever made a note of it and no note
		// anywhere carries it. The conversation was folded, though, which is what
		// makes it searchable, so the marker must read `conversation`: a place of
		// its own, and not `gone`. Reading it as gone would be the bench saying
		// the room lost something it can still read back.
		const heardOnly = plants.filter((plant) => plant.noted === false);
		assert(heardOnly.length > 0, `${language}: the fixture plants nothing that was said and never noted, so there is no conversation-only evidence to check`);
		const misplaced = heardOnly.filter((plant) => located[plant.marker] !== "conversation");
		assert(
			misplaced.length === 0,
			`${language}: a fact the room was told and never wrote down lives in the conversation it was said in, and ${misplaced.length} read otherwise: ${misplaced.map((plant) => `${plant.marker}=${located[plant.marker] ?? "gone"}`).join(", ")}`,
		);
		for (const plant of heardOnly) {
			assert(detail[plant.marker]?.how === "code", `${language}: ${plant.marker} is in a transcript, which keeps the sentence word for word, so it is found by its code and it read "${detail[plant.marker]?.how ?? "not found"}"`);
		}
		pass(`${language}: all ${heardOnly.length} facts that were said and never written down read "${locationLabel("conversation")}", found by the code their transcript kept`);

		// And the room can REACH one: the question that asks for it, with its own
		// literal words, through the room's own recall. This is the check that is
		// red on a recall that reads the archive alone — there is nothing there to
		// find — and green on one that reads the conversations too.
		const heardQuestion = fixture.questions.find((question) => question.evidence.some((evidence) => heardOnly.some((plant) => plant.marker === evidence.marker)));
		assert(heardQuestion, `${language}: no question asks for any of ${heardOnly.map((plant) => plant.marker).join(", ")}, so nothing measures the conversation the room kept`);
		const heardMarker = heardQuestion.evidence.find((evidence) => heardOnly.some((plant) => plant.marker === evidence.marker))!.marker;
		const heardRanks = ranksByQuestion.get(heardQuestion.id);
		assert(heardRanks, `${language}: ${heardQuestion.id} was not among the questions the ranks were taken for`);
		assert(
			heardRanks.applicable,
			`${language}: ${heardQuestion.id} rests on ${heardMarker}, which only a search can reach, so recall has to answer for it and the engine called its ranks not applicable`,
		);
		const heardRow = heardRanks.perMarker.find((row) => row.marker === heardMarker);
		assert(heardRow, `${language}: the ranks for ${heardQuestion.id} carry no row for ${heardMarker}`);
		assert(heardRow.location === "conversation", `${language}: the ranks put ${heardMarker} in "${heardRow.location}" and locate puts it in the conversation it was said in`);
		assert(
			typeof heardRow.ranks.literal === "number",
			`${language}: the literal query "${heardQuestion.queries.literal}" is the transcript's own words, so a recall that reads the room's conversations hands ${heardMarker} back, and it came back as ${String(heardRow.ranks.literal)} — null here is a recall that reads the archive alone`,
		);
		assert(
			typeof heardRanks.ranks.literal === "number",
			`${language}: ${heardQuestion.id}'s own literal rank is the best its searchable evidence reaches, and it reads ${String(heardRanks.ranks.literal)} against ${heardMarker}'s ${String(heardRow.ranks.literal)}`,
		);
		pass(`${language}: ${heardQuestion.id} reaches ${heardMarker} at rank ${String(heardRow.ranks.literal)} in the conversation the room kept, with no note of it anywhere`);

		// The forgetting table counts it in a column of its own. A question whose
		// evidence is only in a conversation is neither forgotten nor in front of
		// the room, and a table that folded it into either would say something
		// untrue about both.
		const heardTable = forgettingTable(rows);
		const heardCell = heardTable.byLocation("conversation");
		const heardRowInTable = rows.find((row) => row.id === heardQuestion.id);
		assert(heardRowInTable, `${language}: no row was built for ${heardQuestion.id}`);
		assert(heardRowInTable.location === "conversation", `${language}: ${heardQuestion.id}'s hardest piece of evidence is in a conversation and its row reads "${heardRowInTable.location}"`);
		assert(heardCell.count > 0, `${language}: the forgetting table's conversation column counts ${heardCell.count} questions and ${heardQuestion.id} belongs in it`);
		assert(heardTable.locations.includes("conversation"), `${language}: the forgetting table's columns are always all of them, and "conversation" is not among ${heardTable.locations.join(", ")}`);
		pass(`${language}: the forgetting table counts ${heardCell.count} question(s) in its conversation column, ${heardQuestion.id} among them`);

		// The size story. The summary is the bench's own, and it is checked against
		// the numbers this smoke read off the files itself: a room's sizes that
		// disagree with its own files are a bench reporting something else.
		const summary = await buildRunSummary({ roomId: room.roomId, language, seed: fixture.seed, sessions: fixture.sessions.length, rows, backHistoryNotes: room.backHistoryNotes, markers: plantedMarkers, locations: located });
		assert(summary.notesInCore === notes.length, `${language}: the run summary counts ${summary.notesInCore} notes in the core and the file holds ${notes.length}`);
		assert(summary.archiveRows === archive.length, `${language}: the run summary counts ${summary.archiveRows} archive rows and the file holds ${archive.length}`);
		assert(summary.archivedByBudget === byBudget.length, `${language}: the run summary counts ${summary.archivedByBudget} rows archived by budget and the file holds ${byBudget.length}`);
		assert(summary.memoryTokens === entries.reviewTargetTokens(doc), `${language}: the run summary reports ${summary.memoryTokens} memory tokens and the core renders to ${entries.reviewTargetTokens(doc)}`);
		assert(summary.memoryBudgetTokens === room.memoryBudgetTokens, `${language}: the run summary reports a budget of ${summary.memoryBudgetTokens} tokens and the room was given ${room.memoryBudgetTokens}`);
		runs.push({ language, rows, summary });

		// --- 2b. A row taken out of the file by hand, and what gone really means --
		// The one thing locate must never do is call a note gone while the room can
		// still read it. The row is removed from the archive by hand and the core
		// never carried it — and the marker STILL is not gone, because the
		// conversation it was said in was folded and is searchable, which is
		// exactly the distinction the conversation place exists to draw. Gone is
		// then checked where it is true and nowhere else: a code no part of this
		// room ever carried.
		const currentText = fs.readFileSync(currentPath, "utf-8");
		assert(!currentText.includes(archivedMarker), `${language}: ${archivedMarker} reads as archived and L1b/current.md carries it too, so removing the archive row would prove nothing`);
		const archiveText = fs.readFileSync(archivePath, "utf-8");
		const blocks = archiveText.split("\n\n");
		const kept = blocks.filter((block) => !block.includes(archivedMarker));
		assert(kept.length === blocks.length - 1, `${language}: removing the archive row of ${archivedMarker} should drop exactly one block of entries.md, and ${blocks.length - kept.length} were dropped`);
		fs.writeFileSync(archivePath, kept.join("\n\n"));
		const archiveAfter = store.readArchive(room.roomId);
		assert(archiveAfter.every((row) => !row.text.includes(archivedMarker)), `${language}: the archive still holds a row carrying ${archivedMarker} after it was removed from entries.md`);
		const locatedAfter = await locateEvidence({ roomId: room.roomId, markers: [archivedMarker] });
		assert(
			locatedAfter[archivedMarker] === "conversation",
			`${language}: with its archive row taken out by hand, ${archivedMarker} is in no note of this room and the conversation that said it was folded, so it reads "conversation" and it read "${locatedAfter[archivedMarker]}"`,
		);
		// The same room, a code nothing in it ever carried: no note, no archived
		// row, no transcript. That is the only honest "gone" there is, and a
		// search for it comes back saying so.
		const neverSaid = "REC-ZZ99";
		const locatedNever = await locateEvidence({ roomId: room.roomId, markers: [neverSaid] });
		assert(locatedNever[neverSaid] === "gone", `${language}: ${neverSaid} was never said in this room at all and locate reads it as "${locatedNever[neverSaid]}"`);
		const missed = await retrieve({ roomId: room.roomId, query: neverSaid, marker: neverSaid });
		assert(missed.rank === null, `${language}: a search for "${neverSaid}" returned something carrying it at rank ${missed.rank}, and nothing in this room ever said it`);
		pass(`${language}: the archive row of ${archivedMarker} taken out by hand leaves it readable in its conversation, and a code nothing ever said reads gone and retrieves nothing`);
	}

	// --- 4. The scorer cannot lie ------------------------------------------------
	// Against the fixture's real questions, because the scorer's job is to score
	// those — and one synthetic question for the date shapes, so the three
	// spellings of one day can be asked of one answer key.
	const questionOf = (language: RecallLanguage, ability: RecallQuestion["ability"]): RecallQuestion => {
		const fixture = fixtures.get(language);
		assert(fixture, `the ${language} fixture was not built`);
		const found = fixture.questions.find((question) => question.ability === ability);
		assert(found, `the ${language} fixture holds no ${ability} question`);
		return found;
	};
	const scored = (question: RecallQuestion, answer: string, want: boolean, label: string, known?: readonly string[]): void => {
		const result = scoreAnswer({ question, answer, ...(known === undefined ? {} : { known }) });
		assert(result.correct === want, `the scorer called ${label} ${result.correct ? "right" : "wrong"} and it is ${want ? "right" : "wrong"} (${result.why})`);
	};

	const extraction = questionOf("en", "extraction");
	scored(extraction, extraction.gold[0], true, `an answer that is exactly the first accepted value ("${extraction.gold[0]}")`);
	pass(`the scorer calls an answer that is the accepted value itself right`);

	const update = questionOf("en", "knowledge-update");
	const trapValue = (update.trap ?? [])[0];
	assert(trapValue, "the knowledge-update question plants no replaced value, so the trap cannot be scored");
	scored(update, `The audit window covers ${trapValue} of meter reads.`, false, "an answer carrying only the replaced value");
	scored(update, `It covers ${update.gold[0]} now, up from the earlier ${trapValue}.`, true, "an answer carrying the current value beside the replaced one");
	pass(`the scorer calls the replaced value alone wrong and the current value beside it right`);

	const abstentionEn = questionOf("en", "abstention");
	const abstentionDe = questionOf("de", "abstention");
	scored(abstentionEn, "I don't know, it was never mentioned.", true, "an English not-known to a question with no answer");
	scored(abstentionDe, "Das weiß ich nicht.", true, "a German not-known to a question with no answer");
	scored(abstentionEn, "It is 4471-8890.", false, "an invented specific where nothing was ever planted");
	scored(extraction, "I don't know.", false, "a not-known to a question the room's memory can answer");
	pass(`the scorer calls a not-known right only where there is nothing to know, and an invented specific always wrong`);

	// One day, three spellings, one answer key: the normalisation is what lets a
	// room answer in its own words without the bench calling it wrong.
	const dateQuestion: RecallQuestion = {
		id: "smoke-date",
		ability: "extraction",
		language: "en",
		question: "On which day does it start?",
		gold: ["2026-06-01"],
		evidence: [],
		queries: { literal: "", paraphrase: "", variant: "" },
		askDate: "2026-06-10",
	};
	for (const spelling of ["1.6.2026", "1 June 2026", "2026-06-01"]) {
		scored(dateQuestion, `It starts on ${spelling}.`, true, `the date written "${spelling}"`);
	}
	const portValue = extraction.gold[0];
	assert(/^\d{4}$/.test(portValue), `the separator check needs a four-digit accepted value and the extraction question's first one is "${portValue}"`);
	const separated = `${portValue.slice(0, 1)},${portValue.slice(1)}`;
	scored(extraction, `The export runs on port ${separated}.`, true, `a number written with a thousands separator ("${separated}")`);
	scored(extraction, `The export runs on port ${portValue}.`, true, `the same number written without one ("${portValue}")`);
	pass(`the scorer reads three spellings of one date and both spellings of one number as the same value`);

	// --- 4b. The answers a containment scorer gets wrong --------------------------
	// Everything above is a scorer agreeing with itself. This block is the set of
	// answers a naive containment test scores BACKWARDS, and every case here was
	// red on the bench as committed — a right answer called wrong, or a wrong one
	// called right. They are written against the full fixture's own questions,
	// not against invented ones, because the numbers these produce are the
	// numbers the bench reports.
	//
	// The full fixture is built for this block alone: the questions that carry
	// the interesting answer keys — a bare number, a duration, an amount, an
	// order — only exist at full size. Building it here also means a fixture
	// whose own self-checks are broken fails this smoke, which is right: a bench
	// cannot report a number off a fixture that does not hold together.
	const fullEn = buildRecallFixture({ language: "en" });
	const fullDe = buildRecallFixture({ language: "de" });
	const byId = (id: string): RecallQuestion => {
		const found = [...fullEn.questions, ...fullDe.questions].find((question) => question.id === id);
		assert(found, `the full fixture holds no ${id}; if the ids moved, find the question with the same answer key rather than dropping the case`);
		return found;
	};
	/** Values the room genuinely holds: every accepted answer of every question that has one. */
	const knownValues = [...fullEn.questions, ...fullDe.questions].flatMap((question) => question.gold);

	// --- 5a. A question resting on two sentences quotes both --------------------
	// The demotion ranking can leave one of a temporal question's two sentences
	// in the core and put the other in the archive, and a literal that quotes
	// only the first can never reach the second. So the literal and the variant
	// of a question resting on several sentences carry the words of EVERY one
	// of them — carrying as the engine's own wording rule reads it, which is
	// how the locator finds a note — while a question resting on one keeps its
	// hand-written queries byte for byte.
	for (const fixture of [fullEn, fullDe]) {
		const language = fixture.language;
		const lineOf = (entry: { sessionId: string; marker: string }) => fixture.sessions.find((session) => session.id === entry.sessionId)!.plants.find((plant) => plant.marker === entry.marker)!.line;
		const temporal = fixture.questions.filter((question) => question.ability === "temporal");
		assert(temporal.length > 0, `${language}: the full fixture asks no temporal question`);
		for (const question of temporal) {
			assert(question.evidence.length === 2, `${language}: ${question.id} is a temporal question resting on ${question.evidence.length} sentence(s); it rests on two`);
			const hand = handWrittenQueries(fixture, question);
			const [first, second] = question.evidence.map(lineOf);
			assert(!/REC-[A-Z]+\d+/.test(`${question.queries.literal} ${question.queries.variant}`), `${language}: ${question.id} quotes a reference code, which is the bench's scaffolding and not the room's words: "${question.queries.literal}"`);
			assert(hand.literal.trim() !== "" && first.toLowerCase().includes(hand.literal.toLowerCase()), `${language}: the hand-written literal of ${question.id}, "${hand.literal}", is not inside the sentence of ${question.evidence[0].marker}`);
			assert(carriesWording(first, hand.literal), `${language}: the sentence of ${question.evidence[0].marker} does not carry the words of ${question.id}'s literal "${hand.literal}"`);
			assert(carriesWording(question.queries.literal, plantedWording(second)), `${language}: the literal of ${question.id} does not carry the words of its second sentence (${question.evidence[1].marker}): "${question.queries.literal}"`);
			assert(carriesWording(question.queries.variant, variantWording(language, plantedWording(second))), `${language}: the variant of ${question.id} does not carry the respelled words of its second sentence (${question.evidence[1].marker}): "${question.queries.variant}"`);
			assert(hand.variant !== hand.literal && question.queries.variant !== question.queries.literal, `${language}: the variant of ${question.id} respells nothing: "${question.queries.variant}"`);
		}
		pass(`${language}: the literal and the variant of all ${temporal.length} temporal questions carry the words of both sentences they rest on, and no reference code`);
		const single = fixture.questions.filter((question) => question.evidence.length === 1);
		for (const question of single) {
			const hand = handWrittenQueries(fixture, question);
			assert(hand.literal === question.queries.literal && hand.variant === question.queries.variant, `${language}: ${question.id} rests on one sentence and its queries carry something appended: "${question.queries.literal}"`);
			assert(lineOf(question.evidence[0]).toLowerCase().includes(question.queries.literal.toLowerCase()), `${language}: the literal of ${question.id}, "${question.queries.literal}", is not inside the sentence of ${question.evidence[0].marker}`);
		}
		pass(`${language}: all ${single.length} questions resting on one sentence quote it with their hand-written literal and nothing appended`);
	}
	// The hand-written queries of the first question of each language, byte for
	// byte: the one place a rewrite of the query rule would show first.
	assert(byId("Q-en-01").queries.literal === "export runs on port 8443" && byId("Q-en-01").queries.variant === "export runs on port 8,443", `Q-en-01's queries moved: ${JSON.stringify(byId("Q-en-01").queries)}`);
	assert(byId("Q-de-01").queries.literal === "Der Prüfexport läuft über Port 9443" && byId("Q-de-01").queries.variant === "Der Pruefexport laeuft ueber Port 9443", `Q-de-01's queries moved: ${JSON.stringify(byId("Q-de-01").queries)}`);
	pass(`Q-en-01 and Q-de-01 keep their hand-written literal and variant byte for byte`);

	// A gold value found INSIDE a longer value is not that value. "119" is not
	// "19", "15 hours" is not "5 hours", and the digits of a gold number sitting
	// inside a date are not an answer either — that last one is the one a
	// knowledge-update question turns on, because the answer names the replaced
	// value and only appears to name the current one.
	const dormant = byId("Q-en-36");
	const stale = byId("Q-en-40");
	scored(dormant, "The review found 119 dormant accounts.", false, `a gold value of "${dormant.gold[0]}" found only inside the longer number 119`);
	scored(stale, "The portal was stale for 15 hours.", false, `a gold value of "${stale.gold[0]}" found only inside "15 hours"`);
	scored(dormant, "They found 12 dormant accounts on 2026-05-19.", false, `the replaced value "${(dormant.trap ?? [])[0]}" with the current value's digits only inside a date`);
	pass(`the scorer refuses a gold value that occurs only inside a longer number, a longer duration or a date`);

	// A room answers in its own words, and the words it chooses are still the
	// value. A number word above twelve, a date written day-first with an
	// ordinal, and the three ways an amount is written are all the same answer.
	const netTerms = byId("Q-en-02");
	const cutover = byId("Q-en-03");
	const contractCeiling = byId("Q-en-32");
	scored(netTerms, "They are paid thirty days net.", true, `"${netTerms.gold[0]}" written as a number word above twelve`);
	scored(cutover, "It runs on 11th July 2026.", true, `"${cutover.gold[0]}" written day-first with an ordinal`);
	scored(contractCeiling, "The ceiling is 55k EUR.", true, `"${contractCeiling.gold[0]}" abbreviated with k`);
	scored(contractCeiling, "The ceiling is €55,000.", true, `"${contractCeiling.gold[0]}" with the currency in front`);
	scored(contractCeiling, "The ceiling is 55.000 €.", true, `"${contractCeiling.gold[0]}" with the German thousands separator`);
	const oneDay: RecallQuestion = { ...byId("Q-de-02"), id: "smoke-de-one-day", gold: ["1 Tag"] };
	scored(oneDay, "Es dauerte einen Tag.", true, `"1 Tag" written as the German number word`);
	pass(`the scorer reads a number word above twelve, a day-first ordinal date and three spellings of one amount as the values they are`);

	// An abstention is only right when the room invents NOTHING. A guess dressed
	// as a not-known is an invention; a fact the room really holds is not, even
	// though it carries digits. The second is what `known` is for — without it,
	// the most careful abstention there is, the one that says what it DOES have,
	// scores worse than a bare "I don't know".
	const absFull = fullEn.questions.find((question) => question.ability === "abstention");
	assert(absFull, "the full English fixture holds no abstention question");
	// The trap is named here rather than taken from the question, so the case
	// turns on the named value alone and not on whichever pattern that question
	// happens to carry.
	const guessing: RecallQuestion = { ...absFull, id: "smoke-en-guess", trap: ["Radisson"], trapPattern: undefined };
	scored(guessing, "I don't know for certain, but I believe it was the Radisson.", false, `an abstention that guesses "Radisson" anyway`);
	scored(
		absFull,
		"I don't know the address; the contract renews on 2026-11-30 but no office was ever given.",
		true,
		"an abstention that cites a date the room really holds",
		knownValues,
	);
	pass(`the scorer calls a dressed-up guess wrong and an abstention that cites a fact the room holds right`);

	// The ways a room says it does not know, in both languages. None of these
	// names a value; a scorer that missed any of them would count a correct
	// abstention as a refusal to answer.
	for (const [answer, language] of [
		["I'm not sure, that was never mentioned.", "en"],
		["I don't have that information.", "en"],
		["Keine Ahnung.", "de"],
		["Das wurde nie besprochen.", "de"],
	] as const) {
		scored(questionOf(language, "abstention"), answer, true, `the not-known "${answer}"`);
	}
	pass(`the scorer reads all four of the plainer not-knowns, in both languages, as abstentions`);

	// An order question is answered by CHOOSING, and an answer that names both
	// options has not chosen by naming one of them first: a preamble that lists
	// the two, and a negation that rules the wrong one out before naming the
	// right one, both order the words against the answer's actual meaning.
	const order = byId("Q-en-22");
	const rightOption = order.gold[0];
	const wrongOption = (order.distractor ?? [])[0];
	assert(wrongOption, `${order.id} is an order question and carries no other option to be confused with`);
	scored(order, `Between ${rightOption} and ${wrongOption}, ${wrongOption} was settled first.`, false, "an order answer that lists both and then chooses the other one");
	scored(order, `Not ${wrongOption}: ${rightOption} came first.`, true, "an order answer that rules the other one out before naming the right one");
	scored(order, rightOption, true, "an order answer that names the right option alone");
	pass(`the scorer reads an order question by what the answer chooses, not by which option it mentions first`);

	// --- LongMemEval adapter (added with the adapter) ---
	//
	// Two halves, and a LongMemEval number is only comparable if both hold: the
	// data has to become a room in the order it was actually said, and the
	// scoring has to be upstream's — its prompts character for character, its
	// verdict, and a hypothesis file of the fields its own script reads. Neither
	// half needs the benchmark's data to be on the machine: the instance below
	// is written by hand, and the pool the sample is drawn from with it.

	// The DATE, in the shape the haystack is dated in. The weekday is decoration
	// and a session with no time at all still has a day.
	assert(JSON.stringify(parseLongMemEvalDate("2023/04/10 (Mon) 23:07")) === JSON.stringify({ date: "2023-04-10", time: "23:07" }), `"2023/04/10 (Mon) 23:07" is the 10th of April at 23:07, and it read ${JSON.stringify(parseLongMemEvalDate("2023/04/10 (Mon) 23:07"))}`);
	assert(JSON.stringify(parseLongMemEvalDate("2023/04/12 (Wed) 08:30")) === JSON.stringify({ date: "2023-04-12", time: "08:30" }), `"2023/04/12 (Wed) 08:30" read ${JSON.stringify(parseLongMemEvalDate("2023/04/12 (Wed) 08:30"))}`);
	assert(JSON.stringify(parseLongMemEvalDate("2023/06/02 (Fri)")) === JSON.stringify({ date: "2023-06-02", time: "00:00" }), `a date with no time is still that day, at 00:00, and it read ${JSON.stringify(parseLongMemEvalDate("2023/06/02 (Fri)"))}`);
	pass(`a LongMemEval date becomes the day a session is dated in and the time that orders two sessions of one day`);

	// One instance, written by hand and deliberately OUT OF ORDER in the file,
	// with two of its three sessions on the same day. A room is built in the
	// order things were said — the fold's dating, the budget's demotion ranking
	// and every temporal question depend on it — so the file's order must not
	// survive the mapping, and the time is what separates the two sittings the
	// date cannot.
	const instance: LongMemEvalInstance = {
		question_id: "smoke_lme_001",
		question_type: "multi-session",
		question: "Which port does the export run on?",
		answer: "8443",
		question_date: "2023/06/02 (Fri) 09:15",
		haystack_session_ids: ["s-c", "s-a", "s-b"],
		haystack_dates: ["2023/04/12 (Wed) 08:30", "2023/04/10 (Mon) 23:07", "2023/04/12 (Wed) 19:45"],
		haystack_sessions: [
			[{ role: "user", content: "Third in the file, second in time." }, { role: "assistant", content: "Noted." }],
			[{ role: "user", content: "First in time, second in the file." }, { role: "assistant", content: "Noted." }],
			[{ role: "user", content: "Same day as s-c, later in the evening." }, { role: "assistant", content: "Noted." }],
		],
	};
	const mapped = mapInstance(instance);
	assert(mapped.sessions.length === 3, `the instance carries three sessions and the mapping produced ${mapped.sessions.length}`);
	assert(
		JSON.stringify(mapped.sessions.map((session) => [session.id, session.date])) === JSON.stringify([["S1", "2023-04-10"], ["S2", "2023-04-12"], ["S3", "2023-04-12"]]),
		`the sessions are numbered in the order they were said, with ISO dates, and they came back as ${JSON.stringify(mapped.sessions.map((session) => [session.id, session.date]))}`,
	);
	assert(mapped.sessions[1].title.includes("s-c") && mapped.sessions[2].title.includes("s-b"), `two sessions of one day are ordered by their time, so 08:30 (s-c) comes before 19:45 (s-b), and they read "${mapped.sessions[1].title}" then "${mapped.sessions[2].title}"`);
	assert(mapped.sessions[0].turns.every((turn) => (turn.role === "user" || turn.role === "assistant") && typeof turn.text === "string"), `a mapped turn is {role, text} with the role folded to user or assistant, and the first session's turns read ${JSON.stringify(mapped.sessions[0].turns)}`);
	assert(mapped.sessions[0].turns[0].text === "First in time, second in the file.", `the first session in time is the one the file put second, and its first turn reads "${mapped.sessions[0].turns[0].text}"`);
	assert(mapped.askDate === "2023-06-02", `the question's own date is the day the room is asked on, and it read "${mapped.askDate}"`);
	assert(mapped.sessions.every((session) => session.plants.length === 0), `nothing in the adapter may plant a marker, and a mapped session carried ${mapped.sessions.flatMap((session) => session.plants).length}`);
	assert(benchQuestion(mapped).gold[0] === instance.answer && benchQuestion(mapped).askDate === "2023-06-02", `the bench question carries the instance's own answer and ask date, and it reads ${JSON.stringify(benchQuestion(mapped).gold)} on ${benchQuestion(mapped).askDate}`);
	pass(`a LongMemEval instance maps to three sessions in the order they were said, ISO dated, with {role, text} turns and no planted markers`);

	// The sample. A flat draw would take the types in whatever proportion the
	// benchmark happens to hold, and a small sample would then say nothing about
	// the types it missed — so the same seed must give the same instances, and a
	// sample the size of the type count must reach every type.
	const pool: LongMemEvalInstance[] = ["multi-session", "multi-session", "multi-session", "temporal-reasoning", "knowledge-update", "single-session-user"].map((type, at) => ({
		...instance,
		question_id: `pool_${String(at + 1).padStart(2, "0")}_${type}`,
		question_type: type,
	}));
	const types = [...new Set(pool.map((entry) => entry.question_type))];
	const firstDraw = stratifiedSample(pool, types.length, 41);
	const sameSeed = stratifiedSample(pool, types.length, 41);
	assert(
		JSON.stringify(firstDraw.map((entry) => entry.question_id)) === JSON.stringify(sameSeed.map((entry) => entry.question_id)),
		`one seed is one sample, and two draws of seed 41 gave ${JSON.stringify(firstDraw.map((entry) => entry.question_id))} and ${JSON.stringify(sameSeed.map((entry) => entry.question_id))}`,
	);
	assert(firstDraw.length === types.length, `a sample of ${types.length} from a pool of ${pool.length} returns ${types.length} instances, and it returned ${firstDraw.length}`);
	const drawnTypes = [...new Set(firstDraw.map((entry) => entry.question_type))].sort();
	assert(
		JSON.stringify(drawnTypes) === JSON.stringify([...types].sort()),
		`a sample the size of the type count reaches every type present, and it reached ${JSON.stringify(drawnTypes)} of ${JSON.stringify([...types].sort())} — the three multi-session instances must not crowd the others out`,
	);
	pass(`the stratified sample is the same for one seed and reaches all ${types.length} types present rather than the commonest one`);

	// The verdict, upstream's whole rule: the reply, lowercased, contains "yes".
	assert(judgeLabel("Yes.") === true, `a judge that replies "Yes." has said the response is right, and the label read false`);
	assert(judgeLabel("No, the response does not contain the correct answer.") === false, `a judge that replies "No, …" has said the response is wrong, and the label read true`);
	assert(judgeLabel("  YES  ") === true, `the reply is trimmed and case-folded before the test, and "  YES  " read false`);
	pass(`the judge's verdict is read the way upstream reads it: "yes" anywhere in the reply, trimmed and case-folded`);

	// The prompt, hole for hole. The expected string is built by SPLITTING the
	// template on its holes and putting the three values between the pieces —
	// a different construction from the adapter's own left-to-right scan, so the
	// two agreeing means the holes really are filled in upstream's order. The
	// hypothesis carries a `{}` of its own on purpose: a hypothesis is never
	// rescanned for holes, and a judge has to be shown what the room actually
	// said.
	const judgeType = "knowledge-update";
	const judgeQuestion = "What is the ceiling on the export vendor's contract?";
	const judgeAnswer = "55,000 EUR";
	const judgeHypothesis = "The ceiling is 55,000 EUR {} after the revision.";
	const templateParts = LONGMEMEVAL_JUDGE_TEMPLATES[judgeType].split("{}");
	assert(templateParts.length === 4, `the ${judgeType} template takes three values, and it has ${templateParts.length - 1} hole(s)`);
	const expectedPrompt = templateParts[0] + judgeQuestion + templateParts[1] + judgeAnswer + templateParts[2] + judgeHypothesis + templateParts[3];
	const builtPrompt = judgePrompt({ questionType: judgeType, question: judgeQuestion, answer: judgeAnswer, hypothesis: judgeHypothesis });
	assert(builtPrompt === expectedPrompt, `the ${judgeType} judge prompt is the upstream template with question, answer and response in that order, and it came back as:\n${builtPrompt}`);
	assert(builtPrompt.includes(judgeHypothesis), `the hypothesis reaches the judge unaltered, braces and all, and it did not: ${builtPrompt.slice(-200)}`);
	pass(`the ${judgeType} judge prompt is the upstream template with its three holes filled in order, and a hypothesis carrying braces is never rescanned`);

	// The hypothesis file: one JSON object per line, and upstream's own script
	// reads two fields off it with a `json.loads` per line. A third key would
	// make a file only our own tools can score, and a newline of the line's own
	// would put a blank line into a file something else counts.
	const line = hypothesisLine({ questionId: mapped.questionId, hypothesis: "The export runs on port 8443." });
	const parsedLine = JSON.parse(line) as Record<string, unknown>;
	assert(
		JSON.stringify(Object.keys(parsedLine)) === JSON.stringify(["question_id", "hypothesis"]),
		`a hypothesis line carries exactly question_id and hypothesis, in that order, and this one carries ${JSON.stringify(Object.keys(parsedLine))}`,
	);
	assert(parsedLine.question_id === mapped.questionId, `the line names the instance it answers, and it named ${JSON.stringify(parsedLine.question_id)}`);
	assert(!line.includes("\n"), `the newline belongs to whoever joins the lines, and this line carries one of its own: ${JSON.stringify(line)}`);
	pass(`a hypothesis line is one JSON object of exactly {question_id, hypothesis}, which is what the upstream judge reads`);

	// --- 6. The forgetting-aware table counts every question exactly once --------
	const allRows = runs.flatMap((run) => run.rows);
	for (const run of runs) {
		const fixture = fixtures.get(run.language);
		assert(fixture, `the ${run.language} fixture was not built`);
		const table = forgettingTable(run.rows);
		const byLocation = table.locations.reduce((total, location) => total + table.byLocation(location).count, 0);
		const byAbility = table.abilities.reduce((total, ability) => total + table.byAbility(ability).count, 0);
		const cells = table.abilities.reduce((total, ability) => total + table.locations.reduce((sum, location) => sum + table.cell(ability, location).count, 0), 0);
		assert(table.total.count === fixture.questions.length, `${run.language}: the table totals ${table.total.count} questions and the fixture asked ${fixture.questions.length}`);
		assert(byLocation === fixture.questions.length, `${run.language}: the locations add up to ${byLocation} questions and the fixture asked ${fixture.questions.length}`);
		assert(byAbility === fixture.questions.length, `${run.language}: the abilities add up to ${byAbility} questions and the fixture asked ${fixture.questions.length}`);
		assert(cells === fixture.questions.length, `${run.language}: the ability × location cells add up to ${cells} questions and the fixture asked ${fixture.questions.length}`);
		assert(table.total.answered === 0 && table.total.accuracy === null, `${run.language}: nothing asked the room, so the table reports no answers and no accuracy, and it reports ${table.total.answered} answered`);
	}
	const overall = forgettingTable(allRows);
	// The planted pairs this size holds whole ask one question each, on top of
	// the abilities' own: at six sessions the duplicate (S01 and S04) and the
	// long conflict (S03 and S06); the short conflict has only its older member
	// here, the moved event and the decoy sit later.
	const PAIRS_WHOLE_AT_THIS_SIZE = 2;
	for (const language of LANGUAGES) {
		const shaped = fixtures.get(language)!.questions.filter((question) => question.shape);
		assert(shaped.length === PAIRS_WHOLE_AT_THIS_SIZE, `${language}: ${SESSIONS} sessions hold ${PAIRS_WHOLE_AT_THIS_SIZE} planted pairs whole and ask one question each, and the fixture asks ${shaped.length}: ${shaped.map((question) => `${question.id} (${question.shape})`).join(", ")}`);
	}
	const wanted = LANGUAGES.length * (RECALL_ABILITIES.length * QUESTIONS_PER_ABILITY + SAID_NOT_NOTED + PAIRS_WHOLE_AT_THIS_SIZE);
	assert(overall.total.count === allRows.length, `the two languages together hold ${allRows.length} questions and the table totals ${overall.total.count}`);
	assert(allRows.length === wanted, `${LANGUAGES.length} languages × (${RECALL_ABILITIES.length} abilities × ${QUESTIONS_PER_ABILITY} question(s) + ${SAID_NOT_NOTED} said and never noted + ${PAIRS_WHOLE_AT_THIS_SIZE} planted pairs) is ${wanted} rows, and the runs built ${allRows.length}`);
	pass(`the forgetting table counts each of the ${allRows.length} questions once per language and once overall, with no accuracy while nothing has been asked`);

	for (const run of runs) {
		assert(run.summary.memoryTokens > 0, `${run.language}: the room reports ${run.summary.memoryTokens} memory tokens after ${run.summary.sessions} folded conversations`);
		assert(run.summary.notesInCore > 0, `${run.language}: the room reports ${run.summary.notesInCore} notes in its core after ${run.summary.sessions} folded conversations`);
		const line = sizeLine(run.summary);
		assert(line.includes(`${run.summary.notesInCore} notes in core`), `${run.language}: the size line should name the ${run.summary.notesInCore} notes in the core, and reads "${line}"`);
		assert(line.includes(`memory ${run.summary.memoryTokens}/${run.summary.memoryBudgetTokens} tokens`), `${run.language}: the size line should name ${run.summary.memoryTokens}/${run.summary.memoryBudgetTokens} tokens, and reads "${line}"`);
		assert(line.includes(`${run.summary.archiveRows} rows in archive`), `${run.language}: the size line should name the ${run.summary.archiveRows} archive rows, and reads "${line}"`);
		assert(line.includes(`${run.summary.archivedByBudget} by budget`), `${run.language}: the size line should say how many of the archive's rows the budget took (${run.summary.archivedByBudget}), and reads "${line}"`);
		// The conversations are part of what the room can be asked, so they are
		// part of what the size line says it holds — the documents that are
		// searchable, and how many planted facts live in them and nowhere else.
		assert((run.summary.conversationDocs ?? 0) > 0, `${run.language}: every folded conversation is searchable, and the summary counts ${run.summary.conversationDocs ?? 0} conversation documents after ${run.summary.sessions} of them were folded`);
		assert((run.summary.conversationMarkers ?? 0) > 0, `${run.language}: the fixture says facts were told and never written down, and the summary counts ${run.summary.conversationMarkers ?? 0} of them in the conversations`);
		assert(
			line.includes(`${run.summary.conversationDocs} conversation documents searchable, ${run.summary.conversationMarkers} planted facts only in them`),
			`${run.language}: the size line should name the ${run.summary.conversationDocs} searchable conversation documents and the ${run.summary.conversationMarkers} facts only they carry, and reads "${line}"`,
		);
		pass(`${run.language}: the size line reports ${run.summary.notesInCore} notes in core, ${run.summary.memoryTokens}/${run.summary.memoryBudgetTokens} memory tokens and ${run.summary.conversationDocs} searchable conversation documents`);
	}

	// --- 6b. The locator reads one PLACE at a time -------------------------------
	// A fold writes the point in its own words and drops the fixture's reference
	// code; the transcript it folded keeps every code it was ever told. So the
	// two ways of finding a marker do not live in the same places, and the order
	// the locator tries them in decides what it reports.
	//
	// Trying the CODE across every place before trying the WORDS anywhere puts a
	// fact that is in the core, in the fold's own words, under the conversation
	// it came from: the core reads empty, and the transcript is credited with
	// answers the memory gave. Under a real ingest that is every fact the room
	// kept. The rule is one place at a time, and inside a place the code before
	// the words.
	//
	// The room here is built by the scripted ingest, which copies the planted
	// sentence word for word, and then ONE note is rewritten without its code
	// through the product's own memory writer — the same call a person's hand
	// edit goes through. That is lighter than driving the real fold worker for
	// a single note and lands the same state: the words in the core, the code
	// only in the transcript.
	const wordingFixture = fixtures.get("de");
	assert(wordingFixture, "the de fixture was not built");
	const wordingPlants = wordingFixture.sessions.flatMap((session) => session.plants);
	// No back history: nothing leaves the core by budget, so every planted note
	// is where the fold put it and the check turns on the rewording alone.
	const wordingRoom = await createBenchRoom({ home, name: "Recall Locator DE", backHistoryTokens: 0 });
	await ingestSessions({ roomId: wordingRoom.roomId, sessions: wordingFixture.sessions });
	const wordingMarkers = wordingPlants.map((plant) => plant.marker);
	const beforeEdit = await locateEvidenceInDetail({ roomId: wordingRoom.roomId, markers: wordingMarkers, plants: wordingPlants });
	const inCore = wordingMarkers.find((marker) => beforeEdit[marker]?.location === "core" && beforeEdit[marker]?.how === "code");
	assert(inCore, `the locator check needs a marker the fold left in the core with its code, and none of ${wordingMarkers.length} is one: ${wordingMarkers.map((marker) => `${marker}=${beforeEdit[marker]?.location}/${beforeEdit[marker]?.how}`).join(", ")}`);

	// The rewording, through the product's writer: the sentence keeps every word
	// that carries its meaning and loses only the reference code.
	const loaded = store.loadMemoryDocument(wordingRoom.roomId, { migrate: "in-memory" });
	const edited = entries.cloneDocument(loaded.doc);
	let rewritten = 0;
	for (const topic of edited.topics) {
		for (const entry of topic.entries) {
			if (!entry.text.includes(inCore)) continue;
			entry.text = entry.text.replace(new RegExp(`\\s*\\(${inCore}\\)`, "g"), "").split(inCore).join("").replace(/\s{2,}/g, " ");
			rewritten += 1;
		}
	}
	assert(rewritten === 1, `exactly one core note carries ${inCore} and ${rewritten} were rewritten`);
	store.writeMemoryDocument(wordingRoom.roomId, edited, { why: "user_edit", snapshotLabel: "edit", operation: "edit" });
	const coreAfter = entries.parseMemoryDocument(fs.readFileSync(path.join(wordingRoom.roomDir, "L1b", "current.md"), "utf-8"));
	assert(
		!coreAfter.topics.some((topic) => topic.entries.some((entry) => entry.text.includes(inCore))),
		`${inCore} was written out of the core and a note still carries it`,
	);

	// The transcript still does, which is what makes the order matter at all.
	searchSources.invalidateRoomCorpus(wordingRoom.roomId);
	const corpus = searchSources.loadRoomCorpus(wordingRoom.roomId, { runtimeCwd: threadCwd });
	const conversations = corpus.docs.filter((document) => document.source === "conversation");
	assert(conversations.some((document) => document.text.includes(inCore)), `the folded transcript should still carry ${inCore}, and none of the ${conversations.length} conversation document(s) does`);

	const afterEdit = await locateEvidenceInDetail({ roomId: wordingRoom.roomId, markers: [inCore], plants: wordingPlants });
	const where = afterEdit[inCore];
	assert(
		where?.location === "core",
		`${inCore} is in the core in the fold's own words, and the locator put it in "${where?.location}" — a locator that tries the code everywhere before the words anywhere reports "conversation" here, and the core reads empty`,
	);
	assert(where?.how === "wording", `${inCore} no longer carries its code anywhere in the core, so it is found by the words of its sentence, and the locator said how="${where?.how}"`);
	pass(`the locator reads a reworded core note as core/wording, not as the conversation whose transcript still carries its code`);

	// --- 7. The scripted ceiling -------------------------------------------------
	// One language, on a room of its own, asked through the REAL turn: the
	// product's own server on the temp home, the room's own WebSocket, the room's
	// own `memory_recall`, and a gateway in place of a provider.
	//
	// The scripted room QUOTES and computes nothing. Leg one makes one recall
	// call with the question's own literal query; leg two answers by quoting,
	// verbatim, the line carrying each evidence marker it can see — out of the
	// tool's results when the archive gave them back, out of the memory in its
	// system prompt when the core still holds them — and says it does not know
	// when it can see none. So what it scores is not a model's skill: it is the
	// CEILING this room's memory allows a perfect reader, and a run that scored
	// above it would have invented something.
	//
	// The ceiling itself is the engine's own `predictScriptedRoomAnswer`, fed
	// from the room's files: where each piece of evidence sits, and what the one
	// recall the room makes — the question's literal query, at the maxResults
	// the scripted room asks for — brings back for it. Scoring that prediction
	// is what makes a question the room cannot reach fall out on its own, so
	// the smoke keeps no list of which abilities are out of reach: an interval
	// between two dates is in none of the lines a quoting room would quote.
	const ceilingLanguage: RecallLanguage = "de";
	const ceilingFixture = fixtures.get(ceilingLanguage);
	assert(ceilingFixture, `the ${ceilingLanguage} fixture was not built`);
	const ceilingPlants = ceilingFixture.sessions.flatMap((session) => session.plants);
	const lineByMarker = new Map(ceilingPlants.map((plant) => [plant.marker, plant.line] as const));

	gateway = await startScriptedRoomGateway({ questions: ceilingFixture.questions, plants: ceilingPlants });
	const lock = writeScriptedProviderRecords({ gatewayPort: gateway.port });
	setBenchModel(lock);
	// A room of its own: the language's first room had an archive row taken out
	// of it by hand, and a ceiling has to be read off a room nothing tampered with.
	const ceilingRoom = await createBenchRoom({ home, name: `Recall Ceiling ${ceilingLanguage.toUpperCase()}` });
	const ceilingIngest = await ingestSessions({ roomId: ceilingRoom.roomId, sessions: ceilingFixture.sessions });
	assert(ceilingIngest.failures.length === 0, `${ceilingLanguage}: the ceiling room's ingest refused ${ceilingIngest.failures.length} conversation(s): ${ceilingIngest.failures.map((failure) => `${failure.session} (${failure.reason})`).join("; ")}`);
	const ceilingLocated = await locateEvidence({ roomId: ceilingRoom.roomId, markers: [...lineByMarker.keys()], plants: ceilingPlants });

	const reachable = new Map<string, boolean>();
	for (const question of ceilingFixture.questions) {
		const evidence: Array<{ marker: string; location: EvidenceLocation; literalRank: number | null; text?: string }> = [];
		for (const piece of question.evidence) {
			const location = ceilingLocated[piece.marker] ?? "gone";
			// The two places nothing is in front of the room: an archived note and
			// a conversation it kept. Both are reachable only through the one
			// recall the room makes, so both are asked for the same way.
			const literalRank = location === "archive" || location === "conversation"
				? (await retrieve({ roomId: ceilingRoom.roomId, query: question.queries.literal, marker: piece.marker, maxResults: 10 })).rank
				: null;
			evidence.push({ marker: piece.marker, location, literalRank, text: lineByMarker.get(piece.marker) });
		}
		const predictedAnswer = predictScriptedRoomAnswer({ question, evidence });
		reachable.set(question.id, scoreAnswer({ question, answer: predictedAnswer }).correct);
	}
	const ceiling = [...reachable.values()].filter(Boolean).length;

	server = await startBenchServer({ home, model: lock });
	const verdicts = new Map<string, { correct: boolean; why: string; answer: string; recallCalls: number }>();
	for (const question of ceilingFixture.questions) {
		const turn = await askRoom({ server, roomId: ceilingRoom.roomId, conversationId: askConversationId(question), prompt: askPrompt(question) });
		const judged = scoreAnswer({ question, answer: turn.answer });
		verdicts.set(question.id, { correct: judged.correct, why: judged.why, answer: turn.answer, recallCalls: turn.recallCalls });
	}
	const right = [...verdicts.values()].filter((verdict) => verdict.correct).length;
	const say = (question: RecallQuestion): string => `${question.id} (${question.ability}): ${verdicts.get(question.id)?.why ?? "not asked"} — "${(verdicts.get(question.id)?.answer ?? "").slice(0, 120)}"`;

	// (a) Everything the ceiling says this room can give back, it gives back.
	// Note that "its evidence is in the core" is NOT on its own enough: the
	// temporal question's evidence is both in the core and quoted back, and its
	// answer is an interval nobody computed. That is the ceiling, not a defect.
	const coreOnly = ceilingFixture.questions.filter((question) => question.evidence.length > 0 && question.evidence.every((evidence) => (ceilingLocated[evidence.marker] ?? "gone") === "core"));
	const coreReachable = coreOnly.filter((question) => reachable.get(question.id));
	assert(coreReachable.length > 0, `${ceilingLanguage}: no question has all of its evidence in the core, so there is nothing for the ceiling to reach`);
	const missed = coreReachable.filter((question) => !verdicts.get(question.id)?.correct);
	assert(missed.length === 0, `${ceilingLanguage}: the scripted room quotes the core straight back, so every core-evidence question the ceiling reaches is right, and ${missed.length} were not: ${missed.map(say).join(" | ")}`);
	pass(`${ceilingLanguage}: the scripted room answers all ${coreReachable.length} core-evidence question(s) the ceiling reaches right${coreOnly.length > coreReachable.length ? `, and the ${coreOnly.length - coreReachable.length} it cannot reach is the one whose answer has to be computed rather than quoted` : ""}`);

	// (b) The abstention question: nothing was planted, so the room must say so.
	const ceilingAbstention = ceilingFixture.questions.find((question) => question.ability === "abstention");
	assert(ceilingAbstention, `${ceilingLanguage}: the fixture holds no abstention question`);
	assert(verdicts.get(ceilingAbstention.id)?.correct === true, `${ceilingLanguage}: a room that was never told this should say it does not know, and it said ${say(ceilingAbstention)}`);
	pass(`${ceilingLanguage}: ${ceilingAbstention.id} is answered right — the room says it does not know and invents nothing`);

	// (c) The total is the ceiling, question by question and not only in sum.
	const disagreed = ceilingFixture.questions.filter((question) => verdicts.get(question.id)?.correct !== reachable.get(question.id));
	assert(disagreed.length === 0, `${ceilingLanguage}: the room and the ceiling disagree on ${disagreed.length} question(s): ${disagreed.map((question) => `${say(question)} — the ceiling called it ${reachable.get(question.id) ? "reachable" : "out of reach"}`).join(" | ")}`);
	assert(right === ceiling, `${ceilingLanguage}: the room scored ${right}/${ceilingFixture.questions.length} and the ceiling for this room is ${ceiling}`);
	const askedRecall = [...verdicts.values()].filter((verdict) => verdict.recallCalls > 0).length;
	assert(askedRecall === ceilingFixture.questions.length, `${ceilingLanguage}: every turn makes its one recall call, and only ${askedRecall} of ${ceilingFixture.questions.length} did — the room's own tool is what this section is driving`);
	pass(`${ceilingLanguage}: the scripted room scores ${right}/${ceilingFixture.questions.length}, exactly the ceiling this room allows, with one recall call per turn`);

	// --- 8. The open items, and the interleaved run --------------------------
	// The fixture plants two extraction questions per language as OPEN ITEMS,
	// which the room's budget never moves out, so a run can count that
	// protection. The full fixture is built for the count — the small one above
	// holds one extraction question and so one item — and the RC entries are
	// read for the directive itself, because a plant the fold saves as a fact
	// is not an item whatever the question says.
	for (const language of LANGUAGES) {
		const full = buildRecallFixture({ language });
		const openItems = full.questions.filter((question) => question.openItem);
		assert(openItems.length === OPEN_ITEM_QUESTIONS_PER_LANGUAGE, `${language}: the fixture plants ${openItems.length} open-item question(s); ${OPEN_ITEM_QUESTIONS_PER_LANGUAGE} were promised`);
		assert(openItems.every((question) => question.ability === "extraction"), `${language}: an open-item question is an extraction question, and ${openItems.filter((question) => question.ability !== "extraction").map((question) => question.id).join(", ")} is not`);
		for (const question of openItems) {
			for (const evidence of question.evidence) {
				const session = full.sessions.find((candidate) => candidate.id === evidence.sessionId);
				const plant = session?.plants.find((candidate) => candidate.marker === evidence.marker);
				assert(plant?.kind === "item", `${language}: ${question.id} is an open-item question and its ${evidence.marker} is planted as a ${plant?.kind ?? "fact"}`);
				const directive = session?.recentContextEntry.split("\n").find((line) => line.includes(`id=${evidence.marker.replace("REC-", "")}`) && line.includes("op=add"));
				assert(directive?.includes("kind=item"), `${language}: the RC entry of ${evidence.sessionId} saves ${evidence.marker} with "${directive ?? "no directive at all"}", not as an item`);
			}
		}
		const itemDirectives = full.sessions.reduce((total, session) => total + (session.recentContextEntry.match(/kind=item/g) ?? []).length, 0);
		assert(itemDirectives === OPEN_ITEM_QUESTIONS_PER_LANGUAGE, `${language}: ${itemDirectives} RC directive(s) save an item and ${OPEN_ITEM_QUESTIONS_PER_LANGUAGE} were expected — one per open-item question`);
		pass(`${language}: ${openItems.map((question) => `${question.id} (${question.evidence.map((evidence) => evidence.marker).join("+")})`).join(" and ")} are planted as open items, kind=item in their RC entries`);
	}

	// The bench's own run, interleaved: the room is asked between the folds
	// through the flag, in a child process, because the flag and the tables it
	// prints are the bench's and not the engine's. A dry run says "interleaved"
	// in its header without building anything; a small run reports the
	// forgetting it watched in the results file, with the two protections
	// holding; and the same file, copied, passes as its own "before".
	const webServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
	const bench = (args: string[]): { status: number | null; stdout: string; stderr: string } => {
		const run = spawnSync("npx", ["tsx", "scripts/memory-bench/recall-bench.mts", ...args], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", env: process.env, maxBuffer: 64 * 1024 * 1024 });
		return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
	};
	const dry = bench(["--interleave", "--dry-run", "--language", "de"]);
	assert(dry.status === 0, `--interleave --dry-run exited ${dry.status}: ${dry.stderr.slice(-400)}`);
	const header = dry.stdout.split("\n").find((line) => line.startsWith("Recall bench")) ?? "";
	assert(header.includes("interleaved"), `the run header of an interleaved run says "interleaved", and it reads "${header}"`);
	assert(/^dry run: /m.test(dry.stdout), `--interleave --dry-run should stop at the dry-run lines and printed:\n${dry.stdout.slice(-600)}`);
	pass(`--interleave --dry-run prints an interleaved header and builds nothing`);

	const interleavedOut = path.join(home, "recall-smoke-interleaved.json");
	const small = bench(["--interleave", "--language", "de", "--sessions", "8", "--per-ability", "2", "--fold-every", "3", "--out", interleavedOut]);
	assert(small.status === 0, `the small interleaved run exited ${small.status}:\n${small.stdout.slice(-1200)}\n${small.stderr.slice(-400)}`);
	assert(/^interleaved: \d+ questions asked/m.test(small.stdout), `the small interleaved run prints its interleave table, and its output holds no "interleaved:" line:\n${small.stdout.slice(-1200)}`);
	const results = JSON.parse(fs.readFileSync(interleavedOut, "utf-8")) as { runs: Array<{ summary: RecallRunSummary; rows: RecallResultRow[] }> };
	const interleaved = results.runs[0]?.summary.interleave;
	assert(interleaved, `the results file of an interleaved run carries an interleave block, and this one holds ${JSON.stringify(results.runs[0]?.summary.interleave)}`);
	assert(interleaved.askedQuestions > 0, `the small run asked ${interleaved.askedQuestions} questions between its folds; some were expected`);
	assert(interleaved.askedMarkers > 0, `the small run asked about ${interleaved.askedMarkers} markers; some were expected`);
	assert(interleaved.openItemMarkers > 0, `the small run's fixture plants ${interleaved.openItemMarkers} open-item markers; some were expected`);
	assert(interleaved.openItemMarkersInCore === interleaved.openItemMarkers, `${interleaved.openItemMarkersInCore} of ${interleaved.openItemMarkers} open items are still in the core after the run; the budget never moves an open item out, so all of them were expected`);
	assert(interleaved.budgetRowsInEvents > 0, `the small run's Memorize records moved ${interleaved.budgetRowsInEvents} rows out by budget; some were expected at this size`);
	assert(interleaved.budgetRowsWithReason === interleaved.budgetRowsInEvents, `${interleaved.budgetRowsWithReason} of ${interleaved.budgetRowsInEvents} rows moved out by budget say why; every one was expected to`);
	const withoutFlag = results.runs[0].rows.filter((row) => typeof row.askedWhileInCore !== "boolean");
	assert(withoutFlag.length === 0, `every row of an interleaved run says whether it was asked while in core, and ${withoutFlag.length} of ${results.runs[0].rows.length} do not: ${withoutFlag.map((row) => row.id).join(", ")}`);
	assert(results.runs[0].rows.some((row) => row.askedWhileInCore === true), `no row of the small run was asked while its evidence was in the core; the first fold's own notes are, so some were expected`);
	// The claim audit of the same run: one line per language on the screen, the
	// same numbers in the results file's summary, and zero in both defect counts.
	const smallClaimLines = small.stdout.split("\n").filter((line) => /^claims: \d+ memorized, \d+ unindexed, \d+ misassigned$/.test(line));
	assert(smallClaimLines.length === 1 && smallClaimLines[0] === "claims: 8 memorized, 0 unindexed, 0 misassigned", `the small run prints one claims line, "claims: 8 memorized, 0 unindexed, 0 misassigned", and printed: ${smallClaimLines.join(" | ") || "(no claims line)"}`);
	const smallClaims = results.runs[0]?.summary.claims;
	assert(smallClaims && smallClaims.memorized === 8 && smallClaims.unindexed === 0 && smallClaims.misassigned === 0, `the results file's summary carries the claim audit, 8 memorized and both defect counts zero, and it carries ${JSON.stringify(smallClaims)}`);
	pass(`the small run prints "${smallClaimLines[0]}" and its results file carries the same audit`);

	pass(`a small interleaved run asked ${interleaved.askedQuestions} questions about ${interleaved.askedMarkers} markers, kept all ${interleaved.openItemMarkers} open items, and gave a reason for all ${interleaved.budgetRowsInEvents} rows its Memorizes moved out`);

	const beforeCopy = path.join(home, "recall-smoke-interleaved-before.json");
	fs.copyFileSync(interleavedOut, beforeCopy);
	const gated = bench(["--interleave", "--language", "de", "--sessions", "8", "--per-ability", "2", "--fold-every", "3", "--out", interleavedOut, "--gate-before", beforeCopy]);
	assert(gated.status === 0, `the gated run against a copy of its own results exited ${gated.status}:\n${gated.stdout.slice(-1200)}\n${gated.stderr.slice(-400)}`);
	assert(/^forgetting gate: passed/m.test(gated.stdout), `the gated run should say the gate passed, and printed:\n${gated.stdout.slice(-800)}`);
	assert(/^median answer tokens before\/after/m.test(gated.stdout), `the gated run prints the median answer tokens before and after, and did not:\n${gated.stdout.slice(-800)}`);
	pass(`--gate-before against a copy of the run's own results passes and prints the median answer tokens before/after`);

	// --- 9. The planted pairs: duplicates and conflicts ---------------------
	// Five shapes per language, each a pair of sentences in two conversations:
	// the same sentence twice, one point with two values in the shape the twin
	// test calls alike (nine words, eight shared), in the shape under its
	// six-word floor, and as a dated event whose date moved, and a decoy of two
	// events with two numbers and two dates. What each pair IS is pinned here
	// against the product's own classifier, on the sentences without their
	// reference codes, because the bench's verdict on a run rests on that.
	const EXPECTED_CLASS: Record<ConflictShape, ReturnType<typeof duplicates.classifyNotePair>> = { duplicate: "duplicate", "conflict-long": "conflict", "conflict-short": "conflict", "moved-event": "conflict", decoy: "different" };
	for (const fixture of [fullEn, fullDe]) {
		const language = fixture.language;
		const shaped = fixture.questions.filter((question) => question.shape);
		assert(shaped.length === CONFLICT_SHAPES.length, `${language}: the full fixture asks ${shaped.length} questions about its planted pairs; one per shape, ${CONFLICT_SHAPES.length}, were expected`);
		for (const shape of CONFLICT_SHAPES) {
			const pair = pairOf(fixture, shape);
			assert(pair, `${language}: the full fixture holds the ${shape} pair only in part`);
			const [older, newer] = pair;
			const found = duplicates.classifyNotePair(plantedWording(older.line), plantedWording(newer.line));
			assert(found === EXPECTED_CLASS[shape], `${language}: the ${shape} pair classifies as "${found}" and it is planted to be "${EXPECTED_CLASS[shape]}": "${plantedWording(older.line)}" against "${plantedWording(newer.line)}"`);
			const question = shaped.find((candidate) => candidate.shape === shape);
			assert(question, `${language}: no question asks about the ${shape} pair`);
			const conflict = found === "conflict";
			assert(question.ability === (conflict ? "knowledge-update" : "extraction"), `${language}: ${question.id} asks about the ${shape} pair as ${question.ability}`);
			assert(question.evidence[0]?.marker === (shape === "duplicate" ? older : newer).marker, `${language}: ${question.id} rests on ${question.evidence[0]?.marker ?? "nothing"} and the ${shape} question rests on ${(shape === "duplicate" ? older : newer).marker}`);
			if (conflict) assert(question.trapEvidence?.[0]?.marker === older.marker && (question.trap ?? []).length > 0, `${language}: ${question.id} names no old value at ${older.marker}`);
		}
		// The shape questions come after every ability's, and the sentences of
		// the long shape are the nine-word pattern the twin test calls alike. The
		// one question that comes after the pairs is the dropped conversation's,
		// appended last of all so that no earlier id moves; section 11 pins it.
		const afterThePairs = new Set([...(typeof droppedQuestions === "function" ? droppedQuestions(fixture).map((question) => question.id) : []), ...fixture.questions.filter((question) => question.noHint).map((question) => question.id)]);
		const lastAbility = Math.max(...fixture.questions.map((question, index) => (question.shape || afterThePairs.has(question.id) ? -1 : index)));
		const firstShaped = fixture.questions.findIndex((question) => question.shape);
		assert(firstShaped > lastAbility, `${language}: the planted pairs' questions come after every ability question, and ${fixture.questions[firstShaped].id} comes before ${fixture.questions[lastAbility].id}`);
		const long = pairOf(fixture, "conflict-long")!;
		const longWords = (line: string) => duplicates.normalizeNoteText(plantedWording(line)).split(" ");
		assert(longWords(long[0].line).length === 9 && longWords(long[1].line).length === 9, `${language}: the long conflict shape is nine normalised words a side, and it is ${longWords(long[0].line).length} and ${longWords(long[1].line).length}`);
		assert(longWords(long[0].line).filter((word) => longWords(long[1].line).includes(word)).length === 8, `${language}: the long conflict shape shares eight of its nine words`);
		const short = pairOf(fixture, "conflict-short")!;
		assert(longWords(short[0].line).length < duplicates.NOTE_LOOKALIKE_MIN_WORDS, `${language}: the short conflict shape is under the twin test's floor of ${duplicates.NOTE_LOOKALIKE_MIN_WORDS} words, and it is ${longWords(short[0].line).length}`);
		pass(`${language}: the five planted pairs classify as the product reads them (duplicate, conflict, conflict, conflict, different) and each is asked about once, after the abilities' questions`);
	}
	assert(RECALL_FIXTURE_DEFAULTS.seed === 20260915 && RECALL_FIXTURE_DEFAULTS.sessions === 30 && RECALL_FIXTURE_DEFAULTS.questionsPerAbility === 10 && RECALL_FIXTURE_DEFAULTS.conversationQuestions === 10, `the fixture's defaults moved: ${JSON.stringify(RECALL_FIXTURE_DEFAULTS)}`);

	// THE TABLES MUST NOT MOVE. The pairs are planted at the end of their
	// sittings and numbered after every other marker, so every question, id,
	// marker and query of the fixture as it was is byte for byte what it was.
	// Pinned as literals at the smoke's small size, so a change that renumbers
	// the fixture fails here rather than in a results diff nobody runs.
	const PINNED: Record<RecallLanguage, { firstMarker: string; lastMarker: string; firstShapeMarker: string; abilityIds: string[]; shapeIds: string[] }> = {
		en: { firstMarker: "REC-E01", lastMarker: "REC-E17", firstShapeMarker: "REC-E18", abilityIds: ["Q-en-01", "Q-en-02", "Q-en-03", "Q-en-04", "Q-en-05", "Q-en-06", "Q-en-07", "Q-en-08", "Q-en-09", "Q-en-10", "Q-en-11", "Q-en-12"], shapeIds: ["Q-en-13", "Q-en-14", "Q-en-15"] },
		de: { firstMarker: "REC-D01", lastMarker: "REC-D17", firstShapeMarker: "REC-D18", abilityIds: ["Q-de-01", "Q-de-02", "Q-de-03", "Q-de-04", "Q-de-05", "Q-de-06", "Q-de-07", "Q-de-08", "Q-de-09", "Q-de-10", "Q-de-11", "Q-de-12"], shapeIds: ["Q-de-13", "Q-de-14", "Q-de-15"] },
	};
	for (const language of LANGUAGES) {
		const small = buildRecallFixture({ language, sessions: 8, questionsPerAbility: 2 });
		const pinned = PINNED[language];
		// The no-hint plants and questions come after all of these and are pinned
		// in their own section; here they are left out so the pins read as before.
		const plain = small.sessions.flatMap((session) => session.plants.filter((plant) => !plant.shape && !plant.noHint).map((plant) => plant.marker));
		const shaped = small.sessions.flatMap((session) => session.plants.filter((plant) => plant.shape).map((plant) => plant.marker));
		const number = (marker: string) => Number(marker.replace(/^REC-[A-Z]/, ""));
		const letter = language === "en" ? "E" : "D";
		const asMarker = (value: number) => `REC-${letter}${String(value).padStart(2, "0")}`;
		assert(asMarker(Math.min(...plain.map(number))) === pinned.firstMarker && asMarker(Math.max(...plain.map(number))) === pinned.lastMarker, `${language}: the markers of the fixture as it was run ${asMarker(Math.min(...plain.map(number)))}..${asMarker(Math.max(...plain.map(number)))} at 8 sessions; ${pinned.firstMarker}..${pinned.lastMarker} were pinned`);
		assert(shaped.length > 0 && Math.min(...shaped.map(number)) === number(pinned.firstShapeMarker), `${language}: the planted pairs' markers begin at ${pinned.firstShapeMarker} at 8 sessions, after every other marker, and they begin at ${asMarker(Math.min(...shaped.map(number)))}`);
		assert(shaped.every((marker) => number(marker) > number(pinned.lastMarker)), `${language}: a planted pair's marker is numbered before ${pinned.lastMarker}: ${shaped.join(", ")}`);
		const abilityIds = small.questions.filter((question) => !question.shape && !question.noHint).map((question) => question.id);
		const shapeIds = small.questions.filter((question) => question.shape).map((question) => question.id);
		assert(JSON.stringify(abilityIds) === JSON.stringify(pinned.abilityIds), `${language}: the ability questions at 8 sessions × 2 per ability are ${JSON.stringify(abilityIds)}; ${JSON.stringify(pinned.abilityIds)} were pinned`);
		assert(JSON.stringify(shapeIds) === JSON.stringify(pinned.shapeIds), `${language}: the planted pairs' questions at 8 sessions are ${JSON.stringify(shapeIds)}; ${JSON.stringify(pinned.shapeIds)} were pinned (the duplicate, the long and the short conflict sit inside the first eight sittings)`);
		for (const question of small.questions.filter((candidate) => !candidate.shape)) {
			assert(question.evidence.every((evidence) => !shaped.includes(evidence.marker)), `${language}: ${question.id} is an ability question resting on a planted pair's marker: ${question.evidence.map((evidence) => evidence.marker).join(", ")}`);
		}
		pass(`${language}: at 8 sessions the fixture as it was keeps ${pinned.firstMarker}..${pinned.lastMarker} and ${pinned.abilityIds[0]}..${pinned.abilityIds[pinned.abilityIds.length - 1]}, and the pairs sit after them at ${pinned.firstShapeMarker} and ${pinned.shapeIds.join(", ")}`);
	}

	// The bench's own run over every pair, in a child process: the smallest size
	// that holds all five pairs whole is thirteen sittings (the decoy's second
	// member sits in S13). The conflicts line, one line per shape, the ingest's
	// count of repeats refused, and the results file's conflicts block are
	// read back; --gate-conflicts passes because every shape is as planted.
	const conflictsOut = path.join(home, "recall-smoke-conflicts.json");
	const conflictsRun = bench(["--language", "both", "--sessions", "13", "--per-ability", "2", "--fold-every", "3", "--gate-conflicts", "--out", conflictsOut]);
	assert(conflictsRun.status === 0, `the run over the planted pairs exited ${conflictsRun.status}:\n${conflictsRun.stdout.slice(-1600)}\n${conflictsRun.stderr.slice(-400)}`);
	const conflictLines = conflictsRun.stdout.split("\n").filter((line) => /^conflicts: \d+ found, \d+ superseded with a reason, \d+ left as both, \d+ repeats refused as twins$/.test(line));
	assert(conflictLines.length === 2, `the run prints one conflicts line per language in the shape "conflicts: N found, N superseded with a reason, N left as both, N repeats refused as twins", and printed ${conflictLines.length}:\n${conflictsRun.stdout.split("\n").filter((line) => line.startsWith("conflicts")).join("\n")}`);
	for (const shape of CONFLICT_SHAPES) {
		const lines = conflictsRun.stdout.split("\n").filter((line) => new RegExp(`^  ${shape}\\s+(ok|FAIL)\\s`).test(line));
		assert(lines.length === 2 && lines.every((line) => /\s+ok\s/.test(line)), `the run prints "  ${shape}  ok  <detail>" once per language, and printed:\n${lines.join("\n") || "(nothing)"}`);
	}
	assert(/^conflicts gate: passed for de, en$/m.test(conflictsRun.stdout), `--gate-conflicts says the gate passed for both languages, and printed:\n${conflictsRun.stdout.slice(-600)}`);
	const conflictsFile = JSON.parse(fs.readFileSync(conflictsOut, "utf-8")) as { runs: Array<{ summary: RecallRunSummary; steps: Array<{ twinsRefused: number }>; rows: RecallResultRow[] }> };
	assert(conflictsFile.runs.length === 2, `the results file holds ${conflictsFile.runs.length} run(s); one per language was expected`);
	for (const run of conflictsFile.runs) {
		const language = run.summary.language;
		const block = run.summary.conflicts;
		assert(block, `${language}: the results file carries no summary.conflicts block`);
		assert(block.shapes.length === CONFLICT_SHAPES.length && block.shapes.every((verdict) => verdict.ok), `${language}: summary.conflicts judges ${block.shapes.length} shape(s), ${block.shapes.filter((verdict) => !verdict.ok).map((verdict) => `${verdict.shape}: ${verdict.detail}`).join("; ") || "all ok"}`);
		assert(JSON.stringify(block.shapes.map((verdict) => verdict.shape)) === JSON.stringify(CONFLICT_SHAPES), `${language}: the shapes are judged in the fixture's order, and the block reads ${block.shapes.map((verdict) => verdict.shape).join(", ")}`);
		assert(block.twinsRefused >= 1, `${language}: the duplicate's second add is refused as a repeat and left out, so the ingest counts at least one, and it counts ${block.twinsRefused}`);
		assert(run.steps.reduce((total, step) => total + step.twinsRefused, 0) === block.twinsRefused, `${language}: the steps' repeats add up to ${run.steps.reduce((total, step) => total + step.twinsRefused, 0)} and the block says ${block.twinsRefused}`);
		assert(block.supersededWithReason === 3 && block.leftAsBoth === 0 && block.found === 3, `${language}: three conflicts are planted and each is superseded with a reason, so the block reads 3 found, 3 with a reason, 0 left as both, and it reads ${block.found}, ${block.supersededWithReason}, ${block.leftAsBoth}`);
		const shapeRows = run.rows.filter((row) => row.shape);
		assert(shapeRows.length === CONFLICT_SHAPES.length, `${language}: ${shapeRows.length} result rows carry a shape; one per pair was expected`);
		for (const verdict of block.shapes.filter((candidate) => candidate.shape !== "duplicate" && candidate.shape !== "decoy")) {
			assert(/replaces .* the newer date decides/.test(verdict.detail), `${language}: the ${verdict.shape} verdict quotes the reason the card shows, and reads "${verdict.detail}"`);
		}
		pass(`${language}: the run over all five pairs reads ${block.found} found, ${block.supersededWithReason} superseded with a reason, ${block.leftAsBoth} left as both, ${block.twinsRefused} repeat(s) refused, every shape ok`);
	}

	// --- 11. Searchable conversations: the clock, the audit, the dropped place --
	// (a) THE CLOCK. A room whose conversations all carry ONE timestamp, which
	// is what a day of LongMemEval sessions looks like, folded every two: the
	// room hands RC-0001 and RC-0002 out again after every Memorize, so three
	// Memorizes reuse both ids three times over. The stamps the product wrote
	// are read back off its own records: every Remember later than the one
	// before it, every Memorize after the last Remember it folds and before the
	// next Remember, all on the day the clock named. And the audit reads zero,
	// which on tied stamps and reused ids is exactly what it once did not.
	{
		const tiedFixture = buildRecallFixture({ language: "en", sessions: SESSIONS, questionsPerAbility: QUESTIONS_PER_ABILITY, conversationQuestions: SAID_NOT_NOTED });
		const tiedRoom = await createBenchRoom({ home, name: "Recall Bench Smoke Tied Clock", backHistoryTokens: 0 });
		const tiedDay = "2026-05-04";
		const tiedIngest = await ingestSessions({ roomId: tiedRoom.roomId, sessions: tiedFixture.sessions, foldEvery: FOLD_EVERY, now: () => new Date(`${tiedDay}T09:00:00.000Z`) });
		assert(tiedIngest.failures.length === 0, `the tied-clock ingest refused ${tiedIngest.failures.length} conversation(s): ${tiedIngest.failures.map((failure) => `${failure.session} (${failure.reason})`).join("; ")}`);
		const recordsIn = (kind: string) => {
			const dir = path.join(tiedRoom.roomDir, "events", kind);
			return fs.readdirSync(dir).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(dir, name), "utf-8")) as { approvedAt: string; conversationId?: string; recentContextId?: string });
		};
		const checkpoints = recordsIn("checkpoint");
		const absorbs = recordsIn("absorb").sort((a, b) => Date.parse(a.approvedAt) - Date.parse(b.approvedAt));
		// A session is remembered under a conversation id made of its own id.
		const rememberedAt = tiedFixture.sessions.map((session) => {
			const record = checkpoints.find((candidate) => candidate.conversationId?.endsWith(`_${session.id.toLowerCase()}`));
			assert(record, `no checkpoint record names the conversation ${session.id} was remembered under: ${checkpoints.map((candidate) => candidate.conversationId).join(", ")}`);
			return Date.parse(record.approvedAt);
		});
		for (let at = 1; at < rememberedAt.length; at++) {
			assert(rememberedAt[at] > rememberedAt[at - 1], `every Remember is stamped later than the one before it, and ${tiedFixture.sessions[at].id} is stamped ${new Date(rememberedAt[at]).toISOString()} against ${tiedFixture.sessions[at - 1].id}'s ${new Date(rememberedAt[at - 1]).toISOString()}: a tie lets a fold claim another conversation's transcript`);
		}
		assert(absorbs.length === tiedIngest.steps.length && absorbs.length === Math.ceil(SESSIONS / FOLD_EVERY), `${SESSIONS} conversations folded every ${FOLD_EVERY} are ${Math.ceil(SESSIONS / FOLD_EVERY)} Memorizes, and the room recorded ${absorbs.length} against the report's ${tiedIngest.steps.length}`);
		absorbs.forEach((absorb, step) => {
			const lastFolded = Math.min((step + 1) * FOLD_EVERY, SESSIONS) - 1;
			const stamp = Date.parse(absorb.approvedAt);
			assert(stamp > rememberedAt[lastFolded], `Memorize ${step + 1} is stamped after ${tiedFixture.sessions[lastFolded].id}, the last Remember it folds, and it reads ${absorb.approvedAt} against ${new Date(rememberedAt[lastFolded]).toISOString()}`);
			if (lastFolded + 1 < SESSIONS) assert(stamp < rememberedAt[lastFolded + 1], `Memorize ${step + 1} is stamped before ${tiedFixture.sessions[lastFolded + 1].id}, the next Remember, and it reads ${absorb.approvedAt} against ${new Date(rememberedAt[lastFolded + 1]).toISOString()}`);
		});
		const offDay = [...rememberedAt.map((stamp) => new Date(stamp).toISOString()), ...absorbs.map((absorb) => absorb.approvedAt)].filter((stamp) => !stamp.startsWith(tiedDay));
		assert(offDay.length === 0, `the clock's day is kept, a day holds every stamp of it, and ${offDay.join(", ")} fell off ${tiedDay}`);
		const reused = new Set(checkpoints.map((record) => record.recentContextId)).size;
		assert(reused < SESSIONS, `the room hands its Recent Context ids out again after a Memorize, so ${SESSIONS} Remembers use fewer than ${SESSIONS} ids, and they used ${reused}: without the reuse this room proves nothing about claims`);
		assert(tiedIngest.claims && tiedIngest.claims.memorized === SESSIONS && tiedIngest.claims.unindexed === 0 && tiedIngest.claims.misassigned === 0, `on one shared timestamp and ${reused} reused ids the audit still reads ${SESSIONS} memorized, 0 unindexed, 0 misassigned, and it reads ${JSON.stringify(tiedIngest.claims)}`);
		pass(`a room on one shared timestamp: ${SESSIONS} Remembers strictly increasing, ${absorbs.length} Memorizes each between the last Remember it folds and the next, ${reused} ids reused, "${claimsLine(tiedIngest.claims)}"`);
	}

	// (b) THE PLACE, in the engine and in the fixture. `dropped` is a location
	// of its own, labelled the way the table prints it, worse than a folded
	// conversation and better than gone, and one recall has to answer for. The
	// full fixture plants one fact in its last sitting, which notes nothing, and
	// asks one question about it, last of all and numbered after every other
	// marker; the eight-sitting fixture plants and asks nothing of the kind, so
	// the pins above it hold unchanged.
	assert(locationLabel("dropped" as EvidenceLocation) === "conversation (no notes)", `the dropped place is written "conversation (no notes)" in a table and reads "${locationLabel("dropped" as EvidenceLocation)}"`);
	assert(worstLocation(["conversation", "dropped" as EvidenceLocation]) === "dropped" && worstLocation(["dropped" as EvidenceLocation, "gone"]) === "gone", `a dropped conversation is a harder place than a folded one and an easier one than gone, and worstLocation reads ${worstLocation(["conversation", "dropped" as EvidenceLocation])} and ${worstLocation(["dropped" as EvidenceLocation, "gone"])}`);
	assert(RETRIEVED_LOCATIONS?.has("dropped" as EvidenceLocation) && RETRIEVED_LOCATIONS.has("conversation") && RETRIEVED_LOCATIONS.has("archive"), "recall answers for the archive, a folded conversation and a dropped one");
	const placeColumns = forgettingTable([]).locations;
	assert(placeColumns.indexOf("dropped" as EvidenceLocation) === placeColumns.indexOf("conversation") + 1, `the forgetting table lists the dropped place right after the conversation, and its columns read ${placeColumns.join(", ")}`);
	for (const language of LANGUAGES) {
		const full = buildRecallFixture({ language });
		const asked = droppedQuestions(full);
		assert(asked.length === 1, `${language}: the full fixture asks one question about a conversation the fold drops, and it asks ${asked.length}`);
		const question = asked[0];
		// Last of all but the no-hint questions, which were appended after it.
		const beforeNoHint = full.questions.filter((candidate) => !candidate.noHint);
		assert(question.id === beforeNoHint[beforeNoHint.length - 1].id && question.ability === "extraction" && !question.shape, `${language}: the dropped conversation's question is the last one before the no-hint questions, a plain extraction question, and it is ${question.id} (${question.ability}) where the last is ${beforeNoHint[beforeNoHint.length - 1].id}`);
		assert(question.evidence.length === 1 && droppedIn(full, question.evidence[0]), `${language}: ${question.id} rests on one sentence in a sitting the fold drops`);
		const sitting = full.sessions.find((session) => session.id === question.evidence[0].sessionId);
		assert(sitting && sitting.id === full.sessions[full.sessions.length - 1].id, `${language}: the dropped conversation is the last sitting, and ${question.id} rests on ${question.evidence[0].sessionId}`);
		const plant = sitting.plants.find((candidate) => candidate.marker === question.evidence[0].marker);
		assert(plant && plant.noted === false && sitting.plants.every((candidate) => candidate.noted === false), `${language}: nothing of ${sitting.id} is noted, the new plant included`);
		assert(!sitting.recentContextEntry.includes("<!-- plant") && !sitting.recentContextEntry.includes(plant.marker), `${language}: the RC entry of ${sitting.id} carries no directive and not the marker, so the scripted fold drops the conversation`);
		assert(sitting.turns.some((turn) => turn.role === "assistant" && turn.text === plant.line), `${language}: ${plant.marker} is said in ${sitting.id}, word for word`);
		const numbers = full.sessions.flatMap((session) => session.plants.map((candidate) => Number(candidate.marker.replace(/^REC-[A-Z]+/, ""))));
		const numbersBeforeNoHint = full.sessions.flatMap((session) => session.plants.filter((candidate) => !candidate.noHint).map((candidate) => Number(candidate.marker.replace(/^REC-[A-Z]+/, ""))));
		assert(Number(plant.marker.replace(/^REC-[A-Z]+/, "")) === Math.max(...numbersBeforeNoHint) && new Set(numbers).size === numbers.length, `${language}: ${plant.marker} is numbered after every other marker and no number is used twice`);
		const others = full.questions.filter((candidate) => candidate !== question && candidate.evidence.some((evidence) => evidence.marker === plant.marker || droppedIn(full, evidence)));
		assert(others.length === 0, `${language}: no other question rests on the dropped conversation, and ${others.map((candidate) => candidate.id).join(", ")} do`);
		const eight = buildRecallFixture({ language, sessions: 8, questionsPerAbility: 2 });
		assert(droppedQuestions(eight).length === 0 && eight.sessions.every((session) => session.plants.some((candidate) => candidate.noted !== false)), `${language}: at 8 sessions every sitting notes something, so nothing is planted in a dropped conversation and nothing is asked about one`);
		assert(eight.questions.every((candidate, at) => candidate.id === `Q-${language}-${String(at + 1).padStart(2, "0")}`), `${language}: the 8-session question ids run on unbroken, and they read ${eight.questions.map((candidate) => candidate.id).join(", ")}`);
		pass(`${language}: ${question.id} rests on ${plant.marker}, said in ${sitting.id} and never noted, numbered after every other marker; at 8 sessions nothing of the kind is planted`);
	}

	// (c) THE PLACE, in a run. Every sitting under the last notes something, so
	// the place needs the full thirty: ONE extra run of the bench, one language,
	// one question per ability. Its question row reads "conversation (no notes)",
	// its literal query finds the sentence, the results file says `dropped`, and
	// the audit counts the dropped conversation as memorized and indexed.
	{
		const droppedOut = path.join(home, "recall-smoke-dropped.json");
		const droppedRun = bench(["--language", "en", "--sessions", "30", "--per-ability", "1", "--out", droppedOut]);
		assert(droppedRun.status === 0, `the thirty-sitting run exited ${droppedRun.status}:\n${droppedRun.stdout.slice(-1600)}\n${droppedRun.stderr.slice(-400)}`);
		const thirty = buildRecallFixture({ language: "en", sessions: 30, questionsPerAbility: 1 });
		// Found by the fold's own rule rather than by a flag: the question whose
		// sentence was said in a sitting that plants something and notes none of it.
		const notesNothing = (sessionId: string) => {
			const sitting = thirty.sessions.find((session) => session.id === sessionId);
			return Boolean(sitting && sitting.plants.length > 0 && sitting.plants.every((plant) => plant.noted === false));
		};
		const question = thirty.questions.find((candidate) => candidate.evidence.some((evidence) => notesNothing(evidence.sessionId)));
		assert(question, "the thirty-sitting fixture asks a question about a conversation the fold drops whole, and no question of it rests on a sitting that notes nothing");
		const file = JSON.parse(fs.readFileSync(droppedOut, "utf-8")) as { runs: Array<{ summary: RecallRunSummary; rows: RecallResultRow[] }> };
		const row = file.runs[0]?.rows.find((candidate) => candidate.id === question.id);
		assert(row, `the results file carries no row for ${question.id}`);
		assert((row.location as string) === "dropped", `${question.id} rests on a sentence said in a conversation the fold dropped, so its row reads "dropped", and it reads "${row.location}"`);
		assert(typeof row.ranks.literal === "number", `the literal query "${question.queries.literal}" is the transcript's own words, so recall hands the dropped conversation back, and it came back as ${String(row.ranks.literal)}`);
		const printed = droppedRun.stdout.split("\n").find((line) => line.startsWith(question.id));
		assert(printed && /\sextraction\s+conversation \(no notes\)\s/.test(printed), `the question table prints ${question.id} in "conversation (no notes)", and printed "${printed ?? "(no row)"}"`);
		assert(droppedRun.stdout.split("\n").some((line) => /^literal\s+conversation \(no notes\)\s+1\s+1\s+1\s+0$/.test(line)), `the retrieval table counts the one marker in "conversation (no notes)", found at rank 1 by its literal query`);
		const claims = file.runs[0]?.summary.claims;
		assert(claims && claims.memorized === 30 && claims.unindexed === 0 && claims.misassigned === 0, `thirty conversations were memorized, the dropped one among them, and every one is indexed: the audit reads ${JSON.stringify(claims)}`);
		pass(`one thirty-sitting run: ${question.id} reads "conversation (no notes)", its literal query finds it at rank ${String(row.ranks.literal)}, and the audit reads "${claimsLine(claims)}"`);
	}

	// --- 12. An honest abstention in words no list holds -------------------------
	// The abstention rule's gate is "invents nothing"; saying so is read off the
	// phrase list OR off a plain negation in what is left of the answer once the
	// fixture's own facts are taken out. The cases are the eleven answers a real
	// model gave to the full fixture's abstention questions that the phrase list
	// alone called wrong, each held against its own question, word for word as
	// the room said them (an em dash is written as its escape and is the same
	// string). Two constructed answers carry a negation AND an invention, and
	// stay wrong: the negation is no licence to guess.
	const REJECTED_ABSTENTIONS: ReadonlyArray<readonly [string, string]> = [
		["Q-en-41", "I don't have a CFO's mobile number on record \u2014 nothing in memory covers that, and it's not something I'd store or surface even if it existed, since phone numbers for individuals are personal data I'd handle carefully rather than hand out on request.\n\nIf you need it, best sources are your contacts list, the internal directory, or Dario Lenz's team directly (he's the division head you're coordinating cost figures with). If you tell me why you need it, I can help figure out the right channel."],
		["Q-en-43", "No deputy has been named yet. Ruth Okafor is currently the sole evidence-bundle sign-off owner, and her parental leave starts 2026-09-01, leaving that role uncovered from that date. Since April, this was flagged as open \u2014 confirm with the risk team who covers it \u2014 and as of the last check-in, no answer had come back.\n\nNext step: chase the risk team for a named deputy before the September 1 gap, since there's just over five weeks left."],
		["Q-en-44", "That page doesn't exist yet \u2014 creating it is still an open item on your list, never actually initiated. There's nothing in what I have about a cost to run it, and there wouldn't be, since it hasn't been built.\n\nIf you want that pursued, the next step is still the same one that's been sitting open: request creation of the portal status page to carry the 99.5% freshness SLA. Once it exists, running cost would presumably come from whatever hosting/tooling you pick for it \u2014 worth asking IT or whoever stands it up."],
		["Q-en-48", "Nothing in memory gives a headcount for the risk team. What's on record: they run the annual access review and own its clearance meetings (last Thursday of the month), but no note states how many people are on the team \u2014 that's not information I have."],
		["Q-de-41", "Dazu finde ich in der gemeinsamen Historie nichts – nur, dass die Finanzleitung über das Abrechnungsteam die engere Toleranzschwelle für den Abgleichlauf angefordert hat, keine Kontaktdaten dazu. Eine Mobilnummer der Finanzleitung ist nirgends hinterlegt, und ich würde sie ohnehin nicht einfach herausgeben, selbst wenn sie gespeichert wäre – Kontaktdaten von Kolleg:innen sind personenbezogen.\n\nWenn du für Rückfragen jemanden erreichen musst: Frag am besten direkt beim Abrechnungsteam nach, das ist laut unserer Historie die Schnittstelle zur Finanzleitung."],
		["Q-de-43", "Aktuell ist das noch offen: Die Abzeichnung des Nachweispakets läuft bislang bei Frau Müller (Postfach nachweis-abzeichnung). Sie geht am 01.09.2026 in Elternzeit, und eine Vertretung ist bisher nicht benannt \u2014 das war zuletzt eine offene Anfrage ans Risikoteam, deren Ergebnis noch nicht vorliegt.\n\nNächster Schritt: Beim Risikoteam nachhaken, ob inzwischen eine Vertretung feststeht, da die Lücke ab 01.09. sonst offen bleibt."],
		["Q-de-44", "Dazu liegt nichts vor. Ich habe keine Notiz zu Betriebskosten der Portal-Statusseite \u2014 und die Statusseite selbst existiert noch nicht, sie muss laut Rückstand erst erstellt werden (Tobias Löwe wollte die Frischezahl dort sehen, aber die Umsetzung stand noch aus).\n\nFalls es Kostenzahlen dazu gibt, kenne ich sie nicht aus unserer bisherigen Zusammenarbeit \u2014 das wäre bei euch im Plattform- oder Finanzteam zu erfragen, oder du gibst mir die Zahl, dann halte ich sie fest."],
		["Q-de-45", "Zu Keller Datentechnik ist in meiner Erinnerung nur festgehalten, dass es sich um eine Firma aus Zürich handelt, die den Prüfexport baut –\n\n\"Prüfexport wird von Keller Datentechnik (Zürich) gebaut, nicht intern.\"\n\nEine konkrete Handelsregisteradresse (Straße, Hausnummer, Registernummer o.ä.) ist nirgends notiert.\n\nIch habe dazu also keine belastbare Angabe. Falls du die Adresse für eine Prüfung oder Dokumentation brauchst, würde ich sie direkt im Handelsregister des Kantons Zürich (Handelsregisteramt) nachschlagen oder bei Keller Datentechnik selbst anfragen – möchtest du, dass ich das online recherchiere?"],
		["Q-de-46", "In meiner Erinnerung ist zum Abgleichlauf nur festgehalten, wann er läuft (täglich 03:40 UTC), welche Toleranzschwelle gilt (0,2 %, verschärft von der Finanzleitung) und dass ihn seit der Datenlager-Umstellung das Abrechnungsteam betreut. Von welcher Bank die Auszüge stammen, ist nirgends notiert – das habe ich nicht gespeichert.\n\nWenn das für dich relevant ist, sag mir die Bank und ich halte sie fest, oder prüfe es direkt in eurem Ticket-/Konfigurationssystem."],
		["Q-de-47", "Zu keinem konkreten Gehalt liegt bei mir etwas vor. Erinnert ist nur, dass es um die Stelle **Senior Data Engineer P4** (Lagerseite, Start Q3) geht, mit Beatrix Grünwald als Leitung des vierstufigen Auswahlverfahrens – ein Gehaltsangebot dafür wurde nirgends festgehalten. Falls das schon irgendwo genannt wurde, müsste ich es dir zuliefern lassen; sonst wäre das der nächste Punkt, den du mit Beatrix Grünwald klären müsstest."],
		["Q-de-49", "Zum Kanal **plattform-rufdienst** selbst ist keine Passwortregel hinterlegt \u2014 weder in den aktiven Notizen noch im Archiv. Bekannt ist dazu nur die Erreichbarkeitsregelung: Jörg Käser (Migrationsleitung) ist außerhalb der Arbeitszeit ausschließlich über diesen Kanal erreichbar, nicht telefonisch; das Rufdienst-Gerät liegt in der Schublade im Büro Weßling.\n\nFalls es tatsächlich eine Passwortregel für diesen Kanal gibt, ist die bei mir nicht gespeichert \u2014 dann bräuchte ich die Angabe von dir, um sie festzuhalten."],
	];
	{
		const fullFixtures = [fullEn, fullDe];
		// Everything the fixture plants or accepts, gathered the way the bench's own run gathers it.
		const knownToTheRoom = [
			...new Set([
				...fullFixtures.flatMap((fixture) => fixture.questions.flatMap((question) => [...question.gold, ...(question.trap ?? []), ...(question.distractor ?? []), question.askDate])),
				...fullFixtures.flatMap((fixture) => fixture.sessions.flatMap((session) => session.plants.flatMap((plant) => engineModule.numbersAndDatesIn(plant.line)))),
			]),
		];
		for (const [id, answer] of REJECTED_ABSTENTIONS) {
			const question = byId(id);
			assert(question.ability === "abstention", `${id} is one of the full fixture's abstention questions, and it reads as ${question.ability}`);
			const result = scoreAnswer({ question, answer, known: knownToTheRoom });
			assert(result.correct, `${id}: the room said "${answer.slice(0, 90)}...", which says it holds nothing and invents nothing, so it is a right abstention, and the scorer called it wrong (${result.why})`);
		}
		pass(`the ${REJECTED_ABSTENTIONS.length} honest abstentions of the real runs that the phrase list alone rejected score right against their own questions`);

		const hotel = byId("Q-en-42");
		const hotelTrap = (hotel.trap ?? [])[0];
		assert(hotel.ability === "abstention" && hotelTrap, `Q-en-42 is the abstention question about a hotel and lists the invented ones, and it reads ${hotel.ability} with ${JSON.stringify(hotel.trap)}`);
		const guessed = scoreAnswer({ question: hotel, answer: `That was never written down, but I believe it was the ${hotelTrap}.`, known: knownToTheRoom });
		assert(!guessed.correct, `a hedged guess stays wrong however it is negated, and the scorer called "never written down, but I believe it was the ${hotelTrap}" right (${guessed.why})`);
		const cost = byId("Q-en-44");
		assert(cost.ability === "abstention" && cost.trapPattern, `Q-en-44 is the abstention question about a cost and carries the shape of an invented amount, and it reads ${cost.ability} with ${String(cost.trapPattern)}`);
		const invented = scoreAnswer({ question: cost, answer: "Nothing was ever agreed formally, it is not a big line: it runs at about 140 EUR a month.", known: knownToTheRoom });
		assert(!invented.correct, `an invented number stays wrong however it is negated, and the scorer called "nothing was ever agreed ... about 140 EUR a month" right (${invented.why})`);
		const bare = scoreAnswer({ question: cost, answer: "The status page is hosted with the rest of the portal.", known: knownToTheRoom });
		assert(!bare.correct, `an answer that neither says it does not know nor negates anything is no abstention, and the scorer called it right (${bare.why})`);
		// A hedge followed by a number is a guess on EVERY abstention question, whatever its own trap is shaped for.
		const abstentions = fullFixtures.flatMap((fixture) => fixture.questions.filter((question) => question.ability === "abstention"));
		assert(abstentions.length === 20, `the two full fixtures ask twenty abstention questions, and they ask ${abstentions.length}`);
		const wrongOn = (answer: string): string[] => abstentions.filter((question) => !scoreAnswer({ question, answer, known: knownToTheRoom }).correct).map((question) => question.id);
		for (const hedged of ["I don't know, but it is probably 4,750 or so", "Das weiss ich nicht, vermutlich 4.750"]) {
			const wrong = wrongOn(hedged);
			assert(wrong.length === abstentions.length, `"${hedged}" hedges a guess at a number and is wrong on every abstention question, and the scorer called it right on ${abstentions.filter((question) => !wrong.includes(question.id)).map((question) => question.id).join(", ")}`);
		}
		// No hedge word, so the rule leaves both as they were: a date the room states is no guess, and a stated amount trips only the questions whose own trap is an amount or a number.
		assert(wrongOn("As of 21 July 2026, nothing on that").length === 0, `a date with no hedge before it is no guess, and the scorer called "As of 21 July 2026, nothing on that" wrong on ${wrongOn("As of 21 July 2026, nothing on that").join(", ")}`);
		const statedAmount = wrongOn("I'm not sure. What I do know: the budget is 4,750 EUR");
		assert(statedAmount.join(",") === "Q-en-41,Q-en-44,Q-de-41,Q-de-44", `an amount stated without a hedge is wrong only where the question's own trap is a number (the phone number and the cost, both languages), and it was wrong on ${statedAmount.join(", ") || "none"}`);
		pass("a hedge followed by a number is a guess on all twenty abstention questions in both languages, and a date or an amount with no hedge before it scores as it did");

		pass(`a negation beside a hedged guess ("${guessed.why}") and beside an invented number ("${invented.why}") is still wrong, and so is an answer with no not-known in it`);
	}

	// --- 13. The questions without a hint ---------------------------------------
	// A sixth class, six per language: the answer was said in passing in a
	// conversation the fold KEEPS and was never written down, and the question
	// asks in everyday words. The smoke checks the no-shared-word property with
	// a reading of its own, stricter than the fixture's: every word of four
	// letters or more counts, function words included, and beyond the words of
	// the named entity the question shares none with the planted sentence or
	// with the turn that led to it.
	{
		const wordsOf = (text: string): Set<string> => new Set(text.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").split(/[^a-z0-9]+/).filter((word) => word.length >= 4));
		for (const fixture of [fullEn, fullDe]) {
			const language = fixture.language;
			const noHint = fixture.questions.filter((question) => question.noHint);
			assert(noHint.length === 6 && fixturesModule.NO_HINT_QUESTIONS_PER_LANGUAGE === 6, `${language}: the full fixture asks six questions without a hint, and it asks ${noHint.length} (the fixture promises ${String(fixturesModule.NO_HINT_QUESTIONS_PER_LANGUAGE)})`);
			assert(JSON.stringify(fixturesModule.noHintQuestions(fixture).map((question) => question.id)) === JSON.stringify(noHint.map((question) => question.id)), `${language}: noHintQuestions lists the class as the questions carry it`);
			const others = fixture.questions.filter((question) => !question.noHint);
			assert(fixture.questions.slice(others.length).every((question) => question.noHint), `${language}: the no-hint questions come after every other question, and the order reads ${fixture.questions.slice(-8).map((question) => question.id).join(", ")}`);
			const number = (marker: string) => Number(marker.replace(/^REC-[A-Z]+/, ""));
			const allPlants = fixture.sessions.flatMap((session) => session.plants.map((plant) => ({ session, plant })));
			const highestOther = Math.max(...allPlants.filter(({ plant }) => !plant.noHint).map(({ plant }) => number(plant.marker)));
			for (const question of noHint) {
				assert(question.ability === "extraction" && !question.shape && !question.openItem && question.gold.length > 0 && question.evidence.length === 1, `${language}: ${question.id} is scored like a plain extraction question on one sentence, and it reads ${question.ability} on ${question.evidence.length}`);
				const found = allPlants.find(({ plant }) => plant.marker === question.evidence[0].marker);
				assert(found && found.plant.noHint && found.plant.noted === false, `${language}: ${question.id} rests on a no-hint sentence that was never noted, and ${question.evidence[0].marker} reads ${JSON.stringify(found?.plant)}`);
				const { session, plant } = found;
				assert(number(plant.marker) > highestOther, `${language}: ${plant.marker} is numbered after every other plant, the highest of which is ${highestOther}`);
				assert(!session.recentContextEntry.includes(plant.marker) && session.plants.some((candidate) => candidate.noted !== false) && session.recentContextEntry.includes("<!-- plant"), `${language}: ${session.id} notes other things and not ${plant.marker}, so the fold keeps the conversation and no note carries the sentence`);
				const at = session.turns.findIndex((turn) => turn.text === plant.line);
				assert(at > 0 && session.turns[at].role === "assistant" && session.turns[at - 1].role === "user", `${language}: ${plant.marker} is said by the room in ${session.id}, in answer to a turn of the user`);
				const entity = question.entity ?? "";
				assert(entity.length > 0 && question.question.includes(entity) && `${session.turns[at - 1].text} ${plant.line}`.includes(entity), `${language}: ${question.id} and the exchange of ${plant.marker} both name the entity "${entity}"`);
				const allowed = wordsOf(entity);
				for (const text of [plant.line, session.turns[at - 1].text]) {
					const shared = [...wordsOf(question.question)].filter((word) => wordsOf(text).has(word) && !allowed.has(word));
					assert(shared.length === 0, `${language}: ${question.id} asks "${question.question}" and shares ${shared.map((word) => `"${word}"`).join(", ")} with "${text}"; beyond "${entity}" it shares no word`);
				}
			}
			const early = noHint.filter((question) => Number(question.evidence[0].sessionId.slice(1)) <= 8);
			assert(early.length >= 2, `${language}: at least two no-hint sentences are said inside the first eight sittings, so a small run holds the class, and ${early.length} are`);
			pass(`${language}: ${noHint.map((question) => question.id).join(", ")} are asked without a hint: six sentences said in passing in folded sittings, never noted, numbered after every other marker, sharing no word with their questions beyond the entity`);
		}

		// In a run. The eight-sitting interleaved run of section 8 (German, nobody
		// asked) already holds two of them: its rows say `noHint` and sit in
		// `conversation`, the forgetting table prints the column, and the summary
		// counts them. One more small run ASKS the English room, so the column
		// and the line carry a score and the summary carries the narration count.
		const deRows = results.runs[0].rows.filter((row) => row.noHint);
		assert(deRows.length === 2 && deRows.every((row) => row.location === "conversation" && row.ability === "extraction"), `de: the small run holds two no-hint rows, both in conversation, and it holds ${JSON.stringify(deRows.map((row) => [row.id, row.location]))}`);
		assert(results.runs[0].summary.noHint?.questions === 2 && results.runs[0].summary.noHint.answered === 0, `de: the small run's summary counts two no-hint questions and none asked, and it reads ${JSON.stringify(results.runs[0].summary.noHint)}`);
		const columnLine = (stdout: string) => stdout.split("\n").find((line) => /^ability\s+core\s/.test(line)) ?? "";
		assert(/\sall\s+no hint$/.test(columnLine(small.stdout)), `de: the forgetting table ends on the columns "all" and "no hint", and its header reads "${columnLine(small.stdout)}"`);
		assert(/^no hint: 2 question\(s\) in conversation · recall finds literal 2\/2, paraphrase \d\/2, variant 2\/2 · not asked$/m.test(small.stdout), `de: the run prints its no-hint line, and printed:\n${small.stdout.split("\n").filter((line) => line.startsWith("no hint")).join("\n") || "(none)"}`);
		assert(/^no hint right before\/after \(de\): - before, - after · reported, never a gate$/m.test(gated.stdout), `de: the gated run reports the no-hint score before and after beside the gate, and printed:\n${gated.stdout.split("\n").filter((line) => line.startsWith("no hint")).join("\n") || "(none)"}`);

		const askedOut = path.join(home, "recall-smoke-no-hint-asked.json");
		const askedRun = bench(["--ask", "--language", "en", "--sessions", "8", "--per-ability", "1", "--fold-every", "3", "--out", askedOut]);
		assert(askedRun.status === 0, `the small asked run exited ${askedRun.status}:\n${askedRun.stdout.slice(-1600)}\n${askedRun.stderr.slice(-400)}`);
		const askedFile = JSON.parse(fs.readFileSync(askedOut, "utf-8")) as { runs: Array<{ summary: RecallRunSummary; rows: RecallResultRow[] }> };
		const enRows = askedFile.runs[0].rows.filter((row) => row.noHint);
		assert(enRows.length === 2 && enRows.every((row) => row.location === "conversation"), `en: the small run holds two no-hint rows, both in conversation, and it holds ${JSON.stringify(enRows.map((row) => [row.id, row.location]))}`);
		assert(enRows.every((row) => row.answered === true), `en: the scripted room searches with the literal query and quotes what comes back, so it reaches both no-hint sentences, and it answered ${JSON.stringify(enRows.map((row) => [row.id, row.answered, row.why]))}`);
		assert(JSON.stringify(askedFile.runs[0].summary.noHint) === JSON.stringify({ questions: 2, answered: 2, correct: 2 }), `en: the summary counts the no-hint questions on their own, and it reads ${JSON.stringify(askedFile.runs[0].summary.noHint)}`);
		const extractionLine = askedRun.stdout.split("\n").find((line) => /^extraction\s/.test(line)) ?? "";
		assert(/\sall\s+no hint$/.test(columnLine(askedRun.stdout)) && /\s2\/2 100%$/.test(extractionLine), `en: the "no hint" column reads 2/2 100% on the extraction row, and the rows read "${columnLine(askedRun.stdout)}" and "${extractionLine}"`);
		const abilityRight = askedFile.runs[0].rows.filter((row) => !row.shape && !row.noHint && row.answered === true).length;
		const abilityAsked = askedFile.runs[0].rows.filter((row) => !row.shape && !row.noHint && row.answered !== null).length;
		assert(new RegExp(`^ask: ${abilityRight}/${abilityAsked} right`, "m").test(askedRun.stdout), `en: the ask line counts the abilities' ${abilityAsked} questions and leaves the no-hint ones to their own line, and printed "${askedRun.stdout.split("\n").find((line) => line.startsWith("ask:")) ?? "(no ask line)"}"`);
		assert(/^no hint: 2 question\(s\) in conversation · .* · 2\/2 right$/m.test(askedRun.stdout), `en: the no-hint line carries the score, and printed:\n${askedRun.stdout.split("\n").filter((line) => line.startsWith("no hint")).join("\n") || "(none)"}`);
		pass(`in a run the no-hint rows sit in conversation and in no ability table: the column "no hint" is printed (de 2/-, en 2/2 100%), the summary counts them, and the gated run reports them beside the gate`);

		// --- 14. The answers that name the mechanism ------------------------------
		// A count per run, beside the score and never a gate: the answers that say
		// where a fact sits or that it was looked for. The matcher reads whole
		// words side by side in the scorer's own spelling, in both languages.
		const narrates = engineModule.narratesMechanism;
		assert(typeof narrates === "function", "the engine exports narratesMechanism, the matcher the narration count is made with");
		const NARRATING: ReadonlyArray<readonly [string, string]> = [
			["I don't have any record of that in my memory.", "in my memory"],
			["Nothing in memory gives a headcount for the risk team.", "in memory"],
			["Let me check. The export runs on port 8443.", "let me check"],
			["What's on record: they run the annual access review.", "on record"],
			["In meiner Erinnerung ist dazu nur festgehalten, wann er läuft.", "in meiner erinnerung"],
			["Dazu ist nichts hinterlegt, weder in den aktiven Notizen noch im Archiv.", "in den aktiven notizen"],
			["Das steht so im Archiv.", "im archiv"],
			["Ein Gehaltsangebot wurde nirgends festgehalten.", "festgehalten"],
		];
		for (const [answer, phrase] of NARRATING) assert(narrates(answer) === phrase, `"${answer}" names the mechanism with "${phrase}", and the matcher found ${JSON.stringify(narrates(answer))}`);
		const PLAIN = ["I don't have a number for that.", "The export runs on port 8443.", "No deputy has been named yet.", "The recorded figure is 7,100 EUR.", "Dazu habe ich keine Zahl.", "Frau Müller zeichnet das Nachweispaket ab.", "Die Archivdatei ist signiert."];
		for (const answer of PLAIN) assert(narrates(answer) === null, `"${answer}" names no mechanism, and the matcher found "${String(narrates(answer))}"`);
		const counted = askedFile.runs[0].summary.narrates;
		const answeredRows = askedFile.runs[0].rows.filter((row) => row.answered !== null);
		assert(counted && counted.answers === answeredRows.length && counted.narrating === answeredRows.filter((row) => narrates(row.answer ?? "") !== null).length, `the asked run's summary carries narrates over its ${answeredRows.length} answers, and it carries ${JSON.stringify(counted)}`);
		assert(new RegExp(`^narrates: ${counted.narrating} of ${counted.answers} answers name the mechanism`, "m").test(askedRun.stdout), `the asked run prints the narration count under its score, and printed "${askedRun.stdout.split("\n").find((line) => line.startsWith("narrates")) ?? "(no narrates line)"}"`);
		assert(results.runs[0].summary.narrates === undefined, `a run that asked nobody carries no narration count, and the interleaved run carries ${JSON.stringify(results.runs[0].summary.narrates)}`);
		pass(`the narration matcher hits ${NARRATING.length} wordings and leaves ${PLAIN.length} plain answers alone, and the asked run reports narrates ${counted.narrating} of ${counted.answers} in its summary and under its score`);

		// --- 15. The answers that cite an internal id ------------------------------
		// A second count per run, under the narration count and never a gate: the
		// answers that name a conversation or a note by an id only the tools can
		// read. A whole token, three or four digits; RC in either case, m- in
		// lowercase only.
		const cites = engineModule.citesInternalId;
		assert(typeof cites === "function", "the engine exports citesInternalId, the matcher the internal-id count is made with");
		const CITING: ReadonlyArray<readonly [string, string]> = [
			["That was settled per RC-0004 on 7 April.", "RC-0004"],
			["Das steht in der Konversation (RC-0003) vom 07.04.2026.", "RC-0003"],
			["In RC-0001, on 7 April, the renewal was agreed.", "RC-0001"],
			["The renewal is annual, see m-0031.", "m-0031"],
			["The older wording is kept as m-0031-v1.", "m-0031"],
			["It came up in rc-0012 and again in RC-0014.", "rc-0012"],
			["A shortened id still counts: RC-004.", "RC-004"],
		];
		for (const [answer, id] of CITING) assert(cites(answer) === id, `"${answer}" cites the internal id "${id}", and the matcher found ${JSON.stringify(cites(answer))}`);
		const NOT_CITING = ["The ARC-0004 form was filed on 7 April.", "The ticket RC-00045 is closed.", "RC-04 is the room on the second floor.", "The m-12 bolt is out of stock.", "The am-0031 band is reserved.", "Use form-0031 for the claim.", "The part RC-0004x was replaced.", "The M-0031 motorway exit is closed.", "The renewal was agreed on 7 April, in the talk about the Nordwind contract.", "Das wurde am 07.04.2026 im Gespräch über den Vertrag vereinbart."];
		for (const answer of NOT_CITING) assert(cites(answer) === null, `"${answer}" cites no internal id, and the matcher found "${String(cites(answer))}"`);

		// In the asked run: the summary carries the count over the same answers
		// the narration count reads, and the line sits under the narrates line.
		const idsCounted = askedFile.runs[0].summary.internalIds;
		assert(idsCounted && idsCounted.answers === answeredRows.length && idsCounted.citing === answeredRows.filter((row) => cites(row.answer ?? "") !== null).length, `the asked run's summary carries internalIds over its ${answeredRows.length} answers, and it carries ${JSON.stringify(idsCounted)}`);
		const askedLines = askedRun.stdout.split("\n");
		const narratesAt = askedLines.findIndex((line) => line.startsWith("narrates: "));
		assert(narratesAt >= 0 && new RegExp(`^internal ids: ${idsCounted.citing} of ${idsCounted.answers} answers cite an internal id`).test(askedLines[narratesAt + 1] ?? ""), `the asked run prints the internal-id count under its narrates line, and printed "${askedLines.find((line) => line.startsWith("internal ids")) ?? "(no internal ids line)"}"`);
		assert(results.runs[0].summary.internalIds === undefined && !/^internal ids/m.test(small.stdout), `a run that asked nobody carries no internal-id count and prints no such line, and the interleaved run carries ${JSON.stringify(results.runs[0].summary.internalIds)}`);

		// A run with exactly one citing answer, scripted by hand: three answered
		// rows and one nobody asked, summarised by the bench's own builder.
		const idRows: RecallResultRow[] = runs[0].rows.slice(0, 4).map((row, index) => ({ ...row, answered: index === 3 ? null : index !== 2, answer: ["The renewal was agreed on 7 April.", "Per RC-0004 the renewal was agreed on 7 April.", "I don't know.", "Per RC-0009, never asked."][index] }));
		assert(idRows.length === 4, `the first run holds at least four rows to script, and it holds ${runs[0].rows.length}`);
		const idSummary = await buildRunSummary({ roomId: ceilingRoom.roomId, language: ceilingLanguage, seed: ceilingFixture.seed, sessions: ceilingFixture.sessions.length, rows: idRows, backHistoryNotes: ceilingRoom.backHistoryNotes, markers: [] });
		assert(JSON.stringify(idSummary.internalIds) === JSON.stringify({ answers: 3, citing: 1 }), `a run of three answers, one of which cites RC-0004, carries internalIds { answers: 3, citing: 1 }, and it carries ${JSON.stringify(idSummary.internalIds)}`);
		const idsLine = engineModule.internalIdsLine;
		assert(typeof idsLine === "function", "the engine exports internalIdsLine, the line a run prints under its narration count");
		assert(idsLine(idSummary) === "internal ids: 1 of 3 answers cite an internal id (RC-0004, m-0031) · reported, never a gate", `the line of that run reads "internal ids: 1 of 3 answers cite an internal id (RC-0004, m-0031) · reported, never a gate", and it reads ${JSON.stringify(idsLine(idSummary))}`);
		assert(idsLine({}) === null, `a summary without the count has no line, and it has ${JSON.stringify(idsLine({}))}`);

		// Never a gate: an id beside an answer moves no verdict, right or wrong,
		// and the asked run above exited 0 with its count printed.
		const rightQuestion = ceilingFixture.questions.find((question) => verdicts.get(question.id)?.correct === true);
		const wrongQuestion = ceilingFixture.questions.find((question) => verdicts.get(question.id)?.correct === false);
		assert(rightQuestion && wrongQuestion, `${ceilingLanguage}: the ceiling room holds a question answered right and one answered wrong`);
		for (const question of [rightQuestion, wrongQuestion]) {
			const said = verdicts.get(question.id)?.answer ?? "";
			const plain = scoreAnswer({ question, answer: said }).correct;
			const citing = scoreAnswer({ question, answer: `${said} (RC-0004)` }).correct;
			assert(cites(`${said} (RC-0004)`) !== null && citing === plain, `${question.id}: the same answer with "(RC-0004)" beside it is counted as citing and scored ${plain ? "right" : "wrong"} as before, and it was scored ${citing ? "right" : "wrong"}`);
		}
		assert(askedRun.status === 0, `the asked run exits 0 with its internal-id count printed, and it exited ${askedRun.status}`);
		pass(`the internal-id matcher hits ${CITING.length} citing answers and leaves ${NOT_CITING.length} alone, the asked run reports internal ids ${idsCounted.citing} of ${idsCounted.answers} in its summary and under its narrates line, a scripted run with one citing answer counts 1 of 3, and an id beside an answer moves no verdict`);
	}

	// --- 10. The LongMemEval adapter, end to end, through a provider's bad hour --
	// The adapter's pure halves are pinned above; this section runs the command
	// itself, as a child, on a hand-written data file of three instances, against
	// the scripted gateway told to fail on cue. What is pinned is what a run of
	// fifty instances over five hours needs and once lacked: the provider is
	// waited out and the run carries on; an instance the provider never answers
	// is marked failed in the meta, kept out of the hypothesis file, and does not
	// end the run; every answer is on disk the moment it exists; a run that died
	// is carried on with --resume and never silently overwritten or silently
	// resumed; and an interrupt leaves the meta behind. The waits are ten
	// milliseconds here, through the schedule hook, where a real run waits up to
	// an hour.
	const lmeData = path.join(home, "longmemeval-smoke-data.json");
	const lmeMarker = "ZYGOMORPHIC";
	const lmeInstances: LongMemEvalInstance[] = [
		{ question_id: "smoke_lme_a", question_type: "multi-session", question: "Which port does the export run on?", answer: "8443", question_date: "2023/06/02 (Fri) 09:15", haystack_session_ids: ["a-1", "a-2"], haystack_dates: ["2023/04/10 (Mon) 23:07", "2023/04/12 (Wed) 08:30"], haystack_sessions: [[{ role: "user", content: "The export runs on port 8443 since the move." }, { role: "assistant", content: "Noted, port 8443." }], [{ role: "user", content: "The vendor contract ceiling is 55,000 EUR." }, { role: "assistant", content: "Noted." }]] },
		{ question_id: "smoke_lme_b", question_type: "single-session-user", question: "What is the code name of the orchid project?", answer: lmeMarker, question_date: "2023/06/03 (Sat) 10:00", haystack_session_ids: ["b-1"], haystack_dates: ["2023/04/11 (Tue) 12:00"], haystack_sessions: [[{ role: "user", content: `The orchid project's code name is ${lmeMarker}, keep it to yourself.` }, { role: "assistant", content: "Understood." }]] },
		{ question_id: "smoke_lme_c_abs", question_type: "knowledge-update", question: "Which day was the audit moved to?", answer: "The audit was never mentioned.", question_date: "2023/06/04 (Sun) 11:00", haystack_session_ids: ["c-1"], haystack_dates: ["2023/04/13 (Thu) 14:00"], haystack_sessions: [[{ role: "user", content: "The kickoff is on the fourth of May." }, { role: "assistant", content: "Noted." }]] },
	];
	fs.writeFileSync(lmeData, JSON.stringify(lmeInstances));
	const lmeIds = lmeInstances.map((instance) => instance.question_id);
	const lmeMarked = "smoke_lme_b";
	const adapterScript = "scripts/memory-bench/longmemeval-adapter.mts";
	const adapter = (args: string[], env: Record<string, string> = {}): { status: number | null; stdout: string; stderr: string } => {
		const run = spawnSync("npx", ["tsx", adapterScript, "--scripted", "--data", lmeData, ...args], { cwd: webServerDir, shell: process.platform === "win32", encoding: "utf-8", env: { ...process.env, RECALL_BENCH_RETRY_SCHEDULE_MS: "10,10,10,10,10", ...env }, maxBuffer: 64 * 1024 * 1024 });
		return { status: run.status, stdout: run.stdout ?? "", stderr: run.stderr ?? "" };
	};
	const jsonlIds = (file: string): string[] => fs.readFileSync(file, "utf-8").split("\n").filter((line) => line.trim()).map((line) => (JSON.parse(line) as { question_id: string }).question_id);
	const readMeta = (file: string) => JSON.parse(fs.readFileSync(`${file}.meta.json`, "utf-8")) as { partial: boolean; answered: number; claims?: { memorized: number; unindexed: number; misassigned: number }; failures: Array<{ question_id: string; failure: string }>; resumedFrom: { file: string; answeredBefore: number } | null; rows: Array<{ question_id: string; hypothesis: string | null; failure?: string; sessions?: number; claims?: { memorized: number; unindexed: number; misassigned: number } }> };

	// (e) The dry run names the sample, in order, and builds nothing.
	const lmeDry = adapter(["--out", path.join(home, "lme-dry.jsonl"), "--dry-run"]);
	assert(lmeDry.status === 0, `the adapter's dry run exited ${lmeDry.status}:\n${lmeDry.stdout.slice(-600)}\n${lmeDry.stderr.slice(-400)}`);
	assert(new RegExp(`^sample: ${lmeIds.join(", ")}$`, "m").test(lmeDry.stdout), `the dry run prints the sample's question ids in order on one line, "sample: ${lmeIds.join(", ")}", and printed:\n${lmeDry.stdout.split("\n").filter((line) => line.startsWith("sample")).join("\n") || "(no sample line)"}`);
	assert(!fs.existsSync(path.join(home, "lme-dry.jsonl")), `a dry run writes no hypothesis file, and ${path.join(home, "lme-dry.jsonl")} is there`);
	pass(`the adapter's dry run prints the sample's ${lmeIds.length} question ids in order and writes nothing`);

	// (a) The provider fails once: the run waits, tries again, and answers everything.
	const lmeOnce = path.join(home, "lme-once.jsonl");
	const once = adapter(["--out", lmeOnce], { RECALL_BENCH_SCRIPTED_FAIL: `${lmeMarker}:1` });
	assert(once.status === 0, `the run with one scripted failure exited ${once.status}:\n${once.stdout.slice(-1200)}\n${once.stderr.slice(-600)}`);
	const waitLine = once.stdout.split("\n").find((line) => /^provider error on checkpoint compression worker \(.*\): waiting .* before attempt 2 of 6$/.test(line));
	assert(waitLine, `a checkpoint the provider refused once prints one line, "provider error on checkpoint compression worker (...): waiting ... before attempt 2 of 6", and the run printed:\n${once.stdout.split("\n").filter((line) => line.includes("provider error")).join("\n") || "(no provider error line)"}`);
	assert(!once.stdout.includes("attempt 3 of 6"), `the failure clears after one attempt, so no third attempt is announced, and the run printed:\n${once.stdout.split("\n").filter((line) => line.includes("attempt")).join("\n")}`);
	assert(JSON.stringify(jsonlIds(lmeOnce)) === JSON.stringify(lmeIds), `every instance is answered and its line is in the hypothesis file, in order, and the file holds ${JSON.stringify(jsonlIds(lmeOnce))}`);
	const onceMeta = readMeta(lmeOnce);
	assert(onceMeta.failures.length === 0 && onceMeta.partial === false && onceMeta.answered === lmeIds.length, `the meta of a run that waited a failure out has no failures and is not partial, and it reads partial=${onceMeta.partial}, answered=${onceMeta.answered}, failures=${JSON.stringify(onceMeta.failures)}`);
	pass(`a provider that fails once is waited out: "${waitLine}", every instance answered, no failures, exit 0`);

	// (a2) The claim audit of the same run: one indented line per instance under
	// its ingest summary, the audit in every meta row, and the sum once in the
	// final summary. The scripted folds keep nothing, so every conversation here
	// is DROPPED, and a dropped conversation is memorized and indexed like any
	// other: four memorized over the three instances, none missing.
	const instanceClaimLines = once.stdout.split("\n").filter((line) => /^  claims: \d+ memorized, \d+ unindexed, \d+ misassigned$/.test(line));
	assert(instanceClaimLines.length === lmeIds.length, `the adapter prints one claims line per instance under its ingest summary, and printed ${instanceClaimLines.length}:\n${once.stdout.split("\n").filter((line) => line.includes("claims")).join("\n") || "(no claims line)"}`);
	for (const row of onceMeta.rows) {
		assert(row.claims && row.claims.memorized === row.sessions && row.claims.unindexed === 0 && row.claims.misassigned === 0, `the meta row of ${row.question_id} carries its claim audit, its ${row.sessions} conversation(s) memorized and both defect counts zero, and it carries ${JSON.stringify(row.claims)}`);
	}
	const totalLines = once.stdout.split("\n").filter((line) => /^claims: \d+ memorized, \d+ unindexed, \d+ misassigned$/.test(line));
	assert(totalLines.length === 1 && totalLines[0] === "claims: 4 memorized, 0 unindexed, 0 misassigned", `the final summary sums the audit once, "claims: 4 memorized, 0 unindexed, 0 misassigned", and the run printed: ${totalLines.join(" | ") || "(no summed claims line)"}`);
	assert(onceMeta.claims && onceMeta.claims.memorized === 4 && onceMeta.claims.unindexed === 0 && onceMeta.claims.misassigned === 0, `the meta carries the summed audit, and it carries ${JSON.stringify(onceMeta.claims)}`);
	assert(!once.stdout.includes("CLAIM AUDIT FAILED"), "a run whose audit reads zero does not say the audit failed");
	pass(`the adapter prints a claims line per instance, carries the audit in every meta row, and sums it once: "${totalLines[0]}"`);

	// (b) The provider never answers one instance: that instance is a failure row
	// with no line, the others are answered, and the run exits 0.
	const lmeAll = path.join(home, "lme-all.jsonl");
	const always = adapter(["--out", lmeAll], { RECALL_BENCH_SCRIPTED_FAIL: `${lmeMarker}:all` });
	assert(always.status === 0, `the run whose marked instance the provider never answers exited ${always.status}; the other instances were answered, so 0 was expected:\n${always.stdout.slice(-1200)}\n${always.stderr.slice(-600)}`);
	const allMeta = readMeta(lmeAll);
	const failedRow = allMeta.rows.find((row) => row.question_id === lmeMarked);
	assert(failedRow && failedRow.hypothesis === null, `the marked instance's meta row carries hypothesis null, and it reads ${JSON.stringify(failedRow)}`);
	assert(failedRow.failure && /ingest/.test(failedRow.failure) && /checkpoint compression worker/.test(failedRow.failure) && /scripted provider failure/.test(failedRow.failure), `the failure sentence names the step, the checkpoint compression worker and the provider's message, and it reads "${failedRow.failure}"`);
	assert(allMeta.failures.length === 1 && allMeta.failures[0].question_id === lmeMarked, `the meta lists the one failure by id, and it lists ${JSON.stringify(allMeta.failures)}`);
	assert(allMeta.partial === false, `a run that reached every instance is not partial although one failed, and the meta says partial=${allMeta.partial}`);
	const answeredIds = lmeIds.filter((id) => id !== lmeMarked);
	assert(JSON.stringify(jsonlIds(lmeAll)) === JSON.stringify(answeredIds), `the hypothesis file holds the answered instances only, ${JSON.stringify(answeredIds)}, and it holds ${JSON.stringify(jsonlIds(lmeAll))}`);
	assert(/^summary: 2 answered, 1 failed/m.test(always.stdout), `the summary line counts the failure, "summary: 2 answered, 1 failed", and the run printed:\n${always.stdout.split("\n").filter((line) => line.startsWith("summary")).join("\n") || "(no summary line)"}`);
	assert(always.stdout.split("\n").filter((line) => line.startsWith("failed smoke_lme_b:")).length === 1, `the failure is listed once at the end, and the run printed:\n${always.stdout.split("\n").filter((line) => line.startsWith("failed")).join("\n") || "(no failed line)"}`);
	pass(`an instance the provider never answers is a failure row with no line: "${failedRow.failure}", the other ${answeredIds.length} answered, summary names 1 failure, exit 0`);

	// (d) Incremental: the file's lines are exactly the answered rows, which is
	// only possible when each line was written as its instance finished.
	assert(jsonlIds(lmeAll).length === allMeta.rows.filter((row) => row.hypothesis !== null).length, `the hypothesis file's ${jsonlIds(lmeAll).length} line(s) equal the ${allMeta.rows.filter((row) => row.hypothesis !== null).length} answered row(s) of the meta`);
	pass(`the hypothesis file holds one line per answered row and nothing for the failed one`);

	// (c) Resume: the answered ids are skipped, the failed one is tried again and
	// succeeds now that the provider answers, and the meta says what it resumed.
	const resumed = adapter(["--resume", lmeAll]);
	assert(resumed.status === 0, `the resumed run exited ${resumed.status}:\n${resumed.stdout.slice(-1200)}\n${resumed.stderr.slice(-600)}`);
	assert(new RegExp(`^resume: ${answeredIds.length} of ${lmeIds.length} already answered in .*, 1 to go`, "m").test(resumed.stdout), `the resumed run says how many are already answered, "resume: ${answeredIds.length} of ${lmeIds.length} already answered in <file>, 1 to go", and printed:\n${resumed.stdout.split("\n").filter((line) => line.startsWith("resume")).join("\n") || "(no resume line)"}`);
	assert(/^\[1\/1\] smoke_lme_b/m.test(resumed.stdout) && !/smoke_lme_a · multi-session/.test(resumed.stdout), `only the failed instance is run again, as [1/1], and the run printed:\n${resumed.stdout.split("\n").filter((line) => /^\[\d+\/\d+\]/.test(line)).join("\n")}`);
	assert(JSON.stringify([...jsonlIds(lmeAll)].sort()) === JSON.stringify([...lmeIds].sort()) && jsonlIds(lmeAll).length === lmeIds.length, `after the resume the hypothesis file holds every instance once, and it holds ${JSON.stringify(jsonlIds(lmeAll))}`);
	const resumedMeta = readMeta(lmeAll);
	assert(resumedMeta.resumedFrom?.file === lmeAll && resumedMeta.resumedFrom.answeredBefore === answeredIds.length, `the meta says what it resumed from and how many were answered before, and reads ${JSON.stringify(resumedMeta.resumedFrom)}`);
	assert(resumedMeta.failures.length === 0 && resumedMeta.rows.length === lmeIds.length && resumedMeta.rows.every((row) => typeof row.hypothesis === "string"), `the resumed meta carries every instance answered and no failure, and it carries ${resumedMeta.rows.length} row(s), ${resumedMeta.failures.length} failure(s)`);
	pass(`--resume skips the ${answeredIds.length} answered instances, answers the failed one, and the meta says resumedFrom`);

	const overwrite = adapter(["--out", lmeAll]);
	assert(overwrite.status !== 0, `a run pointed at an existing file without --resume must refuse, and it exited ${overwrite.status}`);
	assert(/is already there: pass --resume/.test(overwrite.stdout), `the refusal is one sentence naming --resume, and the run printed:\n${overwrite.stdout.slice(-400)}`);
	assert(jsonlIds(lmeAll).length === lmeIds.length, `the refused run left the file as it was, and it now holds ${jsonlIds(lmeAll).length} line(s)`);
	pass(`an existing --out without --resume is refused with a sentence naming --resume, and the file is untouched`);

	// On Windows a kill is a termination, never a signal the child can catch, so
	// the interrupt case runs where SIGINT reaches a process.
	if (process.platform !== "win32") {
		// (f) An interrupt: the adapter is started without a wrapper process so the
		// signal reaches it, sent SIGINT once its first answer is printed, and must
		// leave with 130, the answers so far in the file and a meta that says partial.
		const lmeInt = path.join(home, "lme-interrupted.jsonl");
		const interrupted = await new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }>((resolve) => {
			const child = spawn(process.execPath, ["--import", "tsx", adapterScript, "--scripted", "--data", lmeData, "--out", lmeInt], { cwd: webServerDir, env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let sent = false;
			child.stdout.on("data", (chunk) => {
				stdout += String(chunk);
				if (!sent && /answered in \d+s/.test(stdout)) {
					sent = true;
					child.kill("SIGINT");
				}
			});
			child.stderr.on("data", (chunk) => { stdout += String(chunk); });
			child.on("exit", (code, signal) => resolve({ code, signal, stdout }));
		});
		assert(interrupted.code === 130, `an interrupted run leaves with 130, and it left with code ${interrupted.code}, signal ${interrupted.signal}:\n${interrupted.stdout.slice(-800)}`);
		assert(/^interrupted: \d+ answered/m.test(interrupted.stdout), `an interrupted run says so, and printed:\n${interrupted.stdout.slice(-600)}`);
		assert(fs.existsSync(`${lmeInt}.meta.json`), `an interrupted run leaves its meta behind, and ${lmeInt}.meta.json is not there`);
		const intMeta = readMeta(lmeInt);
		assert(intMeta.partial === true, `the meta of an interrupted run says partial, and it says partial=${intMeta.partial}`);
		assert(jsonlIds(lmeInt).length >= 1 && jsonlIds(lmeInt).length === intMeta.rows.filter((row) => row.hypothesis !== null).length && jsonlIds(lmeInt).length < lmeIds.length, `the interrupted run's file holds the answers it got before the interrupt, one line per answered row and fewer than the ${lmeIds.length} instances, and it holds ${jsonlIds(lmeInt).length} line(s) against ${intMeta.rows.length} row(s)`);
		pass(`an interrupt leaves with 130, ${jsonlIds(lmeInt).length} answer(s) in the file and a meta that says partial`);
	} else {
		pass("the interrupt case is not run on Windows, where a kill delivers no SIGINT");
	}

	// (f) The provider ends the ROOM'S OWN turn: the turn still ends the way
	// every turn ends, with no text in it, and taken as an answer it would be an
	// empty hypothesis scored as the room's own. It is a failed attempt, waited
	// out like any other, and the instance is marked failed at the ask. The
	// marker is the ask's own opening, which no checkpoint or fold carries.
	const lmeAsk = path.join(home, "lme-ask.jsonl");
	const askFails = adapter(["--out", lmeAsk], { RECALL_BENCH_SCRIPTED_FAIL: "Today is 2023-06-04:all" });
	assert(askFails.status === 0, `the run whose last instance the provider never answers at the ask exited ${askFails.status}; the others were answered, so 0 was expected:\n${askFails.stdout.slice(-1200)}\n${askFails.stderr.slice(-600)}`);
	const askMeta = readMeta(lmeAsk);
	assert(askMeta.failures.length === 1 && askMeta.failures[0].question_id === "smoke_lme_c_abs" && /^The ask of smoke_lme_c_abs failed: /.test(askMeta.failures[0].failure), `a turn the provider ended marks its instance failed at the ask, and the meta's failures read ${JSON.stringify(askMeta.failures)}`);
	assert(/provider error on the ask of smoke_lme_c_abs \(the room's turn was ended by the provider: /.test(askFails.stdout), `the first failed ask says the provider ended the turn, and the run printed:\n${askFails.stdout.split("\n").filter((line) => line.includes("provider error")).join("\n")}`);
	assert(JSON.stringify(jsonlIds(lmeAsk)) === JSON.stringify(lmeIds.filter((id) => id !== "smoke_lme_c_abs")), `no empty hypothesis is written for the turn the provider ended, and the file holds ${JSON.stringify(jsonlIds(lmeAsk))}`);
	assert(!fs.readFileSync(lmeAsk, "utf-8").includes('"hypothesis":""'), "no line of the hypothesis file carries an empty hypothesis");
	pass(`a turn the provider ended is a failed ask, never an empty answer: ${askMeta.failures[0].question_id} is marked, ${jsonlIds(lmeAsk).length} answered, exit 0`);

	// (g) The provider refuses every FOLD. The product's run turns a fold that
	// gave up into a conversation left waiting and carries on; a measurement
	// must not score a room that was never told its conversations, so the
	// Memorize ends unapproved and the instance is marked failed at the ingest.
	// The run neither hangs on the Memorize's own time limit nor waits the whole
	// schedule once per conversation, and with no instance answered it exits 1.
	const lmeFold = path.join(home, "lme-fold.jsonl");
	const foldFails = adapter(["--out", lmeFold], { RECALL_BENCH_SCRIPTED_FAIL: "Fold this session into memory now.:all" });
	assert(foldFails.status === 1, `a run in which every instance failed exits 1, and this one exited ${foldFails.status}:\n${foldFails.stdout.slice(-1200)}\n${foldFails.stderr.slice(-600)}`);
	const foldMeta = readMeta(lmeFold);
	assert(foldMeta.failures.length === lmeIds.length && foldMeta.failures.every((row) => /failed: memorize fold worker gave up after \d+ attempts?, /.test(row.failure) && /^The ingest of /.test(row.failure)), `every instance is marked failed at the ingest, naming the fold worker, and the meta's failures read ${JSON.stringify(foldMeta.failures)}`);
	assert(foldMeta.partial === false && jsonlIds(lmeFold).length === 0, `the run reached every instance (not partial) and wrote no line, and it reads partial=${foldMeta.partial} with ${jsonlIds(lmeFold).length} line(s)`);
	assert(!/was still in state/.test(foldFails.stdout + foldFails.stderr), "a fold that is being waited out never trips the Memorize's own time limit");
	pass(`a provider that refuses every fold marks all ${lmeIds.length} instances failed at the ingest, writes no line, and exits 1`);

	// (h) A call that HANGS. A provider that has stopped talking does not fail
	// the call, it holds it, and the worker's own limit is what ends it; that
	// whole limit is wall time the Memorize's limit must not read as its own.
	// One fold is held open once, past a worker limit shrunk to 1.5 s, under a
	// Memorize limit shrunk to 1 s: without the accounting the Memorize reads as
	// hung and the run breaks; with it the fold is stopped, tried again,
	// answered, and everything is answered.
	const lmeHangOnce = path.join(home, "lme-hang-once.jsonl");
	const hangOnce = adapter(["--out", lmeHangOnce], { RECALL_BENCH_SCRIPTED_FAIL: "Fold this session into memory now.:1:hang", RECALL_BENCH_WORKER_TIMEOUT_MS: "1500", RECALL_BENCH_SETTLE_TIMEOUT_MS: "1000" });
	assert(hangOnce.status === 0, `the run whose one fold hung past its limit exited ${hangOnce.status}; every instance was answerable, so 0 was expected:\n${hangOnce.stdout.slice(-1200)}\n${hangOnce.stderr.slice(-600)}`);
	assert(/provider error on memorize fold worker \(it ran past its 2 second limit and was stopped\): waiting/.test(hangOnce.stdout), `a fold that hung is stopped by its limit and waited out like a refusal, and the run printed:\n${hangOnce.stdout.split("\n").filter((line) => line.includes("provider error")).join("\n")}`);
	assert(!/was still in state/.test(hangOnce.stdout + hangOnce.stderr), "the time the hung call took is not read as the Memorize's own");
	assert(JSON.stringify(jsonlIds(lmeHangOnce)) === JSON.stringify(lmeIds) && readMeta(lmeHangOnce).failures.length === 0, `every instance is answered after the one hang, and the file holds ${JSON.stringify(jsonlIds(lmeHangOnce))}`);
	pass(`a fold that hangs past its limit is stopped, waited out and tried again; every instance answered, exit 0`);

	// (i) A provider that never answers one instance's checkpoints, by holding
	// them: each attempt costs the worker limit, the schedule runs out, the
	// instance is marked failed at the ingest and the run carries on.
	const lmeHangAll = path.join(home, "lme-hang-all.jsonl");
	const hangAll = adapter(["--out", lmeHangAll], { RECALL_BENCH_SCRIPTED_FAIL: `${lmeMarker}:all:hang`, RECALL_BENCH_WORKER_TIMEOUT_MS: "300" });
	assert(hangAll.status === 0, `the run whose marked instance's calls all hang exited ${hangAll.status}; the others were answered, so 0 was expected:\n${hangAll.stdout.slice(-1200)}\n${hangAll.stderr.slice(-600)}`);
	const hangMeta = readMeta(lmeHangAll);
	assert(hangMeta.failures.length === 1 && hangMeta.failures[0].question_id === lmeMarked && new RegExp(`^The ingest of ${lmeMarked} failed: checkpoint compression worker gave up after 6 attempts, and the provider's last word was "it ran past its `).test(hangMeta.failures[0].failure), `the instance whose calls hang is marked failed at the ingest by the worker's limit, and the meta's failures read ${JSON.stringify(hangMeta.failures)}`);
	assert(JSON.stringify(jsonlIds(lmeHangAll)) === JSON.stringify(lmeIds.filter((id) => id !== lmeMarked)), `the other instances are answered and in the file, which holds ${JSON.stringify(jsonlIds(lmeHangAll))}`);
	pass(`an instance whose calls hang past their limit every time is marked failed after the schedule, the others answered, exit 0`);

	console.log(`recall-bench-smoke: ${passes} checks passed`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
} finally {
	if (server) await server.stop();
	if (gateway) await gateway.close();
	fs.rmSync(home, { recursive: true, force: true });
}
