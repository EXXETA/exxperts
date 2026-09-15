// Review's run over its real routes, against a really spawned web server.
//
// Review stops being one long request that hands back a whole rewritten memory:
// the server tidies a room's topics a group at a time, the client watches that
// happen, adjusts what the budget would archive, and approves at the end. This
// smoke drives that whole path on one room — the status block a room shows
// before anything starts, the refusal while the room is already updating its
// memory, starting the review, the refusal of a second one, polling until it is
// ready, keeping a note the tidy wanted to archive, putting the person's own
// words on one it rewrote, raising the room's budget, and approving — and it
// checks the file on disk afterwards, because the promise the run makes is that
// nothing is written until approve. It ends on the route table, because a route
// that ships without a remote classification fails closed for every phone.
//
// The model is a local gateway that answers what the prompt asks for, so every
// call in this smoke is the real worker path with a scripted reply.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "review-run-route-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(productAppRoot, "personalized-agents");

const MIN_BUDGET_TOKENS = 10_000;
const RAISED_BUDGET_TOKENS = 60_000;
const FIXTURE_TOPICS = ["Commercial terms", "Delivery practice", "Reporting rhythm", "Working style"];
const NOTES_PER_TOPIC = 40;
const SESSION_COUNT = 5;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- The fixture: a room whose memory is well past the smallest budget -------

function fixtureNote(topic: string, n: number): string {
	const id = `m-${String(n).padStart(4, "0")}`;
	const text = `- ${topic} note ${n}: the room keeps the agreed rate, the renewal month, the signing route and the escalation path for account ${n}, together with the reporting rhythm the account team settled on and the handover the account owner asked for, so a later session does not have to rediscover any of it.`;
	return `<!-- e: id=${id} kind=fact saved=2025-0${(n % 9) + 1}-1${n % 9} from=RC-0002 refs=0 -->\n${text}\n`;
}

function fixtureDeepMemory(): string {
	let n = 1;
	return FIXTURE_TOPICS.map((topic) => {
		const notes = Array.from({ length: NOTES_PER_TOPIC }, () => fixtureNote(topic, n++)).join("\n");
		return `### ${topic}\n\n${notes}`;
	}).join("\n");
}

function fixtureSession(n: number): string {
	return `### RC-000${n} | OPEN | 2026-09-0${n} | Account review session ${n}\n\n**Session arc:** Session ${n} settled one commercial question and left one follow-up open.\n\n**Body:**\n- The renewal for account ${n} moves to the first working day of the quarter.\n- The account team wants the reporting pack one page shorter.\n\n**Parked:**\nThe signed addendum for account ${n} is still outstanding.\n`;
}

function fixtureL1b(agentId: string): string {
	const sessions = Array.from({ length: SESSION_COUNT }, (_, i) => fixtureSession(i + 1)).join("\n");
	return `<!-- exxeta:l1b schema_version=1 -->

## Chronos

- Persistent agent id: ${agentId}
- Lifecycle state: ready
- Last checkpoint: cp_20260901_0001
- Last checkpoint at: 2026-09-01T09:00:00.000Z
- Last consolidation: none

## Deep Memory

<!-- entries: next=2000 -->

${fixtureDeepMemory()}
## Active Items

<!-- e: id=m-0900 kind=item saved=2026-09-01 status=open refs=1 -->
- Chase the vendor for the signed addendum.

<!-- e: id=m-0901 kind=item saved=2026-08-20 status=open refs=1 -->
- Confirm the renewal month with legal.

## Recent Context

${sessions}`;
}

// --- The gateway: one scripted reply per kind of prompt ----------------------

interface GatewayCall {
	kind: "assessment" | "fold" | "tidy" | "other";
	topics: string;
}

const gatewayCalls: GatewayCall[] = [];

/** The prompt as the worker sent it, whatever shape the request wraps it in. */
function promptTextOf(rawBody: string): string {
	try {
		const parsed = JSON.parse(rawBody) as { system?: unknown; messages?: Array<{ content?: unknown }> };
		const parts: string[] = [];
		const collect = (content: unknown): void => {
			if (typeof content === "string") {
				parts.push(content);
				return;
			}
			if (Array.isArray(content)) for (const item of content) collect((item as { text?: unknown }).text);
		};
		collect(parsed.system);
		for (const message of parsed.messages ?? []) collect(message.content);
		return parts.join("\n");
	} catch {
		return rawBody;
	}
}

