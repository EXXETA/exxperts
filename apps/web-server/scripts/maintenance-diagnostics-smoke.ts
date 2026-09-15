import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

// Every maintenance worker call leaves one record of what happened: the sizes,
// the timings, the stop reason, which of the template's markers the reply
// actually carried, how the validator judged it, and how the step ended. The
// point of the record is that a user can send it without sending anything
// private with it — so the load-bearing assertion here is the absence of three
// sentinels planted in the prompt, the reply and the room's own memory.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-maintenance-diagnostics-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");

// Three things that must never reach a record: something only the prompt holds,
// something only the reply holds, and something only the room's memory holds.
const MEMORY_SENTINEL = "MEMORY_ONLY_SENTINEL_NORDWIND_RENEWAL";
const REPLY_SENTINEL = "REPLY_ONLY_SENTINEL_QUARTERLY_FORECAST";
const PROMPT_SENTINEL = "PROMPT_ONLY_SENTINEL_ASSESSMENT_STEER";

const {
	buildAbsorbProposal,
	buildConsultAnswer,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
} = await import("../src/persistent-agents.js");
const { cancelReviewRun, getReviewRun, REVIEW_TIDY_REFUSED_TWICE, startReviewRun } = await import("../src/review-run.js");
const {
	exportMaintenanceDiagnostics,
	listMaintenanceDiagnostics,
	maintenanceDiagnosticsDir,
	maintenanceDiagnosticsParseSignature,
	MEMORIZE_PROPOSAL_MARKERS,
	writeMaintenanceDiagnosticsRecord,
} = await import("../src/maintenance-diagnostics.js");
const { getAbsorbModelLock, getStructuralReviewModelLock } = await import("../src/persistent-agent-ai-profiles.js");
const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const ABSORB_MODEL = getAbsorbModelLock("openai-compatible");
const REVIEW_MODEL = getStructuralReviewModelLock("openai-compatible");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function seedMemory(agentId: string): void {
	const instance = createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
	const l1b = `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Lifecycle state: ready

## Deep Memory

### ${MEMORY_SENTINEL} terms

- The contract renews annually and legal signs before June. (saved 2026-07-08)
- Send commercial summaries as one page, numbers first. (saved 2026-08-21)

### Tooling Notes

- Tool note one, verbose. (saved 2026-03-01)

## Active Items

- One live thread. (saved 2026-08-01)

## Recent Context

${Array.from({ length: 5 }, (_, i) => `### RC-000${i + 1} | OPEN | 2026-08-2${i} | Session ${i + 1}\n\n**Session arc:** Session ${i + 1}.\n\n**Body:**\n- durable signal ${i + 1}\n`).join("\n")}
`;
	fs.mkdirSync(path.dirname(l1bPath), { recursive: true });
	fs.writeFileSync(l1bPath, l1b, "utf-8");
}

const assessmentFixture = `## Absorb assessment

I found 5 Recent Context entries. ${PROMPT_SENTINEL}

### What to remember
- The durable commercial terms.

### What to forget
- Chatter.

### What changes in stable memory
- Deep Memory: sharpen.

### Needs your judgment
- None
`;

// A complete Memorize proposal whose headings are BOLDED: the field failure
// that reads as thirteen structural complaints and is invisible in the numbers.
function bolded(reply: string): string {
	return reply.replace(/^### (.+)$/gm, "### **$1**");
}

function memorizeProposal(): string {
	return `## Memory Absorption Proposal

### Mode
RC_CONSOLIDATION

### Primacy Map
${REPLY_SENTINEL} summarises the chain.

### Section-Level Change Log
| Section | Prior Words | Candidate Words | Action | Rationale |
|---|---:|---:|---|---|
| Deep Memory | 20 | 20 | keep | Durable. |

### Entry-Level Detail
| Entry / Block | Operation | Target Section | Rationale |
|---|---|---|---|
| RC-0001 | fold | Deep Memory | Durable. |

### Compression Metrics
- RC input words: 10
- RC removed words: 10
- RC removed percent: 100%
- Stable memory words before: 20
- Stable memory words after: 20
- Stable memory delta: 0
- Compression ratio: 1.0

### Warnings
None

### Candidate L1b
<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Lifecycle state: ready

## Deep Memory

### ${MEMORY_SENTINEL} terms

- The contract renews annually and legal signs before June. (saved 2026-07-08)

## Active Items

- One live thread. (saved 2026-08-01)

## Recent Context

_No sessions are waiting to be memorized._
`;
}

/**
 * A room whose memory is notes with ids, dates and pins — what a Review run
 * reads. Its one Deep Memory topic is TITLED with the sentinel, so the refusals
 * the memory writes about it name the room's own words.
 */
function reviewMemoryFixture(agentId: string): string {
	return [
		"<!-- exxeta:l1b schema_version=1 -->",
		"",
		"## Chronos",
		"",
		`- Persistent agent id: ${agentId}`,
		"- Lifecycle state: ready",
		"",
		"## Deep Memory",
		"",
		"<!-- entries: next=2000 -->",
		"",
		`### ${MEMORY_SENTINEL} terms`,
		"",
		"<!-- e: id=m-0001 kind=fact saved=2026-07-08 from=RC-0002 refs=0 -->",
		"- The contract renews annually, legal signs before June, and the escalation path runs through the account owner first.",
		"",
		"<!-- e: id=m-0002 kind=fact saved=2026-08-21 from=RC-0002 refs=0 -->",
		"- Send commercial summaries as one page, numbers first, with the rate table underneath and nothing else attached.",
		"",
		"<!-- e: id=m-0003 kind=fact saved=2026-03-01 from=RC-0002 refs=0 -->",
		"- Tooling notes are kept verbose on purpose so a new joiner can follow the build without asking anyone.",
		"",
		"## Active Items",
		"",
		"<!-- e: id=m-0900 kind=item status=open saved=2026-09-01 updated=2026-09-11 refs=4 from=RC-0002 -->",
		"- Chase the vendor for the signed addendum.",
		"",
		"## Recent Context",
		"",
		"No checkpointed sessions yet.",
		"",
	].join("\n");
}

