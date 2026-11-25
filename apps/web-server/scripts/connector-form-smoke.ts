// A connector's form in a real room: a real server, a gateway that plays the
// model, a real window and a connector program of the smoke's own
// (connector-form-stand-in.mjs), reached through the mcp tool.
//
// - the form arrives as one card with each field, its kind and Required; a
//   Send whose values don't fit gets a line under each such field and nothing
//   reaches the connector; one that fits reaches it as its form asks;
// - Not now declines; a form the connector stops waiting for closes as
//   withdrawn; one nobody is there for is declined as a question is today;
// - the model's result says how the form ended on the one call that asked it,
//   after the connector's own answer and with no value typed; with two calls
//   to the connector running, in either order of their ends, neither gets it;
// - a form that asks the person to open a page stays refused;
// - no connector is offered the model: no hello declares it, in a room or from
//   the Connectors page's check, whatever the connector settings say, and one
//   asked anyway is refused with no model called and no question;
// - without the form patch, the adapter's cards still work with the room's
//   own questions (its handler with the patch's lines taken out, in this
//   process);
// - a form after the room's connectors changed, in the same window, still
//   tells the model how it ended.
//
// FORM_SMOKE_ROWS=1,6a runs those rows alone, so each shows its own red where the
// change is missing.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import { fileURLToPath, pathToFileURL } from "node:url";
import { authedFetch, freePort, smokeHomeEnv, SMOKE_AUTH_HEADERS, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, stopSmokeServer, waitForServer, type AuthedFetchInit } from "./smoke-server-process.js";
import { waitForTurnSettled } from "./smoke-turn-settle.js";
import { waitEvery } from "./smoke-wait.js";
import { connectorFormModelLine, connectorFormTitle, FORM_FIELD_LINES } from "../src/connector-form-ask.js";
import { createWebUiContext } from "../src/web-ui-context.js";
import { declinedQuestionNoteText } from "../src/thread-items-by-id.js";
import { ANSWER_FLOOR_MS } from "../src/room-box/card-text.js";

if (os.platform() === "win32") {
	console.log("SKIPPED: not yet on a real Windows PC: the stand-in's program start there is not checked yet");
	process.exit(0);
}

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const standIn = path.join(scriptDir, "connector-form-stand-in.mjs");
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-connector-form-"));
const home = path.join(tempRoot, "home");
const agentDir = path.join(home, ".exxperts", "agent");
const appRoot = path.join(home, ".exxperts", "app");
const agentsRoot = path.join(appRoot, "personalized-agents");
const MODEL = { provider: "openai-compatible", model: "room-model" };
const CONNECTOR = "Toy space";
const waitUntil = waitEvery(25, 30_000);
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const ROWS = process.env.FORM_SMOKE_ROWS?.split(",").map((row) => row.trim());
const runs = (row: string) => !ROWS || ROWS.includes(row);

// --- The connector program: what reached it, from its log.
const standInLog = path.join(tempRoot, "stand-in.log");
type Logged = { event: string; label?: string; action?: string; content?: Record<string, unknown>; code?: number; capabilities?: Record<string, unknown> };
const logged = (): Logged[] => (fs.existsSync(standInLog) ? fs.readFileSync(standInLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line)) : []);
const eventsOf = (label: string, event: string) => logged().filter((entry) => entry.label === label && entry.event === event);
const hellos = () => logged().filter((entry) => entry.event === "hello");
const writeSetting = (file: string, value: unknown) => fs.writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
// `spare`: a second connector, switched on only to change what a room may use.
const connectorFile = (settings?: Record<string, unknown>) => ({ ...(settings ? { settings } : {}), mcpServers: { toyspace: { command: process.execPath, args: [standIn], env: { STAND_IN_LOG: standInLog }, displayName: CONNECTOR }, spare: { command: process.execPath, args: [standIn], env: { STAND_IN_LOG: standInLog }, displayName: "Spare space" } } });

