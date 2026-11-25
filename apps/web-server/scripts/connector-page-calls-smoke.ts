// A call from a connector's own page passes the room's gate as the
// assistant's call in that room would, through the REAL room scope: the
// gate the room hands the adapter with a call is called the way the adapter
// calls it for the page that call opened (`fromPage`), as a stand-in tool:
//
//  BLOCKED   - refused with no question and never reached; Always allow and a
//              read-only tool with nothing chosen run beside it.
//  ASKS      - anything else asks in the room, as the assistant's call does;
//              a No is refused, a yes runs; a room that asks nothing runs it.
//  NOBODY    - with nobody there, or in a scheduled run, it is refused.
//  UNREAD    - a choices file that can't be read asks, a read-only tool too.
//  HIDDEN    - a tool the live connection doesn't list, or whose visibility
//              leaves out "app", is refused with no question.
//  STEP      - a page's call that runs on Always allow puts no words on the
//              assistant's step; the assistant's own call does.
//  KEPT      - the gate a page keeps outlives the call that opened it: once
//              the connector is switched off in the room, or the tool is
//              switched off, a read-only tool is refused too.
//  ADAPTER   - through the REAL room extension and the REAL adapter's own
//              page server, against a stand-in connector whose tool carries a
//              page: the page opens with the platform's opener, its link one
//              argument; a Blocked tool, a No and a tool for the assistant only
//              never reach the connector, a read-only tool runs.
// Each refusal is a line the person reads, which the page can show.
//
// Offline, isolated HOME + agent dir + agents root, set before any import that reads them.
// The browser the adapter opens the page in is kept: no page opens on this computer.
// Run: npm run smokes -- connector-page-calls
import childProcess, { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

// The adapter starts the system's opener itself (web-link.ts, scripts/patch-mcp-adapter.mjs
// patch 27): each start of an opener, or of a shell that could run one, is kept here and
// recorded; any other program starts as it would.
type OpenerStart = { program: string; args: string[]; kept: boolean };
const openerStarts: OpenerStart[] = [];
const OPENERS = /^(open|xdg-open|rundll32\.exe|cmd(\.exe)?|powershell(\.exe)?|pwsh(\.exe)?)$/i;
const isOpener = (program: string) => OPENERS.test(path.win32.basename(program));
const realSpawn = childProcess.spawn as (...call: unknown[]) => ChildProcess;
childProcess.spawn = ((program: string, ...rest: unknown[]) => {
	if (!isOpener(program)) return realSpawn(program, ...rest);
	openerStarts.push({ program, args: Array.isArray(rest[0]) ? rest[0].map(String) : [], kept: true });
	const started = Object.assign(new EventEmitter(), { pid: 4242, stdin: null, stdout: null, stderr: null, unref() {}, ref() {}, kill: () => true });
	process.nextTick(() => started.emit("spawn"));
	return started;
}) as unknown as typeof childProcess.spawn;
// Every other way to start a program meets this: an opener started past the stand-in is refused, and recorded.
type Starter = { spawn: (this: ChildProcess, options: { file?: string; args?: string[] }) => unknown };
const starter = ChildProcess.prototype as unknown as Starter;
const realStart = starter.spawn;
starter.spawn = function (options) {
	if (!isOpener(String(options.file))) return realStart.call(this, options);
	openerStarts.push({ program: String(options.file), args: (options.args ?? []).slice(1), kept: false });
	throw new Error("this smoke opens no page in a browser");
};
syncBuiltinESMExports();
/** The platform's opener and what comes before the link, as the patched adapter starts it. */
const systemOpener = process.platform === "win32"
	? { program: path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "rundll32.exe"), before: ["url.dll,FileProtocolHandler"] }
	: { program: process.platform === "darwin" ? "open" : "xdg-open", before: [] as string[] };

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-page-calls-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-page-calls-root-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
delete process.env.MCP_DIRECT_TOOLS;
// The adapter opens a connector's page in the browser, whose opener this smoke keeps.
process.env.MCP_UI_VIEWER = "browser";

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const fakeCtx = { cwd: tempHome, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined, reload: async () => {} };

