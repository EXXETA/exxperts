// The room-state copy on the turns that continue without a new message from
// the person, as the model really receives them (synthetic gateway, real
// server). Pins:
//   1. an overflow whose compaction removed every copy: the retry sends one
//      whole copy after the kept message;
//   2. a failed turn with an attached file whose copy came after it, then Try
//      again: the message and its copy are sent once each, no duplicate;
//   3. a room change after a failed turn, then Try again: the continuation
//      carries a new copy with the change, after the kept message;
//   4. a live turn, an instruction edit, a scheduled resume, a live turn: the
//      scheduled run's system prompt carries no instructions, its copy does
//      (without skills or Attachments, which it cannot use), and the next live turn
//      sends a whole copy under the live system prompt it had before.
import { agentDir, assert, copiesIn, isCopy, MODEL, openRoom, personsNewest, rename, requests, RoomSocket, setInstructions, startRoomStateServer, stopRoomStateServer, waitUntil, type SentRequest } from "./room-state-setup.js";

let passes = 0;
const pass = (label: string) => { passes++; console.log(`  ok ${label}`); };
const failures: string[] = [];
/** Runs one case on its own, so a failure in one still lets the others show theirs. */
async function scenario(label: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		pass(label);
	} catch (caught) {
		failures.push(`${label}: ${(caught as Error).message}`);
		console.error(`  FAILED ${label}: ${(caught as Error).message}`);
	}
}
const describe = (request: SentRequest) => JSON.stringify(request.messages.map((message) => `${message.role}: ${message.text.slice(0, 50)}`));

