// The Claude 4 models left the curated Claude list (Opus 4.8, 4.7 and 4.6,
// Sonnet 4.6, Haiku 4.5); their catalogue rows and names stay. This smoke
// takes one of them, Opus 4.8, and proves end to end, under a synthetic
// Claude sign-in whose requests reach a local fake of the Anthropic API:
// - a conversation started on it keeps its lock and keeps answering;
// - a room set on it refuses a new conversation: the empty conversation a
//   Remember leaves waits with the one notice above the box and Choose
//   another model, and goes on by itself once another model is picked, with
//   the draft kept and no "Connected again."; a room with no open
//   conversation waits on Home, Enter's title carrying the sentence, and
//   enters once another model is picked;
// - Remember, Memorize and Review with it as the Memory model end in the
//   shared notice, which names the model and says nothing was lost;
// - a scheduled run in that room is refused with the room's sentence;
// - a specialist asked for with it as the Memory model refuses with the
//   room's sentence, the same to the chat and to the room's model;
// - AI setup's default set to it says so and points to Settings, AI setup.
// The rest of the removed models are checked to be off the list and still in
// the catalogue.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

function pass(label: string): void {
	console.log(`  ok  ${label}`);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way remote-settings-readonly-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room removed claude model smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = 27000 + Math.floor(Math.random() * 10000);
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-removed-claude-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
const threadCwd = path.join(tempRoot, "cwd");
for (const dir of [agentsRoot, agentDir, threadCwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const REMOVED_IDS = ["claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5"];
const REMOVED = { provider: "anthropic", model: "claude-opus-4-8" };
const CURRENT = { provider: "anthropic", model: "claude-opus-5-5" };
const requests: string[] = [];

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// The Anthropic API, as far as a turn needs it: every request answers with
// the model it was sent to. A message asking for a deck is answered with the
// delegate_task call that quotes it; the tool's result is kept.
const DECK_REQUEST = "Make me a deck about the kickoff.";
const delegateResults: string[] = [];
const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		requests.push(String(body.model));
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 1 } } });
		const last = Array.isArray(body.messages) ? body.messages[body.messages.length - 1] : undefined;
		const parts: any[] = Array.isArray(last?.content) ? last.content : [{ type: "text", text: String(last?.content ?? "") }];
		const toolResult = parts.find((part) => part?.type === "tool_result");
		if (toolResult) delegateResults.push((Array.isArray(toolResult.content) ? toolResult.content : [{ text: toolResult.content }]).map((part: any) => String(part?.text ?? "")).join("\n"));
		else if (parts.some((part) => part?.type === "text" && String(part.text).includes(DECK_REQUEST))) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "toolu_deck", name: "delegate_task", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ template: "deck", brief: "A deck about the kickoff.", userRequest: DECK_REQUEST }) } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Answer from ${body.model}.` } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
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

async function api(pathname: string, init: { method?: string; body?: unknown } = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { method: init.method ?? "GET", headers: init.body === undefined ? {} : { "content-type": "application/json" }, ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }) });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

const WebSocketImpl: any = (await import("ws")).default;

// The first frame of a session bind: "ready", or "error" when refused.
async function firstSessionFrame(agentId: string, conversationId: string): Promise<Record<string, any>> {
	const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frame = await new Promise<Record<string, any>>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(`no frame from the session bind for ${conversationId}`)), 20_000);
		socket.addEventListener("message", (event: { data: unknown }) => {
			try {
				const parsed = JSON.parse(String(event.data));
				if (parsed.type === "ready" || parsed.type === "error") {
					clearTimeout(timer);
					resolve(parsed);
				}
			} catch {}
		});
		socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("websocket failed to connect")); });
	});
	try { socket.close(); } catch {}
	return frame;
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	// The built-in Claude provider, its catalogue untouched, sent to the fake.
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { anthropic: { baseUrl: `http://127.0.0.1:${providerPort}` } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "anthropic" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const profiles = await import("../src/persistent-agent-ai-profiles.js");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

	// A room set on the removed model, with a conversation started on it as an
	// earlier build wrote it: a standby thread with a real turn.
	function roomOnRemovedModel(displayName: string, conversationId?: string): string {
		const agentId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(agentId, { conversation: REMOVED, memory: REMOVED });
		if (conversationId) {
			const created = agents.writePersistentAgentThread(agentId, conversationId, { state: "standby", origin: "home", model: REMOVED, items: [{ kind: "user", id: "u1", text: "Earlier question." }, { kind: "assistant", id: "a1", text: "Earlier answer." }] }, {
				createRuntime: ({ model }) => agents.createPersistentAgentPiSessionJsonlThreadRuntime({ agentId, threadId: conversationId, model, cwd: threadCwd }),
				allowInactiveProfileModel: true,
			});
			const seed = agents.openPersistentAgentPiSessionManager(agentId, created.thread.runtime as any, threadCwd);
			seed.appendMessage({ role: "user", content: [{ type: "text", text: "Earlier question." }], timestamp: Date.now() } as any);
			seed.appendMessage({ role: "assistant", content: [{ type: "text", text: "Earlier answer." }], api: "anthropic-messages", provider: REMOVED.provider, model: REMOVED.model, usage, stopReason: "stop", timestamp: Date.now() } as any);
		}
		return agentId;
	}
	const startedRoom = roomOnRemovedModel("Started On Opus 4.8", "c_started_on_removed");
	const emptyRoom = roomOnRemovedModel("Empty On Opus 4.8");
	const rememberRoom = roomOnRemovedModel("Remembered On Opus 4.8", "c_remember_on_removed");

	// --- A scheduled run in a room set on it ------------------------------------------------
	let scheduled: unknown = null;
	try { roomModels.resolveScheduledRoomModel(startedRoom); } catch (error) { scheduled = error; }
	assert(scheduled instanceof roomModels.RoomModelUnavailableError && scheduled.code === "room_model_unavailable" && /^This room's model, Claude Opus 4\.8, is no longer offered\. Choose another model in Room settings, Model\.$/.test(scheduled.message), `a scheduled run is refused with the room's sentence, got ${String(scheduled)}`);
	pass("a scheduled run in a room set on Opus 4.8 is refused with the sentence that names it");

	// --- The list and the catalogue ------------------------------------------------------------
	const { getModel } = await import("@exxeta/exxperts-ai");
	for (const id of REMOVED_IDS) {
		assert(!profiles.isPersistentRoomModelForProfile("anthropic", "anthropic", id), `${id} is off the curated Claude list`);
		assert(!roomModels.isRoomModelOffered({ provider: "anthropic", model: id }, "conversation"), `${id} is offered to no new conversation`);
		assert(getModel("anthropic" as any, id as any)?.id === id, `${id} keeps its catalogue row, so a conversation on it still runs`);
	}
	pass("the five Claude 4 models are off the list and keep their catalogue rows");

	// --- Remember leaves an empty conversation on the old lock ----------------------------
	// Approval never invokes a model; with the room's pick unable to run, the
	// server resolves no fresh model, so the fresh conversation inherits the
	// old lock (resolveBoundaryFreshThreadModel), as here.
	assert(roomModels.resolveRoomModel(rememberRoom, "conversation").effective === null, "the room set on the removed model has no model to run");
	const rememberThread = agents.getPersistentAgentThread(rememberRoom, "c_remember_on_removed")!;
	const proposal = await agents.buildCheckpointProposal({ agentId: rememberRoom, conversationId: "c_remember_on_removed", model: REMOVED, density: "standard", items: [{ kind: "user", text: "Earlier question." }], runtimeCwd: threadCwd }, async () => ({
		text: "TITLE:\nEarlier question\n\nSESSION_ARC:\nA turn on Opus 4.8.\n\nBODY:\n- The question was asked on Opus 4.8.\n\nPARKED:\nNone\n",
		usage: { input: 1, output: 1, totalTokens: 2, cost: 0 },
	}));
	const parsed = agents.parseCheckpointApprovalRequest({
		conversationId: rememberThread.threadId,
		model: REMOVED,
		density: proposal.density,
		proposal,
		approvedRecentContext: "### RC-DRAFT | CLOSED | 2026-10-12 | Earlier question\n\n**Session arc:** A turn on Opus 4.8.\n\n**Body:**\n- The question was asked on Opus 4.8.\n\n**Parked:**\nNone\n",
	}, rememberRoom);
	const checkpoint = agents.writeApprovedCheckpoint(parsed.request, parsed.warnings, new Date(), { runtimeCwd: threadCwd });
	const afterRemember = checkpoint.postCheckpoint.activeThreadId;
	assert(agents.getPersistentAgentThread(rememberRoom, afterRemember)?.model.model === REMOVED.model, "the empty conversation after Remember was prepared on the old lock");
	assert(agents.getPersistentAgentThread(rememberRoom, "c_remember_on_removed")?.model.model === REMOVED.model, "the remembered conversation keeps its lock");

	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const afterRememberBind = await firstSessionFrame(rememberRoom, afterRemember);
	assert(afterRememberBind.type === "error" && afterRememberBind.code === "room_model_unavailable" && /^This room's model, Claude Opus 4\.8, is no longer offered\./.test(String(afterRememberBind.message)), `the empty conversation after Remember waits with the room instead of binding on the old lock, got ${JSON.stringify(afterRememberBind)}`);
	const memoryFiles = (fs.readdirSync(path.join(agentsRoot, rememberRoom), { recursive: true }) as string[]).filter((name) => name.endsWith(".md"));
	assert(memoryFiles.some((name) => fs.readFileSync(path.join(agentsRoot, rememberRoom, name), "utf-8").includes("The question was asked on Opus 4.8.")), "the remembered conversation landed in the room's memory");
	pass("after Remember the empty conversation waits with the room, and what was remembered is kept");

	// --- Remember, Memorize and Review with it as the Memory model -------------------------
	const notice = "Claude Opus 4.8 is no longer offered. Nothing was lost.";
	const rememberWork = await api(`/api/persistent-agents/${startedRoom}/checkpoint/estimate?conversationId=c_started_on_removed`);
	const memorizeWork = await api(`/api/persistent-agents/${startedRoom}/absorb/assess`, { method: "POST", body: {} });
	const reviewWork = await api(`/api/persistent-agents/${startedRoom}/review/assess`, { method: "POST", body: {} });
	for (const [label, work] of [["Remember", rememberWork], ["Memorize", memorizeWork], ["Review", reviewWork]] as const) {
		assert(work.body?.code === "model_unreachable" && work.body.details?.detail === "not-offered" && work.body.error === notice, `${label} ends in the shared notice, got ${work.status} ${JSON.stringify(work.body)}`);
	}
	const { modelNoticeFromError } = await import(new URL("../../web-ui/src/components/model-notice.tsx", import.meta.url).href) as { modelNoticeFromError(error: unknown): { detail: string; sentence: string } | null };
	const { ApiRequestError } = await import("../../web-ui/src/api.js");
	const shown = modelNoticeFromError(new ApiRequestError(rememberWork.body.error, rememberWork.status, rememberWork.body.code, rememberWork.body.details));
	assert(shown?.detail === "not-offered" && shown.sentence === notice, `the screens read it as the not-offered notice (Try again, Choose another model), got ${JSON.stringify(shown)}`);
	pass("Remember, Memorize and Review with Opus 4.8 as the Memory model end in the one shared notice");

	// --- A specialist task with it as the Memory model ----------------------------------------
	// The room talks on Opus 5.5; the specialist would run on the Memory model.
	const delegateRoom = agents.createPersistentAgentFromScaffoldInput({ displayName: "Delegates On Opus 4.8 Memory", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	roomModels.writeRoomModels(delegateRoom, { conversation: CURRENT, memory: REMOVED });
	const seeded = await api(`/api/persistent-agents/${delegateRoom}/threads/c_delegate`, { method: "PUT", body: { state: "active", origin: "launcher", model: CURRENT, items: [] } });
	assert(seeded.status === 200, `the conversation opens on Opus 5.5, got ${seeded.status} ${JSON.stringify(seeded.body)}`);
	const delegateSocket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${delegateRoom}&conversationId=c_delegate&modelProvider=${CURRENT.provider}&model=${CURRENT.model}&reattach=1`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const delegateFrames: any[] = [];
	delegateSocket.addEventListener("message", (event: { data: unknown }) => { try { delegateFrames.push(JSON.parse(String(event.data))); } catch {} });
	try {
		await new Promise<void>((resolve, reject) => { delegateSocket.addEventListener("open", () => resolve()); delegateSocket.addEventListener("error", () => reject(new Error("the room's socket did not open"))); });
		await waitUntil(() => delegateFrames.some((frame) => frame.type === "ready"), "the room is ready");
		delegateSocket.send(JSON.stringify({ type: "prompt", text: DECK_REQUEST }));
		await waitUntil(() => delegateResults.length > 0 && delegateFrames.some((frame) => frame?.type === "event" && frame.event?.type === "agent_end"), "the turn ends", 30_000);
	} finally {
		try { delegateSocket.close(); } catch {}
	}
	const specialistLine = "This room's memory model, Claude Opus 4.8, is no longer offered. Choose another Memory model in Room settings, Model.";
	const shownResult = delegateFrames.find((frame) => frame?.type === "event" && frame.event?.type === "message_end" && frame.event.message?.role === "toolResult")?.event.message;
	const shownText = (shownResult?.content ?? []).filter((part: any) => part?.type === "text").map((part: any) => part.text).join("\n");
	assert(shownText === specialistLine, `the chat reads the plain sentence, got ${JSON.stringify(shownText)}`);
	assert(delegateResults[0] === specialistLine, `the room's model reads the same sentence, got ${JSON.stringify(delegateResults[0])}`);
	assert(!delegateFrames.some((frame) => frame.type === "task_started"), "no specialist started");
	pass("a specialist asked for in a room with Opus 4.8 as the Memory model refuses with the plain sentence, to the chat and the room's model");

	const browser = await chromium.launch();
	try {
		const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
		// Every appearance of "Connected again." counts, however briefly it shows.
		await ctx.addInitScript(() => {
			(window as any).__connectedAgain = 0;
			document.addEventListener("DOMContentLoaded", () => new MutationObserver(() => {
				if (document.body.innerText.includes("Connected again.")) (window as any).__connectedAgain += 1;
			}).observe(document.body, { childList: true, subtree: true, characterData: true }));
		});
		const page = await ctx.newPage();
		const connectedAgain = () => page.evaluate(() => (window as any).__connectedAgain as number);
		await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
		await page.waitForLoadState("networkidle");
		const dismiss = page.locator(".whats-new-foot .btn-primary");
		if (await dismiss.count()) await dismiss.click();

		// --- A conversation started on it keeps answering ------------------------------------
		await page.locator(".persistent-agent-card").filter({ hasText: "Started On Opus 4.8" }).getByRole("button", { name: "Resume →" }).click();
		const composer = page.locator("textarea").first();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		await page.waitForTimeout(800);
		await composer.fill("Still there?");
		await composer.press("Enter");
		await page.getByText("Answer from claude-opus-4-8.").waitFor({ timeout: 20000 });
		assert(requests[requests.length - 1] === REMOVED.model, `the turn ran on the conversation's own lock, got ${JSON.stringify(requests)}`);
		assert((await page.locator(".room-model-notice").count()) === 0, "a started conversation shows no notice");
		assert((await page.getByText("Earlier answer.").count()) === 1, "the earlier turn is still there");
		pass("a conversation started on Opus 4.8 keeps its lock and keeps answering");

		// --- The empty conversation a Remember left, in a room set on it ----------------------
		const banner = page.locator(".room-model-notice");
		async function pickCurrentModel(): Promise<void> {
			await page.locator(".room-model-section").waitFor({ timeout: 10000 });
			await page.locator(".room-model-section").getByRole("button", { name: /^Conversation model: / }).click();
			await page.getByRole("option", { name: /Opus 5\.5/ }).first().click();
			// The first match is the default, Opus 5.5: picking it is a way out too.
		}
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		let requestsBefore = requests.length;
		await page.locator(".persistent-agent-card").filter({ hasText: "Remembered On Opus 4.8" }).getByRole("button", { name: "Enter →" }).click();
		await banner.waitFor({ timeout: 15000 });
		assert((await banner.innerText()).startsWith("Claude Opus 4.8 is no longer offered. Choose another model to continue."), `the notice names the model, got ${JSON.stringify(await banner.innerText())}`);
		assert((await banner.getByRole("button").allInnerTexts()).join("|") === "Choose another model", `the one way out is Choose another model, got ${JSON.stringify(await banner.getByRole("button").allInnerTexts())}`);
		assert((await page.getByRole("button", { name: "Reconnect" }).count()) === 0 && (await page.locator('button[title="Waiting for the connection"]').count()) === 1, "no Reconnect, and Send waits");
		await composer.fill("A draft written while the room waits.");
		await banner.getByRole("button", { name: "Choose another model" }).click();
		await pickCurrentModel();
		await waitUntil(async () => (await api(`/api/persistent-agents/${rememberRoom}/models`)).body?.models?.conversation?.effective?.model === CURRENT.model, "the room runs on the new pick");
		await page.keyboard.press("Escape");
		await page.locator(".room-model-section").waitFor({ state: "detached", timeout: 10000 });
		await banner.waitFor({ state: "detached", timeout: 15000 });
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		assert(requests.length === requestsBefore, "nothing ran while the room waited");
		assert((await composer.inputValue()) === "A draft written while the room waits.", `the draft is kept, got ${JSON.stringify(await composer.inputValue())}`);
		await page.waitForTimeout(800);
		assert(await connectedAgain() === 0, `a model picked from the notice brings no "Connected again.", it showed ${await connectedAgain()} time(s)`);
		await composer.press("Enter");
		await page.getByText("Answer from claude-opus-5-5.").waitFor({ timeout: 20000 });
		assert(requests[requests.length - 1] === CURRENT.model, `the conversation runs on the new pick, got ${JSON.stringify(requests)}`);
		assert((await api(`/api/persistent-agents/${rememberRoom}/threads/c_remember_on_removed`)).body?.thread?.model?.model === REMOVED.model, "the remembered conversation keeps its lock");
		pass("after Remember, the empty conversation waits with the notice and Choose another model, then goes on by itself on the new pick, with the draft kept");

		// --- A room set on it with no open conversation -------------------------------------
		await page.goto(`${baseUrl}/`);
		await page.waitForLoadState("networkidle");
		requestsBefore = requests.length;
		const card = page.locator(".persistent-agent-card").filter({ hasText: "Empty On Opus 4.8" });
		const enter = card.getByRole("button", { name: "Enter →" });
		await enter.waitFor({ timeout: 15000 });
		assert(await enter.isDisabled(), "Enter waits while the room's model cannot run");
		assert(/^This room's model, Claude Opus 4\.8, is no longer offered\. Choose another model in Room settings, Model\.$/.test(String(await enter.getAttribute("title"))), `Enter's title carries the sentence, got ${JSON.stringify(await enter.getAttribute("title"))}`);
		assert((await card.locator(".card-model-label-name").innerText()) === "Claude Opus 4.8", `the card still names the room's model, got ${JSON.stringify(await card.locator(".card-model-label-name").innerText())}`);
		await card.locator(".card-model-label").click();
		await pickCurrentModel();
		await waitUntil(async () => (await api(`/api/persistent-agents/${emptyRoom}/models`)).body?.models?.conversation?.effective?.model === CURRENT.model, "the room runs on the new pick");
		await page.keyboard.press("Escape");
		await page.locator(".room-model-section").waitFor({ state: "detached", timeout: 10000 });
		await waitUntil(async () => !(await enter.isDisabled()), "Enter is back");
		await enter.click();
		await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		assert(requests.length === requestsBefore, "nothing ran while the room waited");
		await page.waitForTimeout(800);
		await composer.fill("Hello.");
		await composer.press("Enter");
		await page.getByText("Answer from claude-opus-5-5.").waitFor({ timeout: 20000 });
		assert(requests[requests.length - 1] === CURRENT.model, `the new conversation runs on the new pick, got ${JSON.stringify(requests)}`);
		const started = await api(`/api/persistent-agents/${startedRoom}/threads/c_started_on_removed`);
		assert(started.body?.thread?.model?.model === REMOVED.model && started.body.thread.state !== "closed", "the conversation started on Opus 4.8 is untouched");
		pass("a room set on Opus 4.8 with no open conversation waits on Home with the sentence, and enters on the new pick once it is chosen");
		await ctx.close();
	} finally {
		await browser.close();
	}

	// --- AI setup's default set to it --------------------------------------------------------
	roomModels.writeAiDefaults({ conversation: REMOVED, memory: REMOVED });
	const defaults = await api("/api/ai/defaults");
	for (const task of ["conversation", "memory"] as const) {
		const row = defaults.body?.defaults?.[task];
		assert(row?.reason === "not-offered" && row.effective === null && new RegExp(`^The default ${task === "memory" ? "memory model" : "model"}, Claude Opus 4\\.8, is no longer offered\\. Choose another default in Settings, AI setup\\.$`).test(row.refusal), `the ${task} default names the model and points to AI setup, got ${JSON.stringify(row)}`);
	}
	const onDefault = agents.createPersistentAgentFromScaffoldInput({ displayName: "On The Default", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const refused = await api(`/api/persistent-agents/${onDefault}/threads/c_on_default`, { method: "PUT", body: { state: "active", origin: "launcher", items: [] } });
	assert(refused.status === 409 && refused.body?.code === "room_model_unavailable" && /Claude Opus 4\.8, is no longer offered\./.test(refused.body.error), `a room on that default refuses a new conversation with the sentence, got ${refused.status} ${JSON.stringify(refused.body)}`);
	const repick = await api("/api/ai/defaults", { method: "PUT", body: { conversation: REMOVED } });
	assert(repick.status >= 400, `AI setup does not take a removed model as the default, got ${repick.status} ${JSON.stringify(repick.body)}`);
	pass("a default set to Opus 4.8 says so and points to Settings, AI setup; a room on it refuses a new conversation");

	console.log("room-removed-claude-model smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").split("\n").filter((line) => !line.includes("token=")).join("\n").slice(-6000));
	throw error;
} finally {
	try { (provider as any).closeAllConnections?.(); } catch {}
	try { provider.close(); } catch {}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
