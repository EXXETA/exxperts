// Memorize's lines, plain and true. A page placed as one note, a note read
// again and a page that waits read like any conversation; every waiting case
// says the same sentence; no raw error text reaches a card.
//
// Offline: the client's copy module and source, no server.

import fs from "node:fs";
import path from "node:path";
import * as copy from "../../web-ui/src/memory-v2-copy.js";
import type { AbsorbRun, AbsorbRunSession } from "../../web-ui/src/types.js";

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
const errors = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "maintenance-errors.ts"), "utf8");
const screens = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "maintain-workflow-screens.tsx"), "utf8");
// App.tsx and the files its top-level code moved into: a check that the page never says something reads them all.
const PAGE_FILES = ["App.tsx", "maintain-workflow-state.ts", "maintenance-errors.ts", "components/maintain-workflow-screens.tsx", "components/remember-dialog.tsx", "components/landing.tsx", "components/ai-profile-switcher.tsx", "components/memory-shell.tsx", "components/room-file-dialogs.tsx", "components/task-store-gc.tsx", "room-thread-items.ts"];
const pageText = PAGE_FILES.map((file) => fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", file), "utf8")).join("\n");

check("a page placed as one note reads Memorized with its counts, and no one-note line is left", () => {
	const line = copy.absorbRunSessionLine(session({ outcome: "summarized", reason: "Placed under Pricing as one note: the model could not split it into notes. The next Memorize reads it again." }));
	assert(line === "Memorized · 2 added", `got ${line}`);
	const folded = copy.absorbRunSessionLine(session({ reason: "What could not be split into notes was placed under Pricing as one note. The next Memorize reads it again." }));
	assert(folded === "Memorized · 2 added", `got ${folded}`);
});

check("a note read again reads like any conversation", () => {
	const reread = session({ id: "m-0042", title: "Pricing summary", outcome: "folding" });
	const working = run({ state: "folding", progress: { folded: 1, total: 1, current: { id: "m-0042", title: "Pricing summary" } }, rereads: [reread] } as any);
	assert(copy.absorbRunProgressLine(working) === "Memorizing · Pricing summary", `got ${copy.absorbRunProgressLine(working)}`);
	const rows = c.absorbRunRows?.(run({ rereads: [session({ id: "m-0042", title: "Pricing summary", changes: [{ id: "m-0101", kind: "added", topic: "Pricing", text: "- Tiered." }] as any })] }), false) ?? [];
	assert(rows.length === 1 && rows[0].session.id === "m-0042" && rows[0].line === "Memorized · 2 added" && rows.every((one: any) => !one.hover), `the note's row is an ordinary row, got ${JSON.stringify(rows.map((one: any) => one.line))}`);
	const saved = copy.absorbRunSavedSentence({ foldedSessions: ["RC-0007"], sortedNotes: 2 });
	assert(!/read again/.test(saved), `the saved screen says nothing of notes read again, got ${saved}`);
});

check("a run where every conversation became one note names the model and the way out", () => {
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

check("the discussion's limit line", () => {
	assert(screens.includes("This discussion is getting long. Continue to the update soon.") && !pageText.includes("approaching its token limit"), "the discussion's limit line");
});

check("no raw error text, status code or Details reaches a Memorize card", () => {
	assert(!/HTTP \$\{|Details: \$\{|maintenance model|in AI setup|AI profile is not|room's AI profile/.test(errors.slice(errors.indexOf("function formatMaintenanceRequestError"))), "the maintenance formatters carry no raw text and no old names");
	assert(!/ \u2014 the discussion itself/.test(pageText), "no em dash in the too-large sentence");
	const workflow = errors.slice(errors.indexOf("function formatAbsorbWorkflowError"), errors.indexOf("// The unavailable screens"));
	assert(workflow.length > 0 && !/\treturn message;\n\}/.test(workflow), "an unknown Memorize error is never shown as it came");
});

check("a topic title the move cannot take says what a title may hold", () => {
	const server = fs.readFileSync(path.join(process.cwd(), "apps", "web-server", "src", "absorb-run.ts"), "utf8");
	assert(server.includes("throw productError(topicNameSentence(problem, topic, FOLD_TOPIC_TITLE_MAX_CHARS), \"absorb_run_bad_move\")"), "the move refuses with the topic names' own sentence");
});

check("a paused Memorize card offers no Try again where it is sure to fail; the way that works comes first", () => {
	const notice = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "model-notice.tsx"), "utf8");
	assert(/export function retryCanHelp\(cause: string, quotaWay\?: QuotaWay, gatewayFind\?: GatewayFind\): boolean \{\s*if \(cause === "quota"\) return quotaWay !== undefined && quotaOffersTryAgain\(quotaWay\);\s*if \(cause === "gateway-not-found"\) return gatewayFind === "model-listed";\s*return cause !== "signed-out" && cause !== "not-offered" && cause !== "not-on-account" && cause !== "region-or-plan" && cause !== "gateway-refused" && cause !== "gateway-not-found" && cause !== "too-small";/.test(notice), "one rule for every memory screen: not on the account, the region or plan, a gateway's refusal and its not-found unless the model is listed included, and a spent quota whose way on or reset is unknown");
	// Every memory screen takes its ways on from one hook, with the stop's quota and its reset, and shows them with one
	// button row; memory-ways-on-smoke pins what each screen offers per cause, and that taking a way brings Try again back.
	const screen = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "absorb-run-screen.tsx"), "utf8");
	const review = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "review-screen.tsx"), "utf8");
	for (const [name, source, uses] of [["notice", notice, 1], ["Review card", review, 2], ["Memorize card", screen, 1]] as const) {
		const hooks = source.match(/useMemoryWaysOn\((?:notice\.detail, notice\.quotaWay|(?:stop|outage)\?\.cause, (?:stop|outage)\?\.quotaWay),/g) ?? [];
		assert(hooks.length === uses && !/useRetryOffer|offer\.took/.test(source), `${name}: the ways on come from the one hook, reading the stop's quota and its reset`);
	}
});

check("an update that stopped shows no raw error; the cause goes to the console", () => {
	const screen = fs.readFileSync(path.join(process.cwd(), "apps", "web-ui", "src", "components", "absorb-run-screen.tsx"), "utf8");
	const failed = screen.slice(screen.indexOf("export function AbsorbRunFailedScreen"));
	assert(failed.includes("<h2>The update stopped</h2>") && failed.includes("Nothing was saved. Your conversations are still waiting.") && !failed.includes("{error}"), "the stopped screen says what happened and shows no raw error");
	assert(!/<AbsorbRunFailedScreen error=/.test(pageText), "the page hands it no error");
	const settle = app.slice(app.indexOf("async function settleAbsorbRun("), app.indexOf("if (absorbRun.state === \"cancelled\")", app.indexOf("async function settleAbsorbRun(")));
	assert(/console\.info\(`\[maintenance\] \$\{absorbRun\.error\}`\)/.test(settle) && !settle.includes("error: absorbRun.error"), "the run's own error goes to the console, not the screen");
});

assert(failures.length === 0, `memorize lines copy smoke failed:\n${failures.join("\n")}`);
console.log("memorize lines copy smoke passed");
