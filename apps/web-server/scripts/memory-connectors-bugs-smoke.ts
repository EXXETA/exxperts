// What a person meets at the end of a Memorize that only sorts notes, after a
// failed connector check, on an imported connector's row, on a row whose
// sign-in has expired, and after a sign-in a check asked for. The run comes
// from the real server code on a temp room, the check and the connector rows
// from the real adapter against a local stand-in answering each status; the page's own
// components and words turn them into what the person reads.
//
// Offline: no provider, no network beyond 127.0.0.1. Each section can run
// alone (ONLY=<name>).

import fs from "node:fs";
import http from "node:http";
import { createRequire } from "node:module";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CONNECTOR_REQUEST_LINES } from "../src/connector-form.js";

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
	const { CONNECTOR_WORDS, checkOf, connectorRowState, removeConsequence, rowLook, rowMenu, wentWrongLine } = await rowsModule();
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
			const state = connectorRowState(row, checkOf(result), null);
			const wrong = wentWrongLine(row, state, false);
			const look = rowLook(state, false);
			return { state: state.kind, status: look.status, line: wrong?.line ?? null, way: wrong?.button ?? null, menu: rowMenu(row, state, false), button: look.button };
		};
		const words = CONNECTOR_WORDS.wentWrong;
		const { cantConnect, cantConnectNow, notAnswering } = CONNECTOR_WORDS.status;
		const cases: Array<[string, { state: string; status: string; line: unknown; way: string | null; menu: string[]; button: string | null }]> = [
			["from-cursor", { state: "cant-connect", status: cantConnect, line: words.imported("Cursor"), way: null, menu: [], button: null }],
			["cursor-key", { state: "cant-connect", status: cantConnect, line: words.importedKey("Cursor"), way: null, menu: [], button: null }],
			["cursor-tenant", { state: "cant-connect", status: cantConnect, line: words.refusedImported("Cursor"), way: null, menu: [], button: null }],
			["cursor-local", { state: "cant-connect", status: cantConnect, line: words.program, way: "tryAgain", menu: [], button: null }],
			// No status: nothing answering, with Try again for a network that comes back, and no promise that waiting helps.
			["from-claude", { state: "cant-connect-now", status: notAnswering, line: words.noAnswer, way: null, menu: [], button: "tryAgain" }],
			["own-closed", { state: "cant-connect-now", status: notAnswering, line: words.noAnswer, way: "changeAddress", menu: ["changeAddress", "remove"], button: "tryAgain" }],
			["own-404", { state: "cant-connect", status: cantConnect, line: words.addressNotFound, way: "changeAddress", menu: ["changeAddress", "remove"], button: null }],
			["own-tenant", { state: "cant-connect", status: cantConnect, line: words.refused, way: "remove", menu: ["changeAddress", "remove"], button: null }],
			["own-key", { state: "cant-connect", status: cantConnect, line: words.keyRefused, way: "changeKey", menu: ["changeAddress", "remove"], button: null }],
			// Two keys: Change key couldn't tell which one to replace, so the line says to add it again.
			["own-two-keys", { state: "cant-connect", status: cantConnect, line: words.keyFixed, way: "remove", menu: ["changeAddress", "remove"], button: null }],
			["shared-404", { state: "cant-connect", status: cantConnect, line: words.addressNotFoundElsewhere, way: null, menu: ["remove"], button: null }],
			["shared-key", { state: "cant-connect", status: cantConnect, line: words.keyRefusedElsewhere, way: null, menu: ["remove"], button: null }],
			["shared-tenant", { state: "cant-connect", status: cantConnect, line: words.refusedElsewhere, way: null, menu: ["remove"], button: null }],
			// A directory connector its service turned down has no row button; its menu checks again.
			["notion", { state: "cant-connect", status: cantConnect, line: words.turnedDown, way: null, menu: ["checkConnection", "remove"], button: null }],
		];
		assert(cantConnectNow !== notAnswering, "a busy service and one not answering read differently");
		for (const [name, expected] of cases) {
			const got = await failed(name);
			assert(JSON.stringify(got) === JSON.stringify(expected), `${name}'s failed check should give ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
		}
		// Remove's question says what Remove does: the shared file's connector goes for other apps too, ours alone does not.
		const consequence = (name: string) => removeConsequence(rows.get(name), []) ?? "";
		assert(consequence("shared-404").includes(CONNECTOR_WORDS.removeSharedFile), `removing a connector in the shared file says other apps lose it, got ${JSON.stringify(consequence("shared-404"))}`);
		assert(!consequence("own-404").includes(CONNECTOR_WORDS.removeSharedFile), `removing our own connector names no other app, got ${JSON.stringify(consequence("own-404"))}`);
		// Remove agrees with the menu: it refuses the imported one and takes the shared one.
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

// Item 5: the page offers Remove on exactly the rows the server removes, and
// names the tool on the others. Each row is the real status drawn by the real
// row, and each is then really removed, so the two cannot drift apart.
await section("imported-remove", async () => {
	const { removeMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS, connectorRowState, rowMenu } = await rowsModule();
	assert(typeof ConnectorRow === "function", "the page's connector row can be drawn");
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
	const draw = (server: any, { open = false, readOnly = false } = {}) => {
		const html = renderToStaticMarkup(createElement(ConnectorRow, { server, check: null, open, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly })) as string;
		const tag = /<span class="connector-dir-kind"[^>]*>(.*?)<\/span>/.exec(html)?.[1];
		return { words: text(html), tag: tag === undefined ? null : text(tag), offersRemove: rowMenu(server, connectorRowState(server, null, null), readOnly).includes("remove") };
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
		const closed = draw(server);
		const opened = draw(server, { open: true });
		assert(closed.offersRemove === !tool, `${name} ${tool ? "offers no" : "keeps its"} Remove, got ${closed.words}`);
		if (tool) {
			const sentence = CONNECTOR_WORDS.importedNote(tool);
			assert(closed.tag === CONNECTOR_WORDS.tagImported(tool), `${name}'s closed row says where it came from, got ${closed.tag}`);
			assert(!closed.words.includes(sentence), `${name}'s closed row leaves the sentence to the opened row, got ${closed.words}`);
			assert(opened.words.includes(sentence), `${name}'s opened row says ${JSON.stringify(sentence)}, got ${opened.words}`);
			assert(opened.words.includes(url) && !opened.words.includes("mcp.json"), `${name}'s opened row keeps the address and names no file, got ${opened.words}`);
		} else {
			assert(closed.tag === CONNECTOR_WORDS.tagCustom, `${name} is the person's own, got ${closed.tag}`);
			assert(!opened.words.includes("remove it there"), `${name} names no other tool, got ${opened.words}`);
		}
		let refused = "";
		const removed = await removeMcpServer(name).catch((error: Error) => { refused = error.message; });
		assert(Boolean(refused) === Boolean(tool), `the server ${tool ? "refuses" : "removes"} ${name}, got ${JSON.stringify(removed ?? refused)}`);
	}
	const after = await statusRows();
	for (const name of ["only-ours", "only-shared"]) assert(!after.has(name), `${name} is gone after Remove, got ${JSON.stringify([...after.keys()])}`);
	// Our own copy gone, the row that stays is Cursor's: it stops offering Remove.
	for (const name of ["cursor-and-ours", "cursor-and-shared", "cursor-and-project"]) {
		const left = draw(after.get(name), { open: true });
		assert(!left.offersRemove && left.words.includes(CONNECTOR_WORDS.importedNote("Cursor")), `${name}'s Cursor copy left behind offers no Remove, got ${left.words}`);
	}
	// The adapter reads only tools the page has a name for, so a tool it learns later goes by its id.
	const cursorRow = after.get("only-cursor") as any;
	const unnamed = draw({ ...cursorRow, source: { ...cursorRow.source, importKind: "zed", importFile: "~/.zed/mcp.json" } }, { open: true });
	assert(!unnamed.offersRemove && unnamed.tag === CONNECTOR_WORDS.tagImported("zed") && unnamed.words.includes(CONNECTOR_WORDS.importedNote("zed")), `a tool with no name on the page goes by its id, got ${unnamed.words}`);
	// A window that cannot change connectors has no Remove to stand in for, but the row still says where it came from.
	const readOnly = draw(cursorRow, { open: true, readOnly: true });
	assert(!readOnly.offersRemove && !readOnly.words.includes(CONNECTOR_WORDS.importedNote("Cursor")), `a read-only row offers neither Remove nor the way to it, got ${readOnly.words}`);
	assert(readOnly.tag === CONNECTOR_WORDS.tagImported("Cursor"), `a read-only row still says where it came from, got ${readOnly.tag}`);
});

