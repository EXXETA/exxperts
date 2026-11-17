// A connector tool the connector doesn't mark read-only asks first, in a real
// room: a real server, a gateway that plays the model, real windows and a real
// connector that counts what reaches it. Allow reaches it once; Deny, Stop,
// leaving and a scheduled run reach it zero times. A room on Auto still gets
// the card, a full phone's answer counts, and a view-only phone taking over
// refuses with the note until the computer is back. Allow for this room, in a
// room of its own, runs that tool with no question from then on: live, after
// the person left and in a scheduled run, until Remove in Room settings takes
// it back. Each refusal sits beside a row that runs. The gate's own rows are in
// persistent-room-mcp-scope-smoke.ts.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { markedConnector } from "./smoke-marked-connector.js";
import { pairDevice } from "./smoke-pairing.js";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer, type AuthedFetchInit, putRunWithoutAsking } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { declinedQuestionNoteText } from "../src/thread-items-by-id.js";
import { ANSWER_FLOOR_MS } from "../src/room-box/card-text.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: it fails there in some runs, and the cause isn't known yet");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connector-ask-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const MODEL = { provider: "openai-compatible", model: "room-model" };
const ASK_TITLE = "Use Delete project in Asana?";
// The note names Allow for this room, which this question offers; the step's row says its first sentence.
const AWAY_NOTE = declinedQuestionNoteText(ASK_TITLE, true);
const AWAY_ROW = declinedQuestionNoteText(ASK_TITLE);
const waitUntil = waitEvery(25, 30_000);