const ASSESSMENT_REPLY = `## Absorb assessment

I found ${SESSION_COUNT} Recent Context entries. Here is the proposed direction.

### What to remember

- The renewal dates the sessions settled for the reviewed accounts.

### What to forget

- The scheduling chatter around each review call.

### What changes in stable memory

- Deep Memory: the commercial terms notes take the newer renewal dates.

### Needs your judgment

- None
`;

interface PromptNote {
	id: string;
	topic: string;
	pinned: boolean;
	firstLine: string;
}

const SECTION_SPLIT = /\n\n---\n\n/;
const NOTE_ADDRESS = /^(?:\s*(?:[-*+]|\d+[.)])\s+)?\[([^\]\s·]+)(\s+·\s+pinned)?\]\s*([\s\S]*)$/;

function promptSection(prompt: string, heading: string): string {
	const found = prompt.split(SECTION_SPLIT).find((part) => part.trimStart().startsWith(heading));
	return found ? found.slice(found.indexOf("\n") + 1).trim() : "";
}

function notesIn(prompt: string, heading: string): PromptNote[] {
	const rows: PromptNote[] = [];
	let topic = "";
	for (const line of promptSection(prompt, heading).split("\n")) {
		const section = /^##\s+(.+?)\s*$/.exec(line);
		if (section) { topic = section[1]; continue; }
		const subheading = /^###\s+(.+?)\s*$/.exec(line);
		if (subheading) { topic = subheading[1]; continue; }
		const row = NOTE_ADDRESS.exec(line.trim());
		if (row) rows.push({ id: row[1], topic, pinned: Boolean(row[2]), firstLine: row[3] });
	}
	return rows;
}

function foldReply(prompt: string): string {
	const sessionId = /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "RC-0000";
	return `${sessionId} is a repeat of what memory already holds.\n\n\`\`\`json\n${JSON.stringify({ ops: [{ op: "drop", reason: "This conversation repeats what the room already knows." }] }, null, 2)}\n\`\`\`\n`;
}

function tidyReply(prompt: string): string {
	const notes = notesIn(prompt, "## Material: The Notes To Tidy").filter((note) => !note.pinned);
	const ops: Array<Record<string, unknown>> = [];
	if (notes[0]) ops.push({ op: "update", id: notes[0].id, text: `- ${notes[0].firstLine.split(":")[0].slice(0, 80).trim()}, in one line.` });
	if (notes[1]) ops.push({ op: "archive", id: notes[1].id, why: "stale" });
	return `Two of these said one thing between them, and one no longer holds.\n\n\`\`\`json\n${JSON.stringify({ ops }, null, 2)}\n\`\`\`\n`;
}

function sseChunk(payload: unknown): string {
	return `data: ${JSON.stringify(payload)}\n\n`;
}

