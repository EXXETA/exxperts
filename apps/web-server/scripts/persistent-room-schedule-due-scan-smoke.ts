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

function readIfExists(file: string): string | null {
	return fs.existsSync(file) ? fs.readFileSync(file, "utf-8") : null;
}

function runtimeThreadFiles(tempAgentsRoot: string, roomId: string): string[] {
	const threadsDir = path.join(tempAgentsRoot, roomId, "runtime", "threads");
	return fs.existsSync(threadsDir) ? fs.readdirSync(threadsDir).filter((name) => name.endsWith(".json")).sort() : [];
}

function countBackgroundRunFiles(tempHome: string): number {
	return listFilesRecursive(path.join(tempHome, ".exxperts", "app", "background-runs", "runs")).filter((file) => path.basename(file) === "run.json").length;
}

function assertNoPromptLeak(value: unknown, promptText: string, label: string): void {
	assert(!JSON.stringify(value).includes(promptText), `${label}: due-scan/run data must not contain prompt text`);
}

function assertRunNoPromptLeak(run: { message?: string; artifacts?: { inputRelPath?: string; outputRelPath?: string; eventRelPath?: string } }, promptText: string, label: string): void {
	assert(!String(run.message ?? "").includes(promptText), `${label}: run message must not contain prompt text`);
	assert(run.artifacts?.inputRelPath === undefined, `${label}: due scan must not write input prompt artifacts`);
	assert(run.artifacts?.outputRelPath === undefined, `${label}: due scan must not write output prompt artifacts`);
}

