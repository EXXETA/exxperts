// Smoke for connector sign-ins and the authorization server that issued
// them. A fake connector and two fake authorization servers, A and B, on
// localhost; the connector's protected-resource metadata names one of them
// and can be switched. Every request to A and B is recorded. Drives the
// adapter's real machinery (startAuth, the loopback callback, completeAuth,
// getValidToken, McpServerManager.connect, testMcpServer).
//
// 1. Binding: a sign-in made at A is never presented to B. After the switch
//    no request to B carries A's refresh token or A's client secret, on every
//    refresh path.
// 2. A sign-in saved by 0.14.2 (no stamps): the first refresh at A works and
//    stamps both stored values, keeping the client's two dates; the SDK's
//    warning stops after that run; a later switch to B gets nothing of A's.
// 3. The name we register with: exxperts and its GitHub address.
// 4. A configured client (a client ID in the connector's settings): its
//    secret is never copied into the sign-in file, and a switch to B gets
//    nothing of A's.
// 5. A configured client_credentials client: after the switch, B gets no
//    token request carrying the configured secret.
// 6. A configured client: a sign-in the person starts while the connector
//    names B fails with our message after discovery, before any registration,
//    authorization or token request.
// 7. A sign-in file saved by 0.14.2 with a copied configured secret holds
//    only the client ID and the stamp after the first refresh.
// 8. A client ID added to the settings after a dynamic sign-in: the stale
//    registration is replaced at the next sign-in, not refused.
// 9. A configured client switched to a server without dynamic registration
//    gets our message too, not the SDK's registration error.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "exx-mcp-issuer-smoke-home-"));
process.env.HOME = home;
process.env.USERPROFILE = home;
const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exx-mcp-issuer-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// The adapter reads the loopback-callback port at module load: a free one,
// so the smoke never collides with a running exxperts instance.
const CALLBACK_PORT = await new Promise<number>((resolve) => {
	const probe = http.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const port = (probe.address() as { port: number }).port;
		probe.close(() => resolve(port));
	});
});
process.env.MCP_OAUTH_CALLBACK_PORT = String(CALLBACK_PORT);

const failures: string[] = [];
function check(ok: boolean, line: string): void {
	console.log(`${ok ? "PASS" : "FAIL"} ${line}`);
	if (!ok) failures.push(line);
}

// The SDK's warning for a stored refresh token without a stamp.
let unstampedWarnings = 0;
const originalWarn = console.warn;
console.warn = (...args: unknown[]) => {
	if (args.some((arg) => typeof arg === "string" && arg.includes("have no 'issuer' property"))) unstampedWarnings += 1;
	originalWarn(...args);
};

function readBody(req: http.IncomingMessage): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		req.on("data", (c) => (data += c));
		req.on("end", () => resolve(data));
	});
}

function json(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
	res.writeHead(status, { "content-type": "application/json", ...headers });
	res.end(JSON.stringify(body));
}

function listen(server: http.Server): Promise<string> {
	return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(`http://localhost:${(server.address() as { port: number }).port}`)));
}

// Access tokens the connector accepts (issued by A or B and not expired).
const validAccess = new Set<string>();

interface AsRequest {
	method: string;
	path: string;
	body: string;
	// Query, body and authorization header (a Basic header decoded), for searching.
	text: string;
}

