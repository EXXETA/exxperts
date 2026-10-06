// Memorize never gets stuck, driven end to end through the REAL run on temp
// rooms: a scripted worker and a scripted probe answer the way a model would,
// and the run decides. Every section can run alone (ONLY=<name>), so each
// behaviour is its own red-first command against the base.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate, AbsorbRunProbe } from "../src/absorb-run.js";
import type { AbsorbGenerateResult } from "../src/persistent-agents.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "absorb-never-stuck-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const appDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(appDir, { recursive: true });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const run = await import("../src/absorb-run.js");
const { approveAbsorbRun, cancelAbsorbRun, getAbsorbRun, resetAbsorbRunsForTests, setAbsorbFoldRetryPauseForTests, startAbsorbRun } = run;
setAbsorbFoldRetryPauseForTests(0);
run.setAbsorbFoldRateLimitPauseForTests?.(0);
const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
const { IsolatedPersistentAgentWorkerTurnError } = await import("../src/persistent-agent-worker-runtime.js");
const { applyFoldOps } = await import("../src/absorb-ops.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const RUN_CLOCK = () => new Date("2026-09-13T09:00:00.000Z");
const ASSESSMENT = "## What these sessions leave behind\n\n- A few durable points.";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function page(id: string, title: string, marker: string, extra = "", checkpointId?: string): string {
	const meta = checkpointId ? [`<!-- rc_metadata: checkpoint_id=${checkpointId}; session_id=s-1; conversation_id=c-1; density=normal; model=openai-compatible/gpt-5.5; approved_at=2026-09-11T10:00:00.000Z -->`] : [];
	return [`### ${id} | OPEN | 2026-09-11 | ${title}`, ...meta, "", `**Session arc:** ${marker} was settled.`, "", "**Body:**", `- ${marker} is the durable point.${extra}`, "", "**Parked:**", "None", ""].join("\n");
}

function createRoom(name: string, pages: string[]): { agentId: string; l1bPath: string; runtimeDir: string } {
	const created = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=10 -->", "", "### Renewals", "", "<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", "- The Nordwind contract renews in April.", "",
		"## Active Items", "", "<!-- e: id=m-0002 kind=item saved=2026-09-01 status=open -->", "- Send the draft to legal.", "",
		"## Recent Context", "", pages.join("\n"),
	].join("\n"), { mode: 0o600 });
	return { agentId, l1bPath, runtimeDir: path.join(root, agentId, "runtime") };
}

const sessionOf = (prompt: string) => /Session being folded: (RC-\d+)/.exec(prompt)?.[1] ?? "?";
const fence = (ops: unknown[]) => `\`\`\`json\n${JSON.stringify({ ops })}\n\`\`\``;
const answer = (marker: string): AbsorbGenerateResult => ({ text: `One durable line.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: `- ${marker} is the durable point.` }])}\n`, usage: { input: 100, output: 20 } });
const providerError = (message: string) => new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "error", message);

type Script = (attempt: number, prompt: string) => AbsorbGenerateResult | Promise<AbsorbGenerateResult>;
function scripted(scripts: Record<string, Script>, calls: Array<{ id: string; prompt: string; maxTokens?: number }>): AbsorbRunGenerate {
	return async (prompt, _model, options) => {
		const id = sessionOf(prompt);
		calls.push({ id, prompt, maxTokens: (options as { maxTokens?: number }).maxTokens });
		const script = scripts[id];
		assert(script, `no script for ${id}`);
		return script(calls.filter((call) => call.id === id).length, prompt);
	};
}
const probeAnswers: AbsorbRunProbe = async () => ({ text: "OK" });
const probeFails: AbsorbRunProbe = async () => { throw new Error("fetch failed"); };

async function settle(agentId: string, runId: string): Promise<AbsorbRun> {
	const deadline = Date.now() + 60_000;
	let current = getAbsorbRun(agentId, runId);
	while (["prepass", "folding", "budget"].includes(current.state)) {
		assert(Date.now() < deadline, `the run was still "${current.state}" after 60 seconds`);
		await sleep(2);
		current = getAbsorbRun(agentId, runId);
	}
	return current;
}
const view = (r: AbsorbRun, id: string) => r.sessions.find((session) => session.id === id)!;
const records = (runtimeDir: string): Record<string, unknown> => {
	const file = path.join(runtimeDir, "memorize-page-failures.json");
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf-8")).records : {};
};
const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	resetAbsorbRunsForTests();
	await body();
	console.log(`ok ${name}`);
}

