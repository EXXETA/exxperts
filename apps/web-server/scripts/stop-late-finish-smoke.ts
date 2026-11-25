// What an answer ended by force (turn-forced-end.ts) does late changes nothing
// a person or the next answer can see. On the detached-turn rig, with model
// calls that never hear their abort (smoke-ignores-stop-preload.mjs) and that
// the smoke lets finish when it wants. Proves:
//   1. after Remember saved the stopped conversation, the late finish leaves
//      its thread file, its transcript's bytes, the memory page, the answer's
//      note, the room's unseen mark and the fresh conversation as they were,
//      and what it spent is on the usage ledger once;
//   2. a late finish while Remember reads leaves its page good to save;
//   3. a late finish during the next answer ends nothing of it: the room
//      stays busy with that answer's own turn, which then lands whole;
//   4. the next message tells the model what the person saw of the stopped
//      answer, once, and a late finish brings that note back for nobody;
//   5. a document that was being read when its answer was ended by force, and
//      whose parser answers after the room was deleted, brings nothing of the
//      room back, nor into a new room of the same name with a file of the same
//      name; a room that was archived, or stayed, keeps its files as they were.
import fs from "node:fs";
import path from "node:path";
import { rememberPartsOfPage } from "../src/memory-typed-text.js";
import { persistentRoomReadingCacheDirPath, persistentRoomShelfDirPath } from "../src/persistent-room-shelf.js";
import { assert, createRoom, DEAF_MARKER, DEAF_READ_FILE, DEAF_READ_MARKER, DEAF_TEXT, type GatewayRequest, gatewayRequests, getStatus, getThread, LATE_TEXT, LATE_USAGE, productAppRoot, putThread, rememberHold, reportDetachedFailure, requestJson, scriptDir, startDetachedServer, stopDetachedServer, tempHome, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

const json = { "content-type": "application/json" };
const post = (pathname: string, body: unknown) => requestJson(pathname, { method: "POST", headers: json, body: JSON.stringify(body) });
const played = (tag: string): GatewayRequest | undefined => gatewayRequests.find((row) => row.played === `${DEAF_MARKER}:${tag}`);
const inFlight = async (roomId: string): Promise<boolean> => (await getStatus(roomId)).activeThread?.inFlight === true;
const SHOWN = "Words before";
const parserHeld = path.join(tempHome, "parser-held");

/** A PDF of one page with these words. */
function pdfSaying(words: string): Buffer {
	const text = `BT /F1 12 Tf 72 720 Td (${words}) Tj ET`;
	const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>", `<< /Length ${text.length} >>\nstream\n${text}\nendstream`, "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
	let body = "%PDF-1.4\n";
	const offsets = objects.map((object, index) => {
		const at = body.length;
		body += `${index + 1} 0 obj\n${object}\nendobj\n`;
		return at;
	});
	const xref = offsets.map((at) => `${String(at).padStart(10, "0")} 00000 n \n`).join("");
	return Buffer.from(`${body}xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${body.length}\n%%EOF\n`, "latin1");
}
type Room = { roomId: string; conversationId: string };

/** Every file of the room as it is, by its path: the conversations, the transcripts, the memory, the pieces and the marks. */
function filesOf(room: Room): Map<string, string> {
	const root = path.join(productAppRoot, "personalized-agents", room.roomId);
	const files = new Map<string, string>();
	for (const name of fs.readdirSync(root, { recursive: true }) as string[]) {
		const file = path.join(root, name);
		// The lock's heartbeat and the list's own caches say nothing of the conversation.
		if (fs.statSync(file).isFile() && !/lock/i.test(name)) files.set(name, fs.readFileSync(file, "utf-8"));
	}
	return files;
}

function changed(before: Map<string, string>, after: Map<string, string>): string[] {
	return [...new Set([...before.keys(), ...after.keys()])].filter((name) => before.get(name) !== after.get(name));
}

function usageOf(roomId: string): any[] {
	try {
		return fs.readFileSync(path.join(productAppRoot, "usage.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.agent === roomId && row.output === LATE_USAGE.completion_tokens);
	} catch {
		return [];
	}
}

async function deafAnswer(ws: WsHarness, room: Room, tag: string): Promise<void> {
	const from = ws.frames.length;
	ws.send({ type: "prompt", id: `${tag}asked`, text: `Never stop. ${DEAF_MARKER}:${tag}`, shown: { text: `Never stop ${tag}`, files: [] } });
	await waitUntil(() => !!played(tag), `${tag}: the call reached the gateway`);
	await ws.waitFor((frame) => frame.event?.type === "message_update", `${tag}: the answer starts`, from);
}

/** A room with one answered message, then one stopped answer that was ended by force; its call still hangs. */
async function endedByForce(name: string, tag: string): Promise<Room> {
	const roomId = await createRoom(name);
	const room = { roomId, conversationId: `lateconv_${Math.random().toString(36).slice(2, 10)}` };
	assert((await putThread(roomId, room.conversationId, [])).status === 200, `${tag}: the conversation is saved`);
	const ws = await WsHarness.connect(roomId, room.conversationId);
	await ws.waitFor((frame) => frame.type === "ready", `${tag}: ready frame`);
	ws.send({ type: "prompt", id: `${tag}first`, text: "Say hello." });
	await ws.waitFor((frame) => frame.event?.type === "agent_end", `${tag}: the first answer`);
	await waitUntil(async () => !(await inFlight(roomId)), `${tag}: the first answer settled`);
	await deafAnswer(ws, room, tag);
	ws.send({ type: "abort", shown: SHOWN.length });
	await waitUntil(() => ws.closed, `${tag}: the page is let go`);
	assert(!(await inFlight(roomId)) && !played(tag)!.finished, `${tag}: the room is idle while the call still hangs`);
	return room;
}

/** Lets the hung call finish, and waits until the server has heard it: what it spent is on the ledger. */
async function finishLate(room: Room, tag: string): Promise<void> {
	assert(usageOf(room.roomId).length === 0, `${tag}: nothing of the hung call is on the ledger yet`);
	played(tag)!.release();
	await waitUntil(() => usageOf(room.roomId).length > 0, `${tag}: what the call spent is on the ledger`);
}

const propose = (room: Room) => post(`/api/persistent-agents/${room.roomId}/checkpoint/propose`, { conversationId: room.conversationId, density: "standard" });
async function approve(room: Room, proposal: any): Promise<{ status: number; body: any }> {
	const read = rememberPartsOfPage(String(proposal.proposedRecentContext));
	assert(read, "the page splits into its parts");
	return post(`/api/persistent-agents/${room.roomId}/checkpoint/approve`, { conversationId: room.conversationId, density: proposal.density, proposal, approvedFields: read.parts });
}

try {
	let unchanged = () => {};
	const preload = new URL(`file://${path.join(scriptDir, "smoke-ignores-stop-preload.mjs")}`).href;
	await startDetachedServer(undefined, { env: { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${preload}`.trim(), SMOKE_PARSER_HELD_FILE: parserHeld } });

	// --- 1. Remember saved, then the late finish.
	{
		const room = await endedByForce("Late Remember Room", "remembered");
		const proposed = await propose(room);
		assert(proposed.status === 200, `Remember reads, got ${proposed.status} ${JSON.stringify(proposed.body)}`);
		const saved = await approve(room, proposed.body);
		assert(saved.status === 200, `Remember saves, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		const freshId = String(saved.body.postCheckpoint.activeThreadId);
		const before = filesOf(room);
		for (const part of [`runtime/threads/${room.conversationId}.json`, `runtime/pi-sessions/${room.conversationId}.jsonl`, `runtime/threads/${freshId}.json`, "L1b/current.md"]) assert(before.has(path.normalize(part)), `the room keeps ${part}, got ${[...before.keys()].join(", ")}`);
		await finishLate(room, "remembered");
		unchanged = () => {
			const differs = changed(before, filesOf(room));
			assert(differs.length === 0, `the late finish changes no file of the room, got ${differs.join(", ")}`);
		};
		unchanged();
		const status = await getStatus(room.roomId);
		assert(status.activeThread?.threadId === freshId && status.activeThread?.inFlight !== true, `the fresh conversation is untouched, got ${JSON.stringify(status.activeThread)}`);
		const rows = usageOf(room.roomId);
		assert(rows.length === 1 && rows[0].kind === "chat" && rows[0].input === LATE_USAGE.prompt_tokens, `what it spent is on the ledger once, got ${JSON.stringify(rows)}`);
		console.log(`ok 1 after Remember saved, the late finish changes none of the room's ${before.size} files, and its spend is recorded once`);
	}

	// --- 2. The late finish while Remember reads.
	{
		const room = await endedByForce("Late Read Room", "reading");
		let letGo = () => {};
		rememberHold.until = new Promise<void>((resolve) => { letGo = resolve; });
		const asked = propose(room);
		await waitUntil(async () => (await requestJson(`/api/persistent-agents/${room.roomId}/checkpoint/progress?conversationId=${room.conversationId}`)).body?.state === "reading", "Remember reads");
		await finishLate(room, "reading");
		letGo();
		rememberHold.until = undefined;
		const proposed = await asked;
		assert(proposed.status === 200, `Remember's read ends well, got ${proposed.status} ${JSON.stringify(proposed.body)}`);
		const saved = await approve(room, proposed.body);
		assert(saved.status === 200, `its page is good to save, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		console.log("ok 2 a late finish while Remember reads leaves its page good to save");
	}

	// --- 3 and 4. The late finish during the next answer, and the note.
	{
		const room = await endedByForce("Late Next Room", "late");
		const note = path.normalize(`runtime/turn-pieces/${room.conversationId}.note.json`);
		assert((filesOf(room).get(note) ?? "").includes(SHOWN), `the next message will tell the model what the person saw, got ${filesOf(room).get(note)}`);
		const ws = await WsHarness.connect(room.roomId, room.conversationId);
		await ws.waitFor((frame) => frame.type === "ready", "late: the room opens again");
		await deafAnswer(ws, room, "nextdeaf");
		assert(!filesOf(room).has(note), "the note goes with the next message");
		const running = (await getStatus(room.roomId)).activeThread?.activeTurn;
		const from = ws.frames.length;
		await finishLate(room, "late");
		const after = (await getStatus(room.roomId)).activeThread;
		assert(after?.inFlight === true && after.activeTurn?.turnId === running?.turnId && after.cancelling !== true, `the room stays busy with the next answer's own turn, got ${JSON.stringify(after)}`);
		assert(!ws.closed && !JSON.stringify(ws.frames.slice(from)).includes("agent_end"), "the next answer goes on on its page");
		assert(!filesOf(room).has(note), "the late finish leaves no note");
		played("nextdeaf")!.release();
		await ws.waitFor((frame) => frame.event?.type === "agent_end", "the next answer ends", from);
		await waitUntil(async () => !(await inFlight(room.roomId)), "the next answer settled");
		const items: any[] = (await getThread(room.roomId, room.conversationId)).items ?? [];
		const stopped = items.filter((item) => item.kind === "assistant" && String(item.id).startsWith("lateasked"));
		const next = items.filter((item) => item.kind === "assistant" && String(item.id).startsWith("nextdeafasked"));
		assert(next.length === 1 && next[0].text === `${DEAF_TEXT}${LATE_TEXT}`, `the next answer lands whole, got ${JSON.stringify(next)}`);
		assert(stopped.length === 1 && stopped[0].text === SHOWN, `the stopped one reads as it did, got ${JSON.stringify(stopped)}`);
		ws.close();
		// And nothing of it came slowly, behind what it spent.
		unchanged();
		console.log("ok 3 a late finish during the next answer ends nothing of it, and it lands whole");
		console.log("ok 4 the next message carries what the person saw, once, and no late finish brings it back");
	}

	// --- 5. A document's parser that answers late.
	{
		const roots = path.join(productAppRoot, "personalized-agents");
		const named = (roomId: string) => (fs.readdirSync(roots, { recursive: true }) as string[]).filter((name) => name.split(path.sep)[0] === roomId || name.startsWith(`${roomId}${path.sep}`)).map((name) => path.join(roots, name)).filter((file) => fs.statSync(file).isFile());
		const holding = (roomId: string, words: string) => named(roomId).filter((file) => fs.readFileSync(file).includes(words));
		/** A room whose answer was ended by force while the parser's answer for its attachment is held. */
		const readingRoom = async (name: string, tag: string): Promise<Room> => {
			fs.rmSync(`${parserHeld}.answered`, { force: true });
			fs.writeFileSync(parserHeld, "");
			const room = { roomId: await createRoom(name), conversationId: `lateconv_${tag}` };
			fs.mkdirSync(persistentRoomShelfDirPath(room.roomId, { persistentAgentsRoot: roots }), { recursive: true });
			fs.writeFileSync(path.join(persistentRoomShelfDirPath(room.roomId, { persistentAgentsRoot: roots }), DEAF_READ_FILE), pdfSaying("The old price is 60"));
			assert((await putThread(room.roomId, room.conversationId, [])).status === 200, `${tag}: the conversation is saved`);
			const ws = await WsHarness.connect(room.roomId, room.conversationId);
			await ws.waitFor((frame) => frame.type === "ready", `${tag}: ready frame`);
			ws.send({ type: "prompt", id: `${tag}asked`, text: `Read it. ${DEAF_READ_MARKER}:${tag}` });
			await waitUntil(() => fs.existsSync(`${parserHeld}.answered`), `${tag}: the document is read`);
			ws.send({ type: "abort", shown: 0 });
			await waitUntil(() => ws.closed, `${tag}: the page is let go`);
			assert(!(await inFlight(room.roomId)), `${tag}: the room is idle while the parser's answer is held`);
			return room;
		};
		const parserHeardLate = async (): Promise<void> => {
			fs.rmSync(parserHeld, { force: true });
			// The held answer is heard within its 20 ms look; a second room's own read, which comes after it, shows it was.
			const check = await readingCheck();
			assert(check, "the next document is read and kept");
		};
		let checks = 0;
		/** Reads another room's document to its end: what it read is kept beside it. */
		const readingCheck = async (): Promise<boolean> => {
			const roomId = await createRoom(`Read Check Room ${++checks}`);
			const conversationId = `lateconv_check${checks}`;
			fs.mkdirSync(persistentRoomShelfDirPath(roomId, { persistentAgentsRoot: roots }), { recursive: true });
			fs.writeFileSync(path.join(persistentRoomShelfDirPath(roomId, { persistentAgentsRoot: roots }), DEAF_READ_FILE), pdfSaying("The check price is 10"));
			assert((await putThread(roomId, conversationId, [])).status === 200, "the check's conversation is saved");
			const ws = await WsHarness.connect(roomId, conversationId);
			await ws.waitFor((frame) => frame.type === "ready", "the check's ready frame");
			ws.send({ type: "prompt", id: `check${checks}`, text: `Read it. ${DEAF_READ_MARKER}:check${checks}` });
			await ws.waitFor((frame) => frame.event?.type === "agent_end", "the check's answer");
			await waitUntil(async () => !(await inFlight(roomId)), "the check settled");
			ws.close();
			return fs.existsSync(persistentRoomReadingCacheDirPath(roomId, { persistentAgentsRoot: roots })) && fs.readdirSync(persistentRoomReadingCacheDirPath(roomId, { persistentAgentsRoot: roots })).length === 2;
		};

		const gone = await readingRoom("Late Deleted Room", "gone");
		assert((await post(`/api/persistent-agents/${gone.roomId}/purge`, { confirmation: `DELETE ${gone.roomId} FOREVER` })).status === 200, "gone: the room is deleted");
		await parserHeardLate();
		assert(!fs.existsSync(path.join(roots, gone.roomId)), `gone: nothing of the deleted room came back, got ${named(gone.roomId).join(", ")}`);

		const again = await readingRoom("Late Again Room", "again");
		assert((await post(`/api/persistent-agents/${again.roomId}/purge`, { confirmation: `DELETE ${again.roomId} FOREVER` })).status === 200, "again: the room is deleted");
		const successor = await createRoom("Late Again Room");
		assert(successor === again.roomId, `again: the new room has the old one's id, got ${successor}`);
		const shelf = persistentRoomShelfDirPath(successor, { persistentAgentsRoot: roots });
		fs.mkdirSync(shelf, { recursive: true });
		fs.writeFileSync(path.join(shelf, DEAF_READ_FILE), pdfSaying("The new price is 90"));
		await parserHeardLate();
		assert(holding(successor, "old price").length === 0, `again: nothing of the deleted room's document is in the new room, got ${holding(successor, "old price").join(", ")}`);

		const archived = await readingRoom("Late Archived Room", "archived");
		assert((await post(`/api/persistent-agents/${archived.roomId}/archive`, { confirmation: `DELETE ${archived.roomId}` })).status === 200, "archived: the room is archived");
		const archivedBefore = filesOf(archived);
		await parserHeardLate();
		const archivedChanges = changed(archivedBefore, filesOf(archived)).filter((name) => !path.join(roots, archived.roomId, name).startsWith(persistentRoomReadingCacheDirPath(archived.roomId, { persistentAgentsRoot: roots })));
		assert(archivedChanges.length === 0, `archived: the room keeps its files as they were, got ${archivedChanges.join(", ")}`);

		const stayed = await readingRoom("Late Stayed Room", "stayed");
		const stayedBefore = filesOf(stayed);
		await parserHeardLate();
		const stayedChanges = changed(stayedBefore, filesOf(stayed));
		const cache = persistentRoomReadingCacheDirPath(stayed.roomId, { persistentAgentsRoot: roots });
		assert(stayedChanges.length === 2 && stayedChanges.every((name) => path.join(roots, stayed.roomId, name).startsWith(cache)), `stayed: only what was read of its own document is kept, got ${stayedChanges.join(", ")}`);
		console.log("ok 5 a parser that answers late brings nothing of a deleted room back, and a room that stayed or was archived keeps its files");
	}
} catch (error) {
	reportDetachedFailure(error);
} finally {
	for (const request of gatewayRequests) request.release();
	await stopDetachedServer();
}
