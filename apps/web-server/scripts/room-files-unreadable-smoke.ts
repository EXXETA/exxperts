// A room that can't read its own files says so in plain words, against a real
// server: a message over the room's socket is refused with the code
// room_files_unreadable, whether the state file or the conversation's record
// is unreadable; Remember is refused the same way, in its own words, never as
// "went on in another window"; and in the page a message refused before the
// room began the turn goes back into an empty box, its line saying so, while a
// box holding other text keeps it and the message stays above. ONLY=wire,
// remember, page, box or settings runs one part. Offline: a synthetic model
// that is never called. Throwaway HOME.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";
import { authedFetch, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, type AuthedFetchInit } from "./smoke-server-process.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const only = process.env.ONLY;
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-files-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
// A model to enter a room with; every message here is refused before it, so its address answers nothing.
const appDir = path.join(tempHome, ".exxperts", "app");
fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: "http://127.0.0.1:9/v1", api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 128000, maxTokens: 16384 }] } } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "openai-compatible": { type: "api_key", key: "synthetic-files-key" } }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" }, null, 2), { mode: 0o600 });
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2), { mode: 0o600 });

const MESSAGE_LINE = "The room could not read its own files, so your message was not sent. Nothing was lost. Try again; if it repeats, restart exxperts.";
const MESSAGE_BACK_LINE = "The room could not read its own files, so your message was not sent. Your message is back in the box. Try again; if it repeats, restart exxperts.";
const REMEMBER_LINE = "The room could not read its own files, so Remember did not start. Nothing was saved. Generate again; if it repeats, restart exxperts.";
const SETTINGS_LINE = "The room could not apply its new settings, so your message was not sent. Nothing was lost. Try again; if it repeats, restart exxperts.";
const SETTINGS_BACK_LINE = "The room could not apply its new settings, so your message was not sent. Your message is back in the box. Try again; if it repeats, restart exxperts.";

async function api(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}

async function waitUntil(predicate: () => Promise<boolean> | boolean, label: string, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await predicate()) return;
		await new Promise((resolve) => setTimeout(resolve, 100));
	}
	throw new Error(`timed out waiting until ${label}`);
}

