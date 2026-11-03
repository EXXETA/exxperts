import { COALESCE_WINDOW_MS, createTurnFrameCoalescer, MAX_PENDING_CHARS } from "../src/turn-frame-coalescer.js";
import { createWebClientEventProjector } from "../src/web-client-event-projection.js";
import { createRoom, deltaText, expectedText, type Frame, gatewayRequests, getStatus, putThread, reportDetachedFailure, SLOW_ANSWER_CHUNKS, SLOW_MARKER, startDetachedServer, stopDetachedServer, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

// Two parts. The coalescer on its own, on a hand-driven clock: what merges,
// what goes out at once, and that nothing overtakes text written before it.
// Then a real room on the reattach rig (persistent-room-detached-turn-setup.ts):
// every turn frame carries seq, counting from 1 per turn, and a reattach
// replays the very frames the first window got, numbers included.

// Not an assertion signature: the checks read out.length again after each push, which a narrowed type would forbid.
function check(condition: unknown, message: string): void {
	if (!condition) throw new Error(message);
}

// A hand-driven clock: the window's timer fires only when the smoke says so.
function fakeTimer() {
	let due: Array<() => void> = [];
	return {
		set: (fn: () => void, _ms: number) => { due.push(fn); },
		fire: () => { const fns = due; due = []; for (const fn of fns) fn(); },
		pending: () => due.length,
	};
}
const text = (delta: string, contentIndex = 0) => ({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex, delta } } });
const beat = (type: string) => ({ type: "event", event: { type: "message_update", assistantMessageEvent: { type, contentIndex: 1 } } });
const deltaOf = (frame: any): string | undefined => frame?.event?.assistantMessageEvent?.delta;
const kindOf = (frame: any): string => frame?.type === "event" ? (frame.event.assistantMessageEvent?.type ?? frame.event.type) : frame?.type;
const coalescer = () => {
	const t = fakeTimer();
	const out: unknown[] = [];
	return { t, out, c: createTurnFrameCoalescer((f) => out.push(f), t.set) };
};

