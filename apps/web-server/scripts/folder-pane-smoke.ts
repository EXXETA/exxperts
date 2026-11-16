// Room settings' Folder pane as a person uses it, against a real server in
// this process with a gateway playing the model: each change saves on its
// click, and a screen reader hears Saved where no row shows it; Change folder
// keeps the room's Can change files and Commands, and Stop using keeps
// Commands and protection; a room with no folder shows only Location, its one
// line and its sites; Can change files, Commands and the Protection switch
// each say the line true for the state they show in, Protection what it is
// where it can work and only its cause where it can't; turning protection off
// asks first, in words true for the room's Commands, and turning it on saves
// at once; Also allowed says its one sentence in every state; a phone sees
// the pane greyed with no line under its switches and the server refuses its
// writes; an older Bounded room whose Commands are turned on sends its next
// command to the box.
//
// The protection's states other than the one this computer has are stand-ins:
// a `page.route` that fulfils the pane's read of the room with that state
// (each such row says "stand-in"). The box never starts here: the server's
// ask for a box is counted and refused, as a box that won't start is. A row
// that needs protection to run, or to not run, says skip where it can't, and
// where this kind of computer never can, which systems run it instead.
// Run: npm run smokes -- folder-pane
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Locator, type Page, type Route } from "playwright";

import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { authedFetch, freePort, putRunWithoutAsking, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { closeBrowser } from "./smoke-close-context.js";

{
	const p = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!p || !fs.existsSync(p)) {
		console.log("folder pane smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const ROWS = [
	"each change saves on its click and a screen reader hears Saved, while no row shows it; every save sends the room's Can change files and only the Commands switch sends Commands; closing Room settings asks nothing",
	"Change folder saves at once and keeps Can change files off and Commands on; the cross's Cancel sends nothing; Stop using keeps Commands and protection for the next folder, and Location then shows its one line, the removal heard and not shown",
	"with no folder (stand-in reads): Location with its one line, no other switches; the Protection switch only where the person turned it off; no start-on line in any state, on the computer or a phone",
	"a new room where protection runs gets commands on in Run without asking at its first folder picked in the pane",
	"the Commands line for each state (stand-in reads): protected, the same one sentence with Can change files on or off, and on Auto its own; this computer, this computer with Can change files off (shown off and greyed), off by the person or for the folder, also with a read that says Auto; a failed read of the mode shows no Commands line",
	"with Can change files off a write is refused and no command or commands ask is offered, and with it on the same write lands and the ask is offered (on a computer with no protection)",
	"Can change files' line for each state and position (stand-in reads): on, the room and its commands change files in every state; off, its commands only read too where protection is on, still change files where the person turned it off, for the folder or a cause not known, and go unnamed where this computer holds them off",
	"the Protection switch for each state (stand-in reads): on and movable where On, off and movable where the person turned it off, both saying what protection is; off and held with only the cause, on one line, for this computer, this folder and not known, with no button on the row; no Unprotected mark anywhere on the page; also for a folder that is gone and with commands off",
	"turning the switch off asks first, in words for the room's Commands on and off: Cancel, Escape and the backdrop send nothing and leave it on, Turn off sends one {state:\"off\"}; turning it on saves at once, and the Commands line then says the mode read with it, Auto's included, or nothing when that read fails; Home's list is read again (stand-in route)",
	"a refused protection change (stand-in route): a cause that stands says its line, a refusal with no cause standing says the whole sentence, a wait greys, any other failure puts the switch back with the failure line, and a failed read offers Try again",
	"Location and Also allowed's folders show their names, with the path only on the name for the pointer and a listed folder's access under its name; Also allowed says its one sentence in every protection state and nothing about commands (stand-in reads)",
	"on a phone: every switch greyed under one Changeable at the computer only, Protection's included, no line under any switch, names and no paths, no buttons, the state without its cause",
	"a paired device's writes are refused: the folder, Stop using, the protection and the list",
	"an older Bounded room reads Commands off and offers no command; once turned on in the pane, its next command goes to the box (asked for, and refused as a box that won't start)",
	"Also allowed follows Can change files: turned on, a Can read folder on the list offers Allow changes without reopening Room settings; turned off again, it no longer does; a read of the list that began before a removal never puts the row back (stand-in route)",
	"the room's own text with Can change files off and Commands on: it can only read files while protection holds its commands, and its commands can still change files once the person turns protection off",
	"after Stop using, the read says commands start on exactly where the next folder's commands run without asking, not where they ask first or are off; the pane shows no pick line either way",
	"Stop using keeps a protection the person turned off: turned off through its route, then Stop using and the next folder, both the commands read and the folder read say Off by the person",
	"a folder saved with no tool choice keeps Can change files: left reading only, Stop using and the next folder saved with the folder alone (as the chat's pick sends it) read only, and the kept state goes with that save; left able to, it comes back able to; a new room's first folder, or one kept before the field, starts able to; a room with a folder, reading only, given another still reads only",
	"in the pane, a room left reading only: after Stop using and the pick, the save sends no tool choice and Can change files shows off",
	"the kept Can change files is still there after the server starts again, and the next folder saved there reads only (a server of its own, started twice)",
	"a room left reading only with commands on and Run without asking: after Stop using the read says commands don't start on and, where protection runs, the pane shows no pick line; on a computer with no protection the next folder offers neither commands nor their ask",
	"a room whose commands ran without asking, turned off with Commands off: once Commands is turned on, each command asks first; turned back on, they run without asking again",
];

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const waitUntil = waitEvery(50, 20_000);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-folder-pane-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const folders = path.join(home, "Documents");
for (const dir of [agentDir, agentsRoot, folders]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const MODEL = { provider: "openai-compatible", model: "room-model" };

// --- The gateway plays the model: each leg of a turn makes its calls, then it answers in words.
type Call = { name: string; args: Record<string, unknown> };
let legs: Call[][] = [];
let toolResults: string[] = [];
let offered: string[] = [];
/** Each offered tool's description, by name, as the model reads it. */
let described: Record<string, string> = {};
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const text = (message: any) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part: any) => String(part?.text ?? "")).join("") : "");
		const tools = (parsed.tools ?? []).map((tool: any) => String(tool?.function?.name ?? tool?.name ?? ""));
		const sinceUser = messages.slice(messages.map((message) => message?.role).lastIndexOf("user") + 1);
		if (tools.length > 0) {
			offered = tools;
			described = Object.fromEntries((parsed.tools ?? []).map((tool: any) => [String(tool?.function?.name ?? tool?.name ?? ""), String(tool?.function?.description ?? tool?.description ?? "")]));
			toolResults = sinceUser.filter((message) => message?.role === "tool").map(text);
		}
		const done = sinceUser.filter((message) => message?.role === "assistant").length;
		const leg = tools.length > 0 ? legs[done] : undefined;
		const base = { id: `cmpl_${done}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (leg) {
			const tool_calls = leg.map((call, index) => ({ index, id: `call_${Date.now()}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 4, total_tokens: 154 } }));
		}
		res.end("data: [DONE]\n\n");
	});
});
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-folder-pane" } });
writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME"]) delete process.env[name];
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: home,
	USERPROFILE: home,
	PORT: String(port),
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
	LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});

const cards = await import("../src/room-box/card-text.js");
const { RoomBox } = await import("../src/room-box/box-session.js");
const { BoxFault } = await import("../src/room-box/box-process.js");
const policyStore = await import("../src/persistent-room-workspace-policy.js");
await import("../src/index.js");
await waitUntil(() => fetch(`${baseUrl}/healthz`).then((response) => response.ok, () => false), "the server is up", 60_000);

// --- The server's ask for a room's box, counted by room and refused: no box ever starts here.
const boxAsks = new Map<string, number>();
const asksOf = (roomId: string) => boxAsks.get(roomId) ?? 0;
RoomBox.prototype.ensureRun = function (this: InstanceType<typeof RoomBox>) {
	const roomId = String((this as any).options.roomId);
	boxAsks.set(roomId, asksOf(roomId) + 1);
	return Promise.reject(new BoxFault("the box did not start"));
} as typeof RoomBox.prototype.ensureRun;

async function json(pathname: string, init: AuthedFetchInit = {}, base = baseUrl): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${base}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const roomPath = (roomId: string, tail = "") => `/api/persistent-agents/${encodeURIComponent(roomId)}${tail}`;
const runtimeOf = (roomId: string, ...names: string[]) => path.join(agentsRoot, roomId, "runtime", ...names);
const folderRead = async (roomId: string) => (await json(roomPath(roomId, "/workspace-default"))).body;
const READ_TOOLS = ["read", "ls", "find", "grep"];
const ALL_TOOLS = [...READ_TOOLS, "write", "edit"];

