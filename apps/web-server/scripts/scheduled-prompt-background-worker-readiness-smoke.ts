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

function readTextIfExists(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function listFilesRecursive(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const files: string[] = [];
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name);
		const stat = fs.statSync(file);
		if (stat.isDirectory()) files.push(...listFilesRecursive(file));
		else files.push(file);
	}
	return files;
}

function runtimeThreadFiles(tempAgentsRoot: string, roomId: string): string[] {
	const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
	return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")).sort() : [];
}

function assertNoPromptLeak(value: unknown, promptText: string, label: string): void {
	assert(!JSON.stringify(value).includes(promptText), `${label}: worker/readiness data must not contain prompt text`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-scheduled-worker-readiness-"));
const tempHome = path.join(tmp, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
const authJsonPath = path.join(tempAgentRuntimeRoot, "auth.json");
const modelsJsonPath = path.join(tempAgentRuntimeRoot, "models.json");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentRuntimeRoot, { recursive: true, mode: 0o700 });

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
		backgroundRunsDirectoryPath,
		claimBackgroundRunLease,
		createBackgroundRun,
		findBackgroundRunByScheduledOccurrence,
		listBackgroundRuns,
		listClaimableScheduledPromptBackgroundRuns,
		readBackgroundRun,
		recoverExpiredBackgroundRunLeases,
		reviveTransientlyBlockedBackgroundRuns,
		updateClaimedBackgroundRunStatus,
	} = backgroundRuns;
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const { processScheduledPromptBackgroundRunReadinessOnce } = await import("../src/scheduled-prompt-background-worker.js");
	const { scanPersistentRoomScheduleDueRuns } = await import("../src/persistent-room-schedule-due-scan.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const scheduleModule = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		addPersistentRoomScheduleJob,
		removePersistentRoomScheduleJob,
		updatePersistentRoomScheduleJob,
	} = scheduleModule;
	const persistentAgents = await import("../src/persistent-agents.js");
	const {
		createPersistentAgentFromScaffoldInput,
		getPersistentAgentRuntimeState,
		getPersistentAgentThread,
		writePersistentAgentThread,
	} = persistentAgents;

	writePersistentAgentAiProfileState("openai-compatible");
	writeJson(modelsJsonPath, {
		providers: {
			"openai-compatible": {
				name: "Synthetic Gateway",
				baseUrl: "https://synthetic.invalid/v1",
				api: "openai-completions",
				models: [
					{ id: "gpt-5.5", name: "GPT 5.5" },
					{ id: "claude-opus-4.6", name: "Claude Opus 4.6" },
				],
			},
		},
	});
	writeJson(authJsonPath, { "openai-compatible": { type: "api_key", key: "synthetic-key" } });

	const promptText = "SYNTHETIC_WORKER_SECRET_PROMPT_DO_NOT_COPY";
	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const readyNow = new Date("2026-01-01T02:00:00.000Z");
	const workerId = "scheduler-readiness:smoke:worker";
	const createdRoomIds: string[] = [];
	const threadSnapshots = new Map<string, string>();

	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const roomId = String(created.agent.agentId);
		assert(roomId, `${displayName}: room id should be returned`);
		createdRoomIds.push(roomId);
		return roomId;
	}

	function addSchedule(roomId: string, name: string, options: { prompt?: string; enabled?: boolean; now?: Date } = {}) {
		return addPersistentRoomScheduleJob(roomId, {
			name,
			type: "once",
			schedule: "+30m",
			prompt: options.prompt ?? promptText,
			enabled: options.enabled,
			now: options.now ?? baseNow,
		});
	}

	function preflight(roomId: string, scheduleJobId: string, dueAt: string, now = baseNow) {
		const result = createScheduledPromptBackgroundRunPreflight({ roomId, scheduleJobId, dueAt, now });
		assertNoPromptLeak(result.run, promptText, `preflight ${roomId}`);
		return result.run;
	}

	function rememberThreads(roomId: string): void {
		threadSnapshots.set(roomId, runtimeThreadFiles(tempAgentsRoot, roomId).join(","));
	}

	function assertNoUnexpectedRuntimeSideEffects(label: string): void {
		for (const roomId of createdRoomIds) {
			const before = threadSnapshots.get(roomId) ?? "";
			const after = runtimeThreadFiles(tempAgentsRoot, roomId).join(",");
			assert(after === before, `${label}: worker must not create/remove runtime threads for ${roomId}; before=${before} after=${after}`);
			assert(getPersistentAgentRuntimeState(roomId).state !== "active", `${label}: worker must not start an active runtime turn for ${roomId}`);
		}
		const jsonlFiles = listFilesRecursive(tempHome).filter((file) => file.endsWith(".jsonl"));
		assert(jsonlFiles.length === 0, `${label}: worker must not create Pi JSONL sessions, found ${jsonlFiles.join(",")}`);
		const runs = listBackgroundRuns({ kind: "scheduled-prompt", limit: 1000 });
		for (const run of runs) {
			assertNoPromptLeak(run, promptText, `${label}: run ${run.runId}`);
			assert(run.artifacts?.inputRelPath === undefined, `${label}: run ${run.runId} must not write input artifacts`);
			assert(run.artifacts?.outputRelPath === undefined, `${label}: run ${run.runId} must not write output artifacts`);
			assert(run.artifacts?.eventRelPath === undefined, `${label}: run ${run.runId} must not write event artifacts`);
		}
		assert(!fs.existsSync(path.join(tempHome, ".exxeta")), `${label}: worker must not create legacy ~/.exxeta state`);
	}

	const primitiveRoom = createRoom("Worker Primitive Claim Room");
	const primitiveJob = addSchedule(primitiveRoom, "primitive job");
	const primitiveRun = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: primitiveRoom },
		source: { trigger: "schedule-due", schedulerJobId: primitiveJob.id, dueAt: "2026-01-01T00:30:00.000Z" },
		status: "queued",
		reason: "synthetic_queued",
		target: { kind: "none", roomId: primitiveRoom },
		now: baseNow,
	});
	const firstClaim = claimBackgroundRunLease({ runId: primitiveRun.runId, workerId: "worker-a", token: "token-a", now: baseNow, leaseMs: 60_000 });
	assert(firstClaim?.status === "running" && firstClaim.lease?.token === "token-a", "first claimant should claim queued run");
	const secondClaim = claimBackgroundRunLease({ runId: primitiveRun.runId, workerId: "worker-b", token: "token-b", now: baseNow, leaseMs: 60_000 });
	assert(secondClaim === null, "second claimant must not claim an actively leased run");
	expectThrow(() => updateClaimedBackgroundRunStatus({ runId: primitiveRun.runId, token: "wrong-token", status: "cancelled", reason: "wrong_token", now: baseNow }), "wrong token release");
	const cancelledPrimitive = updateClaimedBackgroundRunStatus({ runId: primitiveRun.runId, token: "token-a", status: "cancelled", reason: "primitive_done", now: baseNow });
	assert(cancelledPrimitive.status === "cancelled" && !cancelledPrimitive.lease, "correct token should finalize and clear lease");

	const expiredRoom = createRoom("Worker Expired Lease Room");
	const expiredJob = addSchedule(expiredRoom, "expired lease job");
	const expiredRun = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: expiredRoom },
		source: { trigger: "schedule-due", schedulerJobId: expiredJob.id, dueAt: "2026-01-01T00:40:00.000Z" },
		status: "deferred",
		reason: "synthetic_deferred",
		target: { kind: "none", roomId: expiredRoom },
		now: baseNow,
	});
	const expiredClaim = claimBackgroundRunLease({ runId: expiredRun.runId, workerId: "worker-expired", token: "expired-token", now: baseNow, leaseMs: 1 });
	assert(expiredClaim?.status === "running", "expired fixture should claim deferred run");
	const recovered = recoverExpiredBackgroundRunLeases({ kind: "scheduled-prompt", now: new Date("2026-01-01T00:00:00.002Z"), limit: 10 });
	assert(recovered.some((run: any) => run.runId === expiredRun.runId && run.status === "deferred" && run.reason === "lease_expired"), "expired lease should recover to deferred lease_expired");
	assert(listClaimableScheduledPromptBackgroundRuns({ now: readyNow, limit: 100 }).some((run: any) => run.runId === expiredRun.runId), "recovered expired run should become claimable later");
	const reclaimed = claimBackgroundRunLease({ runId: expiredRun.runId, workerId: "worker-reclaimed", token: "reclaimed-token", now: readyNow, leaseMs: 60_000 });
	assert(reclaimed?.status === "running", "recovered run should be claimable after lease recovery");
	updateClaimedBackgroundRunStatus({ runId: expiredRun.runId, token: "reclaimed-token", status: "cancelled", reason: "recovery_proven", now: readyNow });

	// Crash-leftover mutation locks: a SIGKILL between lock acquire and release leaves .mutation-lock
	// behind with the run still "running". Recovery must reclaim a stale lock, respect a fresh one,
	// and never let one locked run abort the whole pass (which would halt every room's schedules).
	const makeCrashedRun = (roomLabel: string, jobLabel: string, dueAt: string, token: string) => {
		const roomId = createRoom(roomLabel);
		const job = addSchedule(roomId, jobLabel);
		const run = createBackgroundRun({
			kind: "scheduled-prompt",
			scope: { kind: "persistent-room", roomId },
			source: { trigger: "schedule-due", schedulerJobId: job.id, dueAt },
			status: "queued",
			reason: "synthetic_queued",
			target: { kind: "none", roomId },
			now: baseNow,
		});
		claimBackgroundRunLease({ runId: run.runId, workerId: "worker-crashed", token, now: baseNow, leaseMs: 1 });
		const lockDir = path.join(backgroundRunsDirectoryPath(), run.runId, ".mutation-lock");
		fs.mkdirSync(lockDir, { mode: 0o700 });
		return { run, lockDir };
	};
	const staleLocked = makeCrashedRun("Worker Stale Lock Room", "stale lock job", "2026-01-01T00:50:00.000Z", "stale-lock-token");
	const freshLocked = makeCrashedRun("Worker Fresh Lock Room", "fresh lock job", "2026-01-01T00:55:00.000Z", "fresh-lock-token");
	const staleMtime = new Date(Date.now() - 60 * 60 * 1000);
	fs.utimesSync(staleLocked.lockDir, staleMtime, staleMtime);
	const lockRecovered = recoverExpiredBackgroundRunLeases({ kind: "scheduled-prompt", now: readyNow, limit: 10 });
	assert(lockRecovered.some((run: any) => run.runId === staleLocked.run.runId && run.status === "deferred" && run.reason === "lease_expired"), "stale crash-leftover mutation lock should be reclaimed and the run recovered");
	assert(!fs.existsSync(staleLocked.lockDir), "stale mutation lock dir should be removed after recovery");
	assert(!lockRecovered.some((run: any) => run.runId === freshLocked.run.runId), "fresh mutation lock must still be respected");
	assert(readBackgroundRun(freshLocked.run.runId).status === "running", "fresh-locked run should be untouched while its lock is held");
	fs.rmSync(freshLocked.lockDir, { recursive: true, force: true });
	const lockRecoveredAfterRelease = recoverExpiredBackgroundRunLeases({ kind: "scheduled-prompt", now: readyNow, limit: 10 });
	assert(lockRecoveredAfterRelease.some((run: any) => run.runId === freshLocked.run.runId && run.status === "deferred"), "run should recover once its fresh lock is released");
	for (const leftover of [staleLocked.run, freshLocked.run]) {
		claimBackgroundRunLease({ runId: leftover.runId, workerId: "worker-cleanup", token: "cleanup-token", now: readyNow, leaseMs: 60_000 });
		updateClaimedBackgroundRunStatus({ runId: leftover.runId, token: "cleanup-token", status: "cancelled", reason: "lock_fixture_done", now: readyNow });
	}

	const readyRoom = createRoom("Worker Ready Room");
	const readyJob = addSchedule(readyRoom, "ready job");
	rememberThreads(readyRoom);
	const readyRun = preflight(readyRoom, readyJob.id, String(readyJob.nextRunAt));
	const authBeforeReady = readTextIfExists(authJsonPath);
	const modelsBeforeReady = readTextIfExists(modelsJsonPath);
	const readySummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 10, leaseMs: 60_000 });
	assert(readySummary.processed.some((item) => item.runId === readyRun.runId && item.finalStatus === "queued" && item.reason === "ready_for_execution"), "idle fresh run should become queued ready_for_execution");
	const readyAfter = readBackgroundRun(readyRun.runId);
	assert(readyAfter.status === "queued" && readyAfter.reason === "ready_for_execution", "ready run should return to queued status");
	assert(readyAfter.readiness?.result === "ready" && readyAfter.readiness.reason === "ready_for_execution", "ready run should persist readiness metadata");
	assert(readyAfter.target?.kind === "fresh-thread" && readyAfter.target.model?.provider === "openai-compatible", "ready run should refresh target/model metadata");
	assert(!readyAfter.lease, "ready run should not keep a lease after readiness check");
	assert(readTextIfExists(authJsonPath) === authBeforeReady, "readiness worker must not mutate existing auth.json");
	assert(readTextIfExists(modelsJsonPath) === modelsBeforeReady, "readiness worker must not mutate existing models.json");
	assertNoPromptLeak(readySummary, promptText, "ready summary");

	const duplicateCountBefore = listBackgroundRuns({ kind: "scheduled-prompt", limit: 1000 }).length;
	const duplicateScan = scanPersistentRoomScheduleDueRuns({ roomId: readyRoom, now: readyNow });
	assert(duplicateScan.summary.created === 0 && duplicateScan.summary.duplicates === 1, "due scan should still suppress duplicate after readiness updates");
	assert(findBackgroundRunByScheduledOccurrence({ roomId: readyRoom, schedulerJobId: readyJob.id, dueAt: readyRun.source.dueAt })?.runId === readyRun.runId, "updated ready run should remain the occurrence record");
	assert(listBackgroundRuns({ kind: "scheduled-prompt", limit: 1000 }).length === duplicateCountBefore, "duplicate due scan must not create a second run after readiness updates");

	const lockedRoom = createRoom("Worker Locked Room");
	const lockedJob = addSchedule(lockedRoom, "locked job");
	rememberThreads(lockedRoom);
	const lockFile = path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockedRoom}.json`);
	writeJson(lockFile, { surface: "web", pid: process.pid, connectionId: "synthetic-lock", host: os.hostname(), label: "smoke", acquiredAt: Date.now(), lastSeen: Date.now() });
	const lockedRun = preflight(lockedRoom, lockedJob.id, "2026-01-01T01:10:00.000Z");
	assert(lockedRun.status === "deferred" && lockedRun.reason === "room_in_use", "locked fixture should preflight as deferred");
	const lockedSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 10, leaseMs: 60_000 });
	assert(lockedSummary.processed.some((item) => item.runId === lockedRun.runId && item.finalStatus === "deferred" && item.reason === "room_in_use"), "locked room should remain deferred while lock exists");
	assert(readBackgroundRun(lockedRun.runId).readiness?.result === "deferred", "locked run should persist deferred readiness");
	fs.rmSync(lockFile, { force: true });
	const unlockedSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: new Date("2026-01-01T02:01:00.000Z"), limit: 10, leaseMs: 60_000 });
	assert(unlockedSummary.processed.some((item) => item.runId === lockedRun.runId && item.finalStatus === "queued" && item.reason === "ready_for_execution"), "deferred room should become queued/ready after lock removal");

	const deletedRoom = createRoom("Worker Deleted Schedule Room");
	const deletedJob = addSchedule(deletedRoom, "deleted job");
	rememberThreads(deletedRoom);
	const deletedRun = preflight(deletedRoom, deletedJob.id, "2026-01-01T01:20:00.000Z");
	removePersistentRoomScheduleJob(deletedRoom, { jobId: deletedJob.id });
	const deletedSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 10, leaseMs: 60_000 });
	assert(deletedSummary.processed.some((item) => item.runId === deletedRun.runId && item.finalStatus === "cancelled" && item.reason === "schedule_missing"), "deleted schedule should cancel the occurrence");
	assert(readBackgroundRun(deletedRun.runId).readiness?.result === "cancelled", "deleted schedule cancellation should persist readiness metadata");

	const disabledRoom = createRoom("Worker Disabled Schedule Room");
	const disabledJob = addSchedule(disabledRoom, "disabled job");
	rememberThreads(disabledRoom);
	const disabledRun = preflight(disabledRoom, disabledJob.id, "2026-01-01T01:30:00.000Z");
	updatePersistentRoomScheduleJob(disabledRoom, { jobId: disabledJob.id }, { enabled: false, now: readyNow });
	const disabledSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 10, leaseMs: 60_000 });
	assert(disabledSummary.processed.some((item) => item.runId === disabledRun.runId && item.finalStatus === "cancelled" && item.reason === "schedule_disabled"), "disabled schedule should cancel the occurrence");
	assert(readBackgroundRun(disabledRun.runId).readiness?.result === "cancelled", "disabled schedule cancellation should persist readiness metadata");

	const checkpointRoom = createRoom("Worker Checkpoint Boundary Room");
	const checkpointJob = addSchedule(checkpointRoom, "checkpoint job");
	rememberThreads(checkpointRoom);
	const checkpointRun = preflight(checkpointRoom, checkpointJob.id, "2026-01-01T01:40:00.000Z");
	assert(checkpointRun.status === "queued", "checkpoint fixture should start from a queued stale preflight run");
	const checkpointThreadId = "worker_checkpoint_0001";
	writePersistentAgentThread(checkpointRoom, checkpointThreadId, { state: "standby", origin: "checkpoint", model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" }, items: [] });
	threadSnapshots.set(checkpointRoom, runtimeThreadFiles(tempAgentsRoot, checkpointRoom).join(","));
	const checkpointSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 10, leaseMs: 60_000 });
	assert(checkpointSummary.processed.some((item) => item.runId === checkpointRun.runId && item.finalStatus === "blocked" && item.reason === "prepared_runtime_boundary"), "prepared checkpoint boundary should block stale queued run");
	assert(getPersistentAgentThread(checkpointRoom, checkpointThreadId) !== null, "prepared checkpoint boundary must not be retired by readiness worker");
	assert(getPersistentAgentRuntimeState(checkpointRoom).activeThreadId === checkpointThreadId, "prepared checkpoint boundary must remain active runtime boundary");

	fs.rmSync(authJsonPath, { force: true });
	const noAuthRoom = createRoom("Worker Missing Auth Room");
	const noAuthJob = addSchedule(noAuthRoom, "missing auth job");
	rememberThreads(noAuthRoom);
	const noAuthRun = preflight(noAuthRoom, noAuthJob.id, "2026-01-01T00:10:00.000Z");
	const noAuthSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: readyNow, limit: 1, leaseMs: 60_000 });
	assert(noAuthSummary.processed.some((item) => item.runId === noAuthRun.runId && item.finalStatus === "blocked" && item.reason === "provider_not_connected"), "missing provider auth should block without execution");
	assert(!fs.existsSync(authJsonPath), "read-only auth readiness must not recreate missing auth.json");
	assert(readTextIfExists(modelsJsonPath) === modelsBeforeReady, "missing-auth readiness must not mutate models.json");

	// Transiently blocked runs must not be terminal: once the blocking condition clears, the revive
	// pass returns them to deferred so the normal readiness re-check can queue them. Permanent and
	// needs-a-human blocks stay put, and revival respects the backoff window.
	const revivedTooSoon = reviveTransientlyBlockedBackgroundRuns({ kind: "scheduled-prompt", now: readyNow, limit: 100 });
	assert(!revivedTooSoon.some((run: any) => run.runId === noAuthRun.runId), "revive must respect the backoff window right after the block");
	const reviveNow = new Date("2026-01-01T02:05:00.000Z");
	const revived = reviveTransientlyBlockedBackgroundRuns({ kind: "scheduled-prompt", now: reviveNow, limit: 100 });
	assert(revived.some((run: any) => run.runId === noAuthRun.runId && run.status === "deferred" && run.reason === "transient_block_revived"), "provider_not_connected block should revive to deferred after backoff");
	assert(!revived.some((run: any) => run.runId === checkpointRun.runId), "prepared_runtime_boundary block must not be revived");
	assert(readBackgroundRun(checkpointRun.runId).status === "blocked", "prepared boundary run should stay blocked");
	fs.writeFileSync(authJsonPath, authBeforeReady ?? "{}");
	const revivedSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: reviveNow, limit: 10, leaseMs: 60_000 });
	assert(revivedSummary.processed.some((item) => item.runId === noAuthRun.runId && item.finalStatus === "queued" && item.reason === "ready_for_execution"), "revived run should queue once the provider is connected again");

	// A room's own pick that cannot run is never run and nothing runs in its
	// place. On no list any more: refused at preflight with the sentence. On
	// the gateway's list but unknown to the registry: named at preflight and
	// blocked by readiness as model_not_found.
	const { writeRoomModels } = await import("../src/room-models.js");
	fs.writeFileSync(path.join(smokeAppDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }, { modelId: "claude-opus-4.6" }, { modelId: "listed-only" }], maintenanceModel: "claude-opus-4.6" }, null, 2));
	const delistedRoom = createRoom("Worker Delisted Pick Room");
	writeRoomModels(delistedRoom, { conversation: { provider: "openai-compatible", model: "retired-model" } });
	const delistedRun = preflight(delistedRoom, addSchedule(delistedRoom, "delisted pick job").id, "2026-01-01T00:20:00.000Z", reviveNow);
	assert(delistedRun.status === "blocked" && delistedRun.reason === "model_policy_unavailable" && /^This room's model, retired-model on .+, is no longer offered\./.test(String(delistedRun.message)), `a pick on no list is refused at preflight with the sentence, got ${JSON.stringify({ status: delistedRun.status, reason: delistedRun.reason, message: delistedRun.message })}`);
	const unknownRoom = createRoom("Worker Unknown Listed Pick Room");
	writeRoomModels(unknownRoom, { conversation: { provider: "openai-compatible", model: "listed-only" } });
	const unknownRun = preflight(unknownRoom, addSchedule(unknownRoom, "unknown listed pick job").id, "2026-01-01T00:25:00.000Z", reviveNow);
	assert(unknownRun.status === "queued" && (unknownRun.target as any)?.model?.model === "listed-only", `a listed pick the registry does not know is named at preflight, got ${JSON.stringify({ status: unknownRun.status, target: unknownRun.target })}`);
	const unknownSummary = processScheduledPromptBackgroundRunReadinessOnce({ workerId, now: reviveNow, limit: 10, leaseMs: 60_000 });
	assert(unknownSummary.processed.some((item) => item.runId === unknownRun.runId && item.finalStatus === "blocked" && item.reason === "model_not_found"), `and readiness blocks it as model_not_found, never running it, got ${JSON.stringify(unknownSummary.processed)}`);

	assertNoUnexpectedRuntimeSideEffects("final");

	console.log("scheduled-prompt background worker/readiness smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
