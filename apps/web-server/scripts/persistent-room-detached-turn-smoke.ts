import fs from "node:fs";
import path from "node:path";
import { assert, countOccurrences, createRoom, deltaText, expectedText, type GatewayRequest, gatewayRequests, getStatus, getThread, HANG_ANSWER_CHUNKS, HANG_MARKER, joinedDeltas, putThread, releaseHeldStreams, reportDetachedFailure, SLOW_ANSWER_CHUNKS, SLOW_MARKER, startDetachedServer, stopDetachedServer, tempHome, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

// End to end: closing the room websocket while a turn is
// in flight DETACHES the turn instead of aborting it. Against a real spawned
// server with a synthetic OpenAI-compatible SSE gateway, proves:
//   1. the provider stream is NOT aborted by the disconnect and runs to its end;
//   2. the room lock stays held while the turn cooks (a new connection bounces
//      with the "finishing a response in the background" message);
//   3. the finished answer lands in the thread file server-side, superseding a
//      partial assistant tail the client persisted before the drop, and the
//      thread parks as standby;
//   4. the turn state settles idle/completed and the lock releases, so a new
//      connection (Resume) succeeds afterwards;
//   5. a turn the user STOPPED before disconnecting still cancels (no detach);
//   6. a provider stream that HANGS after the disconnect is stopped by the
//      away limit on no progress (shortened via EXXETA_DETACHED_TURN_SILENCE_MS),
//      the partial lands with that limit's line, and the lock releases.
// Slice 3 (completion signal) rides the same sections: the landing records an
// unseen-landed-answer marker on the room status (threadId/turnId/terminal
// reason), binding a new session clears it, a cancelled turn never writes one,
// and the away-limit landing records the marker with terminalReason failed.
// Stepping back into a room extends the run:
//   2. (rewritten) a connection for the SAME conversation no longer bounces
//      mid-cook: it binds, receives turn_reattach plus the replayed stream
//      from the turn's very first chunk, then the live continuation, and
//      leaving again re-detaches (away limits re-armed, lock kept) so the
//      original landing sections 3 and 4 still prove the unwatched path; the
//      honest room_cooking bounce survives only for a mismatched conversation;
//   7. a reattach that stays: the adopted stream runs to the turn's end on the
//      new socket with the deltas joining seamlessly (no gap, no duplicate),
//      the landing is written exactly once with the room left active (not
//      standby), no unseen marker is recorded for an answer the user watched
//      land, and the next prompt works because the settle rebinds the session;
//   8. reattach then Stop: the adopted turn cancels through the ordinary
//      cancelling machinery (provider request aborted, terminal reason
//      cancelled, no marker);
//   9. reattach racing the landing: connecting while the last chunk is in
//      flight resolves coherently on either side of the race, with the answer
//      landing exactly once and, when the bind won a claim, the replayed
//      frames carrying the whole answer exactly once;
// Sections 10 to 21 run in persistent-room-detached-turn-reattach-smoke.ts, on the
// same rig (persistent-room-detached-turn-setup.ts).

try {
	await startDetachedServer();

	const roomId = await createRoom("Detached Turn Room");
	const conversationId = `smokeconv_${Date.now().toString(36)}`;
	await putThread(roomId, conversationId, []);

	// --- 1. Detach: disconnect mid-stream, turn keeps cooking ----------------
	const ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", "ready frame");
	const promptText = `Please think out loud. ${SLOW_MARKER}`;
	ws.send({ type: "prompt", text: promptText });
	// Simulate the client's debounced persist landing the user's message plus
	// a partial assistant tail before the drop.
	await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "first streamed delta");
	const partialItems = [
		{ kind: "user", id: "u1", text: promptText },
		{ kind: "assistant", id: "i_mhz1a1_1_k3p9q", text: "slow part 1. ", streaming: true },
	];
	const partialPut = await putThread(roomId, conversationId, partialItems);
	assert(partialPut.status === 200, `mid-stream client persist should succeed, got ${partialPut.status}: ${JSON.stringify(partialPut.body)}`);
	const requestsBeforeClose = gatewayRequests.filter((request) => request.slow).length;
	assert(requestsBeforeClose === 1, `exactly one slow provider request should be in flight, got ${requestsBeforeClose}`);
	ws.close();

	// --- 2. While cooking: stepping back in ADOPTS the turn ------------------
	const slowRequest = gatewayRequests.find((request) => request.slow)!;
	await waitUntil(async () => slowRequest.aborted || (await getStatus(roomId)).answeringDetached === true, "the server has taken the disconnect", 10_000);
	assert(!slowRequest.aborted, "the provider stream must NOT be aborted by the disconnect");
	// The status advertises the open door: cooking with no client attached.
	const cookingStatus = await getStatus(roomId);
	assert(cookingStatus.answeringDetached === true, `a cooking room with no client should report answeringDetached, got ${JSON.stringify(cookingStatus.answeringDetached)}`);
	// A connection for a DIFFERENT conversation still bounces, honestly: the
	// machine-readable code stays the client's detach-vs-death signal.
	const wsOther = await WsHarness.connect(roomId, `smokeconv_other_${Date.now().toString(36)}`);
	const bounceIndex = await wsOther.waitFor((frame) => frame.type === "error", "mismatched-conversation bounce while cooking");
	assert(wsOther.frames[bounceIndex].code === "room_cooking", `bounce should carry code room_cooking, got: ${JSON.stringify(wsOther.frames[bounceIndex].code)}`);
	wsOther.close();
	// The SAME conversation binds instead of bouncing: ready frame, then the
	// reattach frame, then the whole stream so far replayed, then live deltas.
	const ws2 = await WsHarness.connect(roomId, conversationId);
	await ws2.waitFor((frame) => frame.type === "ready", "reattach ready frame");
	const reattachIndex = await ws2.waitFor((frame) => frame.type === "turn_reattach", "turn_reattach frame");
	const reattachFrame = ws2.frames[reattachIndex];
	assert(reattachFrame.settled === false, `a mid-cook reattach should not be settled, got ${JSON.stringify(reattachFrame.settled)}`);
	assert(reattachFrame.conversationId === conversationId, `turn_reattach should name the cooking conversation, got ${JSON.stringify(reattachFrame.conversationId)}`);
	assert(String(reattachFrame.userText ?? "").includes(SLOW_MARKER), `turn_reattach should carry the turn's user text, got ${JSON.stringify(reattachFrame.userText)}`);
	assert(typeof reattachFrame.startedAt === "number" && reattachFrame.startedAt <= Date.now(), `turn_reattach should carry the turn's start time, got ${JSON.stringify(reattachFrame.startedAt)}`);
	// The replay reaches back to the turn's very first chunk, which streamed
	// before this connection even existed.
	await ws2.waitFor((frame) => deltaText(frame).includes("slow part 1. "), "replayed first chunk", reattachIndex);
	// Live continuation: a later chunk arrives on this socket as it streams.
	slowRequest.release(7);
	await ws2.waitFor((frame) => deltaText(frame).includes("slow part 8. "), "live continuation past the replay", reattachIndex, 15_000);
	const seamText = joinedDeltas(ws2.frames, reattachIndex);
	assert(seamText.startsWith("slow part 1. slow part 2. "), `replayed and live deltas must join seamlessly, got ${JSON.stringify(seamText.slice(0, 60))}`);
	assert(countOccurrences(seamText, "slow part 1. ") === 1, `the seam must not duplicate replayed text, got ${JSON.stringify(seamText.slice(0, 120))}`);
	const adoptedStatus = await getStatus(roomId);
	assert(adoptedStatus.answeringDetached === false, `an adopted turn is no longer detached cooking, got ${JSON.stringify(adoptedStatus.answeringDetached)}`);
	assert(adoptedStatus.activeLock, "the room lock stays held while the adopter is inside");
	// Leaving again mid-cook re-detaches: the turn keeps cooking with the lock
	// held and the door reopens, so sections 3 and 4 still prove the original
	// UNWATCHED landing (standby parking plus the unseen marker).
	ws2.close();
	await waitUntil(async () => (await getStatus(roomId)).answeringDetached === true, "room back to detached cooking after the adopter left", 10_000);
	assert(!slowRequest.aborted, "the provider stream must survive a reattach and a second leave");

	// --- 3. The turn runs to its end and lands in the thread file ------------
	slowRequest.release();
	await waitUntil(() => slowRequest.finished, "provider stream finished", 30_000);
	await waitUntil(async () => {
		const thread = await getThread(roomId, conversationId);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "landed detached assistant item", 30_000);
	const landedThread = await getThread(roomId, conversationId);
	assert(landedThread.state === "standby", `thread should park as standby after landing, got ${landedThread.state}`);
	const landedItems: any[] = landedThread.items ?? [];
	const landed = landedItems.find((item) => String(item.id ?? "").startsWith("detached-assistant-"));
	assert(landed?.kind === "assistant" && landed.text === expectedText, `landed assistant item should carry the full answer, got ${JSON.stringify(landed)}`);
	assert(landed.streaming === false, "landed assistant item must not be marked streaming");
	assert(typeof landed.ts === "number" && landed.ts >= reattachFrame.startedAt, `landed assistant item should be stamped no earlier than the turn's start, got ${JSON.stringify({ ts: landed.ts, startedAt: reattachFrame.startedAt })}`);
	assert(!landedItems.some((item) => item.id === "i_mhz1a1_1_k3p9q"), "the partial assistant tail must be superseded by the landed answer");
	assert(landedItems.some((item) => item.id === "u1" && item.kind === "user"), "the user's message must survive the landing");
	assert(landedItems.filter((item) => item.kind === "assistant").length === 1, `exactly one assistant item should remain, got ${JSON.stringify(landedItems.map((item) => item.id))}`);

	// --- 4. Turn settled + lock released: reopening works --------------------
	const status = await getStatus(roomId);
	assert(status.activeThread?.inFlight === false, `turn should be settled, got ${JSON.stringify(status.activeThread?.activeTurn)}`);
	assert(status.activeThread?.activeTurn?.lastTerminalReason === "completed", `turn should settle completed, got ${JSON.stringify(status.activeThread?.activeTurn)}`);
	assert(!status.activeLock, `room lock should be released after landing, got ${JSON.stringify(status.activeLock)}`);
	// Slice 3: the landing recorded the unseen marker — a fresh session's Home
	// reads it off the status to badge the room.
	assert(status.unseenLandedAnswer, `the landing should record an unseen-landed-answer marker, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(status.unseenLandedAnswer.threadId === conversationId, `marker should name the landed thread, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(status.unseenLandedAnswer.terminalReason === "completed", `marker should carry terminalReason completed, got ${JSON.stringify(status.unseenLandedAnswer)}`);
	assert(String(landed.id) === `detached-assistant-${status.unseenLandedAnswer.turnId}`, `marker turnId should match the landed item id, got ${JSON.stringify({ landedId: landed.id, marker: status.unseenLandedAnswer })}`);
	const reopenPut = await putThread(roomId, conversationId, landedItems);
	assert(reopenPut.status === 200, `resume PUT should succeed, got ${reopenPut.status}`);
	const ws3 = await WsHarness.connect(roomId, conversationId);
	await ws3.waitFor((frame) => frame.type === "ready", "resume ready frame");
	// Slice 3: binding a session to the room clears the marker (the user is
	// looking at the landed answer now).
	const boundStatus = await getStatus(roomId);
	assert(!boundStatus.unseenLandedAnswer, `binding a session should clear the unseen marker, got ${JSON.stringify(boundStatus.unseenLandedAnswer)}`);

	// Slice 3 self-heal: a marker whose thread is no longer the room's active
	// thread (read in the CLI, thread retired from another door) must be
	// dropped by the status read instead of badging the room forever.
	const staleMarkerPath = path.join(tempHome, ".exxperts", "app", "personalized-agents", roomId, "runtime", "unseen-landed-answer.json");
	fs.writeFileSync(staleMarkerPath, JSON.stringify({ threadId: "thread_smoke_retired_000000", turnId: "turn-smoke-stale", terminalReason: "completed", landedAt: Date.now() }));
	const healedStatus = await getStatus(roomId);
	assert(!healedStatus.unseenLandedAnswer, `a marker for a retired thread should self-heal away on status read, got ${JSON.stringify(healedStatus.unseenLandedAnswer)}`);
	assert(!fs.existsSync(staleMarkerPath), "the stale marker file should be removed by the self-heal");

	// --- 5. Stop-then-disconnect still cancels (no detach) -------------------
	const requestsBeforeStop = gatewayRequests.length;
	ws3.send({ type: "prompt", text: `Another long one. ${SLOW_MARKER}` });
	await ws3.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "second turn first delta");
	ws3.send({ type: "abort" });
	ws3.close();
	await waitUntil(() => {
		const request = gatewayRequests.slice(requestsBeforeStop).find((row) => row.slow);
		return !!request && (request.aborted || request.finished);
	}, "stopped turn's provider request settled", 20_000);
	const stoppedRequest = gatewayRequests.slice(requestsBeforeStop).find((row) => row.slow)!;
	assert(stoppedRequest.aborted, "a turn the user stopped must abort its provider request on disconnect");
	await waitUntil(async () => {
		const after = await getStatus(roomId);
		return after.activeThread?.inFlight === false && !after.activeLock;
	}, "stopped turn settled and lock released", 20_000);
	const afterStop = await getThread(roomId, conversationId);
	assert(!(afterStop.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-") && item.id !== landed.id), "a cancelled turn must not land a detached assistant item");
	// Slice 3: no landing means no marker — a stopped turn is a SEEN ending.
	const afterStopStatus = await getStatus(roomId);
	assert(!afterStopStatus.unseenLandedAnswer, `a cancelled turn must not record an unseen marker, got ${JSON.stringify(afterStopStatus.unseenLandedAnswer)}`);

	// --- 6. Away limit: a hung provider stream cannot cook forever ----------
	// The gateway streams one chunk and then goes silent. After the disconnect
	// the shortened silence limit (EXXETA_DETACHED_TURN_SILENCE_MS) must abort
	// the turn, land the partial with that limit's line, and release the
	// lock: without it the room would refuse connections until someone
	// stepped back in to stop it.
	const ws4 = await WsHarness.connect(roomId, conversationId);
	await ws4.waitFor((frame) => frame.type === "ready", "hang turn ready frame");
	const requestsBeforeHang = gatewayRequests.length;
	ws4.send({ type: "prompt", text: `This provider goes silent. ${HANG_MARKER}` });
	await ws4.waitFor((frame) => frame.type === "event" && frame.event?.type === "message_update", "hang turn first delta");
	ws4.close();
	await waitUntil(() => {
		const request = gatewayRequests.slice(requestsBeforeHang).find((row) => row.hang);
		return !!request && request.aborted;
	}, "hung provider request aborted by the away limit", 30_000);
	await waitUntil(async () => {
		const after = await getStatus(roomId);
		return after.activeThread?.inFlight === false && !after.activeLock;
	}, "away-limit-aborted turn settled and lock released", 20_000);
	const afterHangStatus = await getStatus(roomId);
	assert(afterHangStatus.activeThread?.activeTurn?.lastTerminalReason === "failed", `away-limit-aborted turn should settle failed, got ${JSON.stringify(afterHangStatus.activeThread?.activeTurn)}`);
	const hangThread = await getThread(roomId, conversationId);
	assert(hangThread.state === "standby", `thread should park as standby after the away-limit landing, got ${hangThread.state}`);
	const hangItems: any[] = hangThread.items ?? [];
	const hangLanded = hangItems.find((item) => String(item.id ?? "").startsWith("detached-assistant-") && item.id !== landed.id);
	assert(hangLanded?.kind === "assistant" && hangLanded.text === HANG_ANSWER_CHUNKS.join("").trim(), `the away-limit landing should carry the partial answer, got ${JSON.stringify(hangLanded)}`);
	const hangLine = hangItems.find((item) => String(item.id ?? "").startsWith("detached-partial-") && item.kind === "system");
	assert(hangLine?.text === "Stopped while you were away: it made no progress for 10 minutes. The steps it finished are above." && hangLine.failure === "away-no-progress" && hangLine.level === "error", `the partial landing must carry the no-progress line, got ${JSON.stringify(hangLine ?? hangItems.map((item) => item.id))}`);
	// Slice 3: the away-limit landing records the marker too, with the honest
	// failed reason — the client badges completed landings only, so the reason
	// must survive the wire.
	assert(afterHangStatus.unseenLandedAnswer?.terminalReason === "failed", `the away-limit landing should record an unseen marker with terminalReason failed, got ${JSON.stringify(afterHangStatus.unseenLandedAnswer)}`);
	assert(afterHangStatus.unseenLandedAnswer.threadId === conversationId, `the away-limit marker should name the landed thread, got ${JSON.stringify(afterHangStatus.unseenLandedAnswer)}`);

	// --- 7. Full reattach: watch the answer land -----------------------------
	// A fresh room so the landing assertions cannot be polluted by earlier
	// sections' landed items.
	const room7 = await createRoom("Reattach Watch Room");
	const conv7 = `smokeconv7_${Date.now().toString(36)}`;
	await putThread(room7, conv7, []);
	const ws5 = await WsHarness.connect(room7, conv7);
	await ws5.waitFor((frame) => frame.type === "ready", "room7 ready frame");
	const prompt7 = `Watch me finish. ${SLOW_MARKER}`;
	const requestsBefore7 = gatewayRequests.length;
	ws5.send({ type: "prompt", text: prompt7 });
	await ws5.waitFor((frame) => deltaText(frame).length > 0, "room7 first delta");
	// The client's leave-save: the user's message plus a partial tail.
	const partial7 = await putThread(room7, conv7, [
		{ kind: "user", id: "u7", text: prompt7 },
		{ kind: "assistant", id: "i_mhz1a7_7_w2x8r", text: "slow part 1. ", streaming: true },
	]);
	assert(partial7.status === 200, `room7 mid-stream persist should succeed, got ${partial7.status}`);
	ws5.close();
	await waitDetached(room7, "room7");
	const ws6 = await WsHarness.connect(room7, conv7);
	await ws6.waitFor((frame) => frame.type === "ready", "room7 reattach ready frame");
	const reattach7 = await ws6.waitFor((frame) => frame.type === "turn_reattach", "room7 turn_reattach frame");
	// Watch it land: the adopted stream runs to the turn's end on THIS socket.
	const request7 = gatewayRequests.slice(requestsBefore7).find((row) => row.slow)!;
	request7.release();
	await ws6.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room7 adopted turn end", reattach7, 40_000);
	const joined7 = joinedDeltas(ws6.frames, reattach7);
	assert(joined7.trim() === expectedText, `replay plus live deltas must carry the whole answer with no gap, got ${JSON.stringify(joined7.slice(0, 120))}`);
	assert(countOccurrences(joined7, "slow part 1. ") === 1, `the watched stream must carry the answer exactly once, got ${JSON.stringify(joined7.slice(0, 160))}`);
	assert(request7.finished && !request7.aborted, "the adopted turn's provider stream must run to its end");
	// The landing is written exactly once, and as a WATCHED landing: the open
	// room is not parked standby, the partial tail is superseded, and no unseen
	// marker is recorded for an answer the user watched land.
	await waitUntil(async () => {
		const thread = await getThread(room7, conv7);
		return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
	}, "room7 adopted landing written", 20_000);
	const thread7 = await getThread(room7, conv7);
	assert(thread7.state === "active", `a watched landing must not park the open room as standby, got ${thread7.state}`);
	const assistants7 = (thread7.items ?? []).filter((item: any) => item.kind === "assistant");
	assert(assistants7.length === 1 && assistants7[0].text === expectedText, `room7 should land exactly one assistant item carrying the full answer, got ${JSON.stringify(assistants7.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
	assert(!(thread7.items ?? []).some((item: any) => item.id === "i_mhz1a7_7_w2x8r"), "room7's partial tail must be superseded by the watched landing");
	const status7 = await getStatus(room7);
	assert(status7.activeThread?.inFlight === false, `room7 turn should be settled, got ${JSON.stringify(status7.activeThread?.activeTurn)}`);
	assert(status7.activeThread?.activeTurn?.lastTerminalReason === "completed", `room7 turn should settle completed, got ${JSON.stringify(status7.activeThread?.activeTurn)}`);
	assert(!status7.unseenLandedAnswer, `a watched landing must not record an unseen marker, got ${JSON.stringify(status7.unseenLandedAnswer)}`);
	assert(status7.activeLock, "the adopter keeps the room lock as an ordinary live session");
	// The next prompt works: the settle rebound the session onto the landed
	// history, so the room keeps chatting without a reconnect. (The session
	// history carries the SLOW marker, so the gateway holds it like the first;
	// what matters is that the rebound session streams and completes at all.)
	const beforeFollowUp = ws6.frames.length;
	const requestsBeforeFollowUp = gatewayRequests.length;
	ws6.send({ type: "prompt", text: "Say something else now." });
	await ws6.waitFor((frame) => deltaText(frame).length > 0, "room7 follow-up prompt streams", beforeFollowUp, 30_000);
	releaseHeldStreams();
	await ws6.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room7 follow-up turn end", beforeFollowUp, 40_000);
	assert(gatewayRequests.length > requestsBeforeFollowUp, "room7 follow-up must reach the provider through the rebound session");
	ws6.close();
	await waitUntil(async () => !(await getStatus(room7)).activeLock, "room7 lock released after the adopter left", 20_000);

	// --- 8. Reattach then Stop -----------------------------------------------
	const room8 = await createRoom("Reattach Stop Room");
	const conv8 = `smokeconv8_${Date.now().toString(36)}`;
	await putThread(room8, conv8, []);
	const ws7 = await WsHarness.connect(room8, conv8);
	await ws7.waitFor((frame) => frame.type === "ready", "room8 ready frame");
	const requestsBefore8 = gatewayRequests.length;
	ws7.send({ type: "prompt", text: `Stop me after the comeback. ${SLOW_MARKER}` });
	await ws7.waitFor((frame) => deltaText(frame).length > 0, "room8 first delta");
	ws7.close();
	await waitDetached(room8, "room8");
	const ws8 = await WsHarness.connect(room8, conv8);
	await ws8.waitFor((frame) => frame.type === "ready", "room8 reattach ready frame");
	await ws8.waitFor((frame) => frame.type === "turn_reattach", "room8 turn_reattach frame");
	const request8 = gatewayRequests.slice(requestsBefore8).find((row) => row.slow)!;
	assert(!request8.aborted, "room8's provider stream must still be cooking at reattach");
	// Stop from the adopted session cancels through the ordinary machinery.
	ws8.send({ type: "abort" });
	await waitUntil(() => request8.aborted, "room8 provider request aborted by Stop after reattach", 15_000);
	await waitUntil(async () => (await getStatus(room8)).activeThread?.inFlight === false, "room8 stopped turn settled", 20_000);
	const status8 = await getStatus(room8);
	assert(status8.activeThread?.activeTurn?.lastTerminalReason === "cancelled", `a stop after reattach should settle cancelled, got ${JSON.stringify(status8.activeThread?.activeTurn)}`);
	assert(!status8.unseenLandedAnswer, `a stop the user watched must not record an unseen marker, got ${JSON.stringify(status8.unseenLandedAnswer)}`);
	ws8.close();
	await waitUntil(async () => !(await getStatus(room8)).activeLock, "room8 lock released after the stopping session left", 20_000);

	// --- 9. Reattach racing the landing --------------------------------------
	// Two probes into the race window: connect while the LAST chunk is still
	// in flight, and connect the instant the stream finished (the settle is
	// then racing the bind itself). Whichever side wins, exactly one coherent
	// outcome must hold: either the bind adopts the live tail, or it replays a
	// stream that settled mid-bind, or it binds to a settled thread; the
	// answer lands exactly once either way.
	// Each probe lets the stream go up to its trigger, and the first lets the
	// last chunk go as the connection opens.
	const raceProbes: Array<{ label: string; release: (request: GatewayRequest) => void; trigger: (request: GatewayRequest) => boolean; onConnect: (request: GatewayRequest) => void }> = [
		{ label: "last chunk in flight", release: (request) => request.release(SLOW_ANSWER_CHUNKS.length - 2), trigger: (request) => request.sent >= SLOW_ANSWER_CHUNKS.length - 1, onConnect: (request) => request.release() },
		{ label: "stream just finished", release: (request) => request.release(), trigger: (request) => request.finished, onConnect: () => {} },
	];
	for (const probe of raceProbes) {
		const room9 = await createRoom(`Reattach Race Room ${raceProbes.indexOf(probe) + 1}`);
		const conv9 = `smokeconv9_${Date.now().toString(36)}`;
		await putThread(room9, conv9, []);
		let ws9 = await WsHarness.connect(room9, conv9);
		await ws9.waitFor((frame) => frame.type === "ready", "room9 ready frame");
		const requestsBefore9 = gatewayRequests.length;
		ws9.send({ type: "prompt", text: `Race the landing. ${SLOW_MARKER}` });
		await ws9.waitFor((frame) => deltaText(frame).length > 0, "room9 first delta");
		ws9.close();
		const request9 = gatewayRequests.slice(requestsBefore9).find((row) => row.slow)!;
		probe.release(request9);
		await waitUntil(() => probe.trigger(request9), `room9 race trigger (${probe.label})`, 30_000);
		ws9 = await WsHarness.connect(room9, conv9);
		probe.onConnect(request9);
		await ws9.waitFor((frame) => frame.type === "ready", "room9 race ready frame");
		await waitUntil(async () => (await getStatus(room9)).activeThread?.inFlight === false, "room9 race turn settled", 30_000);
		await waitUntil(async () => {
			const thread = await getThread(room9, conv9);
			return (thread.items ?? []).some((item: any) => String(item.id ?? "").startsWith("detached-assistant-"));
		}, "room9 landing written", 20_000);
		const thread9 = await getThread(room9, conv9);
		const assistants9 = (thread9.items ?? []).filter((item: any) => item.kind === "assistant");
		assert(assistants9.length === 1 && assistants9[0].text === expectedText, `the race must land the answer exactly once, got ${JSON.stringify(assistants9.map((item: any) => [item.id, String(item.text).slice(0, 40)]))}`);
		const reattach9 = ws9.frames.findIndex((frame) => frame.type === "turn_reattach");
		if (reattach9 >= 0) {
			// The bind won a claim: whether it adopted the live tail or replayed
			// a stream that settled mid-bind, the frames carry the whole answer
			// exactly once and reach the turn's terminal frame.
			await ws9.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "room9 race stream reaches the turn end", reattach9, 20_000);
			const joined9 = joinedDeltas(ws9.frames, reattach9);
			assert(joined9.trim() === expectedText, `the raced replay must carry the whole answer with no gap, got ${JSON.stringify(joined9.slice(0, 120))}`);
			assert(countOccurrences(joined9, "slow part 1. ") === 1, `the raced replay must not duplicate text, got ${JSON.stringify(joined9.slice(0, 160))}`);
			console.log(`  race branch (${probe.label}): reattach (settled=${JSON.stringify(ws9.frames[reattach9].settled)})`);
		} else {
			// The landing beat the connect entirely: an ordinary bind onto the
			// settled thread, whose file already carries the landed answer.
			console.log(`  race branch (${probe.label}): landing won before the bind`);
		}
		const status9 = await getStatus(room9);
		assert(!status9.unseenLandedAnswer, `no unseen marker may survive a session inside the room, got ${JSON.stringify(status9.unseenLandedAnswer)}`);
		ws9.close();
		await waitUntil(async () => !(await getStatus(room9)).activeLock, "room9 lock released after the racing session left", 20_000);
	}


	console.log("persistent-room detached turn smoke passed");
} catch (error) {
	reportDetachedFailure(error);
} finally {
	await stopDetachedServer();
}