// A readable reply of which nothing lands is filed as its summary at once, in
// this run; a change naming a note memory does not hold is kept in Unsorted.
await section("nothing-lands", async () => {
	const room = createRoom("Nothing Lands Room", [page("RC-0001", "Nothing lands", "NOTHING-POINT"), page("RC-0002", "Unknown id", "UNKNOWN-POINT"), page("RC-0003", "Healthy", "HEALTHY-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const nothing = (): AbsorbGenerateResult => ({ text: fence([{ op: "close", id: "m-9999" }]) });
	const unknown = (): AbsorbGenerateResult => ({ text: fence([{ op: "update", id: "m-9999", text: "- UNKNOWN-POINT is kept although its note is gone." }]) });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": nothing, "RC-0002": unknown, "RC-0003": () => answer("HEALTHY-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "summarized" && calls.filter((call) => call.id === "RC-0001").length === 1, `a reply of which nothing lands is summarized after one call, got "${view(done, "RC-0001").outcome}" after ${calls.filter((call) => call.id === "RC-0001").length}`);
	assert(view(done, "RC-0002").outcome === "folded" && calls.filter((call) => call.id === "RC-0002").length === 1, `an update of an unknown id is folded in one call, got "${view(done, "RC-0002").outcome}"`);
	assert(!calls.some((call) => call.prompt.includes("## Retry Notice")), "no call is ever asked again with reasons");
	// The fold records say how each op ended, in codes, and never a word of the reply.
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const folds = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => fs.readFileSync(path.join(diagnosticsDir, name), "utf-8")).filter((raw) => JSON.parse(raw).process === "memorize-fold");
	const fates = folds.map((raw) => JSON.stringify(JSON.parse(raw).fold?.ops)).sort();
	assert(fates.includes(JSON.stringify([{ i: 0, op: "close", fate: "traced", codes: ["unknown-id"] }])) && fates.includes(JSON.stringify([{ i: 0, op: "update", fate: "redirected", codes: ["unknown-id"] }])), `each fold record carries its ops' fates and codes, got ${fates.join(" | ")}`);
	assert(folds.every((raw) => !raw.includes("UNKNOWN-POINT") && !raw.includes("NOTHING-POINT")) && folds.some((raw) => JSON.parse(raw).fold?.pairs?.subset === 0), "the fold records carry no room text, and the pair counts");
	approveAbsorbRun(room.agentId, started.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	assert(!/^### RC-0001 \|/m.test(written) && written.includes("NOTHING-POINT is the durable point.") && /^### Unsorted$/m.test(written), "the approve removes it from Recent Context and its page is in Unsorted");
	assert(written.includes("UNKNOWN-POINT is kept although its note is gone."), "the redirected text is in memory");
});

// A draft list, prose taking it back, then an empty list as the last fence:
// the fold still takes the draft (no change of behaviour), and the page record
// counts the shape in a code, so a real run can say how often it happens.
await section("earlier-fence", async () => {
	const room = createRoom("Earlier Fence Room", [page("RC-0001", "Retracted", "RETRACTED-POINT", "", "cp-801"), page("RC-0002", "Healthy", "HEALTHY-POINT", "", "cp-802")]);
	const retracted = (): AbsorbGenerateResult => ({ text: `${answer("RETRACTED-POINT").text}\nOn reflection nothing here is durable.\n\n${fence([])}\n` });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": retracted, "RC-0002": () => answer("HEALTHY-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "folded" && view(done, "RC-0002").outcome === "folded", `both pages fold, the first from its draft, got "${view(done, "RC-0001").outcome}"`);
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const pages = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir, name), "utf-8"))).filter((record) => record.process === "memorize-page");
	const byKey = new Map(pages.map((record) => [record.page.key, record.page]));
	assert(JSON.stringify(byKey.get("cp-801")?.reader) === JSON.stringify(["earlier-fence"]) && byKey.get("cp-802")?.reader === undefined, `the page whose list came from before a final empty fence says so in a code, the other says nothing, got ${JSON.stringify([...byKey.values()])}`);
});

