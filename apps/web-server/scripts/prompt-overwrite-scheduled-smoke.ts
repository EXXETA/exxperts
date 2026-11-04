// Two lines of what the model is told, as the model really receives them
// (synthetic gateway, real server, a real scheduled run). Pins:
//   1. a room that can write files, by a write tool or by Bash, is told not to
//      replace a file silently; a room that cannot write is not told;
//   2. a scheduled run is told no one can answer, in a room of any kind, and
//      where it can write it gets the replace line without its "ask"; a live
//      conversation is never told it is a scheduled run, not even right after
//      one, in the conversation that run left behind.
import fs from "node:fs";
import path from "node:path";
import { assert, copiesIn, MODEL, openRoom, personsNewest, requestJson, requests, RoomSocket, startRoomStateServer, stopRoomStateServer, tempHome, waitUntil } from "./room-state-setup.js";

const LIVE_REPLACE = "Before you write a file, look: if a file with that name exists, the user did not ask to change it and you did not make it for them, ask, or write under a new name and say so. Changing or recreating a file the user asked to change, or one you made for them, needs no question.";
const SCHEDULED_REPLACE = "Never replace an existing file unless the task names that file: look first, and if it exists, write under a new name and say so.";
const SCHEDULED_RUN = "This is a scheduled run: no one is present and no one can answer. Never ask, offer or wait: make the reasonable choice, say which, finish the work, and list what you could not do.";
const RUN_LACKS = "This run has no skills or Attachments tools, so this message leaves them out.";
const READ_TOOLS = ["read", "ls", "find", "grep"];

type Folder = { access: "bounded" | "localFiles"; bash?: boolean; tools?: string[] };

async function setFolder(roomId: string, folder: Folder): Promise<void> {
	const root = path.join(tempHome, `folder-${roomId}`);
	fs.mkdirSync(root, { recursive: true });
	const saved = await requestJson(`/api/persistent-agents/${roomId}/workspace-default`, { method: "PUT", body: JSON.stringify({ root, workspaceAccessMode: folder.access, bashEnabled: folder.bash === true, ...(folder.tools ? { toolSelection: { kind: "custom", allowedToolNames: folder.tools } } : {}) }) });
	assert(saved.status === 200, `the folder should save, got ${saved.status}: ${JSON.stringify(saved.body).slice(0, 300)}`);
}

/** The copy a person's first message sends. */
async function liveCopy(name: string, folder?: Folder): Promise<string> {
	const { roomId, conversationId } = await openRoom(name, folder && ((id) => setFolder(id, folder)));
	const room = await RoomSocket.connect(roomId, conversationId);
	const [request] = await room.prompt("Hello.");
	await room.close();
	const [copy] = copiesIn(request);
	assert(copy, "the first message carries a room-state copy");
	return copy;
}

/** A one-time job's run, through the schedule a person saves: the copy it sends and the conversation it leaves. */
async function scheduledCopy(name: string, folder?: Folder): Promise<{ copy: string; roomId: string; threadId: string }> {
	const { roomId } = await openRoom(name, folder && ((id) => setFolder(id, folder)));
	const pinned = await requestJson(`/api/persistent-agents/${roomId}/models`, { method: "PUT", body: JSON.stringify({ conversation: MODEL, memory: MODEL }) });
	assert(pinned.status === 200, `the room's models should save, got ${pinned.status}`);
	const prompt = `Weekly digest for ${name}.`;
	const job = await requestJson(`/api/persistent-agents/${roomId}/schedules`, { method: "POST", body: JSON.stringify({ name: "Digest", type: "once", schedule: "+1s", prompt, enabled: true }) });
	assert(job.status === 200 || job.status === 201, `the job should save, got ${job.status}: ${JSON.stringify(job.body).slice(0, 300)}`);
	let threadId = "";
	await waitUntil(async () => {
		const runs = (await requestJson(`/api/persistent-agents/${roomId}/background-runs`)).body?.runs ?? [];
		threadId = String(runs.find((run: any) => /completed|succeeded/i.test(String(run.status)))?.target?.threadId ?? "");
		return threadId !== "";
	}, `the scheduled run in ${name} ended`, 90_000);
	const request = requests.find((sent) => personsNewest(sent).includes(prompt));
	assert(request, "the run reached the model");
	const [copy] = copiesIn(request);
	assert(copy, "the run sends a room-state copy");
	return { copy, roomId, threadId };
}

