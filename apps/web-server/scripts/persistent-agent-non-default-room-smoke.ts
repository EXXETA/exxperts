import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-room-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-room-root-"));
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const {
	createPersistentAgentFromScaffoldInput,
	deletePersistentAgentThread,
	getPersistentAgentStatus,
	getPersistentAgentThread,
	listPersistentAgents,
	writePersistentAgentThread,
} = await import("../src/persistent-agents.js");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function readJson(file: string): any {
	return JSON.parse(readText(file));
}

function assertFile(file: string, label: string): void {
	assert(fs.existsSync(file) && fs.statSync(file).isFile(), `expected file for ${label}`);
}

function assertNoControlRuntimeWrites(controlRoot: string): void {
	const controlRuntimePath = path.join(controlRoot, "runtime", "state.json");
	if (fs.existsSync(controlRuntimePath)) {
		const runtime = readJson(controlRuntimePath);
		assert(runtime.state === "idle" && runtime.activeThreadId === null, "selected room operations must not activate control room runtime state");
	}
	const controlThreadsDir = path.join(controlRoot, "runtime", "threads");
	const controlThreadFiles = fs.existsSync(controlThreadsDir)
		? fs.readdirSync(controlThreadsDir).filter((entry) => entry.endsWith(".json"))
		: [];
	assert(controlThreadFiles.length === 0, "selected room operations must not write control room thread files");
}