// A change aimed at a pinned note reaches the card as a new note beside it,
// tagged; a new note that may disagree with memory is tagged too. The pinned
// note is saved as it was.
await section("beside", async () => {
	const room = createRoom("Beside Room", [page("RC-0001", "Pinned", "PINNED-POINT"), page("RC-0002", "Disagrees", "DISAGREE-POINT")]);
	const pinnedLine = "<!-- e: id=m-0001 kind=fact saved=2026-09-01 pinned=true -->";
	fs.writeFileSync(room.l1bPath, fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- e: id=m-0001 kind=fact saved=2026-09-01 -->", pinnedLine), { mode: 0o600 });
	const calls: Array<{ id: string; prompt: string }> = [];
	const started = startAbsorbRun({
		agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, probe: probeAnswers, now: RUN_CLOCK,
		generate: scripted({
			"RC-0001": () => ({ text: fence([{ op: "update", id: "m-0001", text: "- The Nordwind contract renews in May." }]) }),
			"RC-0002": () => ({ text: fence([{ op: "add", topic: "Active Items", kind: "item", text: "- Never send the draft to legal." }]) }),
		}, calls),
	});
	const done = await settle(room.agentId, started.runId);
	const pinnedRow = view(done, "RC-0001").changes ?? [];
	assert(view(done, "RC-0001").outcome === "folded" && pinnedRow.length === 1 && pinnedRow[0].kind === "added" && pinnedRow[0].topic === "Renewals" && pinnedRow[0].beside === "pinned", `the pinned note's change is a new note beside it, tagged, got ${JSON.stringify(pinnedRow)}`);
	const disagreeRow = view(done, "RC-0002").changes ?? [];
	assert(disagreeRow.length === 1 && disagreeRow[0].beside === "may-disagree", `a new note that may disagree with memory is tagged, got ${JSON.stringify(disagreeRow)}`);
	assert(pinnedRow[0].besideOf === "m-0001" && pinnedRow[0].besideLine === "- The Nordwind contract renews in April." && disagreeRow[0].besideOf === "m-0002" && disagreeRow[0].besideLine === "- Send the draft to legal.", `each tagged row names the other note and its first line, got ${JSON.stringify([pinnedRow[0], disagreeRow[0]])}`);
	approveAbsorbRun(room.agentId, started.runId, new Date("2026-09-13T09:05:00.000Z"));
	const written = fs.readFileSync(room.l1bPath, "utf-8");
	// Its text and pin are as they were; it names the new note beside it that disagrees with it.
	assert(written.includes(`${pinnedLine.replace(" -->", ` disagrees=${pinnedRow[0].id} -->`)}\n- The Nordwind contract renews in April.`) && written.includes("- The Nordwind contract renews in May.") && written.includes("- Send the draft to legal.") && written.includes("- Never send the draft to legal."), "the pinned note is saved as it was, both new notes beside the old ones");
});

// A cut-off reply is salvaged from its last complete fence; otherwise asked again; otherwise summarized.
await section("cut-off", async () => {
	const room = createRoom("Cut Off Room", [page("RC-0001", "Salvaged", "SALVAGED-POINT"), page("RC-0002", "Cut twice", "CUT-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const salvage = (): AbsorbGenerateResult => ({ text: `${answer("SALVAGED-POINT").text}\nAnd more:\n\`\`\`json\n{"ops":[{"op":"add",`, truncated: true });
	const cut = (): AbsorbGenerateResult => ({ text: 'Narrative.\n```json\n{"ops":[{"op":"add",', truncated: true });
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": salvage, "RC-0002": cut }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "folded" && view(done, "RC-0001").attempts === 1, `a cut-off reply with a complete fence is salvaged, got "${view(done, "RC-0001").outcome}" after ${view(done, "RC-0001").attempts}`);
	assert(view(done, "RC-0002").outcome === "summarized" && calls.filter((call) => call.id === "RC-0002").length === 2, `a cut-off reply with nothing to salvage is asked again, then summarized, got "${view(done, "RC-0002").outcome}"`);
});

// An apply that throws files that page as its summary, and the run goes on.
await section("apply-throws", async () => {
	const room = createRoom("Apply Throws Room", [page("RC-0001", "Throws", "THROWN-POINT"), page("RC-0002", "After", "AFTER-POINT")]);
	run.setAbsorbFoldApplyForTests((doc, ops, ctx) => {
		const applied = applyFoldOps(doc, ops, ctx);
		if (ctx.sessionId === "RC-0001") throw new Error("the applier threw");
		return applied;
	});
	try {
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("THROWN-POINT"), "RC-0002": () => answer("AFTER-POINT") }, []), probe: probeAnswers, now: RUN_CLOCK });
		const done = await settle(room.agentId, started.runId);
		assert(done.state === "ready", `an apply that throws does not fail the run, got "${done.state}" ${done.error ?? ""}`);
		assert(view(done, "RC-0001").outcome === "summarized" && view(done, "RC-0002").outcome === "folded", `the page is summarized and the next one folds, got ${JSON.stringify(done.sessions.map((s) => s.outcome))}`);
		const added = (view(done, "RC-0001").changes ?? []).filter((change) => change.kind === "added");
		assert(added.length === 1 && added[0].topic === "Unsorted", `only the summary note is added for the page whose apply threw, got ${JSON.stringify(added)}`);
	} finally {
		run.setAbsorbFoldApplyForTests(null);
	}
});

// The window lookup failing reads as unknown: no raw text on the card. The output cap rides every call.
await section("window-unknown", async () => {
	const room = createRoom("Window Room", [page("RC-0001", "Fine", "FINE-POINT")]);
	const calls: Array<{ id: string; prompt: string; maxTokens?: number }> = [];
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => answer("FINE-POINT") }, calls), probe: probeAnswers, resolveModelWindow: () => { throw new Error("model not found: openai-compatible/gpt-5.5"); }, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(!JSON.stringify(done).includes("model not found"), "a window lookup failure puts no raw text on the card");
	assert(view(done, "RC-0001").outcome === "folded", `and the fold runs as if the window were unknown, got "${view(done, "RC-0001").outcome}"`);
	assert(calls.every((call) => call.maxTokens === 16_000), `every fold call carries the 16k output cap, got ${JSON.stringify(calls.map((call) => call.maxTokens))}`);
});

// A prompt too large for the window is filed as its summary, with no raw text.
await section("oversize", async () => {
	const room = createRoom("Oversize Room", [page("RC-0001", "Too big", "BIG-POINT")]);
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({}, []), probe: probeAnswers, resolveModelWindow: () => ({ contextWindow: 1_000, maxOutputTokens: 200 }), now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(view(done, "RC-0001").outcome === "summarized" && !view(done, "RC-0001").reason, `an oversize page is summarized, got "${view(done, "RC-0001").outcome}" / "${view(done, "RC-0001").reason}"`);
});

