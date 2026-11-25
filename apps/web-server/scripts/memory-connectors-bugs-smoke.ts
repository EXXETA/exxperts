// What a person meets at the end of a Memorize that only sorts notes, after a
// failed connector check, on an imported connector's row, on a row whose
// sign-in has expired, and after a sign-in a check asked for. The run comes
// from the real server code on a temp room, the check and the connector rows
// from the real adapter against a local stand-in answering each status; the page's own
// components and words turn them into what the person reads.
//
// Offline: no provider, no network beyond 127.0.0.1. Each section can run
// alone (ONLY=<name>).

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CONNECTOR_REQUEST_LINES } from "../src/connector-form.js";
import { CONNECTORS_EACH_TOOL_LINE } from "../src/room-box/card-text.js";

// Its real path: a project's files are found from the working directory, which
// comes back resolved, and a path shows as ~ only if it starts with HOME.
const tempHome = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "memory-connectors-bugs-home-")));
const root = path.join(tempHome, ".exxperts", "app", "personalized-agents");
const appDir = path.join(tempHome, ".exxperts", "app");
const agentDir = path.join(tempHome, ".exxperts", "agent");
fs.mkdirSync(appDir, { recursive: true });
fs.mkdirSync(agentDir, { recursive: true });
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.EXXPERTS_CODING_AGENT_DIR = agentDir;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = root;
fs.writeFileSync(path.join(appDir, "openai-compatible-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible", providerId: "openai-compatible", label: "Synthetic Gateway", roomModels: [{ modelId: "gpt-5.5" }], maintenanceModel: "gpt-5.5" }, null, 2));
fs.writeFileSync(path.join(appDir, "persistent-agent-ai-profile.json"), JSON.stringify({ profileId: "openai-compatible" }, null, 2));

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const pageRequire = createRequire(new URL("../../web-ui/package.json", import.meta.url));
const React = pageRequire("react");
(globalThis as any).React = React;
const { createElement } = React;
const { renderToStaticMarkup } = pageRequire("react-dom/server");
const component = (file: string) => import(new URL(`../../web-ui/src/components/${file}`, import.meta.url).href) as Promise<any>;
const noop = () => {};
/** The words a person reads, without the markup between them. */
const text = (html: string) => html.replace(/<[^>]+>/g, "").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
const click = (dom: any, act: (fn: () => Promise<void> | void) => Promise<void>, found: Element) => act(async () => { found.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const buttonNamed = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((found) => found.textContent === label);
const jsonAnswer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** A room that has `name` on, for a Keep to leave as it was. */
async function roomWith(name: string): Promise<string> {
	const { writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
	const id = `keeps-${name}`;
	fs.mkdirSync(path.join(root, id), { recursive: true });
	fs.writeFileSync(path.join(root, id, "agent.json"), JSON.stringify({ agentId: id }));
	writePersistentRoomMcpSettings(id, [name]);
	return id;
}

/** After Keep: no delete left the page, the app still has the connector, and the room still has it on. */
async function keptAfterKeep(name: string, asked: readonly string[], room: string): Promise<string[]> {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { readPersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
	const problems: string[] = [];
	const deletes = asked.filter((route) => route.startsWith("DELETE /api/mcp/servers/"));
	if (deletes.length) problems.push(`Keep on ${name} sent ${deletes.join(", ")}`);
	if (!(await getMcpConnectorsStatus()).servers.some((server: { name: string }) => server.name === name)) problems.push(`Keep on ${name} left it configured nowhere`);
	if (!readPersistentRoomMcpSettings(room).grantedConnectors.includes(name)) problems.push(`Keep on ${name} took it from its room`);
	return problems;
}

const ONLY = process.env.ONLY;
async function section(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY && ONLY !== name) return;
	await body();
	console.log(`ok ${name}`);
}

const MODEL = { provider: "openai-compatible", model: "gpt-5.5", label: "GPT-5.5" };

/** A room with one topic, one note left in Unsorted by an older Memorize, and no conversation waiting. */
async function roomWithNoteToSort(name: string): Promise<{ agentId: string }> {
	const { createPersistentAgentFromScaffoldInput } = await import("../src/persistent-agents.js");
	const agentId = createPersistentAgentFromScaffoldInput({ displayName: name, userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId;
	fs.writeFileSync(path.join(root, agentId, "L1b", "current.md"), [
		"<!-- exxeta:l1b schema_version=1 -->", "", "## Chronos", "", `- Persistent agent id: ${agentId}`, "- Lifecycle state: ready", "- Last checkpoint: cp_20260912_0001", "- Last checkpoint at: 2026-09-12T09:00:00.000Z", "- Last consolidation: none", "",
		"## Deep Memory", "", "<!-- entries: next=900 -->", "",
		"### Maintenance terms", "", "<!-- e: id=m-0003 kind=fact saved=2026-09-01 -->", "- The Nordwind maintenance contract renews automatically on 1 June.", "",
		"### Unsorted", "", "<!-- e: id=m-0101 kind=fact saved=2026-09-02 -->", "- The Nordwind contract notice period is three months.", "",
		"## Active Items", "",
		"## Recent Context", "",
	].join("\n"), { mode: 0o600 });
	return { agentId };
}

// Item 2: a Memorize run that only sorts notes read no conversation, so the
// card shows no "0 of 0" counts and no empty "New in memory" section; a run
// that read conversations keeps both.
await section("sort-only-run", async () => {
	const run = await import("../src/absorb-run.js");
	const { agentId } = await roomWithNoteToSort("Sort Room");
	const { runId } = run.startAbsorbRun({
		agentId,
		assessmentMarkdown: "## What these sessions leave behind\n\n- Nothing new.",
		model: MODEL,
		generate: async (prompt) => {
			assert(prompt.includes("notes that have no topic yet"), `the run only sorts, got a prompt starting ${JSON.stringify(prompt.slice(0, 120))}`);
			return { text: "m-0101: Maintenance terms", usage: { input: 50, output: 5 } };
		},
		probe: async () => ({ text: "OK" }),
	});
	const deadline = Date.now() + 30_000;
	let ready = run.getAbsorbRun(agentId, runId);
	while (["prepass", "folding", "budget"].includes(ready.state)) {
		assert(Date.now() < deadline, `the run was still "${ready.state}" after 30 seconds`);
		await sleep(5);
		ready = run.getAbsorbRun(agentId, runId);
	}
	assert(ready.progress.total === 0 && (ready.sorted ?? []).length === 1, `the run sorted one note and read no conversation, got ${JSON.stringify({ state: ready.state, total: ready.progress.total, sorted: ready.sorted })}`);
	const screen = await component("absorb-run-screen.tsx");
	const card = (absorb: unknown) => text(renderToStaticMarkup(createElement(screen.AbsorbRunCard, { run: absorb, roomName: "Sort Room", keepIds: [], busy: false, error: null, onToggleKeep: noop, onToggleKeepTopic: noop, onRaiseBudget: noop, onApprove: noop, onCancel: noop, onBackToAssessment: noop, onResume: noop, onChooseModel: noop, onSignIn: noop })) as string);
	const sortOnly = card(ready);
	assert(sortOnly.includes("Nordwind contract notice period") && sortOnly.includes("under Maintenance terms"), `the card shows the sorted note, got ${sortOnly}`);
	for (const empty of ["0 of 0 read", "0 added or updated", "New in memory", "No conversation was read yet."]) {
		assert(!sortOnly.includes(empty), `a sort-only run shows no "${empty}", got ${sortOnly}`);
	}
	// The allowed neighbour: a run that read a conversation keeps its counts and its section.
	const session = { id: "RC-0001", title: "Pricing", date: "2026-09-11", outcome: "folded", summary: { added: 1, updated: 0, superseded: 0, closed: 0, dropped: 0 }, changes: [{ id: "m-0102", kind: "add", topic: "Maintenance terms", text: "- Pricing holds." }] };
	const withConversation = card({ ...ready, progress: { folded: 1, total: 1 }, sessions: [session] });
	assert(withConversation.includes("1 of 1 read") && withConversation.includes("1 added or updated") && withConversation.includes("New in memory"), `a run that read a conversation keeps its counts and section, got ${withConversation}`);
	run.cancelAbsorbRun(agentId, runId);
});

// The connectors page's row model, words and row, as the page itself uses them.
const rowsModule = () => import(new URL("../../web-ui/src/connector-rows.ts", import.meta.url).href) as Promise<any>;

// Item 3: every status a server really answers a failed check with gets the
// row state and the line of its own. The adapter's answer comes from a local
// stand-in; the page's row model words it.
await section("test-status-advice", async () => {
	const { addMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS, checkOf, connectorRowState, wentWrongLine } = await rowsModule();
	const words = CONNECTOR_WORDS.wentWrong;
	const NOT_FOUND = { kind: "cant-connect", line: words.addressNotFound, way: "changeAddress" };
	// Any other refusal says only that the service turned it down; "wasn't found" is for a 404 or 410.
	const REFUSED = { kind: "cant-connect", line: words.addressRefused, way: "changeAddress" };
	// Waiting can get past these, and only these: a 501 or 505 never passes.
	const BUSY = { kind: "cant-connect-now", line: words.busy, way: null };
	const rows: Array<[number, { kind: string; line: unknown; way: string | null }]> = [
		[404, NOT_FOUND],
		[408, BUSY],
		[410, NOT_FOUND],
		[418, REFUSED],
		[425, BUSY],
		[429, BUSY],
		[500, BUSY],
		[501, REFUSED],
		[502, BUSY],
		[503, BUSY],
		[504, BUSY],
		[505, REFUSED],
		[520, REFUSED],
	];
	for (const [status, expected] of rows) {
		const server = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => { res.writeHead(status, { "Content-Type": "text/plain" }); res.end(`stand-in answered ${status}`); });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const name = `status-${status}`;
			await addMcpServer({ name, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` });
			const result = await testMcpServer(name);
			assert(!result.ok && !result.needsAuth && result.httpStatus === status, `the check reports ${status}, got ${JSON.stringify(result)}`);
			const row = (await getMcpConnectorsStatus()).servers.find((each: { name: string }) => each.name === name);
			const state = connectorRowState(row, checkOf(result), null);
			const line = wentWrongLine(row, state, false);
			assert(state.kind === expected.kind && line?.line === expected.line && line?.button === expected.way, `HTTP ${status} gets ${JSON.stringify(expected)}, got ${JSON.stringify({ kind: state.kind, line })}`);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
});

// Item 4: a connector imported from another tool cannot be removed or changed
// here, so a failed check points to that tool, named as people know it, and
// its menu offers neither Remove nor Change address. One in the exxperts file
// keeps both; one in the shared global file (which Remove does edit) keeps Remove,
// and its remove question says other apps lose it too. Each failure's line
// names only its own cause: a turned-down key is never called a missing
// address, and nothing answering is never called busy.
await section("imported-test-advice", async () => {
	const { addMcpServer, removeMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS, checkOf, connectorRowState, removeConsequence, rowLook, wentWrongLine } = await rowsModule();
	const server = http.createServer((req, res) => {
		req.resume();
		const status = req.url?.startsWith("/key") ? 403 : 404;
		req.on("end", () => { res.writeHead(status, { "Content-Type": "text/plain" }); res.end(`stand-in answered ${status}`); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
		const keyUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/key`;
		const closed = "http://127.0.0.1:9/mcp";
		const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
		// A tenant header is no key: a refusal to one that carries only that never names a key.
		const tenant = { "X-Tenant": "acme" };
		writeJson(path.join(tempHome, ".cursor", "mcp.json"), { mcpServers: { "from-cursor": { url }, "cursor-key": { url: keyUrl, headers: { Authorization: "Bearer synthetic-key" } }, "cursor-tenant": { url: keyUrl, headers: tenant }, "cursor-local": { command: "zq-no-such-program" } } });
		writeJson(path.join(tempHome, ".claude.json"), { mcpServers: { "from-claude": { url: closed } } });
		writeJson(path.join(tempHome, ".config", "mcp", "mcp.json"), { mcpServers: { "shared-404": { url }, "shared-key": { url: keyUrl, headers: { Authorization: "Bearer synthetic-key" } }, "shared-tenant": { url: keyUrl, headers: tenant } } });
		const configPath = path.join(agentDir, "mcp.json");
		const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
		writeJson(configPath, { ...config, imports: ["cursor", "claude-code"], mcpServers: { ...config.mcpServers, "own-tenant": { url: keyUrl, headers: tenant }, "own-key": { url: keyUrl, auth: false, headers: { "X-Api-Key": "synthetic-key" } }, "own-two-keys": { url: keyUrl, auth: false, headers: { "X-Api-Key": "synthetic-key", Authorization: "Bearer synthetic-key" } } } });
		await addMcpServer({ name: "own-404", url });
		await addMcpServer({ name: "own-closed", url: closed });
		// The directory's own name: its address is the directory's, not the person's to change.
		await addMcpServer({ name: "notion", url });
		const rows = new Map((await getMcpConnectorsStatus()).servers.map((row: { name: string }) => [row.name, row]));
		const failed = async (name: string) => {
			const row = rows.get(name);
			assert(row, `${name} is on the page, got ${JSON.stringify([...rows.keys()])}`);
			const result = await testMcpServer(name);
			assert(!result.ok && !result.needsAuth, `${name}'s check fails, got ${JSON.stringify(result)}`);
			const check = checkOf(result);
			const state = connectorRowState(row, check, null);
			const wrong = wentWrongLine(row, state, false);
			const look = rowLook(state, false);
			return { state: state.kind, status: look.status, line: wrong?.line ?? null, way: wrong?.button ?? null, button: look.button, page: (await drawnPage(row, check)).offers };
		};
		const words = CONNECTOR_WORDS.wentWrong;
		const { cantConnect, cantConnectNow, notAnswering } = CONNECTOR_WORDS.status;
		// What its own page offers, in order: the fix beside What went wrong, Change address on its address,
		// the state's own step, Check connection, and Remove where this page can remove it.
		const { changeAddress, changeKey, checkConnection, remove, tryAgain } = CONNECTOR_WORDS.button;
		const cases: Array<[string, { state: string; status: string; line: unknown; way: string | null; button: string | null; page: string[] }]> = [
			["from-cursor", { state: "cant-connect", status: cantConnect, line: words.imported("Cursor"), way: null, button: null, page: [checkConnection] }],
			["cursor-key", { state: "cant-connect", status: cantConnect, line: words.importedKey("Cursor"), way: null, button: null, page: [checkConnection] }],
			["cursor-tenant", { state: "cant-connect", status: cantConnect, line: words.refusedImported("Cursor"), way: null, button: null, page: [checkConnection] }],
			// A program that isn't on this computer says so by its name, with Try again for once it is installed.
			["cursor-local", { state: "program-failed", status: CONNECTOR_WORDS.status.cantStart, line: words.programMissing("zq-no-such-program"), way: "tryAgain", button: null, page: [tryAgain, checkConnection] }],
			// No status: nothing answering, with Try again for a network that comes back, and no promise that waiting helps.
			["from-claude", { state: "cant-connect-now", status: notAnswering, line: words.noAnswer, way: null, button: "tryAgain", page: [tryAgain, checkConnection] }],
			["own-closed", { state: "cant-connect-now", status: notAnswering, line: words.noAnswer, way: "changeAddress", button: "tryAgain", page: [changeAddress, changeKey, tryAgain, checkConnection, remove] }],
			["own-404", { state: "cant-connect", status: cantConnect, line: words.addressNotFound, way: "changeAddress", button: null, page: [changeAddress, changeKey, checkConnection, remove] }],
			// Added here with no key (a tenant header is none): its first key goes in through Change key.
			["own-tenant", { state: "cant-connect", status: cantConnect, line: words.refusedKeyInPlace, way: "changeKey", button: null, page: [changeKey, changeAddress, checkConnection, remove] }],
			["own-key", { state: "cant-connect", status: cantConnect, line: words.keyRefused, way: "changeKey", button: null, page: [changeKey, changeAddress, checkConnection, remove] }],
			// Two keys: Change key couldn't tell which one to replace, so the line says to add it again, and leaves Remove to the page's Remove row.
			["own-two-keys", { state: "cant-connect", status: cantConnect, line: words.keyFixed, way: "remove", button: null, page: [changeAddress, checkConnection, remove] }],
			["shared-404", { state: "cant-connect", status: cantConnect, line: words.addressNotFoundElsewhere, way: null, button: null, page: [checkConnection, remove] }],
			["shared-key", { state: "cant-connect", status: cantConnect, line: words.keyRefusedElsewhere, way: null, button: null, page: [checkConnection, remove] }],
			["shared-tenant", { state: "cant-connect", status: cantConnect, line: words.refusedElsewhere, way: null, button: null, page: [checkConnection, remove] }],
			// A directory connector its service turned down has no row button; its page checks again.
			["notion", { state: "cant-connect", status: cantConnect, line: words.turnedDown, way: null, button: null, page: [checkConnection, remove] }],
		];
		assert(cantConnectNow !== notAnswering, "a busy service and one not answering read differently");
		// Each case is told apart, so one run shows every one that fails.
		const problems: string[] = [];
		for (const [name, expected] of cases) {
			const got = await failed(name);
			if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`${name}'s failed check should give ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
		}
		assert(problems.length === 0, problems.join("\n"));
		// Remove's question says what Remove does: the shared file's connector goes for other apps too, ours alone does not.
		const consequence = (name: string) => removeConsequence(rows.get(name), []) ?? "";
		assert(consequence("shared-404").includes(CONNECTOR_WORDS.removeSharedFile), `removing a connector in the shared file says other apps lose it, got ${JSON.stringify(consequence("shared-404"))}`);
		assert(!consequence("own-404").includes(CONNECTOR_WORDS.removeSharedFile), `removing our own connector names no other app, got ${JSON.stringify(consequence("own-404"))}`);
		// Remove agrees with the page: it refuses the imported one and takes the shared one.
		const removed = await removeMcpServer("shared-404");
		assert(removed.removedFrom.length === 1, `Remove takes the shared one, got ${JSON.stringify(removed)}`);
		let refused = "";
		await removeMcpServer("from-cursor").catch((error: Error) => { refused = error.message; });
		assert(refused === CONNECTOR_REQUEST_LINES.notRemovable("Cursor"), `Remove refuses the imported one and names its app, got ${JSON.stringify(refused)}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

// Item 5: a connector's page offers Remove on exactly the connectors the server
// removes, and names the tool on the others. Each is the real status drawn by
// the real row and page, and each is then really removed, so the two cannot
// drift apart.
await section("imported-remove", async () => {
	const { removeMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const url = "http://127.0.0.1:9/mcp";
	const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
	const configPath = path.join(agentDir, "mcp.json");
	// The adapter reads a project's files from the working directory.
	process.chdir(tempHome);
	writeJson(path.join(tempHome, ".mcp.json"), { mcpServers: { "cursor-and-project": { url } } });
	writeJson(path.join(tempHome, ".cursor", "mcp.json"), { mcpServers: { "only-cursor": { url }, "cursor-and-ours": { url }, "cursor-and-shared": { url }, "cursor-and-project": { url } } });
	writeJson(path.join(tempHome, ".claude.json"), { mcpServers: { "only-claude": { url } } });
	writeJson(path.join(tempHome, ".config", "mcp", "mcp.json"), { mcpServers: { "only-shared": { url }, "cursor-and-shared": { url } } });
	writeJson(configPath, { imports: ["cursor", "claude-code"], mcpServers: { "only-ours": { url }, "cursor-and-ours": { url } } });
	const statusRows = async () => new Map((await getMcpConnectorsStatus()).servers.map((row: { name: string }) => [row.name, row]));
	// Its row in the list, and its own page.
	const draw = async (server: any, { readOnly = false } = {}) => {
		const row = await drawnRow(server, null, { readOnly });
		const page = await drawnPage(server, null, { readOnly });
		return { row: row.words, tag: row.tag, page: page.words, offersRemove: page.offers.includes(CONNECTOR_WORDS.button.remove) };
	};
	const rows = await statusRows();
	const cases: Array<{ name: string; tool: string | null }> = [
		{ name: "only-cursor", tool: "Cursor" },
		{ name: "only-claude", tool: "Claude Code" },
		{ name: "only-ours", tool: null },
		{ name: "only-shared", tool: null },
		{ name: "cursor-and-ours", tool: null },
		{ name: "cursor-and-shared", tool: null },
		{ name: "cursor-and-project", tool: null },
	];
	for (const { name, tool } of cases) {
		const server = rows.get(name);
		const drawn = await draw(server);
		assert(drawn.offersRemove === !tool, `${name}'s page ${tool ? "offers no" : "keeps its"} Remove, got ${drawn.page}`);
		if (tool) {
			const sentence = CONNECTOR_WORDS.importedNote(tool);
			assert(drawn.tag === CONNECTOR_WORDS.tagImported(tool), `${name}'s row says where it came from, got ${drawn.tag}`);
			assert(!drawn.row.includes(sentence), `${name}'s row leaves the sentence to its page, got ${drawn.row}`);
			assert(drawn.page.includes(sentence), `${name}'s page says ${JSON.stringify(sentence)}, got ${drawn.page}`);
			assert(drawn.page.includes(url) && !drawn.page.includes("mcp.json"), `${name}'s page keeps the address and names no file, got ${drawn.page}`);
		} else {
			assert(drawn.tag === CONNECTOR_WORDS.tagCustom, `${name} is the person's own, got ${drawn.tag}`);
			assert(!drawn.page.includes("remove it there"), `${name} names no other tool, got ${drawn.page}`);
		}
		let refused = "";
		const removed = await removeMcpServer(name).catch((error: Error) => { refused = error.message; });
		assert(Boolean(refused) === Boolean(tool), `the server ${tool ? "refuses" : "removes"} ${name}, got ${JSON.stringify(removed ?? refused)}`);
	}
	const after = await statusRows();
	for (const name of ["only-ours", "only-shared"]) assert(!after.has(name), `${name} is gone after Remove, got ${JSON.stringify([...after.keys()])}`);
	// Our own copy gone, the row that stays is Cursor's: it stops offering Remove.
	for (const name of ["cursor-and-ours", "cursor-and-shared", "cursor-and-project"]) {
		const left = await draw(after.get(name));
		assert(!left.offersRemove && left.page.includes(CONNECTOR_WORDS.importedNote("Cursor")) && left.tag === CONNECTOR_WORDS.tagImported("Cursor"), `${name}'s Cursor copy left behind says where it came from and offers no Remove, got ${left.tag}: ${left.page}`);
	}
	// The adapter reads only tools the page has a name for, so a tool it learns later goes by its id.
	const cursorRow = after.get("only-cursor") as any;
	const unnamed = await draw({ ...cursorRow, source: { ...cursorRow.source, importKind: "zed", importFile: "~/.zed/mcp.json" } });
	assert(!unnamed.offersRemove && unnamed.tag === CONNECTOR_WORDS.tagImported("zed") && unnamed.page.includes(CONNECTOR_WORDS.importedNote("zed")), `a tool with no name on the page goes by its id, got ${unnamed.page}`);
	// A window that cannot change connectors has no Remove to stand in for, but the row still says where it came from.
	const readOnly = await draw(cursorRow, { readOnly: true });
	assert(!readOnly.offersRemove && !readOnly.page.includes(CONNECTOR_WORDS.importedNote("Cursor")), `a read-only page offers neither Remove nor the way to it, got ${readOnly.page}`);
	assert(readOnly.tag === CONNECTOR_WORDS.tagImported("Cursor"), `a read-only row still says where it came from, got ${readOnly.tag}`);
});

// A sign-in that has expired with nothing to renew it needs the person:
// Reconnect. One still valid, or one that renews itself, reads Connected with
// no button, and Disconnect on its page. Each is the real status of
// a sign-in the adapter's own store holds, drawn by the real row and page.
await section("expired-login", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { CONNECTOR_WORDS } = await rowsModule();
	const url = "http://127.0.0.1:9/mcp";
	const names = ["expired-login", "expired-renewable", "valid-login"];
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, { url }])) }));
	const now = Math.floor(Date.now() / 1000);
	authStore.updateTokens("expired-login", { accessToken: "synthetic-expired", expiresAt: now - 3600 }, url);
	authStore.updateTokens("expired-renewable", { accessToken: "synthetic-renewable", refreshToken: "synthetic-refresh", expiresAt: now - 3600 }, url);
	authStore.updateTokens("valid-login", { accessToken: "synthetic-valid", expiresAt: now + 3600 }, url);
	const rows = new Map((await getMcpConnectorsStatus()).servers.map((row: { name: string }) => [row.name, row]));
	const drawn = async (name: string) => {
		const server = rows.get(name);
		const { status, button } = await drawnRow(server, null);
		return { status, button, disconnect: (await drawnPage(server, null)).offers.includes(CONNECTOR_WORDS.button.disconnect) };
	};
	const { status, button } = CONNECTOR_WORDS;
	const cases: Array<[string, { status: string; button: string | null; disconnect: boolean }]> = [
		// Expired with nothing to renew it: its one step is Reconnect; that token opens nothing, so there is nothing to disconnect.
		["expired-login", { status: status.needsReconnecting, button: button.reconnect, disconnect: false }],
		["expired-renewable", { status: status.connected, button: null, disconnect: true }],
		["valid-login", { status: status.connected, button: null, disconnect: true }],
	];
	for (const [name, expected] of cases) {
		const got = await drawn(name);
		assert(JSON.stringify(got) === JSON.stringify(expected), `${name}'s row should read ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
	}
});

// A check that says the connector needs a sign-in again offers Reconnect; a
// sign-in that fails reads "Sign-in didn't finish" with its reason and Try
// again, the service's own words on its page under Technical details; once a
// sign-in succeeds the row reads Connected with no button. The pane runs as
// it does on screen, in StrictMode: its own check runs the real adapter
// against a stand-in that refuses the stored token, and the sign-in is a
// stand-in that stores fresh tokens, as a finished sign-in does.
await sectionInOwnProcess("login-after-test", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { CONNECTOR_WORDS, lineText } = await rowsModule();
	const provider = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => { res.writeHead(401, { "Content-Type": "text/plain" }); res.end("stand-in refused the token"); });
	});
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const name = "revoked-login";
	const url = `http://127.0.0.1:${(provider.address() as AddressInfo).port}/mcp`;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url } } }));
	const later = () => Math.floor(Date.now() / 1000) + 3600;
	authStore.updateTokens(name, { accessToken: "synthetic-revoked", expiresAt: later() }, url);
	let loginFails = true;
	let started = false;
	const FAILED = lineText(CONNECTOR_WORDS.wentWrong.busy, false);
	try {
		// Before any check, a stored token reads Connected with no button.
		const before = await drawnRow((await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name), null);
		assert(before.status === CONNECTOR_WORDS.status.connected && before.button === null, `a row with a stored token reads Connected with no button, got ${JSON.stringify(before)}`);
		const base = `/api/mcp/servers/${name}`;
		await connectorsPage((route) => {
			if (route === `POST ${base}/login`) {
				started = true;
				if (!loginFails) authStore.updateTokens(name, { accessToken: "synthetic-fresh", expiresAt: later() }, url);
				return jsonAnswer({ started: true });
			}
			// Only a sign-in this smoke started has an answer; on opening, nothing waits.
			if (route === `GET ${base}/login`) return jsonAnswer(!started ? { pending: false } : loginFails ? { pending: false, cause: "busy", detail: "stand-in: sign-in refused" } : { pending: false });
			return null;
		}, async ({ container, dom, act, waitFor, rowOf, openPage, back, pageButton }) => {
			const status = () => rowOf(name)?.querySelector(".connector-item-status")?.textContent;
			const button = () => rowOf(name)?.querySelector(".connector-item-slot .connector-slot-label")?.textContent ?? null;
			const press = async (label: string) => {
				const found = rowOf(name)?.querySelector(".connector-item-slot button");
				assert(found && button() === label, `the row offers ${label}, got ${JSON.stringify(button())}`);
				await click(dom, act, found);
			};
			// The pane's own check: the real adapter against the refusing stand-in.
			await waitFor("the pane's own check", () => status() === CONNECTOR_WORDS.status.needsReconnecting);
			assert(button() === CONNECTOR_WORDS.button.reconnect, `after a check that needs a sign-in, the row offers Reconnect, got ${JSON.stringify(button())}`);
			await press(CONNECTOR_WORDS.button.reconnect);
			await waitFor("the failed sign-in", () => status() === CONNECTOR_WORDS.status.signInFailed);
			assert(button() === CONNECTOR_WORDS.button.tryAgain, `a sign-in that failed offers Try again, got ${JSON.stringify(button())}`);
			// Its page says why in full, and keeps the service's own words under Technical details, as a failed check's are.
			await openPage(name);
			assert(container.querySelector(".connector-fact-wrong")?.textContent?.includes(FAILED), `a failed sign-in's page says why, got ${container.textContent}`);
			const fold = container.querySelector(".connector-page .connector-tech");
			assert(fold?.querySelector("summary")?.textContent === CONNECTOR_WORDS.details.technicalDetails && fold?.querySelector("code")?.textContent === "stand-in: sign-in refused", `a failed sign-in keeps the service's words under Technical details, got ${container.textContent}`);
			loginFails = false;
			await click(dom, act, pageButton(CONNECTOR_WORDS.button.tryAgain)!);
			await waitFor("the sign-in to finish", () => pageButton(CONNECTOR_WORDS.button.disconnect) !== undefined);
			await back();
			assert(status() === CONNECTOR_WORDS.status.connected && button() === null, `after the sign-in succeeds the row reads Connected with no button, got ${JSON.stringify([status(), button()])}`);
		}, { strict: true });
	} finally {
		provider.closeAllConnections();
		provider.close();
	}
});

// Opening the page checks a web connector only when the check can tell the
// person something: one nothing is known about yet, or one whose last check
// failed. One whose last check said it needs a sign-in waits for the person's
// Connect, as does one that names its own sign-in app; a program never starts.
// A sign-in the service refuses, or one that needs the service's own sign-in
// app or has no sign-in, fails the same way twice: its row offers no Try
// again. One the person said no to, the service was too busy for, that ran
// too long, or that failed for a reason not known keeps it. The server reads
// the adapter's own error into these causes, a refusal by the standard's code
// whether the service sent a description with it or not, and a sign-in whose
// discovery answered with a web page as one with no sign-in. One with no
// sign-in, whose check found it wants one, says only a key can help.
await section("sign-in-causes", async () => {
	const { loginFailureOf } = await import("../src/mcp-admin.js");
	const { rowLook, wentWrongLine, technicalDetails, CONNECTOR_WORDS } = await rowsModule();
	const tryAgain = "tryAgain";
	const { signInFailed, cantSignIn } = CONNECTOR_WORDS.status;
	const failed = CONNECTOR_WORDS.signInFailed;
	// The same failure on a connector added here, in the shared file, and brought in from Cursor: the way on is one each can take.
	const web = { name: "team-wiki", target: "http://127.0.0.1:9/mcp", transport: "http", editable: true, key: "none", auth: { mode: "oauth", hasStoredTokens: false } };
	const places = {
		here: { ...web, source: { kind: "user", path: "~/.exxperts/agent/mcp.json" } },
		file: { ...web, editable: false, source: { kind: "import", importKind: "global MCP config", path: "~/.config/mcp/mcp.json" } },
		app: { ...web, editable: false, source: { kind: "import", importKind: "cursor", importFile: "~/.cursor/mcp.json", path: "~/.exxperts/agent/mcp.json" } },
	};
	// The adapter's error: its words, and the service's refusal code on it where the service sent one (patch 1).
	const refusal = (code: string, description?: string) => Object.assign(new Error(description ?? code), { signInRefusal: code });
	const cases: Array<[string | Error, string, string, string | null, (place: "here" | "file" | "app") => unknown]> = [
		["HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F'. Raw body: Forbidden", "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		["Incompatible auth server: does not support dynamic client registration", "needs-own-app", cantSignIn, null, (place) => failed.needsOwnApp(place, "Cursor")],
		["HTTP 404 trying to load well-known OAuth metadata", "no-sign-in", cantSignIn, null, () => failed.noSignIn],
		// The discovery address answered with an ordinary web page.
		[`SyntaxError: Unexpected token '<', "<!DOCTYPE "... is not valid JSON`, "no-sign-in", cantSignIn, null, () => failed.noSignIn],
		// The service's refusal, by the standard's code, bare and with the service's description.
		[refusal("access_denied"), "declined", signInFailed, tryAgain, () => failed.declined],
		[refusal("access_denied", "The user said no"), "declined", signInFailed, tryAgain, () => failed.declined],
		[refusal("server_error"), "busy", signInFailed, tryAgain, () => CONNECTOR_WORDS.wentWrong.busy],
		[refusal("temporarily_unavailable", "Try again in a minute"), "busy", signInFailed, tryAgain, () => CONNECTOR_WORDS.wentWrong.busy],
		[refusal("invalid_target"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		[refusal("invalid_target", "The resource is not allowed"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		[refusal("invalid_scope", "Unknown scope"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		[refusal("invalid_request"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		[refusal("unauthorized_client", "Not allowed"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		[refusal("unsupported_response_type"), "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		// A code that isn't the standard's is no refusal of its own; nor are words that look like one, without the code.
		[refusal("made_up_code", "Something else"), "other", signInFailed, tryAgain, () => failed.other],
		["access_denied", "other", signInFailed, tryAgain, () => failed.other],
		["HTTP 503 trying to load well-known OAuth metadata", "busy", signInFailed, tryAgain, () => CONNECTOR_WORDS.wentWrong.busy],
		// A 501 is no busy service: waiting won't help, so it isn't worded as if it would.
		["Error POSTing to endpoint (HTTP 501): Not Implemented", "other", signInFailed, tryAgain, () => failed.other],
		["The sign-in timed out waiting for the browser", "too-slow", signInFailed, tryAgain, () => failed.tooSlow],
		["fetch failed", "other", signInFailed, tryAgain, () => failed.other],
	];
	for (const [error, cause, status, button, lineFor] of cases) {
		const failure = loginFailureOf(error);
		const message = typeof error === "string" ? error : error.message;
		const state = { kind: "sign-in-failed", cause: failure.cause, detail: failure.detail };
		const look = rowLook(state, false);
		for (const place of ["here", "file", "app"] as const) {
			// The page words the line from the cause; the service's words always go under Technical details.
			const wrong = wentWrongLine(places[place], state, false);
			const got = [failure.cause, look.status, look.button, wrong?.line, wrong?.button ?? null, technicalDetails(state)];
			// Added here by its address with no key, a refused sign-in's way on is Change key, and so is one that found no sign-in on offer;
			// elsewhere, a line that starts with removing it has Remove under it.
			const keyInPlace = place === "here" && (cause === "refused" || cause === "no-sign-in");
			const keyLine = cause === "refused" ? failed.refusedKeyInPlace : failed.noSignInKey;
			const expected = [cause, status, button, keyInPlace ? keyLine : lineFor(place), keyInPlace ? "changeKey" : place === "here" && cause === "needs-own-app" ? "remove" : null, message];
			assert(JSON.stringify(got) === JSON.stringify(expected), `${JSON.stringify([message, (error as { signInRefusal?: string }).signInRefusal])} on one added ${place} should give ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
		}
	}
	// The refused sign-in's line, word for word, and from another app it names that app.
	const { lineText } = await rowsModule();
	assert(lineText(failed.refused("here", ""), false) === "This service doesn't let exxperts sign in, so trying again won't help. If you have a key for it, remove this connector and add it again with the key.", "the refused sign-in line, word for word");
	assert(lineText(failed.refusedKeyInPlace, false) === "This service doesn't let exxperts sign in, so trying again won't help. If you have a key for it, use Change key.", "a refused sign-in where a first key goes in place says Change key");
	assert(lineText(failed.refused("app", "Cursor"), false).endsWith("remove it in Cursor, then add it by its web address with that key."), "from another app, the refused sign-in names it");
	// A sign-in with no answer by the page's deadline may still finish another time.
	assert(rowLook({ kind: "sign-in-failed" }, false).button === tryAgain, "a sign-in that never answered offers Try again");
	assert(lineText(failed.declined, false) === "The service didn't give exxperts access. If you said no there by mistake, try again.", "the declined sign-in's line is the one proposed");
	// No sign-in offered, by a connector whose newest check (the page's own, or the kept one) found it wants one:
	// only a key helps, given in place on one added here by its address, else by where it was added.
	const { connectorRowState } = await rowsModule();
	const noSignIn = { kind: "sign-in-failed", cause: "no-sign-in" };
	const fact = "It wants a sign-in or a key, and doesn't offer a sign-in here.";
	for (const status of [401, 403]) {
		const wantsOne = { at: Date.now(), ok: false, needsAuth: true, httpStatus: status };
		const wants = (["here", "file", "app"] as const).map((place) => wentWrongLine(places[place], connectorRowState(places[place], wantsOne, noSignIn), false));
		const expected = [
			{ line: { fact, way: "If you have a key for it, use Change key." }, button: "changeKey" },
			{ line: { fact, way: CONNECTOR_WORDS.wentWrong.refusedElsewhere.way }, button: null },
			{ line: { fact, way: CONNECTOR_WORDS.wentWrong.refusedImported("Cursor").way }, button: null },
		];
		assert(JSON.stringify(wants) === JSON.stringify(expected), `a ${status} with no sign-in offered says only a key helps, got ${JSON.stringify(wants)}`);
		// Read from the kept check alone, as Settings opened again reads it.
		const kept = { ...places.here, lastCheck: wantsOne };
		assert(JSON.stringify(wentWrongLine(kept, connectorRowState(kept, kept.lastCheck, noSignIn), false)) === JSON.stringify(expected[0]), `a ${status} kept says the same`);
	}
	// From the directory, or set to sign in on purpose (its own sign-in app among them), it can't take one in place:
	// its way starts with removing it.
	const fromDirectory = { ...places.here, name: "notion" };
	const signsInOnPurpose = { ...places.here, auth: { ...places.here.auth, explicit: true } };
	const wantsOne = { at: Date.now(), ok: false, needsAuth: true, httpStatus: 401 };
	for (const [what, server] of [["from the directory", fromDirectory], ["set to sign in on purpose", signsInOnPurpose]] as const) {
		const got = wentWrongLine(server, connectorRowState(server, wantsOne, noSignIn), false);
		assert(JSON.stringify(got) === JSON.stringify({ line: { fact, way: CONNECTOR_WORDS.wentWrong.refused.way }, button: "remove" }), `one ${what} isn't offered Change key, got ${JSON.stringify(got)}`);
		// A refused sign-in and a refused check on it say the same: remove it and add it again with the key.
		const refusedSignIn = wentWrongLine(server, { kind: "sign-in-failed", cause: "refused" }, false);
		assert(JSON.stringify(refusedSignIn) === JSON.stringify({ line: failed.refused("here", ""), button: "remove" }), `one ${what} refused at its sign-in is told to add it again, got ${JSON.stringify(refusedSignIn)}`);
		const refusedCheck = wentWrongLine(server, { kind: "cant-connect", cause: "refused" }, false);
		assert(JSON.stringify(refusedCheck) === JSON.stringify({ line: CONNECTOR_WORDS.wentWrong.refused, button: "remove" }), `one ${what} its service turned down is told to add it again, got ${JSON.stringify(refusedCheck)}`);
	}
	// One added here by its address with no key, turned down by its service: Change key, as for the sign-in.
	const refusedHere = wentWrongLine(places.here, { kind: "cant-connect", cause: "refused" }, false);
	assert(JSON.stringify(refusedHere) === JSON.stringify({ line: { fact: "Its service turned the connection down.", way: "If you have a key for it, use Change key." }, button: "changeKey" }), `one added here its service turned down offers Change key, got ${JSON.stringify(refusedHere)}`);
	// No sign-in on offer for one never checked: added here, a key goes in place; elsewhere it likely works without one.
	assert(JSON.stringify(wentWrongLine(places.here, connectorRowState(places.here, null, noSignIn), false)) === JSON.stringify({ line: failed.noSignInKey, button: "changeKey" }), "one added here, never checked, is led to Change key");
	for (const place of ["file", "app"] as const) assert(JSON.stringify(wentWrongLine(places[place], connectorRowState(places[place], null, noSignIn), false)) === JSON.stringify({ line: failed.noSignIn, button: null }), `one added ${place}, never checked, likely works without one`);
	// One whose check connected stays connected, with nothing gone wrong: the same line sits in its Sign-in row instead.
	const { noSignInLine } = await rowsModule();
	const connectedCheck = { at: Date.now(), ok: true };
	for (const place of ["here", "file", "app"] as const) {
		const state = connectorRowState(places[place], connectedCheck, noSignIn);
		const got = [state, wentWrongLine(places[place], state, false), noSignInLine(places[place], state)];
		const expected = [{ kind: "connected", noSignIn: true }, null, place === "here" ? failed.noSignInKey : failed.noSignIn];
		assert(JSON.stringify(got) === JSON.stringify(expected), `one added ${place}, connected, stays connected with the line beside its sign-in, got ${JSON.stringify(got)}`);
	}
});

await section("background-checks", async () => {
	const { getMcpConnectorsStatus, writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { connectorRowState, checksInBackground } = await rowsModule();
	const url = "http://127.0.0.1:9/mcp";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		"never-checked": { url },
		"said-sign-in": { url },
		"failed-before": { url },
		"own-app": { url, oauth: { clientId: "synthetic-client" } },
		"program": { command: "zq-no-such-program" },
	} }));
	writeMcpConnectorCheck("said-sign-in", { at: Date.now(), ok: false, needsAuth: true, httpStatus: 401 });
	writeMcpConnectorCheck("failed-before", { at: Date.now(), ok: false, httpStatus: 503 });
	const rows = new Map((await getMcpConnectorsStatus()).servers.map((server: any) => [server.name, server]));
	const expected = { "never-checked": true, "said-sign-in": false, "failed-before": true, "own-app": false, "program": false };
	const checked = Object.fromEntries(Object.keys(expected).map((name) => {
		const server: any = rows.get(name);
		return [name, checksInBackground(server, connectorRowState(server, server.lastCheck ?? null, null))];
	}));
	assert(JSON.stringify(checked) === JSON.stringify(expected), `the page checks by itself ${JSON.stringify(expected)}, got ${JSON.stringify(checked)}`);
});

/**
 * Draws page parts in a jsdom page for one section, with the page's own
 * requests answered by `pageFetch`, and puts the process's globals back after.
 */
async function inPage(pageFetch: ((input: unknown, init?: { method?: string; body?: unknown }) => Promise<Response>) | null, body: (page: { container: HTMLElement; dom: any; act: (fn: () => Promise<void> | void) => Promise<void>; render: (element: unknown) => Promise<void> }) => Promise<void>): Promise<void> {
	const { JSDOM } = await import("jsdom");
	// Visual, so the window has the frame timer the page waits on before it moves the focus into a menu.
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { pretendToBeVisual: true });
	// React's DOM was loaded before this window existed, so it takes the page for an old browser
	// and watches a focused field through attachEvent, which jsdom lacks. jsdom draws nothing, so it has no scrolling either.
	Object.assign(dom.window.HTMLElement.prototype, { attachEvent: noop, detachEvent: noop, scrollIntoView: noop });
	// Nor media queries: this page is a desktop-width one.
	Object.assign(dom.window, { matchMedia: (query: string) => ({ matches: false, media: query, addEventListener: noop, removeEventListener: noop }) });
	const globals = globalThis as any;
	const previous = { window: globals.window, document: globals.document, fetch: globals.fetch, act: globals.IS_REACT_ACT_ENVIRONMENT, resizeObserver: globals.ResizeObserver, frame: globals.requestAnimationFrame, cancelFrame: globals.cancelAnimationFrame };
	globals.window = dom.window;
	globals.document = dom.window.document;
	if (pageFetch) globals.fetch = pageFetch;
	// jsdom lays nothing out, so the menu's size watcher has nothing to report.
	globals.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
	globals.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
	globals.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
	globals.IS_REACT_ACT_ENVIRONMENT = true;
	const ownNavigator = !("navigator" in globalThis);
	if (ownNavigator) globals.navigator = dom.window.navigator;
	const { createRoot } = pageRequire("react-dom/client");
	const { act } = pageRequire("react");
	const container = dom.window.document.getElementById("root")!;
	const root = createRoot(container);
	try {
		await body({ container, dom, act, render: (element) => act(async () => root.render(element)) });
	} finally {
		await act(async () => root.unmount());
		globals.window = previous.window;
		globals.document = previous.document;
		globals.fetch = previous.fetch;
		globals.IS_REACT_ACT_ENVIRONMENT = previous.act;
		globals.ResizeObserver = previous.resizeObserver;
		globals.requestAnimationFrame = previous.frame;
		globals.cancelAnimationFrame = previous.cancelFrame;
		if (ownNavigator) delete globals.navigator;
	}
}

/** The real row state for a status row and the check the page holds, with no work under way. */
function workFor(rows: any, check: unknown, activity: unknown = null) {
	return { state: (server: any) => rows.connectorRowState(server, check, activity), busy: () => null, failure: () => null, press: noop, check: noop, disconnect: noop, remove: noop, saved: async () => {}, outOfDate: async () => {} };
}
/** The page's buttons and button links by their words, its way back and Copy aside. */
function offersIn(html: string, words: any): string[] {
	return [...html.matchAll(/<(button|a)\b[^>]*class="[^"]*\brs-btn\b[^"]*"[^>]*>(.*?)<\/\1>/g)].map((found) => text(found[2])).filter((label) => label !== words.details.copy);
}
/** A connector's own page drawn for a status row and a check: its words, and what it offers. */
async function drawnPage(server: any, check: unknown, { readOnly = false, sharedFile = null as string | null, activity = null as unknown } = {}): Promise<{ words: string; offers: string[]; html: string }> {
	const rows = await rowsModule();
	const { ConnectorPage } = await component("connector-page.tsx");
	const html = renderToStaticMarkup(createElement(ConnectorPage, { server, work: workFor(rows, check, activity), readOnly, sharedFile, edit: null, onEdit: noop, onBack: noop, notice: null })) as string;
	return { words: text(html), offers: offersIn(html, rows.CONNECTOR_WORDS), html };
}
/** A connector's row in the list drawn for a status row and a check. */
async function drawnRow(server: any, check: unknown, { readOnly = false, activity = null as unknown } = {}): Promise<{ words: string; status: string | null; button: string | null; tag: string | null }> {
	const rows = await rowsModule();
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const html = renderToStaticMarkup(createElement(ConnectorRow, { server, work: workFor(rows, check, activity), readOnly, onOpen: noop })) as string;
	const tag = /<span class="connector-dir-kind"[^>]*>(.*?)<\/span>/.exec(html)?.[1];
	const status = /<span class="connector-item-status">(.*?)<\/span>/.exec(html)?.[1];
	return { words: text(html), status: status === undefined ? null : text(status), button: /<span class="connector-item-slot">.*?<span class="connector-slot-label">(.*?)<\/span>/.exec(html)?.[1] ?? null, tag: tag === undefined ? null : text(tag) };
}

/**
 * Settings, Connectors as it runs, in a jsdom page (in a section of its own
 * process: the page keeps its first answer about where it runs): the list from the real
 * status, checks by the real adapter (against this smoke's stand-ins), the
 * real sign-in state, and whatever else `answers` stages first. A sign-in is
 * never started for real: a section that presses Connect stages its answer.
 */
async function connectorsPage(answers: (route: string, init?: { method?: string; body?: unknown }) => Response | null | Promise<Response | null>, body: (page: { container: HTMLElement; dom: any; act: (fn: () => Promise<void> | void) => Promise<void>; asked: string[]; waitFor: (what: string, done: () => boolean) => Promise<void>; rowOf: (name: string) => Element | null; openPage: (name: string) => Promise<void>; back: () => Promise<void>; pageButton: (label: string) => HTMLButtonElement | undefined; dialog: () => Element | null }) => Promise<void>, { strict = false } = {}): Promise<void> {
	const { ConnectorsPage } = await component("ConnectorsPage.tsx");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { testMcpServer, getMcpServerLoginState, removeMcpServer } = await import("../src/mcp-admin.js");
	const { startRefusalLookup } = await import("../src/connector-start-check.js");
	const { shownName } = await rowsModule();
	const asked: string[] = [];
	// The page's requests still out: the pane stays until they are answered, so nothing lands after it is gone.
	let open = 0;
	// The page and the adapter share this process's fetch: only the page's own calls are answered here.
	const realFetch = globalThis.fetch;
	await inPage(async (input, init) => {
		if (typeof input !== "string" || !input.startsWith("/api/")) return realFetch(input as string, init as RequestInit);
		open++;
		try {
			return await answerPage(input, init);
		} finally {
			open--;
		}
	}, async ({ container, dom, act, render }) => {
		try {
			await drawn({ container, dom, act, render });
		} finally {
			for (let tries = 0; tries < 200 && open > 0; tries++) await act(() => sleep(50));
		}
	});
	async function answerPage(input: string, init?: { method?: string; body?: unknown }): Promise<Response> {
		const route = `${init?.method ?? "GET"} ${input}`;
		asked.push(route);
		const staged = await answers(route, init);
		if (staged) return staged;
		if (route === "GET /api/remote/client-context") return jsonAnswer({ remote: false, capability: "full", sharedServer: false, person: null });
		if (route === "GET /api/mcp/status") return jsonAnswer(await getMcpConnectorsStatus(startRefusalLookup));
		const one = /^(GET|POST) \/api\/mcp\/servers\/([^/]+)\/(test|login)$/.exec(route);
		if (one?.[1] === "POST" && one[3] === "test") return jsonAnswer(await testMcpServer(decodeURIComponent(one[2])));
		if (one?.[1] === "GET" && one[3] === "login") return jsonAnswer(await getMcpServerLoginState(decodeURIComponent(one[2])));
		// Remove reaches the real removal, so a question answered Keep that removed all the same would show in the app and the rooms.
		const removal = /^DELETE \/api\/mcp\/servers\/([^/]+)$/.exec(route);
		if (removal) return removeMcpServer(decodeURIComponent(removal[1])).then(jsonAnswer, (error: Error & { statusCode?: number }) => jsonAnswer({ error: error.message }, error.statusCode ?? 500));
		throw new Error(`the page asked for ${route}, which this smoke does not answer`);
	}
	async function drawn({ container, dom, act, render }: { container: HTMLElement; dom: any; act: (fn: () => Promise<void> | void) => Promise<void>; render: (element: unknown) => Promise<void> }): Promise<void> {
		// The app's dialog asks what had the focus by this window's own element type.
		const previousElement = (globalThis as any).HTMLElement;
		(globalThis as any).HTMLElement = dom.window.HTMLElement;
		// The app's dialog host sits at its root, beside the pane.
		const { ConfirmDialogHost } = await component("confirm-dialog.tsx");
		const page = createElement(React.Fragment, null, createElement(ConnectorsPage, {}), createElement(ConfirmDialogHost));
		await render(strict ? createElement(React.StrictMode, null, page) : page);
		const waitFor = async (what: string, done: () => boolean) => {
			for (let tries = 0; tries < 200 && !done(); tries++) await act(() => sleep(50));
			assert(done(), `waited for ${what}, the page reads ${container.textContent}`);
		};
		const shown = new Map<string, string>(((await getMcpConnectorsStatus()).servers as any[]).map((server) => [server.name, shownName(server)]));
		const rowOf = (name: string) => [...container.querySelectorAll(".connector-list .connector-item")].find((row) => row.querySelector(".connector-item-name-text")?.textContent === (shown.get(name) ?? name)) ?? null;
		await waitFor("the list", () => container.querySelector(".connector-list, .settings-empty") !== null);
		const openPage = async (name: string) => {
			await waitFor(`${name}'s row`, () => rowOf(name) !== null);
			await click(dom, act, rowOf(name)!.querySelector(".connector-item-hit")!);
			await waitFor(`${name}'s page`, () => container.querySelector(".connector-page") !== null);
		};
		const back = async () => {
			await click(dom, act, container.querySelector(".connector-page-back")!);
			await waitFor("the list", () => container.querySelector(".connector-list") !== null);
		};
		const pageButton = (label: string) => buttonNamed(container.querySelector(".connector-page") ?? container, label);
		const dialog = () => dom.window.document.querySelector(".confirm-dialog-backdrop");
		try {
			await body({ container, dom, act, asked, waitFor, rowOf, openPage, back, pageButton, dialog });
		} finally {
			(globalThis as any).HTMLElement = previousElement;
		}
	}
}

// A key the service turned down is changed on the connector's page: a custom
// connector's edit shows its address and the key, a directory connector's
// shows only the key, since its address is the directory's; saving a key alone
// says the key is saved. Each one's last check, as the server keeps it, is a
// stand-in turning the key down.
await sectionInOwnProcess("change-key", async () => {
	const { CONNECTOR_WORDS } = await rowsModule();
	const { writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const refuser = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => { res.writeHead(401, { "Content-Type": "text/plain" }); res.end("stand-in turned the key down"); });
	});
	await new Promise<void>((resolve) => refuser.listen(0, "127.0.0.1", resolve));
	const at = `http://127.0.0.1:${(refuser.address() as AddressInfo).port}`;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		github: { url: `${at}/mcp`, headers: { Authorization: "Bearer synthetic-key" } },
		"team-wiki": { url: `${at}/wiki`, headers: { Authorization: "Bearer synthetic-key" } },
	} }));
	for (const name of ["github", "team-wiki"]) writeMcpConnectorCheck(name, { at: Date.now(), ok: false, httpStatus: 401, error: "HTTP 401" });
	const saves: unknown[] = [];
	let listHeld: Promise<void> | null = null;
	try {
		await connectorsPage(async (route, init) => {
			if (route.startsWith("PUT /api/mcp/servers/")) {
				saves.push(JSON.parse(String(init?.body)));
				return jsonAnswer({ sameSite: true });
			}
			if (route === "GET /api/mcp/status" && listHeld) await listHeld;
			return null;
		}, async ({ container, dom, act, waitFor, openPage, back, pageButton }) => {
			const fieldsAfterChangeKey = async (name: string) => {
				await openPage(name);
				await waitFor(`${name}'s turned-down key offers ${CONNECTOR_WORDS.button.changeKey}`, () => pageButton(CONNECTOR_WORDS.button.changeKey) !== undefined);
				await click(dom, act, pageButton(CONNECTOR_WORDS.button.changeKey)!);
				const field = (label: string) => container.querySelector(`.connector-edit input[aria-label="${label}"]`) !== null;
				return { address: field(CONNECTOR_WORDS.details.address), key: field(CONNECTOR_WORDS.details.key) };
			};
			const custom = await fieldsAfterChangeKey("team-wiki");
			assert(custom.address && custom.key, `a custom connector's key edit shows its address and the key, got ${JSON.stringify(custom)}`);
			await back();
			const directory = await fieldsAfterChangeKey("github");
			assert(!directory.address && directory.key, `a directory connector's key edit shows only the key, got ${JSON.stringify(directory)}`);
			// Nothing typed, nothing to save; a new key alone is saved as a key, not as a new address.
			const saveButton = () => [...container.querySelectorAll<HTMLButtonElement>(".connector-edit button")].find((found) => found.textContent === CONNECTOR_WORDS.button.save);
			assert(saveButton()?.disabled === true, "the key edit's Save waits for a new key");
			await typeInto(dom, act, container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.key}"]`)!, "synthetic-new-key");
			const save = saveButton();
			assert(save && !save.disabled, "the key edit offers Save once a key is typed");
			// Saved, it reads Checking… while it is read again, never its old state or a step for it.
			let releaseList = () => {};
			listHeld = new Promise<void>((resolve) => { releaseList = resolve; });
			await click(dom, act, save);
			await waitFor("the saved line", () => container.querySelector(".connector-notice") !== null);
			const statusNow = container.querySelector(".connector-page .connector-facts .connector-item-status")?.textContent;
			listHeld = null;
			await act(async () => releaseList());
			assert(statusNow === CONNECTOR_WORDS.status.checking, `a saved key reads Checking… while the list is read again, got ${statusNow}`);
			assert(container.querySelector(".connector-notice")?.textContent === CONNECTOR_WORDS.keySaved, `saving a new key alone says the key is saved, got ${container.querySelector(".connector-notice")?.textContent}`);
			assert(JSON.stringify(saves) === JSON.stringify([{ url: `${at}/mcp`, key: "synthetic-new-key" }]), `the key goes with the address it had, got ${JSON.stringify(saves)}`);
		});
	} finally {
		refuser.closeAllConnections();
		refuser.close();
	}
	// A first key, for one added by its address without one, is kept exactly as Add keeps a key given there, its
	// other headers beside it; its rooms and its tool choices stay. One with its own sign-in app can't take one, as at Add.
	{
		const { addMcpServer, changeMcpServerAddress } = await import("../src/mcp-admin.js");
		const { setConnectorToolChoices, readConnectorToolChoices } = await import("../src/connector-tool-choices.js");
		const { readPersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
		const { CONNECTOR_FORM_LINES } = await import("../src/connector-form.js");
		const address = (name: string) => `http://127.0.0.1:9/${name}`;
		const tenant = { "X-Tenant": "acme" };
		const later = await addMcpServer({ name: "Key later", url: address("key-later"), headers: tenant });
		const atAdd = await addMcpServer({ name: "Key at add", url: address("key-at-add"), bearerToken: "synthetic-first-key", headers: tenant });
		const room = await roomWith(later.name);
		setConnectorToolChoices(later.name, { search: { choice: "blocked" }, read: { choice: "ask" } });
		const choicesBefore = JSON.stringify(readConnectorToolChoices());
		const changed = await changeMcpServerAddress(later.name, { url: address("key-later"), key: "synthetic-first-key" });
		assert(changed.sameSite, "a first key at the same address stays on its site");
		const entries = () => JSON.parse(fs.readFileSync(path.join(agentDir, "mcp.json"), "utf-8")).mcpServers;
		// Compared whole but for its own name and address, and only the fields' names are ever printed: the key stays out of the output.
		const sorted = (entry: Record<string, unknown>) => JSON.stringify(Object.fromEntries(Object.entries({ ...entry, url: null, displayName: null }).sort(([one], [other]) => one.localeCompare(other))));
		const [given, added] = [entries()[later.name], entries()[atAdd.name]];
		assert(sorted(given) === sorted(added), `a first key is kept as Add keeps one, got the fields ${JSON.stringify(Object.keys(given))} beside ${JSON.stringify(Object.keys(added))}`);
		assert(readPersistentRoomMcpSettings(room).grantedConnectors.includes(later.name), "a first key leaves it on in its room");
		assert(JSON.stringify(readConnectorToolChoices()) === choicesBefore, "a first key leaves its tool choices as they were");
		const withApp = await addMcpServer({ name: "App later", url: address("app-later"), oauth: { clientId: "synthetic-client" } });
		const before = JSON.stringify(entries()[withApp.name]);
		let refusal = "";
		try {
			await changeMcpServerAddress(withApp.name, { url: address("app-later"), key: "synthetic-first-key" });
		} catch (error) {
			refusal = (error as Error).message;
		}
		assert(refusal === CONNECTOR_FORM_LINES.keyAndSignInApp && JSON.stringify(entries()[withApp.name]) === before, `one with its own sign-in app is refused a key, as at Add, and unchanged, got ${JSON.stringify(refusal)}`);
	}

	// After adding from the directory, Connect is the next step only for one that signs in.
	const { addedNotice } = await rowsModule();
	for (const [kind, line] of [["oauth", CONNECTOR_WORDS.addedFromDirectory("X")], ["open", CONNECTOR_WORDS.addedCustom("X")], ["token", CONNECTOR_WORDS.addedCustom("X")]]) {
		assert(addedNotice({ name: "X", kind }) === line, `adding a ${kind} entry says ${JSON.stringify(line)}, got ${JSON.stringify(addedNotice({ name: "X", kind }))}`);
	}
});

// Esc in the Add connector menu closes it (the browser smokes hold that it
// leaves the Settings window open). Saving an address on the same site says
// so and checks it at once, a connector that needs no sign-in included. A
// sign-in that failed can be checked from its page, as its line says, and a
// page says when no room uses it.
await sectionInOwnProcess("menu-and-save", async () => {
	const { getMcpConnectorsStatus, writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const missing = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("not here"); });
	});
	await new Promise<void>((resolve) => missing.listen(0, "127.0.0.1", resolve));
	const at = `http://127.0.0.1:${(missing.address() as AddressInfo).port}`;
	const name = "plain-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: `${at}/plain` } } }));
	writeMcpConnectorCheck(name, { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" });
	const server: any = (await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name);
	assert(server && server.auth.mode === "oauth" && !server.auth.explicit && !server.auth.hasStoredTokens, `${name} is a bare address that may need no sign-in, got ${JSON.stringify(server?.auth)}`);
	// Each case is told apart, so one run shows every one that fails.
	const problems: string[] = [];
	if (!(await drawnPage(server, null, { activity: { kind: "sign-in-failed", error: "no sign-in here" } })).offers.includes(CONNECTOR_WORDS.button.checkConnection)) problems.push("a failed sign-in's page offers Check connection");
	try {
		await connectorsPage((route) => (route === `PUT /api/mcp/servers/${name}/address` ? jsonAnswer({ name, sameSite: true }) : null), async ({ container, dom, act, asked, waitFor, openPage, pageButton }) => {
			// The Add connector menu: Esc on its item closes it.
			await click(dom, act, container.querySelector(".connector-add-btn")!);
			const item = await (async () => {
				await waitFor("the Add connector menu", () => dom.window.document.querySelector(".ai-profile-menu [role=menuitem]") !== null);
				return dom.window.document.querySelector(".ai-profile-menu [role=menuitem]")!;
			})();
			await act(async () => { item.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
			if (dom.window.document.querySelector(".ai-profile-menu") !== null) problems.push("Esc closes the Add connector menu");
			await openPage(name);
			// No room uses it, and its page says so (a phone hides the row's rooms link).
			const facts = [...container.querySelectorAll(".connector-facts .connector-fact")].map((fact) => [fact.querySelector(".settings-row-label")?.textContent, fact.querySelector(".connector-fact-value")?.textContent]);
			if (!facts.some(([label, value]) => label === CONNECTOR_WORDS.details.usedIn && value === CONNECTOR_WORDS.roomsLink(0))) problems.push(`a page no room uses says so under ${CONNECTOR_WORDS.details.usedIn}, got ${JSON.stringify(facts)}`);
			await waitFor(`a missing address offers ${CONNECTOR_WORDS.button.changeAddress}`, () => pageButton(CONNECTOR_WORDS.button.changeAddress) !== undefined);
			await click(dom, act, pageButton(CONNECTOR_WORDS.button.changeAddress)!);
			const saveButton = () => [...container.querySelectorAll<HTMLButtonElement>(".connector-edit button")].find((found) => found.textContent === CONNECTOR_WORDS.button.save);
			if (saveButton()?.disabled !== true) problems.push("the address edit's Save waits for a change");
			const addressField = () => container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!;
			await act(async () => { addressField().dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
			await act(() => sleep(50));
			if (asked.includes(`PUT /api/mcp/servers/${name}/address`) || container.querySelector(".connector-notice")) problems.push(`Enter in the address edit waits for a change, as Save does, the page asked ${JSON.stringify(asked)}`);
			// A new address on the same site.
			await typeInto(dom, act, addressField(), `${at}/plain/mcp`);
			const save = saveButton();
			assert(save && !save.disabled, "the address edit offers Save once the address changes");
			const checksBefore = asked.filter((route) => route === `POST /api/mcp/servers/${name}/test`).length;
			await click(dom, act, save);
			await waitFor("the check after the save", () => asked.filter((route) => route === `POST /api/mcp/servers/${name}/test`).length > checksBefore);
			if (container.querySelector(".connector-notice")?.textContent !== CONNECTOR_WORDS.addressSaved) problems.push(`an address save says the address is saved, got ${JSON.stringify(container.querySelector(".connector-notice")?.textContent)}`);
		});
	} finally {
		missing.closeAllConnections();
		missing.close();
	}
	assert(problems.length === 0, problems.join("; "));
});

// A program's command sits right under What went wrong, where a web
// connector's address sits, so "Check its command" points at the next line;
// where it stands comes after, then the rooms it is on in.
await section("details-order", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const words = CONNECTOR_WORDS.details;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "local-files": { command: "node", args: ["files-server.js"] }, "plain-wiki": { url: "http://127.0.0.1:9/plain" } } }));
	const servers: any[] = (await getMcpConnectorsStatus()).servers;
	const orders: Record<string, (string | null)[]> = {};
	for (const name of ["local-files", "plain-wiki"]) {
		const server = servers.find((row: { name: string }) => row.name === name);
		assert(server, `${name} is listed`);
		const check = name === "plain-wiki" ? { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" } : { at: Date.now(), ok: false, error: "spawn node ENOENT" };
		const { html } = await drawnPage(server, check);
		orders[name] = [...html.matchAll(/<span class="settings-row-label">(.*?)<\/span>/g)].map((found) => text(found[1])).filter((label) => label !== CONNECTOR_WORDS.remove.title);
	}
	assert(JSON.stringify(orders["plain-wiki"]) === JSON.stringify([words.wentWrong, words.address, words.key, words.connection, words.usedIn]), `a web connector's page reads What went wrong, Web address, Key, Connection, On in, got ${JSON.stringify(orders["plain-wiki"])}`);
	assert(JSON.stringify(orders["local-files"]) === JSON.stringify([words.wentWrong, words.runs, words.connection, words.usedIn]), `a program's page reads What went wrong, Runs, Connection, On in, got ${JSON.stringify(orders["local-files"])}`);
});

// A check the server says outlived a change to its connector (a new address
// meanwhile) is not about it any more: the page keeps nothing of it. An
// ordinary answer next to it is kept.
await sectionInOwnProcess("superseded-check", async () => {
	const { writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const name = "moving-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/moving", auth: false } } }));
	writeMcpConnectorCheck(name, { at: Date.now(), ok: true });
	// It answers, until a check below says otherwise.
	let answer: Record<string, unknown> = { ok: true, toolCount: 0 };
	await connectorsPage((route) => (route === `POST /api/mcp/servers/${name}/test` ? jsonAnswer(answer) : null), async ({ container, dom, act, asked, waitFor, openPage, pageButton }) => {
		await openPage(name);
		const status = () => container.querySelector(".connector-page .connector-facts .connector-item-status")?.textContent;
		const checkWith = async (reply: Record<string, unknown>) => {
			answer = reply;
			const before = asked.filter((route) => route === `GET /api/mcp/status`).length;
			await click(dom, act, pageButton(CONNECTOR_WORDS.button.checkConnection)!);
			// The check has ended once the list is read again after it.
			await waitFor("the check to end", () => asked.filter((route) => route === `GET /api/mcp/status`).length > before && status() !== CONNECTOR_WORDS.status.checking);
			return status();
		};
		assert((await checkWith({ ok: false, httpStatus: 404, error: "HTTP 404", superseded: true })) === CONNECTOR_WORDS.status.connected, `a superseded check's answer is not kept, it reads ${status()}`);
		assert((await checkWith({ ok: false, httpStatus: 404, error: "HTTP 404" })) === CONNECTOR_WORDS.status.cantConnect, "an ordinary check's answer is kept");
	});
});

/** Types into a field as the page's React reads typing in this window: a key event in a focused field. */
async function typeInto(dom: any, act: (fn: () => Promise<void> | void) => Promise<void>, field: HTMLInputElement, value: string): Promise<void> {
	await act(async () => {
		field.focus();
		Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(field, value);
		field.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "x", bubbles: true }));
	});
}


// The check of a program that downloads at its first start, ending just
// before its page would say it is getting ready, while the list is read
// again, leaves it as the check found it, with no Cancel; one that runs past
// that says it is getting ready, with Cancel, until it ends. Check connection
// is pressed on its page.
await sectionInOwnProcess("getting-ready-ends", async () => {
	const { writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const name = "slow-notes";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { command: "uvx", args: ["notes-server"] } } }));
	writeMcpConnectorCheck(name, { at: Date.now(), ok: true });
	// The page says such a program is getting ready after 3 seconds of its check.
	const READY_AFTER_MS = 3000;
	let answerAfter = 0;
	let listReadTakes = 0;
	let listReads = 0;
	await connectorsPage(async (route) => {
		if (route === `POST /api/mcp/servers/${name}/test`) {
			await sleep(answerAfter);
			return jsonAnswer({ ok: true, toolCount: 1 });
		}
		if (route === "GET /api/mcp/status") {
			await sleep(listReadTakes);
			listReads++;
		}
		return null;
	}, async ({ container, dom, act, waitFor, openPage, pageButton }) => {
		await openPage(name);
		const status = () => container.querySelector(".connector-page .connector-facts .connector-item-status")?.textContent;
		const stateButton = () => container.querySelector(".connector-page .connector-facts .connector-fact:not(.connector-fact-wrong) .connector-slot-label")?.textContent ?? null;
		answerAfter = 0;
		listReadTakes = READY_AFTER_MS + 1500;
		const readsBefore = listReads;
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.checkConnection)!);
		let saidReady = false;
		await waitFor("the list read after the check", () => {
			if (status() === CONNECTOR_WORDS.status.gettingReady) saidReady = true;
			return listReads > readsBefore;
		});
		assert(!saidReady && status() === CONNECTOR_WORDS.status.connected && stateButton() === null, `a check that ended before the list was read again leaves it as it found it, got ${JSON.stringify([saidReady, status(), stateButton()])}`);
		answerAfter = READY_AFTER_MS + 1000;
		listReadTakes = 0;
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.checkConnection)!);
		await waitFor("it to say it is getting ready", () => status() === CONNECTOR_WORDS.status.gettingReady);
		assert(stateButton() === CONNECTOR_WORDS.button.cancel, `a long check offers Cancel, got ${JSON.stringify(stateButton())}`);
		await waitFor("the long check to end", () => status() !== CONNECTOR_WORDS.status.gettingReady);
		assert(status() === CONNECTOR_WORDS.status.connected && stateButton() === null, `a long check that ends leaves it as it found it, got ${JSON.stringify([status(), stateButton()])}`);
	});
});

