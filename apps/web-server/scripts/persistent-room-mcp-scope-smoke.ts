// Per-room MCP enforcement smoke: the shared room-scope wrapper, driven
// through the REAL exxperts mcp extension and the REAL pi-mcp-adapter against
// two configured connectors (alpha granted, beta not). Proves, per door:
//
//  SEE   - the proxy tool's description, status, list, search and describe
//          speak only of the granted connector;
//  CALL  - every server-naming mode refuses the ungranted connector BEFORE
//          the adapter runs (a live HTTP recorder on beta proves no request
//          ever reaches it), while granted traffic passes through;
//  LIVE  - grants re-read per call: editing the room's settings file changes
//          the very next answer, no re-registration needed;
//  DOORS - the live web session and the background execution path both build
//          their extension via createRoomScopedMcpExtension, a CLI room
//          process scopes itself from EXXETA_PERSISTENT_ROOM_AGENT, an
//          unscoped session stays untouched, specialists cannot even be
//          granted the mcp tool, and the isolated worker (consults, maintain
//          flows) runs with no extensions and no tools at all.
//
// Offline, isolated HOME + agent dir + agents root - set BEFORE any import
// that reads them.
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-scope-home-"));
const tempAgentsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-scope-root-"));
const agentDir = path.join(tempHome, ".exxperts", "agent");
process.env.HOME = tempHome;
process.env.USERPROFILE = tempHome;
process.env.PI_CODING_AGENT_DIR = agentDir;
process.env.EXXETA_PERSISTENT_AGENTS_ROOT = tempAgentsRoot;
delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;
delete process.env.MCP_DIRECT_TOOLS;

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const webServerSrc = path.resolve(scriptDir, "..", "src");

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

