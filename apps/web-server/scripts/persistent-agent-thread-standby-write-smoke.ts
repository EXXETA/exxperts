// A standby write to a conversation that is no longer the room's current one
// leaves the runtime pointer alone (keepRuntimeIfMoved): the thread file takes
// the items, the room stays on the newer conversation. Without the option the
// write moves the pointer as it always has (the scheduled-run landing and the
// boundary fresh threads rely on that), and a landing into an idle room still
// makes it resumable. A write that does not know the thread's origin
// ("unknown", as the client's debounced and pagehide saves send) keeps the
// origin the thread has, so an empty prepared thread stays prepared.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-standby-write-home-"));
const tempCwd = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-standby-write-cwd-"));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model" }], maintenanceModel: "room-model" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;

const agents = await import("../src/persistent-agents.js");
const model = { provider: "openai-compatible", model: "room-model", label: "Room Model" };

function write(agentId: string, threadId: string, state: "active" | "standby", items: unknown[], options: { keepRuntimeIfMoved?: boolean; origin?: "launcher" | "checkpoint" | "home" | "unknown" } = {}) {
	return agents.writePersistentAgentThread(agentId, threadId, { state, origin: options.origin ?? "launcher", model, items }, {
		createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId, model, cwd: tempCwd }),
		...options,
	});
}

try {
	const scaffolded = agents.createPersistentAgentFromScaffoldInput({ displayName: "Standby Write Smoke Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	const agentId = scaffolded.agent.agentId;
	const turn = [{ kind: "user", id: "u1", text: "a question" }, { kind: "assistant", id: "a1", text: "the landed answer", streaming: false }];

	// A parked, then B opened: the room is on B.
	write(agentId, "c_thread_a", "standby", [{ kind: "user", id: "u1", text: "a question" }]);
	write(agentId, "c_thread_b", "active", []);
	assert(agents.getPersistentAgentRuntimeState(agentId).activeThreadId === "c_thread_b", "the room is on B");

	// A landing into A with the option: A's file has the items, the room stays on B.
	const kept = write(agentId, "c_thread_a", "standby", turn, { keepRuntimeIfMoved: true });
	assert(kept.runtime.activeThreadId === "c_thread_b" && kept.runtime.state === "active", `the returned runtime is the unchanged B runtime, got ${JSON.stringify(kept.runtime)}`);
	assert(agents.getPersistentAgentRuntimeState(agentId).activeThreadId === "c_thread_b", "the pointer stays on B");
	const landedA = agents.getPersistentAgentThread(agentId, "c_thread_a");
	assert(landedA?.state === "standby" && landedA.items.some((item: any) => item.id === "a1"), "A's file carries the landed answer");
	assert(agents.beginPersistentAgentTurn(agentId, "c_thread_b", { turnId: "turn_b_1" }).turnId === "turn_b_1", "a prompt on B is accepted after the landing");
	agents.finishPersistentAgentTurn(agentId, "c_thread_b", { turnId: "turn_b_1", terminalReason: "completed" });

	// The same write to the CURRENT conversation moves nothing either way.
	const current = write(agentId, "c_thread_b", "standby", [{ kind: "user", id: "u2", text: "parked" }], { keepRuntimeIfMoved: true });
	assert(current.runtime.activeThreadId === "c_thread_b" && current.runtime.state === "standby", "a standby write to the current conversation parks it as always");

	// Without the option the write moves the pointer, as the scheduled landing and the boundary threads rely on.
	write(agentId, "c_thread_b", "active", []);
	const moved = write(agentId, "c_thread_a", "standby", turn);
	assert(moved.runtime.activeThreadId === "c_thread_a" && agents.getPersistentAgentRuntimeState(agentId).activeThreadId === "c_thread_a", "without the option the pointer moves to A");

	// An idle room plus the option: the landing makes the room resumable on A.
	agents.writePersistentAgentRuntimeState(agentId, { state: "idle" });
	const idle = write(agentId, "c_thread_a", "standby", turn, { keepRuntimeIfMoved: true });
	assert(idle.runtime.activeThreadId === "c_thread_a" && idle.runtime.state === "standby", "a landing into an idle room takes the pointer");

	// An empty thread Remember prepared keeps its origin through a save that
	// does not know it, so the room still reads as parked at that boundary.
	write(agentId, "c_thread_cp", "active", [], { origin: "checkpoint" });
	write(agentId, "c_thread_cp", "active", [], { origin: "unknown" });
	const afterUnknown = agents.getPersistentAgentThread(agentId, "c_thread_cp")?.origin;
	assert(afterUnknown === "checkpoint", `an unknown origin keeps the known one, got ${afterUnknown}`);
	assert(agents.getPersistentAgentStatus(agentId).activeThread?.preparedByBoundary === "checkpoint", "the empty prepared thread is still prepared after the unknown save");
	// A known origin still replaces it.
	write(agentId, "c_thread_cp", "active", [], { origin: "home" });
	const afterHome = agents.getPersistentAgentThread(agentId, "c_thread_cp")?.origin;
	assert(afterHome === "home", `a known origin replaces the old one, got ${afterHome}`);
	// A new thread written with an unknown origin is simply unknown.
	write(agentId, "c_thread_new", "active", [], { origin: "unknown" });
	assert(agents.getPersistentAgentThread(agentId, "c_thread_new")?.origin === "unknown", "a new thread with an unknown origin stays unknown");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempCwd, { recursive: true, force: true });
	console.log("persistent agent thread standby write smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
