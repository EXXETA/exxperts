// The search index reads the whole conversation, compactions included.
//
// A room compacts a long conversation on its own: the runtime writes a summary
// and, from then on, sends the model that summary instead of the messages
// before the cut. The index used to read that same model view, and it skips
// summaries by design, so every word said before a compaction was in neither
// the notes nor the search once the conversation was memorized. This smoke
// builds a conversation with two compactions, remembers it, memorizes it with
// the real run, and asks the corpus for three things: a word said before the
// first cut is found, a word said between the cuts is found, and a word that
// only the compaction summaries hold is not (a summary restates messages that
// are on the path themselves). A fourth word, from after the last cut, fixes
// the order: the chunks read the conversation front to back.
//
// Offline: no server, no provider, no network, no port.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { AbsorbRun, AbsorbRunGenerate } from "../src/absorb-run.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "search-full-path-home-"));
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

const { approveAbsorbRun, getAbsorbRun, resetAbsorbRunsForTests, setAbsorbFoldRetryPauseForTests, startAbsorbRun } = await import("../src/absorb-run.js");
setAbsorbFoldRetryPauseForTests(0);
const {
	buildPersistentAgentCheckpointTranscriptSource,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");
const { collectRoomDocuments } = await import("../src/memory-search-sources.js");

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
const REMEMBER_AT = new Date("2026-09-20T09:00:00.000Z");
const RUN_CLOCK = () => new Date("2026-09-21T09:00:00.000Z");
const APPROVED_AT = new Date("2026-09-21T09:05:00.000Z");

/** Said before the first compaction: gone from the model's view, and it has to be findable. */
const PLANT_BEFORE_FIRST_CUT = "PERIWINKLEANVIL";
/** Said between the two compactions: also gone from the model's view by the end. */
const PLANT_BETWEEN_CUTS = "TANGERINEBEACON";
/** Said after the last compaction: in both views. */
const PLANT_AFTER_LAST_CUT = "SAFFRONLANTERN";
/** Held only by the compaction summaries: never a conversation document. */
const PLANT_SUMMARY_ONLY = "GRAPHITEORCHARD";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function memoryFixture(agentId: string): string {
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
		"<!-- entries: next=300 -->",
		"",
		"### Commercial terms",
		"",
		"<!-- e: id=m-0001 kind=practice saved=2026-09-02 refs=4 -->",
		"- A note this room already held before anything was remembered.",
		"",
		"## Active Items",
		"",
		"## Recent Context",
		"",
	].join("\n");
}

const threadCwd = path.join(tempHome, "thread-cwd");
fs.mkdirSync(threadCwd, { recursive: true });
const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