// A probe-confirmed failure waits once with a record, keyed by the Remember's
// checkpoint id; the second one is filed as its summary; recorded pages go last.
// A provider error is not worded as a dropped
// connection; a dropped connection is.
await section("second-failure", async () => {
	const room = createRoom("Second Failure Room", [page("RC-0001", "Poison", "POISON-POINT", "", "cp-777"), page("RC-0002", "Healthy", "HEALTHY-POINT"), page("RC-0003", "Dropped", "DROPPED-POINT")]);
	const poison = () => { throw providerError("the content was filtered"); };
	const dropped = () => { throw providerError("terminated"); };
	const first = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": poison, "RC-0002": () => answer("HEALTHY-POINT"), "RC-0003": dropped }, []), probe: probeAnswers, now: RUN_CLOCK });
	const one = await settle(room.agentId, first.runId);
	assert(view(one, "RC-0001").outcome === "failed" && Object.keys(records(room.runtimeDir)).length === 2, `a first probe-confirmed failure waits with a record, got "${view(one, "RC-0001").outcome}" and ${Object.keys(records(room.runtimeDir)).length} record(s)`);
	assert(view(one, "RC-0001").reason === run.ABSORB_FOLD_WORKER_FAILED_TWICE && view(one, "RC-0003").reason === run.ABSORB_FOLD_CONNECTION_LOST_TWICE, `a provider error reads as the model failing, a dropped connection as the connection, got "${view(one, "RC-0001").reason}" / "${view(one, "RC-0003").reason}"`);
	assert("cp-777" in records(room.runtimeDir) && !Object.keys(records(room.runtimeDir)).some((key) => key.startsWith("RC-")), `the record is keyed by the checkpoint id, never the RC id, got ${Object.keys(records(room.runtimeDir)).join(",")}`);
	const diagnosticsDir = path.join(root, room.agentId, "events", "maintenance-diagnostics");
	const pageKeys = fs.readdirSync(diagnosticsDir, { recursive: true }).map(String).filter((name) => name.endsWith(".json")).map((name) => JSON.parse(fs.readFileSync(path.join(diagnosticsDir, name), "utf-8"))).filter((record) => record.process === "memorize-page").map((record) => record.page.key);
	assert(pageKeys.includes("cp-777") && !pageKeys.some((key: string) => key.startsWith("RC-")), `the page diagnostics are keyed by the checkpoint id too, got ${pageKeys.join(",")}`);
	assert(!JSON.stringify(records(room.runtimeDir)).includes("POISON"), "the record holds no room text");
	const calls: Array<{ id: string; prompt: string }> = [];
	const second = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": poison, "RC-0002": () => answer("HEALTHY-POINT"), "RC-0003": dropped }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const two = await settle(room.agentId, second.runId);
	assert(calls[0].id === "RC-0002", `a page carrying a record folds last, got ${calls.map((call) => call.id).join(",")}`);
	assert(view(two, "RC-0001").outcome === "summarized" && view(two, "RC-0003").outcome === "summarized", `the second probe-confirmed failure summarizes, got "${view(two, "RC-0001").outcome}"`);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "and its record is gone");
});

// A dropped connection is told by its own words, never by a sentence that uses the word "terminated".
await section("dropped-words", async () => {
	for (const message of ["terminated", "TypeError: terminated", "fetch failed", "read ECONNRESET", "getaddrinfo ENOTFOUND api.example.com", "getaddrinfo EAI_AGAIN api.example.com", "connect EHOSTUNREACH 10.0.0.1:443", "UND_ERR_SOCKET: other side closed", "socket hang up", "WebSocket error", "websocket connection closed"]) assert(run.connectionDropped(message), `a dropped connection: ${message}`);
	for (const message of ["The response was terminated because the content was filtered", "Output terminated at max_tokens", "Tool call terminated by the user", "502 Bad Gateway", "504 Gateway Timeout", "the content was filtered"]) assert(!run.connectionDropped(message), `not a dropped connection: ${message}`);
});

// A blip (a server error, a dropped connection) passes within a minute: the one
// retry waits it out, so the page folds with no notice. A failure that is no
// blip (a content refusal) is asked again after the short pause, as before.
await section("blip-wait", async () => {
	setAbsorbFoldRetryPauseForTests(20);
	run.setAbsorbFoldRateLimitPauseForTests?.(600);
	try {
		const SERVICE_UNAVAILABLE = 'Codex error: {"type":"error","error":{"type":"service_unavailable_error","code":null,"message":"Unable to verify model access right now. Please retry.","param":null},"sequence_number":2}';
		const SERVER_ERROR = 'Codex error: {"type":"error","error":{"type":"server_error","code":"server_error","message":"An error occurred while processing your request. You can retry your request.","param":null}}';
		const REFUSAL = "400 invalid_request_error: The response was filtered due to the prompt triggering content management policy";
		for (const [n, message] of ["WebSocket error", SERVICE_UNAVAILABLE, SERVER_ERROR, "read ECONNRESET", REFUSAL].entries()) {
			const room = createRoom(`Blip Room ${n}`, [page("RC-0001", "Blip", "BLIP-POINT")]);
			// The model fails, and does not answer the probe either, for 300 ms after its first failure.
			let blipUntil = 0;
			const blipping = () => Date.now() < blipUntil;
			const calls: Array<{ id: string; prompt: string }> = [];
			const generate = scripted({ "RC-0001": () => { if (blipUntil === 0) blipUntil = Date.now() + 300; if (blipping()) throw providerError(message); return answer("BLIP-POINT"); } }, calls);
			const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: async (...args) => (blipping() ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK }).runId);
			if (message === REFUSAL) assert(done.stop?.kind === "outage" && view(done, "RC-0001").outcome !== "folded", `a content refusal is asked again after the short pause, got "${view(done, "RC-0001").outcome}"`);
			else assert(!done.stop && view(done, "RC-0001").outcome === "folded" && calls.length === 2, `a blip is waited out and the page folds with no notice: ${message.slice(0, 40)}, got "${view(done, "RC-0001").outcome}"${done.stop ? " and a stop" : ""} after ${calls.length} call(s)`);
		}
	} finally {
		setAbsorbFoldRetryPauseForTests(0);
		run.setAbsorbFoldRateLimitPauseForTests?.(0);
	}
});