// A sign-in that has expired with nothing to renew it needs the person:
// Reconnect. One still valid, or one that renews itself, reads Connected with
// no button. Each row is the real status of a sign-in the adapter's own store
// holds, drawn by the real row.
await section("expired-login", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS, connectorRowState, rowMenu } = await rowsModule();
	const url = "http://127.0.0.1:9/mcp";
	const names = ["expired-login", "expired-renewable", "valid-login"];
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: Object.fromEntries(names.map((name) => [name, { url }])) }));
	const now = Math.floor(Date.now() / 1000);
	authStore.updateTokens("expired-login", { accessToken: "synthetic-expired", expiresAt: now - 3600 }, url);
	authStore.updateTokens("expired-renewable", { accessToken: "synthetic-renewable", refreshToken: "synthetic-refresh", expiresAt: now - 3600 }, url);
	authStore.updateTokens("valid-login", { accessToken: "synthetic-valid", expiresAt: now + 3600 }, url);
	const rows = new Map((await getMcpConnectorsStatus()).servers.map((row: { name: string }) => [row.name, row]));
	const drawn = (name: string) => {
		const server = rows.get(name);
		const html = renderToStaticMarkup(createElement(ConnectorRow, { server, check: null, open: false, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly: false })) as string;
		const status = /<span class="connector-item-status[^"]*">(.*?)<\/span>/.exec(html)?.[1];
		const button = /<span class="connector-item-slot">.*?<span class="connector-slot-label">(.*?)<\/span>/.exec(html)?.[1] ?? null;
		return { status, button, disconnect: rowMenu(server, connectorRowState(server, null, null), false).includes("disconnect") };
	};
	const { status, button } = CONNECTOR_WORDS;
	const cases: Array<[string, { status: string; button: string | null; disconnect: boolean }]> = [
		["expired-login", { status: status.needsReconnecting, button: button.reconnect, disconnect: true }],
		["expired-renewable", { status: status.connected, button: null, disconnect: true }],
		["valid-login", { status: status.connected, button: null, disconnect: true }],
	];
	for (const [name, expected] of cases) {
		const got = drawn(name);
		assert(JSON.stringify(got) === JSON.stringify(expected), `${name}'s row should read ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
	}
});

// A check that says the connector needs a sign-in again offers Reconnect; a
// sign-in that fails reads "Sign-in didn't finish" with its reason and Try
// again; once a sign-in succeeds the row reads Connected with no button. The
// real row is clicked in a page; the check runs the real adapter against a
// stand-in that refuses the stored token, and the sign-in is a stand-in that
// stores fresh tokens, as a finished sign-in does.
await section("login-after-test", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { testMcpServer } = await import("../src/mcp-admin.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS, checkOf } = await rowsModule();
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
	const { lineText } = await rowsModule();
	const FAILED = lineText(CONNECTOR_WORDS.wentWrong.busy, false);
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	// The page and the adapter share this process's fetch: only the page's own calls are answered here.
	const realFetch = globalThis.fetch;
	const pageFetch = async (input: unknown, init?: { method?: string }) => {
		if (typeof input !== "string" || !input.startsWith("/api/")) return realFetch(input as string, init as RequestInit);
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		const base = `/api/mcp/servers/${name}`;
		if (route === `POST ${base}/login`) {
			if (!loginFails) authStore.updateTokens(name, { accessToken: "synthetic-fresh", expiresAt: later() }, url);
			return json({ started: true });
		}
		if (route === `GET ${base}/login`) return json(loginFails ? { pending: false, cause: "busy", detail: "stand-in: sign-in refused" } : { pending: false });
		throw new Error(`the row asked for ${route}, which this smoke does not answer`);
	};
	const { JSDOM } = await import("jsdom");
	const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
	const globals = globalThis as any;
	const previous = { window: globals.window, document: globals.document, fetch: globals.fetch, act: globals.IS_REACT_ACT_ENVIRONMENT };
	globals.window = dom.window;
	globals.document = dom.window.document;
	globals.fetch = pageFetch;
	globals.IS_REACT_ACT_ENVIRONMENT = true;
	const ownNavigator = !("navigator" in globalThis);
	if (ownNavigator) globals.navigator = dom.window.navigator;
	const { createRoot } = pageRequire("react-dom/client");
	const { act } = pageRequire("react");
	const container = dom.window.document.getElementById("root")!;
	const root = createRoot(container);
	try {
		// The page keeps the newest check per row and draws the row again when it changes.
		let check: unknown = null;
		const draw = async () => {
			const server = (await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name);
			assert(server, `${name} is on the page`);
			// In StrictMode, as the page is mounted while it is developed: its effects run, are undone and run again.
			await act(async () => root.render(createElement(React.StrictMode, null, createElement(ConnectorRow, { server, check, open: true, onToggle: noop, onCheck: (_: string, next: unknown) => { check = next; }, onChanged: draw, onNotice: noop, readOnly: false }))));
		};
		const status = () => container.querySelector(".connector-item-status")?.textContent;
		const button = () => container.querySelector(".connector-item-slot .connector-slot-label")?.textContent ?? null;
		const click = (label: string) => act(async () => {
			const found = container.querySelector(".connector-item-slot button");
			assert(found && button() === label, `the row offers ${label}, got ${JSON.stringify(button())}`);
			found.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
		});
		const waitFor = async (what: string, done: () => boolean) => {
			for (let tries = 0; tries < 200 && !done(); tries++) await act(() => sleep(50));
			assert(done(), `waited for ${what}, the row reads ${container.textContent}`);
		};
		await draw();
		assert(status() === CONNECTOR_WORDS.status.connected && button() === null, `a row with a stored token reads Connected with no button, got ${JSON.stringify([status(), button()])}`);
		// The page's background check: the real adapter against the refusing stand-in.
		check = checkOf(await testMcpServer(name));
		await draw();
		assert(status() === CONNECTOR_WORDS.status.needsReconnecting && button() === CONNECTOR_WORDS.button.reconnect, `after a check that needs a sign-in, the row offers Reconnect, got ${JSON.stringify([status(), button()])}`);
		await click(CONNECTOR_WORDS.button.reconnect);
		await waitFor("the failed sign-in", () => status() === CONNECTOR_WORDS.status.signInFailed);
		assert(button() === CONNECTOR_WORDS.button.tryAgain && container.textContent!.includes(FAILED), `a sign-in that failed offers Try again and says why, got ${container.textContent}`);
		// The service's own words wait under Technical details, as a failed check's do.
		const fold = container.querySelector(".connector-tech");
		assert(fold?.querySelector("summary")?.textContent === CONNECTOR_WORDS.details.technicalDetails && fold?.querySelector("code")?.textContent === "stand-in: sign-in refused", `a failed sign-in keeps the service's words under Technical details, got ${container.textContent}`);
		loginFails = false;
		await click(CONNECTOR_WORDS.button.tryAgain);
		await waitFor("the sign-in to finish", () => status() === CONNECTOR_WORDS.status.connected);
		assert(button() === null, `after the sign-in succeeds the row has no button, got ${JSON.stringify(button())}`);
	} finally {
		await act(async () => root.unmount());
		globals.window = previous.window;
		globals.document = previous.document;
		globals.fetch = previous.fetch;
		globals.IS_REACT_ACT_ENVIRONMENT = previous.act;
		if (ownNavigator) delete globals.navigator;
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
// again. One the service was too busy for, that ran too long, or that failed
// for a reason not known keeps it. The
// server reads the adapter's own error into these causes.
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
	const cases: Array<[string, string, string, string | null, (place: "here" | "file" | "app") => unknown]> = [
		["HTTP 403: Invalid OAuth error response: SyntaxError: Unexpected token 'F'. Raw body: Forbidden", "refused", cantSignIn, null, (place) => failed.refused(place, "Cursor")],
		["Incompatible auth server: does not support dynamic client registration", "needs-own-app", cantSignIn, null, (place) => failed.needsOwnApp(place, "Cursor")],
		["HTTP 404 trying to load well-known OAuth metadata", "no-sign-in", cantSignIn, null, () => failed.noSignIn],
		["HTTP 503 trying to load well-known OAuth metadata", "busy", signInFailed, tryAgain, () => CONNECTOR_WORDS.wentWrong.busy],
		// A 501 is no busy service: waiting won't help, so it isn't worded as if it would.
		["Error POSTing to endpoint (HTTP 501): Not Implemented", "other", signInFailed, tryAgain, () => failed.other],
		["The sign-in timed out waiting for the browser", "too-slow", signInFailed, tryAgain, () => failed.tooSlow],
		["fetch failed", "other", signInFailed, tryAgain, () => failed.other],
	];
	for (const [message, cause, status, button, lineFor] of cases) {
		const failure = loginFailureOf(message);
		const state = { kind: "sign-in-failed", cause: failure.cause, detail: failure.detail };
		const look = rowLook(state, false);
		for (const place of ["here", "file", "app"] as const) {
			// The page words the line from the cause; the service's words always go under Technical details.
			const wrong = wentWrongLine(places[place], state, false);
			const got = [failure.cause, look.status, look.button, wrong?.line, wrong?.button ?? null, technicalDetails(state)];
			// Added here, a line that starts with removing it has Remove under it.
			const expected = [cause, status, button, lineFor(place), place === "here" && (cause === "refused" || cause === "needs-own-app") ? "remove" : null, message];
			assert(JSON.stringify(got) === JSON.stringify(expected), `${JSON.stringify(message)} on one added ${place} should give ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
		}
	}
	// The refused sign-in's line is the decided one, word for word, and from another app it names that app.
	const { lineText } = await rowsModule();
	assert(lineText(failed.refused("here", ""), false) === "This service doesn't let exxperts sign in, so trying again won't help. If you get a key for it, remove this connector and add it again with the key.", "the refused sign-in line is the one decided");
	assert(lineText(failed.refused("app", "Cursor"), false).endsWith("remove it in Cursor, then use Add custom connector with that key."), "from another app, the refused sign-in names it");
	// A sign-in with no answer by the page's deadline may still finish another time.
	assert(rowLook({ kind: "sign-in-failed" }, false).button === tryAgain, "a sign-in that never answered offers Try again");
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

// A key the service turned down is changed in the row: a custom connector's
// edit shows its address and the key, a directory connector's shows only the
// key, since its address is the directory's. The real row is clicked in a page.
await section("change-key", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS } = await rowsModule();
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
		github: { url: "http://127.0.0.1:9/mcp", headers: { Authorization: "Bearer synthetic-key" } },
		"team-wiki": { url: "http://127.0.0.1:9/wiki", headers: { Authorization: "Bearer synthetic-key" } },
	} }));
	const rows = new Map((await getMcpConnectorsStatus()).servers.map((server: any) => [server.name, server]));
	const notices: string[] = [];
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		if (route.startsWith("PUT /api/mcp/servers/")) return json({ sameSite: true });
		if (route.startsWith("POST /api/mcp/servers/")) return json({ ok: true, toolCount: 1 });
		throw new Error(`the row asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		const fieldsAfterChangeKey = async (name: string) => {
			const server = rows.get(name);
			assert(server, `${name} is on the page`);
			const check = { at: Date.now(), ok: false, httpStatus: 401, error: "HTTP 401" };
			await render(createElement(ConnectorRow, { key: name, server, check, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: (line: string) => { notices.push(line); }, readOnly: false }));
			const way = [...container.querySelectorAll("button.connector-way")].find((found) => found.textContent === CONNECTOR_WORDS.button.changeKey);
			assert(way, `${name}'s turned-down key offers ${CONNECTOR_WORDS.button.changeKey}, the row reads ${container.textContent}`);
			await act(async () => { way.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
			const field = (label: string) => container.querySelector(`.connector-edit input[aria-label="${label}"]`) !== null;
			return { address: field(CONNECTOR_WORDS.details.address), key: field(CONNECTOR_WORDS.details.key) };
		};
		const custom = await fieldsAfterChangeKey("team-wiki");
		assert(custom.address && custom.key, `a custom connector's key edit shows its address and the key, got ${JSON.stringify(custom)}`);
		const directory = await fieldsAfterChangeKey("github");
		assert(!directory.address && directory.key, `a directory connector's key edit shows only the key, got ${JSON.stringify(directory)}`);
		// Nothing typed, nothing to save; a new key alone is saved as a key, not as a new address.
		const saveButton = () => [...container.querySelectorAll<HTMLButtonElement>(".connector-edit button")].find((found) => found.textContent === CONNECTOR_WORDS.button.save);
		assert(saveButton()?.disabled === true, "the key edit's Save waits for a new key");
		const keyField = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.key}"]`)!;
		// The page's React takes this window for an old browser and reads typing on a key event in a focused field.
		await act(async () => {
			keyField.focus();
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(keyField, "synthetic-new-key");
			keyField.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "y", bubbles: true }));
		});
		const save = saveButton();
		assert(save && !save.disabled, "the key edit offers Save once a key is typed");
		await act(async () => { save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
		for (let tries = 0; tries < 60 && notices.length === 0; tries++) await act(() => sleep(50));
		assert(JSON.stringify(notices) === JSON.stringify([CONNECTOR_WORDS.keySaved]), `saving a new key alone says the key is saved, got ${JSON.stringify(notices)}`);
	});
	// After adding from the directory, Connect is the next step only for one that signs in.
	const { addedNotice } = await rowsModule();
	for (const [kind, line] of [["oauth", CONNECTOR_WORDS.addedFromDirectory("X")], ["oauth-client", CONNECTOR_WORDS.addedFromDirectory("X")], ["open", CONNECTOR_WORDS.addedCustom("X")], ["token", CONNECTOR_WORDS.addedCustom("X")]]) {
		assert(addedNotice({ name: "X", kind }) === line, `adding a ${kind} entry says ${JSON.stringify(line)}, got ${JSON.stringify(addedNotice({ name: "X", kind }))}`);
	}
});

// Esc in the row's "⋯" closes only the menu, never the Settings window around
// it. Saving an address on the same site checks it at once, a connector that
// needs no sign-in included. A sign-in that failed can be checked from "⋯",
// as its line says.
await section("row-menu-and-save", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS, connectorRowState, rowMenu } = await rowsModule();
	const name = "plain-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/plain" } } }));
	const server: any = (await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name);
	assert(server && server.auth.mode === "oauth" && !server.auth.explicit && !server.auth.hasStoredTokens, `${name} is a bare address that may need no sign-in, got ${JSON.stringify(server?.auth)}`);
	// Each case is told apart, so one run shows every one that fails.
	const problems: string[] = [];
	const notices: string[] = [];
	if (!rowMenu(server, connectorRowState(server, null, { kind: "sign-in-failed", error: "no sign-in here" }), false).includes("checkConnection")) problems.push("a failed sign-in's menu offers Check connection");
	const asked: string[] = [];
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		asked.push(route);
		if (route === `PUT /api/mcp/servers/${name}/address`) return json({ name, sameSite: true });
		if (route === `POST /api/mcp/servers/${name}/test`) return json({ ok: true, toolCount: 1 });
		throw new Error(`the row asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		let escapesOutside = 0;
		dom.window.document.addEventListener("keydown", (e: KeyboardEvent) => { if (e.key === "Escape") escapesOutside++; });
		const check = { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" };
		await render(createElement(ConnectorRow, { server, check, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: (line: string) => { notices.push(line); }, readOnly: false }));
		// No room uses it, and the opened row says so (a phone hides the row's rooms link).
		const labels = [...container.querySelectorAll(".connector-label")].map((label) => [label.textContent, label.nextElementSibling?.textContent]);
		if (!labels.some(([label, value]) => label === CONNECTOR_WORDS.details.usedIn && value === CONNECTOR_WORDS.roomsLink(0))) problems.push(`an opened row no room uses says so under ${CONNECTOR_WORDS.details.usedIn}, got ${JSON.stringify(labels)}`);
		await act(async () => { container.querySelector("button.connector-item-more")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
		const item = container.ownerDocument.querySelector(".ai-profile-menu [role=menuitem]");
		assert(item, "the row's menu opened");
		await act(async () => { item.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
		assert(container.ownerDocument.querySelector(".ai-profile-menu") === null, "Esc closes the menu");
		if (escapesOutside !== 0) problems.push("Esc in the menu reaches nothing around the row");
		const way = [...container.querySelectorAll("button.connector-way")].find((found) => found.textContent === CONNECTOR_WORDS.button.changeAddress);
		assert(way, `a missing address offers ${CONNECTOR_WORDS.button.changeAddress}, the row reads ${container.textContent}`);
		await act(async () => { way.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
		const saveButton = () => [...container.querySelectorAll<HTMLButtonElement>(".connector-edit button")].find((found) => found.textContent === CONNECTOR_WORDS.button.save);
		if (saveButton()?.disabled !== true) problems.push("the address edit's Save waits for a change");
		const unchanged = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!;
		await act(async () => { unchanged.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
		await act(() => sleep(50));
		assert(!asked.includes(`PUT /api/mcp/servers/${name}/address`) && notices.length === 0, `Enter in the address edit waits for a change, as Save does, the row asked ${JSON.stringify(asked)}`);
		// A new address on the same site, typed as the page's React reads typing here (a key event in a focused field).
		const addressField = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!;
		await act(async () => {
			addressField.focus();
			Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, "value")!.set!.call(addressField, "http://127.0.0.1:9/plain/mcp");
			addressField.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "p", bubbles: true }));
		});
		const save = saveButton();
		assert(save && !save.disabled, "the address edit offers Save once the address changes");
		await act(async () => { save.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
		for (let tries = 0; tries < 100 && !asked.includes(`POST /api/mcp/servers/${name}/test`); tries++) await act(() => sleep(50));
		if (JSON.stringify(notices) !== JSON.stringify([CONNECTOR_WORDS.addressSaved])) problems.push(`an address save says the address is saved, got ${JSON.stringify(notices)}`);
		if (!asked.includes(`POST /api/mcp/servers/${name}/test`)) problems.push(`a same-site save is checked at once, the row asked ${JSON.stringify(asked)}`);
	});
	assert(problems.length === 0, problems.join("; "));
});

// A program's command sits right under What went wrong, where a web
// connector's address sits, so "Check its command" points at the next line.
await section("details-order", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS } = await rowsModule();
	const words = CONNECTOR_WORDS.details;
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { "local-files": { command: "node", args: ["files-server.js"] }, "plain-wiki": { url: "http://127.0.0.1:9/plain" } } }));
	const servers: any[] = (await getMcpConnectorsStatus()).servers;
	const orders: Record<string, (string | null)[]> = {};
	for (const name of ["local-files", "plain-wiki"]) {
		const server = servers.find((row: { name: string }) => row.name === name);
		assert(server, `${name} is listed`);
		const check = name === "plain-wiki" ? { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" } : { at: Date.now(), ok: false, error: "spawn node ENOENT" };
		await inPage(async (input, init) => { throw new Error(`the row asked for ${init?.method ?? "GET"} ${String(input)}, which this smoke does not answer`); }, async ({ container, render }) => {
			await render(createElement(ConnectorRow, { server, check, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly: false }));
			orders[name] = [...container.querySelectorAll(".connector-label")].map((label) => label.textContent);
		});
	}
	assert(JSON.stringify(orders["plain-wiki"]) === JSON.stringify([words.wentWrong, words.address, words.usedIn]), `a web connector's details read What went wrong, Address, Used in, got ${JSON.stringify(orders["plain-wiki"])}`);
	assert(JSON.stringify(orders["local-files"]) === JSON.stringify([words.wentWrong, words.runs, words.usedIn]), `a program's details read What went wrong, Runs, Used in, got ${JSON.stringify(orders["local-files"])}`);
});

