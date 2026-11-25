// The room's question, docked above the message box, in a browser against a real
// server and a synthetic model, with the questions handed to the page as the
// server sends them:
//
// - where it sits: right above the box at 1280 and 390 px, light and dark, never
//   past half the window, its answers stacked at phone width; the steps keep a
//   quiet row and a head with no amber;
// - it takes no focus, is a named region, says each new question politely, and
//   comes before the box in tab order;
// - its main answer ignores a click and the chord for its pause (when it
//   appears, at the next question, when the window comes to the front, when the
//   folder window gives back a line), and takes them after; it looks the same;
// - several questions: the oldest one at a time, with a count, and a new one
//   changes only the count;
// - plain Enter gives no yes, from the box, the page or a focused button;
//   Cmd+Enter (Ctrl+Enter on Windows) is Allow this time only with the box
//   empty and nothing queued, and is Send now otherwise; the commands question
//   takes no chord; Escape is the no, from the empty box, the panel or the page;
// - on a narrow screen no taller than 740px, two answers share a row, and a real
//   press, mouse or finger, reaches the pressed answer and only it;
// - sending a message declines the question only when the draft started after it;
// - the folder the server shows: a Folder row with its name and path, wrapping and
//   never cut; Choose another folder with one click, Choose folder without; a press
//   reads Choosing and leaves only Not now answering;
// - the run-outside question: Escape waits out the pause and a held one answers nothing,
//   both answers fold it at once with no reply from the server, the steps keep their
//   lines, the box's hint is the panel's, a long command scrolls in a panel that keeps
//   to half the window, Run once wakes after its delay with nothing scrolled and stays
//   awake where scrollbars take space, and Running now shows only a command begun and
//   not waiting for its own question;
// - "Run this command?" on Ask: its title, the command whole in its box and the folder under
//   Runs in, Not now and Run once, no card with Deny or Allow in the steps; plain Enter never
//   gives Run once and Cmd+Enter does only with the box empty, nothing queued and the pause over;
//   a long command scrolls with the answers in view; a phone answers it; two waiting show one; and,
//   with the room's real question in a room with protection off and in one with it left on, Run
//   once runs the command, Not now, Escape and a message leave it not run with the model reading
//   today's no, and the steps keep one row for the command and none for the question;
// - a reload draws no panel from a saved question;
// - a connector's form: one card in the question's place at 1280 and 390 px,
//   light and dark, with nothing to scroll sideways: the connector's message
//   under From, each field with its own label, Required, Send and Not now; Tab
//   goes through its fields in order, Enter in a field and Escape send nothing;
//   Send carries what was typed, ticked and picked, the server's lines show
//   under their fields with what was typed kept and the focus on the first; Not now, a form sent, and one
//   the connector stopped waiting for each leave their row in the steps; a
//   date and time is picked, and goes as the adapter's own check takes it,
//   and the connector's own one shows in the picker and goes unchanged; a list
//   with nothing picked shows its prompt, which goes as no value, so the
//   server's check gives a required list its line and an optional one nothing.
//
// Run: npm run smokes -- ask-panel-ui
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright";
import { authedFetch, SMOKE_AUTH_TOKEN, SMOKE_SERVER_AUTH_ENV, SMOKE_SERVER_SPAWN_TREE_OPTIONS, smokeHomeEnv, stopSmokeServer, freePort, putRunWithoutAsking } from "./smoke-server-process.js";
import { sendFromBox, waitEvery } from "./smoke-wait.js";
import { CONNECTOR_CHOICE_WORDS, connectorApprovalTitle, connectorChangeLine, connectorRiskLine, PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE } from "../src/room-approval-titles.js";
import { connectorAskFrame, connectorFormFrame } from "../src/web-ui-context.js";
import { checkConnectorForm, connectorFormFrom, connectorFormGaveUpLine, connectorFormGoesTo, connectorFormTitle, FORM_FIELD_LINES, FORM_PICK_PROMPT, FORM_REQUIRED, FORM_SEND, FORM_SENT, readConnectorFormValues, type ConnectorFormParams } from "../src/connector-form-ask.js";
import { COMMAND_DECLINED } from "../src/persistent-room-bash-approval.js";
import { ALLOW_FOR_ROOM_PICK, ALLOW_THIS_TIME_PICK, ASK_PANEL_NAME, ASKED_FOR_FOLDER, CHOOSE_ANOTHER_FOLDER, CHOOSE_FOLDER, CHANGE_SAVE_FAILED, CHOOSING, FILE_LABEL, FOLDER_CARD_WINDOW_CLOSED, FOLDER_PICK_REFUSED_IN_PANEL, COMMANDS_ASK_LINES, COMMANDS_ASK_TITLE, folderAskLine, folderAskTitle, FOLDER_PANE_TITLE, FOLDER_PANEL_PRESSES, moreQuestionsLine, NOT_NOW, OUTSIDE_CARD_LINE, OUTSIDE_RUN_DELAY_MS, OUTSIDE_RUN_ONCE, roomNeedsAnswer, RUNNING_NOW, RUNS_IN, SENDING_COUNTS_AS_NOT_NOW, siteCardQuestion, SITE_ALLOW_ONCE, TURN_ON_ANYWAY, TURN_ON_COMMANDS, WAITING_AT_COMPUTER, WAITING_FOR_OK } from "../src/room-box/card-text.js";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

{
	const browserPath = typeof chromium?.executablePath === "function" ? chromium.executablePath() : "";
	if (!browserPath || !fs.existsSync(browserPath)) {
		console.log("ask panel ui smoke skipped (Chromium not installed)");
		process.exit(0);
	}
}

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerDir = path.resolve(scriptDir, "..");
const repoRoot = path.resolve(webServerDir, "..", "..");
const port = await freePort();
const baseUrl = `http://127.0.0.1:${port}`;
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-ask-panel-")));
const tempHome = path.join(tempRoot, "home");
const agentsRoot = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const agentDir = path.join(tempHome, ".exxperts", "agent");
for (const dir of [agentsRoot, agentDir]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = agentsRoot;

const KEY_PROVIDER = "anthropic-api-key";
const ON_KEY = { provider: KEY_PROVIDER, model: "claude-sonnet-5-5" };
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const WINDOWS = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
const waitUntil = waitEvery(50, 20_000);

function sse(res: http.ServerResponse, event: string, payload: unknown): void {
	if (!res.destroyed) res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

const lastUserText = (messages: any[]): string => {
	const user = [...messages].reverse().find((message) => message.role === "user" && (typeof message.content === "string" || message.content?.some?.((part: any) => part.type === "text")));
	return typeof user?.content === "string" ? user.content : (user?.content ?? []).map((part: any) => part.text ?? "").join("\n");
};
const answeredTool = (messages: any[]): boolean => messages.slice(-2).some((message) => Array.isArray(message.content) && message.content.some((part: any) => part.type === "tool_result"));
/** A message with this in it makes the model call the room's folder question, which then waits on the person. */
const ASK_THE_FOLDER = "Ask for the folder.";
/** A message that starts with this makes the model run the rest of it as a command, then end its answer; what the command's step gave the model is kept. */
const RUN_THE_COMMAND = "Run the command: ";
const textOf = (content: unknown): string => (typeof content === "string" ? content : Array.isArray(content) ? content.map((part: any) => (part?.type === "text" ? String(part.text ?? "") : "")).join("\n") : "");

// Every answer writes a little and then holds, as a turn does while a step waits on a question, until the page cuts it.
const endpointState = { open: 0, folderAskDescription: "", commandResults: [] as Array<{ command: string; text: string; isError: boolean }> };
const endpoint = http.createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => { raw += chunk; });
	req.on("end", () => {
		const body = JSON.parse(raw || "{}");
		const messages: any[] = body.messages ?? [];
		const folderAsk = (body.tools ?? []).find((tool: any) => tool.name === "ask_for_folder");
		if (folderAsk) endpointState.folderAskDescription = String(folderAsk.description ?? "");
		res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
		sse(res, "message_start", { type: "message_start", message: { id: `msg_panel_${Date.now()}`, type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } });
		const asked = messages.map((message) => message.role === "user" && textOf(message.content).startsWith(RUN_THE_COMMAND)).lastIndexOf(true);
		// Only the rooms the model runs commands in are sent this; a message sent there while the command waits ends with the command's step.
		if (asked >= 0) {
			const command = textOf(messages[asked].content).slice(RUN_THE_COMMAND.length);
			const result = messages.slice(asked + 1).flatMap((message) => (Array.isArray(message.content) ? message.content : [])).find((part: any) => part.type === "tool_result");
			if (!result) {
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_run_${Date.now()}`, name: "bash", input: {} } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ command }) } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
				sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
			} else {
				endpointState.commandResults.push({ command, text: textOf(result.content), isError: result.is_error === true });
				sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } });
				sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
				sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } });
			}
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		if (!answeredTool(messages) && lastUserText(messages).includes(ASK_THE_FOLDER)) {
			sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: `toolu_${Date.now()}`, name: "ask_for_folder", input: {} } });
			sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: JSON.stringify({ access: "read", reason: "The sales figures are in Finance." }) } });
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "tool_use", stop_sequence: null }, usage: { output_tokens: 20 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			return;
		}
		sse(res, "content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } });
		endpointState.open += 1;
		let index = 0;
		const holdUntil = Date.now() + 120_000;
		const timer = setInterval(() => {
			if (index < 3) {
				sse(res, "content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Word ${index + 1} of the answer. ` } });
				index += 1;
				return;
			}
			if (Date.now() < holdUntil) return;
			clearInterval(timer);
			sse(res, "content_block_stop", { type: "content_block_stop", index: 0 });
			sse(res, "message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 40 } });
			sse(res, "message_stop", { type: "message_stop" });
			res.end();
			endpointState.open -= 1;
		}, 100);
		res.on("close", () => {
			if (!res.writableEnded) endpointState.open -= 1;
			clearInterval(timer);
		});
	});
});

let server: ChildProcessWithoutNullStreams | undefined;
const failures: string[] = [];
const expect = (condition: unknown, message: string) => {
	if (!condition) failures.push(message);
	console.log(`${condition ? "  ok  " : "FAIL  "}${message}`);
};

