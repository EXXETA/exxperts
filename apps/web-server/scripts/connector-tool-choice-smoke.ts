// Each connector tool's choice, Always allow, Ask first or Blocked, as the
// connector's page saves it and the room's gate reads it, driven through the
// REAL exxperts mcp extension and the REAL pi-mcp-adapter against a real
// connector that counts what reaches it:
//
//  BLOCKED - refused with no question in every room and with nobody there:
//            a read-only tool, a resource read, a room that asks nothing, a
//            scheduled run (no note), a phone; each beside a tool that runs.
//  ALLOW   - an unmarked tool, a destructive one and a program's tool run with
//            no question, live, after the person left and in a scheduled run,
//            while the connector is still where it was when allowed.
//  ASK     - a saved Ask first asks for a read-only tool, and over an old room
//            yes; a room that asks nothing runs it.
//  OLD YES - a room yes kept from before counts in its room only, until a
//            choice is picked, which clears it in every room; the gate ignores
//            it even where that clearing failed.
//  PIN     - a moved address, or a program's changed command, arguments,
//            folder or settings, stop an Always allow; the app's address
//            change clears it, and Blocked and Ask first stay.
//  REMOVE  - removing a connector clears its choices; a clearing that fails
//            removes nothing.
//  UNREAD  - a choices file that can't be read: every tool asks, nothing is
//            written over it, and the status says so, and why. A removal is
//            refused with what to do first; Reset choices sets the file aside
//            beside itself and starts again with nothing chosen. A file a
//            newer version wrote is never reset.
//  ROUTE   - PUT /api/mcp/servers/:name/tools: 404, 400, 409, a phone's refusal;
//            a phone can't reset the choices either.
//  SHARED  - a shared server reads no choices file: the gate, the status, a
//            save and a scheduled run's answers are as on main. A schedule
//            runs through the room's live session only there (room-socket.ts
//            makes a room host only on a shared server), so no choice reaches
//            that path either.
//
// Offline, isolated HOME + agent dir + agents root, set before any import that reads them.
// Run: npm run smokes -- connector-tool-choice
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { markedConnector } from "./smoke-marked-connector.js";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-tool-choice-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-tool-choice-root-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
delete process.env.MCP_DIRECT_TOOLS;

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

const connector = markedConnector();

interface FakePi {
	tools: Map<string, any>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
}

function makeFakePi(): FakePi & Record<string, unknown> {
	const pi = {
		tools: new Map<string, any>(),
		handlers: new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>(),
		flags: new Map<string, unknown>(),
		registerTool(tool: any) { pi.tools.set(String(tool.name), tool); },
		registerCommand() {},
		registerFlag() {},
		getFlag(name: string) { return pi.flags.get(name); },
		getAllTools() { return [...pi.tools.values()]; },
		sendMessage() {},
		on(event: string, handler: (event: unknown, ctx: unknown) => unknown) { pi.handlers.set(event, [...(pi.handlers.get(event) ?? []), handler]); },
	};
	return pi;
}

const fakeCtx = { cwd: tempHome, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined, reload: async () => {} };
const startSession = async (pi: FakePi) => { for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, fakeCtx); };
const shutdownSession = async (pi: FakePi) => { for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, fakeCtx); };