// A shared server refuses a first key as it did, with the same sentence, and
// writes nothing: what a first key means there for who may use the connector
// is not decided here. Its neighbour on this computer is "change-key".
await sectionInOwnProcess("first-key-shared-server", async () => {
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	const { addMcpServer, changeMcpServerAddress } = await import("../src/mcp-admin.js");
	const { CONNECTOR_FORM_LINES } = await import("../src/connector-form.js");
	const added = await addMcpServer({ name: "Key later", url: "http://127.0.0.1:9/key-later" });
	const file = path.join(agentDir, "mcp.json");
	const before = fs.readFileSync(file, "utf-8");
	let refusal = "";
	try {
		await changeMcpServerAddress(added.name, { url: "http://127.0.0.1:9/key-later", key: "synthetic-first-key" });
	} catch (error) {
		refusal = (error as Error).message;
	}
	assert(refusal === CONNECTOR_FORM_LINES.keyNotChangeable, `a shared server refuses a first key with its sentence, got ${JSON.stringify(refusal)}`);
	assert(fs.readFileSync(file, "utf-8") === before, "a refused first key writes nothing");
});

// The check the page starts by itself, behind the list, ending while the
// person's own check of that connector still runs, leaves the row "Checking…"
// with the pressed button busy, until the person's check ends.
await sectionInOwnProcess("background-check-yields", async () => {
	const { writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const name = "busy-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/busy-wiki" } } }));
	writeMcpConnectorCheck(name, { at: Date.now(), ok: false, httpStatus: 503, error: "HTTP 503" });
	const held: Array<() => void> = [];
	let listReads = 0;
	await connectorsPage(async (route) => {
		if (route === "GET /api/mcp/status") listReads++;
		if (route !== `POST /api/mcp/servers/${name}/test`) return null;
		await new Promise<void>((resolve) => held.push(resolve));
		return jsonAnswer(held.length === 1 ? { ok: false, httpStatus: 503, error: "HTTP 503" } : { ok: true, toolCount: 1 });
	}, async ({ dom, act, waitFor, rowOf }) => {
		const status = () => rowOf(name)?.querySelector(".connector-item-status")?.textContent;
		await waitFor("the check behind the list", () => held.length === 1);
		// Behind the list it shows what was last known, with Try again.
		await waitFor("Try again on its row", () => buttonNamed(rowOf(name)!, CONNECTOR_WORDS.button.tryAgain) !== undefined);
		await click(dom, act, buttonNamed(rowOf(name)!, CONNECTOR_WORDS.button.tryAgain)!);
		await waitFor("the person's own check", () => held.length === 2);
		assert(status() === CONNECTOR_WORDS.status.checking, `the person's check reads Checking…, got ${status()}`);
		// Once the check behind the list has ended, the list is read again.
		const readsBefore = listReads;
		await act(async () => held[0]());
		await waitFor("the list read after the check behind it", () => listReads > readsBefore);
		assert(status() === CONNECTOR_WORDS.status.checking && buttonNamed(rowOf(name)!, CONNECTOR_WORDS.button.tryAgain)?.getAttribute("aria-busy") === "true", `the check behind the list ending leaves the person's own running, got ${JSON.stringify([status(), rowOf(name)?.textContent])}`);
		await act(async () => held[1]());
		await waitFor("the person's check to end", () => status() === CONNECTOR_WORDS.status.connected);
	});
});