// --- The gateway plays the model: each leg makes its scripted calls, then it answers in words.
type Call = Record<string, unknown>;
interface Leg { calls: Call[]; before?: () => Promise<void> }
let script: Leg[] = [];
let toolResults: string[] = [];
let hookFailure: unknown;
const deleteProject: Call = { tool: "asana_delete_project", args: JSON.stringify({ project: "Q3" }) };
const listProjects: Call = { tool: "asana_list_projects", args: "{}" };
const createNote: Call = { tool: "asana_create_note", args: JSON.stringify({ text: "hello" }) };
const dropBoard: Call = { tool: "asana_drop_board", args: "{}" };
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", async () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const userAt = messages.map((message) => message?.role).lastIndexOf("user");
		const results = messages.slice(userAt + 1).filter((message) => message?.role === "tool");
		toolResults = results.map((message) => (typeof message.content === "string" ? message.content : message.content.map((part: any) => String(part?.text ?? "")).join("")));
		const legsDone = messages.slice(userAt + 1).filter((message) => message?.role === "assistant").length;
		const leg = (parsed.tools ?? []).length > 0 ? script[legsDone] : undefined;
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${legsDone}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? MODEL.model) };
		if (leg) {
			try {
				await leg.before?.();
			} catch (error) {
				hookFailure ??= error;
				return void res.end();
			}
			const tool_calls = leg.calls.map((call, index) => ({ index, id: `call_${legsDone}_${index}`, type: "function", function: { name: "mcp", arguments: JSON.stringify(call) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "That is as far as I got." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

const connector = markedConnector();
connector.tools = [{ name: "list_projects", annotations: { readOnlyHint: true } }, { name: "delete_project" }, { name: "create_note" }, { name: "drop_board", annotations: { destructiveHint: true } }];
const callsOf = (name: string) => connector.called.filter((called) => called === name).length;
const AWAY_SILENCE_MS = 5_000;
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
const serverOutput: string[] = [];
let port = 0;
let room = "";
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const threadPath = (conversation: string) => `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`;
const threadItems = async (conversation: string): Promise<any[]> => (await json(threadPath(conversation))).body?.thread?.items ?? [];
const notesOf = (items: any[]) => items.filter((item) => item.kind === "system").map((item) => String(item.text));
const deleteStepOf = (items: any[]) => items.find((item) => item.kind === "tool" && item.name === "mcp" && item.args?.tool === deleteProject.tool);
// The saved step as the room's card reads it: not run, and the line its row says.
const look: any = await import(new URL("../../web-ui/src/work-look.ts", import.meta.url).href);
const stepLines: any = await import(new URL("../../web-ui/src/step-lines.ts", import.meta.url).href);
function readsNotRun(step: any, line: string, label: string): void {
	assert(step, `${label}: the step was saved, got none`);
	const folded = look.foldedWords([{ item: step }]);
	assert(look.stepState(step, undefined) === "denied" && folded === "1 step not run", `${label}: the saved step reads not run, got ${look.stepState(step, undefined)} / ${folded} for ${JSON.stringify(step)}`);
	assert(stepLines.connectorNotRunLine(step) === line, `${label}: its row says "${line}", got ${stepLines.connectorNotRunLine(step)}`);
	assert(step.details?.use === "Delete project in Asana" && !String(step.result).includes("Delete project"), `${label}: the saved step keeps what its card asked to use, and the model's text doesn't carry it, got ${JSON.stringify(step)}`);
}

async function openWindow(conversation: string, deviceCookie?: string) {
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = deviceCookie
		? new WebSocketImpl(`ws://[::1]:${port}/ws?${query}`, { headers: { Origin: `http://[::1]:${port}`, Cookie: deviceCookie } })
		: new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const seen = async (match: (frame: any) => boolean, label: string): Promise<any> => {
		await waitUntil(() => {
			if (hookFailure) throw hookFailure;
			return frames.some(match);
		}, `${label}; frames ${frames.map((frame) => frame.type).join(",")}`);
		return frames.find(match);
	};
	const cards = () => frames.filter((frame) => frame.type === "ui_request" && frame.kind === "connector" && frame.again !== true);
	return {
		ws,
		frames,
		seen,
		cards,
		card: async (count = 1) => { await waitUntil(() => cards().length >= count, `card ${count} came; frames ${frames.map((frame) => frame.type).join(",")}`); return cards()[count - 1]; },
		// true is Allow this time and false Not now, as the panel sends them; a yes waits out the server's floor, as a person's press does.
		answer: (id: string, value: boolean | "room") => {
			const sent = value === true ? "once" : value === false ? "decline" : value;
			setTimeout(() => ws.send(JSON.stringify({ type: "ui_response", id, value: sent })), sent === "decline" ? 0 : ANSWER_FLOOR_MS + 50);
		},
		prompt: (text: string) => ws.send(JSON.stringify({ type: "prompt", text })),
		ended: () => seen((frame) => frame.type === "event" && frame.event?.type === "agent_end", "the turn ended"),
	};
}
type RoomWindow = Awaited<ReturnType<typeof openWindow>>;

// A new room has no active thread to settle, so the wait starts after its first conversation.
let turnBefore = false;
async function freshConversation(conversation: string): Promise<void> {
	if (turnBefore) await waitForTurnSettled(json, room, `the turn before ${conversation} has settled`);
	turnBefore = true;
	assert((await json(threadPath(conversation), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) })).status === 200, `${conversation} was seeded`);
	connector.called.length = 0;
}
const openConversation = async (conversation: string, deviceCookie?: string): Promise<RoomWindow> => {
	await freshConversation(conversation);
	const window = await openWindow(conversation, deviceCookie);
	await window.seen((frame) => frame.type === "ready", `${conversation}: the window is ready`);
	return window;
};
async function waitDetached(): Promise<void> {
	await waitUntil(async () => {
		const rooms = await json("/api/persistent-agents");
		return (rooms.body?.agents ?? rooms.body ?? []).some((row: any) => row.id === room && row.answeringDetached === true);
	}, "the turn went on with nobody in the room");
}

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => connector.server.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-connector-ask" } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	writeSetting(path.join(agentDir, "mcp.json"), { mcpServers: { asana: { url: connector.webUrl() } } });

	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		// The proxy settings come after the home's, which copies the runner's NODE_OPTIONS that they add to.
		env: { ...process.env, ...smokeHomeEnv(home), ...connector.proxyEnv(), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_REMOTE_TEST_ADDRESS: "::1",
			// Short, so row 15 can watch the away limit end an answer; every other answer with nobody there makes progress well within it.
			EXXETA_DETACHED_TURN_SILENCE_MS: String(AWAY_SILENCE_MS) } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.on("data", (chunk) => serverOutput.push(String(chunk)));
	serverProcess.stderr.on("data", (chunk) => serverOutput.push(String(chunk)));
	await waitForServer(serverProcess, `http://127.0.0.1:${port}`, 20_000);
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Connector Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	const grant = await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "asana" }) });
	assert(grant.status === 200, `the connector was enabled, got ${grant.status}`);

	// --- 1. The marked tool runs with no card, the unmarked one stops on one, and Allow reaches the connector once.
	{
		const window = await openConversation("conv-allow");
		script = [{ calls: [listProjects] }, { calls: [deleteProject] }];
		window.prompt("Tidy up Asana.");
		const card = await window.card();
		assert(card.title === ASK_TITLE, `the card's title, got ${card.title}`);
		assert(card.connector === "Asana" && card.sent === `{"project":"Q3"}` && card.cut === 0 && card.lasting === true, `the card's fields, with Allow for this room at the computer, got ${JSON.stringify(card)}`);
		assert(callsOf("list_projects") === 1 && window.cards().length === 1, `the marked tool ran with no card of its own, got ${JSON.stringify(connector.called)}, ${window.cards().length} cards`);
		assert(callsOf("delete_project") === 0, "the unmarked tool waits on its card");
		window.answer(card.id, true);
		await window.ended();
		assert(callsOf("delete_project") === 1, `Allow reached the connector once, got ${JSON.stringify(connector.called)}`);
		window.ws.close();
		console.log("ok 1 the marked tool runs, the unmarked one asks, and Allow reaches the connector once");
	}

	// --- 2. Deny reaches nothing, and the words say so.
	{
		const window = await openConversation("conv-deny");
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		window.answer((await window.card()).id, false);
		await window.ended();
		assert(callsOf("delete_project") === 0, "Deny reached nothing");
		assert(toolResults.at(-1)?.startsWith("You declined this, so nothing changed in Asana.") && !toolResults.at(-1)?.includes("Delete project"), `the room is told, and nothing kept for the page reaches it, got ${toolResults.at(-1)}`);
		window.ws.close();
		await waitForTurnSettled(json, room, "the declined turn landed");
		readsNotRun(deleteStepOf(await threadItems("conv-deny")), "You declined this, so nothing changed in Asana.", "Deny");
		console.log("ok 2 Deny reaches nothing");
	}

	// --- 3. Stop reaches nothing.
	{
		const window = await openConversation("conv-stop");
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		await window.card();
		window.ws.send(JSON.stringify({ type: "abort", shown: 0 }));
		await window.ended();
		assert(callsOf("delete_project") === 0, "Stop reached nothing");
		window.ws.close();
		console.log("ok 3 Stop reaches nothing");
	}

	// --- 4. Leaving reaches nothing and leaves the note.
	{
		const window = await openConversation("conv-left");
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		await window.card();
		window.ws.close();
		await waitDetached();
		await waitForTurnSettled(json, room, "the left turn landed");
		assert(callsOf("delete_project") === 0, "leaving reached nothing");
		assert(toolResults.at(-1)?.startsWith("The user left the room") && toolResults.at(-1)?.endsWith("Nothing was sent to Asana. Leave this undone and say so."), `the room is told to leave it undone, got ${toolResults.at(-1)}`);
		const leftItems = await threadItems("conv-left");
		const notes = notesOf(leftItems);
		assert(notes.includes(AWAY_NOTE), `leaving leaves the note, got ${JSON.stringify(notes)}`);
		readsNotRun(deleteStepOf(leftItems), AWAY_ROW, "leaving");
		console.log("ok 4 leaving reaches nothing and leaves the note");
	}

	// --- 4b. The same when the page saved the card before the person left, as the real page does: the card stays and so does the note.
	{
		const conversation = "conv-left-kept";
		const window = await openConversation(conversation);
		script = [{ calls: [deleteProject] }];
		const ask = "Delete the Q3 project while I close the window.";
		window.ws.send(JSON.stringify({ type: "prompt", text: ask, id: "kept1", shown: { text: ask, files: [] } }));
		const card = await window.card();
		const saved = await json(threadPath(conversation), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [{ kind: "user", id: "kept1", text: ask }, { kind: "approval", id: "card-kept", requestId: card.id, uiKind: "connector", title: card.title, connector: card.connector, sent: card.sent, cut: card.cut, lasting: card.lasting }] }) });
		assert(saved.status === 200, `the page's save with the card is taken, got ${saved.status}`);
		window.ws.close();
		await waitDetached();
		await waitForTurnSettled(json, room, "the kept-card turn landed");
		const items = await threadItems(conversation);
		assert(items.some((item) => item.id === "card-kept") && notesOf(items).includes(AWAY_NOTE), `the kept card and the note both stay, got ${JSON.stringify(items.map((item) => `${item.kind}:${item.id}:${item.text ?? ""}`))}`);
		assert(callsOf("delete_project") === 0, "leaving reached nothing");
		console.log("ok 4b a card the page kept still leaves the note");
	}

	// --- 5. A room on Auto gets the card: Auto is about commands.
	{
		const auto = await putRunWithoutAsking(`http://127.0.0.1:${port}/api/persistent-agents/${encodeURIComponent(room)}/bash-settings`, true);
		const autoBody = await auto.json();
		assert(auto.status === 200 && autoBody?.settings?.autoApprove === true, `the room is on Auto, got ${JSON.stringify(autoBody)}`);
		const window = await openConversation("conv-auto");
		script = [{ calls: [listProjects] }, { calls: [deleteProject] }];
		window.prompt("Tidy up Asana.");
		const card = await window.card();
		assert(card.title === ASK_TITLE && callsOf("delete_project") === 0, "a room on Auto gets the card");
		window.answer(card.id, false);
		await window.ended();
		assert(callsOf("delete_project") === 0 && callsOf("list_projects") === 1, `on Auto a read still runs and a No still stops, got ${JSON.stringify(connector.called)}`);
		window.ws.close();
		await putRunWithoutAsking(`http://127.0.0.1:${port}/api/persistent-agents/${encodeURIComponent(room)}/bash-settings`, false);
		console.log("ok 5 a room on Auto gets the card");
	}

	// --- 6. Two calls at once, answered differently: each answer reaches its own tool.
	{
		const window = await openConversation("conv-two");
		script = [{ calls: [deleteProject, createNote] }];
		window.prompt("Delete Q3 and leave a note.");
		const second = await window.card(2);
		const first = window.cards()[0];
		assert(JSON.stringify([first.title, second.title].sort()) === JSON.stringify(["Use Create note in Asana?", ASK_TITLE]), `each call asks by its own name, got ${first.title}, ${second.title}`);
		const noteCard = [first, second].find((card) => card.title !== ASK_TITLE);
		const deleteCard = [first, second].find((card) => card.title === ASK_TITLE);
		window.answer(noteCard.id, true);
		window.answer(deleteCard.id, false);
		await window.ended();
		assert(JSON.stringify(connector.called) === JSON.stringify(["create_note"]), `only the allowed tool reached the connector, got ${JSON.stringify(connector.called)}`);
		window.ws.close();
		console.log("ok 6 two calls at once: each answer reaches its own tool");
	}

	// --- 7. A full phone's answer counts.
	assert((await json("/api/remote/enable", { method: "POST" })).status === 200, "remote access is on");
	const fullPhone = await pairDevice(port, "Full phone", "full");
	{
		const exposed = await json("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: room, exposed: true }) });
		assert(exposed.status === 200, `the room is on the phones, got ${exposed.status}`);
		const window = await openConversation("conv-phone", fullPhone.cookie);
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		const card = await window.card();
		assert(card.lasting === false, "a phone sees two answers");
		window.answer(card.id, true);
		await window.ended();
		assert(callsOf("delete_project") === 1, `a full phone's Allow reached the connector once, got ${JSON.stringify(connector.called)}`);
		window.ws.close();
		console.log("ok 7 a full phone's answer counts");
	}

	// --- 8. The computer, then a view-only phone, then the computer: refused with
	// the note and no card on the phone; back at the computer a new request asks.
	const viewPhone = await pairDevice(port, "View phone", "read-only");
	{
		const conversation = "conv-view";
		const computer = await openConversation(conversation);
		let phone: RoomWindow | undefined;
		let back: RoomWindow | undefined;
		script = [
			{
				calls: [deleteProject],
				before: async () => {
					computer.ws.close();
					await waitDetached();
					phone = await openWindow(conversation, viewPhone.cookie);
					await phone.seen((frame) => frame.type === "turn_reattach_replay_done", "the view-only phone watches the turn");
				},
			},
			{
				calls: [deleteProject],
				before: async () => {
					assert(toolResults.at(-1)?.startsWith("The user left the room"), `the phone's takeover refused the first ask, got ${toolResults.at(-1)}`);
					assert(callsOf("delete_project") === 0, "the refused ask reached nothing");
					assert(phone!.cards().length === 0, "the view-only phone got no card it cannot answer");
					phone!.ws.close();
					await waitDetached();
					back = await openWindow(conversation);
					await back.seen((frame) => frame.type === "turn_reattach_replay_done", "the computer is back in the turn");
				},
			},
		];
		computer.prompt("Delete the Q3 project.");
		await waitUntil(() => {
			if (hookFailure) throw hookFailure;
			return back !== undefined;
		}, "the computer came back");
		const card = await back!.card();
		assert(card.title === ASK_TITLE, "a new request can be made at the computer");
		back!.answer(card.id, true);
		await back!.ended();
		assert(callsOf("delete_project") === 1, `the computer's Allow reached the connector once, got ${JSON.stringify(connector.called)}`);
		await waitForTurnSettled(json, room, "the view-only turn landed");
		const notes = notesOf(await threadItems(conversation));
		assert(notes.includes(AWAY_NOTE), `the refusal left the note, got ${JSON.stringify(notes)}`);
		back!.ws.close();
		console.log("ok 8 the computer, a view-only phone, the computer: refused with the note, then a new request asks");
	}

	// --- 10 to 13. Allow for this room, in a room of its own.
	await waitForTurnSettled(json, room, "the view-only turn has settled");
	const firstRoom = room;
	const madeAllowed = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Allowed Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	room = String(madeAllowed.body?.agent?.id ?? madeAllowed.body?.agent?.agentId ?? "");
	turnBefore = false;
	const connectorsPath = `/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`;
	assert(madeAllowed.status === 201 && room && (await json(connectorsPath, { method: "PUT", body: JSON.stringify({ action: "grant", name: "asana" }) })).status === 200, "the second room has the connector");
	assert((await json("/api/remote/rooms/exposure", { method: "POST", body: JSON.stringify({ id: room, exposed: true }) })).status === 200, "the second room is on the phones");
	const allowedTools = async () => JSON.stringify((await json(connectorsPath)).body?.allowedTools ?? null);
	const ALLOWED_DELETE = JSON.stringify({ asana: [{ tool: "delete_project", shown: "Delete project" }] });
	const takenFor = (window: RoomWindow, id: string) => window.seen((frame) => frame.type === "ui_request_closed" && frame.id === id && frame.reason === "answered", "the question said what it took");
	{
		const window = await openConversation("conv-allow-phone", fullPhone.cookie);
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		const card = await window.card();
		assert(card.lasting === false, "a phone is never offered Allow for this room");
		window.answer(card.id, "room");
		assert((await takenFor(window, card.id)).taken === "once", "a phone's Allow for this room counts this time");
		await window.ended();
		assert(callsOf("delete_project") === 1 && (await allowedTools()) === "{}", `it ran once and stored nothing, got ${JSON.stringify(connector.called)}, ${await allowedTools()}`);
		window.ws.close();
		console.log("ok 10 a full phone sees two answers, and Allow for this room sent from it counts this time");
	}
	{
		const window = await openConversation("conv-allow-room");
		script = [{ calls: [deleteProject] }];
		window.prompt("Delete the Q3 project.");
		const card = await window.card();
		assert(card.lasting === true, "the computer is offered Allow for this room");
		window.answer(card.id, "room");
		assert((await takenFor(window, card.id)).taken === "room", "the question says the yes is kept for the room");
		await window.ended();
		assert(callsOf("delete_project") === 1 && (await allowedTools()) === ALLOWED_DELETE, `it ran, and Room settings lists it, got ${JSON.stringify(connector.called)}, ${await allowedTools()}`);
		window.ws.close();
		console.log("ok 11 the computer's Allow for this room runs the call and is listed in Room settings");
	}
	{
		const window = await openConversation("conv-allowed");
		script = [{ calls: [deleteProject] }, { calls: [createNote] }];
		window.prompt("Delete Q3, then leave a note.");
		const card = await window.card();
		assert(card.title === "Use Create note in Asana?" && callsOf("delete_project") === 1, `the allowed tool ran with no question and another tool asks, got ${card.title}, ${JSON.stringify(connector.called)}`);
		window.answer(card.id, false);
		await window.ended();
		assert(window.cards().length === 1 && callsOf("create_note") === 0, "one question, for the tool not allowed");
		window.ws.close();
		const conversation = "conv-allowed-left";
		const left = await openConversation(conversation);
		script = [{ calls: [listProjects] }, { calls: [deleteProject, createNote], before: async () => { left.ws.close(); await waitDetached(); } }];
		left.prompt("Delete Q3 and leave a note while I'm gone.");
		await waitForTurnSettled(json, room, "the turn after the person left landed");
		const leftItems = await threadItems(conversation);
		const notes = notesOf(leftItems);
		// The server saved this answer, as nobody was there: the step that ran on the room's yes keeps the person's words for its row.
		const ranStep = deleteStepOf(leftItems);
		assert(ranStep && !ranStep.isError && ranStep.details?.use === "Delete project in Asana", `the step that ran on the room's yes keeps the person's words, got ${JSON.stringify(ranStep)}`);
		assert(callsOf("delete_project") === 1 && callsOf("create_note") === 0, `after the person left the allowed tool ran and the other didn't, got ${JSON.stringify(connector.called)}`);
		assert(JSON.stringify(notes) === JSON.stringify([declinedQuestionNoteText("Use Create note in Asana?", true)]), `one note, for the tool not allowed, naming the way on, got ${JSON.stringify(notes)}`);
		console.log("ok 12 the allowed tool runs with no question, live and after the person left; another tool asks");
	}
	{
		const window = await openConversation("conv-remove");
		script = [{ calls: [deleteProject] }, {
			calls: [deleteProject],
			before: async () => {
				const removed = await json(connectorsPath, { method: "PUT", body: JSON.stringify({ action: "forget-tool", name: "asana", tool: "delete_project" }) });
				assert(removed.status === 200 && JSON.stringify(removed.body?.allowedTools) === "{}", `Remove in Room settings, got ${removed.status} ${JSON.stringify(removed.body)}`);
			},
		}];
		window.prompt("Delete Q3 twice.");
		const card = await window.card();
		assert(card.title === ASK_TITLE && callsOf("delete_project") === 1, `the first call ran with no question, the second asks after Remove, got ${JSON.stringify(connector.called)}`);
		window.answer(card.id, "room");
		await window.ended();
		assert(callsOf("delete_project") === 2 && (await allowedTools()) === ALLOWED_DELETE && window.cards().length === 1, `allowed for the room again, got ${JSON.stringify(connector.called)}, ${await allowedTools()}`);
		window.ws.close();
		console.log("ok 13 Remove counts from the next call, within a running answer too");
	}
	{
		// --- 15. The yes kept for the room changes no away limit: after the person left, the limit still ends a silent answer;
		// with only a view-only phone watching a room on Ask, the limits stand down for it as for any answer.
		const activeTurn = async () => (await json(`/api/persistent-agents/${encodeURIComponent(room)}/status`)).body?.activeThread;
		const left = await openConversation("conv-allowed-away");
		script = [{ calls: [deleteProject], before: async () => { left.ws.close(); await waitDetached(); } }, { calls: [listProjects], before: () => pause(AWAY_SILENCE_MS * 3) }];
		left.prompt("Delete Q3, then look around while I'm gone.");
		// The turn is under way once the person has left it: only then can its settling be read.
		await waitDetached();
		await waitForTurnSettled(json, room, "the away limit ends the silent answer", AWAY_SILENCE_MS * 4);
		const ended = await activeTurn();
		assert(callsOf("delete_project") === 1 && ended?.activeTurn?.lastTerminalReason === "failed", `after the person left, the allowed tool ran and the away limit ended the silent answer, got ${JSON.stringify(connector.called)}, ${JSON.stringify(ended?.activeTurn)}`);
		await pause(AWAY_SILENCE_MS * 2);
		const computer = await openConversation("conv-allowed-viewer");
		let phone: RoomWindow | undefined;
		let stillGoing = false;
		script = [
			{
				calls: [deleteProject],
				before: async () => {
					computer.ws.close();
					await waitDetached();
					phone = await openWindow("conv-allowed-viewer", viewPhone.cookie);
					await phone.seen((frame) => frame.type === "turn_reattach_replay_done", "the view-only phone watches the turn");
				},
			},
			{ calls: [listProjects], before: async () => { await pause(AWAY_SILENCE_MS * 2); stillGoing = (await activeTurn())?.inFlight === true; } },
		];
		computer.prompt("Delete Q3, then look around.");
		await waitUntil(() => {
			if (hookFailure) throw hookFailure;
			return phone !== undefined;
		}, "the view-only phone took the answer over");
		await waitForTurnSettled(json, room, "the answer the view-only phone watched landed", AWAY_SILENCE_MS * 6);
		assert(callsOf("delete_project") === 1 && stillGoing && (await activeTurn())?.activeTurn?.lastTerminalReason !== "failed", `with a view-only phone watching, the allowed tool ran and the answer went on past the away limit, got ${JSON.stringify(connector.called)}, going ${stillGoing}, ${JSON.stringify((await activeTurn())?.activeTurn)}`);
		phone?.ws.close();
		console.log("ok 15 the yes kept for the room changes no away limit: after the person left one still ends the answer, and a view-only phone stands them down as for any answer");
	}
	await waitForTurnSettled(json, room, "the last live turn has settled");
	const allowedRoom = room;
	room = firstRoom;
	await stopSmokeServer(serverProcess);
	serverProcess = undefined;

	// --- 9. A scheduled run: the marked tool runs, the unmarked one is refused with the note.
	Object.assign(process.env, { HOME: home, USERPROFILE: home, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, EXXETA_HOME: repoRoot });
	// The scheduled runs go on in this process, which reaches the connector's web name as the server did.
	await connector.proxyHere();
	const background = await import("../src/persistent-room-background-execution.js");
	const { getPersistentAgentThread } = await import("../src/persistent-agents.js");
	connector.called.length = 0;
	script = [{ calls: [listProjects] }, { calls: [deleteProject] }];
	await background.executePersistentRoomBackgroundPrompt({
		roomId: room,
		target: { kind: "fresh-thread", model: MODEL },
		prompt: "Tidy up Asana.",
		executionId: "connector-ask-scheduled",
		cwd: tempRoot,
		agentDir,
	} as any);
	assert(JSON.stringify(connector.called) === JSON.stringify(["list_projects"]), `a scheduled run reads and changes nothing, got ${JSON.stringify(connector.called)}`);
	const scheduled: any[] = getPersistentAgentThread(room, background.scheduledPromptBackgroundThreadId("connector-ask-scheduled"))?.items ?? [];
	assert(notesOf(scheduled).includes(AWAY_NOTE), `a scheduled run leaves the note, got ${JSON.stringify(scheduled.map((item) => `${item.kind}:${item.text ?? item.name}`))}`);
	readsNotRun(deleteStepOf(scheduled), AWAY_ROW, "a scheduled run");
	console.log("ok 9 a scheduled run reads, refuses the rest, and leaves the note");

	// --- 14. A scheduled run in the room that allowed Delete project: it runs; Create note is refused with a note that names the way
	// on, and Drop board, which the connector marks destructive, with a note that doesn't.
	connector.called.length = 0;
	script = [{ calls: [deleteProject] }, { calls: [createNote] }, { calls: [dropBoard] }];
	await background.executePersistentRoomBackgroundPrompt({
		roomId: allowedRoom,
		target: { kind: "fresh-thread", model: MODEL },
		prompt: "Tidy up Asana.",
		executionId: "connector-allowed-scheduled",
		cwd: tempRoot,
		agentDir,
	} as any);
	assert(JSON.stringify(connector.called) === JSON.stringify(["delete_project"]), `a scheduled run uses the allowed tool alone, got ${JSON.stringify(connector.called)}`);
	const allowedRun = notesOf(getPersistentAgentThread(allowedRoom, background.scheduledPromptBackgroundThreadId("connector-allowed-scheduled"))?.items ?? []);
	assert(JSON.stringify(allowedRun) === JSON.stringify([declinedQuestionNoteText("Use Create note in Asana?", true), declinedQuestionNoteText("Use Drop board in Asana?")]), `the notes, got ${JSON.stringify(allowedRun)}`);
	console.log("ok 14 a scheduled run uses the allowed tool, and its notes name the way on only where it is offered");
	console.log("connector-ask-first-smoke: OK");
} catch (error) {
	console.error(serverOutput.join("").slice(-4000));
	throw error;
} finally {
	try { gateway.close(); } catch {}
	try { connector.server.close(); } catch {}
	await stopSmokeServer(serverProcess);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
