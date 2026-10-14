// Remember in the browser, as a job on the server: the dialog follows a
// Remember that started before a reload (the job reads on, and entering the
// room opens the dialog in its reading state), shows the proposal when the
// job ends, Discard deletes the kept proposal on the server, and Cancel stops
// the provider call from the dialog. A Remember that fills the room, quick or
// reviewed, offers Memorize on its page and never bounces to Home through the
// full room's refusal; its Memorize starts Memorize. Offline: one synthetic provider.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("remember dialog smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-remember-dialog-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const CLAUDE = { provider: "fake-claude", model: "claude-fake" };
// Twelve points to keep: the review shows every one of them.
const POINTS = ["The launch moves to May.", ...Array.from({ length: 11 }, (_, i) => `Launch step ${i + 2} is agreed with the team and needs no further review before the launch.`)];
const PAGE = `TITLE:\nThe launch plan\n\nSESSION_ARC:\nWe planned the launch.\n\nBODY:\n${POINTS.map((point) => `- ${point}`).join("\n")}\n\nPARKED:\nNone\n`;
type ProviderRequest = { remember: boolean; aborted: boolean };
const requests: ProviderRequest[] = [];
let holdRemember = true;
const held: Array<() => void> = [];

function sse(res: http.ServerResponse, event: string | null, payload: unknown): void {
	res.write(`${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(payload)}\n\n`);
}

function answer(res: http.ServerResponse, model: string, text: string): void {
	if (res.writableEnded || res.destroyed) return;
	sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
	sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
	sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } });
	sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
	sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
	sse(res, "message_stop", { type: "message_stop" });
	res.end();
}

// One synthetic Anthropic provider. A Remember call waits until the smoke
// releases it, and records whether its stream was closed on it.
const providers = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const record: ProviderRequest = { remember: raw.includes("Checkpoint Compression Constitution"), aborted: false };
		requests.push(record);
		res.on("close", () => { if (!res.writableFinished) record.aborted = true; });
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (!record.remember) return answer(res, String(body.model), "Answer from claude-fake.");
		if (!holdRemember) return answer(res, String(body.model), PAGE);
		held.push(() => answer(res, String(body.model), PAGE));
	});
});

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 25_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
	}
	throw new Error(`timed out waiting until ${label}`);
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

function startServer(): void {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
}

