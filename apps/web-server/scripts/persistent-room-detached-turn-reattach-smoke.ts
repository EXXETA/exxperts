import { assert, BIG_ANSWER_CHUNKS, BIG_MARKER, countOccurrences, createRoom, deltaText, expectedText, FAST_ANSWER_CHUNKS, type Frame, gatewayRequests, getStatus, getThread, joinedDeltas, putThread, releaseHeldStreams, reportDetachedFailure, requestJson, SLOW_ANSWER_CHUNKS, SLOW_MARKER, startDetachedServer, stopDetachedServer, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

// End to end, the rest of persistent-room-detached-turn-smoke.ts (its header
// says what the run proves; the rig is persistent-room-detached-turn-setup.ts):
//  10. displacement: when a THIRD connection takes the adopted turn over, the
//      displaced session is actively told (error code room_displaced, never a
//      frozen busy spinner), its Stop loses authority over the turn
//      (claimant-checked), and the takeover session streams the whole answer;
//  11. the supersede anchor: with a completed earlier exchange persisted, the
//      cooking prompt missing from the file AND textually identical to the
//      earlier prompt, the reattach frame anchors on turn identity
//      (anchorItemId = last item at turn start) and the unwatched landing
//      keeps the earlier answer, restores the missing prompt, and appends the
//      new answer after it;
//  12. the mismatched-conversation bounce holds WHILE ADOPTED (keyed on the
//      cooking handle, not the cooking set adopt() clears), with the
//      adopter's stream and lock untouched;
//  13. reattach is opt-in: a connection without the reattach capability gets
//      the older room_cooking bounce and zero replay frames, while a
//      capable connection adopts the same turn right afterwards;
//  14. settle during bind, made deterministic via the test-only bind delay:
//      the reattach frame arrives settled with the whole answer replayed
//      once, and the settle leaves the mid-bind claimant's room lock HELD;
//  15. replay-buffer lifecycle: an ordinary completed turn releases its
//      buffer at settle (probe: frames 0), and a turn that overflows the
//      byte cap frees the buffer immediately, bounces reattaches honestly
//      instead of replaying a gap, and still lands the whole answer;
//  16. overflow AND settle inside the claim-to-adopt window: the raced bind
//      is bounced rather than handed an empty settled replay, and the landed
//      answer survives in the thread file;
//  17. a claim takeover during another claimant's bind: the displaced
//      mid-bind claimant receives room_displaced and never a silent ordinary
//      bind, while the takeover adopts and streams the whole answer;
//  18. the landing cut drops post-anchor tool chips (same predicate as the
//      client's supersede), keeping everything before the anchor.
// After a turn that finished while the client watched:
//  19. a turn that COMPLETED while the client watched, whose debounced persist
//      never fired, lands on socket close: the thread gains the answer (and
//      the never-persisted prompt), parks standby, and records the unseen
//      marker — the multi-second window between "model finished" and "client
//      persisted" no longer loses the answer;
//  20. when the client DID persist the answer before closing, the close-time
//      landing skips entirely: no detached items, state stays active, no
//      marker;
//  21. a stale client PUT that arrives AFTER the landing (the in-flight save
//      from before the drop) merges: the landed answer survives, the stale
//      partial fragment is dropped, no duplicate prompt — and a late save
//      that carries the client's own full copy of the answer is left
//      untouched (no detached duplicate appended).
// Messages sent while it answers:
//  22. a reload with two messages waiting for the answer is told both on
//      ready and on turn_reattach; once the room took them, a second
//      window's ready names them as taken and none waiting; a conversation
//      with no answer running gets empty lists and no reattach.
// Keyed turns (the page names its question, thread-items-by-id.ts):
//  23. the next message's reattach anchor is an item the page holds, and the
//      reattach names that message by id;
//  24. the landing replaces a copy a lost connection cut short, and keeps a
//      copy a Stop cut, with its note;
//  25. a reload during a question with only files: the reattach carries its
//      id and both chips, with empty words.


try {
	await startDetachedServer();

	// --- 10. Displacement: a second reattach takes over cleanly ---------------
	// A detaches, B adopts and streams, C connects for the same conversation:
	// C wins the claim (ordinary web-over-web takeover), B is TOLD it was
	// displaced (never a frozen spinner), B's Stop loses authority over the
	// turn (claimant-checked), and C streams the whole answer to completion.
	const room10 = await createRoom("Reattach Displace Room");
	const conv10 = `smokeconv10_${Date.now().toString(36)}`;
	await putThread(room10, conv10, []);
	const ws10a = await WsHarness.connect(room10, conv10);
	await ws10a.waitFor((frame) => frame.type === "ready", "room10 ready frame");
	const requestsBefore10 = gatewayRequests.length;
	ws10a.send({ type: "prompt", text: `Three windows walk into a room. ${SLOW_MARKER}` });
	await ws10a.waitFor((frame) => deltaText(frame).length > 0, "room10 first delta");
	ws10a.close();
	await waitDetached(room10, "room10");
	const request10 = gatewayRequests.slice(requestsBefore10).find((row) => row.slow)!;
	const ws10b = await WsHarness.connect(room10, conv10);
	await ws10b.waitFor((frame) => frame.type === "ready", "room10 first reattach ready");
	await ws10b.waitFor((frame) => frame.type === "turn_reattach", "room10 first reattach frame");
	request10.release(2);
	await ws10b.waitFor((frame) => deltaText(frame).includes("slow part 3. "), "room10 first adopter receives live deltas");
	const ws10c = await WsHarness.connect(room10, conv10);
	await ws10c.waitFor((frame) => frame.type === "ready", "room10 second reattach ready");
	const reattach10c = await ws10c.waitFor((frame) => frame.type === "turn_reattach", "room10 second reattach frame");
	assert(ws10c.frames[reattach10c].settled === false, `the takeover reattach should be live, got ${JSON.stringify(ws10c.frames[reattach10c].settled)}`);
	// B is actively told; silence would freeze its window busy forever.
	const displacedIndex = await ws10b.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "displacement signal to the first adopter", 0, 10_000);
	assert(String(ws10b.frames[displacedIndex].message).includes("This room is now open in another window."), `the displacement message should be honest, got ${JSON.stringify(ws10b.frames[displacedIndex].message)}`);
	const framesAfterDisplacement = ws10b.frames.length;
	// B's Stop no longer reaches the turn C is watching, while the stream
	// goes on to C alone.
	ws10b.send({ type: "abort" });
	request10.release(3);
	await new Promise((resolve) => setTimeout(resolve, 1200));
	assert(!request10.aborted, "a displaced session's Stop must NOT abort the stream the new session is watching");
	assert(ws10b.frames.slice(framesAfterDisplacement).every((frame) => deltaText(frame) === ""), "a displaced session must receive no further stream deltas");
	// C watches the whole answer land, exactly once.
	request10.release();
	await ws10c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room10 takeover stream reaches the turn end", reattach10c, 40_000);
	const joined10 = joinedDeltas(ws10c.frames, reattach10c);
	assert(joined10.trim() === expectedText, `the takeover session must see the whole answer with no gap, got ${JSON.stringify(joined10.slice(0, 120))}`);
	assert(countOccurrences(joined10, "slow part 1. ") === 1, `the takeover replay must not duplicate text, got ${JSON.stringify(joined10.slice(0, 160))}`);
	assert(request10.finished && !request10.aborted, "the displaced Stop must leave the provider stream to finish");
	const status10 = await getStatus(room10);
	assert(!status10.unseenLandedAnswer, `a landing the takeover session watched must not record an unseen marker, got ${JSON.stringify(status10.unseenLandedAnswer)}`);
	ws10b.close();
	ws10c.close();
	await waitUntil(async () => !(await getStatus(room10)).activeLock, "room10 lock released after both sessions left", 20_000);
	const thread10 = await getThread(room10, conv10);
	const assistants10 = (thread10.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants10.length === 1 && assistants10[0].text === expectedText, `room10 must land the answer exactly once, got ${JSON.stringify(assistants10.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);

	// --- 11. Reattach anchor: a missing prompt cannot cost the prior answer --
	// The crash-leave scenario: the thread file carries a COMPLETED earlier
	// exchange, the cooking turn's prompt was never persisted, and that prompt
	// is TEXTUALLY IDENTICAL to the earlier one (the "continue continue"
	// amplifier). The reattach frame must anchor on turn identity (the last
	// persisted item at turn start), and the unwatched landing must keep the
	// earlier answer, restore the missing prompt, and append the new answer
	// after it.
	const room11 = await createRoom("Reattach Anchor Room");
	const conv11 = `smokeconv11_${Date.now().toString(36)}`;
	const repeatedPrompt = `continue please ${SLOW_MARKER}`;
	await putThread(room11, conv11, [
		{ kind: "user", id: "u-prior", text: repeatedPrompt },
		{ kind: "assistant", id: "a-prior-done", text: "The earlier answer, fully finished.", streaming: false },
	]);
	const ws11a = await WsHarness.connect(room11, conv11);
	await ws11a.waitFor((frame) => frame.type === "ready", "room11 ready frame");
	ws11a.send({ type: "prompt", text: repeatedPrompt });
	await ws11a.waitFor((frame) => deltaText(frame).length > 0, "room11 first delta");
	// No mid-stream persist: the cooking prompt never reaches the file.
	ws11a.close();
	await waitDetached(room11, "room11");
	const ws11b = await WsHarness.connect(room11, conv11);
	await ws11b.waitFor((frame) => frame.type === "ready", "room11 reattach ready");
	const reattach11 = await ws11b.waitFor((frame) => frame.type === "turn_reattach", "room11 reattach frame");
	assert(ws11b.frames[reattach11].anchorItemId === "a-prior-done", `the reattach must anchor on the last item at turn start, got ${JSON.stringify(ws11b.frames[reattach11].anchorItemId)}`);
	assert(String(ws11b.frames[reattach11].userText ?? "") === repeatedPrompt, `the reattach must carry the cooking prompt, got ${JSON.stringify(ws11b.frames[reattach11].userText)}`);
	// Leave again so the landing runs UNWATCHED, the path that used to delete.
	ws11b.close();
	await waitDetached(room11, "room11 after the second leave");
	releaseHeldStreams();
	await waitUntil(async () => {
		const thread = await getThread(room11, conv11);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room11 landing written", 40_000);
	const thread11 = await getThread(room11, conv11);
	const items11: any[] = thread11.items ?? [];
	const priorAnswer = items11.find((item) => item.id === "a-prior-done");
	assert(priorAnswer && priorAnswer.text === "The earlier answer, fully finished.", `the prior completed answer must survive the landing, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(items11.some((item) => item.id === "u-prior"), "the prior prompt must survive the landing");
	const restoredUserIndex = items11.findIndex((item) => String(item.id ?? "").startsWith("detached-user-"));
	const landedIndex11 = items11.findIndex((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	const priorAnswerIndex = items11.findIndex((item) => item.id === "a-prior-done");
	assert(restoredUserIndex >= 0 && items11[restoredUserIndex].kind === "user" && items11[restoredUserIndex].text === repeatedPrompt, `the missing prompt must be restored into the landing, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(priorAnswerIndex < restoredUserIndex && restoredUserIndex < landedIndex11, `the restored prompt must sit between the prior answer and the landed answer, got ${JSON.stringify(items11.map((item) => item.id))}`);
	assert(items11[landedIndex11].text === expectedText, `the landed answer must carry the full text, got ${JSON.stringify(String(items11[landedIndex11].text).slice(0, 80))}`);
	assert(items11.filter((item) => item.kind === "assistant").length === 2, `exactly the prior and the landed answers must remain, got ${JSON.stringify(items11.map((item) => item.id))}`);

	// --- 12. The mismatched-conversation bounce holds WHILE ADOPTED -----------
	// adopt() clears detachedCookingRooms, but the room-level bounce must not
	// clear with it: a stale connection under a different conversation id would
	// otherwise take the cooking turn's lock over mid-stream. The adopter's
	// stream must not even flinch.
	const room12 = await createRoom("Reattach Gate Room");
	const conv12 = `smokeconv12_${Date.now().toString(36)}`;
	await putThread(room12, conv12, []);
	const ws12a = await WsHarness.connect(room12, conv12);
	await ws12a.waitFor((frame) => frame.type === "ready", "room12 ready frame");
	const requestsBefore12 = gatewayRequests.length;
	ws12a.send({ type: "prompt", text: `Guard the door while I answer. ${SLOW_MARKER}` });
	await ws12a.waitFor((frame) => deltaText(frame).length > 0, "room12 first delta");
	ws12a.close();
	await waitDetached(room12, "room12");
	const request12 = gatewayRequests.slice(requestsBefore12).find((row) => row.slow)!;
	const ws12b = await WsHarness.connect(room12, conv12);
	await ws12b.waitFor((frame) => frame.type === "ready", "room12 reattach ready");
	const reattach12 = await ws12b.waitFor((frame) => frame.type === "turn_reattach", "room12 reattach frame");
	request12.release(2);
	await ws12b.waitFor((frame) => deltaText(frame).includes("slow part 3. "), "room12 adopter receives live deltas", reattach12);
	// While the adopter watches, a different conversation id still bounces.
	const ws12x = await WsHarness.connect(room12, `smokeconv12_other_${Date.now().toString(36)}`);
	const bounce12 = await ws12x.waitFor((frame) => frame.type === "error", "room12 mismatched-conversation bounce while adopted");
	assert(ws12x.frames[bounce12].code === "room_cooking", `the while-adopted bounce should carry code room_cooking, got ${JSON.stringify(ws12x.frames[bounce12].code)}`);
	assert(!ws12x.frames.some((frame) => frame.type === "turn_reattach" || frame.type === "ready"), `the bounced connection must get neither ready nor a reattach, got ${JSON.stringify(ws12x.frames.map((frame) => frame.type))}`);
	ws12x.close();
	// The adopter's stream is undisturbed: later chunks keep arriving and the
	// provider request was never touched.
	request12.release(3);
	await ws12b.waitFor((frame) => deltaText(frame).includes("slow part 6. "), "room12 adopter still streaming after the bounce", reattach12, 15_000);
	assert(!request12.aborted, "the bounced stale connection must not touch the provider stream");
	const adoptedStatus12 = await getStatus(room12);
	assert(adoptedStatus12.activeLock, "the adopter must still hold the room lock after the bounce");
	// Cleanup: stop the turn and leave.
	ws12b.send({ type: "abort" });
	await waitUntil(async () => (await getStatus(room12)).activeThread?.inFlight === false, "room12 stopped turn settled", 20_000);
	ws12b.close();
	await waitUntil(async () => !(await getStatus(room12)).activeLock, "room12 lock released", 20_000);

	// --- 13. Reattach is opt-in: an older client keeps its bounce -------------
	// A client that does not declare the reattach capability would ignore
	// turn_reattach, double-render the replay under its persisted partial, and
	// then persist the duplicated transcript over the clean landing. It must
	// get the older room_cooking bounce and NOTHING else; a capable
	// connection for the same conversation still adopts normally afterwards.
	const room13 = await createRoom("Reattach Optin Room");
	const conv13 = `smokeconv13_${Date.now().toString(36)}`;
	await putThread(room13, conv13, []);
	const ws13a = await WsHarness.connect(room13, conv13);
	await ws13a.waitFor((frame) => frame.type === "ready", "room13 ready frame");
	const requestsBefore13 = gatewayRequests.length;
	ws13a.send({ type: "prompt", text: `An old tab is watching. ${SLOW_MARKER}` });
	await ws13a.waitFor((frame) => deltaText(frame).length > 0, "room13 first delta");
	ws13a.close();
	await waitDetached(room13, "room13");
	const request13 = gatewayRequests.slice(requestsBefore13).find((row) => row.slow)!;
	const ws13o = await WsHarness.connect(room13, conv13, { reattach: false });
	const bounce13 = await ws13o.waitFor((frame) => frame.type === "error", "room13 old-client bounce");
	assert(ws13o.frames[bounce13].code === "room_cooking", `the old client should get the room_cooking bounce, got ${JSON.stringify(ws13o.frames[bounce13])}`);
	assert(/finishing a response in the background/.test(String(ws13o.frames[bounce13].message)), `the old-client bounce keeps the pre-#33 copy, got ${JSON.stringify(ws13o.frames[bounce13].message)}`);
	// The stream goes on meanwhile, and none of it reaches the old client.
	request13.release(1);
	await new Promise((resolve) => setTimeout(resolve, 400));
	assert(!ws13o.frames.some((frame) => frame.type === "ready" || frame.type === "turn_reattach" || frame.type === "event"), `the old client must receive no ready, no reattach and ZERO replay frames, got ${JSON.stringify(ws13o.frames.map((frame) => frame.type))}`);
	ws13o.close();
	assert(!request13.aborted, "the old-client bounce must not disturb the cooking stream");
	// A CAPABLE connection still adopts the same turn right afterwards.
	const ws13b = await WsHarness.connect(room13, conv13);
	await ws13b.waitFor((frame) => frame.type === "ready", "room13 capable reattach ready");
	await ws13b.waitFor((frame) => frame.type === "turn_reattach", "room13 capable reattach frame");
	ws13b.send({ type: "abort" });
	await waitUntil(async () => (await getStatus(room13)).activeThread?.inFlight === false, "room13 stopped turn settled", 20_000);
	ws13b.close();
	await waitUntil(async () => !(await getStatus(room13)).activeLock, "room13 lock released", 20_000);

	// --- 14. Settle during bind: the raced session keeps its lock -------------
	// The previously-unpinned middle branch of the landing race, made
	// deterministic with the test-only bind delay: the connection claims the
	// cooking turn, the turn settles while the bind is (artificially) slow,
	// and phase two replays the finished stream. The settle must NOT release
	// the mid-bind claimant's lock: it continues as an ordinary live session
	// and must still hold the room when the replay lands.
	const room14 = await createRoom("Reattach Bindrace Room");
	const conv14 = `smokeconv14_${Date.now().toString(36)}`;
	await putThread(room14, conv14, []);
	const ws14a = await WsHarness.connect(room14, conv14);
	await ws14a.waitFor((frame) => frame.type === "ready", "room14 ready frame");
	const requestsBefore14 = gatewayRequests.length;
	ws14a.send({ type: "prompt", text: `Finish while I bind. ${SLOW_MARKER}` });
	await ws14a.waitFor((frame) => deltaText(frame).length > 0, "room14 first delta");
	ws14a.close();
	await waitDetached(room14, "room14");
	const request14 = gatewayRequests.slice(requestsBefore14).find((row) => row.slow)!;
	request14.release(SLOW_ANSWER_CHUNKS.length - 2);
	await waitUntil(() => request14.sent >= SLOW_ANSWER_CHUNKS.length - 1, "room14 stream almost finished", 30_000);
	const ws14b = await WsHarness.connect(room14, conv14, { extraParams: "&testBindDelayMs=1500" });
	await ws14b.waitFor((frame) => frame.type === "ready", "room14 raced ready frame");
	// The ready frame comes after the claim and before the bind delay: the
	// last chunk now settles the turn inside the delay.
	request14.release();
	const reattach14 = await ws14b.waitFor((frame) => frame.type === "turn_reattach", "room14 raced reattach frame", 0, 15_000);
	assert(ws14b.frames[reattach14].settled === true, `the settle must have beaten this bind (deterministic via the delay), got ${JSON.stringify(ws14b.frames[reattach14].settled)}`);
	await ws14b.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room14 settled replay reaches the turn end", reattach14, 15_000);
	const joined14 = joinedDeltas(ws14b.frames, reattach14);
	assert(joined14.trim() === expectedText, `the settled replay must carry the whole answer, got ${JSON.stringify(joined14.slice(0, 120))}`);
	assert(countOccurrences(joined14, "slow part 1. ") === 1, `the settled replay must not duplicate text, got ${JSON.stringify(joined14.slice(0, 160))}`);
	// THE LOCK ORDERING ASSERTION: the settle that raced this bind ran with a
	// live mid-bind claimant and must have left that claimant's lock alone.
	const status14 = await getStatus(room14);
	assert(status14.activeThread?.inFlight === false, `room14 turn should be settled, got ${JSON.stringify(status14.activeThread?.activeTurn)}`);
	assert(status14.activeLock, "the settle that raced this bind must NOT release the live session's room lock");
	assert(!status14.unseenLandedAnswer, `the raced session watched the replay; no unseen marker may remain, got ${JSON.stringify(status14.unseenLandedAnswer)}`);
	const thread14 = await getThread(room14, conv14);
	const assistants14 = (thread14.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants14.length === 1 && assistants14[0].text === expectedText, `room14 must land the answer exactly once, got ${JSON.stringify(assistants14.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
	ws14b.close();
	await waitUntil(async () => !(await getStatus(room14)).activeLock, "room14 lock released after the session left", 20_000);

	// --- 15. Replay-buffer lifecycle: released at settle, capped on overflow --
	const room15 = await createRoom("Reattach Buffer Room");
	const conv15 = `smokeconv15_${Date.now().toString(36)}`;
	await putThread(room15, conv15, []);
	const bufferStats = async (roomId: string): Promise<{ frames: number; bytes: number; overflowed: boolean }> => {
		const response = await requestJson(`/api/persistent-agents/${roomId}/reattach-buffer-stats`);
		assert(response.status === 200, `buffer stats should return 200, got ${response.status}`);
		return response.body;
	};
	// 15a: an ORDINARY completed turn on a connection that stays attached must
	// release its replay buffer at settle, not hold it until the next prompt.
	const ws15a = await WsHarness.connect(room15, conv15);
	await ws15a.waitFor((frame) => frame.type === "ready", "room15 ready frame");
	ws15a.send({ type: "prompt", text: "Just answer quickly please." });
	await ws15a.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room15 ordinary turn end");
	await waitUntil(async () => {
		const stats = await bufferStats(room15);
		return stats.frames === 0 && stats.bytes === 0;
	}, "room15 replay buffer released after the ordinary turn settled", 10_000);
	const statsMidBuffer = await bufferStats(room15);
	assert(statsMidBuffer.overflowed === false, `an ordinary turn must not mark overflow, got ${JSON.stringify(statsMidBuffer)}`);
	ws15a.close();
	await waitUntil(async () => !(await getStatus(room15)).activeLock, "room15 lock released", 20_000);
	// 15b: a turn that overflows the cap frees the buffer immediately, and a
	// reattach degrades to the honest bounce instead of a truncated replay;
	// the landing still carries the whole answer.
	const room15b = await createRoom("Reattach Overflow Room");
	const conv15b = `smokeconv15b_${Date.now().toString(36)}`;
	await putThread(room15b, conv15b, []);
	const ws15b = await WsHarness.connect(room15b, conv15b);
	await ws15b.waitFor((frame) => frame.type === "ready", "room15b ready frame");
	const requestsBefore15 = gatewayRequests.length;
	ws15b.send({ type: "prompt", text: `Stream something enormous. ${BIG_MARKER}` });
	await ws15b.waitFor((frame) => deltaText(frame).length > 0, "room15b first big delta");
	ws15b.close();
	const request15 = gatewayRequests.slice(requestsBefore15).find((row) => row.slow)!;
	request15.release(5);
	await waitUntil(async () => (await bufferStats(room15b)).overflowed === true, "room15b replay buffer overflowed the cap", 15_000);
	const overflowStats = await bufferStats(room15b);
	assert(overflowStats.frames === 0, `overflow must free the buffer immediately, got ${JSON.stringify(overflowStats)}`);
	assert(!request15.finished, "the overflow assertion must land while the big turn still cooks");
	// A capable reattach now bounces honestly rather than replaying a gap.
	const ws15c = await WsHarness.connect(room15b, conv15b);
	const bounce15 = await ws15c.waitFor((frame) => frame.type === "error", "room15b overflow bounce");
	assert(ws15c.frames[bounce15].code === "room_cooking", `the overflow bounce should carry code room_cooking, got ${JSON.stringify(ws15c.frames[bounce15])}`);
	assert(!ws15c.frames.some((frame) => frame.type === "turn_reattach" || frame.type === "event"), `an overflow reattach must replay nothing, got ${JSON.stringify(ws15c.frames.map((frame) => frame.type))}`);
	ws15c.close();
	// The answer still lands whole, and the buffer stays free after settle.
	request15.release();
	const expectedBig = BIG_ANSWER_CHUNKS.join("").trim();
	await waitUntil(async () => {
		const thread = await getThread(room15b, conv15b);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room15b landing written despite the overflow", 30_000);
	const thread15 = await getThread(room15b, conv15b);
	const landed15 = (thread15.items ?? []).find((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed15?.text === expectedBig, `the overflow landing must carry the whole big answer, got ${JSON.stringify(String(landed15?.text ?? "").slice(0, 60))}... (${String(landed15?.text ?? "").length} chars)`);
	const settledStats15 = await bufferStats(room15b);
	assert(settledStats15.frames === 0 && settledStats15.bytes === 0, `the buffer must stay free after the overflow turn settled, got ${JSON.stringify(settledStats15)}`);
	await waitUntil(async () => !(await getStatus(room15b)).activeLock, "room15b lock released after the landing", 20_000);

	// --- 16. Overflow AND settle inside the claim-to-adopt window -------------
	// The claim passes while the turn is under the cap and still cooking; the
	// widened bind window then sees the turn BOTH overflow the cap and settle.
	// A settled adoption would replay the freed (empty) buffer, superseding
	// the client's partial with nothing, so the phase-two guard must degrade
	// to the honest bounce and the thread file must keep the landed answer.
	const room16 = await createRoom("Reattach Overflow Race Room");
	const conv16 = `smokeconv16_${Date.now().toString(36)}`;
	await putThread(room16, conv16, []);
	const ws16a = await WsHarness.connect(room16, conv16);
	await ws16a.waitFor((frame) => frame.type === "ready", "room16 ready frame");
	const requestsBefore16 = gatewayRequests.length;
	ws16a.send({ type: "prompt", text: `Enormous and racing. ${BIG_MARKER}` });
	await ws16a.waitFor((frame) => deltaText(frame).length > 0, "room16 first big delta");
	ws16a.close();
	// Claim BEFORE the overflow (~chunk 4 of 10), with one chunk sent; once the
	// claim is in (the ready frame), the rest goes, so the bind delay spans
	// both the overflow and the settle.
	await waitDetached(room16, "room16");
	const request16 = gatewayRequests.slice(requestsBefore16).find((row) => row.slow)!;
	const ws16b = await WsHarness.connect(room16, conv16, { extraParams: "&testBindDelayMs=1500" });
	await ws16b.waitFor((frame) => frame.type === "ready", "room16 raced ready frame");
	request16.release();
	const bounce16 = await ws16b.waitFor((frame) => frame.type === "error", "room16 overflow-then-settle bounce", 0, 20_000);
	assert(ws16b.frames[bounce16].code === "room_cooking", `the overflow-then-settle window should bounce with room_cooking, got ${JSON.stringify(ws16b.frames[bounce16])}`);
	assert(!ws16b.frames.some((frame) => frame.type === "turn_reattach"), `no reattach frame may ride an unreplayable settled turn, got ${JSON.stringify(ws16b.frames.map((frame) => frame.type))}`);
	assert(!ws16b.frames.some((frame) => frame.type === "event"), `an empty settled replay must never be delivered, got ${JSON.stringify(ws16b.frames.map((frame) => frame.type))}`);
	ws16b.close();
	assert(request16.finished && !request16.aborted, "room16's big turn must have finished on its own");
	// The landing survived the whole dance.
	const expectedBig16 = BIG_ANSWER_CHUNKS.join("").trim();
	const thread16 = await getThread(room16, conv16);
	const landed16 = (thread16.items ?? []).find((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed16?.text === expectedBig16, `the landed answer must survive the bounced raced bind, got ${String(landed16?.text ?? "").length} chars`);
	await waitUntil(async () => !(await getStatus(room16)).activeLock, "room16 lock released after the bounced bind closed", 20_000);

	// --- 17. A claim takeover during another claimant's bind is told ----------
	// The third displacement variant: C2 claims and is still binding (widened
	// via the test delay) when C3 claims. C2 must receive room_displaced and
	// never a silent ordinary bind, and C3 must adopt and stream undisturbed.
	const room17 = await createRoom("Reattach Midbind Room");
	const conv17 = `smokeconv17_${Date.now().toString(36)}`;
	await putThread(room17, conv17, []);
	const ws17a = await WsHarness.connect(room17, conv17);
	await ws17a.waitFor((frame) => frame.type === "ready", "room17 ready frame");
	const requestsBefore17 = gatewayRequests.length;
	ws17a.send({ type: "prompt", text: `Two rivals mid-bind. ${SLOW_MARKER}` });
	await ws17a.waitFor((frame) => deltaText(frame).length > 0, "room17 first delta");
	ws17a.close();
	await waitDetached(room17, "room17");
	const request17 = gatewayRequests.slice(requestsBefore17).find((row) => row.slow)!;
	// C2 claims and is held mid-bind by the test delay; its ready frame comes
	// after the claim, inside the delay.
	const ws17b = await WsHarness.connect(room17, conv17, { extraParams: "&testBindDelayMs=2000" });
	await ws17b.waitFor((frame) => frame.type === "ready", "room17 mid-bind claimant ready");
	// C3 claims while C2 is still inside its bind window, then adopts.
	const ws17c = await WsHarness.connect(room17, conv17);
	await ws17c.waitFor((frame) => frame.type === "ready", "room17 takeover ready");
	const reattach17 = await ws17c.waitFor((frame) => frame.type === "turn_reattach", "room17 takeover reattach frame");
	assert(ws17c.frames[reattach17].settled === false, `the takeover should adopt the live turn, got ${JSON.stringify(ws17c.frames[reattach17].settled)}`);
	// C2 is actively told, and never silently becomes an ordinary session.
	const displaced17 = await ws17b.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "displacement signal to the mid-bind claimant", 0, 10_000);
	assert(String(ws17b.frames[displaced17].message).includes("This room is now open in another window."), `the mid-bind displacement message should be honest, got ${JSON.stringify(ws17b.frames[displaced17].message)}`);
	assert(!ws17b.frames.some((frame) => frame.type === "turn_reattach"), `a displaced mid-bind claimant must never receive a reattach, got ${JSON.stringify(ws17b.frames.map((frame) => frame.type))}`);
	assert(!ws17b.frames.some((frame) => frame.type === "event"), `a displaced mid-bind claimant must never stream as a silent ordinary session, got ${JSON.stringify(ws17b.frames.map((frame) => frame.type))}`);
	ws17b.close();
	// C3 watches the whole answer land, exactly once, with the lock held.
	request17.release();
	await ws17c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room17 takeover stream reaches the turn end", reattach17, 40_000);
	const joined17 = joinedDeltas(ws17c.frames, reattach17);
	assert(joined17.trim() === expectedText, `the takeover session must see the whole answer, got ${JSON.stringify(joined17.slice(0, 120))}`);
	assert(countOccurrences(joined17, "slow part 1. ") === 1, `the takeover replay must not duplicate text, got ${JSON.stringify(joined17.slice(0, 160))}`);
	assert(request17.finished && !request17.aborted, "room17's stream must finish untouched by the displaced claimant");
	const status17 = await getStatus(room17);
	assert(status17.activeLock, "the takeover session must hold the room lock");
	assert(!status17.unseenLandedAnswer, `a landing the takeover watched must not record a marker, got ${JSON.stringify(status17.unseenLandedAnswer)}`);
	ws17c.close();
	await waitUntil(async () => !(await getStatus(room17)).activeLock, "room17 lock released after the takeover left", 20_000);
	const thread17 = await getThread(room17, conv17);
	const assistants17 = (thread17.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants17.length === 1 && assistants17[0].text === expectedText, `room17 must land the answer exactly once, got ${JSON.stringify(assistants17.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);

	// --- 18. The landing cut drops post-anchor tool chips too -----------------
	// A tool chip persisted mid-turn can never resolve after the landing (its
	// toolCallId died with the connection that ran it); the unwatched landing
	// must drop it like the client's supersede does, while everything before
	// the anchor survives.
	const room18 = await createRoom("Reattach Toolcut Room");
	const conv18 = `smokeconv18_${Date.now().toString(36)}`;
	const prompt18 = `Use your tools please. ${SLOW_MARKER}`;
	await putThread(room18, conv18, [
		{ kind: "user", id: "u-prior-18", text: "An earlier question." },
		{ kind: "assistant", id: "a-prior-18", text: "An earlier finished answer.", streaming: false },
	]);
	const ws18 = await WsHarness.connect(room18, conv18);
	await ws18.waitFor((frame) => frame.type === "ready", "room18 ready frame");
	ws18.send({ type: "prompt", text: prompt18 });
	await ws18.waitFor((frame) => deltaText(frame).length > 0, "room18 first delta");
	// The client's mid-stream persist: prompt, a running tool chip, a partial.
	const midPut18 = await putThread(room18, conv18, [
		{ kind: "user", id: "u-prior-18", text: "An earlier question." },
		{ kind: "assistant", id: "a-prior-18", text: "An earlier finished answer.", streaming: false },
		{ kind: "user", id: "u-18", text: prompt18 },
		{ kind: "tool", id: "t-stale-18", name: "kb_search", args: {}, status: "running" },
		{ kind: "assistant", id: "a-18-partial", text: "slow part 1. ", streaming: true },
	]);
	assert(midPut18.status === 200, `room18 mid-stream persist should succeed, got ${midPut18.status}: ${JSON.stringify(midPut18.body)}`);
	ws18.close();
	await waitDetached(room18, "room18");
	releaseHeldStreams();
	await waitUntil(async () => {
		const thread = await getThread(room18, conv18);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room18 landing written", 40_000);
	const thread18 = await getThread(room18, conv18);
	const items18: any[] = thread18.items ?? [];
	assert(!items18.some((item) => item.id === "t-stale-18"), `the landed transcript must not keep the unresolvable tool chip, got ${JSON.stringify(items18.map((item) => item.id))}`);
	assert(!items18.some((item) => item.id === "a-18-partial"), "the partial must be superseded by the landing");
	assert(items18.some((item) => item.id === "u-18"), "the persisted prompt must survive the landing");
	const prior18 = items18.find((item) => item.id === "a-prior-18");
	assert(prior18 && prior18.text === "An earlier finished answer.", `the earlier answer must survive the tool cut, got ${JSON.stringify(items18.map((item) => item.id))}`);
	const landed18 = items18.find((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed18?.text === expectedText, `the landed answer must carry the full text, got ${JSON.stringify(String(landed18?.text ?? "").slice(0, 60))}`);
	assert(items18.filter((item) => item.kind === "assistant").length === 2, `exactly the prior and the landed answers must remain, got ${JSON.stringify(items18.map((item) => item.id))}`);
	assert(!items18.some((item) => String(item.id ?? "").startsWith("detached-user-")), "no prompt restore is needed when the prompt was persisted");
	await waitUntil(async () => !(await getStatus(room18)).activeLock, "room18 lock released after the landing", 20_000);

	// --- 19. Post-stream tail: unpersisted answer lands on socket close ------
	// The turn completes while the client is still attached, but the client
	// never persists (the debounced save fires ~500ms after the last reveal
	// tick, and this client dies inside that window). The close handler must
	// land the finished answer server-side.
	const fastText = FAST_ANSWER_CHUNKS.join("").trim();
	const room19 = await createRoom("Post-Stream Tail Room");
	const conv19 = `smokeconv19_${Date.now().toString(36)}`;
	const prompt19 = "Just answer quickly, please.";
	await putThread(room19, conv19, []);
	const ws19 = await WsHarness.connect(room19, conv19);
	await ws19.waitFor((frame) => frame.type === "ready", "room19 ready frame");
	ws19.send({ type: "prompt", text: prompt19 });
	await ws19.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room19 turn end", 0, 20_000);
	await waitUntil(async () => {
		const status = await getStatus(room19);
		return status.activeThread?.inFlight === false && status.activeThread?.activeTurn?.lastTerminalReason === "completed";
	}, "room19 turn settled completed", 20_000);
	// No client persist at all: the thread file still holds the pre-turn state.
	const preClose19 = await getThread(room19, conv19);
	assert((preClose19.items ?? []).length === 0, `room19 thread must still be empty before the close, got ${JSON.stringify(preClose19.items)}`);
	ws19.close();
	await waitUntil(async () => {
		const thread = await getThread(room19, conv19);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room19 post-stream landing written", 20_000);
	const thread19 = await getThread(room19, conv19);
	assert(thread19.state === "standby", `room19 should park standby after the unwatched landing, got ${thread19.state}`);
	const items19: any[] = thread19.items ?? [];
	const landed19 = items19.find((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed19?.kind === "assistant" && landed19.text === fastText, `room19 must land the full answer, got ${JSON.stringify(landed19)}`);
	assert(landed19.streaming === false, "room19 landed answer must not be marked streaming");
	const landedUser19 = items19.find((item) => String(item.id ?? "").startsWith("detached-user-"));
	assert(landedUser19?.kind === "user" && landedUser19.text === prompt19, `room19 must restore the never-persisted prompt, got ${JSON.stringify(landedUser19)}`);
	assert(items19.filter((item) => item.kind === "assistant").length === 1, `room19 must land exactly one assistant item, got ${JSON.stringify(items19.map((item) => item.id))}`);
	const status19 = await getStatus(room19);
	assert(status19.unseenLandedAnswer, `room19 landing should record the unseen marker, got ${JSON.stringify(status19.unseenLandedAnswer)}`);
	assert(status19.unseenLandedAnswer.terminalReason === "completed", `room19 marker should carry completed, got ${JSON.stringify(status19.unseenLandedAnswer)}`);
	assert(String(landed19.id) === `detached-assistant-${status19.unseenLandedAnswer.turnId}`, `room19 marker turnId should match the landed item, got ${JSON.stringify({ landedId: landed19.id, marker: status19.unseenLandedAnswer })}`);
	await waitUntil(async () => !(await getStatus(room19)).activeLock, "room19 lock released after the close", 20_000);

	// --- 20. Client persisted first: the close-time landing skips ------------
	const room20 = await createRoom("Persisted First Room");
	const conv20 = `smokeconv20_${Date.now().toString(36)}`;
	const prompt20 = "Another quick one, please.";
	await putThread(room20, conv20, []);
	const ws20 = await WsHarness.connect(room20, conv20);
	await ws20.waitFor((frame) => frame.type === "ready", "room20 ready frame");
	ws20.send({ type: "prompt", text: prompt20 });
	await ws20.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room20 turn end", 0, 20_000);
	await waitUntil(async () => {
		const status = await getStatus(room20);
		return status.activeThread?.inFlight === false && status.activeThread?.activeTurn?.lastTerminalReason === "completed";
	}, "room20 turn settled completed", 20_000);
	// The client's ordinary debounced save carries the answer before the close
	// (the pagehide keepalive save takes this same shape).
	const persistedPut20 = await putThread(room20, conv20, [
		{ kind: "user", id: "u-20", text: prompt20 },
		{ kind: "assistant", id: "a-20", text: fastText, streaming: false },
	]);
	assert(persistedPut20.status === 200, `room20 client persist should succeed, got ${persistedPut20.status}: ${JSON.stringify(persistedPut20.body)}`);
	ws20.close();
	await waitUntil(async () => !(await getStatus(room20)).activeLock, "room20 lock released after the close", 20_000);
	const thread20 = await getThread(room20, conv20);
	const items20: any[] = thread20.items ?? [];
	assert(thread20.state === "active", `room20 must stay active when the client already persisted, got ${thread20.state}`);
	assert(!items20.some((item) => String(item.id ?? "").startsWith("detached-")), `room20 must not land detached items over a persisted answer, got ${JSON.stringify(items20.map((item) => item.id))}`);
	assert(items20.filter((item) => item.kind === "assistant").length === 1, `room20 must keep exactly the client's answer, got ${JSON.stringify(items20.map((item) => item.id))}`);
	const status20 = await getStatus(room20);
	assert(!status20.unseenLandedAnswer, `room20 must not record a marker when the landing skipped, got ${JSON.stringify(status20.unseenLandedAnswer)}`);

	// --- 21. A stale client PUT after the landing merges, never clobbers -----
	const room21 = await createRoom("Late Save Room");
	const conv21 = `smokeconv21_${Date.now().toString(36)}`;
	const prompt21 = "One more quick one, please.";
	await putThread(room21, conv21, []);
	const ws21 = await WsHarness.connect(room21, conv21);
	await ws21.waitFor((frame) => frame.type === "ready", "room21 ready frame");
	ws21.send({ type: "prompt", text: prompt21 });
	await ws21.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room21 turn end", 0, 20_000);
	await waitUntil(async () => {
		const status = await getStatus(room21);
		return status.activeThread?.inFlight === false && status.activeThread?.activeTurn?.lastTerminalReason === "completed";
	}, "room21 turn settled completed", 20_000);
	ws21.close();
	await waitUntil(async () => {
		const thread = await getThread(room21, conv21);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room21 post-stream landing written", 20_000);
	const landedId21 = String((await getThread(room21, conv21)).items.find((item: any) => String(item.id ?? "").startsWith("detached-assistant-")).id);
	// The stale save that was in flight when the socket died arrives now: the
	// prompt plus a partial reveal fragment, from BEFORE the landing.
	const stalePut21 = await putThread(room21, conv21, [
		{ kind: "user", id: "u-21", text: prompt21 },
		{ kind: "assistant", id: "a-21-partial", text: "Quick ", streaming: true },
	]);
	assert(stalePut21.status === 200, `room21 stale save should succeed, got ${stalePut21.status}: ${JSON.stringify(stalePut21.body)}`);
	const merged21 = await getThread(room21, conv21);
	const mergedItems21: any[] = merged21.items ?? [];
	const mergedLanded21 = mergedItems21.find((item) => item.id === landedId21);
	assert(mergedLanded21?.text === fastText, `room21 stale save must not clobber the landed answer, got ${JSON.stringify(mergedItems21.map((item) => [item.id, String(item.text ?? "").slice(0, 30)]))}`);
	assert(!mergedItems21.some((item) => item.id === "a-21-partial"), `room21 merge must drop the stale partial fragment, got ${JSON.stringify(mergedItems21.map((item) => item.id))}`);
	assert(mergedItems21.some((item) => item.id === "u-21"), "room21 merge must keep the client's prompt item");
	assert(!mergedItems21.some((item) => String(item.id ?? "").startsWith("detached-user-")), `room21 merge must not duplicate the prompt, got ${JSON.stringify(mergedItems21.map((item) => item.id))}`);
	assert(mergedItems21.filter((item) => item.kind === "assistant").length === 1, `room21 must end with exactly one assistant item, got ${JSON.stringify(mergedItems21.map((item) => item.id))}`);
	// A late save carrying the client's OWN full copy of the answer (pagehide
	// keepalive that lost the race) is left untouched: no detached duplicate.
	const ownCopyPut21 = await putThread(room21, conv21, [
		{ kind: "user", id: "u-21", text: prompt21 },
		{ kind: "assistant", id: "a-21", text: fastText, streaming: false },
	]);
	assert(ownCopyPut21.status === 200, `room21 own-copy save should succeed, got ${ownCopyPut21.status}`);
	const ownCopy21 = await getThread(room21, conv21);
	const ownCopyItems21: any[] = ownCopy21.items ?? [];
	assert(ownCopyItems21.filter((item) => item.kind === "assistant").length === 1, `room21 own-copy save must not gain a detached duplicate, got ${JSON.stringify(ownCopyItems21.map((item) => item.id))}`);
	assert(ownCopyItems21.some((item) => item.id === "a-21" && item.text === fastText), `room21 own-copy answer must be the one kept, got ${JSON.stringify(ownCopyItems21.map((item) => item.id))}`);

	// --- 22. Messages waiting while it answers, after a reload and in a second window
	// The rig plays no steps, so the two messages wait for the answer's end; a
	// step holds them in the same list (room-steer-smoke.ts case 15b).
	const room22 = await createRoom("Waiting Messages Room");
	const conv22 = `smokeconv22_${Date.now().toString(36)}`;
	await putThread(room22, conv22, []);
	const ws22a = await WsHarness.connect(room22, conv22);
	await ws22a.waitFor((frame) => frame.type === "ready", "room22 ready frame");
	const requestsBefore22 = gatewayRequests.length;
	ws22a.send({ type: "prompt", text: `Tell me about the waiting room. ${SLOW_MARKER}` });
	await ws22a.waitFor((frame) => deltaText(frame).length > 0, "room22 first delta");
	const waiting22 = [{ id: "w22-1", text: "Only the short version." }, { id: "w22-2", text: "And in English." }];
	for (const message of waiting22) ws22a.send({ type: "steer", ...message });
	for (const message of waiting22) await ws22a.waitFor((frame) => frame.type === "steer_waiting" && frame.id === message.id, `room22 ${message.id} waits`);
	ws22a.close();
	await waitDetached(room22, "room22");
	const ws22b = await WsHarness.connect(room22, conv22);
	const ready22b = ws22b.frames[await ws22b.waitFor((frame) => frame.type === "ready", "room22 reload ready")];
	const reattach22b = ws22b.frames[await ws22b.waitFor((frame) => frame.type === "turn_reattach", "room22 reload reattach")];
	assert(JSON.stringify(ready22b.waiting) === JSON.stringify(waiting22) && ready22b.reattaching === true, `room22 the reload's ready lists both waiting messages, got ${JSON.stringify({ waiting: ready22b.waiting, taken: ready22b.taken, reattaching: ready22b.reattaching })}`);
	assert(JSON.stringify(reattach22b.waiting) === JSON.stringify(waiting22), `room22 turn_reattach lists both waiting messages, got ${JSON.stringify(reattach22b.waiting)}`);
	// The answer ends, the room takes both, and its answer to them is held.
	gatewayRequests.slice(requestsBefore22).find((row) => row.slow)!.release();
	for (const message of waiting22) await ws22b.waitFor((frame) => frame.type === "steer_taken" && frame.id === message.id, `room22 ${message.id} taken`);
	await waitUntil(async () => gatewayRequests.slice(requestsBefore22).filter((row) => row.slow).length >= 2, "room22 the answer to both is being written", 20_000);
	const ws22c = await WsHarness.connect(room22, conv22);
	const ready22c = ws22c.frames[await ws22c.waitFor((frame) => frame.type === "ready", "room22 second window ready")];
	assert(JSON.stringify(ready22c.waiting) === "[]" && waiting22.every((message) => (ready22c.taken ?? []).includes(message.id)) && ready22c.reattaching === true, `room22 a second window's ready names both as taken and none waiting, got ${JSON.stringify({ waiting: ready22c.waiting, taken: ready22c.taken, reattaching: ready22c.reattaching })}`);
	releaseHeldStreams();
	await ws22c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room22 the answer to both ends", 0, 40_000);
	ws22b.close();
	ws22c.close();
	await waitUntil(async () => !(await getStatus(room22)).activeLock, "room22 lock released", 20_000);
	// No answer running: nothing waits, nothing is taken, nothing to step back into.
	const conv22idle = `smokeconv22idle_${Date.now().toString(36)}`;
	await putThread(room22, conv22idle, []);
	const ws22d = await WsHarness.connect(room22, conv22idle);
	const ready22d = ws22d.frames[await ws22d.waitFor((frame) => frame.type === "ready", "room22 idle ready")];
	assert(JSON.stringify(ready22d.waiting) === "[]" && JSON.stringify(ready22d.taken) === "[]" && ready22d.reattaching === false, `room22 a conversation with no answer running gets empty lists and no reattach, got ${JSON.stringify({ waiting: ready22d.waiting, taken: ready22d.taken, reattaching: ready22d.reattaching })}`);
	ws22d.close();

	// --- Keyed turns (thread-items-by-id.ts): the page names its question and saves what the frames named.
	const namedIn = (frames: Frame[], fromIndex = 0): string[] => {
		const named: string[] = [];
		for (const frame of frames.slice(fromIndex)) {
			const id = frame.type === "event" ? frame.event?.itemId ?? frame.event?.assistantMessageEvent?.itemId : undefined;
			if (typeof id === "string" && !named.includes(id)) named.push(id);
		}
		return named;
	};
	const keyedPrompt = (key: string, text: string, files: Array<{ name: string; bytes: number; extension: string }> = []) => ({ type: "prompt", text, id: key, shown: { text, files } });

	// --- 23. The next message's reattach anchor is an item the page holds: the adopted turn's landing keeps the frames' ids.
	const room23 = await createRoom("Keyed Anchor Room");
	const conv23 = `smokeconv23_${Date.now().toString(36)}`;
	await putThread(room23, conv23, []);
	const ws23a = await WsHarness.connect(room23, conv23);
	await ws23a.waitFor((frame) => frame.type === "ready", "room23 ready frame");
	const requestsBefore23 = gatewayRequests.length;
	const asked23 = `Walk me through it. ${SLOW_MARKER}`;
	ws23a.send(keyedPrompt("kr23a", asked23));
	await ws23a.waitFor((frame) => deltaText(frame).length > 0, "room23 first delta");
	ws23a.close();
	await waitDetached(room23, "room23");
	const ws23b = await WsHarness.connect(room23, conv23);
	const reattach23 = await ws23b.waitFor((frame) => frame.type === "turn_reattach", "room23 reattach frame");
	gatewayRequests.slice(requestsBefore23).find((row) => row.slow)!.release();
	await ws23b.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room23 adopted answer ends", reattach23, 40_000);
	const part23 = namedIn(ws23b.frames, reattach23).find((id) => /^kr23a-a\d+$/.test(id));
	assert(part23, `room23 the replay names the answer part, got ${JSON.stringify(namedIn(ws23b.frames, reattach23))}`);
	// The page saves the replay under the ids the frames named, and sends its next message at once.
	const pageList23 = [{ kind: "user", id: "kr23a", text: asked23, ts: Date.now() }, { kind: "assistant", id: part23, text: expectedText, streaming: false, ts: Date.now() }];
	await putThread(room23, conv23, pageList23);
	const requestsBeforeNext23 = gatewayRequests.length;
	ws23b.send(keyedPrompt("kr23b", "And the next part?"));
	await waitUntil(async () => gatewayRequests.slice(requestsBeforeNext23).some((row) => row.slow), "room23 the next answer is being written", 20_000);
	ws23b.close();
	await waitDetached(room23, "room23 after the next message");
	const ws23c = await WsHarness.connect(room23, conv23);
	const reattach23c = ws23c.frames[await ws23c.waitFor((frame) => frame.type === "turn_reattach", "room23 second reattach frame")];
	assert(pageList23.some((item) => item.id === reattach23c.anchorItemId), `room23 the reattach anchor is an item the page holds, got ${JSON.stringify(reattach23c.anchorItemId)} for ${JSON.stringify(pageList23.map((item) => item.id))}`);
	assert(reattach23c.promptId === "kr23b" && reattach23c.userText === "And the next part?", `room23 the reattach names the question by id, got ${JSON.stringify({ promptId: reattach23c.promptId, userText: reattach23c.userText })}`);
	releaseHeldStreams();
	await ws23c.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room23 the next answer ends", 0, 40_000);
	ws23c.close();
	await waitUntil(async () => !(await getStatus(room23)).activeLock, "room23 lock released", 20_000);

	// --- 24. A lost connection keeps nothing short: the landing replaces the page's cut-off copy; a Stop's copy keeps its cut.
	const room24 = await createRoom("Keyed Cut Room");
	const conv24 = `smokeconv24_${Date.now().toString(36)}`;
	await putThread(room24, conv24, []);
	const ws24a = await WsHarness.connect(room24, conv24);
	await ws24a.waitFor((frame) => frame.type === "ready", "room24 ready frame");
	const requestsBefore24 = gatewayRequests.length;
	const asked24 = `Tell me everything. ${SLOW_MARKER}`;
	const mark24 = ws24a.frames.length;
	ws24a.send(keyedPrompt("kr24a", asked24));
	await ws24a.waitFor((frame) => deltaText(frame).length > 0, "room24 first delta");
	const part24 = namedIn(ws24a.frames, mark24).find((id) => /^kr24a-a\d+$/.test(id))!;
	assert(part24, "room24 the frames name the answer part");
	await putThread(room24, conv24, [{ kind: "user", id: "kr24a", text: asked24 }, { kind: "assistant", id: part24, text: "slow part 1.\n\n_The connection was lost._", streaming: false }]);
	ws24a.close();
	await waitDetached(room24, "room24");
	gatewayRequests.slice(requestsBefore24).find((row) => row.slow)!.release();
	await waitUntil(async () => ((await getThread(room24, conv24)).items ?? []).some((item: any) => item.id === part24 && item.landed === true), "room24 the answer landed", 40_000);
	const lost24 = ((await getThread(room24, conv24)).items ?? []).find((item: any) => item.id === part24);
	assert(lost24.text === expectedText && lost24.stoppedAt === undefined, `room24 a lost connection's copy gives way to the whole answer, got ${JSON.stringify(String(lost24.text).slice(0, 80))}`);
	await waitUntil(async () => !(await getStatus(room24)).activeLock, "room24 lock released", 20_000);
	// The detached landing parks the thread before the next connection opens.
	await waitUntil(async () => (await getThread(room24, conv24)).state === "standby", "room24 detached landing parks the thread", 20_000);
	// After a Stop the page's copy is stopped, and the file keeps that cut.
	const ws24b = await WsHarness.connect(room24, conv24);
	await ws24b.waitFor((frame) => frame.type === "ready", "room24 second ready");
	const requestsBeforeStop24 = gatewayRequests.length;
	const mark24b = ws24b.frames.length;
	ws24b.send(keyedPrompt("kr24b", `Once more. ${SLOW_MARKER}`));
	await ws24b.waitFor((frame) => deltaText(frame).length > 0, "room24 second first delta", mark24b);
	gatewayRequests.slice(requestsBeforeStop24).find((row) => row.slow)!.release(2);
	await ws24b.waitFor((frame) => deltaText(frame).includes("slow part 3. "), "room24 more of the answer shows", mark24b);
	const shown24 = "slow part 1. slow part 2.".length;
	ws24b.send({ type: "abort", shown: shown24 });
	const stopped24 = namedIn(ws24b.frames, mark24b).find((id) => /^kr24b-a\d+$/.test(id))!;
	const pageStopped = `${"slow part 1. slow part 2.".slice(0, shown24)}\n\n_Stopped._`;
	const before24 = (await getThread(room24, conv24)).items ?? [];
	const stopSave24 = await putThread(room24, conv24, [...before24.filter((item: any) => item.id !== stopped24), { kind: "assistant", id: stopped24, text: pageStopped, stoppedAt: shown24, streaming: false }]);
	assert(stopSave24.status === 200, `room24 the stopped answer save succeeds, got ${stopSave24.status}: ${JSON.stringify(stopSave24.body)}`);
	await ws24b.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room24 the stopped answer ends", mark24b, 20_000);
	const settledSave24 = await putThread(room24, conv24, [...before24.filter((item: any) => item.id !== stopped24), { kind: "assistant", id: stopped24, text: pageStopped, stoppedAt: shown24, streaming: false }]);
	assert(settledSave24.status === 200, `room24 the settled Stop save succeeds, got ${settledSave24.status}: ${JSON.stringify(settledSave24.body)}`);
	await waitUntil(async () => ((await getThread(room24, conv24)).items ?? []).some((item: any) => item.id === stopped24 && item.landed === true), "room24 the stopped answer landed", 20_000);
	const kept24 = ((await getThread(room24, conv24)).items ?? []).find((item: any) => item.id === stopped24);
	assert(kept24.stoppedAt === shown24 && kept24.text === pageStopped, `room24 a Stop's copy keeps its cut and its note, got ${JSON.stringify(kept24)}`);
	ws24b.close();
	await waitUntil(async () => !(await getStatus(room24)).activeLock, "room24 lock released after the Stop", 20_000);

	// --- 25. A reload during a files-only question: the reattach names the question and its chips, with no words.
	const room25 = await createRoom("Keyed Files Room");
	const conv25 = `smokeconv25_${Date.now().toString(36)}`;
	await putThread(room25, conv25, []);
	const ws25a = await WsHarness.connect(room25, conv25);
	await ws25a.waitFor((frame) => frame.type === "ready", "room25 ready frame");
	const files25 = [{ name: "plan.pdf", bytes: 1200, extension: "pdf" }, { name: "notes.txt", bytes: 80, extension: "txt" }];
	ws25a.send({ ...keyedPrompt("kr25", `[Attached files: plan.pdf, notes.txt] ${SLOW_MARKER}`, files25), shown: { text: "", files: files25 } });
	await ws25a.waitFor((frame) => deltaText(frame).length > 0, "room25 first delta");
	ws25a.close();
	await waitDetached(room25, "room25");
	const ws25b = await WsHarness.connect(room25, conv25);
	const reattach25 = ws25b.frames[await ws25b.waitFor((frame) => frame.type === "turn_reattach", "room25 reattach frame")];
	assert(reattach25.promptId === "kr25" && JSON.stringify(reattach25.promptFiles) === JSON.stringify(files25) && reattach25.userText === "", `room25 the reattach carries the id, both chips and no words, got ${JSON.stringify({ promptId: reattach25.promptId, promptFiles: reattach25.promptFiles, userText: reattach25.userText })}`);
	releaseHeldStreams();
	await ws25b.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room25 the answer ends", 0, 40_000);
	ws25b.close();

	console.log("persistent-room detached turn reattach smoke passed");
} catch (error) {
	reportDetachedFailure(error);
} finally {
	await stopDetachedServer();
}
