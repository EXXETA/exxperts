// A room's protection, its own and changed only by the app's control, on a
// Mac. A real server runs in this process with a gateway playing the model,
// and real room connections send real messages. Whether a call went to the
// room's box is read where the server asks for it (`RoomBox.ensureRun`).
//
// The box itself runs only where it is meant to be tested: on a Mac, unless
// `--no-box` is given. With it, starting a box fails at once, as a box that
// won't start does, so every row but the box's own walls still runs and says
// so; those print as skipped. On any other computer every row is skipped.
// Run: npm run smokes -- room-protection
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { pairDevice, remoteRequest } from "./smoke-pairing.js";
import { authedFetch, freePort, putRunWithoutAsking, SMOKE_AUTH_HEADERS, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";

const ROWS = [
	"no file, a malformed file, an unreadable one and an older app's data read On; a file read at start counts; a room made with the name of one deleted while off reads On; a protected room's commands and file tools ask the box",
	"Turn off, then Turn on, on one open connection: off, the next message has no box for commands, no run_outside_box, no box line, no word on where each kind of file goes, and a card for each command, while its file calls still read and write in the box; on, all of it is back with the protected Run without asking",
	"a turn in flight keeps its box: while the room answers, the route refuses on and off and writes nothing",
	"Run without asking holds only in the state it was given in: an unprotected yes isn't honoured once protected and is gone after; a protected yes never holds while off and comes back",
	"the chip's write carries the state it read: none, another state or another cause is refused with the app's sentence and stores nothing, in a room that is on and in one she turned off",
	"the chip in the page sends the protection it last read, on and off, and reads again after a refusal",
	"a yes on the commands card shows the chip at once, with no focus change or reload: Turn on anyway in a room she turned off, under the card's line for it, and Turn on commands in a protected room",
	"a yes from before converts at the room's first known state: a Mac's, a Windows one where the box works, an older app's own to Auto where the room's commands are on and to Semi where they are off, one where it can't; not known converts nothing",
	"causes: this computer, a network folder, a drive letter; the route refuses where a cause stands; the commands card's line names the room only where she or the folder is why",
	"a protection.json changed on disk while the server runs changes nothing: reads, the route and the next message keep the held state",
	"out of the assistant's reach: only the route imports the writer; a file tool can't write the file; fetch_url can't reach the app; a phone's PUT is refused; nothing the model reads names the switch",
	"a boxed command can't write protection.json, read the sign-in file or reach the app's port",
	"a protected room whose box fails runs nothing; an unreadable file keeps the box",
	"a message bound while off whose turn starts after Turn on asks before each command: the protected Run without asking waits for the next message",
	"while off, on Auto a command in a turn whose window closed runs, and on Ask it doesn't; a protected room's runs in its box",
	"what the model is sent per mode, live and in a scheduled run: Ask and Semi that a site needs the person's yes, Auto that public websites need none, what stays closed, and the reader's line",
	"a room on Auto turned off asks before each command and loses the Auto lines; turned on again it is on Auto; a phone's write of the mode is refused",
	"while off, on Auto the model is told public websites open without asking, live and in a scheduled run, which opens a page it would have asked for and still runs no command; on Ask it isn't, and the scheduled run's page is refused",
	"while off, Auto switched to Ask while the room answers: the next page asks and the next command asks",
	"while off, on Auto a viewing-only phone that takes the answer over sees its commands run, and the away limit still ends it, also after the computer's window stepped back in first, while the phone comes and goes, and when the room goes on Auto after the phone took it over on Ask, also for an answer that only opens pages; with the person in the room a page or a command on Auto starts no limit; on Ask the takeover stands the limits down",
	"on a shared server, a room stored off has no protection in either read, and its Turn on is refused",
];

if (process.platform !== "darwin") {
	for (const name of ROWS) console.log(`  skip ${name} (needs a Mac)`);
	process.exit(0);
}
const realBox = !process.argv.includes("--no-box");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const waitUntil = waitEvery(25, 30_000);
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(scriptDir, "..", "..", "..");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-room-protection-")));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const folders = path.join(home, "Documents");
for (const dir of [agentDir, agentsRoot, folders]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const MODEL = { provider: "openai-compatible", model: "room-model" };
const AWAY_SILENCE_MS = 5_000;
// The sign-in file a command must not read: this run pins its token, so the file is planted.
const SIGN_IN_MARK = "sign-in-file-mark-6d1f";
fs.writeFileSync(path.join(appRoot, "auth-token"), `${SIGN_IN_MARK}\n`, { mode: 0o600 });

// --- The gateway plays the model: each leg of a turn makes its calls, then it answers in words.
type Call = { name: string; args: Record<string, unknown> };
let legs: Call[][] = [];
let toolResults: string[] = [];
/** Every request the model got: its tool names, what the app told it (the system prompt, tool definitions and the app's own messages), and what it told since the model last spoke. */
const requests: { tools: string[]; told: string; system: string; fresh: string }[] = [];
// While set, the model's next call with tools waits before it is answered: a window can close in between.
let gatewayHold: Promise<void> | null = null;
let gatewayHeld = false;
const sse = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const text = (message: any) => (typeof message?.content === "string" ? message.content : Array.isArray(message?.content) ? message.content.map((part: any) => String(part?.text ?? "")).join("") : "");
		const tools = (parsed.tools ?? []).map((tool: any) => String(tool?.function?.name ?? tool?.name ?? ""));
		// What the app wrote: never the person's message, the model's calls or what a tool gave back.
		const appWrote = (message: any) => message?.role === "system" || (message?.role === "user" && !PROMPTS.has(text(message).trim()));
		const told = [...messages.filter(appWrote).map(text), JSON.stringify(parsed.tools ?? [])].join("\n");
		const fresh = messages.slice(messages.map((message) => message?.role).lastIndexOf("assistant") + 1).filter(appWrote).map(text).join("\n");
		const system = messages.filter((message) => message?.role === "system").map(text).join("\n");
		requests.push({ tools, told, system, fresh });
		if (gatewayHold && tools.length > 0) {
			gatewayHeld = true;
			await gatewayHold;
		}
		const userAt = messages.map((message) => message?.role).lastIndexOf("user");
		const sinceUser = messages.slice(userAt + 1);
		const offeredTools = tools.length > 0;
		if (offeredTools) toolResults = sinceUser.filter((message) => message?.role === "tool").map(text);
		const done = sinceUser.filter((message) => message?.role === "assistant").length;
		const leg = offeredTools ? legs[done] : undefined;
		const base = { id: `cmpl_${done}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: MODEL.model };
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		if (leg) {
			const tool_calls = leg.map((call, index) => ({ index, id: `call_${requests.length}_${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sse({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sse({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 4, total_tokens: 154 } }));
		}
		res.end("data: [DONE]\n\n");
	});
});
const PROMPT = "Work in the folder.";
const PROMPTS = new Set([PROMPT]);
await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-room-protection" } });
writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });

const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
for (const name of ["EXXPERTS_DATA_DIR", "EXXPERTS_STATE_HOME", "EXXPERTS_REAL_HOME", "EXXPERTS_TEST_SHELL_PLATFORM"]) delete process.env[name];
Object.assign(process.env, SMOKE_SERVER_AUTH_ENV, {
	HOME: home,
	USERPROFILE: home,
	PORT: String(port),
	EXXETA_HOME: repoRoot,
	EXXPERTS_CODING_AGENT_DIR: agentDir,
	EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot,
	EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
	EXXPERTS_TEST_INTROSPECTION: "1",
	// Short, so a row can watch the away limit end an answer; every other row's answer with nobody there makes progress well within it.
	EXXETA_DETACHED_TURN_SILENCE_MS: String(AWAY_SILENCE_MS),
	LOG_LEVEL: process.env.LOG_LEVEL ?? "warn",
});