function makeAuthServer(label: "a" | "b" | "c", { acceptAnyClient = false, registration = true } = {}) {
	const requests: AsRequest[] = [];
	const clients = new Map<string, string | undefined>();
	const refreshTokens = new Map<string, string>();
	const codes = new Map<string, { challenge: string; clientId: string }>();
	let counter = 0;
	let base = "";

	function issueTokens(clientId: string) {
		counter += 1;
		const access = `${label}-access-${counter}`;
		const refresh = `${label}-refresh-${counter}`;
		validAccess.add(access);
		refreshTokens.set(refresh, clientId);
		return { access_token: access, token_type: "Bearer", expires_in: 3600, refresh_token: refresh };
	}

	function clientOf(req: http.IncomingMessage, params: URLSearchParams): string | undefined {
		let id = params.get("client_id") ?? undefined;
		let secret = params.get("client_secret") ?? undefined;
		const basic = req.headers.authorization;
		if (basic?.startsWith("Basic ")) {
			const [rawId, rawSecret] = Buffer.from(basic.slice(6), "base64").toString().split(":");
			id = decodeURIComponent(rawId);
			secret = decodeURIComponent(rawSecret);
		}
		if (!id || !clients.has(id)) return undefined;
		const expected = clients.get(id);
		return expected === undefined || expected === secret ? id : undefined;
	}

	const server = http.createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", base);
		const body = await readBody(req);
		const basic = req.headers.authorization?.startsWith("Basic ") ? Buffer.from(req.headers.authorization.slice(6), "base64").toString() : "";
		requests.push({ method: req.method ?? "GET", path: url.pathname, body, text: `${url.search} ${body} ${req.headers.authorization ?? ""} ${basic}` });

		if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
			json(res, 200, {
				issuer: base,
				authorization_endpoint: `${base}/authorize`,
				token_endpoint: `${base}/token`,
				...(registration ? { registration_endpoint: `${base}/register` } : {}),
				response_types_supported: ["code"],
				grant_types_supported: ["authorization_code", "refresh_token", "client_credentials"],
				code_challenge_methods_supported: ["S256"],
				token_endpoint_auth_methods_supported: ["client_secret_post"],
			});
			return;
		}
		if (registration && url.pathname === "/register" && req.method === "POST") {
			counter += 1;
			const metadata = JSON.parse(body) as Record<string, unknown>;
			const clientId = `${label}-client-${counter}`;
			const clientSecret = `${label}-client-pass-${counter}`;
			clients.set(clientId, clientSecret);
			json(res, 201, { ...metadata, client_id: clientId, client_secret: clientSecret, client_id_issued_at: 1_700_000_000, client_secret_expires_at: 0 });
			return;
		}
		if (url.pathname === "/authorize") {
			const clientId = url.searchParams.get("client_id") ?? "";
			if (!acceptAnyClient && !clients.has(clientId)) {
				json(res, 400, { error: "unknown client" });
				return;
			}
			counter += 1;
			const code = `${label}-code-${counter}`;
			codes.set(code, { challenge: url.searchParams.get("code_challenge") ?? "", clientId });
			const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
			redirect.searchParams.set("code", code);
			redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
			res.writeHead(302, { location: redirect.toString() });
			res.end();
			return;
		}
		if (url.pathname === "/token" && req.method === "POST") {
			const params = new URLSearchParams(body);
			const clientId = clientOf(req, params);
			if (!clientId) {
				json(res, 401, { error: "invalid_client" });
				return;
			}
			if (params.get("grant_type") === "authorization_code") {
				const pending = codes.get(params.get("code") ?? "");
				const challenge = crypto.createHash("sha256").update(params.get("code_verifier") ?? "").digest("base64url");
				if (!pending || pending.clientId !== clientId || pending.challenge !== challenge) {
					json(res, 400, { error: "invalid_grant" });
					return;
				}
				codes.delete(params.get("code") ?? "");
				json(res, 200, issueTokens(clientId));
				return;
			}
			if (params.get("grant_type") === "refresh_token") {
				const refresh = params.get("refresh_token") ?? "";
				if (refreshTokens.get(refresh) !== clientId) {
					json(res, 400, { error: "invalid_grant" });
					return;
				}
				refreshTokens.delete(refresh);
				json(res, 200, issueTokens(clientId));
				return;
			}
			if (params.get("grant_type") === "client_credentials") {
				counter += 1;
				const access = `${label}-access-${counter}`;
				validAccess.add(access);
				json(res, 200, { access_token: access, token_type: "Bearer", expires_in: 3600 });
				return;
			}
			json(res, 400, { error: "unsupported_grant_type" });
			return;
		}
		json(res, 404, { error: "not found" });
	});

	return {
		requests,
		clients,
		refreshTokens,
		get base() {
			return base;
		},
		async start() {
			base = await listen(server);
		},
		close() {
			server.close();
		},
	};
}

