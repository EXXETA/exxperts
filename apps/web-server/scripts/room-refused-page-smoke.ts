// A room the server refuses, in the browser, on a stand-in for a shared server.
// A small door in front of the real server answers a room's routes and its live
// connection with the refusal, as a shared server's own door would: the page
// shows the answer's sentence and "Back to rooms", with no box, and stops
// trying, on a first open and on a reconnect. A lost connection and another 403
// go on as before. Each row prints how many requests reached the door for its
// room, and every row runs, so a failing run still shows the counts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { chromium, type BrowserContext, type BrowserContextOptions, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const waitUntil = waitEvery(150);
const waitForASecondWithoutChange = waitEvery(1000);

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// A machine without Chromium cannot run a browser assertion at all; skip
// whole, the same way forget-no-reconnect-smoke does.
{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("room refused page smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const REFUSED_SENTENCE = "This stand-in room is closed to you, in the stand-in door's own words.";
const OTHER_SENTENCE = "The stand-in door refuses this for another reason.";
const REFUSED = { error: REFUSED_SENTENCE, code: "room_not_yours" };
const OTHER_403 = { error: OTHER_SENTENCE, code: "another_refusal" };
// The page's retries on a shared server start at about a second and double, each
// spread by half: this window holds at least one of them, however far they got.
const QUIET_MS = 8_000;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const frontPort = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const frontUrl = `http://127.0.0.1:${frontPort}`;

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-refused-"));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
const appDir = path.join(tempHome, ".exxperts", "app");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

// A synthetic provider that speaks the Anthropic stream.
const provider = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const model = String(JSON.parse(raw || "{}").model);
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: "msg_1", type: "message", role: "assistant", model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 100, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } });
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Answer from the model." } });
		sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
		sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 20 } });
		sse(res, "message_stop", { type: "message_stop" });
		res.end();
	});
});

// The door: each room's answer, every request that reached it for a room, and
// the live connections it passed on.
const doors = new Map<string, typeof REFUSED | typeof OTHER_403>();
const requestsFor = new Map<string, string[]>();
const countFor = (room: string) => requestsFor.get(room)?.length ?? 0;
const passedSockets = new Set<net.Socket>();
const refusedUpgrades: string[] = [];
let serverDown = false;
let sharedServer = true;
// A room whose refusal waits until a row lets it go, for an answer that comes late.
let heldRoom: string | null = null;
let letHeldAnswerGo: (() => void) | null = null;
let contextReads = 0;
// What a row changes in the room list on its way to the page.
let shapeList: ((rows: any[]) => any[]) | null = null;

function noteRequest(room: string, request: string): void {
	requestsFor.set(room, [...(requestsFor.get(room) ?? []), request]);
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
	res.writeHead(status, { "content-type": "application/json" });
	res.end(JSON.stringify(body));
}

const front = http.createServer((req, res) => {
	const url = new URL(req.url ?? "/", frontUrl);
	if (url.pathname === "/api/remote/client-context") contextReads += 1;
	if (serverDown) {
		req.socket.destroy();
		return;
	}
	if (url.pathname === "/api/remote/client-context") {
		json(res, 200, { remote: false, capability: "full", sharedServer, person: null, signOut: null });
		return;
	}
	const room = /^\/api\/persistent-agents\/([^/]+)\//.exec(url.pathname)?.[1];
	if (room) noteRequest(room, `${req.method} ${url.pathname}`);
	const refusal = room ? doors.get(room) : undefined;
	if (refusal) {
		if (room === heldRoom) letHeldAnswerGo = () => json(res, 403, refusal);
		else json(res, 403, refusal);
		return;
	}
	const shapesThis = shapeList !== null && url.pathname === "/api/persistent-agents" && req.method === "GET";
	const upstream = http.request({
		host: "127.0.0.1",
		port,
		method: req.method,
		path: req.url,
		headers: { ...req.headers, host: `127.0.0.1:${port}`, ...(req.headers.origin ? { origin: baseUrl } : {}) },
	}, (answer) => {
		if (!shapesThis) {
			res.writeHead(answer.statusCode ?? 502, answer.headers);
			answer.pipe(res);
			return;
		}
		let raw = "";
		answer.on("data", (chunk) => { raw += chunk; });
		answer.on("end", () => json(res, answer.statusCode ?? 502, shapeList?.(JSON.parse(raw))));
	});
	upstream.on("error", () => res.destroy());
	req.pipe(upstream);
});