// --- Rooms as they stand before this start: what the start reads once.
const agents = await import("../src/persistent-agents.js");
const runtimeOf = (roomId: string, ...names: string[]) => path.join(agentsRoot, roomId, "runtime", ...names);
const plantRoom = (name: string, plant: (runtime: string) => void): string => {
	const roomId = String(agents.createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	fs.mkdirSync(runtimeOf(roomId), { recursive: true });
	plant(runtimeOf(roomId));
	return roomId;
};
const before = {
	none: plantRoom("Start None", () => {}),
	malformed: plantRoom("Start Malformed", (runtime) => fs.writeFileSync(path.join(runtime, "protection.json"), "{ \"state\": \"off\"")),
	unschemed: plantRoom("Start Unschemed", (runtime) => fs.writeFileSync(path.join(runtime, "protection.json"), JSON.stringify({ state: "off" }))),
	unreadable: plantRoom("Start Unreadable", (runtime) => fs.mkdirSync(path.join(runtime, "protection.json"))),
	olderApp: plantRoom("Start Older App", (runtime) => fs.writeFileSync(path.join(runtime, "bash-settings.json"), JSON.stringify({ schemaVersion: 1, autoApprove: true, updatedAt: "2026-10-01T00:00:00.000Z" }))),
	off: plantRoom("Start Off", (runtime) => fs.writeFileSync(path.join(runtime, "protection.json"), JSON.stringify({ schemaVersion: 1, state: "off", updatedAt: "2026-10-01T00:00:00.000Z" }))),
};

const { BoxProcess } = await import("../src/room-box/box-process.js");
const { RoomBox } = await import("../src/room-box/box-session.js");
const cards = await import("../src/room-box/card-text.js");
const { NOBODY_TO_APPROVE_COMMAND } = await import("../src/persistent-room-bash-approval.js");
const { closedRefusal } = await import("../src/room-files.js");
const protection = await import("../src/persistent-room-protection.js");
const bashSettings = await import("../src/persistent-room-bash-settings.js");
const { detachedCookingRooms } = await import("../src/room-live-sessions.js");
const { DefaultResourceLoader } = await import("@exxeta/exxperts-runtime");
await import("../src/index.js");
await waitUntil(() => fetch(`${baseUrl}/healthz`).then((response) => response.ok, () => false), "the server is up", 60_000);

// --- Where the server asks for a box, by room. Without the box, or while it is made to fail, it won't start.
const boxAsks = new Map<string, number>();
const asksOf = (roomId: string) => boxAsks.get(roomId) ?? 0;
const ensureRun = RoomBox.prototype.ensureRun;
RoomBox.prototype.ensureRun = function (this: InstanceType<typeof RoomBox>) {
	const roomId = String((this as any).options.roomId);
	boxAsks.set(roomId, asksOf(roomId) + 1);
	return ensureRun.apply(this);
};
let boxFails = !realBox;
const startBox = BoxProcess.start;
BoxProcess.start = (async (...args: Parameters<typeof BoxProcess.start>) => {
	if (boxFails) throw new Error("the box did not start");
	return startBox(...args);
}) as typeof BoxProcess.start;
// While set, a bind waits after it has read the room's protection and before its turn begins.
let bindHold: Promise<void> | null = null;
let bindHeld = false;
const reload = DefaultResourceLoader.prototype.reload;
DefaultResourceLoader.prototype.reload = async function (this: InstanceType<typeof DefaultResourceLoader>, ...args: Parameters<typeof reload>) {
	if (bindHold) {
		bindHeld = true;
		await bindHold;
	}
	return reload.apply(this, args);
};

async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`${baseUrl}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const roomPath = (roomId: string, tail = "") => `/api/persistent-agents/${encodeURIComponent(roomId)}${tail}`;
const turnProtection = (roomId: string, state: unknown) => json(roomPath(roomId, "/protection"), { method: "PUT", body: JSON.stringify({ state }) });
const protectionShown = async (roomId: string) => (await json(roomPath(roomId, "/workspace-default"))).body?.protection;
const runsWithoutAsking = async (roomId: string) => (await json(roomPath(roomId, "/bash-settings"))).body?.settings?.autoApprove === true;
const chip = (roomId: string, autoApprove: boolean) => putRunWithoutAsking(`${baseUrl}${roomPath(roomId, "/bash-settings")}`, autoApprove);
const storedSettings = (roomId: string) => JSON.parse(fs.readFileSync(runtimeOf(roomId, "bash-settings.json"), "utf8"));
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

let made = 0;
/** A room as the page makes one: its folder in Full access with commands on, which on a Mac start in Run without asking. */
async function newRoom(name: string): Promise<{ id: string; folder: string }> {
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	const id = String(created.body?.agent?.id ?? "");
	assert(created.status === 201 && id, `${name} was made, got ${created.status}`);
	const folder = path.join(folders, `folder-${++made}`);
	fs.mkdirSync(folder, { recursive: true });
	fs.writeFileSync(path.join(folder, "notes.txt"), "needle here\n");
	const saved = await json(roomPath(id, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: name, workspaceAccessMode: "localFiles" }) });
	assert(saved.status === 200 && saved.body?.policy?.bashEnabled === true, `${name}'s folder with commands on, got ${saved.status}: ${JSON.stringify(saved.body)}`);
	return { id, folder: fs.realpathSync(folder) };
}

const WebSocketImpl: any = (await import("ws")).default;
let conversations = 0;
/** A room connection: each turn's legs, its cards answered yes unless told otherwise, and what the model was offered and told. */
async function openWindow(roomId: string) {
	const conversation = `conversation-${++conversations}`;
	const seeded = await json(roomPath(roomId, `/threads/${conversation}`), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) });
	assert(seeded.status === 200, `${conversation} was seeded, got ${seeded.status}`);
	const query = `persistentAgentId=${roomId}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	let answer = true;
	ws.addEventListener("message", (event: any) => {
		let frame: any;
		try { frame = JSON.parse(String(event.data)); } catch { return; }
		frames.push(frame);
		// The command question's yes, a floor later, as a person reads first: a yes sooner is asked again.
		if (answer && frame.type === "ui_request" && frame.kind === "run") setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id: frame.id, value: true })), cards.ANSWER_FLOOR_MS + 50);
	});
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	await waitUntil(() => frames.some((frame) => frame.type === "ready"), `${conversation} is ready`);
	const ends = () => frames.filter((frame) => frame.type === "event" && frame.event?.type === "agent_end").length;
	const runQuestions = () => frames.filter((frame) => frame.type === "ui_request" && frame.kind === "run" && frame.again !== true);
	return {
		conversation,
		frames,
		/** Sends a message whose turn makes these calls; `answerCards` false leaves its cards open. */
		send(calls: Call[][], { answerCards = true, prompt = PROMPT }: { answerCards?: boolean; prompt?: string } = {}) {
			answer = answerCards;
			PROMPTS.add(prompt);
			const endsBefore = ends();
			const cardsBefore = runQuestions().length;
			const asked = requests.length;
			legs = calls;
			toolResults = [];
			ws.send(JSON.stringify({ type: "prompt", text: prompt }));
			return {
				answerCard: (id: string) => setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id, value: true })), cards.ANSWER_FLOOR_MS + 50),
				openCard: () => waitUntil(() => runQuestions().length > cardsBefore, "a card is open").then(() => runQuestions().at(-1)),
				async ended() {
					// A turn that never ends says what the window was sent instead: its error frames and whether it is still open.
					await waitUntil(() => ends() > endsBefore, "the turn ended").catch((error: Error) => {
						const errors = frames.filter((frame) => frame.type === "error").map((frame) => frame.code ?? frame.message);
						throw new Error(`${error.message}; the window's errors: ${JSON.stringify(errors)}, open: ${ws.readyState === 1}`, { cause: error });
					});
					await waitForTurnSettled(json, roomId, "the turn has settled");
					const seen = requests.slice(asked);
					// What this message told the model about the room: the system prompt and the room's own note for it.
					const told = seen[0] ? `${seen[0].system}\n${seen[0].fresh}` : "";
					// The app's own refresh of the model list can land first, and offers no tools.
					const tools = seen.find((request) => request.tools.length > 0)?.tools ?? [];
					return { results: toolResults, cards: runQuestions().length - cardsBefore, tools, told };
				},
			};
		},
		turn(calls: Call[][], options: { prompt?: string } = {}) {
			return this.send(calls, options).ended();
		},
		close: () => ws.close(),
	};
}
const bash = (command: string): Call => ({ name: "bash", args: { command } });
const read = (file: string): Call => ({ name: "read", args: { path: file } });
const BOX_LINE = "Commands run inside this room's protection";

let passed = 0;
let skipped = 0;
const failures: string[] = [];
let rowAt = 0;
async function row(name: string, body: () => Promise<void>): Promise<void> {
	assert(ROWS[rowAt++] === name, `rows run in the order ROWS lists them: ${name}`);
	try {
		await body();
		passed += 1;
		console.log(`  ok   ${name}`);
	} catch (error) {
		failures.push(name);
		console.log(`  FAIL ${name}: ${(error as Error).message}`);
	}
}

