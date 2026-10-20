// Memorize's lines, plain and true. A page placed as one note, a note read
// again and a page that waits read like any conversation; every waiting case
// says the same sentence; no engine warning stops the automatic save; no raw
// error text reaches a card.
//
// Offline: the client's copy module and source, no server.

import fs from "node:fs";
import path from "node:path";
import * as copy from "../../web-ui/src/memory-v2-copy.js";
import * as warnings from "../../web-ui/src/maintenance-warnings.js";
import type { AbsorbRun, AbsorbRunSession } from "../../web-ui/src/types.js";
import { memoryTopicNameProblem, topicNameSentence } from "../src/memory-typed-text.js";
import { credentialGoneWords } from "../src/model-not-offered.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const failures: string[] = [];
function check(label: string, run: () => void): void {
	try {
		run();
		console.log(`  ok  ${label}`);
	} catch (error) {
		failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
		console.log(`  FAIL ${label}`);
	}
}

const c = copy as any;
function session(overrides: Partial<AbsorbRunSession> = {}): AbsorbRunSession {
	return { id: "RC-0007", title: "Nordwind pricing call", date: "2026-07-08", outcome: "folded", attempts: 1, summary: { added: 2, updated: 0, superseded: 0, closed: 0 }, ...overrides };
}
function run(overrides: Partial<AbsorbRun> = {}): AbsorbRun {
	return {
		runId: "absorb-run-1", agentId: "room-1", state: "ready", startedAt: "2026-09-13T09:00:00.000Z", updatedAt: "2026-09-13T09:04:00.000Z",
		progress: { folded: 1, total: 1 }, sessions: [session()], prepass: { demoted: [] },
		budget: { before: 1_000, after: 1_200, budgetTokens: 20_000, savedBudgetTokens: 20_000, overBudgetAfter: false, ceilingTokens: 80_000 },
		demotion: { entries: [], keepIds: [], keepTopics: [], overageTokens: 0, protectedOpenItems: 0, counts: { leaving: 0, kept: 0, instead: 0 } },
		candidate: { sourceFingerprint: { algorithm: "sha256", value: "abc" }, estimatedTokens: 1_200 }, guidance: null, migration: null, warnings: [],
		...overrides,
	} as AbsorbRun;
}
const app = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "App.tsx"), "utf8");

check("a page placed as one note reads Memorized with its counts, and no one-note line is left", () => {
	const line = copy.absorbRunSessionLine(session({ outcome: "summarized", reason: "Placed under Pricing as one note: the model could not split it into notes. The next Memorize reads it again." }));
	assert(line === "Memorized · 2 added", `got ${line}`);
	const folded = copy.absorbRunSessionLine(session({ reason: "What could not be split into notes was placed under Pricing as one note. The next Memorize reads it again." }));
	assert(folded === "Memorized · 2 added", `got ${folded}`);
	assert(!("ABSORB_SUMMARIZED_LINE" in copy) && !("ABSORB_SUMMARIZED_HOVER" in copy), "the one-note line and its hover are gone");
});

check("a note read again reads like any conversation", () => {
	const reread = session({ id: "m-0042", title: "Pricing summary", outcome: "folding" });
	const working = run({ state: "folding", progress: { folded: 1, total: 1, current: { id: "m-0042", title: "Pricing summary" } }, rereads: [reread] } as any);
	assert(copy.absorbRunProgressLine(working) === "Memorizing · Pricing summary", `got ${copy.absorbRunProgressLine(working)}`);
	for (const gone of ["absorbRunRereadLine", "ABSORB_REREAD_HOVER", "absorbRunRereadRows", "absorbRunRereadsWaiting"]) assert(!(gone in copy), `${gone} is gone`);
	const rows = c.absorbRunRows?.(run({ rereads: [session({ id: "m-0042", title: "Pricing summary", changes: [{ id: "m-0101", kind: "added", topic: "Pricing", text: "- Tiered." }] as any })] }), false) ?? [];
	assert(rows.length === 1 && rows[0].session.id === "m-0042" && rows[0].line === "Memorized · 2 added" && rows.every((one: any) => !one.hover), `the note's row is an ordinary row, got ${JSON.stringify(rows.map((one: any) => one.line))}`);
	const saved = copy.absorbRunSavedSentence({ foldedSessions: ["RC-0007"], sortedNotes: 2 });
	assert(!/read again/.test(saved), `the saved screen says nothing of notes read again, got ${saved}`);
});

check("a run where every conversation became one note names the model and the way out", () => {
	assert(!("ABSORB_ALL_SUMMARIZED_SENTENCE" in copy), "the old sentence is gone");
	assert(c.absorbRunAllSummarizedSentence?.("Claude Sonnet 5.5") === "Claude Sonnet 5.5 could not sort these conversations into topics. Another Memory model may do better.", `got ${c.absorbRunAllSummarizedSentence?.("Claude Sonnet 5.5")}`);
});