// A check the server says outlived a change to its connector (a new address
// meanwhile) is not about it any more: the row keeps nothing of it. An
// ordinary answer next to it is kept.
await section("superseded-check", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS } = await rowsModule();
	const name = "moving-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/moving", auth: false } } }));
	const server: any = (await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name);
	const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
	let answer: Record<string, unknown> = {};
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		if (route === `POST /api/mcp/servers/${name}/test`) return json(answer);
		throw new Error(`the row asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		const kept: unknown[] = [];
		const checkFromMenu = async (reply: Record<string, unknown>) => {
			answer = reply;
			kept.length = 0;
			await render(createElement(ConnectorRow, { server, check: { at: Date.now(), ok: true }, open: false, onToggle: noop, onCheck: (_: string, check: unknown) => { kept.push(check); }, onChanged: async () => {}, onNotice: noop, readOnly: false }));
			await act(async () => { container.querySelector("button.connector-item-more")!.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
			const item = [...container.ownerDocument.querySelectorAll(".ai-profile-menu [role=menuitem]")].find((found) => found.textContent === CONNECTOR_WORDS.menu.checkConnection);
			assert(item, "a connected row's menu offers Check connection");
			await act(async () => { item.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
			for (let tries = 0; tries < 60 && container.querySelector(".connector-item-status")?.textContent === CONNECTOR_WORDS.status.checking; tries++) await act(() => sleep(50));
			return kept.length;
		};
		assert((await checkFromMenu({ ok: false, httpStatus: 404, error: "HTTP 404" })) === 1, "an ordinary check's answer is kept");
		assert((await checkFromMenu({ ok: false, httpStatus: 404, error: "HTTP 404", superseded: true })) === 0, "a superseded check's answer is not kept");
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

const click = (dom: any, act: (fn: () => Promise<void> | void) => Promise<void>, found: Element) => act(async () => { found.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true })); });
const buttonNamed = (root: ParentNode, label: string) => [...root.querySelectorAll<HTMLButtonElement>("button")].find((found) => found.textContent === label);
const jsonAnswer = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

// A new address on another site: the line under the field says what the move
// keeps and what the person must do again, a key is asked for and Save waits
// for it; one that would lose its own sign-in app or a header that isn't its
// key can't move there, and Save stays off.
await section("another-site-edit", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
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
	await inPage(async (input, init) => { throw new Error(`the row asked for ${init?.method ?? "GET"} ${String(input)}, which this smoke does not answer`); }, async ({ container, dom, act, render }) => {
		for (const [name, expected] of cases) {
			const server = rows.get(name);
			assert(server, `${name} is on the page`);
			await render(createElement(ConnectorRow, { key: name, server, check: null, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly: false }));
			await click(dom, act, container.querySelector("button.connector-item-more")!);
			const item = [...container.ownerDocument.querySelectorAll(".ai-profile-menu [role=menuitem]")].find((found) => found.textContent === CONNECTOR_WORDS.menu.changeAddress);
			assert(item, `${name}'s menu offers ${CONNECTOR_WORDS.menu.changeAddress}`);
			await click(dom, act, item);
			const address = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!;
			await typeInto(dom, act, address, `http://localhost:9/${name}`);
			const keyField = container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.key}"]`);
			const got = { hint: container.querySelector(".connector-edit-hint")?.textContent ?? null, key: keyField !== null, save: buttonNamed(container, CONNECTOR_WORDS.button.save)?.disabled === false };
			if (JSON.stringify(got) !== JSON.stringify(expected)) problems.push(`${name} on another site should show ${JSON.stringify(expected)}, got ${JSON.stringify(got)}`);
			// The line that says to remove it has Remove under it, asking the row's own question; no other line has one.
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
				const asked = container.querySelector(".connector-ask-q strong")?.textContent;
				if (asked !== CONNECTOR_WORDS.removeQuestion(shownName(server))) problems.push(`${name}'s Remove should ask the row's own question, got ${asked ?? "none"}`);
			}
			if (keyField) {
				await typeInto(dom, act, keyField, "synthetic-new-key");
				if (buttonNamed(container, CONNECTOR_WORDS.button.save)?.disabled !== false) problems.push(`${name}'s Save comes on once the key is typed`);
			}
		}
	});
	assert(problems.length === 0, problems.join("; "));
});

