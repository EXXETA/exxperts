// A failed message goes back in the box, and Send waits while a retry runs,
// in the browser against one synthetic Anthropic endpoint on a Claude API key
// (the scenes that end while nobody is in the room are in
// room-failed-message-returns-away-smoke.ts; the setup both share is in
// room-failed-message-returns-setup.ts):
//
// - a message the model could not answer leaves the conversation: its bubble
//   goes, its text is back in the box, and the next request no longer
//   carries it;
// - it is back in the box after a reload; left there, it comes back on every
//   open with its one line, a model switch after the line included;
// - while the runtime retries, the box shows Stop, and Stop ends the retry;
// - Stop while it retries, a reload while it retries, and something typed in
//   the box meanwhile each end true: back in the box, or still above;
// - an answer cut off mid-way stays above with the message, one line, and
//   the box as the person left it, when the room is left and opened again,
//   any number of times; Try again has the model answer the message again,
//   which reaches it once, and its answer lands below the line; cut off
//   while nobody was there, the partial lands once and its turn ends failed:
//   Home never says a response is ready;
// - a message with a file stays above when it fails, and Try again asks
//   again with its file's note, never sending it twice;
// - cut off in a step while nobody was there, a message back in the box lands
//   no step and no question; one that stays above (a file note) still lands
//   its steps.
import { authedFetch } from "./smoke-server-process.js";
import { answerNow, assert, closeFailureRoom, MODEL_NAME, ON_KEY, openFailureRoom, requestUserTexts, SECOND, waitUntil } from "./room-failed-message-returns-setup.js";