const gateway = http.createServer((req, res) => {
	if (req.method !== "POST" || !String(req.url ?? "").endsWith("/chat/completions")) {
		res.writeHead(404).end();
		return;
	}
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const prompt = promptTextOf(body);
		const isTidy = prompt.includes("## Task: Tidy These Notes");
		const isFold = prompt.includes("## Task: Fold This Session Into Memory");
		const isAssessment = prompt.includes("## Task: Compact Initial Assessment");
		const kind: GatewayCall["kind"] = isTidy ? "tidy" : isFold ? "fold" : isAssessment ? "assessment" : "other";
		gatewayCalls.push({ kind, topics: isTidy ? [...new Set(notesIn(prompt, "## Material: The Notes To Tidy").map((note) => note.topic))].join("|") : "" });
		const text = isTidy ? tidyReply(prompt) : isFold ? foldReply(prompt) : isAssessment ? ASSESSMENT_REPLY : "Nothing to do here.";
		const base = { id: `cmpl_${gatewayCalls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
		// A maintenance call takes a beat, the way a real one does: the run must
		// still be open when the smoke asks a second thing of the room.
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 } }));
			res.write("data: [DONE]\n\n");
			res.end();
		}, isAssessment ? 0 : 400);
	});
});

// --- The spawned server ------------------------------------------------------

function smokeEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "AZURE_OPENAI_API_KEY", "EXXETA_AI_API_KEY", "COPILOT_GITHUB_TOKEN", "GH_TOKEN", "GITHUB_TOKEN", "GEMINI_API_KEY", "GOOGLE_CLOUD_API_KEY", "OPENROUTER_API_KEY"]) {
		delete env[key];
	}
	env.HOME = tempHome;
	env.USERPROFILE = tempHome;
	env.PORT = String(port);
	Object.assign(env, SMOKE_SERVER_AUTH_ENV);
	env.EXXETA_HOME = repoRoot;
	env.EXXPERTS_CODING_AGENT_DIR = agentDir;
	// Opens the route-table hook this smoke reads the remote classifications from.
	env.EXXPERTS_REMOTE_TEST_ADDRESS = "::1";
	return env;
}

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
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

async function requestJson(pathname: string, init?: AuthedFetchInit): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, init);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

function jsonBody(method: string, body: unknown): AuthedFetchInit {
	return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
const startedAt = Date.now();

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;

	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	fs.mkdirSync(productAppRoot, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 400000, maxTokens: 16384 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-review-run-key" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "openai-compatible-ai-profile.json"), JSON.stringify({
		profileId: "openai-compatible",
		providerId: "openai-compatible",
		label: "Synthetic Gateway",
		roomModels: [{ modelId: "room-model", label: "Room Model" }],
		maintenanceModel: "room-model",
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(productAppRoot, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeEnv(),
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const created = await requestJson("/api/persistent-agents", jsonBody("POST", { displayName: "Review Run Route Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }));
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	assert(roomId, `room creation should return an agent id, got ${JSON.stringify(created.body)}`);
	const room = `/api/persistent-agents/${roomId}`;
	const l1bPath = path.join(agentsRoot, roomId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, fixtureL1b(roomId), { mode: 0o600 });
	const fixtureBytes = fs.readFileSync(l1bPath, "utf-8");

	const budgetSet = await requestJson(`${room}/maintenance-settings`, jsonBody("PUT", { memoryBudgetTokens: MIN_BUDGET_TOKENS }));
	assert(budgetSet.status === 200, `setting the budget to ${MIN_BUDGET_TOKENS} should return 200, got ${budgetSet.status}: ${JSON.stringify(budgetSet.body)}`);

	// --- 1. The status block a room shows before Review starts ----------------
	const status = await requestJson(`${room}/review/status`);
	assert(status.status === 200, `GET review/status should return 200, got ${status.status}: ${JSON.stringify(status.body)}`);
	assert(status.body.available === true && !status.body.reason, `a room with notes should be able to review, got ${JSON.stringify(status.body)}`);
	assert(status.body.topics === FIXTURE_TOPICS.length + 1, `the status should count every topic that holds a note, got ${JSON.stringify(status.body.topics)}`);
	assert(status.body.notes === FIXTURE_TOPICS.length * NOTES_PER_TOPIC + 2, `the status should count every note, got ${JSON.stringify(status.body.notes)}`);
	assert(status.body.budget?.overBudget === true && status.body.budget.budgetTokens === MIN_BUDGET_TOKENS, `the status should measure this memory against the room's own budget, got ${JSON.stringify(status.body.budget)}`);
	assert(status.body.recommendedDepth === "tidy", `a memory over its limit should be offered the deeper tidy first, got ${JSON.stringify(status.body.recommendedDepth)}`);
	assert(status.body.writesMemory === false, "looking at a room's review never writes memory");

	const badDepth = await requestJson(`${room}/review/runs`, jsonBody("POST", {}));
	assert(badDepth.status === 400 && badDepth.body?.code === "review_run_bad_depth", `a review needs the depth the person chose, got ${badDepth.status}: ${JSON.stringify(badDepth.body)}`);

	// --- 2. A review while the room is already updating its memory ------------
	const assessed = await requestJson(`${room}/absorb/assess`, jsonBody("POST", {}));
	assert(assessed.status === 200, `POST absorb/assess should return 200, got ${assessed.status}: ${JSON.stringify(assessed.body)}`);
	const memorize = await requestJson(`${room}/absorb/propose`, jsonBody("POST", { assessmentMarkdown: String(assessed.body?.assessmentMarkdown ?? "") }));
	assert(memorize.status === 202, `POST absorb/propose should return 202, got ${memorize.status}: ${JSON.stringify(memorize.body)}`);
	const blocked = await requestJson(`${room}/review/runs`, jsonBody("POST", { depth: "tidy" }));
	assert(blocked.status === 409 && blocked.body?.code === "review_absorb_active", `a review while the room is memorizing should be refused with its own code, got ${blocked.status}: ${JSON.stringify(blocked.body)}`);
	assert(/updating its memory/.test(String(blocked.body?.error ?? "")), `the refusal should say what is in the way, got ${JSON.stringify(blocked.body?.error)}`);
	const cancelledMemorize = await requestJson(`${room}/absorb/runs/${memorize.body.runId}/cancel`, jsonBody("POST", {}));
	assert(cancelledMemorize.status === 200 && cancelledMemorize.body?.state === "cancelled", `the memory update should cancel, got ${cancelledMemorize.status}: ${JSON.stringify(cancelledMemorize.body?.state)}`);

	// --- 3. Starting the review, and the refusal of a second one ---------------
	const startedRun = await requestJson(`${room}/review/runs`, jsonBody("POST", { depth: "tidy", topics: FIXTURE_TOPICS, guidance: { shorten: ["Commercial terms"], junk: 7 } }));
	assert(startedRun.status === 202, `POST review/runs should return 202 the moment the run starts, got ${startedRun.status}: ${JSON.stringify(startedRun.body)}`);
	const runId = String(startedRun.body?.runId ?? "");
	assert(runId, `POST review/runs should answer with the run's id, got ${JSON.stringify(startedRun.body)}`);

	const second = await requestJson(`${room}/review/runs`, jsonBody("POST", { depth: "tidy" }));
	assert(second.status === 409 && second.body?.code === "review_run_active", `a second review while one is running should be refused with 409, got ${second.status}: ${JSON.stringify(second.body)}`);
	assert(second.body?.details?.runId === runId, `the refusal should name the run in the way, so the client can offer to cancel it, got ${JSON.stringify(second.body?.details)}`);

	// --- 4. Watching the run until it is ready --------------------------------
	const runUrl = `${room}/review/runs/${runId}`;
	const pollDeadline = Date.now() + 120_000;
	let run: any = null;
	while (Date.now() < pollDeadline) {
		const polled = await requestJson(runUrl);
		assert(polled.status === 200, `GET review/runs/:runId should return 200 while the run is open, got ${polled.status}: ${JSON.stringify(polled.body)}`);
		run = polled.body;
		if (!["prepass", "tidying", "budget"].includes(String(run.state))) break;
		await new Promise((resolve) => setTimeout(resolve, 300));
	}
	assert(run, "the run should have been readable at least once");
	assert(run.state === "ready", `the run should end ready to approve, got state ${JSON.stringify(run.state)}${run.error ? ` with error ${JSON.stringify(run.error)}` : ""}`);
	assert(run.runId === runId && run.agentId === roomId, `the run should identify itself and its room, got ${JSON.stringify({ runId: run.runId, agentId: run.agentId })}`);
	assert(run.depth === "tidy", `the run should carry the depth it was started with, got ${JSON.stringify(run.depth)}`);
	assert(Array.isArray(run.guidance?.shorten) && run.guidance.shorten[0] === "Commercial terms" && !("junk" in run.guidance), `the sign-off should come back on the run, bounded to the fields it defines, got ${JSON.stringify(run.guidance)}`);
	assert(run.topics.length === FIXTURE_TOPICS.length, `the run should tidy the topics it was given, got ${JSON.stringify(run.topics)}`);
	assert(run.progress.groups >= 2 && run.progress.group === run.progress.groups, `every group should have finished, got ${JSON.stringify(run.progress)}`);
	assert(Array.isArray(run.changes) && run.changes.length > 0, `the run should have tidied something, got ${JSON.stringify(run.changes)}`);
	assert(run.changes.every((change: any) => /^m-\d{4}$/.test(String(change.id)) && change.topic && change.kind), `every row should be a readable card, got ${JSON.stringify(run.changes[0])}`);
	assert(Array.isArray(run.leftAsIs), "the run always says which topics were left as they were, even when none were");
	assert(run.candidate?.sourceFingerprint?.algorithm === "sha256", `a ready run carries the fingerprint of the memory it was built on, got ${JSON.stringify(run.candidate)}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === fixtureBytes, "a review writes nothing until it is approved");
	assert(gatewayCalls.filter((call) => call.kind === "tidy").length === run.progress.groups, `one tidy call per group, and no more, got ${JSON.stringify(gatewayCalls.map((call) => call.kind))}`);

	// --- 5. Keeping a note the tidy wanted to archive --------------------------
	const archivedRow = run.changes.find((change: any) => change.kind === "archived");
	assert(archivedRow, `the scripted tidy archives a note in every group, and the run shows none: ${JSON.stringify(run.changes.map((c: any) => c.kind))}`);
	const kept = await requestJson(`${runUrl}/keep`, jsonBody("POST", { entryIds: [archivedRow.id] }));
	assert(kept.status === 200, `POST review/runs/:runId/keep should return 200, got ${kept.status}: ${JSON.stringify(kept.body)}`);
	assert(kept.body.demotion.keepIds.includes(archivedRow.id), `the kept note should be listed as kept, got ${JSON.stringify(kept.body.demotion.keepIds)}`);
	// A budget row kept over the route stays on the list; a protected topic is
	// accepted in the same body and leaves the kept ids alone.
	const budgetRow = kept.body.demotion.entries.find((entry: any) => entry.leaving);
	assert(budgetRow, `this memory is over its limit, so the run should list what would leave, got ${JSON.stringify(kept.body.demotion.counts)}`);
	const keptBoth = await requestJson(`${runUrl}/keep`, jsonBody("POST", { keepIds: [archivedRow.id, budgetRow.id], keepTopics: [`${budgetRow.section}/${budgetRow.topic}`] }));
	assert(keptBoth.status === 200, `POST review/runs/:runId/keep with both lists should return 200, got ${keptBoth.status}: ${JSON.stringify(keptBoth.body)}`);
	const keptBudgetRow = keptBoth.body.demotion.entries.find((entry: any) => entry.id === budgetRow.id);
	assert(keptBudgetRow?.kept === true && keptBudgetRow.leaving === false, `a kept row stays on the list, kept and no longer leaving, got ${JSON.stringify(keptBudgetRow)}`);
	assert(JSON.stringify(keptBoth.body.demotion.keepTopics) === JSON.stringify([`${budgetRow.section}/${budgetRow.topic}`]) && keptBoth.body.demotion.keepIds.length === 2, `the run echoes both lists, got ${JSON.stringify(keptBoth.body.demotion)}`);
	assert(keptBoth.body.demotion.counts.kept === keptBoth.body.demotion.entries.filter((entry: any) => entry.kept).length, `the counts are the server's, got ${JSON.stringify(keptBoth.body.demotion.counts)}`);
	const backToOne = await requestJson(`${runUrl}/keep`, jsonBody("POST", { entryIds: [archivedRow.id], keepTopics: [] }));
	assert(backToOne.status === 200 && backToOne.body.demotion.keepIds.length === 1 && backToOne.body.demotion.keepTopics.length === 0, `the older entryIds name still works, got ${JSON.stringify(backToOne.body?.demotion)}`);

	// --- 6. The person's own words on a note the review rewrote ----------------
	const shortened = run.changes.find((change: any) => change.kind === "shortened");
	assert(shortened, "the scripted tidy shortens a note in every group");
	const edited = await requestJson(`${runUrl}/edit`, jsonBody("POST", { entryId: shortened.id, text: "The renewal month and the signing route, in one line." }));
	assert(edited.status === 200, `POST review/runs/:runId/edit should return 200, got ${edited.status}: ${JSON.stringify(edited.body)}`);
	assert(edited.body.changes.some((change: any) => change.id === shortened.id && change.after === "- The renewal month and the signing route, in one line."), `the edit should show on the card with the topic's own bullet, got ${JSON.stringify(edited.body.changes.find((c: any) => c.id === shortened.id))}`);
	const notMine = await requestJson(`${runUrl}/edit`, jsonBody("POST", { entryId: "m-0901", text: "not this one" }));
	assert(notMine.status === 404, `a note this review did not rewrite is not editable here, got ${notMine.status}: ${JSON.stringify(notMine.body)}`);

	// --- 7. Raising the limit on the run ---------------------------------------
	const tooSmall = await requestJson(`${runUrl}/budget`, jsonBody("POST", { budgetTokens: 9000 }));
	assert(tooSmall.status === 400 && /between 10000 and 80000/.test(String(tooSmall.body?.error ?? "")), `a budget below the floor should be refused with what a budget may be, got ${tooSmall.status}: ${JSON.stringify(tooSmall.body)}`);
	const raised = await requestJson(`${runUrl}/budget`, jsonBody("POST", { budgetTokens: RAISED_BUDGET_TOKENS }));
	assert(raised.status === 200 && raised.body.budget.budgetTokens === RAISED_BUDGET_TOKENS, `POST review/runs/:runId/budget should return the run measured against the new budget, got ${raised.status}: ${JSON.stringify(raised.body?.budget)}`);
	assert(raised.body.demotion.counts.leaving === 0 && raised.body.demotion.entries.length >= kept.body.demotion.entries.length, `at ${RAISED_BUDGET_TOKENS} tokens nothing has to leave this memory and the rows stay listed, got ${JSON.stringify(raised.body.demotion.counts)}`);
	const settingsAfterRaise = await requestJson(`${room}/maintenance-settings`);
	assert(settingsAfterRaise.body?.settings?.memoryBudgetTokens === MIN_BUDGET_TOKENS && raised.body.budget.savedBudgetTokens === MIN_BUDGET_TOKENS, `raising the limit on the card must not store it on the room before Save, got ${JSON.stringify({ settings: settingsAfterRaise.body?.settings, budget: raised.body.budget })}`);

	// --- 8. Approving: the one write ------------------------------------------
	const approved = await requestJson(`${runUrl}/approve`, jsonBody("POST", {}));
	assert(approved.status === 200, `POST review/runs/:runId/approve should return 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
	assert(approved.body.budgetRaisedTo === RAISED_BUDGET_TOKENS && approved.body.memoryBudget?.budgetTokens === RAISED_BUDGET_TOKENS, `the limit the card raised is written by the save and named to the saved screen, got ${JSON.stringify({ budgetRaisedTo: approved.body.budgetRaisedTo, memoryBudget: approved.body.memoryBudget })}`);
	const settingsAfterApproval = await requestJson(`${room}/maintenance-settings`);
	assert(settingsAfterApproval.body?.settings?.memoryBudgetTokens === RAISED_BUDGET_TOKENS, `the limit the card raised is the room's from the save on, got ${JSON.stringify(settingsAfterApproval.body?.settings)}`);
	assert(typeof approved.body.reviewId === "string" && approved.body.saveId === approved.body.reviewId, `an approval should name the write it made under both names, got ${JSON.stringify({ reviewId: approved.body.reviewId, saveId: approved.body.saveId })}`);
	assert(approved.body.writesMemory === true && approved.body.notesChanged > 0, `an approval is the one write of the run, got ${JSON.stringify({ writesMemory: approved.body.writesMemory, notesChanged: approved.body.notesChanged })}`);
	assert(approved.body.eventRelPath.startsWith("events/review/") && !path.isAbsolute(approved.body.eventRelPath), `an approval names its record by the room-relative path, got ${JSON.stringify(approved.body.eventRelPath)}`);
	const approvalJson = JSON.stringify(approved.body);
	for (const key of ["archivedL1bPath", "updatedL1bPath", "eventRecordPath"]) {
		assert(!approvalJson.includes(key), `an approval a browser reads must not carry ${key}, and it did: ${approvalJson}`);
	}
	assert(!approvalJson.includes(tempHome), "an approval must not carry a local absolute path");

	const written = fs.readFileSync(l1bPath, "utf-8");
	assert(written !== fixtureBytes, "approve is the write");
	assert(/^- Last review: review_/m.test(written), `the write should stamp Chronos with this review, got ${JSON.stringify(written.slice(0, 400))}`);
	assert(/^##\s+Deep Memory$/m.test(written) && /^##\s+Active Items$/m.test(written) && /^##\s+Recent Context$/m.test(written), "the write should keep the memory's own sections");
	assert(/^###\s+RC-0001/m.test(written), "a review never touches what the room has remembered but not yet memorized");
	assert(/id=m-0001\b/.test(written) && /from=RC-0002/.test(written), "every note that stayed kept its id and where it came from: the whole reason Review was rebuilt");

	const undone = await requestJson(`${room}/memory/undo`, jsonBody("POST", { saveId: approved.body.saveId }));
	assert(undone.status === 200, `POST memory/undo should take a review back, got ${undone.status}: ${JSON.stringify(undone.body)}`);
	assert(undone.body?.undone?.kind === "review", `the undo should say it took back a review, got ${JSON.stringify(undone.body?.undone)}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === fixtureBytes, "undo puts the file back byte for byte");

	const history = await requestJson(`${room}/memory/history`);
	assert(history.status === 200, `GET memory/history should return 200, got ${history.status}`);
	const historyRow = (history.body.events ?? history.body.history ?? history.body).find?.((event: any) => event.kind === "review" && event.id === approved.body.saveId);
	assert(historyRow?.undone === true, `the history should carry the review, marked as taken back, got ${JSON.stringify(history.body).slice(0, 400)}`);

	// --- 9. The run's routes are classified for remote devices ----------------
	const inventory = await requestJson("/api/remote/test/routes");
	assert(inventory.status === 200, `the route table should be readable from the computer itself, got ${inventory.status}: ${JSON.stringify(inventory.body)}`);
	const classOf = (method: string, url: string): string | null => {
		const found = (inventory.body.routes as any[]).find((route) => route.method === method && route.url === url);
		assert(found, `${method} ${url} should be a registered route, and it is not in the live route table`);
		return found.class ?? null;
	};
	for (const url of ["/api/persistent-agents/:id/review/status", "/api/persistent-agents/:id/review/runs/:runId"]) {
		assert(classOf("GET", url) === "read", `watching a review is a room read, got ${JSON.stringify(classOf("GET", url))} for GET ${url}`);
	}
	for (const url of ["/api/persistent-agents/:id/review/runs", "/api/persistent-agents/:id/review/runs/:runId/keep", "/api/persistent-agents/:id/review/runs/:runId/budget", "/api/persistent-agents/:id/review/runs/:runId/edit", "/api/persistent-agents/:id/review/runs/:runId/cancel", "/api/persistent-agents/:id/review/runs/:runId/approve"]) {
		assert(classOf("POST", url) === "write", `changing a review is room interaction, so POST ${url} should be classified write, got ${JSON.stringify(classOf("POST", url))}`);
	}

	// --- 10. Cancel, on a run of its own --------------------------------------
	const secondRun = await requestJson(`${room}/review/runs`, jsonBody("POST", { depth: "wording" }));
	assert(secondRun.status === 202, `a review after the first one was approved should start, got ${secondRun.status}: ${JSON.stringify(secondRun.body)}`);
	const cancelled = await requestJson(`${room}/review/runs/${secondRun.body.runId}/cancel`, jsonBody("POST", {}));
	assert(cancelled.status === 200 && cancelled.body?.state === "cancelled", `POST review/runs/:runId/cancel should end the run, got ${cancelled.status}: ${JSON.stringify(cancelled.body?.state)}`);
	const unknown = await requestJson(`${room}/review/runs/reviewrun_nope/`);
	assert(unknown.status === 404 || unknown.status === 400, `a run id nobody has should not be found, got ${unknown.status}: ${JSON.stringify(unknown.body)}`);

	console.log(`review-run-route-smoke: OK (${Math.round((Date.now() - startedAt) / 1000)}s, ${gatewayCalls.length} model calls)`);
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	console.error(`gateway calls: ${JSON.stringify(gatewayCalls)}`);
	console.error(serverOutput.slice(-40).join(""));
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	gateway.close();
	if (process.exitCode !== 1) fs.rmSync(tempHome, { recursive: true, force: true });
}