// A line that says to remove a connector added here has Remove under it, which
// asks the row's own question; a row from a file names the file where a row
// from another app names the app, by the path the page's line about it shows.
await section("remove-way-and-file-note", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
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
	const wrongBox = (container: HTMLElement) => container.querySelector(".connector-details");
	const wayNamed = (container: HTMLElement, label: string) => [...(wrongBox(container)?.querySelectorAll<HTMLButtonElement>("button.connector-way") ?? [])].find((button) => button.textContent === label) ?? null;
	await inPage(async (input, init) => { throw new Error(`the row asked for ${init?.method ?? "GET"} ${String(input)}, which this smoke does not answer`); }, async ({ container, dom, act, render }) => {
		const draw = (server: any, readOnly = false) => render(createElement(ConnectorRow, { key: `${server.name}-${readOnly}`, server, check: refused, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly, sharedFile: sharedPath }));
		// Two keys: the line says to remove it and add it again, and Remove under it asks the row's own question.
		await draw(rows.get("two-keys"));
		const remove = wayNamed(container, CONNECTOR_WORDS.button.remove);
		assert(remove, `the two-keys line has Remove under it, the row reads ${container.textContent}`);
		await click(dom, act, remove!);
		assert(container.querySelector(".connector-ask-q strong")?.textContent === CONNECTOR_WORDS.removeQuestion(shownName(rows.get("two-keys"))), `Remove asks the row's own question, the row reads ${container.textContent}`);
		// One key: Change key is its way on, and nothing says to remove it.
		await draw(rows.get("one-key"));
		assert(wayNamed(container, CONNECTOR_WORDS.button.changeKey) && !wayNamed(container, CONNECTOR_WORDS.button.remove), `one key: Change key, no Remove, the row reads ${container.textContent}`);
		assert(!container.querySelector(".connector-note"), `a connector added here names no file, the row reads ${container.textContent}`);
		// Over remote access the line shows its fact only, with no button.
		await draw(rows.get("two-keys"), true);
		assert(!wayNamed(container, CONNECTOR_WORDS.button.remove), `over remote access no Remove, the row reads ${container.textContent}`);
		// From the shared file: its line sends the person there, with no Remove under it, and the row names the file as the page's line does.
		await draw(rows.get("shared-wiki"));
		const shared = CONNECTOR_WORDS.addedInSharedFile;
		assert(!wayNamed(container, CONNECTOR_WORDS.button.remove), `a shared file's line has no Remove under it, the row reads ${container.textContent}`);
		assert(container.querySelector(".connector-note")?.textContent === `${shared.before}${sharedPath}${shared.after}`, `a row from the shared file names it, the row reads ${container.textContent}`);
		// From a file in the folder exxperts runs from: the row names that file.
		await draw(project);
		const own = CONNECTOR_WORDS.addedInProjectFile;
		assert(container.querySelector(".connector-note")?.textContent === `${own.before}~/work/.mcp.json${own.after}`, `a row from a project's file names it, the row reads ${container.textContent}`);
	});
});

