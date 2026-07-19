import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function listFilesRecursive(root: string): string[] {
	if (!fs.existsSync(root)) return [];
	const entries: string[] = [];
	for (const name of fs.readdirSync(root)) {
		const file = path.join(root, name);
		const stat = fs.statSync(file);
		if (stat.isDirectory()) entries.push(...listFilesRecursive(file));
		else entries.push(file);
	}
	return entries;
}

function runtimeThreadFiles(tempAgentsRoot: string, roomId: string): string[] {
	const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
	return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")) : [];
}

function countBackgroundRunFiles(tempHome: string): number {
	return listFilesRecursive(path.join(tempHome, ".exxperts", "app", "background-runs", "runs")).filter((file) => path.basename(file) === "run.json").length;
}

function readIfExists(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-background-run-history-api-"));
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

const { createBackgroundRun } = await import("../src/background-runs.js");
const { persistentRoomScheduleStorePath } = await import("../../../pi-package/extensions/schedule-prompt/index.js");

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 26000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

async function waitForServer(server: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 15000;
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

async function requestJson(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any; text: string }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, {
		...init,
		headers: {
			...(init.body ? { "content-type": "application/json" } : {}),
			...(init.headers ?? {}),
		},
	});
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null, text };
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
	return agentId;
}

async function createSchedule(roomId: string, name: string): Promise<string> {
	const created = await requestJson(`/api/persistent-agents/${encodeURIComponent(roomId)}/schedules`, {
		method: "POST",
		body: JSON.stringify({
			name,
			type: "once",
			schedule: "+30m",
			prompt: "Synthetic scheduled prompt used only for history API smoke fixtures.",
			enabled: true,
		}),
	});
	assert(created.status === 201, `create schedule should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	const jobId = String(created.body?.job?.id ?? "");
	assert(jobId.startsWith("sched_"), "create schedule should return a schedule job id");
	return jobId;
}

function assertNoRuntimeSideEffects(roomIds: string[], label: string): void {
	for (const roomId of roomIds) {
		const threads = runtimeThreadFiles(tempAgentsRoot, roomId);
		assert(threads.length === 0, `${label}: history GETs must not create runtime threads for ${roomId}, found ${threads.join(",")}`);
	}
	const sessionJsonlFiles = listFilesRecursive(tempHome).filter((file) => file.endsWith(".jsonl"));
	assert(sessionJsonlFiles.length === 0, `${label}: history GETs must not create Pi JSONL sessions, found ${sessionJsonlFiles.join(",")}`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), `${label}: history GETs must not create/read runtime auth state`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), `${label}: history GETs must not create/read runtime model state`);
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), `${label}: history GETs must not create legacy ~/.exxeta state`);
}

function assertHistoryEnvelope(body: any, roomId: string, label: string): void {
	assert(body?.roomId === roomId, `${label}: response should include room id`);
	assert(body?.ordering === "createdAt_desc", `${label}: response should declare createdAt descending ordering`);
	assert(Array.isArray(body?.runs), `${label}: response should include runs array`);
	assert(body?.summary?.totalReturned === body.runs.length, `${label}: summary should count returned runs`);
}

let server: ChildProcessWithoutNullStreams | null = null;
const serverOutput: string[] = [];
const createdRoomIds: string[] = [];

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
	await waitForServer(server);

	const roomA = await createRoom("Background Run History Room A");
	const roomB = await createRoom("Background Run History Room B");
	const emptyRoom = await createRoom("Background Run History Empty Room");
	const archivedRoom = await createRoom("Background Run History Archived Room");
	createdRoomIds.push(roomA, roomB, emptyRoom, archivedRoom);
	const encodedRoomA = encodeURIComponent(roomA);
	const encodedRoomB = encodeURIComponent(roomB);
	const encodedEmptyRoom = encodeURIComponent(emptyRoom);
	const encodedArchivedRoom = encodeURIComponent(archivedRoom);

	const scheduleA = await createSchedule(roomA, "Synthetic history schedule A");
	const scheduleB = await createSchedule(roomA, "Synthetic history schedule B");
	const roomAScheduleStorePath = persistentRoomScheduleStorePath(roomA);
	const scheduleStoreBeforeGets = readIfExists(roomAScheduleStorePath);
	assert(scheduleStoreBeforeGets, "fixture should have a schedule store before history GETs");

	const oldBlocked = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: roomA },
		source: { trigger: "schedule-due", schedulerJobId: scheduleA, dueAt: "2026-01-01T07:00:00.000Z" },
		status: "blocked",
		reason: "prepared_runtime_boundary",
		message: "Synthetic blocked preflight.",
		target: { kind: "none", roomId: roomA },
		artifacts: { inputRelPath: "runs/synthetic/input.md", outputRelPath: "runs/synthetic/output.md", eventRelPath: "runs/synthetic/events.jsonl" },
		warnings: ["Synthetic warning."],
		error: { code: "synthetic_blocked", message: "Synthetic blocked reason." },
		now: new Date("2026-01-01T07:00:00.000Z"),
	});
	const middleDeferred = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: roomA },
		source: { trigger: "schedule-due", schedulerJobId: scheduleB, dueAt: "2026-01-01T08:00:00.000Z" },
		status: "deferred",
		reason: "room_in_use",
		message: "Synthetic room lock is active.",
		target: { kind: "none", roomId: roomA },
		warnings: [],
		now: new Date("2026-01-01T08:00:00.000Z"),
	});
	const newestManual = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: roomA },
		source: { trigger: "manual" },
		status: "queued",
		reason: "fresh_thread",
		message: "Synthetic manual room background run.",
		target: {
			kind: "fresh-thread",
			roomId: roomA,
			modelPolicyKey: "scheduledRoom",
			model: { provider: "openai-compatible", model: "synthetic-model", label: "Synthetic Model" },
		},
		warnings: [],
		now: new Date("2026-01-01T09:00:00.000Z"),
	});
	const roomBRun = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: roomB },
		source: { trigger: "schedule-due", schedulerJobId: scheduleA, dueAt: "2026-01-01T10:00:00.000Z" },
		status: "failed",
		reason: "synthetic_unrelated_room",
		message: "Synthetic unrelated room run.",
		target: { kind: "none", roomId: roomB },
		warnings: [],
		now: new Date("2026-01-01T10:00:00.000Z"),
	});
	assert(roomBRun.scope.kind === "persistent-room" && roomBRun.scope.roomId === roomB, "fixture should create unrelated room run");

	const runCountBeforeGets = countBackgroundRunFiles(tempHome);
	assert(runCountBeforeGets === 4, `fixture should create four background-run records, found ${runCountBeforeGets}`);

	const defaultHistory = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs`);
	assert(defaultHistory.status === 200, `default history should return 200, got ${defaultHistory.status}: ${JSON.stringify(defaultHistory.body)}`);
	assertHistoryEnvelope(defaultHistory.body, roomA, "default history");
	assert(defaultHistory.body?.filters?.limit === 50, "default history should use default limit 50");
	assert(defaultHistory.body?.runs?.length === 3, "default history should include all room A runs only");
	assert(defaultHistory.body.runs.map((run: any) => run.runId).join(",") === [newestManual.runId, middleDeferred.runId, oldBlocked.runId].join(","), "default history should be newest-first by createdAt");
	assert(defaultHistory.body.runs.every((run: any) => run.roomId === roomA), "default history should exclude unrelated room records");
	assert(defaultHistory.body.runs.every((run: any) => run.runId !== roomBRun.runId), "default history should not include room B run id");
	assert(defaultHistory.body.runs.some((run: any) => !run.source.scheduleId), "default history should include room runs without schedule ids");
	assert(defaultHistory.body.summary.byStatus.queued === 1, "default summary should count queued run");
	assert(defaultHistory.body.summary.byStatus.deferred === 1, "default summary should count deferred run");
	assert(defaultHistory.body.summary.byStatus.blocked === 1, "default summary should count blocked run");
	assert(defaultHistory.body.summary.latestCreatedAt === newestManual.createdAt, "default summary should report latest createdAt");
	assert(defaultHistory.body.summary.latestUpdatedAt === newestManual.updatedAt, "default summary should report latest updatedAt");

	const artifactRun = defaultHistory.body.runs.find((run: any) => run.runId === oldBlocked.runId);
	assert(artifactRun?.source?.scheduleId === scheduleA, "projection should map schedulerJobId to source.scheduleId");
	assert(artifactRun?.artifacts?.hasInput === true, "projection should expose hasInput boolean");
	assert(artifactRun?.artifacts?.hasOutput === true, "projection should expose hasOutput boolean");
	assert(artifactRun?.artifacts?.hasEvents === true, "projection should expose hasEvents boolean");
	const artifactRunText = JSON.stringify(artifactRun);
	assert(!artifactRunText.includes("inputRelPath") && !artifactRunText.includes("outputRelPath") && !artifactRunText.includes("eventRelPath"), "projection must not expose raw artifact path field names");
	assert(!artifactRunText.includes("runs/synthetic/input.md") && !artifactRunText.includes("runs/synthetic/output.md"), "projection must not expose raw artifact paths");
	assert(artifactRun?.error?.code === "synthetic_blocked", "projection should include diagnostic error code");
	assert(Array.isArray(artifactRun?.warnings) && artifactRun.warnings.length === 1, "projection should include diagnostic warnings");

	const scheduleHistory = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?scheduleId=${encodeURIComponent(scheduleA)}`);
	assert(scheduleHistory.status === 200, `schedule history should return 200, got ${scheduleHistory.status}: ${JSON.stringify(scheduleHistory.body)}`);
	assertHistoryEnvelope(scheduleHistory.body, roomA, "schedule history");
	assert(scheduleHistory.body?.filters?.scheduleId === scheduleA, "schedule history should echo scheduleId filter");
	assert(scheduleHistory.body?.runs?.length === 1 && scheduleHistory.body.runs[0].runId === oldBlocked.runId, "scheduleId filter should return only matching schedule-associated records");
	assert(scheduleHistory.body.runs.every((run: any) => run.source.scheduleId === scheduleA), "scheduleId filter should map all returned source schedule ids");

	const statusHistory = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?status=deferred`);
	assert(statusHistory.status === 200, `status history should return 200, got ${statusHistory.status}: ${JSON.stringify(statusHistory.body)}`);
	assert(statusHistory.body?.filters?.status === "deferred", "status history should echo status filter");
	assert(statusHistory.body?.runs?.length === 1 && statusHistory.body.runs[0].runId === middleDeferred.runId, "status filter should return only matching statuses");
	assert(statusHistory.body.runs.every((run: any) => run.status === "deferred"), "status filter should include only deferred records");

	const limitedHistory = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?limit=2`);
	assert(limitedHistory.status === 200, `limited history should return 200, got ${limitedHistory.status}: ${JSON.stringify(limitedHistory.body)}`);
	assert(limitedHistory.body?.filters?.limit === 2, "limit response should echo requested limit");
	assert(limitedHistory.body?.runs?.length === 2, "limit=2 should return two records");
	assert(limitedHistory.body.runs.map((run: any) => run.runId).join(",") === [newestManual.runId, middleDeferred.runId].join(","), "limit=2 should return two newest matching records");

	const emptyHistory = await requestJson(`/api/persistent-agents/${encodedEmptyRoom}/background-runs`);
	assert(emptyHistory.status === 200, `empty room history should return 200, got ${emptyHistory.status}: ${JSON.stringify(emptyHistory.body)}`);
	assertHistoryEnvelope(emptyHistory.body, emptyRoom, "empty room history");
	assert(emptyHistory.body?.runs?.length === 0, "empty room history should return no runs");
	assert(emptyHistory.body?.summary?.latestCreatedAt === null, "empty summary should report null latestCreatedAt");
	assert(emptyHistory.body?.summary?.latestUpdatedAt === null, "empty summary should report null latestUpdatedAt");

	const emptyFilterHistory = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?scheduleId=sched_ffffffffffffffffffffffffffffffff`);
	assert(emptyFilterHistory.status === 200, `unknown schedule id filter should return 200, got ${emptyFilterHistory.status}: ${JSON.stringify(emptyFilterHistory.body)}`);
	assert(emptyFilterHistory.body?.runs?.length === 0, "unknown schedule id filter should return empty runs without validating schedule registry");

	const invalidRoom = await requestJson("/api/persistent-agents/InvalidRoom/background-runs");
	assert(invalidRoom.status === 400, `invalid room id should return 400, got ${invalidRoom.status}: ${JSON.stringify(invalidRoom.body)}`);
	const invalidStatus = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?status=not-a-status`);
	assert(invalidStatus.status === 400, `invalid status should return 400, got ${invalidStatus.status}: ${JSON.stringify(invalidStatus.body)}`);
	const invalidLimit = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?limit=201`);
	assert(invalidLimit.status === 400, `too-large limit should return 400, got ${invalidLimit.status}: ${JSON.stringify(invalidLimit.body)}`);
	const blankSchedule = await requestJson(`/api/persistent-agents/${encodedRoomA}/background-runs?scheduleId=`);
	assert(blankSchedule.status === 400, `blank scheduleId should return 400, got ${blankSchedule.status}: ${JSON.stringify(blankSchedule.body)}`);

	const missingRoom = await requestJson("/api/persistent-agents/background-history-missing-room/background-runs");
	assert(missingRoom.status === 404, `missing room should return 404, got ${missingRoom.status}: ${JSON.stringify(missingRoom.body)}`);

	const archived = await requestJson(`/api/persistent-agents/${encodedArchivedRoom}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${archivedRoom}` }),
	});
	assert(archived.status === 200, `archive should succeed, got ${archived.status}: ${JSON.stringify(archived.body)}`);
	const archivedHistory = await requestJson(`/api/persistent-agents/${encodedArchivedRoom}/background-runs`);
	assert(archivedHistory.status === 410, `archived room history should return 410, got ${archivedHistory.status}: ${JSON.stringify(archivedHistory.body)}`);

	const roomBHistory = await requestJson(`/api/persistent-agents/${encodedRoomB}/background-runs`);
	assert(roomBHistory.status === 200, `room B history should return 200, got ${roomBHistory.status}: ${JSON.stringify(roomBHistory.body)}`);
	assert(roomBHistory.body?.runs?.length === 1 && roomBHistory.body.runs[0].runId === roomBRun.runId, "room B history should return its own run only");

	assert(countBackgroundRunFiles(tempHome) === runCountBeforeGets, "history GETs must not create or delete background-run records");
	assert(readIfExists(roomAScheduleStorePath) === scheduleStoreBeforeGets, "history GETs must not mutate schedule store");
	assertNoRuntimeSideEffects(createdRoomIds, "background-run history API smoke");

	console.log("persistent-room background-run history API smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-100).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${tempRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	}
}