// A WebSocket that failed twice is said as the connection dropping, not as a failed worker.
await section("websocket-sentence", async () => {
	const room = createRoom("WebSocket Room", [page("RC-0001", "Socket", "SOCKET-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const done = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("WebSocket error"); } }, calls), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(view(done, "RC-0001").reason === run.ABSORB_FOLD_CONNECTION_LOST_TWICE, `the reason names the connection, got "${view(done, "RC-0001").reason}"`);
});

// The probe asks at low reasoning, so a reasoning model does not think its way to the ceiling.
await section("probe-low", async () => {
	const room = createRoom("Probe Low Room", [page("RC-0001", "Poison", "POISON-POINT")]);
	const probeOptions: Array<{ thinkingLevel?: string; timeoutMs?: number }> = [];
	const probe: AbsorbRunProbe = async (prompt, model, options) => { probeOptions.push(options); return probeAnswers(prompt, model, options); };
	await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("the content was filtered"); } }, []), probe, now: RUN_CLOCK }).runId);
	assert(probeOptions.length === 1 && probeOptions[0].thinkingLevel === "low" && probeOptions[0].timeoutMs === 45_000, `the probe asks at low reasoning within its 45 s, got ${JSON.stringify(probeOptions)}`);
});

// An outage stops the run, records nothing, and says so; a rate limit is an outage whatever the probe says; Try again resumes.
await section("outage", async () => {
	const room = createRoom("Outage Room", [page("RC-0001", "First", "FIRST-POINT"), page("RC-0002", "Second", "SECOND-POINT"), page("RC-0003", "Third", "THIRD-POINT")]);
	let down = true;
	const calls: Array<{ id: string; prompt: string }> = [];
	const maybe = (marker: string) => () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return answer(marker); };
	const scripts = { "RC-0001": () => answer("FIRST-POINT"), "RC-0002": maybe("SECOND-POINT"), "RC-0003": maybe("THIRD-POINT") };
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, calls), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	assert(stopped.state === "ready" && stopped.stop?.kind === "outage" && stopped.stop.cause === "not-answering", `an outage stops the run with its notice, got ${JSON.stringify(stopped.stop)} in "${stopped.state}"`);
	assert(view(stopped, "RC-0001").outcome === "folded" && view(stopped, "RC-0002").outcome === "pending" && view(stopped, "RC-0003").outcome === "pending", `what finished stays, the rest wait, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	assert(calls.filter((call) => call.id === "RC-0003").length === 0, "no page after the outage is called");
	assert(Object.keys(records(room.runtimeDir)).length === 0, "an outage records nothing, not even its first page");
	assert(stopped.sessions.every((s) => !s.reason), "no page of an outage carries a failure reason");
	down = false;
	const resumed = run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	assert(resumed.state === "folding" && !resumed.stop, `Try again resumes the same run, got "${resumed.state}"`);
	const after = await settle(room.agentId, started.runId);
	assert(after.state === "ready" && after.sessions.every((s) => s.outcome === "folded"), `the resumed run folds what waited, keeping what finished, got ${JSON.stringify(after.sessions.map((s) => s.outcome))}`);
	assert(calls.filter((call) => call.id === "RC-0001").length === 1, "a finished page is not folded again");
	assert(after.progress.folded === 3, `the progress counts all three, got ${after.progress.folded}`);
});

// A run that stopped for an outage and then ended, saved or cancelled, offers
// no Try again: another tab watching it must not show the notice.
await section("ended-stop", async () => {
	const stoppedRun = async (name: string) => {
		const room = createRoom(name, [page("RC-0001", "First", "FIRST-POINT"), page("RC-0002", "Second", "SECOND-POINT")]);
		const scripts = { "RC-0001": () => answer("FIRST-POINT"), "RC-0002": () => { throw providerError("fetch failed: ECONNREFUSED"); } };
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, []), probe: probeFails, now: RUN_CLOCK });
		const stopped = await settle(room.agentId, started.runId);
		assert(stopped.stop?.kind === "outage", `the run stops for the outage, got ${JSON.stringify(stopped.stop)}`);
		return { room, runId: started.runId };
	};
	const saved = await stoppedRun("Ended Stop Saved Room");
	approveAbsorbRun(saved.room.agentId, saved.runId);
	const afterSave = getAbsorbRun(saved.room.agentId, saved.runId);
	assert(afterSave.state === "saved" && !afterSave.stop, `a saved run carries no outage stop, got ${JSON.stringify(afterSave.stop)} in "${afterSave.state}"`);
	const cancelled = await stoppedRun("Ended Stop Cancelled Room");
	cancelAbsorbRun(cancelled.room.agentId, cancelled.runId);
	const afterCancel = getAbsorbRun(cancelled.room.agentId, cancelled.runId);
	assert(afterCancel.state === "cancelled" && !afterCancel.stop, `a cancelled run carries no outage stop, got ${JSON.stringify(afterCancel.stop)} in "${afterCancel.state}"`);
});

// A rate limit waits out one pause and is asked again; still limited, it is an
// outage whatever the probe says. The page goes last next run, and when it
// stops that run too after another page folded, it is filed as its summary.
await section("rate-limit", async () => {
	const room = createRoom("Rate Limit Room", [page("RC-0001", "Limited", "LIMITED-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const calls: Array<{ id: string; prompt: string }> = [];
	const limited = () => { throw providerError("litellm.RateLimitError: RateLimitError: OpenAIException - Rate limit reached. Please try again in 12s."); };
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": limited, "RC-0002": () => answer("BEHIND-POINT") }, calls), probe: probeAnswers, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(done.stop?.cause === "busy", `a rate-limit message is an outage even when the probe answers, got ${JSON.stringify(done.stop)}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0 && view(done, "RC-0001").outcome === "pending", "and records nothing");
	assert(calls.filter((call) => call.id === "RC-0001").length === 2, "it was asked again once, after its pause");
	cancelAbsorbRun(room.agentId, started.runId);
	const second: Array<{ id: string; prompt: string }> = [];
	const next = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": limited, "RC-0002": () => answer("BEHIND-POINT") }, second), probe: probeAnswers, now: RUN_CLOCK });
	const two = await settle(room.agentId, next.runId);
	assert(second[0].id === "RC-0002", `the page that stopped the last run goes last, got ${second.map((call) => call.id).join(",")}`);
	assert(!two.stop && view(two, "RC-0001").outcome === "summarized" && view(two, "RC-0002").outcome === "folded", `stopping this run too after another page folded, it is kept as its summary, got ${JSON.stringify(two.sessions.map((s) => s.outcome))} stop ${JSON.stringify(two.stop)}`);
});

