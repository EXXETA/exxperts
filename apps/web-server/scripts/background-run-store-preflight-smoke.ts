import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function expectThrow(fn: () => unknown, label: string): void {
	try {
		fn();
	} catch {
		return;
	}
	throw new Error(`${label}: expected failure`);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-background-run-store-"));
const tempHome = path.join(tmp, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
const smokeAppDir = path.join(tempHome, ".exxperts", "app");
fs.mkdirSync(smokeAppDir, { recursive: true });
fs.writeFileSync(
	path.join(smokeAppDir, "openai-compatible-ai-profile.json"),
	JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }], maintenanceModel: "claude-opus-4.6" }, null, 2),
);
fs.writeFileSync(path.join(smokeAppDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));
process.env.EXXPERTS_CODING_AGENT_DIR = tempAgentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

try {
	const backgroundRuns = await import("../src/background-runs.js");
	const {
		backgroundRunRecordPath,
		backgroundRunsDirectoryPath,
		backgroundRunsRootPath,
		createBackgroundRun,
		listBackgroundRuns,
		readBackgroundRun,
		updateBackgroundRunStatus,
	} = backgroundRuns;

	const expectedRoot = path.join(tempHome, ".exxperts", "app", "background-runs");
	const expectedRunsDir = path.join(expectedRoot, "runs");
	assert(backgroundRunsRootPath() === expectedRoot, "background-run root should live under temp ~/.exxperts/app");
	assert(backgroundRunsDirectoryPath() === expectedRunsDir, "background-run records should live under runs/ subdirectory");
	assert(listBackgroundRuns().length === 0, "empty store should list no background runs");
	assert(!fs.existsSync(expectedRoot), "empty list should not create background-run storage");

	expectThrow(() => backgroundRunRecordPath("../escape"), "path traversal run id");
	expectThrow(() => backgroundRunRecordPath("bg_../../escape"), "embedded traversal run id");
	expectThrow(() => backgroundRunRecordPath("not-bg-id"), "invalid run id prefix");
	expectThrow(() => backgroundRunRecordPath("BG_0123456789abcdef0123456789abcdef"), "uppercase run id");

	const now = new Date("2026-01-01T00:00:00.000Z");
	const run = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: "background-run-smoke-room" },
		source: { trigger: "schedule-due", schedulerJobId: "sched_0123456789abcdef0123456789abcdef", dueAt: "2026-01-01T00:05:00.000Z" },
		target: { kind: "fresh-thread", roomId: "background-run-smoke-room", modelPolicyKey: "scheduledRoom" },
		warnings: ["synthetic warning"],
		now,
	});
	assert(/^bg_[a-f0-9]{32}$/.test(run.runId), "created run id should use bg_ prefix");
	assert(run.status === "queued", "new run should default to queued");
	assert(run.queuedAt === now.toISOString(), "queued run should record queuedAt");
	assert(run.createdAt === now.toISOString() && run.updatedAt === now.toISOString(), "created run should use provided reference time");
	assert(run.target?.kind === "fresh-thread", "created run should persist target metadata only");

	const runPath = backgroundRunRecordPath(run.runId);
	assert(runPath === path.join(expectedRunsDir, run.runId, "run.json"), "record path should be canonical runs/<runId>/run.json");
	assert(path.resolve(runPath).startsWith(path.resolve(expectedRunsDir) + path.sep), "record path must be contained by background-run root");
	assert(fs.existsSync(runPath), "create should write durable run.json");

	const storedJson = JSON.parse(fs.readFileSync(runPath, "utf-8"));
	assert(storedJson.runId === run.runId, "run.json should persist run id");
	assert(storedJson.kind === "scheduled-prompt", "run.json should persist kind");
	assert(storedJson.scope?.roomId === "background-run-smoke-room", "run.json should persist room scope");

	const durable = readBackgroundRun(run.runId);
	assert(durable.runId === run.runId, "read should round-trip created run");
	assert(durable.target?.modelPolicyKey === "scheduledRoom", "read should preserve model policy placeholder without resolving models");
	assert(durable.warnings.length === 1 && durable.warnings[0] === "synthetic warning", "read should preserve warnings");

	const startedAt = "2026-01-01T00:01:00.000Z";
	const updated = updateBackgroundRunStatus(run.runId, "deferred", {
		reason: "room_in_use",
		message: "Synthetic room lock is active.",
		startedAt,
		attempts: 1,
		target: { kind: "none", roomId: "background-run-smoke-room" },
		warnings: [],
		now: new Date("2026-01-01T00:02:00.000Z"),
	});
	assert(updated.status === "deferred", "status update should persist new status");
	assert(updated.reason === "room_in_use", "status update should persist reason");
	assert(updated.message === "Synthetic room lock is active.", "status update should persist message");
	assert(updated.startedAt === startedAt, "status update should persist startedAt metadata");
	assert(updated.attempts === 1, "status update should persist attempts");
	assert(updated.updatedAt === "2026-01-01T00:02:00.000Z", "status update should refresh updatedAt");

	const second = createBackgroundRun({
		kind: "room-consult",
		scope: { kind: "room-consult", sourceRoomId: "source-room", targetRoomId: "target-room" },
		source: { trigger: "manual" },
		status: "blocked",
		reason: "prepared_runtime_boundary",
		message: "Synthetic boundary blocks mutation.",
		target: { kind: "no-room-mutation" },
		now: new Date("2026-01-01T00:03:00.000Z"),
	});
	assert(second.status === "blocked", "create should allow non-queued statuses");
	assert(second.queuedAt === undefined, "non-queued create should not pretend the run was queued");

	const third = createBackgroundRun({
		kind: "global-memory-refresh",
		scope: { kind: "global-memory" },
		source: { trigger: "system" },
		status: "queued",
		now: new Date("2026-01-01T00:04:00.000Z"),
	});

	const listed = listBackgroundRuns();
	assert(listed.map((item: any) => item.runId).join(",") === [third.runId, second.runId, run.runId].join(","), "list should return records newest first");
	assert(listBackgroundRuns({ kind: "scheduled-prompt" }).length === 1, "list should filter by kind");
	assert(listBackgroundRuns({ status: "blocked" }).length === 1, "list should filter by status");
	assert(listBackgroundRuns({ scope: { kind: "persistent-room", roomId: "background-run-smoke-room" } }).length === 1, "list should filter by persistent-room scope");
	assert(listBackgroundRuns({ limit: 2 }).length === 2, "list should respect limit");

	expectThrow(() => createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: "Uppercase" },
		source: { trigger: "manual" },
	}), "unsafe room id in scope");
	expectThrow(() => createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: "../escape" },
		source: { trigger: "manual" },
	}), "path traversal room id in scope");
	expectThrow(() => createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: "safe-room" },
		source: { trigger: "manual" },
		artifacts: { inputRelPath: "../prompt.md" },
	}), "path traversal artifact path");

	const corruptRunId = "bg_ffffffffffffffffffffffffffffffff";
	writeJson(path.join(expectedRunsDir, corruptRunId, "run.json"), { version: 999, runId: corruptRunId });
	expectThrow(() => readBackgroundRun(corruptRunId), "corrupt record read");
	expectThrow(() => listBackgroundRuns(), "corrupt record list");

	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	writePersistentAgentAiProfileState("openai-compatible");
	const persistentAgents = await import("../src/persistent-agents.js");
	const {
		beginPersistentAgentTurn,
		classifyPersistentRoomBackgroundRunTarget,
		createPersistentAgentFromScaffoldInput,
		finishPersistentAgentTurn,
		getPersistentAgentRuntimeState,
		getPersistentAgentThread,
		writePersistentAgentThread,
	} = persistentAgents;
	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const roomId = String(created.agent.agentId);
		assert(roomId, `${displayName}: room id should be returned`);
		return roomId;
	}
	function runtimeThreadFiles(roomId: string): string[] {
		const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
		return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")) : [];
	}

	const missingPreflight = classifyPersistentRoomBackgroundRunTarget("missing-background-room");
	assert(missingPreflight.status === "blocked" && missingPreflight.reason === "room_missing", "missing room should block preflight as room_missing");

	const idleRoomId = createRoom("Background Preflight Idle Room");
	const idlePreflight = classifyPersistentRoomBackgroundRunTarget(idleRoomId);
	assert(idlePreflight.status === "queued" && idlePreflight.reason === "fresh_thread", "idle room should queue fresh-thread background target");
	assert(idlePreflight.target.kind === "fresh-thread" && idlePreflight.target.modelPolicyKey === "scheduledRoom", "fresh target should use scheduledRoom policy placeholder");
	assert(runtimeThreadFiles(idleRoomId).length === 0, "idle preflight must not create runtime threads");
	assert(getPersistentAgentRuntimeState(idleRoomId).state === "idle", "idle preflight must not mutate runtime state");

	const lockRoomId = createRoom("Background Preflight Locked Room");
	const lockFile = path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockRoomId}.json`);
	writeJson(lockFile, { surface: "web", pid: process.pid, connectionId: "synthetic-lock", host: os.hostname(), label: "smoke", acquiredAt: Date.now(), lastSeen: Date.now() });
	const lockedPreflight = classifyPersistentRoomBackgroundRunTarget(lockRoomId);
	assert(lockedPreflight.status === "deferred" && lockedPreflight.reason === "room_in_use", "active advisory room lock should defer preflight");
	assert(getPersistentAgentRuntimeState(lockRoomId).state === "idle", "locked preflight must not mutate runtime state");

	const resumeRoomId = createRoom("Background Preflight Resume Room");
	const resumeThreadId = "resume_thread_0001";
	writePersistentAgentThread(resumeRoomId, resumeThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", id: "synthetic-user", text: "Synthetic prior message." }],
	});
	const resumePreflight = classifyPersistentRoomBackgroundRunTarget(resumeRoomId);
	assert(resumePreflight.status === "queued" && resumePreflight.reason === "resume_thread", "message-bearing thread should queue resume-thread background target");
	assert(resumePreflight.target.kind === "resume-thread" && resumePreflight.target.threadId === resumeThreadId, "resume target should preserve active thread id");
	assert(resumePreflight.target.model?.provider === model.provider && resumePreflight.target.model?.model === model.model, "resume target should preserve locked model metadata");
	assert(getPersistentAgentRuntimeState(resumeRoomId).activeThreadId === resumeThreadId, "resume preflight must not mutate active thread");

	const runningTurn = beginPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: "synthetic-background-preflight-turn", connectionId: "synthetic-ws" });
	assert(runningTurn.state === "running", "fixture should mark active turn running");
	const activeTurnPreflight = classifyPersistentRoomBackgroundRunTarget(resumeRoomId);
	assert(activeTurnPreflight.status === "deferred" && activeTurnPreflight.reason === "active_turn_in_flight", "running active turn should defer preflight");
	assert(getPersistentAgentRuntimeState(resumeRoomId).activeThreadId === resumeThreadId, "active-turn preflight must not mutate active thread");
	finishPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: runningTurn.turnId, terminalReason: "completed" });
	// An unreadable state file is not "this room went on in another window".
	const resumeStateFile = path.join(tempAgentsRoot, resumeRoomId, "runtime", "state.json");
	const resumeState = fs.readFileSync(resumeStateFile, "utf-8");
	fs.writeFileSync(resumeStateFile, "{ not json");
	const unreadableLine = "The room could not read its own files, so your message was not sent. Nothing was lost. Try again; if it repeats, restart exxperts.";
	try {
		beginPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: "synthetic-unreadable-state-turn", connectionId: "synthetic-ws" });
		throw new Error("a turn with an unreadable state file must not start");
	} catch (error) {
		assert((error as Error).message === unreadableLine, `an unreadable state file says so, not "moved", got: ${(error as Error).message}`);
	}
	fs.writeFileSync(resumeStateFile, resumeState);
	// So does the conversation's own record, in place of a developer's words.
	const resumeThreadFile = path.join(tempAgentsRoot, resumeRoomId, "runtime", "threads", `${resumeThreadId}.json`);
	const resumeThread = fs.readFileSync(resumeThreadFile, "utf-8");
	fs.writeFileSync(resumeThreadFile, "{ not json");
	try {
		beginPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: "synthetic-unreadable-thread-turn", connectionId: "synthetic-ws" });
		throw new Error("a turn with an unreadable conversation record must not start");
	} catch (error) {
		assert((error as Error).message === unreadableLine && (error as { code?: string }).code === "room_files_unreadable", `an unreadable conversation record says the room could not read its own files, got: ${(error as Error).message}`);
	}
	fs.writeFileSync(resumeThreadFile, resumeThread);
	const readableAgain = beginPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: "synthetic-readable-again-turn", connectionId: "synthetic-ws" });
	finishPersistentAgentTurn(resumeRoomId, resumeThreadId, { turnId: readableAgain.turnId, terminalReason: "completed" });

	const checkpointRoomId = createRoom("Background Preflight Checkpoint Boundary Room");
	const checkpointThreadId = "postcp_background_0001";
	writePersistentAgentThread(checkpointRoomId, checkpointThreadId, { state: "standby", origin: "checkpoint", model, items: [] });
	const checkpointPreflight = classifyPersistentRoomBackgroundRunTarget(checkpointRoomId);
	assert(checkpointPreflight.status === "blocked" && checkpointPreflight.reason === "prepared_runtime_boundary", "empty checkpoint boundary should block preflight");
	assert(getPersistentAgentThread(checkpointRoomId, checkpointThreadId) !== null, "checkpoint boundary preflight must not discard prepared thread");
	assert(getPersistentAgentRuntimeState(checkpointRoomId).activeThreadId === checkpointThreadId, "checkpoint boundary preflight must not mutate runtime");

	const mementoRoomId = createRoom("Background Preflight Memento Boundary Room");
	const mementoThreadId = "postmem_background_0001";
	writePersistentAgentThread(mementoRoomId, mementoThreadId, { state: "standby", origin: "memento", model, items: [] });
	const mementoPreflight = classifyPersistentRoomBackgroundRunTarget(mementoRoomId);
	assert(mementoPreflight.status === "blocked" && mementoPreflight.reason === "prepared_runtime_boundary", "empty Memento boundary should block preflight");
	assert(getPersistentAgentThread(mementoRoomId, mementoThreadId) !== null, "Memento boundary preflight must not discard prepared thread");
	assert(getPersistentAgentRuntimeState(mementoRoomId).activeThreadId === mementoThreadId, "Memento boundary preflight must not mutate runtime");

	const escapedOutside = path.join(tempHome, ".exxperts", "app", "escape");
	assert(!fs.existsSync(escapedOutside), "unsafe ids must not create escaped background-run paths");
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "background-run smoke must not write legacy ~/.exxeta state");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "agent", "auth.json")), "background-run smoke must not create/read runtime auth state");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "agent", "models.json")), "background-run smoke must not create/read runtime model state");

	console.log("background-run store/preflight smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