const REVIEW_WINDOW = { contextWindow: 400_000, maxOutputTokens: 16_384 };

function tidyReply(narrative: string, ops: unknown[]) {
	return { text: `${narrative}\n\n\`\`\`json\n${JSON.stringify({ ops }, null, 2)}\n\`\`\`\n`, usage: { input: 2400, output: 260, totalTokens: 2660, cost: 0 } };
}

/** Closing a fact is refused, and the refusal names the topic it sits under. */
const CLOSE_A_FACT = [{ op: "close", id: "m-0001" }];
/** The same point in fewer words: what a tidy is for, and what the memory accepts. */
const SHORTEN_A_FACT = [{ op: "update", id: "m-0001", text: "- The contract renews annually; legal signs before June." }];

async function settleReviewRun(agentId: string, runId: string) {
	const deadline = Date.now() + 60_000;
	let run = getReviewRun(agentId, runId);
	while (run.state === "prepass" || run.state === "tidying" || run.state === "budget") {
		assert(Date.now() < deadline, `a scripted tidy answers in milliseconds, yet the run stayed in "${run.state}"`);
		await new Promise((resolve) => setTimeout(resolve, 5));
		run = getReviewRun(agentId, runId);
	}
	return run;
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(child: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 20_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (child.exitCode != null) throw new Error(`server exited before startup with code ${child.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

try {
	// --- 1. A Memorize proposal whose headings deviate ------------------------
	createPersistentAgentFromScaffoldInput({ displayName: "Diagnostics Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = "diagnostics-smoke-room";
	const roomRootDir = createPersistentAgentInstance(agentId).rootDir;
	assert(fs.existsSync(maintenanceDiagnosticsDir(roomRootDir)), "the scaffold should create the diagnostics directory");
	seedMemory(agentId);

	const deviating = await buildAbsorbProposal({ agentId, assessmentMarkdown: assessmentFixture }, ABSORB_MODEL, async () => ({
		text: bolded(memorizeProposal()),
		usage: { input: 6000, output: 900, totalTokens: 6900, cost: 0 },
	}));
	assert(deviating.candidateValidation.valid === false, "a bolded-heading proposal is exactly the field failure: complete, and unparseable");

	const afterFirst = listMaintenanceDiagnostics(roomRootDir);
	assert(afterFirst.length === 1, `one worker call should leave one record, got ${afterFirst.length}`);
	const record = afterFirst[0];
	assert(record.process === "memorize-proposal", `the record should name the process, got ${record.process}`);
	assert(record.provider === ABSORB_MODEL.provider && record.model === ABSORB_MODEL.model, `the record should name the model, got ${record.provider}/${record.model}`);
	assert(record.promptChars > 0 && record.promptEstimatedTokens > 0, "the record should carry the prompt's size");
	assert(record.promptEstimatedTokens === Math.ceil(record.promptChars / 4), "the prompt estimate should be the product's own chars/4");
	assert(record.replyChars > 0, "the record should carry the reply's size");
	assert(record.inputTokens === 6000 && record.outputTokens === 900, `the record should carry the reported usage, got ${record.inputTokens}/${record.outputTokens}`);
	assert(record.truncated === false, "a complete reply is not truncated");
	assert(typeof record.wallTimeMs === "number" && record.wallTimeMs >= 0, "the record should carry a wall time");
	assert(record.attempt === 1, `the first call is attempt one, got ${record.attempt}`);
	assert(record.outcome === "refused", `a proposal the validator rejects is refused, got ${record.outcome}`);
	assert(record.validatorErrors.length > 0, "the record should carry the validator's reasons");

	// The parse signature is the whole point: it separates "the reply was cut"
	// from "the reply was complete and its headings deviated".
	const states = new Map(record.parseSignature.markers.map((m) => [m.marker, m.state]));
	assert(states.get("Mode") === "deviating", `a bolded heading should read as deviating, got ${states.get("Mode")}`);
	assert(states.get("Candidate L1b") === "deviating", `every bolded heading should read as deviating, got ${states.get("Candidate L1b")}`);
	assert(record.parseSignature.markers.length === MEMORIZE_PROPOSAL_MARKERS.length, "every expected marker is reported");

	// --- 2. Nothing private in the record -------------------------------------
	const serialized = JSON.stringify(record);
	for (const [label, sentinel] of [["the room's memory", MEMORY_SENTINEL], ["the reply", REPLY_SENTINEL], ["the prompt", PROMPT_SENTINEL]] as const) {
		assert(!serialized.includes(sentinel), `the record must not carry anything from ${label}`);
	}

	// --- 3. A Review tidy whose refusals name the room's own topic -------------
	// A tidy is refused by the memory itself, and the memory says why by naming
	// what it refused — a note id, and the topic that note sits under. Here the
	// topic's TITLE carries the sentinel, so the refusal the record has to carry
	// is exactly the leak the record must not become: the sentence is kept, the
	// words it quoted are not.
	createPersistentAgentFromScaffoldInput({ displayName: "Diagnostics Review Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const reviewRoomId = "diagnostics-review-room";
	const reviewRootDir = createPersistentAgentInstance(reviewRoomId).rootDir;
	fs.writeFileSync(path.join(root, reviewRoomId, "L1b", "current.md"), reviewMemoryFixture(reviewRoomId), { mode: 0o600 });

	let tidyAttempt = 0;
	const retriedRun = startReviewRun(reviewRoomId, {
		depth: "tidy",
		model: REVIEW_MODEL,
		resolveModelWindow: () => REVIEW_WINDOW,
		// Refused once, then said in fewer words: one group, two calls.
		generate: async () => tidyReply("Here is the tidy.", ++tidyAttempt === 1 ? CLOSE_A_FACT : SHORTEN_A_FACT),
	});
	const retried = await settleReviewRun(reviewRoomId, retriedRun.runId);
	assert(retried.progress.groups === 1, `this fixture is meant to ride in one group, got ${retried.progress.groups}`);
	assert(retried.leftAsIs.length === 0, `the second call was accepted, so nothing is left as is: ${JSON.stringify(retried.leftAsIs)}`);

	const retriedRecords = listMaintenanceDiagnostics(reviewRootDir).filter((r) => r.process === "review-tidy");
	assert(retriedRecords.length === 2, `the refused call and its retry should each leave a record, got ${retriedRecords.length}`);
	assert(retriedRecords.some((r) => r.attempt === 1) && retriedRecords.some((r) => r.attempt === 2), "each attempt is numbered");
	const refusedFirst = retriedRecords.find((r) => r.attempt === 1);
	assert(refusedFirst && refusedFirst.outcome === "refused", `a tidy the memory refused is refused, got ${refusedFirst?.outcome}`);
	assert(retriedRecords.find((r) => r.attempt === 2)?.outcome === "accepted", "the call the memory accepted is accepted");
	assert(refusedFirst!.validatorErrors.length > 0, "the record should carry the memory's own reasons for refusing");
	assert(refusedFirst!.validatorErrors.some((reason) => /not an open item/.test(reason)), `the reason survives the redaction as a sentence, got ${JSON.stringify(refusedFirst!.validatorErrors)}`);
	assert(refusedFirst!.validatorErrors.some((reason) => reason.includes('"…"')), "and what it quoted is taken out rather than the whole sentence being dropped");
	assert(!JSON.stringify(retriedRecords).includes(MEMORY_SENTINEL), "a refusal that named the room's topic must be redacted before it is written");

	// --- 3b. A consulted room still records no trace of having been consulted ---
	// The consult's numbers belong to the room that asked; a file in the read
	// room's own events would break the promise its own warning makes.
	createPersistentAgentFromScaffoldInput({ displayName: "Diagnostics Asking Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const askingRoomId = "diagnostics-asking-room";
	const askingRootDir = createPersistentAgentInstance(askingRoomId).rootDir;
	const beforeConsult = listMaintenanceDiagnostics(roomRootDir).length;
	const consulted = await buildConsultAnswer({ targetAgentId: agentId, fromRoomId: askingRoomId, question: "What are the commercial terms?" }, { provider: ABSORB_MODEL.provider, model: ABSORB_MODEL.model }, async () => ({
		text: "From my memory: the contract renews annually.",
		usage: { input: 100, output: 20, totalTokens: 120, cost: 0 },
	}));
	assert(consulted.warnings.some((warning: string) => /no trace/.test(warning)), "the consulted room is promised it records no trace");
	assert(listMaintenanceDiagnostics(roomRootDir).length === beforeConsult, "a consult must not write into the room it read");
	const askingRecords = listMaintenanceDiagnostics(askingRootDir);
	assert(askingRecords.length === 1 && askingRecords[0].process === "consult", `the consult's record belongs to the asking room, got ${JSON.stringify(askingRecords.map((r) => r.process))}`);

	// --- 3c. A tidy refused on both attempts closes its record as refused ------
	cancelReviewRun(reviewRoomId, retriedRun.runId);
	const refusedRun = startReviewRun(reviewRoomId, {
		depth: "tidy",
		model: REVIEW_MODEL,
		resolveModelWindow: () => REVIEW_WINDOW,
		generate: async () => tidyReply("Here is the tidy.", CLOSE_A_FACT),
	});
	const refusedTwice = await settleReviewRun(reviewRoomId, refusedRun.runId);
	assert(refusedTwice.leftAsIs.some((row) => row.reason === REVIEW_TIDY_REFUSED_TWICE), `a group refused twice is left as it was: ${JSON.stringify(refusedTwice.leftAsIs)}`);
	const afterRefusal = listMaintenanceDiagnostics(reviewRootDir).filter((r) => r.process === "review-tidy");
	assert(afterRefusal.length === retriedRecords.length + 2, `the refused run leaves its own two records, got ${afterRefusal.length - retriedRecords.length}`);
	assert(afterRefusal[0].outcome === "refused", `a run that ended in a refusal must not read as accepted, got ${afterRefusal[0].outcome}`);
	assert(afterRefusal[0].attempt === 2, `the newest record is the last attempt, even when both land in the same millisecond, got attempt ${afterRefusal[0].attempt}`);
	assert(!JSON.stringify(afterRefusal).includes(MEMORY_SENTINEL), "neither attempt may carry the room's words");

	// --- 4. The signature reads a cut reply differently ------------------------
	const cut = maintenanceDiagnosticsParseSignature("## Memory Absorption Proposal\n\n### Mode\nRC_CONSOLIDATION\n\n### Primacy Map\nThe chain", MEMORIZE_PROPOSAL_MARKERS);
	const cutStates = new Map(cut.markers.map((m) => [m.marker, m.state]));
	assert(cutStates.get("Mode") === "exact", "a cut reply's surviving headings read as exact");
	assert(cutStates.get("Candidate L1b") === "missing", "a cut reply's lost headings read as missing, not deviating");

	// --- 4b. Newest first does not depend on file names -----------------------
	// A retry can land in the same millisecond as the call it retried, and the
	// second file's name then sorts BEFORE the first's. Order has to come from
	// what the records say.
	createPersistentAgentFromScaffoldInput({ displayName: "Diagnostics Order Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const orderRootDir = createPersistentAgentInstance("diagnostics-order-room").rootDir;
	const sameMillisecond = "2026-09-12T10:00:00.000Z";
	for (const attempt of [1, 2]) {
		writeMaintenanceDiagnosticsRecord(orderRootDir, {
			schemaVersion: 1,
			agentId: "diagnostics-order-room",
			process: "memorize-proposal",
			at: sameMillisecond,
			attempt,
			provider: "openai-compatible",
			model: "gpt-5.5",
			promptChars: 10,
			promptEstimatedTokens: 3,
			replyChars: 10,
			truncated: false,
			wallTimeMs: 1,
			parseSignature: maintenanceDiagnosticsParseSignature("", MEMORIZE_PROPOSAL_MARKERS),
			validatorErrors: [],
			validatorWarnings: [],
			outcome: attempt === 1 ? "retried" : "refused",
		});
	}
	const ordered = listMaintenanceDiagnostics(orderRootDir);
	assert(ordered.length === 2, `both records should be listed, got ${ordered.length}`);
	assert(ordered[0].attempt === 2, `within one millisecond the later attempt comes first, got attempt ${ordered[0].attempt}`);

	// --- 5. The export is one document, and the routes serve it ---------------
	const exported = exportMaintenanceDiagnostics(reviewRootDir, reviewRoomId);
	assert(exported.agentId === reviewRoomId && exported.recordCount === exported.records.length && exported.recordCount >= 4, `the export should carry every record, got ${exported.recordCount}`);
	assert(!JSON.stringify(exported).includes(MEMORY_SENTINEL), "the export must not carry the room's memory either");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...SMOKE_SERVER_AUTH_ENV, HOME: tempHome, USERPROFILE: tempHome, PORT: String(port), EXXETA_HOME: repoRoot },
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const listResponse = await authedFetch(`${baseUrl}/api/persistent-agents/${reviewRoomId}/maintenance-diagnostics`);
	assert(listResponse.status === 200, `the diagnostics route should return 200, got ${listResponse.status}`);
	const listed = await listResponse.json() as any;
	assert(listed.agentId === reviewRoomId && Array.isArray(listed.records) && listed.records.length >= 2, `the route should list the room's records, got ${JSON.stringify(listed).slice(0, 200)}`);
	assert(listed.records[0].at >= listed.records[listed.records.length - 1].at, "the route lists records newest first");

	const exportResponse = await authedFetch(`${baseUrl}/api/persistent-agents/${reviewRoomId}/maintenance-diagnostics/export`);
	assert(exportResponse.status === 200, `the export route should return 200, got ${exportResponse.status}`);
	const exportBody = await exportResponse.text();
	const exportJson = JSON.parse(exportBody);
	assert(exportJson.recordCount === exportJson.records.length && exportJson.recordCount >= 2, "the export route returns one document with every record");
	for (const sentinel of [MEMORY_SENTINEL, REPLY_SENTINEL, PROMPT_SENTINEL]) {
		assert(!exportBody.includes(sentinel), "the export a user attaches to a report must carry nothing private");
	}

	console.log("maintenance diagnostics smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-40).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server ?? undefined);
	if (process.exitCode == null || process.exitCode === 0) fs.rmSync(tempHome, { recursive: true, force: true });
}
