// The rest of the room-failed-message-returns smoke, on the same setup
// (room-failed-message-returns-setup.ts), in the browser against one synthetic
// Anthropic endpoint on a Claude API key:
//
// - a failed message is back in the box after a failure that ended while
//   nobody was in the room, with the live line;
// - Send never comes back between a failed attempt and its retry;
// - a message sent while another answer is still running goes back in the
//   box with a plain line, its files' chips with it, and the running answer
//   still ends well; the line passes: it goes once that turn is over, and is
//   never saved;
// - the connection lost while it retries, and the app stopping while it
//   retries, each end true: back in the box;
// - a refused key leaves only the key notice, with the failure lines' mark,
//   which on the way in also says why when the key was refused while nobody
//   was in the room; while it shows, the workspace hint waits, and it is back
//   once the notice goes; a message with a file note stays where it was;
// - a scheduled task that fails in the room's conversation, with Bash on or
//   off, keeps its failure where it is: nothing lands in the box at the next
//   open, since only a message the person typed is ever handed back.
// - a new message whose first attempt the runtime asks again leaves the last
//   turn's line where it is;
// - after a Try again refused before it began (the app stopping, or the
//   connection lost), the next message is one of its own: refused while an
//   answer runs, it is handed back with its line;
// - Try again for a message that cannot go whole again (its file gone from
//   the room's Attachments) sends nothing: its words go back in the box, focused,
//   and its line says so; with a draft in the box, or no words of its own,
//   the box stays as it is and the line says it can't be sent again as it was.
import fs from "node:fs";
import path from "node:path";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";
import { closeContext } from "./smoke-close-context.js";
import { assert, closeFailureRoom, MODEL_NAME, openFailureRoom, requestUserTexts, TURN_RUNNING_LINE, waitUntil } from "./room-failed-message-returns-setup.js";