try {
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const board = { url: "https://board.example.test/mcp" };
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { board } }, null, 2));

	const settingsStore = await import("../src/persistent-room-mcp-settings.js");
	const choicesStore = await import("../src/connector-tool-choices.js");
	const { connectorAwayNote } = await import("../src/thread-items-by-id.js");
	const { createWebUiContext } = await import("../src/web-ui-context.js");
	const { createHeadlessUiContext } = await import("../src/persistent-room-background-execution.js");
	const { connectorPlacesReader, roomScopedMcpToolRegistration } = await import("../../../pi-package/extensions/mcp/room-scope.js");

	const room = "page-calls-room";
	settingsStore.writePersistentRoomMcpSettings(room, ["board"]);
	fs.writeFileSync(path.join(path.dirname(path.dirname(settingsStore.persistentRoomMcpSettingsPath(room))), "agent.json"), "{}");
	const choicesFile = path.join(agentDir, "mcp-tool-choices.json");
	const noChoices = () => fs.rmSync(choicesFile, { recursive: true, force: true });
	const choose = (tools: Record<string, "allow" | "ask" | "blocked">) => choicesStore.setConnectorToolChoices("board", Object.fromEntries(Object.entries(tools).map(([tool, choice]) => [tool, { choice, ...(choice === "allow" ? { where: choicesStore.connectorPin(board) } : {}) }])));

	// Who is there: a person at the room's bridge, holding each question for the row to answer; nobody expected to be asked; nobody there; a scheduled run.
	type Asked = { card: any; answer: (value: "once" | "room" | "decline") => void };
	const person = () => {
		const asked: Asked[] = [];
		const ui = createWebUiContext((frame: any) => {
			if (frame.type === "ui_request" && frame.kind === "connector" && !frame.again) asked.push({ card: frame, answer: (value) => ui.resolveResponse(frame.id, value, "computer") });
		}, undefined, "computer", { now: (() => { let at = 0; return () => (at += 60_000); })() });
		return { ctx: { ...fakeCtx, ui }, asked };
	};
	const nobodyAsked = () => {
		const asked: unknown[] = [];
		const ui = createWebUiContext((frame: any) => {
			if (frame.type !== "ui_request" || frame.kind !== "connector") return;
			asked.push(frame);
			ui.resolveResponse(frame.id, "decline", "computer");
		}, undefined, "computer");
		return { ctx: { ...fakeCtx, ui }, asked };
	};
	const away = () => {
		const ui = createWebUiContext(() => {});
		ui.detach("The user left the room.");
		return { ctx: { ...fakeCtx, ui } };
	};
	const askedYet = async (asked: Asked[], label: string) => {
		const deadline = Date.now() + 15_000;
		while (asked.length < 1) {
			if (Date.now() > deadline) throw new Error(`${label}: no question came`);
			await new Promise((resolve) => setImmediate(resolve));
		}
	};

	// The tools as the live connection lists them; `undefined` for one it doesn't list.
	const unmarked = {};
	const readOnly = { annotations: { readOnlyHint: true } };
	const forModelOnly = { annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["model"] } } };
	const forAppOnly = { annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["app"] } } };

	// The gate the room hands the adapter with a call, called as the adapter calls it for the page that call opened.
	const readPlaces = await connectorPlacesReader();
	const ran: string[] = [];
	const call = async (toolName: string, ctx: unknown, liveTool: unknown, { fromPage = true, asksNothing }: { fromPage?: boolean; asksNothing?: () => boolean } = {}) => {
		const places = readPlaces(undefined);
		let refusal: any;
		const standIn = await roomScopedMcpToolRegistration(room, { name: "mcp", asksBeforeConnectorCalls: true, execute: async (_id, _params, _signal, _onUpdate, gate: any) => {
			refusal = await gate({ server: "board", toolName, liveTool, resourceRead: false, args: { card: "Q4 plan" }, ...(fromPage ? { fromPage: true } : {}) });
			if (!refusal) ran.push(toolName);
			return refusal ?? { content: [{ type: "text", text: `ran ${toolName}` }] };
		} }, { connectedPlaces: () => places, ...(asksNothing ? { asksNothing } : {}) });
		const result: any = await standIn!.execute("smoke-page-call", { tool: toolName, server: "board" }, undefined, undefined, ctx);
		return { refusal, result };
	};
	const ranCount = (tool: string) => ran.filter((name) => name === tool).length;
	const refusedAs = (outcome: { refusal: any }, error: string, line: string, label: string) => {
		const { refusal } = outcome;
		assert(refusal?.isError === true && refusal.details?.error === error && refusal.details?.fromPage === true && refusal.content?.[0]?.text === line, `${label}: refused with "${line}", got ${JSON.stringify(refusal)}`);
	};

	// ── BLOCKED ──────────────────────────────────────────────────────────────
	choose({ delete_card: "blocked", create_card: "allow" });
	const blockedHere = nobodyAsked();
	refusedAs(await call("delete_card", blockedHere.ctx, unmarked), "connector_tool_blocked", "Didn't run: Delete card in board is blocked. You can change this in Settings, Connectors.", "a Blocked tool");
	refusedAs(await call("delete_card", person().ctx, readOnly), "connector_tool_blocked", "Didn't run: Delete card in board is blocked. You can change this in Settings, Connectors.", "a Blocked tool marked read-only");
	assert(blockedHere.asked.length === 0 && ranCount("delete_card") === 0, "a Blocked tool asks nothing and never reaches the connector");
	const allowedHere = nobodyAsked();
	assert(!(await call("create_card", allowedHere.ctx, unmarked)).refusal && allowedHere.asked.length === 0, "Always allow beside it runs with no question");
	assert(!(await call("list_cards", allowedHere.ctx, readOnly)).refusal && allowedHere.asked.length === 0, "a read-only tool with nothing chosen runs with no question");
	assert(ranCount("create_card") === 1 && ranCount("list_cards") === 1, `the tools beside it reached the connector, got ${JSON.stringify(ran)}`);
	noChoices();

	// ── ASKS ─────────────────────────────────────────────────────────────────
	const declining = person();
	const declined = call("move_card", declining.ctx, unmarked);
	await askedYet(declining.asked, "an unmarked tool from the page");
	assert(declining.asked[0].card.title === "Use Move card in board?" && declining.asked[0].card.lasting === true, `the page's call asks the room's question, Always allow offered, got ${JSON.stringify(declining.asked[0].card)}`);
	declining.asked[0].answer("decline");
	refusedAs(await declined, "connector_call_declined", "You declined this, so nothing changed in board.", "the person's No");
	const yes = person();
	const allowedOnce = call("move_card", yes.ctx, unmarked);
	await askedYet(yes.asked, "an unmarked tool from the page, again");
	yes.asked[0].answer("once");
	assert(!(await allowedOnce).refusal && ranCount("move_card") === 1, "Allow this time runs it");
	const asksNothingHere = nobodyAsked();
	assert(!(await call("move_card", asksNothingHere.ctx, unmarked, { asksNothing: () => true })).refusal && asksNothingHere.asked.length === 0, "in a room that asks nothing it runs with no question, as the assistant's call does");
	choose({ list_cards: "ask" });
	const askFirst = person();
	const askFirstCall = call("list_cards", askFirst.ctx, readOnly);
	await askedYet(askFirst.asked, "a read-only tool set to Ask first");
	askFirst.asked[0].answer("decline");
	refusedAs(await askFirstCall, "connector_call_declined", "You declined this, so nothing changed in board.", "a read-only tool set to Ask first asks");
	noChoices();

	// ── NOBODY ───────────────────────────────────────────────────────────────
	const before = ranCount("move_card");
	refusedAs(await call("move_card", away().ctx, unmarked), "connector_call_unanswered", connectorAwayNote("Move card in board"), "with nobody there");
	refusedAs(await call("move_card", { ...fakeCtx, ui: createHeadlessUiContext(undefined, () => {}) }, unmarked), "connector_call_unanswered", connectorAwayNote("Move card in board"), "in a scheduled run");
	refusedAs(await call("move_card", fakeCtx, unmarked), "connector_call_unanswered", connectorAwayNote("Move card in board"), "with no way to ask at all");
	assert(ranCount("move_card") === before, "nobody could be asked: it never reached the connector");

	// ── UNREAD ───────────────────────────────────────────────────────────────
	fs.writeFileSync(choicesFile, "{ not json");
	const unreadable = person();
	const unreadableCall = call("list_cards", unreadable.ctx, readOnly);
	await askedYet(unreadable.asked, "unreadable: a read-only tool");
	assert(unreadable.asked[0].card.lasting === false, "unreadable: no Always allow offered");
	unreadable.asked[0].answer("decline");
	refusedAs(await unreadableCall, "connector_call_declined", "You declined this, so nothing changed in board.", "unreadable: a read-only tool asks first");
	noChoices();

	// ── HIDDEN ───────────────────────────────────────────────────────────────
	const hidden = nobodyAsked();
	const ranBefore = ran.length;
	refusedAs(await call("list_cards", hidden.ctx, forModelOnly), "connector_page_tool_hidden", "Didn't run: List cards in board.", "a tool for the assistant only");
	refusedAs(await call("archive_board", hidden.ctx, undefined), "connector_page_tool_hidden", "Didn't run: Archive board in board.", "a tool the live connection doesn't list");
	assert(hidden.asked.length === 0 && ran.length === ranBefore, "neither asks nor reaches the connector");
	assert(!(await call("list_cards", hidden.ctx, forAppOnly)).refusal, "a tool for the page only runs");
	choose({ list_cards: "allow" });
	refusedAs(await call("list_cards", hidden.ctx, forModelOnly), "connector_page_tool_hidden", "Didn't run: List cards in board.", "Always allow doesn't open a tool for the assistant only to the page");
	noChoices();

	// ── STEP ─────────────────────────────────────────────────────────────────
	choose({ create_card: "allow" });
	const fromPage = await call("create_card", nobodyAsked().ctx, unmarked);
	const byAssistant = await call("create_card", nobodyAsked().ctx, unmarked, { fromPage: false });
	assert(!fromPage.refusal && fromPage.result.details?.use === undefined, `a page's call puts no words on the assistant's step, got ${JSON.stringify(fromPage.result)}`);
	assert(!byAssistant.refusal && byAssistant.result.details?.use === "Create card in board", `the assistant's own call on Always allow keeps its words, got ${JSON.stringify(byAssistant.result)}`);
	noChoices();

	// ── KEPT ─────────────────────────────────────────────────────────────────
	const keptPlaces = readPlaces(undefined);
	let kept: any;
	const opener = await roomScopedMcpToolRegistration(room, { name: "mcp", asksBeforeConnectorCalls: true, execute: async (_id, _params, _signal, _onUpdate, gate: any) => {
		kept = gate;
		return { content: [{ type: "text", text: "opened" }] };
	} }, { connectedPlaces: () => keptPlaces });
	await opener!.execute("smoke-page-open", { tool: "open_board", server: "board" }, undefined, undefined, nobodyAsked().ctx);
	const keptCall = async (toolName: string) => ({ refusal: await kept({ server: "board", toolName, liveTool: readOnly, resourceRead: false, args: {}, fromPage: true }) });
	assert(!(await keptCall("list_cards")).refusal, "kept: a read-only tool runs while the connector is on in the room");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { board: { ...board, excludeTools: ["list_cards"] } } }, null, 2));
	refusedAs(await keptCall("list_cards"), "connector_tool_withdrawn", "Didn't run: List cards in board.", "kept: a tool switched off since");
	assert(!(await keptCall("get_card")).refusal, "kept: the tool beside it still runs");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { board } }, null, 2));
	settingsStore.writePersistentRoomMcpSettings(room, []);
	refusedAs(await keptCall("list_cards"), "connector_not_enabled", "Didn't run: List cards in board.", "kept: the connector switched off in the room since");
	settingsStore.writePersistentRoomMcpSettings(room, ["board"]);
	assert(!(await keptCall("list_cards")).refusal, "kept: switched on again, it runs");

	// ── ADAPTER ──────────────────────────────────────────────────────────────
	// The same gate on the adapter's own page path: the room's assistant calls
	// show_board, whose tool carries a page; the adapter serves that page on this
	// computer and opens it (kept here), and the page posts as its host does,
	// its consent first, then its calls with the page's token.
	const PAGE_URI = "ui://board/view.html";
	const reached: string[] = [];
	const liveTools = [
		{ name: "show_board", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { resourceUri: PAGE_URI } } },
		{ name: "list_cards", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
		{ name: "count_cards", inputSchema: { type: "object" }, annotations: { readOnlyHint: true }, _meta: { ui: { visibility: ["model"] } } },
		{ name: "move_card", inputSchema: { type: "object" } },
		{ name: "delete_card", inputSchema: { type: "object" } },
	];
	const answerOf = (method: string, params: any): unknown => {
		if (method === "initialize") return { protocolVersion: params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "board-standin", version: "1.0.0" } };
		if (method === "tools/list") return { tools: liveTools };
		if (method === "resources/list") return { resources: [{ uri: PAGE_URI, name: "board", mimeType: "text/html;profile=mcp-app" }] };
		if (method === "resources/read") return { contents: [{ uri: PAGE_URI, mimeType: "text/html;profile=mcp-app", text: "<!doctype html><html><body>board</body></html>" }] };
		if (method === "tools/call") {
			reached.push(String(params?.name));
			return { content: [{ type: "text", text: `ran ${params?.name}` }] };
		}
		return {};
	};
	const connector = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			if (req.method !== "POST") return void res.writeHead(405).end();
			const message = JSON.parse(raw);
			if (message.id === undefined) return void res.writeHead(202).end();
			res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: answerOf(message.method, message.params) }));
		});
	});
	const pi: any = {
		tools: new Map<string, any>(),
		handlers: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
		registerTool(tool: any) { pi.tools.set(String(tool.name), tool); },
		registerCommand() {},
		registerFlag() {},
		getFlag() { return undefined; },
		getAllTools() { return [...pi.tools.values()]; },
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]); },
	};
	let pagePost: ((route: string, params: unknown) => Promise<any>) | undefined;
	await new Promise<void>((resolve) => connector.listen(0, "127.0.0.1", resolve));
	try {
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { board: { url: `http://127.0.0.1:${(connector.address() as AddressInfo).port}/mcp` } } }, null, 2));
		choose({ delete_card: "blocked" });
		const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");
		await createRoomScopedMcpExtension(room)(pi);
		for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, fakeCtx);

		const inRoom = person();
		await pi.tools.get("mcp").execute("smoke-show-board", { tool: "board_show_board", server: "board" }, undefined, undefined, inRoom.ctx);
		// The page's link, with its session, is the one link the platform's opener gets.
		const pageUrl = openerStarts.length === 1 ? openerStarts[0].args.at(-1) : undefined;
		const opensPage = pageUrl?.includes("session=") && JSON.stringify(openerStarts[0]) === JSON.stringify({ program: systemOpener.program, args: [...systemOpener.before, pageUrl], kept: true });
		assert(reached.includes("show_board") && pageUrl && opensPage, `adapter: the assistant's call runs and the adapter opens its page with ${systemOpener.program}, the link one argument, got ${JSON.stringify({ reached, openerStarts })}`);
		const page = new URL(pageUrl);
		const post = pagePost = async (route: string, params: unknown) => {
			const response = await fetch(`http://127.0.0.1:${page.port}${route}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: page.searchParams.get("session"), params }) });
			return response.json();
		};
		const textOf = (reply: any) => String(reply?.result?.content?.[0]?.text ?? reply?.error ?? "");
		// The page's host posts this after the browser's dialog; a page could post it itself.
		await post("/proxy/ui/consent", { approved: true });

		// Every miss is kept, so a page that skips the gate shows each tool it reached.
		const misses: string[] = [];
		const blocked = await post("/proxy/tools/call", { name: "delete_card", arguments: {} });
		if (reached.includes("delete_card")) misses.push("a Blocked tool called from the page reached the connector");
		if (blocked?.result?.isError !== true || textOf(blocked) !== "Didn't run: Delete card in board is blocked. You can change this in Settings, Connectors.") misses.push(`the page didn't get the Blocked line, got ${JSON.stringify(blocked)}`);

		const asking = post("/proxy/tools/call", { name: "move_card", arguments: { card: "Q4 plan" } });
		const first = await Promise.race([asking.then((reply) => ({ reply })), askedYet(inRoom.asked, "adapter: an unmarked tool from the page").then(() => ({ asked: true }))]);
		if ("reply" in first) {
			misses.push(`a tool that asks ran from the page with no question, got ${JSON.stringify(first.reply)}`);
		} else {
			if (inRoom.asked[0].card.title !== "Use Move card in board?") misses.push(`the page's call asked another question, got ${JSON.stringify(inRoom.asked[0].card)}`);
			inRoom.asked[0].answer("decline");
			const declined = await asking;
			if (declined?.result?.isError !== true || textOf(declined) !== "You declined this, so nothing changed in board.") misses.push(`the page didn't get the No's line, got ${JSON.stringify(declined)}`);
		}
		if (reached.includes("move_card")) misses.push("a tool the person said No to, or was never asked about, reached the connector");

		// The adapter's live tool keeps its _meta, so a tool for the assistant only is refused to the page.
		const forAssistant = await post("/proxy/tools/call", { name: "count_cards", arguments: {} });
		if (reached.includes("count_cards")) misses.push("a tool for the assistant only, called from the page, reached the connector");
		if (forAssistant?.result?.isError !== true || textOf(forAssistant) !== "Didn't run: Count cards in board.") misses.push(`the page didn't get the line for a tool it may not call, got ${JSON.stringify(forAssistant)}`);

		const listed = await post("/proxy/tools/call", { name: "list_cards", arguments: {} });
		if (!reached.includes("list_cards") || textOf(listed) !== "ran list_cards") misses.push(`a read-only tool with nothing chosen didn't run from the page, got ${JSON.stringify(listed)}`);
		assert(misses.length === 0, `adapter: ${misses.join("; ")}`);
	} finally {
		await pagePost?.("/proxy/ui/complete", { reason: "done" }).catch(() => undefined);
		for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, fakeCtx);
		connector.close();
		noChoices();
	}

	assert(openerStarts.every((start) => start.kept), `the opener never starts for real, got ${JSON.stringify(openerStarts)}`);
	console.log(`  ok  opener: starts kept ${openerStarts.length}, reached the system 0`);
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	console.log("connector-page-calls-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
}