const authA = makeAuthServer("a");
// B and C play servers that took the connector over: their sign-in pages take
// any client. C offers no dynamic registration.
const authB = makeAuthServer("b", { acceptAnyClient: true });
const authC = makeAuthServer("c", { acceptAnyClient: true, registration: false });

// The connector: names one authorization server at a time.
let namedAuthServer = "";
let connectorBase = "";
const connector = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", connectorBase);
	if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
		json(res, 200, { resource: `${connectorBase}/mcp`, authorization_servers: [namedAuthServer] });
		return;
	}
	if (url.pathname === "/mcp" && req.method === "POST") {
		const body = await readBody(req);
		const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : "";
		if (!validAccess.has(bearer)) {
			json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${connectorBase}/.well-known/oauth-protected-resource"` });
			return;
		}
		const message = JSON.parse(body) as { id?: number; method?: string; params?: { protocolVersion?: string } };
		if (message.method === "initialize") {
			json(res, 200, { id: message.id, jsonrpc: "2.0", result: { protocolVersion: message.params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "issuer-smoke", version: "1" } } });
			return;
		}
		if (message.method === "notifications/initialized") {
			res.writeHead(202).end();
			return;
		}
		if (message.method === "tools/list") {
			json(res, 200, { id: message.id, jsonrpc: "2.0", result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: {} } }] } });
			return;
		}
		json(res, 200, { id: message.id, jsonrpc: "2.0", result: {} });
		return;
	}
	res.writeHead(404).end();
});