front.on("upgrade", (req, socket: net.Socket, head) => {
	socket.on("error", () => {});
	const room = new URL(req.url ?? "/", frontUrl).searchParams.get("persistentAgentId");
	if (room) noteRequest(room, "live connection");
	if (serverDown) {
		socket.destroy();
		return;
	}
	const refusal = room ? doors.get(room) : undefined;
	if (refusal) {
		const body = JSON.stringify(refusal);
		refusedUpgrades.push(body);
		socket.end(`HTTP/1.1 403 Forbidden\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`);
		return;
	}
	const upstream = net.connect(port, "127.0.0.1", () => {
		const headers = { ...req.headers, host: `127.0.0.1:${port}`, origin: baseUrl };
		upstream.write(`GET ${req.url} HTTP/1.1\r\n${Object.entries(headers).map(([name, value]) => `${name}: ${String(value)}`).join("\r\n")}\r\n\r\n`);
		upstream.write(head);
		socket.pipe(upstream).pipe(socket);
	});
	upstream.on("error", () => socket.destroy());
	socket.on("close", () => { upstream.destroy(); passedSockets.delete(socket); });
	passedSockets.add(socket);
});

function dropLiveConnections(): void {
	for (const socket of passedSockets) socket.destroy();
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

const failures: string[] = [];
async function row(name: string, run: () => Promise<void>): Promise<void> {
	try {
		await run();
		console.log(`ok: ${name}`);
	} catch (error) {
		failures.push(name);
		// The whole message: a Playwright timeout names what it waited for in the
		// call log under its first line.
		console.log(`FAILED: ${name}: ${(error as Error).message}`);
	}
}

try {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => front.listen(frontPort, "127.0.0.1", resolve));
	const providerPort = (provider.address() as AddressInfo).port;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({
		providers: { "fake-claude": { name: "Fake Claude", baseUrl: `http://127.0.0.1:${providerPort}`, api: "anthropic-messages", models: [{ id: "claude-fake", name: "Claude Fake", input: ["text"], contextWindow: 200000, maxTokens: 32000 }] } },
	}, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ "fake-claude": { type: "api_key", key: "synthetic-claude" } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "custom-ai-profiles.json"), JSON.stringify({ version: 1, profiles: [
		{ id: "custom-fake-claude", providerId: "fake-claude", label: "Fake Claude", roomModels: ["claude-fake"], learnModel: "claude-fake", reviewMemoryModel: "claude-fake" },
	] }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "custom-fake-claude" }, null, 2), { mode: 0o600 });

	const agents = await import("../src/persistent-agents.js");
	const roomModels = await import("../src/room-models.js");
	const makeRoom = (displayName: string): string => {
		const roomId = agents.createPersistentAgentFromScaffoldInput({ displayName, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
		roomModels.writeRoomModels(roomId, { conversation: { provider: "fake-claude", model: "claude-fake" } });
		return roomId;
	};
	// A room per row: a window that closed may hold its room's lock for a moment.
	const waitingRoom = makeRoom("Waiting Room");
	const freshRoom = makeRoom("Fresh Room");
	const preparedRoom = makeRoom("Prepared Room");
	const unlistedRoom = makeRoom("Unlisted Room");
	const noRoomsRoom = makeRoom("No Rooms Room");
	const followedRoom = makeRoom("Followed Room");
	const otherUnlistedRoom = makeRoom("Other Unlisted Room");
	const fromRoomTarget = makeRoom("From Room Target");
	makeRoom("Draft Room");
	const lateRoom = makeRoom("Late Room");
	const lateMemoryRoom = makeRoom("Late Memory Room");
	const fromMemoryRoom = makeRoom("From Memory Room");
	const lateCardRoom = makeRoom("Late Card Room");
	makeRoom("Stays Open Room");
	const droppedRoom = makeRoom("Dropped Room");
	makeRoom("Own Room");
	makeRoom("Next Room");
	makeRoom("Lost Room");
	const otherFirstRoom = makeRoom("Other First Room");
	const otherDroppedRoom = makeRoom("Another Refusal Room");

	startServer();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready");

	const browser = await chromium.launch();
	try {
		// What's new opens on Home only after its own reads, so on a slow machine it
		// can land over a card or a button a row is about to click. Every window
		// here has seen this version's, as a person who closed it once has.
		const whatsNewVersion = String((await (await authedFetch(`${baseUrl}/api/whats-new`)).json()).version ?? "");
		assert(whatsNewVersion, "the server names its version for What's new");
		const signedIn = async (device: BrowserContextOptions = { viewport: { width: 1280, height: 900 } }): Promise<BrowserContext> => {
			const ctx = await browser.newContext(device);
			await ctx.addInitScript((version) => {
				try { localStorage.setItem("exxperts.whats-new-seen", version); } catch {}
			}, whatsNewVersion);
			// Counts each refused answer the page has finished reading, so a row can
			// wait until the page has had a refusal it then chooses to do nothing with.
			await ctx.addInitScript(() => {
				const read = Response.prototype.json;
				(window as any).__refusalsRead = 0;
				Response.prototype.json = async function (this: Response) {
					const body = await read.call(this);
					if (this.status === 403) (window as any).__refusalsRead += 1;
					return body;
				};
			});
			// Counts the room requests the page has started and those still waiting
			// for their answer, so a row can tell when the page has stopped asking.
			await ctx.addInitScript(() => {
				const send = window.fetch;
				const asks = { started: 0, open: 0 };
				(window as any).__roomAsks = asks;
				window.fetch = function (this: unknown, ...args: Parameters<typeof fetch>) {
					const url = args[0] instanceof Request ? args[0].url : String(args[0]);
					if (!url.includes("/api/persistent-agents")) return send.apply(this, args);
					asks.started += 1;
					asks.open += 1;
					return send.apply(this, args).finally(() => { asks.open -= 1; });
				} as typeof fetch;
			});
			const page = await ctx.newPage();
			await page.goto(`${frontUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.close();
			return ctx;
		};
		const onHome = async (page: Page) => {
			await page.locator(".persistent-agent-card").first().waitFor({ timeout: 15000 });
		};
		const openHome = async (ctx: BrowserContext): Promise<Page> => {
			const page = await ctx.newPage();
			await page.goto(`${frontUrl}/`);
			await onHome(page);
			return page;
		};
		const enterFromCard = async (page: Page, name: string) => {
			await page.locator(".persistent-agent-card").filter({ hasText: name }).locator(".landing-action").click();
			await page.locator("textarea").first().waitFor({ timeout: 15000 });
			await page.locator('button[title="Send"]').first().waitFor({ timeout: 15000 });
		};
		const askAndGetAnswer = async (page: Page) => {
			await page.locator("textarea").first().fill("A question.");
			await sendFromBox(page);
			await page.getByText("Answer from the model.").first().waitFor({ timeout: 15000 });
		};
		const openLink = async (ctx: BrowserContext, room: string): Promise<Page> => {
			const page = await ctx.newPage();
			await page.goto(`${frontUrl}/#/room/${room}`);
			return page;
		};
		const screen = (page: Page) => page.locator(".room-refused");
		// The page has stopped: the sentence and the way back, no box, nothing that
		// says it is still working, and no request for the room in a window that
		// holds a retry. Leaving the room sends Home's own reads, the refused room's
		// among them, and on a slow machine they reach the door seconds after the
		// screen: the count starts once the page has had no room request open and
		// started none for a second, and the door has had none in that second. A
		// retry that came sooner keeps that second from ever passing. A fixed wait
		// after it, because nothing happening has no state to wait on. The counts
		// print before anything is asserted.
		const expectStopped = async (page: Page, room: string, label: string) => {
			const shown = await screen(page).getByText(REFUSED_SENTENCE, { exact: true }).waitFor({ timeout: 12000 }).then(() => true, () => false);
			let last = "";
			let lastCount = -1;
			await waitForASecondWithoutChange(async () => {
				const asks = await page.evaluate(() => (window as any).__roomAsks as { started: number; open: number });
				const now = JSON.stringify([countFor(room), asks.started]);
				const same = asks.open === 0 && now === last;
				last = now;
				lastCount = countFor(room);
				return same;
			}, "the page has asked nothing for a second and the door is quiet");
			const atStop = lastCount;
			await page.waitForTimeout(QUIET_MS);
			console.log(`${label}: ${atStop} requests for the room until the page stopped, ${countFor(room) - atStop} more in the next ${QUIET_MS / 1000} s: ${JSON.stringify(requestsFor.get(room))}`);
			assert(shown, "the refused screen shows the answer's sentence");
			assert(countFor(room) === atStop, "no further tries");
			assert(await screen(page).getByRole("button", { name: "Back to rooms", exact: true }).isVisible(), "Back to rooms shows");
			assert(await page.locator("textarea").count() === 0, "no message box");
			assert(await page.getByText(/Reconnecting|Opening/).count() === 0, "nothing says it is still working");
			assert(await page.getByRole("status").count() === 0, "no spinner or status line");
		};
		const backToRooms = async (page: Page) => {
			await screen(page).getByRole("button", { name: "Back to rooms", exact: true }).click();
			await onHome(page);
			assert(await screen(page).count() === 0, "the refused screen is gone");
			await waitUntil(() => new URL(page.url()).hash === "#/" || new URL(page.url()).hash === "", "the address is Home's");
		};

		await row("a waiting conversation is made for the first open", async () => {
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await enterFromCard(page, "Waiting Room");
			await askAndGetAnswer(page);
			await page.getByRole("button", { name: "Rooms", exact: true }).first().click();
			await onHome(page);
			await ctx.close();
		});

		await row("the page cannot read the answer to a refused live connection", async () => {
			doors.set(freshRoom, REFUSED);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			const seen = await page.evaluate((url) => new Promise<Record<string, unknown>>((resolve) => {
				const events: string[] = [];
				const ws = new WebSocket(url);
				ws.onerror = (event) => { events.push(`${event.type}:${Object.keys(event).join(",")}`); };
				ws.onclose = (event) => resolve({ code: event.code, reason: event.reason, wasClean: event.wasClean, events });
			}), `ws://127.0.0.1:${frontPort}/ws?persistentAgentId=${freshRoom}`);
			console.log(`a refused upgrade as the page sees it: ${JSON.stringify(seen)}; as the door sent it: 403 ${refusedUpgrades.at(-1)}`);
			assert(refusedUpgrades.at(-1)?.includes(REFUSED_SENTENCE), "the door answered the upgrade with the sentence");
			assert(seen.code === 1006 && seen.reason === "" && seen.wasClean === false, "the close says nothing of the answer");
			assert(!JSON.stringify(seen).includes("room_not_yours"), "the code does not reach the page");
			doors.delete(freshRoom);
			requestsFor.delete(freshRoom);
			await ctx.close();
		});

		await row("a first open of a waiting conversation stops", async () => {
			doors.set(waitingRoom, REFUSED);
			requestsFor.delete(waitingRoom);
			const ctx = await signedIn();
			const page = await openLink(ctx, waitingRoom);
			await expectStopped(page, waitingRoom, "first open, waiting conversation");
			assert(new URL(page.url()).hash === `#/room/${waitingRoom}`, "the address still names the room");
			await backToRooms(page);
			await enterFromCard(page, "Own Room");
			await askAndGetAnswer(page);
			await page.getByRole("button", { name: "Rooms", exact: true }).first().click();
			await onHome(page);
			await ctx.close();
		});

		await row("a first open with no conversation stops", async () => {
			doors.set(freshRoom, REFUSED);
			const ctx = await signedIn();
			await expectStopped(await openLink(ctx, freshRoom), freshRoom, "first open, no conversation");
			await ctx.close();
		});

		await row("Back to rooms is a finger's size on a touch screen and at a phone's width, and small with a mouse in a wide window", async () => {
			const backHeight = async (device: BrowserContextOptions) => {
				const ctx = await signedIn(device);
				const page = await openLink(ctx, freshRoom);
				const back = screen(page).getByRole("button", { name: "Back to rooms", exact: true });
				await back.waitFor({ timeout: 12000 });
				const height = (await back.boundingBox())!.height;
				await ctx.close();
				return height;
			};
			const phone = { viewport: { width: 390, height: 844 } };
			const touch = await backHeight({ ...phone, hasTouch: true, isMobile: true });
			const narrow = await backHeight(phone);
			const wide = await backHeight({ viewport: { width: 1280, height: 800 } });
			console.log(`Back to rooms: ${touch}px on a touch screen, ${narrow}px with a mouse at 390 px, ${wide}px with a mouse at 1280 px`);
			assert(touch >= 44, `on a touch screen it measures at least 44px, got ${touch}`);
			assert(narrow >= 44, `with a mouse at a phone's width it measures at least 44px, got ${narrow}`);
			assert(wide < 44, `with a mouse in a wide window it keeps its small look, got ${wide}`);
		});

		await row("a first open of a prepared conversation stops", async () => {
			doors.set(preparedRoom, REFUSED);
			shapeList = (rows) => rows.map((status) => status.id === preparedRoom
				? { ...status, runtime: { ...status.runtime, state: "standby", activeThreadId: "postcp_stand_in" }, activeThread: { ...status.activeThread, threadId: "postcp_stand_in", preparedByBoundary: "checkpoint", hasUserVisibleTurns: false } }
				: status);
			const ctx = await signedIn();
			await expectStopped(await openLink(ctx, preparedRoom), preparedRoom, "first open, prepared conversation");
			shapeList = null;
			await ctx.close();
		});

		await row("a reconnect stops", async () => {
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await enterFromCard(page, "Dropped Room");
			requestsFor.delete(droppedRoom);
			doors.set(droppedRoom, REFUSED);
			dropLiveConnections();
			await expectStopped(page, droppedRoom, "reconnect");
			assert(countFor(droppedRoom) > 0, "the page asked for the room");
			await backToRooms(page);
			await enterFromCard(page, "Next Room");
			await askAndGetAnswer(page);
			await ctx.close();
		});

		const expectOneRead = (room: string) => {
			const requests = requestsFor.get(room) ?? [];
			assert(requests.length === 1 && requests[0] === `GET /api/persistent-agents/${room}/status`, `one read of the room, got ${JSON.stringify(requests)}`);
		};

		await row("a first open of a room the list does not hold reads it once and stops", async () => {
			doors.set(unlistedRoom, REFUSED);
			shapeList = (rows) => rows.filter((status) => status.id !== unlistedRoom);
			const ctx = await signedIn();
			const page = await openLink(ctx, unlistedRoom);
			await expectStopped(page, unlistedRoom, "first open, room not in the list");
			expectOneRead(unlistedRoom);
			assert(new URL(page.url()).hash === `#/room/${unlistedRoom}`, "the address still names the room");
			await backToRooms(page);
			shapeList = null;
			await ctx.close();
		});

		await row("a person with no rooms gets the same", async () => {
			doors.set(noRoomsRoom, REFUSED);
			shapeList = () => [];
			const ctx = await signedIn();
			const page = await openLink(ctx, noRoomsRoom);
			await expectStopped(page, noRoomsRoom, "first open, empty room list");
			expectOneRead(noRoomsRoom);
			shapeList = null;
			await ctx.close();
		});

		await row("an address followed in an open page gets the same", async () => {
			doors.set(followedRoom, REFUSED);
			shapeList = (rows) => rows.filter((status) => status.id !== followedRoom);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await page.evaluate((room) => { window.location.hash = `#/room/${room}`; }, followedRoom);
			await expectStopped(page, followedRoom, "address followed, room not in the list");
			expectOneRead(followedRoom);
			await backToRooms(page);
			shapeList = null;
			await ctx.close();
		});

		await row("a link followed from inside a room keeps that room's draft and Home's connection", async () => {
			doors.set(fromRoomTarget, REFUSED);
			shapeList = (rows) => rows.filter((status) => status.id !== fromRoomTarget);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await enterFromCard(page, "Draft Room");
			await page.locator("textarea").first().fill("A draft.");
			await page.evaluate((room) => { window.location.hash = `#/room/${room}`; }, fromRoomTarget);
			await expectStopped(page, fromRoomTarget, "link followed from inside a room");
			assert(passedSockets.size > 0, "Home keeps its live connection");
			await backToRooms(page);
			shapeList = null;
			await enterFromCard(page, "Draft Room");
			const draft = await page.locator("textarea").first().inputValue();
			assert(draft === "A draft.", `the room's draft is kept, got "${draft}"`);
			await ctx.close();
		});

		// The page has read the whole refusal, and two frames have been drawn since.
		const letAnswerLand = async (page: Page) => {
			const refusalsRead = () => page.evaluate(() => (window as any).__refusalsRead as number);
			const before = await refusalsRead();
			letHeldAnswerGo?.();
			await waitUntil(async () => await refusalsRead() > before, "the page has read the refusal");
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			heldRoom = null;
			letHeldAnswerGo = null;
		};

		await row("a refusal that lands after Back leaves Home alone", async () => {
			doors.set(lateRoom, REFUSED);
			heldRoom = lateRoom;
			shapeList = (rows) => rows.filter((status) => status.id !== lateRoom);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await page.evaluate((room) => { window.location.hash = `#/room/${room}`; }, lateRoom);
			await waitUntil(() => letHeldAnswerGo !== null, "the read is out");
			await page.goBack();
			await waitUntil(() => !new URL(page.url()).hash.startsWith("#/room/"), "Back has left the room's address");
			await letAnswerLand(page);
			assert(await screen(page).count() === 0, "the late refusal does not cover Home");
			assert(await page.locator(".persistent-agent-card").count() > 0, "Home stays");
			shapeList = null;
			await ctx.close();
		});

		await row("a link followed from Memory stops", async () => {
			doors.set(fromMemoryRoom, REFUSED);
			shapeList = (rows) => rows.filter((status) => status.id !== fromMemoryRoom);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await page.getByRole("button", { name: "Memory", exact: true }).first().click();
			await waitUntil(() => new URL(page.url()).hash === "#/memory", "the page is on Memory");
			await page.evaluate((room) => { window.location.hash = `#/room/${room}`; }, fromMemoryRoom);
			await expectStopped(page, fromMemoryRoom, "link followed from Memory");
			expectOneRead(fromMemoryRoom);
			await backToRooms(page);
			shapeList = null;
			await ctx.close();
		});

		await row("a refusal that lands after a move to Memory leaves Memory alone", async () => {
			doors.set(lateMemoryRoom, REFUSED);
			heldRoom = lateMemoryRoom;
			shapeList = (rows) => rows.filter((status) => status.id !== lateMemoryRoom);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await page.evaluate((room) => { window.location.hash = `#/room/${room}`; }, lateMemoryRoom);
			await waitUntil(() => letHeldAnswerGo !== null, "the read is out");
			await page.getByRole("button", { name: "Memory", exact: true }).first().click();
			await waitUntil(() => new URL(page.url()).hash === "#/memory", "the page is on Memory");
			await letAnswerLand(page);
			assert(await screen(page).count() === 0, "the late refusal does not cover Memory");
			assert(new URL(page.url()).hash === "#/memory", "the page stays on Memory");
			shapeList = null;
			await ctx.close();
		});

		await row("a refusal that lands after another room opened leaves that room alone", async () => {
			doors.set(lateCardRoom, REFUSED);
			heldRoom = lateCardRoom;
			shapeList = (rows) => rows.map((status) => status.id === lateCardRoom
				? { ...status, runtime: { ...status.runtime, state: "standby", activeThreadId: "c_stand_in" }, activeThread: { ...status.activeThread, threadId: "c_stand_in" } }
				: status);
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await page.locator(".persistent-agent-card").filter({ hasText: "Late Card Room" }).locator(".landing-action").click();
			await waitUntil(() => letHeldAnswerGo !== null, "the read is out");
			await enterFromCard(page, "Stays Open Room");
			await letAnswerLand(page);
			assert(await screen(page).count() === 0, "the late refusal does not cover the open room");
			assert(await page.locator("textarea").count() > 0, "the open room stays");
			shapeList = null;
			await askAndGetAnswer(page);
			await ctx.close();
		});

		await row("another 403 on a room the list does not hold lands on Home", async () => {
			doors.set(otherUnlistedRoom, OTHER_403);
			shapeList = (rows) => rows.filter((status) => status.id !== otherUnlistedRoom);
			const ctx = await signedIn();
			const page = await openLink(ctx, otherUnlistedRoom);
			await waitUntil(() => countFor(otherUnlistedRoom) > 0, "the page reads the room");
			await onHome(page);
			console.log(`another 403, room not in the list: ${JSON.stringify(requestsFor.get(otherUnlistedRoom))}`);
			expectOneRead(otherUnlistedRoom);
			assert(await screen(page).count() === 0, "another 403 is not this refusal");
			shapeList = null;
			await ctx.close();
		});

		await row("a room that does not exist on the desktop still lands on Home", async () => {
			sharedServer = false;
			const missing = "no-such-room";
			const ctx = await signedIn();
			const page = await openLink(ctx, missing);
			await waitUntil(() => countFor(missing) > 0, "the page reads the room");
			await onHome(page);
			console.log(`no such room on the desktop: ${JSON.stringify(requestsFor.get(missing))}`);
			expectOneRead(missing);
			assert(await screen(page).count() === 0, "no refusal");
			assert(!fs.existsSync(path.join(agentsRoot, missing)), "the read makes no folder for the room");
			sharedServer = true;
			await ctx.close();
		});

		await row("a lost connection still reconnects", async () => {
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await enterFromCard(page, "Lost Room");
			const readsBefore = contextReads;
			serverDown = true;
			dropLiveConnections();
			await waitUntil(() => contextReads >= readsBefore + 3, "the page tries again while the server is away");
			console.log(`lost connection: ${contextReads - readsBefore} tries while the server was away`);
			assert(await screen(page).count() === 0, "a lost connection shows no refusal");
			serverDown = false;
			await page.getByText("Connected again.").waitFor({ timeout: 30000 });
			await askAndGetAnswer(page);
			await ctx.close();
		});

		await row("another 403 on a first open stays Home's line", async () => {
			doors.set(otherFirstRoom, OTHER_403);
			const ctx = await signedIn();
			const page = await openLink(ctx, otherFirstRoom);
			await page.getByText(OTHER_SENTENCE).first().waitFor({ timeout: 15000 });
			await onHome(page);
			assert(await screen(page).count() === 0, "another 403 is not this refusal");
			await ctx.close();
		});

		await row("another 403 on a reconnect goes on trying", async () => {
			const ctx = await signedIn();
			const page = await openHome(ctx);
			await enterFromCard(page, "Another Refusal Room");
			const before = countFor(otherDroppedRoom);
			doors.set(otherDroppedRoom, OTHER_403);
			dropLiveConnections();
			await waitUntil(() => countFor(otherDroppedRoom) >= before + 3, "the page goes on trying through another 403");
			console.log(`another 403 on a reconnect: ${countFor(otherDroppedRoom) - before} tries and still going`);
			assert(await screen(page).count() === 0, "another 403 is not this refusal");
			assert(await page.locator("textarea").count() > 0, "the box stays");
			doors.delete(otherDroppedRoom);
			await page.getByText("Connected again.").waitFor({ timeout: 30000 });
			await ctx.close();
		});
	} finally {
		await browser.close();
	}
	assert(failures.length === 0, `failed rows: ${failures.join("; ")}`);
	console.log("room-refused-page smoke: ok");
} catch (error) {
	console.error(serverOutput.join("").slice(-3000));
	throw error;
} finally {
	for (const closing of [front, provider]) {
		try { (closing as any).closeAllConnections?.(); } catch {}
		try { closing.close(); } catch {}
	}
	await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
