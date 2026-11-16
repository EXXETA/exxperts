import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { SMOKE_AUTH_TOKEN, putRunWithoutAsking } from "./smoke-server-process.js";
import { AFTER_TOOL_TEXT, assert, baseUrl, createRoom, DRIP_EVERY_MS, DRIP_MARKER, endFailingCase, FAILING_MARKER, FAST_ANSWER_CHUNKS, type Frame, type GatewayRequest, gatewayRequests, getStatus, getThread, putThread, QUIET_MARKER, reportDetachedFailure, requestJson, SILENT_TOOL_MARKER, SILENT_TOOL_SECONDS, SLOW_ANSWER_CHUNKS, SLOW_MARKER, startDetachedServer, stopDetachedServer, tempHome, waitDetached, waitUntil, WsHarness } from "./persistent-room-detached-turn-setup.js";

// The limits of a turn that runs while nobody is in the room
// (room-live-sessions.ts), on the detached-turn rig with both windows
// shortened. Against a real server and a synthetic gateway, proves:
//   1. a turn that sends nothing for the silence window after the leave is
//      stopped, and its line says it made no progress; here with no step and
//      no answer, so it lands on the turn's failure line without the sentence
//      about finished steps, as the 60-minute line does then;
//   1b. a stop in the runtime's wait to ask the model again keeps the
//      message above with the stop's line, now and when the room opens again;
//   1c. a message queued for that answer (no window to take it back) is held
//      by the stop, listed when the room opens again, and sent by nobody;
//   2. a turn that keeps sending events well past the silence window is not;
//   3. a shell command that runs silently longer than the window does not
//      stop the turn, and the window starts again once it ends;
//   4. a turn that keeps making progress is stopped once it has worked on its
//      own for the total window since the leave, with its own line;
//   5. a watched turn has neither limit;
//   6. stepping back in clears both clocks, and leaving again starts them fresh;
//   7. in the page, each stop's line reads word for word as approved, with a
//      Try again that sends the message again, the turn's finished steps still
//      in what the model is sent, on a page that read the line from the
//      saved thread; one whose message cannot go again whole (a file gone)
//      goes back into the box, and Try again then sends what the box holds.
//   9. a Try again pressed before the room's connection has opened is not
//      lost: the message goes once it has, and the screen stays as it was;
//  10-15. that press waits only for that connection: it ends with the visit,
//      with the line, and with a connection that fails; it waits for a message
//      the room hands back; it leaves words typed since in the box; and with
//      no connection under way there is nothing to wait for, so Try again is grey;
//  16-18. Try again is grey, as Send is, whenever nothing could take the press:
//      after the connection it waited on failed, between reconnect tries, after
//      they gave up and during a running answer, and it is live again with no
//      reload once the room can take it;
//  19. grey Try again changes no other button on the line, on any failure kind.

const SILENCE_MS = 2500;
const LIMIT_MS = 15_000;
// A timer fires late, never early, but the gateway and the server stamp times on two clocks a little apart.
const CLOCK_SLACK_MS = 300;
const NO_PROGRESS_LINE = "Stopped while you were away: it made no progress for 10 minutes. The steps it finished are above.";
const TIME_LIMIT_LINE = "Stopped while you were away: it reached the 60-minute limit for working on its own. The steps it finished are above.";
// With nothing finished above (no step and no answer of the turn), each line keeps only its first sentence.
const NO_PROGRESS_NOTHING_LINE = "Stopped while you were away: it made no progress for 10 minutes.";
const TIME_LIMIT_NOTHING_LINE = "Stopped while you were away: it reached the 60-minute limit for working on its own.";
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const isFirstDelta = (frame: Frame) => frame.type === "event" && frame.event?.type === "message_update";
const awayLines = (items: any[]) => items.filter((item) => item.kind === "system" && String(item.failure ?? "").startsWith("away-"));

/** A room with an empty conversation, and a window open on it. */
async function openRoom(name: string, setup?: (roomId: string) => Promise<void>): Promise<{ roomId: string; conversationId: string; ws: WsHarness }> {
	const roomId = await createRoom(name);
	await setup?.(roomId);
	const conversationId = `awayconv_${Math.random().toString(36).slice(2, 10)}`;
	assert((await putThread(roomId, conversationId, [])).status === 200, `${name}: the conversation is saved`);
	const ws = await WsHarness.connect(roomId, conversationId);
	await ws.waitFor((frame) => frame.type === "ready", `${name}: ready frame`);
	return { roomId, conversationId, ws };
}

/** Waits until the room's turn has ended, and the lock is free unless a window is in the room, and answers the turn's end and the saved conversation. */
async function settled(roomId: string, conversationId: string, label: string, options: { timeoutMs?: number; windowIn?: boolean } = {}): Promise<{ reason: string; items: any[] }> {
	await waitUntil(async () => {
		const status = await getStatus(roomId);
		return status.activeThread?.inFlight === false && (options.windowIn === true || !status.activeLock);
	}, `${label}: the turn settled${options.windowIn ? "" : " and the lock is free"}`, options.timeoutMs ?? 30_000);
	const status = await getStatus(roomId);
	return { reason: String(status.activeThread?.activeTurn?.lastTerminalReason ?? ""), items: (await getThread(roomId, conversationId)).items ?? [] };
}