const { page, composer, agentId, baseUrl, retryWaits, sendToPage, continueAnswer, holdAnswers, open, stepOut, errorTexts, causes, answerBelowNewestLine, bubbles, status, settled, send, ask, isReturned, retryNotes, returnedSaved } = await openFailureRoom();
try {
	// A message the model could not answer goes back in the box, and the next request no longer carries it.
	await send("An odd request, please.");
	await isReturned("An odd request, please.", "a failed message");
	await settled();
	await send("And now a fine question.");
	await page.getByText("Answer from claude-haiku-5-5.").first().waitFor({ timeout: 20000 });
	await settled();
	const fineRequest = requestUserTexts.at(-1) ?? [];
	assert(fineRequest.some((text) => text.includes("And now a fine question.")) && !fineRequest.some((text) => text.includes("odd request")), `the next request no longer carries the failed message, got ${JSON.stringify(fineRequest)}`);
	console.log("  ok  a failed message goes back in the box, and the next request no longer carries it");

	// After a reload it is still in the box.
	await send("An odd request again.");
	await isReturned("An odd request again.", "before the reload");
	await settled();
	await open();
	await isReturned("An odd request again.", "after the reload");
	console.log("  ok  after a reload the failed message is back in the box");

	// Left in the box, it comes back on every open with one line that says so: never one more per open.
	// Two messages failed so far (the first scene's and this one), each with its own line: the older one folded to its cause.
	const backInBox = async () => (await causes()).filter((text) => text === `${MODEL_NAME} could not answer this message.`).length;
	const savedBackInBox = async () => {
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
		const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
		return items.filter((item) => item?.kind === "system" && item?.text === returnedSaved).length;
	};
	assert((await backInBox()) === 2, `after the reload each failed message has one line, got ${await backInBox()}`);
	const otherRoom = await authedFetch(`${baseUrl}/api/persistent-agents`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ displayName: "Other Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(otherRoom.status === 201, `another room is made, got ${otherRoom.status}`);
	const enter = async (name: string) => {
		const readies = continueAnswer.readies;
		await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15000 });
		await waitUntil(() => continueAnswer.readies > readies, `${name}: the room's connection is ready`);
	};
	const home = async () => {
		await page.evaluate(() => { window.location.hash = "#/"; });
		await page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).waitFor({ timeout: 10000 });
	};
	await home();
	await enter("Failure Room");
	await isReturned("An odd request again.", "Home and back");
	assert((await backInBox()) === 2, `Home and back: each failed message has one line, got ${await backInBox()}`);
	await home();
	await enter("Other Room");
	await home();
	await enter("Failure Room");
	await isReturned("An odd request again.", "another room and back");
	assert((await backInBox()) === 2, `another room and back: one line each, got ${await backInBox()}`);
	await open();
	await isReturned("An odd request again.", "a second reload");
	assert((await backInBox()) === 2, `a second reload: one line each, got ${await backInBox()}`);
	await page.waitForTimeout(1500);
	assert((await savedBackInBox()) === 2, `the saved conversation keeps one such line each, got ${await savedBackInBox()}`);
	// The line's own advice, another model, puts its "Continued on" line after it: the next opens still add none.
	const switchTo = async (to: typeof ON_KEY, name: string) => {
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const switched = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}/switch-model`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(to) });
		assert(switched.ok, `the conversation moves to ${name}, got ${switched.status} ${await switched.text()}`);
		await page.getByText(`Continued on ${name}`).last().waitFor({ timeout: 15000 });
	};
	await switchTo(SECOND, "Claude Sonnet 5.5");
	await home();
	await enter("Failure Room");
	await isReturned("An odd request again.", "after a model switch, Home and back");
	assert((await backInBox()) === 2, `after a model switch, Home and back: one line each, got ${await backInBox()}`);
	await open();
	await isReturned("An odd request again.", "after a model switch, a reload");
	assert((await backInBox()) === 2, `after a model switch, a reload: one line each, got ${await backInBox()}`);
	await page.waitForTimeout(1500);
	assert((await savedBackInBox()) === 2, `after a model switch, the saved conversation keeps one such line each, got ${await savedBackInBox()}`);
	await switchTo(ON_KEY, "Claude Haiku 5.5");
	console.log("  ok  a message left in the box comes back on every open with one line, never one more per open, after a model switch too");

	// Cleared from the box, it does not come back on the next open.
	await composer.fill("");
	await page.waitForTimeout(500);
	await open();
	assert((await composer.inputValue()) === "" && (await bubbles("An odd request again.")) === 0, `a message cleared from the box stays gone after a reload, got ${JSON.stringify(await composer.inputValue())}`);
	console.log("  ok  a message cleared from the box is not handed back again on the next open");

	// While the runtime retries, the box shows Stop; Stop ends the retry, and the message goes back in the box.
	retryWaits(1000);
	await open();
	await send("Always busy, sorry.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
	assert((await page.locator(".stop-btn").count()) === 1 && (await page.locator('button.send-btn[aria-label="Send"]').count()) === 0, "while the runtime retries, the box shows Stop, not Send");
	// A refusal for a message sent in the moment before this window saw the retry: Stop stays while the retry runs.
	sendToPage(JSON.stringify({ type: "error", code: "turn_running", message: "persistent-agent activeThread is still running" }));
	// The message is back in the box, so the button is Send; with the box emptied, Stop is back while the retry runs.
	await waitUntil(async () => (await composer.inputValue()) !== "", "the refused message is back in the box");
	assert((await page.locator('button.send-btn[aria-label="Send"]').count()) === 1 && (await page.locator(".stop-btn").count()) === 0, "with the message back in the box, the button is Send");
	await composer.fill("");
	await waitUntil(async () => (await page.locator(".stop-btn").count()) === 1, "after the still-finishing line, Stop stays while the retry runs");
	const stopLines = async () => (await page.locator(".answer-stop-line, .system-line-text").allInnerTexts()).filter((text) => text.trim().startsWith("You stopped this answer.")).length;
	const stopsBefore = await stopLines();
	await page.locator(".stop-btn").click();
	await isReturned("Always busy, sorry.", "a message stopped while the runtime waited to try again");
	await settled();
	assert((await retryNotes()) === 0, "Stop ends the retry and its note");
	await waitUntil(async () => (await stopLines()) > stopsBefore, "Stop leaves its line", 5000);
	assert((await stopLines()) === stopsBefore + 1, `one Stop, one line, after a refusal already put the message back in the box, got ${(await stopLines()) - stopsBefore}`);
	await composer.fill("");
	await ask("A fine question after the stop.");
	assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("Always busy, sorry.")), `the next request no longer carries the stopped message, got ${JSON.stringify(requestUserTexts.at(-1))}`);
	console.log("  ok  while the runtime retries, the box shows Stop; Stop ends the retry and hands the message back");

	// A later Stop on a message the room keeps (it carries a file, so it is not handed back) still says it stopped.
	await page.locator(".composer-attach-input").setInputFiles({ name: "busy-notes.txt", mimeType: "text/plain", buffer: Buffer.from("Notes.\n") });
	await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
	const stopsBeforeFile = await stopLines();
	await send("Always busy, with a file.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).last().waitFor({ timeout: 15000 });
	await page.locator(".stop-btn").click();
	await settled();
	await waitUntil(async () => (await stopLines()) > stopsBeforeFile, `a later Stop says so too, got ${(await stopLines()) - stopsBeforeFile} new Stop line(s)`, 5000);
	assert((await stopLines()) === stopsBeforeFile + 1 && (await bubbles("Always busy, with a file.")) === 1, `a later Stop on a kept message: one Stop line, the message above, got ${(await stopLines()) - stopsBeforeFile} line(s), ${await bubbles("Always busy, with a file.")} bubble(s)`);
	await composer.fill("");
	console.log("  ok  a later Stop on a message the room keeps says it stopped, after an earlier Stop handed one back");

	// Something typed in the box while it retries: the failed message stays where it was, and the model still sees it.
	await send("Always busy, while I type.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
	await composer.fill("A new question I typed.");
	await settled();
	// The page saves the turn's last line after the server settles it; the next message waits for that save.
	const newestSavedLine = async () => {
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
		const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
		return items.filter((item) => item?.kind === "system").at(-1)?.text;
	};
	await waitUntil(async () => (await newestSavedLine())?.startsWith(`${MODEL_NAME} is still busy after several tries.`) ?? false, "the page saved the line for a message that failed while something was typed", 10000).catch(() => {});
	assert((await bubbles("Always busy, while I type.")) === 1 && (await composer.inputValue()) === "A new question I typed.", `the failed message stays and the box keeps what was typed, got ${await bubbles("Always busy, while I type.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
	await ask("A new question I typed.");
	assert((requestUserTexts.at(-1) ?? []).some((text) => text.includes("Always busy, while I type.")), `the model still sees the message the room still shows, got ${JSON.stringify(requestUserTexts.at(-1))}`);
	console.log("  ok  something typed while it retries: the failed message stays above, and the model still sees it");

	// A reload while it retries: one retry note at most, and none once the turn ends.
	await send("Always busy, then a reload.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
	await open();
	let mostNotes = 0;
	while ((await status())?.activeThread?.inFlight) {
		mostNotes = Math.max(mostNotes, await retryNotes());
		await page.waitForTimeout(200);
	}
	// The turn's end shows once the message is back in the box and its bubble has gone.
	await waitUntil(async () => (await composer.inputValue()) === "Always busy, then a reload." && (await bubbles("Always busy, then a reload.")) === 0, "a failure after a reload: the message is back in the box", 15000).catch(() => {});
	await isReturned("Always busy, then a reload.", "a failure after a reload");
	assert(mostNotes <= 1 && (await retryNotes()) === 0, `one retry note at most, none after, got ${mostNotes} then ${await retryNotes()}`);
	await composer.fill("");
	retryWaits(50);
	await open();
	console.log("  ok  a reload while it retries shows one retry note at most, and none once the turn ends");

	// A message with a file that stays above when it fails: Try again has the model answer it again, its file's note included, and never sends it twice.
	await composer.fill("");
	await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Monday: export finished.\nTuesday: import checked.\n") });
	await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
	await send("An odd request about the notes, please.");
	await settled();
	await waitUntil(async () => (await errorTexts()).at(-1)?.startsWith(`${MODEL_NAME} could not answer this message.`) ?? false, `a message with a file fails with its own line, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
	assert((await bubbles("An odd request about the notes, please.")) === 1 && (await composer.inputValue()) === "", "the message with its file stays above, and the box is empty");
	const fileRequestsBefore = requestUserTexts.length;
	await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
	await waitUntil(() => requestUserTexts.slice(fileRequestsBefore).some((texts) => texts.at(-1)?.includes("An odd request about the notes, please.") ?? false), "Try again asks the model again", 15000);
	await settled();
	const askedAgain = requestUserTexts.slice(fileRequestsBefore).find((texts) => texts.at(-1)?.includes("An odd request about the notes, please.")) ?? [];
	assert(askedAgain.filter((text) => text.includes("An odd request about the notes, please.")).length === 1 && (askedAgain.at(-1) ?? "").includes("[FILE ATTACHED: notes.txt"), `Try again asks with the message once, its file's note included, got ${JSON.stringify(askedAgain)}`);
	assert((await bubbles("An odd request about the notes, please.")) === 1, `the message is not shown twice, got ${await bubbles("An odd request about the notes, please.")} bubble(s)`);
	await composer.fill("");
	console.log("  ok  a message with a file that stays above: Try again asks again with its file's note, and never sends it twice");

	// An answer cut off mid-way: the question and its partial answer stay above, with one line, and the box is left as it was.
	await send("Cut off midway, please.");
	await settled();
	await waitUntil(async () => (await errorTexts()).at(-1)?.startsWith(`${MODEL_NAME} stopped in the middle of its answer.`) ?? false, `the cut-off answer gets its line, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
	assert((await page.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts()).join("|") === "Try again", `the cut-off line offers Try again, got ${JSON.stringify(await page.locator(".failure-line:not(.is-folded) .failure-actions .rs-btn").allInnerTexts())}`);
	const cutLines = async () => (await errorTexts()).filter((text) => text.startsWith(`${MODEL_NAME} stopped in the middle of its answer.`)).length;
	const partials = () => page.getByText("A partial answer that stops").count();
	const keptAbove = async (label: string) => {
		const seen = { bubbles: await bubbles("Cut off midway, please."), partials: await partials(), lines: await cutLines(), box: await composer.inputValue() };
		assert(seen.bubbles === 1 && seen.partials === 1 && seen.lines === 1 && seen.box === "", `${label}: the message and its partial answer stay above with one line, and the box is left as it was, got ${JSON.stringify(seen)}`);
	};
	await keptAbove("an answer cut off mid-way");
	// Left and opened again, any number of times, the room shows the same.
	for (const visit of [1, 2]) {
		await open();
		await keptAbove(`the cut-off message, opened again (${visit})`);
	}
	console.log("  ok  an answer cut off mid-way: the question and its partial answer stay above with one line, the box is left as it was, and leaving and opening the room again keeps it so");

	// Try again: the model answers the same message again, which reaches it once, and the answer lands below the line; the box keeps its draft.
	await composer.fill("A draft written meanwhile.");
	answerNow.add("Cut off midway, please.");
	const cutRequestsBefore = requestUserTexts.length;
	const answersBeforeCut = await page.getByText("Answer from claude-haiku-5-5.").count();
	await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
	await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeCut, "the answer after Try again lands");
	await settled();
	const cutAsked = requestUserTexts.slice(cutRequestsBefore);
	assert(cutAsked.length === 1 && cutAsked[0]!.filter((text) => text.includes("Cut off midway, please.")).length === 1, `Try again asks once, with the message once, got ${JSON.stringify(cutAsked)}`);
	assert(await answerBelowNewestLine(), "the new answer lands below the line");
	assert((await bubbles("Cut off midway, please.")) === 1 && (await composer.inputValue()) === "A draft written meanwhile.", `the message is not shown twice and the box keeps its draft, got ${await bubbles("Cut off midway, please.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
	await composer.fill("");
	console.log("  ok  Try again under a cut-off answer: the model gets the message once, its answer lands below the line, and the box keeps its draft");

	const savedItems = async () => {
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
		return (thread?.thread?.items ?? thread?.items ?? []) as any[];
	};
	// Cut off while nobody is in the room: the message and its partial answer stay above on every open, the partial landed once,
	// and its turn ends failed: Home never says a response is ready.
	const linesBeforeAway = (await errorTexts()).length;
	holdAnswers();
	// Home's look at the room once this turn has ended is what would show the badge. Home stops asking
	// soon after, so its reads are watched from the send on, and only a read that names this turn as
	// landed counts (an earlier turn's late answer says nothing about it).
	let homeSawTurnEnd = false;
	let heldTurn = "";
	const homeReads = async (response: { url(): string; request(): { method(): string }; json(): Promise<unknown> }) => {
		if (new URL(response.url()).pathname !== "/api/persistent-agents" || response.request().method() !== "GET") return;
		const rooms = await response.json().catch(() => []) as Array<{ id?: string; activeThread?: { inFlight?: boolean }; unseenLandedAnswer?: { turnId?: string } }>;
		if (rooms.some((room) => room.id === agentId && room.activeThread?.inFlight === false && !!heldTurn && room.unseenLandedAnswer?.turnId === heldTurn)) homeSawTurnEnd = true;
	};
	await send("Cut off midway, while I step out.");
	page.on("response", homeReads);
	heldTurn = String((await status())?.activeThread?.activeTurn?.turnId ?? "");
	assert(heldTurn, "the held turn has an id while it runs");
	await stepOut();
	await settled();
	const readyBadge = page.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).locator(".persistent-agent-badge.ready");
	await waitUntil(() => homeSawTurnEnd, "Home's look at the room after the turn ended", 15000);
	page.off("response", homeReads);
	await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
	assert((await readyBadge.count()) === 0, "Home says a response is ready for an answer cut off while nobody was in the room");
	const outcome = await status();
	assert(outcome?.activeThread?.activeTurn?.lastTerminalReason === "failed" && outcome?.unseenLandedAnswer?.terminalReason === "failed", `the turn of an answer cut off ends failed, got ${JSON.stringify({ last: outcome?.activeThread?.activeTurn?.lastTerminalReason, unseen: outcome?.unseenLandedAnswer?.terminalReason })}`);
	for (const visit of [1, 2]) {
		await open();
		await page.waitForTimeout(500);
		const seen = { bubbles: await bubbles("Cut off midway, while I step out."), box: await composer.inputValue(), partials: await partials(), lines: (await errorTexts()).length - linesBeforeAway };
		assert(seen.bubbles === 1 && seen.box === "" && seen.partials === 2 && seen.lines === 1, `cut off while nobody was in the room, open ${visit}: the message and its partial answer stay above with one line, and the box is left as it was, got ${JSON.stringify(seen)}`);
	}
	const landedAnswers = (await savedItems()).filter((item) => item?.kind === "assistant" && String(item?.text ?? "").includes("A partial answer that stops")).map((item) => String(item.text));
	assert(landedAnswers.at(-1) === "A partial answer that stops", `the landed partial is said once, not once per attempt, got ${JSON.stringify(landedAnswers.at(-1))}`);
	console.log("  ok  an answer cut off while nobody was in the room: on every open the message and its partial answer stay above, landed once, with one line");

	// Cut off while it streams a step's call, with nobody in the room: the message handed back lands no step and no question.
	// A step the server landed: under the turn's own id with its mark when the page sent one, or a detached- id when it did not.
	const landedSteps = async () => (await savedItems()).filter((item) => item?.kind === "tool" && (item?.landed === true || String(item?.id ?? "").startsWith("detached-step-")));
	const stepsBefore = (await landedSteps()).length;
	const linesBeforeStep = (await errorTexts()).length;
	holdAnswers();
	await send("Cut off in a step, while I step out.");
	await stepOut();
	await settled();
	await open();
	await isReturned("Cut off in a step, while I step out.", "cut off in a step while nobody was in the room");
	const stepsAfter = await landedSteps();
	assert(stepsAfter.length === stepsBefore, `a message handed back lands no step, got ${JSON.stringify(stepsAfter.slice(stepsBefore).map((item) => ({ name: item.name, status: item.status })))}`);
	assert(!(await savedItems()).some((item) => item?.kind === "user" && String(item?.text ?? "").includes("Cut off in a step, while I step out.")), "a message handed back lands no question in the transcript");
	assert((await errorTexts()).length === linesBeforeStep + 1 && !/back in the box/.test((await errorTexts()).at(-1) ?? ""), `cut off in a step: one line, and it does not say the message is back in the box, got ${JSON.stringify((await errorTexts()).slice(linesBeforeStep))}`);
	await composer.fill("");
	console.log("  ok  an attempt cut off in a step while nobody was in the room: no stopped step, no question, the message in the box, one line");

	// The same with a file, whose message stays above: its turn still lands its steps.
	await page.locator(".composer-attach-input").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("Monday: export finished.\n") });
	await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
	holdAnswers();
	await send("Cut off in a step about the notes, while I step out.");
	await stepOut();
	await settled();
	await open();
	await page.waitForTimeout(800);
	assert((await bubbles("Cut off in a step about the notes, while I step out.")) === 1 && (await composer.inputValue()) === "", `a message with a file cut off in a step stays above, got ${await bubbles("Cut off in a step about the notes, while I step out.")} bubble(s), box ${JSON.stringify(await composer.inputValue())}`);
	const keptSteps = (await landedSteps()).slice(stepsAfter.length);
	assert(keptSteps.length > 0 && keptSteps.every((item) => item.status === "stopped"), `a turn not handed back still lands its steps, got ${JSON.stringify(keptSteps.map((item) => ({ name: item.name, status: item.status })))}`);
	console.log("  ok  the same with a message that stays above: its turn still lands its steps");

	// Stop in the middle of an answer says so.
	const partialsBeforeSlow = await partials();
	await send("A slow answer, please.");
	await waitUntil(async () => (await partials()) > partialsBeforeSlow, "the slow answer has begun", 15000);
	await page.locator(".stop-btn").click();
	await settled();
	await page.locator(".answer-stop-line").filter({ hasText: "You stopped this answer." }).last().waitFor({ timeout: 5000 });
	assert((await bubbles("A slow answer, please.")) === 1, "a message answered in part stays where it was");
	console.log("  ok  Stop in the middle of an answer says the answer was interrupted");
	console.log("room-failed-message-returns smoke: ok");
} catch (error) {
	await closeFailureRoom(error);
	throw error;
}
await closeFailureRoom();
