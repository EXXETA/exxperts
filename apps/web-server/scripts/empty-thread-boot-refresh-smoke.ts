// The fresh conversation Remember prepares boots from a frozen prompt
// snapshot that carries the room's memory as it was then. While nobody has
// spoken in it, a bind rebuilds that snapshot from the memory as it is now
// (Memorize and Review may have run in between); a conversation with turns
// stays frozen; an unchanged memory rewrites nothing; and a Remember made in
// the rebuilt conversation is not called stale because of the rebuild.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-empty-thread-boot-home-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-empty-thread-boot-rooms-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-empty-thread-boot-cwd-"));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const {
	createPersistentAgentFromScaffoldInput,
	buildCheckpointProposal,
	createPersistentAgentInstance,
	createPersistentAgentPiSessionJsonlThreadRuntime,
	getPersistentAgentThread,
	openPersistentAgentPiSessionManager,
	parseCheckpointApprovalRequest,
	readPersistentAgentBootPromptSnapshot,
	refreshEmptyPersistentAgentThreadBootSnapshot,
	writeApprovedCheckpoint,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

const agentId = "empty-thread-boot-room";
const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
let failures = 0;
function check(label: string, condition: unknown, detail?: unknown): void {
	if (condition) console.log(`  ok  ${label}`);
	else {
		failures += 1;
		console.log(`FAIL  ${label}${detail === undefined ? "" : `: ${JSON.stringify(detail)}`}`);
	}
}

function approvedRecentContext(title: string): string {
	return `### RC-DRAFT | CLOSED | 2026-09-24 | ${title}\n\n**Session arc:** A synthetic session for the boot refresh smoke.\n\n**Body:**\n- ${title} body line.\n\n**Parked:**\nNone\n`;
}

async function rememberThread(threadId: string, title: string): Promise<string> {
	const session = openPersistentAgentPiSessionManager(agentId, getPersistentAgentThread(agentId, threadId)!.runtime as any, tempCwd);
	session.appendMessage({ role: "user", content: `A message worth remembering for ${title}.`, timestamp: Date.now() });
	const proposal = await buildCheckpointProposal(
		{ agentId, conversationId: threadId, model, density: "standard", rememberText: "", runtimeCwd: tempCwd },
		async () => ({ text: `TITLE:\n${title}\n\nSESSION_ARC:\nA synthetic session.\n\nBODY:\n- ${title} body line.\n\nPARKED:\nNone\n`, usage: { input: 1, output: 1, totalTokens: 2, cost: 0 } }),
	);
	const parsed = parseCheckpointApprovalRequest({ conversationId: threadId, model, density: proposal.density, proposal, approvedRecentContext: approvedRecentContext(title) }, agentId);
	const result = writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: tempCwd });
	return result.postCheckpoint.activeThreadId;
}

function bootPromptOf(threadId: string): string {
	const thread = getPersistentAgentThread(agentId, threadId)!;
	return readPersistentAgentBootPromptSnapshot(agentId, thread.runtime as any);
}