// A new address on another site: the line under the field says what the move
// keeps and what the person must do again, a key is asked for and Save waits
// for it; one that would lose its own sign-in app or a header that isn't its
// key can't move there, and Save stays off. Change address is pressed on each
// connector's page; Remove under the line asks the app's question.
await sectionInOwnProcess("another-site-edit", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { CONNECTOR_WORDS, shownName } = await rowsModule();
	const { CONNECTOR_FORM_LINES } = await import("../src/connector-form.js");
	const url = (name: string) => `http://127.0.0.1:9/${name}`;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		"key-wiki": { url: url("key-wiki"), auth: "bearer", bearerToken: "synthetic-key" },
		"open-wiki": { url: url("open-wiki"), auth: false },
		"signed-wiki": { url: url("signed-wiki") },
		"key-and-signed": { url: url("key-and-signed"), headers: { "X-Api-Key": "synthetic-key" } },
		"app-wiki": { url: url("app-wiki"), oauth: { clientId: "synthetic-client" } },
		"tenant-wiki": { url: url("tenant-wiki"), headers: { "X-Tenant": "acme" } },
	} }));
	const later = Math.floor(Date.now() / 1000) + 3600;
	for (const name of ["signed-wiki", "key-and-signed"]) authStore.updateTokens(name, { accessToken: "synthetic-token", expiresAt: later }, url(name));
	const rows = new Map((await getMcpConnectorsStatus()).servers.map((server: any) => [server.name, server]));
	const lines = CONNECTOR_FORM_LINES;
	const cases: Array<[string, { hint: string | null; key: boolean; save: boolean }]> = [
		["key-wiki", { hint: lines.anotherSiteKey, key: true, save: false }],
		["open-wiki", { hint: null, key: false, save: true }],
		["signed-wiki", { hint: lines.anotherSiteSignIn, key: false, save: true }],
		["key-and-signed", { hint: lines.anotherSiteKeyAndSignIn, key: true, save: false }],
		["app-wiki", { hint: lines.cantMoveSite, key: false, save: false }],
		["tenant-wiki", { hint: lines.cantMoveSite, key: false, save: false }],
	];
	const problems: string[] = [];
	const keepRooms = new Map<string, string>();
	for (const [name] of cases) keepRooms.set(name, await roomWith(name));
	await connectorsPage(() => null, async ({ container, dom, act, asked, waitFor, openPage, back, pageButton, dialog }) => {
		for (const [name, expected] of cases) {
			const server = rows.get(name);
			assert(server, `${name} is on the page`);
			await openPage(name);
			await waitFor(`${name}'s page offers ${CONNECTOR_WORDS.button.changeAddress}`, () => pageButton(CONNECTOR_WORDS.button.changeAddress) !== undefined);
			await click(dom, act, pageButton(CONNECTOR_WORDS.button.changeAddress)!);
			const address = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!;
			await typeInto(dom, act, address, `http://localhost:9/${name}`);
			const keyField = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.key}"]`);
			const got = { hint: container.querySelector(".connector-edit-hint")?.textContent ?? null, key: keyField !== null, save: buttonNamed(container, CONNECTOR_WORDS.button.save)?.disabled === false };
			if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`${name} on another site should show ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
			// The line that says to remove it has Remove under it, asking the app's own question; no other line has one.
			const remove = [...container.querySelectorAll<HTMLButtonElement>(".connector-edit button.connector-way")].find((button) => button.textContent === CONNECTOR_WORDS.button.remove);
			if (Boolean(remove) !== (expected.hint === lines.cantMoveSite)) problems.push(`${name} on another site ${remove ? "shows" : "has no"} Remove under its line`);
			// Enter on a button presses that button: the edit leaves its key alone.
			for (const button of [remove, buttonNamed(container, CONNECTOR_WORDS.button.cancel)]) {
				if (!button) continue;
				const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
				await act(async () => { button.dispatchEvent(enter); });
				if (enter.defaultPrevented) problems.push(`${name}: Enter on ${button.textContent} is held back, so the button doesn't press`);
			}
			if (remove) {
				await click(dom, act, remove);
				await waitFor(`${name}'s Remove question`, () => dialog() !== null);
				const question = dialog()!.querySelector("h2")?.textContent;
				if (question !== CONNECTOR_WORDS.removeQuestion(shownName(server))) problems.push(`${name}'s Remove should ask the app's question, got ${question ?? "none"}`);
				await click(dom, act, buttonNamed(dialog()!, CONNECTOR_WORDS.button.keep)!);
				await waitFor(`${name}'s Remove question to close`, () => dialog() === null);
				const kept = await keptAfterKeep(name, asked, keepRooms.get(name)!);
				assert(kept.length === 0, kept.join("; "));
			}
			if (keyField) {
				await typeInto(dom, act, keyField, "synthetic-new-key");
				if (buttonNamed(container, CONNECTOR_WORDS.button.save)?.disabled !== false) problems.push(`${name}'s Save comes on once the key is typed`);
			}
			await back();
		}
	});
	assert(problems.length === 0, problems.join("; "));
});

