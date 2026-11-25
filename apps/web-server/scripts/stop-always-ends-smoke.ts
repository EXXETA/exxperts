// Stop ends an answer within a few seconds, whatever the model or a tool does
// (turn-forced-end.ts). On the detached-turn rig, with a server whose model
// calls never hear their abort and whose commands can't be killed
// (smoke-ignores-stop-preload.mjs). Proves:
//   1. a model call that ignores Stop: the room is idle within the limit, the
//      question and the words on screen are in the conversation once, the page
//      is let go and the next message is answered;
//   2. after such an end, Remember, Forget, switching, deleting the
//      conversation, changing the model, archiving and deleting the room work;
//   3. a command that ignores Stop: the same end, and what it does late stays
//      out of the conversation;
//   4. Stop, then leave at once: the same limit;
//   5. a turn that runs on its own: an away limit, and Stop by a page that
//      stepped back into it, which keeps its connection and is told why;
//   6. Forget pressed while the answer runs ends it within the same limit;
//   7. a stop of the app does not wait for it, and the next start lands what
//      was running;
//   8. a scheduled run's time limit ends it within the limit, and what it says
//      late stays out of its conversation;
//   9. a Stop the model hears leaves what it always left, and the connection;
//  10. on a shared server, Stop on one page of a room ends it for the room's
//      pages alone, and they come back to one live session;
//  11. there, Stop on a scheduled answer ends it and its run, and what it
//      spends late is one scheduled row.
import fs from "node:fs";
import path from "node:path";
import { rememberPartsOfPage } from "../src/memory-typed-text.js";
import { STOP_CUT_ANSWER_SENTENCE } from "../src/turn-ended-by.js";
import { STOP_LIMIT_MS } from "../src/turn-forced-end.js";
import { assert, agentDir, baseUrl, createRoom, DEAF_MARKER, DEAF_TEXT, DEAF_TOOL_MARKER, FAST_ANSWER_CHUNKS, type GatewayRequest, gatewayRequests, getStatus, getThread, LATE_TEXT, productAppRoot, putThread, QUIET_MARKER, REFUSED_MARKER, repoRoot, reportDetachedFailure, requestJson, scriptDir, server, spawnDetachedServer, startDetachedServer, stopDetachedServer, tempHome, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";
import "./smoke-ignores-stop-preload.mjs";
import { putRunWithoutAsking, treeEnded } from "./smoke-server-process.js";

const SILENCE_MS = 2_500;
// The limit, and time for a loaded machine to act on it: on a hung turn the old code never ended at all.
const WITHIN_MS = STOP_LIMIT_MS + 5_000;
const LIMITS = { silenceMs: SILENCE_MS, limitMs: 120_000 };
const serverEnv = { NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ""} --import=${new URL(`file://${path.join(scriptDir, "smoke-ignores-stop-preload.mjs")}`).href}`.trim(), SMOKE_KILLS_OFF_FILE: path.join(tempHome, "kills-off") };
const json = { "content-type": "application/json" };
const killsOff = serverEnv.SMOKE_KILLS_OFF_FILE;
const workspaceRoot = path.join(tempHome, "stop-workspace");
const fast = FAST_ANSWER_CHUNKS.join("");
const post = (pathname: string, body: unknown) => requestJson(pathname, { method: "POST", headers: json, body: JSON.stringify(body) });
const played = (tag: string): GatewayRequest | undefined => gatewayRequests.find((row) => row.played === tag);
const inFlight = async (roomId: string): Promise<boolean> => (await getStatus(roomId)).activeThread?.inFlight === true;

type Room = { roomId: string; conversationId: string; ws: WsHarness };

async function openRoom(name: string): Promise<Room> {
	const roomId = await createRoom(name);
	const conversationId = `stopconv_${Math.random().toString(36).slice(2, 10)}`;
	assert((await putThread(roomId, conversationId, [])).status === 200, `${name}: the conversation is saved`);
	const ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", `${name}: ready frame`);
	return { roomId, conversationId, ws };
}

/** A first answered message, then one whose answer starts and never hears a stop. */
async function deafAnswer(room: Room, tag: string, marker = DEAF_MARKER): Promise<void> {
	room.ws.send({ type: "prompt", id: `${tag}first`, text: `Say hello for ${tag}.` });
	await room.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", `${tag}: the first answer`);
	await waitUntil(async () => !(await inFlight(room.roomId)), `${tag}: the first answer settled`);
	const from = room.ws.frames.length;
	room.ws.send({ type: "prompt", id: `${tag}asked`, text: `Never stop. ${marker}:${tag}`, shown: { text: `Never stop ${tag}`, files: [] } });
	await waitUntil(() => !!played(`${marker}:${tag}`), `${tag}: the call reached the gateway`);
	if (marker === DEAF_MARKER) await room.ws.waitFor((frame) => frame.event?.type === "message_update", `${tag}: the answer starts`, from);
	else await room.ws.waitFor((frame) => frame.event?.type === "tool_execution_start", `${tag}: the command starts`, from);
}

async function idleAfter(roomId: string, since: number, label: string): Promise<number> {
	await waitUntil(async () => !(await inFlight(roomId)), `${label}: the room is idle`, WITHIN_MS);
	return Date.now() - since;
}

const itemsOf = async (room: Room): Promise<any[]> => (await getThread(room.roomId, room.conversationId)).items ?? [];
const words = (items: any[]) => JSON.stringify(items.map((item) => `${item.kind}:${item.id}:${item.text ?? item.name ?? ""}`));

/** The question once, the words the person saw once and cut there, and nothing the model said after. */
function readsStopped(items: any[], tag: string): void {
	assert(items.filter((item) => item.kind === "user" && item.id === `${tag}asked`).length === 1, `${tag}: the question is there once, got ${words(items)}`);
	const parts = items.filter((item) => item.kind === "assistant" && String(item.id).startsWith(`${tag}asked`));
	assert(parts.length === 1 && parts[0].text === "Words before" && parts[0].stoppedAt === "Words before".length, `${tag}: the words on screen at the Stop are there once, marked as cut, got ${JSON.stringify(parts)}`);
	assert(!JSON.stringify(items).includes(LATE_TEXT), `${tag}: nothing said after the Stop, got ${words(items)}`);
}

async function nextMessageAnswered(room: Room, tag: string): Promise<void> {
	const ws = await WsHarness.connect(room.roomId, room.conversationId);
	await ws.waitFor((frame) => frame.type === "ready", `${tag}: the room opens again`);
	ws.send({ type: "prompt", id: `${tag}next`, text: "And now?" });
	await ws.waitFor((frame) => frame.event?.type === "agent_end", `${tag}: the next message is answered`);
	await waitUntil(async () => !(await inFlight(room.roomId)), `${tag}: the next answer settled`);
	assert((await itemsOf(room)).some((item) => item.kind === "assistant" && String(item.id).startsWith(`${tag}next`) && item.text === fast), `${tag}: the next answer is in the conversation`);
	ws.close();
}

let failed = 0;
/** One row: a row that fails is told, and the rows after it still run. */
async function row(name: string, body: () => Promise<string | void>): Promise<void> {
	try {
		const said = await body();
		console.log(`ok ${name}${said ? `: ${said}` : ""}`);
	} catch (error) {
		failed++;
		console.error(`FAILED ${name}: ${(error as Error)?.message ?? error}`);
	}
}

try {
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	await startDetachedServer(LIMITS, { env: serverEnv, moreModels: ["other-model"] });

	// --- 1. A model call that ignores Stop.
	await row("1 a model call that ignores Stop", async () => {
		const room = await openRoom("Deaf Room");
		await deafAnswer(room, "deaf");
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort", shown: "Words before".length });
		await waitUntil(async () => (await getStatus(room.roomId)).activeThread?.cancelling === true, "deaf: the Stop is taken");
		const took = await idleAfter(room.roomId, stoppedAt, "deaf");
		assert(took > STOP_LIMIT_MS - 500, `deaf: a stop gets its whole limit first, ended after ${took} ms`);
		assert(!played(`${DEAF_MARKER}:deaf`)!.finished, "deaf: the model call itself still hangs");
		const status = await getStatus(room.roomId);
		assert(status.activeThread?.activeTurn?.lastTerminalReason === "cancelled", `deaf: it ended as a Stop, got ${JSON.stringify(status.activeThread?.activeTurn)}`);
		await waitUntil(() => room.ws.closed, "deaf: the page is let go");
		await waitUntil(async () => !(await getStatus(room.roomId)).activeLock, "deaf: the room is free");
		readsStopped(await itemsOf(room), "deaf");
		await nextMessageAnswered(room, "deaf");
		readsStopped(await itemsOf(room), "deaf");
		return `idle ${took} ms after it, stopped once in the conversation, the next message is answered`;
	});

	// --- 2. Every action that was refused while the room was stopping, a room each.
	{
		const acts = ["remember", "forget", "switch", "deleteconversation", "model", "archive", "deleteroom"] as const;
		const rooms = new Map<string, Room>();
		for (const act of acts) {
			const room = await openRoom(`Act ${act}`);
			rooms.set(act, room);
			await deafAnswer(room, act);
		}
		const stoppedAt = Date.now();
		for (const room of rooms.values()) room.ws.send({ type: "abort", shown: "Words before".length });
		// Each action tells for itself whether its room was free: a room that never came back fails its own row.
		await Promise.allSettled([...rooms].map(async ([act, room]) => {
			await idleAfter(room.roomId, stoppedAt, act);
			await waitUntil(async () => !(await getStatus(room.roomId)).activeLock, `${act}: the room is free`, WITHIN_MS);
		}));

		await row("2 after an answer ended by force, Remember reads and saves", async () => {
			const remember = rooms.get("remember")!;
			const proposed = await post(`/api/persistent-agents/${remember.roomId}/checkpoint/propose`, { conversationId: remember.conversationId, density: "standard" });
			assert(proposed.status === 200, `remember: it reads the conversation, got ${proposed.status} ${JSON.stringify(proposed.body)}`);
			const read = rememberPartsOfPage(String(proposed.body.proposedRecentContext));
			assert(read, "remember: the page splits into its parts");
			const saved = await post(`/api/persistent-agents/${remember.roomId}/checkpoint/approve`, { conversationId: remember.conversationId, density: proposed.body.density, proposal: proposed.body, approvedFields: read.parts });
			assert(saved.status === 200 && String(saved.body?.postCheckpoint?.activeThreadId ?? "") !== "" && saved.body.postCheckpoint.activeThreadId !== remember.conversationId, `remember: it saves and a fresh conversation follows, got ${saved.status} ${JSON.stringify(saved.body).slice(0, 300)}`);
		});

		await row("2 after an answer ended by force, Forget closes the conversation", async () => {
			const forget = rooms.get("forget")!;
			const forgot = await post(`/api/persistent-agents/${forget.roomId}/memento`, { conversationId: forget.conversationId });
			assert(forgot.status === 200, `forget: it closes the conversation, got ${forgot.status} ${JSON.stringify(forgot.body)}`);
		});

		await row("2 after an answer ended by force, the room switches to another conversation", async () => {
			const switching = rooms.get("switch")!;
			const other = await putThread(switching.roomId, "stopconv_another", [{ kind: "user", id: "other-user", text: "Another conversation." }]);
			assert(other.status === 200 && (await getStatus(switching.roomId)).activeThread?.threadId === "stopconv_another", `switch: the room moves to another conversation, got ${other.status} ${JSON.stringify(other.body)}`);
		});

		await row("2 after an answer ended by force, the conversation is deleted", async () => {
			const deleting = rooms.get("deleteconversation")!;
			const deleted = await requestJson(`/api/persistent-agents/${deleting.roomId}/threads/${deleting.conversationId}`, { method: "DELETE" });
			assert(deleted.status === 200 && deleted.body?.ok === true, `delete: the conversation goes, got ${deleted.status} ${JSON.stringify(deleted.body)}`);
		});

		await row("2 after an answer ended by force, the model changes", async () => {
			const model = rooms.get("model")!;
			const switched = await post(`/api/persistent-agents/${model.roomId}/threads/${model.conversationId}/switch-model`, { provider: "openai-compatible", model: "other-model" });
			assert(switched.status === 200 && (await getThread(model.roomId, model.conversationId)).model?.model === "other-model", `model: the conversation goes on with another model, got ${switched.status} ${JSON.stringify(switched.body)}`);
		});

		await row("2 after an answer ended by force, the room is archived", async () => {
			const archive = rooms.get("archive")!;
			const archived = await post(`/api/persistent-agents/${archive.roomId}/archive`, { confirmation: `DELETE ${archive.roomId}` });
			assert(archived.status === 200, `archive: the room is archived, got ${archived.status} ${JSON.stringify(archived.body)}`);
		});

		await row("2 after an answer ended by force, the room is deleted", async () => {
			const purge = rooms.get("deleteroom")!;
			const purged = await post(`/api/persistent-agents/${purge.roomId}/purge`, { confirmation: `DELETE ${purge.roomId} FOREVER` });
			assert(purged.status === 200, `delete: the room is deleted, got ${purged.status} ${JSON.stringify(purged.body)}`);
		});
	}

	// --- 3. A command that can't be killed.
	await row("3 a command that ignores Stop", async () => {
		const room = await openRoom("Deaf Command Room");
		const releaseCommand = () => {
			fs.rmSync(killsOff, { force: true });
			fs.writeFileSync(path.join(workspaceRoot, "release-tool"), "");
		};
		const workspace = await requestJson(`/api/persistent-agents/${room.roomId}/workspace-default`, { method: "PUT", headers: json, body: JSON.stringify({ root: workspaceRoot, displayLabel: "Stop Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
		assert(workspace.status === 200, `tool: commands are on, got ${workspace.status}`);
		assert((await putRunWithoutAsking(`${baseUrl}/api/persistent-agents/${room.roomId}/bash-settings`, true)).status === 200, "tool: commands run without asking");
		try {
			await deafAnswer(room, "tool", DEAF_TOOL_MARKER);
			fs.writeFileSync(killsOff, "");
			const stoppedAt = Date.now();
			room.ws.send({ type: "abort", shown: 0 });
			const took = await idleAfter(room.roomId, stoppedAt, "tool");
			await waitUntil(() => room.ws.closed, "tool: the page is let go");
			const before = JSON.stringify(await itemsOf(room));
			releaseCommand();
			await nextMessageAnswered(room, "tool");
			const after = await itemsOf(room);
			assert(JSON.stringify(after.slice(0, JSON.parse(before).length)) === before, `tool: the stopped answer reads as it did, got ${words(after)}`);
			return `idle ${took} ms after it, the next message is answered`;
		} finally {
			releaseCommand();
		}
	});

	// --- 4. Stop, then leave at once.
	await row("4 Stop, then leave", async () => {
		const room = await openRoom("Deaf Left Room");
		await deafAnswer(room, "left");
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort", shown: "Words before".length });
		await waitUntil(async () => (await getStatus(room.roomId)).activeThread?.cancelling === true, "left: the Stop is taken");
		room.ws.close();
		const took = await idleAfter(room.roomId, stoppedAt, "left");
		readsStopped(await itemsOf(room), "left");
		await nextMessageAnswered(room, "left");
		return `idle ${took} ms after the Stop`;
	});

	// A page that went before the end drew no line: the conversation says it ended, once, whatever the answer had said.
	const told = (items: any[]) => items.filter((item) => item.kind === "system").map((item) => item.text);
	for (const [tag, what] of [["reloadquiet", "nothing on screen"], ["reloadtext", "words on screen"], ["reloadolder", "nothing on screen, under an older line"]] as const) await row(`4 Stop, then the page goes, with ${what}`, async () => {
		const room = await openRoom(`Deaf ${tag} Room`);
		const older = tag === "reloadolder" ? ["An older line."] : [];
		if (older.length) assert((await putThread(room.roomId, room.conversationId, [{ kind: "user", id: "older-asked", text: "Earlier." }, { kind: "system", id: "older-line", text: older[0] }])).status === 200, `${tag}: the older line is saved`);
		room.ws.send({ type: "prompt", id: `${tag}asked`, text: tag !== "reloadtext" ? `Never stop. ${DEAF_MARKER} ${QUIET_MARKER}:${tag}` : `Never stop. ${DEAF_MARKER}:${tag}`, shown: { text: "Never stop", files: [] } });
		await waitUntil(() => gatewayRequests.some((request) => request.played?.endsWith(`:${tag}`)), `${tag}: the call reached the gateway`);
		if (tag === "reloadtext") await room.ws.waitFor((frame) => frame.event?.type === "message_update", `${tag}: the answer starts`);
		const stoppedAt = Date.now();
		// As the page's Stop button sends it.
		room.ws.send({ type: "abort" });
		await waitUntil(async () => (await getStatus(room.roomId)).activeThread?.cancelling === true, `${tag}: the Stop is taken`);
		room.ws.close();
		await idleAfter(room.roomId, stoppedAt, tag);
		const items = await itemsOf(room);
		assert(JSON.stringify(told(items)) === JSON.stringify([...older, STOP_CUT_ANSWER_SENTENCE]) && items.at(-1).kind === "system", `${tag}: the conversation says once that the answer was not finished, got ${words(items)}`);
		const status = await getStatus(room.roomId);
		assert(!status.unseenLandedAnswer && status.activeThread?.threadId === room.conversationId, `${tag}: and the room is no Response ready, got ${JSON.stringify(status.unseenLandedAnswer)}`);
		await nextMessageAnswered(room, tag);
		assert(told(await itemsOf(room)).length === older.length + 1, `${tag}: once, after the next answer too, got ${words(await itemsOf(room))}`);
	});
	for (const [tag, what] of [["again", "the page goes, with nothing on screen"], ["againown", "a page that saved its own line as it left"], ["againlate", "the page goes, its failure saved after the Try again"], ["againafter", "the page goes, its failure saved after the Stop"], ["againcut", "a page that marked the words where it stopped them"]] as const) await row(`4 Stop on a Try again, then ${what}`, async () => {
		const room = await openRoom(`Deaf ${tag} Room`);
		const plays = tag === "againcut" ? `${DEAF_MARKER}:${tag}` : `${QUIET_MARKER}:${tag}`;
		const asked = `Never stop. ${REFUSED_MARKER}:${tag} ${DEAF_MARKER} ${plays}`;
		room.ws.send({ type: "prompt", id: `${tag}asked`, text: `[FILE ATTACHED: notes.md]\n${asked}`, shown: { text: "Never stop", files: [{ name: "notes.md", bytes: 12, extension: "md" }] } });
		await room.ws.waitFor((frame) => frame.event?.type === "agent_end", `${tag}: the refused answer ends`);
		await waitUntil(async () => !(await inFlight(room.roomId)), `${tag}: the refused answer settled`);
		// The failure's line as the page saves it, the item the Try again continues.
		const failed = [...(await itemsOf(room)), { kind: "system", id: `${tag}-line`, text: "The model refused this message.", level: "error" }];
		const saveFailure = async () => assert((await putThread(room.roomId, room.conversationId, failed)).status === 200, `${tag}: the page saves its failure line`);
		if (!["againlate", "againafter"].includes(tag)) await saveFailure();
		room.ws.send({ type: "continue", id: `${tag}key` });
		await waitUntil(() => !!played(plays), `${tag}: the call reached the gateway`);
		if (tag === "againlate") await saveFailure();
		if (tag === "againcut") await room.ws.waitFor((frame) => frame.event?.type === "message_update", `${tag}: its words reach the page`, room.ws.frames.length - 1);
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort" });
		await waitUntil(async () => (await getStatus(room.roomId)).activeThread?.cancelling === true, `${tag}: the Stop is taken`);
		if (tag === "againafter") await saveFailure();
		if (tag === "againown") assert((await putThread(room.roomId, room.conversationId, [...(await itemsOf(room)), { kind: "system", id: `${tag}-own`, text: "Response interrupted because you left the room." }])).status === 200, `${tag}: the page saves as it leaves`);
		if (tag === "againcut") assert((await putThread(room.roomId, room.conversationId, [...(await itemsOf(room)), { kind: "assistant", id: `${tag}key-a1`, text: "Words before\n\n_You stopped this answer._", streaming: false, stoppedAt: "Words before".length }])).status === 200, `${tag}: the page saves the words it stopped`);
		room.ws.close();
		await idleAfter(room.roomId, stoppedAt, tag);
		const items = await itemsOf(room);
		const failure = "The model refused this message.";
		// A failure saved late is placed after the stopped line, which goes after the item the Try again continued; one the
		// server first hears of after the Stop can't be told from the page's own line, so nothing is added to it.
		const says = { again: [failure, STOP_CUT_ANSWER_SENTENCE], againown: [failure, "Response interrupted because you left the room."], againlate: [STOP_CUT_ANSWER_SENTENCE, failure], againafter: [failure], againcut: [failure] }[tag];
		assert(JSON.stringify(told(items)) === JSON.stringify(says), `${tag}: the conversation says it as it should, got ${words(items)}`);
		await nextMessageAnswered(room, tag);
		assert(told(await itemsOf(room)).length === says.length, `${tag}: once, after the next answer too, got ${words(await itemsOf(room))}`);
	});
	await row("4 Stop, then a page that saved its own line as it left", async () => {
		const room = await openRoom("Deaf Own Line Room");
		await deafAnswer(room, "ownline");
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort" });
		await waitUntil(async () => (await getStatus(room.roomId)).activeThread?.cancelling === true, "ownline: the Stop is taken");
		const saved = await itemsOf(room);
		const left = await putThread(room.roomId, room.conversationId, [...saved, ...(saved.some((item) => item.id === "ownlineasked") ? [] : [{ kind: "user", id: "ownlineasked", text: "Never stop ownline" }]), { kind: "system", id: "ownline-line", text: "Response interrupted because you left the room." }]);
		assert(left.status === 200, `ownline: the page saves as it leaves, got ${left.status} ${JSON.stringify(left.body)}`);
		room.ws.close();
		await idleAfter(room.roomId, stoppedAt, "ownline");
		assert(JSON.stringify(told(await itemsOf(room))) === JSON.stringify(["Response interrupted because you left the room."]), `ownline: only the page's own line is there, got ${words(await itemsOf(room))}`);
	});

	// --- 5. A turn that runs on its own.
	await row("5 an away limit", async () => {
		const room = await openRoom("Deaf Away Room");
		await deafAnswer(room, "away");
		room.ws.close();
		const leftAt = Date.now();
		await waitDetached(room.roomId, "away");
		await waitUntil(async () => !(await inFlight(room.roomId)), "away: the room is idle", SILENCE_MS + WITHIN_MS);
		const took = Date.now() - leftAt;
		const items = await itemsOf(room);
		assert(items.filter((item) => item.kind === "system" && item.failure === "away-no-progress").length === 1 && items.some((item) => item.kind === "assistant" && item.text === DEAF_TEXT.trim()), `away: what it wrote is kept under the limit's line, got ${words(items)}`);
		assert((await getStatus(room.roomId)).activeThread?.activeTurn?.lastTerminalReason === "failed", "away: a limit nobody pressed is no Stop");
		await waitUntil(async () => !(await getStatus(room.roomId)).activeLock, "away: the room is free");
		await nextMessageAnswered(room, "away");
		return `idle ${took} ms after the leave, with its own line`;
	});
	await row("5 Stop by a page that stepped back in", async () => {
		const back = await openRoom("Deaf Back Room");
		await deafAnswer(back, "back");
		back.ws.close();
		await waitDetached(back.roomId, "back");
		const backIn = await WsHarness.connect(back.roomId, back.conversationId);
		await backIn.waitFor((frame) => frame.type === "turn_reattach_replay_done", "back: the window steps back in");
		const from = backIn.frames.length;
		const stoppedAt = Date.now();
		backIn.send({ type: "abort", shown: "Words before".length });
		const backTook = await idleAfter(back.roomId, stoppedAt, "back");
		const end = backIn.frames[await backIn.waitFor((frame) => frame.event?.type === "agent_end", "back: the page is told the answer ended", from)];
		assert(end.event.endedBy === "stop" && !backIn.closed, `back: the page is told it was its Stop and keeps its connection, got ${JSON.stringify(end)}`);
		readsStopped(await itemsOf(back), "back");
		const afterEnd = backIn.frames.length;
		backIn.send({ type: "prompt", id: "backnext", text: "And now?" });
		await backIn.waitFor((frame) => frame.event?.type === "agent_end", "back: the next message is answered on the same connection", afterEnd);
		backIn.close();
		return `idle ${backTook} ms after it, on the same connection`;
	});

	// --- 6. Forget while the answer runs.
	await row("6 Forget while a deaf answer runs", async () => {
		const room = await openRoom("Deaf Forget Room");
		await deafAnswer(room, "forgetrun");
		const askedAt = Date.now();
		const forgot = await post(`/api/persistent-agents/${room.roomId}/memento`, { conversationId: room.conversationId });
		const took = Date.now() - askedAt;
		assert(forgot.status === 200 && took < WITHIN_MS, `forget: the running answer ends with the conversation, got ${forgot.status} after ${took} ms`);
		await room.ws.waitFor((frame) => frame.kind === "notify" && String(frame.message).startsWith("This conversation was forgotten."), "forget: the page is told as always");
		await waitUntil(() => room.ws.closed, "forget: the page is let go");
		const fresh = (await getStatus(room.roomId)).activeThread;
		assert(fresh?.threadId !== room.conversationId && fresh?.inFlight !== true, `forget: the room is on its fresh conversation, idle, got ${JSON.stringify(fresh)}`);
		return `done in ${took} ms, the page told as always`;
	});
	await row("6 Forget while an answer that hears its stop runs is as quick as before", async () => {
		const quick = await openRoom("Quick Forget Room");
		quick.ws.send({ type: "prompt", id: "quickforget", text: `Say nothing. ${QUIET_MARKER}:quickforget` });
		await waitUntil(() => !!played(`${QUIET_MARKER}:quickforget`), "quick forget: the call reached the gateway");
		const quickAt = Date.now();
		assert((await post(`/api/persistent-agents/${quick.roomId}/memento`, { conversationId: quick.conversationId })).status === 200 && Date.now() - quickAt < STOP_LIMIT_MS - 1_000, `quick forget: an answer that hears its stop ends at once, took ${Date.now() - quickAt} ms`);
	});

	// --- 9. A Stop the model hears.
	await row("9 a Stop the model hears", async () => {
		const room = await openRoom("Quick Room");
		room.ws.send({ type: "prompt", id: "quickasked", text: `Say nothing. ${QUIET_MARKER}:quick`, shown: { text: "Say nothing", files: [] } });
		await waitUntil(() => !!played(`${QUIET_MARKER}:quick`), "quick: the call reached the gateway");
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort" });
		const took = await idleAfter(room.roomId, stoppedAt, "quick");
		assert(took < STOP_LIMIT_MS - 1_000, `quick: it ends at once, took ${took} ms`);
		const end = room.ws.frames[await room.ws.waitFor((frame) => frame.event?.type === "agent_end", "quick: the page is told")];
		assert(end.event.endedBy === "stop", `quick: by its Stop, got ${JSON.stringify(end)}`);
		// Longer than the limit: nothing of it is left to fire.
		await new Promise((resolve) => setTimeout(resolve, STOP_LIMIT_MS + 500));
		assert(!room.ws.closed, "quick: the connection stays past the limit");
		const from = room.ws.frames.length;
		room.ws.send({ type: "prompt", id: "quicknext", text: "And now?" });
		await room.ws.waitFor((frame) => frame.event?.type === "agent_end", "quick: the next message is answered on the same connection", from);
		room.ws.close();
		return `ends in ${took} ms and keeps the connection`;
	});

	// --- 8. A scheduled run, in this process.
	const scheduledRoom = await createRoom("Scheduled Room");
	await row("8 a scheduled run's time limit", async () => {
		Object.assign(process.env, { HOME: tempHome, USERPROFILE: tempHome, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: path.join(productAppRoot, "personalized-agents"), EXXETA_HOME: repoRoot });
		const background = await import("../src/persistent-room-background-execution.js");
		const { getPersistentAgentThread, getPersistentAgentActiveTurnState } = await import("../src/persistent-agents.js");
		const { AgentSession } = await import("@exxeta/exxperts-runtime");
		// The run's session, to know when it has read the words before the stop.
		let session: any;
		const prompt = AgentSession.prototype.prompt;
		AgentSession.prototype.prompt = function (this: any, ...args: any[]) {
			session = this;
			return (prompt as any).apply(this, args);
		} as typeof prompt;
		const limit = new AbortController();
		const cuts: any[] = [];
		const run = background.executePersistentRoomBackgroundPrompt({ roomId: scheduledRoom, target: { kind: "fresh-thread", model: { provider: "openai-compatible", model: "room-model" } }, prompt: `Never stop. ${DEAF_MARKER}:scheduled`, executionId: "stop-scheduled", cwd: tempHome, agentDir, signal: limit.signal, onCut: (spent: any) => cuts.push(spent) } as any).then(() => null, (error: Error) => error);
		await waitUntil(() => !!played(`${DEAF_MARKER}:scheduled`), "scheduled: the call reached the gateway");
		AgentSession.prototype.prompt = prompt;
		await waitUntil(() => JSON.stringify(session?.agent.state.streamingMessage ?? null).includes(DEAF_TEXT), "scheduled: the run read the words before the stop");
		const cutAt = Date.now();
		limit.abort(Object.assign(new Error("This task reached its time limit."), { code: "time_limit" }));
		const error = await Promise.race([run, new Promise<string>((resolve) => setTimeout(() => resolve("still running"), WITHIN_MS))]);
		const took = Date.now() - cutAt;
		assert(error instanceof Error && error.message === "This task reached its time limit.", `scheduled: the run ends with the limit's own line, got ${String(error)}`);
		const threadId = background.scheduledPromptBackgroundThreadId("stop-scheduled");
		const items: any[] = getPersistentAgentThread(scheduledRoom, threadId)?.items ?? [];
		assert(items.some((item) => item.kind === "assistant" && item.text === DEAF_TEXT.trim()) && items.filter((item) => item.kind === "system" && item.text === "This task reached its time limit.").length === 1, `scheduled: what it wrote is kept above the limit's line, got ${words(items)}`);
		assert(getPersistentAgentActiveTurnState(scheduledRoom, threadId).state === "idle" && cuts.length === 1, `scheduled: its turn is over and its spend was told once, got ${cuts.length}`);
		const before = fs.readFileSync(path.join(productAppRoot, "personalized-agents", scheduledRoom, "runtime", "threads", `${threadId}.json`), "utf-8");
		played(`${DEAF_MARKER}:scheduled`)!.release();
		await waitUntil(() => played(`${DEAF_MARKER}:scheduled`)!.finished, "scheduled: the late answer came");
		await waitUntil(() => usageRows(scheduledRoom).length === 1, "scheduled: what it spent late is on the ledger once");
		assert(usageRows(scheduledRoom)[0].kind === "scheduled" && usageRows(scheduledRoom)[0].output === 33, `scheduled: as a scheduled row, got ${JSON.stringify(usageRows(scheduledRoom))}`);
		assert(fs.readFileSync(path.join(productAppRoot, "personalized-agents", scheduledRoom, "runtime", "threads", `${threadId}.json`), "utf-8") === before, "scheduled: the late answer changes nothing in its conversation");
		return `ends it in ${took} ms; what it says late changes nothing`;
	});

	// --- 7. A stop of the app with an answer that ignores it, last: the server goes.
	if (process.platform !== "win32") await row("7 a stop of the app with a deaf answer running", async () => {
		const room = await openRoom("Deaf Server Stop Room");
		await deafAnswer(room, "appstop");
		const app = server!;
		const stoppedAt = Date.now();
		process.kill(-app.pid!, "SIGTERM");
		await waitUntil(() => treeEnded(app), "app stop: the server has exited", 15_000);
		const took = Date.now() - stoppedAt;
		assert(took < STOP_LIMIT_MS, `app stop: it doesn't wait for the answer, took ${took} ms`);
		await spawnDetachedServer(LIMITS, serverEnv);
		const ws = await WsHarness.connect(room.roomId, room.conversationId);
		await ws.waitFor((frame) => frame.type === "ready", "app stop: the room opens after the next start");
		const items = await itemsOf(room);
		assert(items.filter((item) => item.kind === "user" && item.id === "appstopasked").length === 1 && items.filter((item) => item.kind === "system" && item.text === STOP_CUT_ANSWER_SENTENCE).length === 1, `app stop: the question and the app's own line are there once, got ${words(items)}`);
		ws.send({ type: "prompt", id: "appstopnext", text: "And now?" });
		await ws.waitFor((frame) => frame.event?.type === "agent_end", "app stop: the next message is answered");
		ws.close();
		return `exits in ${took} ms, and the next start says so once`;
	});
	// --- 10. A shared server: two pages of one room, and Stop on the second.
	if (process.platform !== "win32") await row("10 on a shared server, Stop on the second page of a room", async () => {
		const app = server!;
		process.kill(-app.pid!, "SIGTERM");
		await waitUntil(() => treeEnded(app), "shared: the server has exited", 15_000);
		const sharedEntry = new URL(`file://${path.join(scriptDir, "team-room-shared-server.ts")}`).href;
		await spawnDetachedServer(LIMITS, { ...serverEnv, EXXPERTS_SCHEDULER_PREFLIGHT_LOOP_INTERVAL_MS: "1000", EXXPERTS_SCHEDULER_EXECUTION_LOOP_INTERVAL_MS: "1000" }, [sharedEntry]);
		const room = await openRoom("Deaf Shared Room");
		const other = await openRoom("Other Shared Room");
		const second = await WsHarness.connect(room.roomId, room.conversationId);
		await second.waitFor((frame) => frame.type === "ready", "shared: the second page joins the room");
		await deafAnswer(room, "shared");
		await second.waitFor((frame) => frame.event?.type === "message_update", "shared: the second page follows the answer");
		const stoppedAt = Date.now();
		second.send({ type: "abort", shown: "Words before".length });
		const took = await idleAfter(room.roomId, stoppedAt, "shared");
		await waitUntil(() => room.ws.closed && second.closed, "shared: both pages are let go");
		assert(!other.ws.closed, "shared: a page of another room keeps its connection");
		readsStopped(await itemsOf(room), "shared");
		// Both come back, and the room is one live session again: the answer to the first is followed by the second.
		const back = await WsHarness.connect(room.roomId, room.conversationId);
		await back.waitFor((frame) => frame.type === "ready", "shared: the room opens again");
		const backToo = await WsHarness.connect(room.roomId, room.conversationId);
		await backToo.waitFor((frame) => frame.type === "ready", "shared: the second page joins it again");
		back.send({ type: "prompt", id: "sharednext", text: "And now?" });
		await backToo.waitFor((frame) => frame.event?.type === "agent_end", "shared: the next answer ends on both pages");
		await waitUntil(async () => !(await inFlight(room.roomId)), "shared: the next answer settled");
		readsStopped(await itemsOf(room), "shared");
		for (const ws of [back, backToo, other.ws]) ws.close();
		return `idle ${took} ms after it; both pages come back to one session`;
	});
	if (process.platform !== "win32") await row("11 on a shared server, Stop on a scheduled answer in an open room", async () => {
		const room = await openRoom("Scheduled Shared Room");
		room.ws.send({ type: "prompt", id: "roomschedfirst", text: "Say hello." });
		await room.ws.waitFor((frame) => frame.event?.type === "agent_end", "room schedule: the first answer");
		await waitUntil(async () => !(await inFlight(room.roomId)), "room schedule: the first answer settled");
		const spent = usageRows(room.roomId).length;
		assert((await requestJson("/smoke/quiet-spell?ms=500", { method: "POST" })).status === 200, "room schedule: the quiet spell is short");
		const from = room.ws.frames.length;
		const saved = await post(`/api/persistent-agents/${room.roomId}/schedules`, { name: "Smoke check", type: "once", schedule: "+1s", prompt: `Never stop. ${DEAF_MARKER}:roomsched`, enabled: true });
		const job = String(saved.body?.job?.id ?? "");
		assert(saved.status === 201 && job, `room schedule: the schedule is saved, got ${saved.status} ${JSON.stringify(saved.body)}`);
		await room.ws.waitFor((frame) => frame.type === "turn_reattach" && frame.startsAnswer === true, "room schedule: the page sees it start", from, 30_000);
		await room.ws.waitFor((frame) => frame.event?.type === "message_update", "room schedule: its words reach the page", from);
		const stoppedAt = Date.now();
		room.ws.send({ type: "abort", shown: "Words before".length });
		const took = await idleAfter(room.roomId, stoppedAt, "room schedule");
		const runOf = async () => ((await requestJson(`/api/persistent-agents/${room.roomId}/background-runs?scheduleId=${encodeURIComponent(job)}`)).body?.runs ?? [])[0];
		await waitUntil(async () => !["running", "queued"].includes((await runOf())?.status), "room schedule: the run ends with it");
		assert(usageRows(room.roomId).length === spent, "room schedule: nothing is spent yet");
		const before = JSON.stringify(await itemsOf(room));
		played(`${DEAF_MARKER}:roomsched`)!.release();
		await waitUntil(() => usageRows(room.roomId).length === spent + 1, "room schedule: what it spent late is on the ledger");
		assert(usageRows(room.roomId).at(-1).kind === "scheduled" && usageRows(room.roomId).at(-1).output === 33, `room schedule: once, as a scheduled row, got ${JSON.stringify(usageRows(room.roomId).slice(spent))}`);
		assert(JSON.stringify(await itemsOf(room)) === before, "room schedule: the late answer changes nothing in the conversation");
		return `idle ${took} ms after it, the run ${(await runOf()).status}; its late spend is one scheduled row`;
	});
	assert(failed === 0, `${failed} rows failed`);
} catch (error) {
	reportDetachedFailure(error);
} finally {
	for (const request of gatewayRequests) request.release();
	await stopDetachedServer();
}

function usageRows(roomId: string): any[] {
	try {
		return fs.readFileSync(path.join(productAppRoot, "usage.jsonl"), "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line)).filter((row) => row.agent === roomId);
	} catch {
		return [];
	}
}