// Live recorders: any request reaching them is a real connection attempt.
function recorder(): { server: http.Server; hits: () => number; url: () => string } {
	let count = 0;
	const server = http.createServer((_req, res) => {
		count += 1;
		res.writeHead(500).end();
	});
	return {
		server,
		hits: () => count,
		url: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`,
	};
}
const alphaRecorder = recorder();
const betaRecorder = recorder();
const fooRecorder = recorder();
const fooBarRecorder = recorder();

// Minimal ExtensionAPI stand-in: captures tools/commands/handlers the way the
// runtime would hold them.
interface FakePi {
	tools: Map<string, any>;
	commands: Map<string, any>;
	handlers: Map<string, Array<(event: unknown, ctx: unknown) => unknown>>;
	/** Flag values the runtime would surface via getFlag (e.g. --mcp-config). */
	flags: Map<string, unknown>;
	registerTool: (tool: any) => void;
	registerCommand: (name: string, options: any) => void;
	registerFlag: (name: string, options: any) => void;
	getFlag: (name: string) => unknown;
	getAllTools: () => any[];
	sendMessage: (...args: unknown[]) => void;
	on: (event: string, handler: (event: unknown, ctx: unknown) => unknown) => void;
}

function makeFakePi(): FakePi {
	const pi: FakePi = {
		tools: new Map(),
		commands: new Map(),
		handlers: new Map(),
		flags: new Map(),
		registerTool(tool: any) { pi.tools.set(String(tool.name), tool); },
		registerCommand(name: string, options: any) { pi.commands.set(name, options); },
		registerFlag() {},
		getFlag(name: string) { return pi.flags.get(name); },
		getAllTools() { return [...pi.tools.values()]; },
		sendMessage() {},
		on(event: string, handler) {
			const list = pi.handlers.get(event) ?? [];
			list.push(handler);
			pi.handlers.set(event, list);
		},
	};
	return pi;
}

const fakeCtx = { cwd: tempHome, hasUI: false, ui: undefined, modelRegistry: undefined, model: undefined, signal: undefined, reload: async () => {} };

async function startSession(pi: FakePi): Promise<void> {
	for (const handler of pi.handlers.get("session_start") ?? []) await handler({}, fakeCtx);
}

async function shutdownSession(pi: FakePi): Promise<void> {
	for (const handler of pi.handlers.get("session_shutdown") ?? []) await handler({}, fakeCtx);
}

async function callMcp(pi: FakePi, params: Record<string, unknown>): Promise<{ text: string; details: any }> {
	const tool = pi.tools.get("mcp");
	assert(tool, "the mcp proxy tool must be registered");
	const result = await tool.execute("smoke-call", params, undefined, undefined, fakeCtx);
	return { text: String(result?.content?.[0]?.text ?? ""), details: result?.details ?? {} };
}

const roomId = "mcp-scope-smoke-room";

try {
	await new Promise<void>((resolve) => alphaRecorder.server.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => betaRecorder.server.listen(0, "127.0.0.1", resolve));

	// ── Migration safety: a corrupt config must ABORT without the marker ─────
	// The adapter reads a corrupt config file as "no servers"; migrating off
	// that would grant every legacy room an empty list and stamp the
	// irreversible marker. Isolated agents root, driven directly.
	fs.mkdirSync(agentDir, { recursive: true, mode: 0o700 });
	const { ensureRoomScopedMcpGrantsMigration } = await import("../../../pi-package/extensions/mcp/room-scope.js");
	const isolatedMigrationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-scope-migration-"));
	fs.mkdirSync(path.join(isolatedMigrationRoot, "corrupt-era-room"), { recursive: true });
	fs.writeFileSync(path.join(isolatedMigrationRoot, "corrupt-era-room", "agent.json"), "{}");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), "{ this is not json");
	const abortedMigration = await ensureRoomScopedMcpGrantsMigration({ persistentAgentsRoot: isolatedMigrationRoot });
	assert(abortedMigration.skipped === "unreadable-config", `a corrupt config must abort the migration, got ${JSON.stringify(abortedMigration)}`);
	assert(!fs.existsSync(path.join(isolatedMigrationRoot, ".mcp-grants-migration.json")), "an aborted migration must NOT stamp the marker");
	assert(!fs.existsSync(path.join(isolatedMigrationRoot, "corrupt-era-room", "runtime", "mcp-settings.json")), "an aborted migration must leave rooms untouched");

	// ── Migration guard: imports + dual-key precedence ───────────────────────
	// A discovery config declaring `imports` pulls connectors from Cursor/
	// Claude compatibility files that the adapter silently DROPS on a parse
	// failure - the guard must abort on an unreadable import file exactly like
	// on an unreadable discovery file. And a file carrying BOTH mcpServers and
	// mcp-servers keys is valid: the adapter reads only the first, so names
	// under the second must not make the guard abort forever.
	const isolatedImportsRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-scope-imports-"));
	fs.mkdirSync(path.join(isolatedImportsRoot, "imports-era-room"), { recursive: true });
	fs.writeFileSync(path.join(isolatedImportsRoot, "imports-era-room", "agent.json"), "{}");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({
		mcpServers: { alpha: { url: "http://127.0.0.1:9/mcp" }, beta: { url: "http://127.0.0.1:9/mcp" } },
		"mcp-servers": { "ghost-key": { url: "http://127.0.0.1:9/mcp" } },
		imports: ["cursor"],
	}, null, 2));
	const cursorDir = path.join(tempHome, ".cursor");
	fs.mkdirSync(cursorDir, { recursive: true, mode: 0o700 });
	fs.writeFileSync(path.join(cursorDir, "mcp.json"), "{ truncated mid-save");
	const importAborted = await ensureRoomScopedMcpGrantsMigration({ persistentAgentsRoot: isolatedImportsRoot });
	assert(importAborted.skipped === "unreadable-config", `an unreadable IMPORT file must abort the migration, got ${JSON.stringify(importAborted)}`);
	assert(!fs.existsSync(path.join(isolatedImportsRoot, ".mcp-grants-migration.json")), "an import-file abort must NOT stamp the marker");
	fs.writeFileSync(path.join(cursorDir, "mcp.json"), JSON.stringify({ mcpServers: { gamma: { url: "http://127.0.0.1:9/mcp" } } }, null, 2));
	const importHealed = await ensureRoomScopedMcpGrantsMigration({ persistentAgentsRoot: isolatedImportsRoot });
	assert(importHealed.skipped === null && importHealed.migrated.join(",") === "imports-era-room", `a healed import file must let the migration through despite the dual-key file, got ${JSON.stringify(importHealed)}`);
	assert(
		JSON.parse(fs.readFileSync(path.join(isolatedImportsRoot, "imports-era-room", "runtime", "mcp-settings.json"), "utf-8")).grantedConnectors.join(",") === "alpha,beta,gamma",
		"the migrated list must carry the adapter-visible names: both direct keys' winners plus the imported connector, never the dropped mcp-servers names",
	);
	fs.rmSync(isolatedImportsRoot, { recursive: true, force: true });
	fs.rmSync(cursorDir, { recursive: true, force: true });

	// Global connector config + a valid metadata cache (lazy lifecycle, so
	// session start reconstructs tools from cache without connecting).
	const servers = {
		alpha: { url: alphaRecorder.url() },
		beta: { url: betaRecorder.url() },
	};
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));
	const cacheMod = await import("pi-mcp-adapter/metadata-cache.ts" as string);
	const alphaBetaCache = {
		version: 1,
		servers: {
			alpha: { configHash: cacheMod.computeServerHash(servers.alpha), cachedAt: Date.now(), resources: [], tools: [{ name: "search_docs", description: "Search the alpha docs" }] },
			beta: { configHash: cacheMod.computeServerHash(servers.beta), cachedAt: Date.now(), resources: [], tools: [{ name: "fetch_page", description: "Fetch a beta page" }, { name: "search_docs", description: "Search the beta docs" }] },
		},
	};
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(alphaBetaCache, null, 2));

	// With the config healed, the same isolated migration now goes through.
	const healedMigration = await ensureRoomScopedMcpGrantsMigration({ persistentAgentsRoot: isolatedMigrationRoot });
	assert(healedMigration.skipped === null && healedMigration.migrated.join(",") === "corrupt-era-room", `a healed config must migrate, got ${JSON.stringify(healedMigration)}`);
	assert(JSON.parse(fs.readFileSync(path.join(isolatedMigrationRoot, "corrupt-era-room", "runtime", "mcp-settings.json"), "utf-8")).grantedConnectors.join(",") === "alpha,beta", "the healed migration must grant the full list");
	fs.rmSync(isolatedMigrationRoot, { recursive: true, force: true });

	const { writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
	writePersistentRoomMcpSettings(roomId, ["alpha"]);

	// A legacy room on the DEFAULT agents root: the extension's room-scoped
	// registration (the CLI door's exact path) must run the update-day
	// migration itself, so a terminal-opened room is never stuck at zero
	// grants waiting for the web server's first boot.
	fs.mkdirSync(path.join(tempAgentsRoot, "cli-legacy-room"), { recursive: true });
	fs.writeFileSync(path.join(tempAgentsRoot, "cli-legacy-room", "agent.json"), "{}");

	const mcpExtModule = await import("../../../pi-package/extensions/mcp/index.js");
	const { createRoomScopedMcpExtension } = mcpExtModule;

	// ── The room-scoped session (the web door's exact assembly) ──────────────
	const pi = makeFakePi();
	await createRoomScopedMcpExtension(roomId)(pi);
	await startSession(pi);

	// The registration above ran the marker-guarded migration on the default
	// root: the legacy room now holds the full connector list.
	assert(fs.existsSync(path.join(tempAgentsRoot, ".mcp-grants-migration.json")), "a room-scoped registration must run the update-day migration");
	assert(JSON.parse(fs.readFileSync(path.join(tempAgentsRoot, "cli-legacy-room", "runtime", "mcp-settings.json"), "utf-8")).grantedConnectors.join(",") === "alpha,beta", "the room door's migration must grant legacy rooms the full connector list");

	// SEE: manifest description names only the granted connector.
	const description = String(pi.tools.get("mcp")?.description ?? "");
	assert(description.includes("alpha"), "the proxy description should name the granted connector");
	assert(!description.includes("beta"), "the proxy description must not name an ungranted connector");

	// SEE: status speaks only of the granted connector.
	const status = await callMcp(pi, {});
	assert(status.text.includes("alpha"), `status should list the granted connector, got: ${status.text}`);
	assert(!status.text.includes("beta"), `status must not list an ungranted connector, got: ${status.text}`);
	assert(Array.isArray(status.details.servers) && status.details.servers.length === 1 && status.details.servers[0].name === "alpha", "status details must hold EXACTLY the room's list");

	// SEE: list of the granted connector works from cache; the ungranted one refuses.
	const listAlpha = await callMcp(pi, { server: "alpha" });
	assert(listAlpha.text.includes("alpha_search_docs"), `granted list should show cached tools, got: ${listAlpha.text}`);
	const listBeta = await callMcp(pi, { server: "beta" });
	assert(listBeta.details.error === "connector_not_enabled", "listing an ungranted connector must refuse");
	assert(listBeta.text.includes("not enabled for this room") && listBeta.text.includes("control which connectors this room can use"), `the refusal wording must match the product rule, got: ${listBeta.text}`);

	// SEE: unscoped search matches only granted tools, though beta also matches.
	const search = await callMcp(pi, { search: "search_docs" });
	assert(search.details.count === 1 && search.details.matches[0].server === "alpha", `search must fan out over granted connectors only, got: ${JSON.stringify(search.details)}`);
	assert(!search.text.includes("beta_search_docs"), "search text must not surface ungranted tools");

	// SEE: describing a tool owned only by an ungranted connector refuses.
	const describe = await callMcp(pi, { describe: "beta_fetch_page" });
	assert(describe.details.error === "connector_not_enabled", "describe of an ungranted connector's tool must refuse");

	// CALL: nothing above ever touched either server.
	assert(alphaRecorder.hits() === 0 && betaRecorder.hits() === 0, "read-only modes must not open connections");

	// CALL: ungranted traffic is refused BEFORE the adapter runs.
	for (const params of [
		{ tool: "beta_fetch_page" },
		{ tool: "fetch_page", server: "beta" },
		{ connect: "beta" },
		{ search: "page", server: "beta" },
		{ action: "auth-start", server: "beta" },
		{ action: "auth-complete", server: "beta", args: JSON.stringify({ code: "x" }) },
	]) {
		const refused = await callMcp(pi, params as Record<string, unknown>);
		assert(refused.details.error === "connector_not_enabled", `ungranted mode must refuse: ${JSON.stringify(params)} got ${JSON.stringify(refused.details)}`);
	}
	assert(betaRecorder.hits() === 0, "no refused mode may ever reach the ungranted server");

	// CALL: granted traffic passes through to the adapter (which really tries
	// the connection - the recorder answers 500, so the call fails HONESTLY
	// with the granted server's name on it).
	const alphaCall = await callMcp(pi, { tool: "alpha_search_docs", args: JSON.stringify({ query: "q" }) });
	assert(alphaRecorder.hits() > 0, "a granted call must reach the granted server");
	assert(String(alphaCall.details.server ?? "") === "alpha" || alphaCall.text.includes("alpha"), `the granted call's outcome should name the granted server, got: ${alphaCall.text}`);
	assert(betaRecorder.hits() === 0, "granted traffic must not touch other servers");

	// LIVE: granting beta on disk changes the very next answer, no rebind.
	writePersistentRoomMcpSettings(roomId, ["alpha", "beta"]);
	const statusBoth = await callMcp(pi, {});
	assert(statusBoth.details.servers.length === 2, "a fresh grant must apply from the next call");
	writePersistentRoomMcpSettings(roomId, []);
	const statusNone = await callMcp(pi, {});
	assert(statusNone.details.error === "no_connectors_enabled", "an emptied grant list must apply from the next call");
	assert(statusNone.text.includes("No MCP connectors are enabled for this room"), `the zero-grant answer should say so plainly, got: ${statusNone.text}`);
	const searchNone = await callMcp(pi, { search: "search_docs" });
	assert(searchNone.details.error === "no_connectors_enabled", "search with zero grants must answer the zero-grant refusal");
	writePersistentRoomMcpSettings(roomId, ["alpha"]);
	await shutdownSession(pi);

	// ── Cold cache: session start warms ONLY granted connectors ──────────────
	// Without the guard, a missing cache file makes the adapter's session
	// start bootstrap-connect EVERY configured server once, ungranted beta
	// included (owner decision 2026-08-11: restrict the bootstrap to grants;
	// eager/keep-alive keep their global behavior).
	const alphaHitsBeforeCold = alphaRecorder.hits();
	const betaHitsBeforeCold = betaRecorder.hits();
	fs.rmSync(path.join(agentDir, "mcp-cache.json"), { force: true });
	const piCold = makeFakePi();
	await createRoomScopedMcpExtension(roomId)(piCold);
	assert(fs.existsSync(path.join(agentDir, "mcp-cache.json")), "the cold-cache guard must recreate the cache file before the adapter session starts");
	assert(alphaRecorder.hits() > alphaHitsBeforeCold, "the cold-cache warm-up must try the granted connector");
	await startSession(piCold);
	assert(betaRecorder.hits() === betaHitsBeforeCold, "a cold cache must never bootstrap-connect an ungranted connector in a room session");
	await shutdownSession(piCold);
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(alphaBetaCache, null, 2));

	// ── Bind-time fingerprint: reported from the description's OWN read ──────
	// The web session records this exact value as its bound fingerprint, so a
	// grant edit racing the bind can never leave the manifest silently stale.
	let reportedFingerprint: string | null = null;
	const piFingerprint = makeFakePi();
	await createRoomScopedMcpExtension(roomId, { onBoundGrants: (fingerprint: string) => { reportedFingerprint = fingerprint; } })(piFingerprint);
	assert(reportedFingerprint === JSON.stringify(["alpha"]), `the wrapper must report the grants fingerprint its description used, got ${JSON.stringify(reportedFingerprint)}`);

	// ── The --mcp-config override: one baseline for adapter and wrapper ──────
	// A CLI room launched with --mcp-config reads connectors from the override
	// file; the grant context must see the SAME baseline or an override-only
	// connector is granted-but-refused by the configured intersection.
	const overridePath = path.join(tempHome, "override-mcp.json");
	fs.writeFileSync(overridePath, JSON.stringify({ mcpServers: { omega: { url: "http://127.0.0.1:9/mcp" } } }, null, 2));
	const overrideRoomId = "mcp-scope-smoke-override-room";
	writePersistentRoomMcpSettings(overrideRoomId, ["omega"]);
	process.argv.push("--mcp-config", overridePath);
	try {
		const piOverride = makeFakePi();
		piOverride.flags.set("mcp-config", overridePath);
		await createRoomScopedMcpExtension(overrideRoomId)(piOverride);
		await startSession(piOverride);
		const overrideDescription = String(piOverride.tools.get("mcp")?.description ?? "");
		assert(overrideDescription.includes("omega"), `the override file's granted connector must appear in the manifest, got: ${overrideDescription}`);
		const overrideStatus = await callMcp(piOverride, {});
		assert(Array.isArray(overrideStatus.details.servers) && overrideStatus.details.servers.length === 1 && overrideStatus.details.servers[0].name === "omega", `an override-only connector must be usable when granted, got ${JSON.stringify(overrideStatus.details)}`);
		await shutdownSession(piOverride);
	} finally {
		process.argv.splice(process.argv.indexOf("--mcp-config"), 2);
	}
	fs.rmSync(overridePath, { force: true });

	// ── Zero-grant room at BIND time: description carries the plain note ─────
	const piEmpty = makeFakePi();
	await createRoomScopedMcpExtension("mcp-scope-smoke-empty-room")(piEmpty);
	const emptyDescription = String(piEmpty.tools.get("mcp")?.description ?? "");
	assert(emptyDescription.includes("No MCP connectors are enabled for this room"), "a zero-grant room's manifest description should say so");
	assert(!emptyDescription.includes("alpha") && !emptyDescription.includes("beta"), "a zero-grant room's description must name no connectors");

	// ── The CLI room door: the process env scopes the default export ─────────
	process.env.EXXETA_PERSISTENT_ROOM_AGENT = roomId;
	const piCli = makeFakePi();
	await (mcpExtModule.default as (pi: unknown) => Promise<unknown>)(piCli);
	const cliDescription = String(piCli.tools.get("mcp")?.description ?? "");
	assert(cliDescription.includes("alpha") && !cliDescription.includes("beta"), "a CLI room process must scope itself from EXXETA_PERSISTENT_ROOM_AGENT");
	delete process.env.EXXETA_PERSISTENT_ROOM_AGENT;

	// ── An unscoped session stays untouched ──────────────────────────────────
	const piGlobal = makeFakePi();
	await (mcpExtModule.default as (pi: unknown) => Promise<unknown>)(piGlobal);
	const globalDescription = String(piGlobal.tools.get("mcp")?.description ?? "");
	assert(globalDescription.includes("alpha") && globalDescription.includes("beta"), "an unscoped session must keep the full connector surface");

	// ── Door wiring: the session assemblers really use the wrapper ───────────
	const indexSource = fs.readFileSync(path.join(webServerSrc, "index.ts"), "utf-8");
	assert(indexSource.includes("createRoomScopedMcpExtension(persistentAgentId"), "the live web session must build its mcp extension through the room-scope wrapper");
	assert(indexSource.includes("mcpGrantsFingerprintAtBind ?? persistentRoomMcpGrantsFingerprint"), "the live web session must record the bound grants fingerprint from the description's own read");
	const backgroundSource = fs.readFileSync(path.join(webServerSrc, "persistent-room-background-execution.ts"), "utf-8");
	assert(backgroundSource.includes("createRoomScopedMcpExtension(input.roomId)"), "scheduled/background execution must build its mcp extension through the room-scope wrapper");
	const specialistSource = fs.readFileSync(path.join(webServerSrc, "persistent-room-specialist-execution.ts"), "utf-8");
	assert(!specialistSource.includes("extensions/mcp"), "specialists must not load the mcp extension at all");
	const workerSource = fs.readFileSync(path.join(webServerSrc, "persistent-agent-worker-runtime.ts"), "utf-8");
	assert(workerSource.includes('noTools: "all"') && workerSource.includes("extensionFactories: []"), "the isolated worker (consults, maintain flows) must run with no extensions and no tools");

	// ── The nested-prefix world: foo vs foo-bar ──────────────────────────────
	// "foo_bar_baz" is ambiguous by NAME (foo's "bar_baz" or foo-bar's "baz");
	// attribution must come from the registration's real spec server, and the
	// proxy's describe must not let foo's first-match namesake destroy or leak
	// past foo-bar's granted tool.
	await new Promise<void>((resolve) => fooRecorder.server.listen(0, "127.0.0.1", resolve));
	await new Promise<void>((resolve) => fooBarRecorder.server.listen(0, "127.0.0.1", resolve));
	const fooServers = {
		foo: { url: fooRecorder.url() },
		"foo-bar": { url: fooBarRecorder.url() },
	};
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: fooServers }, null, 2));
	const fooCache = {
		version: 1,
		servers: {
			foo: { configHash: cacheMod.computeServerHash(fooServers.foo), cachedAt: Date.now(), resources: [], tools: [{ name: "bar_baz", description: "foo's own bar_baz" }, { name: "only_tool", description: "only foo has this" }] },
			"foo-bar": { configHash: cacheMod.computeServerHash(fooServers["foo-bar"]), cachedAt: Date.now(), resources: [], tools: [{ name: "baz", description: "foo-bar's baz" }, { name: "ping", description: "foo-bar's ping" }] },
		},
	};
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(fooCache, null, 2));
	const fooRoomId = "mcp-scope-smoke-foo-room";
	writePersistentRoomMcpSettings(fooRoomId, ["foo-bar"]);
	process.env.MCP_DIRECT_TOOLS = "foo";

	// Grant bypass repro: room granted foo-bar only; direct tool foo_bar_baz
	// REALLY belongs to foo (spec server), whatever its name prefix suggests.
	const piBypass = makeFakePi();
	await createRoomScopedMcpExtension(fooRoomId)(piBypass);
	await startSession(piBypass);
	assert(!piBypass.tools.has("foo_bar_baz"), "a direct tool whose real spec server is ungranted must not be registered, whatever its name prefix suggests");
	assert(!piBypass.tools.has("foo_only_tool"), "no ungranted direct tool may be registered");

	// Describe namesake: the adapter's first match for foo_bar_baz is foo
	// (config order); the wrapper must answer with the GRANTED owner instead.
	const namesake = await callMcp(piBypass, { describe: "foo_bar_baz" });
	assert(namesake.details.server === "foo-bar", `describe must resolve to the granted owner, got ${JSON.stringify(namesake.details)}`);
	assert(namesake.text.includes("Server: foo-bar"), `describe text must name the granted owner, got: ${namesake.text}`);
	assert(namesake.text.includes("foo-bar's baz"), "describe must carry the granted tool's description");

	// Describe leak: a tool only an ungranted connector owns answers a NEUTRAL
	// refusal that does not name the resolved server.
	const neutral = await callMcp(piBypass, { describe: "foo_only_tool" });
	assert(neutral.details.error === "connector_not_enabled", "describe of an ungranted-only tool must refuse");
	assert(neutral.details.server === undefined, "the neutral refusal must not carry the resolved server in details");
	assert(neutral.text.includes("is not available in this room"), `the neutral refusal must not name the resolved server, got: ${neutral.text}`);

	// Native-tool redirect hint survives room scoping.
	piBypass.tools.set("web_search", { name: "web_search" });
	const native = await callMcp(piBypass, { tool: "web_search" });
	assert(native.details.error === "native_tool", `a native tool call through mcp should answer the redirect hint, got ${JSON.stringify(native.details)}`);

	// Unqualified-call fallback: tamper the disk cache so foo-bar's entry is
	// INVALID and foo (ungranted) is the only cached owner of foo_bar_baz. The
	// wrapper must still TRY the granted prefix candidate instead of refusing
	// on cache attribution alone - the call reaches foo-bar, never foo.
	const fooBarHitsBefore = fooBarRecorder.hits();
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify({
		...fooCache,
		servers: { ...fooCache.servers, "foo-bar": { ...fooCache.servers["foo-bar"], configHash: "0".repeat(16) } },
	}, null, 2));
	const fallback = await callMcp(piBypass, { tool: "foo_bar_baz", args: JSON.stringify({}) });
	assert(fooBarRecorder.hits() > fooBarHitsBefore, "the granted prefix candidate must really be tried");
	assert(!JSON.stringify(fallback.details).includes('"foo"'), `the fallback outcome must not involve the ungranted server, got ${JSON.stringify(fallback.details)}`);
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(fooCache, null, 2));
	assert(fooRecorder.hits() === 0, "nothing in the granted-foo-bar session may ever reach foo");
	await shutdownSession(piBypass);

	// The same direct tool in a room granted foo: registered, live-gated, and
	// its execution really targets foo.
	const fooOwnerRoomId = "mcp-scope-smoke-foo-owner-room";
	writePersistentRoomMcpSettings(fooOwnerRoomId, ["foo"]);
	const piOwner = makeFakePi();
	await createRoomScopedMcpExtension(fooOwnerRoomId)(piOwner);
	await startSession(piOwner);
	assert(piOwner.tools.has("foo_bar_baz") && piOwner.tools.has("foo_only_tool"), "granted direct tools must register");
	writePersistentRoomMcpSettings(fooOwnerRoomId, []);
	const revokedDirect = await piOwner.tools.get("foo_bar_baz").execute("smoke-direct", {}, undefined, undefined, fakeCtx);
	assert(revokedDirect?.details?.error === "connector_not_enabled", "a revoked direct tool must refuse on the very next call");
	assert(fooRecorder.hits() === 0, "a revoked direct tool must not touch its server");
	writePersistentRoomMcpSettings(fooOwnerRoomId, ["foo"]);
	await piOwner.tools.get("foo_bar_baz").execute("smoke-direct", {}, undefined, undefined, fakeCtx);
	assert(fooRecorder.hits() > 0, "a granted direct tool call must reach its real server");
	await shutdownSession(piOwner);

	// toolPrefix "none": direct tools keep working for granted connectors (the
	// name carries no prefix, so only spec attribution can place them).
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: fooServers, settings: { toolPrefix: "none" } }, null, 2));
	const noneCache = {
		version: 1,
		servers: {
			foo: { configHash: cacheMod.computeServerHash(fooServers.foo), cachedAt: Date.now(), resources: [], tools: [{ name: "bare_tool", description: "foo's bare tool" }] },
		},
	};
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(noneCache, null, 2));
	const piNone = makeFakePi();
	await createRoomScopedMcpExtension(fooOwnerRoomId)(piNone);
	assert(piNone.tools.has("bare_tool"), "under toolPrefix none a granted connector's direct tool must still register");
	const piNoneUngranted = makeFakePi();
	await createRoomScopedMcpExtension(fooRoomId)(piNoneUngranted);
	assert(!piNoneUngranted.tools.has("bare_tool"), "under toolPrefix none an ungranted connector's direct tool must not register");
	delete process.env.MCP_DIRECT_TOOLS;

	// Restore the alpha/beta world for anything below.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));

	// ── Specialists: the template floor cannot even grant the mcp tool ───────
	const { assertSpecialistTemplateTools } = await import("../src/specialist-templates.js");
	let specialistRefused = false;
	try {
		assertSpecialistTemplateTools({ id: "smoke-template", toolNames: ["mcp"] } as any);
	} catch (error) {
		specialistRefused = /forbidden/.test((error as Error).message);
	}
	assert(specialistRefused, "a specialist template granting the mcp tool must be rejected as forbidden");

	fs.rmSync(tempHome, { recursive: true, force: true });
	fs.rmSync(tempAgentsRoot, { recursive: true, force: true });
	console.log("persistent-room-mcp-scope-smoke: OK");
} catch (error) {
	console.error(error instanceof Error ? error.stack || error.message : error);
	console.error(`temp home preserved for inspection: ${tempHome}`);
	process.exitCode = 1;
} finally {
	alphaRecorder.server.close();
	betaRecorder.server.close();
	fooRecorder.server.close();
	fooBarRecorder.server.close();
}