const { page, ctx, composer, agentId, agentDir, agentsRoot, tempRoot, tempHome, repoRoot, port, baseUrl, retryWaits, startServer, killServer, stopServer, sendToPage, gap, continueAnswer, holdAnswers, open, stepOut, errorTexts, causes, bubbles, status, settled, send, ask, inBox, isReturned, retryNotes, stillBusyReturned } = await openFailureRoom();
try {
	// A failure that ends while nobody is in the room: the message is back in the box on the way in, with its own cause.
	retryWaits(1000);
	await open();
	await send("Always busy, while I step out.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
	await page.goto(`${baseUrl}/`);
	await settled();
	await open();
	await isReturned("Always busy, while I step out.", "a failure that ended while nobody was in the room");
	assert((await errorTexts()).at(-1) === stillBusyReturned && (await retryNotes()) === 0, `the line says what happened, in place of the retry note saved on the way out, got ${JSON.stringify(await page.locator(".system-line").allInnerTexts())}`);
	await composer.fill("");
	console.log("  ok  a failure that ended while nobody was in the room: the message is back in the box on the way in, with its cause");

	// The line said on the way in is the live line: the same cause, its Details, its way on.
	const lastErrorLine = async () => {
		const line = page.locator(".system-line.error").last();
		return { text: (await line.locator(".system-line-text").innerText()).replace(/\s+/g, " ").trim(), details: await line.locator(".failure-details-toggle").count() };
	};
	for (const cause of ["Not on account", "No longer offered"]) {
		await send(`${cause}, live.`);
		await isReturned(`${cause}, live.`, `${cause}, live`);
		await settled();
		const live = await lastErrorLine();
		await composer.fill("");
		await open();
		holdAnswers();
		await send(`${cause}, while I step out.`);
		await stepOut();
		await settled();
		await open();
		await isReturned(`${cause}, while I step out.`, `${cause}, while nobody was in the room`);
		const away = await lastErrorLine();
		assert(away.text === live.text, `${cause}: the line on the way in is the live line, got ${JSON.stringify(away.text)} for ${JSON.stringify(live.text)}`);
		assert(live.details === 1 && away.details === 1, `${cause}: both lines keep the provider's Details, got live ${live.details} and away ${away.details}`);
		await composer.fill("");
		await open();
	}
	console.log("  ok  a failure that ended while nobody was in the room says the live line, with its Details");

	// The connection is lost while it retries (the server killed, so no stop runs, as in a crash or a power cut): the note goes with the connection, the room says it is reconnecting rather than calling the answer cut, and after the restart the message is back in the box.
	await send("Always busy, the connection is lost.");
	await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
	await killServer();
	await page.locator(".turn-status-line", { hasText: "Reconnecting…" }).waitFor({ timeout: 15000 });
	assert((await retryNotes()) === 0, "the retry note goes with the connection");
	assert((await page.getByText("Response interrupted: the connection was lost.").count()) === 0, "a dropped connection is not called a cut answer while the room reconnects");
	await startServer();
	await isReturned("Always busy, the connection is lost.", "a message left unanswered when the connection was lost");
	await page.locator(".turn-status-line").waitFor({ state: "detached", timeout: 15000 });
	assert((await retryNotes()) === 0, "no retry note after the restart");
	await composer.fill("");
	await ask("A fine question after the restart.");
	assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("the connection is lost")), `the next request no longer carries it, got ${JSON.stringify(requestUserTexts.at(-1))}`);
	console.log("  ok  the connection is lost while it retries: the note goes, and after the restart the message is back in the box");

	// The app stops while it retries: the stop hands the message back before the server ends, so it is in the box before the restart, with no retry note.
	if (process.platform === "win32") {
		console.log("  skip  the app stops while it retries: on Windows a stop is a forced kill, which the lost connection above covers");
	} else {
		await send("Always busy, the app stops.");
		await page.getByText(`${MODEL_NAME} is busy. Trying again…`).waitFor({ timeout: 15000 });
		await stopServer();
		await isReturned("Always busy, the app stops.", "a message left unanswered when the app stopped, before the restart");
		assert((await retryNotes()) === 0, "no retry note once the app stopped");
		await startServer();
		// The message never left the box, so the page's reconnect is awaited by its Send button.
		await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 15000 });
		// After the restart the reconnect shows the saved thread, bubble included,
		// until the server's ready hands the message back again, so the bubble's
		// absence is waited for.
		await inBox("Always busy, the app stops.", "a message left unanswered when the app stopped, after the restart");
		await waitUntil(async () => (await bubbles("Always busy, the app stops.")) === 0, "a message left unanswered when the app stopped, after the restart: its bubble is gone", 15000);
		assert((await retryNotes()) === 0, "no retry note after the restart");
		await composer.fill("");
		await ask("A fine question after the restart.");
		assert(!(requestUserTexts.at(-1) ?? []).some((text) => text.includes("the app stops")), `the next request no longer carries it, got ${JSON.stringify(requestUserTexts.at(-1))}`);
		console.log("  ok  the app stops while it retries: the message is back in the box before the restart, and after it, its bubble gone once ready hands it back");
	}

	// Sent while an answer is still running (here, the refusal the server sends then): back in the box with a plain line.
	await send("Refused while running.", false);
	await isReturned("Refused while running.", "a message sent while an answer runs");
	await page.getByText(TURN_RUNNING_LINE).last().waitFor({ timeout: 5000 });
	assert((await page.getByText(/activeThread|still running/).count()) === 0, "no internal words on the page");
	assert((await page.locator('button.send-btn[aria-label="Send"]').count()) === 1, "Send is back");
	console.log("  ok  a message sent while an answer runs goes back in the box with a plain line");
	await composer.fill("");
	// The same with a file: its chip comes back with the text, and Send carries the file's note once.
	await page.locator(".composer-attach-input").setInputFiles({ name: "while-running.txt", mimeType: "text/plain", buffer: Buffer.from("Wednesday: backup checked.\n") });
	await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
	await send("Refused while running, with a file.", false);
	await isReturned("Refused while running, with a file.", "a message with a file sent while an answer runs");
	await page.locator(".composer-staged-card:not(.uploading)", { hasText: "while-running.txt" }).waitFor({ timeout: 5000 });
	const withFileBefore = requestUserTexts.length;
	const answersBeforeFile = await page.getByText("Answer from claude-haiku-5-5.").count();
	await composer.press("Enter");
	await waitUntil(() => requestUserTexts.slice(withFileBefore).some((texts) => texts.at(-1)?.includes("Refused while running, with a file.") ?? false), "the message is sent again with its file", 15000);
	await settled();
	await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeFile, "the message sent again with its file is answered");
	await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
	const sentWithFile = requestUserTexts.slice(withFileBefore).find((texts) => texts.at(-1)?.includes("Refused while running, with a file.")) ?? [];
	const fileNotes = (sentWithFile.at(-1) ?? "").split("[FILE ATTACHED: while-running.txt").length - 1;
	assert(fileNotes === 1 && sentWithFile.filter((text) => text.includes("Refused while running, with a file.")).length === 1, `Send carries the message once with its file's note once, got ${JSON.stringify(sentWithFile)}`);
	assert((await page.locator(".composer-staged-card").count()) === 0 && (await bubbles("Refused while running, with a file.")) === 1, "the chip went with the message, shown once");
	await composer.fill("");
	console.log("  ok  a message with a file sent while an answer runs goes back in the box with its file's chip, and Send carries the file's note once");
	// A file dropped and sent before the room's Attachments list caught up: the list the page holds lacks it, and its chip still comes back.
	const staleName = "dropped-and-sent.txt";
	let staleLists = 1;
	await page.route(/\/api\/persistent-agents\/[^/]+\/files(\?|$)/, async (route) => {
		if (route.request().method() !== "GET" || staleLists === 0) return route.fallback();
		staleLists -= 1;
		const response = await route.fetch();
		const body = await response.json();
		await route.fulfill({ response, json: { ...body, files: (body.files ?? []).filter((file: { name: string }) => file.name !== staleName) } });
	});
	await page.locator(".composer-attach-input").setInputFiles({ name: staleName, mimeType: "text/plain", buffer: Buffer.from("Thursday: restore checked.\n") });
	await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
	await waitUntil(() => staleLists === 0, "the Attachments list read after the upload is the stale one");
	await send("Refused while running, dropped and sent.", false);
	await isReturned("Refused while running, dropped and sent.", "a message with a file sent before the Attachments list caught up");
	await page.locator(".composer-staged-card:not(.uploading)", { hasText: staleName }).waitFor({ timeout: 5000 });
	await page.unroute(/\/api\/persistent-agents\/[^/]+\/files(\?|$)/);
	const staleBefore = requestUserTexts.length;
	await composer.press("Enter");
	await waitUntil(() => requestUserTexts.slice(staleBefore).some((texts) => texts.at(-1)?.includes("Refused while running, dropped and sent.") ?? false), "the message is sent again with its file", 15000);
	await settled();
	await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
	const sentStale = requestUserTexts.slice(staleBefore).find((texts) => texts.at(-1)?.includes("Refused while running, dropped and sent.")) ?? [];
	assert((sentStale.at(-1) ?? "").split(`[FILE ATTACHED: ${staleName}`).length - 1 === 1, `Send carries the file's note once, got ${JSON.stringify(sentStale)}`);
	await composer.fill("");
	console.log("  ok  a file sent before the Attachments list caught up still comes back as a chip");
	// The moment between attempts and the still-finishing line, each checked to the end so every miss is named.
	const turnFailures: string[] = [];
	const expect = (condition: unknown, message: string) => { if (!condition) turnFailures.push(message); };

	// Between a failed attempt and its retry, Send never comes back: the turn goes on.
	gap.armed = true;
	const answersBeforeGap = await page.getByText("Answer from claude-haiku-5-5.").count();
	await send("A server error once, the gap.");
	await waitUntil(() => gap.holding, "the failed attempt's end reached the page", 15000);
	await page.waitForTimeout(500);
	const inGap = { stop: await page.locator(".stop-btn").count(), send: await page.locator('button.send-btn[aria-label="Send"]').count() };
	expect(inGap.stop === 1 && inGap.send === 0, `between a failed attempt and its retry the box shows Stop, not Send, got ${JSON.stringify(inGap)}`);
	expect(gap.end?.retrying === true, `the end of an attempt the runtime asks again says a retry follows, got ${JSON.stringify(gap.end)}`);
	gap.letGo();
	await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeGap, "the retried message is answered");
	await settled();
	await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });

	// The still-finishing line passes: with no answer running it goes at once; once the turn it waited for is over it goes, live and after a reload; it is never saved.
	await waitUntil(async () => (await page.getByText(TURN_RUNNING_LINE).count()) === 0, "the still-finishing line goes", 10000).catch(() => {});
	expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "with no answer running, the still-finishing line goes");
	const answersBeforeNote = await page.getByText("Answer from claude-haiku-5-5.").count();
	await send("A server error once, the passing note.");
	await page.getByText(`${MODEL_NAME} hit an error at its provider. Trying again…`).waitFor({ timeout: 15000 });
	sendToPage(JSON.stringify({ type: "error", code: "turn_running", message: "persistent-agent activeThread is still running" }));
	await page.getByText(TURN_RUNNING_LINE).last().waitFor({ timeout: 5000 });
	await waitUntil(async () => (await page.getByText("Answer from claude-haiku-5-5.").count()) > answersBeforeNote, "the running answer lands");
	await settled();
	await composer.fill("");
	await waitUntil(async () => (await page.getByText(TURN_RUNNING_LINE).count()) === 0, "the still-finishing line goes", 10000).catch(() => {});
	expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "the still-finishing line goes once the turn is over");
	const savedNotes = async () => {
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/threads/${encodeURIComponent(threadId)}`)).json();
		const items: any[] = thread?.thread?.items ?? thread?.items ?? [];
		return items.filter((item) => item?.text === TURN_RUNNING_LINE).length;
	};
	expect((await savedNotes()) === 0, `the still-finishing line is never saved, got ${await savedNotes()}`);
	retryWaits(50);
	await open();
	expect((await page.getByText(TURN_RUNNING_LINE).count()) === 0, "after a reload the still-finishing line is not there");
	assert(turnFailures.length === 0, `between attempts and the still-finishing line:\n  ${turnFailures.join("\n  ")}`);
	console.log("  ok  between a failed attempt and its retry, Stop stays and Send never comes back");
	console.log("  ok  the still-finishing line goes once the turn is over, is not there after a reload, and is never saved");

	// Two tabs: a room is open in one window at a time, so a message handed back in the first is still offered in the second until it is cleared from a box.
	await send("An odd request, two tabs.");
	await isReturned("An odd request, two tabs.", "the first tab");
	await settled();
	const second = await ctx.newPage();
	const enterOn = async (tab: typeof page) => {
		await tab.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await tab.waitForLoadState("networkidle");
		if (await tab.locator(".whats-new-close").count()) await tab.locator(".whats-new-close").click();
		return tab.locator(".persistent-agent-card").filter({ hasText: "Failure Room" }).getByRole("button", { name: /^(Enter|Resume)$/ });
	};
	assert(await (await enterOn(second)).isDisabled(), "the second tab cannot enter while the first has the room");
	await page.goto(`${baseUrl}/`);
	await page.waitForLoadState("networkidle");
	await second.reload();
	await second.waitForLoadState("networkidle");
	await (await enterOn(second)).click();
	const secondComposer = second.locator("textarea").first();
	await waitUntil(async () => (await secondComposer.inputValue()) === "An odd request, two tabs.", `the second tab gets the message back, got ${JSON.stringify(await secondComposer.inputValue())}`, 15000);
	assert((await second.locator(".bubble-row.user", { hasText: "An odd request, two tabs." }).count()) === 0, "its bubble is gone in the second tab too");
	await secondComposer.fill("");
	await second.waitForTimeout(500);
	await second.close();
	await open();
	assert((await composer.inputValue()) === "", `cleared in the second tab, it is not handed back again in the first, got ${JSON.stringify(await composer.inputValue())}`);
	console.log("  ok  two tabs: the room is open in one at a time, and a message handed back is offered in the next one until it is cleared");

	// No key at all: refused before it reached the conversation, the message goes back in the box.
	const savedAuth = fs.readFileSync(path.join(agentDir, "auth.json"), "utf8");
	fs.writeFileSync(path.join(agentDir, "auth.json"), "{}", { mode: 0o600 });
	await send("With no key at all.", false);
	await page.getByText(/No Claude API key is saved/).first().waitFor({ timeout: 15000 });
	await settled();
	await isReturned("With no key at all.", "a message refused for a missing key");
	console.log("  ok  no key at all: the key notice says it, and the message is back in the box");
	fs.writeFileSync(path.join(agentDir, "auth.json"), savedAuth, { mode: 0o600 });
	await composer.fill("");
	await open();
	// The room has no folder, so the hint to connect one shows until a notice that stops the room takes its place.
	const workspaceHint = page.locator(".room-workspace-nudge:not(.room-model-notice)");
	await workspaceHint.waitFor({ timeout: 10000 });
	// A refused key: the key notice says it, and no red line beside it.
	const linesBeforeKey = (await errorTexts()).length;
	await send("Key refused, please.");
	await isReturned("Key refused, please.", "a message whose key was refused");
	await settled();
	await page.waitForTimeout(500);
	assert((await errorTexts()).length === linesBeforeKey, `no red line beside the key notice, got ${JSON.stringify((await errorTexts()).slice(linesBeforeKey))}`);
	const keyNotice = page.locator(".room-model-notice .room-workspace-nudge-text");
	await waitUntil(async () => (await keyNotice.count()) > 0 && /did not accept the saved key/.test(await keyNotice.first().innerText()) && !(await keyNotice.first().innerText()).includes("back in the box"), `the key notice says the cause and not that the message is back in the box, got ${JSON.stringify(await keyNotice.allInnerTexts())}`, 10000);
	assert((await workspaceHint.count()) === 0, "while the key notice shows, the hint to connect a folder waits");
	console.log("  ok  a refused key: the key notice says it, not that the message is back in the box, and no red line beside it");
	// The notice goes with the next message, and the hint is back.
	await ask("A fine question after the refused key.");
	await page.locator(".room-model-notice").waitFor({ state: "detached", timeout: 10000 });
	await workspaceHint.waitFor({ timeout: 10000 });
	console.log("  ok  while the key notice shows, the hint to connect a folder waits, and it is back once the notice goes");
	await composer.fill("");
	await open();
	// The same while nobody is in the room: on the way in the box has the message, and a sentence says so.
	holdAnswers();
	await send("Key refused, while I step out.");
	await stepOut();
	await settled();
	await open();
	await isReturned("Key refused, while I step out.", "a key refused while nobody was in the room");
	// On the way in, the key notice says why, with its button: never a bare line.
	await waitUntil(async () => (await keyNotice.count()) > 0 && /did not accept the saved key/.test(await keyNotice.first().innerText()), `the key notice says the cause, got ${JSON.stringify(await page.locator(".room-model-notice, .system-line").allInnerTexts())}`, 10000);
	assert((await page.locator(".room-model-notice button", { hasText: "Replace key" }).count()) === 1, "the notice offers Replace key");
	assert((await page.locator(".system-line-text").allInnerTexts()).every((text) => text.trim() !== "Your message is back in the box."), `no bare line stands in for the notice, got ${JSON.stringify((await page.locator(".system-line-text").allInnerTexts()).slice(-3))}`);
	await composer.fill("");
	console.log("  ok  a key refused while nobody was in the room: the key notice says why, with Replace key, and the message is back in the box");

	// A scheduled task fails in the room's conversation while nobody is in the room, with Bash off and then on.
	const background = await import("../src/persistent-room-background-execution.js");
	const policies = await import("../src/persistent-room-workspace-policy.js");
	const threads = await import("../src/persistent-agents.js");
	const workspaceRoot = path.join(tempRoot, "workspace");
	fs.mkdirSync(workspaceRoot, { recursive: true });
	const scheduledFailures: string[] = [];
	// The third run stands for one that failed before this update: its session file has no mark.
	for (const [bash, beforeUpdate] of [[false, false], [true, false], [false, true]] as const) {
		await composer.fill("");
		await page.waitForTimeout(300);
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		await waitUntil(async () => (await status())?.activeThread?.inFlight === false, "the room is idle before the scheduled run");
		if (bash) {
			policies.writePersistentRoomDefaultCapabilityPolicy(policies.createPersistentRoomDefaultCapabilityPolicy({ agentId, root: workspaceRoot, repoRoot, persistentAgentsRoot: agentsRoot, exxetaStateRoot: path.join(tempHome, ".exxperts", "app"), workspaceAccessMode: "localFiles", bashEnabled: true, displayLabel: "Scheduled Smoke Workspace" }), { persistentAgentsRoot: agentsRoot });
		}
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = threads.getPersistentAgentThread(agentId, threadId);
		assert(thread?.model, "the room's conversation has its model");
		const scheduledPrompt = `A scheduled odd request, bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}.`;
		let failedRun = false;
		try {
			await background.executePersistentRoomBackgroundPrompt({ roomId: agentId, target: { kind: "resume-thread", roomId: agentId, threadId, model: { provider: thread.model.provider, model: thread.model.model } }, prompt: scheduledPrompt, executionId: `smoke_bash_${bash ? "on" : "off"}${beforeUpdate ? "_before" : ""}`, agentDir });
		} catch {
			failedRun = true;
		}
		assert(failedRun, `the scheduled run with Bash ${bash ? "on" : "off"} fails`);
		if (beforeUpdate) {
			const sessionFiles: string[] = [];
			const walk = (dir: string) => { for (const entry of fs.readdirSync(dir, { withFileTypes: true })) { const full = path.join(dir, entry.name); if (entry.isDirectory()) walk(full); else if (entry.name.endsWith(".jsonl")) sessionFiles.push(full); } };
			walk(agentsRoot);
			let stripped = 0;
			for (const file of sessionFiles) {
				// Only the run's own mark, the file's last entry: earlier marks have entries after them that point at them.
				const lines = fs.readFileSync(file, "utf8").split("\n");
				const last = lines.map((line) => line.trim()).lastIndexOf(lines.filter((line) => line.trim()).at(-1) ?? "");
				if (last >= 0 && lines[last]!.includes('"app-turn-failed"')) {
					lines.splice(last, 1);
					fs.writeFileSync(file, lines.join("\n"));
					stripped += 1;
				}
			}
			assert(stripped >= 1, "the run before the update has no mark in its session file");
		}
		const sentWithPrefix = requestUserTexts.some((texts) => texts.some((text) => text.includes(scheduledPrompt) && text.includes("Background scheduled execution does not have Bash")));
		assert(sentWithPrefix === bash, `the scheduled prompt carries the Bash prefix only with Bash on (Bash ${bash ? "on" : "off"}: ${sentWithPrefix})`);
		await open();
		await page.waitForTimeout(1500);
		const box = await composer.inputValue();
		const lines = await errorTexts();
		console.log(`  scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: box ${JSON.stringify(box)}; bubble ${await bubbles(scheduledPrompt)}; last line ${JSON.stringify(lines.at(-1))}`);
		if (box !== "") scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: nothing lands in the box, got ${JSON.stringify(box)}`);
		if (lines.at(-1)?.includes("back in the box")) scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: no line says a message is back in the box, got ${JSON.stringify(lines.at(-1))}`);
		if ((await bubbles(scheduledPrompt)) !== 1) scheduledFailures.push(`a failed scheduled run, Bash ${bash ? "on" : "off"}${beforeUpdate ? ", before the update" : ""}: its prompt stays where it is`);
		await composer.fill("");
		if (bash) policies.deletePersistentRoomDefaultCapabilityPolicy(agentId, { persistentAgentsRoot: agentsRoot });
	}
	assert(scheduledFailures.length === 0, `scheduled runs:\n  ${scheduledFailures.join("\n  ")}`);
	console.log("  ok  a scheduled task that fails keeps its failure where it is, with Bash on and off, and one from before the update: nothing lands in the box");

	// A scheduled task whose answer is cut off keeps its partial as an ordinary answer, said once however often the runtime asked again.
	{
		await composer.fill("");
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		await waitUntil(async () => (await status())?.activeThread?.inFlight === false, "the room is idle before the scheduled run");
		const threadId = String((await status())?.activeThread?.threadId ?? "");
		const thread = threads.getPersistentAgentThread(agentId, threadId);
		assert(thread?.model, "the room's conversation has its model");
		await background.executePersistentRoomBackgroundPrompt({ roomId: agentId, target: { kind: "resume-thread", roomId: agentId, threadId, model: { provider: thread.model.provider, model: thread.model.model } }, prompt: "Cut off midway, a scheduled task.", executionId: "smoke_cut", agentDir }).catch(() => undefined);
		const landed = (threads.getPersistentAgentThread(agentId, threadId)?.items ?? []).filter((item: any) => item?.kind === "assistant" && String(item?.id ?? "").startsWith("scheduled-assistant-smoke_cut")).map((item: any) => String(item.text));
		assert(landed.length === 1 && landed[0] === "A partial answer that stops", `a scheduled task's cut-off answer lands its partial once, as an answer, got ${JSON.stringify(landed)}`);
		await open();
	}
	console.log("  ok  a scheduled task whose answer is cut off keeps its partial once, as an ordinary answer");

	// A message handed back that the page shows no bubble for: it lands in the box with a line of its own, and no other line is changed.
	await composer.fill("");
	await page.waitForTimeout(300);
	const linesBefore = await errorTexts();
	const causesBefore = await causes();
	sendToPage(JSON.stringify({ type: "prompt_returned", text: "A message this page never showed.", failure: "other" }));
	await waitUntil(async () => (await composer.inputValue()) === "A message this page never showed." || (await errorTexts()).length !== linesBefore.length, "the handed-back message is placed");
	await page.waitForTimeout(500);
	const linesAfter = await errorTexts();
	if ((await composer.inputValue()) === "A message this page never showed.") {
		assert(linesAfter.length === linesBefore.length + 1, `text in the box comes with its own line, got ${JSON.stringify(linesAfter.slice(-2))}`);
		// A line that was the newest folds to its cause; no line says anything else.
		const causesAfter = await causes();
		assert(JSON.stringify(causesAfter.slice(0, causesBefore.length)) === JSON.stringify(causesBefore), `no other line is changed, got ${JSON.stringify(causesAfter.slice(-3))} after ${JSON.stringify(causesBefore.slice(-2))}`);
	}
	await composer.fill("");
	await page.waitForTimeout(300);
	console.log("  ok  a message handed back with no bubble comes with its own line, and no other line changes");

	// A new message whose first attempt the runtime asks again (the retry's start sent here, then Stop): the last turn's line stays where it is.
	await send("An odd request, the last line.");
	await isReturned("An odd request, the last line.", "a failed message before a retried one");
	await settled();
	await composer.fill("");
	const linesBeforeRetry = await errorTexts();
	const partialsBeforeRetry = await page.getByText("A partial answer that stops").count();
	await send("Slow answer, then a retry.");
	await waitUntil(async () => (await page.getByText("A partial answer that stops").count()) > partialsBeforeRetry, "the slow answer has begun", 15000);
	sendToPage(JSON.stringify({ type: "event", event: { type: "auto_retry_start", attempt: 1, maxAttempts: 3, delayMs: 1000, errorMessage: "Overloaded" } }));
	await page.getByText(/Trying again…/).waitFor({ timeout: 5000 });
	const linesInRetry = await errorTexts();
	assert(linesInRetry.length === linesBeforeRetry.length, `a retry of a new message leaves the last turn's line, got ${JSON.stringify(linesInRetry.slice(-2))} after ${JSON.stringify(linesBeforeRetry.slice(-2))}`);
	await page.locator(".stop-btn").click();
	await settled();
	console.log("  ok  a new message's first attempt asked again leaves the last turn's line where it is");

	// Try again under a message that stayed above, refused before it began (the app stopping, or the connection lost):
	// the next message is one of its own, so its refusal hands it back with its line, as any other's.
	for (const refusal of [{ type: "error", code: "server_stopping", message: "exxperts is stopping, so this cannot start now." }, "drop" as const]) {
		const label = refusal === "drop" ? "the connection lost" : "the app stopping";
		await composer.fill("");
		await send(`Cut off midway, then ${label}.`);
		await settled();
		await waitUntil(async () => (await errorTexts()).at(-1) === `${MODEL_NAME} stopped in the middle of its answer. Your message is still above.`, `${label}: the cut-off line says the message is still above, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		const readiesBefore = continueAnswer.readies;
		continueAnswer.next = refusal;
		await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
		if (refusal === "drop") await waitUntil(() => continueAnswer.readies > readiesBefore, `${label}: the room is connected again`);
		else await page.getByText("exxperts is stopping, so this cannot start now.").last().waitFor({ timeout: 5000 });
		await page.locator('button.send-btn[aria-label="Send"]').waitFor({ timeout: 10000 });
		await page.waitForTimeout(500);
		const notesBefore = await page.getByText(TURN_RUNNING_LINE).count();
		await send(`Refused while running, after ${label}.`, false);
		await waitUntil(async () => (await page.getByText(TURN_RUNNING_LINE).count()) > notesBefore, `${label}: the next message refused while an answer runs says so, got ${await page.getByText(TURN_RUNNING_LINE).count()} line(s), ${await bubbles(`Refused while running, after ${label}.`)} bubble(s), box ${JSON.stringify(await composer.inputValue())}`, 8000);
		await isReturned(`Refused while running, after ${label}.`, `${label}: the next message refused while an answer runs`);
		await composer.fill("");
		await page.waitForTimeout(1500);
	}
	console.log("  ok  after a Try again refused before it began, by the app stopping or the connection lost, the next message refused is handed back with its line");

	// Try again where the conversation moved on, for a message that cannot go whole again (its file gone from the room's Attachments):
	// nothing is sent, its words go back in the box, focused, and its line says so.
	const goneAbove = `${MODEL_NAME} could not answer this message. Your message is still above. Try again; if it repeats, choose another model.`;
	// Sends a message with a file, which fails and stays above; the file then leaves the room's Attachments, the room opens again,
	// and Try again finds nothing to continue.
	const tryAgainWithFileGone = async (fileName: string, text: string, draft = "") => {
		await composer.fill("");
		await page.locator(".composer-attach-input").setInputFiles({ name: fileName, mimeType: "text/plain", buffer: Buffer.from("A file that leaves.\n") });
		await page.locator(".composer-staged-card:not(.uploading)").waitFor({ timeout: 15000 });
		const before = requestUserTexts.length;
		await composer.fill(text);
		await composer.press("Enter");
		await waitUntil(() => requestUserTexts.slice(before).some((texts) => texts.some((typed) => typed.includes(fileName))), `the message with ${fileName} reached the model`);
		await settled();
		await waitUntil(async () => (await errorTexts()).at(-1) === goneAbove, `the message with its file stays above, got ${JSON.stringify((await errorTexts()).at(-1))}`, 10000);
		const deleted = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/files/${encodeURIComponent(fileName)}/delete`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		assert(deleted.ok, `the file leaves the room's Attachments, got ${deleted.status}`);
		const committed = await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/files/${encodeURIComponent(fileName)}/delete/commit`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: (await deleted.json()).token }) });
		assert(committed.ok, `the delete is final, got ${committed.status}`);
		await open();
		await waitUntil(async () => (await errorTexts()).at(-1) === goneAbove, "the line is there after the reload", 10000);
		await composer.fill(draft);
		const sentBefore = requestUserTexts.length;
		continueAnswer.next = { type: "error", code: "nothing_to_continue", message: "There is nothing to continue." };
		await page.locator(".failure-line:not(.is-folded)").getByRole("button", { name: "Try again" }).click();
		return sentBefore;
	};
	const nothingSent = async (sentBefore: number) => {
		assert(await page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"), "the box has the focus");
		await page.waitForTimeout(500);
		assert(requestUserTexts.length === sentBefore, `nothing is sent, got ${JSON.stringify(requestUserTexts.slice(sentBefore))}`);
		await composer.fill("");
	};
	const requestsBeforeGone = await tryAgainWithFileGone("gone.txt", "An odd request about the gone file, please.");
	await inBox("An odd request about the gone file, please.", "Try again for a message that cannot go whole");
	await waitUntil(async () => (await errorTexts()).at(-1) === `${MODEL_NAME} could not answer this message. Try again; if it repeats, choose another model.`, `the line no longer says where the message is, got ${JSON.stringify((await errorTexts()).at(-1))}`, 5000);
	await nothingSent(requestsBeforeGone);
	console.log("  ok  Try again for a message that cannot go whole again: nothing is sent, its words are back in the box, focused, and its line says so");

	// The same with a draft in the box, and for a message that was only its file: the draft stays, nothing is sent, and the line says the message can't go as it was.
	const notSentAgain = `${MODEL_NAME} could not answer this message. Your message is still above. It can't be sent again as it was. Send what you need in a new message.`;
	for (const scene of [{ fileName: "draft.txt", text: "An odd request, with a draft after it.", draft: "A draft of my own." }, { fileName: "odd request only.txt", text: "", draft: "" }]) {
		const label = scene.draft ? "with a draft in the box" : "for a message that was only its file";
		const sentBefore = await tryAgainWithFileGone(scene.fileName, scene.text, scene.draft);
		await waitUntil(async () => (await errorTexts()).at(-1) === notSentAgain, `${label}: the line says the message can't be sent again as it was, got ${JSON.stringify((await errorTexts()).at(-1))}`, 5000);
		assert((await composer.inputValue()) === scene.draft, `${label}: the box keeps ${JSON.stringify(scene.draft)}, got ${JSON.stringify(await composer.inputValue())}`);
		await nothingSent(sentBefore);
	}
	console.log("  ok  Try again for a message that cannot go whole, with a draft in the box or no words of its own: nothing is sent, the box stays, and its line says so");
	await closeContext(ctx);
	// The server: a message sent while an answer runs is refused for that window only, and the running answer still ends well.
	const WebSocketImpl: any = (await import("ws")).default;
	const conversationId = String((await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.threadId ?? "");
	assert(conversationId, "the room has an active conversation");
	const frames: any[] = [];
	retryWaits(1000);
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), "ready frame");
	socket.send(JSON.stringify({ type: "prompt", text: "A server error once, on the socket." }));
	await waitUntil(() => frames.some((frame) => frame.type === "event" && frame.event?.type === "auto_retry_start"), "the retry starts");
	socket.send(JSON.stringify({ type: "prompt", text: "Second while running." }));
	await waitUntil(() => frames.some((frame) => frame.type === "error" && frame.code === "turn_running"), "the second message is refused as sent while an answer runs");
	await waitUntil(async () => frames.some((frame) => JSON.stringify(frame).includes("Answer from")) && (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === false, "the running answer lands");
	// A message that carries more than the person typed (a file note) stays where it was when it fails: only typed text can go back in the box.
	const inFlight = async () => (await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json())?.activeThread?.inFlight === true;
	const framesBeforeFile = frames.length;
	socket.send(JSON.stringify({ type: "prompt", text: "[FILE ATTACHED: notes.txt (1 KB)]\nAn odd request with a file." }));
	await waitUntil(() => requestUserTexts.some((texts) => texts.some((text) => text.includes("An odd request with a file."))), "the message with a file note reached the model");
	await waitUntil(async () => !(await inFlight()), "the failed message with a file note settled");
	await new Promise((resolve) => setTimeout(resolve, 500));
	assert(!frames.slice(framesBeforeFile).some((frame) => frame.type === "prompt_returned"), `a message with a file note is not handed back, got ${JSON.stringify(frames.slice(framesBeforeFile).filter((frame) => frame.type === "prompt_returned"))}`);
	socket.send(JSON.stringify({ type: "prompt", text: "And a fine question about the file." }));
	await waitUntil(async () => requestUserTexts.some((texts) => texts.some((text) => text.includes("And a fine question about the file."))) && !(await inFlight()), "the next message is answered");
	const fileRequest = requestUserTexts.filter((texts) => texts.some((text) => text.includes("And a fine question about the file."))).at(-1) ?? [];
	assert(fileRequest.some((text) => text.includes("FILE ATTACHED: notes.txt")), `the model still sees the message with its file note, got ${JSON.stringify(fileRequest)}`);
	console.log("  ok  a failed message that carries a file note stays where it was, and the model still sees it");
	socket.close();
	assert(!requestUserTexts.some((texts) => texts.some((text) => text.includes("Second while running."))), "the refused message never reached the model");
	const turnState = JSON.stringify(await (await authedFetch(`${baseUrl}/api/persistent-agents/${agentId}/status`)).json());
	assert(turnState.includes('"lastTerminalReason":"completed"'), `the running answer still ends well, got ${turnState.match(/"activeTurn":\{[^}]*\}/)?.[0]}`);
	console.log("  ok  the server refuses a message sent while an answer runs for that window only, and the running answer still ends well");
	console.log("room-failed-message-returns-away smoke: ok");
} catch (error) {
	await closeFailureRoom(error);
	throw error;
}
await closeFailureRoom();
