import { assert, createRoom, deltaText, expectedText, FAST_ANSWER_CHUNKS, type GatewayRequest, gatewayRequests, getStatus, getThread, putThread, reportDetachedFailure, SLOW_MARKER, startDetachedServer, stopDetachedServer, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

// End to end, on the detached-turn rig (persistent-room-detached-turn-setup.ts):
// a person sends the next message right after an answer ends, before the
// page's debounced save of that answer lands. The save arrives while the next
// turn already runs, so the earlier answer sits after the next turn's start
// anchor in the thread file. Whatever lands the next turn must keep it:
//   1. a reload right after the next answer ends: the close-time landing keeps
//      the earlier answer and its step, and so does the bind after it;
//   2. the next turn detaches with its own partial saved too: the reattach
//      frame anchors after the earlier answer, and the landing drops only the
//      next turn's partial;
//   3. the late save carried the earlier answer but not the next message: the
//      landing cuts nothing, restores the prompt after the earlier answer;
//   4. the page's save of a message lands before its turn starts (a settings
//      rebind holds the turn): the landing still drops that turn's own partial
//      and chip;
//   5. the first message was never saved during its turn either, and the late
//      save carries the whole first exchange without the next message: the
//      first prompt is not taken for the next one, nothing is cut;
//   6. as 5, with the next message and its partial in the late save: only the
//      partial goes;
//   7. the next message carries only a file: it is still a message of its own,
//      not a continued answer, and the earlier answer stays;
//   8. a failed answer is continued while a settings rebind holds the turn,
//      and the earlier answer is saved during the hold: it stays.

const fastText = FAST_ANSWER_CHUNKS.join("").trim();
const firstPrompt = "First question, quick please.";
const nextPrompt = `Thanks, now the next one. ${SLOW_MARKER}`;
const earlierTurn = [
	{ kind: "user", id: "u-first", text: firstPrompt },
	{ kind: "tool", id: "t-first", name: "kb_search", args: {}, status: "done" },
	{ kind: "assistant", id: "a-first", text: fastText, streaming: false },
];

const landedItems = async (roomId: string, conversationId: string, label: string): Promise<any[]> => {
	await waitUntil(async () => ((await getThread(roomId, conversationId)).items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-")), `${label} landing written`, 40_000);
	return (await getThread(roomId, conversationId)).items ?? [];
};

const settledCompleted = async (roomId: string, label: string): Promise<void> => {
	await waitUntil(async () => {
		const status = await getStatus(roomId);
		return status.activeThread?.inFlight === false && status.activeThread?.activeTurn?.lastTerminalReason === "completed";
	}, `${label} turn settled completed`, 20_000);
};

// One answered message, then the next one sent the moment the room is idle;
// the page's save of the first prompt landed during the first turn unless
// told otherwise, the save of its answer has not. Returns once the next turn
// streams.
const answerThenSendNext = async (label: string, options: { firstPromptSaved?: boolean; next?: string } = {}): Promise<{ roomId: string; conversationId: string; ws: WsHarness; request: GatewayRequest }> => {
	const roomId = await createRoom(`Quick Follow-Up ${label}`);
	const conversationId = `smokeconv_quick_${label}_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, []);
	const ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", `${label} ready frame`);
	ws.send({ type: "prompt", text: firstPrompt });
	if (options.firstPromptSaved !== false) {
		const promptPut = await putThread(roomId, conversationId, [earlierTurn[0]]);
		assert(promptPut.status === 200, `${label} prompt save should succeed, got ${promptPut.status}: ${JSON.stringify(promptPut.body)}`);
	}
	const firstEnd = await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", `${label} first turn end`, 0, 20_000);
	await settledCompleted(roomId, `${label} first`);
	const requestsBefore = gatewayRequests.length;
	ws.send({ type: "prompt", text: options.next ?? nextPrompt });
	await ws.waitFor((frame) => deltaText(frame).length > 0, `${label} next turn first delta`, firstEnd);
	const request = gatewayRequests.slice(requestsBefore).find((row) => row.slow);
	assert(request, `${label} next turn should reach the provider`);
	return { roomId, conversationId, ws, request };
};

const assertEarlierTurnKept = (items: any[], label: string, nextText = nextPrompt): void => {
	const ids = items.map((item) => String(item.id ?? ""));
	const at = earlierTurn.map((item) => ids.indexOf(item.id));
	assert(at.every((index, i) => index >= 0 && (i === 0 || index > at[i - 1])), `${label}: the earlier answer and its step must survive in order, got ${JSON.stringify(ids)}`);
	assert(items[at[2]].text === fastText, `${label}: the earlier answer must keep its text, got ${JSON.stringify(items[at[2]].text)}`);
	const landed = items.findIndex((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed > at[2] && items[landed].text === expectedText, `${label}: the next answer must land whole after the earlier one, got ${JSON.stringify(ids)}`);
	assert(items.filter((item) => item.kind === "assistant").length === 2, `${label}: exactly the earlier and the landed answers must remain, got ${JSON.stringify(ids)}`);
	const prompts = items.filter((item) => item.kind === "user");
	assert(prompts.length === 2 && prompts[1].text === nextText && ids.indexOf(String(prompts[1].id)) > at[2] && ids.indexOf(String(prompts[1].id)) < landed, `${label}: the next message must sit once between the two answers, got ${JSON.stringify(ids)}`);
};

try {
	await startDetachedServer();

	// --- 1. Reload right after the next answer ends ---------------------------
	{
		const { roomId, conversationId, ws, request } = await answerThenSendNext("reload");
		const latePut = await putThread(roomId, conversationId, [...earlierTurn, { kind: "user", id: "u-next", text: nextPrompt }]);
		assert(latePut.status === 200, `reload: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		const beforeEnd = ws.frames.length;
		request.release();
		await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "reload: next turn end", beforeEnd, 30_000);
		await settledCompleted(roomId, "reload: next");
		// The reload closes the socket before the page saved the next answer.
		ws.close();
		assertEarlierTurnKept(await landedItems(roomId, conversationId, "reload"), "reload landing");
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "reload: lock released after the close", 20_000);
		const reloaded = await WsHarness.connect(roomId, conversationId);
		await reloaded.waitFor((frame) => frame.type === "ready", "reload: ready frame after the reload");
		assertEarlierTurnKept((await getThread(roomId, conversationId)).items ?? [], "after the reload");
		reloaded.close();
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "reload: lock released after the reloaded page left", 20_000);
	}

	// --- 2. The next turn detaches with its own partial saved ----------------
	{
		const { roomId, conversationId, ws, request } = await answerThenSendNext("detach");
		const latePut = await putThread(roomId, conversationId, [
			...earlierTurn,
			{ kind: "user", id: "u-next", text: nextPrompt },
			{ kind: "tool", id: "t-next-running", name: "kb_search", args: {}, status: "running" },
			{ kind: "assistant", id: "a-next-partial", text: "slow part 1. ", streaming: true },
		]);
		assert(latePut.status === 200, `detach: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		ws.close();
		await waitDetached(roomId, "detach");
		const back = await WsHarness.connect(roomId, conversationId);
		await back.waitFor((frame) => frame.type === "ready", "detach: reattach ready frame");
		const reattach = await back.waitFor((frame) => frame.type === "turn_reattach", "detach: turn_reattach frame");
		assert(back.frames[reattach].anchorItemId === "a-first", `detach: the page's supersede must start after the earlier answer, got ${JSON.stringify(back.frames[reattach].anchorItemId)}`);
		back.close();
		await waitDetached(roomId, "detach: after the second leave");
		request.release();
		const items = await landedItems(roomId, conversationId, "detach");
		assertEarlierTurnKept(items, "detach landing");
		assert(!items.some((item) => item.id === "a-next-partial" || item.id === "t-next-running"), `detach: the next turn's own partial and chip must be superseded, got ${JSON.stringify(items.map((item) => item.id))}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "detach: lock released after the landing", 20_000);
	}

	// --- 3. The late save carried the earlier answer, not the next message ---
	{
		const { roomId, conversationId, ws, request } = await answerThenSendNext("no-prompt");
		const latePut = await putThread(roomId, conversationId, earlierTurn);
		assert(latePut.status === 200, `no-prompt: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		ws.close();
		await waitDetached(roomId, "no-prompt");
		request.release();
		const items = await landedItems(roomId, conversationId, "no-prompt");
		assertEarlierTurnKept(items, "no-prompt landing");
		assert(items.some((item) => String(item.id ?? "").startsWith("detached-user-") && item.text === nextPrompt), `no-prompt: the never-saved message must be restored, got ${JSON.stringify(items.map((item) => item.id))}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "no-prompt: lock released after the landing", 20_000);
	}

	// --- 4. The message's own save lands before its turn starts --------------
	{
		const roomId = await createRoom("Quick Follow-Up held start");
		const conversationId = `smokeconv_quick_held_${Date.now().toString(36)}`;
		await putThread(roomId, conversationId, []);
		const ws = await WsHarness.connect(roomId, conversationId, { extraParams: "&testPromptStartDelayMs=1500" });
		await ws.waitFor((frame) => frame.type === "ready", "held: ready frame");
		const requestsBefore = gatewayRequests.length;
		ws.send({ type: "prompt", text: nextPrompt });
		const promptPut = await putThread(roomId, conversationId, [{ kind: "user", id: "u-next", text: nextPrompt }]);
		assert(promptPut.status === 200, `held: the prompt save should succeed, got ${promptPut.status}: ${JSON.stringify(promptPut.body)}`);
		await ws.waitFor((frame) => deltaText(frame).length > 0, "held: first delta");
		const request = gatewayRequests.slice(requestsBefore).find((row) => row.slow);
		assert(request, "held: the turn should reach the provider");
		const partialPut = await putThread(roomId, conversationId, [
			{ kind: "user", id: "u-next", text: nextPrompt },
			{ kind: "tool", id: "t-next-running", name: "kb_search", args: {}, status: "running" },
			{ kind: "assistant", id: "a-next-partial", text: "slow part 1. ", streaming: true },
		]);
		assert(partialPut.status === 200, `held: the partial save should succeed, got ${partialPut.status}: ${JSON.stringify(partialPut.body)}`);
		ws.close();
		await waitDetached(roomId, "held");
		request.release();
		const items = await landedItems(roomId, conversationId, "held");
		const ids = items.map((item) => String(item.id ?? ""));
		assert(!ids.includes("a-next-partial") && !ids.includes("t-next-running"), `held: the turn's own partial and chip must be superseded, got ${JSON.stringify(ids)}`);
		assert(items.filter((item) => item.kind === "user").length === 1 && ids[0] === "u-next", `held: the message must stay once, first, got ${JSON.stringify(ids)}`);
		assert(items.filter((item) => item.kind === "assistant").length === 1 && items.find((item) => item.kind === "assistant").text === expectedText, `held: exactly the landed answer must remain, got ${JSON.stringify(ids)}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "held: lock released after the landing", 20_000);
	}

	// --- 5. Nothing of the first exchange saved before the next message ------
	{
		const { roomId, conversationId, ws, request } = await answerThenSendNext("unsaved-first", { firstPromptSaved: false });
		const latePut = await putThread(roomId, conversationId, earlierTurn);
		assert(latePut.status === 200, `unsaved-first: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		ws.close();
		await waitDetached(roomId, "unsaved-first");
		request.release();
		const items = await landedItems(roomId, conversationId, "unsaved-first");
		assertEarlierTurnKept(items, "unsaved-first landing");
		assert(items.some((item) => String(item.id ?? "").startsWith("detached-user-") && item.text === nextPrompt), `unsaved-first: the never-saved message must be restored, got ${JSON.stringify(items.map((item) => item.id))}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "unsaved-first: lock released after the landing", 20_000);
	}

	// --- 6. As 5, with the next message and its partial saved late ----------
	{
		const { roomId, conversationId, ws, request } = await answerThenSendNext("unsaved-first-partial", { firstPromptSaved: false });
		const latePut = await putThread(roomId, conversationId, [
			...earlierTurn,
			{ kind: "user", id: "u-next", text: nextPrompt },
			{ kind: "assistant", id: "a-next-partial", text: "slow part 1. ", streaming: true },
		]);
		assert(latePut.status === 200, `unsaved-first-partial: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		ws.close();
		await waitDetached(roomId, "unsaved-first-partial");
		const back = await WsHarness.connect(roomId, conversationId);
		const reattach = await back.waitFor((frame) => frame.type === "turn_reattach", "unsaved-first-partial: turn_reattach frame");
		assert(back.frames[reattach].anchorItemId === "a-first", `unsaved-first-partial: the page's supersede must start after the earlier answer, got ${JSON.stringify(back.frames[reattach].anchorItemId)}`);
		back.close();
		await waitDetached(roomId, "unsaved-first-partial: after the second leave");
		request.release();
		const items = await landedItems(roomId, conversationId, "unsaved-first-partial");
		assertEarlierTurnKept(items, "unsaved-first-partial landing");
		assert(!items.some((item) => item.id === "a-next-partial"), `unsaved-first-partial: the next turn's own partial must be superseded, got ${JSON.stringify(items.map((item) => item.id))}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "unsaved-first-partial: lock released after the landing", 20_000);
	}

	// --- 7. The next message carries only a file ------------------------------
	{
		const fileNote = `[FILE ATTACHED: ${SLOW_MARKER}.txt · 1 page · now in this room's Attachments; read it with read_file when relevant]`;
		const { roomId, conversationId, ws, request } = await answerThenSendNext("file-only", { next: fileNote });
		const latePut = await putThread(roomId, conversationId, [...earlierTurn, { kind: "user", id: "u-next", text: "", attachments: [{ name: `${SLOW_MARKER}.txt`, bytes: 12, extension: ".txt" }] }]);
		assert(latePut.status === 200, `file-only: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		const beforeEnd = ws.frames.length;
		request.release();
		await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "file-only: next turn end", beforeEnd, 30_000);
		await settledCompleted(roomId, "file-only: next");
		ws.close();
		assertEarlierTurnKept(await landedItems(roomId, conversationId, "file-only"), "file-only landing", "");
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "file-only: lock released after the close", 20_000);
	}

	// --- 8. A continued answer whose turn is held while the page saves --------
	{
		const roomId = await createRoom("Quick Follow-Up continued");
		const conversationId = `smokeconv_quick_continued_${Date.now().toString(36)}`;
		await putThread(roomId, conversationId, []);
		const ws = await WsHarness.connect(roomId, conversationId, { extraParams: "&testPromptStartDelayMs=1500" });
		await ws.waitFor((frame) => frame.type === "ready", "continued: ready frame");
		ws.send({ type: "prompt", text: firstPrompt });
		await putThread(roomId, conversationId, [earlierTurn[0]]);
		const firstEnd = await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "continued: first turn end", 0, 20_000);
		await settledCompleted(roomId, "continued: first");
		const requestsBeforeFailing = gatewayRequests.length;
		ws.send({ type: "prompt", text: nextPrompt });
		await ws.waitFor((frame) => deltaText(frame).length > 0, "continued: failing turn first delta", firstEnd);
		const failing = gatewayRequests.slice(requestsBeforeFailing).find((row) => row.slow);
		assert(failing, "continued: the failing turn should reach the provider");
		// The provider keeps dropping the stream, the runtime's retries included.
		await waitUntil(async () => {
			for (const row of gatewayRequests.slice(requestsBeforeFailing)) if (row.slow && !row.aborted && !row.finished) row.fail();
			return (await getStatus(roomId)).activeThread?.inFlight === false;
		}, "continued: failed turn settled", 90_000);
		const failedEnd = await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "continued: failed turn end", firstEnd + 1);
		assert(!ws.frames.some((frame) => frame.type === "prompt_returned"), `continued: a failed answer with text stays on screen, got ${JSON.stringify(ws.frames.filter((frame) => frame.type === "prompt_returned"))}`);
		const requestsBeforeContinue = gatewayRequests.length;
		ws.send({ type: "continue" });
		const latePut = await putThread(roomId, conversationId, [
			...earlierTurn,
			{ kind: "user", id: "u-next", text: nextPrompt },
			{ kind: "assistant", id: "a-next-failed", text: "slow part 1. ", streaming: false },
		]);
		assert(latePut.status === 200, `continued: the late save should succeed, got ${latePut.status}: ${JSON.stringify(latePut.body)}`);
		await waitUntil(() => gatewayRequests.slice(requestsBeforeContinue).some((row) => row.slow), "continued: the continued turn reaches the provider", 30_000);
		const continued = gatewayRequests.slice(requestsBeforeContinue).find((row) => row.slow)!;
		continued.release();
		await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "continued: continued turn end", failedEnd + 1, 30_000);
		await settledCompleted(roomId, "continued: continued");
		ws.close();
		const items = await landedItems(roomId, conversationId, "continued");
		const ids = items.map((item) => String(item.id ?? ""));
		assert(["u-first", "t-first", "a-first", "u-next"].every((id) => ids.includes(id)), `continued: the earlier answer and the continued message must stay, got ${JSON.stringify(ids)}`);
		await waitUntil(async () => !(await getStatus(roomId)).activeLock, "continued: lock released after the close", 20_000);
	}

	console.log("persistent-room quick follow-up smoke passed");
} catch (error) {
	reportDetachedFailure(error);
} finally {
	await stopDetachedServer();
}