let made = 0;
const newFolder = (name = `folder-${++made}`): string => {
	const folder = path.join(folders, name);
	fs.mkdirSync(folder, { recursive: true });
	return folder;
};
/** A room as this smoke needs it: made before commands started on unless `startsOn`, with a folder saved as given. */
async function newRoom(name: string, folder?: { root?: string; tools?: string[]; commands?: boolean; access?: "bounded" | "localFiles" }, startsOn = false): Promise<string> {
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const id = String(created.body?.agent?.id ?? "");
	assert(created.status === 201 && id, `${name} was made, got ${created.status}`);
	if (!startsOn) for (const file of ["commands-start-on.json", "bash-settings.json"]) fs.rmSync(runtimeOf(id, file), { force: true });
	if (folder) {
		const saved = await json(roomPath(id, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder.root ?? newFolder(), workspaceAccessMode: folder.access ?? "localFiles", ...(folder.tools ? { toolSelection: { kind: "custom", allowedToolNames: folder.tools } } : {}), ...(folder.commands === undefined ? {} : { bashEnabled: folder.commands }) }) });
		assert(saved.status === 200, `${name}'s folder was saved, got ${saved.status}: ${JSON.stringify(saved.body)}`);
	}
	return id;
}
/** What Stop using kept for the room's next folder, as on disk, or null. */
const keptOf = (roomId: string, root = agentsRoot) => {
	const file = path.join(root, roomId, "runtime", "commands-kept.json");
	return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : null;
};
const storedCommands = (roomId: string) => {
	const policy = policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId);
	return policy ? policyStore.persistentRoomCommandsOf(policy) : null;
};
/** A list of tools in one order, so two lists compare by what is in them. */
const toolSet = (names: readonly string[] | undefined) => (names ? [...names].sort().join(",") : null);
const storedTools = (roomId: string) => {
	const policy = policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId);
	return policy ? toolSet(policyStore.persistentRoomCapabilityPolicyView(policy).allowedToolNames) : null;
};

const WebSocketImpl: any = (await import("ws")).default;
let conversations = 0;
/** One message in a fresh conversation whose turn makes these calls, its cards answered yes: what the tools gave back and what the model was offered. */
async function turn(roomId: string, calls: Call[][]): Promise<{ results: string[]; tools: string[] }> {
	const conversation = `conversation-${++conversations}`;
	const seeded = await json(roomPath(roomId, `/threads/${conversation}`), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) });
	assert(seeded.status === 200, `${conversation} was seeded, got ${seeded.status}`);
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?persistentAgentId=${roomId}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	ws.addEventListener("message", (event: any) => {
		let frame: any;
		try { frame = JSON.parse(String(event.data)); } catch { return; }
		frames.push(frame);
		// The command question's yes, a floor later, as a person reads first: a yes sooner is asked again.
		if (frame.type === "ui_request" && frame.kind === "run") setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id: frame.id, value: true })), cards.ANSWER_FLOOR_MS + 50);
	});
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	try {
		await waitUntil(() => frames.some((frame) => frame.type === "ready"), `${conversation} is ready`);
		legs = calls;
		toolResults = [];
		offered = [];
		ws.send(JSON.stringify({ type: "prompt", text: "Work in the folder." }));
		await waitUntil(() => frames.some((frame) => frame.type === "event" && frame.event?.type === "agent_end"), "the turn ended");
		await waitForTurnSettled(json, roomId, "the turn has settled");
		return { results: toolResults, tools: offered };
	} finally {
		ws.close();
	}
}

// --- The page.
const browser = await chromium.launch();
async function newPage(context: { remote?: boolean } = {}): Promise<Page> {
	const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 } })).newPage();
	if (context.remote) {
		await page.route("**/api/remote/client-context", (route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
	}
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const close = page.locator(".whats-new-close");
	if (await close.count()) await close.click();
	return page;
}
const paneOf = (page: Page) => page.locator(".room-settings-section:not([hidden]) .room-workspace-section");
/** `loaded` false: a read that fails draws no Location row, so nothing waits for one. */
async function openPane(page: Page, roomName: string, { loaded = true } = {}) {
	// Home as it is now: a room made since the page last read its list is on it.
	await page.goto(`${baseUrl}/#/`);
	await page.reload();
	await page.waitForLoadState("networkidle");
	const card = page.locator(".persistent-agent-card").filter({ hasText: roomName });
	await card.waitFor({ timeout: 10_000 });
	await card.locator(".card-gear-btn").click();
	await page.waitForSelector(".settings-dialog", { timeout: 10_000 });
	await page.locator(".settings-dialog-nav-item").filter({ hasText: /^Folder$/ }).first().click();
	const pane = paneOf(page);
	if (loaded) await pane.locator(".folder-pane-location").waitFor({ timeout: 10_000 });
	return pane;
}
async function closeSettings(page: Page): Promise<void> {
	await page.keyboard.press("Escape");
	await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
}
/** Stand-in: the pane's read of this room, changed as `edit` says, the rest as the server answers. */
async function standInRead(page: Page, roomId: string, edit: (body: any) => any): Promise<() => Promise<void>> {
	const pattern = `**${roomPath(roomId, "/workspace-default")}`;
	const handler = async (route: Route) => {
		if (route.request().method() !== "GET") return route.continue();
		const response = await route.fetch();
		await route.fulfill({ response, json: edit(await response.json()) });
	};
	await page.route(pattern, handler);
	return () => page.unroute(pattern, handler);
}
/** The room's mode as the pane reads it, stood in for: `free` in the answer, or a failed read. */
async function standInMode(page: Page, roomId: string, mode: { free: boolean } | "fails"): Promise<() => Promise<void>> {
	const pattern = `**${roomPath(roomId, "/bash-settings")}`;
	const handler = async (route: Route) => {
		if (route.request().method() !== "GET") return route.continue();
		if (mode === "fails") return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "unreadable" }) });
		const response = await route.fetch();
		const body = await response.json();
		const { free: _free, ...settings } = body.settings ?? {};
		await route.fulfill({ response, json: { ...body, settings: { ...settings, autoApprove: true, ...(mode.free ? { free: true } : {}) } } });
	};
	await page.route(pattern, handler);
	return () => page.unroute(pattern, handler);
}
/** The computer's folder window, stood in for: it gives `folder`. */
async function folderWindowGives(page: Page, folder: string): Promise<() => Promise<void>> {
	const handler = (route: Route) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ supported: true, cancelled: false, path: folder }) });
	await page.route("**/api/system/choose-folder", handler);
	return () => page.unroute("**/api/system/choose-folder", handler);
}
const switchOf = (page: Page, name: string) => paneOf(page).getByRole("switch", { name, exact: true });
const switchRow = (page: Page, name: string) => paneOf(page).locator("label.settings-row").filter({ has: page.getByRole("switch", { name, exact: true }) });
const protectionRow = (page: Page) => paneOf(page).locator(".folder-pane-protection");
/** The pane's live line: what a screen reader hears after a change. */
const heard = (page: Page) => paneOf(page).locator(":scope > .sr-only[role=status]");
/** A change took: the screen reader hears Saved, and no row shows it. */
async function savedHeardNotShown(page: Page): Promise<void> {
	await waitUntil(async () => (await heard(page).textContent()) === cards.SAVED, "a screen reader hears Saved");
	const shown = await paneOf(page).locator(".settings-rows").getByText(cards.SAVED, { exact: true }).count();
	assert(shown === 0, `no row shows Saved, got ${shown}`);
}
const PROTECTIONS = {
	on: { state: "on" },
	person: { state: "off" },
	computer: { state: "off", cause: "computer" },
	folder: { state: "off", cause: "folder" },
	unknown: { state: "off", cause: "unknown" },
} as const;
type ProtectionKey = keyof typeof PROTECTIONS;

/** Where this computer's protection stands, as the server reads it for a room. */
const protectionHere = async (roomId: string) => (await folderRead(roomId))?.protection as { state: string; cause?: string } | undefined;

/**
 * Why a row didn't run here. "skip" is a gap: this kind of computer could have
 * run it. `onlyOn` names the systems that run a row this kind never can, in the
 * words the smoke runner takes as another system's part (ONLY_ON in
 * scripts/run-smokes.mjs), so it is no gap here.
 */
type LeftOut = "skip" | { onlyOn: string };
/** Protection runs only on a person's own Mac or Windows PC (roomBoxComputer, src/room-box/box-available.ts); there a row that finds none is a gap. */
const WITHOUT_PROTECTION: LeftOut = process.platform === "darwin" || process.platform === "win32" ? "skip" : { onlyOn: "only on macOS or Windows, where protection runs" };

