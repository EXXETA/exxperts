import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The ten-entry deadlock: a room whose Recent Context was full could not save
// another session until a Memorize succeeded — and a room whose memory had
// outgrown what one Memorize can rewrite had no way to make one succeed. The
// hard cap still means "Memorize is due" (status needs_absorb, the badge, the
// card copy); it no longer means "stop saving sessions", and it no longer means
// "stop opening the room" either — the room the user is told still works kept
// refusing every door. Saving and entering stop only at the block cap, with
// Memorize named as the way out.

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-recent-context-cap-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-recent-context-cap-cwd-"));
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

const {
	RECENT_CONTEXT_BLOCK_CAP,
	assertPersistentAgentAcceptsSession,
	createPersistentAgentFromScaffoldInput,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	buildCheckpointProposal,
	getPersistentAgentStatus,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
writePersistentAgentAiProfileState("openai-compatible");

const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function rcEntry(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | OPEN | 2026-05-18 | Cap smoke ${index}\n\n**Session arc:** Smoke session ${index} produced durable signal.\n\n**Body:**\n- Durable understanding ${index} should be considered for Deep Memory.\n\n**Parked:**\nNone\n`;
}

function setRecentContextEntries(agentId: string, count: number): void {
	const instance = createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());
	const base = fs.readFileSync(l1bPath, "utf-8");
	const match = /^##\s+Recent Context\s*$/m.exec(base);
	assert(match?.index != null, "scaffold L1b should include Recent Context");
	const start = match.index + match[0].length;
	const entries = Array.from({ length: count }, (_, i) => rcEntry(i + 1)).join("\n");
	fs.writeFileSync(l1bPath, `${base.slice(0, start)}\n\n${entries}\n`, "utf-8");
}

function approvedRecentContext(index: number): string {
	return `### RC-${String(index).padStart(4, "0")} | CLOSED | 2026-06-14 | Cap smoke approval\n\n**Session arc:** A session was saved while the room was already due for Memorize.\n\n**Body:**\n- Saving a session stays available past the due mark.\n\n**Parked:**\nNone\n`;
}

async function saveOneSession(agentId: string, threadId: string, approvedIndex: number) {
	const write = writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "home",
		model,
		items: [{ kind: "user", id: "u1", text: "Synthetic session message for the cap smoke." }],
	}, {
		createRuntime: ({ model: threadModel }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model: threadModel, cwd: tempCwd }),
	});
	const session = openPersistentAgentPiSessionManager(agentId, write.thread.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: "Synthetic session message for the cap smoke.", timestamp: Date.now() });
	const proposal = await buildCheckpointProposal({
		agentId,
		conversationId: threadId,
		model,
		density: "standard",
		items: [{ kind: "user", text: "Synthetic session message for the cap smoke." }],
		runtimeCwd: tempCwd,
	}, async () => ({
		text: "TITLE:\nCap smoke\n\nSESSION_ARC:\nA session was saved while the room was already due for Memorize.\n\nBODY:\n- Saving a session stays available past the due mark.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	const parsed = parseCheckpointApprovalRequest({
		conversationId: threadId,
		model,
		density: proposal.density,
		proposal,
		approvedRecentContext: approvedRecentContext(approvedIndex),
	}, agentId);
	return writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date("2026-06-14T13:00:00.000Z"), { runtimeCwd: tempCwd });
}

async function expectRejects(fn: () => Promise<unknown>, expected: RegExp, label: string): Promise<Error> {
	try {
		await fn();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		assert(expected.test(message), `${label}: expected ${expected}, got ${message}`);
		return error as Error;
	}
	throw new Error(`${label}: expected rejection`);
}

