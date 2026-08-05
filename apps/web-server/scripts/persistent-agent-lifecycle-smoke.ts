// Room lifecycle: archive → restore → purge. The archive smoke owns the
// archive endpoint's own edges; this smoke owns everything after it — the
// archived listing with real counts, restore re-admitting the room (and its
// schedules), and purge permanently removing the room plus every per-room
// store OUTSIDE the room dir, while refusing whenever the room is busy and
// never touching workspace roots or the agent-state side.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { authedFetch, type AuthedFetchInit, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer } from "./smoke-server-process.js";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-lifecycle-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-lifecycle-root-"));
const tempWorkspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-agent-lifecycle-workspace-"));
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const appStateDir = path.join(tempHome, ".exxperts", "app");
const port = 24000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function readJson(file: string): any {
	return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function writeJson(file: string, value: unknown): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
}

function writeText(file: string, text: string): void {
	fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
	fs.writeFileSync(file, text, { mode: 0o600 });
}

function assertNoPathLeak(value: unknown, label: string): void {
	const serialized = JSON.stringify(value);
	for (const blockedPath of [tempHome, tempAgentsRoot, repoRoot, tempWorkspaceRoot]) {
		assert(!serialized.includes(blockedPath), `${label}: response must not leak absolute path ${blockedPath}`);
	}
	assert(!serialized.includes('"root"'), `${label}: response must not expose root field`);
	assert(!serialized.includes('"path"'), `${label}: response must not expose path field`);
}

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
		body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }),
	});
	assert(created.status === 201, `create room should succeed, got ${created.status}: ${JSON.stringify(created.body)}`);
	return String(created.body?.agent?.agentId ?? "");
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
			EXXETA_PERSISTENT_AGENTS_ROOT: tempAgentsRoot,
		},
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(server);

	const agentId = await createRoom("Lifecycle Smoke Room");
	assert(agentId === "lifecycle-smoke-room", `expected lifecycle-smoke-room id, got ${agentId}`);
	const encodedAgentId = encodeURIComponent(agentId);
	const agentRoot = path.join(tempAgentsRoot, agentId);

	// ── Seed the room's contents so every count is a real number ──────────────
	for (const threadId of ["lifecycle_thread_a", "lifecycle_thread_b"]) {
		writeJson(path.join(agentRoot, "runtime", "threads", `${threadId}.json`), {
			schemaVersion: 1,
			threadId,
			agentId,
			state: "standby",
			origin: "home",
			model: { provider: "synthetic", model: "lifecycle-smoke", label: "Lifecycle Smoke" },
			items: [{ kind: "user", id: "u1", text: "synthetic thread" }],
			createdAt: Date.now(),
			updatedAt: Date.now(),
		});
	}
	// Three memories: RC entries under the scaffolded Recent Context section.
	const l1bPath = path.join(agentRoot, "L1b", "current.md");
	const rcEntries = ["### RC-0001 | seeded", "note one", "", "### RC-0002 | seeded", "note two", "", "### RC-0003 | seeded", "note three", ""].join("\n");
	fs.writeFileSync(l1bPath, fs.readFileSync(l1bPath, "utf-8").replace(/^##\s+Recent Context\s*$/m, (heading) => `${heading}\n\n${rcEntries}`), { mode: 0o600 });
	// Two shelf files, one of them claimed by a ledger record = a document the
	// room created; the record also names the global task folder purge must drop.
	const taskId = "tsk-lifecycle1";
	writeText(path.join(agentRoot, "files", "report.html"), "<html>report</html>\n");
	writeText(path.join(agentRoot, "files", "notes.txt"), "user notes\n");
	writeJson(path.join(agentRoot, "runtime", "task-ledger", `${taskId}.json`), {
		schemaVersion: 1,
		taskId,
		roomId: agentId,
		conversationId: "lifecycle_thread_a",
		templateId: "artifact_report",
		templateVersion: 1,
		title: "Seeded report",
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		outcome: "ok",
		artifacts: [{ relativePath: "files/report.html", bytes: 20, extension: ".html" }],
	});
	const taskFolder = path.join(appStateDir, "artifacts", "tasks", taskId);
	writeText(path.join(taskFolder, "deck.html"), "<html>deck</html>\n");
	const foreignTaskFolder = path.join(appStateDir, "artifacts", "tasks", "tsk-other-room");
	writeText(path.join(foreignTaskFolder, "keep.html"), "<html>keep</html>\n");

	// ── Seed the per-room stores that live outside the room dir ──────────────
	// The schedules are deliberately OVERDUE: an interval whose anchor passed,
	// a one-shot whose time passed, and a daily cron whose occurrence passed —
	// restore must re-anchor all three instead of letting them fire on click.
	const nowIso = new Date().toISOString();
	const staleIso = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
	const scheduleJob = (overrides: Record<string, unknown>) => ({
		id: `sched_${crypto.randomBytes(16).toString("hex")}`,
		name: "Seeded schedule",
		enabled: true,
		prompt: "synthetic",
		createdAt: staleIso,
		updatedAt: staleIso,
		lastRunAt: null,
		lastStatus: "never_run",
		lastError: null,
		nextRunAt: null,
		...overrides,
	});
	const overdueIntervalJob = scheduleJob({ name: "Overdue interval", type: "interval", schedule: "1d", nextRunAt: staleIso });
	const missedOnceJob = scheduleJob({ name: "Missed one-shot", type: "once", schedule: staleIso, nextRunAt: staleIso });
	const overdueCronJob = scheduleJob({ name: "Overdue daily", type: "cron", schedule: "0 0 7 * * *" });
	writeJson(path.join(appStateDir, "persistent-room-schedules", agentId, "schedules.json"), {
		version: 1,
		roomId: agentId,
		jobs: [overdueIntervalJob, missedOnceJob, overdueCronJob],
	});
	writeText(path.join(appStateDir, "stream-traces", agentId, "lifecycle_thread_a.jsonl"), "{}\n");
	const runId = `bg_${crypto.randomBytes(16).toString("hex")}`;
	writeJson(path.join(appStateDir, "background-runs", "runs", runId, "run.json"), {
		schemaVersion: 1, runId, kind: "scheduled-prompt", status: "succeeded",
		scope: { kind: "persistent-room", roomId: agentId },
		createdAt: nowIso, updatedAt: nowIso, revision: 1,
	});
	const foreignRunId = `bg_${crypto.randomBytes(16).toString("hex")}`;
	writeJson(path.join(appStateDir, "background-runs", "runs", foreignRunId, "run.json"), {
		schemaVersion: 1, runId: foreignRunId, kind: "scheduled-prompt", status: "succeeded",
		scope: { kind: "persistent-room", roomId: "some-other-room" },
		createdAt: nowIso, updatedAt: nowIso, revision: 1,
	});
	// A workspace policy names a real user folder; purge must remove the policy
	// file with the room but never follow it into the folder it points at.
	const workspaceSentinel = path.join(tempWorkspaceRoot, "keep-me.txt");
	writeText(workspaceSentinel, "user data\n");
	writeJson(path.join(agentRoot, "runtime", "workspace-policies", "lifecycle_thread_a.json"), {
		schemaVersion: 1, policyId: "pol-lifecycle", agentId, conversationId: "lifecycle_thread_a",
		workspaceAccessMode: "bounded",
		roots: [{ id: "root-1", displayLabel: "Workspace", path: tempWorkspaceRoot, realpath: tempWorkspaceRoot, basename: path.basename(tempWorkspaceRoot), pathHash: "x", source: "manual", grantedAt: nowIso }],
		modes: { read: true, write: true }, allowedToolNames: [], deniedRoots: [], denySegments: [], denyFilenameGlobs: [],
		createdAt: nowIso, updatedAt: nowIso,
	});
	// Nothing under the agent-state side may be involved in a purge.
	const agentSideSentinel = path.join(tempHome, ".exxperts", "agent", "sentinel.txt");
	writeText(agentSideSentinel, "agent state\n");

	// ── Counts: the danger zone's numbers must be the seeded reality ─────────
	const counts = await requestJson(`/api/persistent-agents/${encodedAgentId}/lifecycle-counts`);
	assert(counts.status === 200, `lifecycle-counts should succeed, got ${counts.status}: ${JSON.stringify(counts.body)}`);
	assert(counts.body?.counts?.conversations === 2, `expected 2 conversations, got ${JSON.stringify(counts.body?.counts)}`);
	assert(counts.body?.counts?.memories === 3, `expected 3 memories, got ${JSON.stringify(counts.body?.counts)}`);
	assert(counts.body?.counts?.files === 2, `expected 2 files, got ${JSON.stringify(counts.body?.counts)}`);
	assert(counts.body?.counts?.documents === 1, `expected 1 room-made document, got ${JSON.stringify(counts.body?.counts)}`);
	assertNoPathLeak(counts.body, "lifecycle-counts");

	// ── Archive → archived listing carries the room with its counts ──────────
	let archivedList = await requestJson("/api/persistent-agents/archived");
	assert(archivedList.status === 200 && Array.isArray(archivedList.body) && archivedList.body.length === 0, `archived list should start empty, got ${JSON.stringify(archivedList.body)}`);
	const archive = await requestJson(`/api/persistent-agents/${encodedAgentId}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId}` }),
	});
	assert(archive.status === 200, `archive should succeed, got ${archive.status}: ${JSON.stringify(archive.body)}`);
	archivedList = await requestJson("/api/persistent-agents/archived");
	assert(archivedList.status === 200 && archivedList.body.length === 1, `archived list should carry the room, got ${JSON.stringify(archivedList.body)}`);
	const archivedRow = archivedList.body[0];
	assert(archivedRow.id === agentId, "archived row should carry the room id");
	assert(archivedRow.displayName === "Lifecycle Smoke Room", "archived row should carry the display name");
	assert(archivedRow.archivedAt === archive.body.archivedAt, "archived row should carry archivedAt");
	assert(archivedRow.counts?.memories === 3 && archivedRow.counts?.files === 2, `archived row should carry real counts, got ${JSON.stringify(archivedRow.counts)}`);
	assertNoPathLeak(archivedList.body, "archived list");

	// ── Restore: the room is back, its archive marks are gone, and no overdue
	//    schedule is allowed to fire the moment the user clicks Restore ───────
	const restoreStartedAt = Date.now();
	const restore = await requestJson(`/api/persistent-agents/${encodedAgentId}/restore`, { method: "POST", body: JSON.stringify({}) });
	assert(restore.status === 200, `restore should succeed, got ${restore.status}: ${JSON.stringify(restore.body)}`);
	assert(restore.body?.agentId === agentId && restore.body?.status === "ready", "restore should report the room ready");
	assert(restore.body?.enabledSchedules === 2, `interval + cron stay enabled, got ${JSON.stringify(restore.body)}`);
	assert(restore.body?.missedOnceSchedules === 1, `the past one-shot is reported missed, got ${JSON.stringify(restore.body)}`);
	assertNoPathLeak(restore.body, "restore");
	const reanchoredJobs = readJson(path.join(appStateDir, "persistent-room-schedules", agentId, "schedules.json")).jobs as any[];
	const reanchoredInterval = reanchoredJobs.find((job) => job.id === overdueIntervalJob.id);
	assert(reanchoredInterval.enabled === true, "the interval job stays enabled");
	assert(Date.parse(reanchoredInterval.nextRunAt) > restoreStartedAt, `the interval anchor must move into the future, got ${reanchoredInterval.nextRunAt}`);
	const missedOnce = reanchoredJobs.find((job) => job.id === missedOnceJob.id);
	assert(missedOnce.enabled === false, "the past one-shot must not stay enabled");
	assert(missedOnce.lastStatus === "missed", "the past one-shot is marked missed, not silently dropped");
	assert(typeof missedOnce.lastError === "string" && /new time/.test(missedOnce.lastError), `the missed one-shot explains it needs a new time, got ${missedOnce.lastError}`);
	const reanchoredCron = reanchoredJobs.find((job) => job.id === overdueCronJob.id);
	assert(reanchoredCron.enabled === true, "the daily cron stays enabled");
	assert(Date.parse(reanchoredCron.createdAt) >= restoreStartedAt, "the daily cron's occurrence fence must move to the restore moment");
	assert(reanchoredCron.lastStatus === "missed", "the skipped cron stretch is marked, not silent");
	const restoredMeta = readJson(path.join(agentRoot, "agent.json"));
	assert(restoredMeta.status === "ready", "agent.json should be ready again after restore");
	assert(restoredMeta.archivedAt === undefined && restoredMeta.archivedBy === undefined, "restore must drop the archive marks entirely");
	const listed = await requestJson("/api/persistent-agents");
	assert(listed.body.some((row: any) => row.id === agentId), "restored room should be back in the active list");
	archivedList = await requestJson("/api/persistent-agents/archived");
	assert(archivedList.body.length === 0, "archived list should be empty after restore");
	const restoreAgain = await requestJson(`/api/persistent-agents/${encodedAgentId}/restore`, { method: "POST", body: JSON.stringify({}) });
	assert(restoreAgain.status === 409, `restoring a live room should return 409, got ${restoreAgain.status}: ${JSON.stringify(restoreAgain.body)}`);

	// ── Purge guards ─────────────────────────────────────────────────────────
	const wrongPurge = await requestJson(`/api/persistent-agents/${encodedAgentId}/purge`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId}` }),
	});
	assert(wrongPurge.status === 400, `archive-grade confirmation must not purge, got ${wrongPurge.status}: ${JSON.stringify(wrongPurge.body)}`);
	assert(fs.existsSync(agentRoot), "failed confirmation must leave the room untouched");
	const lockPath = path.join(appStateDir, ".room-locks", `${agentId}.json`);
	writeJson(lockPath, { surface: "web", connectionId: "synthetic", host: os.hostname(), acquiredAt: Date.now(), lastSeen: Date.now() });
	const lockedPurge = await requestJson(`/api/persistent-agents/${encodedAgentId}/purge`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId} FOREVER` }),
	});
	assert(lockedPurge.status === 409, `purge under an active room lock should return 409, got ${lockedPurge.status}: ${JSON.stringify(lockedPurge.body)}`);
	assert(lockedPurge.body?.reason === "room_lock", `the lock refusal should carry its machine reason, got ${JSON.stringify(lockedPurge.body)}`);
	assert(fs.existsSync(agentRoot), "a locked room must survive the refused purge");
	assert(fs.existsSync(taskFolder), "a locked room's task folder must survive the refused purge");
	// A STALE lock (owner gone, lastSeen far past the web TTL) must not block —
	// and its file must be removed by the purge itself, which is only provable
	// when the file is still there going in.
	writeJson(lockPath, { surface: "web", connectionId: "synthetic", host: os.hostname(), acquiredAt: Date.now() - 600_000, lastSeen: Date.now() - 600_000 });

	// ── Purge an ACTIVE room: the room and its external stores go, nothing else ─
	const purge = await requestJson(`/api/persistent-agents/${encodedAgentId}/purge`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId} FOREVER` }),
	});
	assert(purge.status === 200, `purge should succeed, got ${purge.status}: ${JSON.stringify(purge.body)}`);
	assert(purge.body?.status === "purged" && purge.body?.agentId === agentId, "purge should report the purged room");
	assert(purge.body?.removedTaskFolders === 1, `purge should remove the room's one task folder, got ${JSON.stringify(purge.body)}`);
	assert(purge.body?.removedBackgroundRuns === 1, `purge should remove the room's one background run, got ${JSON.stringify(purge.body)}`);
	assert(Array.isArray(purge.body?.failed) && purge.body.failed.length === 0, `a clean purge reports an empty failed list, got ${JSON.stringify(purge.body)}`);
	assertNoPathLeak(purge.body, "purge");
	assert(!fs.existsSync(agentRoot), "purge must remove the room directory");
	assert(!fs.existsSync(lockPath), "purge must remove the room's stale lock file itself");
	assert(!fs.existsSync(taskFolder), "purge must remove the room's task folder from the global store");
	assert(fs.existsSync(foreignTaskFolder), "purge must leave other rooms' task folders alone");
	assert(!fs.existsSync(path.join(appStateDir, "persistent-room-schedules", agentId)), "purge must remove the room's schedule store");
	assert(!fs.existsSync(path.join(appStateDir, "stream-traces", agentId)), "purge must remove the room's stream traces");
	assert(!fs.existsSync(path.join(appStateDir, "background-runs", "runs", runId)), "purge must remove the room-scoped background run");
	assert(fs.existsSync(path.join(appStateDir, "background-runs", "runs", foreignRunId)), "purge must leave other rooms' background runs alone");
	assert(fs.existsSync(workspaceSentinel), "purge must never touch a workspace root the room's policies named");
	assert(fs.existsSync(agentSideSentinel), "purge must never touch the agent-state side");
	assert(!fs.readdirSync(tempAgentsRoot).some((name) => name.includes(".purging-")), "a clean purge must leave no tombstone behind");
	const purgedList = await requestJson("/api/persistent-agents");
	assert(!purgedList.body.some((row: any) => row.id === agentId), "purged room must be gone from the active list");
	const purgeMissing = await requestJson(`/api/persistent-agents/${encodedAgentId}/purge`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${agentId} FOREVER` }),
	});
	assert(purgeMissing.status === 404, `purging a purged room should return 404, got ${purgeMissing.status}: ${JSON.stringify(purgeMissing.body)}`);

	// ── Purge an ARCHIVED room: same ending from the other lifecycle state ────
	const archivedRoomId = await createRoom("Lifecycle Archived Room");
	const archivedRoomRoot = path.join(tempAgentsRoot, archivedRoomId);
	const archiveSecond = await requestJson(`/api/persistent-agents/${encodeURIComponent(archivedRoomId)}/archive`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${archivedRoomId}` }),
	});
	assert(archiveSecond.status === 200, `second archive should succeed, got ${archiveSecond.status}`);
	const purgeArchived = await requestJson(`/api/persistent-agents/${encodeURIComponent(archivedRoomId)}/purge`, {
		method: "POST",
		body: JSON.stringify({ confirmation: `DELETE ${archivedRoomId} FOREVER` }),
	});
	assert(purgeArchived.status === 200, `purging an archived room should succeed, got ${purgeArchived.status}: ${JSON.stringify(purgeArchived.body)}`);
	assert(!fs.existsSync(archivedRoomRoot), "purging an archived room must remove its directory");

	await stopSmokeServer(server);
	server = null;

	// ── In-process guards: turn in flight and detached cooking ───────────────
	// These live in the server process's memory, so they are pinned at module
	// level: same env contract as the server had, then the module directly.
	process.env.HOME = tempHome;
	process.env.USERPROFILE = tempHome;
	process.env.EXXETA_HOME = repoRoot;
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
	const agents = await import("../src/persistent-agents.js");
	const guardRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: "Lifecycle Guard Room", userName: "Synthetic User" } as any);
	const guardId = guardRoom.agent.agentId;
	const guardRoot = path.join(tempAgentsRoot, guardId);
	const guardThreadId = "lifecycle_guard_thread";
	writeJson(path.join(guardRoot, "runtime", "threads", `${guardThreadId}.json`), {
		schemaVersion: 1,
		threadId: guardThreadId,
		agentId: guardId,
		state: "standby",
		origin: "home",
		model: { provider: "synthetic", model: "lifecycle-smoke", label: "Lifecycle Smoke" },
		items: [{ kind: "user", id: "u1", text: "synthetic thread" }],
		createdAt: Date.now(),
		updatedAt: Date.now(),
	});
	// Hand-written like every smoke's runtime seed: the model-approval gate in
	// writePersistentAgentRuntimeState is out of scope here.
	writeJson(path.join(guardRoot, "runtime", "state.json"), {
		schemaVersion: 1,
		agentId: guardId,
		state: "active",
		activeThreadId: guardThreadId,
		model: { provider: "synthetic", model: "lifecycle-smoke", label: "Lifecycle Smoke" },
		updatedAt: Date.now(),
	});
	agents.beginPersistentAgentTurn(guardId, guardThreadId, { turnId: "turn_guard_1" });
	assert(agents.hasPersistentAgentTurnInFlight(guardId), "begun turn should register as in flight");
	try {
		agents.purgePersistentAgent(guardId, { confirmation: `DELETE ${guardId} FOREVER` });
		assert(false, "purge must refuse while a turn is in flight");
	} catch (error) {
		assert((error as any).statusCode === 409, `in-flight purge should be 409, got ${(error as any).statusCode}: ${(error as Error).message}`);
		assert(/in flight/.test((error as Error).message), `in-flight purge should say so, got: ${(error as Error).message}`);
	}
	assert(fs.existsSync(guardRoot), "an in-flight room must survive the refused purge");
	agents.finishPersistentAgentTurn(guardId, guardThreadId, { turnId: "turn_guard_1", terminalReason: "completed" });
	try {
		agents.purgePersistentAgent(guardId, { confirmation: `DELETE ${guardId} FOREVER`, detachedCooking: true });
		assert(false, "purge must refuse while the room is detached-cooking");
	} catch (error) {
		assert((error as any).statusCode === 409, `detached-cooking purge should be 409, got ${(error as any).statusCode}: ${(error as Error).message}`);
		assert(/background answer/.test((error as Error).message), `detached-cooking purge should say so, got: ${(error as Error).message}`);
	}
	assert(fs.existsSync(guardRoot), "a detached-cooking room must survive the refused purge");

	// Specialist tasks deliberately outlive their connection (option 4) and are
	// invisible to the lock/turn/detached guards — a worker finishing after the
	// purge would recreate the room dir as a ghost, so a running task refuses.
	const registry = await import("../src/persistent-room-specialist-registry.js");
	registry.registerSpecialistTask(guardId, {
		taskId: "tsk-guard-running",
		templateId: "artifact_report",
		templateVersion: 1,
		templateLabel: "Report",
		title: "Running guard task",
		model: null,
		abortController: new AbortController(),
	});
	try {
		agents.purgePersistentAgent(guardId, { confirmation: `DELETE ${guardId} FOREVER` });
		assert(false, "purge must refuse while a specialist task is running");
	} catch (error) {
		assert((error as any).statusCode === 409, `running-task purge should be 409, got ${(error as any).statusCode}: ${(error as Error).message}`);
		assert(/working in the background/.test((error as Error).message), `running-task purge should say so, got: ${(error as Error).message}`);
	}
	assert(fs.existsSync(guardRoot), "a room with a running task must survive the refused purge");
	registry.removeSpecialistTask(guardId, "tsk-guard-running");

	// The room dir leaves via an atomic rename: when the OS refuses THAT, the
	// purge aborts with the room fully intact — no half-eaten shell, no store
	// touched. chmod has no teeth on Windows or as root, so only forced here.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		fs.chmodSync(tempAgentsRoot, 0o500);
		let renameAborted = false;
		try {
			agents.purgePersistentAgent(guardId, { confirmation: `DELETE ${guardId} FOREVER` });
		} catch (error) {
			renameAborted = true;
			assert(/could not be detached/.test((error as Error).message), `the rename abort should say so, got: ${(error as Error).message}`);
			assert(!(error as Error).message.includes(tempAgentsRoot), "the rename abort must not leak paths");
		} finally {
			fs.chmodSync(tempAgentsRoot, 0o700);
		}
		assert(renameAborted, "a refused rename must abort the purge");
		assert(fs.existsSync(path.join(guardRoot, "agent.json")), "a refused rename leaves the room fully intact");
		assert(!fs.readdirSync(tempAgentsRoot).some((name) => name.includes(".purging-")), "a refused rename leaves no tombstone");
		assert(!fs.existsSync(path.join(appStateDir, ".room-locks", `${guardId}.json`)), "the aborted purge must release its own room lock");
	}

	// A tombstone a crash left behind is invisible to listings and swept at boot.
	const strandedTombstone = path.join(tempAgentsRoot, `${guardId}.purging-123`);
	writeText(path.join(strandedTombstone, "agent.json"), "{}\n");
	assert(!agents.listPersistentAgents().some((row) => row.id.includes("purging")), "a tombstone must never appear in the room listing");
	const swept = agents.sweepPersistentAgentPurgeTombstones();
	assert(swept >= 1, `the boot sweep should reclaim the stranded tombstone, got ${swept}`);
	assert(!fs.existsSync(strandedTombstone), "the swept tombstone must be gone");

	// A target the OS refuses AFTER the room dir is gone is reported, never
	// swallowed. chmod has no teeth on Windows, so the shape is only forced here.
	const guardTaskId = "tsk-guard-locked";
	writeJson(path.join(guardRoot, "runtime", "task-ledger", `${guardTaskId}.json`), {
		schemaVersion: 1,
		taskId: guardTaskId,
		roomId: guardId,
		conversationId: guardThreadId,
		templateId: "artifact_report",
		templateVersion: 1,
		title: "Locked task folder",
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
		outcome: "ok",
		artifacts: [{ relativePath: "files/locked.html", bytes: 10, extension: ".html" }],
	});
	const guardTasksRoot = path.join(appStateDir, "artifacts", "tasks");
	const guardTaskFolder = path.join(guardTasksRoot, guardTaskId);
	writeText(path.join(guardTaskFolder, "locked.html"), "<html>locked</html>\n");
	const forceFailure = canForceFsRefusal;
	if (forceFailure) fs.chmodSync(guardTasksRoot, 0o500);
	let guardPurge: ReturnType<typeof agents.purgePersistentAgent> | null = null;
	try {
		guardPurge = agents.purgePersistentAgent(guardId, { confirmation: `DELETE ${guardId} FOREVER` });
	} finally {
		if (forceFailure) fs.chmodSync(guardTasksRoot, 0o700);
	}
	assert(guardPurge !== null && guardPurge.status === "purged", "purge should succeed once the room is quiet");
	assert(!fs.existsSync(guardRoot), "the quiet purge must remove the room directory");
	if (forceFailure) {
		assert(guardPurge.failed.some((entry) => entry.target === `tasks/${guardTaskId}` && typeof entry.reason === "string" && entry.reason.length > 0), `the refused task folder must be reported, got ${JSON.stringify(guardPurge.failed)}`);
		assert(!JSON.stringify(guardPurge.failed).includes(tempHome), "failure reasons must never carry absolute paths");
		fs.rmSync(guardTaskFolder, { recursive: true, force: true });
	} else {
		assert(guardPurge.failed.length === 0, "with nothing refusing, the failed list stays empty");
	}

	console.log("persistent-agent lifecycle smoke passed");
} catch (error) {
	const output = serverOutput.join("").trim();
	if (output) console.error(output.split("\n").slice(-80).join("\n"));
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp HOME preserved for inspection: ${tempHome}`);
	console.error(`temp agents root preserved for inspection: ${tempAgentsRoot}`);
	process.exitCode = 1;
} finally {
	await stopSmokeServer(server);
	if (process.exitCode == null || process.exitCode === 0) {
		fs.rmSync(tempHome, { recursive: true, force: true });
		fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
		fs.rmSync(tempWorkspaceRoot, { recursive: true, force: true });
	}
}