check("every waiting case says the same sentence", () => {
	assert(copy.absorbRunSessionLine(session({ outcome: "failed", reason: "This conversation will be tried again next time." })) === "Waits for the next Memorize.", "a waiting row has no cause");
	assert(copy.absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" })] })) === "1 conversation waits for the next Memorize.", `got ${copy.absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" })] }))}`);
	assert(copy.absorbRunFailedSessionNote(run({ sessions: [session({ outcome: "failed" }), session({ id: "RC-0008", outcome: "failed" })] })) === "2 conversations wait for the next Memorize.", "plural");
	assert(copy.rememberedMeanwhileSentence(["RC-0009", "RC-0010"]) === "2 conversations wait for the next Memorize.", `got ${copy.rememberedMeanwhileSentence(["RC-0009", "RC-0010"])}`);
	const saved = copy.absorbRunSavedSentence({ foldedSessions: ["RC-0007"], remainingSessions: ["RC-0008"] });
	assert(saved.includes("1 conversation waits for the next Memorize.") && !/keeps? waiting|next update/.test(saved), `got ${saved}`);
});

check("the paused notice names the conversations only", () => {
	const paused = (copy.absorbRunOutageSentence as (...args: unknown[]) => string)("Claude Sonnet 5.5", "not-answering", 2, 3);
	assert(paused === "Memorize paused because Claude Sonnet 5.5 isn't answering right now. 2 conversations are still waiting.", `got ${paused}`);
});

check("the notes card counts only notes in Unsorted", () => {
	assert(copy.memorizeNotesText(3) === "3 notes in Unsorted can be sorted into topics.", `got ${copy.memorizeNotesText(3)}`);
	assert(copy.memorizeNotesText(1) === "1 note in Unsorted can be sorted into a topic.", `got ${copy.memorizeNotesText(1)}`);
});

check("no ids-migration line and no first-read parse warning reaches the card", () => {
	assert(!("absorbRunMigrationSentence" in copy), "the ids-migration line is gone");
	assert(!("meaningfulMaintenanceWarnings" in warnings) && !("describeMaintenanceWarning" in warnings) && typeof (warnings as any).logMaintenanceWarnings === "function", "engine warnings go to the console, none is translated for the screen");
	assert(app.includes("This discussion is getting long. Continue to the update soon.") && !app.includes("approaching its token limit"), "the discussion's limit line");
});

check("the automatic save stops only for the person's real decisions", () => {
	assert(copy.absorbRunFastPathBlockers(run({ warnings: ["assessment missing Deep Memory change bullets"] })).length === 0, "an engine warning never stops it");
	assert(copy.absorbRunFastPathBlockers(run({ sessions: [session(), session({ id: "RC-0008", outcome: "failed" })] })).length === 0, "an unfinished conversation never stops it");
	assert(copy.absorbRunFastPathBlockers(run({ sessions: [session({ outcome: "dropped" })] })).length === 1, "a dropped conversation still does");
});

check("no raw error text, status code or Details reaches a Memorize card", () => {
	const saveError = warnings.formatAbsorbRunSaveError("Request failed (500)");
	assert(!/HTTP|\(\d{3}\)|Details/.test(saveError), `got ${saveError}`);
	const unknown = warnings.formatAbsorbRunSaveError("ENOENT: no such file, open '/x/y'");
	assert(!/ENOENT|Details|\/x\/y/.test(unknown), `got ${unknown}`);
	assert(!/HTTP \$\{|Details: \$\{|maintenance model|in AI setup|AI profile is not|room's AI profile/.test(app.slice(app.indexOf("function formatMaintenanceRequestError"), app.indexOf("function CheckpointPreviewShell"))), "the maintenance formatters carry no raw text and no old names");
	assert(!/ \u2014 the discussion itself/.test(app), "no em dash in the too-large sentence");
	const workflow = app.slice(app.indexOf("function formatAbsorbWorkflowError"), app.indexOf("// The unavailable screens"));
	assert(workflow.length > 0 && !/\treturn message;\n\}/.test(workflow), "an unknown Memorize error is never shown as it came");
});

check("a topic title the move cannot take says what a title may hold", () => {
	const server = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "absorb-run.ts"), "utf8");
	assert(server.includes("throw productError(topicNameSentence(problem, topic, FOLD_TOPIC_TITLE_MAX_CHARS), \"absorb_run_bad_move\")"), "the move refuses with the topic names' own sentence");
});

check("a typed topic name the file cannot take says why, in the same words on every surface", () => {
	const sentences = {
		empty: "Write a name for the topic.",
		heading: "A topic name can't start with #. Write it without the #.",
		reserved: "Active Items is the name of a list memory keeps for itself. Choose another name.",
		"too-long": "A topic name is at most 80 characters.",
	} as const;
	for (const [problem, sentence] of Object.entries(sentences)) assert(topicNameSentence(problem as keyof typeof sentences, "Active Items", 80) === sentence, `${problem}: got ${JSON.stringify(topicNameSentence(problem as keyof typeof sentences, "Active Items", 80))}`);
	assert(memoryTopicNameProblem("") === "empty" && memoryTopicNameProblem("## Booking") === "heading" && memoryTopicNameProblem("Active Items") === "reserved" && memoryTopicNameProblem("C# tips") === null && memoryTopicNameProblem("x".repeat(81), { maxChars: 80 }) === "too-long", "each problem is found");
	for (const sentence of Object.values(sentences)) assert(!/[<>]|\u2014/.test(sentence) && !/topic_|\bL1b\b|Deep Memory/.test(sentence), `no engine words: ${sentence}`);
});

check("a sign-in that is missing names where to sign in", () => {
	const formatters = app.slice(app.indexOf("function formatMaintenanceRequestError"), app.indexOf("function CheckpointPreviewShell"));
	// The credential remedy: the server's matchers and words (model-not-offered.ts), in the step's frame.
	const frame = "`The Memory model ${gone.state}. No memory was updated. ${gone.again} in Settings, AI setup, then run this step again.`";
	// The page cannot tell a key from a sign-in, so its fallback never builds either one's words.
	const fallback = app.slice(app.indexOf("function maintenanceCredentialLine"), app.indexOf("function shortenWorkerFailureDetail"));
	assert(!fallback.includes('credentialGoneWords("key-missing")') && !fallback.includes('credentialGoneWords("signed-out")') && fallback.includes("/^No API key found for/i.test(detail) || signInFailed(detail)"), "no key found reads as the neutral line, never as a key or a sign-in");
	assert(formatters.includes("maintenanceCredentialLine(") && app.includes(frame) && app.includes("The Memory model's key or sign-in is missing or was not accepted. No memory was updated. Check it in Settings, AI setup, then run this step again.") && !app.includes("isMaintenanceSignInFailure"), "the credential remedy names Settings, AI setup, with the server's matchers");
	const line = (words: { state: string; again: string }) => `The Memory model ${words.state}. No memory was updated. ${words.again} in Settings, AI setup, then run this step again.`;
	assert(line(credentialGoneWords("key-no-workspace")) === "The Memory model has a key that isn't tied to a workspace. No memory was updated. Replace it with a key made inside a workspace in Settings, AI setup, then run this step again.", "a key outside a workspace reads as its own line");
	assert(!formatters.includes("Sign in again, then"), "no sign-in remedy without its place");
});

check("an update that stopped shows no raw error; the cause goes to the console", () => {
	const screen = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "absorb-run-screen.tsx"), "utf8");
	const failed = screen.slice(screen.indexOf("export function AbsorbRunFailedScreen"));
	assert(failed.includes("<h2>The update stopped</h2>") && failed.includes("Nothing was saved. Your conversations are still waiting.") && !failed.includes("{error}"), "the stopped screen says what happened and shows no raw error");
	assert(!/<AbsorbRunFailedScreen error=/.test(app), "the page hands it no error");
	const settle = app.slice(app.indexOf("async function settleAbsorbRun("), app.indexOf("if (absorbRun.state === \"cancelled\")", app.indexOf("async function settleAbsorbRun(")));
	assert(/console\.info\(`\[maintenance\] \$\{absorbRun\.error\}`\)/.test(settle) && !settle.includes("error: absorbRun.error"), "the run's own error goes to the console, not the screen");
});

check("a discussion at its limit says so in plain words", () => {
	const LIMIT = "This discussion has grown too long to carry on. Continue to the update with what you have agreed so far, or leave the discussion.";
	assert(!/token limit\./.test(app) && !app.includes("reached its token limit"), "no line says token limit");
	assert(app.includes(`{budget?.state === "hard_stop" && <div className="checkpoint-proposal-error" role="alert">${LIMIT}</div>}`), "the discussion's hard stop line");
	const workflow = app.slice(app.indexOf("function formatAbsorbWorkflowError"), app.indexOf("function isPlainProductSentence"));
	assert(workflow.includes(`return "${LIMIT}";`), "Memorize's own refusal at the limit says the same");
});

assert(failures.length === 0, `memorize lines copy smoke failed:\n${failures.join("\n")}`);
console.log("memorize lines copy smoke passed");