console.log(`room protection smoke${realBox ? "" : " (--no-box: a box never starts)"}`);
try {
	await row(ROWS[0], async () => {
		for (const [what, roomId] of [["no file", before.none], ["a malformed file", before.malformed], ["a file with no schema", before.unschemed], ["an unreadable file", before.unreadable], ["an older app's data", before.olderApp]] as const) {
			assert(same(await protectionShown(roomId), { state: "on" }), `${what} reads ${JSON.stringify(await protectionShown(roomId))}`);
			assert(same((await json(roomPath(roomId, "/bash-settings"))).body?.protection, { state: "on" }), `${what}: the chip's read`);
		}
		assert(same(await protectionShown(before.off), { state: "off" }), `a well-formed off read at start counts, got ${JSON.stringify(await protectionShown(before.off))}`);
		// A room deleted while off frees its name: the room made with that name since has no file, so it reads On.
		const gone = await newRoom("Name Taken Again");
		assert((await turnProtection(gone.id, "off")).status === 200, "Turn off before the delete");
		const purged = await json(roomPath(gone.id, "/purge"), { method: "POST", body: JSON.stringify({ confirmation: `DELETE ${gone.id} FOREVER` }) });
		assert(purged.status === 200, `the delete: ${purged.status} ${JSON.stringify(purged.body)}`);
		const again = await newRoom("Name Taken Again");
		assert(again.id === gone.id, `the name gave another room id, so this proves nothing: ${again.id}`);
		assert(same(await protectionShown(again.id), { state: "on" }), `a room made with a deleted room's name reads ${JSON.stringify(await protectionShown(again.id))}`);
		const room = await newRoom("Protected Room");
		const window = await openWindow(room.id);
		const asks = asksOf(room.id);
		const { results, cards: shown } = await window.turn([[bash("touch boxed.txt && echo ran")], [read("notes.txt")]]);
		assert(asksOf(room.id) >= asks + 2, `the command and the read each asked the box: ${asksOf(room.id) - asks}`);
		assert(shown === 0, "a new protected room's command asked first");
		if (realBox) assert(results[0]?.includes("ran") && fs.existsSync(path.join(room.folder, "boxed.txt")), `the boxed command ran: ${results[0]}`);
		else assert(results[0]?.includes(cards.BOX_FAULT_SENTENCE) && !fs.existsSync(path.join(room.folder, "boxed.txt")), `with no box, the command ran: ${results[0]}`);
		window.close();
	});

	await row(ROWS[1], async () => {
		const room = await newRoom("Switch Room");
		const window = await openWindow(room.id);
		const on = await window.turn([[bash("touch first.txt")]]);
		assert(on.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME) && on.told.includes(BOX_LINE) && on.cards === 0, `protected: outside tool ${on.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME)}, box line ${on.told.includes(BOX_LINE)}, cards ${on.cards}`);
		const off = await turnProtection(room.id, "off");
		assert(off.status === 200 && same(off.body?.protection, { state: "off" }), `Turn off: ${off.status} ${JSON.stringify(off.body)}`);
		const asks = asksOf(room.id);
		const unprotected = await window.turn([[bash("touch second.txt && echo ran")]]);
		assert(asksOf(room.id) === asks, `off, a command asked the box: ${asksOf(room.id) - asks}`);
		assert(!unprotected.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME) && unprotected.tools.includes("bash"), `off: the tools were ${unprotected.tools.join(",")}`);
		assert(!unprotected.told.includes(BOX_LINE), "off: the model was told commands run in the box");
		assert(on.told.includes(cards.BOX_FILE_HOMES_LINE) && !unprotected.told.includes(cards.BOX_FILE_HOMES_LINE), "the line on where each kind of file goes: protected only");
		assert(unprotected.cards === 1 && unprotected.results[0]?.includes("ran") && fs.existsSync(path.join(room.folder, "second.txt")), `off: the command ran after one card: cards ${unprotected.cards}, ${unprotected.results[0]}`);
		const fileAsks = asksOf(room.id);
		const files = await window.turn([[read("notes.txt")], [{ name: "write", args: { path: path.join(room.folder, "off.txt"), content: "written off" } }]]);
		assert(asksOf(room.id) >= fileAsks + 2, `off, the read and the write each asked the box: ${asksOf(room.id) - fileAsks}`);
		assert(files.results[0]?.includes("needle here") && fs.readFileSync(path.join(room.folder, "off.txt"), "utf8") === "written off", `off: the read ${files.results[0]}, the write ${files.results[1]}`);
		const back = await turnProtection(room.id, "on");
		assert(back.status === 200 && same(back.body?.protection, { state: "on" }), `Turn on: ${back.status} ${JSON.stringify(back.body)}`);
		const onAsks = asksOf(room.id);
		const again = await window.turn([[bash("touch third.txt")], [read("notes.txt")]]);
		assert(asksOf(room.id) >= onAsks + 2 && again.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME) && again.told.includes(BOX_LINE) && again.cards === 0, `on again: box asks ${asksOf(room.id) - onAsks}, outside tool ${again.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME)}, box line ${again.told.includes(BOX_LINE)}, cards ${again.cards}`);
		window.close();
	});

	await row(ROWS[2], async () => {
		const room = await newRoom("Answering Room");
		assert((await chip(room.id, false)).status === 200, "Ask before each command");
		const window = await openWindow(room.id);
		const turn = window.send([[bash("touch held.txt")]], { answerCards: false });
		const card = await turn.openCard();
		for (const state of ["off", "on"]) {
			const refused = await turnProtection(room.id, state);
			assert(refused.status === 409 && refused.body?.code === "active_turn_in_flight", `${state} while the room answers: ${refused.status} ${JSON.stringify(refused.body)}`);
		}
		assert(!fs.existsSync(runtimeOf(room.id, "protection.json")), "a refused change wrote the file");
		const asks = asksOf(room.id);
		turn.answerCard(card.id);
		await turn.ended();
		assert(asksOf(room.id) > asks, "the command in flight lost its box");
		assert(same(await protectionShown(room.id), { state: "on" }), "the room is no longer protected");
		const after = await turnProtection(room.id, "off");
		assert(after.status === 200, `once the room is idle, Turn off: ${after.status}`);
		window.close();
	});

	await row(ROWS[3], async () => {
		const { id } = await newRoom("Yes Room");
		assert(await runsWithoutAsking(id), "a new room runs without asking where it is protected");
		assert((await chip(id, false)).status === 200 && !(await runsWithoutAsking(id)), "protected: Ask before each command");
		assert((await turnProtection(id, "off")).status === 200, "Turn off");
		assert((await chip(id, true)).status === 200 && await runsWithoutAsking(id), "off: her yes");
		assert(storedSettings(id).unprotectedYes === "person", `off: the yes is kept as hers: ${JSON.stringify(storedSettings(id))}`);
		assert((await turnProtection(id, "on")).status === 200, "Turn on");
		assert(!(await runsWithoutAsking(id)), "on: the yes given without protection held");
		assert(!("unprotectedYes" in storedSettings(id)), `on: the yes given without protection was kept: ${JSON.stringify(storedSettings(id))}`);
		assert((await turnProtection(id, "off")).status === 200 && !(await runsWithoutAsking(id)), "off again: the dropped yes came back");
		assert((await turnProtection(id, "on")).status === 200 && (await chip(id, true)).status === 200 && await runsWithoutAsking(id), "on: a protected yes");
		assert((await turnProtection(id, "off")).status === 200 && !(await runsWithoutAsking(id)), "off: the protected yes held");
		assert((await turnProtection(id, "on")).status === 200 && await runsWithoutAsking(id), "on: the protected yes didn't come back");
	});

	await row(ROWS[4], async () => {
		const { id } = await newRoom("Chip Room");
		const file = runtimeOf(id, "bash-settings.json");
		const stored = fs.readFileSync(file, "utf8");
		const put = (body: unknown) => json(roomPath(id, "/bash-settings"), { method: "PUT", body: JSON.stringify(body) });
		for (const [what, body] of [["no state (a page open from before)", { autoApprove: false }], ["another state", { autoApprove: false, protection: { state: "off" } }], ["another cause", { autoApprove: false, protection: { state: "off", cause: "computer" } }], ["a state with a stray cause", { autoApprove: false, protection: { state: "on", cause: "folder" } }]] as const) {
			const refused = await put(body);
			assert(refused.status === 409 && refused.body?.error === cards.CHANGE_SAVE_FAILED && refused.body?.code === "protection_changed", `${what}: ${refused.status} ${JSON.stringify(refused.body)}`);
			assert(fs.readFileSync(file, "utf8") === stored, `${what}: the file changed`);
		}
		const allowed = await put({ autoApprove: false, protection: { state: "on" } });
		assert(allowed.status === 200 && allowed.body?.settings?.autoApprove === false && same(allowed.body?.protection, { state: "on" }), `the state it read: ${allowed.status} ${JSON.stringify(allowed.body)}`);
		// Turned off by her, the state alone no longer tells: a cause she didn't give is another protection.
		const off = await newRoom("Chip Off Room");
		assert((await turnProtection(off.id, "off")).status === 200, "Turn off");
		const offFile = runtimeOf(off.id, "bash-settings.json");
		const offStored = fs.readFileSync(offFile, "utf8");
		const putOff = (body: unknown) => json(roomPath(off.id, "/bash-settings"), { method: "PUT", body: JSON.stringify(body) });
		for (const [what, sent] of [["off for this computer", { state: "off", cause: "computer" }], ["off for the folder", { state: "off", cause: "folder" }], ["on", { state: "on" }]] as const) {
			const refused = await putOff({ autoApprove: true, protection: sent });
			assert(refused.status === 409 && refused.body?.code === "protection_changed", `turned off by her, a write naming ${what}: ${refused.status} ${JSON.stringify(refused.body)}`);
			assert(fs.readFileSync(offFile, "utf8") === offStored, `turned off by her, a write naming ${what}: the file changed`);
		}
		const hers = await putOff({ autoApprove: true, protection: { state: "off" } });
		assert(hers.status === 200 && hers.body?.settings?.autoApprove === true, `turned off by her, the state it read: ${hers.status} ${JSON.stringify(hers.body)}`);
	});

	await row(ROWS[5], async () => {
		const { chromium } = await import("playwright");
		const browserPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		assert(browserPath && fs.existsSync(browserPath), "Chromium is not installed (PLAYWRIGHT_BROWSERS_PATH)");
		const { id } = await newRoom("Page Chip Room");
		const browser = await chromium.launch();
		try {
			const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
			await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
			await page.waitForLoadState("networkidle");
			const dismiss = page.locator(".whats-new-close");
			if (await dismiss.count()) await dismiss.click();
			await page.locator(".persistent-agent-card").filter({ hasText: "Page Chip Room" }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
			/** A mode's item in the selector, found by its name as the page shows it. */
			const option = (mode: keyof typeof cards.MODE_NAMES) => page.locator(".bash-mode-option").filter({ has: page.locator(".bash-mode-option-name", { hasText: new RegExp(`^${cards.MODE_NAMES[mode]}$`) }) });
			const pick = async (mode: keyof typeof cards.MODE_NAMES): Promise<any> => {
				await page.locator(".bash-mode-chip").click();
				const sent = page.waitForRequest((request) => request.method() === "PUT" && request.url().endsWith(roomPath(id, "/bash-settings")), { timeout: 15_000 });
				await option(mode).click();
				return JSON.parse((await sent).postData() ?? "{}");
			};
			await page.locator(".bash-mode-chip").waitFor({ timeout: 15_000 });
			const asked = await pick("ask");
			assert(same(asked, { autoApprove: false, protection: { state: "on" } }), `protected, the chip sent ${JSON.stringify(asked)}`);
			await page.locator(".bash-mode-chip-label", { hasText: cards.MODE_NAMES.ask }).waitFor({ timeout: 10_000 });
			assert(!(await runsWithoutAsking(id)), "the chip's Ask wasn't stored");
			// Turned off while the menu is open: the chip's yes is refused, and the same click again is given in the state it read since.
			const read = () => page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(roomPath(id, "/bash-settings")), { timeout: 15_000 });
			const opened = read();
			await page.locator(".bash-mode-chip").click();
			await opened;
			assert((await turnProtection(id, "off")).status === 200, "Turn off");
			// Read on, the menu's yes is Semi; read off, it is Auto, which asks first: its write leaves only from the question's own button.
			const choose = async (mode: "semi" | "auto", { confirm = false } = {}): Promise<{ sent: any; status: number }> => {
				const answered = page.waitForResponse((response) => response.request().method() === "PUT" && response.url().endsWith(roomPath(id, "/bash-settings")), { timeout: 15_000 });
				await option(mode).click();
				if (confirm) await page.getByRole("alertdialog", { name: cards.RUN_WITHOUT_ASKING_TITLE }).getByRole("button", { name: cards.RUN_WITHOUT_ASKING }).click();
				const response = await answered;
				return { sent: JSON.parse(response.request().postData() ?? "{}"), status: response.status() };
			};
			const readAgain = read();
			// Awaited after the checks below; until then a failed read must not end the process.
			readAgain.catch(() => {});
			const refused = await choose("semi");
			assert(refused.status === 409 && same(refused.sent, { autoApprove: true, protection: { state: "on" } }), `the menu read on, so the chip sent ${JSON.stringify(refused.sent)}: ${refused.status}`);
			await page.locator(".bash-mode-menu-error", { hasText: cards.CHANGE_SAVE_FAILED }).waitFor({ timeout: 10_000 });
			// The read's answer is in and read: the chip holds it within the next frames.
			await (await readAgain).finished();
			await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
			const yes = await choose("auto", { confirm: true });
			assert(yes.status === 200 && same(yes.sent, { autoApprove: true, protection: { state: "off" } }), `off, the chip's second try sent ${JSON.stringify(yes.sent)}: ${yes.status}`);
			await page.locator(".bash-mode-chip-label", { hasText: cards.MODE_NAMES.auto }).waitFor({ timeout: 10_000 });
			assert(await runsWithoutAsking(id) && storedSettings(id).unprotectedYes === "person", `the chip's yes wasn't stored as hers: ${JSON.stringify(storedSettings(id))}`);
		} finally {
			await browser.close();
		}
	});

	await row(ROWS[6], async () => {
		const { chromium } = await import("playwright");
		const browserPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
		assert(browserPath && fs.existsSync(browserPath), "Chromium is not installed (PLAYWRIGHT_BROWSERS_PATH)");
		/** A room whose commands are off and may be asked for: made where protection can't run (acting as Linux), so they don't start on, then given its folder on this Mac. */
		const commandsOffRoom = async (name: string): Promise<string> => {
			process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
			let created: { status: number; body: any };
			try {
				created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
			} finally {
				delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
			}
			const id = String(created.body?.agent?.id ?? "");
			assert(created.status === 201 && id, `${name} was made, got ${created.status}`);
			const folder = path.join(folders, `folder-${++made}`);
			fs.mkdirSync(folder, { recursive: true });
			const saved = await json(roomPath(id, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: name, workspaceAccessMode: "localFiles", bashEnabled: false }) });
			assert(saved.status === 200, `${name}'s folder: ${saved.status} ${JSON.stringify(saved.body)}`);
			const commands = JSON.parse(fs.readFileSync(runtimeOf(id, "workspace-default.json"), "utf8")).commands;
			assert(commands === "off", `${name}'s commands are ${commands}, so the room won't ask for them`);
			return id;
		};
		const off = await commandsOffRoom("Card Off Room");
		assert((await turnProtection(off, "off")).status === 200, "Turn off");
		const on = await commandsOffRoom("Card On Room");
		const browser = await chromium.launch();
		try {
			for (const [name, id, yes, line] of [["Card Off Room", off, cards.TURN_ON_ANYWAY, cards.COMMANDS_ASK_LINES.unprotected], ["Card On Room", on, cards.TURN_ON_COMMANDS, cards.COMMANDS_ASK_LINES["in-box"]]] as const) {
				const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
				// Every way the page reads the chip again on its own, counted: the row holds only if none of them fired.
				await page.addInitScript(() => {
					(window as any).__rereads = 0;
					const count = () => { (window as any).__rereads += 1; };
					window.addEventListener("focus", count);
					document.addEventListener("visibilitychange", count);
				});
				await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
				await page.waitForLoadState("networkidle");
				const dismiss = page.locator(".whats-new-close");
				if (await dismiss.count()) await dismiss.click();
				const folderRead = page.waitForResponse((response) => response.request().method() === "GET" && response.url().endsWith(roomPath(id, "/workspace-default")), { timeout: 15_000 });
				await page.locator(".persistent-agent-card").filter({ hasText: name }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
				const read = await folderRead;
				assert((await read.json())?.policy?.bashEnabled === false, `${name}: commands are on before the card, so this row proves nothing`);
				assert(await page.locator(".bash-mode-chip").count() === 0, `${name}: the chip shows while commands are off`);
				const prompt = `Run the tests in ${name}.`;
				PROMPTS.add(prompt);
				legs = [[{ name: cards.ASK_FOR_COMMANDS_TOOL_NAME, args: { reason: "To run the tests." } }]];
				await page.locator("textarea").first().fill(prompt);
				await sendFromBox(page);
				// The question shows in the panel above the message box, and its main answer takes a press once its pause ends.
				const card = page.locator(".ask-panel").filter({ hasText: cards.COMMANDS_ASK_TITLE });
				await card.waitFor({ timeout: 15_000 });
				assert(await card.getByText(line).count() === 1 && await card.getByRole("button", { name: yes }).count() === 1, `${name}: the card reads ${await card.innerText()}`);
				await card.locator('.rs-btn-primary[data-awake="1"]').waitFor({ timeout: 5_000 });
				const rereads = await page.evaluate(() => (window as any).__rereads);
				await card.getByRole("button", { name: yes }).click();
				await page.locator(".box-room-after", { hasText: cards.COMMANDS_ON_LINE }).waitFor({ timeout: 15_000 });
				const shown = await page.locator(".bash-mode-chip").waitFor({ timeout: 5_000 }).then(() => true, () => false);
				assert(shown, `${name}: after ${yes} the card says commands are on, but the chip doesn't show`);
				assert(await page.evaluate(() => (window as any).__rereads) === rereads, `${name}: the page was refocused or shown again, so this row proves nothing`);
				await waitForTurnSettled(json, id, `${name}'s turn has settled`);
				await page.close();
			}
		} finally {
			await browser.close();
		}
	});

	await row(ROWS[7], async () => {
		const pre = (roomId: string, body: Record<string, unknown>) => {
			fs.mkdirSync(runtimeOf(roomId), { recursive: true });
			fs.writeFileSync(runtimeOf(roomId, "bash-settings.json"), JSON.stringify({ schemaVersion: 1, updatedAt: "2026-10-01T00:00:00.000Z", ...body }));
		};
		const earlier = { autoApprove: false, runWithoutAsking: "yes" };
		const readIn = (roomId: string, state: Parameters<typeof bashSettings.readPersistentRoomBashSettingsIn>[1]) => bashSettings.readPersistentRoomBashSettingsIn(roomId, state).autoApprove;
		const windowsWorks = protection.protectionOf({ computer: true, windows: true, folder: "C:\\Users\\Ana\\Room", turnedOff: false });
		const cannot = protection.protectionOf({ computer: false, windows: false, folder: null, turnedOff: false });
		const unknown = protection.protectionOf({ computer: "unknown", windows: true, folder: "C:\\Users\\Ana\\Room", turnedOff: false });
		assert(same(windowsWorks, { state: "on" }) && same(cannot, { state: "off", cause: "computer" }) && same(unknown, { state: "off", cause: "unknown" }), "the stand-in states");
		for (const [what, roomId, body, state] of [["a Mac's yes", "migrate-mac", earlier, protection.persistentRoomProtection("migrate-mac")], ["a Windows yes where the box works", "migrate-windows", earlier, windowsWorks]] as const) {
			pre(roomId, body);
			assert(same(state, { state: "on" }), `${what}: the room isn't protected here`);
			assert(readIn(roomId, state), `${what}: the yes was lost`);
			const kept = storedSettings(roomId);
			assert(kept.perProtection === true && kept.runWithoutAsking === "yes" && !("unprotectedYes" in kept) && kept.autoApprove === false, `${what}: stored ${JSON.stringify(kept)}`);
			assert(!readIn(roomId, cannot), `${what}: the yes held without protection`);
		}
		// An older app's own yes never asked about a site: where protection runs and the room's commands are on it is Auto.
		const { id: olderOn } = await newRoom("Older Yes Room");
		pre(olderOn, { autoApprove: true });
		assert(readIn(olderOn, { state: "on" }) && bashSettings.readPersistentRoomBashSettingsIn(olderOn, { state: "on" }).free === true, "an older app's yes on a Mac isn't Auto");
		const older = storedSettings(olderOn);
		assert(older.perProtection === true && older.runWithoutAsking === "free" && !("unprotectedYes" in older) && older.autoApprove === false, `an older app's yes on a Mac: stored ${JSON.stringify(older)}`);
		assert(!readIn(olderOn, cannot), "an older app's yes held without protection");
		// A room with no commands on never ran without asking: its older yes is Semi.
		pre("migrate-older-off", { autoApprove: true });
		assert(readIn("migrate-older-off", { state: "on" }) && bashSettings.readPersistentRoomBashSettingsIn("migrate-older-off", { state: "on" }).free === undefined, "an older app's yes with commands off is Auto");
		assert(storedSettings("migrate-older-off").runWithoutAsking === "yes", `an older app's yes with commands off: stored ${JSON.stringify(storedSettings("migrate-older-off"))}`);
		pre("migrate-cannot", earlier);
		assert(readIn("migrate-cannot", cannot), "where the box can't work: the yes was lost");
		const kept = storedSettings("migrate-cannot");
		assert(kept.perProtection === true && kept.runWithoutAsking === "no" && kept.unprotectedYes === "computer", `where the box can't work: stored ${JSON.stringify(kept)}`);
		assert(!readIn("migrate-cannot", { state: "on" }) && !("unprotectedYes" in storedSettings("migrate-cannot")), "where the box can't work: the yes held once protected");
		pre("migrate-unknown", earlier);
		const untouched = fs.readFileSync(runtimeOf("migrate-unknown", "bash-settings.json"), "utf8");
		assert(!readIn("migrate-unknown", unknown) && fs.readFileSync(runtimeOf("migrate-unknown", "bash-settings.json"), "utf8") === untouched, "a state not known yet converted the yes, or honoured it");
	});

	await row(ROWS[8], async () => {
		const windows = (folder: string) => protection.protectionOf({ computer: true, windows: true, folder, turnedOff: false });
		assert(same(windows("\\\\server\\share\\room"), { state: "off", cause: "folder" }), `a network folder: ${JSON.stringify(windows("\\\\server\\share\\room"))}`);
		assert(same(windows("Z:\\room"), { state: "on" }), `a drive letter: ${JSON.stringify(windows("Z:\\room"))}`);
		assert(protection.unprotectedByRoom({ state: "off", cause: "folder" }) && protection.unprotectedByRoom({ state: "off" }), "the card's line doesn't name the room for the folder's cause or her off");
		assert(!protection.unprotectedByRoom({ state: "off", cause: "computer" }) && !protection.unprotectedByRoom({ state: "off", cause: "unknown" }) && !protection.unprotectedByRoom({ state: "on" }), "the card's line names the room for the computer's cause, one not known, or On");
		const { id } = await newRoom("Linux Room");
		process.env.EXXPERTS_TEST_SHELL_PLATFORM = "linux";
		try {
			assert(same(await protectionShown(id), { state: "off", cause: "computer" }), `acting as Linux: ${JSON.stringify(await protectionShown(id))}`);
			for (const state of ["on", "off"]) {
				const refused = await turnProtection(id, state);
				assert(refused.status === 409 && refused.body?.code === "protection_unavailable" && refused.body?.error === cards.PROTECTION_UNAVAILABLE_COMPUTER, `${state} where the computer is the cause: ${refused.status} ${JSON.stringify(refused.body)}`);
			}
			assert(!fs.existsSync(runtimeOf(id, "protection.json")), "a refused change wrote the file");
		} finally {
			delete process.env.EXXPERTS_TEST_SHELL_PLATFORM;
		}
		assert((await turnProtection(id, "off")).status === 200, "on a Mac, Turn off is allowed");
		const malformed = await turnProtection(id, "maybe");
		assert(malformed.status === 400, `a state that is neither: ${malformed.status}`);
	});

	await row(ROWS[9], async () => {
		const room = await newRoom("Disk Room");
		fs.writeFileSync(runtimeOf(room.id, "protection.json"), JSON.stringify({ schemaVersion: 1, state: "off", updatedAt: "2026-11-01T00:00:00.000Z" }));
		assert(same(await protectionShown(room.id), { state: "on" }) && same((await json(roomPath(room.id, "/bash-settings"))).body?.protection, { state: "on" }), "a file written behind the app's back turned it off");
		const window = await openWindow(room.id);
		const asks = asksOf(room.id);
		const turn = await window.turn([[bash("touch disk.txt")]]);
		assert(asksOf(room.id) > asks && turn.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME), "the next message lost its box");
		const answer = await turnProtection(room.id, "on");
		assert(answer.status === 200 && same(answer.body?.protection, { state: "on" }), `the route: ${JSON.stringify(answer.body)}`);
		assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
		fs.writeFileSync(runtimeOf(room.id, "protection.json"), JSON.stringify({ schemaVersion: 1, state: "on", updatedAt: "2026-11-01T00:00:00.000Z" }));
		assert(same(await protectionShown(room.id), { state: "off" }), "a file written behind the app's back turned it on");
		window.close();
	});

	await row(ROWS[10], async () => {
		const src = path.join(scriptDir, "..", "src");
		const importers: string[] = [];
		const walk = (folder: string) => {
			for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
				const place = path.join(folder, entry.name);
				if (entry.isDirectory()) {
					// Installed and built copies are not code anyone writes here.
					if (!["node_modules", "dist", "build"].includes(entry.name)) walk(place);
				}
				else if (/\.(ts|tsx|mjs|cjs|js)$/.test(entry.name) && fs.readFileSync(place, "utf8").includes("writePersistentRoomProtection")) importers.push(path.relative(src, place)); // portability-ok: both names it may equal sit at the top of src, so they carry no separator on Windows either
			}
		};
		walk(src);
		walk(path.join(scriptDir, "..", "..", "web-ui", "src"));
		walk(path.join(repoRoot, "pi-package"));
		walk(path.join(repoRoot, "runtime"));
		assert(same(importers.sort(), ["persistent-room-protection.ts", "room-settings-routes.ts"]), `the writer is named in ${importers.join(", ")}`);

		const room = await newRoom("Reach Room");
		const file = runtimeOf(room.id, "protection.json");
		const window = await openWindow(room.id);
		const wrote = await window.turn([[{ name: "write", args: { path: file, content: JSON.stringify({ schemaVersion: 1, state: "off" }) } }]]);
		assert(!fs.existsSync(file) && same(await protectionShown(room.id), { state: "on" }), `a file tool wrote the room's protection: ${wrote.results[0]}`);
		assert(wrote.results[0]?.endsWith(closedRefusal("")), `the file tool's refusal reads otherwise: ${wrote.results[0]}`);
		const landed = await window.turn([[{ name: "write", args: { path: path.join(room.folder, "landed.txt"), content: "here" } }]]);
		assert(fs.readFileSync(path.join(room.folder, "landed.txt"), "utf8") === "here", `the allowed neighbour, a write in the room's folder: ${landed.results[0]}`);
		const address = `${baseUrl}/healthz`;
		assert((await fetch(address)).ok, "the app's address answers from outside the room");
		const fetched = await window.turn([[{ name: "fetch_url", args: { url: address } }]], { prompt: `Read ${address} for me.` });
		assert(fetched.results.length === 1 && fetched.results[0] === `Refusing to fetch private/reserved address "127.0.0.1".`, `fetch_url reached the app: ${fetched.results[0]}`);
		window.close();

		assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
		const phone = await pairDevice(port, "Protection phone", "full");
		const fromPhone = await remoteRequest(port, roomPath(room.id, "/protection"), { method: "PUT", headers: { Cookie: phone.cookie, Origin: `http://[::1]:${port}`, "content-type": "application/json" }, body: JSON.stringify({ state: "off" }) });
		assert(fromPhone.status === 403 && !fs.existsSync(file) && same(await protectionShown(room.id), { state: "on" }), `a phone's Turn off: ${fromPhone.status} ${fromPhone.body}`);
		const readFromPhone = await remoteRequest(port, roomPath(room.id, "/workspace-default"), { headers: { Cookie: phone.cookie, Origin: `http://[::1]:${port}` } });
		assert(readFromPhone.status === 200, `the phone's read, the allowed neighbour: ${readFromPhone.status}`);

		const words = ["protection.json", "/protection", cards.TURN_OFF_PROTECTION_TITLE, cards.TURN_OFF_PROTECTION_BODY, cards.TURN_OFF_PROTECTION_BODY_COMMANDS_OFF];
		const named = requests.flatMap((request) => words.filter((word) => request.told.includes(word)));
		assert(requests.length > 0 && named.length === 0, `the model was told: ${[...new Set(named)].join(", ")}`);
	});

	if (!realBox) {
		rowAt += 1;
		skipped += 1;
		console.log(`  skip ${ROWS[11]} (--no-box)`);
	} else {
		await row(ROWS[11], async () => {
			const room = await newRoom("Wall Room");
			const file = runtimeOf(room.id, "protection.json");
			const healthz = await (await fetch(`${baseUrl}/healthz`)).text();
			const window = await openWindow(room.id);
			const { results } = await window.turn([
				[bash(`printf '{"schemaVersion":1,"state":"off"}' > '${file}'; echo wrote=$?`)],
				[bash(`cat '${path.join(appRoot, "auth-token")}'; echo read=$?`)],
				[bash(`curl -sf -m 5 ${baseUrl}/healthz; echo reached=$?`)],
			]);
			assert(!fs.existsSync(file) && !results[0]?.includes("wrote=0"), `a boxed command wrote protection.json: ${results[0]}`);
			assert(!results[1]?.includes(SIGN_IN_MARK) && !results[1]?.includes("read=0"), `a boxed command read the sign-in file: ${results[1]}`);
			assert(!results[2]?.includes(healthz) && !results[2]?.includes("reached=0") && results[2]?.includes("The room's protection refused 127.0.0.1"), `a boxed command reached the app: ${results[2]}`);
			assert(same(await protectionShown(room.id), { state: "on" }), "the room's protection changed");
			window.close();
		});
	}

	await row(ROWS[12], async () => {
		const room = await newRoom("Failing Room");
		const failed = boxFails;
		boxFails = true;
		try {
			const window = await openWindow(room.id);
			const asks = asksOf(room.id);
			const { results } = await window.turn([[bash("touch c7.txt && echo ran")]]);
			assert(asksOf(room.id) === asks + 1 && results[0]?.includes(cards.BOX_FAULT_SENTENCE) && !results[0]?.includes("ran") && !fs.existsSync(path.join(room.folder, "c7.txt")), `a protected room whose box failed ran the command: ${results[0]}`);
			window.close();
		} finally {
			boxFails = failed;
		}
		// The room whose protection.json is a folder: read at start as On, its commands ask the box.
		const folder = path.join(folders, "unreadable-room");
		fs.mkdirSync(folder, { recursive: true });
		assert((await json(roomPath(before.unreadable, "/workspace-default"), { method: "PUT", body: JSON.stringify({ root: folder, displayLabel: "Unreadable", workspaceAccessMode: "localFiles", bashEnabled: true }) })).status === 200, "the unreadable room's folder");
		const window = await openWindow(before.unreadable);
		const asks = asksOf(before.unreadable);
		await window.turn([[bash("echo here")]]);
		assert(asksOf(before.unreadable) > asks, "an unreadable file took the box away");
		window.close();
	});

	await row(ROWS[13], async () => {
		const room = await newRoom("Bound Off Room");
		assert(await runsWithoutAsking(room.id), "a new protected room runs without asking");
		const window = await openWindow(room.id);
		assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
		// The message binds off; Turn on lands before its turn begins, which nothing refuses while no turn has begun.
		let release = () => {};
		bindHold = new Promise<void>((resolve) => { release = resolve; });
		bindHeld = false;
		const asks = asksOf(room.id);
		const turn = window.send([[bash("touch bound-off.txt && echo ran")]]);
		try {
			await waitUntil(() => bindHeld, "the message's bind waits");
			const on = await turnProtection(room.id, "on");
			assert(on.status === 200, `Turn on while the message binds: ${on.status} ${JSON.stringify(on.body)}`);
		} finally {
			bindHold = null;
			release();
		}
		const bound = await turn.ended();
		assert(bound.cards === 1 && bound.results[0]?.includes("ran") && asksOf(room.id) === asks, `bound off, the command ran without asking on the protected yes: cards ${bound.cards}, box asks ${asksOf(room.id) - asks}, ${bound.results[0]}`);
		assert(!bound.tools.includes(cards.RUN_OUTSIDE_BOX_TOOL_NAME), "bound off, the outside tool was offered");
		const next = await window.turn([[bash("touch bound-on.txt")]]);
		assert(next.cards === 0 && asksOf(room.id) > asks, `the next message, bound on: cards ${next.cards}, box asks ${asksOf(room.id) - asks}`);
		window.close();
	});

	await row(ROWS[14], async () => {
		/** Sends a message whose command is called after its window has closed, and gives what the command answered. */
		const away = async (roomId: string, file: string): Promise<string> => {
			const window = await openWindow(roomId);
			let release = () => {};
			gatewayHold = new Promise<void>((resolve) => { release = resolve; });
			gatewayHeld = false;
			try {
				window.send([[bash(`touch ${file} && echo ran`)]]);
				await waitUntil(() => gatewayHeld, "the model's call waits");
				window.close();
				await waitUntil(() => detachedCookingRooms.has(roomId), "the turn goes on with nobody there");
			} finally {
				gatewayHold = null;
				release();
			}
			await waitUntil(() => toolResults.length > 0, "the command answered");
			await waitForTurnSettled(json, roomId, "the away turn has settled");
			return toolResults[0];
		};
		const room = await newRoom("Away Off Room");
		assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
		assert((await chip(room.id, true)).status === 200 && await runsWithoutAsking(room.id), "off: Auto");
		const ran = await away(room.id, "away-off.txt");
		assert(ran.includes("ran") && fs.existsSync(path.join(room.folder, "away-off.txt")), `off, on Auto, with nobody there, the command didn't run: ${ran}`);
		assert((await chip(room.id, false)).status === 200 && !(await runsWithoutAsking(room.id)), "off: Ask");
		const refused = await away(room.id, "away-ask.txt");
		assert(refused.startsWith("The user left the room") && !fs.existsSync(path.join(room.folder, "away-ask.txt")), `off, on Ask, with nobody there, the command ran: ${refused}`);
		// The neighbour: a protected room's yes holds with nobody there, since its command runs in the box.
		const boxed = await newRoom("Away On Room");
		const asks = asksOf(boxed.id);
		const allowed = await away(boxed.id, "away-on.txt");
		assert(!allowed.includes(NOBODY_TO_APPROVE_COMMAND) && asksOf(boxed.id) > asks, `protected, with nobody there, the command wasn't let through to the box: ${allowed}`);
	});

	const putMode = (roomId: string, mode: "ask" | "semi" | "auto") => json(roomPath(roomId, "/bash-settings"), { method: "PUT", body: JSON.stringify({ autoApprove: mode !== "ask", ...(mode === "auto" ? { free: true } : {}), protection: { state: "on" } }) });
	const FREE_LINE = cards.FREE_READER_LINE.trim();
	/** The lines of a room on Auto, or the asking ones, in what the model was told. */
	const toldFree = (told: string) => told.includes(cards.boxSitesClause(true)) && told.includes(FREE_LINE) && !told.includes(cards.boxSitesClause(false));
	const toldAsking = (told: string) => told.includes(cards.boxSitesClause(false)) && !told.includes(FREE_LINE) && !told.includes(cards.boxSitesClause(true));
	const background = await import("../src/persistent-room-background-execution.js");
	let scheduledRuns = 0;
	/** A scheduled run in a new conversation of the room: its first request to the model, and what its calls answered. */
	async function scheduledRequest(roomId: string, calls: Call[][] = []): Promise<(typeof requests)[number] & { results: string[] }> {
		const asked = requests.length;
		// Without calls the model answers in words.
		legs = calls;
		toolResults = [];
		await background.executePersistentRoomBackgroundPrompt({ roomId, target: { kind: "fresh-thread", model: MODEL }, prompt: "The scheduled check.", executionId: `modes-scheduled-${++scheduledRuns}`, agentDir } as any);
		const first = requests[asked];
		assert(first, "the scheduled run asked the model nothing");
		return { ...first, results: toolResults };
	}
	/** What a scheduled run's first request told the model. */
	const scheduledTold = async (roomId: string): Promise<string> => (await scheduledRequest(roomId)).told;

	await row(ROWS[15], async () => {
		const room = await newRoom("Mode Lines Room");
		for (const mode of ["ask", "semi", "auto"] as const) {
			const put = await putMode(room.id, mode);
			assert(put.status === 200 && (put.body?.settings?.free === true) === (mode === "auto"), `${mode}: ${put.status} ${JSON.stringify(put.body)}`);
			// A window of its own for each live turn, closed before the scheduled run, which takes the room as a person's window would.
			const window = await openWindow(room.id);
			const live = await window.turn([[bash("echo mode")]]);
			window.close();
			assert(mode === "auto" ? toldFree(live.told) : toldAsking(live.told), `${mode}, live: the model was told ${live.told.slice(live.told.indexOf(BOX_LINE), live.told.indexOf(BOX_LINE) + 600)}`);
			assert(live.cards === (mode === "ask" ? 1 : 0), `${mode}: ${live.cards} cards`);
			const scheduled = await scheduledTold(room.id);
			assert(scheduled.includes(FREE_LINE) === (mode === "auto"), `${mode}, scheduled: the reader's line ${mode === "auto" ? "is missing" : "was sent"}`);
		}
		await putMode(room.id, "ask");
	});

	await row(ROWS[16], async () => {
		const room = await newRoom("Auto Off Room");
		assert((await putMode(room.id, "auto")).status === 200, "Auto");
		const window = await openWindow(room.id);
		assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
		const settingsOff = (await json(roomPath(room.id, "/bash-settings"))).body?.settings;
		assert(settingsOff?.autoApprove === false && settingsOff?.free === undefined, `off: ${JSON.stringify(settingsOff)}`);
		const off = await window.turn([[bash("echo off")]]);
		window.close();
		assert(off.cards === 1 && !off.told.includes(FREE_LINE) && !off.told.includes(cards.boxSitesClause(true)), `off: ${off.cards} cards, Auto lines ${off.told.includes(FREE_LINE)}`);
		assert(!(await scheduledTold(room.id)).includes(FREE_LINE), "off: a scheduled run was told the reader's Auto line");
		assert((await turnProtection(room.id, "on")).status === 200, "Turn on");
		assert((await json(roomPath(room.id, "/bash-settings"))).body?.settings?.free === true, "on again: the room isn't on Auto");
		const again = await openWindow(room.id);
		const on = await again.turn([[bash("echo on")]]);
		again.close();
		assert(on.cards === 0 && toldFree(on.told), `on again: ${on.cards} cards, Auto lines ${toldFree(on.told)}`);
		const phone = await pairDevice(port, "Modes phone", "full");
		const stored = fs.readFileSync(runtimeOf(room.id, "bash-settings.json"), "utf8");
		const fromPhone = await remoteRequest(port, roomPath(room.id, "/bash-settings"), { method: "PUT", headers: { Cookie: phone.cookie, Origin: `http://[::1]:${port}`, "content-type": "application/json" }, body: JSON.stringify({ autoApprove: false, protection: { state: "on" } }) });
		assert(fromPhone.status === 403 && fs.readFileSync(runtimeOf(room.id, "bash-settings.json"), "utf8") === stored, `a phone's write: ${fromPhone.status} ${fromPhone.body}`);
		const readFromPhone = await remoteRequest(port, roomPath(room.id, "/bash-settings"), { headers: { Cookie: phone.cookie, Origin: `http://[::1]:${port}` } });
		assert(readFromPhone.status === 200 && JSON.parse(readFromPhone.body)?.settings?.free === true, `the phone's read, the allowed neighbour: ${readFromPhone.status} ${readFromPhone.body}`);
	});

	await row(ROWS[17], async () => {
		const room = await newRoom("Off Auto Lines Room");
		assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
		// A page on this computer the scheduled prompt doesn't name, which would ask.
		const pages = http.createServer((_req, res) => { res.writeHead(200, { "content-type": "text/plain" }); res.end("the scheduled page"); });
		await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
		const page: Call = { name: "fetch_url", args: { url: `http://127.0.0.1:${(pages.address() as AddressInfo).port}/scheduled` } };
		process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE = "1";
		try {
			for (const mode of ["auto", "ask"] as const) {
				assert((await chip(room.id, mode === "auto")).status === 200, mode);
				const window = await openWindow(room.id);
				const live = await window.turn([[bash("echo mode")]]);
				window.close();
				assert(live.told.includes(FREE_LINE) === (mode === "auto") && !live.told.includes(cards.boxSitesClause(true)), `${mode}, live: the reader's line ${mode === "auto" ? "is missing" : "was sent"}, or a box line was`);
				assert(live.cards === (mode === "ask" ? 1 : 0), `${mode}: ${live.cards} cards`);
				const scheduled = await scheduledRequest(room.id, [[page]]);
				assert(scheduled.told.includes(FREE_LINE) === (mode === "auto"), `${mode}, scheduled: the reader's line ${mode === "auto" ? "is missing" : "was sent"}`);
				assert(!scheduled.tools.includes("bash") && scheduled.told.includes("A scheduled run can't run commands."), `${mode}, scheduled: commands were offered: ${JSON.stringify(scheduled.tools)}`);
				const opened = scheduled.results[0] ?? "";
				assert(mode === "auto" ? opened.includes("the scheduled page") : opened.includes(cards.NOBODY_TO_OPEN_PAGE) && !opened.includes("the scheduled page"), `${mode}, scheduled: the page answered ${JSON.stringify(scheduled.results)}`);
			}
		} finally {
			delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
			pages.close();
		}
	});

	await row(ROWS[18], async () => {
		// A page on this computer that waits until it is let go: the switch happens while the first one opens.
		let releasePage = () => {};
		const pageHold = new Promise<void>((resolve) => { releasePage = resolve; });
		let pagesAsked = 0;
		const pages = http.createServer(async (req, res) => {
			pagesAsked += 1;
			if (req.url === "/first") await pageHold;
			res.writeHead(200, { "content-type": "text/plain" });
			res.end(`page ${req.url}`);
		});
		await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
		const page = (name: string): Call => ({ name: "fetch_url", args: { url: `http://127.0.0.1:${(pages.address() as AddressInfo).port}/${name}` } });
		process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE = "1";
		try {
			const room = await newRoom("Auto To Ask Room");
			assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
			assert((await chip(room.id, true)).status === 200, "Auto");
			const window = await openWindow(room.id);
			const siteCards = () => window.frames.filter((frame) => frame.type === "ui_request" && frame.kind === "site");
			const turn = window.send([[page("first")], [page("second")], [bash("echo after")]], { answerCards: false });
			await waitUntil(() => pagesAsked === 1, "the first page opens");
			assert(siteCards().length === 0, "on Auto, the first page asked");
			assert((await chip(room.id, false)).status === 200, "Ask, while the room answers");
			releasePage();
			await waitUntil(() => siteCards().length === 1, "the next page asks");
			turn.answerCard(siteCards()[0].id);
			const card = await turn.openCard();
			turn.answerCard(card.id);
			const ended = await turn.ended();
			window.close();
			assert(pagesAsked === 1 && ended.cards === 1 && ended.results.at(-1)?.includes("after"), `after the switch: ${pagesAsked} pages opened, ${ended.cards} command cards, ${JSON.stringify(ended.results)}`);
		} finally {
			delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
			releasePage();
			pages.close();
		}
	});

	await row(ROWS[19], async () => {
		assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
		const viewer = (await pairDevice(port, "Viewing phone", "read-only")).cookie;
		/** The phone's window, or the computer's, on the conversation the computer's window left, once it watches the answer. */
		const watchingWindow = async (roomId: string, conversation: string, from: "phone" | "computer") => {
			const query = `persistentAgentId=${roomId}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
			const ws = from === "phone"
				? new WebSocketImpl(`ws://[::1]:${port}/ws?${query}`, { headers: { Origin: `http://[::1]:${port}`, Cookie: viewer } })
				: new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
			const frames: any[] = [];
			ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
			await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("the phone failed to connect"))); });
			await waitUntil(() => frames.some((frame) => frame.type === "turn_reattach_replay_done"), "the phone watches the answer");
			return ws;
		};
		/** A command (or `first`), then a model that never answers again: the computer's window leaves at the first call and the phone takes over, after the computer stepped back in where `back`, and the room goes on Auto once the phone watches where `toAuto`; `name` tells the room apart. */
		const takenOver = async (mode: "auto" | "ask", back = false, toAuto = false, name = "", first = bash("touch viewed.txt")) => {
			const room = await newRoom(`View ${mode}${back ? " Back" : ""}${toAuto ? " To Auto" : ""}${name} Room`);
			assert((await turnProtection(room.id, "off")).status === 200, "Turn off");
			assert((await chip(room.id, mode === "auto")).status === 200, mode);
			const window = await openWindow(room.id);
			let releaseFirst = () => {};
			let releaseHung = () => {};
			gatewayHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
			gatewayHeld = false;
			let phone: any = null;
			let computer: any = null;
			try {
				window.send([[first]]);
				await waitUntil(() => gatewayHeld, "the model's call waits");
				window.close();
				await waitUntil(() => detachedCookingRooms.has(room.id), "the answer goes on with nobody there");
				if (back) computer = await watchingWindow(room.id, window.conversation, "computer");
				phone = await watchingWindow(room.id, window.conversation, "phone");
				if (toAuto) assert((await chip(room.id, true)).status === 200, "Auto, while the phone watches the answer");
				// The model's next call, after the command, never comes back.
				gatewayHold = new Promise<void>((resolve) => { releaseHung = resolve; });
				gatewayHeld = false;
				releaseFirst();
				await waitUntil(() => gatewayHeld, "the model's call after the command waits");
				return { room, conversation: window.conversation, phone, computer, releaseHung };
			} catch (error) {
				releaseFirst();
				releaseHung();
				phone?.close();
				computer?.close();
				throw error;
			}
		};
		const status = async (roomId: string) => (await json(roomPath(roomId, "/status"))).body?.activeThread;
		for (const back of [false, true]) {
			const auto = await takenOver("auto", back);
			const how = back ? "after the computer stepped back in" : "from nobody";
			try {
				assert(fs.existsSync(path.join(auto.room.folder, "viewed.txt")), `on Auto, with only the phone watching ${how}, the command didn't run`);
				await waitForTurnSettled(json, auto.room.id, `the away limit ends the answer the phone took over ${how}`, AWAY_SILENCE_MS * 4);
				assert((await status(auto.room.id))?.activeTurn?.lastTerminalReason === "failed", `on Auto, ${how}, the answer ended: ${JSON.stringify((await status(auto.room.id))?.activeTurn)}`);
			} finally {
				auto.releaseHung();
				auto.phone.close();
				auto.computer?.close();
			}
		}
		// The phone comes and goes more often than the silence limit: the limits keep counting from the person's own leave.
		const visited = await takenOver("auto", false, false, " Visits");
		let visitingPhone: any = visited.phone;
		let visits = 0;
		try {
			// Well past the silence limit counted from the leave, and the visits never stop before the answer ends.
			const until = Date.now() + AWAY_SILENCE_MS * 3;
			while ((await status(visited.room.id))?.inFlight === true && Date.now() < until) {
				visitingPhone?.close();
				// The phone's leave reaches the server before its next visit.
				await waitUntil(async () => detachedCookingRooms.has(visited.room.id) || (await status(visited.room.id))?.inFlight !== true, "the phone left");
				visitingPhone = await watchingWindow(visited.room.id, visited.conversation, "phone").catch(() => null);
				visits += 1;
				await new Promise((resolve) => setTimeout(resolve, AWAY_SILENCE_MS / 4));
			}
			const endedWhileVisiting = (await status(visited.room.id))?.inFlight !== true;
			await waitForTurnSettled(json, visited.room.id, "the answer the phone keeps visiting ends");
			assert(endedWhileVisiting && visits >= 3 && (await status(visited.room.id))?.activeTurn?.lastTerminalReason === "failed", `on Auto, with the phone coming and going ${visits} times, the away limit ${endedWhileVisiting ? "ended" : "didn't end"} the answer: ${JSON.stringify((await status(visited.room.id))?.activeTurn)}`);
		} finally {
			visited.releaseHung();
			visitingPhone?.close();
		}
		const toAuto = await takenOver("ask", false, true);
		try {
			assert(fs.existsSync(path.join(toAuto.room.folder, "viewed.txt")), "on Auto since the phone took over on Ask, the command didn't run");
			await waitForTurnSettled(json, toAuto.room.id, "the away limit ends the answer that went on Auto under the phone", AWAY_SILENCE_MS * 4);
			assert((await status(toAuto.room.id))?.activeTurn?.lastTerminalReason === "failed", `on Auto since the phone took over on Ask, the answer ended: ${JSON.stringify((await status(toAuto.room.id))?.activeTurn)}`);
		} finally {
			toAuto.releaseHung();
			toAuto.phone.close();
		}
		// The same order with a page on this computer the prompt doesn't name in place of the command: it opens without asking, and the limits end the answer.
		let pagesAsked = 0;
		const pagesOpened = () => pagesAsked;
		const pages = http.createServer((_req, res) => { pagesAsked += 1; res.writeHead(200, { "content-type": "text/plain" }); res.end("the phone's page"); });
		await new Promise<void>((resolve) => pages.listen(0, "127.0.0.1", resolve));
		process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE = "1";
		try {
			const page: Call = { name: "fetch_url", args: { url: `http://127.0.0.1:${(pages.address() as AddressInfo).port}/page` } };
			const pagesOnly = await takenOver("ask", false, true, " Pages", page);
			try {
				assert(pagesOpened() === 1, `on Auto since the phone took over on Ask, the page opened ${pagesOpened()} times`);
				await waitForTurnSettled(json, pagesOnly.room.id, "the away limit ends the answer that went on Auto under the phone and opens only pages", AWAY_SILENCE_MS * 4);
				assert((await status(pagesOnly.room.id))?.activeTurn?.lastTerminalReason === "failed", `on Auto since the phone took over on Ask, the answer that opens only pages ended: ${JSON.stringify((await status(pagesOnly.room.id))?.activeTurn)}`);
			} finally {
				pagesOnly.releaseHung();
				pagesOnly.phone.close();
			}
			// The allowed neighbour: with the person in the room, a page and a command on Auto start no limit, so past the silence limit the answer still runs.
			const watched = await newRoom("View Watched Auto Room");
			assert((await turnProtection(watched.id, "off")).status === 200, "Turn off");
			assert((await chip(watched.id, true)).status === 200, "Auto");
			const window = await openWindow(watched.id);
			let releaseFirst = () => {};
			let releaseHung = () => {};
			try {
				gatewayHold = new Promise<void>((resolve) => { releaseFirst = resolve; });
				gatewayHeld = false;
				const turn = window.send([[page, bash("touch watched.txt")]]);
				await waitUntil(() => gatewayHeld, "the model's call waits");
				gatewayHold = new Promise<void>((resolve) => { releaseHung = resolve; });
				gatewayHeld = false;
				releaseFirst();
				await waitUntil(() => gatewayHeld, "the model's call after the page and the command waits");
				assert(pagesOpened() === 2 && fs.existsSync(path.join(watched.folder, "watched.txt")), `with the person in the room, the page opened ${pagesOpened() - 1} times and the command ran: ${fs.existsSync(path.join(watched.folder, "watched.txt"))}`);
				await new Promise((resolve) => setTimeout(resolve, AWAY_SILENCE_MS * 2));
				assert((await status(watched.id))?.inFlight === true, `with the person in the room, an away limit ended the answer: ${JSON.stringify((await status(watched.id))?.activeTurn)}`);
				releaseHung();
				await turn.ended();
			} finally {
				releaseFirst();
				releaseHung();
				window.close();
			}
		} finally {
			delete process.env.EXXETA_FETCH_URL_ALLOW_PRIVATE;
			pages.close();
		}
		const ask = await takenOver("ask");
		try {
			assert(!fs.existsSync(path.join(ask.room.folder, "viewed.txt")), "on Ask, with only the phone watching, the command ran");
			// Past the silence limit and then some: the answer still runs.
			await new Promise((resolve) => setTimeout(resolve, AWAY_SILENCE_MS * 2));
			assert((await status(ask.room.id))?.inFlight === true, `on Ask, the away limit ended the answer the phone took over: ${JSON.stringify(await status(ask.room.id))}`);
		} finally {
			ask.releaseHung();
			ask.phone.close();
		}
		await waitForTurnSettled(json, ask.room.id, "the answer ends once the model answers");
	});

	// Last: once a process is a shared server it stays one.
	await row(ROWS[20], async () => {
		const shown = async () => ({
			chip: (await json(roomPath(before.off, "/bash-settings"))).body,
			pane: (await json(roomPath(before.off, "/workspace-default"))).body,
		});
		const desktop = await shown();
		assert(same(desktop.chip?.protection, { state: "off" }) && same(desktop.pane?.protection, { state: "off" }), `on this computer, the room stored off: ${JSON.stringify({ chip: desktop.chip?.protection, pane: desktop.pane?.protection })}`);
		const { registerServerHooks } = await import("../src/server-hooks.js");
		registerServerHooks({});
		const shared = await shown();
		assert(shared.chip?.settings !== undefined && !("protection" in shared.chip) && shared.pane?.policy !== undefined && !("protection" in shared.pane), `a shared server's reads: ${JSON.stringify({ chip: shared.chip, pane: shared.pane?.protection })}`);
		const turned = await json(roomPath(before.off, "/protection"), { method: "PUT", body: JSON.stringify({ state: "on" }) });
		assert(turned.status === 403 && turned.body?.code === "protection_unavailable", `a shared server's Turn on: ${turned.status} ${JSON.stringify(turned.body)}`);
		assert(JSON.parse(fs.readFileSync(runtimeOf(before.off, "protection.json"), "utf8")).state === "off", "the refused Turn on wrote the file");
	});
} finally {
	gateway.close();
}

console.log(`room protection smoke: ${passed} passed, ${failures.length} failed${skipped ? `, ${skipped} skipped` : ""}`);
if (failures.length) {
	console.log(`failed: ${failures.join("; ")}`);
	console.log(`temp root kept for inspection: ${tempRoot}`);
	process.exit(1);
}
fs.rmSync(tempRoot, { recursive: true, force: true });
process.exit(0);