try {
	assert(RECENT_CONTEXT_BLOCK_CAP === 20, `the block cap should be 20, got ${RECENT_CONTEXT_BLOCK_CAP}`);

	// --- 1. At the hard cap the room is due for Memorize, and still saves -----
	createPersistentAgentFromScaffoldInput({ displayName: "Cap Smoke Due Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const dueRoom = "cap-smoke-due-room";
	setRecentContextEntries(dueRoom, 10);
	const dueStatus = getPersistentAgentStatus(dueRoom);
	assert(dueStatus.recentContext.fullEntries === 10, `the due room should hold 10 entries, got ${dueStatus.recentContext.fullEntries}`);
	assert(dueStatus.status === "needs_absorb", `the hard cap must still read as due for Memorize, got ${dueStatus.status}`);
	assert(dueStatus.recentContext.hardCap === 10, `the hard cap the room reports should be unchanged, got ${dueStatus.recentContext.hardCap}`);
	assert(dueStatus.memoryStatus.recentContextLevel === "hard_cap", `the memory status level at the hard cap should be unchanged, got ${dueStatus.memoryStatus.recentContextLevel}`);

	const saved = await saveOneSession(dueRoom, "pi_cap_due_0001", 11);
	assert(saved.writesMemory === true, "a room that is due for Memorize must still be able to save a session");
	assert(saved.recentContextEntryCount === 11, `the saved session should be the eleventh entry, got ${saved.recentContextEntryCount}`);
	assert(getPersistentAgentStatus(dueRoom).status === "needs_absorb", "the room stays due for Memorize after saving past the hard cap");

	// --- 2. At the block cap saving refuses, and names the way out -----------
	createPersistentAgentFromScaffoldInput({ displayName: "Cap Smoke Full Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const fullRoom = "cap-smoke-full-room";
	setRecentContextEntries(fullRoom, RECENT_CONTEXT_BLOCK_CAP);
	assert(getPersistentAgentStatus(fullRoom).recentContext.fullEntries === RECENT_CONTEXT_BLOCK_CAP, "the full room should hold the block cap's worth of entries");

	const refusal = await expectRejects(
		() => saveOneSession(fullRoom, "pi_cap_full_0001", 21),
		/not ready: needs_absorb/,
		"saving at the block cap",
	);
	// The phrase above is what the surfaces match on to offer a remedy; the
	// sentence itself must also say what to do for the surfaces that show it raw.
	assert(/Memorize/.test(refusal.message), `the refusal should name Memorize as the way out, got: ${refusal.message}`);
	assert(/20/.test(refusal.message), `the refusal should say how many sessions the room is holding, got: ${refusal.message}`);

	// --- 3. One under the block cap still saves ------------------------------
	createPersistentAgentFromScaffoldInput({ displayName: "Cap Smoke Edge Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const edgeRoom = "cap-smoke-edge-room";
	setRecentContextEntries(edgeRoom, RECENT_CONTEXT_BLOCK_CAP - 1);
	const edgeSaved = await saveOneSession(edgeRoom, "pi_cap_edge_0001", 20);
	assert(edgeSaved.recentContextEntryCount === RECENT_CONTEXT_BLOCK_CAP, `the last allowed save should land on the block cap, got ${edgeSaved.recentContextEntryCount}`);

	// --- 4. The same release for the door into the room ----------------------
	// A room that is due for Memorize could not be ENTERED at all: both doors —
	// the chat socket and the CLI's bootstrap — demanded exactly "ready", while
	// the product told the user that chatting still works meanwhile. Both now
	// pass through assertPersistentAgentAcceptsSession, so this is the one
	// predicate either door applies.
	assertPersistentAgentAcceptsSession(getPersistentAgentStatus(dueRoom));
	const edgeEntryStatus = getPersistentAgentStatus(edgeRoom);
	assert(edgeEntryStatus.recentContext.fullEntries === RECENT_CONTEXT_BLOCK_CAP, `the edge room should now hold the block cap's worth of entries, got ${edgeEntryStatus.recentContext.fullEntries}`);
	let entryRefusal: Error | null = null;
	try {
		assertPersistentAgentAcceptsSession(getPersistentAgentStatus(fullRoom));
	} catch (error) {
		entryRefusal = error as Error;
	}
	assert(entryRefusal, "a room holding the block cap's worth of sessions must refuse to open");
	assert(/not ready: needs_absorb/.test(entryRefusal.message), `the entry refusal should keep the phrase the surfaces match on, got: ${entryRefusal.message}`);
	assert(/Memorize/.test(entryRefusal.message), `the entry refusal should name Memorize as the way out, got: ${entryRefusal.message}`);
	assert(/20/.test(entryRefusal.message), `the entry refusal should say how many sessions the room is holding, got: ${entryRefusal.message}`);

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("checkpoint recent context cap smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