// A page whose probe the model is too slow to answer: the same, without a rate limit's words.
await section("slow-probe", async () => {
	const room = createRoom("Slow Probe Room", [page("RC-0001", "Heavy", "HEAVY-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const heavy = () => { throw providerError("stream stalled"); };
	let heavyInFlight = false;
	const generate: AbsorbRunGenerate = async (prompt, model, options) => {
		heavyInFlight = sessionOf(prompt) === "RC-0001";
		return scripted({ "RC-0001": heavy, "RC-0002": () => answer("BEHIND-POINT") }, [])(prompt, model, options);
	};
	const slowProbe: AbsorbRunProbe = async (...args) => (heavyInFlight ? probeFails(...args) : probeAnswers(...args));
	const first = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: slowProbe, now: RUN_CLOCK }).runId);
	assert(first.stop?.cause === "not-answering" && view(first, "RC-0002").outcome === "pending", `a failed probe stops the run, got ${JSON.stringify(first.stop)}`);
	cancelAbsorbRun(room.agentId, first.runId);
	const two = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate, probe: slowProbe, now: RUN_CLOCK }).runId);
	assert(!two.stop && view(two, "RC-0001").outcome === "summarized" && view(two, "RC-0002").outcome === "folded", `the page that stopped a run twice is kept as its summary, not in the way again, got ${JSON.stringify(two.sessions.map((s) => s.outcome))}`);
});

// Cancel works while a rate-limited call waits out its pause.
await section("pause-cancel", async () => {
	const room = createRoom("Pause Cancel Room", [page("RC-0001", "Limited", "LIMITED-POINT")]);
	run.setAbsorbFoldRateLimitPauseForTests?.(null);
	try {
		const calls: Array<{ id: string; prompt: string }> = [];
		const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("429 Too Many Requests"); } }, calls), probe: probeAnswers, now: RUN_CLOCK });
		const deadline = Date.now() + 10_000;
		while (calls.length === 0) { assert(Date.now() < deadline, "the run reached the page"); await sleep(2); }
		await sleep(50);
		const before = Date.now();
		cancelAbsorbRun(room.agentId, started.runId);
		const done = await settle(room.agentId, started.runId);
		assert(done.state === "cancelled" && Date.now() - before < 5_000 && calls.length === 1, `a cancel ends the 30-second pause at once, got "${done.state}" after ${Date.now() - before} ms and ${calls.length} call(s)`);
		assert(!fs.existsSync(path.join(room.runtimeDir, "memorize-page-failures.json")), "and neither records nor notes the page");
	} finally {
		run.setAbsorbFoldRateLimitPauseForTests?.(0);
	}
});

