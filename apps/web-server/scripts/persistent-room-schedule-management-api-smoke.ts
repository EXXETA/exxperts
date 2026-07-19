import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
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

function runtimeThreadFiles(tempAgentsRoot: string, roomId: string): string[] {
	const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
	return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")) : [];
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

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-management-api-"));
const tempHome = path.join(tempRoot, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const tempAgentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = tempAgentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

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
	return agentId;
}

function assertManagementResponse(body: any, roomId: string, label: string): void {
	assert(body?.roomId === roomId, `${label}: response should include room id`);
	assert(body?.executionEnabled === false, `${label}: response should report execution disabled`);
	assert(body?.managementOnly === true, `${label}: response should mark management-only writes`);
	assert(String(body?.notice ?? "").includes("Enabled schedules can run as background room work"), `${label}: response should include background-execution notice`);
	assert(Array.isArray(body?.jobs), `${label}: response should include jobs list`);
	assert(body?.summary?.executionEnabled === false, `${label}: summary should report execution disabled`);
}

function assertNoExecutionSideEffects(roomIds: string[], label: string): void {
	const backgroundRunFiles = listFilesRecursive(path.join(tempHome, ".exxperts", "app", "background-runs", "runs")).filter((file) => path.basename(file) === "run.json");
	assert(backgroundRunFiles.length === 0, `${label}: management writes must not create background-run records, found ${backgroundRunFiles.join(",")}`);
	for (const roomId of roomIds) {
		const threads = runtimeThreadFiles(tempAgentsRoot, roomId);
		assert(threads.length === 0, `${label}: management writes must not create runtime threads for ${roomId}, found ${threads.join(",")}`);
	}
	const sessionJsonlFiles = listFilesRecursive(tempHome).filter((file) => file.endsWith(".jsonl"));
	assert(sessionJsonlFiles.length === 0, `${label}: management writes must not create Pi JSONL sessions, found ${sessionJsonlFiles.join(",")}`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), `${label}: management writes must not create/read runtime auth state`);
	assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), `${label}: management writes must not create/read runtime model state`);
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), `${label}: management writes must not create legacy ~/.exxeta state`);
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

	const agentId = await createRoom("Schedule Management API Smoke Room");
	createdRoomIds.push(agentId);
	const encodedAgentId = encodeURIComponent(agentId);

	const created = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify({
			name: "World Cup results",
			type: "once",
			schedule: "+30m",
			prompt: "Check the World Cup results and summarize them for me.",
			enabled: true,
		}),
	});
	assert(created.status === 201, `valid POST should return 201, got ${created.status}: ${JSON.stringify(created.body)}`);
	assertManagementResponse(created.body, agentId, "create");
	assert(created.body?.job?.id?.startsWith("sched_"), "create response should include created job id");
	assert(created.body?.job?.name === "World Cup results", "create response should include created job name");
	assert(created.body?.job?.type === "once", "create response should include created job type");
	assert(created.body?.job?.enabled === true, "create response should include enabled job");
	assert(created.body?.jobs?.length === 1, "create response should include current jobs list");
	assert(created.body?.summary?.totalCount === 1, "create response summary should count created job");
	assert(created.body?.summary?.enabledCount === 1, "create response summary should count enabled job");
	const jobId = String(created.body.job.id);

	let schedules = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`);
	assert(schedules.status === 200, `GET after POST should succeed, got ${schedules.status}: ${JSON.stringify(schedules.body)}`);
	assert(schedules.body?.jobs?.some((job: any) => job.id === jobId), "GET should see created schedule job");
	assert(schedules.body?.executionEnabled === false, "GET should remain execution-disabled compatible");

	const patched = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/${encodeURIComponent(jobId)}`, {
		method: "PATCH",
		body: JSON.stringify({
			name: "Updated match results",
			type: "interval",
			schedule: "2h",
			prompt: "Check the latest match results and summarize changes.",
		}),
	});
	assert(patched.status === 200, `PATCH update should return 200, got ${patched.status}: ${JSON.stringify(patched.body)}`);
	assertManagementResponse(patched.body, agentId, "patch update");
	assert(patched.body?.job?.id === jobId, "PATCH response should include updated job");
	assert(patched.body?.job?.name === "Updated match results", "PATCH should update name");
	assert(patched.body?.job?.type === "interval", "PATCH should update type");
	assert(patched.body?.job?.schedule === "2h", "PATCH should canonicalize/update schedule");
	assert(patched.body?.job?.prompt === "Check the latest match results and summarize changes.", "PATCH should update prompt");

	const disabled = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/${encodeURIComponent(jobId)}`, {
		method: "PATCH",
		body: JSON.stringify({ enabled: false }),
	});
	assert(disabled.status === 200, `PATCH disable should return 200, got ${disabled.status}: ${JSON.stringify(disabled.body)}`);
	assert(disabled.body?.job?.enabled === false, "PATCH { enabled:false } should disable job");
	assert(disabled.body?.summary?.enabledCount === 0, "disable response summary should count no enabled jobs");

	const enabled = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/${encodeURIComponent(jobId)}`, {
		method: "PATCH",
		body: JSON.stringify({ enabled: true }),
	});
	assert(enabled.status === 200, `PATCH enable should return 200, got ${enabled.status}: ${JSON.stringify(enabled.body)}`);
	assert(enabled.body?.job?.enabled === true, "PATCH { enabled:true } should enable job");
	assert(enabled.body?.summary?.enabledCount === 1, "enable response summary should count enabled job");

	const deleted = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/${encodeURIComponent(jobId)}`, { method: "DELETE" });
	assert(deleted.status === 200, `DELETE should return 200, got ${deleted.status}: ${JSON.stringify(deleted.body)}`);
	assertManagementResponse(deleted.body, agentId, "delete");
	assert(deleted.body?.removed?.id === jobId, "DELETE response should include removed job");
	assert(Array.isArray(deleted.body?.jobs) && deleted.body.jobs.length === 0, "DELETE response should include current empty jobs list");
	assert(deleted.body?.summary?.totalCount === 0, "DELETE summary should count no jobs");

	const invalidBody = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify("not an object"),
	});
	assert(invalidBody.status === 400, `invalid request body should return 400, got ${invalidBody.status}: ${JSON.stringify(invalidBody.body)}`);

	const unknownField = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "bad", schedule: "+30m", prompt: "bad", surprise: true }),
	});
	assert(unknownField.status === 400, `unknown fields should return 400, got ${unknownField.status}: ${JSON.stringify(unknownField.body)}`);

	const invalidBoolean = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "bad boolean", schedule: "+30m", prompt: "bad", enabled: "false" }),
	});
	assert(invalidBoolean.status === 400, `invalid boolean should return 400, got ${invalidBoolean.status}: ${JSON.stringify(invalidBoolean.body)}`);

	const emptyPatch = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/sched_ffffffffffffffffffffffffffffffff`, {
		method: "PATCH",
		body: JSON.stringify({}),
	});
	assert(emptyPatch.status === 400, `empty PATCH should return 400, got ${emptyPatch.status}: ${JSON.stringify(emptyPatch.body)}`);

	const longPrompt = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "too long", schedule: "+30m", prompt: "x".repeat(20_001) }),
	});
	assert(longPrompt.status === 400, `prompt over 20k chars should return 400, got ${longPrompt.status}: ${JSON.stringify(longPrompt.body)}`);

	const invalidSchedule = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "bad schedule", type: "interval", schedule: "not an interval", prompt: "bad" }),
	});
	assert(invalidSchedule.status === 400, `invalid schedule/type should return 400, got ${invalidSchedule.status}: ${JSON.stringify(invalidSchedule.body)}`);

	const missingJob = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules/sched_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee`, {
		method: "PATCH",
		body: JSON.stringify({ enabled: false }),
	});
	assert(missingJob.status === 404, `missing schedule job should return 404, got ${missingJob.status}: ${JSON.stringify(missingJob.body)}`);

	const missingRoom = await requestJson("/api/persistent-agents/schedule-management-missing-room/schedules", {
		method: "POST",
		body: JSON.stringify({ name: "missing room", schedule: "+30m", prompt: "bad" }),
	});
	assert(missingRoom.status === 404, `missing room should return 404, got ${missingRoom.status}: ${JSON.stringify(missingRoom.body)}`);

	const archivedRoomId = await createRoom("Schedule Management Archived Room");
	createdRoomIds.push(archivedRoomId);
	const encodedArchivedRoomId = encodeURIComponent(archivedRoomId);
	const archived = await requestJson(`/api/persistent-agents/${encodedArchivedRoomId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${archivedRoomId}` }),
	});
	assert(archived.status === 200, `archive should succeed, got ${archived.status}: ${JSON.stringify(archived.body)}`);
	const archivedWrite = await requestJson(`/api/persistent-agents/${encodedArchivedRoomId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "archived", schedule: "+30m", prompt: "bad" }),
	});
	assert(archivedWrite.status === 410, `archived room should return 410, got ${archivedWrite.status}: ${JSON.stringify(archivedWrite.body)}`);

	const corruptRoomId = await createRoom("Schedule Management Corrupt Store Room");
	createdRoomIds.push(corruptRoomId);
	const encodedCorruptRoomId = encodeURIComponent(corruptRoomId);
	writeJson(persistentRoomScheduleStorePath(corruptRoomId), { version: 999, roomId: corruptRoomId, jobs: [] });
	const corruptWrite = await requestJson(`/api/persistent-agents/${encodedCorruptRoomId}/schedules`, {
		method: "POST",
		body: JSON.stringify({ name: "corrupt", schedule: "+30m", prompt: "bad" }),
	});
	assert(corruptWrite.status === 500, `corrupt schedule store should return 500, got ${corruptWrite.status}: ${JSON.stringify(corruptWrite.body)}`);
	assert(String(corruptWrite.body?.error ?? "").includes("unsupported persistent room schedule store version"), "corrupt store error should explain validation failure");

	schedules = await requestJson(`/api/persistent-agents/${encodedAgentId}/schedules`);
	assert(schedules.status === 200 && schedules.body?.jobs?.length === 0, "main room should remain readable after management validation failures");

	assertNoExecutionSideEffects(createdRoomIds, "schedule management API smoke");

	console.log("persistent-room schedule management API smoke passed");
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