async function createRoom(displayName: string): Promise<string> {
	const created = await api("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	assert(created.status === 201, `${displayName} is created, got ${created.status}`);
	return String(created.body?.agent?.id ?? "");
}

// The room's open conversation, written as the page writes it when a room is entered.
async function openConversation(agentId: string, conversationId: string, items: unknown[] = []): Promise<void> {
	const saved = await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/threads/${conversationId}`, { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: { provider: "openai-compatible", model: "room-model" }, items }) });
	assert(saved.status === 200, `the conversation is open, got ${saved.status} ${JSON.stringify(saved.body)}`);
}

function roomFiles(agentId: string, conversationId: string): Array<[string, string]> {
	const runtime = path.join(agentsRoot, agentId, "runtime");
	return [["state file", path.join(runtime, "state.json")], ["conversation record", path.join(runtime, "threads", `${conversationId}.json`)]];
}

// Leaves the file unreadable while `run` goes, then puts it back as it was.
async function withUnreadable<T>(file: string, run: () => Promise<T>): Promise<T> {
	const kept = fs.readFileSync(file, "utf-8");
	fs.writeFileSync(file, "{ not json");
	try {
		return await run();
	} finally {
		fs.writeFileSync(file, kept);
	}
}

let server: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
try {
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	server.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 30_000);

	// 1. Over the room's socket: the refusal carries its code, for either file.
	if (!only || only === "wire") {
		const agentId = await createRoom("Wire Desk");
		const conversationId = `wire_${Date.now().toString(36)}`;
		await openConversation(agentId, conversationId);
		const WebSocketImpl: any = (await import("ws")).default;
		const frames: any[] = [];
		const socket = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${agentId}&conversationId=${conversationId}&modelProvider=openai-compatible&model=room-model`, { headers: { ...SMOKE_AUTH_HEADERS } });
		socket.addEventListener("message", (event: { data: unknown }) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
		await new Promise<void>((resolve, reject) => { socket.addEventListener("open", () => resolve()); socket.addEventListener("error", () => reject(new Error("the room's socket failed to connect"))); });
		try {
			await waitUntil(() => frames.some((frame) => frame.type === "ready"), "the room's socket is ready");
			for (const [label, file] of roomFiles(agentId, conversationId)) {
				const refused = await withUnreadable(file, async () => {
					const from = frames.length;
					socket.send(JSON.stringify({ type: "prompt", text: `A message while the ${label} is unreadable.` }));
					await waitUntil(() => frames.slice(from).some((frame) => frame.type === "error"), `the message is refused with the ${label} unreadable`);
					return frames.slice(from).find((frame) => frame.type === "error");
				});
				assert(refused.message === MESSAGE_LINE, `with the ${label} unreadable the room says it could not read its own files, got ${JSON.stringify(refused.message)}`);
				assert(refused.code === "room_files_unreadable", `with the ${label} unreadable the refusal carries its code, got ${JSON.stringify(refused)}`);
			}
		} finally {
			socket.close();
		}
		console.log("  ok  a message refused for an unreadable state file or conversation record carries room_files_unreadable");
	}

	// 2. Remember: in its own words, and the room is not locked as moved.
	if (!only || only === "remember") {
		const agentId = await createRoom("Remember Desk");
		const conversationId = `remember_${Date.now().toString(36)}`;
		await openConversation(agentId, conversationId, [{ kind: "user", id: "synthetic-user", text: "Something worth keeping." }, { kind: "assistant", id: "synthetic-answer", text: "Noted." }]);
		for (const [label, file] of roomFiles(agentId, conversationId)) {
			const refused = await withUnreadable(file, () => api(`/api/persistent-agents/${encodeURIComponent(agentId)}/checkpoint/propose`, { method: "POST", body: JSON.stringify({ conversationId, background: true }) }));
			assert(refused.status === 409 && refused.body?.code === "room_files_unreadable" && refused.body?.error === REMEMBER_LINE, `Remember with the ${label} unreadable says the room could not read its own files, got ${refused.status} ${JSON.stringify(refused.body)}`);
		}
		console.log("  ok  Remember with an unreadable state file or conversation record says so, not moved");
	}

	const chromiumPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (only && !["page", "box", "settings"].includes(only)) {
		// The page's parts were not asked for.
	} else if (!chromiumPath || !fs.existsSync(chromiumPath)) {
		console.log("  the page's parts skipped (Chromium not installed)");
	} else {
		const agentId = await createRoom("Page Desk");
		const browser = await chromium.launch();
		try {
			const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
			// The room's socket, passed through; a part may hold the next message back, or answer it as the server would.
			const wire: { holdNext: boolean; held: string | null; answerNext: Record<string, unknown> | null; upstream: { send(message: string): void } | null } = { holdNext: false, held: null, answerNext: null, upstream: null };
			await page.routeWebSocket(/\/ws\?/, (ws) => {
				const upstream = ws.connectToServer();
				wire.upstream = upstream;
				ws.onMessage((message) => {
					const text = String(message);
					const isPrompt = (() => { try { return JSON.parse(text)?.type === "prompt"; } catch { return false; } })();
					if (isPrompt && wire.answerNext) {
						ws.send(JSON.stringify(wire.answerNext));
						wire.answerNext = null;
						return;
					}
					if (isPrompt && wire.holdNext) {
						wire.held = text;
						wire.holdNext = false;
						return;
					}
					upstream.send(text);
				});
				upstream.onMessage((message) => ws.send(message));
			});
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Page Desk" }).getByRole("button", { name: /^(Enter|Resume) →$/ }).click();
			await page.locator('button[title="Send"], .stop-btn').first().waitFor({ timeout: 15_000 });
			await page.waitForLoadState("networkidle");
			await page.waitForTimeout(800);
			const conversationId = String((await api(`/api/persistent-agents/${encodeURIComponent(agentId)}/status`)).body?.activeThread?.threadId ?? "");
			assert(conversationId, "the page opened a conversation");
			const [, stateFile] = roomFiles(agentId, conversationId)[0];
			const composer = page.locator("textarea").first();
			// The line shows its cause and the rest as two blocks; read it as one sentence run.
			const errorLines = async () => (await page.locator(".system-line.error").allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
			const bubbles = (text: string) => page.locator(".bubble-row.user", { hasText: text }).count();
			const send = async (text: string) => {
				await composer.fill(text);
				await composer.press("Enter");
			};
			// The page saves the conversation after each change, which writes both files again: its saves wait while a file is unreadable.
			const saves: { held: boolean; waiting: Array<() => void> } = { held: false, waiting: [] };
			await page.route(/\/api\/persistent-agents\/[^/]+\/threads\/[^/?]+$/, (route) => {
				if (saves.held && route.request().method() === "PUT") saves.waiting.push(() => void route.continue());
				else void route.continue();
			});
			const unreadableWhile = async (file: string, run: () => Promise<void>): Promise<void> => {
				saves.held = true;
				try {
					await withUnreadable(file, run);
				} finally {
					saves.held = false;
					for (const go of saves.waiting.splice(0)) go();
				}
			};

			// 3. A refused message goes back into the empty box, and its line says so.
			if (!only || only === "page") {
				const before = (await errorLines()).length;
				await unreadableWhile(stateFile, async () => {
					await send("Plan the week.");
					await waitUntil(async () => (await errorLines()).length > before, "the refusal is shown");
				});
				await page.waitForTimeout(300);
				assert((await errorLines()).at(-1) === MESSAGE_BACK_LINE, `the line says the message is back in the box, got ${JSON.stringify((await errorLines()).at(-1))}`);
				assert((await composer.inputValue()) === "Plan the week.", `the message is back in the box, got ${JSON.stringify(await composer.inputValue())}`);
				assert((await bubbles("Plan the week.")) === 0, "its bubble is gone, so sending it again makes one");
				await composer.fill("");
				console.log("  ok  a message refused before the turn began is back in the empty box, and its line says so");
			}

			// 4. With other text in the box, that text stays, and so does the message above.
			if (!only || only === "box") {
				const before = (await errorLines()).length;
				await unreadableWhile(stateFile, async () => {
					wire.holdNext = true;
					await send("Draft the agenda.");
					await waitUntil(() => wire.held !== null, "the message is held on its way");
					await composer.fill("Something else.");
					wire.upstream?.send(String(wire.held));
					wire.held = null;
					await waitUntil(async () => (await errorLines()).length > before, "the refusal is shown");
				});
				await page.waitForTimeout(300);
				assert((await errorLines()).at(-1) === MESSAGE_LINE, `the line keeps "Nothing was lost.", got ${JSON.stringify((await errorLines()).at(-1))}`);
				assert((await composer.inputValue()) === "Something else.", `the box keeps what was typed in it, got ${JSON.stringify(await composer.inputValue())}`);
				assert((await bubbles("Draft the agenda.")) === 1, "the message stays above");
				await composer.fill("");
				console.log("  ok  with other text in the box, the box keeps it and the message stays above");
			}

			// 5. The new settings could not be applied: the same hand-back, and the raw error is never shown.
			if (!only || only === "settings") {
				const before = (await errorLines()).length;
				wire.answerNext = { type: "error", code: "room_settings_not_applied", message: SETTINGS_LINE, details: "EACCES: permission denied, open '/synthetic/L1a.md'" };
				await send("Sum up the notes.");
				await waitUntil(async () => (await errorLines()).length > before, "the refusal is shown");
				await page.waitForTimeout(300);
				assert((await errorLines()).at(-1) === SETTINGS_BACK_LINE, `the settings line says the message is back in the box, got ${JSON.stringify((await errorLines()).at(-1))}`);
				assert((await composer.inputValue()) === "Sum up the notes.", `the message is back in the box, got ${JSON.stringify(await composer.inputValue())}`);
				assert((await bubbles("Sum up the notes.")) === 0, "its bubble is gone");
				assert(!(await page.locator("body").innerText()).includes("EACCES"), "the raw error is never shown");
				await composer.fill("");
				console.log("  ok  a message the new settings could not take is back in the box, and the raw error is not shown");
			}
		} finally {
			await browser.close();
		}
	}
	console.log("room-files-unreadable smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