// --- The gateway plays the model: the turn's first leg makes the scripted calls, then it answers in words.
type Call = { name: string; arguments: Record<string, unknown> };
let script: Call[] = [];
let requests: Array<{ body: string; toolResults: string[] }> = [];
// Every call of the smoke has its own id, across turns.
let callsMade = 0;
const sseChunk = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => String(part?.text ?? "")).join("\n") : "");
const gateway = http.createServer((req, res) => {
	let body = "";
	req.on("data", (chunk) => { body += chunk; });
	req.on("end", () => {
		const parsed = JSON.parse(body || "{}");
		const messages: any[] = Array.isArray(parsed.messages) ? parsed.messages : [];
		const after = messages.slice(messages.map((message) => message?.role).lastIndexOf("user") + 1);
		requests.push({ body, toolResults: after.filter((message) => message?.role === "tool").map((message) => textOf(message.content)) });
		const first = (parsed.tools ?? []).length > 0 && after.every((message) => message?.role !== "assistant");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		const base = { id: `cmpl_${requests.length}`, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: String(parsed.model ?? MODEL.model) };
		if (first && script.length > 0) {
			const tool_calls = script.map((call, index) => ({ index, id: `call_${(callsMade += 1)}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", tool_calls }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } }));
		} else {
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: { role: "assistant", content: "Done." }, finish_reason: null }] }));
			res.write(sseChunk({ ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 150, completion_tokens: 12, total_tokens: 162 } }));
		}
		res.write("data: [DONE]\n\n");
		res.end();
	});
});

/** A call of one of the stand-in's tools through the mcp tool. */
const tool = (name: string, args: Record<string, unknown>): Call => ({ name: "mcp", arguments: { tool: `toyspace_${name}`, server: "toyspace", args: JSON.stringify(args) } });

const WebSocketImpl: any = (await import("ws")).default;
let serverProcess: ChildProcessWithoutNullStreams | undefined;
let port = 0;
let room = "";
async function json(pathname: string, init: AuthedFetchInit = {}): Promise<{ status: number; body: any }> {
	const response = await authedFetch(`http://127.0.0.1:${port}${pathname}`, { ...init, headers: { ...(init.body ? { "content-type": "application/json" } : {}), ...init.headers } });
	const text = await response.text();
	return { status: response.status, body: text ? JSON.parse(text) : null };
}
const threadPath = (conversation: string) => `/api/persistent-agents/${encodeURIComponent(room)}/threads/${conversation}`;

async function openWindow(conversation: string) {
	const query = `persistentAgentId=${room}&conversationId=${conversation}&modelProvider=${MODEL.provider}&model=${MODEL.model}&reattach=1`;
	const ws = new WebSocketImpl(`ws://127.0.0.1:${port}/ws?${query}`, { headers: { ...SMOKE_AUTH_HEADERS } });
	const frames: any[] = [];
	ws.addEventListener("message", (event: any) => { try { frames.push(JSON.parse(String(event.data))); } catch {} });
	await new Promise<void>((resolve, reject) => { ws.addEventListener("open", () => resolve()); ws.addEventListener("error", () => reject(new Error("websocket failed to connect"))); });
	const seen = async (match: (frame: any) => boolean, label: string, timeoutMs?: number): Promise<any> => {
		await waitUntil(() => frames.some(match), `${label}; frames ${frames.map((frame) => frame.type).join(",")}`, timeoutMs);
		return frames.find(match);
	};
	await seen((frame) => frame.type === "ready", `${conversation}: the window is ready`);
	const isEnd = (frame: any) => frame.type === "event" && frame.event?.type === "agent_end";
	return {
		ws,
		frames,
		seen,
		prompt: (text: string) => ws.send(JSON.stringify({ type: "prompt", text })),
		answer: (id: string, value: unknown) => ws.send(JSON.stringify({ type: "ui_response", id, value })),
		ended: () => waitUntil(() => frames.some(isEnd), "the turn ended", 30_000),
		/** The results the model was given for its calls, in the order of its calls. */
		results: () => {
			const messages = frames.filter((frame) => frame.type === "event" && frame.event?.type === "message_end").map((frame) => frame.event.message);
			const calls = messages.filter((message) => message?.role === "assistant").flatMap((message) => (Array.isArray(message.content) ? message.content : [])).filter((part: any) => part?.type === "toolCall");
			return calls.map((call: any) => {
				const result = messages.find((message) => message?.role === "toolResult" && message.toolCallId === call.id);
				return { id: String(call.id), text: result ? textOf(result.content) : "", isError: result?.isError === true, details: result?.details };
			});
		},
	};
}

let turnBefore = false;
/** A conversation of its own whose model makes `calls` at once. */
async function startTurn(conversation: string, calls: Call[]) {
	if (turnBefore) await waitForTurnSettled(json, room, `the turn before ${conversation} has settled`);
	turnBefore = true;
	assert((await json(threadPath(conversation), { method: "PUT", body: JSON.stringify({ state: "active", origin: "launcher", model: MODEL, items: [] }) })).status === 200, `${conversation} was seeded`);
	const window = await openWindow(conversation);
	script = calls;
	requests = [];
	window.prompt(`Run ${conversation}.`);
	return window;
}
const formFrame = (window: Awaited<ReturnType<typeof openWindow>>, label: string) => window.seen((frame) => frame.type === "ui_request" && frame.kind === "form", `${label}: the form's card came`);
// A Send right as the card shows is a press meant for something else, and counts for nothing.
const afterFloor = () => pause(ANSWER_FLOOR_MS + 150);

const LINES = { sent: connectorFormModelLine("sent", CONNECTOR), notNow: connectorFormModelLine("not-now", CONNECTOR), nobody: connectorFormModelLine("nobody", CONNECTOR) };
const formLinesIn = (text: string) => Object.values(LINES).filter((line) => text.includes(line));

const cleanUp = async () => {
	try { gateway.close(); } catch {}
	await stopSmokeServer(serverProcess);
	fs.rmSync(tempRoot, { recursive: true, force: true });
};

try {
	await new Promise<void>((resolve) => gateway.listen(0, "127.0.0.1", resolve));
	const gatewayPort = (gateway.address() as AddressInfo).port;
	for (const dir of [agentsRoot, agentDir, appRoot]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
	writeSetting(path.join(agentDir, "models.json"), { providers: { "openai-compatible": { name: "Synthetic Gateway", baseUrl: `http://127.0.0.1:${gatewayPort}/v1`, api: "openai-completions", models: [{ id: "room-model", name: "Room Model", contextWindow: 200000, maxTokens: 4096 }] } } });
	writeSetting(path.join(agentDir, "auth.json"), { "openai-compatible": { type: "api_key", key: "synthetic-connector-form" } });
	writeSetting(path.join(appRoot, "openai-compatible-ai-profile.json"), { profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "room-model", label: "Room Model" }], maintenanceModel: "room-model" });
	writeSetting(path.join(appRoot, "persistent-agent-ai-profile.json"), { profileId: "openai-compatible" });
	writeSetting(path.join(agentDir, "mcp.json"), connectorFile());

	port = await freePort();
	serverProcess = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: { ...process.env, ...smokeHomeEnv(home), EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot, PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot } as NodeJS.ProcessEnv,
	});
	serverProcess.stdout.resume();
	serverProcess.stderr.resume();
	await waitForServer(serverProcess, `http://127.0.0.1:${port}`, 60_000);
	const created = await json("/api/persistent-agents", { method: "POST", body: JSON.stringify({ displayName: "Form Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }) });
	room = String(created.body?.agent?.id ?? created.body?.agent?.agentId ?? "");
	assert(created.status === 201 && room, `room created, got ${created.status}`);
	assert((await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "toyspace" }) })).status === 200, "Toy space was enabled");

	// --- 1. One card, each field with its own label, kind and Required; a Send that doesn't fit gets its lines, one that fits reaches the connector.
	if (runs("1")) {
		const window = await startTurn("conv-send", [tool("ask", { label: "send", form: "all" })]);
		const card = await formFrame(window, "send");
		const asked = window.frames.filter((frame) => frame.type === "ui_request" && frame.kind !== "notify" && frame.kind !== "status");
		assert(asked.length === 1, `one card for the whole form, got ${asked.map((frame) => `${frame.kind}: ${frame.title}`).join(" | ")}`);
		assert(card.title === connectorFormTitle(CONNECTOR) && card.connector === CONNECTOR && card.message === "Tell us about the trip.", `the card names the connector as the person knows it and carries its message, got ${card.title} / ${card.connector} / ${card.message}`);
		const shape = card.fields.map((field: any) => `${field.name}:${field.kind}:${field.label}:${field.required ? "required" : "optional"}`);
		const expected = ["name:text:Your name:required", "nights:integer:Nights:required", "budget:number:Budget:optional", "email:email:Email:required", "site:url:Hotel page:optional", "start:date:Start date:optional", "room:one:Room:required", "extras:many:Extras:required", "insured:yes-no:Travel insurance:optional", "notes:text:Notes:optional"];
		assert(JSON.stringify(shape) === JSON.stringify(expected), `each field with its own label, kind and Required, got ${JSON.stringify(shape)}`);
		assert(card.fields.find((field: any) => field.name === "room").choices.map((choice: any) => choice.label).join(",") === "Single,Double" && card.fields.find((field: any) => field.name === "notes").description === "Anything the hotel should know.", "a list's choices and a field's own words come with it");
		console.log("ok 1a the form arrives as one card: each field with its own label, kind and Required");

		await afterFloor();
		window.answer(card.id, { values: { name: "A", nights: "0", budget: "lots", email: "not an email", site: "not a page", start: "next week", extras: ["breakfast", "parking", "late checkout"], insured: false } });
		const update = await window.seen((frame) => frame.type === "ui_request_update" && frame.id === card.id, "send: the lines came back");
		const lines = { name: FORM_FIELD_LINES.minLength(2), nights: FORM_FIELD_LINES.orMore(1), budget: FORM_FIELD_LINES.number, email: FORM_FIELD_LINES.email, site: FORM_FIELD_LINES.url, start: FORM_FIELD_LINES.date, room: FORM_FIELD_LINES.pickOne, extras: FORM_FIELD_LINES.atMost(2) };
		assert(JSON.stringify(update.fieldLines) === JSON.stringify(lines), `a line under each field that doesn't fit, by the adapter's own check, got ${JSON.stringify(update.fieldLines)}`);
		// The card changed: the floor counts again from its lines.
		await afterFloor();
		assert(eventsOf("send", "form").length === 0, "nothing reached the connector");
		window.answer(card.id, { values: { name: "Ada", nights: "2.5", email: "ada@example.com", room: "double", extras: [], insured: false } });
		const second = await window.seen((frame) => frame.type === "ui_request_update" && frame.id === card.id && frame !== update, "send: the second lines came back");
		assert(JSON.stringify(second.fieldLines) === JSON.stringify({ nights: FORM_FIELD_LINES.integer, extras: FORM_FIELD_LINES.atLeast(1) }), `a field that fits now has no line, got ${JSON.stringify(second.fieldLines)}`);
		console.log("ok 1b a value that doesn't fit gets its line and nothing is sent");

		await afterFloor();

		window.answer(card.id, { values: { name: "Ada", nights: "3", budget: "120.5", email: "ada@example.com", site: "https://hotel.example.com", start: "2026-12-01", room: "double", extras: ["breakfast"], insured: true, notes: "Quiet room" } });
		const closed = await window.seen((frame) => frame.type === "ui_request_closed" && frame.id === card.id, "send: the card closed");
		assert(closed.reason === "answered" && closed.taken === "sent" && Object.keys(closed).sort().join(",") === "id,reason,taken,type", `the card closed as sent, with no value in its frame, got ${JSON.stringify(Object.keys(closed))}`);
		await waitUntil(() => eventsOf("send", "form").length === 1, "the connector got the form's answer");
		const got = eventsOf("send", "form")[0]!;
		const wanted = { name: "Ada", nights: 3, budget: 120.5, email: "ada@example.com", site: "https://hotel.example.com", start: "2026-12-01", room: "double", extras: ["breakfast"], insured: true, notes: "Quiet room" };
		assert(got.action === "accept" && JSON.stringify(got.content) === JSON.stringify(wanted), "the values reach the connector as its form asks: numbers as numbers, a list as a list, yes or no as true or false");
		console.log("ok 1c Send delivers the values as the connector's form asks");

		await window.ended();
		const [result] = window.results();
		const said = result?.text ?? "";
		assert(said.startsWith("Form accept.") && said.endsWith(LINES.sent) && formLinesIn(said).length === 1, `the call that asked holds the connector's own answer, then the line, got ${JSON.stringify(said)}`);
		assert(["Ada", "ada@example.com", "hotel.example.com", "Quiet room", "120.5"].every((typed) => !said.includes(typed)), "the line holds no value the person typed");
		const toModel = requests.at(-1)?.toolResults.join("\n") ?? "";
		assert(toModel.includes(LINES.sent), "the model reads the line");
		window.ws.close();
		console.log("ok 1d the call that asked tells the model the person sent the form, with no value typed");
	}

	// --- 2. Not now declines; the connector stopping its wait closes the card as withdrawn.
	if (runs("2a")) {
		const window = await startTurn("conv-not-now", [tool("ask", { label: "not-now" })]);
		const card = await formFrame(window, "not now");
		await afterFloor();
		window.answer(card.id, "decline");
		const closed = await window.seen((frame) => frame.type === "ui_request_closed" && frame.id === card.id, "not now: the card closed");
		await window.ended();
		const [result] = window.results();
		assert(closed.taken === "decline" && eventsOf("not-now", "form")[0]?.action === "decline", `Not now declines the form, got ${closed.taken} / ${eventsOf("not-now", "form")[0]?.action}`);
		assert(result?.text.startsWith("Form decline.") && result.text.endsWith(LINES.notNow) && formLinesIn(result.text).length === 1, `the model reads the person chose Not now, got ${JSON.stringify(result?.text)}`);
		window.ws.close();
		console.log("ok 2a Not now declines, and the model reads it on the call that asked");
	}
	if (runs("2b")) {
		const window = await startTurn("conv-gave-up", [tool("ask", { label: "gave-up", giveUpMs: 1_500 })]);
		const card = await formFrame(window, "gave up");
		const closed = await window.seen((frame) => frame.type === "ui_request_closed" && frame.id === card.id, "gave up: the card closed", 10_000);
		await window.ended();
		const [result] = window.results();
		assert(closed.reason === "withdrawn" && eventsOf("gave-up", "gave-up").length === 1, `a form the connector stopped waiting for closes as withdrawn, got ${closed.reason}`);
		assert(result?.text.startsWith("Form not answered in time.") && result.text.endsWith(LINES.nobody), `the model reads nobody answered before it closed, got ${JSON.stringify(result?.text)}`);
		window.ws.close();
		console.log("ok 2b a form the connector stopped waiting for closes with its own end");
	}

	// --- 3. Nobody there: the form is declined as a question is today, and the landing says so.
	if (runs("3")) {
		const window = await startTurn("conv-away", [tool("ask", { label: "away" })]);
		const card = await formFrame(window, "away");
		window.ws.close();
		await waitUntil(() => eventsOf("away", "form").length === 1, "away: the connector got an answer");
		await waitForTurnSettled(json, room, "away: the turn landed");
		const items: any[] = (await json(threadPath("conv-away"))).body?.thread?.items ?? [];
		const note = declinedQuestionNoteText(card.title);
		assert(eventsOf("away", "form")[0]?.action === "cancel", `nobody there: the connector is told the form was dismissed, got ${eventsOf("away", "form")[0]?.action}`);
		assert(items.some((item) => item.kind === "system" && item.text === note), `the landing says a question came up while away, got ${JSON.stringify(items.filter((item) => item.kind === "system").map((item) => item.text))}`);
		const toModel = requests.at(-1)?.toolResults.join("\n") ?? "";
		assert(toModel.endsWith(LINES.nobody), `the model reads nobody answered, got ${JSON.stringify(toModel)}`);
		console.log("ok 3 a form nobody is there for is declined as a question is today");
	}

	// --- 4. Two calls to the connector at once: in either order of their ends, neither gets the form's line.
	for (const [order, workMs] of runs("4") ? ([["the other call ends first", 200], ["the asking call ends first", 6_000]] as const) : []) {
		const label = workMs < 1_000 ? "pair-a" : "pair-b";
		const window = await startTurn(`conv-${label}`, [tool("ask", { label }), tool("work", { label: `${label}-work`, ms: workMs })]);
		const card = await formFrame(window, order);
		// The room hands the model its calls' results in their order, so the other call's end shows first in the connector's log.
		if (workMs < 1_000) await waitUntil(() => eventsOf(`${label}-work`, "worked").length === 1, `${order}: the other call ended`);
		await afterFloor();
		window.answer(card.id, { values: { city: "Lisbon" } });
		await window.ended();
		const results = window.results();
		assert(results.length === 2 && results.every((result) => formLinesIn(result.text).length === 0), `${order}: neither call gets the form's line, got ${JSON.stringify(results.map((result) => result.text))}`);
		assert(results[0]?.text === "Form accept." && results[1]?.text === `${label}-work done`, `${order}: each keeps the connector's own answer, got ${JSON.stringify(results.map((result) => result.text))}`);
		window.ws.close();
		console.log(`ok 4 two calls at once, ${order}: no call gets the form's line`);
	}

	// --- 5. A form that asks the person to open a page stays refused outside the terminal.
	if (runs("5")) {
		const window = await startTurn("conv-page", [tool("ask_page", { label: "page" })]);
		await window.ended();
		const page = eventsOf("page", "page")[0];
		assert(page?.code !== undefined && !window.frames.some((frame) => frame.type === "ui_request" && frame.kind !== "notify" && frame.kind !== "status"), `a page form is refused, and nobody is asked, got ${JSON.stringify(page)}`);
		window.ws.close();
		console.log("ok 5 a form that asks to open a page stays refused");
	}

	// --- 6. No connector is offered the model.
	if (runs("6a")) {
		const plain = await startTurn("conv-hello", [tool("work", { label: "hello", ms: 10 })]);
		await plain.ended();
		plain.ws.close();
		const withModel = hellos().filter((hello) => "sampling" in (hello.capabilities ?? {}));
		// The app's own read of a connector's tools has no window, so its hello offers neither; a room's offers forms.
		assert(hellos().some((hello) => "elicitation" in (hello.capabilities ?? {})) && withModel.length === 0, `a room's hello offers forms and no hello offers the model, got ${JSON.stringify(hellos().map((hello) => hello.capabilities))}`);
		const window = await startTurn("conv-borrow", [tool("borrow", { label: "borrow" })]);
		await window.ended();
		const [result] = window.results();
		assert(eventsOf("borrow", "borrow")[0]?.code === -32601, `a connector that asks anyway is refused, got ${JSON.stringify(eventsOf("borrow", "borrow"))}`);
		assert(requests.every((request) => !request.body.includes("Borrowed text")), "no model is called with the connector's text");
		assert(!window.frames.some((frame) => frame.type === "ui_request" && /sampling|model/i.test(String(frame.title ?? ""))), "no question about the model");
		assert(result?.isError && result.details?.failure === "connector-error", `the step reads as the connector's own error, got ${JSON.stringify(result?.details)}`);
		window.ws.close();
		console.log("ok 6a no hello offers the model, and a request sent anyway is refused with no model called");
	}
	if (runs("6b")) {
		for (const settings of [{ sampling: true }, { samplingAutoApprove: true }]) {
			writeSetting(path.join(agentDir, "mcp.json"), connectorFile(settings));
			const before = hellos().length;
			const turn = await startTurn(`conv-settings-${Object.keys(settings)[0]}`, [tool("work", { label: `settings-${Object.keys(settings)[0]}`, ms: 10 })]);
			await turn.ended();
			turn.ws.close();
			const checked = await json("/api/mcp/servers/toyspace/test", { method: "POST" });
			const after = hellos().slice(before);
			assert(checked.status === 200 && after.length >= 2 && after.every((hello) => !("sampling" in (hello.capabilities ?? {}))), `with ${JSON.stringify(settings)}, neither a room nor the Connectors page's check offers the model, got ${checked.status} / ${JSON.stringify(after.map((hello) => hello.capabilities))}`);
		}
		writeSetting(path.join(agentDir, "mcp.json"), connectorFile());
		console.log("ok 6b with sampling or samplingAutoApprove in the settings, still no hello offers the model, in a room or from the check");
	}

	// --- 7. Without the form patch, the adapter's own cards still work with the room's questions.
	if (runs("7")) {
		const adapterDir = path.dirname(createRequire(import.meta.url).resolve("pi-mcp-adapter/package.json"));
		const patched = fs.readFileSync(path.join(adapterDir, "elicitation-handler.ts"), "utf8");
		const unpatched = patched.split("\n").filter((line) => !line.includes("askForm") && !line.includes("patch 28")).join("\n");
		assert(patched.includes("askForm") && !unpatched.includes("askForm"), "the copy holds the adapter's handler without the patch's lines");
		// Beside the adapter's own, so it imports what the adapter imports.
		const copy = path.join(adapterDir, `.form-smoke-${process.pid}.ts`);
		fs.writeFileSync(copy, unpatched);
		try {
			const handler = await import(pathToFileURL(copy).href);
			const frames: any[] = [];
			const ui = createWebUiContext((frame) => frames.push(frame));
			const answered = handler.handleElicitationRequest({ serverName: "toyspace", ui, allowUrl: false }, { method: "elicitation/create", params: { mode: "form", message: "Which city?", requestedSchema: { type: "object", properties: { city: { type: "string", title: "City" } }, required: ["city"] } } });
			const reply = async (kind: string, value: unknown) => {
				const at = frames.length;
				await waitUntil(() => frames.slice(at - 1).some((frame) => frame.type === "ui_request" && frame.kind === kind), `the adapter asked a ${kind} card`);
				const frame = frames.filter((one) => one.type === "ui_request" && one.kind === kind).at(-1);
				ui.resolveResponse(frame.id, value);
				return frame;
			};
			const first = await reply("select", "Continue");
			await reply("select", "Enter value");
			await reply("input", "Lisbon");
			await reply("select", "Submit");
			const result = await answered;
			assert(String(first.title).startsWith("MCP Input Request") && result.action === "accept" && result.content?.city === "Lisbon" && !frames.some((frame) => frame.kind === "form"), `today's cards still work, got ${JSON.stringify(result)}`);
		} finally {
			fs.rmSync(copy, { force: true });
		}
		console.log("ok 7 without the form patch, the adapter's cards work with the room's questions");
	}

	// --- 8. The room's connectors change while its window stays: the next message builds the room's session again, and a form there still tells its call how it ended.
	if (runs("8")) {
		const window = await startTurn("conv-rebind", [tool("ask", { label: "rebind-before" })]);
		const before = await formFrame(window, "rebind, before");
		await afterFloor();
		window.answer(before.id, { values: { city: "Lisbon" } });
		await window.ended();
		assert(window.results()[0]?.text.endsWith(LINES.sent), `before the change, the call reads the form was sent, got ${JSON.stringify(window.results()[0]?.text)}`);
		await waitForTurnSettled(json, room, "rebind: the first turn settled");
		assert((await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "grant", name: "spare" }) })).status === 200, "Spare space was enabled");
		const at = window.frames.length;
		const isEnd = (frame: any) => frame.type === "event" && frame.event?.type === "agent_end";
		script = [tool("ask", { label: "rebind-after" })];
		requests = [];
		window.prompt("Again.");
		const after = await window.seen((frame) => frame.type === "ui_request" && frame.kind === "form" && window.frames.indexOf(frame) >= at, "rebind, after: the form's card came");
		await afterFloor();
		window.answer(after.id, "decline");
		await waitUntil(() => window.frames.slice(at).some(isEnd), "rebind: the second turn ended");
		const said = window.results()[1]?.text ?? "";
		assert(said.startsWith("Form decline.") && said.endsWith(LINES.notNow), `after the change, the call reads the person chose Not now, got ${JSON.stringify(window.results())}`);
		window.ws.close();
		assert((await json(`/api/persistent-agents/${encodeURIComponent(room)}/mcp-connectors`, { method: "PUT", body: JSON.stringify({ action: "revoke", name: "spare" }) })).status === 200, "Spare space was switched off again");
		console.log("ok 8 after the room's connectors change in the same window, a form still tells its call how it ended");
	}

	console.log("connector-form-smoke: OK");
} finally {
	await cleanUp();
}
process.exit(0);
