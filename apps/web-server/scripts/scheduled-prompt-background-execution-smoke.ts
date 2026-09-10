import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
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

function readText(file: string): string {
	return fs.readFileSync(file, "utf-8");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const require = createRequire(import.meta.url);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-scheduled-execution-"));
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
process.env.EXXETA_HOME = repoRoot;

const roomLock = require(path.join(repoRoot, "bin", "lib", "room-lock.cjs")) as {
	tryAcquire: (agentId: string, owner: Record<string, unknown>) => { ok: boolean; heldBy?: { surface?: string } };
	release: (agentId: string, owner: Record<string, unknown>) => void;
};

try {
	const backgroundRuns = await import("../src/background-runs.js");
	const {
		listBackgroundRuns,
		readBackgroundRun,
		updateBackgroundRunStatus,
	} = backgroundRuns;
	const { buildPersistentRoomBackgroundRunsResponse } = await import("../src/persistent-room-background-run-history.js");
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const {
		processScheduledPromptBackgroundRunExecutionOnce,
	} = await import("../src/scheduled-prompt-background-execution.js");
	const artifacts = await import("../src/scheduled-prompt-background-artifacts.js");
	const {
		inspectScheduledPromptBackgroundRunIdempotency,
		scheduledPromptBackgroundRunArtifactPaths,
		scheduledPromptBackgroundRunHasInputArtifact,
		scheduledPromptBackgroundRunHasOutputArtifact,
	} = artifacts;
	const executionAdapter = await import("../src/persistent-room-background-execution.js");
	const {
		persistentRoomBackgroundSessionToolNames,
		scheduledPromptBackgroundAssistantItemId,
		scheduledPromptBackgroundThreadId,
		scheduledPromptBackgroundUserItemId,
	} = executionAdapter;
	const { getPersistentRoomToolPolicy } = await import("../src/persistent-room-tool-policy.js");
	const backgroundAllowlist = persistentRoomBackgroundSessionToolNames(getPersistentRoomToolPolicy("bg-allowlist-smoke", { workspaceToolsEnabled: true, workspaceToolNames: ["read", "ls", "find", "grep", "write", "edit"] }).allowedToolNames);
	assert(!backgroundAllowlist.includes("read_file") && !backgroundAllowlist.includes("search_file"), "background allowlist must not carry shelf tool names that are never registered there");
	assert(backgroundAllowlist.includes("mcp"), "background allowlist keeps the mcp proxy, which the room-scoped extension registers");
	assert(backgroundAllowlist.includes("web_search") && backgroundAllowlist.includes("fetch_url") && backgroundAllowlist.includes("read"), "background allowlist keeps web research and workspace tools");
	const { appendUsage, loadUsage } = await import("../src/usage-log.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const scheduleModule = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		addPersistentRoomScheduleJob,
		removePersistentRoomScheduleJob,
		updatePersistentRoomScheduleJob,
	} = scheduleModule;
	const persistentAgents = await import("../src/persistent-agents.js");
	const {
		beginPersistentAgentTurn,
		createPersistentAgentFromScaffoldInput,
		createPersistentAgentPiSessionJsonlThreadRuntime,
		finishPersistentAgentTurn,
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

	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const dueNow = new Date("2026-01-01T01:00:00.000Z");
	const promptText = "SCHEDULED_EXECUTION_SECRET_PROMPT_DO_NOT_LEAK";
	const modelA = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT 5.5" };
	const fakeCalls = new Map<string, number>();
	const slowHeartbeatChecked = new Set<string>();
	const foregroundBlockedChecked = new Set<string>();
	const failRuns = new Set<string>();
	const slowRuns = new Set<string>();

	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const roomId = String(created.agent.agentId);
		assert(roomId, `${displayName}: room id should be returned`);
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

	function preflight(roomId: string, scheduleJobId: string, dueAt: string) {
		return createScheduledPromptBackgroundRunPreflight({ roomId, scheduleJobId, dueAt, now: baseNow }).run;
	}

	function artifactFile(relPath: string): string {
		return path.join(tempHome, ".exxperts", "app", "background-runs", relPath);
	}

	function assertRunNoPromptLeak(run: unknown, label: string): void {
		assert(!JSON.stringify(run).includes(promptText), `${label}: public run data must not include prompt text`);
	}

	function cancelRun(runId: string): void {
		updateBackgroundRunStatus(runId, "cancelled", { reason: "smoke_done", now: new Date() });
	}

	const fakeExecute = async (input: any) => {
		const runId = String(input.executionId);
		fakeCalls.set(runId, (fakeCalls.get(runId) ?? 0) + 1);
		const webOwner = { surface: "web", connectionId: `smoke-web-${runId}`, pid: process.pid, label: "smoke foreground" };
		const foregroundAcquire = roomLock.tryAcquire(input.roomId, webOwner);
		assert(!foregroundAcquire.ok && foregroundAcquire.heldBy?.surface === "scheduler", `${runId}: scheduler lock should block simulated foreground entry`);
		foregroundBlockedChecked.add(runId);

		if (slowRuns.has(runId)) {
			await sleep(80);
			const running = readBackgroundRun(runId);
			assert(running.lease?.heartbeatAt, `${runId}: slow fake execution should observe lease heartbeat`);
			slowHeartbeatChecked.add(runId);
		}
		if (failRuns.has(runId)) throw new Error("synthetic fake execution failure");

		const model = input.target.model;
		assert(model?.provider && model?.model, `${runId}: fake execution requires target model`);
		let threadId: string;
		let targetKind: "fresh-thread" | "resume-thread";
		if (input.target.kind === "fresh-thread") {
			threadId = scheduledPromptBackgroundThreadId(runId);
			targetKind = "fresh-thread";
			const existing = getPersistentAgentThread(input.roomId, threadId);
			if (!existing) {
				writePersistentAgentThread(input.roomId, threadId, { state: "standby", origin: "home", model, items: [] }, {
					createRuntime: ({ instance, threadId: createdThreadId, model: createdModel }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({
						agentId: instance.agentId,
						threadId: createdThreadId,
						model: createdModel,
						cwd: repoRoot,
					}),
				});
			}
		} else {
			threadId = String(input.target.threadId ?? "");
			targetKind = "resume-thread";
			const thread = getPersistentAgentThread(input.roomId, threadId);
			assert(thread, `${runId}: resume fake execution should find existing thread`);
			assert(thread.model.provider === model.provider && thread.model.model === model.model, `${runId}: resume fake execution must preserve model lock`);
		}

		let activeTurnId: string | undefined;
		try {
			const current = getPersistentAgentThread(input.roomId, threadId)!;
			writePersistentAgentThread(input.roomId, threadId, {
				state: current.state === "active" ? "active" : "standby",
				origin: current.origin,
				model: current.model,
				items: [...current.items, { kind: "user", id: scheduledPromptBackgroundUserItemId(runId), text: input.prompt }],
			});
			const turn = beginPersistentAgentTurn(input.roomId, threadId, { turnId: `fake_${runId}`, connectionId: `fake:${runId}` });
			activeTurnId = turn.turnId;
			const beforeAssistant = getPersistentAgentThread(input.roomId, threadId)!;
			const assistantText = `synthetic assistant output for ${runId}`;
			const write = writePersistentAgentThread(input.roomId, threadId, {
				state: "standby",
				origin: beforeAssistant.origin,
				model: beforeAssistant.model,
				items: [...beforeAssistant.items, { kind: "assistant", id: scheduledPromptBackgroundAssistantItemId(runId), text: assistantText, streaming: false }],
			});
			return {
				roomId: input.roomId,
				threadId,
				targetKind,
				model,
				assistantText,
				usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
				items: { userItemId: scheduledPromptBackgroundUserItemId(runId), assistantItemId: scheduledPromptBackgroundAssistantItemId(runId) },
				thread: write.thread,
			};
		} finally {
			if (activeTurnId) finishPersistentAgentTurn(input.roomId, threadId, { turnId: activeTurnId, terminalReason: "completed" });
		}
	};

	async function processOne(label: string, options: Record<string, unknown> = {}) {
		const summary = await processScheduledPromptBackgroundRunExecutionOnce({
			workerId: `scheduler-execution:smoke:${label}`,
			now: dueNow,
			limit: 1,
			leaseMs: 1_000,
			heartbeatMs: 10,
			executePrompt: fakeExecute as any,
			...options,
		});
		assertRunNoPromptLeak(summary, `${label} summary`);
		return summary;
	}

	const freshRoom = createRoom("Execution Fresh Room");
	const freshJob = addSchedule(freshRoom, "fresh job");
	const freshRun = preflight(freshRoom, freshJob.id, String(freshJob.nextRunAt));
	const freshSummary = await processOne("fresh");
	assert(freshSummary.processed.some((item: any) => item.runId === freshRun.runId && item.finalStatus === "succeeded"), "fresh run should succeed");
	assert(fakeCalls.get(freshRun.runId) === 1, "fresh run should execute exactly once");
	const freshAfter = readBackgroundRun(freshRun.runId);
	assert(freshAfter.status === "succeeded" && freshAfter.reason === "completed", "fresh run record should be succeeded/completed");
	assert(freshAfter.target?.kind === "fresh-thread" && freshAfter.target.threadId === scheduledPromptBackgroundThreadId(freshRun.runId), "fresh run should persist deterministic thread id");
	assert(scheduledPromptBackgroundRunHasInputArtifact(freshAfter), "fresh run should write input artifact");
	assert(scheduledPromptBackgroundRunHasOutputArtifact(freshAfter), "fresh run should write output artifact");
	assert(readText(artifactFile(freshAfter.artifacts!.inputRelPath!)).includes(promptText), "private input artifact should contain prompt text");
	assert(readText(artifactFile(freshAfter.artifacts!.outputRelPath!)).includes("synthetic assistant output"), "private output artifact should contain assistant text");
	const freshThread = getPersistentAgentThread(freshRoom, freshAfter.target!.threadId!)!;
	assert(freshThread.runtime.kind === "pi-session-jsonl", "fresh fake execution should create Pi JSONL runtime thread");
	assert(freshThread.model.provider === "openai-compatible" && freshThread.model.model === "gpt-5.5", "fresh fake execution should use scheduledRoom model");
	assert(freshThread.items.filter((item: any) => item.id === scheduledPromptBackgroundUserItemId(freshRun.runId)).length === 1, "fresh thread should contain one deterministic scheduled user item");
	assert(freshThread.items.filter((item: any) => item.id === scheduledPromptBackgroundAssistantItemId(freshRun.runId)).length === 1, "fresh thread should contain one deterministic scheduled assistant item");
	assert(getPersistentAgentRuntimeState(freshRoom).state === "standby", "fresh room should end in standby");
	assert(foregroundBlockedChecked.has(freshRun.runId), "fresh fake execution should verify scheduler lock blocks foreground");

	const history = buildPersistentRoomBackgroundRunsResponse(freshRoom, listBackgroundRuns({ scope: { kind: "persistent-room", roomId: freshRoom }, limit: 10 }), { limit: 10 });
	const historyText = JSON.stringify(history);
	assert(!historyText.includes(promptText), "public history projection must not include prompt text");
	assert(!historyText.includes("synthetic assistant output"), "public history projection must not include output text");
	assert(!historyText.includes("inputRelPath") && !historyText.includes("outputRelPath"), "public history projection must not expose artifact path fields");
	assert(history.runs[0]?.artifacts?.hasInput === true && history.runs[0]?.artifacts?.hasOutput === true, "public history should expose artifact booleans only");

	const repeatSummary = await processOne("repeat-empty");
	assert(repeatSummary.counts.processed === 0, "succeeded fresh run should not be reprocessed by repeated tick");

	updateBackgroundRunStatus(freshRun.runId, "deferred", { reason: "lease_expired", artifacts: freshAfter.artifacts, target: freshAfter.target, now: new Date("2026-01-01T01:01:00.000Z") });
	const beforeIdempotentCalls = fakeCalls.get(freshRun.runId) ?? 0;
	const idempotentSummary = await processOne("idempotent-recovery", { now: new Date("2026-01-01T01:02:00.000Z") });
	assert(idempotentSummary.processed.some((item: any) => item.runId === freshRun.runId && item.finalStatus === "succeeded" && item.reason === "already_completed"), "idempotency evidence should mark recovered run succeeded without execution");
	assert(fakeCalls.get(freshRun.runId) === beforeIdempotentCalls, "idempotency evidence must avoid duplicate fake execution");
	assert(inspectScheduledPromptBackgroundRunIdempotency({ run: readBackgroundRun(freshRun.runId) }).alreadyCompleted, "idempotency helper should report completed evidence");
	const freshUsageRows = loadUsage().filter((row: any) => row.runId === freshRun.runId);
	assert(freshUsageRows.length === 1 && freshUsageRows[0].kind === "scheduled", "fresh run should bill exactly one scheduled usage row across recovery");

	// Double-billing crash window: a previous attempt that crashed after billing but before the
	// output artifact used to re-execute AND re-bill. The runId-keyed append must skip the
	// duplicate row even when the run genuinely executes again.
	const billedRoom = createRoom("Execution Billed Crash Room");
	const billedJob = addSchedule(billedRoom, "billed crash job");
	const billedRun = preflight(billedRoom, billedJob.id, String(billedJob.nextRunAt));
	appendUsage({ ts: Date.now(), agent: billedRoom, persona: "business", kind: "scheduled", input: 3, output: 2, cacheRead: 0, cacheWrite: 0, cost: 0.005, runId: billedRun.runId });
	const billedSummary = await processOne("billed-crash");
	assert(billedSummary.processed.some((item: any) => item.runId === billedRun.runId && item.finalStatus === "succeeded" && item.reason === "completed"), "billed-crash run should still execute to completion");
	assert(loadUsage().filter((row: any) => row.runId === billedRun.runId).length === 1, "re-executed run must not bill the same occurrence twice");

	const resumeRoom = createRoom("Execution Resume Room");
	const resumeThreadId = "exec_resume_0001";
	writePersistentAgentThread(resumeRoom, resumeThreadId, { state: "standby", origin: "home", model: modelA, items: [{ kind: "user", id: "prior-user", text: "prior message" }] }, {
		createRuntime: ({ instance, threadId, model }: any) => createPersistentAgentPiSessionJsonlThreadRuntime({ agentId: instance.agentId, threadId, model, cwd: repoRoot }),
	});
	const resumeJob = addSchedule(resumeRoom, "resume job");
	const resumeRun = preflight(resumeRoom, resumeJob.id, String(resumeJob.nextRunAt));
	const resumeSummary = await processOne("resume");
	assert(resumeSummary.processed.some((item: any) => item.runId === resumeRun.runId && item.finalStatus === "succeeded"), "resume run should succeed");
	const resumeThread = getPersistentAgentThread(resumeRoom, resumeThreadId)!;
	assert(resumeThread.model.provider === modelA.provider && resumeThread.model.model === modelA.model, "resume run should keep immutable model lock");
	assert(resumeThread.items.some((item: any) => item.id === scheduledPromptBackgroundAssistantItemId(resumeRun.runId)), "resume thread should contain deterministic assistant item");

	const lockedRoom = createRoom("Execution Locked Room");
	const lockedJob = addSchedule(lockedRoom, "locked job");
	const lockFile = path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockedRoom}.json`);
	writeJson(lockFile, { surface: "web", pid: process.pid, connectionId: "synthetic-lock", host: os.hostname(), label: "smoke", acquiredAt: Date.now(), lastSeen: Date.now() });
	const lockedRun = preflight(lockedRoom, lockedJob.id, String(lockedJob.nextRunAt));
	const lockedSummary = await processOne("locked");
	assert(lockedSummary.processed.some((item: any) => item.runId === lockedRun.runId && item.finalStatus === "deferred" && item.reason === "room_in_use"), "active room lock should defer execution");
	assert(!scheduledPromptBackgroundRunHasInputArtifact(readBackgroundRun(lockedRun.runId)), "locked run must not snapshot input before lock/readiness");
	fs.rmSync(lockFile, { force: true });
	cancelRun(lockedRun.runId);

	const activeTurnRoom = createRoom("Execution Active Turn Room");
	const activeThreadId = "exec_active_0001";
	writePersistentAgentThread(activeTurnRoom, activeThreadId, { state: "standby", origin: "home", model: modelA, items: [{ kind: "user", id: "prior", text: "prior" }] });
	const activeTurn = beginPersistentAgentTurn(activeTurnRoom, activeThreadId, { turnId: "smoke_active_turn", connectionId: "smoke" });
	const activeJob = addSchedule(activeTurnRoom, "active job");
	const activeRun = preflight(activeTurnRoom, activeJob.id, String(activeJob.nextRunAt));
	const activeSummary = await processOne("active-turn");
	assert(activeSummary.processed.some((item: any) => item.runId === activeRun.runId && item.finalStatus === "deferred" && item.reason === "active_turn_in_flight"), "active foreground turn should defer execution");
	finishPersistentAgentTurn(activeTurnRoom, activeThreadId, { turnId: activeTurn.turnId, terminalReason: "completed" });
	cancelRun(activeRun.runId);

	const checkpointRoom = createRoom("Execution Checkpoint Room");
	const checkpointJob = addSchedule(checkpointRoom, "checkpoint job");
	const checkpointRun = preflight(checkpointRoom, checkpointJob.id, String(checkpointJob.nextRunAt));
	const checkpointThreadId = "exec_checkpoint_0001";
	writePersistentAgentThread(checkpointRoom, checkpointThreadId, { state: "standby", origin: "checkpoint", model: modelA, items: [] });
	const checkpointSummary = await processOne("checkpoint");
	assert(checkpointSummary.processed.some((item: any) => item.runId === checkpointRun.runId && item.finalStatus === "blocked" && item.reason === "prepared_runtime_boundary"), "empty checkpoint boundary should block execution");
	assert(getPersistentAgentThread(checkpointRoom, checkpointThreadId), "checkpoint boundary must not be retired");
	assert(!scheduledPromptBackgroundRunHasInputArtifact(readBackgroundRun(checkpointRun.runId)), "blocked checkpoint run must not snapshot input");

	const missingRoom = createRoom("Execution Missing Schedule Room");
	const missingJob = addSchedule(missingRoom, "missing job");
	const missingRun = preflight(missingRoom, missingJob.id, String(missingJob.nextRunAt));
	removePersistentRoomScheduleJob(missingRoom, { jobId: missingJob.id });
	const missingSummary = await processOne("missing-schedule");
	assert(missingSummary.processed.some((item: any) => item.runId === missingRun.runId && item.finalStatus === "cancelled" && item.reason === "schedule_missing"), "missing schedule should cancel before snapshot");
	assert(!scheduledPromptBackgroundRunHasInputArtifact(readBackgroundRun(missingRun.runId)), "missing schedule must not snapshot input");

	const disabledRoom = createRoom("Execution Disabled Schedule Room");
	const disabledJob = addSchedule(disabledRoom, "disabled job");
	const disabledRun = preflight(disabledRoom, disabledJob.id, String(disabledJob.nextRunAt));
	updatePersistentRoomScheduleJob(disabledRoom, { jobId: disabledJob.id }, { enabled: false, now: dueNow });
	const disabledSummary = await processOne("disabled-schedule");
	assert(disabledSummary.processed.some((item: any) => item.runId === disabledRun.runId && item.finalStatus === "cancelled" && item.reason === "schedule_disabled"), "disabled schedule should cancel before snapshot");
	assert(!scheduledPromptBackgroundRunHasInputArtifact(readBackgroundRun(disabledRun.runId)), "disabled schedule must not snapshot input");

	const failRoom = createRoom("Execution Failure Room");
	const failJob = addSchedule(failRoom, "failure job");
	const failRun = preflight(failRoom, failJob.id, String(failJob.nextRunAt));
	failRuns.add(failRun.runId);
	const failSummary = await processOne("fake-failure");
	assert(failSummary.processed.some((item: any) => item.runId === failRun.runId && item.finalStatus === "failed"), "fake execution error should mark run failed");
	const failAfter = readBackgroundRun(failRun.runId);
	assert(!failAfter.lease, "failed run should release lease");
	const failWebAcquire = roomLock.tryAcquire(failRoom, { surface: "web", connectionId: "after-failure", pid: process.pid, label: "after failure" });
	assert(failWebAcquire.ok, "failed run should release scheduler room lock");
	roomLock.release(failRoom, { surface: "web", connectionId: "after-failure", pid: process.pid, label: "after failure" });
	assert(scheduledPromptBackgroundRunHasInputArtifact(failAfter), "failed after execution start should keep private input snapshot");
	assert(!scheduledPromptBackgroundRunHasOutputArtifact(failAfter), "failed run should not write output artifact");

	const slowRoom = createRoom("Execution Slow Heartbeat Room");
	const slowJob = addSchedule(slowRoom, "slow job");
	const slowRun = preflight(slowRoom, slowJob.id, String(slowJob.nextRunAt));
	slowRuns.add(slowRun.runId);
	const slowSummary = await processOne("slow-heartbeat");
	assert(slowSummary.processed.some((item: any) => item.runId === slowRun.runId && item.finalStatus === "succeeded"), "slow fake execution should succeed");
	assert(slowHeartbeatChecked.has(slowRun.runId), "slow fake execution should verify heartbeat extension");

	const allRuns = listBackgroundRuns({ kind: "scheduled-prompt", limit: 1000 });
	for (const run of allRuns) assertRunNoPromptLeak(run, `stored run ${run.runId}`);
	assert(listFilesRecursive(tempHome).some((file) => file.endsWith(".jsonl")), "smoke should create Pi JSONL runtime session files for executed runs");
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "scheduled execution smoke must not create legacy ~/.exxeta state");

	console.log("scheduled-prompt background execution smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
