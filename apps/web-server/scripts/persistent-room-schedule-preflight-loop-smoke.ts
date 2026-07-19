import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
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

function readIfExists(file: string): string | null {
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

function countBackgroundRunFiles(tempHome: string): number {
	return listFilesRecursive(path.join(tempHome, ".exxperts", "app", "background-runs", "runs")).filter((file) => path.basename(file) === "run.json").length;
}

function assertNoPromptLeak(value: unknown, promptText: string, label: string): void {
	assert(!JSON.stringify(value).includes(promptText), `${label}: preflight loop data must not contain prompt text`);
}

function assertRunNoPromptLeak(run: { message?: string; artifacts?: { inputRelPath?: string; outputRelPath?: string; eventRelPath?: string } }, promptText: string, label: string): void {
	assert(!String(run.message ?? "").includes(promptText), `${label}: run message must not contain prompt text`);
	assert(run.artifacts?.inputRelPath === undefined, `${label}: preflight loop must not write input prompt artifacts`);
	assert(run.artifacts?.outputRelPath === undefined, `${label}: preflight loop must not write output prompt artifacts`);
}

function assertNoUnexpectedRuntimeSideEffects(tempHome: string, tempAgentsRoot: string, tempAgentRuntimeRoot: string, roomIds: string[], threadSnapshots: Map<string, string>, label: string): void {
	for (const roomId of roomIds) {
		const before = threadSnapshots.get(roomId) ?? "";
		const after = runtimeThreadFiles(tempAgentsRoot, roomId).join(",");
		assert(after === before, `${label}: preflight loop must not create/remove runtime threads for ${roomId}; before=${before} after=${after}`);
	}
	const jsonlFiles = listFilesRecursive(tempHome).filter((file) => file.endsWith(".jsonl"));
	assert(jsonlFiles.length === 0, `${label}: preflight loop must not create Pi JSONL sessions, found ${jsonlFiles.join(",")}`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), `${label}: preflight loop must not create/read runtime auth state`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), `${label}: preflight loop must not create/read runtime model state`);
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), `${label}: preflight loop must not create legacy ~/.exxeta state`);
}

async function waitForServer(server: ChildProcessWithoutNullStreams, baseUrl: string): Promise<void> {
	const deadline = Date.now() + 15_000;
	let lastError = "server did not respond";
	while (Date.now() < deadline) {
		if (server.exitCode != null) throw new Error(`server exited before startup with code ${server.exitCode}`);
		try {
			const response = await fetch(`${baseUrl}/healthz`);
			if (response.ok) return;
			lastError = `healthz returned ${response.status}`;
		} catch (error) {
			lastError = (error as Error).message;
		}
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`server did not become ready: ${lastError}`);
}