try {
	await new Promise<void>((resolve) => providers.listen(0, "127.0.0.1", resolve));
	const providerPort = (providers.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: {
			"fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
			// An address nothing listens on: a Memory model that is not answering, said at once.
			"fake-dead": { name: "Fake Dead", baseUrl: "http://127.0.0.1:9", api: "anthropic-messages", models: [{ id: "dead-fake", name: "Dead Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] },
		},
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" }, "fake-dead": { type: "api_key", key: "synthetic-dead" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
		{ id: "custom-fake-dead", providerId: "fake-dead", label: "Fake Dead", roomModels: ["dead-fake"], learnModel: "dead-fake", reviewMemoryModel: "dead-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Remember Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(agentId, { conversation: CLAUDE });
	const otherId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Other Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(otherId, { conversation: CLAUDE });

	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		const page = await ctx.newPage();
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();
		const enterRoom = async () => {
			// A reload on the room's address opens the room by itself; from Home, its card does.
			const card = page.locator(".persistent-agent-card").filter({ hasText: "Remember Room" });
			const composerBox = page.locator("textarea").first();
			if (!(await page.evaluate(() => window.location.hash)).startsWith("#/room/")) await card.getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await waitUntil(async () => (await composerBox.isVisible().catch(() => false)) && !(await card.count()), "the room is open");
		};
		await enterRoom();
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("We moved the launch to May.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer");
		await page.waitForTimeout(800);

		const dialog = page.getByRole("dialog", { name: "Remember this conversation" });
		const openDialog = async () => {
			// Entering a room whose Remember finished opens the dialog on the entry by itself.
			await page.waitForTimeout(500);
			if (await dialog.isVisible().catch(() => false)) return;
			await page.getByRole("button", { name: "More ways to remember" }).click();
			await page.getByRole("menuitem", { name: "Remember with options…" }).click();
			await dialog.waitFor({ timeout: 10000 });
		};
		const activeConversation = () => page.evaluate(async (id) => {
			const res = await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/status`);
			return (await res.json()).activeThread?.threadId as string;
		}, agentId);
		let conversationId = await activeConversation();
		const progress = () => authedFetch(`${baseUrl}/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/progress?conversationId=${encodeURIComponent(conversationId)}`).then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

		// 1. Generate, then reload while it reads: the job reads on.
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await waitUntil(() => requests.some((request) => request.remember), "the Remember call reaches the provider");
		const first = requests.find((request) => request.remember)!;
		await page.reload({ waitUntil: "domcontentloaded" });
		if (await dismiss.count()) await dismiss.click();
		await page.waitForTimeout(1500);
		assert(!first.aborted, "a reload does not stop the Remember: its provider call is still open");
		assert((await progress()).body?.state === "reading", "the server still reads after the reload");

		// 2. Entering the room opens the dialog in its reading state.
		if (!(await dialog.count())) await enterRoom();
		await dialog.waitFor({ timeout: 15000 });
		await dialog.getByRole("button", { name: "Cancel" }).waitFor({ timeout: 10000 });

		// 3. The job ends: the dialog shows the proposal.
		holdRemember = false;
		for (const release of held.splice(0)) release();
		await dialog.getByText("The launch moves to May.").first().waitFor({ timeout: 20000 });
		assert((await progress()).body?.state === "done", "the finished proposal is kept on the server");

		// 3b. The review shows the whole entry under the editor's section names, every one of its 12 points; it
		// scrolls inside the card, and the heading and Save stay in sight without scrolling the page, at 1280x720
		// and at phone width. No labels row, no sentence about saving without the preview. Edit opens the editor
		// with Save in sight; Done editing shows the whole entry again.
		const inSight = (name: string) => dialog.getByRole("button", { name }).evaluate((button) => {
			const rect = button.getBoundingClientRect();
			const heading = button.closest(".checkpoint-input-card")!.querySelector("h2")!.getBoundingClientRect();
			return window.scrollY === 0 && heading.top >= 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
		});
		for (const viewport of [{ width: 1280, height: 720 }, { width: 390, height: 740 }]) {
			await page.setViewportSize(viewport);
			await page.waitForTimeout(300);
			for (const point of POINTS) assert(await dialog.getByText(point, { exact: true }).count() === 1, `the review shows every point, missing ${JSON.stringify(point)} at ${viewport.width}`);
			const text = await dialog.innerText();
			assert(/What happened/.test(text) && /What to keep/.test(text) && text.includes("We planned the launch.") && text.includes("The launch plan"), `the review names the editor's sections, got ${JSON.stringify(text.slice(0, 400))}`);
			assert(!/tokens|includes parked items|Holds \d+ of|Show full entry|Hide full entry|without the preview|Untitled|No session arc/.test(text), `no labels row and no preview sentence, got ${JSON.stringify(text.slice(0, 600))}`);
			assert(await inSight("Save to memory") && await inSight("Discard"), `the heading, Save and Discard stay in sight at ${viewport.width}x${viewport.height}`);
		}
		await page.setViewportSize({ width: 1280, height: 720 });
		await dialog.getByRole("button", { name: "Edit", exact: true }).click();
		await dialog.locator("textarea").first().waitFor({ timeout: 5000 });
		assert(await inSight("Save to memory"), "Save stays in sight while the entry is edited");
		// Save never stays off without a reason: with "What happened" and "Still open" emptied it saves; with
		// "What to keep" emptied too, one line says what to do.
		const field = (name: string) => dialog.locator("label").filter({ hasText: name }).locator("textarea");
		const arc = await field("What happened").inputValue();
		const keep = await field("What to keep").inputValue();
		await field("What happened").fill("");
		await field("Still open").fill("");
		assert(await dialog.getByRole("button", { name: "Save to memory" }).isEnabled(), "Save needs only What to keep");
		await field("What to keep").fill("");
		assert(!(await dialog.getByRole("button", { name: "Save to memory" }).isEnabled()) && await dialog.getByText("Write what to keep before saving.", { exact: true }).count() === 1, "an empty What to keep says what to do");
		await field("What to keep").fill(keep);
		await dialog.getByRole("button", { name: "Done editing" }).click();
		assert(await dialog.getByText(POINTS[11]!, { exact: true }).count() === 1, "Done editing shows the whole entry again");
		assert(!/What happened|Still open/.test(await dialog.innerText()), "an emptied part is left out of the review");
		await dialog.getByRole("button", { name: "Edit", exact: true }).click();
		await field("What happened").fill(arc);
		await dialog.getByRole("button", { name: "Done editing" }).click();
		await page.setViewportSize({ width: 1280, height: 900 });

		// 4. Discard deletes the kept proposal on the server.
		await dialog.getByRole("button", { name: "Discard" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
		await waitUntil(async () => (await progress()).body?.state === "none", "Discard deletes the kept proposal");

		// 4a. Remember with "Remember without the preview" off: the review simply opens, the whole entry and no
		// sentence about the setting.
		await page.getByRole("button", { name: "Remember", exact: true }).click();
		await dialog.getByText(POINTS[11]!, { exact: true }).waitFor({ timeout: 20000 });
		assert(!/without the preview|Room settings/.test(await dialog.innerText()), `the review opens with no sentence about the setting, got ${JSON.stringify((await dialog.innerText()).slice(0, 600))}`);
		await dialog.getByRole("button", { name: "Discard" }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: "Discard" }).click();
		await waitUntil(async () => (await progress()).body?.state === "none", "Discard deletes the quick Remember's proposal");

		// 4b. Back while Remember reads: the job reads on, entering the room again
		// opens the dialog in its reading state, and another room's dialog never
		// shows this room's proposal or a line about it.
		holdRemember = true;
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await dialog.getByRole("button", { name: "Cancel" }).waitFor({ timeout: 10000 });
		const homeCard = (name: string) => page.locator(".persistent-agent-card").filter({ hasText: name });
		await page.goBack();
		await homeCard("Remember Room").waitFor({ timeout: 10000 });
		await homeCard("Remember Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await dialog.getByRole("button", { name: "Cancel" }).waitFor({ timeout: 10000 }).catch(() => { throw new Error("entering the room again after Back opens the dialog in its reading state"); });
		await page.goBack();
		await homeCard("Other Room").waitFor({ timeout: 10000 });
		await homeCard("Other Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await waitUntil(async () => (await page.evaluate(() => window.location.hash)) === `#/room/${otherId}` && (await composer.isVisible().catch(() => false)), "the other room is open");
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("The venue holds two hundred.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer in the other room");
		holdRemember = false;
		for (const release of held.splice(0)) release();
		await waitUntil(async () => (await progress()).body?.state === "done", "the first room's Remember ends");
		await page.waitForTimeout(2500);
		await openDialog();
		await page.waitForTimeout(1000);
		assert(await dialog.getByText("The launch moves to May.").count() === 0, "the other room's dialog does not show the first room's proposal");
		assert(await dialog.getByText(/another conversation is open|does not match/).count() === 0, "the other room's dialog shows no line about the first room's Remember");
		assert(await dialog.getByRole("button", { name: "Generate memory proposal" }).count() === 1, "the other room's dialog opens on its own options");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		const enterFirstRoom = async () => {
			await page.goBack();
			await homeCard("Remember Room").waitFor({ timeout: 10000 });
			await homeCard("Remember Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await waitUntil(async () => (await page.evaluate(() => window.location.hash)) === `#/room/${agentId}` && (await composer.isVisible().catch(() => false)), "back in the first room");
			await page.waitForTimeout(800);
		};
		// The finished proposal shown in the first room stays there.
		await enterFirstRoom();
		await openDialog();
		await dialog.getByText("The launch moves to May.").first().waitFor({ timeout: 15000 });
		await page.goBack();
		await homeCard("Other Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await waitUntil(async () => (await page.evaluate(() => window.location.hash)) === `#/room/${otherId}` && (await composer.isVisible().catch(() => false)), "the other room again");
		await page.waitForTimeout(800);
		await openDialog();
		await page.waitForTimeout(1000);
		assert(await dialog.getByText("The launch moves to May.").count() === 0 && await dialog.getByRole("button", { name: "Generate memory proposal" }).count() === 1, "a finished proposal shown in the first room is not shown in the other room's dialog");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		// A save still on its way when the tab moves to another room lands, and the tab stays where it went.
		// This save fills the first room: the other room never shows its full-room page.
		const firstRoomL1b = agents.createPersistentAgentInstance(agentId).l1bCurrentPath(agents.createPersistentAgentInstance(agentId).readAgentJson());
		const beforeFill = fs.readFileSync(firstRoomL1b, "utf-8");
		const saved = (beforeFill.match(/^### RC-\d+ \|/gm) ?? []).length;
		const filler = (n: number) => [`### RC-09${String(n).padStart(2, "0")} | CLOSED | 2026-09-11 | Filler plan ${n}`, "", `**Session arc:** Filler plan ${n} was settled.`, "", "**Body:**", `- Filler plan ${n} is settled.`, "", "**Parked:**", "None", ""].join("\n");
		const recent = /^##\s+Recent Context\s*$/m.exec(beforeFill)!;
		fs.writeFileSync(firstRoomL1b, `${beforeFill.slice(0, recent.index + recent[0].length)}\n\n${Array.from({ length: 19 - saved }, (_, n) => filler(n + 1)).join("\n")}\n${beforeFill.slice(recent.index + recent[0].length)}`, "utf-8");
		await enterFirstRoom();
		await openDialog();
		let releaseSave: () => void = () => {};
		const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
		await page.route("**/checkpoint/approve", async (route) => { await saveHeld; await route.continue(); });
		await dialog.getByRole("button", { name: "Save to memory" }).click({ timeout: 15000 });
		await page.goBack();
		await homeCard("Other Room").getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
		await waitUntil(async () => (await page.evaluate(() => window.location.hash)) === `#/room/${otherId}` && (await composer.isVisible().catch(() => false)), "the other room while the save is on its way");
		releaseSave();
		await waitUntil(async () => (await activeConversation()) !== conversationId, "the first room's save lands");
		await page.waitForTimeout(2500);
		await page.unroute("**/checkpoint/approve");
		assert((await page.evaluate(() => window.location.hash)) === `#/room/${otherId}` && (await composer.isVisible()) && (await homeCard("Other Room").count()) === 0, "the tab stays in the room it moved to when the first room's save lands");
		await openDialog();
		await page.waitForTimeout(800);
		assert(await dialog.getByText("Memory updated").count() === 0 && await dialog.getByRole("button", { name: "Memorize" }).count() === 0 && await dialog.getByRole("button", { name: "Generate memory proposal" }).count() === 1, "the first room's full-room page never shows in the other room");
		await page.keyboard.press("Escape");
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		fs.writeFileSync(firstRoomL1b, fs.readFileSync(firstRoomL1b, "utf-8").replace(/^### RC-09\d\d \| CLOSED \| 2026-09-11 \| Filler plan \d+\n[\s\S]*?\nNone\n\n?/gm, ""), "utf-8");
		conversationId = await activeConversation();
		await enterFirstRoom();
		await composer.fill("We moved the launch to May.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer in the first room's new conversation");
		await page.waitForTimeout(800);

		// 4c. One ordinary reviewed Save: the saved page with Keep chatting, which opens the fresh conversation.
		conversationId = await activeConversation();
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await dialog.getByText("The launch moves to May.").first().waitFor({ timeout: 20000 });
		await dialog.getByRole("button", { name: "Save to memory" }).click();
		await dialog.getByText("Memory updated").waitFor({ timeout: 15000 });
		await dialog.getByRole("button", { name: "Keep chatting" }).click();
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		await waitUntil(async () => (await composer.isVisible().catch(() => false)) && (await activeConversation()) !== conversationId, "Keep chatting opens the fresh conversation");
		assert(await page.getByText("Answer from claude-fake.").count() === 0, "the fresh conversation starts empty");
		conversationId = await activeConversation();
		await composer.fill("We moved the launch to May.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer in the fresh conversation");
		await page.waitForTimeout(800);

		// 5. Cancel from the dialog stops the provider call.
		holdRemember = true;
		const before = requests.length;
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await waitUntil(() => requests.slice(before).some((request) => request.remember), "the second Remember reaches the provider");
		const second = requests.slice(before).find((request) => request.remember)!;
		await dialog.getByRole("button", { name: "Cancel" }).click();
		await waitUntil(() => second.aborted, "Cancel closes the provider call");
		await waitUntil(async () => (await progress()).body?.state === "cancelled", "the job says cancelled");

		// 5b. A notice on the options form stands alone: the form and its buttons
		// give way, and the notice carries Close with its ways out.
		roomModels.writeRoomModels(agentId, { memory: { provider: "fake-dead", model: "dead-fake" } });
		if (!(await dialog.count())) await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		// A model nothing answers for: the wait is said as it is at once, and the notice comes after about 15 s.
		await dialog.getByText(/^Can't reach the Memory model right now\. Trying again at .+\.$/).waitFor({ timeout: 10000 });
		assert(await dialog.getByText(/is busy/).count() === 0, "the wait for a model nothing answers for never says busy");
		await dialog.locator(".model-notice").waitFor({ timeout: 30000 });
		// The notice reads as body text: the page's own size and colour, no hint bar on its left.
		const noticeLook = await dialog.locator(".model-notice").evaluate((el) => {
			const notice = getComputedStyle(el);
			const body = getComputedStyle(document.body);
			return { size: notice.fontSize, bodySize: body.fontSize, color: notice.color, bodyColor: body.color, bar: notice.borderLeftWidth };
		});
		assert(noticeLook.size === noticeLook.bodySize && noticeLook.color === noticeLook.bodyColor && noticeLook.bar === "0px", `the model notice reads as body text, got ${JSON.stringify(noticeLook)}`);
		assert(await dialog.locator("textarea").count() === 0 && await dialog.getByText("How much should this room keep?").count() === 0, "under the notice the options form is hidden");
		assert(await dialog.getByRole("button", { name: "Generate memory proposal" }).count() === 0, "under the notice Generate is hidden");
		assert(await dialog.getByRole("button", { name: "Close" }).count() === 1 && await dialog.locator(".model-notice").getByRole("button", { name: "Close" }).count() === 1, "Close is one of the notice's ways out");
		await dialog.locator(".model-notice").getByRole("button", { name: "Close" }).click();
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		roomModels.writeRoomModels(agentId, { memory: null });

		// 5c. An ordinary quick Remember (the room does not fill): the saved line in the room, and a fresh conversation.
		holdRemember = false;
		(await import("../src/persistent-room-maintenance-settings.js")).writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: true });
		conversationId = await activeConversation();
		await page.getByRole("button", { name: "Remember", exact: true }).click();
		await page.getByText(/^Saved to memory automatically\./).first().waitFor({ timeout: 20000 });
		await waitUntil(async () => (await activeConversation()) !== conversationId && (await composer.isVisible().catch(() => false)), "the quick save opens the fresh conversation");
		assert(await dialog.count() === 0, "an ordinary quick save shows no dialog");
		(await import("../src/persistent-room-maintenance-settings.js")).writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: false });
		await composer.fill("We moved the launch to May.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer after the quick save");
		await page.waitForTimeout(800);

		// 6. A Remember that fills the room: first the quick one, then the reviewed one.
		holdRemember = false;
		const l1bPath = agents.createPersistentAgentInstance(agentId).l1bCurrentPath(agents.createPersistentAgentInstance(agentId).readAgentJson());
		const scaffoldL1b = fs.readFileSync(l1bPath, "utf-8");
		const holdNineteen = (count = 19) => {
			const at = /^##\s+Recent Context\s*$/m.exec(scaffoldL1b)!;
			const entries = Array.from({ length: count }, (_, i) => `### RC-${String(i + 1).padStart(4, "0")} | CLOSED | 2026-09-18 | Earlier ${i + 1}\n\n**Session arc:** Session ${i + 1}.\n\n**Body:**\n- Point ${i + 1}.\n\n**Parked:**\nNone\n`).join("\n");
			fs.writeFileSync(l1bPath, `${scaffoldL1b.slice(0, at.index + at[0].length)}\n\n${entries}\n`, "utf-8");
		};
		const filled = /now holds 20 conversations, as many as it can/;
		const staysOnFilledPage = async (label: string) => {
			await dialog.getByText(filled).waitFor({ timeout: 20000 });
			await page.waitForTimeout(2500);
			assert(await dialog.getByText(filled).count() === 1, `${label}: the page that offers Memorize stays`);
			assert(await dialog.getByRole("button", { name: "Memorize" }).count() === 1 && await dialog.getByRole("button", { name: "Keep chatting" }).count() === 0, `${label}: Memorize, and no Keep chatting`);
			assert(await page.getByText(/cannot be opened until|Memorize them from Maintain/).count() === 0, `${label}: no bounce to Home through the refusal`);
		};
		const reenter = async () => {
			await page.reload({ waitUntil: "domcontentloaded" });
			if (await dismiss.count()) await dismiss.click();
			await enterRoom();
			await page.waitForTimeout(800);
		};
		// 5d. A reviewed save that makes 19: the heads-up shows before Save, and the saved page does not repeat it.
		const nineteenHeadsUp = "One more remembered conversation fills this room. Then Memorize before starting a new one.";
		holdNineteen(18);
		await reenter();
		await composer.fill("The venue is booked.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) >= 1, "the answer before the 19th save");
		await page.waitForTimeout(800);
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		await dialog.getByText(nineteenHeadsUp, { exact: true }).waitFor({ timeout: 20000 });
		await dialog.getByRole("button", { name: "Save to memory" }).click();
		await dialog.getByText("Memory updated", { exact: true }).waitFor({ timeout: 20000 });
		assert(await dialog.getByText(nineteenHeadsUp, { exact: true }).count() === 0, "the saved page does not repeat the heads-up the review showed");
		await dialog.getByRole("button", { name: "Return Home" }).click();
		await dialog.waitFor({ state: "detached", timeout: 10000 });
		(await import("../src/persistent-room-maintenance-settings.js")).writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: true });
		holdNineteen();
		await reenter();
		// The 19th save left a new, empty conversation: say something to remember.
		await composer.fill("The caterer is confirmed.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) >= 1, "the answer before the quick save");
		await page.waitForTimeout(800);
		const closedId = await page.evaluate(async (id) => {
			const res = await fetch(`/api/persistent-agents/${encodeURIComponent(id)}/status`);
			return (await res.json()).activeThread?.threadId as string;
		}, agentId);
		// The quick Remember without the preview says it is saving while it reads, never "Drafting".
		holdRemember = true;
		await page.getByRole("button", { name: "Remember", exact: true }).click();
		await dialog.getByText("Saving to Remember Room’s memory…").waitFor({ timeout: 15000 });
		assert(await dialog.getByText(/Remembering…|Drafting memory proposal|Nothing is saved yet/).count() === 0, "the quick save's line is the saving line, not the draft's");
		holdRemember = false;
		for (const release of held.splice(0)) release();
		await staysOnFilledPage("the quick Remember");
		// Escape on the full room's page is Return Home: nothing reaches the closed conversation, no engine words.
		const toClosed: string[] = [];
		page.on("request", (request) => { if (request.method() !== "GET" && request.url().includes(encodeURIComponent(closedId))) toClosed.push(`${request.method()} ${request.url()}`); });
		page.on("websocket", (socket) => socket.on("framesent", (frame) => { if (String(frame.payload).includes('"prompt"')) toClosed.push(`ws ${String(frame.payload).slice(0, 80)}`); }));
		await page.keyboard.press("Escape");
		await page.locator(".persistent-agent-card").filter({ hasText: "Remember Room" }).waitFor({ timeout: 10000 });
		await page.waitForTimeout(1500);
		assert(await dialog.count() === 0 && await page.locator("textarea").count() === 0, "Escape on the full room's page goes Home: no dialog, no message box");
		assert(await page.locator(".system-line.error").count() === 0 && await page.getByText(/activeThread|non-resumable|thread is closed|persistent-agent/).count() === 0, "no red line and no engine words after Escape");
		assert(await page.locator(".persistent-agent-card").filter({ hasText: "Remember Room" }).getByText(/memorize now/i).count() === 1, "Home's card says the room is full");
		assert(await page.locator(".persistent-agent-card").filter({ hasText: "Remember Room" }).getByText("Memorize from Maintain to start a new conversation.", { exact: true }).isVisible(), "the card says the way on in plain sight, not only in a tooltip");
		assert(toClosed.length === 0, `nothing is sent to the closed conversation, got ${toClosed.join(" | ")}`);
		(await import("../src/persistent-room-maintenance-settings.js")).writePersistentRoomMaintenanceSettings(agentId, { quickCheckpointAutoApply: false });
		holdNineteen();
		await reenter();
		await composer.fill("And the budget holds.");
		await composer.press("Enter");
		await waitUntil(async () => (await page.getByText("Answer from claude-fake.").count()) === 1, "the answer in the new conversation");
		await page.waitForTimeout(800);
		await openDialog();
		await dialog.getByRole("button", { name: "Generate memory proposal" }).click();
		// Before Save, the review says once that this save fills the room (it holds 19; the save makes 20).
		const fillsBefore = "This save fills Remember Room: it will hold 20 conversations, as many as it can. Then Memorize them to start a new conversation.";
		await dialog.getByText(fillsBefore, { exact: true }).waitFor({ timeout: 20000 });
		assert(await dialog.getByText(fillsBefore, { exact: true }).count() === 1, "the review says once that this save fills the room");
		// This save goes without "What happened": an absent part is saved as absent.
		await dialog.getByRole("button", { name: "Edit", exact: true }).click();
		await dialog.locator("label").filter({ hasText: "What happened" }).locator("textarea").fill("");
		await dialog.getByRole("button", { name: "Done editing" }).click();
		// The first answer to Save is lost on the way back, and the server stays out of reach a moment; then the page finds it saved by itself, and that save filled the room.
		let lost = false;
		let unreachable = true;
		await page.route("**/checkpoint/approve", async (route) => {
			if (lost) return route.continue();
			lost = true;
			await route.fetch();
			await route.abort("connectionreset");
		});
		await page.route("**/checkpoint/progress**", (route) => (unreachable ? route.abort("connectionrefused") : route.continue()));
		await dialog.getByRole("button", { name: "Save to memory" }).click({ timeout: 20000 });
		await waitUntil(() => lost, "the first save reaches the server");
		await page.waitForTimeout(1500);
		// The lost answer's line shows beside the buttons, inside the window, however long the entry.
		const failedLine = dialog.locator(".checkpoint-proposal-error");
		await failedLine.waitFor({ timeout: 10000 });
		const lineInSight = await failedLine.evaluate((line) => {
			const rect = line.getBoundingClientRect();
			const scroller = line.closest(".checkpoint-proposal-result");
			return !scroller && window.scrollY === 0 && rect.top >= 0 && rect.bottom <= window.innerHeight;
		});
		assert(lineInSight, "a lost answer's line shows next to the buttons without scrolling");
		assert(await failedLine.innerText() === "The connection dropped while saving. Checking whether it was saved…", `the line says the connection dropped, got ${JSON.stringify(await failedLine.innerText())}`);
		const again = page.waitForResponse((r) => r.url().includes("/checkpoint/approve") && r.status() === 200);
		unreachable = false;
		assert((await (await again).json()).alreadySaved === true, "the page asks again by itself, and the answer says the save had already landed");
		await staysOnFilledPage("the reviewed Remember, saved on the first try");
		await page.unroute("**/checkpoint/approve");
		await page.unroute("**/checkpoint/progress**");
		await dialog.getByRole("button", { name: "Memorize" }).click();
		const workflow = page.locator('[aria-label="Memory absorption workflow"]');
		await workflow.waitFor({ timeout: 10000 });

		// 7. The whole ordinary Memorize in the page: the first read, Continue, the run, Save, the saved screen.
		await workflow.getByRole("button", { name: "Continue →" }).click({ timeout: 60000 });
		const saveRun = workflow.getByRole("button", { name: /^Save (to memory|over the budget)$/ });
		await waitUntil(async () => (await saveRun.count()) === 1 && (await saveRun.isEnabled()), "the run's card offers Save once every conversation is read", 180000);
		await saveRun.click();
		// Save asks once, in the page: Keep reading or Save.
		await page.getByRole("dialog").filter({ hasText: "Save these notes to Remember Room's memory?" }).getByRole("button", { name: "Save", exact: true }).click({ timeout: 10000 });
		await workflow.getByRole("heading", { name: /^Remember Room memorized \d+ conversations?$/ }).waitFor({ timeout: 30000 });
		console.log("  ok  an ordinary Memorize runs to its saved screen in the page");
		await ctx.close();
	} finally {
		await browser.close();
	}
	console.log("remember dialog smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-6000));
	throw error;
} finally {
	for (const release of held.splice(0)) release();
	try { (providers as any).closeAllConnections?.(); } catch {}
	try { providers.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
