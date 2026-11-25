// An answer ended by force (turn-forced-end.ts) and the box its commands ran
// in, on a Mac with the box. On the detached-turn rig, with a model call that
// never hears its abort (smoke-ignores-stop-preload.mjs). Proves:
//   1. a job a command left running in the box is gone once the answer was
//      ended by force, while the model call still hangs;
//   2. when that call finishes late, the next answer's command, in the same
//      room, runs on to its own end;
// and, on any computer with bash, with a stand-in for the box's process that
// starts when the smoke wants and holds nothing closed:
//   3. a box that is still starting when its turn ends is never that room's
//      box: it clears nothing of the next answer's and stops itself;
//   4. nor does it bring back the folder of a room deleted meanwhile;
//   5. a box that starts within its turn runs, and clears what an earlier
//      turn left.
import fs from "node:fs";
import path from "node:path";
import { roomBoxComputer } from "../src/room-box/box-available.js";
import { assert, baseUrl, createRoom, DEAF_JOB_MARKER, DEAF_TOOL_MARKER, gatewayRequests, getStatus, getThread, LATE_USAGE, productAppRoot, putThread, reportDetachedFailure, requestJson, scriptDir, startDetachedServer, stopDetachedServer, tempHome, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";
import { putRunWithoutAsking } from "./smoke-server-process.js";

if (process.platform !== "win32") await lateStarts();

if (roomBoxComputer() !== "mac") {
	console.log("room box stop forced end smoke skipped (needs a Mac with the room box)");
	fs.rmSync(tempHome, { recursive: true, force: true });
	process.exit(0);
}

const json = { "content-type": "application/json" };
const workspaceRoot = path.join(tempHome, "stop-workspace");
const inFlight = async (roomId: string): Promise<boolean> => (await getStatus(roomId)).activeThread?.inFlight === true;
const hung = () => gatewayRequests.find((row) => row.played === `${DEAF_JOB_MARKER}:job` && row.afterTool);
const lateUsage = (roomId: string): boolean => {
	try {
		return fs.readFileSync(path.join(productAppRoot, "usage.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).some((row) => row.agent === roomId && row.output === LATE_USAGE.completion_tokens);
	} catch {
		return false;
	}
};
const alive = (pid: number): boolean => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};
let job = 0;

try {
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const preload = new URL(`file://${path.join(scriptDir, "smoke-ignores-stop-preload.mjs")}`).href;
	await startDetachedServer(undefined, { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim() } });
	const roomId = await createRoom("Deaf Job Room");
	const conversationId = "stopconv_job";
	const workspace = await requestJson(`/api/persistent-agents/${roomId}/workspace-default`, { method: "PUT", headers: json, body: JSON.stringify({ root: workspaceRoot, displayLabel: "Stop Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
	assert(workspace.status === 200, `commands are on, got ${workspace.status}`);
	assert((await putRunWithoutAsking(`${baseUrl}/api/persistent-agents/${roomId}/bash-settings`, true)).status === 200, "commands run without asking");
	assert((await putThread(roomId, conversationId, [])).status === 200, "the conversation is saved");

	const first = await WsHarness.connect(roomId, conversationId);
	await first.waitFor((frame) => frame.type === "ready", "ready frame");
	first.send({ type: "prompt", id: "jobasked", text: `Leave a job running. ${DEAF_JOB_MARKER}:job` });
	await waitUntil(() => !!hung(), "the command ran and the model is asked again");
	await first.waitFor((frame) => frame.event?.type === "message_update", "the answer goes on");
	job = Number(fs.readFileSync(path.join(workspaceRoot, "job-job"), "utf-8"));
	assert(job > 1 && alive(job), `the command left its job running, got ${job}`);
	first.send({ type: "abort", shown: 0 });
	await waitUntil(() => first.closed, "the page is let go");
	assert(!(await inFlight(roomId)) && !hung()!.finished, "the room is idle while the model call still hangs");
	await waitUntil(() => !alive(job), "the job ended with the answer");
	console.log("ok 1 a command still running in the box is gone after a forced end");

	const next = await WsHarness.connect(roomId, conversationId);
	await next.waitFor((frame) => frame.type === "ready", "the room opens again");
	const from = next.frames.length;
	next.send({ type: "prompt", id: "nextasked", text: `And now? ${DEAF_TOOL_MARKER}:next` });
	await next.waitFor((frame) => frame.event?.type === "tool_execution_start", "the next answer's command starts", from);
	hung()!.release();
	await waitUntil(() => lateUsage(roomId), "the hung call finished late");
	assert(await inFlight(roomId), "the next answer's command still runs");
	fs.writeFileSync(path.join(workspaceRoot, "release-next"), "");
	await next.waitFor((frame) => frame.event?.type === "agent_end", "the next answer ends", from);
	await waitUntil(async () => !(await inFlight(roomId)), "the next answer settled");
	assert(fs.existsSync(path.join(workspaceRoot, "late-next")), `the next answer's command ran to its end, got ${JSON.stringify((await getThread(roomId, conversationId)).items)}`);
	next.close();
	console.log("ok 2 a late finish leaves the next answer's command running");
} catch (error) {
	reportDetachedFailure(error);
} finally {
	for (const request of gatewayRequests) request.release();
	// A failed row leaves nothing running: the job is this smoke's own command.
	if (job > 1 && alive(job)) process.kill(job, "SIGKILL");
	await stopDetachedServer();
}

async function lateStarts(): Promise<void> {
	// The rooms' root is read as these load: it is the smoke's own, however it is run.
	process.env.EXXETA_PERSISTENT_AGENTS_ROOT = path.join(productAppRoot, "personalized-agents");
	const { BoxProcess } = await import("../src/room-box/box-process.js");
	const { RoomBox } = await import("../src/room-box/box-session.js");
	const { persistentAgentRootPath } = await import("../src/persistent-room-workspace-policy.js");
	assert(persistentAgentRootPath("late").startsWith(tempHome), "the rooms are in the smoke's own home");
	const realStart = BoxProcess.start;
	const started: { let: () => void; stopped: boolean }[] = [];
	// The box's own proof wants its refused steps refused: the stand-in runs the two allowed ones and the clearing as they are.
	const wrapped = (command: string) => (/written\.txt|rm deleted|\/usr\/bin\/find/.test(command) ? command : "exit 1");
	BoxProcess.start = (async () => {
		const record = { let: () => {}, stopped: false };
		const wait = new Promise<void>((resolve) => { record.let = resolve; });
		started.push(record);
		await wait;
		return { get alive() { return !record.stopped; }, request: async (op: string, payload: any) => (op === "wrap" ? { wrapped: wrapped(payload.command) } : {}), stop: async () => { record.stopped = true; } };
	}) as unknown as typeof BoxProcess.start;
	const roomBox = (roomId: string) => new RoomBox({ roomId, conversationId: () => "late", questions: { watcher: () => "none", closeSiteCards: () => {} } as any, rights: () => ({ canChangeFiles: true, skillFolders: [] }), warn: () => {} });
	const temps = (roomId: string) => fs.readdirSync(path.join(persistentAgentRootPath(roomId), "runtime", "box")).filter((name) => name.startsWith("temp-"));
	const startOf = async (box: ReturnType<typeof roomBox>): Promise<{ run: Promise<string>; let: () => void; stopped: () => boolean }> => {
		const at = started.length;
		const run = box.ensureRun().then(() => "runs", (error: Error) => `ended: ${error.message}`);
		await waitUntil(() => started.length === at + 1, "the box starts");
		return { run, let: started[at]!.let, stopped: () => started[at]!.stopped };
	};
	try {
		// First: until a box has proved itself once, its proof makes its folder.
		const gone = "late-gone-room";
		fs.mkdirSync(persistentAgentRootPath(gone), { recursive: true });
		const goneBox = roomBox(gone);
		const goneStart = await startOf(goneBox);
		await goneBox.endTurn();
		fs.rmSync(persistentAgentRootPath(gone), { recursive: true });
		goneStart.let();
		await goneStart.run;
		assert(!fs.existsSync(persistentAgentRootPath(gone)), "4 the deleted room's folder stays gone");
		console.log("ok 4 a late box brings no deleted room's folder back");

		const room = "late-start-room";
		fs.mkdirSync(persistentAgentRootPath(room), { recursive: true });
		const before = roomBox(room);
		const late = await startOf(before);
		await before.endTurn();
		const next = roomBox(room);
		const nextStart = await startOf(next);
		nextStart.let();
		assert((await nextStart.run) === "runs", `3 the next answer's box runs, got ${await nextStart.run}`);
		const own = next.ownTemp()!;
		fs.writeFileSync(path.join(own, "work"), "the next answer's");
		late.let();
		assert((await late.run).startsWith("ended:") && late.stopped(), `3 the late box stops itself, got ${await late.run}, stopped ${late.stopped()}`);
		assert(!before.ownTemp(), "3 it is nobody's box");
		assert(fs.existsSync(path.join(own, "work")), "3 the next answer's own temp is as it was");
		console.log("ok 3 a box that starts after its turn ended stops itself and leaves the next answer's temp alone");

		const left = path.join(path.dirname(own), "temp-left");
		await next.endTurn();
		fs.mkdirSync(left);
		const inTurn = await startOf(next);
		inTurn.let();
		assert((await inTurn.run) === "runs", `5 the same room's next turn has its box, got ${await inTurn.run}`);
		await waitUntil(() => !fs.existsSync(left), "5 what an earlier turn left is cleared");
		assert(temps(room).length >= 1 && fs.existsSync(next.ownTemp()!), "5 and its own temp stays");
		await next.endTurn();
		console.log("ok 5 a box that starts within its turn runs, and clears what was left");
	} finally {
		for (const record of started) record.let();
		BoxProcess.start = realStart;
		fs.rmSync(persistentAgentRootPath("late-start-room"), { recursive: true, force: true });
	}
}
