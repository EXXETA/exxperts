// Stop ends a turn whose conversation is being shortened, end to end: a real
// server, a room over its socket, and a provider whose summaries take forever.
//
// - Stop while it is shortened before a message is sent: the message is not
//   sent, no second shortening starts, and the next message is accepted and
//   answered within two seconds.
// - Stop while it is shortened after a refusal: the same, and the model is not
//   asked again.
// - Not stopped, the same shortening ends and the model is asked again.
import { assert, type SizeLimitRoom, SizeLimitRooms, TOO_LONG_FOR_MODEL, waitUntil } from "./size-limit-setup.js";

const FREE_WITHIN_MS = 2000;
// Longer than the runtime waits before it asks again after a shortening.
const QUIET_MS = 1000;
const rooms = new SizeLimitRooms();
const { gateway } = rooms;

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// A room with one answer, then a message refused as too long, whose shortening has begun.
async function shortening(displayName: string): Promise<SizeLimitRoom> {
	gateway.refuseChats = 0;
	gateway.holdSummaries = true;
	const room = await rooms.room(displayName);
	await room.say("say something");
	gateway.refuseChats = Infinity;
	const from = room.start("say something very long");
	await waitUntil(() => gateway.requests.slice(from.requests).some((request) => request.summary), `${displayName}: the shortening starts`);
	gateway.refuseChats = 0;
	return room;
}

async function stopped(room: SizeLimitRoom, label: string): Promise<void> {
	const frames = room.framesFrom(0).length;
	const requests = gateway.requests.length;
	const pressed = Date.now();
	room.send({ type: "abort" });
	await room.settled(`${label}: Stop ends the turn`, FREE_WITHIN_MS);
	const from = room.start("hello");
	await waitUntil(() => room.framesFrom(from.frames).some((frame) => frame.event?.type === "agent_start"), `${label}: the next message is accepted`);
	const took = Date.now() - pressed;
	const next = await room.ended(from, `${label}: the next message`);
	assert(next.answer.endsWith("Answered: hello") && !next.frames.some((frame) => frame.code === "turn_running"), `${label}: the next message is answered, got "${next.answer}" ${JSON.stringify(next.failures).slice(0, 300)}`);
	assert(took < FREE_WITHIN_MS, `${label}: accepted within ${FREE_WITHIN_MS} ms of Stop, got ${took}`);
	assert(gateway.requests.length === requests + 1, `${label}: only the next message's request followed Stop, got ${JSON.stringify(gateway.requests.slice(requests))}`);
	await new Promise((resolve) => setTimeout(resolve, QUIET_MS));
	assert(gateway.requests.length === requests + 1, `${label}: nothing more follows later, got ${JSON.stringify(gateway.requests.slice(requests))}`);
	const failures = room.framesFrom(frames).filter((frame) => frame.event?.failure || frame.type === "error" || (frame.type === "ui_request" && frame.level === "error"));
	assert(failures.length === 0, `${label}: Stop shows no failure, got ${JSON.stringify(failures).slice(0, 400)}`);
}

try {
	await rooms.open();
	gateway.refusal = TOO_LONG_FOR_MODEL;

	{
		const room = await shortening("Stop Before A Send");
		// The refused message is the conversation's last when the server starts again, so the next message is shortened for before it is sent.
		await rooms.restart();
		await room.connect();
		const from = room.start("say something else");
		await waitUntil(() => gateway.requests.slice(from.requests).some((request) => request.summary), "the shortening before the send starts");
		assert(gateway.requests.length === from.requests + 1, "nothing was sent before the shortening");
		await stopped(room, "before a send");
		pass("Stop while a conversation is shortened before a send: the message goes nowhere, and the next one is answered within two seconds");
	}

	{
		const room = await shortening("Stop After A Refusal");
		await stopped(room, "after a refusal");
		pass("Stop while a conversation is shortened after a refusal: the model is not asked again, and the next message is answered within two seconds");
	}

	{
		gateway.refuseChats = 0;
		gateway.holdSummaries = false;
		const room = await rooms.room("Not Stopped");
		await room.say("say something");
		gateway.refuseChats = 1;
		const from = room.start("say something very long");
		await waitUntil(() => room.framesFrom(from.frames).some((frame) => frame.event?.type === "message_end" && JSON.stringify(frame.event.message?.content ?? "").includes("Answered: ")), "not stopped, the model is asked again and answers");
		const sent = gateway.requests.slice(from.requests);
		assert(sent.filter((request) => !request.summary).length === 2 && sent.some((request) => request.summary), `the refused request, the summary and one ask-again, got ${JSON.stringify(sent)}`);
		pass("not stopped, the shortening ends and the model is asked again once");
	}
	console.log("stop-ends-shortening smoke passed");
} catch (error) {
	console.error(`stop-ends-shortening-smoke FAILED: ${(error as Error).message}`);
	console.error(rooms.output.join("").slice(-3000));
	process.exitCode = 1;
} finally {
	await rooms.close();
}