function coalescerOnItsOwn(): void {
	check(COALESCE_WINDOW_MS === 40 && MAX_PENDING_CHARS === 8192, "the window and the cap are the documented constants");

	// The first words go out at once; the rest of the window merges into one delta.
	{
		const { t, out, c } = coalescer();
		const source = "Here is the plan. **Summary first**, then the steps.";
		const pieces = source.match(/.{1,4}/gs) ?? [];
		c.push(text(pieces[0]!));
		check(out.length === 1 && deltaOf(out[0]) === pieces[0], "the first delta is sent at once");
		for (const p of pieces.slice(1)) c.push(text(p));
		check(out.length === 1, `deltas inside the window wait, got ${out.length} frames`);
		t.fire();
		check(out.length === 2, `the window's end sends one merged delta, got ${out.length} frames`);
		check(JSON.stringify(Object.keys((out[1] as any).event.assistantMessageEvent).sort()) === JSON.stringify(["contentIndex", "delta", "type"]), "a merged delta looks like a single one");
		check(out.map(deltaOf).join("") === source, "joined text equals the input");
		check(t.pending() === 1, "a window that sent something stays open");
		t.fire();
		check(t.pending() === 0, "an empty window closes");
		c.push(text("Next."));
		check(out.length === 3 && deltaOf(out[2]) === "Next.", "a delta after the window closed goes out at once again");
	}

	// Order across kinds: an approval card, the message end, the turn end and an error never overtake text.
	{
		const { out, c } = coalescer();
		c.push(text("Let me "));
		c.push(text("run "));
		c.push(text("it."));
		c.push({ type: "ui_request", id: "ui_1", kind: "confirm" });
		c.push(text(" Done", 2));
		c.push(text(".", 2));
		c.push({ type: "event", event: { type: "message_end" } });
		c.push(text("Oh", 0));
		c.push(text(" no", 0));
		c.push({ type: "error", message: "The answer stopped." });
		c.push({ type: "event", event: { type: "agent_end" } });
		const kinds = out.map(kindOf);
		check(JSON.stringify(kinds) === JSON.stringify(["text_delta", "text_delta", "ui_request", "text_delta", "message_end", "text_delta", "error", "agent_end"]), `order holds and each run of text is one frame: ${kinds.join(",")}`);
		check(out.filter((f) => kindOf(f) === "text_delta").map(deltaOf).join("") === "Let me run it. Done.Oh no", "no text is lost across the other frames");
	}

	// flush, for frames that bypass the coalescer, sends what is pending first.
	{
		const { out, c } = coalescer();
		c.push(text("a"));
		c.push(text("b"));
		c.push(text("c"));
		check(out.length === 1, "the second and third delta wait");
		c.flush();
		check(out.length === 2 && deltaOf(out[1]) === "bc", "flush sends the pending delta, merged");
		c.flush();
		check(out.length === 2, "a second flush sends nothing");
	}

	// Blocks do not merge into each other.
	{
		const { t, out, c } = coalescer();
		c.push(text("x", 0));
		c.push(text("one", 1));
		c.push(text(" more", 1));
		c.push(text("two", 3));
		t.fire();
		check(JSON.stringify(out.map(deltaOf)) === JSON.stringify(["x", "one more", "two"]), `each block keeps its own delta: ${JSON.stringify(out.map(deltaOf))}`);
	}

	// Type-only frames collapse to one per window.
	{
		const { t, out, c } = coalescer();
		for (let i = 0; i < 200; i++) c.push(beat(i % 3 ? "toolcall_delta" : "thinking_delta"));
		t.fire();
		check(out.length === 2, `200 type-only frames became ${out.length} frames, not 2`);
	}

	// Thinking deltas of one block merge as text deltas do: the first at once, the rest of the window as one delta; blocks and kinds stay apart.
	{
		const { t, out, c } = coalescer();
		const thought = (delta: string, contentIndex = 0) => ({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "thinking_delta", contentIndex, delta } } });
		c.push(thought("Checking "));
		check(out.length === 1 && deltaOf(out[0]) === "Checking ", `the first thinking words go out at once, got ${out.map(deltaOf).join("|")}`);
		c.push(thought("the "));
		c.push(thought("file"));
		check(out.length === 1, "thinking words inside the window wait");
		t.fire();
		check(out.length === 2 && deltaOf(out[1]) === "the file" && kindOf(out[1]) === "thinking_delta", `the window's end sends one merged thinking delta, got ${JSON.stringify(out[1])}`);
		check(JSON.stringify(Object.keys((out[1] as any).event.assistantMessageEvent).sort()) === JSON.stringify(["contentIndex", "delta", "type"]), "a merged thinking delta looks like a single one");
		c.push(thought(" again", 0));
		c.push(thought("other", 2));
		c.push(text("Answer", 3));
		t.fire();
		check(JSON.stringify(out.slice(2).map((f) => [kindOf(f), deltaOf(f)])) === JSON.stringify([["thinking_delta", " again"], ["thinking_delta", "other"], ["text_delta", "Answer"]]), `blocks and kinds keep their own deltas: ${JSON.stringify(out.slice(2).map(deltaOf))}`);
	}

	// Previews of one tool call merge to the newest; another call's preview and the call's end send what is pending first.
	{
		const { t, out, c } = coalescer();
		const preview = (command: string, contentIndex = 1) => ({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "toolcall_delta", contentIndex, id: `call-${contentIndex}`, name: "bash", preview: { command } } } });
		c.push(preview("g"));
		check(out.length === 1, "the first preview goes out at once");
		c.push(preview("gi"));
		c.push(preview("git"));
		c.push(preview("git st"));
		t.fire();
		check(out.length === 2 && (out[1] as any).event.assistantMessageEvent.preview.command === "git st", `the window's end sends only the newest preview, got ${JSON.stringify(out.slice(1))}`);
		c.push(preview("git status"));
		c.push(preview("ls", 2));
		c.push({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 2, id: "call-2", name: "bash", preview: { command: "ls -la" } } } });
		const commands = out.slice(2).map((f: any) => f.event.assistantMessageEvent.preview.command);
		check(JSON.stringify(commands) === JSON.stringify(["git status", "ls", "ls -la"]), `each call keeps its own newest preview and the end goes after them: ${JSON.stringify(commands)}`);
	}

	// Only frames that are still type-only collapse: a thinking start or end with its time, or a preview, never stands in for another.
	{
		const { t, out, c } = coalescer();
		c.push(beat("toolcall_delta"));
		c.push({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "thinking_start", contentIndex: 4, at: 1_000 } } });
		c.push(beat("thinking_delta"));
		c.push({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "thinking_end", contentIndex: 4, at: 2_000 } } });
		t.fire();
		const stamped = out.filter((f: any) => typeof f.event.assistantMessageEvent.at === "number").map((f: any) => f.event.assistantMessageEvent.at);
		check(JSON.stringify(stamped) === JSON.stringify([1_000, 2_000]), `a thinking start and end keep their times, got ${JSON.stringify(out)}`);
	}

	// With thinking words off, the projection and the coalescer together still bring the page each thought's start and end, with their times and no words.
	{
		const { t, out, c } = coalescer();
		let clock = 1_000;
		const project = createWebClientEventProjector(() => clock, false);
		const partial = { content: [{ type: "toolCall", id: "call-1", name: "bash", arguments: {} }, { type: "thinking", thinking: "" }] };
		const update = (assistantMessageEvent: Record<string, unknown>) => c.push({ type: "event", event: project({ type: "message_update", assistantMessageEvent: { partial, ...assistantMessageEvent } }) });
		update({ type: "toolcall_delta", contentIndex: 0, delta: "{" });
		update({ type: "thinking_start", contentIndex: 1 });
		for (const words of ["Weighing ", "the bucket ", "size."]) update({ type: "thinking_delta", contentIndex: 1, delta: words });
		clock = 3_500;
		update({ type: "thinking_end", contentIndex: 1, content: "Weighing the bucket size." });
		t.fire();
		const thinking = out.filter((f: any) => /^thinking_/.test(kindOf(f))).map((f: any) => `${kindOf(f)}@${f.event.assistantMessageEvent.at ?? "-"}`);
		check(thinking.includes("thinking_start@1000") && thinking.includes("thinking_end@3500"), `with words off, a thought's start and end reach the page with their times, got ${JSON.stringify(thinking)}`);
		check(!JSON.stringify(out).includes("Weighing"), "with words off, no thinking word reaches the page");
	}

	// The first words go out at once also when the text's start opened the window.
	{
		const { out, c } = coalescer();
		c.push(beat("text_start"));
		c.push(text("Hello"));
		check(out.length === 2 && kindOf(out[0]) === "text_start" && deltaOf(out[1]) === "Hello", `a text start and the first words both go out at once, got ${out.map(kindOf).join(",")}`);
		c.push(text(" there"));
		check(out.length === 2, "the words after them wait for the window");
	}

	// One delta past the cap goes out at once, even as the first of a pending run.
	{
		const { out, c } = coalescer();
		c.push(text("start"));
		c.push(text("z".repeat(MAX_PENDING_CHARS + 1)));
		check(out.length === 2 && deltaOf(out[1])!.length === MAX_PENDING_CHARS + 1, `one delta past the cap is sent without waiting for the window, got ${out.length} frames`);
		c.push(text("tail"));
		check(out.length === 2, "the words after it wait for the window");
	}

	// Pending text past the cap goes out at once.
	{
		const { out, c } = coalescer();
		c.push(text("start"));
		const chunk = "y".repeat(1024);
		for (let i = 0; i < 7; i++) c.push(text(chunk));
		check(out.length === 1, "7 KB of pending text waits for the window");
		c.push(text(chunk));
		check(out.length === 2 && deltaOf(out[1])!.length === MAX_PENDING_CHARS, `8 KB of pending text is sent without waiting for the window, got ${out.length} frames`);
	}
}