const WRITERS: [string, Folder][] = [
	["Bounded", { access: "bounded" }],
	["Full access", { access: "localFiles" }],
	["Full access with Bash", { access: "localFiles", bash: true }],
	["Full access, Bash but no write tools", { access: "localFiles", bash: true, tools: READ_TOOLS }],
];
const NON_WRITERS: [string, Folder | undefined][] = [
	["no folder", undefined],
	["Bounded, read only", { access: "bounded", tools: READ_TOOLS }],
	["Full access, read only", { access: "localFiles", tools: READ_TOOLS }],
];

let error: unknown;
try {
	// A due job becomes a run on these loops' ticks, a minute apart by default, one job at a time.
	process.env.EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS = "1000";
	process.env.EXXPERTS_SCHEDULER_EXECUTION_LOOP_INTERVAL_MS = "1000";
	await startRoomStateServer();

	for (const [label, folder] of WRITERS) {
		const copy = await liveCopy(`Writer ${label}`, folder);
		assert(copy.includes(LIVE_REPLACE), `${label}: the room is told, got:\n${copy}`);
		assert(!copy.includes(SCHEDULED_REPLACE) && !copy.includes(SCHEDULED_RUN), `${label}: a live conversation is not told it is a scheduled run, got:\n${copy}`);
		console.log(`  ok ${label}: a live room that can write is told not to replace silently`);
	}

	for (const [label, folder] of NON_WRITERS) {
		const copy = await liveCopy(`Reader ${label}`, folder);
		assert(!copy.includes(LIVE_REPLACE) && !copy.includes(SCHEDULED_REPLACE), `${label}: a room that cannot write is not told, got:\n${copy}`);
		console.log(`  ok ${label}: a live room that cannot write is not told`);
	}

	const written = await scheduledCopy("Scheduled Writer", { access: "localFiles", bash: true });
	assert(written.copy.includes(SCHEDULED_RUN) && written.copy.includes(RUN_LACKS), `the run is told no one can answer and what it lacks, got:\n${written.copy}`);
	assert(written.copy.includes(SCHEDULED_REPLACE) && !written.copy.includes(LIVE_REPLACE), `the run gets the replace line without its "ask", got:\n${written.copy}`);
	console.log("  ok a scheduled run that can write: both scheduled lines, not the live one");

	for (const [label, folder] of NON_WRITERS) {
		const { copy } = await scheduledCopy(`Scheduled Reader ${label}`, folder);
		assert(copy.includes(SCHEDULED_RUN), `${label}: the run is told no one can answer, got:\n${copy}`);
		assert(!copy.includes(LIVE_REPLACE) && !copy.includes(SCHEDULED_REPLACE), `${label}: a run that cannot write gets no replace line, got:\n${copy}`);
		console.log(`  ok ${label}: a scheduled run that cannot write gets no replace line`);
	}

	const room = await RoomSocket.connect(written.roomId, written.threadId);
	const [request] = await room.prompt("Thanks, and now?");
	await room.close();
	// The run's copy stays in the history; the newest one replaces it.
	const after = copiesIn(request).at(-1);
	assert(after && after.includes(LIVE_REPLACE) && !after.includes(SCHEDULED_REPLACE) && !after.includes(SCHEDULED_RUN), `a person opening the run's conversation gets the live lines, got:\n${after}`);
	console.log("  ok a live turn after a scheduled run drops the scheduled lines");
	console.log("prompt-overwrite-scheduled-smoke: passed");
} catch (caught) {
	error = caught;
	console.error(`prompt-overwrite-scheduled-smoke: FAILED: ${(caught as Error).message}`);
	process.exitCode = 1;
} finally {
	await stopRoomStateServer(error);
}
