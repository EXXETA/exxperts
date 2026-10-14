// A conversation record is written whole or not at all: a write cut off half
// way (a crash, a full disk) leaves the record as it was, never a file that
// no longer reads. Each write that changes a record in place is cut off once
// here: adding a note for the next turn, clearing those notes, and moving an
// empty conversation to another model.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-torn-record-home-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model" }, { modelId: "other-model" }], maintenanceModel: "room-model" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const agents = await import("../src/persistent-agents.js");
const model = { provider: "openai-compatible", model: "room-model", label: "Room Model" };
const realWriteFileSync = fs.writeFileSync;

// The next write to a conversation record stops half way and throws.
function tearNextRecordWrite(): { hit(): boolean } {
	let fired = false;
	(fs as any).writeFileSync = (file: any, data: any, ...rest: any[]) => {
		if (!fired && /[\\/]threads[\\/][^\\/]+\.json/.test(String(file)) && typeof data === "string") {
			fired = true;
			(realWriteFileSync as any)(file, data.slice(0, Math.floor(data.length / 2)), ...rest);
			throw new Error("injected: the disk filled half way");
		}
		return (realWriteFileSync as any)(file, data, ...rest);
	};
	return { hit: () => fired };
}

function cutOff(label: string, write: () => unknown): void {
	const tear = tearNextRecordWrite();
	let threw = false;
	try {
		write();
	} catch {
		threw = true;
	} finally {
		(fs as any).writeFileSync = realWriteFileSync;
	}
	assert(tear.hit() && threw, `${label}: the write was cut off`);
}

try {
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Torn Record Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const turn = [{ kind: "user", id: "u1", text: "a question" }, { kind: "assistant", id: "a1", text: "the answer", streaming: false }];
	agents.writePersistentAgentThread(agentId, "c_torn_0001", { state: "standby", origin: "home", model, items: turn });
	agents.appendPersistentAgentThreadPendingHandoff(agentId, "c_torn_0001", "A note for the next turn.");

	cutOff("adding a note", () => agents.appendPersistentAgentThreadPendingHandoff(agentId, "c_torn_0001", "A second note."));
	let record = agents.getPersistentAgentThread(agentId, "c_torn_0001");
	assert(record?.items.length === 2 && record.pendingHandoffs?.length === 1, `a cut-off note leaves the record as it was, got ${JSON.stringify(record?.pendingHandoffs)}`);

	cutOff("clearing the notes", () => agents.clearPersistentAgentThreadPendingHandoffs(agentId, "c_torn_0001"));
	record = agents.getPersistentAgentThread(agentId, "c_torn_0001");
	assert(record?.items.length === 2 && record.pendingHandoffs?.length === 1, `a cut-off clear leaves the record as it was, got ${JSON.stringify(record)}`);

	agents.writePersistentAgentThread(agentId, "c_torn_0002", { state: "standby", origin: "home", model, items: [] }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: "c_torn_0002", model, cwd: tempHome }),
	});
	cutOff("moving an empty conversation to another model", () => agents.refreshEmptyPersistentAgentThreadModel(agentId, "c_torn_0002", { provider: "openai-compatible", model: "other-model" }));
	record = agents.getPersistentAgentThread(agentId, "c_torn_0002");
	assert(record?.model.model === "room-model", `a cut-off model move leaves the record as it was, got ${JSON.stringify(record?.model)}`);

	console.log("conversation-record-torn-write smoke: ok");
} finally {
	(fs as any).writeFileSync = realWriteFileSync;
	fs.rmSync(tempHome, { recursive: true, force: true });
}
