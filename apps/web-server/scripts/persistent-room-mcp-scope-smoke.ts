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
//          their extension via createRoomScopedMcpExtension, the only door,
//          specialists cannot even be granted the mcp tool, and the isolated
//          worker (consults, maintain flows) runs with no extensions and no
//          tools at all;
//  ASK   - a tool runs by itself only when the connection that will run it
//          marks it read-only, or it is a resource read; anything else stops
//          on the card, on every call path, counted at a real connector;
//  ROOM  - Allow for this room: offered and kept only for a web connector's
//          tool the live connection lists and doesn't mark destructive, only
//          from the computer, pinned to the address, dropped by every change
//          that takes it back, and never on a shared server.
//
// Offline, isolated HOME + agent dir + agents root - set BEFORE any import
// that reads them.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";
import { markedConnector } from "./smoke-marked-connector.js";

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

// A connector that needs a sign-in: /mcp answers 401, and the OAuth discovery
// and client registration the adapter does next are answered here. No sign-in
// ever completes: there is no /authorize or /token.
function signInConnector(): { server: http.Server; hits: () => number; url: () => string } {
	let count = 0;
	const origin = () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => res.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
	const server = http.createServer((req, res) => {
		count += 1;
		const url = new URL(req.url ?? "/", origin());
		let raw = "";
		req.on("data", (chunk) => { raw += chunk; });
		req.on("end", () => {
			if (url.pathname === "/mcp") return json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${origin()}/.well-known/oauth-protected-resource/mcp"` });
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return json(res, 200, { resource: `${origin()}/mcp`, authorization_servers: [origin()], bearer_methods_supported: ["header"] });
			if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
				return json(res, 200, { issuer: origin(), authorization_endpoint: `${origin()}/authorize`, token_endpoint: `${origin()}/token`, registration_endpoint: `${origin()}/register`, response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"], code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
			}
			if (req.method === "POST" && url.pathname === "/register") {
				let asked: { redirect_uris?: string[] } = {};
				try { asked = JSON.parse(raw); } catch {}
				return json(res, 201, { client_id: "smoke-connector-client", client_id_issued_at: Math.floor(Date.now() / 1000), redirect_uris: asked.redirect_uris ?? [], token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] });
			}
			json(res, 404, { error: "not_found" });
		});
	});
	return { server, hits: () => count, url: () => `${origin()}/mcp` };
}
const signInRecorder = signInConnector();

const askConnector = markedConnector();

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