let passed = 0;
let skipped = 0;
let elsewhere = 0;
const failures: string[] = [];
let rowAt = 0;
const only = process.env.ONLY ? Number(process.env.ONLY) : null;
async function row(name: string, body: () => Promise<void | LeftOut>, why?: string): Promise<void> {
	const at = rowAt++;
	assert(ROWS[at] === name, `rows run in the order ROWS lists them: ${name}`);
	if (only !== null && only !== at + 1) return;
	try {
		const left = await body();
		if (left === "skip") {
			skipped += 1;
			console.log(`  skip ${name} (${why})`);
			return;
		}
		if (left) {
			elsewhere += 1;
			console.log(`SKIPPED: ${name} (${left.onlyOn})`);
			return;
		}
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

console.log("folder pane smoke");
try {
	const page = await newPage();

	await row(ROWS[0], async () => {
		const roomId = await newRoom("Click Desk", { tools: ALL_TOOLS, commands: false });
		const puts: any[] = [];
		page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith(roomPath(roomId, "/workspace-default"))) puts.push(request.postDataJSON()); });
		await openPane(page, "Click Desk");
		await switchOf(page, cards.COMMANDS).click();
		await savedHeardNotShown(page);
		assert(storedCommands(roomId) === "on", `the Commands switch saved on its click, stored ${storedCommands(roomId)}`);
		await switchOf(page, cards.CAN_CHANGE_FILES).click();
		await waitUntil(() => storedTools(roomId) === toolSet(READ_TOOLS), "Can change files saved on its click");
		await savedHeardNotShown(page);
		assert(storedTools(roomId) === toolSet(READ_TOOLS), `Can change files saved on its click, stored ${storedTools(roomId)}`);
		assert(puts.length === 2, `one save for each click, got ${puts.length}`);
		assert(puts[0].bashEnabled === true && toolSet(puts[0].toolSelection?.allowedToolNames) === toolSet(ALL_TOOLS) && !("root" in puts[0]), `the Commands save sends Commands with the room's Can change files, got ${JSON.stringify(puts[0])}`);
		assert(!("bashEnabled" in puts[1]) && toolSet(puts[1].toolSelection?.allowedToolNames) === toolSet(READ_TOOLS), `the Can change files save leaves Commands as they stand, got ${JSON.stringify(puts[1])}`);
		assert(storedCommands(roomId) === "on", "Commands stay on after Can change files is turned off");
		await page.keyboard.press("Escape");
		await page.locator(".settings-dialog").first().waitFor({ state: "detached", timeout: 10_000 });
		assert(await page.getByRole("alertdialog", { name: "Unsaved changes" }).count() === 0, "closing Room settings after a change asks nothing");
	});

	await row(ROWS[1], async () => {
		const roomId = await newRoom("Keep Desk", { tools: READ_TOOLS, commands: true });
		fs.writeFileSync(runtimeOf(roomId, "protection.json"), JSON.stringify({ schemaVersion: 1, state: "on", updatedAt: "2026-11-01T00:00:00.000Z" }));
		const protectionBefore = fs.readFileSync(runtimeOf(roomId, "protection.json"), "utf8");
		assert(storedCommands(roomId) === "on" && storedTools(roomId) === toolSet(READ_TOOLS), `the room starts with Can change files off and Commands on, got ${storedTools(roomId)} / ${storedCommands(roomId)}`);
		const pane = await openPane(page, "Keep Desk");
		const next = newFolder("Keep next");
		let restore = await folderWindowGives(page, next);
		try {
			await pane.locator(".folder-pane-location").getByRole("button", { name: cards.CHANGE_FOLDER }).click();
			await waitUntil(() => policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId)?.roots[0]?.path === next, "Change folder saved the new folder at once");
		} finally {
			await restore();
		}
		assert(storedTools(roomId) === toolSet(READ_TOOLS) && storedCommands(roomId) === "on", `the new folder keeps Can change files off and Commands on, got ${storedTools(roomId)} / ${storedCommands(roomId)}`);
		const writes: string[] = [];
		page.on("request", (request) => { if (request.url().includes(roomPath(roomId, "/workspace-default")) && request.method() !== "GET") writes.push(request.method()); });
		await pane.getByRole("button", { name: cards.STOP_USING_FOLDER }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: cards.CANCEL, exact: true }).click();
		await page.getByRole("alertdialog").waitFor({ state: "detached", timeout: 10_000 });
		assert(writes.length === 0 && policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId) !== null, `the cross's Cancel sends nothing, got ${JSON.stringify(writes)}`);
		await pane.getByRole("button", { name: cards.STOP_USING_FOLDER }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: cards.STOP_USING, exact: true }).click();
		await waitUntil(async () => (await heard(page).textContent()) === cards.FOLDER_REMOVED, "a screen reader hears the folder removed");
		assert(policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId) === null, "Stop using clears the folder");
		const locationLines = await pane.locator(".folder-pane-location .settings-row-sub").allTextContents();
		assert(JSON.stringify(locationLines) === JSON.stringify([cards.NO_FOLDER_YET_LINE]), `Location shows its one line after Stop using, got ${JSON.stringify(locationLines)}`);
		restore = await folderWindowGives(page, next);
		try {
			await pane.locator(".folder-pane-location").getByRole("button", { name: cards.CHOOSE_FOLDER }).click();
			await waitUntil(() => policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId) !== null, "the folder is chosen again");
		} finally {
			await restore();
		}
		assert(storedCommands(roomId) === "on", `after Stop using, the next folder has Commands as they were, got ${storedCommands(roomId)}`);
		assert(fs.readFileSync(runtimeOf(roomId, "protection.json"), "utf8") === protectionBefore, "Stop using and the next folder leave the protection as it was");
		await closeSettings(page);
	});

	await row(ROWS[2], async () => {
		const roomId = await newRoom("Bare Desk");
		const read = (protection: object, commandsStartOn: boolean) => (body: any) => ({ ...body, policy: null, warnings: [], protection, commandsStartOn });
		const look = async (on: Page) => {
			const pane = paneOf(on);
			return {
				switches: await pane.getByRole("switch").count(),
				row: await pane.locator(".folder-pane-protection").count(),
				protectionSwitch: await pane.getByRole("switch", { name: cards.PROTECTION, exact: true }).count(),
				location: (await pane.locator(".folder-pane-location .settings-row-sub").allTextContents()).join(" | "),
			};
		};
		const line = cards.NO_FOLDER_YET_LINE;
		for (const [label, protection, startsOn, expected] of [
			["On, commands start on", PROTECTIONS.on, true, { switches: 0, row: 0, protectionSwitch: 0, location: line }],
			["On, commands don't start on", PROTECTIONS.on, false, { switches: 0, row: 0, protectionSwitch: 0, location: line }],
			["turned off by the person", PROTECTIONS.person, true, { switches: 1, row: 1, protectionSwitch: 1, location: line }],
			["this computer", PROTECTIONS.computer, true, { switches: 0, row: 0, protectionSwitch: 0, location: line }],
		] as const) {
			const unroute = await standInRead(page, roomId, read(protection, startsOn));
			try {
				await openPane(page, "Bare Desk");
				await paneOf(page).getByText(cards.NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
				const seen = await look(page);
				assert(JSON.stringify(seen) === JSON.stringify(expected), `stand-in ${label}: got ${JSON.stringify(seen)}`);
				await closeSettings(page);
			} finally {
				await unroute();
			}
		}
		const phone = await newPage({ remote: true });
		try {
			await standInRead(phone, roomId, read(PROTECTIONS.on, true));
			await openPane(phone, "Bare Desk");
			await paneOf(phone).getByText(cards.CHANGEABLE_AT_COMPUTER, { exact: true }).waitFor({ timeout: 10_000 });
			const seen = (await look(phone)).location;
			assert(seen === cards.NO_FOLDER_YET, `a phone shows Location's one line and no start-on line, got ${seen}`);
		} finally {
			await phone.context().close();
		}
	});

	await row(ROWS[3], async () => {
		const roomId = await newRoom("First Folder Desk", undefined, true);
		const protection = await protectionHere(roomId);
		if (protection?.state !== "on") return WITHOUT_PROTECTION;
		await openPane(page, "First Folder Desk");
		await paneOf(page).getByText(cards.NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
		const restore = await folderWindowGives(page, newFolder("First folder"));
		try {
			await paneOf(page).locator(".folder-pane-location").getByRole("button", { name: cards.CHOOSE_FOLDER }).click();
			await switchOf(page, cards.COMMANDS).waitFor({ timeout: 10_000 });
		} finally {
			await restore();
		}
		const settings = (await json(roomPath(roomId, "/bash-settings"))).body?.settings;
		// "automatic": on by the start-on default, which holds only where protection runs.
		assert(storedCommands(roomId) === "automatic" && settings?.autoApprove === true, `the first folder's commands start on in Run without asking, got ${storedCommands(roomId)} / ${JSON.stringify(settings)}`);
		assert(await switchOf(page, cards.COMMANDS).isChecked(), "the pane shows Commands on");
		await closeSettings(page);
	}, "needs a computer where protection runs");

	const linesDesk = await newRoom("Lines Desk", { tools: ALL_TOOLS, commands: true });
	const linesReadDesk = await newRoom("Lines Read Desk", { tools: READ_TOOLS, commands: true });

	await row(ROWS[4], async () => {
		const expected: Array<[ProtectionKey, string, boolean, string, boolean?]> = [
			["on", "Lines Desk", true, cards.COMMANDS_PROTECTED_REACH],
			["on", "Lines Read Desk", false, cards.COMMANDS_PROTECTED_REACH],
			["on", "Lines Desk", true, cards.COMMANDS_FREE_REACH, true],
			["on", "Lines Read Desk", false, cards.COMMANDS_FREE_REACH, true],
			["computer", "Lines Desk", true, cards.COMMANDS_NO_PROTECTION_REACH],
			["computer", "Lines Read Desk", false, cards.COMMANDS_NEED_CHANGES_LINE],
			["person", "Lines Desk", true, cards.COMMANDS_UNPROTECTED_REACH],
			["person", "Lines Read Desk", false, cards.COMMANDS_UNPROTECTED_REACH],
			["person", "Lines Desk", true, cards.COMMANDS_UNPROTECTED_REACH, true],
			["folder", "Lines Desk", true, cards.COMMANDS_UNPROTECTED_REACH],
			["computer", "Lines Desk", true, cards.COMMANDS_NO_PROTECTION_REACH, true],
		];
		for (const [key, name, canChange, line, free = false] of expected) {
			const roomId = name === "Lines Desk" ? linesDesk : linesReadDesk;
			// Commands read on, so a switch shown off says the pane held it.
			const unroute = await standInRead(page, roomId, (body) => ({ ...body, protection: PROTECTIONS[key], policy: { ...body.policy, bashEnabled: true } }));
			const unrouteMode = await standInMode(page, roomId, { free });
			try {
				await openPane(page, name);
				const commands = switchRow(page, cards.COMMANDS);
				const shown = await commands.locator(".settings-row-sub").first().textContent();
				assert(shown === line, `stand-in ${key}${free ? " read as Auto" : ""}, Can change files ${canChange ? "on" : "off"}: the Commands line, got ${shown}`);
				const held = key === "computer" && !canChange;
				assert(await switchOf(page, cards.COMMANDS).isChecked() === !held && await switchOf(page, cards.COMMANDS).isDisabled() === held, `stand-in ${key}, Can change files ${canChange ? "on" : "off"}: the switch ${held ? "shows off and greyed" : "shows on and works"}`);
				await closeSettings(page);
			} finally {
				await unroute();
				await unrouteMode();
			}
		}
		// A mode that can't be read: the pane shows no Commands line rather than another mode's.
		const unroute = await standInRead(page, linesDesk, (body) => ({ ...body, protection: PROTECTIONS.on, policy: { ...body.policy, bashEnabled: true } }));
		const unrouteMode = await standInMode(page, linesDesk, "fails");
		try {
			await openPane(page, "Lines Desk", { loaded: false });
			await paneOf(page).getByText(cards.FOLDER_LOAD_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await switchRow(page, cards.COMMANDS).count() === 0 && await paneOf(page).getByText(cards.COMMANDS_PROTECTED_REACH, { exact: true }).count() === 0, "a failed read of the mode shows a Commands line");
			await closeSettings(page);
		} finally {
			await unroute();
			await unrouteMode();
		}
	});

	await row(ROWS[5], async () => {
		const readOnly = await newRoom("Read Only Desk", { tools: READ_TOOLS, commands: false });
		const protection = await protectionHere(readOnly);
		if (protection?.state === "on") return { onlyOn: "only on Linux, where no protection runs" };
		if (!(protection?.state === "off" && protection.cause === "computer")) return "skip";
		const folderOf = (roomId: string) => String(policyStore.readPersistentRoomDefaultCapabilityPolicy(roomId)?.roots[0]?.path);
		const refused = path.join(folderOf(readOnly), "refused.txt");
		const without = await turn(readOnly, [[{ name: "write", args: { path: refused, content: "no" } }]]);
		assert(!without.tools.includes("write") && !fs.existsSync(refused), `with Can change files off the room has no write and nothing lands, offered ${without.tools.join(",")}`);
		assert(!without.tools.includes("bash") && !without.tools.includes("ask_for_commands"), `with Can change files off commands can't run here, so neither they nor their ask are offered: offered ${without.tools.join(",")}`);
		const writer = await newRoom("Writer Desk", { tools: ALL_TOOLS, commands: false });
		const landed = path.join(folderOf(writer), "landed.txt");
		const withIt = await turn(writer, [[{ name: "write", args: { path: landed, content: "yes" } }]]);
		assert(withIt.tools.includes("write") && fs.existsSync(landed), `with Can change files on the same write lands, results ${JSON.stringify(withIt.results)}`);
		assert(withIt.tools.includes("ask_for_commands"), `with Can change files on the room may ask for commands, offered ${withIt.tools.join(",")}`);
		// The room's questions show above the message box, so what the model reads of them never calls one a card.
		const asking = described.ask_for_commands ?? "";
		assert(asking.includes("The app shows them your reason, and they say yes or no.") && !/\bcards?\b/i.test(asking), `the commands question's description as the model reads it: ${asking}`);
		// A save answers with the room as the next read gives it: commands on, then Can change files turned off, which here stops them; and a list without Read, no folder.
		const flip = await newRoom("Flip Desk", { tools: ALL_TOOLS, commands: true });
		assert((await folderRead(flip)).policy?.bashEnabled === true, "the room starts with Can change files and Commands on");
		const asked = await json(roomPath(flip, "/workspace-default"), { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: READ_TOOLS } }) });
		assert(asked.status === 200 && asked.body.policy?.bashEnabled === false && (await folderRead(flip)).policy?.bashEnabled === false, `the save's answer and the next read agree on commands, got ${JSON.stringify(asked.body.policy?.bashEnabled)}`);
		const noRead = await json(roomPath(writer, "/workspace-default"), { method: "PUT", body: JSON.stringify({ toolSelection: { kind: "custom", allowedToolNames: ["ls"] } }) });
		assert(noRead.status === 200 && noRead.body.policy === null && (await folderRead(writer)).policy === null, `a list without Read answers no folder, as the next read does, got ${JSON.stringify(noRead.body.policy)}`);
	}, "needs a computer with no protection: the Linux stand-in");

	await row(ROWS[6], async () => {
		const offLines: Record<ProtectionKey, string> = {
			on: cards.CAN_CHANGE_FILES_OFF_LINE,
			person: cards.CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE,
			folder: cards.CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE,
			unknown: cards.CAN_CHANGE_FILES_OFF_UNPROTECTED_LINE,
			computer: cards.CAN_CHANGE_FILES_OFF_NO_COMMANDS_LINE,
		};
		for (const [key, name, line] of (Object.keys(offLines) as ProtectionKey[]).flatMap((key) => [[key, "Lines Desk", cards.CAN_CHANGE_FILES_ON_LINE], [key, "Lines Read Desk", offLines[key]]] as const)) {
			const unroute = await standInRead(page, name === "Lines Desk" ? linesDesk : linesReadDesk, (body) => ({ ...body, protection: PROTECTIONS[key] }));
			try {
				await openPane(page, name);
				const shown = await switchRow(page, cards.CAN_CHANGE_FILES).locator(".settings-row-sub").first().textContent();
				assert(shown === line, `stand-in ${key} in ${name}: Can change files' line, got ${shown}`);
				await closeSettings(page);
			} finally {
				await unroute();
			}
		}
	});

	await row(ROWS[7], async () => {
		const goneDesk = await newRoom("Gone Desk", { root: newFolder("gone"), tools: ALL_TOOLS, commands: false });
		fs.rmSync(path.join(folders, "gone"), { recursive: true, force: true });
		// Each state: whether the switch shows on, whether it is held, the cause's line, and the button beside it.
		const states: Array<[ProtectionKey, boolean, boolean, string | null, string | null]> = [
			["on", true, false, cards.PROTECTION_LINE, null],
			["person", false, false, cards.PROTECTION_LINE, null],
			["computer", false, true, cards.PROTECTION_ROW_UNAVAILABLE_COMPUTER, null],
			["folder", false, true, cards.PROTECTION_ROW_UNAVAILABLE_FOLDER, null],
			["unknown", false, true, cards.PROTECTION_ROW_UNAVAILABLE, null],
		];
		for (const [roomId, name] of [[linesDesk, "Lines Desk"], [goneDesk, "Gone Desk"]] as const) {
			for (const [key, on, held, line, button] of states) {
				const unroute = await standInRead(page, roomId, (body) => ({ ...body, protection: PROTECTIONS[key] }));
				try {
					await openPane(page, name);
					const protection = protectionRow(page);
					await protection.waitFor({ timeout: 10_000 });
					const control = protection.getByRole("switch", { name: cards.PROTECTION, exact: true });
					const seen = {
						label: await protection.locator(".settings-row-label").textContent(),
						on: await control.isChecked(),
						held: await control.isDisabled(),
						mark: await page.getByText("Unprotected", { exact: true }).count(),
						line: (await protection.locator(".settings-row-sub").allTextContents()).join(" ") || null,
						// How many lines its words take at this desktop width.
						wraps: await protection.locator(".settings-row-sub").count() === 0 ? 0 : await protection.locator(".settings-row-sub").first().evaluate((el) => {
							const range = document.createRange();
							range.selectNodeContents(el);
							return new Set(Array.from(range.getClientRects(), (rect) => Math.round(rect.top))).size;
						}),
						buttons: (await protection.getByRole("button").allTextContents()).join(","),
					};
					assert(seen.label === cards.PROTECTION && seen.on === on && seen.held === held && seen.mark === 0 && seen.line === line && seen.wraps === 1 && seen.buttons === (button ?? ""), `stand-in ${key} in ${name}: got ${JSON.stringify(seen)}`);
					await closeSettings(page);
				} finally {
					await unroute();
				}
			}
		}
		const goneRead = await folderRead(goneDesk);
		assert((goneRead?.warnings ?? []).length > 0 && goneRead?.policy?.bashEnabled === false, "the gone folder's room reads its folder missing, with commands off");
	});

	await row(ROWS[8], async () => {
		const roomId = await newRoom("Turn Desk", { tools: ALL_TOOLS, commands: false });
		let shown: object = PROTECTIONS.on;
		const sent: any[] = [];
		const unroute = await standInRead(page, roomId, (body) => ({ ...body, protection: shown }));
		await page.route(`**${roomPath(roomId, "/protection")}`, async (route) => {
			const body = route.request().postDataJSON();
			sent.push(body);
			shown = body.state === "off" ? PROTECTIONS.person : PROTECTIONS.on;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ agentId: roomId, protection: shown }) });
		});
		let listReads = 0;
		page.on("request", (request) => { if (request.method() === "GET" && new URL(request.url()).pathname === "/api/persistent-agents") listReads += 1; });
		try {
			const question = page.getByRole("alertdialog", { name: cards.TURN_OFF_PROTECTION_TITLE });
			const protectionSwitch = () => switchOf(page, cards.PROTECTION);
			const ask = async () => {
				await protectionSwitch().click();
				await question.waitFor({ timeout: 10_000 });
			};
			// With the room's Commands on, the question says what they will be able to do.
			const unrouteOn = await standInRead(page, linesDesk, (body) => ({ ...body, protection: PROTECTIONS.on, policy: { ...body.policy, bashEnabled: true } }));
			try {
				await openPane(page, "Lines Desk");
				await ask();
				const said = await question.innerText();
				assert(said.includes(cards.TURN_OFF_PROTECTION_BODY) && !said.includes(cards.TURN_OFF_PROTECTION_BODY_COMMANDS_OFF), `with Commands on, the question says what commands will be able to do, got ${said}`);
				await question.getByRole("button", { name: cards.CANCEL, exact: true }).click();
				await question.waitFor({ state: "detached", timeout: 10_000 });
				await closeSettings(page);
			} finally {
				await unrouteOn();
			}
			// Turn Desk's Commands are off: the question says what they could do once turned on.
			await openPane(page, "Turn Desk");
			await ask();
			const said = await question.innerText();
			assert(said.includes(cards.TURN_OFF_PROTECTION_BODY_COMMANDS_OFF) && !said.includes(cards.TURN_OFF_PROTECTION_BODY), `with Commands off, the question says what commands could do once turned on, got ${said}`);
			assert(await question.getByRole("button", { name: cards.CANCEL, exact: true }).evaluate((el) => el === document.activeElement), "the focus starts on Cancel");
			await question.getByRole("button", { name: cards.CANCEL, exact: true }).click();
			await question.waitFor({ state: "detached", timeout: 10_000 });
			await ask();
			await page.keyboard.press("Escape");
			await question.waitFor({ state: "detached", timeout: 10_000 });
			await ask();
			await page.locator(".confirm-dialog-backdrop").click({ position: { x: 4, y: 4 } });
			await question.waitFor({ state: "detached", timeout: 10_000 });
			assert(sent.length === 0, `Cancel, Escape and the backdrop send nothing, got ${JSON.stringify(sent)}`);
			assert(await protectionSwitch().isChecked(), "after Cancel, Escape and the backdrop the switch is still on");
			const readsBefore = listReads;
			await ask();
			await question.getByRole("button", { name: cards.TURN_OFF, exact: true }).click();
			await waitUntil(async () => !(await protectionSwitch().isChecked()) && (await heard(page).textContent()) === cards.SAVED, "the switch shows off once Turn off has saved");
			assert(JSON.stringify(sent) === JSON.stringify([{ state: "off" }]), `Turn off sends one {state:"off"}, got ${JSON.stringify(sent)}`);
			await waitUntil(() => listReads > readsBefore, "Home's list is read again after Turn off");
			const readsBeforeOn = listReads;
			await protectionSwitch().click();
			await waitUntil(async () => await protectionSwitch().isChecked() && JSON.stringify(sent.at(-1)) === JSON.stringify({ state: "on" }), "turning the switch on saves");
			assert(await page.getByRole("alertdialog").count() === 0 && JSON.stringify(sent) === JSON.stringify([{ state: "off" }, { state: "on" }]), `turning it on saves at once, with no question, got ${JSON.stringify(sent)}`);
			await waitUntil(() => listReads > readsBeforeOn, "Home's list is read again after Turn on");
			// Back on, the Commands line says the mode read with it: Auto's line, and no line at all when that read fails.
			for (const mode of [{ free: true }, "fails"] as const) {
				await ask();
				await question.getByRole("button", { name: cards.TURN_OFF, exact: true }).click();
				await waitUntil(async () => !(await protectionSwitch().isChecked()) && !(await protectionSwitch().isDisabled()), "the switch shows off again");
				const unrouteMode = await standInMode(page, roomId, mode);
				try {
					await protectionSwitch().click();
					if (mode === "fails") {
						await paneOf(page).getByText(cards.FOLDER_LOAD_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
						assert(await paneOf(page).getByText(cards.COMMANDS_PROTECTED_REACH, { exact: true }).count() === 0, "back on, a failed read of the mode shows the protected Commands line");
					} else {
						await waitUntil(async () => (await switchRow(page, cards.COMMANDS).locator(".settings-row-sub").first().textContent()) === cards.COMMANDS_FREE_REACH, "back on, a room read as Auto shows Auto's Commands line");
					}
				} finally {
					await unrouteMode();
				}
			}
			await closeSettings(page);
		} finally {
			await unroute();
			await page.unroute(`**${roomPath(roomId, "/protection")}`);
		}
	});

	await row(ROWS[9], async () => {
		const roomId = await newRoom("Refuse Desk", { tools: ALL_TOOLS, commands: false });
		let shown: object = PROTECTIONS.on;
		let readFails = false;
		let answer: { status: number; body: object } = { status: 500, body: {} };
		const pattern = `**${roomPath(roomId, "/workspace-default")}`;
		await page.route(pattern, async (route) => {
			if (route.request().method() !== "GET") return route.continue();
			if (readFails) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Internal Server Error" }) });
			const response = await route.fetch();
			await route.fulfill({ response, json: { ...(await response.json()), protection: shown } });
		});
		await page.route(`**${roomPath(roomId, "/protection")}`, (route) => route.fulfill({ status: answer.status, contentType: "application/json", body: JSON.stringify(answer.body) }));
		const SERVER_WORDS = "The server's own words, never shown.";
		try {
			await openPane(page, "Refuse Desk");
			const turnOff = async () => {
				await switchOf(page, cards.PROTECTION).click();
				await page.getByRole("alertdialog").getByRole("button", { name: cards.TURN_OFF, exact: true }).click();
			};
			// A cause stands now: the row says its line, and no failure line.
			answer = { status: 409, body: { error: SERVER_WORDS, code: "protection_unavailable" } };
			shown = PROTECTIONS.folder;
			await turnOff();
			await protectionRow(page).getByText(cards.PROTECTION_ROW_UNAVAILABLE_FOLDER, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await paneOf(page).getByText(SERVER_WORDS).count() === 0 && await paneOf(page).getByText(cards.CHANGE_SAVE_FAILED).count() === 0, "a standing cause says its own line, never the server's words or a failure");
			const causeLines = await paneOf(page).getByText(cards.PROTECTION_ROW_UNAVAILABLE_FOLDER, { exact: true }).count();
			const generalLines = await paneOf(page).getByText(cards.PROTECTION_ROW_UNAVAILABLE, { exact: true }).count() + await paneOf(page).getByText(cards.PROTECTION_UNAVAILABLE, { exact: true }).count();
			assert(causeLines === 1 && generalLines === 0, `a standing cause says its line once, and not the line for a cause not known: ${causeLines} / ${generalLines}`);
			assert(await heard(page).textContent() !== cards.SAVED, "a refused Turn off whose cause stands is never heard as Saved");
			await closeSettings(page);
			// Refused for a cause the read back doesn't show: the line stands under the row's own, so it says the whole sentence.
			shown = PROTECTIONS.on;
			await openPane(page, "Refuse Desk");
			await turnOff();
			await protectionRow(page).getByText(cards.PROTECTION_UNAVAILABLE, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await paneOf(page).getByText(SERVER_WORDS).count() === 0, "a refusal with no cause standing says the whole sentence, never the server's words");
			await closeSettings(page);
			// The room started answering: the row waits, quietly.
			shown = PROTECTIONS.on;
			answer = { status: 409, body: { error: SERVER_WORDS, code: "active_turn_in_flight" } };
			await openPane(page, "Refuse Desk");
			await turnOff();
			const wait = protectionRow(page).getByText(cards.ROOM_ANSWERING_CHANGE_LINE, { exact: true });
			await wait.waitFor({ timeout: 10_000 });
			assert(await wait.getAttribute("role") === "status", "a wait is a quiet status");
			await closeSettings(page);
			// Any other failure: the room read back shows its stored state, with the failure line.
			answer = { status: 500, body: { error: SERVER_WORDS } };
			await openPane(page, "Refuse Desk");
			await turnOff();
			await protectionRow(page).getByText(cards.CHANGE_SAVE_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			assert(await switchOf(page, cards.PROTECTION).isChecked() && await paneOf(page).getByText(SERVER_WORDS).count() === 0, "the switch is back on, as stored, with the failure line and not the server's words");
			// And where that read fails too, the pane says so with Try again.
			readFails = true;
			await turnOff();
			await paneOf(page).getByText(cards.FOLDER_LOAD_FAILED, { exact: true }).waitFor({ timeout: 10_000 });
			readFails = false;
			await paneOf(page).getByRole("button", { name: cards.TRY_AGAIN }).click();
			await protectionRow(page).waitFor({ timeout: 10_000 });
			await closeSettings(page);
		} finally {
			await page.unroute(pattern);
			await page.unroute(`**${roomPath(roomId, "/protection")}`);
		}
	});

	await row(ROWS[10], async () => {
		const listedRoot = newFolder("Sales Review");
		const priceLists = newFolder("Price Lists");
		const listedDesk = await newRoom("Listed Desk", { root: listedRoot, tools: ALL_TOOLS, commands: true });
		writeSetting(runtimeOf(listedDesk, "also-allowed.json"), { folders: [{ path: priceLists, access: "read" }], sites: [{ host: "example.com", port: 443 }] });
		for (const key of Object.keys(PROTECTIONS) as ProtectionKey[]) {
			const unroute = await standInRead(page, listedDesk, (body) => ({ ...body, protection: PROTECTIONS[key] }));
			try {
				const pane = await openPane(page, "Listed Desk");
				const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
				await list.locator(".also-allowed-row").first().waitFor({ timeout: 10_000 });
				const head = await list.locator(".group-head-line").allTextContents();
				assert(same(head, [cards.ALSO_ALLOWED_LINE]), `stand-in ${key}: Also allowed's heading says its one sentence, got ${JSON.stringify(head)}`);
				const location = pane.locator(".folder-pane-location .workspace-folder-name");
				assert(await location.textContent() === "Sales Review" && await location.getAttribute("title") === listedRoot && !(await pane.locator(".folder-pane-location").innerText()).includes(folders), `stand-in ${key}: Location shows the folder's name, its path on the name, got ${await pane.locator(".folder-pane-location").innerText()}`);
				const folderRow = list.locator(".also-allowed-row").filter({ hasText: "Price Lists" });
				const [name, under] = [folderRow.locator(".also-allowed-name"), await folderRow.locator(".settings-row-sub").allTextContents()];
				assert(await name.textContent() === "Price Lists" && await name.getAttribute("title") === priceLists && same(under, [cards.CAN_READ]) && !(await list.innerText()).includes(folders), `stand-in ${key}: the listed folder shows its name with Can read under it and no path, got ${await list.innerText()}`);
				// The room's own folder name reads as a name, in the darker colour of a listed folder's access, not the grey of the lines under a row.
				const colourOf = (at: Locator) => at.evaluate((el) => getComputedStyle(el).color);
				const [locationColour, accessColour] = [await colourOf(location), await colourOf(folderRow.locator(".also-allowed-access"))];
				assert(locationColour === accessColour, `stand-in ${key}: Location's name in ${locationColour}, a listed folder's access in ${accessColour}`);
				await closeSettings(page);
			} finally {
				await unroute();
			}
		}
		// With no folder the row shows only where the person turned protection off, and Also allowed's heading has no line.
		const siteOnly = await newRoom("Site Only Desk");
		writeSetting(runtimeOf(siteOnly, "also-allowed.json"), { folders: [], sites: [{ host: "pypi.org", port: 443 }] });
		for (const key of Object.keys(PROTECTIONS) as ProtectionKey[]) {
			const unroute = await standInRead(page, siteOnly, (body) => ({ ...body, protection: PROTECTIONS[key] }));
			try {
				await openPane(page, "Site Only Desk");
				const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
				await list.getByText("pypi.org").first().waitFor({ timeout: 10_000 });
				const rows = await paneOf(page).locator(".folder-pane-protection").count();
				const lines = await list.locator(".group-head-line").count();
				assert(rows === (key === "person" ? 1 : 0) && lines === 0, `no folder, stand-in ${key}: the row shows ${rows} times and the heading's line ${lines}`);
				await closeSettings(page);
			} finally {
				await unroute();
			}
		}
	});

	await row(ROWS[11], async () => {
		const phone = await newPage({ remote: true });
		try {
			// A phone is sent names alone (room-workspace-path-reach-smoke holds the server's answer); here the folder's cause stands.
			await standInRead(phone, linesDesk, (body) => ({ ...body, protection: PROTECTIONS.folder, policy: { ...body.policy, roots: body.policy.roots.map(({ path: _path, ...rest }: any) => rest) } }));
			const pane = await openPane(phone, "Lines Desk");
			await pane.locator(".workspace-folder-name").waitFor({ timeout: 10_000 });
			const text = await pane.innerText();
			assert(await pane.getByText(cards.CHANGEABLE_AT_COMPUTER, { exact: true }).count() === 1, `one Changeable at the computer only for the pane, got: ${text}`);
			for (const control of await pane.getByRole("switch").all()) assert(await control.isDisabled(), "every switch is greyed on a phone");
			assert(await pane.getByRole("switch").count() === 3, "the three switches show, greyed");
			assert(await pane.getByRole("button").count() === 0, `no buttons on a phone, got: ${(await pane.getByRole("button").allTextContents()).join(",")}`);
			assert(!text.includes(folders) && await pane.locator(".workspace-folder-name").getAttribute("title") === null, "no path on a phone, not even on the name");
			assert(await protectionRow(phone).locator(".settings-row-label").textContent() === cards.PROTECTION && !(await switchOf(phone, cards.PROTECTION).isChecked()) && !text.includes(cards.PROTECTION_ROW_UNAVAILABLE_FOLDER), "the switch shows off without its cause");
			assert(await pane.locator(".folder-pane-switch-row .settings-row-sub").count() === 0, `no line under any switch on a phone, got: ${text}`);
		} finally {
			await phone.context().close();
		}
	});

	await row(ROWS[12], async () => {
		assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
		const phone = await pairDevice(port, "Folder pane phone", "full");
		const fromPhone = (tail: string, method: string, body?: object) => remoteRequest(port, roomPath(linesDesk, tail), { method, headers: { Cookie: phone.cookie, Origin: `http://[::1]:${port}`, ...(body ? { "content-type": "application/json" } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
		const before = JSON.stringify(policyStore.readPersistentRoomDefaultCapabilityPolicy(linesDesk));
		const read = await fromPhone("/workspace-default", "GET");
		assert(read.status === 200, `the phone reads the pane, got ${read.status}`);
		for (const [tail, method, body] of [
			["/workspace-default", "PUT", { bashEnabled: false }],
			["/workspace-default", "PUT", { root: newFolder("phone pick") }],
			["/workspace-default", "DELETE", undefined],
			["/protection", "PUT", { state: "off" }],
			["/also-allowed/folders", "POST", { path: newFolder("phone list") }],
			["/also-allowed/remove", "POST", { kind: "site", host: "pypi.org", port: 443 }],
		] as const) {
			const answer = await fromPhone(tail, method, body);
			assert(answer.status === 403, `${method} ${tail} from a phone is refused, got ${answer.status} ${answer.body}`);
		}
		assert(JSON.stringify(policyStore.readPersistentRoomDefaultCapabilityPolicy(linesDesk)) === before, "nothing the phone sent changed the room");
	});

	await row(ROWS[13], async () => {
		const roomId = await newRoom("Bounded Desk", { access: "bounded" });
		const protection = await protectionHere(roomId);
		if (protection?.state !== "on") return WITHOUT_PROTECTION;
		const command = [[{ name: "bash", args: { command: "echo hello" } }]];
		assert(storedCommands(roomId) === "switched-off", `an older Bounded room reads Commands switched off, got ${storedCommands(roomId)}`);
		const off = await turn(roomId, command);
		assert(!off.tools.includes("bash") && !off.tools.includes("ask_for_commands") && asksOf(roomId) === 0, `with Commands off it offers no command and no ask, and asks no box: offered ${off.tools.join(",")}, box asked ${asksOf(roomId)}`);
		await openPane(page, "Bounded Desk");
		assert(!(await switchOf(page, cards.COMMANDS).isChecked()), "the pane shows its Commands off");
		await switchOf(page, cards.COMMANDS).click();
		await savedHeardNotShown(page);
		await closeSettings(page);
		const on = await turn(roomId, command);
		assert(on.tools.includes("bash") && asksOf(roomId) > 0, `once turned on, its next command goes to the box: offered ${on.tools.join(",")}, box asked ${asksOf(roomId)}`);
		assert(!on.results.some((result) => result.includes("hello")), `the box was refused, so the command never ran, got ${JSON.stringify(on.results)}`);
	}, "needs a computer where protection runs");

	await row(ROWS[14], async () => {
		const roomId = await newRoom("Follow Desk", { tools: READ_TOOLS, commands: false });
		writeSetting(runtimeOf(roomId, "also-allowed.json"), { folders: [{ path: newFolder("Follow listed"), access: "read" }], sites: [] });
		await openPane(page, "Follow Desk");
		const list = page.locator(".room-settings-section:not([hidden]) section.also-allowed");
		await list.getByText("Follow listed").first().waitFor({ timeout: 10_000 });
		const allow = list.getByRole("button", { name: cards.ALLOW_CHANGES, exact: true });
		assert(await allow.count() === 0, "with Can change files off, a Can read folder offers no Allow changes");
		for (const on of [true, false]) {
			await switchOf(page, cards.CAN_CHANGE_FILES).click();
			await waitUntil(() => (storedTools(roomId) === toolSet(ALL_TOOLS)) === on, `Can change files saved ${on ? "on" : "off"}`);
			await waitUntil(async () => (await allow.count()) === (on ? 1 : 0), `with Can change files ${on ? "on" : "off"}, Allow changes ${on ? "shows" : "goes"} without reopening`);
		}
		// The read Can change files starts answers late, with the list as it stood before the row was removed.
		const listPattern = `**${roomPath(roomId, "/also-allowed")}`;
		let held = false;
		let release!: () => void;
		const released = new Promise<void>((resolve) => { release = resolve; });
		let answered!: () => void;
		const lateAnswer = new Promise<void>((resolve) => { answered = resolve; });
		const before = (await json(roomPath(roomId, "/also-allowed"))).body;
		await page.route(listPattern, async (route) => {
			if (route.request().method() !== "GET" || held) return route.fallback();
			held = true;
			await released;
			await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(before) });
			answered();
		});
		try {
			await switchOf(page, cards.CAN_CHANGE_FILES).click();
			await waitUntil(() => held, "the list is read again after Can change files");
			await list.getByRole("button", { name: `${cards.REMOVE_FROM_LIST}: Follow listed` }).click();
			const removedLine = list.locator(".also-allowed-removed").getByText(cards.folderRemovedLine("Follow listed"), { exact: true });
			await removedLine.waitFor({ timeout: 10_000 });
			release();
			await lateAnswer;
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			assert(await list.getByRole("button", { name: `${cards.REMOVE_FROM_LIST}: Follow listed` }).count() === 0 && await removedLine.count() === 1, `a late read of the list put a removed row back: ${JSON.stringify(await list.innerText())}`);
		} finally {
			release();
			await page.unroute(listPattern);
		}
		await closeSettings(page);
	});

	await row(ROWS[15], async () => {
		const roomId = await newRoom("Text Desk", { tools: READ_TOOLS, commands: true });
		if ((await protectionHere(roomId))?.state !== "on") return WITHOUT_PROTECTION;
		const capability = () => policyStore.resolvePersistentRoomEffectiveWorkspacePolicy(roomId, "conversation-text").capability;
		assert(capability()?.bashEnabled === true && capability()?.commandsChangeFiles === false, `protected: commands on and held to reading, got ${JSON.stringify(capability())}`);
		const off = await json(roomPath(roomId, "/protection"), { method: "PUT", body: JSON.stringify({ state: "off" }) });
		assert(off.status === 200, `the person turns protection off, got ${off.status}`);
		assert(capability()?.commandsChangeFiles === true, `turned off: commands can change files, got ${JSON.stringify(capability())}`);
	}, "needs a computer where protection runs");

	await row(ROWS[16], async () => {
		const probe = await newRoom("Pick Probe Desk");
		const protects = (await protectionHere(probe))?.state === "on";
		const locationLines = async () => JSON.stringify(await paneOf(page).locator(".folder-pane-location .settings-row-sub").allTextContents());
		// Each room's first folder as the person left it, then Stop using and the next folder with the switch untouched.
		// Where protection runs, a new room's commands start on, "automatic"; elsewhere the person turned them on.
		const cases: Array<[string, { commands?: boolean; runWithoutAsking: boolean }, boolean]> = [
			["commands on, run without asking", { ...(protects ? {} : { commands: true }), runWithoutAsking: true }, true],
			["commands on, each asks first", { ...(protects ? {} : { commands: true }), runWithoutAsking: false }, false],
			["commands off", { commands: false, runWithoutAsking: true }, false],
		];
		for (const [label, first, runsWithoutAsking] of cases) {
			const name = `Pick ${label}`;
			const roomId = await newRoom(name, { tools: ALL_TOOLS, ...(first.commands === undefined ? {} : { commands: first.commands }) }, protects);
			const asking = await putRunWithoutAsking(`${baseUrl}${roomPath(roomId, "/bash-settings")}`, first.runWithoutAsking);
			assert(asking.status === 200, `${label}: Run without asking was saved, got ${asking.status}`);
			const cleared = await json(roomPath(roomId, "/workspace-default"), { method: "DELETE" });
			assert(cleared.status === 200, `${label}: Stop using, got ${cleared.status}`);
			const startsOn = (await folderRead(roomId))?.commandsStartOn;
			assert(startsOn === runsWithoutAsking, `${label}: after Stop using the read says commands start on ${runsWithoutAsking}, got ${startsOn}`);
			if (protects) {
				await openPane(page, name);
				await paneOf(page).getByText(cards.NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
				assert(await locationLines() === JSON.stringify([cards.NO_FOLDER_YET_LINE]), `${label}: Location shows its one line and no pick line, got ${await locationLines()}`);
				await closeSettings(page);
			}
			const next = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: newFolder(), workspaceAccessMode: "localFiles" }) });
			assert(next.status === 200, `${label}: the next folder was saved, got ${next.status}`);
			const commands = storedCommands(roomId);
			const autoApprove = (await json(roomPath(roomId, "/bash-settings"))).body?.settings?.autoApprove;
			const ran = (commands === "on" || commands === "automatic") && autoApprove === true;
			assert(ran === runsWithoutAsking, `${label}: the next folder's commands ${runsWithoutAsking ? "run without asking" : "ask first or stay off"}, got ${commands} / Run without asking ${autoApprove}`);
		}
	});

	await row(ROWS[17], async () => {
		const roomId = await newRoom("Off Keep Desk", { tools: ALL_TOOLS, commands: true });
		if ((await protectionHere(roomId))?.state !== "on") return WITHOUT_PROTECTION;
		const off = await json(roomPath(roomId, "/protection"), { method: "PUT", body: JSON.stringify({ state: "off" }) });
		assert(off.status === 200, `the person turns protection off, got ${off.status}`);
		const cleared = await json(roomPath(roomId, "/workspace-default"), { method: "DELETE" });
		assert(cleared.status === 200, `Stop using, got ${cleared.status}`);
		const next = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: newFolder(), workspaceAccessMode: "localFiles" }) });
		assert(next.status === 200, `the next folder was saved, got ${next.status}`);
		const byPerson = (protection: any) => protection?.state === "off" && protection.cause === undefined;
		const commandsRead = (await json(roomPath(roomId, "/bash-settings"))).body?.protection;
		const folderProtection = (await folderRead(roomId))?.protection;
		assert(byPerson(commandsRead) && byPerson(folderProtection), `the next folder's room reads Off by the person, got commands ${JSON.stringify(commandsRead)} / folder ${JSON.stringify(folderProtection)}`);
	}, "needs a computer where protection runs");

	await row(ROWS[18], async () => {
		const clear = async (roomId: string, label: string) => {
			const cleared = await json(roomPath(roomId, "/workspace-default"), { method: "DELETE" });
			assert(cleared.status === 200, `${label}: Stop using, got ${cleared.status}`);
		};
		// The chat's pick sends the folder alone.
		const folderAlone = async (roomId: string, label: string) => {
			const saved = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: newFolder() }) });
			assert(saved.status === 200, `${label}: the folder was saved, got ${saved.status}: ${JSON.stringify(saved.body)}`);
		};
		const reader = await newRoom("Left Reading Desk", { tools: READ_TOOLS, commands: false });
		await clear(reader, "left reading only");
		await folderAlone(reader, "left reading only");
		assert(storedTools(reader) === toolSet(READ_TOOLS), `left reading only: the next folder reads only, got ${storedTools(reader)}`);
		assert(keptOf(reader) === null, `left reading only: the kept state goes with the next folder's save, kept ${JSON.stringify(keptOf(reader))}`);
		const writer = await newRoom("Left Writing Desk", { tools: ALL_TOOLS, commands: false });
		await clear(writer, "left able to change files");
		await folderAlone(writer, "left able to change files");
		assert(storedTools(writer) === toolSet(ALL_TOOLS), `left able to change files: the next folder can change files, got ${storedTools(writer)}`);
		const fresh = await newRoom("First Writing Desk");
		await folderAlone(fresh, "a new room's first folder");
		assert(storedTools(fresh) === toolSet(ALL_TOOLS), `a new room's first folder can change files, got ${storedTools(fresh)}`);
		const older = await newRoom("Older Kept Desk");
		fs.writeFileSync(runtimeOf(older, "commands-kept.json"), JSON.stringify({ schemaVersion: 1, commands: "off" }), { mode: 0o600 });
		await folderAlone(older, "kept before the field");
		assert(storedTools(older) === toolSet(ALL_TOOLS), `a kept file with no Can change files: the next folder can change files, got ${storedTools(older)}`);
		const moving = await newRoom("Moving Reader Desk", { tools: READ_TOOLS, commands: false });
		await folderAlone(moving, "another folder while one is set");
		assert(storedTools(moving) === toolSet(READ_TOOLS), `a room with a folder, reading only, given another still reads only, got ${storedTools(moving)}`);
	});

	await row(ROWS[19], async () => {
		const roomId = await newRoom("Pane Reader Desk", { tools: READ_TOOLS, commands: false });
		const puts: any[] = [];
		page.on("request", (request) => { if (request.method() === "PUT" && request.url().endsWith(roomPath(roomId, "/workspace-default"))) puts.push(request.postDataJSON()); });
		const pane = await openPane(page, "Pane Reader Desk");
		await pane.getByRole("button", { name: cards.STOP_USING_FOLDER }).click();
		await page.getByRole("alertdialog").getByRole("button", { name: cards.STOP_USING, exact: true }).click();
		await pane.getByText(cards.NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
		const restore = await folderWindowGives(page, newFolder("Pane reader next"));
		try {
			await pane.locator(".folder-pane-location").getByRole("button", { name: cards.CHOOSE_FOLDER }).click();
			await switchOf(page, cards.CAN_CHANGE_FILES).waitFor({ timeout: 10_000 });
		} finally {
			await restore();
		}
		assert(puts.length === 1 && !("toolSelection" in puts[0]), `the pick in a room with no folder sends no tool choice, got ${JSON.stringify(puts)}`);
		assert(storedTools(roomId) === toolSet(READ_TOOLS), `the next folder reads only, got ${storedTools(roomId)}`);
		assert(!(await switchOf(page, cards.CAN_CHANGE_FILES).isChecked()), "the pane shows Can change files off");
		await closeSettings(page);
	});

	await row(ROWS[20], async () => {
		const ownHome = path.join(tempRoot, "own-server-home");
		const ownAgents = path.join(ownHome, ".exxperts", "app", "personalized-agents");
		const ownFolder = (name: string) => {
			const folder = path.join(ownHome, "Documents", name);
			fs.mkdirSync(folder, { recursive: true });
			return folder;
		};
		fs.mkdirSync(ownAgents, { recursive: true, mode: 0o700 });
		const ownPort = await freePort();
		const ownUrl = `http://127.0.0.1:${ownPort}`;
		const start = async () => {
			const server = spawn("npx", ["tsx", "src/index.ts"], {
				shell: process.platform === "win32",
				...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
				cwd: path.join(repoRoot, "apps", "web-server"),
				env: smokeHomeEnv(ownHome, { PORT: String(ownPort), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXETA_PERSISTENT_AGENTS_ROOT: ownAgents }) as NodeJS.ProcessEnv,
			});
			server.stdout.resume();
			server.stderr.resume();
			try {
				await waitForServer(server, ownUrl, 60_000);
			} catch (error) {
				await stopSmokeServer(server);
				throw error;
			}
			return server;
		};
		let server = await start();
		let roomId: string;
		try {
			const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Restart Reader Desk", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) }, ownUrl);
			roomId = String(created.body?.agent?.id ?? "");
			assert(created.status === 201 && roomId, `the room was made, got ${created.status}`);
			const saved = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: ownFolder("First"), toolSelection: { kind: "custom", allowedToolNames: READ_TOOLS }, bashEnabled: false }) }, ownUrl);
			assert(saved.status === 200, `the room's folder was saved reading only, got ${saved.status}: ${JSON.stringify(saved.body)}`);
			const cleared = await json(roomPath(roomId, "/workspace-default"), { method: "DELETE" }, ownUrl);
			assert(cleared.status === 200, `Stop using, got ${cleared.status}`);
		} finally {
			await stopSmokeServer(server);
		}
		server = await start();
		try {
			assert(keptOf(roomId, ownAgents)?.canChangeFiles === false, `after the server starts again the kept state says it reads only, kept ${JSON.stringify(keptOf(roomId, ownAgents))}`);
			const next = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: ownFolder("Next") }) }, ownUrl);
			assert(next.status === 200, `the next folder was saved, got ${next.status}: ${JSON.stringify(next.body)}`);
			const tools = toolSet(next.body?.policy?.allowedToolNames);
			assert(tools === toolSet(READ_TOOLS), `the next folder reads only, got ${tools}`);
			assert(keptOf(roomId, ownAgents) === null, `the kept state goes with the next folder's save, kept ${JSON.stringify(keptOf(roomId, ownAgents))}`);
		} finally {
			await stopSmokeServer(server);
		}
	});

	await row(ROWS[21], async () => {
		const name = "Reader Commands Desk";
		const roomId = await newRoom(name, { tools: READ_TOOLS, commands: true });
		const asking = await putRunWithoutAsking(`${baseUrl}${roomPath(roomId, "/bash-settings")}`, true);
		assert(asking.status === 200, `Run without asking was saved, got ${asking.status}`);
		const cleared = await json(roomPath(roomId, "/workspace-default"), { method: "DELETE" });
		assert(cleared.status === 200, `Stop using, got ${cleared.status}`);
		const read = await folderRead(roomId);
		assert(read?.commandsStartOn === false, `after Stop using the read says commands don't start on, got ${read?.commandsStartOn}`);
		const protection = read?.protection as { state: string; cause?: string } | undefined;
		if (protection?.state === "on") {
			await openPane(page, name);
			await paneOf(page).getByText(cards.NO_FOLDER_YET_LINE, { exact: true }).waitFor({ timeout: 10_000 });
			const lines = JSON.stringify(await paneOf(page).locator(".folder-pane-location .settings-row-sub").allTextContents());
			assert(lines === JSON.stringify([cards.NO_FOLDER_YET_LINE]), `Location shows its one line and no pick line, got ${lines}`);
			await closeSettings(page);
		}
		const next = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: newFolder() }) });
		assert(next.status === 200 && storedTools(roomId) === toolSet(READ_TOOLS), `the next folder reads only, got ${next.status} / ${storedTools(roomId)}`);
		if (protection?.state === "off" && protection.cause === "computer") {
			const { tools } = await turn(roomId, []);
			assert(!tools.includes("bash") && !tools.includes("ask_for_commands"), `on a computer with no protection neither commands nor their ask are offered: offered ${tools.join(",")}`);
		}
	});

	await row(ROWS[22], async () => {
		const roomId = await newRoom("Later Commands Desk", { tools: ALL_TOOLS, commands: true });
		if ((await protectionHere(roomId))?.state !== "on") return WITHOUT_PROTECTION;
		const runsWithoutAsking = async () => (await json(roomPath(roomId, "/bash-settings"))).body?.settings?.autoApprove;
		const asking = await putRunWithoutAsking(`${baseUrl}${roomPath(roomId, "/bash-settings")}`, true);
		assert(asking.status === 200 && await runsWithoutAsking() === true, `protected, commands run without asking, got ${asking.status} / ${await runsWithoutAsking()}`);
		const commandsOff = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ bashEnabled: false }) });
		assert(commandsOff.status === 200 && storedCommands(roomId) !== "on" && storedCommands(roomId) !== "automatic", `Commands turned off, got ${commandsOff.status} / ${storedCommands(roomId)}`);
		const off = await json(roomPath(roomId, "/protection"), { method: "PUT", body: JSON.stringify({ state: "off" }) });
		assert(off.status === 200, `the person turns protection off, got ${off.status}`);
		const commandsOn = await json(roomPath(roomId, "/workspace-default"), { method: "PUT", body: JSON.stringify({ bashEnabled: true }) });
		assert(commandsOn.status === 200 && storedCommands(roomId) === "on", `Commands turned on later, got ${commandsOn.status} / ${storedCommands(roomId)}`);
		assert(await runsWithoutAsking() === false, `turned off, each command asks first, got Run without asking ${await runsWithoutAsking()}`);
		const on = await json(roomPath(roomId, "/protection"), { method: "PUT", body: JSON.stringify({ state: "on" }) });
		assert(on.status === 200 && await runsWithoutAsking() === true, `turned back on, commands run without asking again, got ${on.status} / ${await runsWithoutAsking()}`);
	}, "needs a computer where protection runs");
} finally {
	await closeBrowser(browser);
	gateway.closeAllConnections();
	gateway.close();
	fs.rmSync(tempRoot, { recursive: true, force: true });
}

// Only a gap says skipped, which the smoke runner reads as one (skipLines in scripts/run-smokes.mjs).
console.log(`folder pane smoke: ${passed} passed, ${elsewhere} for another system${skipped ? `, ${skipped} skipped` : ""}, ${failures.length} failed`);
for (const name of failures) console.log(`  failed: ${name}`);
process.exit(failures.length ? 1 : 0);