// The room folders on disk: a listing or a room's lifecycle creates none that was not asked for.
function roomFolders(): string[] {
	return fs.readdirSync(tempAgentsRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
}

try {
	const initiallyListed = listPersistentAgents();
	assert(Array.isArray(initiallyListed) && initiallyListed.length === 0, "fresh empty agents root should list no rooms");
	assert(roomFolders().length === 0, `a fresh listing creates no room folder, got ${JSON.stringify(roomFolders())}`);

	const control = createPersistentAgentFromScaffoldInput({
		displayName: "Control Smoke Room",
		userName: "Smoke User",
		preferredUserAddress: "Smoke User",
	});
	const controlAgentId = control.agent.agentId;
	const controlRoot = path.join(tempAgentsRoot, controlAgentId);
	const controlAgentBefore = readText(path.join(controlRoot, "agent.json"));
	const controlL1bBefore = readText(path.join(controlRoot, "L1b", "current.md"));
	assertNoControlRuntimeWrites(controlRoot);

	const created = createPersistentAgentFromScaffoldInput({
		displayName: "Selected Smoke Room",
		userName: "Smoke User",
		preferredUserAddress: "Smoke User",
	});
	const agentId = created.agent.agentId;
	assert(agentId !== controlAgentId, "created room must be distinct from control room");
	assert(agentId === "selected-smoke-room", `the created room's id comes from the name asked for, got ${agentId}`);
	assert(created.status.status === "ready", "created selected room should be ready");
	assert(created.status.id === agentId, "created status id should match generated room id");
	assert(created.status.displayName === "Selected Smoke Room", "created status should preserve display name");

	const roomRoot = path.join(tempAgentsRoot, agentId);
	assert(created.status.root === roomRoot, "created status root should point at selected room root");
	assertFile(path.join(roomRoot, "agent.json"), "selected agent.json");
	assertFile(path.join(roomRoot, "runtime", "state.json"), "selected initial runtime state");
	assert(fs.existsSync(path.join(roomRoot, "runtime", "threads")), "selected runtime threads directory should exist");

	const listed = listPersistentAgents();
	const listedIds = listed.map((status: any) => status.id);
	assert(listedIds.includes(controlAgentId), "list should include control room");
	assert(listedIds.includes(agentId), "list should include created selected room");
	assert(JSON.stringify([...listedIds].sort()) === JSON.stringify([controlAgentId, agentId].sort()), `the list holds the rooms made and no other, got ${JSON.stringify(listedIds)}`);
	const listedRoom = listed.find((status: any) => status.id === agentId);
	assert(listedRoom?.displayName === "Selected Smoke Room", "list should expose display name for selected room");

	const status = getPersistentAgentStatus(agentId);
	assert(status.exists === true && status.status === "ready", "status should find created selected room");
	assert(status.runtime.agentId === agentId && status.runtime.state === "idle", "initial runtime should belong to selected room");

	const threadId = "mr10_selected_room_thread";
	const threadModel = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
	const writeResult = writePersistentAgentThread(agentId, threadId, {
		state: "active",
		origin: "launcher",
		model: threadModel,
		items: [
			{ kind: "user", id: "u1", text: "synthetic selected-room user turn" },
			{ kind: "assistant", id: "a1", text: "synthetic selected-room assistant turn" },
		],
	});
	assert(writeResult.thread.agentId === agentId, "written thread should record selected room id");
	assert(writeResult.thread.threadId === threadId, "written thread should record selected thread id");
	assert(writeResult.runtime.agentId === agentId, "runtime write should record selected room id");
	assert(writeResult.runtime.state === "active", "runtime should become active after active thread write");
	assert(writeResult.runtime.activeThreadId === threadId, "runtime activeThreadId should point to selected thread");

	const roomRuntimeFile = path.join(roomRoot, "runtime", "state.json");
	const roomThreadFile = path.join(roomRoot, "runtime", "threads", `${threadId}.json`);
	assertFile(roomRuntimeFile, "selected runtime after write");
	assertFile(roomThreadFile, "selected thread after write");
	assertNoControlRuntimeWrites(controlRoot);

	const runtimeAfterWrite = readJson(roomRuntimeFile);
	assert(runtimeAfterWrite.agentId === agentId, "runtime file should contain selected room id");
	assert(runtimeAfterWrite.activeThreadId === threadId, "runtime file should point to selected thread");
	assert(runtimeAfterWrite.model.provider === threadModel.provider && runtimeAfterWrite.model.model === threadModel.model, "runtime model should come from selected thread write");

	const threadFileAfterWrite = readJson(roomThreadFile);
	assert(threadFileAfterWrite.agentId === agentId, "thread file should contain selected room id");
	assert(threadFileAfterWrite.items.length === 2, "thread file should contain synthetic transcript items");

	const readThread = getPersistentAgentThread(agentId, threadId);
	assert(readThread?.agentId === agentId, "read thread should come from selected room");
	assert(readThread?.items.length === 2, "read thread should preserve synthetic items");
	assert(getPersistentAgentThread(controlAgentId, threadId) === null, "control room must not see selected room thread");

	const standbyResult = writePersistentAgentThread(agentId, threadId, {
		state: "standby",
		origin: "home",
		model: threadModel,
		items: readThread.items,
	});
	assert(standbyResult.thread.state === "standby", "selected thread should update to standby");
	assert(standbyResult.runtime.state === "standby", "selected runtime should update to standby");
	assert(readJson(roomRuntimeFile).state === "standby", "runtime file should persist standby state under selected root");
	assertNoControlRuntimeWrites(controlRoot);

	const deleteResult = deletePersistentAgentThread(agentId, threadId);
	assert(deleteResult.ok === true, "delete should report ok");
	assert(deleteResult.runtime.agentId === agentId, "delete runtime response should belong to selected room");
	assert(deleteResult.runtime.state === "idle", "delete should idle selected room runtime");
	assert(!fs.existsSync(roomThreadFile), "selected thread file should be removed by delete");
	assert(readJson(roomRuntimeFile).agentId === agentId, "runtime after delete should still belong to selected room");
	assert(readJson(roomRuntimeFile).activeThreadId === null, "runtime after delete should clear selected activeThreadId");
	assertNoControlRuntimeWrites(controlRoot);

	assert(readText(path.join(controlRoot, "agent.json")) === controlAgentBefore, "selected room lifecycle must not modify control agent.json");
	assert(readText(path.join(controlRoot, "L1b", "current.md")) === controlL1bBefore, "selected room lifecycle must not modify control L1b");
	assert(JSON.stringify(roomFolders()) === JSON.stringify([controlAgentId, agentId].sort()), `only the rooms asked for have folders, got ${JSON.stringify(roomFolders())}`);

	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	fs.rmSync(tempHome, { recursive: true, force: true });
	console.log("persistent-agent non-default room smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
}
