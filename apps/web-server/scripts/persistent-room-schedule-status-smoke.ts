import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, freePort, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer } from "./smoke-server-process.js";
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-status-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = tempAgentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

const scheduleModule = await import("../../../pi-package/extensions/schedule-prompt/index.js");
const {
	addPersistentRoomScheduleJob,
	persistentRoomScheduleStorePath,
	readPersistentRoomScheduleStore,
	writePersistentRoomScheduleStore,
} = scheduleModule;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function createRoom(displayName: string): Promise<string> {
	const created = await requestJson("/api/persistent-agents", {
		method: "POST",
		body: JSON.stringify({
			displayName,
			userName: "Synthetic User",
			preferredUserAddress: "Synthetic User",
		}),
	});
	assert(created.status === 201, `create room ${displayName} should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const agentId = String(created.body?.agent?.agentId ?? "");
	assert(agentId, `create room ${displayName} should return agentId`);
	assert(created.body?.status?.scheduleSummary?.totalCount === 0, "new room status schedule summary should start empty");
	return agentId;
}

function assertEmptyRuntimeThreads(agentId: string, label: string): void {
	const threadsDir = path.join(tempAgentsRoot, agentId, "runtime", "threads");
	const threadFiles = fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")) : [];
	assert(threadFiles.length === 0, `${label}: schedule status reads must not create runtime threads, found ${threadFiles.join(",")}`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];

try {
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
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server, baseUrl, 15000);

	const agentId = await createRoom("Schedule Status Smoke Room");
	const encodedAgentId = encodeURIComponent(agentId);
	const scheduleStorePath = persistentRoomScheduleStorePath(agentId);

	let schedules = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`);
	assert(schedules.status === 200, `empty schedules GET should succeed, got ${schedules.status}: ${JSON.stringify(schedules.body)}`);
	assert(schedules.body?.roomId === agentId, "empty schedules response should include room id");
	assert(Array.isArray(schedules.body?.jobs) && schedules.body.jobs.length === 0, "empty schedules response should return no jobs");
	assert(schedules.body?.summary?.totalCount === 0, "empty summary total count should be zero");
	assert(schedules.body?.summary?.enabledCount === 0, "empty summary enabled count should be zero");
	assert(schedules.body?.summary?.nextRunAt === null, "empty summary nextRunAt should be null");
	assert(!fs.existsSync(scheduleStorePath), "empty schedule read should not create schedule store file");

	const now = new Date("2026-01-01T00:00:00.000Z");
	const lateEnabled = addPersistentRoomScheduleJob(agentId, {
		name: "late enabled",
		schedule: "every hour",
		prompt: "Run later enabled work",
		now,
	});
	const earlyDisabled = addPersistentRoomScheduleJob(agentId, {
		name: "early disabled",
		type: "once",
		schedule: "+15m",
		prompt: "Disabled jobs should not choose nextRunAt",
		enabled: false,
		now,
	});
	const earlyEnabled = addPersistentRoomScheduleJob(agentId, {
		name: "early enabled",
		type: "once",
		schedule: "+30m",
		prompt: "Run earliest enabled work",
		now,
	});
	const store = readPersistentRoomScheduleStore(agentId);
	writePersistentRoomScheduleStore({
		...store,
		jobs: store.jobs.map((job: any) => {
			if (job.id === lateEnabled.id) return { ...job, lastRunAt: "2026-01-01T00:10:00.000Z", lastStatus: "success" };
			if (job.id === earlyDisabled.id) return { ...job, lastRunAt: "2026-01-01T00:20:00.000Z", lastStatus: "error", lastError: "synthetic stored error" };
			return job;
		}),
	});

	schedules = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`);
	assert(schedules.status === 200, `populated schedules GET should succeed, got ${schedules.status}: ${JSON.stringify(schedules.body)}`);
	assert(schedules.body?.jobs?.length === 3, "populated schedules response should return three jobs");
	assert(schedules.body?.summary?.totalCount === 3, "summary should count all jobs");
	assert(schedules.body?.summary?.enabledCount === 2, "summary should count only enabled jobs as enabled");
	assert(schedules.body?.summary?.nextRunAt === earlyEnabled.nextRunAt, "summary should choose earliest enabled nextRunAt");
	assert(schedules.body?.summary?.nextRunAt === "2026-01-01T00:30:00.000Z", "disabled earlier nextRunAt must not be selected");
	assert(schedules.body?.summary?.lastRunAt === "2026-01-01T00:20:00.000Z", "summary should choose most recent stored lastRunAt");
	assert(schedules.body?.summary?.lastStatus === "error", "summary should pair lastStatus with most recent stored lastRunAt job");
	assert(schedules.body?.summary?.lastError === "synthetic stored error", "summary should pair lastError with selected lastStatus job");

	const status = await requestJson(`/api/persistent-agents/${encodedAgentId}/status`);
	assert(status.status === 200, `status should succeed, got ${status.status}: ${JSON.stringify(status.body)}`);
	assert(status.body?.scheduleSummary?.totalCount === 3, "status should include schedule summary total count");
	assert(status.body?.scheduleSummary?.enabledCount === 2, "status should include schedule summary enabled count");
	assert(status.body?.runtime?.state === "idle", "schedule status reads should not start a runtime turn");
	assert(status.body?.runtime?.activeThreadId === null, "schedule status reads should not select an active runtime thread");
	assertEmptyRuntimeThreads(agentId, "populated schedule status");

	const listed = await requestJson("/api/persistent-agents");
	assert(listed.status === 200 && Array.isArray(listed.body), `list should succeed, got ${listed.status}: ${JSON.stringify(listed.body)}`);
	const listedRoom = listed.body.find((room: any) => room.id === agentId);
	assert(listedRoom?.scheduleSummary?.totalCount === 3, "room list should include schedule summary");

	// A one-off that ran shows its own run after 60 newer runs of another task push it out of the newest 50.
	const { createBackgroundRun } = await import("../src/background-runs.js");
	// A page component (.tsx): loaded at run time, as the server build compiles scripts without JSX.
	const { findRelevantRunForJob, latestRunsBySchedule, shownNextDueAt }: any = await import(new URL("../../web-ui/src/components/RoomScheduledTasksSection.tsx", import.meta.url).href);
	const historyRoomId = await createRoom("Schedule History Room");
	const minutes = (from: string | Date, count: number) => new Date(new Date(from).getTime() + count * 60_000);
	const ranRun = (jobId: string, dueAt: string | Date) => createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: historyRoomId },
		source: { schedulerJobId: jobId, trigger: "schedule-due", dueAt: new Date(dueAt).toISOString() },
		status: "succeeded",
		reason: "completed",
		now: new Date(dueAt),
	});
	const oneOff = addPersistentRoomScheduleJob(historyRoomId, { name: "one-off", type: "once", schedule: "+10m", prompt: "Run once.", now });
	const busy = addPersistentRoomScheduleJob(historyRoomId, { name: "busy", type: "interval", schedule: "1m", prompt: "Run often.", now });
	const oneOffRun = ranRun(oneOff.id, String(oneOff.nextRunAt));
	for (let count = 1; count <= 60; count += 1) ranRun(busy.id, minutes(String(oneOff.nextRunAt), count));
	const history = await requestJson(`/api/persistent-agents/${encodeURIComponent(historyRoomId)}/background-runs?limit=50`);
	assert(history.status === 200 && !history.body.runs.some((run: any) => run.runId === oneOffRun.runId), "the one-off's run is past the newest 50");
	const historyJobs = (await requestJson(`/api/persistent-agents/${encodeURIComponent(historyRoomId)}/schedules`)).body.jobs;
	const oneOffRow = findRelevantRunForJob(historyJobs.find((job: any) => job.id === oneOff.id), latestRunsBySchedule(history.body));
	assert(oneOffRow?.runId === oneOffRun.runId && oneOffRow.status === "succeeded", `the one-off's row shows its own run, got ${JSON.stringify(oneOffRow)}`);
	assert(shownNextDueAt(historyJobs.find((job: any) => job.id === oneOff.id), oneOffRow) === null, "a one-off that ran shows no Next due");

	// An interval task's Next due after seven runs is its next real time, not its first.
	const hourlyCreatedAt = new Date(Date.now() - 7.5 * 60 * 60_000);
	const hourly = addPersistentRoomScheduleJob(historyRoomId, { name: "hourly", type: "interval", schedule: "1h", prompt: "Run hourly.", now: hourlyCreatedAt });
	for (let hour = 0; hour < 7; hour += 1) ranRun(hourly.id, minutes(String(hourly.nextRunAt), hour * 60));
	const hourlyListed = (await requestJson(`/api/persistent-agents/${encodeURIComponent(historyRoomId)}/schedules`)).body.jobs.find((job: any) => job.id === hourly.id);
	const nextReal = minutes(String(hourly.nextRunAt), 7 * 60);
	assert(nextReal.getTime() > Date.now() && hourlyListed?.nextRunAt === nextReal.toISOString(), `after seven runs, Next due is ${nextReal.toISOString()}, got ${hourlyListed?.nextRunAt}`);
	assert(shownNextDueAt(hourlyListed, null) === nextReal.toISOString(), `an enabled interval task shows its Next due, got ${shownNextDueAt(hourlyListed, null)}`);
	// Switched off, the same kind of task shows no Next due.
	const switchedOff = await requestJson(`/api/persistent-agents/${encodeURIComponent(historyRoomId)}/schedules/${encodeURIComponent(busy.id)}`, { method: "PATCH", body: JSON.stringify({ enabled: false }) });
	assert(switchedOff.status === 200, `switching a task off should succeed, got ${switchedOff.status}: ${JSON.stringify(switchedOff.body)}`);
	const busyListed = (await requestJson(`/api/persistent-agents/${encodeURIComponent(historyRoomId)}/schedules`)).body.jobs.find((job: any) => job.id === busy.id);
	assert(busyListed?.enabled === false && shownNextDueAt(busyListed, null) === null, `a switched-off task shows no Next due, got ${shownNextDueAt(busyListed, null)}`);

	const missing = await requestJson("/api/persistent-agents/not-a-real-room/schedules");
	assert(missing.status === 404, `missing room schedules should return 404, got ${missing.status}: ${JSON.stringify(missing.body)}`);
	const invalid = await requestJson("/api/persistent-agents/Uppercase/schedules");
	assert(invalid.status === 400, `invalid room id schedules should return 400, got ${invalid.status}: ${JSON.stringify(invalid.body)}`);

	const errorRoomId = await createRoom("Schedule Error Status Room");
	const encodedErrorRoomId = encodeURIComponent(errorRoomId);
	addPersistentRoomScheduleJob(errorRoomId, { name: "error room job", schedule: "+45m", prompt: "Readable even when room status is error", now });
	fs.rmSync(path.join(tempAgentsRoot, errorRoomId, "L1a.md"), { force: true });
	const errorRoomStatus = await requestJson(`/api/persistent-agents/${encodedErrorRoomId}/status`);
	assert(errorRoomStatus.status === 200 && errorRoomStatus.body?.status === "error", "synthetic broken room should expose status error");
	const errorRoomSchedules = await requestJson(`/api/persistent-agents/${encodedErrorRoomId}/schedules`);
	assert(errorRoomSchedules.status === 200, `schedules should remain readable for existing non-archived error room, got ${errorRoomSchedules.status}: ${JSON.stringify(errorRoomSchedules.body)}`);
	assert(errorRoomSchedules.body?.summary?.totalCount === 1, "error room schedules should return stored jobs");

	const corruptRoomId = await createRoom("Schedule Corrupt Store Room");
	const encodedCorruptRoomId = encodeURIComponent(corruptRoomId);
	writeJson(persistentRoomScheduleStorePath(corruptRoomId), { version: 999, roomId: corruptRoomId, jobs: [] });
	const corruptStatus = await requestJson(`/api/persistent-agents/${encodedCorruptRoomId}/status`);
	assert(corruptStatus.status === 200, `status should survive corrupt schedule store, got ${corruptStatus.status}: ${JSON.stringify(corruptStatus.body)}`);
	assert(corruptStatus.body?.scheduleSummary?.totalCount === 0, "status should use empty schedule summary when schedule store cannot be read");
	assert(Array.isArray(corruptStatus.body?.warnings) && corruptStatus.body.warnings.some((warning: string) => warning.includes("schedule summary unavailable")), "status should use existing warnings surface for schedule summary read failures");
	const corruptSchedules = await requestJson(`/api/persistent-agents/${encodedCorruptRoomId}/schedules`);
	assert(corruptSchedules.status === 500, `detailed schedules endpoint should surface corrupt store as 500, got ${corruptSchedules.status}: ${JSON.stringify(corruptSchedules.body)}`);
	assert(String(corruptSchedules.body?.error ?? "").includes("unsupported persistent room schedule store version"), "corrupt schedules error should explain validation failure");

	const archivedRoomId = await createRoom("Schedule Archived Status Room");
	const encodedArchivedRoomId = encodeURIComponent(archivedRoomId);
	const archived = await requestJson(`/api/persistent-agents/${encodedArchivedRoomId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${archivedRoomId}` }),
	});
	assert(archived.status === 200, `archive should succeed, got ${archived.status}: ${JSON.stringify(archived.body)}`);
	const archivedSchedules = await requestJson(`/api/persistent-agents/${encodedArchivedRoomId}/schedules`);
	assert(archivedSchedules.status === 410, `archived room schedules should return 410, got ${archivedSchedules.status}: ${JSON.stringify(archivedSchedules.body)}`);

	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "schedule status smoke must not create legacy ~/.exxeta state");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), "schedule status smoke must not create/read runtime auth state");
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), "schedule status smoke must not create/read runtime model state");

	console.log("persistent-room schedule status smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}
