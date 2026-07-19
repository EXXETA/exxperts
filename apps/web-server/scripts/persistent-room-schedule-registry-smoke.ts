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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-registry-"));
const tempHome = path.join(tmp, "home");
const agentId = "schedule-smoke-room";
fs.mkdirSync(tempHome, { recursive: true, mode: 0o700 });

process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(tempHome, ".exxperts", "app", "personalized-agents");

try {
	const scheduleModule = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const {
		addPersistentRoomScheduleJob,
		listPersistentRoomScheduleJobs,
		parsePersistentRoomSchedule,
		persistentRoomScheduleRootPath,
		persistentRoomScheduleStorePath,
		readPersistentRoomScheduleStore,
		removePersistentRoomScheduleJob,
		setPersistentRoomScheduleJobEnabled,
		updatePersistentRoomScheduleJob,
	} = scheduleModule;

	const expectedRoot = path.join(tempHome, ".exxperts", "app", "persistent-room-schedules");
	const expectedStorePath = path.join(expectedRoot, agentId, "schedules.json");
	assert(persistentRoomScheduleRootPath() === expectedRoot, "schedule root should live under temp ~/.exxperts/app");
	assert(persistentRoomScheduleStorePath(agentId) === expectedStorePath, "store path should use room-scoped schedule registry path");
	assert(path.resolve(expectedStorePath).startsWith(path.resolve(expectedRoot) + path.sep), "store path must be contained by schedule root");
	expectThrow(() => persistentRoomScheduleStorePath("../escape"), "path traversal room id");
	expectThrow(() => persistentRoomScheduleStorePath("room/escape"), "slash room id");
	expectThrow(() => persistentRoomScheduleStorePath("Uppercase"), "unsafe room id");

	assert(listPersistentRoomScheduleJobs(agentId).length === 0, "empty room should list no schedule jobs");
	assert(!fs.existsSync(expectedStorePath), "empty read should not create a schedule store file");

	const now = new Date("2026-01-01T00:00:00.000Z");
	const once = addPersistentRoomScheduleJob(agentId, {
		name: "once job",
		type: "once",
		schedule: "+30m",
		prompt: "Run one-shot work",
		now,
	});
	assert(once.id.startsWith("sched_"), "job id should use sched_ prefix");
	assert(once.type === "once", "once job type should be once");
	assert(once.nextRunAt === "2026-01-01T00:30:00.000Z", "once nextRunAt should be derived from relative time");
	assert(once.lastRunAt === null && once.lastStatus === null && once.lastError === null, "new job should not pretend execution occurred");

	const interval = addPersistentRoomScheduleJob(agentId, {
		name: "interval job",
		schedule: "every hour",
		prompt: "Run interval work",
		now,
	});
	assert(interval.type === "interval", "every hour should infer interval type");
	assert(interval.schedule === "1h", "interval schedule should be canonicalized");
	assert(interval.nextRunAt === "2026-01-01T01:00:00.000Z", "interval nextRunAt should be management-only derived metadata");

	const cron = addPersistentRoomScheduleJob(agentId, {
		name: "cron job",
		type: "cron",
		schedule: "0 0 7 * * *",
		prompt: "Run cron work",
		now,
	});
	assert(cron.type === "cron", "cron job type should be cron");
	assert(cron.nextRunAt === null, "cron nextRunAt should remain null in dependency-free S1 validation");

	assert(fs.existsSync(expectedStorePath), "schedule store file should be written after add");
	const storedJson = JSON.parse(fs.readFileSync(expectedStorePath, "utf-8"));
	assert(storedJson.roomId === agentId, "store should persist room id");
	assert(storedJson.jobs.length === 3, "store should persist added jobs");

	const durable = readPersistentRoomScheduleStore(agentId);
	assert(durable.jobs.length === 3, "durable store should round-trip jobs after reload/read");
	assert(durable.jobs.map((job: any) => job.name).join(",") === "once job,interval job,cron job", "durable jobs should preserve names/order");

	const updated = updatePersistentRoomScheduleJob(agentId, { jobId: once.id }, {
		name: "updated once",
		prompt: "Updated prompt",
		type: "interval",
		schedule: "2h",
		enabled: false,
		now,
	});
	assert(updated.name === "updated once", "update should change name");
	assert(updated.prompt === "Updated prompt", "update should change prompt");
	assert(updated.type === "interval" && updated.schedule === "2h", "update should change type/schedule");
	assert(updated.enabled === false, "update should change enabled state");

	const disabled = setPersistentRoomScheduleJobEnabled(agentId, { name: "interval job" }, false, { now });
	assert(disabled.enabled === false, "disable by name should work");
	const enabled = setPersistentRoomScheduleJobEnabled(agentId, { jobId: disabled.id }, true, { now });
	assert(enabled.enabled === true, "enable by id should work");

	const removed = removePersistentRoomScheduleJob(agentId, { jobId: cron.id });
	assert(removed.id === cron.id, "remove by id should return removed job");
	assert(listPersistentRoomScheduleJobs(agentId).length === 2, "remove should persistently delete one job");

	expectThrow(() => addPersistentRoomScheduleJob(agentId, { type: "interval", schedule: "not an interval", prompt: "bad", now }), "invalid interval");
	expectThrow(() => parsePersistentRoomSchedule("0 99 7 * * *", "cron", { now }), "invalid cron field");
	expectThrow(() => parsePersistentRoomSchedule("2000-01-01T00:00:00.000Z", "once", { now }), "past once schedule");

	let sentUserMessages = 0;
	let registeredTool: any = null;
	const fakePi = {
		registerTool(tool: any) {
			registeredTool = tool;
		},
		sendUserMessage() {
			sentUserMessages += 1;
		},
	};
	scheduleModule.default(fakePi as unknown as Parameters<typeof scheduleModule.default>[0], { roomId: agentId });
	assert(registeredTool?.name === "schedule_prompt", "extension should register schedule_prompt tool");

	const toolAdd = await registeredTool.execute("tool-call-1", {
		action: "add",
		name: "tool job",
		schedule: "+1h",
		prompt: "Stored through tool",
	});
	assert(toolAdd.details.executionEnabled === false, "tool details should be honest that execution is disabled");
	assert(toolAdd.details.managementOnly === true, "tool details should mark management-only behavior");
	assert(String(toolAdd.content[0].text).includes("autonomous scheduled execution is not enabled"), "tool add response should not promise autonomous execution");
	assert(sentUserMessages === 0, "schedule_prompt management actions must not inject runtime user messages");

	const toolList = await registeredTool.execute("tool-call-2", { action: "list" });
	assert(toolList.details.jobs.length === 3, "tool list should read durable jobs for scoped room");
	assert(String(toolList.content[0].text).includes("registry-only"), "tool list response should remain management-only");

	await registeredTool.execute("tool-call-3", { action: "disable", jobId: toolAdd.details.job.id });
	await registeredTool.execute("tool-call-4", { action: "enable", jobId: toolAdd.details.job.id });
	await registeredTool.execute("tool-call-5", { action: "update", jobId: toolAdd.details.job.id, name: "tool job updated", prompt: "Updated through tool" });
	await registeredTool.execute("tool-call-6", { action: "remove", jobId: toolAdd.details.job.id });
	assert(sentUserMessages === 0, "all schedule_prompt tool actions must remain registry-only");
	assert(listPersistentRoomScheduleJobs(agentId).length === 2, "tool remove should persistently delete tool-created job");

	const escapedOutside = path.join(tempHome, ".exxperts", "app", "escape");
	assert(!fs.existsSync(escapedOutside), "unsafe room id must not create escaped schedule paths");
	assert(!fs.existsSync(path.join(tempHome, ".exxeta")), "schedule registry must not write legacy ~/.exxeta state");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "agent", "auth.json")), "smoke must not create/read runtime auth state");
	assert(!fs.existsSync(path.join(tempHome, ".exxperts", "agent", "models.json")), "smoke must not create/read runtime model state");

	console.log("persistent-room schedule registry smoke passed");
} finally {
	fs.rmSync(tmp, { recursive: true, force: true });
}