async function fetchCallback(url: string): Promise<Response> {
	// The callback server binds "localhost", which resolves to one address
	// family; a browser handles this, the smoke tries both loopback literals.
	const candidates = [url, url.replace("://localhost:", "://[::1]:"), url.replace("://localhost:", "://127.0.0.1:")];
	let lastError: unknown;
	for (const candidate of candidates) {
		try {
			return await fetch(candidate);
		} catch (error) {
			lastError = error;
		}
	}
	throw lastError;
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
	return Promise.race([promise, new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} timed out after 20s`)), 20_000))]);
}

async function main(): Promise<void> {
	await authA.start();
	await authB.start();
	await authC.start();
	connectorBase = await listen(connector);
	const serverUrl = `${connectorBase}/mcp`;
	// The SDK stamps the authorization server URL as discovery used it and
	// compares stamps as URLs, so a trailing slash does not matter.
	const stampedForA = (stamp: unknown) => typeof stamp === "string" && new URL(stamp).href === new URL(authA.base).href;

	const admin = await import("../src/mcp-admin.js");
	const authFlow = await import("pi-mcp-adapter/mcp-auth-flow.ts" as string);
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const callbackMod = await import("pi-mcp-adapter/mcp-callback-server.ts" as string);
	const managerMod = await import("pi-mcp-adapter/server-manager.ts" as string);
	const configMod = await import("pi-mcp-adapter/config.ts" as string);
	const entryOf = (name: string) => configMod.loadMcpConfig().mcpServers[name];

	async function signIn(name: string): Promise<void> {
		const { authorizationUrl } = await authFlow.startAuth(name, serverUrl, entryOf(name));
		if (!authorizationUrl) throw new Error(`startAuth gave no authorization URL for ${name}`);
		const callbackPromise = callbackMod.waitForCallback(authStore.getOAuthState(name));
		const authorize = await fetch(authorizationUrl, { redirect: "manual" });
		const location = authorize.headers.get("location");
		if (authorize.status !== 302 || !location) throw new Error(`authorize answered ${authorize.status} for ${name}`);
		await fetchCallback(location);
		await authFlow.completeAuth(name, await callbackPromise);
		if (!authStore.hasStoredTokens(name)) throw new Error(`no tokens stored after the sign-in of ${name}`);
	}

	// What the web Connectors page's Test shows the person.
	async function testShows(name: string): Promise<string> {
		const result = await withTimeout(admin.testMcpServer(name), "testMcpServer");
		return result.ok ? "ok" : `${result.needsAuth ? "needs sign-in" : "error"}: ${result.error}`;
	}

	async function connectThroughManager(name: string): Promise<string> {
		const manager = new managerMod.McpServerManager();
		try {
			const connection = (await withTimeout(manager.connect(name, entryOf(name)), "connect")) as { tools?: Array<{ name: string }> };
			return `connected, tools ${(connection.tools ?? []).map((t) => t.name).join(",")}`;
		} finally {
			await manager.closeAll().catch(() => {});
		}
	}

	// The access token expires: the connector refuses it and the store says so.
	function expire(name: string): void {
		const entry = authStore.getAuthEntry(name);
		validAccess.delete(entry.tokens.accessToken);
		authStore.saveAuthEntry(name, { ...entry, tokens: { ...entry.tokens, expiresAt: Math.floor(Date.now() / 1000) - 60 } });
	}

	function storeSummary(name: string): string {
		const entry = authStore.getAuthEntry(name) ?? {};
		const client = entry.clientInfo;
		const tokens = entry.tokens;
		return `client ${client?.clientId ?? "none"} (issuer ${client?.issuer ?? "none"}), tokens ${tokens ? `refresh ${tokens.refreshToken ?? "none"} (issuer ${tokens.issuer ?? "none"})` : "none"}`;
	}

	function carrying(requests: AsRequest[], values: Array<string | undefined>): AsRequest[] {
		const present = values.filter((v): v is string => Boolean(v));
		return requests.filter((r) => present.some((v) => r.text.includes(v)));
	}

	const describe = (requests: AsRequest[]) => (requests.length ? requests.map((r) => `${r.method} ${r.path}`).join(", ") : "none");

	// --- Case 1 and case 3: dynamic registration at A, then the switch to B ---
	namedAuthServer = authA.base;
	const switched = "issuer-switch";
	await admin.addMcpServer({ name: switched, url: serverUrl });
	await signIn(switched);

	const registration = authA.requests.find((r) => r.path === "/register");
	const registered = registration ? (JSON.parse(registration.body) as Record<string, unknown>) : {};
	check(registered.client_name === "exxperts", `case 3 name: registration at A sends client_name ${JSON.stringify(registered.client_name)} (want "exxperts")`);
	check(registered.client_uri === "https://github.com/EXXETA/exxperts", `case 3 name: registration at A sends client_uri ${JSON.stringify(registered.client_uri)} (want "https://github.com/EXXETA/exxperts")`);

	const signedIn = structuredClone(authStore.getAuthEntry(switched));
	const aRefresh: string | undefined = signedIn.tokens?.refreshToken;
	const aSecret: string | undefined = signedIn.clientInfo?.clientSecret;
	console.log(`case 1 setup: signed in at A; ${storeSummary(switched)}`);
	namedAuthServer = authB.base;

	const paths: Array<[string, () => Promise<string>]> = [
		["getValidToken (adapter API, no caller in the app)", async () => `returned ${(await withTimeout(authFlow.getValidToken(switched, serverUrl), "getValidToken")) ? "tokens" : "null"}`],
		["McpServerManager.connect (web rooms, the terminal and its connectors panel)", () => connectThroughManager(switched)],
		["testMcpServer (the web Connectors page)", async () => {
			const result = await withTimeout(admin.testMcpServer(switched), "testMcpServer");
			return result.ok ? "ok" : `not ok (${result.needsAuth ? "needs sign-in" : "error"}: ${result.error})`;
		}],
	];
	for (const [label, run] of paths) {
		authStore.saveAuthEntry(switched, structuredClone(signedIn));
		expire(switched);
		const before = authB.requests.length;
		let outcome: string;
		try {
			outcome = await run();
		} catch (error) {
			outcome = `threw: ${(error as Error).message}`;
		}
		const sent = authB.requests.slice(before);
		const leaks = carrying(sent, [aRefresh, aSecret]);
		check(leaks.length === 0, `case 1 binding, ${label}: B got ${describe(sent)}; ${leaks.length} carrying A's refresh token or client secret (${describe(leaks)}). The connector reports: ${outcome}. Store left: ${storeSummary(switched)}`);
	}

	// --- Case 2: a sign-in saved by 0.14.2, written through the store itself ---
	namedAuthServer = authA.base;
	const legacy = "saved-by-0142";
	await admin.addMcpServer({ name: legacy, url: serverUrl });
	authA.clients.set("legacy-client", "legacy-client-pass");
	authA.refreshTokens.set("legacy-refresh-0", "legacy-client");
	authStore.updateClientInfo(
		legacy,
		{ clientId: "legacy-client", clientSecret: "legacy-client-pass", clientIdIssuedAt: 1_700_000_000, clientSecretExpiresAt: 4_102_444_800, redirectUris: [`http://localhost:${CALLBACK_PORT}/callback`] },
		serverUrl,
	);
	authStore.updateTokens(legacy, { accessToken: "legacy-access-0", refreshToken: "legacy-refresh-0", expiresAt: Math.floor(Date.now() / 1000) - 60 }, serverUrl);

	let warningsBefore = unstampedWarnings;
	let firstRun: string;
	try {
		firstRun = await connectThroughManager(legacy);
	} catch (error) {
		firstRun = `threw: ${(error as Error).message}`;
	}
	const firstRunWarnings = unstampedWarnings - warningsBefore;
	check(firstRun.startsWith("connected"), `case 2 0.14.2 sign-in, first refresh at A without a new sign-in: ${firstRun}`);
	const afterFirst = authStore.getAuthEntry(legacy) ?? {};
	check(stampedForA(afterFirst.tokens?.issuer) && stampedForA(afterFirst.clientInfo?.issuer), `case 2 0.14.2 sign-in, both stored values stamped for A after the first refresh: tokens ${afterFirst.tokens?.issuer ?? "none"}, client ${afterFirst.clientInfo?.issuer ?? "none"} (want ${authA.base})`);
	check(afterFirst.clientInfo?.clientIdIssuedAt === 1_700_000_000 && afterFirst.clientInfo?.clientSecretExpiresAt === 4_102_444_800, `case 2 0.14.2 sign-in, the client's two dates survive: clientIdIssuedAt ${afterFirst.clientInfo?.clientIdIssuedAt}, clientSecretExpiresAt ${afterFirst.clientInfo?.clientSecretExpiresAt}`);

	expire(legacy);
	warningsBefore = unstampedWarnings;
	let secondRun: string;
	try {
		secondRun = await connectThroughManager(legacy);
	} catch (error) {
		secondRun = `threw: ${(error as Error).message}`;
	}
	const secondRunWarnings = unstampedWarnings - warningsBefore;
	check(secondRun.startsWith("connected") && secondRunWarnings === 0, `case 2 0.14.2 sign-in, the SDK's unstamped warning stops after the first run: ${firstRunWarnings} in the first run, ${secondRunWarnings} in the second (${secondRun})`);

	const beforeSwitch = authStore.getAuthEntry(legacy);
	expire(legacy);
	namedAuthServer = authB.base;
	const legacyBefore = authB.requests.length;
	let switchRun: string;
	try {
		switchRun = await connectThroughManager(legacy);
	} catch (error) {
		switchRun = `threw: ${(error as Error).message}`;
	}
	const legacySent = authB.requests.slice(legacyBefore);
	const legacyLeaks = carrying(legacySent, [beforeSwitch?.tokens?.refreshToken, "legacy-client-pass"]);
	check(legacyLeaks.length === 0, `case 2 0.14.2 sign-in, a later switch to B: B got ${describe(legacySent)}; ${legacyLeaks.length} carrying A's refresh token or client secret (${describe(legacyLeaks)}). The connector reports: ${switchRun}. Store left: ${storeSummary(legacy)}`);

	// --- Case 4 and case 6: a configured authorization-code client ---
	namedAuthServer = authA.base;
	const configured = "pre-registered";
	authA.clients.set("configured-client", "configured-client-pass");
	await admin.addMcpServer({ name: configured, url: serverUrl, oauth: { clientId: "configured-client", clientSecret: "configured-client-pass" } });
	const secretInStore = (name: string) => fs.readFileSync(authStore.getAuthEntryFilePath(name), "utf-8").includes("configured-client-pass");
	await signIn(configured);
	check(!secretInStore(configured), `case 4 configured client, after the sign-in at A the configured secret is ${secretInStore(configured) ? "in" : "not in"} tokens.json; ${storeSummary(configured)}`);
	expire(configured);
	let refreshRun: string;
	try {
		refreshRun = await connectThroughManager(configured);
	} catch (error) {
		refreshRun = `threw: ${(error as Error).message}`;
	}
	check(refreshRun.startsWith("connected") && !secretInStore(configured), `case 4 configured client, after a refresh at A (${refreshRun}) the configured secret is ${secretInStore(configured) ? "in" : "not in"} tokens.json; ${storeSummary(configured)}`);
	const configuredBefore = authStore.getAuthEntry(configured);
	expire(configured);
	namedAuthServer = authB.base;
	let mark = authB.requests.length;
	let configuredSwitch: string;
	try {
		configuredSwitch = await connectThroughManager(configured);
	} catch (error) {
		configuredSwitch = `threw: ${(error as Error).message}`;
	}
	const configuredTest = await testShows(configured);
	let sent = authB.requests.slice(mark);
	let leaks = carrying(sent, [configuredBefore?.tokens?.refreshToken, "configured-client-pass"]);
	check(leaks.length === 0, `case 4 configured client, after the switch to B: B got ${describe(sent)}; ${leaks.length} carrying the refresh token or the configured secret (${describe(leaks)}). The connector reports: ${configuredSwitch}. The Test shows: ${configuredTest}. Store left: ${storeSummary(configured)}`);

	mark = authB.requests.length;
	let userSignIn: string;
	try {
		await signIn(configured);
		userSignIn = "signed in";
	} catch (error) {
		userSignIn = `failed: ${(error as Error).message}`;
	}
	sent = authB.requests.slice(mark);
	check(
		userSignIn.includes(`connector "${configured}" has changed`) && !sent.some((r) => r.path === "/register" || r.path === "/authorize" || r.path === "/token"),
		`case 6 configured client, a sign-in started while the connector names B: ${userSignIn}; B got ${describe(sent)} (want no registration, authorization or token request). Store left: ${storeSummary(configured)}`,
	);

	namedAuthServer = authC.base;
	mark = authC.requests.length;
	let noRegistration: string;
	try {
		await signIn(configured);
		noRegistration = "signed in";
	} catch (error) {
		noRegistration = `failed: ${(error as Error).message}`;
	}
	sent = authC.requests.slice(mark);
	check(
		noRegistration.includes(`connector "${configured}" has changed`) && !sent.some((r) => r.path === "/authorize" || r.path === "/token"),
		`case 9 configured client, a sign-in while the connector names a server without registration: ${noRegistration}; it got ${describe(sent)} (want our message, no authorization and no token request)`,
	);

	// --- Case 5: a configured client_credentials client ---
	namedAuthServer = authA.base;
	const machine = "client-credentials";
	authA.clients.set("machine-client", "machine-client-pass");
	configMod.writeSharedServerEntry(configMod.getPiGlobalConfigPath(), machine, { url: serverUrl, auth: "oauth", oauth: { grantType: "client_credentials", clientId: "machine-client", clientSecret: "machine-client-pass" } });
	await authFlow.startAuth(machine, serverUrl, entryOf(machine));
	let machineRun: string;
	try {
		machineRun = await connectThroughManager(machine);
	} catch (error) {
		machineRun = `threw: ${(error as Error).message}`;
	}
	check(machineRun.startsWith("connected"), `case 5 client_credentials, signed in and connected at A: ${machineRun}; ${storeSummary(machine)}`);
	expire(machine);
	namedAuthServer = authB.base;
	mark = authB.requests.length;
	try {
		machineRun = await connectThroughManager(machine);
	} catch (error) {
		machineRun = `threw: ${(error as Error).message}`;
	}
	const machineTest = await testShows(machine);
	sent = authB.requests.slice(mark);
	leaks = carrying(sent, ["machine-client-pass"]);
	check(leaks.length === 0, `case 5 client_credentials, after the switch to B: B got ${describe(sent)}; ${leaks.length} carrying the configured secret (${describe(leaks)}). The connector reports: ${machineRun}. The Test shows: ${machineTest}. Store left: ${storeSummary(machine)}`);

	mark = authB.requests.length;
	let machineSignIn: string;
	try {
		await withTimeout(authFlow.startAuth(machine, serverUrl, entryOf(machine)), "startAuth");
		machineSignIn = "signed in";
	} catch (error) {
		machineSignIn = `failed: ${(error as Error).message}`;
	}
	sent = authB.requests.slice(mark);
	check(machineSignIn.includes(`connector "${machine}" has changed`) && !sent.some((r) => r.path === "/token"), `case 5 client_credentials, a sign-in started while the connector names B: ${machineSignIn}; B got ${describe(sent)} (want our message and no token request)`);

	// --- Case 7: a 0.14.2 sign-in file holding a copied configured secret ---
	namedAuthServer = authA.base;
	const copied = "configured-saved-by-0142";
	await admin.addMcpServer({ name: copied, url: serverUrl, oauth: { clientId: "configured-client", clientSecret: "configured-client-pass" } });
	authA.refreshTokens.set("copied-refresh-0", "configured-client");
	authStore.updateClientInfo(copied, { clientId: "configured-client", clientSecret: "configured-client-pass", redirectUris: [`http://localhost:${CALLBACK_PORT}/callback`] }, serverUrl);
	authStore.updateTokens(copied, { accessToken: "copied-access-0", refreshToken: "copied-refresh-0", expiresAt: Math.floor(Date.now() / 1000) - 60 }, serverUrl);
	let copiedRun: string;
	try {
		copiedRun = await connectThroughManager(copied);
	} catch (error) {
		copiedRun = `threw: ${(error as Error).message}`;
	}
	const copiedClient = authStore.getAuthEntry(copied)?.clientInfo ?? {};
	check(
		copiedRun.startsWith("connected") && !secretInStore(copied) && copiedClient.clientId === "configured-client" && stampedForA(copiedClient.issuer),
		`case 7 0.14.2 copied secret, after the first refresh at A (${copiedRun}): the configured secret is ${secretInStore(copied) ? "in" : "not in"} tokens.json; client ${copiedClient.clientId ?? "none"} (issuer ${copiedClient.issuer ?? "none"})`,
	);

	// --- Case 8: a client ID added to the settings after a dynamic sign-in ---
	namedAuthServer = authA.base;
	const added = "client-id-added-later";
	await admin.addMcpServer({ name: added, url: serverUrl });
	await signIn(added);
	const staleClient = authStore.getAuthEntry(added)?.clientInfo?.clientId;
	configMod.writeSharedServerEntry(configMod.getPiGlobalConfigPath(), added, { url: serverUrl, auth: "oauth", oauth: { clientId: "configured-client", clientSecret: "configured-client-pass" } });
	let addedRun: string;
	try {
		await signIn(added);
		addedRun = "signed in";
	} catch (error) {
		addedRun = `failed: ${(error as Error).message}`;
	}
	const addedClient = authStore.getAuthEntry(added)?.clientInfo ?? {};
	check(
		addedRun === "signed in" && addedClient.clientId === "configured-client" && stampedForA(addedClient.issuer) && !secretInStore(added),
		`case 8 client ID added later, the next sign-in at A: ${addedRun}; the stored client went from ${staleClient ?? "none"} to ${addedClient.clientId ?? "none"} (issuer ${addedClient.issuer ?? "none"}), the configured secret is ${secretInStore(added) ? "in" : "not in"} tokens.json`,
	);

	await callbackMod.stopCallbackServer().catch(() => {});
	authA.close();
	authB.close();
	authC.close();
	connector.close();
	fs.rmSync(agentDir, { recursive: true, force: true });
	fs.rmSync(home, { recursive: true, force: true });
	if (failures.length) {
		console.error(`mcp oauth issuer smoke failed: ${failures.length} check(s)`);
		process.exit(1);
	}
	console.log("mcp oauth issuer smoke passed");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
