// A room held open through several due times, a free room beside it, and runs of a deleted and a switched-off task:
// the scheduler's tick runs each task once, never lets one held room hold up another, and clears ended tasks at once.
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

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-held-room-runs-"));
const tempHome = path.join(tmp, "home");
const appDir = path.join(tempHome, ".exxperts", "app");
const agentRuntimeRoot = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(path.join(appDir, "personalized-agents"), { recursive: true, mode: 0o700 });
fs.mkdirSync(agentRuntimeRoot, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentRuntimeRoot;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(appDir, "personalized-agents");
process.env.EXXETA_HOME = repoRoot;
writeJson(path.join(appDir, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" });
writeJson(path.join(appDir, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
writeJson(path.join(agentRuntimeRoot, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "https://synthetic.invalid/v1", api: "openai-completions", models: [{ id: "gpt-5.5", name: "GPT 5.5" }] } } });
writeJson(path.join(agentRuntimeRoot, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-key" } });

try {
	const { createBackgroundRun, listBackgroundRuns, listBackgroundRunsWithNewestPerSchedule, readBackgroundRun } = await import("../src/background-runs.js");
	const { buildPersistentRoomBackgroundRunsResponse } = await import("../src/persistent-room-background-run-history.js");
	const { createScheduledPromptBackgroundRunPreflight } = await import("../src/scheduled-prompt-runs.js");
	const { scanPersistentRoomScheduleDueRuns } = await import("../src/persistent-room-schedule-due-scan.js");
	const { processScheduledPromptBackgroundRunExecutionOnce } = await import("../src/scheduled-prompt-background-execution.js");
	const { createPersistentAgentFromScaffoldInput, writePersistentAgentThread } = await import("../src/persistent-agents.js");
	const { scheduledPromptBackgroundAssistantItemId, scheduledPromptBackgroundThreadId } = await import("../src/persistent-room-background-execution.js");
	const { addPersistentRoomScheduleJob, removePersistentRoomScheduleJob, updatePersistentRoomScheduleJob } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const { writeScheduledPromptBackgroundRunOutputArtifact } = await import("../src/scheduled-prompt-background-artifacts.js");
	const { formatFriendlyRunReason, recentRunReason } = await import("../../web-ui/src/scheduled-run-reason.js");
	// A page component (.tsx): loaded at run time, as the server build compiles scripts without JSX.
	const { findRelevantRunForJob, latestRunsBySchedule, recentScheduledRuns }: any = await import(new URL("../../web-ui/src/components/RoomScheduledTasksSection.tsx", import.meta.url).href);

	const roomInUse = formatFriendlyRunReason({ status: "deferred", reason: "room_in_use" });
	assert(roomInUse, "the pane has a line for a room in use");

	const calls = new Map<string, number>();
	// What happens elsewhere while a room's turn runs, by room.
	const whileRunning = new Map<string, () => void>();
	const fakeExecute = async (input: any) => {
		calls.set(input.roomId, (calls.get(input.roomId) ?? 0) + 1);
		whileRunning.get(input.roomId)?.();
		return { roomId: input.roomId, threadId: `held_${input.executionId.slice(3, 15)}`, targetKind: input.target.kind, model: input.target.model, assistantText: "ok" };
	};
	const tick = (now: Date, limit = 1) => processScheduledPromptBackgroundRunExecutionOnce({ workerId: "scheduler-execution:smoke:held-room", now, limit, leaseMs: 60_000, heartbeatMs: 30_000, executePrompt: fakeExecute as any });
	const createRoom = (displayName: string) => String(createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	const runsOf = (roomId: string) => listBackgroundRuns({ scope: { kind: "persistent-room", roomId }, limit: 1000 });
	const pending = (roomId: string) => runsOf(roomId).filter((run) => run.status === "queued" || run.status === "deferred");
	// Ana's tab: the room's lock, as an open page holds it.
	const lockFile = (roomId: string) => path.join(appDir, ".room-locks", `${roomId}.json`);
	const hold = (roomId: string) => writeJson(lockFile(roomId), { surface: "web", pid: process.pid, connectionId: "held-room-smoke", host: os.hostname(), label: "smoke", acquiredAt: Date.now(), lastSeen: Date.now() });
	// What the Scheduled tasks pane reads for a room, as its runs route answers.
	function paneRuns(roomId: string): any {
		const history = listBackgroundRunsWithNewestPerSchedule({ scope: { kind: "persistent-room", roomId }, limit: 50 });
		return buildPersistentRoomBackgroundRunsResponse(roomId, history.runs, { limit: 50 }, history.newestPerSchedule);
	}
	// What the pane shows for a room: each task's row, and its Recent runs list.
	function paneLines(roomId: string, job: any): string[] {
		const response = paneRuns(roomId);
		const row = findRelevantRunForJob(job, latestRunsBySchedule(response));
		return [row && row.status !== "succeeded" ? formatFriendlyRunReason(row) : null, ...recentScheduledRuns(response).slice(0, 3).map((run: any) => recentRunReason(run))].filter((line): line is string => !!line);
	}

	const t0 = new Date("2026-03-02T09:00:00.000Z");
	const at = (minutes: number, seconds = 0) => new Date(t0.getTime() + minutes * 60_000 + seconds * 1000);
	const salesReview = createRoom("Sales Review");
	const weeklyReport = createRoom("Weekly Report");
	const salesJob = addPersistentRoomScheduleJob(salesReview, { name: "Sales check", type: "interval", schedule: "15m", prompt: "Check the sales numbers.", now: t0 });
	// Due half a minute after the held room's task, so the held room's waiting runs are always the older ones.
	addPersistentRoomScheduleJob(weeklyReport, { name: "Report", type: "interval", schedule: "15m", prompt: "Update the report.", now: at(0, 30) });

	// Row 1: Sales Review is held through five due times; Weekly Report's task runs on its own time all the while.
	hold(salesReview);
	for (let occurrence = 1; occurrence <= 5; occurrence += 1) {
		const now = at(occurrence * 15, 45);
		hold(salesReview);
		scanPersistentRoomScheduleDueRuns({ roomId: salesReview, now });
		scanPersistentRoomScheduleDueRuns({ roomId: weeklyReport, now });
		const summary = await tick(now);
		assert(calls.get(weeklyReport) === occurrence, `while Sales Review is held, Weekly Report's run ${occurrence} runs on its own time, got ${calls.get(weeklyReport) ?? 0} run(s): ${JSON.stringify(summary.processed)}`);
		assert(!calls.has(salesReview), "the held room's task does not run while the room is held");
	}
	const salesRuns = runsOf(salesReview);
	assert(salesRuns.length === 5, `five due times made five runs, got ${salesRuns.length}`);
	assert(pending(salesReview).length === 1, `only the newest run still waits, got ${pending(salesReview).length}`);
	const waiting = pending(salesReview)[0];
	assert(waiting.source.dueAt === at(75).toISOString(), `the run that waits is the newest, got ${waiting.source.dueAt}`);
	assert(salesRuns.filter((run) => run.runId !== waiting.runId).every((run) => run.status === "cancelled" && run.reason === "superseded_by_later_run"), `the older runs end superseded, got ${salesRuns.map((run) => `${run.status}/${run.reason}`).join(",")}`);
	assert(paneLines(salesReview, salesJob).includes(roomInUse), `while held, the pane says the room is in use, got ${JSON.stringify(paneLines(salesReview, salesJob))}`);

	// A waiting run waits a minute before it is tried again while its room stays held.
	const updatedAt = new Date(readBackgroundRun(waiting.runId).updatedAt).getTime();
	const attemptsBefore = readBackgroundRun(waiting.runId).attempts;
	hold(salesReview);
	await tick(new Date(updatedAt + 30_000));
	assert(readBackgroundRun(waiting.runId).attempts === attemptsBefore, "half a minute later, the held room's run is not tried again");
	await tick(new Date(updatedAt + 61_000));
	const retried = readBackgroundRun(waiting.runId);
	assert(retried.attempts === attemptsBefore + 1 && retried.status === "deferred" && retried.reason === "room_in_use", `a minute later it is tried again and still waits, got ${retried.status}/${retried.reason} after ${retried.attempts} attempt(s)`);

	// Ana closes the room: the next tick runs the task once, and the pane no longer says the room is in use.
	fs.rmSync(lockFile(salesReview), { force: true });
	const closedAt = new Date(retried.updatedAt).getTime();
	await tick(new Date(closedAt + 5_000));
	assert(calls.get(salesReview) === 1, `the first tick after the room closes runs its task, got ${calls.get(salesReview) ?? 0} run(s)`);
	for (let seconds = 20; seconds <= 80; seconds += 15) await tick(new Date(closedAt + seconds * 1000));
	assert(calls.get(salesReview) === 1, `held through five due times, the task runs once, got ${calls.get(salesReview)} run(s)`);
	assert(readBackgroundRun(waiting.runId).status === "succeeded", `the newest run is the one that ran, got ${readBackgroundRun(waiting.runId).status}`);
	const linesAfter = paneLines(salesReview, salesJob);
	assert(!linesAfter.includes(roomInUse), `after the room closes, the pane no longer says it is in use, got ${JSON.stringify(linesAfter)}`);
	const listedAfter = recentScheduledRuns(paneRuns(salesReview));
	assert(listedAfter.length === 1 && listedAfter[0].runId === waiting.runId, `after the room closes, Recent runs lists the one run that ran and none it replaced, got ${listedAfter.map((run: any) => `${run.status}/${run.reason}`).join(",")}`);

	// Row 2: sixty runs of a deleted task and sixty of a switched-off task clear in one tick.
	const drainRoom = createRoom("Drain Room");
	const deletedJob = addPersistentRoomScheduleJob(drainRoom, { name: "Deleted", type: "interval", schedule: "1m", prompt: "Deleted task.", now: t0 });
	const offJob = addPersistentRoomScheduleJob(drainRoom, { name: "Switched off", type: "interval", schedule: "1m", prompt: "Switched-off task.", now: t0 });
	for (let minute = 1; minute <= 60; minute += 1) {
		for (const job of [deletedJob, offJob]) createScheduledPromptBackgroundRunPreflight({ roomId: drainRoom, scheduleJobId: job.id, dueAt: at(minute).toISOString(), now: at(minute) });
	}
	assert(pending(drainRoom).length === 120, `sixty runs of each task wait, got ${pending(drainRoom).length}`);
	removePersistentRoomScheduleJob(drainRoom, { jobId: deletedJob.id });
	updatePersistentRoomScheduleJob(drainRoom, { jobId: offJob.id }, { enabled: false, now: at(61) });
	await tick(at(200));
	assert(pending(drainRoom).length === 0, `one tick clears them all, ${pending(drainRoom).length} still wait`);
	assert(!calls.has(drainRoom), "an ended task's runs never run");
	const newest = (jobId: string) => runsOf(drainRoom).find((run) => run.source.schedulerJobId === jobId && run.source.dueAt === at(60).toISOString())!;
	assert(newest(deletedJob.id).reason === "schedule_missing" && newest(offJob.id).reason === "schedule_disabled", `each task's newest run says why it did not run, got ${newest(deletedJob.id).reason}, ${newest(offJob.id).reason}`);
	// A task switched off while its room is held: its waiting runs clear in the next tick too, not a minute later.
	const heldOffRoom = createRoom("Held Off Room");
	const heldOffJob = addPersistentRoomScheduleJob(heldOffRoom, { name: "Held off", type: "interval", schedule: "1m", prompt: "Held-off task.", now: t0 });
	hold(heldOffRoom);
	for (let minute = 1; minute <= 3; minute += 1) createScheduledPromptBackgroundRunPreflight({ roomId: heldOffRoom, scheduleJobId: heldOffJob.id, dueAt: at(minute).toISOString(), now: at(minute) });
	assert(pending(heldOffRoom).length === 3 && pending(heldOffRoom).every((run) => run.reason === "room_in_use"), "three runs wait for the held room");
	updatePersistentRoomScheduleJob(heldOffRoom, { jobId: heldOffJob.id }, { enabled: false, now: at(3, 5) });
	await tick(at(3, 10));
	assert(pending(heldOffRoom).length === 0, `the next tick clears a switched-off task's runs while its room is held, ${pending(heldOffRoom).map((run) => `${run.status}/${run.reason}`).join(",")} still wait`);
	fs.rmSync(lockFile(heldOffRoom), { force: true });

	// A newer run of a task that comes due while another room's turn runs takes the older one's place in the same tick.
	const firstRoom = createRoom("First Room");
	const secondRoom = createRoom("Second Room");
	const firstJob = addPersistentRoomScheduleJob(firstRoom, { name: "First", type: "once", schedule: at(400).toISOString(), prompt: "First task.", now: t0 });
	const secondJob = addPersistentRoomScheduleJob(secondRoom, { name: "Second", type: "interval", schedule: "1m", prompt: "Second task.", now: t0 });
	createScheduledPromptBackgroundRunPreflight({ roomId: firstRoom, scheduleJobId: firstJob.id, dueAt: at(400).toISOString(), now: at(400) });
	const olderSecond = createScheduledPromptBackgroundRunPreflight({ roomId: secondRoom, scheduleJobId: secondJob.id, dueAt: at(401).toISOString(), now: at(401) }).run;
	let newerSecond: any = null;
	whileRunning.set(firstRoom, () => { newerSecond = createScheduledPromptBackgroundRunPreflight({ roomId: secondRoom, scheduleJobId: secondJob.id, dueAt: at(402).toISOString(), now: at(402) }).run; });
	await tick(at(402, 30), 2);
	assert(calls.get(firstRoom) === 1 && newerSecond, "the first room's task ran, and the second task came due meanwhile");
	assert(readBackgroundRun(olderSecond.runId).status === "cancelled" && readBackgroundRun(olderSecond.runId).reason === "superseded_by_later_run", `the older run gives way in the same tick, got ${readBackgroundRun(olderSecond.runId).status}/${readBackgroundRun(olderSecond.runId).reason}`);
	await tick(at(403));
	assert(calls.get(secondRoom) === 1 && readBackgroundRun(newerSecond.runId).status === "succeeded", `the second task runs once, its newer run, got ${calls.get(secondRoom) ?? 0} run(s)`);

	// An older run whose answer already reached the room is never superseded: it ends already completed.
	const landedRoom = createRoom("Landed Room");
	const landedJob = addPersistentRoomScheduleJob(landedRoom, { name: "Landed", type: "interval", schedule: "1m", prompt: "Landed task.", now: t0 });
	const landed = createScheduledPromptBackgroundRunPreflight({ roomId: landedRoom, scheduleJobId: landedJob.id, dueAt: at(500).toISOString(), now: at(500) }).run;
	writeScheduledPromptBackgroundRunOutputArtifact({ run: landed, assistantText: "The answer that landed.", completedAt: at(500, 30) });
	writePersistentAgentThread(landedRoom, scheduledPromptBackgroundThreadId(landed.runId), { state: "standby", origin: "home", model: { provider: "openai-compatible", model: "gpt-5.5" }, items: [{ kind: "assistant", id: scheduledPromptBackgroundAssistantItemId(landed.runId), text: "The answer that landed.", streaming: false }] });
	const landedNewer = createScheduledPromptBackgroundRunPreflight({ roomId: landedRoom, scheduleJobId: landedJob.id, dueAt: at(501).toISOString(), now: at(501) }).run;
	await tick(at(501, 30));
	assert(readBackgroundRun(landed.runId).status === "succeeded" && readBackgroundRun(landed.runId).reason === "already_completed" && !calls.has(landedRoom), `a run whose answer landed ends already completed, got ${readBackgroundRun(landed.runId).status}/${readBackgroundRun(landed.runId).reason}`);
	await tick(at(502));
	assert(calls.get(landedRoom) === 1 && readBackgroundRun(landedNewer.runId).status === "succeeded", "the newer run of that task runs next");

	// However many runs of a task wait, 1001 left from before an update for instance, only the newest runs.
	const backlogRoom = createRoom("Backlog Room");
	const backlogJob = addPersistentRoomScheduleJob(backlogRoom, { name: "Backlog", type: "interval", schedule: "1m", prompt: "Backlog task.", now: t0 });
	const firstBacklog = createScheduledPromptBackgroundRunPreflight({ roomId: backlogRoom, scheduleJobId: backlogJob.id, dueAt: at(1000).toISOString(), now: at(1000) }).run;
	let newestBacklog = firstBacklog;
	for (let minute = 1001; minute <= 2000; minute += 1) {
		newestBacklog = createBackgroundRun({ kind: "scheduled-prompt", scope: firstBacklog.scope, source: { schedulerJobId: backlogJob.id, trigger: "schedule-due", dueAt: at(minute).toISOString() }, status: "queued", reason: firstBacklog.reason, target: firstBacklog.target, now: at(minute) });
	}
	await tick(at(2000, 30));
	assert(calls.get(backlogRoom) === 1 && readBackgroundRun(newestBacklog.runId).status === "succeeded" && pending(backlogRoom).length === 0, `the newest of 1001 runs is the one that runs, got ${calls.get(backlogRoom) ?? 0} run(s), newest ${readBackgroundRun(newestBacklog.runId).status}, ${pending(backlogRoom).length} still wait`);

	// A free room's task, due in the same tick, still runs.
	const freeRoom = createRoom("Free Room");
	const freeJob = addPersistentRoomScheduleJob(freeRoom, { name: "Free", type: "once", schedule: at(300).toISOString(), prompt: "Free task.", now: t0 });
	scanPersistentRoomScheduleDueRuns({ roomId: freeRoom, now: at(301) });
	await tick(at(301));
	assert(calls.get(freeRoom) === 1 && runsOf(freeRoom)[0]?.source.schedulerJobId === freeJob.id, "a free room's task runs on its time");

	console.log("scheduled runs held-room smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