// Try again folds from the card as the person left it: an edited note reaches
// the resumed fold in the person's words and an update shows them as its
// before; a kept note reads as pinned, so a resumed fold cannot rewrite it.
await section("resume-card", async () => {
	const room = createRoom("Resume Card Room", [page("RC-0001", "Alpha", "ALPHA-POINT"), page("RC-0002", "Beta", "BETA-POINT"), page("RC-0003", "Gamma", "GAMMA-POINT")]);
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const { parseMemoryDocument, reviewTargetTokens } = await import("../src/memory-entries.js");
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 10_000 });
	// Old filler notes up to just under the limit, so the first fold's note pushes one out.
	const base = fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- entries: next=10 -->", "<!-- entries: next=900 -->");
	const filler: string[] = [];
	const withFiller = () => base.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_940; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-01-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"an old detail that nobody has touched in months ".repeat(3).trim()}.`, "");
	assert(filler.length / 3 < 800, "the filler ids stay below the next entry number");
	fs.writeFileSync(room.l1bPath, withFiller(), { mode: 0o600 });
	const long = `- ALPHA-POINT ${"is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	// Long enough that, added beside the kept note, it takes the memory over its budget again.
	const gamma = `- GAMMA-POINT rewrote the kept note: ${"it is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	let down = true;
	let alphaId = "";
	let keptId = "";
	const calls: Array<{ id: string; prompt: string }> = [];
	const scripts: Record<string, Script> = {
		"RC-0001": () => ({ text: `Alpha.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: long }])}\n` }),
		"RC-0002": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Beta.\n\n${fence([{ op: "update", id: alphaId, text: "- ALPHA was EDITED by the person, and BETA-POINT adds to it." }])}\n` }; },
		"RC-0003": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Gamma.\n\n${fence([{ op: "update", id: keptId, text: gamma }])}\n` }; },
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, calls), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	assert(stopped.stop?.kind === "outage" && view(stopped, "RC-0001").outcome === "folded", `the first page folds and the outage stops the run, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	alphaId = (view(stopped, "RC-0001").changes ?? []).find((change) => change.kind === "added")?.id ?? "";
	const leaving = stopped.demotion.entries.find((row) => row.leaving && row.phase === "after");
	assert(alphaId && leaving, `the fold added a note and pushed an old one out, got ${alphaId} and ${JSON.stringify(stopped.demotion.entries.map((row) => [row.id, row.phase, row.leaving]))}`);
	keptId = leaving.id;
	const keptText = leaving.text;
	run.editAbsorbRunEntry(room.agentId, started.runId, alphaId, "ALPHA was EDITED by the person.");
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	down = false;
	run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	const after = await settle(room.agentId, started.runId);
	const betaPrompt = calls.filter((call) => call.id === "RC-0002").pop()?.prompt ?? "";
	assert(betaPrompt.includes("ALPHA was EDITED by the person."), "the resumed fold reads the person's edit");
	const update = (view(after, "RC-0002").changes ?? []).find((change) => change.id === alphaId);
	assert(update?.kind === "updated" && update.before === "- ALPHA was EDITED by the person.", `the update shows the person's words as its before, got ${JSON.stringify(update)}`);
	// A kept note is not the person's pin: the change is added beside it, untagged, and the page folds (it was filed whole under the S1 rules).
	const beside = view(after, "RC-0003").changes ?? [];
	assert(view(after, "RC-0003").outcome === "folded" && beside.length === 1 && beside[0].kind === "added" && beside[0].after === gamma && !("beside" in beside[0]) && !beside.some((change) => change.id === keptId), `a resumed fold's update of a kept note is added beside it, untagged, got "${view(after, "RC-0003").outcome}" ${JSON.stringify(beside)}`);
	assert(after.demotion.entries.find((row) => row.id === keptId)?.text === keptText || !after.demotion.entries.some((row) => row.id === keptId), "the kept note itself is unchanged");
	const gammaPrompt = calls.filter((call) => call.id === "RC-0003")[0]?.prompt ?? "";
	assert(new RegExp(`\\[${keptId} · pinned`).test(gammaPrompt), "the kept note reads as pinned to the resumed fold");
	// The pin was the folds' only: taking the keep back leaves the note to the budget again.
	const unkept = run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [] });
	assert(unkept.demotion.entries.find((row) => row.id === keptId)?.leaving === true, `a keep taken back after the resume leaves the note to the budget, unpinned, got ${JSON.stringify(unkept.demotion.entries.find((row) => row.id === keptId))} of ${unkept.demotion.entries.length} rows, leaving ${unkept.demotion.counts.leaving}`);
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	approveAbsorbRun(room.agentId, started.runId);
	const saved = fs.readFileSync(room.l1bPath, "utf-8");
	assert(saved.includes(keptText) && saved.includes(gamma.slice(2)), "the kept note is saved as the person kept it, and the resumed fold's text beside it");
});

// A resumed fold that pins a kept note itself, because the conversation asks
// for it, makes a change the card shows, and that pin stays after the folds.
await section("resume-pin", async () => {
	const asked = "The user asked to pin the old filler detail for good.";
	const room = createRoom("Resume Pin Room", [page("RC-0001", "Alpha", "ALPHA-POINT"), page("RC-0002", "Beta", "BETA-POINT", ` ${asked}`)]);
	const { writePersistentRoomMaintenanceSettings } = await import("../src/persistent-room-maintenance-settings.js");
	const { parseMemoryDocument, reviewTargetTokens } = await import("../src/memory-entries.js");
	writePersistentRoomMaintenanceSettings(room.agentId, { memoryBudgetTokens: 10_000 });
	const base = fs.readFileSync(room.l1bPath, "utf-8").replace("<!-- entries: next=10 -->", "<!-- entries: next=900 -->");
	const filler: string[] = [];
	const withFiller = () => base.replace("## Active Items", ["### Filler", "", ...filler, "## Active Items"].join("\n"));
	for (let n = 100; reviewTargetTokens(parseMemoryDocument(withFiller())) < 9_940; n++) filler.push(`<!-- e: id=m-0${n} kind=fact saved=2026-01-${String(1 + (n % 28)).padStart(2, "0")} -->`, `- Filler note ${n}: ${"an old detail that nobody has touched in months ".repeat(3).trim()}.`, "");
	fs.writeFileSync(room.l1bPath, withFiller(), { mode: 0o600 });
	const long = `- ALPHA-POINT ${"is a durable point about the renewal terms and the people involved ".repeat(8).trim()}.`;
	let down = true;
	let keptId = "";
	const scripts: Record<string, Script> = {
		"RC-0001": () => ({ text: `Alpha.\n\n${fence([{ op: "add", topic: "Renewals", kind: "fact", text: long }])}\n` }),
		"RC-0002": () => { if (down) throw providerError("fetch failed: ECONNREFUSED"); return { text: `Beta.\n\n${fence([{ op: "pin", id: keptId, because: asked }])}\n` }; },
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted(scripts, []), probe: async (...args) => (down ? probeFails(...args) : probeAnswers(...args)), now: RUN_CLOCK });
	const stopped = await settle(room.agentId, started.runId);
	const leaving = stopped.demotion.entries.find((row) => row.leaving && row.phase === "after");
	assert(stopped.stop?.kind === "outage" && leaving, `the first fold pushed an old note out and the outage stopped the run, got ${JSON.stringify(stopped.sessions.map((s) => s.outcome))}`);
	keptId = leaving.id;
	run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [keptId] });
	down = false;
	run.resumeAbsorbRun(room.agentId, started.runId, MODEL);
	const after = await settle(room.agentId, started.runId);
	assert(view(after, "RC-0002").outcome === "folded" && (view(after, "RC-0002").changes ?? []).some((change) => change.kind === "pinned" && change.id === keptId), `the resumed fold's pin is a change on the card, got ${JSON.stringify(view(after, "RC-0002"))}`);
	const unkept = run.keepAbsorbRunEntries(room.agentId, started.runId, { keepIds: [] });
	assert(unkept.demotion.entries.find((row) => row.id === keptId)?.leaving !== true, "a keep taken back leaves the note the fold pinned in memory, pinned");
	approveAbsorbRun(room.agentId, started.runId);
	const saved = fs.readFileSync(room.l1bPath, "utf-8");
	assert(new RegExp(`id=${keptId}\\b[^\\n]*pinned=true`).test(saved), "the note the resumed fold pinned is saved pinned");
});