const putJson = (url: string, body: unknown) => authedFetch(`${baseUrl}${url}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

const site = (id: string, lasting = true) => ({ type: "ui_request", kind: "site", id, title: siteCardQuestion("pypi.org"), host: "pypi.org", port: 443, lasting });
/** The run-outside question's title, as the server asks it. */
const OUTSIDE_TITLE = "Run outside this room?";
const outside = (id: string, command = "git push origin main", reason = "It needs your SSH key.") => ({ type: "ui_request", kind: "outside", id, title: OUTSIDE_TITLE, command, reason });
const folder = (id: string) => ({ type: "ui_request", kind: "folder", id, title: folderAskTitle(true), access: "read", reason: "The sales figures are in Finance.", roomHasFolder: true, canChoose: true });
// Two frames painted: whatever a press set in the page's state has drawn.
// How see-through a button is drawn: the family's disabled look (.rs-btn:disabled) is the only one below 1.
const opacity = (button: { evaluate: (fn: (el: Element) => number) => Promise<number> }) => button.evaluate((el) => Number(getComputedStyle(el).opacity));
const painted = (page: Page) => page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const commands = (id: string) => ({ type: "ui_request", kind: "commands", id, title: COMMANDS_ASK_TITLE, reason: "It needs to run a script.", line: "in-box", anyway: false });
/** "Run this command?" in a room on Ask, as the server asks it: the command whole and the folder it runs in, hidden characters written out. */
const RUN_TITLE = PERSISTENT_ROOM_COMMAND_APPROVAL_TITLE;
const runAsk = (id: string, command = "rm -r build", folder = "/Users/ana/Sales") => ({ type: "ui_request", kind: "run", id, title: RUN_TITLE, command, folder });

/** A connector's form with a field of every kind, as connector-form-stand-in.mjs asks it. */
const TRIP_FORM: ConnectorFormParams = {
	message: "Tell us about the trip.",
	requestedSchema: {
		type: "object",
		properties: {
			name: { type: "string", title: "Your name", minLength: 2 },
			nights: { type: "integer", title: "Nights", minimum: 1, maximum: 14 },
			budget: { type: "number", title: "Budget" },
			email: { type: "string", format: "email", title: "Email" },
			site: { type: "string", format: "uri", title: "Hotel page" },
			start: { type: "string", format: "date", title: "Start date" },
			room: { type: "string", title: "Room", oneOf: [{ const: "single", title: "Single" }, { const: "double", title: "Double" }] },
			extras: { type: "array", title: "Extras", items: { type: "string", enum: ["breakfast", "parking", "late checkout"] }, minItems: 1, maxItems: 2 },
			insured: { type: "boolean", title: "Travel insurance", default: false },
			notes: { type: "string", description: "Anything the hotel should know." },
		},
		required: ["name", "nights", "email", "room", "extras"],
	},
};
const TRIP_LABELS = ["Your name", "Nights", "Budget", "Email", "Hotel page", "Start date", "Room", "Extras", "Travel insurance", "Notes"];
const formAsk = (id: string, params = TRIP_FORM) => ({ type: "ui_request", id, ...connectorFormFrame({ connector: "Toy space", params }) });
const PICK_FORM: ConnectorFormParams = {
	message: "Which room?",
	requestedSchema: {
		type: "object",
		properties: {
			room: { type: "string", title: "Room", oneOf: [{ const: "single", title: "Single" }, { const: "double", title: "Double" }] },
			view: { type: "string", title: "View", enum: ["sea", "garden"] },
			size: { type: "string", title: "Size", enum: ["small", "large"], enumNames: ["Small", "Large"], default: "large" },
		},
		required: ["room"],
	},
};
const WHEN_FORM: ConnectorFormParams = { message: "When do you arrive?", requestedSchema: { type: "object", properties: { when: { type: "string", format: "date-time", title: "Arrival" } }, required: ["when"] } };

/** `phone`: the page as a phone sees it, through a stand-in of its client context. */
async function openRoom(browser: Browser, options: BrowserContextOptions, roomName: string, phone = false) {
	const context = await browser.newContext(options);
	if (phone) await context.route("**/api/remote/client-context", (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify({ remote: true, capability: "full", sharedServer: false }) }));
	const page: Page = await context.newPage();
	let pageSocket: { send(message: string): void } | undefined;
	const socket = { readies: 0, responses: [] as any[], sent: [] as any[] };
	// The cards the smoke hands the page, by id with their kind, and those whose reply the smoke holds back.
	const handed = new Map<string, string>();
	const held = new Set<string>();
	const reply = (id: string, taken: unknown) => pageSocket?.send(JSON.stringify({ type: "ui_request_closed", id, reason: "answered", taken }));
	await page.routeWebSocket(/\/ws\?/, (ws) => {
		pageSocket = ws;
		const upstream = ws.connectToServer();
		ws.onMessage((message) => {
			const frame = JSON.parse(String(message));
			if (frame.type === "ui_response") socket.responses.push(frame);
			socket.sent.push(frame);
			upstream.send(message);
			// The server's reply to an answer to a card the smoke handed over: what it took, as the app says it. A folder window press gets none.
			const kind = frame.type === "ui_response" ? handed.get(frame.id) : undefined;
			// The run-outside question gets none: the page folds it itself.
			if (!kind || kind === "outside" || held.has(frame.id)) return;
			if (kind === "site") reply(frame.id, frame.value === "once" || frame.value === "room" ? frame.value : "decline");
			else if (kind === "commands") reply(frame.id, frame.value === true);
			else if (frame.value === false) reply(frame.id, false);
		});
		upstream.onMessage((message) => {
			if (String(message).includes('"type":"ready"')) socket.readies += 1;
			ws.send(message);
		});
		upstream.onClose((code, reason) => ws.close({ code, reason }));
		ws.onClose(() => upstream.close());
	});
	await page.goto(`${baseUrl}/auth/session?token=${SMOKE_AUTH_TOKEN}`);
	await page.waitForLoadState("networkidle");
	const dismiss = page.locator(".whats-new-close");
	if (await dismiss.count()) await dismiss.click();
	await page.locator(".persistent-agent-card").filter({ hasText: roomName }).getByRole("button", { name: /^(Enter|Resume)$/ }).click();
	await page.locator(".composer-box textarea").waitFor({ timeout: 15000 });
	await waitUntil(() => socket.readies > 0, "the room's connection is ready");
	const composer = page.locator(".composer-box textarea");
	const panel = page.locator(".ask-panel");
	const main = panel.locator(".rs-btn-primary");
	const answer = async (text: string) => {
		await composer.fill(text);
		await sendFromBox(page);
		await page.locator(".composer-box .stop-btn").waitFor({ timeout: 15000 });
		await waitUntil(() => endpointState.open > 0, "the answer is under way");
	};
	const send = (frame: { type: string; id?: string; kind?: string; [field: string]: unknown }) => {
		if (frame.type === "ui_request" && frame.id && frame.kind) handed.set(frame.id, frame.kind);
		pageSocket?.send(JSON.stringify(frame));
	};
	const responses = (id: string) => socket.responses.filter((frame) => frame.id === id);
	const response = (id: string) => socket.responses.find((frame) => frame.id === id);
	// Awake and taking a press: a card whose yes waits for the app's reply is neither.
	const awake = () => panel.locator('.rs-btn-primary[data-awake="1"]:not([aria-disabled="true"])').waitFor();
	const asleep = async () => (await main.getAttribute("data-awake")) === "0";
	return { context, page, composer, panel, main, socket, answer, send, response, responses, awake, asleep, hold: (id: string) => held.add(id), reply };
}

try {
	await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
	const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "models.json"), JSON.stringify({ providers: { [KEY_PROVIDER]: { baseUrl: endpointUrl } } }, null, 2), { mode: 0o600 });
	fs.writeFileSync(path.join(agentDir, "auth.json"), JSON.stringify({ [KEY_PROVIDER]: { type: "api_key", key: "synthetic-anthropic-key" } }, null, 2), { mode: 0o600 });
	const roomFolder = path.join(tempHome, "room-folder");
	fs.mkdirSync(roomFolder, { recursive: true, mode: 0o700 });
	const agents = await import("../src/persistent-agents.js");
	const roomId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Panel Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const savedId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Saved Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// Windows gets a room of its own: the Mac rows leave messages queued in Panel Room, and with one queued the chord is Send now.
	const windowsId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Windows Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// The app's replies get a room of their own, so each answered card's words are the only ones in its steps.
	const replyId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Reply Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A connector's form's answers too.
	agents.createPersistentAgentFromScaffoldInput({ displayName: "Form Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" });
	// The run-outside question gets a room of its own, so each of its lines in the steps is the only one.
	const outsideId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Outside Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// The run-outside question in a browser whose scrollbars take space, as on a computer set to show them always.
	const outsideBarsId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Outside Bars Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// "Run this command?", handed to the page; and asked by the model in a room with protection turned off and in one with it left on.
	const runId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Run Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const askOpenId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Ask Open Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	const askGuardedId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Ask Guarded Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	// A real folder question, asked by the model, for leaving the room and coming back while it waits.
	const returnId = agents.createPersistentAgentFromScaffoldInput({ displayName: "Return Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	server = spawn("npx", ["tsx", "src/index.ts"], {
		shell: process.platform === "win32",
		...SMOKE_SERVER_SPAWN_TREE_OPTIONS,
		cwd: webServerDir,
		env: smokeHomeEnv(tempHome, { PORT: String(port), ...SMOKE_SERVER_AUTH_ENV, EXXETA_HOME: repoRoot, EXXPERTS_CODING_AGENT_DIR: agentDir, EXXETA_PERSISTENT_AGENTS_ROOT: agentsRoot }) as NodeJS.ProcessEnv,
	});
	server.stdout.resume();
	server.stderr.resume();
	await waitUntil(() => fetch(`${baseUrl}/healthz`).then((r) => r.ok).catch(() => false), "server ready", 60_000);
	assert((await putJson("/api/persistent-agent-ai-profiles/custom", { providerId: KEY_PROVIDER, label: "Claude API key", roomModels: [ON_KEY.model], learnModel: ON_KEY.model })).ok, "the key's model is approved");
	for (const id of [roomId, savedId, windowsId, replyId, returnId, outsideId, outsideBarsId, runId, askOpenId, askGuardedId]) assert((await putJson(`/api/persistent-agents/${id}/models`, { conversation: ON_KEY })).ok, "the room picks the key's model");
	for (const id of [roomId, savedId, windowsId, replyId, returnId, outsideId, outsideBarsId, runId]) assert((await putJson(`/api/persistent-agents/${id}/workspace-default`, { root: roomFolder, displayLabel: "Room Folder", workspaceAccessMode: "localFiles", bashEnabled: true })).ok, "the room's folder is set");
	// Each room the model runs commands in has a folder of its own, so what each command left is its own.
	const askFolders = new Map<string, string>();
	for (const [id, name] of [[askOpenId, "open-folder"], [askGuardedId, "guarded-folder"]] as const) {
		const folder = path.join(tempHome, name);
		fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
		askFolders.set(id, folder);
		assert((await putJson(`/api/persistent-agents/${id}/workspace-default`, { root: folder, displayLabel: name, workspaceAccessMode: "localFiles", bashEnabled: true })).ok, `${name} is set`);
	}
	// Turned off as the person does; where this computer has no room box it is off already, and can't be turned off.
	const openProtection = (await (await authedFetch(`${baseUrl}/api/persistent-agents/${askOpenId}/bash-settings`)).json())?.protection;
	if (openProtection?.cause !== "computer") {
		const turnedOff = await putJson(`/api/persistent-agents/${askOpenId}/protection`, { state: "off" });
		assert(turnedOff.ok && (await turnedOff.json())?.protection?.state === "off", "Ask Open Room's protection is turned off, as the person does");
	}
	// Where protection can run, a new room starts on Run without asking, so the guarded room is put on Ask with the protection it shows.
	assert((await putRunWithoutAsking(`${baseUrl}/api/persistent-agents/${askGuardedId}/bash-settings`, false)).ok, "Ask Guarded Room is put on Ask");
	// A question saved in the conversation, as a page leaves it when it goes mid-question.
	const seeded = await putJson(`/api/persistent-agents/${savedId}/threads/c_saved_0001`, { state: "active", origin: "home", items: [
		{ kind: "user", id: "u-saved", text: "Check the prices." },
		{ kind: "approval", id: "q-saved", requestId: "saved-site", uiKind: "site", title: siteCardQuestion("pypi.org"), lasting: true },
	] });
	assert(seeded.ok, `Saved Room's question is seeded (${seeded.status} ${await seeded.clone().text()})`);

	const browser = await chromium.launch();
	try {
		// Where it sits, at both widths and in both themes, with the steps' quiet row beside it.
		for (const [width, height, colorScheme] of [[1280, 900, "light"], [1280, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
			const room = await openRoom(browser, { viewport: { width, height }, userAgent: MAC, colorScheme }, "Panel Room");
			const at = `${width} ${colorScheme}`;
			try {
				room.send(site(`look-${width}-${colorScheme}`));
				await room.panel.waitFor();
				const [panelBox, boxBox] = await Promise.all([room.panel.boundingBox(), room.page.locator(".composer-box").boundingBox()]);
				expect(panelBox && boxBox && panelBox.y + panelBox.height <= boxBox.y && boxBox.y - (panelBox.y + panelBox.height) <= 24 && Math.abs(panelBox.width - boxBox.width) <= 2, `${at}: the panel sits right above the message box, as wide as it (${JSON.stringify([panelBox, boxBox])})`);
				expect(panelBox && panelBox.height <= height / 2, `${at}: the panel takes at most half the window (${panelBox?.height})`);
				const underAnswers = await room.panel.evaluate((panel) => Math.round(panel.getBoundingClientRect().bottom - panel.querySelector(".ask-actions")!.getBoundingClientRect().bottom));
				expect(underAnswers <= 16, `${at}: with one question, the answers end the panel, with only its padding under them (${underAnswers} px)`);
				expect(await room.page.locator(".above-composer-dock > .ask-panel:last-child").count() === 1, `${at}: the panel is the dock's last part, closest to the box`);
				const [panelFill, pageFill] = await Promise.all([room.panel.evaluate((element) => getComputedStyle(element).backgroundColor), room.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--panel").trim())]);
				expect(panelFill !== "rgba(0, 0, 0, 0)" && pageFill !== "", `${at}: the panel stands on the app's raised surface (${panelFill})`);
				const row = room.page.locator('.wk-row[data-s="waiting"]');
				expect(await row.count() === 1 && await row.locator("button").count() === 0 && (await row.innerText()).includes(siteCardQuestion("pypi.org")), `${at}: the steps keep one quiet row for it, with no answers`);
				expect(await room.page.locator(".wk-card.waiting").count() === 0 && await room.page.locator(".wk-ask").count() === 0, `${at}: no amber card or amber head in the steps`);
				if (width === 390) {
					const stacked = await room.panel.locator(".rs-btn").evaluateAll((buttons) => buttons.map((button) => ({ text: (button as HTMLElement).innerText, top: button.getBoundingClientRect().top, width: button.getBoundingClientRect().width })));
					const order = [...stacked].sort((a, b) => a.top - b.top).map((button) => button.text);
					expect(JSON.stringify(order) === JSON.stringify([SITE_ALLOW_ONCE, "Allow for this room", NOT_NOW]) && stacked.every((button) => Math.abs(button.width - stacked[0].width) <= 1), `${at}: the answers stack full width, the main one on top and Not now at the bottom (${JSON.stringify(stacked)})`);
				}
			} finally {
				await room.context.close();
			}
		}

		// A connector's tool: three answers where Always allow is offered, two where it isn't, with what the room would send.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Panel Room");
			try {
				const title = connectorApprovalTitle("Delete project", "Asana");
				for (const lasting of [true, false]) {
					const id = `connector-${lasting}`;
					room.send({ type: "ui_request", kind: "connector", id, title, connector: "Asana", sent: `{"project":"Q3"}`, cut: 0, lasting });
					await room.panel.locator(".ask-actions").waitFor();
					const counts = await Promise.all([SITE_ALLOW_ONCE, CONNECTOR_CHOICE_WORDS.allow, NOT_NOW].map((name) => room.panel.getByRole("button", { name }).count()));
					const words = await room.panel.innerText();
					expect(JSON.stringify(counts) === JSON.stringify([1, lasting ? 1 : 0, 1]) && await room.panel.locator(".ask-actions .rs-btn").count() === (lasting ? 3 : 2), `connector, lasting ${lasting}: ${lasting ? "three" : "two"} answers (${JSON.stringify(counts)})`);
					expect(words.includes(connectorRiskLine("Asana")) && words.includes(`{"project":"Q3"}`) && words.includes("Always allow lets Delete project run without asking in every room where Asana is on, also when you're away.") === lasting, `connector, lasting ${lasting}: what it may do, what it would send, and what Always allow gives only where offered (${words})`);
					room.send({ type: "ui_request_closed", id, reason: "unanswered" });
					await room.panel.waitFor({ state: "detached" });
				}
				// The first line goes by the connector's own marks: none for a read-only tool, the softer one for a tool marked as
				// not destructive, today's for one with no marks.
				for (const [label, marks, lead] of [["read-only", { readOnly: true }, null], ["not destructive", { destructive: false }, connectorChangeLine("Asana")], ["no marks", {}, connectorRiskLine("Asana")]] as const) {
					const id = `connector-marks-${label}`;
					// The frame as the server builds it from the gate's card.
					room.send({ type: "ui_request", id, ...connectorAskFrame({ title, connector: "Asana", sent: `{"project":"Q3"}`, cut: 0, lasting: false, ...marks }) });
					await room.panel.locator(".ask-actions").waitFor();
					const words = await room.panel.innerText();
					const others = [connectorRiskLine("Asana"), connectorChangeLine("Asana")].filter((line) => line !== lead);
					expect((lead === null || words.includes(lead)) && others.every((line) => !words.includes(line)), `connector, ${label}: ${lead ?? "no line"} on what it may do (${words})`);
					room.send({ type: "ui_request_closed", id, reason: "unanswered" });
					await room.panel.waitFor({ state: "detached" });
				}
				// What the room would send, up to 20,000 characters, shows whole in its scroll box, with the answers in view.
				for (const [width, height] of [[1280, 900], [390, 844]] as const) {
					await room.page.setViewportSize({ width, height });
					const id = `connector-long-${width}`;
					const sent = JSON.stringify({ text: "x".repeat(19_989) });
					room.send({ type: "ui_request", kind: "connector", id, title, connector: "Asana", sent, cut: 0, lasting: false });
					await room.panel.locator(".ask-actions").waitFor();
					const shown = await room.panel.evaluate((panel) => {
						const code = panel.querySelector(".ask-facts code") as HTMLElement;
						const words = panel.querySelector(".ask-panel-in") as HTMLElement;
						const allow = panel.querySelector(".ask-actions .rs-btn") as HTMLElement;
						const box = allow.getBoundingClientRect();
						return { length: code.textContent?.length ?? 0, scrolls: words.scrollHeight > words.clientHeight || code.scrollHeight > code.clientHeight, answersInView: box.top >= 0 && box.bottom <= window.innerHeight, panelHeight: panel.getBoundingClientRect().height };
					});
					expect(sent.length === 20_000 && shown.length === 20_000 && shown.scrolls && shown.answersInView && shown.panelHeight <= height / 2 + 1, `connector at ${width}: 20,000 characters whole, in a box that scrolls, the answers in view (${JSON.stringify(shown)})`);
					room.send({ type: "ui_request_closed", id, reason: "unanswered" });
					await room.panel.waitFor({ state: "detached" });
				}
			} finally {
				await room.context.close();
			}
		}

		// A connector's form: one card in the question's place, at both widths and in both themes, with nothing to scroll sideways.
		for (const [width, height, colorScheme] of [[1280, 900, "light"], [1280, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
			const room = await openRoom(browser, { viewport: { width, height }, userAgent: MAC, colorScheme }, "Panel Room");
			const at = `form ${width} ${colorScheme}`;
			try {
				room.send(formAsk(`form-look-${width}-${colorScheme}`));
				await room.panel.locator(".ask-form").waitFor();
				const words = await room.panel.innerText();
				expect([connectorFormTitle("Toy space"), connectorFormFrom("Toy space"), "Tell us about the trip.", connectorFormGoesTo("Toy space")].every((line) => words.includes(line)), `${at}: the title, the connector's message under From, and where the details go (${words})`);
				const fields = await room.panel.locator(".ask-form-field").evaluateAll((all) => all.map((field) => ({ name: field.querySelector(".ask-form-name")?.firstChild?.textContent ?? "", required: !!field.querySelector(".ask-form-required"), controls: field.querySelectorAll("input, select").length })));
				expect(JSON.stringify(fields.map((field) => field.name)) === JSON.stringify(TRIP_LABELS) && fields.every((field) => field.controls > 0), `${at}: one card with each field under its own label (${JSON.stringify(fields)})`);
				expect(fields.filter((field) => field.required).map((field) => field.name).join(",") === "Your name,Nights,Email,Room,Extras" && (await room.panel.locator(".ask-form-required").first().innerText()) === FORM_REQUIRED, `${at}: Required beside each field the form needs`);
				const answers = await room.panel.locator(".ask-actions .rs-btn").evaluateAll((buttons) => buttons.map((button) => (button as HTMLElement).innerText.split("\n")[0]));
				expect(answers.length === 2 && answers.includes(NOT_NOW) && answers.includes(FORM_SEND), `${at}: Send and Not now, and no other answer (${JSON.stringify(answers)})`);
				const sideways = await room.page.evaluate(() => ({ page: document.documentElement.scrollWidth - window.innerWidth, panel: (() => { const panel = document.querySelector(".ask-panel") as HTMLElement; return panel.scrollWidth - panel.clientWidth; })() }));
				expect(sideways.page <= 0 && sideways.panel <= 0, `${at}: nothing scrolls sideways (${JSON.stringify(sideways)})`);
				const panelBox = await room.panel.boundingBox();
				expect(panelBox && panelBox.height <= height / 2 + 1, `${at}: the card takes at most half the window, its fields scrolling (${panelBox?.height})`);
				const row = room.page.locator('.wk-row[data-s="waiting"]');
				expect(await row.count() === 1 && (await row.innerText()).includes(connectorFormTitle("Toy space")), `${at}: the steps keep one quiet row for it`);
			} finally {
				await room.context.close();
			}
		}

		// A connector's form by keyboard and by its answers: Tab through the fields, Enter and Escape send nothing, Send carries
		// what the person gave, the server's lines show under their fields, and each end leaves its row in the steps.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Form Room");
			const { page, panel } = room;
			try {
				room.send(formAsk("form-keys"));
				await panel.locator(".ask-form").waitFor();
				const name = panel.locator("#form-field-name");
				await name.click();
				await page.keyboard.type("Ada");
				await page.keyboard.press("Enter");
				await page.keyboard.press("Escape");
				await page.waitForTimeout(400);
				expect(room.responses("form-keys").length === 0 && await panel.count() === 1 && await name.inputValue() === "Ada", "form: Enter in a field and Escape send nothing, and what was typed stays");
				const order: string[] = [];
				// A date field takes a Tab for each of its parts.
				for (let step = 0; step < 24; step++) {
					order.push(await page.evaluate(() => {
						const focused = document.activeElement as HTMLElement | null;
						const field = focused?.closest(".ask-form-field");
						return field ? field.querySelector(".ask-form-name")?.firstChild?.textContent ?? "" : focused?.innerText?.split("\n")[0] ?? "";
					}));
					await page.keyboard.press("Tab");
				}
				const reached = order.filter((label, index) => label !== order[index - 1]);
				expect(JSON.stringify(reached.slice(0, TRIP_LABELS.length)) === JSON.stringify(TRIP_LABELS) && reached.includes(FORM_SEND), `form: Tab goes through every field in order, then the answers (${JSON.stringify(reached)})`);
				await panel.locator("#form-field-nights").fill("3");
				await panel.locator("#form-field-email").fill("ada@");
				await panel.locator("#form-field-room").selectOption("double");
				await panel.getByLabel("breakfast").check();
				await panel.getByLabel("Travel insurance").check();
				await room.awake();
				await room.main.click();
				await waitUntil(() => room.responses("form-keys").length === 1, "form: Send was sent");
				expect(JSON.stringify(room.response("form-keys")?.value) === JSON.stringify({ values: { name: "Ada", nights: "3", email: "ada@", room: "double", extras: ["breakfast"], insured: true } }), `form: Send carries what was typed, ticked and picked, and leaves out what is empty (${JSON.stringify(room.response("form-keys")?.value)})`);
				room.send({ type: "ui_request_update", id: "form-keys", fieldLines: { email: FORM_FIELD_LINES.email } });
				await panel.locator(".ask-form-line").waitFor();
				const lineUnder = await panel.locator('.ask-form-field[data-wrong="1"]').evaluateAll((all) => all.map((field) => `${field.querySelector(".ask-form-name")?.firstChild?.textContent}: ${field.querySelector(".ask-form-line")?.textContent}`));
				expect(JSON.stringify(lineUnder) === JSON.stringify([`Email: ${FORM_FIELD_LINES.email}`]) && await panel.locator("#form-field-email").inputValue() === "ada@" && await name.inputValue() === "Ada", `form: the server's line shows under its field, and what was typed stays (${JSON.stringify(lineUnder)})`);
				expect(await page.evaluate(() => document.activeElement?.id) === "form-field-email", "form: with the lines, the focus goes to the first field that doesn't fit");
				room.reply("form-keys", "sent");
				await panel.waitFor({ state: "detached" });
				await page.getByText(`${FORM_SENT} · ${connectorFormTitle("Toy space")}`).first().waitFor();
				expect(true, "form: a form sent leaves its row: Sent");

				room.send(formAsk("form-no"));
				await panel.locator(".ask-form").waitFor();
				await page.waitForTimeout(1_100);
				await panel.getByRole("button", { name: NOT_NOW }).click();
				await waitUntil(() => room.responses("form-no").length === 1, "form: Not now was sent");
				expect(room.response("form-no")?.value === "decline", `form: Not now declines (${JSON.stringify(room.response("form-no")?.value)})`);
				room.reply("form-no", "decline");
				await panel.waitFor({ state: "detached" });

				room.send(formAsk("form-gave-up"));
				await panel.locator(".ask-form").waitFor();
				room.send({ type: "ui_request_closed", id: "form-gave-up", reason: "withdrawn" });
				await panel.waitFor({ state: "detached" });
				// Its card now holds three settled questions, so it folds: opened, its last row says so.
				const head = page.locator('.wk-head[aria-expanded="false"]').last();
				await head.click();
				await page.locator(".wk-row").filter({ hasText: connectorFormGaveUpLine("Toy space") }).last().waitFor();
				expect(true, "form: one the connector stopped waiting for says so in the steps");

				// A date and time is picked, and Send writes it as the adapter's own check takes it.
				room.send(formAsk("form-when", WHEN_FORM));
				await panel.locator("#form-field-when").fill("2026-12-01T10:30");
				await room.awake();
				await room.main.click();
				await waitUntil(() => room.responses("form-when").length === 1, "form: the date and time was sent");
				const when = (room.response("form-when")?.value as { values?: Record<string, unknown> } | undefined)?.values?.when;
				const { coerceAndValidateFormValues } = await import("pi-mcp-adapter/elicitation-handler.ts" as string);
				let fits = true;
				try { coerceAndValidateFormValues(WHEN_FORM, { when }); } catch { fits = false; }
				expect(typeof when === "string" && /^2026-12-01T10:30:00[+-]\d\d:\d\d$/.test(when) && fits, `form: a date and time is picked, and goes with its seconds and time zone, as the adapter's check takes it (${JSON.stringify(when)})`);
				room.reply("form-when", "sent");
				await panel.waitFor({ state: "detached" });

				// The connector's own date and time, left as it is: the picker shows it, and Send carries that same moment.
				const given = "2026-12-01T09:30:00Z";
				room.send(formAsk("form-when-given", { ...WHEN_FORM, requestedSchema: { ...WHEN_FORM.requestedSchema, properties: { when: { ...WHEN_FORM.requestedSchema.properties.when, default: given } } } }));
				const picker = panel.locator("#form-field-when");
				await picker.waitFor();
				const shown = await picker.inputValue();
				await room.awake();
				await room.main.click();
				await waitUntil(() => room.responses("form-when-given").length === 1, "form: the connector's date and time was sent");
				const kept = (room.response("form-when-given")?.value as { values?: Record<string, unknown> } | undefined)?.values?.when;
				expect(shown !== "" && typeof kept === "string" && Date.parse(kept) === Date.parse(given), `form: the connector's own date and time shows in the picker, and Send carries that same moment (${JSON.stringify(shown)} → ${JSON.stringify(kept)})`);
				room.reply("form-when-given", "sent");
				await panel.waitFor({ state: "detached" });

				// A list with nothing picked says so, and its prompt never goes: the server's own check then gives a required one its line.
				room.send(formAsk("form-pick", PICK_FORM));
				const pickedText = (name: string) => panel.locator(`#form-field-${name}`).evaluate((select: HTMLSelectElement) => select.selectedOptions[0]?.textContent ?? "");
				await panel.locator("#form-field-room").waitFor();
				const untouched = [await pickedText("room"), await pickedText("view"), await pickedText("size")];
				expect(JSON.stringify(untouched) === JSON.stringify([FORM_PICK_PROMPT, FORM_PICK_PROMPT, "Large"]), `form: a list with nothing picked shows "${FORM_PICK_PROMPT}", and one with the connector's own choice shows that (${JSON.stringify(untouched)})`);
				await room.awake();
				await room.main.click();
				await waitUntil(() => room.responses("form-pick").length === 1, "form: Send with nothing picked was sent to the server");
				const leftEmpty = readConnectorFormValues(PICK_FORM, room.response("form-pick")?.value);
				const checkedEmpty = leftEmpty && checkConnectorForm(PICK_FORM, leftEmpty, coerceAndValidateFormValues);
				expect(leftEmpty && JSON.stringify(Object.keys(leftEmpty).sort()) === JSON.stringify(["size"]) && checkedEmpty && "lines" in checkedEmpty && JSON.stringify(checkedEmpty.lines) === JSON.stringify({ room: FORM_FIELD_LINES.pickOne }), `form: the prompt goes as no value, and the server's check gives the required list its line and sends nothing (${JSON.stringify(room.response("form-pick")?.value)} → ${JSON.stringify(checkedEmpty)})`);
				room.send({ type: "ui_request_update", id: "form-pick", fieldLines: checkedEmpty && "lines" in checkedEmpty ? checkedEmpty.lines : {} });
				await panel.locator('.ask-form-field[data-wrong="1"] .ask-form-line').waitFor();
				expect(await panel.locator('.ask-form-field[data-wrong="1"]').evaluateAll((all) => all.map((field) => `${field.querySelector(".ask-form-name")?.firstChild?.textContent}: ${field.querySelector(".ask-form-line")?.textContent}`).join("|")) === `Room: ${FORM_FIELD_LINES.pickOne}`, "form: the line shows under the list left on its prompt");
				await panel.locator("#form-field-room").selectOption("double");
				expect(await panel.locator('.ask-form-field[data-wrong="1"]').count() === 0 && await panel.locator(".ask-form-line").count() === 0, "form: a field the person changes drops its line and its mark until the next Send checks it");
				await room.awake();
				await room.main.click();
				await waitUntil(() => room.responses("form-pick").length === 2, "form: Send with a room picked was sent");
				const picked = readConnectorFormValues(PICK_FORM, room.responses("form-pick")[1]?.value);
				const checkedPicked = picked && checkConnectorForm(PICK_FORM, picked, coerceAndValidateFormValues);
				expect(checkedPicked && "content" in checkedPicked && JSON.stringify(checkedPicked.content) === JSON.stringify({ room: "double", size: "large" }), `form: an optional list left on its prompt goes with no value (${JSON.stringify(checkedPicked)})`);
				room.reply("form-pick", "sent");
				await panel.waitFor({ state: "detached" });
			} finally {
				await room.context.close();
			}
		}

		// The Mac's keys, the pause, and several questions, while an answer runs.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Panel Room");
			const { page, composer, panel, main, send, response, awake, asleep } = room;
			await room.answer("A slow answer, please.");
			try {
				await composer.focus();
				send(site("pause"));
				await main.waitFor();
				expect(!(await page.evaluate(() => !!document.activeElement?.closest(".ask-panel"))), "focus: the panel takes no focus when it appears");
				expect(await page.getByRole("region", { name: ASK_PANEL_NAME }).count() === 1, "a screen reader finds the panel as a named region");
				await page.locator('[aria-live="polite"]').filter({ hasText: `${roomNeedsAnswer("Panel Room")}: ${siteCardQuestion("pypi.org")}` }).waitFor();
				expect(true, "a new question is said politely, in the notification's words");
				expect(await composer.getAttribute("placeholder") === SENDING_COUNTS_AS_NOT_NOW, `the box says sending counts as Not now (${await composer.getAttribute("placeholder")})`);
				// The checks above take time: the window coming to the front starts the pause again, so the presses below land inside it.
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				// The look once the family's hover transition has run out, so a rested button is compared with a rested one.
				const look = () => main.evaluate(async (button) => {
					while (button.getAnimations().length > 0) await new Promise((resolve) => requestAnimationFrame(resolve));
					return `${getComputedStyle(button).backgroundColor} ${getComputedStyle(button).opacity} ${Math.round(button.getBoundingClientRect().width)}`;
				});
				const lastingLeft = () => panel.getByRole("button", { name: "Allow for this room" }).evaluate((button) => Math.round(button.getBoundingClientRect().left));
				const paused = { look: await look(), left: await lastingLeft() };
				const hintDuringPause = await asleep() && await main.locator("kbd").isVisible();
				// A click, then the chord, both inside the pause: the state says so before and after each press.
				let inside = await asleep();
				await main.click({ force: true });
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				inside = inside && await asleep();
				expect(inside && !response("pause"), `pause: a click and the chord during the pause answer nothing (${inside})`);
				await awake();
				// The forced click left the pointer on it: move it off, so hover doesn't count as a change.
				await page.mouse.move(0, 0);
				const woke = { look: await look(), left: await lastingLeft() };
				expect(paused.look === woke.look && paused.left === woke.left, `pause: the main answer looks the same while it waits, and the answers beside it don't move (${JSON.stringify([paused, woke])})`);
				expect(hintDuringPause, "pause: the chord's hint stays on the main answer while it waits");
				await composer.fill("A word");
				const typed = { look: await look(), left: await lastingLeft() };
				const centred = await main.evaluate((button) => {
					// The words a person sees: the visible span that holds neither a hint nor another span.
					const words = [...button.querySelectorAll("span")].find((span) => getComputedStyle(span).visibility === "visible" && !span.querySelector("kbd, span"));
					const b = button.getBoundingClientRect();
					const r = words?.getBoundingClientRect();
					return { hint: [...button.querySelectorAll("kbd")].some((kbd) => getComputedStyle(kbd).visibility === "visible"), off: r ? Math.round((r.left + r.width / 2 - (b.left + b.width / 2)) * 10) / 10 : null };
				});
				expect(!centred.hint && centred.off !== null && Math.abs(centred.off) <= 1, `with words in the box, the main answer shows its words alone, centred in its kept width (${JSON.stringify(centred)})`);
				await composer.fill("");
				expect(typed.look === woke.look && typed.left === woke.left, `the answers don't move when the box fills (${JSON.stringify([woke, typed])})`);
				// The window comes to the front: the pause starts again.
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				inside = await asleep();
				await main.click({ force: true });
				inside = inside && await asleep();
				expect(inside && !response("pause"), "pause: when the window comes to the front, a click waits again");
				await awake();
				await main.click();
				await waitUntil(() => !!response("pause"), "a click after the pause answers");
				expect(response("pause").value === "once", `pause: after it, a click is Allow this time (${response("pause").value})`);
				expect(await page.evaluate(() => !!document.activeElement?.closest(".composer-box")), "focus: after an answer the box has the focus");

				// Several questions: the oldest one shows, with a count; a new one changes only the count.
				send(site("first"));
				await awake();
				send(folder("second"));
				await panel.locator(".ask-more").filter({ hasText: moreQuestionsLine(1) }).waitFor();
				expect((await panel.locator(".ask-title").innerText()) === siteCardQuestion("pypi.org") && !(await asleep()), "several: the first question stays, awake, when a second arrives");
				send(commands("third"));
				await panel.locator(".ask-more").filter({ hasText: moreQuestionsLine(2) }).waitFor();
				expect((await panel.locator(".ask-title").innerText()) === siteCardQuestion("pypi.org"), "several: a third arrival changes only the count");
				// The chord gives the first its Allow this time; the next shows asleep, so a second press lands on nothing.
				expect((await main.innerText()).includes("⌘↵"), "chord: with the box empty and nothing queued, Allow this time shows ⌘↵");
				await page.keyboard.press("Meta+Enter");
				await waitUntil(() => !!response("first"), "the chord answers the first question");
				expect(response("first").value === "once", `chord: Cmd+Enter is Allow this time (${response("first").value})`);
				await panel.filter({ hasText: folderAskTitle(true) }).waitFor();
				inside = await asleep();
				await page.keyboard.press("Meta+Enter");
				inside = inside && await asleep();
				expect(inside && !response("second"), "several: the next question comes paused, so a second chord takes no answer meant for the first");
				expect(await panel.locator(".ask-more").innerText() === moreQuestionsLine(1), "several: the count goes down");
				// Escape in the empty box is the folder question's Not now, not Stop.
				await awake();
				await composer.focus();
				await page.keyboard.press("Escape");
				await waitUntil(() => !!response("second"), "Escape answers the folder question");
				expect(response("second").value === false && await page.locator(".composer-box .stop-btn").count() === 1, `escape: in the empty box it is Not now, and the answer goes on (${response("second").value})`);
				// The commands question: no chord, no Enter, its yes takes a click or Space.
				await panel.filter({ hasText: COMMANDS_ASK_TITLE }).waitFor();
				await awake();
				expect(!(await main.innerText()).includes("⌘↵"), "commands: Turn on commands shows no chord");
				await page.keyboard.press("Meta+Enter");
				await main.focus();
				await page.keyboard.press("Enter");
				expect(!response("third"), "commands: neither the chord nor Enter turns commands on");
				expect(await main.innerText() === TURN_ON_COMMANDS, "commands: the main answer is Turn on commands");
				const lineWeight = (text: string) => panel.getByText(text).evaluate((line) => Number(getComputedStyle(line).fontWeight));
				const protectedWeight = await lineWeight(COMMANDS_ASK_LINES["in-box"]);
				expect(protectedWeight < 600, `commands: in a protected room the line is a standing line (weight ${protectedWeight})`);
				await page.keyboard.press("Space");
				await waitUntil(() => !!response("third"), "Space answers the commands question");
				expect(response("third").value === true, `commands: Space on Turn on commands is the yes (${response("third").value})`);
				// Where commands would reach all of a person's files, the line that says so is not the quietest on the panel.
				send({ ...commands("anyway"), line: "unprotected", anyway: true });
				await panel.getByText(COMMANDS_ASK_LINES.unprotected).waitFor();
				expect(await main.innerText() === TURN_ON_ANYWAY, "commands: an unprotected room's main answer is Turn on anyway");
				const riskWeight = await lineWeight(COMMANDS_ASK_LINES.unprotected);
				expect(riskWeight >= 600 && riskWeight > protectedWeight, `commands: an unprotected room's line reads louder than a protected room's (weight ${riskWeight} against ${protectedWeight})`);
				send({ type: "ui_request_closed", id: "anyway", reason: "unanswered" });
				await panel.filter({ hasText: COMMANDS_ASK_TITLE }).waitFor({ state: "detached" });

				// A double click on a lasting yes or on Not now answers the first question only: the next one comes paused.
				// The second click lands once the next question is drawn, as a person's second click does.
				send(site("double-a"));
				send({ ...site("double-b"), title: siteCardQuestion("files.pythonhosted.org"), host: "files.pythonhosted.org" });
				await awake();
				await panel.getByRole("button", { name: "Allow for this room" }).click();
				await panel.filter({ hasText: siteCardQuestion("files.pythonhosted.org") }).waitFor();
				await panel.getByRole("button", { name: "Allow for this room" }).click({ force: true });
				await waitUntil(() => !!response("double-a"), "the first click answers the first question");
				// Still asked (the second click took nothing): Escape is its answer.
				if (await panel.count()) {
					await awake();
					await composer.focus();
					await page.keyboard.press("Escape");
				}
				await waitUntil(() => !!response("double-b"), "the second question is answered");
				expect(response("double-a").value === "room" && response("double-b").value === "decline", `several: a double click on Allow for this room gives the next question nothing (${response("double-a").value}, ${response("double-b").value})`);
				send(site("double-c"));
				send(site("double-d"));
				await awake();
				await panel.getByRole("button", { name: NOT_NOW }).click();
				await waitUntil(() => !!response("double-c"), "the first click declines the first question");
				await panel.getByRole("button", { name: NOT_NOW }).click({ force: true });
				if (await panel.count()) {
					await awake();
					await composer.focus();
					await page.keyboard.press("Meta+Enter");
				}
				await waitUntil(() => !!response("double-d"), "the second question is answered");
				expect(response("double-c").value === "decline" && response("double-d").value === "once", `several: a double click on Not now gives the next question nothing (${response("double-c").value}, ${response("double-d").value})`);

				// Focus back from one of the page's own frames (a preview) waits out the pause too: the page can't tell it from coming back from another window.
				send(site("frame"));
				await awake();
				await page.evaluate(() => {
					const frame = document.createElement("iframe");
					frame.className = "smoke-frame";
					frame.srcdoc = "<button>inside</button>";
					document.body.append(frame);
				});
				await page.frameLocator(".smoke-frame").getByRole("button").focus();
				await waitUntil(() => page.evaluate(() => document.activeElement?.className === "smoke-frame"), "the focus is in the frame");
				await main.click({ force: true });
				let fromFrame = (await panel.count()) > 0 && await asleep() && !response("frame");
				if (fromFrame) {
					await awake();
					await main.click();
				}
				await waitUntil(() => !!response("frame"), "the frame's question is answered");
				fromFrame = fromFrame && response("frame").value === "once";
				expect(fromFrame, `pause: a click back from a frame on the page waits out the pause, and the next one answers (${response("frame").value})`);
				await page.evaluate(() => document.querySelector(".smoke-frame")?.remove());

				// Plain Enter is never a yes: from the box, from the page, from the focused button. A click is.
				send(site("enter"));
				await awake();
				await composer.focus();
				await page.keyboard.press("Enter");
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await page.keyboard.press("Enter");
				// Still asked (a yes above took it away): the focused button's turn.
				if (await main.count()) {
					await main.focus();
					await page.keyboard.press("Enter");
				}
				expect(!response("enter"), "enter: plain Enter from the box, the page or Allow this time gives no yes");
				// Escape from the page, the box empty: the no.
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await page.keyboard.press("Escape");
				await waitUntil(() => !!response("enter"), "Escape from the page answers");
				expect(response("enter").value === "decline", `escape: from the page it is Not now (${response("enter").value})`);

				// The Esc hint shows while Escape reaches the question; Escape inside the panel is its no.
				send(site("esc"));
				await awake();
				const esc = panel.locator(".ask-esc");
				expect(await esc.isVisible(), "esc hint: with the box empty, Not now shows Esc");
				const noButton = panel.getByRole("button", { name: NOT_NOW });
				const withHint = await noButton.boundingBox();
				await composer.fill("Half a thought");
				expect(!(await esc.isVisible()) && !(await main.innerText()).includes("⌘↵"), "esc hint: with words in the box, neither Esc nor ⌘↵ shows");
				// Without its hint, Not now keeps its box and its words sit in the middle of it, as the main answer's do.
				const words = await noButton.evaluate((button) => {
					const box = button.getBoundingClientRect();
					const walker = document.createTreeWalker(button, NodeFilter.SHOW_TEXT);
					let [left, right] = [Infinity, -Infinity];
					for (let node = walker.nextNode(); node; node = walker.nextNode()) {
						const style = getComputedStyle(node.parentElement!);
						if (!node.textContent?.trim() || style.visibility !== "visible" || style.display === "none") continue;
						const range = document.createRange();
						range.selectNodeContents(node);
						const r = range.getBoundingClientRect();
						[left, right] = [Math.min(left, r.left), Math.max(right, r.right)];
					}
					return { box: [box.x, box.y, box.width, box.height].map(Math.round).join(","), leftGap: Math.round(left - box.left), rightGap: Math.round(box.right - right) };
				});
				const hinted = withHint && [withHint.x, withHint.y, withHint.width, withHint.height].map(Math.round).join(",");
				expect(words.box === hinted && Math.abs(words.leftGap - words.rightGap) <= 1, `esc hint: with words in the box, Not now keeps its box and its words are centred in it (${JSON.stringify({ ...words, hinted })})`);
				await panel.getByRole("button", { name: "Allow for this room" }).focus();
				expect(await esc.isVisible(), "esc hint: with the focus in the panel, Esc shows again");
				await page.keyboard.press("Escape");
				await waitUntil(() => !!response("esc"), "Escape in the panel answers");
				expect(response("esc").value === "decline" && await composer.inputValue() === "Half a thought", `escape: in the panel it is Not now, and the box keeps its words (${response("esc").value})`);

				// Tab: the panel's answers come before the box.
				send(site("tab"));
				await awake();
				await composer.focus();
				await page.keyboard.press("Shift+Tab");
				expect(await page.evaluate(() => !!document.activeElement?.closest(".ask-panel")), "tab: Shift+Tab from the box reaches the panel's answers");
				// Its focus ring is whole: nothing from the scrolling facts paints over it, and the panel doesn't clip it.
				const ring = await page.evaluate(() => {
					const button = document.activeElement as HTMLElement;
					const style = getComputedStyle(button);
					const out = parseFloat(style.outlineWidth) + parseFloat(style.outlineOffset);
					const b = button.getBoundingClientRect();
					const box = { top: b.top - out, bottom: b.bottom + out, left: b.left - out, right: b.right + out };
					const words = document.querySelector(".ask-panel .ask-panel-in")?.getBoundingClientRect();
					const panel = document.querySelector(".ask-panel")!.getBoundingClientRect();
					return { out, clear: !words || words.bottom <= box.top + 0.5, inside: box.top >= panel.top && box.bottom <= panel.bottom && box.left >= panel.left && box.right <= panel.right };
				});
				expect(ring.out > 0 && ring.clear && ring.inside, `tab: the focused answer's ring is whole, clear of the facts above it and inside the panel (${JSON.stringify(ring)})`);

				// A draft started before the question doesn't answer it; one started after does.
				const steers = () => room.socket.sent.filter((frame) => frame.type === "steer");
				const before = steers().length;
				await sendFromBox(page);
				await waitUntil(() => steers().length > before, "the earlier draft is sent");
				expect(steers().at(-1).declines === undefined && await panel.filter({ hasText: siteCardQuestion("pypi.org") }).count() === 1, `sending: a draft started before the question leaves it open (${JSON.stringify(steers().at(-1))})`);
				await composer.fill("A later thought");
				await sendFromBox(page);
				await waitUntil(() => steers().length > before + 1, "the later message is sent");
				expect(steers().at(-1).declines === true, `sending: a message started after the question declines it (${JSON.stringify(steers().at(-1))})`);

				// A refused pick from the folder window starts the pause again.
				// The server closes a question a message declined; this one was handed to the page, so the smoke closes it.
				send({ type: "ui_request_closed", id: "tab", reason: "unanswered" });
				send(folder("window"));
				await panel.filter({ hasText: folderAskTitle(true) }).waitFor();
				await awake();
				send({ type: "ui_request_update", id: "window", line: FOLDER_PICK_REFUSED_IN_PANEL, canChoose: true });
				await panel.getByText(FOLDER_PICK_REFUSED_IN_PANEL).waitFor();
				const [refused, standing] = await Promise.all([panel.getByText(FOLDER_PICK_REFUSED_IN_PANEL).evaluate((line) => Number(getComputedStyle(line).fontWeight)), panel.locator(".ask-line:not(.ask-warning)").first().evaluate((line) => Number(getComputedStyle(line).fontWeight))]);
				expect(refused >= 600 && standing < 600, `a refused pick's line reads louder than the standing line (weight ${refused} against ${standing})`);
				expect(await asleep(), "pause: a refused pick from the folder window starts it again");
				send({ type: "ui_request_closed", id: "window", reason: "unanswered" });

				// With a message queued, the chord sends it now and leaves the question.
				send(site("queued"));
				await awake();
				await composer.fill("Queue this one");
				await sendFromBox(page);
				await page.locator(".queued-messages").waitFor();
				expect(!(await main.innerText()).includes("⌘↵"), "chord: with a message queued, Allow this time shows no ⌘↵");
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await waitUntil(() => room.socket.sent.some((frame) => frame.type === "abort" && frame.forNext === true), "the chord sends the queued message now");
				expect(!response("queued"), "chord: with a message queued it sends that message now, and answers nothing");
			} finally {
				await room.context.close();
			}
		}

		// Not now and Escape wait out the pause only when a question newly appears: never after the window comes to the front,
		// the folder window closes or the same question is sent again. A yes waits each time.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Panel Room");
			const { page, composer, panel, main, send, response, responses, awake } = room;
			try {
				const noButton = panel.getByRole("button", { name: NOT_NOW });
				// Whether the yes still waits, read at once: a question an answer closed has no yes left to read.
				const asleep = async () => (await main.count()) > 0 && (await main.getAttribute("data-awake")) === "0";
				// A real press where the button is: a locator's click would wait for the button to stop reading as disabled.
				const no = async (how: "click" | "Escape") => {
					const box = how === "click" ? await noButton.boundingBox() : null;
					if (box) await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
					else {
						await composer.focus();
						await page.keyboard.press("Escape");
					}
				};
				// A no the pause swallowed sends nothing, so the wait for one is bounded and its end is the finding.
				const answered = (id: string) => waitUntil(() => !!response(id), `${id} is answered`, 2500).then(() => true, () => false);
				const focusBack = () => page.evaluate(() => window.dispatchEvent(new Event("focus")));
				const triggers = [
					{ name: "the window comes to the front", frame: site, fire: async () => focusBack() },
					// The page sees the folder window close as the focus coming back, with the server's line about it.
					{ name: "the folder window closes", frame: folder, fire: async (id: string) => {
						send({ type: "ui_request_update", id, line: FOLDER_CARD_WINDOW_CLOSED, canChoose: true });
						await panel.getByText(FOLDER_CARD_WINDOW_CLOSED).waitFor();
						await focusBack();
					} },
					{ name: "the same question is sent again", frame: site, fire: async (id: string) => send({ ...site(id), again: true }) },
				];
				for (const how of ["click", "Escape"] as const) {
					for (const trigger of triggers) {
						const id = `no-${how}-${triggers.indexOf(trigger)}`;
						const label = `Not now by ${how === "click" ? "a click" : "Escape"}, right after ${trigger.name}`;
						send(trigger.frame(id));
						await awake();
						await trigger.fire(id);
						// Inside the trigger's pause: the yes is still asleep after its press, and the no comes right after.
						let inside = await asleep();
						await main.click({ force: true });
						inside = inside && await asleep();
						await no(how);
						const took = await answered(id);
						const sent = responses(id).map((frame) => frame.value);
						const declined = trigger.frame === folder ? false : "decline";
						expect(inside && took && JSON.stringify(sent) === JSON.stringify([declined]), `${label}: answers at once, while a yes pressed then still waits (${JSON.stringify({ inside, sent })})`);
						if (!took) send({ type: "ui_request_closed", id, reason: "unanswered" });
						await panel.waitFor({ state: "detached" });
					}
					// The next question in an answered one's place: the no waits out its pause, then answers.
					const [first, next] = [`next-${how}-a`, `next-${how}-b`];
					send(site(first));
					send(site(next));
					await awake();
					await no(how);
					await waitUntil(() => !!response(first), "the first question is answered");
					let inside = await asleep();
					await main.click({ force: true });
					await no(how);
					inside = inside && await asleep();
					const tookInside = !!response(next);
					await awake();
					await no(how);
					const took = await answered(next);
					expect(inside && !tookInside && took && JSON.stringify(responses(next).map((frame) => frame.value)) === JSON.stringify(["decline"]), `Not now by ${how === "click" ? "a click" : "Escape"}, as the next question takes an answered one's place: answers nothing within its pause, a yes neither, and answers after it (${JSON.stringify({ inside, tookInside, took })})`);
					await panel.waitFor({ state: "detached" });
				}
			} finally {
				await room.context.close();
			}
		}

		// Windows: Ctrl+Enter, and Send now with words in the box.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: WINDOWS }, "Windows Room");
			const { page, composer, main, send, response, awake } = room;
			await room.answer("A slow answer, please.");
			try {
				send(site("windows-meta"));
				await awake();
				expect((await main.innerText()).includes("Ctrl+Enter"), "windows: Allow this time shows Ctrl+Enter");
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await page.keyboard.press("Escape");
				await waitUntil(() => !!response("windows-meta"), "Escape answers the question");
				expect(response("windows-meta").value === "decline", `windows: the Windows key with Enter answers nothing (${response("windows-meta").value})`);
				send(site("windows"));
				await awake();
				await composer.focus();
				await page.keyboard.press("Control+Enter");
				await waitUntil(() => !!response("windows"), "Ctrl+Enter answers");
				expect(response("windows").value === "once", `windows: Ctrl+Enter is Allow this time (${response("windows").value})`);
				send(site("windows-text"));
				await awake();
				await composer.fill("Send this now");
				await page.keyboard.press("Control+Enter");
				await waitUntil(() => room.socket.sent.some((frame) => frame.type === "steer" && frame.now === true), "Ctrl+Enter sends the words now");
				expect(!response("windows-text"), "windows: with words in the box, Ctrl+Enter is Send now and answers nothing");
				// The same chord with an answer of the panel focused: still the box's Send now. The earlier message lands first: while it is
				// still on its way the box takes no other Send now, from the box or from here.
				await page.locator(".bubble.user:not(.queued)").filter({ hasText: "Send this now" }).waitFor();
				await page.locator(".composer-box .stop-btn").waitFor();
				send(site("windows-focus"));
				await awake();
				await composer.fill("Send from the panel");
				await page.locator(".ask-panel").getByRole("button", { name: "Allow for this room" }).focus();
				await page.keyboard.press("Control+Enter");
				await waitUntil(() => room.socket.sent.some((frame) => frame.type === "steer" && frame.now === true && frame.text === "Send from the panel"), "Ctrl+Enter on a panel answer sends the words now");
				expect(!response("windows-focus"), "windows: with words in the box and a panel answer focused, Ctrl+Enter is Send now and answers nothing");
			} finally {
				await room.context.close();
			}
		}

		// The app's reply: a yes waits for it, a Not now while it is on its way never hides it, a card sent again keeps its place and notifies nobody, and held-down keys answer nothing.
		{
			// The desktop app's notifications, counted with their title and body: the window is in the background, so a new question would notify.
			const counting = async (room: Awaited<ReturnType<typeof openRoom>>) => {
				// As text, so the smoke's own build adds nothing the page lacks.
				await room.page.evaluate(`(() => {
					const shown = [];
					window.__shown = shown;
					window.Notification = Object.assign(function (title, options) { shown.push({ title, body: options && options.body }); }, { permission: "granted" });
					document.documentElement.classList.add("desktop-app");
					document.hasFocus = () => false;
				})()`);
				return () => room.page.evaluate(() => ((window as any).__shown as string[]).length);
			};
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Reply Room");
			const { page, panel, main, send, responses, awake, hold, reply } = room;
			await room.answer("A slow answer, please.");
			try {
				const lasting = panel.getByRole("button", { name: "Allow for this room" });
				// The steps' row for an answered card says what was taken.
				const stepsSay = (words: string) => waitUntil(async () => (await page.locator(".wk-row").allTextContents()).some((row) => row.startsWith(words)), `the steps say ${words}`);
				const notNow = panel.getByRole("button", { name: NOT_NOW });
				// A yes waits: its buttons are off until the reply, and a second press sends nothing.
				hold("wait");
				send(site("wait"));
				await awake();
				const hint = main.locator("kbd.ask-chord");
				expect(await opacity(main) === 1 && await opacity(lasting) === 1 && await hint.isVisible(), "wait: an awake card's yeses look on, the main one with its key hint");
				await main.click();
				await waitUntil(() => responses("wait").length === 1, "the yes is sent");
				await main.click({ force: true });
				const waiting = await panel.count() === 1 && await main.getAttribute("aria-disabled") === "true" && await lasting.getAttribute("aria-disabled") === "true" && await notNow.getAttribute("aria-disabled") === "false";
				expect(waiting && responses("wait").length === 1, `wait: after Allow this time the card stays with its yeses off and Not now on, and a second press sends nothing (${responses("wait").length} sent)`);
				expect(await opacity(main) < 1 && await opacity(lasting) < 1 && !(await hint.isVisible()) && await opacity(notNow) === 1, "wait: while the yes is on its way its yeses look off, with no key hint, and Not now looks as it was");
				reply("wait", "once");
				await panel.waitFor({ state: "detached" });
				await stepsSay(`You chose ${SITE_ALLOW_ONCE}`);
				expect(true, "wait: the reply folds the card, which reads what the app took");
				// The card open again, as a save made before the reply brings it back after a reconnect, and the app's closing frame sent again on attach: it folds again.
				send({ ...site("wait"), again: true });
				await panel.waitFor();
				reply("wait", "once");
				await panel.waitFor({ state: "detached" });
				expect((await page.locator(".wk-row").allTextContents()).filter((row) => row.startsWith(`You chose ${SITE_ALLOW_ONCE}`)).length === 1, "wait: the app's closing frame sent again folds a card brought back open");
				// A folder card whose window is open on the computer, as a device that took the room over gets it: Choosing, its yeses off.
				// The window opened from Choose another folder, beside a folder Allow this time would give.
				send({ ...folder("choosing"), choosing: FOLDER_PANEL_PRESSES.choose, suggested: { name: "Invoices", path: "~/Documents/Invoices", once: true }, again: true });
				await panel.waitFor();
				await waitUntil(async () => await main.getAttribute("data-awake") === "1", "the folder card wakes");
				const windowButton = panel.getByRole("button", { name: CHOOSING });
				expect(await windowButton.getAttribute("aria-disabled") === "true" && await main.getAttribute("aria-disabled") === "true" && await opacity(windowButton) < 1 && await opacity(main) < 1 && await opacity(lasting) < 1 && !(await hint.isVisible()) && await opacity(notNow) === 1, "choosing: while the folder window is open, Choosing, Allow for this room and Allow this time look off and take no press, and Not now looks as it was");
				send({ type: "ui_request_closed", id: "choosing", reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// Not now pressed while a yes is on its way: sent, and the card reads the yes the app took.
				hold("race-site");
				send(site("race-site"));
				await awake();
				await lasting.click();
				await waitUntil(() => responses("race-site").length === 1, "the room yes is sent");
				await notNow.click();
				await waitUntil(() => responses("race-site").length === 2, "the Not now is sent too");
				await painted(page);
				expect(await page.getByText("Not done · you said no").count() === 0, "race: while the site's yes is on its way, a Not now is sent but the card is not labelled a no");
				reply("race-site", "room");
				await stepsSay("You chose Allow for this room");
				expect(responses("race-site")[1].value === "decline" && await page.getByText("Not done · you said no").count() === 0, "race: a Not now pressed while the site's yes was on its way reads as the yes the app took");
				hold("race-commands");
				send(commands("race-commands"));
				await awake();
				await main.click();
				await waitUntil(() => responses("race-commands").length === 1, "the commands yes is sent");
				await notNow.click();
				await waitUntil(() => responses("race-commands").length === 2, "the Not now is sent too");
				await painted(page);
				expect(await page.getByText("Not done · you said no").count() === 0, "race: while the commands yes is on its way, a Not now is sent but the card is not labelled a no");
				reply("race-commands", true);
				await stepsSay(`You chose ${TURN_ON_COMMANDS}`);
				expect(await page.getByText("Not done · you said no").count() === 0, "race: a Not now pressed while the commands yes was on its way reads as the yes the app took");
				// A yes that couldn't be saved: the card stays with its buttons back and the line.
				hold("unsaved");
				send(commands("unsaved"));
				await awake();
				await main.click();
				await waitUntil(() => responses("unsaved").length === 1, "the commands yes is sent");
				send({ type: "ui_request_update", id: "unsaved", failure: CHANGE_SAVE_FAILED });
				await panel.getByText(CHANGE_SAVE_FAILED).waitFor();
				expect(await room.asleep() && await panel.getByText(COMMANDS_ASK_LINES["in-box"]).count() === 1, "unsaved: the card keeps its line about commands, shows the failure, and its pause starts again");
				await awake();
				expect(await main.getAttribute("aria-disabled") === "false", "unsaved: its yes takes a press again");
				await notNow.click();
				reply("unsaved", false);
				await panel.waitFor({ state: "detached" });
				hold("unsaved-site");
				send(site("unsaved-site"));
				await awake();
				await lasting.click();
				await waitUntil(() => responses("unsaved-site").length === 1, "the site's room yes is sent");
				send({ type: "ui_request_update", id: "unsaved-site", failure: CHANGE_SAVE_FAILED });
				await panel.getByText(CHANGE_SAVE_FAILED).waitFor();
				await awake();
				expect(await lasting.getAttribute("aria-disabled") === "false", "unsaved: a site card's room yes that couldn't be saved shows the failure and takes a press again");
				await notNow.click();
				reply("unsaved-site", "decline");
				await panel.waitFor({ state: "detached" });
				// A yes the app asks again, as it does one sooner than its floor: the card wakes after its pause and the yes takes a press again.
				hold("too-soon");
				send(site("too-soon"));
				await awake();
				await main.click();
				await waitUntil(() => responses("too-soon").length === 1, "the early yes is sent");
				send({ ...site("too-soon"), again: true });
				await awake();
				await main.click();
				await waitUntil(() => responses("too-soon").length === 2, "the yes after the card came back is sent");
				reply("too-soon", "once");
				await panel.waitFor({ state: "detached" });
				expect(true, "again: a yes asked again takes a press again once the card wakes");
				// A card sent again: in place, its pause again, and nobody notified; a new card notifies once.
				const notified = await counting(room);
				send(site("again-a"));
				await awake();
				send({ ...site("again-b"), title: siteCardQuestion("files.pythonhosted.org"), host: "files.pythonhosted.org" });
				await panel.locator(".ask-more").waitFor();
				await waitUntil(async () => (await notified()) === 2, "each new card notifies");
				send({ ...site("again-a"), again: true });
				await waitUntil(async () => await room.asleep(), "the card sent again pauses");
				expect((await panel.locator(".ask-title").innerText()) === siteCardQuestion("pypi.org") && await notified() === 2, `again: a card sent again keeps its place, starts its pause again and notifies nobody (${await notified()})`);
				// Held-down keys: their repeats answer nothing, from the box, the page or the panel's own buttons.
				await awake();
				await room.composer.focus();
				const repeat = (key: string, meta: boolean) => page.evaluate(([key, meta]) => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: key as string, metaKey: meta as boolean, repeat: true, bubbles: true, cancelable: true })), [key, meta] as const);
				await repeat("Enter", true);
				await repeat("Escape", false);
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await repeat("Enter", true);
				await repeat("Escape", false);
				await lasting.focus();
				await repeat("Enter", true);
				await repeat("Escape", false);
				expect(responses("again-a").length === 0 && await panel.count() === 1, `keys: a held-down chord or Escape answers nothing (${JSON.stringify(responses("again-a"))})`);
				await room.composer.focus();
				await page.keyboard.press("Escape");
				await waitUntil(() => responses("again-a").length === 1, "a fresh Escape answers");
				expect(responses("again-a")[0].value === "decline", "keys: a fresh Escape is still the no");
			} finally {
				await room.context.close();
			}
			// A fresh window that never saw the card: one sent again notifies nobody there either.
			const fresh = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Reply Room");
			try {
				const notified = await counting(fresh);
				fresh.send({ ...site("again-fresh"), again: true });
				await fresh.panel.waitFor();
				expect(await notified() === 0, "again: in a fresh window a card sent again notifies nobody");
				// A folder card that shows a folder notifies with the card's fixed title: never the folder's name or path, nor the room's reason.
				fresh.send({ ...folder("notify-folder"), suggested: { name: "Quarterly Secret", path: "~/Documents/Quarterly Secret", once: true } });
				await waitUntil(async () => (await notified()) === 1, "the folder card notifies");
				const [note] = await fresh.page.evaluate(() => (window as any).__shown as Array<{ title: string; body?: string }>);
				const said = JSON.stringify(note);
				expect(note.body === folderAskTitle(true) && !said.includes("Quarterly") && !said.includes("Finance"), `notification: a folder card that shows a folder says only its fixed title (${said})`);
			} finally {
				await fresh.context.close();
			}
		}

		// A phone with its keyboard up: the panel keeps to half of what shows, above the box. The question's line and the answers hold
		// their place and only the facts between them scroll, with a fade at each end that hides words.
		const keyboardUp = async (room: Awaited<ReturnType<typeof openRoom>>) => {
			await room.composer.focus();
			// The lift phone-viewport.ts sets while the on-screen keyboard covers the bottom 300px.
			await room.page.evaluate(() => document.documentElement.style.setProperty("--phone-keyboard-lift", "300px"));
			await room.page.waitForFunction(() => {
				const box = document.querySelector(".composer-box")?.getBoundingClientRect();
				return !!box && box.bottom <= window.innerHeight - 299;
			});
			// As phone-viewport.ts does with the lift: the conversation follows its latest line.
			await room.page.evaluate(() => { const messages = document.querySelector(".messages"); if (messages) messages.scrollTop = messages.scrollHeight; });
		};
		const longReason = "The March invoices are in the Finance folder, with the credit notes, the paid and unpaid lists, and the notes from the auditors on each supplier.";
		const shapes: { name: string; frames: { type: string; id?: string; [field: string]: unknown }[] }[] = [
			{ name: "folder", frames: [{ ...folder("shape-folder"), reason: longReason }] },
			{ name: "page", frames: [{ type: "ui_request", kind: "site", id: "shape-page", title: siteCardQuestion("figures.example.com"), host: "figures.example.com", port: 443, address: `https://figures.example.com/${"march-figures/".repeat(30)}`, lasting: true }] },
			{ name: "commands", frames: [{ ...commands("shape-commands"), reason: longReason, line: "unprotected", anyway: true }] },
			{ name: "two waiting", frames: [{ ...folder("shape-two-a"), reason: longReason }, site("shape-two-b")] },
		];
		{
			const room = await openRoom(browser, { viewport: { width: 390, height: 844 }, userAgent: MAC, hasTouch: true, isMobile: true }, "Panel Room");
			try {
				await keyboardUp(room);
				for (const shape of shapes) {
					for (const frame of shape.frames) room.send(frame);
					await room.panel.locator(".ask-panel-in").waitFor();
					const [panelBox, boxBox] = await Promise.all([room.panel.boundingBox(), room.page.locator(".composer-box").boundingBox()]);
					expect(!!panelBox && !!boxBox && panelBox.y >= 0 && panelBox.height <= (844 - 300) / 2 + 1 && panelBox.y + panelBox.height <= boxBox.y, `keyboard, ${shape.name}: the panel keeps to half of what shows, above the box (${JSON.stringify([panelBox, boxBox])})`);
					for (const at of ["start", "middle", "end"] as const) {
						const seen = await room.panel.evaluate((panel, at) => {
							const words = panel.querySelector(".ask-panel-in") as HTMLElement;
							const reach = words.scrollHeight - words.clientHeight;
							words.scrollTop = at === "start" ? 0 : at === "middle" ? Math.round(reach / 2) : reach;
							const box = panel.getBoundingClientRect();
							const content = panel.querySelector(".ask-words")!.getBoundingClientRect();
							const [topFade, bottomFade] = ["top", "bottom"].map((end) => panel.querySelector(`.ask-fade[data-end="${end}"]`)!.getBoundingClientRect());
							const whole = [panel.querySelector(".ask-title")!, ...panel.querySelectorAll(".ask-actions .rs-btn")].map((element) => element.getBoundingClientRect()).map((r) => r.height > 0 && r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5);
							// A fade hides words when it stands over the words' own box rather than in its slot beside it.
							return {
								reach,
								outerStill: panel.scrollTop === 0 && panel.scrollHeight <= panel.clientHeight + 1,
								titleWhole: whole[0],
								answersWhole: whole.slice(1).every(Boolean) && whole.length > 2,
								moreAbove: words.scrollTop > 0.5,
								moreBelow: words.scrollTop < reach - 0.5,
								topFade: topFade.bottom > content.top + 0.5,
								// Scrolling stops on whole pixels and the words' height need not be whole: at the end, under a pixel of them can stay under the fade.
								bottomFade: bottomFade.top < content.bottom - 1,
							};
						}, at);
						expect(seen.reach > 20 && seen.outerStill && seen.titleWhole && seen.answersWhole, `keyboard, ${shape.name}, ${at}: the question's line and every answer are whole and in the panel, only the facts scroll (${JSON.stringify(seen)})`);
						expect(seen.topFade === seen.moreAbove && seen.bottomFade === seen.moreBelow && (at !== "start" || seen.moreBelow) && (at !== "end" || seen.moreAbove), `keyboard, ${shape.name}, ${at}: a fade shows exactly at the ends that hide words (${JSON.stringify(seen)})`);
					}
					if (shape.name === "two waiting") {
						// Scrolled to its end and answered: the next question starts from its top.
						await room.awake();
						await room.panel.getByRole("button", { name: NOT_NOW }).click();
						await room.panel.filter({ hasText: siteCardQuestion("pypi.org") }).waitFor();
						const next = await room.panel.evaluate((panel) => ({ words: (panel.querySelector(".ask-panel-in") as HTMLElement | null)?.scrollTop ?? 0, outer: panel.scrollTop }));
						expect(next.words === 0 && next.outer === 0, `keyboard, ${shape.name}: after Not now, the next question starts from its top (${JSON.stringify(next)})`);
					}
					for (const frame of shape.frames) room.send({ type: "ui_request_closed", id: frame.id, reason: "unanswered" });
					await room.panel.waitFor({ state: "detached" });
				}
				// All the words in view: no fade over them.
				room.send(site("shape-short"));
				await room.panel.locator(".ask-panel-in").waitFor();
				const fits = await room.panel.evaluate((panel) => {
					const content = panel.querySelector(".ask-words")!.getBoundingClientRect();
					const [top, bottom] = ["top", "bottom"].map((end) => panel.querySelector(`.ask-fade[data-end="${end}"]`)!.getBoundingClientRect());
					return { top: top.bottom > content.top + 0.5, bottom: bottom.top < content.bottom - 0.5 };
				});
				expect(!fits.top && !fits.bottom, `keyboard: with all the words in view, no fade stands over them (${JSON.stringify(fits)})`);
			} finally {
				await room.context.close();
			}
		}
		// A short phone with its keyboard up: the question's line and the stacked answers alone pass half of what shows, so the
		// whole panel scrolls. It opens at its top with the question's line first, every answer can be reached, and so can the next.
		{
			// The seeded room, so a conversation stands behind the panel.
			const room = await openRoom(browser, { viewport: { width: 390, height: 600 }, userAgent: MAC, hasTouch: true, isMobile: true }, "Saved Room");
			try {
				await room.page.getByText("Not answered").first().waitFor();
				// A question comes while the room answers, as in the app.
				await room.answer("Sum up the March invoices.");
				// The answer has written its words and holds, as a turn does while its step waits on the question.
				await room.page.getByText("Word 3 of the answer.").waitFor();
				await keyboardUp(room);
				room.send({ ...folder("short-a"), reason: longReason });
				room.send(folder("short-b"));
				await room.panel.locator(".ask-more").waitFor();
				const opened = await room.panel.evaluate((panel) => {
					const box = panel.getBoundingClientRect();
					const title = panel.querySelector(".ask-title")!.getBoundingClientRect();
					return { height: Math.round(box.height), scrollTop: panel.scrollTop, titleFirst: title.top >= box.top && title.bottom <= box.bottom };
				});
				expect(opened.height <= 151 && opened.scrollTop === 0 && opened.titleFirst, `keyboard, short phone: the panel keeps to half of what shows and opens at its top, the question's line first (${JSON.stringify(opened)})`);
				// Above the keyboard the room's header, the panel and the box take all the room: the panel stays under the header,
				// and nothing of the conversation shows anywhere above the panel, between it and the box, or under the box,
				// though the conversation keeps its place behind them while the answer is under way.
				const room300 = await room.page.evaluate(() => {
					const frame = document.querySelector(".messages-frame")!.getBoundingClientRect();
					const panel = document.querySelector(".ask-panel")!.getBoundingClientRect();
					const box = document.querySelector(".composer-box")!.getBoundingClientRect();
					const keyboardTop = window.innerHeight - 300;
					const bands = [[frame.top, panel.top], [panel.bottom, box.top], [box.bottom, keyboardTop]];
					const messages = document.querySelector(".messages")!;
					const showing: string[] = [];
					for (const [from, to] of bands) {
						for (let y = Math.ceil(from) + 0.5; y < to; y += 1) {
							for (let x = 1; x < window.innerWidth; x += 4) {
								// Down the stack at this point: the first solid ground covers what lies under it.
								for (const el of document.elementsFromPoint(x, y)) {
									if (el !== messages && messages.contains(el)) { showing.push(`<${el.tagName.toLowerCase()}.${el.classList[0] ?? ""}> at ${Math.round(x)},${Math.round(y)}`); break; }
									const fill = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)?.map(Number);
									if (fill && (fill.length < 4 || fill[3] === 1)) break;
								}
							}
						}
					}
					return { headerBottom: Math.round(frame.top), panelTop: Math.round(panel.top), showing: [...new Set(showing.map((s) => s.split(" at ")[0]))], first: showing[0] ?? null };
				});
				expect(room300.panelTop >= room300.headerBottom && room300.showing.length === 0, `keyboard, short phone: the panel stays under the room's header and no words of the conversation show around the panel and the box (${JSON.stringify(room300)})`);
				const reached: string[] = [];
				const answers = await room.panel.locator(".ask-actions .rs-btn").all();
				for (const button of answers) {
					await button.scrollIntoViewIfNeeded();
					const [b, p] = await Promise.all([button.boundingBox(), room.panel.boundingBox()]);
					if (b && p && b.y >= p.y - 0.5 && b.y + b.height <= p.y + p.height + 0.5) reached.push(await button.innerText());
				}
				expect(answers.length >= 2 && reached.length === answers.length, `keyboard, short phone: every answer can be scrolled to in the panel (${JSON.stringify(reached)})`);
				await room.awake();
				await room.panel.getByRole("button", { name: NOT_NOW }).click();
				await room.panel.locator(".ask-more").waitFor({ state: "detached" });
				const next = await room.panel.evaluate((panel) => {
					const box = panel.getBoundingClientRect();
					const title = panel.querySelector(".ask-title")!.getBoundingClientRect();
					return { scrollTop: panel.scrollTop, titleFirst: title.top >= box.top && title.bottom <= box.bottom };
				});
				expect(next.scrollTop === 0 && next.titleFirst, `keyboard, short phone: after Not now, the next question opens at its top, its line first (${JSON.stringify(next)})`);
				// A site question has two answers: on a short phone with the keyboard up both stay whole in the panel, under its whole question line.
				await room.awake();
				await room.panel.getByRole("button", { name: NOT_NOW }).click();
				await room.panel.waitFor({ state: "detached" });
				room.send({ type: "ui_request", kind: "site", id: "short-site", title: siteCardQuestion("figures.example.com"), host: "figures.example.com", port: 443, address: `https://figures.example.com/${"march-figures/".repeat(6)}`, lasting: false });
				await room.panel.locator(".ask-actions").waitFor();
				await room.composer.focus();
				await room.awake();
				const two = await room.panel.evaluate((panel) => {
					const box = panel.getBoundingClientRect();
					const title = panel.querySelector(".ask-title")!.getBoundingClientRect();
					const answers = [...panel.querySelectorAll(".ask-actions .rs-btn")].map((button) => {
						const r = button.getBoundingClientRect();
						return { name: button.textContent, whole: r.top >= box.top - 0.5 && r.bottom <= box.bottom + 0.5, height: Math.round(r.height) };
					});
					return { answers, titleWhole: title.top >= box.top && title.bottom <= box.bottom, panel: Math.round(box.height), scrolls: panel.scrollHeight > panel.clientHeight + 1 };
				});
				expect(two.answers.length === 2 && two.answers.every((answer) => answer.whole && answer.height >= 44) && two.titleWhole, `keyboard, short phone: a site question's two answers are both whole inside the panel, under its whole question line (${JSON.stringify(two)})`);
				// A long draft grows the box to its cap: the whole box, its buttons included, stays between the header and the keyboard.
				await room.page.locator(".composer textarea").fill(Array.from({ length: 11 }, (_, i) => `Line ${i + 1} of a long draft.`).join("\n"));
				await room.page.waitForFunction(() => document.querySelector<HTMLTextAreaElement>(".composer textarea")!.scrollHeight > 200);
				const drafted = await room.page.evaluate(() => {
					const frame = document.querySelector(".messages-frame")!.getBoundingClientRect();
					const box = document.querySelector(".composer-box")!.getBoundingClientRect();
					return { headerBottom: Math.round(frame.top), boxTop: Math.round(box.top), boxBottom: Math.round(box.bottom), keyboardTop: window.innerHeight - 300 };
				});
				expect(drafted.boxTop >= drafted.headerBottom && drafted.boxBottom <= drafted.keyboardTop, `keyboard, short phone: a long draft keeps the whole box between the room's header and the keyboard (${JSON.stringify(drafted)})`);
			} finally {
				await room.context.close();
			}
		}

		// The folder the server shows: its Folder row, never cut, and its presses, at both widths and in both themes.
		for (const [width, height, colorScheme] of [[1280, 900, "light"], [1280, 900, "dark"], [390, 844, "light"], [390, 844, "dark"]] as const) {
			const room = await openRoom(browser, { viewport: { width, height }, userAgent: MAC, colorScheme }, "Panel Room");
			const { panel, main, send, response, awake } = room;
			const at = `${width} ${colorScheme}`;
			const longName = "Quarterly reports for the Finance team and the board, final versions only";
			const buttonsOf = async () => (await panel.getByRole("button").allInnerTexts()).map((label) => label.replace(/(Esc|⌘↵)$/, "").trim());
			try {
				// One click offered: the row with Choose another folder, then Not now, Allow for this room and Allow this time.
				send({ ...folder(`once-${at}`), suggested: { name: longName, path: `~/Documents/${longName}`, once: true } });
				const row = panel.locator(".ask-fact").first();
				await row.waitFor();
				expect(await row.locator("dt").innerText() === FOLDER_PANE_TITLE && (await row.locator("dd").innerText()).includes(longName) && await row.locator(".ask-path").innerText() === `~/Documents/${longName}`, `${at}: the Folder row shows the folder's name and path (${await row.innerText()})`);
				const cut = await row.locator("dd").evaluate((dd) => ({ over: dd.scrollWidth - dd.clientWidth, lines: Math.round(dd.getBoundingClientRect().height / parseFloat(getComputedStyle(dd).lineHeight || "20")), ellipsis: getComputedStyle(dd).textOverflow }));
				expect(cut.over <= 1 && cut.ellipsis !== "ellipsis" && (width > 400 || cut.lines >= 2), `${at}: a long name and path wrap, never cut (${JSON.stringify(cut)})`);
				// The label stands beside the fact's first line, however many lines the name and path take. Its words are a size smaller than the name's, so their tops may differ by a pixel or two, never by a line.
				const firstTops = await row.evaluate((fact) => [fact.querySelector("dt")!, fact.querySelector("dd")!].map((element) => {
					const range = document.createRange();
					range.selectNodeContents(element);
					return Math.min(...[...range.getClientRects()].map((box) => box.top));
				}));
				expect(Math.abs(firstTops[0] - firstTops[1]) < 4, `${at}: Folder lines up with the first line of a name and path that wrap (${JSON.stringify(firstTops)})`);
				expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth) <= 1, `${at}: the panel never scrolls sideways`);
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([CHOOSE_ANOTHER_FOLDER, NOT_NOW, ALLOW_FOR_ROOM_PICK, ALLOW_THIS_TIME_PICK]), `${at}: with one click, Choose another folder, Not now, Allow for this room and Allow this time (${JSON.stringify(await buttonsOf())})`);
				// A yes gives the folder named here, so the line says this folder, not one to choose.
				expect(await panel.getByText(folderAskLine("read", "named"), { exact: true }).count() === 1 && await panel.getByText(folderAskLine("read"), { exact: true }).count() === 0, `${at}: with one click, the line says this folder`);
				// Choose another folder is quiet: no fill at rest; under the name on a narrow panel its words keep the name's edge, and at the row's end on a wide one its box ends where the answers end (the row scrolls, so nothing hangs past it).
				const link = await row.getByRole("button", { name: CHOOSE_ANOTHER_FOLDER }).evaluate((button) => {
					const box = button.getBoundingClientRect();
					const style = getComputedStyle(button);
					const words = document.createRange();
					words.selectNodeContents(button);
					const text = words.getBoundingClientRect();
					const name = (button.parentElement?.querySelector("dd") as HTMLElement).getBoundingClientRect();
					const actions = (button.closest(".ask-panel")?.querySelector(".ask-actions") as HTMLElement).getBoundingClientRect();
					return { fill: style.backgroundColor, wordsLeft: Math.round(text.left), nameLeft: Math.round(name.left), wordsRight: Math.round(text.right), actionsRight: Math.round(actions.right), boxRight: Math.round(box.right), wordsTop: Math.round(text.top), nameBottom: Math.round(name.bottom), boxHeight: Math.round(box.height) };
				});
				const onEdge = width === 390 ? Math.abs(link.wordsLeft - link.nameLeft) <= 1 : Math.abs(link.boxRight - link.actionsRight) <= 1;
				expect(link.fill === "rgba(0, 0, 0, 0)" && onEdge, `${at}: Choose another folder is quiet, its words on the text edge (${JSON.stringify(link)})`);
				// Under the folder on a narrow panel, its words sit against the path as the row's own action, and it keeps its tap height.
				if (width === 390) expect(link.wordsTop >= link.nameBottom && link.wordsTop - link.nameBottom <= 10 && link.boxHeight >= 40, `${at}: Choose another folder sits under the folder, against the path, keeping its tap height (${JSON.stringify(link)})`);
				await room.page.locator('[aria-live="polite"]').filter({ hasText: `${FOLDER_PANE_TITLE}: ${longName}` }).waitFor();
				expect(true, `${at}: the folder shown is said with its question`);
				// Choose another folder: the press waits for the server, reads Choosing, and every answer but Not now is off.
				await awake();
				await row.getByRole("button", { name: CHOOSE_ANOTHER_FOLDER }).click();
				await waitUntil(() => !!response(`once-${at}`), "Choose another folder reaches the socket");
				expect(response(`once-${at}`).value === FOLDER_PANEL_PRESSES.choose, `${at}: Choose another folder sends its press and no folder (${JSON.stringify(response(`once-${at}`).value)})`);
				await row.getByRole("button", { name: CHOOSING }).waitFor();
				const offs = await panel.getByRole("button").evaluateAll((buttons) => buttons.map((button) => `${(button as HTMLElement).innerText.replace(/(Esc|⌘↵)$/, "").trim()}=${button.getAttribute("aria-disabled")}`));
				expect(offs.filter((entry) => entry.endsWith("=true")).length === 3 && offs.some((entry) => entry.startsWith(`${NOT_NOW}`) && entry.endsWith("=false")), `${at}: while choosing, only Not now answers (${JSON.stringify(offs)})`);
				// The window's pick, held: the row names it, and the answers come back after the pause.
				send({ type: "ui_request_update", id: `once-${at}`, line: null, canChoose: true, choosing: null, suggested: { name: "March invoices", path: "~/Documents/Finance/March invoices", once: true } });
				await panel.locator(".ask-path").filter({ hasText: "~/Documents/Finance/March invoices" }).waitFor();
				// Where name and path don't fit one line, the path starts its own line whole: the name never breaks for it.
				const lines = await row.locator("dd").evaluate((dd) => {
					const path = dd.querySelector(".ask-path") as HTMLElement;
					const range = document.createRange();
					range.selectNodeContents(dd.firstChild as Node);
					return { name: new Set([...range.getClientRects()].map((box) => Math.round(box.top))).size, pathAtStart: Math.abs(path.getClientRects()[0].left - dd.getBoundingClientRect().left) <= 1, pathLines: new Set([...path.getClientRects()].map((box) => Math.round(box.top))).size };
				});
				expect(lines.name === 1 && (width > 400 ? lines.pathLines === 1 : lines.pathAtStart), `${at}: the name stays on one line and the path wraps after it, never inside the name (${JSON.stringify(lines)})`);
				// A name in right-to-left letters can't reorder what stands around it: the name and the path are each isolated.
				const isolated = await row.locator("dd").evaluate((dd) => [".ask-name", ".ask-path"].map((selector) => getComputedStyle(dd.querySelector(selector) as Element).unicodeBidi));
				expect(isolated.every((value) => value === "isolate"), `${at}: the name and the path are each isolated (${JSON.stringify(isolated)})`);
				await awake();
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([CHOOSE_ANOTHER_FOLDER, NOT_NOW, ALLOW_FOR_ROOM_PICK, ALLOW_THIS_TIME_PICK]), `${at}: a held pick offers both Allow buttons (${JSON.stringify(await buttonsOf())})`);
				send({ type: "ui_request_closed", id: `once-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// No one click: Not now and Choose folder, no link, and Choose folder reads Choosing once pressed.
				send({ ...folder(`no-once-${at}`), suggested: { name: "app", path: "~/Projects/app", once: false } });
				await panel.locator(".ask-path").filter({ hasText: "~/Projects/app" }).waitFor();
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([NOT_NOW, CHOOSE_FOLDER]) && (await main.innerText()).trim() === CHOOSE_FOLDER, `${at}: without one click, Not now and Choose folder (${JSON.stringify(await buttonsOf())})`);
				// The yes here opens the window, so the line keeps the folder you choose.
				expect(await panel.getByText(folderAskLine("read"), { exact: true }).count() === 1 && await panel.getByText(folderAskLine("read", "named"), { exact: true }).count() === 0, `${at}: without one click, the line says the folder you choose`);
				await awake();
				await main.click();
				await waitUntil(() => !!response(`no-once-${at}`), "Choose folder reaches the socket");
				await panel.getByRole("button", { name: CHOOSING }).waitFor();
				expect(response(`no-once-${at}`).value === FOLDER_PANEL_PRESSES.choose && await main.getAttribute("aria-disabled") === "true", `${at}: Choose folder reads Choosing and is off while the window is open`);
				send({ type: "ui_request_closed", id: `no-once-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// One click where the folder window can't open: Allow this time needs no window and stays, with the line that says what it gives; Not now beside it.
				for (const access of ["read", "write"] as const) {
					send({ ...folder(`no-window-${access}-${at}`), access, canChoose: false, line: null, suggested: { name: "Invoices", path: "~/Documents/Invoices", once: true } });
					await panel.locator(".ask-path").filter({ hasText: "~/Documents/Invoices" }).waitFor();
					expect(JSON.stringify(await buttonsOf()) === JSON.stringify([NOT_NOW, ALLOW_THIS_TIME_PICK]), `${at}: with one click and no folder window, Not now and Allow this time (${JSON.stringify(await buttonsOf())})`);
					expect(await panel.getByText(folderAskLine(access, "named"), { exact: true }).count() === 1, `${at}: with one click and no folder window, the ${access} line for this folder stays beside Allow this time`);
					send({ type: "ui_request_closed", id: `no-window-${access}-${at}`, reason: "unanswered" });
					await panel.waitFor({ state: "detached" });
				}
				// No folder window and no one click: Not now alone, and no line about a folder to choose.
				send({ ...folder(`no-window-no-once-${at}`), canChoose: false, line: null, suggested: { name: "app", path: "~/Projects/app", once: false } });
				await panel.locator(".ask-path").filter({ hasText: "~/Projects/app" }).waitFor();
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([NOT_NOW]) && await panel.getByText(folderAskLine("read"), { exact: true }).count() === 0 && await panel.getByText(folderAskLine("read", "named"), { exact: true }).count() === 0, `${at}: with no folder window and no one click, Not now alone and no access line (${JSON.stringify(await buttonsOf())})`);
				send({ type: "ui_request_closed", id: `no-window-no-once-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// A file the room named, in a folder with one click: a File row above the Folder row, and the line says the whole folder.
				send({ ...folder(`file-${at}`), suggested: { name: "Scripts", path: "~/Documents/Scripts", once: true, file: "fetch_transcript.py" } });
				await panel.locator(".ask-path").filter({ hasText: "~/Documents/Scripts" }).waitFor();
				const fileRows = await panel.locator(".ask-fact").evaluateAll((facts) => facts.map((fact) => [fact.querySelector("dt")?.textContent, fact.querySelector("dd")?.textContent]));
				expect(JSON.stringify(fileRows.slice(0, 2)) === JSON.stringify([[FILE_LABEL, "fetch_transcript.py"], [FOLDER_PANE_TITLE, "Scripts~/Documents/Scripts"]]), `${at}: a file's card names the file, then its folder (${JSON.stringify(fileRows)})`);
				expect(await panel.getByText(folderAskLine("read", { file: "fetch_transcript.py" }), { exact: true }).count() === 1 && folderAskLine("read", { file: "fetch_transcript.py" }) === "It will be able to read all the files in this folder, not just fetch_transcript.py. It gets no other access.", `${at}: a file's line says the whole folder`);
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([CHOOSE_ANOTHER_FOLDER, NOT_NOW, ALLOW_FOR_ROOM_PICK, ALLOW_THIS_TIME_PICK]), `${at}: a file's folder with one click keeps its presses (${JSON.stringify(await buttonsOf())})`);
				send({ type: "ui_request_closed", id: `file-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// Only the room's words for a place: the Folder row shows them as text, with Not now and Choose folder, no Allow and the line for the folder you choose.
				const words = "~/.local/bin/⟦U+202E⟧fetch_transcript.py";
				send({ ...folder(`named-${at}`), suggested: { named: words, once: false } });
				const namedRow = panel.locator(".ask-fact").first();
				await namedRow.waitFor();
				expect(await namedRow.locator("dt").innerText() === FOLDER_PANE_TITLE && await namedRow.locator("dd").innerText() === words && await namedRow.locator(".ask-name").count() === 0, `${at}: the room's words show on the Folder row as text (${await namedRow.innerText()})`);
				expect(await namedRow.locator(".ask-path").evaluate((element) => getComputedStyle(element).unicodeBidi) === "isolate", `${at}: the room's words are isolated`);
				expect(JSON.stringify(await buttonsOf()) === JSON.stringify([NOT_NOW, CHOOSE_FOLDER]) && await panel.getByText(folderAskLine("read"), { exact: true }).count() === 1, `${at}: the room's words give no Allow (${JSON.stringify(await buttonsOf())})`);
				expect(await panel.evaluate((element) => element.scrollWidth - element.clientWidth) <= 1, `${at}: the room's words never scroll the panel sideways`);
				await room.page.locator('[aria-live="polite"]').filter({ hasText: `${FOLDER_PANE_TITLE}: ${words}` }).waitFor();
				send({ type: "ui_request_closed", id: `named-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// A Windows path too long for its line breaks after a backslash, never inside a folder's name.
				if (width === 390) {
					send({ ...folder(`windows-path-${at}`), suggested: { name: "March invoices", path: "C:\\Users\\office\\Documents\\Finance\\March invoices", once: true } });
					const path = panel.locator(".ask-path");
					await path.waitFor();
					// Each folder's name in the path stays on one line; the path still wraps, at its backslashes.
					const names = await path.evaluate((element) => {
						// The path's text, one character per entry with the line it sits on (no helper functions: the page has none of the runner's).
						const chars: Array<{ char: string; top: number }> = [];
						const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
						for (let node = walker.nextNode(); node; node = walker.nextNode()) {
							for (let index = 0; index < node.textContent!.length; index += 1) {
								const range = document.createRange();
								range.setStart(node, index);
								range.setEnd(node, index + 1);
								chars.push({ char: node.textContent![index], top: Math.round(range.getBoundingClientRect().top) });
							}
						}
						const split: string[] = [];
						let name: typeof chars = [];
						for (const entry of [...chars, { char: "\\", top: 0 }]) {
							if (entry.char !== "\\") { name.push(entry); continue; }
							if (new Set(name.filter((c) => c.char !== " ").map((c) => c.top)).size > 1) split.push(name.map((c) => c.char).join(""));
							name = [];
						}
						return { split, pathLines: new Set(chars.map((c) => c.top)).size };
					});
					expect(names.split.length === 0 && names.pathLines > 1, `${at}: a Windows path breaks after a backslash, never inside a folder's name (${JSON.stringify(names)})`);
					send({ type: "ui_request_closed", id: `windows-path-${at}`, reason: "unanswered" });
					await panel.waitFor({ state: "detached" });
				}
				// Nothing shown: no Folder row.
				send(folder(`none-${at}`));
				await panel.filter({ hasText: folderAskTitle(true) }).waitFor();
				expect(await panel.getByText(FOLDER_PANE_TITLE, { exact: true }).count() === 0 && JSON.stringify(await buttonsOf()) === JSON.stringify([NOT_NOW, CHOOSE_FOLDER]), `${at}: with no folder shown, no Folder row, and Not now and Choose folder (${JSON.stringify(await buttonsOf())})`);
				send({ type: "ui_request_closed", id: `none-${at}`, reason: "unanswered" });
				await panel.waitFor({ state: "detached" });
				// A room on Auto asks for another folder in the same words as a room on Ask or Semi: a frame marked `free`, as a room on
				// Auto once sent it, shows the lines of the same frame unmarked, with a folder shown and without.
				const linesOf = async (frame: ReturnType<typeof folder> & Record<string, unknown>) => {
					send(frame);
					await panel.filter({ hasText: folderAskTitle(true) }).waitFor();
					const lines = (await panel.locator(".ask-line").allInnerTexts()).map((line) => line.trim());
					send({ type: "ui_request_closed", id: frame.id, reason: "unanswered" });
					await panel.waitFor({ state: "detached" });
					return lines;
				};
				for (const [shown, extra] of [["once", { suggested: { name: "Finance", path: "~/Documents/Finance", once: true } }], ["none", {}]] as const) {
					const other = await linesOf({ ...folder(`semi-${shown}-${at}`), ...extra });
					const auto = await linesOf({ ...folder(`auto-${shown}-${at}`), ...extra, free: true });
					const line = folderAskLine("read", shown === "once" ? "named" : "chosen");
					expect(other.includes(line) && JSON.stringify(auto) === JSON.stringify(other), `${at}: in a room on Auto the folder question reads as in any other room (${JSON.stringify(auto)} beside ${JSON.stringify(other)})`);
				}
			} finally {
				await room.context.close();
			}
		}

		// A real press on an answer, with a mouse or a finger, reaches that answer and only it, and nothing the press changes
		// moves any answer: not where the focus is, and not the Esc hint, which a press brings onto Not now when the box holds a
		// draft. On a narrow screen no taller than 740px a question's two answers share a row; the narrowest desktop window, with
		// the wider Windows hint, is where three answers have the least room.
		const two = { frame: (id: string) => site(id, false), buttons: 2, answers: [[NOT_NOW, "decline"], [SITE_ALLOW_ONCE, "once"]] } as const;
		// Three answers on a folder question come with a folder one click may give.
		const three = { frame: (id: string) => ({ ...folder(id), suggested: { name: "Finance", path: "~/Documents/Finance", once: true } }), buttons: 3, answers: [[SITE_ALLOW_ONCE, FOLDER_PANEL_PRESSES.thisTime], ["Allow for this room", FOLDER_PANEL_PRESSES.room], [NOT_NOW, false]] } as const;
		// The narrowest desktop window with the Windows hint has no room for three answers on one line: the yeses drop to a
		// second line, every answer stays inside the panel, and nothing scrolls sideways, with the box empty or holding a draft.
		{
			const room = await openRoom(browser, { viewport: { width: 761, height: 800 }, userAgent: WINDOWS }, "Panel Room");
			try {
				for (const draft of ["", "A note for later."]) {
					await room.composer.fill(draft);
					const id = `inside-${draft.length}`;
					room.send(three.frame(id));
					await room.panel.locator(".ask-actions").waitFor();
					await room.awake();
					const fit = await room.panel.evaluate((panel) => {
						const p = panel.getBoundingClientRect();
						const cs = getComputedStyle(panel);
						const inner = { left: p.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), right: p.right - parseFloat(cs.borderRightWidth) - parseFloat(cs.paddingRight) };
						const out = [...panel.querySelectorAll(".ask-actions .rs-btn")].map((button) => ({ name: (button as HTMLElement).innerText, rect: button.getBoundingClientRect() })).filter(({ rect }) => rect.left < inner.left - 0.5 || rect.right > inner.right + 0.5).map(({ name, rect }) => `${name} ${Math.round(rect.left)}-${Math.round(rect.right)}`);
						return { inner: `${Math.round(inner.left)}-${Math.round(inner.right)}`, out, sideways: panel.scrollWidth > panel.clientWidth };
					});
					expect(fit.out.length === 0 && !fit.sideways, `Windows, narrowest desktop window, ${draft ? "a draft in the box" : "the box empty"}: all three answers lie inside the panel and it doesn't scroll sideways (${JSON.stringify(fit)})`);
					room.send({ type: "ui_request_closed", id, reason: "unanswered" });
					await room.panel.waitFor({ state: "detached" });
				}
			} finally {
				await room.context.close();
			}
		}
		const presses = [
			{ how: "mouse", where: "short phone", viewport: { width: 390, height: 600 }, userAgent: MAC, question: two },
			{ how: "touch", where: "short phone", viewport: { width: 390, height: 600 }, userAgent: MAC, question: two },
			{ how: "mouse", where: "small window with a draft", viewport: { width: 760, height: 700 }, userAgent: MAC, question: two },
			{ how: "mouse", where: "narrowest desktop window on Windows with a draft", viewport: { width: 761, height: 800 }, userAgent: WINDOWS, question: three },
		] as const;
		for (const { how, where, viewport, userAgent, question } of presses) {
			for (const [name, value] of question.answers) {
				const label = `${where}, ${how}, ${name}`;
				const draft = viewport.width > 720;
				const room = await openRoom(browser, { viewport, userAgent, ...(how === "touch" ? { hasTouch: true, isMobile: true } : {}) }, "Panel Room");
				try {
					if (how === "touch") await keyboardUp(room);
					else if (draft) await room.composer.fill("A note for later.");
					else await room.composer.focus();
					const id = `press-${viewport.width}-${how}-${value}`;
					room.send(question.frame(id));
					await room.panel.locator(".ask-actions").waitFor();
					await room.awake();
					const boxes = () => room.panel.evaluate((panel) => [...panel.querySelectorAll(".ask-actions .rs-btn")].map((button) => {
						const r = button.getBoundingClientRect();
						return [r.x, r.y, r.width, r.height].map(Math.round).join(",");
					}));
					const focused = await room.page.evaluate(() => document.activeElement === document.querySelector(".composer textarea"));
					const withFocus = await boxes();
					await room.page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
					const withoutFocus = await boxes();
					await room.composer.focus();
					const tops = new Set(withFocus.map((box) => box.split(",")[1]));
					if (question === two) expect(focused && withFocus.length === question.buttons && tops.size === 1, `${label}: with the box focused, the answers share a row (${JSON.stringify(withFocus)})`);
					else expect(focused && withFocus.length === question.buttons, `${label}: with the box focused, the three answers show (${JSON.stringify(withFocus)})`);
					expect(JSON.stringify(withFocus) === JSON.stringify(withoutFocus), `${label}: the answers sit the same with the box focused and not (${JSON.stringify([withFocus, withoutFocus])})`);
					const button = room.panel.getByRole("button", { name });
					await button.evaluate((pressed) => {
						// No named helper in here: the bundler would wrap it in a name call the page doesn't have.
						const r = pressed.getBoundingClientRect();
						const hint = pressed.closest(".ask-panel")!.querySelector(".ask-esc");
						const seen: { before: string; hintBefore: boolean; click?: { onPressed: boolean; target: string; box: string; hint: boolean } } = { before: [r.x, r.y, r.width, r.height].map(Math.round).join(","), hintBefore: !!hint && getComputedStyle(hint).display !== "none" && getComputedStyle(hint).visibility === "visible" };
						(window as unknown as { pressSeen: typeof seen }).pressSeen = seen;
						document.addEventListener("click", (event) => {
							const target = event.target as Element;
							const now = pressed.getBoundingClientRect();
							seen.click = { onPressed: pressed.contains(target), target: `<${target.tagName.toLowerCase()}.${target.classList[0] ?? ""}>`, box: [now.x, now.y, now.width, now.height].map(Math.round).join(","), hint: !!hint && getComputedStyle(hint).display !== "none" && getComputedStyle(hint).visibility === "visible" };
						}, { capture: true, once: true });
					});
					const centre = await button.boundingBox();
					assert(centre, `${label}: the answer has a box`);
					const [x, y] = [centre.x + centre.width / 2, centre.y + centre.height / 2];
					if (how === "touch") await room.page.touchscreen.tap(x, y);
					else {
						await room.page.mouse.move(x, y);
						await room.page.mouse.down();
						await room.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
						await room.page.mouse.up();
					}
					await waitUntil(() => room.page.evaluate(() => !!(window as unknown as { pressSeen: { click?: unknown } }).pressSeen.click), `${label}: the press ends in a click`);
					// A press that reached no answer sends nothing, so the wait for one is bounded and its end is the finding.
					await waitUntil(() => !!room.response(id), `${label}: the answer leaves the page`, 3000).catch(() => {});
					const seen = await room.page.evaluate(() => (window as unknown as { pressSeen: { before: string; hintBefore: boolean; click: { onPressed: boolean; target: string; box: string; hint: boolean } } }).pressSeen);
					const sent = room.socket.responses.filter((frame) => String(frame.id).startsWith("press-")).map((frame) => frame.value);
					expect(JSON.stringify(sent) === JSON.stringify([value]), `${label}: exactly the pressed answer is sent (${JSON.stringify(sent)})`);
					// A folder answer waits for the computer's folder window, so only the other question leaves at once.
					if (question === two) expect(await room.panel.waitFor({ state: "detached", timeout: 3000 }).then(() => true, () => false), `${label}: the panel closes`);
					if (draft) expect(!seen.hintBefore && seen.click.hint, `${label}: the press itself brought the Esc hint onto Not now (${JSON.stringify(seen)})`);
					expect(seen.click.onPressed && seen.click.box === seen.before, `${label}: the click lands on the pressed answer, which has not moved (${JSON.stringify(seen)})`);
				} finally {
					await room.context.close();
				}
			}
		}

		// Leaving a room while its folder question waits, and coming back with Resume: the steps keep one row for it, the question's own.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Return Room");
			try {
				await room.composer.fill(ASK_THE_FOLDER);
				await sendFromBox(room.page);
				await room.panel.waitFor({ timeout: 15000 });
				const asked = room.page.locator(".wk-row").filter({ hasText: ASKED_FOR_FOLDER });
				const rows = async () => (await asked.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim());
				// The question shows above the message box, so what the model reads of it never calls it a card.
				const asking = endpointState.folderAskDescription;
				expect(asking.includes("The app shows them your reason.") && !/\bcards?\b/i.test(asking), `the folder question's description as the model reads it says no card (${asking})`);
				const before = await rows();
				expect(before.length === 1, `leave and Resume: before leaving, one ${ASKED_FOR_FOLDER} row (${JSON.stringify(before)})`);
				await room.page.locator(".sidebar-home-btn").click();
				const card = room.page.locator(".persistent-agent-card").filter({ hasText: "Return Room" });
				await card.getByRole("button", { name: "Resume" }).click();
				await room.panel.waitFor({ timeout: 15000 });
				await waitUntil(async () => (await asked.count()) > 0, "the steps show the folder question again");
				// The replay and the question sent again have both landed once the panel shows; two painted frames let any late row draw.
				await painted(room.page);
				const after = await rows();
				expect(after.length === 1, `leave and Resume: after coming back, still one ${ASKED_FOR_FOLDER} row (${JSON.stringify(after)})`);
				await room.awake();
				await room.panel.getByRole("button", { name: NOT_NOW }).click();
				await room.panel.waitFor({ state: "detached" });
			} finally {
				await room.context.close();
			}
		}

		// The run-outside question in the panel: its keys wait out the panel's pause and a held key answers nothing; both answers
		// leave it at once with no reply from the server, the next question showing; the steps keep their lines and the box's hint
		// is the panel's; the panel keeps its height; a message declines it as it does the others; and Running now shows only a
		// command that has begun and isn't waiting for its own question.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Outside Room");
			const { page, panel, composer, send, response, responses } = room;
			try {
				await room.answer("Push the branch, please.");
				const outsidePanel = panel.filter({ hasText: OUTSIDE_TITLE });
				const run = outsidePanel.getByRole("button", { name: OUTSIDE_RUN_ONCE });
				const notNow = outsidePanel.getByRole("button", { name: NOT_NOW });
				const stepLine = (words: string) => page.locator(".wk-row").filter({ hasText: `${words} · ${OUTSIDE_TITLE}` });
				const gone = () => outsidePanel.waitFor({ state: "detached", timeout: 2_000 }).then(() => true, () => false);

				// Escape in the question's first second answers nothing, pressed as soon as it shows.
				send(outside("o-keys"));
				await composer.focus();
				await outsidePanel.waitFor();
				await page.keyboard.press("Escape");
				await painted(page);
				expect(responses("o-keys").length === 0 && await outsidePanel.count() === 1, `outside: Escape in its first second answers nothing (${JSON.stringify(responses("o-keys"))})`);
				// The box's hint is the panel's, and the steps keep a quiet row with no answers.
				expect(await composer.getAttribute("placeholder") === SENDING_COUNTS_AS_NOT_NOW, `outside: the box's hint is the panel's (${await composer.getAttribute("placeholder")})`);
				const quiet = page.locator('.wk-row[data-s="waiting"]').filter({ hasText: OUTSIDE_TITLE });
				expect(await quiet.count() === 1 && await quiet.getByRole("button").count() === 0 && await page.locator(".wk-row.wk-ask").count() === 0, `outside: the steps keep a quiet row while it waits (${(await page.locator(".wk-card").allInnerTexts()).join(" | ")})`);
				// After the pause Escape is the no.
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await page.keyboard.press("Escape");
				await waitUntil(() => response("o-keys") !== undefined, "Escape answers the outside question");
				expect(response("o-keys").value === false, `outside: Escape after the pause is the no (${response("o-keys").value})`);
				expect(await gone(), "outside: after the no it leaves the panel at once, with no reply from the server");
				expect(await stepLine("Not done · you said no").count() === 1, `outside: after the no the steps say so, as the panel's other questions do (${(await page.locator(".wk-card").allInnerTexts()).join(" | ")})`);

				// Held down as a waiting outside question becomes the one shown, Escape answers nothing; a fresh press does.
				send(site("o-site-first"));
				await room.awake();
				send(outside("o-held"));
				await panel.getByText(moreQuestionsLine(1)).waitFor();
				await page.keyboard.press("Escape");
				await waitUntil(() => response("o-site-first") !== undefined, "Escape answers the site question");
				await outsidePanel.waitFor();
				for (let held = 0; held < 30; held++) {
					await page.evaluate(() => (document.activeElement ?? document.body).dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", repeat: true, bubbles: true, cancelable: true })));
					await page.waitForTimeout(50);
				}
				expect(responses("o-held").length === 0 && await outsidePanel.count() === 1, `outside: Escape held down as it shows answers nothing (${JSON.stringify(responses("o-held"))})`);
				await page.keyboard.press("Escape");
				await waitUntil(() => response("o-held") !== undefined, "a fresh Escape answers it");
				expect(await gone(), "outside: the held question leaves the panel once a fresh Escape answers it");

				// Run once: it leaves at once with no reply from the server, the next question shows, and the steps say what was chosen.
				send(outside("o-yes"));
				await outsidePanel.waitFor();
				send(site("o-site-next"));
				await panel.getByText(moreQuestionsLine(1)).waitFor();
				await waitUntil(() => run.isEnabled(), "Run once wakes");
				await run.click();
				await waitUntil(() => response("o-yes") !== undefined, "Run once answers");
				expect(response("o-yes").value === true, `outside: a click on Run once is the yes (${response("o-yes").value})`);
				expect(await gone() && await panel.filter({ hasText: siteCardQuestion("pypi.org") }).count() === 1, "outside: after Run once it leaves the panel at once and the next waiting question shows");
				expect(await stepLine(`You chose ${OUTSIDE_RUN_ONCE}`).count() === 1, `outside: after Run once the steps say what was chosen (${(await page.locator(".wk-card").allInnerTexts()).join(" | ")})`);
				await room.awake();
				await page.keyboard.press("Escape");
				await waitUntil(() => response("o-site-next") !== undefined, "the next question is answered");
				await panel.waitFor({ state: "detached" });

				// A long command scrolls inside the panel, which keeps to half the window, at the computer and at a phone's width.
				const long = `${"git log --oneline --graph --decorate\n".repeat(60)}git push --force origin main`;
				for (const [width, height] of [[1280, 900], [390, 844]] as const) {
					await page.setViewportSize({ width, height });
					send(outside(`o-tall-${width}`, long, "Long. ".repeat(80)));
					await outsidePanel.waitFor();
					await painted(page);
					const sizes = await page.evaluate(() => {
						const box = document.querySelector(".ask-panel pre")!;
						return { panel: document.querySelector(".ask-panel")!.getBoundingClientRect().height, window: window.innerHeight, scroll: box.scrollHeight, client: box.clientHeight };
					});
					expect(sizes.panel <= sizes.window / 2 + 1 && sizes.scroll > sizes.client, `outside: at ${width}px a long command scrolls in its box and the panel keeps to half the window (${JSON.stringify(sizes)})`);
					await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
					await notNow.click();
					await outsidePanel.waitFor({ state: "detached" });
				}

				// A long reason never pushes what the yes gives out of view: with Run once ready, that line is on screen.
				send(outside("o-reason", long, "One line of the model's reason.\n".repeat(40)));
				await outsidePanel.locator("pre").waitFor();
				await waitUntil(() => run.isEnabled(), "Run once wakes with a long reason");
				const riskShows = await outsidePanel.getByText(OUTSIDE_CARD_LINE).evaluate((line) => {
					const box = line.getBoundingClientRect();
					const words = document.querySelector(".ask-panel .ask-panel-in")!;
					const frame = words.getBoundingClientRect();
					const fades = [...words.querySelectorAll(".ask-fade")].map((fade) => fade.getBoundingClientRect());
					return { line: [box.top, box.bottom], shown: [Math.max(frame.top + words.clientTop, fades[0].bottom), Math.min(frame.top + words.clientTop + words.clientHeight, fades[1].top)] };
				});
				expect(riskShows.line[0] >= riskShows.shown[0] - 1 && riskShows.line[1] <= riskShows.shown[1] + 1, `outside: with a long reason, what the yes gives is on screen when Run once is ready (${JSON.stringify(riskShows)})`);
				await notNow.click();
				await outsidePanel.waitFor({ state: "detached" });

				await page.setViewportSize({ width: 1280, height: 900 });

				// A message declines it only when its writing began after the question appeared.
				const steers = () => room.socket.sent.filter((frame) => frame.type === "steer");
				const sentBefore = steers().length;
				await composer.fill("Written before the question");
				// Two frames: the question comes after the draft's start, never in its millisecond.
				await painted(page);
				send(outside("o-draft"));
				await outsidePanel.waitFor();
				await sendFromBox(page);
				await waitUntil(() => steers().length > sentBefore, "the earlier draft is sent");
				expect(steers().at(-1).declines === undefined && await outsidePanel.count() === 1, `outside: a message begun before it leaves it open (${JSON.stringify(steers().at(-1))})`);
				await composer.fill("Written after the question");
				await sendFromBox(page);
				await waitUntil(() => steers().length > sentBefore + 1, "the later message is sent");
				expect(steers().at(-1).declines === true, `outside: a message begun after it declines it (${JSON.stringify(steers().at(-1))})`);
				// The server closes a question a message declined; this one was handed to the page, so the smoke closes it.
				send({ type: "ui_request_closed", id: "o-draft", reason: "declined" });
				await outsidePanel.waitFor({ state: "detached" });

				// Running now: a command the model has written but the server hasn't begun isn't running, nor one waiting for its own question.
				const written = (id: string, name: string, command: string) => send({ type: "event", event: { type: "message_update", assistantMessageEvent: { type: "toolcall_end", id, name, preview: { command } } } });
				const begun = (id: string, name: string) => send({ type: "event", event: { type: "tool_execution_start", toolCallId: id, toolName: name, startedAt: Date.now() } });
				const runningNow = () => panel.locator(".ask-fact").filter({ hasText: RUNNING_NOW }).locator("code");
				written("toolu_first", "bash", "pip install requests");
				begun("toolu_first", "bash");
				written("toolu_second", "run_outside_box", "git push origin main");
				send(site("o-running"));
				await panel.filter({ hasText: siteCardQuestion("pypi.org") }).waitFor();
				expect(await runningNow().count() === 1 && await runningNow().innerText() === "pip install requests", `running now: with a run-outside call written after it, the site question shows the first command (${await panel.innerText()})`);
				begun("toolu_second", "run_outside_box");
				send(outside("o-own", "git push origin main"));
				await panel.getByText(moreQuestionsLine(1)).waitFor();
				expect(await runningNow().innerText() === "pip install requests", `running now: a command waiting for its own run-outside question isn't running (${await panel.innerText()})`);
				await room.awake();
				await page.keyboard.press("Escape");
				await waitUntil(() => response("o-running") !== undefined, "the site question is answered");
				await outsidePanel.waitFor();
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await notNow.click();
				await outsidePanel.waitFor({ state: "detached" });
			} finally {
				await room.context.close();
			}
		}

		// "Run this command?" handed to the page as the server asks it in a room on Ask: the panel's look, its keys, a queued
		// message, drafts, two waiting and a long command. The page draws it the same whatever the room's protection.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Run Room");
			const { page, panel, composer, main, send, responses, awake, asleep } = room;
			try {
				await room.answer("A slow answer, please.");
				const runPanel = panel.filter({ hasText: RUN_TITLE });
				const notNow = runPanel.getByRole("button", { name: NOT_NOW });
				const yeses = (id: string) => responses(id).filter((frame) => frame.value === true);
				const answerOf = (id: string) => responses(id).map((frame) => frame.value);
				const steps = async () => (await page.locator(".wk-card").allInnerTexts()).join(" | ");

				// The look, and the focus left where it was.
				await composer.focus();
				send(runAsk("run-look"));
				await runPanel.waitFor();
				expect(await page.evaluate(() => !!document.activeElement?.closest(".composer-box")), "run: the question takes no focus when it appears");
				const fact = runPanel.locator(".ask-fact");
				const look = {
					title: await panel.locator(".ask-title").innerText(),
					command: await runPanel.locator("pre.ask-command").innerText(),
					facts: await fact.evaluateAll((rows) => rows.map((row) => [row.querySelector("dt")?.textContent, row.querySelector("dd")?.textContent])),
					answers: await runPanel.getByRole("button").evaluateAll((buttons) => buttons.map((button) => [(button as HTMLElement).innerText.replace(/\s+/g, " ").trim(), Math.round(button.getBoundingClientRect().left)] as const)),
				};
				expect(look.title === RUN_TITLE && look.command === "rm -r build" && JSON.stringify(look.facts) === JSON.stringify([[RUNS_IN, "/Users/ana/Sales"]]), `run: the panel shows the title, the command in its box and the folder under Runs in (${JSON.stringify(look)})`);
				expect(look.answers.length === 2 && look.answers[0][0].startsWith(NOT_NOW) && look.answers[1][0] === `${OUTSIDE_RUN_ONCE}⌘↵` && look.answers[0][1] < look.answers[1][1], `run: Not now on the left, Run once on the right with its chord (${JSON.stringify(look.answers)})`);
				expect(await page.getByRole("button", { name: /^(Deny|Allow)\b/ }).count() === 0 && await page.locator(".wk-ask").count() === 0, `run: no card with Deny or Allow in the steps (${await steps()})`);
				const quiet = page.locator('.wk-row[data-s="waiting"]').filter({ hasText: RUN_TITLE });
				expect(await quiet.count() === 1 && await quiet.getByRole("button").count() === 0 && await page.locator(".wk-card.waiting").count() === 0 && (await steps()).includes(WAITING_FOR_OK), `run: the steps keep one quiet row and say ${WAITING_FOR_OK}, with no amber (${await steps()})`);
				const glyphs = await Promise.all([quiet.locator(".wk-row-ic svg"), panel.locator(".ask-title svg")].map((icon) => icon.innerHTML()));
				expect(glyphs[0] === glyphs[1], "run: the step's quiet row shows the glyph of the panel's title");
				expect(await composer.getAttribute("placeholder") === SENDING_COUNTS_AS_NOT_NOW, `run: the box says sending counts as Not now (${await composer.getAttribute("placeholder")})`);

				// The pause: the chord and a click give nothing.
				await page.evaluate(() => window.dispatchEvent(new Event("focus")));
				let inside = await asleep();
				await page.keyboard.press("Meta+Enter");
				await main.click({ force: true });
				inside = inside && await asleep();
				expect(inside && responses("run-look").length === 0, `run: in the panel's pause the chord and a click give nothing (${JSON.stringify(answerOf("run-look"))})`);
				// Plain Enter never: from the empty box, from the page, from Run once itself.
				await awake();
				await composer.focus();
				await page.keyboard.press("Enter");
				await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
				await page.keyboard.press("Enter");
				await main.focus();
				await page.keyboard.press("Enter");
				await painted(page);
				expect(responses("run-look").length === 0 && await runPanel.count() === 1, `run: plain Enter from the box, the page or Run once gives nothing (${JSON.stringify(answerOf("run-look"))})`);
				// The chord, the box empty, nothing queued and the pause over: Run once, and the question leaves at once.
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await waitUntil(() => responses("run-look").length > 0, "the chord answers");
				expect(JSON.stringify(answerOf("run-look")) === "[true]", `run: Cmd+Enter with the box empty is Run once (${JSON.stringify(answerOf("run-look"))})`);
				await runPanel.waitFor({ state: "detached", timeout: 2_000 });

				// Escape waits out the pause, then is Not now; so is a click on Not now.
				send(runAsk("run-esc"));
				await runPanel.waitFor();
				await page.keyboard.press("Escape");
				await painted(page);
				expect(responses("run-esc").length === 0, "run: Escape in the question's first second gives nothing");
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await page.keyboard.press("Escape");
				await waitUntil(() => responses("run-esc").length > 0, "Escape answers");
				expect(JSON.stringify(answerOf("run-esc")) === "[false]", `run: Escape after the pause is Not now (${JSON.stringify(answerOf("run-esc"))})`);
				send(runAsk("run-no"));
				await runPanel.waitFor();
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await notNow.click();
				await waitUntil(() => responses("run-no").length > 0, "Not now answers");
				expect(JSON.stringify(answerOf("run-no")) === "[false]", `run: a click on Not now is the no (${JSON.stringify(answerOf("run-no"))})`);
				await runPanel.waitFor({ state: "detached", timeout: 2_000 });

				// Two waiting: the first shows, the second is counted, and shows once the first is answered.
				send(runAsk("run-first", "ls first"));
				send(runAsk("run-second", "ls second"));
				await panel.getByText(moreQuestionsLine(1)).waitFor();
				expect(await runPanel.locator("pre").innerText() === "ls first", `run: two waiting, the first shows (${await panel.innerText()})`);
				await awake();
				await page.keyboard.press("Escape");
				await waitUntil(() => responses("run-first").length > 0, "the first is answered");
				await runPanel.filter({ hasText: "ls second" }).waitFor();
				expect(await panel.locator(".ask-more").count() === 0 && responses("run-second").length === 0, "run: then the second shows, with no count");
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await notNow.click();
				await runPanel.waitFor({ state: "detached", timeout: 2_000 });

				// A long command, far past the old cut, shows whole with every hidden character the server wrote out, scrolls in its box,
				// and the panel keeps to half the window with both answers in view, at the computer and at a phone's width.
				const long = `echo start ⟦U+202E⟧ hidden\n${"cp reports/2026/q3-summary.xlsx archive/2026/q3-summary.xlsx\n".repeat(150)}rm -r build`;
				const longFolder = `/Users/ana/${"Projects/".repeat(12)}Sales`;
				// Around the panel's words: how far they scroll on their own, the space between the last words in view and the answers,
				// and the first line's top of Runs in and of the folder, with how many lines the folder takes.
				const around = () => page.evaluate(() => {
					const panel = document.querySelector(".ask-panel")!;
					const words = panel.querySelector(".ask-panel-in") as HTMLElement;
					const facts = panel.querySelector(".ask-facts")!.getBoundingClientRect();
					const [label, folder] = [panel.querySelector(".ask-fact dt")!, panel.querySelector(".ask-fact .ask-path")!].map((element) => {
						const range = document.createRange();
						range.selectNodeContents(element);
						return [...new Set([...range.getClientRects()].map((box) => Math.round(box.top)))].sort((a, b) => a - b);
					});
					return { wordsScroll: words.scrollHeight - words.clientHeight, gap: Math.round(panel.querySelector(".ask-actions")!.getBoundingClientRect().top - Math.min(facts.bottom, words.getBoundingClientRect().bottom)), labelTop: label[0], folderTop: folder[0], folderLines: folder.length };
				});
				for (const [width, height] of [[1280, 900], [390, 844]] as const) {
					await page.setViewportSize({ width, height });
					// A short command in the same folder, for the space above its answers.
					send(runAsk(`run-short-${width}`, "rm -r build", longFolder));
					await runPanel.waitFor();
					await painted(page);
					const short = await around();
					expect(Math.abs(short.labelTop - short.folderTop) <= 1 && (width > 400 || short.folderLines >= 2), `run: at ${width}px with a short command, Runs in lines up with the folder's first line (${JSON.stringify(short)})`);
					send({ type: "ui_request_closed", id: `run-short-${width}`, reason: "unanswered" });
					await runPanel.waitFor({ state: "detached", timeout: 2_000 });
					send(runAsk(`run-long-${width}`, long, longFolder));
					await runPanel.waitFor();
					await painted(page);
					const shown = await page.evaluate(() => {
						const panel = document.querySelector(".ask-panel")!.getBoundingClientRect();
						const box = document.querySelector(".ask-panel pre")!;
						const inView = [...document.querySelectorAll(".ask-panel .ask-actions button")].map((button) => {
							const r = button.getBoundingClientRect();
							return r.top >= panel.top && r.bottom <= panel.bottom && r.bottom <= window.innerHeight && r.height > 0;
						});
						return { text: box.textContent, panel: panel.height, window: window.innerHeight, scroll: box.scrollHeight, client: box.clientHeight, inView };
					});
					expect(shown.text === long && shown.panel <= shown.window / 2 + 1 && shown.scroll > shown.client && shown.inView.length === 2 && shown.inView.every(Boolean), `run: at ${width}px a long command shows whole, hidden characters written out, and scrolls in its box, the panel at most half the window with both answers in view (${JSON.stringify({ ...shown, text: `${shown.text?.length} characters` })})`);
					expect(await fact.locator("dd").innerText() === longFolder, `run: at ${width}px a long folder shows whole under Runs in`);
					const tall = await around();
					expect(tall.wordsScroll <= 1, `run: at ${width}px with a long command only the command's box scrolls: the panel's words have no scroll of their own (${JSON.stringify(tall)})`);
					expect(Math.abs(tall.gap - short.gap) <= 1, `run: at ${width}px with a long command the space above the answers is the short command's (${JSON.stringify({ tall: tall.gap, short: short.gap })})`);
					expect(Math.abs(tall.labelTop - tall.folderTop) <= 1 && (width > 400 || tall.folderLines >= 2), `run: at ${width}px with a long command, Runs in lines up with the folder's first line (${JSON.stringify(tall)})`);
					await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
					await notNow.click();
					await runPanel.waitFor({ state: "detached", timeout: 2_000 });
				}
				await page.setViewportSize({ width: 1280, height: 900 });

				// Words in the box: the chord is the box's Send now, never Run once.
				const steers = () => room.socket.sent.filter((frame) => frame.type === "steer");
				send(runAsk("run-words"));
				await awake();
				await composer.fill("A word");
				expect(!(await main.innerText()).includes("⌘↵"), "run: with words in the box, Run once shows no ⌘↵");
				const sentBefore = steers().length;
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await waitUntil(() => steers().length > sentBefore, "the chord sends the box's words");
				expect(yeses("run-words").length === 0, `run: with words in the box the chord sends them and gives no Run once (${JSON.stringify(answerOf("run-words"))})`);
				send({ type: "ui_request_closed", id: "run-words", reason: "declined" });
				await runPanel.waitFor({ state: "detached" });

				// A message begun before the question leaves it waiting; one begun after declines it.
				await composer.fill("Written before the question");
				await painted(page);
				send(runAsk("run-draft"));
				await runPanel.waitFor();
				const draftBefore = steers().length;
				await sendFromBox(page);
				await waitUntil(() => steers().length > draftBefore, "the earlier draft is sent");
				expect(steers().at(-1).declines === undefined && await runPanel.count() === 1 && responses("run-draft").length === 0, `run: a message begun before it leaves it waiting (${JSON.stringify(steers().at(-1))})`);
				await composer.fill("Written after the question");
				await sendFromBox(page);
				await waitUntil(() => steers().length > draftBefore + 1, "the later message is sent");
				expect(steers().at(-1).declines === true && yeses("run-draft").length === 0, `run: a message begun after it declines it (${JSON.stringify(steers().at(-1))})`);
				send({ type: "ui_request_closed", id: "run-draft", reason: "declined" });
				await runPanel.waitFor({ state: "detached" });

				// With a message queued, the chord sends it now and gives no Run once.
				send(runAsk("run-queued"));
				await awake();
				await composer.fill("Queue this one");
				await sendFromBox(page);
				await page.locator(".queued-messages").waitFor();
				expect(!(await main.innerText()).includes("⌘↵"), "run: with a message queued, Run once shows no ⌘↵");
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await waitUntil(() => room.socket.sent.some((frame) => frame.type === "abort" && frame.forNext === true), "the chord sends the queued message now");
				expect(yeses("run-queued").length === 0, `run: with a message queued the chord sends it now and gives no Run once (${JSON.stringify(answerOf("run-queued"))})`);
			} finally {
				await room.context.close();
			}
		}

		// "Run this command?" on a phone: both answers show, and its Run once is sent.
		{
			const room = await openRoom(browser, { viewport: { width: 390, height: 844 }, userAgent: MAC, isMobile: true, hasTouch: true }, "Run Room", true);
			const { panel, send, responses, awake } = room;
			try {
				await room.answer("A slow answer, please.");
				send(runAsk("run-phone"));
				const runPanel = panel.filter({ hasText: RUN_TITLE });
				await runPanel.waitFor();
				const answers = await runPanel.getByRole("button").allInnerTexts();
				expect(answers.length === 2 && answers.includes(NOT_NOW) && answers.includes(OUTSIDE_RUN_ONCE) && !(await panel.innerText()).includes(WAITING_AT_COMPUTER), `run on a phone: the question shows both answers (${JSON.stringify(answers)})`);
				await awake();
				await runPanel.getByRole("button", { name: OUTSIDE_RUN_ONCE }).tap();
				await waitUntil(() => responses("run-phone").length > 0, "the phone's Run once is sent");
				expect(JSON.stringify(responses("run-phone").map((frame) => frame.value)) === "[true]", `run on a phone: a tap on Run once is the yes (${JSON.stringify(responses("run-phone"))})`);
			} finally {
				await room.context.close();
			}
		}

		// "Run this command?" asked by the model through the room's real question, in a room on Ask with protection turned off
		// and in one with it left on (protected wherever the room box runs): the same panel and keys in both; Run once runs the
		// command, and Not now, Escape and a message leave it not run, the model reading today's no; the steps keep one row for
		// the command and none for the question.
		for (const [roomName, id] of [["Ask Open Room", askOpenId], ["Ask Guarded Room", askGuardedId]] as const) {
			const settings = await (await authedFetch(`${baseUrl}/api/persistent-agents/${id}/bash-settings`)).json();
			const protection = settings?.protection?.state === "on" ? "protected" : settings?.protection?.cause ? `without protection: ${settings.protection.cause}` : "protection turned off";
			const at = `run in ${roomName} (${protection})`;
			assert(settings?.settings?.autoApprove === false, `${roomName} is on Ask (${JSON.stringify(settings)})`);
			const folder = askFolders.get(id)!;
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, roomName);
			const { page, panel, composer, main, awake, asleep } = room;
			const runPanel = panel.filter({ hasText: RUN_TITLE });
			const notNow = runPanel.getByRole("button", { name: NOT_NOW });
			const answersSent = () => room.socket.responses.length;
			const resultOf = (command: string) => endpointState.commandResults.find((result) => result.command === command);
			const ran = (name: string) => fs.existsSync(path.join(folder, `ran-${name}.txt`));
			const card = () => page.locator(".wk-card").last().innerText();
			const ask = async (name: string) => {
				const command = `echo ${name} > ran-${name}.txt`;
				await composer.fill(`${RUN_THE_COMMAND}${command}`);
				await sendFromBox(page);
				await runPanel.waitFor();
				return command;
			};
			const ended = async (command: string) => {
				await waitUntil(() => resultOf(command) !== undefined, `the model reads what came of ${command}`);
				await page.locator(".composer-box .stop-btn").waitFor({ state: "detached" });
				await page.getByText("Done.").last().waitFor();
			};
			try {
				// Run once by the chord, after the plain keys and the pause gave nothing.
				await composer.focus();
				const first = await ask("first");
				expect(await page.evaluate(() => !!document.activeElement?.closest(".composer-box")), `${at}: the question takes no focus`);
				await page.keyboard.press("Meta+Enter");
				await page.keyboard.press("Enter");
				const paused = await asleep();
				const shown = { command: await runPanel.locator("pre").innerText(), folder: await runPanel.locator(".ask-fact dd").innerText(), dt: await runPanel.locator(".ask-fact dt").innerText(), answers: await runPanel.getByRole("button").allInnerTexts() };
				expect(shown.command === first && shown.dt === RUNS_IN && shown.folder === folder && shown.answers.length === 2 && shown.answers[0].startsWith(NOT_NOW) && shown.answers[1].startsWith(OUTSIDE_RUN_ONCE), `${at}: the panel shows the command, Runs in with the room's folder, Not now and Run once (${JSON.stringify(shown)})`);
				expect(await page.getByRole("button", { name: /^(Deny|Allow)\b/ }).count() === 0 && await page.locator(".wk-ask").count() === 0, `${at}: no card with Deny or Allow in the steps`);
				expect(paused && answersSent() === 0, `${at}: in the pause the chord and plain Enter give nothing`);
				await awake();
				await page.keyboard.press("Enter");
				await main.focus();
				await page.keyboard.press("Enter");
				await painted(page);
				expect(answersSent() === 0 && !ran("first"), `${at}: after the pause plain Enter, from the box or on Run once, still gives nothing`);
				await composer.focus();
				await page.keyboard.press("Meta+Enter");
				await ended(first);
				expect(ran("first") && resultOf(first)?.isError === false, `${at}: Cmd+Enter is Run once, and the command runs (${JSON.stringify(resultOf(first))})`);
				const ranCard = await card();
				expect(!ranCard.includes(RUN_TITLE) && (ranCard.match(/ran-first/g) ?? []).length === 1, `${at}: after Run once the steps keep one row for the command and none for the question (${ranCard})`);

				// Not now, Escape, and a message begun after the question: each leaves the command not run, and the model reads today's no.
				const DECLINED = `${COMMAND_DECLINED} Do not run it or retry variants of it unless the user asks.`;
				const second = await ask("second");
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await notNow.click();
				await ended(second);
				expect(!ran("second") && resultOf(second)?.isError === true && resultOf(second)!.text.includes(DECLINED), `${at}: Not now leaves the command not run, the model reading today's no (${JSON.stringify(resultOf(second))})`);
				// Folded, the card says a step did not run; opened, its one row says why.
				await page.locator(".wk-card").last().locator(".wk-head").click();
				const rows = await page.locator(".wk-card").last().locator(".wk-row").allInnerTexts();
				expect(rows.length === 1 && rows[0].includes("you said no") && rows[0].includes("ran-second") && !(await card()).includes(RUN_TITLE), `${at}: after Not now the steps keep one row for the command, saying you said no, and none for the question (${JSON.stringify(rows)})`);
				const third = await ask("third");
				await waitUntil(async () => (await notNow.getAttribute("aria-disabled")) === "false", "Not now wakes");
				await composer.focus();
				await page.keyboard.press("Escape");
				await ended(third);
				expect(!ran("third") && resultOf(third)!.text.includes(DECLINED), `${at}: Escape leaves the command not run, the model reading today's no (${JSON.stringify(resultOf(third))})`);
				const fourth = await ask("fourth");
				await composer.fill("Never mind, leave it.");
				await sendFromBox(page);
				await ended(fourth);
				expect(!ran("fourth") && resultOf(fourth)?.isError === true && !resultOf(fourth)!.text.includes(DECLINED), `${at}: a message begun after the question leaves the command not run (${JSON.stringify(resultOf(fourth))})`);
				expect(await panel.count() === 0, `${at}: no question is left in the panel`);
			} finally {
				await room.context.close();
			}
		}

		// Run once wakes after its delay with nothing scrolled, and stays awake, where scrollbars take space: in an ordinary window, and in
		// one where the panel's words have a scrollbar of their own and a long command read to its end changes nothing.
		{
			const barsBrowser = await chromium.launch({ ignoreDefaultArgs: ["--hide-scrollbars"] });
			const room = await openRoom(barsBrowser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Outside Bars Room");
			const { page, panel, send, response } = room;
			try {
				await room.answer("Copy the build, please.");
				const outsidePanel = panel.filter({ hasText: OUTSIDE_TITLE });
				const run = outsidePanel.getByRole("button", { name: OUTSIDE_RUN_ONCE });
				const long = Array.from({ length: 40 }, (_, at) => `rsync -av ./build/part-${at}/ deploy@host:/srv/app/part-${at}/`).join("\n");
				// Six lines of reason: the panel's words then need a scrollbar of their own at 1034 px.
				const reason = "The model's reason line.\n".repeat(6);
				// From the moment Run once shows: when it first takes a click, how often it turned on or off, and whether it holds for 2 s after.
				const watchRunOnce = () => page.evaluate(async (label) => {
					// No named function in here: the page has no helper for the names the smoke's compiler gives them.
					while (![...document.querySelectorAll(".ask-panel button")].some((each) => each.textContent === label)) await new Promise((resolve) => setTimeout(resolve, 5));
					const shown = performance.now();
					let readyAfter: number | null = null;
					let turns = 0;
					let on = false;
					while (performance.now() - shown < 8_000 && (readyAfter === null || performance.now() - shown - readyAfter < 2_000)) {
						const now = [...document.querySelectorAll<HTMLButtonElement>(".ask-panel button")].some((each) => each.textContent === label && !each.disabled);
						if (now !== on) {
							turns += 1;
							on = now;
							readyAfter ??= performance.now() - shown;
						}
						await new Promise((resolve) => setTimeout(resolve, 20));
					}
					return { readyAfter, turns, on };
				}, OUTSIDE_RUN_ONCE);
				const runOnce = async (id: string) => {
					// A Run once that never woke has failed its row already: the smoke closes the question and goes on to the next row.
					if (await run.isDisabled()) {
						send({ type: "ui_request_closed", id, reason: "declined" });
						return outsidePanel.waitFor({ state: "detached" });
					}
					await run.click();
					await waitUntil(() => response(id) !== undefined, "Run once answers");
					expect(response(id).value === true, `outside: a click on Run once is the yes (${id}, ${response(id).value})`);
					await outsidePanel.waitFor({ state: "detached" });
				};

				for (const [width, height, id] of [[1280, 900, "o-plain"], [976, 1034, "o-bars"]] as const) {
					await page.setViewportSize({ width, height });
					send(outside(id, long, reason));
					const watched = await watchRunOnce();
					const words = await page.evaluate(() => { const box = document.querySelector(".ask-panel .ask-panel-in") as HTMLElement; return { bar: box.offsetWidth - box.clientWidth, scroll: box.scrollHeight, client: box.clientHeight }; });
					if (id === "o-bars") expect(words.bar > 0 && words.scroll > words.client, `outside: at ${width}x${height} the panel's words have a scrollbar of their own (${JSON.stringify(words)})`);
					expect(watched.readyAfter !== null && watched.readyAfter >= OUTSIDE_RUN_DELAY_MS - 50 && watched.turns === 1 && watched.on, `outside: at ${width}x${height}, with nothing scrolled, Run once wakes after its delay and stays awake (${JSON.stringify(watched)})`);
					await runOnce(id);
				}

				// Read to its end, the command changes nothing: Run once stays awake.
				send(outside("o-bars-read", long, reason));
				const pre = outsidePanel.locator("pre");
				await pre.waitFor();
				const watching = watchRunOnce();
				await pre.evaluate(async (box) => {
					for (box.scrollTop = 0; box.scrollTop + box.clientHeight < box.scrollHeight; box.scrollTop += box.clientHeight / 2) await new Promise((resolve) => setTimeout(resolve, 120));
					box.scrollTop = box.scrollHeight;
				});
				const read = await watching;
				expect(read.readyAfter !== null && read.turns === 1 && read.on, `outside: at 976x1034, with the command read to its end, Run once wakes and stays awake (${JSON.stringify(read)})`);
				await runOnce("o-bars-read");
			} finally {
				await room.context.close();
				await barsBrowser.close();
			}
		}

		// A reload: the saved question shows in the steps as not answered, and no panel is drawn from it.
		{
			const room = await openRoom(browser, { viewport: { width: 1280, height: 900 }, userAgent: MAC }, "Saved Room");
			try {
				await room.page.getByText("Not answered").first().waitFor();
				expect(await room.panel.count() === 0 && await room.page.getByText(WAITING_FOR_OK).count() === 0, "reload: a saved question draws no panel");
			} finally {
				await room.context.close();
			}
		}
		expect(ASKED_FOR_FOLDER === "Asked for a folder", "words: the folder question's quiet row reads Asked for a folder");
		assert(failures.length === 0, `the room's question:\n  ${failures.join("\n  ")}`);
	} finally {
		await browser.close();
	}
} finally {
	endpoint.close();
	if (server) await stopSmokeServer(server);
	fs.rmSync(tempRoot, { recursive: true, force: true });
}
console.log("ask-panel-ui smoke: ok");