// A line that says to remove a connector added here leaves Remove to the
// page's Remove row, which asks the app's question; a connector from a file
// names the file where one from another app names the app, by the path the
// page's line about it shows.
await sectionInOwnProcess("remove-way-and-file-note", async () => {
	const { getMcpConnectorsStatus, writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS, shownName } = await rowsModule();
	const url = (name: string) => `http://127.0.0.1:9/${name}`;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		"two-keys": { url: url("two-keys"), auth: false, headers: { "X-Api-Key": "synthetic-one", Authorization: "Bearer synthetic-two" } },
		"one-key": { url: url("one-key"), auth: false, headers: { "X-Api-Key": "synthetic-one" } },
	} }));
	const sharedFile = path.join(tempHome, ".config", "mcp", "mcp.json");
	fs.mkdirSync(path.dirname(sharedFile), { recursive: true });
	fs.writeFileSync(sharedFile, JSON.stringify({ mcpServers: { "shared-wiki": { url: url("shared-wiki"), headers: { "X-Api-Key": "synthetic-one" } } } }));
	const status = await getMcpConnectorsStatus();
	const rows = new Map(status.servers.map((row: any) => [row.name, row]));
	const sharedPath = status.configSources.find((source: { path: string }) => !source.path.includes(".exxperts"))?.path ?? null;
	assert(sharedPath, `the status names the shared file, got ${JSON.stringify(status.configSources)}`);
	const project = { ...rows.get("shared-wiki"), name: "project-wiki", source: { kind: "project", path: "~/work/.mcp.json" }, inSharedFile: undefined };
	const refused = { at: Date.now(), ok: false, httpStatus: 403, error: "HTTP 403: Forbidden" };
	const draw = (server: any, readOnly = false) => drawnPage(server, refused, { readOnly, sharedFile: sharedPath });
	// The buttons in the What went wrong row alone: up to the next fact row.
	const besideTheLine = (html: string) => {
		const at = html.indexOf("connector-fact-wrong");
		if (at < 0) return [];
		const end = html.indexOf('class="settings-row connector-fact"', at);
		return offersIn(html.slice(at, end < 0 ? undefined : end), CONNECTOR_WORDS);
	};
	const note = (html: string) => { const found = /<p class="connector-note">(.*?)<\/p>/.exec(html)?.[1]; return found === undefined ? null : text(found); };
	// Two keys: the line says to remove it and add it again; the page's one Remove is its Remove row's.
	const twoKeys = await draw(rows.get("two-keys"));
	assert(twoKeys.words.includes(CONNECTOR_WORDS.wentWrong.keyFixed.fact) && JSON.stringify(besideTheLine(twoKeys.html)) === "[]" && twoKeys.offers.filter((label) => label === CONNECTOR_WORDS.button.remove).length === 1, `two keys: the line, nothing beside it, one Remove on the page, got ${JSON.stringify(twoKeys.offers)}: ${twoKeys.words}`);
	// One key: Change key is its way on, beside the line, and nothing says to remove it.
	const oneKey = await draw(rows.get("one-key"));
	assert(JSON.stringify(besideTheLine(oneKey.html)) === JSON.stringify([CONNECTOR_WORDS.button.changeKey]), `one key: Change key beside the line, got ${JSON.stringify(besideTheLine(oneKey.html))}`);
	assert(note(oneKey.html) === null, `a connector added here names no file, got ${note(oneKey.html)}`);
	// Over remote access no Remove at all.
	assert(!(await draw(rows.get("two-keys"), true)).offers.includes(CONNECTOR_WORDS.button.remove), "over remote access no Remove");
	// From the shared file: its line sends the person there, with nothing beside it, and the page names the file as the list's line does.
	const sharedWiki = await draw(rows.get("shared-wiki"));
	const shared = CONNECTOR_WORDS.addedInSharedFile;
	assert(JSON.stringify(besideTheLine(sharedWiki.html)) === "[]", `a shared file's line has nothing beside it, got ${JSON.stringify(besideTheLine(sharedWiki.html))}`);
	assert(note(sharedWiki.html) === `${shared.before}${sharedPath}${shared.after}`, `a connector from the shared file names it, got ${note(sharedWiki.html)}`);
	// From a file in the folder exxperts runs from: the page names that file.
	const own = CONNECTOR_WORDS.addedInProjectFile;
	assert(note((await draw(project)).html) === `${own.before}~/work/.mcp.json${own.after}`, `a connector from a project's file names it, got ${note((await draw(project)).html)}`);
	// The page's Remove asks the app's question, named as the list names it.
	writeMcpConnectorCheck("two-keys", refused);
	const keepRoom = await roomWith("two-keys");
	await connectorsPage(() => null, async ({ dom, act, asked, waitFor, openPage, pageButton, dialog }) => {
		await openPage("two-keys");
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.remove)!);
		await waitFor("the Remove question", () => dialog() !== null);
		assert(dialog()!.querySelector("h2")?.textContent === CONNECTOR_WORDS.removeQuestion(shownName(rows.get("two-keys"))), `Remove asks the app's question, got ${dialog()!.textContent}`);
		await click(dom, act, buttonNamed(dialog()!, CONNECTOR_WORDS.button.keep)!);
		await waitFor("the question to close", () => dialog() === null);
		const kept = await keptAfterKeep("two-keys", asked, keepRoom);
		assert(kept.length === 0, kept.join("; "));
	});
});