function localDate(year: number, monthIndex: number, day: number, hour: number, minute = 0): Date {
	return new Date(year, monthIndex, day, hour, minute, 0, 0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-due-scan-"));
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
	const { findBackgroundRunByScheduledOccurrence, listBackgroundRuns, readBackgroundRun, createBackgroundRun } = await import("../src/background-runs.js");
	const { buildPersistentRoomBackgroundRunsResponse } = await import("../src/persistent-room-background-run-history.js");
	const { scanPersistentRoomScheduleDueRuns } = await import("../src/persistent-room-schedule-due-scan.js");
	const { writePersistentAgentAiProfileState } = await import("../src/persistent-agent-ai-profile-state.js");
	const {
		addPersistentRoomScheduleJob,
		computePersistentRoomScheduleDueOccurrence,
		persistentRoomScheduleCanRun,
		persistentRoomScheduleStorePath,
		readPersistentRoomScheduleStore,
		updatePersistentRoomScheduleJob,
	} = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		beginPersistentAgentTurn,
		createPersistentAgentFromScaffoldInput,
		finishPersistentAgentTurn,
		getPersistentAgentRuntimeState,
		writePersistentAgentThread,
	} = await import("../src/persistent-agents.js");

	writePersistentAgentAiProfileState("openai-compatible");

	const promptText = "SYNTHETIC_DUE_SCAN_SECRET_PROMPT_DO_NOT_COPY";
	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const scanNow = new Date("2026-01-01T01:00:00.000Z");
	const createdRoomIds: string[] = [];
	const createdRunIds: string[] = [];
	const threadSnapshots = new Map<string, string>();

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

	function scanWithStoreUnchanged(roomId: string, input: { now: Date; dryRun?: boolean; limit?: number }, label: string) {
		const storePath = persistentRoomScheduleStorePath(roomId);
		const before = readIfExists(storePath);
		const result = scanPersistentRoomScheduleDueRuns({ roomId, ...input });
		const after = readIfExists(storePath);
		assert(after === before, `${label}: due scan must not mutate schedule store`);
		assertNoPromptLeak(result, promptText, `${label}: result`);
		return result;
	}

	function rememberThreads(roomId: string): void {
		threadSnapshots.set(roomId, runtimeThreadFiles(tempAgentsRoot, roomId).join(","));
	}

	function assertNoUnexpectedRuntimeSideEffects(label: string): void {
		for (const roomId of createdRoomIds) {
			const before = threadSnapshots.get(roomId) ?? "";
			const after = runtimeThreadFiles(tempAgentsRoot, roomId).join(",");
			assert(after === before, `${label}: due scan must not create/remove runtime threads for ${roomId}; before=${before} after=${after}`);
		}
		const jsonlFiles = listFilesRecursive(tempHome).filter((file) => file.endsWith(".jsonl"));
		assert(jsonlFiles.length === 0, `${label}: due scan must not create Pi JSONL sessions, found ${jsonlFiles.join(",")}`);
		assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "auth.json")), `${label}: due scan must not create/read runtime auth state`);
		assert(!fs.existsSync(path.join(tempAgentRuntimeRoot, "models.json")), `${label}: due scan must not create/read runtime model state`);
		assert(!fs.existsSync(path.join(tempHome, ".exxeta")), `${label}: due scan must not create legacy ~/.exxeta state`);
	}

	function rememberRun(runId: string | undefined, label: string): string {
		assert(runId, `${label}: expected run id`);
		createdRunIds.push(runId);
		return runId;
	}

	const onceRoom = createRoom("Due Scan Once Room");
	const onceJob = addSchedule(onceRoom, "once due");
	rememberThreads(onceRoom);
	const onceResult = scanWithStoreUnchanged(onceRoom, { now: scanNow }, "once due");
	assert(onceResult.summary.scanned === 1 && onceResult.summary.enabled === 1, "once due should scan one enabled schedule");
	assert(onceResult.summary.due === 1 && onceResult.summary.created === 1 && onceResult.summary.queued === 1, "once due should create one queued preflight record");
	assert(onceResult.items[0]?.action === "created" && onceResult.items[0]?.dueAt === onceJob.nextRunAt, "once due item should report created due occurrence");
	const onceRunId = rememberRun(onceResult.items[0]?.runId, "once due");
	const onceRun = readBackgroundRun(onceRunId);
	assert(onceRun.source.trigger === "schedule-due", "once due run should persist schedule-due trigger");
	assert(onceRun.source.schedulerJobId === onceJob.id && onceRun.source.dueAt === onceJob.nextRunAt, "once due run should persist schedule id and dueAt");
	assertRunNoPromptLeak(onceRun, promptText, "once due run");

	const duplicateResult = scanWithStoreUnchanged(onceRoom, { now: scanNow }, "duplicate once");
	assert(duplicateResult.summary.created === 0 && duplicateResult.summary.duplicates === 1, "second scan should suppress duplicate once occurrence");
	assert(duplicateResult.items[0]?.action === "duplicate" && duplicateResult.items[0]?.duplicateRunId === onceRunId, "duplicate item should reference original run");
	assert(countBackgroundRunFiles(tempHome) === 1, "duplicate scan must not create a second run");

	const cancelledDuplicateRoom = createRoom("Due Scan Cancelled Duplicate Room");
	const cancelledDuplicateJob = addSchedule(cancelledDuplicateRoom, "cancelled duplicate");
	rememberThreads(cancelledDuplicateRoom);
	const cancelledDuplicate = createBackgroundRun({
		kind: "scheduled-prompt",
		scope: { kind: "persistent-room", roomId: cancelledDuplicateRoom },
		source: { trigger: "schedule-due", schedulerJobId: cancelledDuplicateJob.id, dueAt: cancelledDuplicateJob.nextRunAt },
		status: "cancelled",
		reason: "synthetic_cancelled_duplicate",
		message: "Synthetic cancelled duplicate occurrence.",
		target: { kind: "none", roomId: cancelledDuplicateRoom },
		warnings: [],
		now: scanNow,
	});
	const cancelledDuplicateResult = scanWithStoreUnchanged(cancelledDuplicateRoom, { now: scanNow }, "cancelled duplicate");
	assert(cancelledDuplicateResult.summary.created === 0 && cancelledDuplicateResult.summary.duplicates === 1, "cancelled existing occurrence should suppress duplicate creation");
	assert(cancelledDuplicateResult.items[0]?.duplicateRunId === cancelledDuplicate.runId, "duplicate lookup should match cancelled occurrences too");

	const futureRoom = createRoom("Due Scan Future Once Room");
	addSchedule(futureRoom, "once future", { schedule: "+2h" });
	rememberThreads(futureRoom);
	const futureCountBefore = countBackgroundRunFiles(tempHome);
	const futureResult = scanWithStoreUnchanged(futureRoom, { now: scanNow }, "once future");
	assert(futureResult.summary.notDue === 1 && futureResult.items[0]?.action === "not_due", "future once schedule should be not_due");
	assert(countBackgroundRunFiles(tempHome) === futureCountBefore, "future once must not create a run");

	const disabledRoom = createRoom("Due Scan Disabled Room");
	addSchedule(disabledRoom, "disabled due", { enabled: false });
	rememberThreads(disabledRoom);
	const disabledCountBefore = countBackgroundRunFiles(tempHome);
	const disabledResult = scanWithStoreUnchanged(disabledRoom, { now: scanNow }, "disabled due");
	assert(disabledResult.summary.enabled === 0 && disabledResult.summary.skipped === 1, "disabled due schedule should be skipped before preflight");
	assert(disabledResult.items[0]?.action === "skipped" && disabledResult.items[0]?.reason === "disabled", "disabled due item should report disabled skip");
	assert(countBackgroundRunFiles(tempHome) === disabledCountBefore, "disabled due must not create a blocked preflight record");

	const dryRunRoom = createRoom("Due Scan Dry Run Room");
	addSchedule(dryRunRoom, "dry run due");
	rememberThreads(dryRunRoom);
	const dryCountBefore = countBackgroundRunFiles(tempHome);
	const dryRunResult = scanWithStoreUnchanged(dryRunRoom, { now: scanNow, dryRun: true }, "dry run");
	assert(dryRunResult.dryRun === true && dryRunResult.summary.due === 1 && dryRunResult.summary.created === 0, "dry-run should detect due schedule without creating a record");
	assert(dryRunResult.items[0]?.action === "dry_run" && dryRunResult.items[0]?.reason === "would_create", "dry-run item should report would_create");
	assert(countBackgroundRunFiles(tempHome) === dryCountBefore, "dry-run must not create background-run records");

	const limitRoom = createRoom("Due Scan Limit Room");
	addSchedule(limitRoom, "limit due one");
	addSchedule(limitRoom, "limit due two");
	addSchedule(limitRoom, "limit due three");
	rememberThreads(limitRoom);
	const limitResult = scanWithStoreUnchanged(limitRoom, { now: scanNow, limit: 1 }, "limit");
	assert(limitResult.limit === 1 && limitResult.summary.due === 3 && limitResult.summary.created === 1, "limit scan should create only one due record");
	assert(limitResult.items.filter((item: any) => item.reason === "limit_reached").length === 2, "limit scan should report remaining due schedules as limit_reached");
	rememberRun(limitResult.items.find((item: any) => item.action === "created")?.runId, "limit created");

	const dailyDueRoom = createRoom("Due Scan Daily Due Room");
	const dailyDueJob = addSchedule(dailyDueRoom, "daily due", { type: "cron", schedule: "0 0 7 * * *", now: localDate(2026, 0, 1, 6) });
	rememberThreads(dailyDueRoom);
	const dailyDueResult = scanWithStoreUnchanged(dailyDueRoom, { now: localDate(2026, 0, 1, 8) }, "daily due");
	assert(dailyDueResult.summary.created === 1 && dailyDueResult.items[0]?.action === "created", "simple daily cron after occurrence should create a run");
	assert(dailyDueResult.items[0]?.type === "cron" && Boolean(dailyDueResult.items[0]?.dueAt), "daily due item should include cron dueAt");
	assert(new Date(String(dailyDueResult.items[0]?.dueAt)).getTime() <= localDate(2026, 0, 1, 8).getTime(), "daily dueAt should be at or before scan now");
	const dailyDueRunId = rememberRun(dailyDueResult.items[0]?.runId, "daily due");
	assert(findBackgroundRunByScheduledOccurrence({ roomId: dailyDueRoom, schedulerJobId: dailyDueJob.id, dueAt: dailyDueResult.items[0]?.dueAt })?.runId === dailyDueRunId, "daily due record should be findable by exact occurrence");

	const dailyAfterCreationRoom = createRoom("Due Scan Daily No Retro Room");
	addSchedule(dailyAfterCreationRoom, "daily no retro", { type: "cron", schedule: "0 0 7 * * *", now: localDate(2026, 0, 1, 8) });
	rememberThreads(dailyAfterCreationRoom);
	const dailyAfterCreationCount = countBackgroundRunFiles(tempHome);
	const dailyAfterCreationResult = scanWithStoreUnchanged(dailyAfterCreationRoom, { now: localDate(2026, 0, 1, 9) }, "daily no retro");
	assert(dailyAfterCreationResult.summary.notDue === 1, "daily scan must not create retrospective dueAt before schedule creation");
	assert(countBackgroundRunFiles(tempHome) === dailyAfterCreationCount, "daily no-retro case must not create a run");

	const dailyFutureRoom = createRoom("Due Scan Daily Future Today Room");
	addSchedule(dailyFutureRoom, "daily future today", { type: "cron", schedule: "0 0 7 * * *", now: localDate(2026, 0, 1, 6) });
	rememberThreads(dailyFutureRoom);
	const dailyFutureCount = countBackgroundRunFiles(tempHome);
	const dailyFutureResult = scanWithStoreUnchanged(dailyFutureRoom, { now: localDate(2026, 0, 1, 6, 30) }, "daily future today");
	assert(dailyFutureResult.summary.notDue === 1, "daily scan before today's first occurrence should be not_due");
	assert(countBackgroundRunFiles(tempHome) === dailyFutureCount, "daily future-today case must not create a run");

	// Weekly: the latest chosen day at its time, in the server's own zone (local dates here), never another day,
	// and, as a daily schedule, never more than a day late. `2026-01-01` is a Thursday, so `2026-01-05` is a Monday.
	const weeklyCreatedAt = localDate(2026, 0, 1, 6);
	const weeklyRows: Array<{ label: string; schedule: string; now: Date; dueAt: Date | null }> = [
		{ label: "a list", schedule: "0 30 8 * * 1,3,5", now: localDate(2026, 0, 8, 7), dueAt: localDate(2026, 0, 7, 8, 30) },
		{ label: "a range", schedule: "0 30 8 * * 1-5", now: localDate(2026, 0, 10, 7), dueAt: localDate(2026, 0, 9, 8, 30) },
		{ label: "a range and a day", schedule: "0 30 8 * * 1-3,5", now: localDate(2026, 0, 8, 7), dueAt: localDate(2026, 0, 7, 8, 30) },
		{ label: "one day", schedule: "0 30 8 * * 3", now: localDate(2026, 0, 7, 12), dueAt: localDate(2026, 0, 7, 8, 30) },
		{ label: "Sunday as 0", schedule: "0 30 8 * * 0", now: localDate(2026, 0, 5, 7), dueAt: localDate(2026, 0, 4, 8, 30) },
		{ label: "Sunday as 7", schedule: "0 30 8 * * 7", now: localDate(2026, 0, 5, 7), dueAt: localDate(2026, 0, 4, 8, 30) },
		{ label: "all seven days as *", schedule: "0 30 8 * * *", now: localDate(2026, 0, 2, 7), dueAt: localDate(2026, 0, 1, 8, 30) },
		{ label: "a time just past on the day", schedule: "0 30 8 * * 1,3,5", now: localDate(2026, 0, 5, 8, 31), dueAt: localDate(2026, 0, 5, 8, 30) },
		{ label: "a time just ahead on the day", schedule: "0 30 8 * * 1,3,5", now: localDate(2026, 0, 5, 8, 29), dueAt: null },
		{ label: "no chosen day since it was made", schedule: "0 30 8 * * 1", now: localDate(2026, 0, 2, 12), dueAt: null },
		// A task whose day was changed to one that passed days ago (an edit keeps createdAt), or one that missed its day by more than a day.
		{ label: "its day more than a day ago", schedule: "0 30 8 * * 2", now: localDate(2026, 0, 8, 12), dueAt: null },
	];
	for (const row of weeklyRows) {
		const room = createRoom(`Due Scan Weekly ${row.label} Room`);
		const job = addSchedule(room, `weekly ${row.label}`, { type: "cron", schedule: row.schedule, now: weeklyCreatedAt });
		rememberThreads(room);
		const result = scanWithStoreUnchanged(room, { now: row.now }, `weekly ${row.label}`);
		if (row.dueAt === null) {
			assert(result.summary.notDue === 1 && result.summary.created === 0, `weekly, ${row.label}: not due, got ${JSON.stringify(result.summary)}`);
			continue;
		}
		assert(result.summary.created === 1 && result.items[0]?.dueAt === row.dueAt.toISOString(), `weekly, ${row.label}: a run due ${row.dueAt.toISOString()}, got ${result.items[0]?.dueAt} ${JSON.stringify(result.summary)}`);
		rememberRun(result.items[0]?.runId, `weekly ${row.label}`);
		assert(findBackgroundRunByScheduledOccurrence({ roomId: room, schedulerJobId: job.id, dueAt: row.dueAt.toISOString() }), `weekly, ${row.label}: the run is findable by its occurrence`);
	}
	// A Monday task changed to Wednesday: a Wednesday that had passed when it was changed is not run late on
	// Thursday; a Wednesday still ahead when it was changed is run.
	for (const edit of [{ label: "after", at: localDate(2026, 0, 8, 7), dueAt: null }, { label: "before", at: localDate(2026, 0, 7, 7), dueAt: localDate(2026, 0, 7, 8, 30) }]) {
		const room = createRoom(`Due Scan Weekly Edited ${edit.label} Room`);
		const job = addSchedule(room, `weekly edited ${edit.label}`, { type: "cron", schedule: "0 30 8 * * 1", now: weeklyCreatedAt });
		updatePersistentRoomScheduleJob(room, { jobId: job.id }, { schedule: "0 30 8 * * 3", now: edit.at });
		const occurrence = computePersistentRoomScheduleDueOccurrence(readPersistentRoomScheduleStore(room).jobs[0], { now: localDate(2026, 0, 8, 7, 30) });
		const dueAt = occurrence.due ? occurrence.dueAt : null;
		assert(dueAt === (edit.dueAt?.toISOString() ?? null), `weekly, changed to Wednesday ${edit.label} its time: due ${edit.dueAt?.toISOString() ?? "never"}, got ${JSON.stringify(occurrence)}`);
	}
	// Renamed through its edit form, which sends the same pattern back, just after its time and before a scan: the day still runs.
	{
		const room = createRoom("Due Scan Weekly Renamed Room");
		const job = addSchedule(room, "weekly renamed", { type: "cron", schedule: "0 30 8 * * 3", now: weeklyCreatedAt });
		updatePersistentRoomScheduleJob(room, { jobId: job.id }, { name: "weekly renamed again", type: "cron", schedule: "0 30 8 * * 3", now: new Date(localDate(2026, 0, 7, 8, 30).getTime() + 1_000) });
		const occurrence = computePersistentRoomScheduleDueOccurrence(readPersistentRoomScheduleStore(room).jobs[0], { now: localDate(2026, 0, 7, 8, 31) });
		assert(occurrence.due && occurrence.dueAt === localDate(2026, 0, 7, 8, 30).toISOString(), `weekly, renamed just after its time: still due, got ${JSON.stringify(occurrence)}`);
	}
	// Hour by hour over two weeks, Monday, Wednesday and Friday at 08:30 are the only occurrences.
	const weeklyJob = { ...addSchedule(createRoom("Due Scan Weekly Hours Room"), "weekly hours", { type: "cron", schedule: "0 30 8 * * 1,3,5", now: weeklyCreatedAt }) };
	const weeklyOccurrences = new Set<string>();
	for (let hour = 0; hour < 14 * 24; hour += 1) {
		const occurrence = computePersistentRoomScheduleDueOccurrence(weeklyJob, { now: localDate(2026, 0, 4, hour) });
		if (occurrence.due) weeklyOccurrences.add(occurrence.dueAt);
	}
	const expectedOccurrences = [5, 7, 9, 12, 14, 16].map((day) => localDate(2026, 0, day, 8, 30).toISOString());
	assert(JSON.stringify([...weeklyOccurrences].sort()) === JSON.stringify(expectedOccurrences), `weekly runs on its days only, got ${JSON.stringify([...weeklyOccurrences].sort())}`);
	// A clock change that skips 02:30 moves that day's time only: the days before keep 02:30.
	const savedTimeZone = process.env.TZ;
	process.env.TZ = "America/New_York";
	try {
		const clockChangeCreatedAt = new Date("2026-01-01T12:00:00Z");
		const saturdayJob = { ...weeklyJob, schedule: "0 30 2 * * 6", createdAt: clockChangeCreatedAt.toISOString() };
		const saturday = computePersistentRoomScheduleDueOccurrence(saturdayJob, { now: new Date("2026-03-08T07:15:00Z") });
		assert(saturday.due && saturday.dueAt === "2026-03-07T07:30:00.000Z", `weekly over a clock change keeps Saturday's 02:30, got ${JSON.stringify(saturday)}`);
		const dailyJob = { ...weeklyJob, schedule: "0 30 2 * * *", createdAt: clockChangeCreatedAt.toISOString() };
		const daily = computePersistentRoomScheduleDueOccurrence(dailyJob, { now: new Date("2026-03-08T07:00:00Z") });
		assert(daily.due && daily.dueAt === "2026-03-07T07:30:00.000Z", `daily over a clock change keeps the day before's 02:30, got ${JSON.stringify(daily)}`);
	} finally {
		if (savedTimeZone === undefined) delete process.env.TZ;
		else process.env.TZ = savedTimeZone;
	}

	// The page's "can't run" line and its Daily and Weekly reading agree with the due calculation, pattern by pattern.
	const presets = await import("../../web-ui/src/persistent-room-schedule-presets.js");
	const patterns = ["0 30 8 * * *", "0 30 8 * * 1,3,5", "0 30 8 * * 1-5", "0 30 8 * * 1-3,5", "0 30 8 * * 0", "0 30 8 * * 7", "0 30 8 * * 0-6", "0 30 8 * * 1-7",
		"0 */15 * * * *", "0 0 7 1 * *", "0 0 7 * 1 *", "0 0 7 * * 1/2", "0 0 7 * * 5-1", "30 0 7 * * *", "0 0-30 7 * * *", "0 0 7,19 * * *", "0 0 7 * * MON"];
	for (const pattern of patterns) {
		const server = persistentRoomScheduleCanRun("cron", pattern);
		assert(presets.scheduleCanRun({ type: "cron", schedule: pattern }) === server, `the page and the server agree whether ${pattern} runs (server: ${server})`);
		if (server) assert(["daily", "weekly"].includes(presets.inferScheduleRecurrenceDraftFromJob({ type: "cron", schedule: pattern } as any).mode), `${pattern} opens in Daily or Weekly`);
	}
	assert(persistentRoomScheduleCanRun("cron", "0 30 8 * * 1-5") && !persistentRoomScheduleCanRun("cron", "0 */15 * * * *"), "the list holds patterns of both kinds");
	assert(JSON.stringify(presets.inferScheduleRecurrenceDraftFromJob({ type: "cron", schedule: "0 30 8 * * 1-5" } as any).weekly.days) === "[1,2,3,4,5]", "a weekly range opens in Weekly with its days");
	// A range renamed just after its time, sent as the same days written another way, and sent through the Weekly
	// form's own helpers: the day still runs. A real change of days in the same edit moves the fence.
	{
		const justAfter = new Date(localDate(2026, 0, 7, 8, 30).getTime() + 1_000);
		const scanAt = localDate(2026, 0, 7, 8, 31);
		const wednesday = localDate(2026, 0, 7, 8, 30).toISOString();
		const renamed = (label: string, request: (job: any) => Record<string, unknown>) => {
			const room = createRoom(`Due Scan Weekly Range ${label} Room`);
			const job = addSchedule(room, `weekdays ${label}`, { type: "cron", schedule: "0 30 8 * * 1-5", now: weeklyCreatedAt });
			updatePersistentRoomScheduleJob(room, { jobId: job.id }, { ...request(job), now: justAfter });
			return computePersistentRoomScheduleDueOccurrence(readPersistentRoomScheduleStore(room).jobs[0], { now: scanAt });
		};
		const asList = renamed("as a list", () => ({ name: "weekdays, renamed", type: "cron", schedule: "0 30 8 * * 1,2,3,4,5" }));
		assert(asList.due && asList.dueAt === wednesday, `weekly, a range sent back as a list: still due, got ${JSON.stringify(asList)}`);
		const throughForm = renamed("through the form", (job) => {
			const sent = presets.applyRecurrenceToUpdateRequest({ name: "weekdays, renamed", prompt: job.prompt, enabled: true }, presets.inferScheduleRecurrenceDraftFromJob(job));
			assert(!("error" in sent), `the Weekly form sends the range back, got ${JSON.stringify(sent)}`);
			return sent as Record<string, unknown>;
		});
		assert(throughForm.due && throughForm.dueAt === wednesday, `weekly, a range renamed through the Weekly form: still due, got ${JSON.stringify(throughForm)}`);
		const otherDays = renamed("other days", () => ({ type: "cron", schedule: "0 30 8 * * 1-3" }));
		assert(!otherDays.due, `weekly, a range changed to other days just after its time: not run late, got ${JSON.stringify(otherDays)}`);
	}

	const intervalDueRoom = createRoom("Due Scan Interval Due Room");
	const intervalDueJob = addSchedule(intervalDueRoom, "interval due", { type: "interval", schedule: "1h", now: baseNow });
	rememberThreads(intervalDueRoom);
	const intervalDueResult = scanWithStoreUnchanged(intervalDueRoom, { now: new Date("2026-01-01T03:30:00.000Z") }, "interval due");
	assert(intervalDueResult.summary.created === 1 && intervalDueResult.items[0]?.dueAt === "2026-01-01T03:00:00.000Z", "interval scan should create only latest due occurrence from anchor");
	assert(intervalDueJob.nextRunAt === "2026-01-01T01:00:00.000Z", "interval fixture should preserve first nextRunAt anchor");
	rememberRun(intervalDueResult.items[0]?.runId, "interval due");

	const intervalFutureRoom = createRoom("Due Scan Interval Future Room");
	addSchedule(intervalFutureRoom, "interval future", { type: "interval", schedule: "1h", now: baseNow });
	rememberThreads(intervalFutureRoom);
	const intervalFutureCount = countBackgroundRunFiles(tempHome);
	const intervalFutureResult = scanWithStoreUnchanged(intervalFutureRoom, { now: new Date("2026-01-01T00:30:00.000Z") }, "interval future");
	assert(intervalFutureResult.summary.notDue === 1 && intervalFutureResult.summary.created === 0, "future interval anchor should be not_due");
	assert(countBackgroundRunFiles(tempHome) === intervalFutureCount, "future interval must not create a run");

	const unsupportedCronRoom = createRoom("Due Scan Unsupported Cron Room");
	// Refused when saved; one already on disk (saved before the refusal) is still skipped.
	let refusal: { message?: string; code?: unknown } | null = null;
	try {
		addPersistentRoomScheduleJob(unsupportedCronRoom, { name: "refused cron", type: "cron", schedule: "0 */15 * * * *", prompt: promptText, now: baseNow, refuseUnrunnable: true });
	} catch (error) {
		refusal = error as { message?: string; code?: unknown };
	}
	assert(refusal?.code === "schedule_pattern_cannot_run" && refusal.message === "This pattern can't run yet. Use Daily or Weekly, or the Interval type to repeat every few minutes or hours.", `a pattern the server can't run is refused at save, got ${refusal?.message}`);
	assert(readPersistentRoomScheduleStore(unsupportedCronRoom).jobs.length === 0, "a refused pattern is not saved");
	addSchedule(unsupportedCronRoom, "unsupported cron", { type: "cron", schedule: "0 */15 * * * *", now: baseNow });
	rememberThreads(unsupportedCronRoom);
	const unsupportedCount = countBackgroundRunFiles(tempHome);
	const unsupportedResult = scanWithStoreUnchanged(unsupportedCronRoom, { now: scanNow }, "unsupported cron");
	assert(unsupportedResult.summary.unsupported === 1 && unsupportedResult.summary.skipped === 1, "custom cron should be skipped as unsupported");
	assert(unsupportedResult.items[0]?.reason === "unsupported_cron_due_calculation", "unsupported cron item should expose explicit reason");
	assert(countBackgroundRunFiles(tempHome) === unsupportedCount, "unsupported cron must not create a run");

	const lockedRoom = createRoom("Due Scan Locked Deferred Room");
	addSchedule(lockedRoom, "locked due");
	writeJson(path.join(tempHome, ".exxperts", "app", ".room-locks", `${lockedRoom}.json`), {
		surface: "web",
		pid: process.pid,
		connectionId: "synthetic-due-scan-lock",
		host: os.hostname(),
		label: "smoke",
		acquiredAt: Date.now(),
		lastSeen: Date.now(),
	});
	rememberThreads(lockedRoom);
	const lockedResult = scanWithStoreUnchanged(lockedRoom, { now: scanNow }, "locked deferred");
	assert(lockedResult.summary.created === 1 && lockedResult.summary.deferred === 1, "active room lock should create durable deferred preflight record");
	assert(lockedResult.items[0]?.runStatus === "deferred" && lockedResult.items[0]?.reason === "room_in_use", "locked due item should report deferred room_in_use");
	rememberRun(lockedResult.items[0]?.runId, "locked deferred");

	const blockedRoom = createRoom("Due Scan Boundary Blocked Room");
	addSchedule(blockedRoom, "boundary due");
	writePersistentAgentThread(blockedRoom, "due_scan_boundary_0001", {
		state: "standby",
		origin: "checkpoint",
		model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" },
		items: [],
	});
	rememberThreads(blockedRoom);
	const blockedResult = scanWithStoreUnchanged(blockedRoom, { now: scanNow }, "blocked boundary");
	assert(blockedResult.summary.created === 1 && blockedResult.summary.blocked === 1, "prepared runtime boundary should create durable blocked preflight record");
	assert(blockedResult.items[0]?.runStatus === "blocked" && blockedResult.items[0]?.reason === "prepared_runtime_boundary", "blocked boundary item should report prepared_runtime_boundary");
	rememberRun(blockedResult.items[0]?.runId, "blocked boundary");

	const activeTurnRoom = createRoom("Due Scan Active Turn Deferred Room");
	addSchedule(activeTurnRoom, "active turn due");
	writePersistentAgentThread(activeTurnRoom, "due_scan_active_turn_0001", {
		state: "standby",
		origin: "home",
		model: { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" },
		items: [{ kind: "user", id: "synthetic-user", text: "Synthetic active turn message." }],
	});
	rememberThreads(activeTurnRoom);
	const runningTurn = beginPersistentAgentTurn(activeTurnRoom, "due_scan_active_turn_0001", { turnId: "synthetic-due-scan-turn", connectionId: "synthetic-ws" });
	const activeTurnResult = scanWithStoreUnchanged(activeTurnRoom, { now: scanNow }, "active turn deferred");
	assert(activeTurnResult.summary.created === 1 && activeTurnResult.summary.deferred === 1, "active turn should create durable deferred preflight record");
	assert(activeTurnResult.items[0]?.runStatus === "deferred" && activeTurnResult.items[0]?.reason === "active_turn_in_flight", "active turn item should report active_turn_in_flight");
	finishPersistentAgentTurn(activeTurnRoom, "due_scan_active_turn_0001", { turnId: runningTurn.turnId, terminalReason: "completed" });
	rememberRun(activeTurnResult.items[0]?.runId, "active turn deferred");

	const visibleRuns = listBackgroundRuns({ kind: "scheduled-prompt", scope: { kind: "persistent-room", roomId: onceRoom }, schedulerJobId: onceJob.id, limit: 10 });
	const history = buildPersistentRoomBackgroundRunsResponse(onceRoom, visibleRuns, { scheduleId: onceJob.id, limit: 10 });
	assert(history.runs.length === 1 && history.runs[0]?.runId === onceRunId, "created due-scan record should be observable through background-run history helpers");
	assert(history.runs[0]?.source?.scheduleId === onceJob.id && history.runs[0]?.source?.dueAt === onceJob.nextRunAt, "history projection should include schedule id and dueAt");

	for (const runId of createdRunIds) {
		const run = readBackgroundRun(runId);
		assertRunNoPromptLeak(run, promptText, `created run ${runId}`);
	}
	assertNoPromptLeak(listBackgroundRuns({ kind: "scheduled-prompt", limit: 100 }), promptText, "all listed runs");

	for (const roomId of createdRoomIds) {
		const store = readPersistentRoomScheduleStore(roomId);
		for (const job of store.jobs) {
			assert(job.lastRunAt === null, `${roomId}/${job.id}: due scan must not set lastRunAt`);
			assert(job.lastStatus === null, `${roomId}/${job.id}: due scan must not set lastStatus`);
			assert(job.lastError === null, `${roomId}/${job.id}: due scan must not set lastError`);
		}
	}

	assert(getPersistentAgentRuntimeState(onceRoom).state === "idle", "queued fresh due scan must not mutate runtime state");
	assertNoUnexpectedRuntimeSideEffects("persistent-room schedule due scan smoke");

	console.log("persistent-room schedule due-scan smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
