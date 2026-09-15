// The Memorize run over its real routes, against a really spawned web server.
//
// Memorize stops being one long request that hands back a whole rewritten
// memory: the server folds a room's remembered sessions into its memory one at
// a time, the client watches that happen, adjusts what the budget would archive,
// and approves at the end. This smoke drives that whole path on one room — the
// status block a room shows before anything starts, starting the run, the
// refusal of a second run while one is open, the polling until the run is ready,
// keeping an entry the budget wanted to archive, raising the room's budget, and
// approving — and it checks the file on disk afterwards, because the promise the
// run makes is that nothing is written until approve and that approve then
// really clears the sessions it folded.
//
// The model is a local gateway that answers what the prompt asks for: the
// assessment prompt gets an assessment, and each fold prompt gets a narrative
// and one operations block naming entries that prompt actually listed. So every
// call in this smoke is the real worker path with a scripted reply, and the run
// is exercised end to end without a provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-run-route-home-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;
const agentDir = path.join(tempHome, ".exxperts", "agent");
const productAppRoot = path.join(tempHome, ".exxperts", "app");
const agentsRoot = path.join(productAppRoot, "personalized-agents");

const SESSION_COUNT = 5;
const MIN_BUDGET_TOKENS = 10_000;
const RAISED_BUDGET_TOKENS = 40_000;
const FIXTURE_TOPICS = ["Commercial terms", "Delivery practice", "Reporting rhythm", "Working style"];
const FIXTURE_ENTRIES_PER_TOPIC = 40;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// --- The fixture: a room whose memory is well past the smallest budget -------

function fixtureEntryText(topic: string, n: number): string {
	return `- ${topic} note ${n}: the room keeps the agreed rate, the renewal month, the signing route and the escalation path for account ${n}, together with the reporting rhythm the account team settled on and the handover the account owner asked for, so a later session does not have to rediscover any of it.`;
}

function fixtureDeepMemory(): string {
	return FIXTURE_TOPICS
		.map((topic) => {
			const bullets = Array.from({ length: FIXTURE_ENTRIES_PER_TOPIC }, (_, i) => fixtureEntryText(topic, i + 1)).join("\n");
			return `### ${topic}\n\n${bullets}\n`;
		})
		.join("\n");
}