try {
	createPersistentAgentFromScaffoldInput({ displayName: "Empty Thread Boot Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const instance = createPersistentAgentInstance(agentId);
	const l1bPath = instance.l1bCurrentPath(instance.readAgentJson());

	const firstThreadId = "pi_boot_first01";
	writePersistentAgentThread(agentId, firstThreadId, { state: "active", origin: "home", model, items: [{ kind: "user", id: "u1", text: "hello" }] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: firstThreadId, model, cwd: tempCwd }),
	});
	const RC_TITLE = "RC_BEFORE_MEMORIZE_SENTINEL";
	const freshThreadId = await rememberThread(firstThreadId, RC_TITLE);
	const fresh = getPersistentAgentThread(agentId, freshThreadId)!;
	check("Remember prepared a Pi-backed fresh conversation", fresh.runtime.kind === "pi-session-jsonl", fresh.runtime.kind);
	check("the prepared snapshot carries the remembered entry", bootPromptOf(freshThreadId).includes(RC_TITLE));

	// Case 1: a Memorize-shaped change (the entry leaves Recent Context and
	// becomes a durable note).
	const NOTE = "MEMORIZED_NOTE_SENTINEL";
	const before1 = fs.readFileSync(l1bPath, "utf-8");
	const withoutEntry = before1.replace(/### RC-[^\n]*RC_BEFORE_MEMORIZE_SENTINEL[\s\S]*?\*\*Parked:\*\*\nNone\n/, "");
	check("the fixture removed the Recent Context entry", !withoutEntry.includes(RC_TITLE));
	const memorized = withoutEntry.replace(/(## [^\n]+\n)/, `$1\n- ${NOTE}: the room remembers this as a lasting note.\n`);
	fs.writeFileSync(l1bPath, memorized, "utf-8");
	const refresh1 = refreshEmptyPersistentAgentThreadBootSnapshot(agentId, freshThreadId);
	check("memorize: the empty conversation was rebuilt", Boolean(refresh1?.rebuilt));
	const prompt1 = bootPromptOf(freshThreadId);
	check("memorize: the boot prompt carries the new note", prompt1.includes(NOTE));
	check("memorize: the boot prompt no longer carries the memorized entry", !prompt1.includes(RC_TITLE));
	const record1 = getPersistentAgentThread(agentId, freshThreadId)!;
	check("memorize: same thread id, same snapshot path, same session", record1.threadId === freshThreadId && (record1.runtime as any).bootPromptSnapshotRelPath === (fresh.runtime as any).bootPromptSnapshotRelPath && (record1.runtime as any).sessionId === (fresh.runtime as any).sessionId);
	check("memorize: the record's fingerprint moved with it", (record1.runtime as any).l1bFingerprint.value === refresh1?.rebuilt?.after.value && (record1.runtime as any).l1bFingerprint.value !== (fresh.runtime as any).l1bFingerprint.value);
	check("memorize: the model lock is unchanged", record1.model.provider === fresh.model.provider && record1.model.model === fresh.model.model);

	// Case 2: a Review-shaped tidy (a note reworded in place).
	const TIDIED = "TIDIED_NOTE_SENTINEL";
	fs.writeFileSync(l1bPath, fs.readFileSync(l1bPath, "utf-8").replace(NOTE, TIDIED), "utf-8");
	const refresh2 = refreshEmptyPersistentAgentThreadBootSnapshot(agentId, freshThreadId);
	check("review: the empty conversation was rebuilt again", Boolean(refresh2?.rebuilt));
	const prompt2 = bootPromptOf(freshThreadId);
	check("review: the boot prompt carries the tidied note", prompt2.includes(TIDIED));
	check("review: the boot prompt no longer carries the old wording", !prompt2.includes(NOTE));

	// Case 4: nothing changed, nothing is rewritten.
	const snapshotPath = instance.resolveRootRelativePath((getPersistentAgentThread(agentId, freshThreadId)!.runtime as any).bootPromptSnapshotRelPath, "snapshot");
	const statBefore = fs.statSync(snapshotPath);
	const recordBefore = fs.readFileSync(instance.runtimeThreadPath(freshThreadId), "utf-8");
	await new Promise((resolve) => setTimeout(resolve, 20));
	const refresh4 = refreshEmptyPersistentAgentThreadBootSnapshot(agentId, freshThreadId);
	check("unchanged memory: no rebuild", refresh4 !== null && refresh4.rebuilt === null);
	check("unchanged memory: snapshot untouched", fs.statSync(snapshotPath).mtimeMs === statBefore.mtimeMs && fs.readFileSync(snapshotPath, "utf-8") === prompt2);
	check("unchanged memory: record untouched", fs.readFileSync(instance.runtimeThreadPath(freshThreadId), "utf-8") === recordBefore);

	// Rule: a Remember made in the rebuilt conversation is not stale.
	let rememberError: string | null = null;
	let nextThreadId = "";
	try {
		nextThreadId = await rememberThread(freshThreadId, "REMEMBER_AFTER_REBUILD_SENTINEL");
	} catch (error) {
		rememberError = (error as Error).message;
	}
	check("remember in the rebuilt conversation is accepted", rememberError === null, rememberError);

	// Case 3: a conversation with turns keeps its snapshot frozen.
	const busyThreadId = "pi_boot_turns01";
	writePersistentAgentThread(agentId, busyThreadId, { state: "active", origin: "home", model, items: [{ kind: "user", id: "u2", text: "a real question" }, { kind: "assistant", id: "a2", text: "a real answer" }] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: busyThreadId, model, cwd: tempCwd }),
	});
	openPersistentAgentPiSessionManager(agentId, getPersistentAgentThread(agentId, busyThreadId)!.runtime as any, tempCwd).appendMessage({ role: "user", content: "a real question", timestamp: Date.now() });
	const busyPromptBefore = bootPromptOf(busyThreadId);
	fs.appendFileSync(l1bPath, "\n- FROZEN_THREAD_MUST_NOT_SEE_THIS_SENTINEL\n", "utf-8");
	const refresh3 = refreshEmptyPersistentAgentThreadBootSnapshot(agentId, busyThreadId);
	check("with turns: no rebuild", refresh3 !== null && refresh3.rebuilt === null);
	check("with turns: the snapshot stays frozen", bootPromptOf(busyThreadId) === busyPromptBefore && !bootPromptOf(busyThreadId).includes("FROZEN_THREAD_MUST_NOT_SEE_THIS_SENTINEL"));

	// A thread that has Pi messages but an empty display cache is not "empty".
	const sessionOnlyId = "pi_boot_sess001";
	writePersistentAgentThread(agentId, sessionOnlyId, { state: "active", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: sessionOnlyId, model, cwd: tempCwd }),
	});
	openPersistentAgentPiSessionManager(agentId, getPersistentAgentThread(agentId, sessionOnlyId)!.runtime as any, tempCwd).appendMessage({ role: "user", content: "spoken but not displayed", timestamp: Date.now() });
	fs.appendFileSync(l1bPath, "\n- ANOTHER_CHANGE_SENTINEL\n", "utf-8");
	const refresh5 = refreshEmptyPersistentAgentThreadBootSnapshot(agentId, sessionOnlyId);
	check("session with messages: no rebuild", refresh5 !== null && refresh5.rebuilt === null);

	if (nextThreadId) check("the next prepared conversation boots on the latest memory", bootPromptOf(nextThreadId).includes(TIDIED));
} catch (error) {
	failures += 1;
	console.error(error instanceof Error ? error.stack || error.message : error);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed; temp root preserved: ${root}`);
	process.exitCode = 1;
} else {
	fs.rmSync(root, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("empty thread boot refresh smoke passed");
}