// A removal whose clean-up fails once the connector's files are written: the
// last check can't be forgotten, as its file can't be written. The delete
// answers that it happened and the page shows the connector gone; one added
// later by the same name starts with no last check all the same.
await sectionInOwnProcess("remove-after-files", async () => {
	const { readMcpConnectorChecks, writeMcpConnectorCheck, getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { addMcpServer, removeMcpServer } = await import("../src/mcp-admin.js");
	const { readPersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const url = "http://127.0.0.1:9/team-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "team-wiki": { url, auth: false } } }));
	writeMcpConnectorCheck("team-wiki", { at: Date.now(), ok: false, httpStatus: 403, error: "HTTP 403: Forbidden" });
	const room = await roomWith("team-wiki");
	// The checks file is written through a temporary file named by this process: a folder in its place stops the write.
	const blocked = path.join(agentDir, `mcp-connector-checks.json.${process.pid}.tmp`);
	fs.mkdirSync(path.join(blocked, "in-the-way"), { recursive: true });
	const answered: number[] = [];
	await connectorsPage(async (route) => {
		const removal = /^DELETE \/api\/mcp\/servers\/([^/]+)$/.exec(route);
		if (!removal) return null;
		try {
			const removed = await removeMcpServer(decodeURIComponent(removal[1]));
			answered.push(200);
			return jsonAnswer(removed);
		} catch (error) {
			const status = (error as { statusCode?: number }).statusCode ?? 500;
			answered.push(status);
			return jsonAnswer({ error: (error as Error).message }, status);
		}
	}, async ({ container, dom, act, waitFor, rowOf, openPage, pageButton, dialog }) => {
		await openPage("team-wiki");
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.remove)!);
		await waitFor("the Remove question", () => dialog() !== null);
		await click(dom, act, buttonNamed(dialog()!, CONNECTOR_WORDS.button.remove)!);
		await waitFor("the delete's answer", () => answered.length > 0);
		assert(JSON.stringify(answered) === "[200]", `a removal whose files are written answers 200, got ${JSON.stringify(answered)}`);
		await waitFor("the list without it", () => container.querySelector(".connector-page") === null && rowOf("team-wiki") === null);
		assert(!(container.textContent ?? "").includes(CONNECTOR_WORDS.remove.failed), `the page says nothing failed, it reads ${container.textContent}`);
	});
	assert(!(await getMcpConnectorsStatus()).servers.some((server: { name: string }) => server.name === "team-wiki"), "the app no longer has it");
	assert(!readPersistentRoomMcpSettings(room).grantedConnectors.includes("team-wiki"), "the room no longer has it on");
	fs.rmSync(blocked, { recursive: true });
	// The old check is still in its file: a namesake added now must not read it.
	assert(Object.hasOwn(readMcpConnectorChecks(), "team-wiki"), "the failed clean-up left the old check in its file");
	const added = await addMcpServer({ name: "Team wiki", url });
	assert(added.name === "team-wiki", `the namesake takes the same name, got ${added.name}`);
	const namesake = (await getMcpConnectorsStatus()).servers.find((server: { name: string }) => server.name === "team-wiki");
	assert(namesake && namesake.lastCheck === null, `a namesake starts with no last check, got ${JSON.stringify(namesake?.lastCheck)}`);
});