let error: unknown;
const sockets: RoomSocket[] = [];
try {
	await startRoomStateServer();

	// --- 1. Overflow: the compaction removed every copy -------------------------
	await scenario("an overflow whose compaction removed every copy sends one whole copy with the retry", async () => {
		const { roomId, conversationId } = await openRoom("Overflow Room");
		const room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		await room.prompt("Hello.");
		await room.prompt("Hello two.");
		const text = "A long one. OVERFLOW ONCE";
		const from = room.frames.length;
		room.send({ type: "prompt", text });
		await waitUntil(() => requests.filter((request) => personsNewest(request) === text).length >= 2, "the overflowed message is sent again after the compaction");
		await room.waitFor((frame) => frame.type === "event" && frame.event?.type === "compaction_end", "the compaction", from);
		await room.idle();
		const [overflowed, retried] = requests.filter((request) => personsNewest(request) === text);
		assert(copiesIn(overflowed).length === 1, `before the compaction the conversation held the first turn's copy, got ${describe(overflowed)}`);
		assert(!retried.messages.some((message) => message.text === "Hello."), `the compaction removed the first turn and its copy, got ${describe(retried)}`);
		assert(copiesIn(retried).length === 1 && isCopy(retried.messages.at(-1)!) && retried.messages.at(-2)?.text === text, `the retry sends one copy, after the kept message, got ${describe(retried)}`);
		assert(retried.messages.at(-1)!.text.includes("Your name is now **Overflow Room**") && retried.messages.at(-1)!.text.includes("## Current workspace"), "the copy the retry sends is whole");
	});

	// --- 2 and 3. Try again -------------------------------------------------------
	{
		const { roomId, conversationId } = await openRoom("Retry Room");
		const room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		await room.prompt("Hello.");
		await scenario("a failed turn with an attached file, then Try again: the message and its copy once each", async () => {
			// A change, so the failing turn's own copy comes after its message.
			await rename(roomId, "Retry Room Two");
			const attached = "[FILE ATTACHED: notes.md]\nRead the notes. FAIL ONCE";
			const failed = await room.prompt(attached);
			assert(failed.length === 1 && isCopy(failed[0].messages.at(-1)!) && failed[0].messages.at(-1)!.text.includes("Retry Room Two"), `the failing turn sends its copy after the message, got ${failed.map(describe)}`);
			const retried = await room.turn({ type: "continue" });
			assert(retried.length === 1, `Try again asks the model once, got ${retried.length} requests`);
			const sent = retried[0];
			assert(sent.messages.filter((message) => message.role === "user" && message.text === attached).length === 1, `Try again sends the attached-file message once, got ${describe(sent)}`);
			assert(copiesIn(sent).length === 2 && sent.messages.at(-2)?.text === attached && isCopy(sent.messages.at(-1)!), `Try again keeps the turn's copy after the message and adds none, got ${describe(sent)}`);
			assert(!sent.messages.some((message) => message.role === "assistant" && message.text === ""), "the failed attempt is not sent again");
		});

		await scenario("a room change after a failed turn, then Try again: the continuation carries the change", async () => {
			const second = "[FILE ATTACHED: notes.md]\nSummarise the notes. FAIL ONCE";
			const failedAgain = await room.prompt(second);
			assert(failedAgain.length === 1 && failedAgain[0].messages.at(-1)?.text === second, "a turn with nothing changed sends no copy, before it fails");
			await rename(roomId, "Retry Room Three");
			const continued = (await room.turn({ type: "continue" }))[0];
			assert(continued, "Try again after the rename asks the model");
			assert(continued.messages.filter((message) => message.text === second).length === 1 && continued.messages.at(-2)?.text === second, `the message is sent once, got ${describe(continued)}`);
			assert(isCopy(continued.messages.at(-1)!) && continued.messages.at(-1)!.text.includes("Your name is now **Retry Room Three**"), `the continuation carries a new copy with the rename, got ${describe(continued)}`);
		});
	}

	// --- 4. Live turn, instruction edit, scheduled resume, live turn -------------
	await scenario("live turn, instruction edit, scheduled resume, live turn: the copy carries the instructions each time", async () => {
		const { roomId, conversationId } = await openRoom("Scheduled Room");
		let room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		const live = (await room.prompt("Hello."))[0];
		await room.close();
		await setInstructions(roomId, "Use bullet points.");
		const background = await import("../src/persistent-room-background-execution.js");
		const before = requests.length;
		await background.executePersistentRoomBackgroundPrompt({ roomId, target: { kind: "resume-thread", threadId: conversationId, model: MODEL }, prompt: "The scheduled check.", executionId: "room-state-scheduled", agentDir } as any);
		const scheduled = requests.slice(before).find((request) => personsNewest(request).includes("The scheduled check."));
		assert(scheduled, `the scheduled run should reach the model, got ${requests.slice(before).map(describe)}`);
		assert(!scheduled.system.includes("Use bullet points.") && !scheduled.system.includes("## Current instructions"), "the scheduled run's system prompt carries no instructions");
		const scheduledCopy = scheduled.messages.at(-1)!;
		assert(isCopy(scheduledCopy) && scheduledCopy.text.includes("Use bullet points.") && scheduledCopy.text.includes("Your name is now **Scheduled Room**"), `the scheduled run's copy carries the edited instructions, got ${describe(scheduled)}`);
		assert(!scheduledCopy.text.includes("## Attachments in this room") && !scheduledCopy.text.includes("## Enabled skills") && scheduledCopy.text.includes("leaves them out"), `the scheduled run's copy leaves out what it cannot use, got:\n${scheduledCopy.text}`);
		room = await RoomSocket.connect(roomId, conversationId);
		sockets.push(room);
		const after = (await room.prompt("Hello after."))[0];
		assert(after.system === live.system, "the live turn after the scheduled run keeps the live system prompt");
		assert(after.messages.some((message) => message.text === scheduledCopy.text), `the live turn sees the scheduled run's copy, got ${describe(after)}`);
		const liveCopy = after.messages.at(-1)!;
		assert(isCopy(liveCopy) && liveCopy.text.includes("Use bullet points.") && liveCopy.text.includes("## Attachments in this room") && !liveCopy.text.includes("leaves them out"), `the next live turn sends a whole copy, got ${describe(after)}`);
	});

	if (failures.length > 0) throw new Error(`${failures.length} of ${passes + failures.length} cases failed`);
	console.log(`room-state-continuations-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`room-state-continuations-smoke FAILED: ${(caught as Error).message}`);
	process.exitCode = 1;
} finally {
	for (const socket of sockets) await socket.close().catch(() => {});
	await stopRoomStateServer(error);
}