// A record counts only on the model that wrote it.
await section("record-model", async () => {
	const room = createRoom("Record Model Room", [page("RC-0001", "Poison", "POISON-POINT")]);
	const poison = () => { throw providerError("the content was filtered"); };
	const other = { provider: "openai-compatible", model: "gpt-5.5-mini", label: "GPT-5.5 mini" };
	const one = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": poison }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	assert(view(one, "RC-0001").outcome === "failed", "the first failure waits");
	cancelAbsorbRun(room.agentId, one.runId);
	const two = await settle(room.agentId, startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: other, generate: scripted({ "RC-0001": poison }, []), probe: probeAnswers, now: RUN_CLOCK }).runId);
	const record = Object.values(records(room.runtimeDir))[0] as { model?: string } | undefined;
	assert(view(two, "RC-0001").outcome === "failed" && record?.model === "gpt-5.5-mini", `another Memory model gets its own first try and its record replaces the old one, got "${view(two, "RC-0001").outcome}" ${JSON.stringify(record)}`);
});

// A provider that says the request is too large: the page is kept as its summary at once, never an outage.
await section("too-large", async () => {
	const room = createRoom("Too Large Room", [page("RC-0001", "Huge", "HUGE-POINT"), page("RC-0002", "Behind", "BEHIND-POINT")]);
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: scripted({ "RC-0001": () => { throw providerError("Request too large for gpt-4o in organization org-x on tokens per min (TPM): Limit 30000, Requested 41290. rate_limit_exceeded"); }, "RC-0002": () => answer("BEHIND-POINT") }, []), probe: probeFails, now: RUN_CLOCK });
	const done = await settle(room.agentId, started.runId);
	assert(!done.stop && view(done, "RC-0001").outcome === "summarized" && view(done, "RC-0002").outcome === "folded", `a request too large is summarized and the run goes on, got ${JSON.stringify(done.sessions.map((s) => s.outcome))} stop ${JSON.stringify(done.stop)}`);
	assert(Object.keys(records(room.runtimeDir)).length === 0, "and nothing is recorded");
});

// The records flush when the loop ends, cancel included.
await section("cancel-flush", async () => {
	const room = createRoom("Cancel Room", [page("RC-0001", "Poison", "POISON-POINT"), page("RC-0002", "Slow", "SLOW-POINT")]);
	let release = () => {};
	const blocked = new Promise<void>((resolve) => { release = resolve; });
	let reachedSlow = false;
	const slow: AbsorbRunGenerate = async (prompt, model, options) => {
		if (sessionOf(prompt) === "RC-0001") throw providerError("the content was filtered");
		reachedSlow = true;
		await new Promise<void>((resolve) => { options.signal.addEventListener("abort", () => resolve()); void blocked.then(resolve); });
		throw new IsolatedPersistentAgentWorkerTurnError("memorize fold worker", "aborted", "cancelled");
	};
	const started = startAbsorbRun({ agentId: room.agentId, assessmentMarkdown: ASSESSMENT, model: MODEL, generate: slow, probe: probeAnswers, now: RUN_CLOCK });
	const deadline = Date.now() + 30_000;
	while (!reachedSlow) { assert(Date.now() < deadline, "the run reached the slow page"); await sleep(2); }
	assert(Object.keys(records(room.runtimeDir)).length === 0, "records are held, not written, while the loop runs");
	cancelAbsorbRun(room.agentId, started.runId);
	release();
	const flushDeadline = Date.now() + 30_000;
	while (Object.keys(records(room.runtimeDir)).length === 0) { assert(Date.now() < flushDeadline, "the records flush when a cancelled loop ends"); await sleep(2); }
	assert(Object.keys(records(room.runtimeDir)).length === 1, "the page that failed before the cancel is recorded; the one in flight is not");
});

fs.rmSync(tempHome, { recursive: true, force: true });
console.log("absorb-never-stuck smoke passed");