// An answer that says the page is out of date: the list is read again, so a
// connector that no longer exists leaves it, and one that can't be changed
// here says so on its page with the edit closed.
await sectionInOwnProcess("out-of-date", async () => {
	const { writeMcpConnectorCheck } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS } = await rowsModule();
	const { CONNECTOR_FORM_LINES } = await import("../src/connector-form.js");
	const name = "stale-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/stale", auth: false } } }));
	writeMcpConnectorCheck(name, { at: Date.now(), ok: true });
	const answers: Record<string, Response> = { [`POST /api/mcp/servers/${name}/test`]: jsonAnswer({ ok: true, toolCount: 0 }) };
	await connectorsPage((route) => answers[route]?.clone() ?? null, async ({ container, dom, act, asked, waitFor, openPage, pageButton, dialog }) => {
		const reads = () => asked.filter((route) => route === "GET /api/mcp/status").length;
		const pageError = () => container.querySelector(".connector-page-error span")?.textContent;
		await openPage(name);
		// Change address refused because it was moved to a file this page doesn't change.
		answers[`PUT /api/mcp/servers/${name}/address`] = jsonAnswer({ error: CONNECTOR_FORM_LINES.addressNotChangeable }, 409);
		let before = reads();
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.changeAddress)!);
		await typeInto(dom, act, container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!, "http://127.0.0.1:9/stale/v2");
		// Saved by the button, as a click takes the focus from the field first.
		await act(async () => { (dom.window.document.activeElement as HTMLElement | null)?.blur(); });
		await click(dom, act, buttonNamed(container, CONNECTOR_WORDS.button.save)!);
		await waitFor("the list read again after a change refused as out of date", () => reads() > before);
		await waitFor("the page to say why", () => pageError() === CONNECTOR_FORM_LINES.addressNotChangeable);
		assert(container.querySelector(".connector-edit") === null, `the edit closes, got ${container.textContent}`);
		// A check of a connector that no longer exists.
		answers[`POST /api/mcp/servers/${name}/test`] = jsonAnswer({ error: CONNECTOR_REQUEST_LINES.noLongerExists }, 404);
		before = reads();
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.checkConnection)!);
		await waitFor("the list read again after a check of a connector that no longer exists", () => reads() > before);
		// Remove refused: added somewhere this page doesn't change.
		answers[`DELETE /api/mcp/servers/${name}`] = jsonAnswer({ error: CONNECTOR_REQUEST_LINES.notRemovable(null) }, 409);
		before = reads();
		await click(dom, act, pageButton(CONNECTOR_WORDS.button.remove)!);
		await waitFor("the Remove question", () => dialog() !== null);
		await click(dom, act, buttonNamed(dialog()!, CONNECTOR_WORDS.button.remove)!);
		await waitFor("the list read again after a refused Remove", () => reads() > before);
		await waitFor("the page to say why Remove was refused", () => pageError() === CONNECTOR_REQUEST_LINES.notRemovable(null));
		assert(!buttonNamed(container.querySelector(".connector-page-error")!, CONNECTOR_WORDS.button.tryAgain), "a Remove refused for good offers no Try again");
	});
});

// Over remote access the page changes nothing, so a line shows its fact
// alone, and "this computer" is the computer itself, not the device in hand.
// Each is the row and the page drawn together.
await section("remote-words", async () => {
	const { CONNECTOR_WORDS, lineText } = await rowsModule();
	const auth = { mode: "none", explicit: false, hasStoredTokens: false, tokenExpired: null, hasRefreshToken: false };
	const base = { tools: null, usedIn: [], lastCheck: null, key: "none", movesToAnotherSite: true, source: { kind: "user", path: "~/.exxperts/agent/mcp.json" }, auth };
	const web = { ...base, name: "team-wiki", transport: "http", target: "http://127.0.0.1:9/wiki", editable: true };
	const program = { ...base, name: "local-files", transport: "stdio", target: "node files-server.js", editable: false };
	const drawn = async (server: unknown, check: unknown, readOnly: boolean) => `${(await drawnRow(server, check, { readOnly })).words} ${(await drawnPage(server, check, { readOnly })).words}`;
	const notFound = { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" };
	const words = CONNECTOR_WORDS.wentWrong;
	const remoteWeb = await drawn(web, notFound, true);
	assert(remoteWeb.includes(words.addressNotFound.fact) && !remoteWeb.includes(words.addressNotFound.way!), `over remote access the line is its fact alone, got ${remoteWeb}`);
	assert((await drawn(web, notFound, false)).includes(lineText(words.addressNotFound, false)), "on the computer itself the line keeps its way on");
	const remoteProgram = await drawn(program, null, true);
	assert(remoteProgram.includes(CONNECTOR_WORDS.status.programRemote) && remoteProgram.includes(CONNECTOR_WORDS.details.runsHereRemote) && !remoteProgram.includes("this computer"), `over remote access a program runs on the computer itself, got ${remoteProgram}`);
	const remoteFailed = await drawn(program, { at: Date.now(), ok: false, error: "spawn node ENOENT" }, true);
	assert(remoteFailed.includes(words.programRemote.fact) && !remoteFailed.includes(words.program.way!), `a program that didn't answer, over remote access, got ${remoteFailed}`);
	const ownProgram = await drawn(program, null, false);
	assert(ownProgram.includes(CONNECTOR_WORDS.status.program) && ownProgram.includes(CONNECTOR_WORDS.details.runsHere), `on the computer itself a program runs on this computer, got ${ownProgram}`);
	// The lines that name the computer say which one: over remote access, the computer itself, never this one.
	const untrusted = { at: Date.now(), ok: false, reach: "untrusted-certificate", error: "self-signed certificate" };
	const python = { at: Date.now(), ok: false, error: "spawn python ENOENT", programFailure: { cause: "python-is-python3", found: "python3" } };
	for (const [what, server, check, here, remote] of [
		["an address it doesn't trust", web, untrusted, words.untrustedCertificate, words.untrustedCertificateRemote],
		["Python by its other name", program, python, words.pythonOtherName("python3", "python"), words.pythonOtherNameRemote("python3", "python")],
	] as const) {
		const far = await drawn(server, check, true);
		assert(far.includes(remote.fact) && !far.includes(here.fact), `${what}, over remote access, names the computer itself, got ${far}`);
		const near = await drawn(server, check, false);
		assert(near.includes(here.fact) && !near.includes(remote.fact), `${what}, on the computer itself, names this computer, got ${near}`);
	}
});

/**
 * Runs a section in a process of its own. The page keeps its first answer
 * about where it runs (this computer, remote access, a shared server) for
 * good, so each place needs a fresh page.
 */
async function sectionInOwnProcess(name: string, body: () => Promise<void>): Promise<void> {
	if (ONLY === name) return section(name, body);
	if (ONLY) return;
	const { spawnSync } = await import("node:child_process");
	const { fileURLToPath } = await import("node:url");
	const child = spawnSync(process.execPath, [...process.execArgv, fileURLToPath(import.meta.url)], { env: { ...process.env, ONLY: name }, encoding: "utf8", timeout: 120_000 });
	assert(child.status === 0, `${name} failed in its own process:\n${child.stdout}\n${child.stderr}`);
	console.log(`ok ${name}`);
}

/** A room's Connectors pane drawn where it runs, with the room's own answer and the full status as given. */
async function roomPane(context: Record<string, unknown>, answers: (route: string, init?: { method?: string; body?: unknown }) => Response | Promise<Response> | null, body: (pane: { container: HTMLElement; dom: any; act: (fn: () => Promise<void> | void) => Promise<void>; asked: string[]; waitFor: (what: string, done: () => boolean) => Promise<void> }) => Promise<void>): Promise<void> {
	const { RoomConnectorsSection } = await component("RoomConnectorsSection.tsx");
	const asked: string[] = [];
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		asked.push(route);
		if (route === "GET /api/remote/client-context") return jsonAnswer({ capability: "full", person: null, ...context });
		const answer = answers(route, init);
		if (answer) return answer;
		throw new Error(`the pane asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		await render(createElement(RoomConnectorsSection, { status: { id: "room-x" }, onOpenConnectors: noop }));
		const waitFor = async (what: string, done: () => boolean) => {
			for (let tries = 0; tries < 100 && !done(); tries++) await act(() => sleep(50));
			assert(done(), `waited for ${what}, the pane reads ${container.textContent}`);
		};
		await body({ container, dom, act, asked, waitFor });
	});
}

const ROOM_ROUTE = "/api/persistent-agents/room-x/mcp-connectors";
const roomAnswer = (configured: string[], granted: Array<{ name: string; configured: boolean }>) => ({ agentId: "room-x", settings: { schemaVersion: 1, grantedConnectors: granted.map((entry) => entry.name), updatedAt: "" }, configuredConnectors: configured, displayNames: {}, granted });
const statusAnswer = (servers: unknown[]) => ({ servers, configSources: [], totalServers: servers.length });
const roomServer = (name: string, transport: "http" | "stdio", target: string, source: unknown = { kind: "user", path: "~/.exxperts/agent/mcp.json" }) => ({ name, transport, target, source, auth: { mode: "none", explicit: false, hasStoredTokens: false, tokenExpired: null, hasRefreshToken: false }, tools: null, editable: transport === "http", key: "none", movesToAnotherSite: true, usedIn: null, lastCheck: null });

// A room's pane on this computer: the empty line says how to add one, with
// Open connectors; a connector that no longer exists says what leaving it
// means; a program says where it runs; a name rooms can't take says why
// instead of offering Enable; and each refusal is a line of ours.
await sectionInOwnProcess("room-pane-own", async () => {
	const { CONNECTOR_WORDS, lineText } = await rowsModule();
	const words = CONNECTOR_WORDS.room;
	await roomPane({ remote: false, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer(roomAnswer([], [])) : route === "GET /api/mcp/status" ? jsonAnswer(statusAnswer([])) : null), async ({ container, waitFor }) => {
		await waitFor("the empty line", () => container.querySelector(".settings-empty") !== null);
		assert(container.querySelector(".settings-empty")!.textContent === `${CONNECTOR_WORDS.noneYet} ${words.empty}`, `the empty line on this computer, got ${container.textContent}`);
		assert(buttonNamed(container, "Open connectors"), "with nothing yet, Open connectors is the way to add one");
	});
	const files = roomServer("files", "stdio", "node files-server.js");
	const drive = roomServer("Google Drive", "http", "http://127.0.0.1:9/drive", { kind: "import", importKind: "cursor", importFile: "~/.cursor/mcp.json", path: "~/.exxperts/agent/mcp.json" });
	const wiki = roomServer("wiki", "http", "http://127.0.0.1:9/wiki");
	let put: Response = jsonAnswer({ error: "persistent agent is archived: room-x" }, 410);
	let reads = 0;
	let firstRead: Response | null = jsonAnswer({ error: "persistent agent not found: room-x" }, 404);
	await roomPane({ remote: false, sharedServer: false }, (route) => {
		if (route === `GET ${ROOM_ROUTE}`) {
			reads++;
			const failing = firstRead;
			firstRead = null;
			return failing ?? jsonAnswer(roomAnswer(["files", "Google Drive", "wiki"], [{ name: "files", configured: true }, { name: "gone-one", configured: false }]));
		}
		if (route === "GET /api/mcp/status") return jsonAnswer(statusAnswer([files, drive, wiki]));
		if (route === `PUT ${ROOM_ROUTE}`) return put.clone();
		return null;
	}, async ({ container, dom, act, waitFor }) => {
		// A load that failed says so in our words, with Try again, which reads the room again.
		await waitFor("the load failure", () => container.querySelector(".connector-load-error") !== null);
		assert(container.querySelector(".connector-load-error span")?.textContent === words.loadFailed && !container.textContent!.includes("room-x"), `a failed load is our line, got ${container.textContent}`);
		await click(dom, act, buttonNamed(container, CONNECTOR_WORDS.loadAgain)!);
		await waitFor("the room's connectors", () => container.querySelectorAll(".room-skills-row").length === 2);
		assert(reads === 2, `Try again read the room again, read ${reads} times`);
		const rowOf = (name: string) => [...container.querySelectorAll(".room-skills-row")].find((row) => row.querySelector(".room-skills-name")?.textContent === name)!;
		assert(rowOf("gone-one").querySelector(".room-skills-warn")?.textContent === lineText(words.gone, false), `a connector that no longer exists says what leaving it means, got ${rowOf("gone-one").textContent}`);
		assert(rowOf("gone-one").querySelector("button")?.getAttribute("title") === words.removeGoneTitle && rowOf("files").querySelector("button")?.getAttribute("title") === words.removeTitle, "each Remove says what it does");
		assert(rowOf("files").querySelector(".room-skills-desc")?.textContent === CONNECTOR_WORDS.status.program && rowOf("files").querySelector(".room-skills-desc")?.getAttribute("title") === "node files-server.js", `a program says where it runs, its command in the tooltip, got ${rowOf("files").textContent}`);
		await click(dom, act, buttonNamed(container, "Enable connectors")!);
		const pickerRow = (name: string) => [...container.querySelectorAll(".room-skills-picker .room-skills-row")].find((row) => row.querySelector(".room-skills-name")?.textContent === name)!;
		assert(pickerRow("Google Drive").querySelector(".room-skills-warn")?.textContent === words.badName("Cursor") && !buttonNamed(pickerRow("Google Drive"), "Enable"), `a name rooms can't take says why, with no Enable, got ${pickerRow("Google Drive").textContent}`);
		// Turning one on in an archived room, for a connector gone since, and anything else.
		const enable = async () => click(dom, act, buttonNamed(pickerRow("wiki"), "Enable")!);
		const shownError = () => container.querySelector(".checkpoint-proposal-error")?.textContent;
		await enable();
		await waitFor("the archived room's line", () => shownError() === words.archived);
		put = jsonAnswer({ error: "unknown connector: wiki" }, 400);
		const readsBefore = reads;
		await enable();
		await waitFor("the gone connector's line", () => shownError() === CONNECTOR_REQUEST_LINES.noLongerExists && reads > readsBefore);
		put = jsonAnswer({ error: "boom" }, 500);
		await enable();
		await waitFor("the failed save's line", () => shownError() === CONNECTOR_REQUEST_LINES.saveFailed);
	});
	// An archived room's load: its line, and no Try again, which would only be refused again.
	await roomPane({ remote: false, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer({ error: "persistent agent is archived: room-x" }, 410) : route === "GET /api/mcp/status" ? jsonAnswer(statusAnswer([])) : null), async ({ container, waitFor }) => {
		await waitFor("the archived line", () => container.textContent!.includes(words.archived));
		assert(!buttonNamed(container, CONNECTOR_WORDS.loadAgain), `an archived room offers no Try again, got ${container.textContent}`);
	});
	// The tools the room may use without asking, under their connector, each with Remove; Remove sends that tool alone, and focus stays in the pane.
	let allowed = [{ tool: "create_task", shown: "Create task" }, { tool: "delete_project", shown: "Delete project" }];
	const sent: unknown[] = [];
	const asanaAnswer = () => jsonAnswer({ ...roomAnswer(["asana"], [{ name: "asana", configured: true }]), allowedTools: allowed.length > 0 ? { asana: allowed } : {} });
	await roomPane({ remote: false, sharedServer: false }, (route, init) => {
		if (route === `GET ${ROOM_ROUTE}`) return asanaAnswer();
		if (route === "GET /api/mcp/status") return jsonAnswer(statusAnswer([roomServer("asana", "http", "https://mcp.asana.example/mcp")]));
		if (route === `PUT ${ROOM_ROUTE}`) {
			const asked = JSON.parse(String(init?.body));
			sent.push(asked);
			allowed = allowed.filter((entry) => entry.tool !== asked.tool);
			return asanaAnswer();
		}
		return null;
	}, async ({ container, dom, act, waitFor }) => {
		const focused = () => dom.window.document.activeElement as HTMLElement | null;
		await waitFor("the allowed tools", () => container.querySelectorAll(".room-connector-allowed li").length === 2);
		assert(container.querySelector(".room-connector-allowed-label")?.textContent === "Allowed without asking in this room:" && container.textContent!.includes(CONNECTORS_EACH_TOOL_LINE), `the pane lists the allowed tools, got ${container.textContent}`);
		await click(dom, act, container.querySelector('button[aria-label="Remove Create task"]')!);
		await waitFor("one tool left", () => container.querySelectorAll(".room-connector-allowed li").length === 1);
		assert(JSON.stringify(sent) === JSON.stringify([{ action: "forget-tool", name: "asana", tool: "create_task" }]), `Remove sends that tool alone, got ${JSON.stringify(sent)}`);
		assert(focused()?.getAttribute("aria-label") === "Remove Delete project", `focus moves to the next Remove, got ${focused()?.outerHTML}`);
		await click(dom, act, container.querySelector('button[aria-label="Remove Delete project"]')!);
		await waitFor("no tool left", () => container.querySelector(".room-connector-allowed") === null);
		assert(focused() === container.querySelector(".room-skills-row-actions button"), `with none left, focus moves to the connector's own button, got ${focused()?.outerHTML}`);
	});
});

