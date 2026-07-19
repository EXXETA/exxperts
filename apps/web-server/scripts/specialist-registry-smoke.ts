import {
	abortAllSpecialistTasks,
	abortSpecialistTask,
	bindSpecialistSink,
	emitSpecialistDelta,
	getSpecialistTask,
	registerSpecialistTask,
	removeSpecialistTask,
	resetSpecialistRegistryForTest,
	runningSpecialistCount,
	sendSpecialistFrame,
	SPECIALIST_REGISTRY_TAIL_CAP,
	unbindSpecialistSink,
} from "../src/persistent-room-specialist-registry.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const NOW = new Date("2026-07-19T10:00:00.000Z");

function entry(taskId: string) {
	return {
		taskId,
		templateId: "deck",
		templateVersion: 3,
		templateLabel: "Slide deck",
		title: "Q3 deck",
		model: { provider: "p", model: "m" },
		abortController: new AbortController(),
	};
}

try {
	// Survival core: a task registered under one sink outlives that sink's
	// unbind (the connection close) — the room, not the tab, owns it.
	resetSpecialistRegistryForTest();
	const roomA = "room-a";
	const framesConn1: any[] = [];
	const sink1 = (msg: unknown) => { framesConn1.push(msg); };
	bindSpecialistSink(roomA, sink1);
	registerSpecialistTask(roomA, entry("tsk-1"), NOW);
	assert(runningSpecialistCount(roomA) === 1, "registered task counts as running");
	emitSpecialistDelta(roomA, "tsk-1", "hello ");
	emitSpecialistDelta(roomA, "tsk-1", "world");
	assert(framesConn1.filter((f) => f.type === "task_delta").length === 2, "live deltas reach the bound sink");
	unbindSpecialistSink(roomA, sink1);
	assert(runningSpecialistCount(roomA) === 1, "unbinding the sink does NOT kill the task (option 4 core)");
	assert(getSpecialistTask(roomA, "tsk-1")?.abortController.signal.aborted === false, "no abort fires on disconnect");
	assert(sendSpecialistFrame(roomA, { type: "task_end", taskId: "tsk-1" }) === false, "frames while away report undelivered — the ledger's noticed:false signal");

	// Reconnect replay: a fresh sink receives task_started + the accumulated
	// tail as one delta — the same frames the client would have received live.
	const framesConn2: any[] = [];
	bindSpecialistSink(roomA, (msg) => { framesConn2.push(msg); });
	assert(framesConn2.length === 2, `replay is exactly started + tail, got ${framesConn2.length}`);
	assert(framesConn2[0].type === "task_started" && framesConn2[0].taskId === "tsk-1" && framesConn2[0].template === "deck" && framesConn2[0].templateLabel === "Slide deck" && framesConn2[0].title === "Q3 deck", "replayed task_started carries the launch shape");
	assert(framesConn2[1].type === "task_delta" && framesConn2[1].delta === "hello world", "replayed tail is the accumulated deltas");

	// Cap accounting across connections: the second connection sees the room's
	// running task even though it launched on the first.
	assert(runningSpecialistCount(roomA) === 1, "cap is per room, not per connection");

	// Stop after reconnect: the new connection aborts a task the old one launched.
	assert(abortSpecialistTask(roomA, "tsk-1") === true, "abort resolves via the registry");
	const t1 = getSpecialistTask(roomA, "tsk-1");
	assert(t1?.stoppedByUser === true && t1.abortController.signal.aborted === true, "abort arms stoppedByUser and fires the signal");
	assert(abortSpecialistTask(roomA, "tsk-nope") === false, "unknown ids refuse (stale-id discipline)");

	// Terminal cleanup frees the slot.
	removeSpecialistTask(roomA, "tsk-1");
	assert(runningSpecialistCount(roomA) === 0, "removal frees the room's cap slot");

	// Tail cap: the replay buffer never exceeds the client's own cap.
	resetSpecialistRegistryForTest();
	registerSpecialistTask(roomA, entry("tsk-2"), NOW);
	emitSpecialistDelta(roomA, "tsk-2", "x".repeat(SPECIALIST_REGISTRY_TAIL_CAP + 500));
	emitSpecialistDelta(roomA, "tsk-2", "END");
	const t2 = getSpecialistTask(roomA, "tsk-2");
	assert(t2?.tail.length === SPECIALIST_REGISTRY_TAIL_CAP, "tail is capped");
	assert(t2.tail.endsWith("END"), "the cap keeps the newest chars");

	// Web→web takeover: the older connection's late unbind must not clobber the
	// newer connection's sink.
	const framesOld: any[] = [];
	const framesNew: any[] = [];
	const oldSink = (msg: unknown) => { framesOld.push(msg); };
	const newSink = (msg: unknown) => { framesNew.push(msg); };
	bindSpecialistSink(roomA, oldSink);
	bindSpecialistSink(roomA, newSink);
	unbindSpecialistSink(roomA, oldSink);
	assert(sendSpecialistFrame(roomA, { type: "task_delta", taskId: "tsk-2", delta: "!" }) === true, "the newer sink survives the older connection's teardown");
	assert(framesNew.some((f) => f.delta === "!") && !framesOld.some((f) => f.delta === "!"), "frames route to the takeover sink only");

	// Rooms are isolated: another room's sink hears nothing.
	const framesB: any[] = [];
	bindSpecialistSink("room-b", (msg) => { framesB.push(msg); });
	assert(framesB.length === 0, "binding an empty room replays nothing");
	emitSpecialistDelta(roomA, "tsk-2", "more");
	assert(framesB.length === 0, "cross-room frames never leak");

	// Delivery honesty: a sink whose socket already closed reports false, and
	// sendSpecialistFrame must NOT count that as the user having been told.
	bindSpecialistSink(roomA, () => false);
	assert(sendSpecialistFrame(roomA, { type: "task_end", taskId: "tsk-2" }) === false, "a dead-socket sink's frames report undelivered");

	// Archive kill switch: aborting a whole room stops every task, arms
	// stoppedByUser, and leaves other rooms untouched.
	resetSpecialistRegistryForTest();
	registerSpecialistTask(roomA, entry("tsk-3"), NOW);
	registerSpecialistTask(roomA, entry("tsk-4"), NOW);
	registerSpecialistTask("room-b", entry("tsk-5"), NOW);
	assert(abortAllSpecialistTasks(roomA) === 2, "room-wide abort reports how many tasks it stopped");
	const t3 = getSpecialistTask(roomA, "tsk-3");
	const t4 = getSpecialistTask(roomA, "tsk-4");
	assert(t3?.stoppedByUser === true && t3.abortController.signal.aborted === true, "archive abort arms stoppedByUser and fires the signal");
	assert(t4?.stoppedByUser === true && t4.abortController.signal.aborted === true, "archive abort covers every task of the room");
	assert(getSpecialistTask("room-b", "tsk-5")?.abortController.signal.aborted === false, "other rooms' tasks keep running");
	assert(abortAllSpecialistTasks("room-empty") === 0, "an unknown room aborts nothing");

	console.log("specialist registry smoke passed");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	process.exitCode = 1;
}