try {
	const created = createPersistentAgentFromScaffoldInput({ displayName: "Search Full Path Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = created.agent.agentId;
	const l1bPath = path.join(root, agentId, "L1b", "current.md");
	fs.writeFileSync(l1bPath, memoryFixture(agentId), { mode: 0o600 });

	const conversationId = "c_compacted_0001";
	const write = writePersistentAgentThread(agentId, conversationId, { state: "active", origin: "home", model: MODEL, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
	});
	assert(write.thread.runtime.kind === "pi-session-jsonl", "the conversation should be backed by a session file");
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime, threadCwd);
	const say = (speaker: "user" | "assistant", text: string): string => speaker === "user"
		? session.appendMessage({ role: "user", content: text, timestamp: Date.now() } as any)
		: session.appendMessage({ role: "assistant", content: [{ type: "text", text }], api: "responses" as any, provider: MODEL.provider as any, model: MODEL.model, usage, stopReason: "stop", timestamp: Date.now() } as any);

	say("user", `We start with the supplier list; the old supplier was code-named ${PLANT_BEFORE_FIRST_CUT} internally.`);
	say("assistant", "Understood, the supplier list first.");
	say("user", "Then the delivery dates for the first quarter.");
	const firstKept = say("assistant", "The first-quarter dates are on the sheet.");
	session.appendCompaction(`Goal: supplier review. Progress: list agreed. Marker ${PLANT_SUMMARY_ONLY}.`, firstKept, 120_000);
	say("user", `Second stretch: the warehouse move, which the team calls ${PLANT_BETWEEN_CUTS}.`);
	say("assistant", "The warehouse move is scheduled for spring.");
	say("user", "And the insurance for the move.");
	const secondKept = say("assistant", "Insurance is covered by the existing policy.");
	session.appendCompaction(`Goal: supplier review and move. Progress: move planned. Marker ${PLANT_SUMMARY_ONLY}.`, secondKept, 125_000);
	say("user", `Last point: the kickoff is called ${PLANT_AFTER_LAST_CUT}.`);
	say("assistant", "Kickoff noted.");

	// The fixture is only worth something if the model's view really lost the
	// early words: check that before relying on it.
	const modelView = JSON.stringify(session.buildSessionContext().messages);
	assert(!modelView.includes(PLANT_BEFORE_FIRST_CUT) && !modelView.includes(PLANT_BETWEEN_CUTS), "the runtime's own view should have dropped the words before the cuts, or the fixture proves nothing");
	assert(modelView.includes(PLANT_SUMMARY_ONLY) && modelView.includes(PLANT_AFTER_LAST_CUT), "the runtime's own view should open with the last summary and keep the words after the cut");
	pass("the fixture's two compactions leave the runtime's view without the early words");

	// Remember it the way the product does.
	const source = buildPersistentAgentCheckpointTranscriptSource({ agentId, conversationId, l1b: fs.readFileSync(l1bPath, "utf-8"), runtimeCwd: threadCwd }).source;
	const approvedRecentContext = [
		"### RC-DRAFT | CLOSED | 2026-09-20 | Supplier review and the move",
		"",
		"**Session arc:** The supplier review moved on to the warehouse move.",
		"",
		"**Body:**",
		"- The supplier list was agreed and the move is planned for spring.",
		"",
		"**Parked:**",
		"None",
		"",
	].join("\n");
	const parsed = parseCheckpointApprovalRequest({
		conversationId,
		model: MODEL,
		density: "compact",
		proposal: { agentId, conversationId, sessionId: null, writesMemory: false, source },
		approvedRecentContext,
	}, agentId);
	writeApprovedCheckpoint(parsed.request, parsed.warnings, REMEMBER_AT, { runtimeCwd: threadCwd });

	// Memorize it with the real run; a scripted fold drops it (a dropped
	// conversation is indexed like a folded one).
	const generate: AbsorbRunGenerate = async () => ({
		text: `Memory already holds what this conversation settled.\n\n\`\`\`json\n${JSON.stringify({ ops: [{ op: "drop", reason: "Nothing new for the notes." }] }, null, 2)}\n\`\`\`\n`,
		usage: { input: 1000, output: 100, totalTokens: 1100, cost: 0 },
	});
	const run = startAbsorbRun({ agentId, assessmentMarkdown: "## What this session leaves behind\n\n- Nothing new.", model: MODEL, generate, now: RUN_CLOCK });
	const deadline = Date.now() + 60_000;
	let settled: AbsorbRun = getAbsorbRun(agentId, run.runId);
	while (["prepass", "folding", "budget"].includes(settled.state)) {
		assert(Date.now() < deadline, `the run was still "${settled.state}" after 60 seconds`);
		await sleep(2);
		settled = getAbsorbRun(agentId, run.runId);
	}
	assert(settled.state === "ready", `the run should come to rest ready to save, got "${settled.state}"${settled.error ? `: ${settled.error}` : ""}`);
	approveAbsorbRun(agentId, run.runId, APPROVED_AT);
	resetAbsorbRunsForTests();
	pass("the compacted conversation is remembered and memorized");

	const { docs, skipped } = collectRoomDocuments(agentId, { runtimeCwd: threadCwd });
	assert(skipped.length === 0, `the conversation should not be skipped, got ${JSON.stringify(skipped)}`);
	const chunks = docs.filter((doc) => doc.source === "conversation" && doc.meta?.conversationId === conversationId);
	assert(chunks.length >= 1, "the memorized conversation should be a document");
	const text = chunks.map((doc) => doc.text).join("\n");
	assert(text.includes(PLANT_BEFORE_FIRST_CUT), `a word said before the first compaction must be searchable (${PLANT_BEFORE_FIRST_CUT})`);
	pass("a word said before the first compaction is found after Memorize");
	assert(text.includes(PLANT_BETWEEN_CUTS), `a word said between the compactions must be searchable (${PLANT_BETWEEN_CUTS})`);
	pass("a word said between the compactions is found after Memorize");
	assert(!docs.some((doc) => doc.text.includes(PLANT_SUMMARY_ONLY)), "a compaction summary is never a document");
	pass("the compaction summaries are not documents");
	const order = [PLANT_BEFORE_FIRST_CUT, PLANT_BETWEEN_CUTS, PLANT_AFTER_LAST_CUT].map((plant) => text.indexOf(plant));
	assert(order.every((at) => at >= 0) && order[0]! < order[1]! && order[1]! < order[2]!, `the chunks read the conversation front to back, got positions ${JSON.stringify(order)}`);
	pass("the chunks read the conversation in the order it was had");

	console.log("search full path smoke passed");
} finally {
	fs.rmSync(tempHome, { recursive: true, force: true });
}