// Over remote access nothing can be added or changed here: the empty line
// says where connectors are set up, with no Open connectors, and a line
// shows its fact alone.
await sectionInOwnProcess("room-pane-remote", async () => {
	const { CONNECTOR_WORDS } = await rowsModule();
	await roomPane({ remote: true, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer(roomAnswer([], [])) : route === "GET /api/mcp/status" ? jsonAnswer(statusAnswer([])) : null), async ({ container, waitFor }) => {
		await waitFor("the empty line", () => container.querySelector(".settings-empty") !== null);
		assert(container.querySelector(".settings-empty")!.textContent === `${CONNECTOR_WORDS.noneYet} ${CONNECTOR_WORDS.setUpOnComputer}` && !buttonNamed(container, "Open connectors"), `the empty line over remote access, got ${container.textContent}`);
	});
	const files = roomServer("files", "stdio", "node files-server.js");
	await roomPane({ remote: true, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer(roomAnswer(["files"], [{ name: "files", configured: true }, { name: "gone-one", configured: false }])) : route === "GET /api/mcp/status" ? jsonAnswer(statusAnswer([files])) : null), async ({ container, waitFor }) => {
		await waitFor("the rows", () => container.querySelectorAll(".room-skills-row").length === 2);
		assert(container.querySelector(".room-skills-warn")?.textContent === CONNECTOR_WORDS.room.gone.fact, `over remote access the gone line is its fact alone, got ${container.textContent}`);
		assert(container.querySelector(".room-skills-desc")?.textContent === CONNECTOR_WORDS.status.programRemote, `over remote access a program runs on the computer itself, got ${container.textContent}`);
	});
	// The allowed tools show on a phone too, with no Remove: only the computer takes one back.
	await roomPane({ remote: true, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer({ ...roomAnswer(["asana"], [{ name: "asana", configured: true }]), allowedTools: { asana: [{ tool: "create_task", shown: "Create task" }] } }) : route === "GET /api/mcp/status" ? jsonAnswer(statusAnswer([roomServer("asana", "http", "https://mcp.asana.example/mcp")])) : null), async ({ container, waitFor }) => {
		await waitFor("the allowed tool", () => container.querySelectorAll(".room-connector-allowed li").length === 1);
		assert(container.querySelector(".room-connector-allowed li")?.textContent === "Create task" && !container.querySelector(".room-connector-allowed button"), `over remote access the allowed tool shows with no Remove, got ${container.querySelector(".room-connector-allowed")?.outerHTML}`);
	});
});

// On a shared server the admin sets connectors up: the empty line says so,
// in the Skills page's own words, with no Open connectors.
await sectionInOwnProcess("room-pane-shared", async () => {
	const { CONNECTOR_WORDS } = await rowsModule();
	const { SHARED_SERVER_ADMIN_LINE } = await import(new URL("../../web-ui/src/remote-client-context.ts", import.meta.url).href);
	await roomPane({ remote: false, sharedServer: true }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer(roomAnswer([], [])) : null), async ({ container, waitFor }) => {
		await waitFor("the empty line", () => container.querySelector(".settings-empty") !== null);
		assert(container.querySelector(".settings-empty")!.textContent === `${CONNECTOR_WORDS.noneYet} ${SHARED_SERVER_ADMIN_LINE}` && !buttonNamed(container, "Open connectors"), `the empty line on a shared server, got ${container.textContent}`);
	});
});

// The list that couldn't be read says so in one line, with Try again, which
// reads it again.
await sectionInOwnProcess("page-load-again", async () => {
	const { ConnectorsPage } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS } = await rowsModule();
	let reads = 0;
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		if (route === "GET /api/remote/client-context") return jsonAnswer({ remote: false, capability: "full", sharedServer: false, person: null });
		if (route === "GET /api/mcp/status") return ++reads === 1 ? jsonAnswer({ error: CONNECTOR_REQUEST_LINES.loadFailed }, 500) : jsonAnswer(statusAnswer([]));
		throw new Error(`the page asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		await render(createElement(ConnectorsPage, {}));
		for (let tries = 0; tries < 100 && !container.querySelector(".connector-load-error"); tries++) await act(() => sleep(50));
		assert(container.querySelector(".connector-load-error span")?.textContent === CONNECTOR_REQUEST_LINES.loadFailed, `the list that couldn't be read says so, got ${container.textContent}`);
		await click(dom, act, buttonNamed(container, CONNECTOR_WORDS.loadAgain)!);
		for (let tries = 0; tries < 100 && !container.querySelector(".settings-empty"); tries++) await act(() => sleep(50));
		assert(reads === 2 && container.querySelector(".settings-empty")?.textContent?.startsWith(CONNECTOR_WORDS.noneYet), `Try again read the list again, read ${reads} times, the page reads ${container.textContent}`);
		// The list's part is named as it is headed on screen.
		assert(container.querySelector(".connector-list-section")?.getAttribute("aria-label") === CONNECTOR_WORDS.listTitle, "the list's part is named Your connectors");
	});
});

// Room settings on a shared server: a member can't read the full connector
// status, so the room's own answer carries the names as typed, and the rows
// and the search use them. The room's answer is the real route's shape.
// A room's own read after a refused Enable can land after a later Enable that
// worked: the later answer is the newer one, so the old read is dropped.
await sectionInOwnProcess("room-pane-late-read", async () => {
	const wiki = roomServer("wiki", "http", "http://127.0.0.1:9/wiki");
	const notes = roomServer("notes", "http", "http://127.0.0.1:9/notes");
	let release: () => void = noop;
	const held = new Promise<void>((resolve) => (release = resolve));
	let reads = 0;
	let puts = 0;
	await roomPane({ remote: false, sharedServer: false }, (route) => {
		if (route === `GET ${ROOM_ROUTE}`) {
			reads++;
			// The first read draws the pane; the read after the refused Enable is held until the second Enable has answered.
			const answer = jsonAnswer(roomAnswer(["wiki", "notes"], []));
			return reads === 1 ? answer : held.then(() => answer);
		}
		if (route === "GET /api/mcp/status") return jsonAnswer(statusAnswer([wiki, notes]));
		if (route === `PUT ${ROOM_ROUTE}`) return ++puts === 1 ? jsonAnswer({ error: "unknown connector: wiki" }, 400) : jsonAnswer(roomAnswer(["wiki", "notes"], [{ name: "notes", configured: true }]));
		return null;
	}, async ({ container, dom, act, waitFor }) => {
		await waitFor("the room's connectors", () => buttonNamed(container, "Enable connectors") !== null);
		await click(dom, act, buttonNamed(container, "Enable connectors")!);
		const pickerRow = (name: string) => [...container.querySelectorAll(".room-skills-picker .room-skills-row")].find((row) => row.querySelector(".room-skills-name")?.textContent === name);
		await click(dom, act, buttonNamed(pickerRow("wiki")!, "Enable")!);
		await waitFor("the gone connector's line and the room read again", () => container.querySelector(".checkpoint-proposal-error")?.textContent === CONNECTOR_REQUEST_LINES.noLongerExists && reads === 2);
		await click(dom, act, buttonNamed(pickerRow("notes")!, "Enable")!);
		const enabled = () => [...container.querySelectorAll(".room-skills-rows .room-skills-row")].some((row) => row.querySelector(".room-skills-name")?.textContent === "notes" && row.textContent!.includes("Enabled"));
		await waitFor("notes enabled", enabled);
		release();
		for (let tries = 0; tries < 10; tries++) await act(() => sleep(50));
		assert(enabled(), `the older read must not undo the later Enable, the pane reads ${container.textContent}`);
	});
});

await section("room-names-shared", async () => {
	const { RoomConnectorsSection } = await component("RoomConnectorsSection.tsx");
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	const asked: string[] = [];
	const room = { agentId: "room-x", settings: { schemaVersion: 1, grantedConnectors: ["team-wiki"], updatedAt: "" }, configuredConnectors: ["notion", "team-wiki"], displayNames: { "team-wiki": "Team wiki" }, granted: [{ name: "team-wiki", configured: true }] };
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		asked.push(route);
		if (route === "GET /api/remote/client-context") return json({ remote: false, capability: "full", sharedServer: true, person: { id: "member-1", name: "Ana", admin: false } });
		if (route === "GET /api/persistent-agents/room-x/mcp-connectors") return json(room);
		throw new Error(`the section asked for ${route}, which this smoke does not answer`);
	}, async ({ container, act, render }) => {
		await render(createElement(RoomConnectorsSection, { status: { id: "room-x" } }));
		for (let tries = 0; tries < 100 && !container.querySelector(".room-skills-name"); tries++) await act(() => sleep(50));
		const names = [...container.querySelectorAll(".room-skills-name")].map((node) => node.textContent);
		assert(JSON.stringify(names) === JSON.stringify(["Team wiki"]), `a member sees the connector as it was named, got ${JSON.stringify(names)}`);
		assert(!asked.includes("GET /api/mcp/status"), `a member's page never asks for the full status, asked ${JSON.stringify(asked)}`);
	});
});

/** A port on this computer with nothing listening: one that was free a moment ago. */
async function closedPort(): Promise<number> {
	const probe = http.createServer();
	await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
	const { port } = probe.address() as AddressInfo;
	await new Promise<void>((resolve) => probe.close(() => resolve()));
	return port;
}

/** Each request a stand-in got: where, whether it was the check's own direct request, its key header, and when its connection closed. */
type Reached = { at: string; direct: boolean; key: string | undefined; arrived: number; closed?: number };

/** A stand-in for a check's failures: `how` answers, holds or drops each request, and every request is kept in `reached`. */
async function failingStandIn(reached: Reached[], how: (req: http.IncomingMessage, res: http.ServerResponse, direct: boolean) => void): Promise<{ server: http.Server; at: string }> {
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			const one: Reached = { at: `${req.headers.host}${req.url}`, direct: raw.includes("exxperts-connection-test"), key: req.headers["x-api-key"] as string | undefined, arrived: Date.now() };
			reached.push(one);
			req.socket.once("close", () => { one.closed = Date.now(); });
			how(req, res, one.direct);
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, at: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

/**
 * A connector over HTTPS whose certificate is made here, self-signed, by
 * openssl; null where there is no openssl. It answers as a connector would,
 * so only the certificate stops a client.
 */
async function untrustedStandIn(reached: Reached[]): Promise<{ server: http.Server; at: string } | null> {
	const folder = fs.mkdtempSync(path.join(os.tmpdir(), "exxperts-untrusted-"));
	try {
		execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", path.join(folder, "key.pem"), "-out", path.join(folder, "cert.pem"), "-days", "1", "-subj", "/CN=127.0.0.1"], { stdio: "ignore" });
	} catch {
		fs.rmSync(folder, { recursive: true, force: true });
		return null;
	}
	const server = https.createServer({ key: fs.readFileSync(path.join(folder, "key.pem")), cert: fs.readFileSync(path.join(folder, "cert.pem")) }, (req, res) => {
		reached.push({ at: `${req.headers.host}${req.url}`, direct: false, key: undefined, arrived: Date.now() });
		res.writeHead(200, { "Content-Type": "application/json" }).end("{}");
	});
	fs.rmSync(folder, { recursive: true, force: true });
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server: server as unknown as http.Server, at: `127.0.0.1:${(server.address() as AddressInfo).port}` };
}

