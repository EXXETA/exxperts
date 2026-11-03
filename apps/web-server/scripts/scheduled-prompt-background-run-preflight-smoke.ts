import fs from "node:fs";
import os from "node:os";
import path from "node:path";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function runtimeThreadFiles(tempAgentsRoot: string, roomId: string): string[] {
	const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
	return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")) : [];
}

function assertNoPromptLeak(run: { message?: string; artifacts?: { inputRelPath?: string } }, promptText: string, label: string): void {
	assert(!String(run.message ?? "").includes(promptText), `${label}: run message must not contain prompt text`);
	assert(run.artifacts?.inputRelPath === undefined, `${label}: MR6 must not write input prompt artifacts`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-scheduled-prompt-preflight-"));
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
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const scheduleModule = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		addPersistentRoomScheduleJob,
		persistentRoomScheduleStorePath,
		readPersistentRoomScheduleStore,
	} = scheduleModule;
	const persistentAgents = await import("../src/persistent-agents.js");
	const {
		beginPersistentAgentTurn,
		createPersistentAgentFromScaffoldInput,
		finishPersistentAgentTurn,
		getPersistentAgentRuntimeState,
		getPersistentAgentThread,
		writePersistentAgentThread,
	} = persistentAgents;

	writePersistentAgentAiProfileState("openai-compatible");

	const model = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };
	const alternateLockedModel = { provider: "openai-compatible", model: "claude-opus-4.6", label: "Claude Opus 4.6" };
	const secretPromptText = "SYNTHETIC_SECRET_PROMPT_TEXT_DO_NOT_COPY_TO_RUN_MESSAGE";
	const now = new Date("2026-01-01T00:00:00.000Z");
	const dueAt = "2026-01-01T00:05:00.000Z";

	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const roomId = String(created.agent.agentId);
		assert(roomId, `${displayName}: room id should be returned`);
		return roomId;
	}

	function addSchedule(roomId: string, name: string, options: { enabled?: boolean; prompt?: string } = {}) {
		return addPersistentRoomScheduleJob(roomId, {
			name,
			type: "once",
			schedule: "+30m",
			prompt: options.prompt ?? secretPromptText,
			enabled: options.enabled,
			now,
		});
	}

	const idleRoomId = createRoom("Scheduled Preflight Idle Room");
	const idleJob = addSchedule(idleRoomId, "idle job");
	const idleBefore = readPersistentRoomScheduleStore(idleRoomId).jobs.find((job: any) => job.id === idleJob.id);
	const idleResult = createScheduledPromptBackgroundRunPreflight({ roomId: idleRoomId, scheduleJobId: idleJob.id, dueAt, now });
	assert(idleResult.job?.id === idleJob.id, "idle result should include schedule job diagnostics");
	assert(idleResult.activeProfileId === "openai-compatible", "fresh preflight should expose active profile diagnostics");
	assert(idleResult.classification?.status === "queued" && idleResult.classification.reason === "fresh_thread", "idle classification should queue fresh thread");
	assert(idleResult.run.kind === "scheduled-prompt", "idle run should be scheduled-prompt kind");
	assert(idleResult.run.scope.kind === "persistent-room" && idleResult.run.scope.roomId === idleRoomId, "idle run should persist room scope");
	assert(idleResult.run.source.schedulerJobId === idleJob.id, "idle run should persist scheduler job id");
	assert(idleResult.run.source.trigger === "schedule-due", "idle run should default trigger to schedule-due");
	assert(idleResult.run.source.dueAt === dueAt, "idle run should persist dueAt metadata");
	assert(idleResult.run.status === "queued" && idleResult.run.reason === "fresh_thread", "idle enabled job should queue fresh-thread run");
	assert(idleResult.run.target?.kind === "fresh-thread", "idle run should target fresh thread");
	assert(idleResult.run.target.roomId === idleRoomId, "idle target should include room id");
	assert(idleResult.run.target.modelPolicyKey === "scheduledRoom", "fresh target should record scheduledRoom policy key");
	assert(idleResult.run.target.model?.provider === "openai-compatible" && idleResult.run.target.model?.model === "gpt-5.5", "fresh target should resolve concrete scheduledRoom model");
	assert(runtimeThreadFiles(tempAgentsRoot, idleRoomId).length === 0, "fresh preflight must not create runtime threads");
	assert(getPersistentAgentRuntimeState(idleRoomId).state === "idle", "fresh preflight must not mutate runtime state");
	const idleAfter = readPersistentRoomScheduleStore(idleRoomId).jobs.find((job: any) => job.id === idleJob.id);
	assert(idleBefore?.lastRunAt === idleAfter?.lastRunAt && idleAfter?.lastRunAt === null, "fresh preflight must not mutate schedule lastRunAt");
	assert(idleBefore?.lastStatus === idleAfter?.lastStatus && idleAfter?.lastStatus === null, "fresh preflight must not mutate schedule lastStatus");
	assert(idleBefore?.lastError === idleAfter?.lastError && idleAfter?.lastError === null, "fresh preflight must not mutate schedule lastError");
	assertNoPromptLeak(idleResult.run, secretPromptText, "idle run");

	const resumeRoomId = createRoom("Scheduled Preflight Resume Room");
	const resumeJob = addSchedule(resumeRoomId, "resume job");
	const resumeThreadId = "sched_resume_thread_0001";
	writePersistentAgentThread(resumeRoomId, resumeThreadId, {
		state: "standby",
		origin: "home",
		model: alternateLockedModel,
		items: [{ kind: "user", id: "synthetic-user", text: "Synthetic prior message." }],
	});
	const resumeResult = createScheduledPromptBackgroundRunPreflight({ roomId: resumeRoomId, scheduleJobId: resumeJob.id, trigger: "manual", now });
	assert(resumeResult.run.status === "queued" && resumeResult.run.reason === "resume_thread", "message-bearing standby should queue resume-thread run");
	assert(resumeResult.run.source.trigger === "manual", "manual trigger should be preserved");
	assert(resumeResult.run.target?.kind === "resume-thread" && resumeResult.run.target.threadId === resumeThreadId, "resume target should preserve active thread id");
	assert(resumeResult.run.target.model?.provider === alternateLockedModel.provider && resumeResult.run.target.model?.model === alternateLockedModel.model, "resume target should preserve locked thread model");
	assert(resumeResult.run.target.modelPolicyKey === undefined, "resume target should not use scheduledRoom policy key");
	assert(getPersistentAgentRuntimeState(resumeRoomId).activeThreadId === resumeThreadId, "resume preflight must not mutate active thread");
	assertNoPromptLeak(resumeResult.run, secretPromptText, "resume run");

	const lockedRoomId = createRoom("Scheduled Preflight Locked Room");
	const lockedJob = addSchedule(lockedRoomId, "locked job");
	writeJson(path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockedRoomId}.json`), {
		surface: "web",
		pid: process.pid,
		connectionId: "synthetic-lock",
		host: os.hostname(),
		label: "smoke",
		acquiredAt: Date.now(),
		lastSeen: Date.now(),
	});
	const lockedResult = createScheduledPromptBackgroundRunPreflight({ roomId: lockedRoomId, scheduleJobId: lockedJob.id, now });
	assert(lockedResult.run.status === "deferred" && lockedResult.run.reason === "room_in_use", "active advisory room lock should defer scheduled preflight");
	assert(lockedResult.run.target?.kind === "none" && lockedResult.run.target.roomId === lockedRoomId, "locked target should be none");
	assertNoPromptLeak(lockedResult.run, secretPromptText, "locked run");

	const activeTurnRoomId = createRoom("Scheduled Preflight Active Turn Room");
	const activeTurnJob = addSchedule(activeTurnRoomId, "active turn job");
	const activeTurnThreadId = "sched_active_turn_0001";
	writePersistentAgentThread(activeTurnRoomId, activeTurnThreadId, {
		state: "standby",
		origin: "home",
		model,
		items: [{ kind: "user", id: "synthetic-user", text: "Synthetic active turn message." }],
	});
	const runningTurn = beginPersistentAgentTurn(activeTurnRoomId, activeTurnThreadId, { turnId: "synthetic-scheduled-preflight-turn", connectionId: "synthetic-ws" });
	const activeTurnResult = createScheduledPromptBackgroundRunPreflight({ roomId: activeTurnRoomId, scheduleJobId: activeTurnJob.id, now });
	assert(activeTurnResult.run.status === "deferred" && activeTurnResult.run.reason === "active_turn_in_flight", "active turn should defer scheduled preflight");
	assert(getPersistentAgentRuntimeState(activeTurnRoomId).activeThreadId === activeTurnThreadId, "active-turn preflight must not mutate active thread");
	finishPersistentAgentTurn(activeTurnRoomId, activeTurnThreadId, { turnId: runningTurn.turnId, terminalReason: "completed" });
	assertNoPromptLeak(activeTurnResult.run, secretPromptText, "active-turn run");

	const checkpointRoomId = createRoom("Scheduled Preflight Checkpoint Boundary Room");
	const checkpointJob = addSchedule(checkpointRoomId, "checkpoint boundary job");
	const checkpointThreadId = "postcp_scheduled_0001";
	writePersistentAgentThread(checkpointRoomId, checkpointThreadId, { state: "standby", origin: "checkpoint", model, items: [] });
	const checkpointResult = createScheduledPromptBackgroundRunPreflight({ roomId: checkpointRoomId, scheduleJobId: checkpointJob.id, now });
	assert(checkpointResult.run.status === "blocked" && checkpointResult.run.reason === "prepared_runtime_boundary", "empty checkpoint boundary should block scheduled preflight");
	assert(checkpointResult.run.error?.code === "prepared_runtime_boundary", "checkpoint boundary should persist blocked error code");
	assert(getPersistentAgentThread(checkpointRoomId, checkpointThreadId) !== null, "checkpoint boundary must be retained");
	assert(getPersistentAgentRuntimeState(checkpointRoomId).activeThreadId === checkpointThreadId, "checkpoint boundary preflight must not mutate runtime");
	assertNoPromptLeak(checkpointResult.run, secretPromptText, "checkpoint run");

	const mementoRoomId = createRoom("Scheduled Preflight Memento Boundary Room");
	const mementoJob = addSchedule(mementoRoomId, "memento boundary job");
	const mementoThreadId = "postmem_scheduled_0001";
	writePersistentAgentThread(mementoRoomId, mementoThreadId, { state: "standby", origin: "memento", model, items: [] });
	const mementoResult = createScheduledPromptBackgroundRunPreflight({ roomId: mementoRoomId, scheduleJobId: mementoJob.id, now });
	assert(mementoResult.run.status === "blocked" && mementoResult.run.reason === "prepared_runtime_boundary", "empty Memento boundary should block scheduled preflight");
	assert(mementoResult.run.error?.code === "prepared_runtime_boundary", "Memento boundary should persist blocked error code");
	assert(getPersistentAgentThread(mementoRoomId, mementoThreadId) !== null, "Memento boundary must be retained");
	assert(getPersistentAgentRuntimeState(mementoRoomId).activeThreadId === mementoThreadId, "Memento boundary preflight must not mutate runtime");
	assertNoPromptLeak(mementoResult.run, secretPromptText, "memento run");

	const missingRoomId = createRoom("Scheduled Preflight Missing Schedule Room");
	const missingResult = createScheduledPromptBackgroundRunPreflight({ roomId: missingRoomId, scheduleJobId: "sched_ffffffffffffffffffffffffffffffff", now });
	assert(missingResult.job === null, "missing schedule result should expose null job");
	assert(missingResult.run.status === "blocked" && missingResult.run.reason === "schedule_missing", "missing schedule should create blocked run");
	assert(missingResult.run.target?.kind === "none" && missingResult.run.error?.code === "schedule_missing", "missing schedule should target none and persist error code");
	assertNoPromptLeak(missingResult.run, secretPromptText, "missing schedule run");

	const disabledRoomId = createRoom("Scheduled Preflight Disabled Schedule Room");
	const disabledJob = addSchedule(disabledRoomId, "disabled job", { enabled: false });
	const disabledResult = createScheduledPromptBackgroundRunPreflight({ roomId: disabledRoomId, scheduleJobId: disabledJob.id, now });
	assert(disabledResult.job?.id === disabledJob.id, "disabled schedule result should expose disabled job");
	assert(disabledResult.run.status === "blocked" && disabledResult.run.reason === "schedule_disabled", "disabled schedule should create blocked run");
	assert(disabledResult.run.error?.code === "schedule_disabled", "disabled schedule should persist error code");
	assertNoPromptLeak(disabledResult.run, secretPromptText, "disabled schedule run");

	const corruptRoomId = "scheduled-corrupt-room";
	fs.mkdirSync(path.dirname(persistentRoomScheduleStorePath(corruptRoomId)), { recursive: true, mode: 0o700 });
	fs.writeFileSync(persistentRoomScheduleStorePath(corruptRoomId), "{ not valid json\n", { mode: 0o600 });
	const corruptResult = createScheduledPromptBackgroundRunPreflight({ roomId: corruptRoomId, scheduleJobId: "sched_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", now });
	assert(corruptResult.job === null, "corrupt schedule result should expose null job");
	assert(corruptResult.run.status === "blocked" && corruptResult.run.reason === "schedule_store_unreadable", "corrupt schedule store should create blocked run");
	assert(corruptResult.run.target?.kind === "none" && corruptResult.run.error?.code === "schedule_store_unreadable", "corrupt schedule should target none and persist error code");
	assertNoPromptLeak(corruptResult.run, secretPromptText, "corrupt schedule run");

	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), "scheduled preflight smoke must not create/read runtime auth state");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), "scheduled preflight smoke must not create/read runtime model state");

	console.log("scheduled-prompt background-run preflight smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