async function callMcp(pi: FakePi, params: Record<string, unknown>): Promise<{ text: string; details: any; isError: boolean }> {
	const tool = pi.tools.get("mcp");
	assert(tool, "the mcp proxy tool must be registered");
	const result = await tool.execute("smoke-call", params, undefined, undefined, fakeCtx);
	return { text: String(result?.content?.[0]?.text ?? ""), details: result?.details ?? {}, isError: result?.isError === true };
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

	const { readPersistentRoomMcpSettings, writePersistentRoomMcpSettings } = await import("../src/persistent-room-mcp-settings.js");
	writePersistentRoomMcpSettings(roomId, ["alpha"]);

	// A legacy room on the DEFAULT agents root: the extension's room-scoped
	// registration must run the update-day migration itself, so a room is
	// never stuck at zero grants waiting for the web server's first boot.
	fs.mkdirSync(path.join(tempAgentsRoot, "cli-legacy-room"), { recursive: true });
	fs.writeFileSync(path.join(tempAgentsRoot, "cli-legacy-room", "agent.json"), "{}");

	const { createRoomScopedMcpExtension } = await import("../../../pi-package/extensions/mcp/index.js");

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
	assert(describe.isError, "a refused describe carries the error flag");
	// The adapter's own refusals (a tool nobody has) carry the error flag too, so the card and the model read a failure.
	const unknown = await callMcp(pi, { describe: "create_issue" });
	assert(unknown.details.error === "tool_not_found" && unknown.isError, `describing a tool nobody has is a failure, got ${JSON.stringify({ error: unknown.details.error, isError: unknown.isError })}`);
	const ok = await callMcp(pi, { server: "alpha" });
	assert(!ok.isError, "a list that worked carries no error flag");

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
	// included (the bootstrap is restricted to grants; eager/keep-alive keep
	// their global behavior).
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
	// A process started with --mcp-config reads connectors from the override
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

	// ── Door wiring: the session assemblers really use the wrapper ───────────
	const indexSource = fs.readFileSync(path.join(webServerSrc, "room-socket.ts"), "utf-8");
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
	assert(fooRecorder.hits() > 0, "a granted direct tool's connection must reach its real server");
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

	// ── A connector that needs a sign-in ─────────────────────────────────────
	// The adapter reports it as a failed connection (it meets the refusal while
	// setting the connection up); the room reads it as the sign-in it is: on a
	// connect, on a call right after it, and on a first call with the tools
	// cached from an earlier sign-in.
	await new Promise<void>((resolve) => signInRecorder.server.listen(0, "127.0.0.1", resolve));
	const signInServers = { ...servers, exxdocs: { url: signInRecorder.url() } };
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: signInServers }, null, 2));
	const signInRoomId = "mcp-scope-smoke-sign-in-room";
	writePersistentRoomMcpSettings(signInRoomId, ["exxdocs"]);
	const signInOutcome = (result: { text: string; details: any; isError: boolean }) => JSON.stringify({ error: result.details.error, server: result.details.server, isError: result.isError, text: result.text.slice(0, 120) });
	const piSignIn = makeFakePi();
	await createRoomScopedMcpExtension(signInRoomId)(piSignIn);
	await startSession(piSignIn);
	const signInConnect = await callMcp(piSignIn, { connect: "exxdocs" });
	assert(signInRecorder.hits() > 0, "the connect must really reach the connector");
	assert(signInConnect.details.error === "auth_required" && signInConnect.details.server === "exxdocs" && signInConnect.isError, `a connect to a connector that needs a sign-in reads as the sign-in, got ${signInOutcome(signInConnect)}`);
	const signInCallAfter = await callMcp(piSignIn, { tool: "exxdocs_search", server: "exxdocs", args: JSON.stringify({ query: "export" }) });
	assert(signInCallAfter.details.error === "auth_required" && signInCallAfter.isError, `a call right after it reads as the sign-in too, got ${signInOutcome(signInCallAfter)}`);
	await shutdownSession(piSignIn);
	const signInCache = { version: 1, servers: { exxdocs: { configHash: cacheMod.computeServerHash(signInServers.exxdocs), cachedAt: Date.now(), resources: [], tools: [{ name: "search", description: "exxdocs' search" }] } } };
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(signInCache, null, 2));
	const piSignInCached = makeFakePi();
	await createRoomScopedMcpExtension(signInRoomId)(piSignInCached);
	await startSession(piSignInCached);
	const signInFirstCall = await callMcp(piSignInCached, { tool: "exxdocs_search", server: "exxdocs", args: JSON.stringify({ query: "export" }) });
	assert(signInFirstCall.details.error === "auth_required" && signInFirstCall.isError, `a first call with the tools cached reads as the sign-in, got ${signInOutcome(signInFirstCall)}`);
	await shutdownSession(piSignInCached);
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));

	// ── A tool not marked read-only asks first ───────────────────────────────
	await new Promise<void>((resolve) => askConnector.server.listen(0, "127.0.0.1", resolve));
	await askConnector.proxyHere();
	const readOnly = { readOnlyHint: true };
	askConnector.tools = [
		{ name: "list_projects", annotations: readOnly },
		{ name: "delete_project" },
		{ name: "archive-project", annotations: { readOnlyHint: false } },
		{ name: "wipe_cache", annotations: { readOnlyHint: true, destructiveHint: true } },
		{ name: "stale_mark", annotations: { readOnlyHint: true, destructiveHint: false } },
		{ name: "create_note" },
		{ name: "drop_board", annotations: { destructiveHint: true } },
	];
	const askServers = { asana: { url: askConnector.webUrl() } };
	const askConfig = { mcpServers: askServers };
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	const askCacheEntry = (tools: Array<Record<string, unknown>>) => ({ version: 1, servers: { asana: { configHash: cacheMod.computeServerHash(askServers.asana), cachedAt: Date.now(), resources: [{ uri: "smoke://notes", name: "notes" }], tools } } });
	const savedAskTools = askConnector.tools.map(({ name }) => ({ name, description: name }));
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));
	const askRoomId = "mcp-scope-smoke-ask-room";
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);

	// A person at the room's real bridge (web-ui-context.ts): each question is held until the row answers it.
	// true is Allow this time and false Not now, as the page sends them; the clock moves on between frames, so
	// no answer meets the floor unless a row holds it still. `closed`: the closing frames, with the yes in the
	// room's file as it stood when each was sent.
	const { createWebUiContext } = await import("../src/web-ui-context.js");
	type Answer = boolean | "once" | "room" | "decline";
	type Asked = { title: string; card: any; answer: (value: Answer, answeredBy?: "computer" | "phone") => void; refuse: (message: string) => void };
	const valueOf = (value: Answer) => (value === true ? "once" : value === false ? "decline" : value);
	function person(from: "computer" | "phone" = "computer", clock: { now?: () => number } = {}): { ctx: unknown; asked: Asked[]; closed: Array<{ frame: any; allowedThen: unknown }>; again: () => number; ui: any } {
		const asked: Asked[] = [];
		const closed: Array<{ frame: any; allowedThen: unknown }> = [];
		let again = 0;
		let at = 0;
		const ui = createWebUiContext((frame: any) => {
			if (frame.type === "ui_request" && frame.kind === "connector" && frame.again) again += 1;
			else if (frame.type === "ui_request" && frame.kind === "connector") asked.push({ title: frame.title, card: frame, answer: (value, answeredBy = from) => ui.resolveResponse(frame.id, valueOf(value), answeredBy), refuse: (words) => ui.declineOpenQuestions(words) });
			if (frame.type === "ui_request_closed") closed.push({ frame, allowedThen: readPersistentRoomMcpSettings(askRoomId).allowedTools.asana ?? [] });
		}, undefined, from, { now: clock.now ?? (() => (at += 60_000)) });
		return { ctx: { ...fakeCtx, ui }, asked, closed, again: () => again, ui };
	}
	// For a row that expects no card: one that comes anyway is answered Not now at once, so the row fails on its count.
	function nobodyAsked(): { ctx: unknown; asked: Asked[] } {
		const asked: Asked[] = [];
		const ui = createWebUiContext((frame: any) => {
			if (frame.type !== "ui_request" || frame.kind !== "connector") return;
			asked.push({ title: frame.title, card: frame, answer: () => {}, refuse: () => {} });
			ui.resolveResponse(frame.id, "decline", "computer");
		});
		return { ctx: { ...fakeCtx, ui }, asked };
	}
	const askedYet = async (asked: Asked[], count: number, label: string) => {
		const deadline = Date.now() + 15_000;
		while (asked.length < count) {
			if (Date.now() > deadline) throw new Error(`${label}: no card came`);
			await new Promise((resolve) => setImmediate(resolve));
		}
	};
	const call = (pi: FakePi, ctx: unknown, params: Record<string, unknown>) => pi.tools.get("mcp").execute("smoke-ask", params, undefined, undefined, ctx);
	const textOf = (result: any) => String(result?.content?.[0]?.text ?? "");
	const callsOf = (name: string) => askConnector.called.filter((called) => called === name).length;

	const piAsk = makeFakePi();
	await createRoomScopedMcpExtension(askRoomId)(piAsk);
	await startSession(piAsk);

	// Marked runs with no card; unmarked stops on one, and only a yes reaches the connector, once.
	const marked = nobodyAsked();
	const ranMarked = await call(piAsk, marked.ctx, { tool: "asana_list_projects", args: "{}" });
	assert(textOf(ranMarked) === "ran list_projects" && marked.asked.length === 0 && callsOf("list_projects") === 1, `a marked tool runs with no card, got ${textOf(ranMarked)}, ${marked.asked.length} cards`);
	const unmarked = person();
	const yes = call(piAsk, unmarked.ctx, { tool: "asana_delete_project", args: JSON.stringify({ project: "Q3" }) });
	await askedYet(unmarked.asked, 1, "unmarked");
	assert(unmarked.asked[0].title === "Use Delete project in Asana?", `the card's title, got ${unmarked.asked[0].title}`);
	assert(callsOf("delete_project") === 0, "a call waiting on its card has not reached the connector");
	unmarked.asked[0].answer(true);
	assert(textOf(await yes) === "ran delete_project" && callsOf("delete_project") === 1, "a yes reaches the connector once");

	const decline = person();
	const no = call(piAsk, decline.ctx, { tool: "asana_delete_project", args: "{}" });
	await askedYet(decline.asked, 1, "decline");
	decline.asked[0].answer(false);
	const declined = await no;
	assert(declined.isError === true && declined.details.error === "connector_call_declined" && textOf(declined).startsWith("You declined this, so nothing changed in Asana."), `a decline says so, got ${JSON.stringify(declined)}`);
	// The page names the step by what its card asked; the model's text never carries it.
	assert(declined.details.use === "Delete project in Asana" && !textOf(declined).includes("Delete project"), `a decline keeps what its card asked to use, for the page only, got ${JSON.stringify(declined)}`);
	assert(callsOf("delete_project") === 1, "a decline reaches nothing");

	// A rejected card (Stop, leaving, a scheduled run) is refused with its own words first, and reaches nothing.
	const stopped = person();
	const stopping = call(piAsk, stopped.ctx, { tool: "asana_delete_project", args: "{}" });
	await askedYet(stopped.asked, 1, "stop");
	stopped.asked[0].refuse("The person pressed Stop before answering, so this was not done.");
	const refusedByStop = await stopping;
	assert(refusedByStop.isError === true && refusedByStop.details.error === "connector_call_unanswered" && textOf(refusedByStop).startsWith("The person pressed Stop before answering, so this was not done."), `a rejected card is refused, got ${JSON.stringify(refusedByStop)}`);
	assert(refusedByStop.details.use === "Delete project in Asana" && !textOf(refusedByStop).includes("Delete project"), `a rejected card keeps what it asked to use, for the page only, got ${JSON.stringify(refusedByStop)}`);
	assert(callsOf("delete_project") === 1, "a rejected card reaches nothing");

	// No way to ask at all refuses too.
	const noUi = await call(piAsk, fakeCtx, { tool: "asana_delete_project", args: "{}" });
	assert(noUi.details.error === "connector_call_unanswered" && callsOf("delete_project") === 1, `with no way to ask the call is refused, got ${JSON.stringify(noUi.details)}`);

	// Every call path passes the gate, each beside its marked neighbour: with a
	// server, by saved owner, by prefix, with a dash spelling.
	for (const [label, unmarkedParams, markedParams] of [
		["with a server", { tool: "asana_delete_project", server: "asana" }, { tool: "asana_list_projects", server: "asana" }],
		["by saved owner", { tool: "asana_delete_project" }, { tool: "asana_list_projects" }],
		["with a dash spelling", { tool: "asana-delete-project" }, { tool: "asana-list-projects" }],
	] as const) {
		const before = person();
		const asking = call(piAsk, before.ctx, unmarkedParams);
		await askedYet(before.asked, 1, label);
		before.asked[0].answer(false);
		const stoppedAt = await asking;
		assert(stoppedAt.details.error === "connector_call_declined" && stoppedAt.details.use === "Delete project in Asana", `${label}: the unmarked tool stops at the gate, named as its card names it, got ${JSON.stringify(stoppedAt.details)}`);
		const free = nobodyAsked();
		assert(textOf(await call(piAsk, free.ctx, markedParams)) === "ran list_projects" && free.asked.length === 0, `${label}: the marked tool passes with no card`);
	}
	// By prefix: with no saved list to name an owner, the granted prefix finds it.
	fs.rmSync(path.join(agentDir, "mcp-cache.json"), { force: true });
	const byPrefix = person();
	const prefixed = call(piAsk, byPrefix.ctx, { tool: "asana_delete_project" });
	await askedYet(byPrefix.asked, 1, "by prefix");
	byPrefix.asked[0].answer(false);
	assert((await prefixed).details.error === "connector_call_declined", "by prefix: the unmarked tool stops at the gate");
	assert(callsOf("delete_project") === 1, "no path reached the connector past a decline");
	const prefixFree = nobodyAsked();
	assert(textOf(await call(piAsk, prefixFree.ctx, { tool: "asana_list_projects" })) === "ran list_projects" && prefixFree.asked.length === 0, "by prefix: the marked tool passes with no card, with no saved list at all");
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));

	// What marks count. A saved mark is never read: the saved list here says
	// read-only for every tool, and the live connection decides.
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(askConnector.tools.map(({ name }) => ({ name, description: name, annotations: readOnly }))), null, 2));
	for (const [label, tool] of [
		["no mark on the live connection", "asana_delete_project"],
		["marked false", "asana_archive_project"],
		["read-only plus destructive", "asana_wipe_cache"],
	] as const) {
		const before = person();
		const asking = call(piAsk, before.ctx, { tool });
		await askedYet(before.asked, 1, label);
		before.asked[0].answer(false);
		assert((await asking).details.error === "connector_call_declined", `${label} gives a card`);
	}
	const destructiveFalse = nobodyAsked();
	assert(textOf(await call(piAsk, destructiveFalse.ctx, { tool: "asana_stale_mark" })) === "ran stale_mark" && destructiveFalse.asked.length === 0, "read-only and marked not destructive runs with no card");
	const resource = nobodyAsked();
	const readingResource = await call(piAsk, resource.ctx, { tool: "asana_get_notes" });
	assert(textOf(readingResource) === "the notes" && resource.asked.length === 0 && askConnector.resourceReads() === 1, `a resource read gives no card, got ${textOf(readingResource)}`);
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));

	// A concurrent Test connection and a second room's session both see the
	// connector mark delete_project read-only, and save that. This session's
	// connection, the one that will run the tool, never said so.
	const { testMcpServer } = await import("../src/mcp-admin.js");
	const unmarkedList = askConnector.tools;
	askConnector.tools = unmarkedList.map((tool) => (tool.name === "delete_project" ? { ...tool, annotations: readOnly } : tool));
	assert((await testMcpServer("asana")).ok, "the Test connection really connects");
	const piSecondRoom = makeFakePi();
	await createRoomScopedMcpExtension(askRoomId)(piSecondRoom);
	await startSession(piSecondRoom);
	const secondRoom = nobodyAsked();
	assert(textOf(await call(piSecondRoom, secondRoom.ctx, { tool: "asana_delete_project" })) === "ran delete_project" && secondRoom.asked.length === 0, "the second session judges by its own connection");
	await shutdownSession(piSecondRoom);
	askConnector.called.length = 0;
	const judged = person();
	const stillAsks = call(piAsk, judged.ctx, { tool: "asana_delete_project" });
	await askedYet(judged.asked, 1, "a refresh elsewhere");
	judged.asked[0].answer(false);
	assert((await stillAsks).details.error === "connector_call_declined" && callsOf("delete_project") === 0, "a Test connection or a second room's refresh can't change the marks a call is judged by");
	askConnector.tools = unmarkedList;
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));

	// A permission withdrawn while the card waits refuses the call after a yes:
	// the room's grant, and the tool switched off on the connector.
	const withdrawn = person();
	const waitingOnGrant = call(piAsk, withdrawn.ctx, { tool: "asana_delete_project" });
	await askedYet(withdrawn.asked, 1, "withdrawn grant");
	writePersistentRoomMcpSettings(askRoomId, []);
	withdrawn.asked[0].answer(true);
	assert((await waitingOnGrant).details.error === "connector_not_enabled" && callsOf("delete_project") === 0, "a grant withdrawn while the card waits refuses after a yes");
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);
	const excluded = person();
	const waitingOnTool = call(piAsk, excluded.ctx, { tool: "asana_delete_project" });
	await askedYet(excluded.asked, 1, "withdrawn tool");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { ...askServers.asana, excludeTools: ["delete_project"] } } }, null, 2));
	excluded.asked[0].answer(true);
	assert((await waitingOnTool).details.error === "connector_tool_withdrawn" && callsOf("delete_project") === 0, "a tool switched off while the card waits refuses after a yes");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	const notWithdrawn = person();
	const allowedAfter = call(piAsk, notWithdrawn.ctx, { tool: "asana_delete_project" });
	await askedYet(notWithdrawn.asked, 1, "not withdrawn");
	notWithdrawn.asked[0].answer(true);
	assert(textOf(await allowedAfter) === "ran delete_project" && callsOf("delete_project") === 1, "with nothing withdrawn the yes runs");

	// Two calls at once, answered in the other order and differently: each
	// answer reaches its own tool.
	askConnector.called.length = 0;
	const both = person();
	const first = call(piAsk, both.ctx, { tool: "asana_delete_project", args: JSON.stringify({ project: "Q3" }) });
	await askedYet(both.asked, 1, "first of two");
	const second = call(piAsk, both.ctx, { tool: "asana_create_note", args: JSON.stringify({ text: "hello" }) });
	await askedYet(both.asked, 2, "second of two");
	assert(both.asked[0].title === "Use Delete project in Asana?" && both.asked[1].title === "Use Create note in Asana?", "each call asks by its own name");
	both.asked[1].answer(true);
	both.asked[0].answer(false);
	const [firstDone, secondDone] = await Promise.all([first, second]);
	assert(firstDone.details.error === "connector_call_declined" && textOf(secondDone) === "ran create_note", `each answer reaches its own tool, got ${textOf(firstDone)} and ${textOf(secondDone)}`);
	assert(JSON.stringify(askConnector.called) === JSON.stringify(["create_note"]), `only the allowed tool reached the connector, got ${JSON.stringify(askConnector.called)}`);

	// The card shows what's sent: the connector by its name, hidden characters
	// written out, and how much was cut from the end.
	const carded = person();
	const hidden = call(piAsk, carded.ctx, { tool: "asana_delete_project", args: JSON.stringify({ project: "Q3\u200b\u202e\u0085\u{e0041}", note: "a\nb" }) });
	await askedYet(carded.asked, 1, "hidden characters");
	carded.asked[0].answer(false);
	await hidden;
	const shownCard = carded.asked[0].card;
	assert(shownCard.connector === "Asana" && shownCard.sent === String.raw`{"project":"Q3[U+200B][U+202E][U+0085][U+E0041]","note":"a\nb"}` && shownCard.cut === 0, `the card's fields, got ${JSON.stringify(shownCard)}`);
	const longCard = person();
	const long = call(piAsk, longCard.ctx, { tool: "asana_delete_project", args: JSON.stringify({ text: "x".repeat(5000) }) });
	await askedYet(longCard.asked, 1, "cut");
	longCard.asked[0].answer(false);
	await long;
	assert(longCard.asked[0].card.sent.length === 1200 && longCard.asked[0].card.cut === 3811, `a long call is cut, and says by how much, got ${longCard.asked[0].card.sent.length} / ${longCard.asked[0].card.cut}`);
	const shortCard = person();
	const short = call(piAsk, shortCard.ctx, { tool: "asana_delete_project" });
	await askedYet(shortCard.asked, 1, "nothing sent");
	shortCard.asked[0].answer(false);
	await short;
	assert(shortCard.asked[0].card.sent === "{}" && shortCard.asked[0].card.cut === 0, `a call that sends nothing shows {} and no cut, got ${JSON.stringify(shortCard.asked[0].card)}`);
	await shutdownSession(piAsk);

	// Through the direct wrapper, each beside its marked neighbour. The saved
	// list also holds an old entry the live connection no longer lists.
	process.env.MCP_DIRECT_TOOLS = "asana";
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry([...savedAskTools, { name: "old_tool", description: "gone since", annotations: readOnly }]), null, 2));
	const piDirect = makeFakePi();
	await createRoomScopedMcpExtension(askRoomId)(piDirect);
	await startSession(piDirect);
	askConnector.called.length = 0;
	const direct = (ctx: unknown, name: string) => piDirect.tools.get(name).execute("smoke-direct-ask", {}, undefined, undefined, ctx);
	const directMarked = nobodyAsked();
	assert(textOf(await direct(directMarked.ctx, "asana_list_projects")) === "ran list_projects" && directMarked.asked.length === 0, "direct: the marked tool runs with no card");
	const directUnmarked = person();
	const directAsking = direct(directUnmarked.ctx, "asana_delete_project");
	await askedYet(directUnmarked.asked, 1, "direct");
	directUnmarked.asked[0].answer(false);
	assert((await directAsking).details.error === "connector_call_declined" && callsOf("delete_project") === 0, "direct: the unmarked tool stops at the gate");
	const directYes = person();
	const directAllowed = direct(directYes.ctx, "asana_delete_project");
	await askedYet(directYes.asked, 1, "direct yes");
	directYes.asked[0].answer(true);
	assert(textOf(await directAllowed) === "ran delete_project" && callsOf("delete_project") === 1, "direct: a yes reaches the connector once");
	const oldEntry = person();
	const oldAsking = direct(oldEntry.ctx, "asana_old_tool");
	await askedYet(oldEntry.asked, 1, "an old entry");
	oldEntry.asked[0].answer(false);
	assert((await oldAsking).details.error === "connector_call_declined" && callsOf("old_tool") === 0, "an old entry the live connection doesn't list gives a card, whatever it was saved with");
	await shutdownSession(piDirect);
	delete process.env.MCP_DIRECT_TOOLS;
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));

	// A connection with no list, and the text "true". The library refuses a list
	// holding text in a mark, so the next row has the connector say it for real;
	// here a stand-in for the adapter hands the gate what it never would.
	const { connectorPlacesReader, roomScopedMcpToolRegistration } = await import("../../../pi-package/extensions/mcp/room-scope.js");
	for (const [label, liveTool, asks] of [
		["no entry on the connection", undefined, true],
		["an entry with no marks", {}, true],
		["null marks", { annotations: null }, true],
		["the text true", { annotations: { readOnlyHint: "true" } }, true],
		["the text false for destructive", { annotations: { readOnlyHint: true, destructiveHint: "false" } }, true],
		["read-only", { annotations: { readOnlyHint: true } }, false],
	] as const) {
		const standIn = await roomScopedMcpToolRegistration(askRoomId, {
			name: "mcp",
			asksBeforeConnectorCalls: true,
			execute: async (_id, _params, _signal, _onUpdate, gate: any) => (await gate({ server: "asana", toolName: "delete_project", liveTool, resourceRead: false, args: {} })) ?? { content: [{ type: "text", text: "ran" }] },
		});
		const before = asks ? person() : nobodyAsked();
		const asking = standIn!.execute("smoke-marks", { tool: "delete_project", server: "asana" }, undefined, undefined, before.ctx);
		if (asks) {
			await askedYet(before.asked, 1, label);
			before.asked[0].answer(false);
			assert((await asking).details?.error === "connector_call_declined", `${label} gives a card`);
		} else {
			assert((await asking).content[0].text === "ran" && before.asked.length === 0, `${label} gives none`);
		}
	}
	const textMarkTools = askConnector.tools;
	askConnector.tools = [{ name: "text_mark", annotations: { readOnlyHint: "true" } }];
	const piTextMark = makeFakePi();
	await createRoomScopedMcpExtension(askRoomId)(piTextMark);
	await startSession(piTextMark);
	askConnector.called.length = 0;
	const textMark = nobodyAsked();
	const textMarkAnswer = await call(piTextMark, textMark.ctx, { tool: "asana_delete_project", server: "asana" });
	assert(textMarkAnswer.isError === true && askConnector.called.length === 0, `a connector saying the text "true" runs nothing, got ${JSON.stringify(textMarkAnswer)}`);
	await shutdownSession(piTextMark);
	askConnector.tools = textMarkTools;

	// ── Allow for this room ──────────────────────────────────────────────────
	const settingsStore = await import("../src/persistent-room-mcp-settings.js");
	const { changeMcpServerAddress } = await import("../src/mcp-admin.js");
	const { declinedQuestionNoteText } = await import("../src/thread-items-by-id.js");
	const allowedIn = (roomId: string) => (readPersistentRoomMcpSettings(roomId).allowedTools.asana ?? []).map((entry: { tool: string }) => entry.tool);
	// The gate as the adapter calls it, with the live tool a row needs (listed with no marks, unless the row says), in a session connected from the settings as they are now; the call goes through the room's proxy as any other.
	const readConnectorPlaces = await connectorPlacesReader();
	const gateCall = async (roomId: string, ctx: unknown, server: string, toolName: string, live: { liveTool: unknown } = { liveTool: {} }): Promise<any> => {
		const { liveTool } = live;
		const connectedPlaces = readConnectorPlaces(undefined);
		const standIn = await roomScopedMcpToolRegistration(roomId, { name: "mcp", asksBeforeConnectorCalls: true, execute: async (_id, _params, _signal, _onUpdate, gate: any) => (await gate({ server, toolName, liveTool, resourceRead: false, args: {} })) ?? { content: [{ type: "text", text: "ran" }] } }, { connectedPlaces: () => connectedPlaces });
		return standIn!.execute("smoke-room-yes", { tool: toolName, server }, undefined, undefined, ctx);
	};
	const piAllow = makeFakePi();
	await createRoomScopedMcpExtension(askRoomId)(piAllow);
	await startSession(piAllow);
	askConnector.called.length = 0;
	/** Asks for delete_project at the computer and answers Allow for this room once the floor has passed: the yes it stores. */
	const allowForRoom = async (roomId = askRoomId, pi = piAllow) => {
		const at = person();
		const asking = call(pi, at.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(at.asked, 1, "allow for this room");
		at.asked[0].answer("room");
		assert(textOf(await asking) === "ran delete_project", "Allow for this room runs the call it answered");
		return at;
	};

	// At the computer a web connector's unmarked tool offers Allow for this room; one it marks destructive doesn't, and a room sent anyway counts this time.
	const offered = person();
	const offeredCall = call(piAllow, offered.ctx, { tool: "asana_delete_project", server: "asana" });
	await askedYet(offered.asked, 1, "offered");
	assert(offered.asked[0].card.lasting === true, `an unmarked tool of a web connector offers the room yes, got ${JSON.stringify(offered.asked[0].card)}`);
	offered.asked[0].answer(false);
	await offeredCall;
	const destructive = person();
	const destructiveCall = call(piAllow, destructive.ctx, { tool: "asana_drop_board", server: "asana" });
	await askedYet(destructive.asked, 1, "destructive");
	assert(destructive.asked[0].card.lasting === false, "a tool marked destructive offers no room yes");
	destructive.asked[0].answer("room");
	assert(textOf(await destructiveCall) === "ran drop_board" && destructive.closed[0].frame.taken === "once" && allowedIn(askRoomId).length === 0, `a room yes sent anyway for a destructive tool counts this time and stores nothing, got ${JSON.stringify(destructive.closed)}`);

	// A full phone sees two answers, and its room yes counts this time.
	const phone = person("phone");
	const phoneCall = call(piAllow, phone.ctx, { tool: "asana_delete_project", server: "asana" });
	await askedYet(phone.asked, 1, "phone");
	assert(phone.asked[0].card.lasting === false, "a phone is never offered the room yes");
	phone.asked[0].answer("room");
	assert(textOf(await phoneCall) === "ran delete_project" && phone.closed[0].frame.taken === "once" && allowedIn(askRoomId).length === 0, `a phone's room yes runs once and stores nothing, got ${JSON.stringify(phone.closed)}`);

	// A room yes within the floor is asked again and stores nothing; after it, it is stored before the question says answered.
	let stillAt = 0;
	const quick = person("computer", { now: () => stillAt });
	const quickCall = call(piAllow, quick.ctx, { tool: "asana_delete_project", server: "asana" });
	await askedYet(quick.asked, 1, "floor");
	quick.asked[0].answer("room");
	assert(quick.again() === 1 && quick.closed.length === 0 && allowedIn(askRoomId).length === 0, `a room yes too soon is asked again, got ${quick.again()} again, ${JSON.stringify(quick.closed)}`);
	stillAt = 60_000;
	quick.asked[0].answer("room");
	assert(textOf(await quickCall) === "ran delete_project", "the room yes runs the call");
	assert(quick.closed[0].frame.taken === "room" && JSON.stringify(quick.closed[0].allowedThen) === JSON.stringify([{ tool: "delete_project", addressPin: settingsStore.connectorAddressPin(askConnector.webUrl()) }]), `stored with the address's pin before the question said answered, got ${JSON.stringify(quick.closed)}`);
	assert(!fs.readFileSync(settingsStore.persistentRoomMcpSettingsPath(askRoomId), "utf-8").includes(askConnector.webUrl()), "the room's file never holds the address itself");
	quick.ui.detach("The user left the room.");
	quick.ui.attach("computer");
	assert((quick.closed.length as number) === 2 && quick.closed[1].frame.id === quick.closed[0].frame.id && quick.closed[1].frame.taken === "room", `a device that comes back is told the room yes again, got ${JSON.stringify(quick.closed.map((entry) => entry.frame))}`);

	// The stored yes runs that tool with no question, at the computer and with nobody there; other tools, rooms and addresses still ask.
	const noQuestion = nobodyAsked();
	assert(textOf(await call(piAllow, noQuestion.ctx, { tool: "asana_delete_project", server: "asana" })) === "ran delete_project" && noQuestion.asked.length === 0, "a stored yes runs with no question");
	const awayNotes: Array<{ title: string; lasting?: boolean }> = [];
	const away = createWebUiContext(() => {}, (question: { title: string; lasting?: boolean }) => awayNotes.push(question));
	away.detach("The user left the room.");
	assert(textOf(await call(piAllow, { ...fakeCtx, ui: away }, { tool: "asana_delete_project", server: "asana" })) === "ran delete_project" && awayNotes.length === 0, "a stored yes runs with nobody there");
	const otherTool = person();
	const otherCall = call(piAllow, otherTool.ctx, { tool: "asana_create_note", server: "asana" });
	await askedYet(otherTool.asked, 1, "another tool");
	otherTool.asked[0].answer(false);
	assert((await otherCall).details.error === "connector_call_declined", "another tool of the connector still asks");
	const otherRoomId = "mcp-scope-smoke-ask-room-2";
	writePersistentRoomMcpSettings(otherRoomId, ["asana"]);
	const otherRoom = person();
	const otherRoomCall = gateCall(otherRoomId, otherRoom.ctx, "asana", "delete_project");
	await askedYet(otherRoom.asked, 1, "another room");
	otherRoom.asked[0].answer(false);
	assert((await otherRoomCall).details.error === "connector_call_declined", "the same tool in another room still asks");
	const movedUrl = askConnector.webUrl("/mcp-moved");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { url: movedUrl } } }, null, 2));
	const moved = person();
	const movedCall = gateCall(askRoomId, moved.ctx, "asana", "delete_project");
	await askedYet(moved.asked, 1, "another address");
	moved.asked[0].answer(false);
	assert((await movedCall).details.error === "connector_call_declined", "the same tool at another address still asks");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));

	// Nobody there: the note names Allow for this room only where it would be offered.
	await call(piAllow, { ...fakeCtx, ui: away }, { tool: "asana_create_note", server: "asana" });
	await call(piAllow, { ...fakeCtx, ui: away }, { tool: "asana_drop_board", server: "asana" });
	assert(JSON.stringify(awayNotes) === JSON.stringify([{ kind: "connector", title: "Use Create note in Asana?", lasting: true }, { kind: "connector", title: "Use Drop board in Asana?", lasting: false }]), `the away notes, got ${JSON.stringify(awayNotes)}`);
	assert(declinedQuestionNoteText("Use Create note in Asana?", true) === "Create note in Asana wasn't used because nobody was there to allow it. To let this room use it when you're away, choose Allow for this room at your computer the next time it asks.", "the note names the way on where it was offered");
	assert(declinedQuestionNoteText("Use Drop board in Asana?", false) === "Drop board in Asana wasn't used because nobody was there to allow it.", "and only there");

	// Each change that takes it back drops it, and the tool asks again.
	// The sweeps reach every room, which a room's own record marks.
	for (const roomId of [askRoomId, otherRoomId]) fs.writeFileSync(path.join(path.dirname(path.dirname(settingsStore.persistentRoomMcpSettingsPath(roomId))), "agent.json"), "{}");
	const asksAgain = async (label: string, roomId = askRoomId) => {
		const again = person();
		const asking = gateCall(roomId, again.ctx, "asana", "delete_project");
		await askedYet(again.asked, 1, label);
		again.asked[0].answer(false);
		assert((await asking).details.error === "connector_call_declined", `${label}: the tool asks again`);
	};
	writePersistentRoomMcpSettings(askRoomId, []);
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);
	assert(allowedIn(askRoomId).length === 0, "switched off for the room, the yes is dropped");
	await asksAgain("switched off and on");
	await allowForRoom();
	settingsStore.revokeMcpConnectorFromAllRooms("asana");
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);
	assert(allowedIn(askRoomId).length === 0, "removed from the app, the yes is dropped");
	await asksAgain("removed and added again");
	await allowForRoom();
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { ...askServers.asana, excludeTools: ["delete_project"] } } }, null, 2));
	const excludedYes = person();
	const excludedCall = gateCall(askRoomId, excludedYes.ctx, "asana", "delete_project");
	await askedYet(excludedYes.asked, 1, "excluded");
	assert(excludedYes.asked[0].card.lasting === false, "an excluded tool offers no room yes");
	excludedYes.asked[0].answer("room");
	assert((await excludedCall).details.error === "connector_tool_withdrawn", "a stored yes for an excluded tool lets nothing run");
	assert(allowedIn(askRoomId).length === 0, `excluded, the yes is dropped, got ${JSON.stringify(allowedIn(askRoomId))}`);
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	await asksAgain("excluded, then included again");
	await allowForRoom();
	// Only a reading call meets the connector while the tool is excluded: it drops the yes too.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { ...askServers.asana, excludeTools: ["delete_project"] } } }, null, 2));
	assert(textOf(await gateCall(askRoomId, person().ctx, "asana", "list_projects", { liveTool: { annotations: { readOnlyHint: true } } })) === "ran", "a reading call runs with no question");
	assert(allowedIn(askRoomId).length === 0, `excluded and met by a reading call, the yes is dropped, got ${JSON.stringify(allowedIn(askRoomId))}`);
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	await asksAgain("excluded, read, then included again");
	await allowForRoom();
	for (const [label, liveTool] of [["marked destructive later", { annotations: { destructiveHint: true } }], ["not listed by the live connection", undefined]] as const) {
		const later = person();
		const laterCall = gateCall(askRoomId, later.ctx, "asana", "delete_project", { liveTool });
		await askedYet(later.asked, 1, label);
		assert(later.asked[0].card.lasting === false, `${label}: no room yes offered`);
		later.asked[0].answer(false);
		assert((await laterCall).details.error === "connector_call_declined", `${label}: the stored yes isn't read, and it asks`);
	}
	settingsStore.allowPersistentRoomMcpTool(otherRoomId, "asana", "delete_project", settingsStore.connectorAddressPin(askConnector.webUrl()));
	const movedAway = await changeMcpServerAddress("asana", { url: movedUrl });
	assert(movedAway.sameSite && allowedIn(askRoomId).length === 0 && allowedIn(otherRoomId).length === 0 && readPersistentRoomMcpSettings(askRoomId).grantedConnectors.includes("asana"), "moved to another address, its yeses go in every room and the grant stays");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	settingsStore.allowPersistentRoomMcpTool(askRoomId, "asana", "delete_project", settingsStore.connectorAddressPin(askConnector.webUrl()));
	await changeMcpServerAddress("asana", { url: askConnector.url() });
	assert(allowedIn(askRoomId).length === 0, "moved to this computer's own address, its yes goes too");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	await asksAgain("moved and back");
	await allowForRoom();
	assert(settingsStore.forgetPersistentRoomMcpTool(askRoomId, "asana", "delete_project").ok && allowedIn(askRoomId).length === 0, "Remove takes the yes back");
	await asksAgain("removed in Room settings");

	// Answered after the connector was switched off: nothing stored, and refused as withdrawn.
	const late = person();
	const lateCall = call(piAllow, late.ctx, { tool: "asana_delete_project", server: "asana" });
	await askedYet(late.asked, 1, "switched off while it waited");
	writePersistentRoomMcpSettings(askRoomId, []);
	late.asked[0].answer("room");
	assert((await lateCall).details.error === "connector_not_enabled" && late.closed[0].frame.taken === "once" && readPersistentRoomMcpSettings(askRoomId).allowedTools.asana === undefined, `switched off while it waited: nothing stored, refused, got ${JSON.stringify(late.closed)}`);
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);

	// Moved to another address while it waited: nothing stored, and refused as withdrawn, whichever yes was given.
	for (const yes of ["room", true] as const) {
		const movedLate = person();
		const movedLateCall = call(piAllow, movedLate.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(movedLate.asked, 1, `moved while it waited (${yes})`);
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { url: movedUrl } } }, null, 2));
		movedLate.asked[0].answer(yes);
		const movedLateResult = await movedLateCall;
		assert(movedLateResult.details.error === "connector_moved" && movedLate.closed[0].frame.taken === "once" && readPersistentRoomMcpSettings(askRoomId).allowedTools.asana === undefined, `moved while it waited (${yes}): nothing stored, refused, got ${JSON.stringify(movedLateResult)} ${JSON.stringify(movedLate.closed)}`);
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	}
	assert(callsOf("delete_project") === 9, `only the answered and allowed calls reached the connector, got ${callsOf("delete_project")}`);
	await shutdownSession(piAllow);

	// An open room keeps the connection it made: the adapter connects, and
	// reconnects, from the settings it read when the session started. Moved in
	// the app while the room is open, the connector asks with two answers, a
	// room yes counts this time, and a yes kept for the new address isn't read,
	// until a session that starts after the move: it reaches the new address,
	// honours that yes and offers three answers.
	const reachedLast = () => askConnector.calledAt[askConnector.calledAt.length - 1];
	for (const [label, from, to] of [
		["from this computer's address to a web name", askConnector.url(), askConnector.webUrl()],
		["from one web address to another", askConnector.webUrl("/a"), askConnector.webUrl("/b")],
	] as const) {
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { url: from } } }, null, 2));
		fs.rmSync(path.join(agentDir, "mcp-cache.json"), { force: true });
		const piOpen = makeFakePi();
		await createRoomScopedMcpExtension(askRoomId)(piOpen);
		await startSession(piOpen);
		const first = person();
		const firstCall = call(piOpen, first.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(first.asked, 1, `${label}: before the move`);
		first.asked[0].answer(true);
		assert(textOf(await firstCall) === "ran delete_project" && reachedLast() === from, `${label}: before the move the call reaches ${from}, got ${reachedLast()}`);
		await changeMcpServerAddress("asana", { url: to });
		const after = person();
		const afterCall = call(piOpen, after.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(after.asked, 1, `${label}: after the move`);
		assert(after.asked[0].card.lasting === false, `${label}: the open room offers no room yes after the move`);
		after.asked[0].answer("room");
		assert(textOf(await afterCall) === "ran delete_project" && after.closed[0].frame.taken === "once" && allowedIn(askRoomId).length === 0, `${label}: a room yes counts this time and stores nothing, got ${JSON.stringify(after.closed)} ${JSON.stringify(allowedIn(askRoomId))}`);
		assert(reachedLast() === from, `${label}: the open room's call still reaches ${from}, got ${reachedLast()}`);
		settingsStore.allowPersistentRoomMcpTool(askRoomId, "asana", "delete_project", settingsStore.connectorAddressPin(to));
		const byHand = person();
		const byHandCall = call(piOpen, byHand.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(byHand.asked, 1, `${label}: a yes kept for the new address`);
		byHand.asked[0].answer(false);
		assert((await byHandCall).details.error === "connector_call_declined", `${label}: the open room doesn't read a yes kept for the new address`);
		await shutdownSession(piOpen);
		const piReopened = makeFakePi();
		await createRoomScopedMcpExtension(askRoomId)(piReopened);
		await startSession(piReopened);
		const reopened = nobodyAsked();
		assert(textOf(await call(piReopened, reopened.ctx, { tool: "asana_delete_project", server: "asana" })) === "ran delete_project" && reopened.asked.length === 0 && reachedLast() === to, `${label}: opened again, the room honours the yes and reaches ${to}, got ${reopened.asked.length} cards, ${reachedLast()}`);
		assert(settingsStore.forgetPersistentRoomMcpTool(askRoomId, "asana", "delete_project").ok, `${label}: the yes is taken back`);
		const offeredAgain = person();
		const offeredAgainCall = call(piReopened, offeredAgain.ctx, { tool: "asana_delete_project", server: "asana" });
		await askedYet(offeredAgain.asked, 1, `${label}: opened again`);
		assert(offeredAgain.asked[0].card.lasting === true, `${label}: opened again, the room offers Allow for this room`);
		offeredAgain.asked[0].answer("room");
		assert(textOf(await offeredAgainCall) === "ran delete_project" && offeredAgain.closed[0].frame.taken === "room" && allowedIn(askRoomId).length === 1, `${label}: opened again, a room yes is kept, got ${JSON.stringify(offeredAgain.closed)}`);
		await shutdownSession(piReopened);
		writePersistentRoomMcpSettings(askRoomId, []);
		writePersistentRoomMcpSettings(askRoomId, ["asana"]);
	}
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	fs.writeFileSync(path.join(agentDir, "mcp-cache.json"), JSON.stringify(askCacheEntry(savedAskTools), null, 2));

	// A yes written by hand for a connector that is a program on this computer lets nothing run, and it offers none.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ...askServers, local: { command: "node", args: ["-e", ""] } } }, null, 2));
	fs.writeFileSync(settingsStore.persistentRoomMcpSettingsPath(askRoomId), JSON.stringify({ schemaVersion: 1, grantedConnectors: ["asana", "local"], allowedTools: { local: [{ tool: "write_file", addressPin: settingsStore.connectorAddressPin("node") }] }, updatedAt: "" }));
	const local = person();
	const localCall = gateCall(askRoomId, local.ctx, "local", "write_file");
	await askedYet(local.asked, 1, "a local program");
	assert(local.asked[0].card.lasting === false, "a local program's tool offers no room yes");
	local.asked[0].answer("room");
	assert(textOf(await localCall) === "ran" && local.closed[0].frame.taken === "once", "a local program's room yes counts this time");
	const localAgain = person();
	const localAgainCall = gateCall(askRoomId, localAgain.ctx, "local", "write_file");
	await askedYet(localAgain.asked, 1, "a local program, a yes by hand");
	localAgain.asked[0].answer(false);
	assert((await localAgainCall).details.error === "connector_call_declined", "a yes written by hand for a local program's tool lets nothing run");
	// An entry that names a command and a web address too is a program the adapter starts: two answers, and a yes written by hand for its address lets nothing run.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { command: "node", args: ["-e", ""], url: askConnector.webUrl() } } }, null, 2));
	fs.writeFileSync(settingsStore.persistentRoomMcpSettingsPath(askRoomId), JSON.stringify({ schemaVersion: 1, grantedConnectors: ["asana"], allowedTools: { asana: [{ tool: "delete_project", addressPin: settingsStore.connectorAddressPin(askConnector.webUrl()) }] }, updatedAt: "" }));
	const commandAndUrl = person();
	const commandAndUrlCall = gateCall(askRoomId, commandAndUrl.ctx, "asana", "delete_project");
	await askedYet(commandAndUrl.asked, 1, "a command with a web address");
	assert(commandAndUrl.asked[0].card.lasting === false, "a command with a web address offers no room yes");
	commandAndUrl.asked[0].answer(false);
	assert((await commandAndUrlCall).details.error === "connector_call_declined", "a yes written by hand for a command with a web address lets nothing run");

	// A connector at this computer's own address is a program here too, in any spelling: two answers, a room yes counts this time, and a yes written by hand still asks.
	const writeAsanaAt = (url: string, allowed: unknown[] = []) => {
		fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { asana: { url } } }, null, 2));
		fs.writeFileSync(settingsStore.persistentRoomMcpSettingsPath(askRoomId), JSON.stringify({ schemaVersion: 1, grantedConnectors: ["asana"], allowedTools: allowed.length ? { asana: allowed } : {}, updatedAt: "" }));
	};
	// This computer's own network name, with and without .local, in any letter case.
	const ownName = os.hostname().replace(/\.local\.?$/i, "");
	for (const url of ["http://127.0.0.1:9/mcp", "http://127.1:9/mcp", "http://localhost:9/mcp", "http://LOCALHOST.:9/mcp", "http://desk.localhost/mcp", "http://[::1]:9/mcp", "http://0.0.0.0:9/mcp", "http://[::]:9/mcp", "http://[::ffff:127.0.0.1]:9/mcp", "http://[::ffff:7f00:1]:9/mcp", "http://localhost.localdomain:9/mcp", "http://ip6-localhost:9/mcp", "http://IP6-Loopback/mcp", `http://${ownName.toLowerCase()}:9/mcp`, `http://${ownName.toUpperCase()}.local:9/mcp`, `http://${ownName}.Local./mcp`]) {
		writeAsanaAt(url, [{ tool: "delete_project", addressPin: settingsStore.connectorAddressPin(url) }]);
		const here = person();
		const hereCall = gateCall(askRoomId, here.ctx, "asana", "delete_project");
		await askedYet(here.asked, 1, `this computer at ${url}`);
		assert(here.asked[0].card.lasting === false, `${url}: no room yes offered`);
		here.asked[0].answer("room");
		assert(textOf(await hereCall) === "ran" && here.closed[0].frame.taken === "once", `${url}: a yes by hand still asks, and a room yes counts this time, got ${JSON.stringify(here.closed)}`);
	}
	// Another computer, on the person's network or the company's, is a web connector.
	for (const url of ["http://10.1.2.3/mcp", "http://192.168.1.5:8080/mcp", "http://projects.corp.internal/mcp", `http://${ownName}.example.test/mcp`, "http://localhost.localdomain.example.test/mcp"]) {
		writeAsanaAt(url);
		const there = person();
		const thereCall = gateCall(askRoomId, there.ctx, "asana", "delete_project");
		await askedYet(there.asked, 1, `another computer at ${url}`);
		assert(there.asked[0].card.lasting === true, `${url}: Allow for this room offered`);
		there.asked[0].answer(false);
		assert((await thereCall).details.error === "connector_call_declined", `${url}: declined`);
	}
	writePersistentRoomMcpSettings(askRoomId, ["asana"]);
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));

	// A tool that doesn't say it stops at the gate is never offered to a room.
	assert(await roomScopedMcpToolRegistration(askRoomId, { name: "mcp", execute: async () => ({ content: [] }) }) === null, "an adapter without the gate offers a room nothing");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: servers }, null, 2));

	// ── The patcher fails the install when its anchor is gone ────────────────
	const adapterFolder = path.dirname(fileURLToPath(import.meta.resolve("pi-mcp-adapter/package.json")));
	const patcher = path.resolve(scriptDir, "..", "..", "..", "scripts", "patch-mcp-adapter.mjs");
	for (const [file, anchor] of [
		["proxy-modes.ts", "const refused = await beforeConnectorCall({"],
		["direct-tools.ts", "const refused = await beforeConnectorCall({"],
		["index.ts", "executeCall(state, params.tool, parsedArgs, params.server, getPiTools, beforeConnectorCall)"],
	]) {
		const scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "exxeta-mcp-scope-patch-"));
		const scratch = path.join(scratchRoot, "node_modules", "pi-mcp-adapter");
		fs.cpSync(adapterFolder, scratch, { recursive: true });
		const aiCopy = path.join(scratchRoot, "node_modules", "@earendil-works", "pi-ai");
		fs.cpSync(path.resolve(adapterFolder, "..", "@earendil-works", "pi-ai"), aiCopy, { recursive: true, dereference: true });
		const source = fs.readFileSync(path.join(scratch, file), "utf-8");
		assert(source.includes(anchor), `the installed ${file} holds the patch`);
		fs.writeFileSync(path.join(scratch, file), source.replace(anchor, "const refused = undefined; ({"));
		const run = spawnSync(process.execPath, [patcher, "--adapter-dir", scratch], { encoding: "utf8" });
		assert(run.status === 1 && /patch 12 .*a room's connector calls would run without asking/.test(run.stderr), `a lost anchor in ${file} fails the install, got ${run.status}: ${run.stderr}`);
		fs.rmSync(scratchRoot, { recursive: true, force: true });
	}

	// ── Specialists: the template floor cannot even grant the mcp tool ───────
	const { assertSpecialistTemplateTools } = await import("../src/specialist-templates.js");
	let specialistRefused = false;
	try {
		assertSpecialistTemplateTools({ id: "smoke-template", toolNames: ["mcp"] } as any);
	} catch (error) {
		specialistRefused = /forbidden/.test((error as Error).message);
	}
	assert(specialistRefused, "a specialist template granting the mcp tool must be rejected as forbidden");

	// ── Room settings, Connectors, and a shared server ───────────────────────
	// The pane's answer lists each allowed tool by its words and keeps the pin on the server; Remove counts from the next call.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	await import("../src/room-settings-routes.js");
	const { app, AUTH_HEADER_NAME, AUTH_TOKEN } = await import("../src/server-app.js");
	app.log.level = "silent";
	const agents = await import("../src/persistent-agents.js");
	const paneRoom = String(agents.createPersistentAgentFromScaffoldInput({ displayName: "Pane Room", userName: "Synthetic User", preferredUserAddress: "Synthetic User" }).agent.agentId);
	const paneUrl = `/api/persistent-agents/${paneRoom}/mcp-connectors`;
	const pane = async (method: "GET" | "PUT", payload?: Record<string, unknown>) => {
		const answer = await app.inject({ method, url: paneUrl, headers: { [AUTH_HEADER_NAME]: AUTH_TOKEN }, ...(payload ? { payload } : {}) });
		return { status: answer.statusCode, body: answer.json() };
	};
	assert((await pane("PUT", { action: "grant", name: "asana" })).status === 200, "the pane turns the connector on");
	const paneStore = await import("../src/persistent-room-mcp-settings.js");
	const pin = paneStore.connectorAddressPin(askConnector.webUrl());
	paneStore.allowPersistentRoomMcpTool(paneRoom, "asana", "delete_project", pin);
	paneStore.allowPersistentRoomMcpTool(paneRoom, "asana", "createTask", pin);
	assert(paneStore.allowPersistentRoomMcpTool(paneRoom, "asana", "x".repeat(201), pin) === false, "a yes the file can't hold is never answered as stored");
	const listed = await pane("GET");
	assert(JSON.stringify(listed.body.allowedTools) === JSON.stringify({ asana: [{ tool: "createTask", shown: "Create Task" }, { tool: "delete_project", shown: "Delete project" }] }) && !JSON.stringify(listed.body).includes(pin) && !("allowedTools" in listed.body.settings), `the pane lists each allowed tool and never its pin, got ${JSON.stringify(listed.body)}`);
	// A connector may be named like an object's own members: the pane still reads, and lists no yes it doesn't hold.
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: { ...askServers, constructor: { url: askConnector.webUrl("/other") } } }, null, 2));
	assert((await pane("PUT", { action: "grant", name: "constructor" })).status === 200, "a connector named constructor is turned on");
	const namedLikeMembers = await pane("GET");
	assert(namedLikeMembers.status === 200 && !Object.hasOwn(namedLikeMembers.body.allowedTools, "constructor"), `a connector named constructor leaves the pane readable, got ${namedLikeMembers.status} ${JSON.stringify(namedLikeMembers.body)}`);
	assert((await pane("PUT", { action: "revoke", name: "constructor" })).status === 200, "and is turned off");
	fs.writeFileSync(path.join(agentDir, "mcp.json"), JSON.stringify(askConfig, null, 2));
	const forgot = await pane("PUT", { action: "forget-tool", name: "asana", tool: "delete_project" });
	assert(forgot.status === 200 && JSON.stringify(forgot.body.allowedTools) === JSON.stringify({ asana: [{ tool: "createTask", shown: "Create Task" }] }), `Remove takes back that tool alone, got ${JSON.stringify(forgot.body)}`);
	const removedAsks = person();
	const removedCall = gateCall(paneRoom, removedAsks.ctx, "asana", "delete_project");
	await askedYet(removedAsks.asked, 1, "after Remove");
	removedAsks.asked[0].answer(false);
	assert((await removedCall).details.error === "connector_call_declined", "after Remove the tool asks on its next call");
	const stillFree = nobodyAsked();
	assert((await gateCall(paneRoom, stillFree.ctx, "asana", "createTask")).content[0].text === "ran" && stillFree.asked.length === 0, "the tool not removed still runs with no question");

	// A shared server keeps no yes: none read, none offered or stored, none listed, and Remove is no action, the file left byte for byte.
	const { registerServerHooks } = await import("../src/server-hooks.js");
	registerServerHooks({});
	const sharedFile = paneStore.persistentRoomMcpSettingsPath(paneRoom);
	const sharedBytes = fs.readFileSync(sharedFile, "utf-8");
	const sharedAsks = person();
	const sharedCall = gateCall(paneRoom, sharedAsks.ctx, "asana", "createTask");
	await askedYet(sharedAsks.asked, 1, "a shared server");
	assert(sharedAsks.asked[0].card.lasting === false, "a shared server offers no room yes");
	sharedAsks.asked[0].answer("room");
	assert((await sharedCall).content[0].text === "ran" && sharedAsks.closed[0].frame.taken === "once", "on a shared server a stored yes isn't read, and a room yes counts this time");
	const sharedList = await pane("GET");
	assert(sharedList.status === 200 && !("allowedTools" in sharedList.body), `a shared server lists no allowed tools, got ${JSON.stringify(sharedList.body)}`);
	const sharedForget = await pane("PUT", { action: "forget-tool", name: "asana", tool: "createTask" });
	assert(sharedForget.status === 400 && fs.readFileSync(sharedFile, "utf-8") === sharedBytes, `a shared server refuses Remove and writes nothing, got ${sharedForget.status}`);

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
	signInRecorder.server.close();
	askConnector.server.close();
}