// A web connector's failed check says why nothing answered when it can tell:
// nothing listening at its address, a name that isn't found, an ordinary web
// page, or a certificate this computer doesn't trust, each with its own line
// and Change address where the person can change it. A server that wants a
// sign-in reads Not connected with Connect, by a 401 or a 403 to one with no
// key and no sign-in; one that holds the
// connection past 20 s still didn't answer in time. Asking the server directly
// goes only to the stored address, with the stored headers, follows no
// redirect and waits 5 s at most. The row reads the same right after the check
// and from the kept check, as Settings opened again reads it, and what it shows
// carries no key, no header's value and no part of the address's query.
await section("check-says-why", async () => {
	const { addMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus, readMcpConnectorChecks } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS, checkOf, connectorRowState, lineText, rowLook, rowNote, wentWrongLine } = await rowsModule();
	const words = CONNECTOR_WORDS.wentWrong;
	const { notAnswering, notConnected, cantConnect } = CONNECTOR_WORDS.status;
	const reached: Reached[] = [];
	// Wants a sign-in for everything and turns down the app's own registration, as the measured service did:
	// the connection then ends with no words of its own.
	const refusing = await failingStandIn(reached, (req, res) => void (req.url?.startsWith("/register") ? res.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"invalid_client_metadata"}') : res.writeHead(401, { "Content-Type": "text/plain" }).end("sign in first")));
	const elsewhere = await failingStandIn(reached, (_req, res) => void res.writeHead(200).end());
	const redirecting = await failingStandIn(reached, (_req, res) => void res.writeHead(302, { Location: `http://${elsewhere.at}/mcp` }).end());
	// Drops the connector's own requests at once and holds the check's direct request, so only its own limit ends it.
	const dropping = await failingStandIn(reached, (req, _res, direct) => { if (!direct) req.socket.destroy(); });
	const holding = await failingStandIn(reached, () => {});
	// Turns away every request without a sign-in, and answers one with a sign-in as `signed` says.
	const signedAnswer = (signed: number) => failingStandIn(reached, (req, res) => void res.writeHead(req.headers.authorization ? signed : 401, { "Content-Type": "text/plain" }).end("no"));
	const signedRefused = await signedAnswer(403);
	const signedDown = await signedAnswer(503);
	const signedOlder = await signedAnswer(405);
	// An ordinary web page at every path, and a service that refuses everyone without a key.
	const webPage = await failingStandIn(reached, (_req, res) => void res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end("<!DOCTYPE html><html><body>Welcome</body></html>"));
	const forbidding = await failingStandIn(reached, (_req, res) => void res.writeHead(403, { "Content-Type": "text/plain" }).end("forbidden"));
	// A connector behind a certificate made here, which this computer has no reason to trust.
	const untrusted = await untrustedStandIn(reached);
	const servers = [refusing, elsewhere, redirecting, dropping, holding, signedRefused, signedDown, signedOlder, webPage, forbidding, ...(untrusted ? [untrusted] : [])].map((one) => one.server);
	const closed = await closedPort();
	const QUERY_SECRET = "synthetic-query-secret";
	const HEADER_SECRET = "synthetic-header-secret";
	try {
		await addMcpServer({ name: "nothing-there", url: `http://127.0.0.1:${closed}/mcp?token=${QUERY_SECRET}`, headers: { Authorization: `Bearer ${HEADER_SECRET}` } });
		await addMcpServer({ name: "name-not-found", url: "http://exxperts-smoke-desk.invalid/mcp" });
		await addMcpServer({ name: "wants-sign-in", url: `http://${refusing.at}/mcp` });
		await addMcpServer({ name: "key-turned-down", url: `http://${refusing.at}/keyed`, headers: { "X-Api-Key": "synthetic-key" } });
		await addMcpServer({ name: "moved-away", url: `http://${redirecting.at}/mcp` });
		await addMcpServer({ name: "slow-to-say", url: `http://${dropping.at}/mcp` });
		await addMcpServer({ name: "holds-on", url: `http://${holding.at}/mcp` });
		await addMcpServer({ name: "signed-in-refused", url: `http://${signedRefused.at}/mcp` });
		await addMcpServer({ name: "signed-in-down", url: `http://${signedDown.at}/mcp` });
		await addMcpServer({ name: "signed-in-older", url: `http://${signedOlder.at}/mcp` });
		await addMcpServer({ name: "web-page", url: `http://${webPage.at}/mcp` });
		await addMcpServer({ name: "forbids-keyless", url: `http://${forbidding.at}/mcp` });
		if (untrusted) await addMcpServer({ name: "untrusted", url: `https://${untrusted.at}/mcp` });
		const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
		const inAnHour = Math.floor(Date.now() / 1000) + 3600;
		authStore.updateTokens("signed-in-refused", { accessToken: "synthetic-valid", expiresAt: inAnHour }, `http://${signedRefused.at}/mcp`);
		authStore.updateTokens("signed-in-down", { accessToken: "synthetic-valid", expiresAt: inAnHour }, `http://${signedDown.at}/mcp`);
		authStore.updateTokens("signed-in-older", { accessToken: "synthetic-valid", expiresAt: inAnHour }, `http://${signedOlder.at}/mcp`);
		const { changeAddress, connect, tryAgain, reconnect } = CONNECTOR_WORDS.button;
		const cases: Array<[string, { reach: string | null; needsAuth: boolean; status: string; line: unknown; way: string | null; button: string | null }]> = [
			["nothing-there", { reach: "nothing-there", needsAuth: false, status: notAnswering, line: words.nothingThere, way: "changeAddress", button: "tryAgain" }],
			["name-not-found", { reach: "name-not-found", needsAuth: false, status: CONNECTOR_WORDS.status.addressNotFound, line: words.nameNotFound, way: "changeAddress", button: "tryAgain" }],
			// No key and no sign-in kept: the 401 is a sign-in to make, as a sign-in known to be missing reads.
			["wants-sign-in", { reach: null, needsAuth: true, status: notConnected, line: null, way: null, button: "connect" }],
			["key-turned-down", { reach: null, needsAuth: false, status: cantConnect, line: words.keyRefused, way: "changeKey", button: null }],
			// A redirect is an answer of its own, never followed to the other host.
			["moved-away", { reach: null, needsAuth: false, status: cantConnect, line: words.addressRefused, way: "changeAddress", button: null }],
			["slow-to-say", { reach: null, needsAuth: false, status: notAnswering, line: words.noAnswer, way: "changeAddress", button: "tryAgain" }],
			["holds-on", { reach: null, needsAuth: false, status: notAnswering, line: words.noAnswer, way: "changeAddress", button: "tryAgain" }],
			// A sign-in kept: the signed request's own answer wins where it isn't about the sign-in; a refusal, or the
			// older transport's 405 after one, leaves the direct request's refusal standing.
			["signed-in-refused", { reach: null, needsAuth: true, status: CONNECTOR_WORDS.status.needsReconnecting, line: null, way: null, button: "reconnect" }],
			["signed-in-older", { reach: null, needsAuth: true, status: CONNECTOR_WORDS.status.needsReconnecting, line: null, way: null, button: "reconnect" }],
			["signed-in-down", { reach: null, needsAuth: false, status: CONNECTOR_WORDS.status.cantConnectNow, line: words.busy, way: null, button: "tryAgain" }],
			// It answered at once, but with an ordinary web page: its address is the way on, not trying again.
			["web-page", { reach: "web-page", needsAuth: false, status: cantConnect, line: words.webPage, way: "changeAddress", button: null }],
			// A 403 with no key and no sign-in kept wants a sign-in, as a 401 does.
			["forbids-keyless", { reach: null, needsAuth: true, status: notConnected, line: null, way: null, button: "connect" }],
		];
		// Turned down at once for its certificate: never an answer to use, and its address is the way on.
		if (untrusted) cases.push(["untrusted", { reach: "untrusted-certificate", needsAuth: false, status: cantConnect, line: words.untrustedCertificate, way: "changeAddress", button: null }]);
		else console.log("check-says-why: the certificate row skipped (no openssl to make a certificate)");
		assert(changeAddress && connect && tryAgain && reconnect, "the buttons have words");
		const results = new Map<string, any>();
		for (const [name] of cases) results.set(name, await testMcpServer(name));
		// Settings opened again: the status as it reads the kept checks.
		const rows = new Map<string, any>((await getMcpConnectorsStatus()).servers.map((row: { name: string }) => [row.name, row]));
		const problems: string[] = [];
		const seen = (row: any, check: unknown) => {
			const state = connectorRowState(row, check, null);
			const wrong = wentWrongLine(row, state, false);
			const look = rowLook(state, false);
			return { status: look.status, line: wrong?.line ?? null, way: wrong?.button ?? null, button: look.button, note: rowNote(row, state, false), remote: wrong ? lineText(wrong.line, true) : null };
		};
		for (const [name, expected] of cases) {
			const result = results.get(name);
			const row = rows.get(name);
			const got = { reach: result.reach ?? null, needsAuth: Boolean(result.needsAuth), ...seen(row, checkOf(result)) };
			const want = { ...expected, note: (expected.line as { fact: string } | null)?.fact ?? null, remote: (expected.line as { fact: string } | null)?.fact ?? null };
			if (JSON.stringify(got) !== JSON.stringify(want)) problems.push(`${name}'s check should read ${JSON.stringify(want)}, got ${JSON.stringify(got)}`);
			const again = seen(row, row.lastCheck);
			const { reach: _reach, needsAuth: _needsAuth, ...right } = got;
			if (JSON.stringify(again) !== JSON.stringify(right)) problems.push(`${name} reads the same from its kept check: ${JSON.stringify(right)}, got ${JSON.stringify(again)}`);
		}
		assert(problems.length === 0, problems.join("\n"));
		assert(words.webPage.fact === "Its address leads to a web page, not a connector." && words.untrustedCertificate.fact === "This computer doesn't trust its address, so it wasn't used.", "the web page's and the certificate's lines are the ones proposed");
		assert(words.nothingThere.fact === "Nothing is answering at its address." && words.nothingThere.way === "If the address is right, try again later." && words.nameNotFound.fact === "Its web address wasn't found." && words.nameNotFound.way === "Check it, and that this computer is online.", "the new lines are the ones proposed");
		// What the row shows of a connector with a key in its address and its header never carries either.
		const secretRow = rows.get("nothing-there");
		const shown = JSON.stringify([results.get("nothing-there").reach, rowNote(secretRow, connectorRowState(secretRow, checkOf(results.get("nothing-there")), null), false), wentWrongLine(secretRow, connectorRowState(secretRow, secretRow.lastCheck, null), false)]);
		assert(!shown.includes(QUERY_SECRET) && !shown.includes(HEADER_SECRET), `the row's words carry no key, got ${shown}`);
		// The kept check keeps a reason only as one of its two codes.
		const checksFile = path.join(agentDir, "mcp-connector-checks.json");
		const kept = JSON.parse(fs.readFileSync(checksFile, "utf-8"));
		kept.checks["odd-reach"] = { at: Date.now(), ok: false, reach: `nothing-there ${HEADER_SECRET}` };
		fs.writeFileSync(checksFile, JSON.stringify(kept));
		const reread = readMcpConnectorChecks();
		assert(reread["odd-reach"] && !("reach" in reread["odd-reach"]) && reread["nothing-there"].reach === "nothing-there" && reread["name-not-found"].reach === "name-not-found" && reread["web-page"].reach === "web-page", `a kept reason is one of its codes or none, got ${JSON.stringify(reread)}`);
		// The direct request: once per check that failed with no answer of its own, at the stored address, with the stored header.
		const direct = reached.filter((one) => one.direct);
		const directAt = direct.map((one) => one.at).sort();
		// The certificate's stand-in never sees a request: its connection is turned down before one is sent.
		const expectedAt = [`${refusing.at}/keyed`, `${refusing.at}/mcp`, `${redirecting.at}/mcp`, `${dropping.at}/mcp`, `${signedRefused.at}/mcp`, `${signedDown.at}/mcp`, `${signedOlder.at}/mcp`, `${webPage.at}/mcp`, `${forbidding.at}/mcp`].sort();
		assert(JSON.stringify(directAt) === JSON.stringify(expectedAt), `the direct request goes to each stored address once, and never on after a redirect or past the 20 s, got ${JSON.stringify(directAt)}`);
		assert(direct.find((one) => one.at === `${refusing.at}/keyed`)?.key === "synthetic-key" && direct.find((one) => one.at === `${refusing.at}/mcp`)?.key === undefined, "the direct request carries the stored header, and only where it is stored");
		const held = direct.find((one) => one.at === `${dropping.at}/mcp`)!;
		const heldFor = (held.closed ?? Date.now()) - held.arrived;
		assert(heldFor >= 4000 && heldFor <= 7000, `the direct request waits 5 s at most, it waited ${heldFor} ms`);
		assert(!reached.some((one) => one.at.startsWith(elsewhere.at) && one.direct), "the direct request follows no redirect to another host");
	} finally {
		for (const server of servers) {
			server.closeAllConnections();
			server.close();
		}
	}
});

/**
 * A connector that lists one tool more to a client that can show its forms,
 * and one more to one that lends it the model, as the reference connector
 * does, with two documents and its own instructions. While it lists its tools
 * it asks for a form and for the model, where the client said it can take
 * them, and keeps each answer.
 */
async function askingConnector(instructions: string): Promise<{ server: http.Server; url: string; answers: Map<string, unknown> }> {
	const answers = new Map<string, unknown>();
	const waiting = new Map<string, () => void>();
	let declared: { elicitation?: unknown; sampling?: unknown } = {};
	const event = (message: unknown) => `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", ...(message as object) })}\n\n`;
	const server = http.createServer((req, res) => {
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", async () => {
			if (req.method !== "POST") return void res.writeHead(405).end();
			const message = JSON.parse(raw);
			if (message.method === undefined && message.id !== undefined) {
				answers.set(String(message.id), message.error ? { error: message.error.message } : message.result);
				waiting.get(String(message.id))?.();
				return void res.writeHead(202).end();
			}
			if (message.id === undefined) return void res.writeHead(202).end();
			const json = (result: unknown) => void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
			if (message.method === "initialize") {
				declared = message.params?.capabilities ?? {};
				return json({ protocolVersion: message.params?.protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: { name: "asking-connector", version: "1.0.0" }, instructions });
			}
			if (message.method === "resources/list") return json({ resources: [{ uri: "notes://all", name: "notes" }, { uri: "notes://spaces", name: "spaces" }] });
			if (message.method !== "tools/list") return json({});
			const tools = [{ name: "search_notes" }, { name: "list_spaces" }, ...(declared.elicitation ? [{ name: "fill_in" }] : []), ...(declared.sampling ? [{ name: "summarize" }] : [])];
			const asks = [
				...(declared.elicitation ? [{ id: "ask-form", method: "elicitation/create", params: { mode: "form", message: "Which space?", requestedSchema: { type: "object", properties: { space: { type: "string" } } } } }] : []),
				...(declared.sampling ? [{ id: "ask-model", method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Summarise the notes." } }], maxTokens: 20 } }] : []),
			];
			res.writeHead(200, { "content-type": "text/event-stream" });
			for (const ask of asks) res.write(event(ask));
			await Promise.all(asks.map((ask) => new Promise<void>((resolve) => { waiting.set(ask.id, resolve); setTimeout(resolve, 5000); })));
			res.end(event({ id: message.id, result: { tools: tools.map((tool) => ({ inputSchema: { type: "object" }, ...tool })) } }));
		});
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`, answers };
}

// The page's check meets a connector as a room does: it says it can show forms
// and offers no model, so the connector lists what it lists to a room, and a
// form it asks for during the check is declined, so nothing reaches the
// person. It keeps the connector's own instructions with its list, cut at
// 4,096 characters. The row gives the
// tools but the one switched off and leaves the documents out; the room's pane
// gives the same tools, and the two add up to the model's line, on a shared
// server too.
await sectionInOwnProcess("check-like-a-room", async () => {
	const { testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { CONNECTOR_WORDS, connectorRowState, rowNote } = await rowsModule();
	const { buildRoomScopedProxyDescription } = await import("../../../pi-package/extensions/mcp/room-scope.js");
	const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);
	const instructions = `Read the notes before the spaces. ${"Each space has its own notes. ".repeat(160)}`;
	assert(instructions.length > 4096, "the instructions run past the cut");
	const connector = await askingConnector(instructions);
	try {
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "notes-desk": { url: connector.url, excludeTools: ["list_spaces"] } } }));
		const result = await testMcpServer("notes-desk");
		assert(result.ok && JSON.stringify([...(result.toolNames ?? [])].sort()) === JSON.stringify(["fill_in", "list_spaces", "search_notes"]), `the check lists what a room is offered, got ${JSON.stringify(result)}`);
		assert(JSON.stringify(connector.answers.get("ask-form")) === JSON.stringify({ action: "decline" }), `a form asked for during the check is declined, got ${JSON.stringify(connector.answers.get("ask-form"))}`);
		assert(!connector.answers.has("ask-model"), `no model is offered, so the connector asks for none, got ${JSON.stringify(connector.answers.get("ask-model"))}`);
		const saved = cacheMod.loadMetadataCache().servers["notes-desk"];
		assert(saved.instructions === instructions.slice(0, 4096), `the connector's instructions are kept with its list, cut at 4,096, got ${String(saved.instructions).length} characters`);
		// Three tools, one switched off, and two documents: two tools and two documents, four to the model.
		const room = await roomWith("notes-desk");
		const modelCount = async () => /notes-desk \((\d+) tools\)/.exec(await buildRoomScopedProxyDescription(room))?.[1];
		const row = (await getMcpConnectorsStatus()).servers.find((one: { name: string }) => one.name === "notes-desk") as any;
		assert(row.tools.count === 2 && row.tools.documents === 2 && (await modelCount()) === "4", `the row's tools and documents add up to the model's line, got ${row.tools.count} and ${row.tools.documents} against ${await modelCount()}`);
		const note = rowNote(row, connectorRowState(row, null, null), false);
		assert(note === "2 tools", `the row counts its tools and leaves its documents out, got ${note}`);
		assert(CONNECTOR_WORDS.toolCount(1) === "1 tool" && CONNECTOR_WORDS.toolCount(4) === "4 tools", "one tool is counted as one");
		await roomPane({ remote: false, sharedServer: false }, (route) => (route === `GET ${ROOM_ROUTE}` ? jsonAnswer(roomAnswer(["notes-desk"], [{ name: "notes-desk", configured: true }])) : route === "GET /api/mcp/status" ? getMcpConnectorsStatus().then((status) => jsonAnswer(status)) : null), async ({ container, waitFor }) => {
			await waitFor("the room's connector", () => container.querySelector(".room-skills-desc") !== null);
			const desc = container.querySelector(".room-skills-desc")!.textContent ?? "";
			assert(desc.endsWith(" · 2 tools"), `the room's pane gives the same tool count, got ${desc}`);
		});
		// On a shared server the lists leave documents and switched-off tools out, and the count stays the model's.
		const { registerServerHooks } = await import("../src/server-hooks.js");
		registerServerHooks({});
		const shared = (await getMcpConnectorsStatus()).servers.find((one: { name: string }) => one.name === "notes-desk") as any;
		assert(shared.tools.count === 2 && shared.tools.documents === 2 && shared.tools.resources === undefined && shared.tools.excluded === undefined && (await modelCount()) === "4", `on a shared server the two counts are the same, got ${JSON.stringify(shared.tools)}`);
	} finally {
		connector.server.closeAllConnections();
		connector.server.close();
	}
});

console.log("memory-connectors-bugs smoke passed");
process.exit(0);