// A turn's numbered frames; every session event is a turn frame, so an event without a number fails here, the turn's end included.
function turnFramesOf(frames: Frame[]): Frame[] {
	const unnumbered = frames.filter((frame) => frame.type === "event" && typeof frame.seq !== "number");
	check(unnumbered.length === 0, `every event frame carries seq, got ${unnumbered.length} without: ${unnumbered.map((frame) => frame.event?.type).join(",")}`);
	return frames.filter((frame) => typeof frame.seq === "number");
}
const seqsOf = (frames: Frame[]): number[] => frames.map((frame) => frame.seq as number);
const counts = (from: number, to: number): number[] => Array.from({ length: to - from + 1 }, (_, i) => from + i);

async function seqLiveAndReplayed(): Promise<void> {
	const room = await createRoom("Turn Frame Seq Room");
	const conv = `smokeconvseq_${Date.now().toString(36)}`;
	await putThread(room, conv, []);
	const first = await WsHarness.connect(room, conv);
	await first.waitFor((frame) => frame.type === "ready", "seq room ready");
	const requestsBefore = gatewayRequests.length;
	first.send({ type: "prompt", text: `Count the frames. ${SLOW_MARKER}` });
	await first.waitFor((frame) => deltaText(frame).length > 0, "seq room first delta");
	const request = gatewayRequests.slice(requestsBefore).find((row) => row.slow)!;
	request.release(3);
	await first.waitFor((frame) => first.frames.map(deltaText).join("").includes("slow part 4. "), "seq room first window sees four parts");
	first.close();
	await waitDetached(room, "seq room");
	// Written while nobody watches: these frames reach the next window only through the replay.
	request.release(3);

	const second = await WsHarness.connect(room, conv);
	const reattach = await second.waitFor((frame) => frame.type === "turn_reattach", "seq room reattach frame");
	check(second.frames[reattach].settled === false, "the reattach is live");
	const replayDone = await second.waitFor((frame) => frame.type === "turn_reattach_replay_done", "seq room replay done", reattach);
	request.release();
	const end = await second.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "seq room turn end", replayDone);

	const live = turnFramesOf(first.frames);
	check(live.length > 0 && JSON.stringify(seqsOf(live)) === JSON.stringify(counts(1, live.length)), `the first window's turn frames count 1, 2, 3… with no gap, got ${seqsOf(live).join(",")}`);
	const replay = second.frames.slice(reattach + 1, replayDone);
	check(replay.length >= live.length && replay.every((frame) => typeof frame.seq === "number"), `every replayed frame carries seq, got ${replay.map((frame) => frame.seq).join(",")}`);
	check(JSON.stringify(seqsOf(replay)) === JSON.stringify(counts(1, replay.length)), `the replay counts from 1 with no gap, got ${seqsOf(replay).join(",")}`);
	for (const frame of live) check(JSON.stringify(replay[frame.seq - 1]) === JSON.stringify(frame), `replayed frame ${frame.seq} is the frame the first window got: ${JSON.stringify(replay[frame.seq - 1])} vs ${JSON.stringify(frame)}`);
	const after = turnFramesOf(second.frames.slice(replayDone + 1, end + 1));
	check(JSON.stringify(seqsOf(after)) === JSON.stringify(counts(replay.length + 1, replay.length + after.length)), `live frames after the replay go on from ${replay.length + 1}, got ${seqsOf(after).join(",")}`);
	const answer = [...replay, ...after].map(deltaText).join("").trim();
	check(answer === expectedText, `replay and live text make the answer once, in order, got ${JSON.stringify(answer)}`);

	second.close();
}