try {
	await new Promise<void>((resolve) => connector.server.listen(0, "127.0.0.1", resolve));
	await connector.proxyHere();
	connector.tools = [
		{ name: "list_projects", annotations: { readOnlyHint: true } },
		{ name: "get_project", annotations: { readOnlyHint: true } },
		{ name: "delete_project" },
		{ name: "create_note" },
		{ name: "drop_board", annotations: { destructiveHint: true } },
	];
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const asana = { url: connector.webUrl() };
	const program = { command: process.execPath, args: ["-e", ""] };
	const writeConfig = (servers: Record<string, unknown>) => fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
	writeConfig({ asana, local: program });
	const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);
	const savedTools = connector.tools.map(({ name, annotations }) => ({ name, description: name, ...(annotations ? { annotations } : {}) }));
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({ version: 1, servers: {
		asana: { configHash: cacheMod.computeServerHash(asana), cachedAt: Date.now(), resources: [{ uri: "smoke://notes", name: "notes" }], tools: savedTools },
		local: { configHash: cacheMod.computeServerHash(program), cachedAt: Date.now(), resources: [], tools: [{ name: "write_file", description: "write_file" }] },
	} }, null, 2));

	const settingsStore = await import("../src/persistent-room-mcp-settings.js");
	const choicesStore = await import("../src/connector-tool-choices.js");
	const { createWebUiContext } = await import("../src/web-ui-context.js");
	const { createHeadlessUiContext } = await import("../src/persistent-room-background-execution.js");
	const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");
	const { connectorPlacesReader, roomScopedMcpToolRegistration } = await import("../../../pi-package/extensions/mcp/room-scope.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_REQUEST_LINES } = await import("../src/connector-form.js");
	const { changeMcpServerAddress, removeMcpServer } = await import("../src/mcp-admin.js");
	await import("../src/mcp-routes.js");
	const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
	app.log.level = "silent";

	// Two rooms with the connector on, each marked as a room so the sweeps reach it.
	const roomA = "tool-choice-room-a";
	const roomB = "tool-choice-room-b";
	for (const room of [roomA, roomB]) {
		settingsStore.writePersistentRoomMcpSettings(room, ["asana", "local"]);
		fs.writeFileSync(path.join(path.dirname(path.dirname(settingsStore.persistentRoomMcpSettingsPath(room))), "agent.json"), "{}");
	}
	const choicesFile = path.join(agentDir, "mcp-tool-choices.json");
	const noChoices = () => fs.rmSync(choicesFile, { recursive: true, force: true });
	/** A connector's choices as the file holds them now, by tool name in order. */
	const choicesOf = (name: string) => {
		const read = choicesStore.readConnectorToolChoices();
		return read.readable ? Object.fromEntries(Object.entries(choicesStore.toolChoicesShown(choicesStore.connectorChoicesIn(read, name))).sort(([a], [b]) => a.localeCompare(b))) : "unreadable";
	};
	const webPin = () => settingsStore.connectorAddressPin(connector.webUrl());
	const roomYes = (room: string, tool: string) => assert(settingsStore.allowPersistentRoomMcpTool(room, "asana", tool, webPin()), `the old room yes for ${tool} is seeded in ${room}`);
	const roomYeses = (room: string) => (settingsStore.readPersistentRoomMcpSettings(room).allowedTools.asana ?? []).map((entry: { tool: string }) => entry.tool);

	// The page's save, as the page sends it: the identity from the status answer, unless a row names another.
	const statusOf = async (name: string) => (await getMcpConnectorsStatus()).servers.find((server: { name: string }) => server.name === name) as any;
	const save = async (name: string, tools: Record<string, unknown>, identity?: string) => {
		const answer = await app.inject({ method: "PUT", url: `/api/mcp/servers/${encodeURIComponent(name)}/tools`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, payload: { tools, identity: identity ?? (await statusOf(name))?.identity } });
		return { status: answer.statusCode, body: answer.json() };
	};
	const saved = async (name: string, tools: Record<string, unknown>) => {
		const answer = await save(name, tools);
		assert(answer.status === 200, `the page saves ${JSON.stringify(tools)}, got ${answer.status} ${JSON.stringify(answer.body)}`);
	};

	// Who is there: a person at the room's real bridge, holding each question for the row to answer; nobody expected to be asked;
	// nobody there at all; and a scheduled run's own answerer. Each counts its questions and the notes left for them.
	type Asked = { card: any; answer: (value: "once" | "room" | "decline") => void };
	const person = (from: "computer" | "phone" = "computer") => {
		const asked: Asked[] = [];
		const ui = createWebUiContext((frame: any) => {
			if (frame.type === "ui_request" && frame.kind === "connector" && !frame.again) asked.push({ card: frame, answer: (value) => ui.resolveResponse(frame.id, value, from) });
		}, undefined, from, { now: (() => { let at = 0; return () => (at += 60_000); })() });
		return { ctx: { ...fakeCtx, ui }, asked };
	};
	const nobodyAsked = (from: "computer" | "phone" = "computer") => {
		const asked: Asked[] = [];
		const ui = createWebUiContext((frame: any) => {
			if (frame.type !== "ui_request" || frame.kind !== "connector") return;
			asked.push({ card: frame, answer: () => {} });
			ui.resolveResponse(frame.id, "decline", from);
		}, undefined, from);
		return { ctx: { ...fakeCtx, ui }, asked };
	};
	const away = () => {
		const notes: Array<{ title: string; lasting?: boolean }> = [];
		const ui = createWebUiContext(() => {}, (question: { title: string; lasting?: boolean }) => notes.push(question));
		ui.detach("The user left the room.");
		return { ctx: { ...fakeCtx, ui }, notes };
	};
	const scheduled = () => {
		const notes: Array<{ title: string; lasting?: boolean }> = [];
		return { ctx: { ...fakeCtx, ui: createHeadlessUiContext(undefined, (question) => notes.push(question)) }, notes };
	};
	const askedYet = async (asked: Asked[], label: string) => {
		const deadline = Date.now() + 15_000;
		while (asked.length < 1) {
			if (Date.now() > deadline) throw new Error(`${label}: no question came`);
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	const textOf = (result: any) => String(result?.content?.[0]?.text ?? "");
	const errorOf = (result: any) => result?.details?.error;
	const callsOf = (name: string) => connector.called.filter((called) => called === name).length;

	// The real proxy in each room, and in room A as a live conversation in a room that asks nothing.
	const session = async (room: string, options: { asksNothing?: () => boolean } = {}) => {
		const pi = makeFakePi();
		await createRoomScopedMcpExtension(room, options)(pi);
		await startSession(pi);
		return pi;
	};
	const piA = await session(roomA);
	const piB = await session(roomB);
	const piQuiet = await session(roomA, { asksNothing: () => true });
	const use = (pi: FakePi, ctx: unknown, tool: string) => pi.tools.get("mcp").execute("smoke-choice", { tool: `asana_${tool}`, server: "asana" }, undefined, undefined, ctx);
	/** A call that asks: declined, and its card is returned. */
	const asks = async (pi: FakePi, tool: string, label: string) => {
		const at = person();
		const calling = use(pi, at.ctx, tool);
		await askedYet(at.asked, label);
		at.asked[0].answer("decline");
		assert(errorOf(await calling) === "connector_call_declined", `${label}: declined`);
		return at.asked[0].card;
	};
	/** A call that runs with no question. */
	const runs = async (pi: FakePi, tool: string, label: string, ctx: unknown = nobodyAsked().ctx) => {
		const result = await use(pi, ctx, tool);
		assert(textOf(result) === `ran ${tool}` || textOf(result) === "the notes", `${label}: runs, got ${JSON.stringify(result)}`);
	};

	// The gate as the adapter calls it, in a session connected from the settings as they are now; `ran` counts what passed.
	// `liveTool` undefined: the live connection doesn't list the tool, though the saved list may.
	const readPlaces = await connectorPlacesReader();
	const ran = new Map<string, number>();
	const gateCall = async (server: string, toolName: string, ctx: unknown, liveTool: unknown) => {
		const places = readPlaces(undefined);
		const standIn = await roomScopedMcpToolRegistration(roomA, { name: "mcp", asksBeforeConnectorCalls: true, execute: async (_id, _params, _signal, _onUpdate, gate: any) => (await gate({ server, toolName, liveTool, resourceRead: false, args: {} })) ?? (ran.set(toolName, (ran.get(toolName) ?? 0) + 1), { content: [{ type: "text", text: "ran" }] }) }, { connectedPlaces: () => places });
		return standIn!.execute("smoke-gate", { tool: toolName, server }, undefined, undefined, ctx);
	};
	const programCall = (ctx: unknown, liveTool: unknown = {}) => gateCall("local", "write_file", ctx, liveTool);

	// ── BLOCKED ──────────────────────────────────────────────────────────────
	await saved("asana", { list_projects: "blocked", get_notes: "blocked", delete_project: "blocked" });
	assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ delete_project: "blocked", get_notes: "blocked", list_projects: "blocked" }), `the choices are kept, got ${JSON.stringify(choicesOf("asana"))}`);
	const readsBefore = connector.resourceReads();
	for (const [label, at] of [["at the computer", nobodyAsked()], ["from a phone", nobodyAsked("phone")]] as const) {
		for (const tool of ["list_projects", "get_notes", "delete_project"]) {
			const result = await use(piA, at.ctx, tool);
			assert(errorOf(result) === "connector_tool_blocked" && result.isError === true && typeof result.details.use === "string" && at.asked.length === 0, `${label}: ${tool} is blocked with no question, got ${JSON.stringify(result)}`);
		}
		await runs(piA, "get_project", `${label}: a read-only tool beside it`, at.ctx);
	}
	const blockedQuiet = nobodyAsked();
	assert(errorOf(await use(piQuiet, blockedQuiet.ctx, "delete_project")) === "connector_tool_blocked" && blockedQuiet.asked.length === 0, "in a room that asks nothing a blocked tool is refused");
	await runs(piQuiet, "create_note", "in a room that asks nothing, an unmarked tool beside it");
	const blockedRun = scheduled();
	assert(errorOf(await use(piA, blockedRun.ctx, "delete_project")) === "connector_tool_blocked", "a scheduled run refuses a blocked tool");
	await runs(piA, "get_project", "a scheduled run: a read-only tool beside it", blockedRun.ctx);
	assert(errorOf(await use(piA, blockedRun.ctx, "create_note")) === "connector_call_unanswered", "a scheduled run: an unmarked tool beside it is refused as on main");
	assert(JSON.stringify(blockedRun.notes.map((note) => note.title)) === JSON.stringify(["Use Create note in Asana?"]), `a scheduled run leaves a note for the question only, none for the blocked tool, got ${JSON.stringify(blockedRun.notes)}`);
	const blockedAway = away();
	assert(errorOf(await use(piA, blockedAway.ctx, "delete_project")) === "connector_tool_blocked" && blockedAway.notes.length === 0, "with nobody there a blocked tool is refused with no note");
	assert(callsOf("list_projects") === 0 && callsOf("delete_project") === 0 && connector.resourceReads() === readsBefore, `a blocked tool never reaches the connector, got ${JSON.stringify(connector.called)}, ${connector.resourceReads() - readsBefore} reads`);
	assert(callsOf("get_project") === 3 && callsOf("create_note") === 1, `the tools beside it did, got ${JSON.stringify(connector.called)}`);
	await saved("asana", { list_projects: null, get_notes: null, delete_project: null });
	await runs(piA, "list_projects", "Use default: a read-only tool runs again");
	await runs(piA, "get_notes", "Use default: a resource read runs again");
	assert(JSON.stringify(choicesOf("asana")) === "{}", "Use default leaves nothing chosen");

	// ── ALLOW ────────────────────────────────────────────────────────────────
	// The page's Always allow for an unmarked and a destructive tool, the question's for a program's tool.
	await saved("asana", { delete_project: "allow", drop_board: "allow" });
	const programAsked = person();
	const programAsking = programCall(programAsked.ctx);
	await askedYet(programAsked.asked, "a program's tool");
	assert(programAsked.asked[0].card.lasting === true, "a program's tool offers Always allow");
	programAsked.asked[0].answer("room");
	assert(textOf(await programAsking) === "ran" && JSON.stringify(choicesOf("local")) === JSON.stringify({ write_file: "allow" }), `Always allow on a program's tool is kept, got ${JSON.stringify(choicesOf("local"))}`);
	for (const [label, who] of [["live", () => ({ ...nobodyAsked(), notes: [] as unknown[] })], ["after the person left", away], ["in a scheduled run", scheduled]] as const) {
		const there = who();
		for (const tool of ["delete_project", "drop_board"]) await runs(piA, tool, `${label}: ${tool} on Always allow`, there.ctx);
		assert(textOf(await programCall(there.ctx)) === "ran", `${label}: the program's tool on Always allow runs`);
		assert(there.notes.length === 0, `${label}: no note, got ${JSON.stringify(there.notes)}`);
	}
	await runs(piB, "delete_project", "in another room where the connector is on");
	assert(callsOf("delete_project") === 4 && callsOf("drop_board") === 3 && ran.get("write_file") === 4, `each reached its connector, got ${JSON.stringify(connector.called)}, program ${ran.get("write_file")}`);

	// ── PIN ──────────────────────────────────────────────────────────────────
	// A program: each of what selects it stops its Always allow; put back, it counts again.
	for (const [label, changed] of [["command", { ...program, command: "node" }], ["arguments", { ...program, args: ["-e", "1"] }], ["working folder", { ...program, cwd: tempHome }], ["settings", { ...program, env: { SMOKE: "1" } }]] as const) {
		writeConfig({ asana, local: changed });
		const moved = person();
		const movedCall = programCall(moved.ctx);
		await askedYet(moved.asked, `a program's changed ${label}`);
		moved.asked[0].answer("decline");
		assert(errorOf(await movedCall) === "connector_call_declined", `a program's changed ${label}: its Always allow stops counting`);
	}
	writeConfig({ asana, local: program });
	assert(textOf(await programCall(nobodyAsked().ctx)) === "ran", "put back, the program's Always allow counts again");
	// A tool read-only when allowed asks once the live connection marks it otherwise.
	await saved("asana", { get_project: "allow" });
	await runs(piA, "get_project", "allowed while read-only");
	const markedLater = person();
	connector.tools = connector.tools.map((tool) => (tool.name === "get_project" ? { name: "get_project" } : tool));
	const piMarkedLater = await session(roomA);
	const markedLaterCall = use(piMarkedLater, markedLater.ctx, "get_project");
	await askedYet(markedLater.asked, "no longer read-only");
	markedLater.asked[0].answer("decline");
	assert(errorOf(await markedLaterCall) === "connector_call_declined", "allowed while read-only, it asks once it no longer is");
	await shutdownSession(piMarkedLater);
	connector.tools = connector.tools.map((tool) => (tool.name === "get_project" ? { name: "get_project", annotations: { readOnlyHint: true } } : tool));
	// A web connector moved in the app: its Always allows go, Blocked and Ask first stay.
	await saved("asana", { create_note: "ask", drop_board: "blocked" });
	assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ create_note: "ask", delete_project: "allow", drop_board: "blocked", get_project: "allow" }), `before the move, got ${JSON.stringify(choicesOf("asana"))}`);
	await changeMcpServerAddress("asana", { url: connector.webUrl("/mcp-moved") });
	assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ create_note: "ask", drop_board: "blocked" }), `moved, its Always allows go and the rest stay, got ${JSON.stringify(choicesOf("asana"))}`);
	writeConfig({ asana, local: program });
	// Moved by hand, outside the app: the pin alone stops it.
	await saved("asana", { delete_project: "allow", get_notes: "allow" });
	// Where it was given, a resource read's Always allow runs, live and in a scheduled run, with no note.
	const piUnmoved = await session(roomA);
	const readsUnmoved = connector.resourceReads();
	for (const [label, who] of [["live", () => ({ ...nobodyAsked(), notes: [] as unknown[] })], ["in a scheduled run", scheduled]] as const) {
		const there = who();
		await runs(piUnmoved, "get_notes", `${label}: a resource read on Always allow`, there.ctx);
		assert(there.notes.length === 0, `${label}: a resource read on Always allow leaves no note, got ${JSON.stringify(there.notes)}`);
	}
	assert(connector.resourceReads() === readsUnmoved + 2, `a resource read on Always allow reached the connector twice, got ${connector.resourceReads() - readsUnmoved}`);
	await shutdownSession(piUnmoved);
	writeConfig({ asana: { url: connector.webUrl("/mcp-by-hand") }, local: program });
	const piMoved = await session(roomA);
	assert((await asks(piMoved, "delete_project", "moved by hand")).lasting === true, "moved by hand, the Always allow given for the old address asks");
	assert((await asks(piMoved, "get_notes", "moved by hand, a resource read's Always allow given for the old address asks")).lasting === true, "moved by hand, a resource read's question offers Always allow again");
	await shutdownSession(piMoved);
	writeConfig({ asana, local: program });
	noChoices();

	// ── ASK ──────────────────────────────────────────────────────────────────
	await saved("asana", { list_projects: "ask" });
	await asks(piA, "list_projects", "a saved Ask first on a read-only tool");
	await runs(piQuiet, "list_projects", "a saved Ask first in a room that asks nothing");
	roomYes(roomA, "list_projects");
	await asks(piA, "list_projects", "a saved Ask first over an old room yes");
	settingsStore.forgetPersistentRoomMcpTool(roomA, "asana", "list_projects");
	noChoices();
	// A tool the live connection doesn't list, though the saved list still may: the page can't show a choice for it, so the question offers none.
	const unlisted = person();
	const unlistedCall = gateCall("asana", "archive_board", unlisted.ctx, undefined);
	await askedYet(unlisted.asked, "a tool the live connection doesn't list");
	assert(unlisted.asked[0].card.lasting === false, "a tool the live connection doesn't list: no Always allow offered");
	unlisted.asked[0].answer("room");
	assert(textOf(await unlistedCall) === "ran" && JSON.stringify(choicesOf("asana")) === "{}", `a tool the live connection doesn't list: an Always allow sent anyway counts this time and stores nothing, got ${JSON.stringify(choicesOf("asana"))}`);
	// One stored before it left the list stays, counts for nothing while it is gone, and counts again when it comes back. Blocked still refuses.
	await saved("asana", { archive_board: "allow" });
	const unlistedAllowed = person();
	const unlistedAllowedCall = gateCall("asana", "archive_board", unlistedAllowed.ctx, undefined);
	await askedYet(unlistedAllowed.asked, "a stored Always allow for a tool no longer listed");
	unlistedAllowed.asked[0].answer("decline");
	assert(errorOf(await unlistedAllowedCall) === "connector_call_declined" && JSON.stringify(choicesOf("asana")) === JSON.stringify({ archive_board: "allow" }), "a stored Always allow for a tool no longer listed asks, and stays stored");
	assert(textOf(await gateCall("asana", "archive_board", nobodyAsked().ctx, {})) === "ran", "listed again, its Always allow counts again");
	await saved("asana", { archive_board: "blocked" });
	assert(errorOf(await gateCall("asana", "archive_board", nobodyAsked().ctx, undefined)) === "connector_tool_blocked", "a Blocked tool no longer listed is still refused");
	noChoices();

	// ── OLD YES ──────────────────────────────────────────────────────────────
	roomYes(roomA, "create_note");
	roomYes(roomB, "create_note");
	await runs(piA, "create_note", "an old room yes in its room");
	settingsStore.forgetPersistentRoomMcpTool(roomB, "asana", "create_note");
	await asks(piB, "create_note", "an old room yes asks in another room");
	roomYes(roomB, "create_note");
	await saved("asana", { create_note: "ask" });
	assert(roomYeses(roomA).length === 0 && roomYeses(roomB).length === 0, `a pick clears the old yes in every room, got ${JSON.stringify([roomYeses(roomA), roomYeses(roomB)])}`);
	noChoices();
	// The clearing made to fail: the room's folder takes no write, the yes stays on disk, and the gate ignores it.
	// A folder's refusal can be forced only off Windows and not as root.
	const canForceFsRefusal = process.platform !== "win32" && process.getuid?.() !== 0;
	if (canForceFsRefusal) {
		roomYes(roomA, "create_note");
		const roomFolder = path.dirname(settingsStore.persistentRoomMcpSettingsPath(roomA));
		fs.chmodSync(roomFolder, 0o500);
		try {
			await saved("asana", { create_note: "blocked" });
			assert(roomYeses(roomA).includes("create_note"), "the clearing failed: the old yes is still on disk");
			assert(errorOf(await use(piA, nobodyAsked().ctx, "create_note")) === "connector_tool_blocked", "the gate ignores an old yes once a choice is stored");
			await saved("asana", { create_note: "ask" });
			await asks(piA, "create_note", "Ask first over an old yes the clearing missed");
		} finally {
			fs.chmodSync(roomFolder, 0o700);
		}
		settingsStore.forgetPersistentRoomMcpTool(roomA, "asana", "create_note");
		noChoices();
		// The rooms folder can be gone through but not listed, so no clearing can start: a pick is saved and answered as saved,
		// and an Always allow answered on the question is kept and the call runs.
		const roomsRoot = path.dirname(path.dirname(roomFolder));
		const roomsRootMode = fs.statSync(roomsRoot).mode & 0o777;
		fs.chmodSync(roomsRoot, 0o311);
		try {
			await saved("asana", { create_note: "blocked" });
			assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ create_note: "blocked" }), `rooms folder not listable: the pick is saved, got ${JSON.stringify(choicesOf("asana"))}`);
			await saved("asana", { create_note: null });
			const unlisted = person();
			const calling = use(piA, unlisted.ctx, "create_note");
			await askedYet(unlisted.asked, "rooms folder not listable");
			unlisted.asked[0].answer("room");
			const result = await calling;
			assert(textOf(result) === "ran create_note" && JSON.stringify(choicesOf("asana")) === JSON.stringify({ create_note: "allow" }), `rooms folder not listable: Always allow is kept and the call runs, got ${JSON.stringify(result)}, ${JSON.stringify(choicesOf("asana"))}`);
		} finally {
			fs.chmodSync(roomsRoot, roomsRootMode);
		}
	}
	noChoices();

	// ── WAITED ───────────────────────────────────────────────────────────────
	// Blocked on the page while its question waited: Always allow then counts as this time, the call is refused, and the block stays.
	const waitedBefore = callsOf("create_note");
	const waited = person();
	const waitedCall = use(piA, waited.ctx, "create_note");
	await askedYet(waited.asked, "blocked while its question waited");
	await saved("asana", { create_note: "blocked" });
	waited.asked[0].answer("room");
	assert(errorOf(await waitedCall) === "connector_tool_blocked" && callsOf("create_note") === waitedBefore, `blocked while its question waited: refused, got ${JSON.stringify(connector.called)}`);
	assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ create_note: "blocked" }), `blocked while its question waited: the block stays, got ${JSON.stringify(choicesOf("asana"))}`);
	noChoices();
	// The question's Always allow takes that tool's old room yeses back too, so Use default later brings none back.
	roomYes(roomB, "create_note");
	const always = person();
	const alwaysCall = use(piA, always.ctx, "create_note");
	await askedYet(always.asked, "the question's Always allow");
	always.asked[0].answer("room");
	assert(textOf(await alwaysCall) === "ran create_note" && roomYeses(roomB).length === 0, `the question's Always allow clears the old yes in every room, got ${JSON.stringify(roomYeses(roomB))}`);
	await saved("asana", { create_note: null });
	await asks(piB, "create_note", "Use default after the question's Always allow: the old yes in another room is gone");
	noChoices();

	// ── UNREAD ───────────────────────────────────────────────────────────────
	const garbage = "{ not json";
	fs.writeFileSync(choicesFile, garbage);
	const unreadableCard = await asks(piA, "list_projects", "unreadable: a read-only tool");
	assert(unreadableCard.lasting === false, "unreadable: no Always allow offered");
	await asks(piA, "get_notes", "unreadable: a resource read");
	await asks(piQuiet, "create_note", "unreadable: a room that asks nothing");
	roomYes(roomA, "create_note");
	await asks(piA, "create_note", "unreadable: an old room yes");
	settingsStore.forgetPersistentRoomMcpTool(roomA, "asana", "create_note");
	const sentAnyway = person();
	const sentAnywayCall = use(piA, sentAnyway.ctx, "delete_project");
	await askedYet(sentAnyway.asked, "unreadable: Always allow sent anyway");
	sentAnyway.asked[0].answer("room");
	assert(textOf(await sentAnywayCall) === "ran delete_project", "unreadable: Always allow sent anyway counts this time");
	const unreadableSave = await save("asana", { delete_project: "blocked" });
	assert(unreadableSave.status === 500 && fs.readFileSync(choicesFile, "utf-8") === garbage, `unreadable: nothing is written over it, got ${unreadableSave.status}`);
	const unreadableStatus = await statusOf("asana");
	assert(unreadableStatus.choicesUnreadable === "cannot-read" && !("choices" in unreadableStatus), `unreadable: the status says so, got ${JSON.stringify(unreadableStatus)}`);
	// A removal while they can't be read: refused with what to do first, and nothing removed.
	const remove = async (name: string) => {
		const answer = await app.inject({ method: "DELETE", url: `/api/mcp/servers/${encodeURIComponent(name)}`, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN } });
		return { status: answer.statusCode, body: answer.json() };
	};
	const stillThere = () => Boolean(JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8")).mcpServers.asana) && settingsStore.readPersistentRoomMcpSettings(roomA).grantedConnectors.includes("asana") && settingsStore.readPersistentRoomMcpSettings(roomB).grantedConnectors.includes("asana");
	const unreadableRemoval = await remove("asana");
	assert(unreadableRemoval.status === 409 && unreadableRemoval.body.error === CONNECTOR_REQUEST_LINES.removeChoicesUnreadable["cannot-read"] && stillThere() && fs.readFileSync(choicesFile, "utf-8") === garbage, `unreadable: a removal is refused with what to do first, and nothing is removed, got ${JSON.stringify(unreadableRemoval)}`);
	// Reset choices: the file is set aside beside itself, kept as it was, and nothing is chosen any more.
	const reset = async () => {
		const answer = await app.inject({ method: "POST", url: "/api/mcp/tool-choices/reset", headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN } });
		return { status: answer.statusCode, body: answer.json() };
	};
	const setAside = () => fs.readdirSync(agentDir).filter((name) => name.startsWith("mcp-tool-choices.json.unreadable-")).sort();
	const resetDone = await reset();
	assert(resetDone.status === 200 && !fs.existsSync(choicesFile) && setAside().length === 1 && fs.readFileSync(path.join(agentDir, setAside()[0]), "utf-8") === garbage, `Reset choices sets the file aside, kept as it was, got ${JSON.stringify(resetDone)}, ${JSON.stringify(setAside())}`);
	const afterReset = await statusOf("asana");
	assert(!("choicesUnreadable" in afterReset) && JSON.stringify(afterReset.choices) === "{}", `after the reset nothing is chosen, got ${JSON.stringify(afterReset)}`);
	await runs(piA, "list_projects", "after the reset a read-only tool runs again");
	await saved("asana", { delete_project: "blocked" });
	noChoices();
	const readableReset = await reset();
	assert(readableReset.status === 409 && readableReset.body.error === CONNECTOR_REQUEST_LINES.choicesReadableAgain && setAside().length === 1, `Reset choices with choices that can be read: refused, nothing set aside, got ${JSON.stringify(readableReset)}`);
	// A second reset sets its file aside under a name of its own: an earlier one is never written over.
	fs.writeFileSync(choicesFile, "second");
	assert((await reset()).status === 200 && setAside().length === 2 && setAside().some((name) => fs.readFileSync(path.join(agentDir, name), "utf-8") === garbage), `a second reset keeps the first file, got ${JSON.stringify(setAside())}`);
	// A clearing that fails removes nothing: the agent folder takes no write, so its choices can't be cleared, and the rooms get it back.
	if (canForceFsRefusal) {
		noChoices();
		await saved("asana", { delete_project: "blocked" });
		const choicesBefore = fs.readFileSync(choicesFile, "utf-8");
		const configBefore = fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8");
		const agentDirMode = fs.statSync(agentDir).mode & 0o777;
		fs.chmodSync(agentDir, 0o500);
		let clearingFailed: Awaited<ReturnType<typeof remove>>;
		try {
			clearingFailed = await remove("asana");
		} finally {
			fs.chmodSync(agentDir, agentDirMode);
		}
		assert(clearingFailed.status === 500 && stillThere() && fs.readFileSync(choicesFile, "utf-8") === choicesBefore && fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8") === configBefore, `a clearing that fails removes nothing, and both rooms keep it, got ${JSON.stringify(clearingFailed)}`);
		noChoices();
	}
	// A file a newer version wrote: every tool asks, a removal says to update first, and it is never reset.
	const newer = JSON.stringify({ schemaVersion: 2, connectors: {} });
	fs.writeFileSync(choicesFile, newer);
	assert((await statusOf("asana")).choicesUnreadable === "newer", "a newer version's file: the status says so");
	await asks(piA, "list_projects", "a newer version's file: a read-only tool asks");
	const newerRemoval = await remove("asana");
	assert(newerRemoval.status === 409 && newerRemoval.body.error === CONNECTOR_REQUEST_LINES.removeChoicesUnreadable.newer && stillThere(), `a newer version's file: a removal says to update first, got ${JSON.stringify(newerRemoval)}`);
	const newerReset = await reset();
	assert(newerReset.status === 409 && newerReset.body.error === CONNECTOR_REQUEST_LINES.choicesFromNewerVersion && fs.readFileSync(choicesFile, "utf-8") === newer && setAside().length === 2, `a newer version's file is never reset, got ${JSON.stringify(newerReset)}`);
	noChoices();

	// ── REMOVE ───────────────────────────────────────────────────────────────
	await saved("asana", { delete_project: "blocked", create_note: "allow" });
	await removeMcpServer("asana");
	assert(JSON.stringify(choicesOf("asana")) === "{}", `removed, its choices go, got ${JSON.stringify(choicesOf("asana"))}`);
	writeConfig({ asana, local: program });
	settingsStore.writePersistentRoomMcpSettings(roomA, ["asana", "local"]);
	const piAgain = await session(roomA);
	await asks(piAgain, "delete_project", "added again under the same name: nothing chosen");
	await shutdownSession(piAgain);

	// ── ROUTE ────────────────────────────────────────────────────────────────
	const identity = (await statusOf("asana")).identity;
	assert(typeof identity === "string" && /^[0-9a-f]{64}$/.test(identity), "the status names the connector the page shows by its pin");
	for (const [label, name, tools, status] of [
		["an unknown connector", "nowhere", { delete_project: "ask" }, 404],
		["a bad value", "asana", { delete_project: "sometimes" }, 400],
		["a name over 200 characters", "asana", { ["t".repeat(201)]: "ask" }, 400],
		["nothing to save", "asana", {}, 400],
		["a tool named like an object's own member", "asana", { ["__proto__"]: "blocked" }, 400],
	] as const) {
		const answer = await save(name, tools as Record<string, unknown>, identity);
		assert(answer.status === status && JSON.stringify(choicesOf("asana")) === "{}", `${label}: ${status}, nothing saved, got ${answer.status} ${JSON.stringify(answer.body)}`);
	}
	// The route's 400 there comes before the store. The store itself keeps a tool so named as any other, and reads it back.
	choicesStore.setConnectorToolChoices("asana", { ["__proto__"]: { choice: "blocked" } });
	assert(JSON.stringify(choicesOf("asana")) === JSON.stringify({ ["__proto__"]: "blocked" }) && choicesStore.readConnectorToolChoices().readable, `the store keeps a tool named like an object's own member, got ${JSON.stringify(choicesOf("asana"))}`);
	noChoices();
	const otherConnector = await save("asana", { delete_project: "allow" }, "0".repeat(64));
	assert(otherConnector.status === 409 && JSON.stringify(choicesOf("asana")) === "{}", `Always allow for a connector that changed since the page read it: 409, got ${otherConnector.status}`);
	assert((await save("asana", { delete_project: "blocked" }, "0".repeat(64))).status === 200, "Blocked needs no identity: it is safe whatever the connector is now");
	const { classifyRemoteRoute } = await import("../src/remote-route-policy.js");
	assert(classifyRemoteRoute("PUT", "/api/mcp/servers/:name/tools") === "local", "a phone can't change a tool's choice");
	assert(classifyRemoteRoute("POST", "/api/mcp/tool-choices/reset") === "local", "a phone can't reset the choices");
	noChoices();

	// ── SHARED ───────────────────────────────────────────────────────────────
	// A shared server, with a choices file on disk that says Blocked and Always allow: read nowhere.
	await saved("asana", { delete_project: "blocked", create_note: "allow" });
	const sharedBytes = fs.readFileSync(choicesFile, "utf-8");
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	const sharedStatus = await statusOf("asana");
	assert(!("choices" in sharedStatus) && !("identity" in sharedStatus) && !("choicesUnreadable" in sharedStatus), `a shared server's status carries no choices, got ${JSON.stringify(sharedStatus)}`);
	const piShared = await session(roomA);
	const sharedBlocked = await asks(piShared, "delete_project", "a shared server: the Blocked on disk isn't read");
	assert(sharedBlocked.lasting === false, "a shared server offers no Always allow");
	await asks(piShared, "create_note", "a shared server: the Always allow on disk isn't read");
	// A scheduled run there, with the stand-alone run's answerer: the gate asks and its questions are declined, as on main.
	const sharedRun = scheduled();
	assert(errorOf(await use(piShared, sharedRun.ctx, "delete_project")) === "connector_call_unanswered" && errorOf(await use(piShared, sharedRun.ctx, "create_note")) === "connector_call_unanswered", "a shared server's scheduled run: Blocked and Always allow on disk ask, and are declined as on main");
	await runs(piShared, "list_projects", "a shared server's scheduled run: a read-only tool runs", sharedRun.ctx);
	const sharedSave = await save("asana", { delete_project: "ask" }, identity);
	assert(sharedSave.status !== 200 && fs.readFileSync(choicesFile, "utf-8") === sharedBytes, `a shared server saves no choice, got ${sharedSave.status}`);
	assert(fs.readFileSync(choicesFile, "utf-8") === sharedBytes, "a shared server writes nothing to the choices file");
	fs.writeFileSync(choicesFile, garbage);
	const sharedReset = await reset();
	assert(sharedReset.status === 404 && fs.readFileSync(choicesFile, "utf-8") === garbage && setAside().length === 2, `a shared server resets nothing, got ${JSON.stringify(sharedReset)}`);
	await shutdownSession(piShared);

	for (const pi of [piA, piB, piQuiet]) await shutdownSession(pi);
	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	console.log("connector-tool-choice-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	connector.server.close();
}