// An answer that says the row is out of date: the list is read again, so a
// connector that no longer exists leaves it, and one that can't be changed
// here says so on its row with the edit closed.
await section("out-of-date", async () => {
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS } = await rowsModule();
	const { CONNECTOR_FORM_LINES } = await import("../src/connector-form.js");
	const name = "stale-wiki";
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { [name]: { url: "http://127.0.0.1:9/stale", auth: false } } }));
	const server: any = (await getMcpConnectorsStatus()).servers.find((row: { name: string }) => row.name === name);
	const answers: Record<string, Response> = {};
	await inPage(async (input, init) => {
		const route = `${init?.method ?? "GET"} ${String(input)}`;
		const answer = answers[route];
		if (answer) return answer.clone();
		throw new Error(`the row asked for ${route}, which this smoke does not answer`);
	}, async ({ container, dom, act, render }) => {
		let reads = 0;
		const draw = () => render(createElement(ConnectorRow, { server, check: { at: Date.now(), ok: true }, open: true, onToggle: noop, onCheck: noop, onChanged: async () => { reads++; }, onNotice: noop, readOnly: false }));
		const fromMenu = async (label: string) => {
			await click(dom, act, container.querySelector("button.connector-item-more")!);
			const item = [...container.ownerDocument.querySelectorAll(".ai-profile-menu [role=menuitem]")].find((found) => found.textContent === label);
			assert(item, `the menu offers ${label}`);
			await click(dom, act, item);
		};
		const waitForRead = async (what: string) => {
			for (let tries = 0; tries < 60 && reads === 0; tries++) await act(() => sleep(50));
			assert(reads > 0, `${what}: the list is read again`);
		};
		// Change address refused because it was moved to a file this page doesn't change.
		answers[`PUT /api/mcp/servers/${name}/address`] = jsonAnswer({ error: CONNECTOR_FORM_LINES.addressNotChangeable }, 409);
		await draw();
		await fromMenu(CONNECTOR_WORDS.menu.changeAddress);
		await typeInto(dom, act, container.querySelector<HTMLInputElement>(`.connector-edit input[aria-label="${CONNECTOR_WORDS.details.address}"]`)!, "http://127.0.0.1:9/stale/v2");
		// Saved by the button, as a click takes the focus from the field first.
		await act(async () => { (dom.window.document.activeElement as HTMLElement | null)?.blur(); });
		await click(dom, act, buttonNamed(container, CONNECTOR_WORDS.button.save)!);
		await waitForRead("a change refused as out of date");
		assert(container.querySelector(".connector-edit") === null && container.querySelector(".connector-row-error")?.textContent === CONNECTOR_FORM_LINES.addressNotChangeable, `the edit closes and the row says why, got ${container.textContent}`);
		// A check of a connector that no longer exists.
		reads = 0;
		answers[`POST /api/mcp/servers/${name}/test`] = jsonAnswer({ error: CONNECTOR_REQUEST_LINES.noLongerExists }, 404);
		await draw();
		await fromMenu(CONNECTOR_WORDS.menu.checkConnection);
		await waitForRead("a check of a connector that no longer exists");
		// Remove refused: added somewhere this page doesn't change.
		reads = 0;
		answers[`DELETE /api/mcp/servers/${name}`] = jsonAnswer({ error: CONNECTOR_REQUEST_LINES.notRemovable(null) }, 409);
		await draw();
		await fromMenu(CONNECTOR_WORDS.menu.remove);
		await click(dom, act, buttonNamed(container, CONNECTOR_WORDS.button.remove)!);
		await waitForRead("a refused Remove");
		assert(container.querySelector(".connector-row-error")?.textContent === CONNECTOR_REQUEST_LINES.notRemovable(null), `a refused Remove says why, got ${container.textContent}`);
	});
});