function fixtureSession(n: number): string {
	return `### RC-${String(n).padStart(4, "0")} | OPEN | 2026-09-0${n} | Account review session ${n}\n\n**Session arc:** Session ${n} settled one commercial question and left one follow-up open.\n\n**Body:**\n- The renewal for account ${n} moves to the first working day of the quarter.\n- The account team wants the reporting pack one page shorter.\n\n**Parked:**\nThe signed addendum for account ${n} is still outstanding.\n`;
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

${fixtureDeepMemory()}
## Active Items

- Chase the vendor for the signed addendum.
- Send the shortened reporting pack to the account team.
- Confirm the renewal month with legal.

## Recent Context

${sessions}`;
}

// --- The gateway: one scripted reply per kind of prompt ----------------------

interface GatewayCall {
	kind: "assessment" | "fold" | "other";
	session: string;
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
- The shorter reporting pack the account team asked for.
- The escalation route the account owner confirmed.

### What to forget

- The scheduling chatter around each review call.
- The repeated restatements of what memory already holds.

### What changes in stable memory

- Deep Memory: the commercial terms entries take the newer renewal dates.
- Active Items: the outstanding addendum stays open until it is signed.
- Recent Context: all entries are expected to be cleared after approval.

### Needs your judgment

- None
`;

interface AreaRow {
	id: string;
	topic: string;
	kind: string;
	pinned: boolean;
}

/** The entries a fold prompt listed as addressable, read back out of the prompt. */
function areaRowsIn(prompt: string): AreaRow[] {
	const rows: AreaRow[] = [];
	const rowPattern = /^- (m-\d{4}) · ([^·\n]+?) · (event|fact|practice|item)( · pinned)? · /gm;
	for (let match = rowPattern.exec(prompt); match; match = rowPattern.exec(prompt)) {
		rows.push({ id: match[1], topic: match[2].trim(), kind: match[3], pinned: Boolean(match[4]) });
	}
	return rows;
}

function foldReply(prompt: string): string {
	const sessionId = /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "RC-0000";
	const rows = areaRowsIn(prompt);
	const target = rows.find((row) => !row.pinned && row.kind !== "item");
	const topic = target?.topic ?? FIXTURE_TOPICS[0];
	const ops: Array<Record<string, string>> = [];
	if (target) {
		ops.push({
			op: "update",
			id: target.id,
			text: `- ${topic} note, as it now stands after ${sessionId}: the agreed rate, the renewal month, the signing route and the escalation path all still hold, the reporting pack is one page shorter than it was, and the account owner keeps the handover, so the point survives in one entry instead of two.`,
		});
	}
	// Each session leaves a point of its own: the fold refuses an add that says
	// what a note already in memory says, and the note session one adds is in
	// memory by the time session two is folded.
	const points = [
		"the renewal moves to the first working day of the quarter, and the account owner stays the escalation route",
		"the reporting pack drops its appendix, so the quarterly deck is one page shorter from the next cycle on",
		"invoices for the account are raised on the last Friday of the month, with the signing route unchanged",
		"the vendor addendum is countersigned by legal before the notice window opens in April",
		"the handover of the account stays with the account owner until the counterparty confirms its new contact",
	];
	ops.push({
		op: "add",
		topic,
		kind: "fact",
		text: `- The point ${sessionId} leaves behind: ${points[(Number(sessionId.slice(3)) || 0) % points.length]}.`,
	});
	return `${sessionId} leaves behind one commercial point worth keeping and one restatement of what memory already holds. The point is folded into the entry that already carries it, and the newer renewal shape is added beside it.\n\n\`\`\`json\n${JSON.stringify({ ops }, null, 2)}\n\`\`\`\n`;
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
		const isFold = prompt.includes("## Task: Fold This Session Into Memory");
		const isAssessment = prompt.includes("## Task: Compact Initial Assessment");
		const kind: GatewayCall["kind"] = isFold ? "fold" : isAssessment ? "assessment" : "other";
		const session = /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "";
		gatewayCalls.push({ kind, session });
		const text = isFold ? foldReply(prompt) : isAssessment ? ASSESSMENT_REPLY : "Nothing to do here.";
		const base = { id: `cmpl_${gatewayCalls.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "room-model" };
		// A fold call takes a beat, the way a real one does: the run must still be
		// open when the smoke asks for a second one.
		setTimeout(() => {
			res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { content: text }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1200, completion_tokens: 180, total_tokens: 1380 } }));
			res.write("data: [DONE]\n\n");
			res.end();
		}, isFold ? 300 : 0);
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
		providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-absorb-run-key" } }, null, 2), { mode: 0o600 });
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

	const created = await requestJson("/api/persistent-agents", jsonBody("POST", { displayName: "Memorize Run Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }));
	assert(created.status === 201, `room creation should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	const roomId = String(created.body?.agent?.id ?? "");
	assert(roomId, `room creation should return an agent id, got ${JSON.stringify(created.body)}`);
	const room = `/api/persistent-agents/${roomId}`;
	const l1bPath = path.join(agentsRoot, roomId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, fixtureL1b(roomId), { mode: 0o600 });

	// The smallest budget a room can hold, so this memory is over it from the
	// start and the run has something to archive both before and after folding.
	const budgetSet = await requestJson(`${room}/maintenance-settings`, jsonBody("PUT", { memoryBudgetTokens: MIN_BUDGET_TOKENS }));
	assert(budgetSet.status === 200 && budgetSet.body?.settings?.memoryBudgetTokens === MIN_BUDGET_TOKENS, `setting the budget to ${MIN_BUDGET_TOKENS} should return 200 with the stored number, got ${budgetSet.status}: ${JSON.stringify(budgetSet.body)}`);

	// --- 1. The status block a room shows before Memorize starts --------------
	const status = await requestJson(`${room}/absorb/status`);
	assert(status.status === 200, `GET absorb/status should return 200, got ${status.status}: ${JSON.stringify(status.body)}`);
	assert(status.body.available === true, `a room with ${SESSION_COUNT} remembered sessions should be able to Memorize, got ${JSON.stringify(status.body.message)}`);
	assert(status.body.version === 2, `the status block should declare version 2, got ${JSON.stringify(status.body.version)}`);
	const statusSessions: any[] = status.body.sessions;
	assert(Array.isArray(statusSessions) && statusSessions.length === SESSION_COUNT, `the status block should list the room's ${SESSION_COUNT} sessions, got ${JSON.stringify(statusSessions)}`);
	assert(statusSessions.every((session) => /^RC-\d{4}$/.test(String(session.id))), `every listed session should carry its RC id, got ${JSON.stringify(statusSessions.map((session) => session.id))}`);
	assert(statusSessions.every((session) => /^Account review session \d$/.test(String(session.title))), `every listed session should carry its own title, got ${JSON.stringify(statusSessions.map((session) => session.title))}`);
	assert(statusSessions.every((session) => /^\d{4}-\d{2}-\d{2}$/.test(String(session.date))), `every listed session should carry its date, got ${JSON.stringify(statusSessions.map((session) => session.date))}`);
	assert(statusSessions.every((session) => typeof session.tokens === "number" && session.tokens > 0), `every listed session should carry its size, got ${JSON.stringify(statusSessions.map((session) => session.tokens))}`);
	assert(status.body.budget?.budgetTokens === MIN_BUDGET_TOKENS, `the status block should read the room's own budget, got ${JSON.stringify(status.body.budget)}`);
	assert(status.body.budget.reviewTargetTokens > MIN_BUDGET_TOKENS && status.body.budget.overBudget === true, `this room's memory is deliberately over its budget, so the status block should say so, got ${JSON.stringify(status.body.budget)}`);
	assert(status.body.prepass?.demotionRequired === true && status.body.prepass.entriesOverBudget > 0, `the status block should say how many entries would have to leave before a single call is made, got ${JSON.stringify(status.body.prepass)}`);

	// --- 2. The assessment the user approves before the run starts ------------
	const assessed = await requestJson(`${room}/absorb/assess`, jsonBody("POST", {}));
	assert(assessed.status === 200, `POST absorb/assess should return 200, got ${assessed.status}: ${JSON.stringify(assessed.body)}`);
	const assessmentMarkdown = String(assessed.body?.assessmentMarkdown ?? "");
	assert(assessmentMarkdown.includes("## Absorb assessment"), `the assessment should come back as the markdown the run carries, got ${JSON.stringify(assessmentMarkdown.slice(0, 120))}`);
	assert(assessed.body.writesMemory === false, `an assessment must not write memory, got ${JSON.stringify(assessed.body.writesMemory)}`);

	// --- 3. Starting the run, and the refusal of a second one -----------------
	const proposed = await requestJson(`${room}/absorb/propose`, jsonBody("POST", { assessmentMarkdown }));
	assert(proposed.status === 202, `POST absorb/propose should return 202 the moment the run starts, got ${proposed.status}: ${JSON.stringify(proposed.body)}`);
	const runId = String(proposed.body?.runId ?? "");
	assert(typeof proposed.body?.runId === "string" && runId.length > 0, `POST absorb/propose should answer with the run's id, got ${JSON.stringify(proposed.body)}`);

	const second = await requestJson(`${room}/absorb/propose`, jsonBody("POST", { assessmentMarkdown }));
	assert(second.status === 409, `a second Memorize while one is running should be refused with 409, got ${second.status}: ${JSON.stringify(second.body)}`);
	assert(second.body?.code === "absorb_run_active", `the refusal should carry the code the client branches on, got ${JSON.stringify(second.body)}`);
	assert(second.body?.details?.runId === runId, `the refusal should name the run in the way, so the client can offer to cancel it, got ${JSON.stringify(second.body?.details)}`);

	// --- 4. Watching the run until it is ready --------------------------------
	const runUrl = `${room}/absorb/runs/${runId}`;
	const pollDeadline = Date.now() + 120_000;
	let run: any = null;
	while (Date.now() < pollDeadline) {
		const polled = await requestJson(runUrl);
		assert(polled.status === 200, `GET absorb/runs/:runId should return 200 while the run is open, got ${polled.status}: ${JSON.stringify(polled.body)}`);
		run = polled.body;
		if (!["prepass", "folding", "budget"].includes(String(run.state))) break;
		await new Promise((resolve) => setTimeout(resolve, 400));
	}
	assert(run, "the run should have been readable at least once");
	assert(run.state === "ready", `the run should end ready to approve, got state ${JSON.stringify(run.state)}${run.error ? ` with error ${JSON.stringify(run.error)}` : ""}`);
	assert(run.runId === runId && run.agentId === roomId, `the run should identify itself and its room, got ${JSON.stringify({ runId: run.runId, agentId: run.agentId })}`);
	const runSessions: any[] = run.sessions;
	assert(runSessions.length === SESSION_COUNT, `the run should account for all ${SESSION_COUNT} sessions, got ${runSessions.length}`);
	assert(runSessions.every((session) => session.outcome === "folded" || session.outcome === "dropped"), `every session should have been folded or dropped, got ${JSON.stringify(runSessions.map((session) => ({ id: session.id, outcome: session.outcome, reason: session.reason })))}`);
	assert(runSessions.every((session) => session.attempts === 1), `a fold the memory accepted should take one attempt, got ${JSON.stringify(runSessions.map((session) => session.attempts))}`);
	assert(run.progress.folded === run.progress.total && run.progress.total === SESSION_COUNT, `progress should end at ${SESSION_COUNT} of ${SESSION_COUNT}, got ${JSON.stringify(run.progress)}`);
	assert(run.progress.current === undefined, `a finished run should name no session in flight, got ${JSON.stringify(run.progress.current)}`);
	assert(run.candidate && run.candidate.sourceFingerprint?.algorithm === "sha256" && /^[a-f0-9]{64}$/.test(String(run.candidate.sourceFingerprint.value)), `a ready run should carry the candidate and the fingerprint of the memory it was built on, got ${JSON.stringify(run.candidate)}`);
	assert(typeof run.candidate.estimatedTokens === "number" && run.candidate.estimatedTokens > 0, `the candidate should disclose its size, got ${JSON.stringify(run.candidate)}`);
	assert(Array.isArray(run.prepass?.demoted) && run.prepass.demoted.length > 0, `this room was over budget before any call, so the run should disclose what it archived first, got ${JSON.stringify(run.prepass)}`);
	assert(run.budget.budgetTokens === MIN_BUDGET_TOKENS && run.budget.before > MIN_BUDGET_TOKENS, `the run should measure this memory against the room's own budget, got ${JSON.stringify(run.budget)}`);
	assert(run.migration?.pending === true && run.migration.entriesAssigned > 0, `this room's memory had no entry ids, so the run should carry the migration it will perform at approve, got ${JSON.stringify(run.migration)}`);
	assert(Array.isArray(run.warnings) && !run.warnings.some((warning: string) => /entry ids/.test(warning)), `the migration is a note on the run, never a warning that would keep the card from applying automatically, got ${JSON.stringify(run.warnings)}`);
	assert(fs.readFileSync(l1bPath, "utf-8") === fixtureL1b(roomId), "a proposal writes nothing: a room whose memory has no entry ids must still be byte for byte as it was");
	assert(gatewayCalls.filter((call) => call.kind === "fold").length === SESSION_COUNT, `one fold call per session, and no more, got ${JSON.stringify(gatewayCalls.map((call) => call.kind))}`);
	assert(gatewayCalls.length === SESSION_COUNT + 1, `the whole run should cost one call per session plus the assessment, got ${JSON.stringify(gatewayCalls.map((call) => call.kind))}`);

	// --- 5. Keeping an entry the budget wanted to archive ---------------------
	const demotionBefore: any[] = run.demotion.entries;
	assert(demotionBefore.length > 0, `the folds put this memory over its budget again, so the run should offer a demotion list, got ${JSON.stringify(run.demotion)}`);
	assert(demotionBefore.every((entry) => /^m-\d{4}$/.test(String(entry.id)) && typeof entry.tokens === "number" && entry.text), `every entry on the demotion list should be a readable card, got ${JSON.stringify(demotionBefore[0])}`);
	const keptId = String(demotionBefore[0].id);
	const kept = await requestJson(`${runUrl}/keep`, jsonBody("POST", { keepIds: [keptId] }));
	assert(kept.status === 200, `POST absorb/runs/:runId/keep should return 200, got ${kept.status}: ${JSON.stringify(kept.body)}`);
	assert(kept.body.runId === runId && kept.body.state === "ready", `a keep should hand the whole run back, still ready, got ${JSON.stringify({ runId: kept.body.runId, state: kept.body.state })}`);
	assert(kept.body.demotion.keepIds.includes(keptId), `the kept entry should be listed as kept, got ${JSON.stringify(kept.body.demotion.keepIds)}`);
	const keptRow = kept.body.demotion.entries.find((entry: any) => entry.id === keptId);
	assert(keptRow?.kept === true && keptRow.leaving === false, `the kept entry should stay on the list, kept and no longer leaving, got ${JSON.stringify(keptRow)}`);
	assert(kept.body.demotion.entries.some((entry: any) => entry.leaving && entry.instead), `keeping one entry means another has to go instead, marked as such, got ${JSON.stringify(kept.body.demotion.counts)}`);
	assert(kept.body.demotion.counts.kept === 1 && kept.body.demotion.counts.instead > 0, `the card's counts come from the server, got ${JSON.stringify(kept.body.demotion.counts)}`);
	// A protected topic over the same route: keepIds is left as it was.
	const leavingRow = kept.body.demotion.entries.find((entry: any) => entry.leaving);
	const topicAddress = `${leavingRow.section}/${leavingRow.topic}`;
	const byTopic = await requestJson(`${runUrl}/keep`, jsonBody("POST", { keepTopics: [topicAddress] }));
	assert(byTopic.status === 200 && JSON.stringify(byTopic.body.demotion.keepTopics) === JSON.stringify([topicAddress]) && byTopic.body.demotion.keepIds.includes(keptId), `a keep body with keepTopics alone protects the topic and leaves the kept ids alone, got ${JSON.stringify(byTopic.body?.demotion)}`);
	assert(byTopic.body.demotion.entries.filter((entry: any) => entry.section === leavingRow.section && entry.topic === leavingRow.topic).every((entry: any) => entry.kept && !entry.leaving), "no note of a protected topic leaves");
	const unprotected = await requestJson(`${runUrl}/keep`, jsonBody("POST", { keepTopics: [] }));
	assert(unprotected.status === 200 && unprotected.body.demotion.keepTopics.length === 0 && unprotected.body.demotion.keepIds.includes(keptId), `clearing the topics keeps the kept ids, got ${JSON.stringify(unprotected.body?.demotion?.keepIds)}`);

	// --- 6. Raising the limit on the run instead ------------------------------
	const raised = await requestJson(`${runUrl}/budget`, jsonBody("POST", { budgetTokens: RAISED_BUDGET_TOKENS }));
	assert(raised.status === 200, `POST absorb/runs/:runId/budget should return 200, got ${raised.status}: ${JSON.stringify(raised.body)}`);
	assert(raised.body.budget.budgetTokens === RAISED_BUDGET_TOKENS, `the run should come back measured against the new budget, got ${JSON.stringify(raised.body.budget)}`);
	assert(raised.body.demotion.counts.leaving === 0 && raised.body.demotion.overageTokens === 0, `at ${RAISED_BUDGET_TOKENS} tokens nothing has to leave this memory any more, got ${JSON.stringify(raised.body.demotion.counts)}`);
	assert(raised.body.demotion.entries.length >= kept.body.demotion.entries.length, "the rows stay listed after a raise");
	assert(raised.body.budget.overBudgetAfter === false && raised.body.budget.after <= RAISED_BUDGET_TOKENS, `the raised budget should leave the candidate inside it, got ${JSON.stringify(raised.body.budget)}`);
	const settingsAfterRaise = await requestJson(`${room}/maintenance-settings`);
	assert(settingsAfterRaise.body?.settings?.memoryBudgetTokens === MIN_BUDGET_TOKENS && raised.body.budget.savedBudgetTokens === MIN_BUDGET_TOKENS, `raising the limit on the card must not store it on the room before Save, got ${JSON.stringify({ settings: settingsAfterRaise.body?.settings, budget: raised.body.budget })}`);

	const tooSmall = await requestJson(`${runUrl}/budget`, jsonBody("POST", { budgetTokens: 9000 }));
	assert(tooSmall.status === 400, `a budget below the floor should be refused with 400, got ${tooSmall.status}: ${JSON.stringify(tooSmall.body)}`);
	assert(/between 10000 and 80000/.test(String(tooSmall.body?.error ?? "")), `the refusal should say what a budget may be, got ${JSON.stringify(tooSmall.body)}`);
	const afterRefusal = await requestJson(`${runUrl}`);
	assert(afterRefusal.body?.budget?.budgetTokens === RAISED_BUDGET_TOKENS, `a refused budget must not have moved the run's limit, got ${JSON.stringify(afterRefusal.body?.budget)}`);

	// --- 7. Approving: the one write, and the file it leaves behind -----------
	const approved = await requestJson(`${room}/absorb/approve`, jsonBody("POST", { runId }));
	assert(approved.status === 200, `POST absorb/approve should return 200, got ${approved.status}: ${JSON.stringify(approved.body)}`);
	assert(typeof approved.body.absorbId === "string" && approved.body.absorbId.length > 0, `an approval should name the write it made, got ${JSON.stringify(approved.body.absorbId)}`);
	assert(approved.body.writesMemory === true, `an approval is the one write of the run, got ${JSON.stringify(approved.body.writesMemory)}`);
	assert(Array.isArray(approved.body.foldedSessions) && approved.body.foldedSessions.length === SESSION_COUNT, `the saved screen should name every session that went into memory, got ${JSON.stringify(approved.body.foldedSessions)}`);
	assert(Array.isArray(approved.body.remainingSessions) && approved.body.remainingSessions.length === 0, `nothing failed, so nothing should be waiting for the next update, got ${JSON.stringify(approved.body.remainingSessions)}`);
	// The limit was raised before Save, so the prepass rows came back and nothing
	// left for the budget: the archive count is the folds' own replacements.
	assert(typeof approved.body.archivedEntries === "number" && approved.body.archivedForBudget === 0, `after a raise that fits the whole memory nothing leaves for the budget, got ${JSON.stringify({ archivedEntries: approved.body.archivedEntries, archivedForBudget: approved.body.archivedForBudget })}`);
	assert(approved.body.memoryBudget?.budgetTokens === RAISED_BUDGET_TOKENS, `the saved screen should read the room's budget as it now stands, got ${JSON.stringify(approved.body.memoryBudget)}`);
	assert(approved.body.budgetRaisedTo === RAISED_BUDGET_TOKENS, `the saved screen is told the limit this save raised, got ${JSON.stringify(approved.body.budgetRaisedTo)}`);
	const settingsAfterApproval = await requestJson(`${room}/maintenance-settings`);
	assert(settingsAfterApproval.body?.settings?.memoryBudgetTokens === RAISED_BUDGET_TOKENS, `the limit the card raised is the room's from the save on, got ${JSON.stringify(settingsAfterApproval.body?.settings)}`);
	// An approval reaches a browser, so it carries where the event landed inside
	// the room and nothing about this computer: no absolute path, and none of the
	// three file paths the server keeps to itself.
	const approvalJson = JSON.stringify(approved.body);
	for (const key of ["archivedL1bPath", "updatedL1bPath", "eventRecordPath"]) {
		assert(!(key in approved.body) && !approvalJson.includes(key), `an approval a browser reads must not carry ${key}, and it did: ${approvalJson}`);
	}
	assert(!approvalJson.includes(tempHome), "an approval must not carry a local absolute path");
	assert(typeof approved.body.eventRelPath === "string" && approved.body.eventRelPath.startsWith("events/absorb/") && !path.isAbsolute(approved.body.eventRelPath), `an approval names its record by the room-relative path, got ${JSON.stringify(approved.body.eventRelPath)}`);
	assert(approved.body.memoryBudget.overBudget === false && approved.body.memoryBudget.reviewTargetEstimatedTokens > 0, `the written memory should be measured and inside its budget, got ${JSON.stringify(approved.body.memoryBudget)}`);
	assert(approved.body.recentContextEntryCount === 0, `every session was folded, so none should be left remembered, got ${JSON.stringify(approved.body.recentContextEntryCount)}`);

	const writtenL1b = fs.readFileSync(l1bPath, "utf-8");
	assert(!/^###\s+RC-/m.test(writtenL1b), "the folded sessions should be gone from the room's memory file");
	assert(writtenL1b.includes("No checkpointed sessions yet."), "a memory with nothing remembered should say so where the sessions were");
	assert(/^##\s+Deep Memory$/m.test(writtenL1b) && /^##\s+Active Items$/m.test(writtenL1b) && /^##\s+Recent Context$/m.test(writtenL1b), "the write should keep the memory's own sections");
	for (const sessionId of approved.body.foldedSessions as string[]) {
		assert(writtenL1b.includes(`from=${sessionId}`), `what a session left behind should say which session it came from, and nothing in the written memory came from ${sessionId}`);
	}

	const afterApproval = await requestJson(`${room}/absorb/status`);
	assert(afterApproval.body.sessions.length === 0 && afterApproval.body.available === false, `a room with nothing remembered has nothing to Memorize, got ${JSON.stringify({ sessions: afterApproval.body.sessions, available: afterApproval.body.available })}`);

	// --- 8. The run's routes are classified for remote devices ----------------
	const inventory = await requestJson("/api/remote/test/routes");
	assert(inventory.status === 200, `the route table should be readable from the computer itself, got ${inventory.status}: ${JSON.stringify(inventory.body)}`);
	const classOf = (method: string, url: string): string | null => {
		const found = (inventory.body.routes as any[]).find((route) => route.method === method && route.url === url);
		assert(found, `${method} ${url} should be a registered route, and it is not in the live route table`);
		return found.class ?? null;
	};
	assert(classOf("GET", "/api/persistent-agents/:id/absorb/runs/:runId") === "read", `watching a run is a room read, got ${JSON.stringify(classOf("GET", "/api/persistent-agents/:id/absorb/runs/:runId"))}`);
	for (const url of ["/api/persistent-agents/:id/absorb/runs/:runId/keep", "/api/persistent-agents/:id/absorb/runs/:runId/budget", "/api/persistent-agents/:id/absorb/runs/:runId/cancel"]) {
		assert(classOf("POST", url) === "write", `changing a run is room interaction, so POST ${url} should be classified write, got ${JSON.stringify(classOf("POST", url))}`);
	}

	console.log(`absorb-run-route-smoke: OK (${Math.round((Date.now() - startedAt) / 1000)}s, ${gatewayCalls.length} model calls)`);
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