const played = (tag: string, afterTool = false): GatewayRequest | undefined => gatewayRequests.find((row) => row.played === tag && row.afterTool === afterTool);
const slowRequestAfter = (from: number): GatewayRequest | undefined => gatewayRequests.slice(from).find((row) => row.slow);

try {
	await startDetachedServer({ silenceMs: SILENCE_MS, limitMs: LIMIT_MS });
	const workspaceRoot = path.join(tempHome, "away-workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
	const json = { "content-type": "application/json" };
	// Commands on, and run without asking: nobody is there to approve one.
	const withCommands = async (roomId: string) => {
		const workspace = await requestJson(`/api/persistent-agents/${roomId}/workspace-default`, { method: "PUT", headers: json, body: JSON.stringify({ root: workspaceRoot, displayLabel: "Away Workspace", workspaceAccessMode: "localFiles", bashEnabled: true }) });
		assert(workspace.status === 200, `the workspace with commands is set, got ${workspace.status}`);
		const bash = await putRunWithoutAsking(`${baseUrl}/api/persistent-agents/${roomId}/bash-settings`, true);
		assert(bash.status === 200, `commands run without asking, got ${bash.status}`);
	};

	// --- 1. No progress: the stream starts and says nothing more.
	let quietRoom: { roomId: string; conversationId: string; prompt: string; tag: string };
	{
		const quiet = await openRoom("Away Quiet Room");
		const tag = `${QUIET_MARKER}:quiet`;
		quiet.ws.send({ type: "prompt", id: "awayquiet1", text: `Say nothing for a while. ${tag}` });
		await waitUntil(() => !!played(tag), "the quiet call reached the gateway", 20_000);
		quiet.ws.close();
		await waitDetached(quiet.roomId, "quiet");
		const { reason, items } = await settled(quiet.roomId, quiet.conversationId, "quiet");
		const request = played(tag)!;
		assert(request.aborted && request.abortedAt! - request.startedAt >= SILENCE_MS - CLOCK_SLACK_MS && request.abortedAt! - request.startedAt < LIMIT_MS, `the quiet call is stopped once the silence window passed, after ${request.abortedAt! - request.startedAt} ms`);
		assert(reason === "failed", `a stopped turn ends failed, got ${reason}`);
		const lines = awayLines(items);
		assert(lines.length === 1 && lines[0].id === "awayquiet1-failure" && lines[0].text === NO_PROGRESS_NOTHING_LINE && lines[0].failure === "away-no-progress" && lines[0].level === "error", `one no-progress line on the turn's failure line, with no word of finished steps, got ${JSON.stringify(items)}`);
		const { awayLimitLine } = await import("../src/thread-items-by-id.js");
		const nothing = awayLimitLine("k-failure", "time-limit", false);
		assert(nothing.text === TIME_LIMIT_NOTHING_LINE && nothing.failure === "away-time-limit" && awayLimitLine("k-partial", "time-limit", true).text === TIME_LIMIT_LINE, `the 60-minute line keeps its first sentence alone with nothing finished, got ${JSON.stringify(nothing)}`);
		quietRoom = { roomId: quiet.roomId, conversationId: quiet.conversationId, prompt: `Say nothing for a while. ${tag}`, tag };
		assert(!items.some((item) => item.kind === "system" && /could not be (fully )?finished/.test(String(item.text))), `no other away line beside it, got ${JSON.stringify(items)}`);
		console.log("ok 1 a turn with no progress for the silence window after the leave is stopped with its line");
	}

	// --- 1b. A stop while the runtime waits to ask again: the model is busy on every call, and the waits run past the silence window.
	let retryRoom: { roomId: string; conversationId: string; prompt: string; tag: string };
	{
		const retry = await openRoom("Away Retry Room");
		const tag = `${FAILING_MARKER}:retry`;
		const prompt = `Ask a busy model. ${tag}`;
		retry.ws.send({ type: "prompt", id: "awayretry1b", text: prompt });
		await retry.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "auto_retry_start", "retry: the runtime waits to ask again");
		retry.ws.close();
		const { reason, items } = await settled(retry.roomId, retry.conversationId, "retry");
		endFailingCase(tag);
		assert(reason === "failed", `the stopped turn ends failed, got ${reason}`);
		const lines = awayLines(items);
		assert(items.some((item) => item.kind === "user" && item.id === "awayretry1b" && item.text === prompt), `the message stays above, got ${JSON.stringify(items)}`);
		assert(lines.length === 1 && lines[0].id === "awayretry1b-failure" && lines[0].text === NO_PROGRESS_NOTHING_LINE && lines[0].failure === "away-no-progress", `the stop in the wait leaves its own line, got ${JSON.stringify(items)}`);
		const reopened = await WsHarness.connect(retry.roomId, retry.conversationId);
		const ready = reopened.frames[await reopened.waitFor((frame) => frame.type === "ready", "retry: the room opens again")];
		assert(ready && ready.returnedPrompt === undefined, `opening the room again hands nothing back, got ${JSON.stringify(ready?.returnedPrompt)}`);
		reopened.close();
		await settled(retry.roomId, retry.conversationId, "retry, closed again");
		retryRoom = { roomId: retry.roomId, conversationId: retry.conversationId, prompt, tag };
		console.log("ok 1b a stop in the wait to ask again keeps the message above with its line, also when the room opens again");
	}

	// --- 1c. A message queued for the answer, then the window closes: the stop holds it, and nothing sends it.
	{
		const queued = await openRoom("Away Queued Room");
		const tag = `${QUIET_MARKER}:queued`;
		queued.ws.send({ type: "prompt", id: "awayqueued1c", text: `Say nothing for a while. ${tag}` });
		await waitUntil(() => !!played(tag), "queued: the quiet call reached the gateway", 20_000);
		const message = { id: "awayqueued1c-next", text: "And after that, the import." };
		queued.ws.send({ type: "steer", ...message });
		const way = queued.ws.frames[await queued.ws.waitFor((frame) => (frame.type === "steer_waiting" || frame.type === "steer_refused") && frame.id === message.id, "queued: the message is routed")];
		assert(way.type === "steer_waiting", `the message waits for the answer, got ${JSON.stringify(way)}`);
		queued.ws.close();
		await waitDetached(queued.roomId, "queued");
		const { reason, items } = await settled(queued.roomId, queued.conversationId, "queued");
		const callsAfterStop = gatewayRequests.length;
		assert(reason === "failed" && awayLines(items).length === 1 && awayLines(items)[0].failure === "away-no-progress", `the turn is stopped by the silence window, got ${reason}, ${JSON.stringify(items)}`);
		assert(!items.some((item) => item.kind === "user" && item.text === message.text), `the queued message is not in the conversation, got ${JSON.stringify(items)}`);
		const reopened = await WsHarness.connect(queued.roomId, queued.conversationId);
		const ready = reopened.frames[await reopened.waitFor((frame) => frame.type === "ready", "queued: the room opens again")];
		assert(JSON.stringify(ready?.held) === JSON.stringify([message]), `the room lists the queued message as held, got ${JSON.stringify(ready?.held)}`);
		const status = await getStatus(queued.roomId);
		assert(status.activeThread?.inFlight !== true && gatewayRequests.length === callsAfterStop, `opening the room sends nothing by itself, got in flight ${status.activeThread?.inFlight}, ${gatewayRequests.length - callsAfterStop} new model calls`);
		reopened.close();
		await settled(queued.roomId, queued.conversationId, "queued, closed again");
		console.log("ok 1c a message queued for an answer an away limit stops is held, and nothing sends it");
	}

	// --- 2. Progress: a chunk every 600 ms, for more than three silence windows.
	{
		const steady = await openRoom("Away Steady Room");
		const from = gatewayRequests.length;
		steady.ws.send({ type: "prompt", id: "awaysteady2", text: `Write steadily. ${SLOW_MARKER}` });
		await steady.ws.waitFor(isFirstDelta, "steady: first delta");
		steady.ws.close();
		await waitDetached(steady.roomId, "steady");
		const leftAt = Date.now();
		const request = slowRequestAfter(from)!;
		for (let chunk = 1; chunk < SLOW_ANSWER_CHUNKS.length; chunk++) {
			await pause(600);
			request.release(1);
		}
		const { reason, items } = await settled(steady.roomId, steady.conversationId, "steady");
		assert(Date.now() - leftAt > 3 * SILENCE_MS, `the turn worked on its own for more than three silence windows, ${Date.now() - leftAt} ms`);
		assert(reason === "completed" && request.finished && !request.aborted, `a turn that keeps making progress runs to its end, got ${reason}, finished ${request.finished}, aborted ${request.aborted}`);
		assert(awayLines(items).length === 0 && items.some((item) => item.kind === "assistant" && String(item.text).includes(SLOW_ANSWER_CHUNKS.at(-1)!.trim())), `its whole answer lands with no stop line, got ${JSON.stringify(items.map((item) => `${item.kind}:${item.id}`))}`);
		console.log("ok 2 a turn that keeps sending events past the silence window is not stopped");
	}

	// --- 3. A silent command longer than the window, then a quiet model call.
	let toolRoom: { roomId: string; conversationId: string; prompt: string; tag: string };
	{
		const tool = await openRoom("Away Command Room", withCommands);
		const tag = `${SILENT_TOOL_MARKER}:tool`;
		const prompt = `Run the long check. ${tag}`;
		tool.ws.send({ type: "prompt", id: "awaytool3", text: prompt });
		await tool.ws.waitFor((frame) => frame.type === "event" && frame.event?.type === "tool_execution_start", "tool: the command starts");
		const commandStartedAt = Date.now();
		tool.ws.close();
		await waitUntil(() => !!played(tag, true), "the model call after the command reached the gateway", SILENT_TOOL_SECONDS * 1000 + 20_000);
		const after = played(tag, true)!;
		assert(after.startedAt - commandStartedAt >= SILENT_TOOL_SECONDS * 1000 - CLOCK_SLACK_MS && SILENT_TOOL_SECONDS * 1000 > 2 * SILENCE_MS, `the command ran silently for more than two silence windows and the turn went on, ${after.startedAt - commandStartedAt} ms`);
		const { reason, items } = await settled(tool.roomId, tool.conversationId, "tool");
		assert(reason === "failed" && after.aborted && after.abortedAt! - after.startedAt >= SILENCE_MS - CLOCK_SLACK_MS, `the window started again when the command ended: the quiet call after it is stopped a window later, after ${after.abortedAt! - after.startedAt} ms`);
		const step = items.find((item) => item.kind === "tool" && item.name === "bash");
		assert(step?.status === "done", `the finished command lands as a done step, got ${JSON.stringify(step)}`);
		const lines = awayLines(items);
		assert(lines.length === 1 && lines[0].id === "awaytool3-partial" && lines[0].text === NO_PROGRESS_LINE && lines[0].failure === "away-no-progress", `the no-progress line under the answer it started, got ${JSON.stringify(items)}`);
		assert(items.indexOf(step) < items.indexOf(lines[0]) && items.some((item) => item.kind === "assistant" && String(item.text).includes(AFTER_TOOL_TEXT.trim())), `the step and the started answer sit above the line, got ${JSON.stringify(items.map((item) => `${item.kind}:${item.id}`))}`);
		toolRoom = { roomId: tool.roomId, conversationId: tool.conversationId, prompt, tag };
		console.log("ok 3 a silent command longer than the window does not stop the turn; the window starts again after it");
	}

	// --- 4. The total: a stream that never stops making progress.
	let dripRoom: { roomId: string; conversationId: string; prompt: string; tag: string };
	{
		const drip = await openRoom("Away Drip Room");
		const tag = `${DRIP_MARKER}:drip`;
		const prompt = `Keep writing forever. ${tag}`;
		drip.ws.send({ type: "prompt", id: "awaydrip4", text: prompt });
		await drip.ws.waitFor(isFirstDelta, "drip: first delta");
		drip.ws.close();
		const leftAt = Date.now();
		const { reason, items } = await settled(drip.roomId, drip.conversationId, "drip", { timeoutMs: LIMIT_MS + 30_000 });
		const request = played(tag)!;
		assert(reason === "failed" && request.aborted && request.abortedAt! - leftAt >= LIMIT_MS - CLOCK_SLACK_MS, `the dripping turn is stopped once it worked on its own for the total window, after ${request.abortedAt! - leftAt} ms`);
		assert(request.sent > LIMIT_MS / DRIP_EVERY_MS / 2, `it made progress all along, ${request.sent} chunks`);
		const lines = awayLines(items);
		assert(lines.length === 1 && lines[0].id === "awaydrip4-partial" && lines[0].text === TIME_LIMIT_LINE && lines[0].failure === "away-time-limit", `the time-limit line under what it wrote, got ${JSON.stringify(items)}`);
		dripRoom = { roomId: drip.roomId, conversationId: drip.conversationId, prompt, tag };
		console.log("ok 4 a turn that keeps making progress is stopped once it worked on its own for the total window");
	}

	// --- 5 and 6, side by side: a watched turn, and one stepped back into, each held silent past both windows.
	{
		const watched = await openRoom("Away Watched Room");
		const watchedFrom = gatewayRequests.length;
		watched.ws.send({ type: "prompt", id: "awaywatched5", text: `Think quietly while I watch. ${SLOW_MARKER}` });
		await watched.ws.waitFor(isFirstDelta, "watched: first delta");
		const watchedRequest = slowRequestAfter(watchedFrom)!;

		const back = await openRoom("Away Back Room");
		const backFrom = gatewayRequests.length;
		back.ws.send({ type: "prompt", id: "awayback6", text: `Think quietly until I come back. ${SLOW_MARKER}` });
		await back.ws.waitFor(isFirstDelta, "back: first delta");
		const backRequest = slowRequestAfter(backFrom)!;
		back.ws.close();
		// While nobody is in, a chunk each half second keeps the silence clock from running out before the step back in.
		let released = 1;
		const keepGoing = setInterval(() => { if (released < SLOW_ANSWER_CHUNKS.length - 4) { backRequest.release(1); released++; } }, 500);
		await waitDetached(back.roomId, "back");
		const backIn = await WsHarness.connect(back.roomId, back.conversationId);
		await backIn.waitFor((frame) => frame.type === "turn_reattach", "back: the window steps back in");
		clearInterval(keepGoing);
		// Both quiet, past the silence window and the total.
		await pause(LIMIT_MS + 1000);
		assert(!watchedRequest.aborted && !backRequest.aborted, `neither turn is stopped while someone watches, watched aborted ${watchedRequest.aborted}, back aborted ${backRequest.aborted}`);
		// Leaving again starts both clocks fresh: a chunk each half second keeps it going for longer than a silence window, then it finishes.
		backIn.close();
		await waitDetached(back.roomId, "back, left again");
		for (let step = 0; step < 3 && released < SLOW_ANSWER_CHUNKS.length; step++) {
			await pause(1000);
			backRequest.release(1);
			released++;
		}
		assert(!backRequest.aborted, "leaving again past the total window does not stop the turn at once");
		watchedRequest.release();
		backRequest.release();
		const watchedEnd = await settled(watched.roomId, watched.conversationId, "watched", { windowIn: true });
		const backEnd = await settled(back.roomId, back.conversationId, "back");
		assert(watchedEnd.reason === "completed" && watchedRequest.finished, `the watched turn runs to its end, got ${watchedEnd.reason}`);
		assert(backEnd.reason === "completed" && backRequest.finished && awayLines(backEnd.items).length === 0, `the turn stepped back into runs to its end with no stop line, got ${backEnd.reason}, ${JSON.stringify(backEnd.items.map((item) => `${item.kind}:${item.id}`))}`);
		console.log("ok 5 a watched turn has neither limit");
		console.log("ok 6 stepping back in clears both clocks; leaving again starts them fresh");
	}

	// --- 7. The page: each stop's line from the saved thread, and Try again.
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("SKIPPED: the away limits page part (Chromium not installed)");
	} else {
		const browser = await chromium.launch();
		try {
			const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			const promptsSent: string[] = [];
			page.on("websocket", (socket) => socket.on("framesent", (frame) => {
				try {
					const data = JSON.parse(String(frame.payload));
					if (data?.type === "prompt") promptsSent.push(String(data.text));
				} catch {}
			}));
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			const newest = () => page.locator(".failure-line:not(.is-folded)");
			// A fresh load of Home, then the room from its card: the page knows the line only from the saved thread.
			const enter = async (name: string) => {
				await page.goto(`${baseUrl}/`);
				await page.waitForLoadState("networkidle");
				await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
				await page.locator('button[title="Send"]').first().waitFor({ timeout: 15_000 });
				await newest().waitFor({ timeout: 15_000 });
			};
			const shownLine = async () => ({
				cause: (await newest().locator(".failure-cause").innerText()).trim(),
				next: (await newest().locator(".failure-next").count()) ? (await newest().locator(".failure-next").innerText()).trim() : "",
				buttons: (await newest().locator(".failure-actions .rs-btn").allInnerTexts()).map((text) => text.trim()).join("|"),
			});
			for (const room of [{ name: "Away Command Room", ...toolRoom, line: NO_PROGRESS_LINE }, { name: "Away Drip Room", ...dripRoom, line: TIME_LIMIT_LINE }, { name: "Away Quiet Room", ...quietRoom, line: NO_PROGRESS_NOTHING_LINE }, { name: "Away Retry Room", ...retryRoom, line: NO_PROGRESS_NOTHING_LINE }]) {
				const steps = room.line.indexOf(" The steps");
				const [cause, next] = steps < 0 ? [room.line, ""] : [room.line.slice(0, steps), room.line.slice(steps + 1)];
				for (const visit of ["opened", "reloaded"]) {
					await enter(room.name);
					const shown = await shownLine();
					assert(shown.cause === cause && shown.next === next && shown.buttons === "Try again", `${room.name}, ${visit}: the line word for word with Try again, got ${JSON.stringify(shown)}`);
				}
				const sentBefore = promptsSent.length;
				const requestsBefore = gatewayRequests.length;
				await newest().getByRole("button", { name: "Try again" }).click();
				await waitUntil(() => promptsSent.slice(sentBefore).some((text) => text.trim() === room.prompt), `${room.name}: Try again sends the message again, got ${JSON.stringify(promptsSent.slice(sentBefore))}`, 15_000);
				await page.getByText(FAST_ANSWER_CHUNKS.join("")).first().waitFor({ timeout: 20_000 });
				const again = gatewayRequests.slice(requestsBefore).find((row) => !row.played);
				assert(again, `${room.name}: the message went to the model again`);
				if (room.tag.startsWith(SILENT_TOOL_MARKER)) {
					assert(again.roles.lastIndexOf("tool") >= 0 && again.roles.lastIndexOf("tool") < again.roles.lastIndexOf("user"), `the command the stopped turn finished is still in what the model is sent, got ${again.roles.join(",")}`);
				}
				await settled(room.roomId, room.conversationId, `${room.name} after Try again`, { windowIn: true });
			}
			console.log("ok 7 each stop's line reads as approved after a reload, one with nothing finished too, and Try again sends the message again with the finished steps kept");

			// A stop whose message carried a file no longer in the room's Attachments, as a keyed landing saves it.
			const filesRoom = await createRoom("Away Files Room");
			const filesConversation = "awayconv_files";
			const filesText = "Read the file I sent.";
			assert((await putThread(filesRoom, filesConversation, [{ kind: "user", id: "awayfiles8", text: filesText, attachments: [{ name: "gone.txt", bytes: 12, extension: "txt" }] }, { kind: "system", id: "awayfiles8-failure", text: NO_PROGRESS_NOTHING_LINE, level: "error", failure: "away-no-progress" }], "standby")).status === 200, "the stopped conversation with a gone file is saved");
			await enter("Away Files Room");
			const composer = page.locator("textarea").first();
			await newest().getByRole("button", { name: "Try again" }).click();
			await waitUntil(async () => (await composer.inputValue()) === filesText && (await shownLine()).next === "", "the message goes back into the box and the line adds nothing", 10_000);
			const sentBeforeBox = promptsSent.length;
			await newest().getByRole("button", { name: "Try again" }).click();
			await waitUntil(() => promptsSent.slice(sentBeforeBox).some((text) => text.trim() === filesText), "Try again then sends what the box holds", 10_000);
			await settled(filesRoom, filesConversation, "files room after Try again", { windowIn: true });
			console.log("ok 8 a stop whose message cannot go again whole gives it back to the box, and Try again sends the box");

			// A room whose socket stays CONNECTING until `open`: while a route's handler waits, the page's side does not open.
			// With `sockets`, each connection gets its own entry and the page talks to it instead of the server, the last entry
			// serving any more: frames, or "close" to fail. `asked` lists the turns the page asked for, and `say` sends a frame on
			// the newest connection. With `slowClose`, a socket the page closes tells it so only after its replacement exists, which a slow network can do.
			const heldRoom = async (name: string, items: any[], options: { sockets?: Array<object[] | "close">; slowClose?: boolean } = {}) => {
				const roomId = await createRoom(name);
				const conversationId = `awayconv_${Math.random().toString(36).slice(2, 10)}`;
				assert((await putThread(roomId, conversationId, items, "standby")).status === 200, `${name}: the stopped conversation is saved`);
				const fromPage: string[] = [];
				let open = () => {};
				const held = new Promise<void>((resolve) => { open = resolve; });
				let connections = 0;
				let say = (_frame: object) => {};
				await page.routeWebSocket(new RegExp(`persistentAgentId=${roomId}`), async (socket) => {
					const script = options.sockets?.[Math.min(connections, options.sockets.length - 1)];
					connections++;
					say = (frame) => socket.send(JSON.stringify(frame));
					let closedByPage = false;
					if (options.slowClose) socket.onClose(() => { closedByPage = true; });
					if (script) socket.onMessage((frame) => { fromPage.push(String(frame)); });
					await held;
					if (closedByPage) return;
					if (script === "close") return socket.close();
					if (!script) return void socket.connectToServer();
					for (const frame of script) socket.send(JSON.stringify(frame));
				});
				await enter(name);
				return { roomId, conversationId, open: () => open(), asked: () => fromPage.filter((frame) => /"type":"(prompt|continue)"/.test(frame)).map((frame) => JSON.parse(frame).text ?? "continue"), connections: () => connections, say: (frame: object) => say(frame) };
			};
			// The room's own ready, with a context reading the page then shows: the mark that it came.
			const ready = (fields: object = {}) => ({ type: "ready", contextHealth: { tokens: 42_000, contextWindow: 100_000, checkpointTokens: 100_000, checkpointPercent: 42, zone: "green", source: "runtime-context-usage" }, ...fields });
			const readyShown = () => page.locator(".composer-context-pill-label", { hasText: "42%" }).waitFor({ timeout: 15_000 });
			const tryAgain = () => newest().getByRole("button", { name: "Try again" });
			const pressTryAgain = () => tryAgain().click();
			// With words in the box, since an empty box greys Send whatever the room is doing.
			const sendIsGrey = async () => {
				await composer.fill("Words for Send.");
				return page.locator(".send-btn").first().isDisabled();
			};
			// The ready shown, then Send lit with words in the box: the room has caught up, a waiting press has had its turn, and no answer runs.
			const caughtUp = async (words: string) => {
				await readyShown();
				await composer.fill(words);
				await page.locator('.send-btn:enabled[title="Send"]').first().waitFor({ timeout: 15_000 });
			};
			const earlyText = "Send this once the room has opened.";
			const awayThread = [{ kind: "user", id: "awayearly9", text: earlyText }, { kind: "system", id: "awayearly9-failure", text: NO_PROGRESS_NOTHING_LINE, level: "error", failure: "away-no-progress" }];
			const busyLine = { kind: "system", id: "awaybusy9-failure", text: "Room Model is still busy after several tries. Try again in a minute.", level: "error", failure: "still-busy" };

			// A press before the room's connection has opened, which the line allows: the saved thread draws it first.
			{
				const early = await heldRoom("Away Early Room", awayThread);
				const lineBefore = await shownLine();
				const draft = "A draft this press leaves alone.";
				await composer.fill(draft);
				const requestsBefore = gatewayRequests.length;
				await pressTryAgain();
				await pressTryAgain();
				const lineHeld = await shownLine();
				assert(JSON.stringify(lineHeld) === JSON.stringify(lineBefore) && await page.locator(".send-btn").first().isDisabled(), `until the room opens the screen stays as it was, got ${JSON.stringify(lineHeld)}`);
				early.open();
				await page.getByText(FAST_ANSWER_CHUNKS.join("")).first().waitFor({ timeout: 20_000 });
				await settled(early.roomId, early.conversationId, "early room after Try again", { windowIn: true });
				const asked = gatewayRequests.slice(requestsBefore).filter((row) => !row.played);
				assert(asked.length === 1 && (await composer.inputValue()) === draft, `pressed twice before the room opened, the message goes once and the box stays, got ${asked.length} model calls, box ${JSON.stringify(await composer.inputValue())}`);
				console.log("ok 9 a Try again pressed before the room's connection opens sends the message once it has, with the screen as it was until then");
			}

			// The same press, and the person leaves before the room opens: it ends with the visit, and coming back sends nothing by itself.
			{
				const left = await heldRoom("Away Left Room", awayThread, { slowClose: true });
				const requestsBefore = gatewayRequests.length;
				const promptsBefore = promptsSent.length;
				await pressTryAgain();
				await page.getByRole("button", { name: "Home", exact: true }).click();
				const card = page.locator(".persistent-agent-card").filter({ hasText: "Away Left Room" });
				await card.waitFor({ timeout: 15_000 });
				left.open();
				await card.getByRole("button", { name: /^(Enter|Resume)$/ }).click();
				await newest().waitFor({ timeout: 15_000 });
				await composer.fill("Nothing went by itself.");
				await page.locator('.send-btn:enabled[title="Send"]').first().waitFor({ timeout: 15_000 });
				assert((await shownLine()).buttons === "Try again" && promptsSent.length === promptsBefore && (await getStatus(left.roomId)).activeThread?.inFlight !== true && gatewayRequests.length === requestsBefore, `the press did not outlive the visit, got ${JSON.stringify(promptsSent.slice(promptsBefore))}`);
				console.log("ok 10 a press still waiting ends when the person leaves the room");
			}

			// The same press, and the catch-up shows the room already answered it, as another window's Try again does before its save: it sends nothing a second time.
			{
				const turn = { turnId: "awayanswered11" };
				const answered = await heldRoom("Away Answered Room", awayThread, { sockets: [[ready({ reattaching: true }), { type: "turn_reattach", ...turn, settled: true, userText: earlyText, promptId: turn.turnId }, { type: "event", event: { type: "agent_start" } }, { type: "event", event: { type: "agent_end" } }, { type: "turn_reattach_replay_done", ...turn }]] });
				await pressTryAgain();
				answered.open();
				await newest().waitFor({ state: "detached", timeout: 15_000 });
				await caughtUp("Nothing went twice.");
				assert(answered.asked().length === 0, `the press ends with the line that offered it, got ${JSON.stringify(answered.asked())}`);
				console.log("ok 11 a press still waiting ends when the catch-up shows the line no longer offers it");
			}

			// The same press on a line whose message the room hands back in its ready: the box takes it a moment after, and it goes.
			{
				const returned = await heldRoom("Away Returned Room", [{ kind: "user", id: "awaybusy9", text: earlyText }, busyLine], { sockets: [[ready({ returnedPrompt: { id: "awaybusy9", text: earlyText } })]] });
				await pressTryAgain();
				returned.open();
				await waitUntil(() => returned.asked().length > 0, "the message handed back goes", 10_000);
				assert(returned.asked().length === 1 && String(returned.asked()[0]).trim() === earlyText, `the message handed back goes once, got ${JSON.stringify(returned.asked())}`);
				console.log("ok 12 a press waiting on a message the room hands back sends it once it is in the box");
			}

			// Under a line that sends the box: what the box held at the press goes, and words typed since are a draft that stays.
			{
				const pressed = "The box as it was pressed.";
				const kept = await heldRoom("Away Box Room", [busyLine], { sockets: [[ready()]] });
				await composer.fill(pressed);
				await pressTryAgain();
				kept.open();
				await waitUntil(() => kept.asked().length > 0, "the box goes", 10_000);
				assert(kept.asked().length === 1 && String(kept.asked()[0]).trim() === pressed, `the box as it was pressed goes, got ${JSON.stringify(kept.asked())}`);
				const edited = await heldRoom("Away Draft Room", [busyLine], { sockets: [[ready()]] });
				await composer.fill(pressed);
				await pressTryAgain();
				await composer.fill(`${pressed} And more.`);
				edited.open();
				await readyShown();
				await page.locator('.send-btn:enabled[title="Send"]').first().waitFor({ timeout: 15_000 });
				assert(edited.asked().length === 0 && (await composer.inputValue()) === `${pressed} And more.`, `a draft typed after the press stays in the box, got ${JSON.stringify(edited.asked())}`);
				console.log("ok 13 a press waiting on the box sends what it held, and leaves words typed since");
			}

			// The same press, and that connection fails: the wait ends with it, so the next one sends nothing by itself, however late.
			{
				const failed = await heldRoom("Away Failed Room", awayThread, { sockets: ["close", [ready()]] });
				await pressTryAgain();
				failed.open();
				await waitUntil(() => failed.connections() > 1, "the page connects again", 15_000);
				await caughtUp("Nothing went by itself.");
				assert(failed.asked().length === 0 && (await shownLine()).buttons === "Try again", `the press ended with its connection, got ${JSON.stringify(failed.asked())}`);
				console.log("ok 14 a press waiting on a connection that fails ends with it");
			}

			// A connection ended before its ready, with none coming by itself: nothing could take a press, so none is offered, and nothing waits for the one the person starts later.
			{
				const gone = await heldRoom("Away Gone Room", awayThread, { sockets: [[{ type: "error", code: "room_displaced", message: "This room is now open in another window." }], [ready()]] });
				gone.open();
				const openHere = page.getByRole("button", { name: "Open here" });
				await openHere.waitFor({ timeout: 15_000 });
				await waitUntil(() => tryAgain().isDisabled(), "with no connection under way Try again is grey", 10_000);
				await openHere.click();
				await caughtUp("Nothing went by itself.");
				assert(gone.asked().length === 0 && await tryAgain().isEnabled(), `the room back, nothing went and Try again is live, got ${JSON.stringify(gone.asked())}`);
				console.log("ok 15 with no connection under way Try again is grey, and nothing waits for a later one");
			}

			// A mark on this load of the page: a reload would lose it.
			const markThisLoad = () => page.evaluate(() => { (window as any).__sameLoad = true; });
			const sameLoad = () => page.evaluate(() => (window as any).__sameLoad === true);

			// A press waiting on a connection that fails, and the tries after it: grey from then on, as Send is, until the room is back; then live, and the press goes.
			{
				const tries = await heldRoom("Away Tries Room", awayThread, { sockets: ["close", "close", "close", [ready()]] });
				await markThisLoad();
				await pressTryAgain();
				tries.open();
				await waitUntil(() => tryAgain().isDisabled(), "Try again goes grey once the connection it waited on failed", 10_000);
				assert(tries.connections() < 4 && await sendIsGrey(), `grey between the tries, with Send grey too, after ${tries.connections()} connections`);
				await caughtUp("Back with no reload.");
				assert(await tryAgain().isEnabled() && await sameLoad(), "the room back, Try again is live again with no reload");
				await composer.fill("");
				await pressTryAgain();
				await waitUntil(() => tries.asked().length > 0, "the press goes once Try again is live again", 10_000);
				assert(tries.asked().length === 1 && String(tries.asked()[0]).trim() === earlyText, `the message goes once, got ${JSON.stringify(tries.asked())}`);
				console.log("ok 16 after the connection it waited on failed and between reconnect tries Try again is grey; the room back, it is live and goes, with no reload");
			}

			// The tries give up: the page's clock is moved past the time it keeps trying. Grey until the person's Reconnect brings the room back.
			{
				const stopped = await heldRoom("Away Stopped Room", awayThread, { sockets: ["close", "close", [ready()]] });
				await markThisLoad();
				stopped.open();
				await waitUntil(() => tryAgain().isDisabled(), "the first connection fails", 10_000);
				await page.evaluate(() => { const real = Date.now; Date.now = () => real() + 10 * 60_000; });
				await page.locator('textarea[placeholder="Not connected, press Reconnect"]').first().waitFor({ timeout: 15_000 });
				assert(await tryAgain().isDisabled() && await sendIsGrey(), "after the tries gave up Try again is grey, with Send");
				await page.getByRole("button", { name: "Reconnect" }).first().click();
				await caughtUp("Back after Reconnect.");
				assert(await tryAgain().isEnabled() && await sameLoad(), "after Reconnect Try again is live again with no reload");
				console.log("ok 17 after the tries gave up Try again is grey, and live again after Reconnect with no reload");
			}

			// A line whose message stayed above stays on screen while the room answers it again: grey for the answer, live again at its end.
			{
				const running = await heldRoom("Away Running Room", [{ kind: "user", id: "awayrun18", text: earlyText }, { ...busyLine, id: "awayrun18-failure", messageAbove: true }], { sockets: [[ready()]] });
				await markThisLoad();
				running.open();
				await readyShown();
				await waitUntil(() => tryAgain().isEnabled(), "the room caught up, Try again is live", 10_000);
				await pressTryAgain();
				await waitUntil(() => running.asked().length > 0, "the press asks the room to continue", 10_000);
				await waitUntil(() => tryAgain().isDisabled(), "during a running answer Try again is grey", 10_000);
				assert(JSON.stringify(running.asked()) === JSON.stringify(["continue"]), `one press, got ${JSON.stringify(running.asked())}`);
				running.say({ type: "event", event: { type: "agent_start" } });
				running.say({ type: "event", event: { type: "agent_end" } });
				await waitUntil(() => tryAgain().isEnabled(), "the answer over, Try again is live again", 10_000);
				assert(await sameLoad(), "live again with no reload");
				console.log("ok 18 during a running answer Try again is grey, and live again at its end with no reload");
			}

			// Grey Try again leaves the line's other buttons as they were, whatever the failure: the same ones, all live.
			{
				const kinds: Array<[string, object, string]> = [
					["other", { failure: "other" }, "Try again|Choose another model"],
					["gateway-refused", { failure: "gateway-refused", provider: "openai-compatible" }, "Choose another model|Replace key"],
					["gateway-not-found", { failure: "gateway-not-found", provider: "openai-compatible" }, "Open AI setup"],
					["overflow", { failure: "overflow" }, "Choose another model"],
				];
				for (const [kind, fields, buttons] of kinds) {
					const down = await heldRoom(`Away Down ${kind} Room`, [{ kind: "user", id: "awaydown19", text: earlyText }, { kind: "system", id: "awaydown19-failure", text: "Room Model could not answer this message.", level: "error", ...fields }], { sockets: ["close"] });
					down.open();
					await waitUntil(() => down.connections() > 1, `${kind}: the page tries again`, 15_000);
					await waitUntil(sendIsGrey, `${kind}: Send is grey`, 10_000);
					const live = (await newest().locator(".failure-actions .rs-btn:enabled").allInnerTexts()).map((text) => text.trim()).join("|");
					assert((await shownLine()).buttons === buttons && live === buttons.replace(/^Try again\|/, ""), `${kind}: the same buttons, all but Try again live, got ${(await shownLine()).buttons}, live ${live}`);
				}
				console.log("ok 19 grey Try again changes no other button on the line, on any failure kind");
			}
		} finally {
			await browser.close();
		}
	}
} catch (error) {
	reportDetachedFailure(error);
} finally {
	await stopDetachedServer();
}