// A window that a newer one displaces gets every word written before it is told so.
async function displacedWindowGetsPendingWords(): Promise<void> {
	const room = await createRoom("Turn Frame Displaced Room");
	const conv = `smokeconvdisp_${Date.now().toString(36)}`;
	await putThread(room, conv, []);
	const first = await WsHarness.connect(room, conv);
	await first.waitFor((frame) => frame.type === "ready", "displaced room ready");
	const requestsBefore = gatewayRequests.length;
	first.send({ type: "prompt", text: `Hand me over twice. ${SLOW_MARKER}` });
	await first.waitFor((frame) => deltaText(frame).length > 0, "displaced room first delta");
	const request = gatewayRequests.slice(requestsBefore).find((row) => row.slow)!;
	first.close();
	await waitDetached(room, "displaced room");
	const adopter = await WsHarness.connect(room, conv);
	await adopter.waitFor((frame) => frame.type === "turn_reattach_replay_done", "displaced room adopter replay done");
	// Five parts at once: the first goes out, the rest wait for the window while a newer window takes over.
	request.release(5);
	const takeover = await WsHarness.connect(room, conv);
	const displaced = await adopter.waitFor((frame) => frame.type === "error" && frame.code === "room_displaced", "displaced room adopter is told");
	const seen = adopter.frames.slice(0, displaced).map(deltaText).join("");
	const written = SLOW_ANSWER_CHUNKS.slice(0, 6).join("");
	check(seen === written, `the displaced window got every word written before it was told, got ${JSON.stringify(seen)} of ${JSON.stringify(written)}`);
	request.release();
	await takeover.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", "displaced room takeover turn end");
	takeover.close();
	adopter.close();
}

async function seqCountsPerTurn(): Promise<void> {
	const room = await createRoom("Turn Frame Seq Two Turns Room");
	const conv = `smokeconvseq2_${Date.now().toString(36)}`;
	await putThread(room, conv, []);
	const ws = await WsHarness.connect(room, conv);
	await ws.waitFor((frame) => frame.type === "ready", "two-turn room ready");
	const turns: Frame[][] = [];
	for (const prompt of ["One answer.", "And once more."]) {
		const from = ws.frames.length;
		ws.send({ type: "prompt", text: prompt });
		const end = await ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "agent_end", `two-turn room end of "${prompt}"`, from);
		turns.push(turnFramesOf(ws.frames.slice(from, end + 1)));
		await waitUntil(async () => (await getStatus(room)).activeThread?.inFlight === false, `two-turn room settled after "${prompt}"`, 20_000);
	}
	for (const [index, frames] of turns.entries()) check(frames.length > 0 && JSON.stringify(seqsOf(frames)) === JSON.stringify(counts(1, frames.length)), `turn ${index + 1} counts from 1, got ${seqsOf(frames).join(",")}`);
	ws.close();
}

try {
	coalescerOnItsOwn();
	console.log("  ok  text and thinking deltas of one block merge, previews of one call merge to the newest, the first words go out at once, the size cap sends at once, nothing overtakes text written before it");
	await startDetachedServer();
	await seqLiveAndReplayed();
	await seqCountsPerTurn();
	console.log("  ok  turn frames carry seq from 1 per turn, the same in the live stream and in the reattach replay");
	await displacedWindowGetsPendingWords();
	console.log("  ok  a displaced window gets every word written before it is told");
	console.log("turn-frame-coalescer smoke: ok");
} catch (error) {
	reportDetachedFailure(error);
} finally {
	await stopDetachedServer();
}
