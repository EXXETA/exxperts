// A person never sees the room-state copy: not in the live chat while a turn
// sends one, and not in the conversation's history after a reload. Drives the
// real page in Chromium against the real server and a synthetic gateway, and
// checks first that the copies did reach the model, so a page that shows none
// is not a page that was never sent any.
import fs from "node:fs";
import { chromium } from "playwright";
import { assert, baseUrl, copiesIn, openRoom, rename, requests, startRoomStateServer, stopRoomStateServer, waitUntil } from "./room-state-setup.js";
import { SMOKE_AUTH_TOKEN } from "./smoke-server-process.js";

{
	const executable = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!executable || !fs.existsSync(executable)) {
		console.log("room-state-page-smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const COPY_WORDS = ["Room state", "Live runtime state", "Your name is now", "Attachments in this room", "Current workspace", "replaces every earlier"];
let passes = 0;
const pass = (label: string) => { passes++; console.log(`  ok ${label}`); };

let error: unknown;
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
	await startRoomStateServer();
	const { roomId } = await openRoom("Page Room");
	browser = await chromium.launch();
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
	const enter = async () => {
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-close");
		if (await dismiss.count()) await dismiss.click();
		await page.locator(".persistent-agent-card").filter({ hasText: "Page Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
		await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
	};
	const composer = page.locator("textarea").first();
	const send = async (text: string) => {
		const answers = await page.getByText("Noted.").count();
		await composer.fill(text);
		await waitUntil(() => page.getByRole("button", { name: "Send", exact: true }).isEnabled(), "Send is enabled");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Noted.").count()) > answers, `"${text}" is answered on the page`);
		await waitUntil(async () => (await (await fetch(`${baseUrl}/api/persistent-agents/${roomId}/status`, { headers: { "X-Exxperts-Auth": SMOKE_AUTH_TOKEN } })).json())?.activeThread?.inFlight === false, "the turn settled");
	};
	const shownCopyWords = async () => {
		const shown = await page.locator("body").innerText();
		return COPY_WORDS.filter((words) => shown.includes(words));
	};

	await enter();
	await send("Hello from the page.");
	await rename(roomId, "Page Room Renamed");
	await send("And again.");
	const sent = requests.at(-1)!;
	assert(copiesIn(sent).length === 2 && sent.messages.at(-1)?.text.includes("Page Room Renamed"), `both turns sent a copy to the model, got ${copiesIn(sent).length}`);
	assert(await page.getByText("Hello from the page.").count() > 0 && await page.getByText("And again.").count() > 0, "the person's messages are on the page");
	const live = await shownCopyWords();
	assert(live.length === 0, `the live chat shows no room-state text, found: ${live.join(", ")}`);
	pass("the live chat shows the messages and answers, and no copy");

	await page.reload();
	await page.waitForLoadState("networkidle");
	await page.getByText("And again.").first().waitFor({ timeout: 15_000 }).catch(async () => { await enter(); await page.getByText("And again.").first().waitFor({ timeout: 15_000 }); });
	assert(await page.getByText("Hello from the page.").count() > 0, "the history shows the earlier message after a reload");
	const history = await shownCopyWords();
	assert(history.length === 0, `the history shows no room-state text, found: ${history.join(", ")}`);
	pass("the conversation's history after a reload shows no copy");

	console.log(`room-state-page-smoke: ${passes} checks passed`);
} catch (caught) {
	error = caught;
	console.error(`room-state-page-smoke FAILED: ${(caught as Error).message}`);
	process.exitCode = 1;
} finally {
	try { await browser?.close(); } catch {}
	await stopRoomStateServer(error);
}