// Over remote access the page changes nothing, so a line shows its fact
// alone, and "this computer" is the computer itself, not the device in hand.
await section("remote-words", async () => {
	const { ConnectorRow } = await component("ConnectorsPage.tsx");
	const { CONNECTOR_WORDS, lineText } = await rowsModule();
	const auth = { mode: "none", explicit: false, hasStoredTokens: false, tokenExpired: null, hasRefreshToken: false };
	const base = { tools: null, usedIn: [], lastCheck: null, key: "none", movesToAnotherSite: true, source: { kind: "user", path: "~/.exxperts/agent/mcp.json" }, auth };
	const web = { ...base, name: "team-wiki", transport: "http", target: "http://127.0.0.1:9/wiki", editable: true };
	const program = { ...base, name: "local-files", transport: "stdio", target: "node files-server.js", editable: false };
	const drawn = (server: unknown, check: unknown, readOnly: boolean) => text(renderToStaticMarkup(createElement(ConnectorRow, { server, check, open: true, onToggle: noop, onCheck: noop, onChanged: async () => {}, onNotice: noop, readOnly })) as string);
	const notFound = { at: Date.now(), ok: false, httpStatus: 404, error: "HTTP 404" };
	const words = CONNECTOR_WORDS.wentWrong;
	const remoteWeb = drawn(web, notFound, true);
	assert(remoteWeb.includes(words.addressNotFound.fact) && !remoteWeb.includes(words.addressNotFound.way!), `over remote access the line is its fact alone, got ${remoteWeb}`);
	assert(drawn(web, notFound, false).includes(lineText(words.addressNotFound, false)), "on the computer itself the line keeps its way on");
	const remoteProgram = drawn(program, null, true);
	assert(remoteProgram.includes(CONNECTOR_WORDS.status.programRemote) && remoteProgram.includes(CONNECTOR_WORDS.details.runsHereRemote) && !remoteProgram.includes("this computer"), `over remote access a program runs on the computer itself, got ${remoteProgram}`);
	const remoteFailed = drawn(program, { at: Date.now(), ok: false, error: "spawn node ENOENT" }, true);
	assert(remoteFailed.includes(words.programRemote.fact) && !remoteFailed.includes(words.program.way!), `a program that didn't answer, over remote access, got ${remoteFailed}`);
	const ownProgram = drawn(program, null, false);
	assert(ownProgram.includes(CONNECTOR_WORDS.status.program) && ownProgram.includes(CONNECTOR_WORDS.details.runsHere), `on the computer itself a program runs on this computer, got ${ownProgram}`);
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
		assert(container.querySelector(".room-connector-allowed-label")?.textContent === "Allowed without asking:" && container.textContent!.includes("Reading runs freely. Anything else asks you first, unless you allowed it below."), `the pane lists the allowed tools, got ${container.textContent}`);
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

console.log("memory-connectors-bugs smoke passed");
process.exit(0);
