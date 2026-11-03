// The minute schedule check must not hold the event loop for the whole room
// list: pages, answers and sockets wait while it runs. This smoke builds many
// rooms on a scratch home and measures the longest event-loop stall during one
// scan, at two room counts, so a scan that blocks shows a stall that grows
// with the rooms.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const SMALL_ROOM_COUNT = 250;
const LARGE_ROOM_COUNT = 1_000;
const MAX_STALL_MS = 50;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-schedule-preflight-stall-"));
const tempHome = path.join(tmp, "home");
const tempAgentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
fs.mkdirSync(tempAgentsRoot, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
// An inherited data profile would put the schedule stores and runs outside the scratch home.
process.env.EXXPERTS_STATE_HOME = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = path.join(tempHome, ".exxperts", "agent");
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;

try {
	const { runPersistentRoomSchedulePreflightScanOnce, startPersistentRoomSchedulePreflightLoop } = await import("../src/persistent-room-schedule-preflight-loop.js");
	const { addPersistentRoomScheduleJob, persistentRoomScheduleStorePath } = await import("../../../pi-package/extensions/schedule-prompt/index.js");
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const { archivePersistentAgent } = await import("../src/persistent-agent-archive.js");

	const baseNow = new Date("2026-01-01T00:00:00.000Z");
	const scanNow = new Date("2026-01-01T01:00:00.000Z");

	// Creating a room checks its name against every other room, so thousands
	// of creations would be slow. One real room is copied instead, with its id
	// rewritten in the files that carry it.
	const template = String(createPersistentAgentFromScaffoldInput({ displayName: "Stall Template", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	addPersistentRoomScheduleJob(template, { name: "future", type: "once", schedule: "+2h", prompt: "Synthetic future prompt.", now: new Date("2099-01-01T00:00:00.000Z") });
	const templateRoot = path.join(tempAgentsRoot, template);
	const templateFiles = fs.readdirSync(templateRoot, { recursive: true, encoding: "utf-8" })
		.filter((file) => fs.statSync(path.join(templateRoot, file)).isFile());
	const templateTexts = new Map(templateFiles.map((file) => [file, fs.readFileSync(path.join(templateRoot, file), "utf-8")]));
	const templateStore = fs.readFileSync(persistentRoomScheduleStorePath(template), "utf-8");
	const roomIds = [template];
	function copyRooms(total: number): void {
		while (roomIds.length < total) {
			const roomId = `stall-room-${String(roomIds.length).padStart(5, "0")}`;
			for (const [file, text] of templateTexts) {
				const target = path.join(tempAgentsRoot, roomId, file);
				fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
				fs.writeFileSync(target, text.replaceAll(template, roomId), { mode: 0o600 });
			}
			const storeFile = persistentRoomScheduleStorePath(roomId);
			fs.mkdirSync(path.dirname(storeFile), { recursive: true, mode: 0o700 });
			fs.writeFileSync(storeFile, templateStore.replaceAll(template, roomId), { mode: 0o600 });
			roomIds.push(roomId);
		}
	}

	// One room with a due task and one archived room with a due task: a scan
	// among many rooms still finds the first and leaves the second alone.
	const dueRoom = String(createPersistentAgentFromScaffoldInput({ displayName: "Stall Due Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	addPersistentRoomScheduleJob(dueRoom, { name: "due", type: "once", schedule: "+30m", prompt: "Synthetic due prompt.", now: baseNow });
	const archivedRoom = String(createPersistentAgentFromScaffoldInput({ displayName: "Stall Archived Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	addPersistentRoomScheduleJob(archivedRoom, { name: "archived due", type: "once", schedule: "+30m", prompt: "Synthetic archived prompt.", now: baseNow });
	archivePersistentAgent(archivedRoom, { confirmation: `DELETE ${archivedRoom}` });

	async function measureScan(label: string): Promise<{ stallMs: number; durationMs: number; result: Awaited<ReturnType<typeof runPersistentRoomSchedulePreflightScanOnce>> }> {
		// The first scan of a room may write once (a last-used estimate, a
		// settled save); the minute check measured on a server is the steady one.
		await runPersistentRoomSchedulePreflightScanOnce({ now: () => scanNow });
		const histogram = monitorEventLoopDelay({ resolution: 5 });
		histogram.enable();
		// The histogram records nothing before its first tick, so a scan that
		// starts at once and never yields would go unseen.
		await new Promise((resolve) => setTimeout(resolve, 20));
		const started = performance.now();
		const result = await runPersistentRoomSchedulePreflightScanOnce({ now: () => scanNow });
		const durationMs = performance.now() - started;
		// One more turn so a stall at the very end of the scan is recorded too.
		await new Promise((resolve) => setTimeout(resolve, 20));
		histogram.disable();
		const stallMs = histogram.max / 1e6;
		console.log(`${label}: ${result.roomCount} rooms, scan ${durationMs.toFixed(0)} ms, longest stall ${stallMs.toFixed(1)} ms`);
		return { stallMs, durationMs, result };
	}

	copyRooms(SMALL_ROOM_COUNT);
	const small = await measureScan("small");
	copyRooms(LARGE_ROOM_COUNT);
	const large = await measureScan("large");

	for (const [label, scan, rooms] of [["small", small, SMALL_ROOM_COUNT], ["large", large, LARGE_ROOM_COUNT]] as const) {
		assert(scan.result.roomCount === rooms + 1 && scan.result.scannedRoomCount === rooms + 1 && scan.result.skippedRoomCount === 0, `${label}: every live room is scanned and the archived room is left out, got ${scan.result.roomCount}/${scan.result.scannedRoomCount}/${scan.result.skippedRoomCount}`);
		assert(!scan.result.rooms.some((room) => room.roomId === archivedRoom), `${label}: the archived room is not scanned`);
		assert(scan.result.totals.notDue === rooms && scan.result.totals.duplicates === 1 && scan.result.totals.created === 0, `${label}: every copied room's future task is read and the due run was made once, got ${JSON.stringify(scan.result.totals)}`);
		assert(scan.stallMs < MAX_STALL_MS, `${label}: the scan held the event loop ${scan.stallMs.toFixed(1)} ms in one stretch; it must yield between rooms (limit ${MAX_STALL_MS} ms)`);
	}

	// A server stop stops the loop while a scan may be between rooms: the scan
	// ends there instead of making runs for the rooms it has not reached.
	const loop = startPersistentRoomSchedulePreflightLoop({ enabled: true, runOnStart: false, now: () => scanNow });
	const inFlight = loop.runOnce();
	loop.stop();
	const cut = await inFlight;
	assert(cut.rooms.length < LARGE_ROOM_COUNT && !loop.isRunning(), `a stopped loop's scan in flight ends early, got ${cut.rooms.length} of ${LARGE_ROOM_COUNT + 1} rooms`);
	const disabled = startPersistentRoomSchedulePreflightLoop({ enabled: false, now: () => scanNow });
	const manual = await disabled.runOnce();
	assert(manual.rooms.length === LARGE_ROOM_COUNT + 1, `a disabled loop's manual run scans every room, got ${manual.rooms.length} of ${LARGE_ROOM_COUNT + 1}`);

	console.log("persistent-room schedule preflight stall smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp root preserved for inspection: ${tmp}`);
	process.exitCode = 1;
} finally {
	if (process.exitCode == null || process.exitCode === 0) fs.rmSync(tmp, { recursive: true, force: true });
}
