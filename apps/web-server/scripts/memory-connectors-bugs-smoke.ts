// What a person meets at the end of a Memorize that only sorts notes, and
// after a failed connector Test. The run comes from the real server code on a
// temp room, the Test and the connector rows from the real
// adapter against a local stand-in answering each status; the page's own
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

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "memory-connectors-bugs-home-"));
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

// Item 3: every status a server really answers a failed Test with gets advice
// of its own. The adapter's answer comes from a local stand-in; the page words it.
await section("test-status-advice", async () => {
	const { addMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
	const { failedTestNextStep } = await component("ConnectorsPage.tsx");
	assert(typeof failedTestNextStep === "function", "the page's next step after a failed Test can be read");
	const BUSY = "The server is busy. Test again in a little while.";
	const OWN_ERROR = "The server answered with an error of its own. Test again later.";
	const rows: Array<[number, string]> = [
		[404, 'The address answered "not found". Check the address; to change it, remove this connector and add it again.'],
		[408, BUSY],
		[418, "The server turned the connection down. Check the address; to change it, remove this connector and add it again."],
		[425, BUSY],
		[429, BUSY],
		[500, OWN_ERROR],
		[502, OWN_ERROR],
		[503, OWN_ERROR],
		[504, OWN_ERROR],
		[520, OWN_ERROR],
	];
	for (const [status, advice] of rows) {
		const server = http.createServer((req, res) => {
			req.resume();
			req.on("end", () => { res.writeHead(status, { "Content-Type": "text/plain" }); res.end(`stand-in answered ${status}`); });
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const name = `status-${status}`;
			await addMcpServer({ name, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp` });
			const result = await testMcpServer(name);
			assert(!result.ok && !result.needsAuth && result.httpStatus === status, `the Test reports ${status}, got ${JSON.stringify(result)}`);
			const line = failedTestNextStep({ httpStatus: result.httpStatus, message: result.error ?? "" }, { transport: "http", source: null });
			assert(line === advice, `HTTP ${status} gets ${JSON.stringify(advice)}, got ${JSON.stringify(line)}`);
		} finally {
			server.closeAllConnections();
			server.close();
		}
	}
});

// Item 4: a connector imported from another tool cannot be removed here, so a
// failed Test points to that tool's own file, named as people know the tool,
// never to Remove. One in the exxperts file, or in the shared global file
// (which Remove does edit), keeps Remove's way.
await section("imported-test-advice", async () => {
	const { addMcpServer, removeMcpServer, testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const { failedTestNextStep } = await component("ConnectorsPage.tsx");
	const server = http.createServer((req, res) => {
		req.resume();
		req.on("end", () => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("stand-in answered 404"); });
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	try {
		const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
		const closed = "http://127.0.0.1:9/mcp";
		const writeJson = (file: string, value: unknown) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value)); };
		writeJson(path.join(tempHome, ".cursor", "mcp.json"), { mcpServers: { "from-cursor": { url }, "cursor-local": { command: "zq-no-such-program" } } });
		writeJson(path.join(tempHome, ".claude.json"), { mcpServers: { "from-claude": { url: closed } } });
		writeJson(path.join(tempHome, ".config", "mcp", "mcp.json"), { mcpServers: { "shared-404": { url } } });
		const configPath = path.join(agentDir, "mcp.json");
		const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf-8")) : {};
		writeJson(configPath, { ...config, imports: ["cursor", "claude-code"] });
		await addMcpServer({ name: "own-404", url });
		const rows = new Map((await getMcpConnectorsStatus()).servers.map((row) => [row.name, row]));
		const line = async (name: string) => {
			const row = rows.get(name);
			assert(row, `${name} is on the page, got ${JSON.stringify([...rows.keys()])}`);
			const result = await testMcpServer(name);
			assert(!result.ok && !result.needsAuth, `${name}'s Test fails, got ${JSON.stringify(result)}`);
			return failedTestNextStep({ httpStatus: result.httpStatus, message: result.error ?? "" }, row) as string;
		};
		// The page shows the file with this system's separators (~\.cursor\mcp.json on Windows).
		const cursorFile = path.join("~", ".cursor", "mcp.json");
		const claudeFile = path.join("~", ".claude.json");
		const cases: Array<[string, string]> = [
			["from-cursor", `The address answered "not found". Check the address in Cursor's file ${cursorFile}.`],
			["cursor-local", `The program did not answer as a connector. To change its command, edit it in Cursor's file ${cursorFile}.`],
			["from-claude", `The server did not answer as a connector. To change its address, edit it in Claude Code's file ${claudeFile}.`],
			["own-404", 'The address answered "not found". Check the address; to change it, remove this connector and add it again.'],
		];
		for (const [name, advice] of cases) {
			const got = await line(name);
			assert(got === advice, `${name}'s failed Test says ${JSON.stringify(advice)}, got ${JSON.stringify(got)}`);
		}
		// Remove agrees with the words: it refuses the imported one and takes the shared one.
		const shared = await line("shared-404");
		assert(shared.includes("remove this connector and add it again") && !rows.get("shared-404")?.source?.importFile, `the shared global file keeps Remove's way, got ${JSON.stringify([shared, rows.get("shared-404")?.source])}`);
		const removed = await removeMcpServer("shared-404");
		assert(removed.removedFrom.length === 1, `Remove takes the shared one, got ${JSON.stringify(removed)}`);
		let refused = "";
		await removeMcpServer("from-cursor").catch((error: Error) => { refused = error.message; });
		assert(refused.includes("not defined in an exxperts config file"), `Remove refuses the imported one, got ${JSON.stringify(refused)}`);
	} finally {
		server.closeAllConnections();
		server.close();
	}
});

console.log("memory-connectors-bugs smoke passed");
process.exit(0);