async function requestJson(baseUrl: string, pathname: string): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`);
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
}

async function waitForHistoryRun(baseUrl: string, roomId: string): Promise<any> {
	const deadline = Date.now() + 10_000;
	let lastBody: any = null;
	while (Date.now() < deadline) {
		const history = await requestJson(baseUrl, `/api/persistent-agents/${encodeURIComponent(roomId)}/background-runs`);
		assert(history.status === 200, `startup loop history should return 200, got ${history.status}: ${history.text}`);
		lastBody = history.body;
		if (Array.isArray(history.body?.runs) && history.body.runs.length > 0) return history.body.runs[0];
		await new Promise((resolve) => setTimeout(resolve, 200));
	}
	throw new Error(`startup loop did not create observable history run: ${JSON.stringify(lastBody)}`);
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-preflight-loop-"));
const tempHome = path.join(tempRoot, "home");
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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10_000);
const baseUrl = `http://127.0.0.1:${port}`;

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
	const { listBackgroundRuns, readBackgroundRun } = await import("../src/background-runs.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const {
		resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv,
		runPersistentRoomSchedulePreflightScanOnce,
		startPersistentRoomSchedulePreflightLoop,
	} = await import("../src/persistent-room-schedule-preflight-loop.js");
	const {
		addPersistentRoomScheduleJob,
		persistentRoomScheduleStorePath,
		readPersistentRoomScheduleStore,
	} = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		beginPersistentAgentTurn,
		createPersistentAgentFromScaffoldInput,
		finishPersistentAgentTurn,
		getPersistentAgentRuntimeState,
		writePersistentAgentThread,
	} = await import("../src/persistent-agents.js");

	writePersistentAgentAiProfileState("openai-compatible");

	const promptText = "SYNTHETIC_PREFLIGHT_LOOP_SECRET_PROMPT_DO_NOT_COPY";
	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const scanNow = new Date("2026-01-01T01:00:00.000Z");
	const createdRoomIds: string[] = [];
	const threadSnapshots = new Map<string, string>();
	const storeSnapshots = new Map<string, string | null>();

	function createRoom(displayName: string): string {
		const created = createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
		const roomId = String(created.agent.agentId);
		assert(roomId, `${displayName}: room id should be returned`);
		createdRoomIds.push(roomId);
		return roomId;
	}

	function addSchedule(roomId: string, name: string, options: { type?: "once" | "interval" | "cron"; schedule?: string; enabled?: boolean; now?: Date; prompt?: string } = {}) {
		return addPersistentRoomScheduleJob(roomId, {
			name,
			type: options.type ?? "once",
			schedule: options.schedule ?? "+30m",
			prompt: options.prompt ?? promptText,
			enabled: options.enabled,
			now: options.now ?? baseNow,
		});
	}

	function rememberRoomState(roomId: string): void {
		threadSnapshots.set(roomId, runtimeThreadFiles(tempAgentsRoot, roomId).join(","));
		storeSnapshots.set(roomId, readIfExists(persistentRoomScheduleStorePath(roomId)));
	}

	function assertStoresUnchanged(label: string): void {
		for (const [roomId, before] of storeSnapshots) {
			const after = readIfExists(persistentRoomScheduleStorePath(roomId));
			assert(after === before, `${label}: preflight loop must not mutate schedule store for ${roomId}`);
		}
	}

	const dueRoom = createRoom("Preflight Loop Due Room");
	const dueJob = addSchedule(dueRoom, "due once");
	rememberRoomState(dueRoom);

	const futureRoom = createRoom("Preflight Loop Future Room");
	addSchedule(futureRoom, "future once", { schedule: "+2h", now: new Date("2099-01-01T00:00:00.000Z") });
	rememberRoomState(futureRoom);

	const unsupportedCronRoom = createRoom("Preflight Loop Unsupported Cron Room");
	addSchedule(unsupportedCronRoom, "unsupported cron", { type: "cron", schedule: "0 */15 * * * *" });
	rememberRoomState(unsupportedCronRoom);

	const lockedRoom = createRoom("Preflight Loop Locked Room");
	addSchedule(lockedRoom, "locked due");
	writeJson(path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockedRoom}.json`), {
		surface: "web",
		pid: process.pid,
		connectionId: "synthetic-preflight-loop-lock",
		host: os.hostname(),
		label: "smoke",
		acquiredAt: Date.now(),
		lastSeen: Date.now(),
	});
	rememberRoomState(lockedRoom);

	const blockedRoom = createRoom("Preflight Loop Boundary Room");
	addSchedule(blockedRoom, "boundary due");
	writePersistentAgentThread(blockedRoom, "preflight_loop_boundary_0001", {
		state: "standby",
		origin: "checkpoint",
		model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" },
		items: [],
	});
	rememberRoomState(blockedRoom);

	const activeTurnRoom = createRoom("Preflight Loop Active Turn Room");
	addSchedule(activeTurnRoom, "active turn due");
	writePersistentAgentThread(activeTurnRoom, "preflight_loop_active_turn_0001", {
		state: "standby",
		origin: "home",
		model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" },
		items: [{ kind: "user", id: "synthetic-user", text: "Synthetic active turn message." }],
	});
	const runningTurn = beginPersistentAgentTurn(activeTurnRoom, "preflight_loop_active_turn_0001", { turnId: "synthetic-preflight-loop-turn", connectionId: "synthetic-ws" });
	rememberRoomState(activeTurnRoom);

	const beforeRunCount = countBackgroundRunFiles(tempHome);
	const firstResult = await runPersistentRoomSchedulePreflightScanOnce({ now: () => scanNow, limitPerRoom: 25 });
	assertNoPromptLeak(firstResult, promptText, "first aggregate scan result");
	assert(firstResult.roomCount >= 6 && firstResult.scannedRoomCount >= 6, "run-once should scan created non-archived rooms");
	assert(firstResult.totals.created === 4, `run-once should create due queued/deferred/blocked records, got ${JSON.stringify(firstResult.totals)}`);
	assert(firstResult.totals.queued === 1, "run-once should create one queued fresh-thread record");
	assert(firstResult.totals.deferred === 2, "run-once should create locked and active-turn deferred records");
	assert(firstResult.totals.blocked === 1, "run-once should create prepared-boundary blocked record");
	assert(firstResult.totals.notDue >= 1, "run-once should report future schedules as not_due");
	assert(firstResult.totals.unsupported >= 1, "run-once should report unsupported custom cron");
	assert(countBackgroundRunFiles(tempHome) === beforeRunCount + 4, "run-once should create exactly four background-run records for due supported schedules");
	assertStoresUnchanged("first run-once");
	assertNoUnexpectedRuntimeSideEffects(tempHome, tempAgentsRoot, tempAgentRuntimeRoot, createdRoomIds, threadSnapshots, "first run-once");

	const dueRoomResult = firstResult.rooms.find((room) => room.roomId === dueRoom)?.result;
	assert(dueRoomResult?.items[0]?.action === "created" && dueRoomResult.items[0].runStatus === "queued", "due room should create a queued run");
	assert(dueRoomResult.items[0].dueAt === dueJob.nextRunAt, "due room result should preserve dueAt");
	const dueRunId = dueRoomResult.items[0].runId;
	assert(dueRunId, "due room should expose run id");
	const dueRun = readBackgroundRun(dueRunId);
	assert(dueRun.source.trigger === "schedule-due" && dueRun.source.schedulerJobId === dueJob.id, "due run should persist schedule-due source metadata");
	assertRunNoPromptLeak(dueRun, promptText, "due run");

	const lockedResult = firstResult.rooms.find((room) => room.roomId === lockedRoom)?.result;
	assert(lockedResult?.items[0]?.runStatus === "deferred" && lockedResult.items[0].reason === "room_in_use", "locked room should create deferred room_in_use history");
	const blockedResult = firstResult.rooms.find((room) => room.roomId === blockedRoom)?.result;
	assert(blockedResult?.items[0]?.runStatus === "blocked" && blockedResult.items[0].reason === "prepared_runtime_boundary", "prepared boundary should create blocked history");
	const activeTurnResult = firstResult.rooms.find((room) => room.roomId === activeTurnRoom)?.result;
	assert(activeTurnResult?.items[0]?.runStatus === "deferred" && activeTurnResult.items[0].reason === "active_turn_in_flight", "active turn should create deferred history");
	finishPersistentAgentTurn(activeTurnRoom, "preflight_loop_active_turn_0001", { turnId: runningTurn.turnId, terminalReason: "completed" });

	const duplicateResult = await runPersistentRoomSchedulePreflightScanOnce({ now: () => scanNow, limitPerRoom: 25 });
	assertNoPromptLeak(duplicateResult, promptText, "duplicate aggregate scan result");
	assert(duplicateResult.totals.created === 0, "second run-once should not create duplicate records for the same due occurrence");
	assert(duplicateResult.totals.duplicates >= 4, "second run-once should report duplicate due occurrences");
	assert(countBackgroundRunFiles(tempHome) === beforeRunCount + 4, "duplicate run-once must not create additional background-run files");
	assertStoresUnchanged("duplicate run-once");

	const futureResult = duplicateResult.rooms.find((room) => room.roomId === futureRoom)?.result;
	assert(futureResult?.items[0]?.action === "not_due", "future room should remain not_due");
	const unsupportedResult = duplicateResult.rooms.find((room) => room.roomId === unsupportedCronRoom)?.result;
	assert(unsupportedResult?.items[0]?.reason === "unsupported_cron_due_calculation", "unsupported cron should remain skipped with explicit reason");

	for (const run of listBackgroundRuns({ kind: "scheduled-prompt", limit: 100 })) {
		assertRunNoPromptLeak(run, promptText, `listed run ${run.runId}`);
	}
	for (const roomId of createdRoomIds) {
		const store = readPersistentRoomScheduleStore(roomId);
		for (const job of store.jobs) {
			assert(job.lastRunAt === null, `${roomId}/${job.id}: loop scan must not set lastRunAt`);
			assert(job.lastStatus === null, `${roomId}/${job.id}: loop scan must not set lastStatus`);
			assert(job.lastError === null, `${roomId}/${job.id}: loop scan must not set lastError`);
		}
	}
	assert(getPersistentAgentRuntimeState(dueRoom).state === "idle", "queued fresh loop scan must not mutate runtime state");

	const stopRoom = createRoom("Preflight Loop Stop Room");
	addSchedule(stopRoom, "stop due");
	rememberRoomState(stopRoom);
	const countBeforeStoppedLoop = countBackgroundRunFiles(tempHome);
	const stoppedLoop = startPersistentRoomSchedulePreflightLoop({ enabled: true, intervalMs: 1_000, runOnStart: false, now: () => scanNow });
	stoppedLoop.stop();
	await new Promise((resolve) => setTimeout(resolve, 1_150));
	assert(countBackgroundRunFiles(tempHome) === countBeforeStoppedLoop, "stop() should prevent a pending interval tick from creating records");
	assert(stoppedLoop.isRunning() === false, "stopped loop should not report running after stop");
	const stopRoomMaterialized = await runPersistentRoomSchedulePreflightScanOnce({ now: () => scanNow, limitPerRoom: 25 });
	assert(stopRoomMaterialized.rooms.find((room) => room.roomId === stopRoom)?.result?.summary.created === 1, "post-stop direct run-once should materialize stop-room due fixture for later duplicate safety");
	assert(countBackgroundRunFiles(tempHome) === countBeforeStoppedLoop + 1, "post-stop direct run-once should create exactly one stop-room record");

	const warnings: unknown[] = [];
	const envDefaults = resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv({});
	assert(envDefaults.enabled === true && envDefaults.intervalMs === 60_000 && envDefaults.runOnStart === false && envDefaults.limitPerRoom === 25, "env resolver should return documented defaults");
	const envDisabled = resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv({ EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_ENABLED: "0" });
	assert(envDisabled.enabled === false, "env resolver should support disabling loop");
	const envTuned = resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv({
		EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_ENABLED: "1",
		EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "1000",
		EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_RUN_ON_START: "yes",
		EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_LIMIT_PER_ROOM: "100",
	});
	assert(envTuned.enabled === true && envTuned.intervalMs === 1_000 && envTuned.runOnStart === true && envTuned.limitPerRoom === 100, "env resolver should parse valid controls");
	const envInvalid = resolvePersistentRoomSchedulePreflightLoopOptionsFromEnv(
		{
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_ENABLED: "maybe",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "not-a-number",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_RUN_ON_START: "later",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_LIMIT_PER_ROOM: "not-a-number",
		},
		{ warn: (value, message) => warnings.push({ value, message }) },
	);
	assert(envInvalid.enabled === true && envInvalid.intervalMs === 60_000 && envInvalid.runOnStart === false && envInvalid.limitPerRoom === 25, "invalid env values should fall back to defaults");
	assert(warnings.length === 4, "invalid env values should emit warnings when a logger is provided");

	const startupRoom = createRoom("Preflight Loop Startup Room");
	const startupJob = addSchedule(startupRoom, "startup due");
	rememberRoomState(startupRoom);
	const startupStoreBefore = readIfExists(persistentRoomScheduleStorePath(startupRoom));
	const runCountBeforeStartupServer = countBackgroundRunFiles(tempHome);

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: {
			...process.env,
			HOME: tempHome, USERPROFILE: tempHome,
			PORT: String(port),
			...SMOKE_SERVER_AUTH_ENV,
			EXXETA_HOME: repoRoot,
			EXXPERTS_CODING_AGENT_DIR: tempAgentRuntimeRoot,
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_ENABLED: "1",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "1000",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_RUN_ON_START: "1",
			EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_LIMIT_PER_ROOM: "25",
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl);
	const startupRun = await waitForHistoryRun(baseUrl, startupRoom);
	assert(startupRun?.source?.scheduleId === startupJob.id, "startup loop-created run should be observable through existing history API");
	assert(startupRun?.source?.dueAt === startupJob.nextRunAt, "startup loop-created run should preserve dueAt in history API");
	assert(startupRun?.status === "queued", "startup loop-created run should be queued for an idle room");
	assert(!JSON.stringify(startupRun).includes(promptText), "startup history projection must not leak prompt text");
	assert(countBackgroundRunFiles(tempHome) === runCountBeforeStartupServer + 1, "startup loop should create exactly one new preflight record for the new due room");
	assert(readIfExists(persistentRoomScheduleStorePath(startupRoom)) === startupStoreBefore, "startup loop must not mutate schedule store fields");
	assertNoUnexpectedRuntimeSideEffects(tempHome, tempAgentsRoot, tempAgentRuntimeRoot, createdRoomIds, threadSnapshots, "startup loop");

	console.log("persistent-room schedule preflight loop smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-120).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}
