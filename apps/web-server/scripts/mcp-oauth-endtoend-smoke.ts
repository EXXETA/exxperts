// Full-chain smoke for the custom OAuth client path: a fake provider whose
// auth server has NO dynamic client registration (HubSpot's shape) — static
// client only. Drives the adapter's real machinery end to end: discovery →
// authorization redirect (smoke plays the browser) → loopback callback →
// PKCE code exchange → authenticated tools/list AND tools/call. Proves the
// last inch a UI test can't reach without a real provider account.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exx-mcp-e2e-smoke-"));
process.env.PI_CODING_AGENT_DIR = agentDir;

// The adapter reads the loopback-callback port at module load. Use a free
// one so the smoke never collides with a running exxperts instance (which
// holds the default 19876 once anyone logs in to a connector).
const CALLBACK_PORT = await new Promise<number>((resolve) => {
	const probe = http.createServer();
	probe.listen(0, "127.0.0.1", () => {
		const port = (probe.address() as { port: number }).port;
		probe.close(() => resolve(port));
	});
});
process.env.MCP_OAUTH_CALLBACK_PORT = String(CALLBACK_PORT);

const CLIENT_ID = "smoke-client-id";
const CLIENT_SECRET = "smoke-client-secret";
const ACCESS_TOKEN = `tok_${crypto.randomBytes(12).toString("hex")}`;
const AUTH_CODE = `code_${crypto.randomBytes(12).toString("hex")}`;

interface Recorded {
	registrationAttempts: number;
	authorizeQuery: URLSearchParams | null;
	tokenRequestOk: boolean;
	listAuthHeader: string | null;
	callAuthHeader: string | null;
	pendingChallenge: string | null;
}
const seen: Recorded = { registrationAttempts: 0, authorizeQuery: null, tokenRequestOk: false, listAuthHeader: null, callAuthHeader: null, pendingChallenge: null };

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

function clientAuthorized(req: http.IncomingMessage, params: URLSearchParams): boolean {
	const basic = req.headers.authorization;
	if (basic?.startsWith("Basic ")) {
		const [id, secret] = Buffer.from(basic.slice(6), "base64").toString().split(":");
		return decodeURIComponent(id) === CLIENT_ID && decodeURIComponent(secret) === CLIENT_SECRET;
	}
	return params.get("client_id") === CLIENT_ID && params.get("client_secret") === CLIENT_SECRET;
}

const provider = http.createServer(async (req, res) => {
	const url = new URL(req.url ?? "/", `http://localhost:${(provider.address() as { port: number }).port}`);
	const base = `http://localhost:${(provider.address() as { port: number }).port}`;

	if (url.pathname.includes("register")) {
		seen.registrationAttempts += 1;
		json(res, 404, { error: "dynamic client registration is not supported" });
		return;
	}
	if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
		json(res, 200, { resource: `${base}/mcp`, authorization_servers: [base] });
		return;
	}
	if (url.pathname.startsWith("/.well-known/oauth-authorization-server") || url.pathname.startsWith("/.well-known/openid-configuration")) {
		// Deliberately NO registration_endpoint: static clients only.
		json(res, 200, {
			issuer: base,
			authorization_endpoint: `${base}/authorize`,
			token_endpoint: `${base}/token`,
			response_types_supported: ["code"],
			grant_types_supported: ["authorization_code"],
			code_challenge_methods_supported: ["S256"],
		});
		return;
	}
	if (url.pathname === "/authorize") {
		seen.authorizeQuery = url.searchParams;
		if (url.searchParams.get("client_id") !== CLIENT_ID) {
			json(res, 400, { error: "unknown client" });
			return;
		}
		seen.pendingChallenge = url.searchParams.get("code_challenge");
		const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
		redirect.searchParams.set("code", AUTH_CODE);
		redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
		res.writeHead(302, { location: redirect.toString() });
		res.end();
		return;
	}
	if (url.pathname === "/token" && req.method === "POST") {
		const params = new URLSearchParams(await readBody(req));
		const verifier = params.get("code_verifier") ?? "";
		const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
		if (params.get("grant_type") !== "authorization_code" || params.get("code") !== AUTH_CODE || !clientAuthorized(req, params) || challenge !== seen.pendingChallenge) {
			json(res, 400, { error: "invalid_grant" });
			return;
		}
		seen.tokenRequestOk = true;
		json(res, 200, { access_token: ACCESS_TOKEN, token_type: "Bearer", expires_in: 3600 });
		return;
	}
	if (url.pathname === "/mcp" && req.method === "POST") {
		const body = await readBody(req);
		const message = JSON.parse(body) as { id?: number; method?: string; params?: { name?: string; arguments?: { text?: string } } };
		if (req.headers.authorization !== `Bearer ${ACCESS_TOKEN}`) {
			json(res, 401, { error: "unauthorized" }, { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` });
			return;
		}
		if (message.method === "initialize") {
			json(res, 200, { id: message.id, jsonrpc: "2.0", result: { protocolVersion: (message as { params?: { protocolVersion?: string } }).params?.protocolVersion ?? "2025-06-18", capabilities: { tools: { listChanged: false } }, serverInfo: { name: "smoke-provider", version: "1" } } });
			return;
		}
		if (message.method === "notifications/initialized") {
			res.writeHead(202).end();
			return;
		}
		if (message.method === "tools/list") {
			seen.listAuthHeader = req.headers.authorization ?? null;
			json(res, 200, { id: message.id, jsonrpc: "2.0", result: { tools: [{ name: "echo", description: "Echo text back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
			return;
		}
		if (message.method === "tools/call") {
			seen.callAuthHeader = req.headers.authorization ?? null;
			assert.equal(message.params?.name, "echo");
			json(res, 200, { id: message.id, jsonrpc: "2.0", result: { content: [{ type: "text", text: `echo:${message.params?.arguments?.text ?? ""}` }] } });
			return;
		}
		json(res, 200, { id: message.id, jsonrpc: "2.0", result: {} });
		return;
	}
	json(res, 404, { error: "not found" });
});

async function fetchCallback(url: string): Promise<Response> {
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

async function main(): Promise<void> {
	await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
	const base = `http://localhost:${(provider.address() as { port: number }).port}`;
	const serverUrl = `${base}/mcp`;
	const name = "hubspot-shaped";

	const { addMcpServer } = await import("../src/mcp-admin.js");
	const added = await addMcpServer({ name, url: serverUrl, oauth: { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET } });
	const entry = JSON.parse(fs.readFileSync(added.path, "utf-8")).mcpServers[name];

	// The adapter's REAL auth flow, exactly as authenticate() runs it — minus
	// the browser open; the smoke plays the browser against /authorize.
	const authFlow = await import("pi-mcp-adapter/mcp-auth-flow.ts" as string);
	const authStore = await import("pi-mcp-adapter/mcp-auth.ts" as string);
	const callbackMod = await import("pi-mcp-adapter/mcp-callback-server.ts" as string);

	const { authorizationUrl } = await authFlow.startAuth(name, serverUrl, entry);
	assert.ok(authorizationUrl, "startAuth must produce an authorization URL for a static client");
	const oauthState = authStore.getOAuthState(name);
	assert.ok(oauthState, "OAuth state must be stored");
	const callbackPromise = callbackMod.waitForCallback(oauthState);

	const authorizeResponse = await fetch(authorizationUrl, { redirect: "manual" });
	assert.equal(authorizeResponse.status, 302);
	const location = authorizeResponse.headers.get("location");
	assert.ok(location?.startsWith(`http://localhost:${CALLBACK_PORT}/callback`), `callback redirect expected, got ${location}`);
	// The callback server binds the hostname "localhost", which resolves to a
	// single address family and not always the one fetch picks (Linux binds
	// ::1 while fetch connects 127.0.0.1). A browser handles this; the smoke
	// tries both loopback literals.
	await fetchCallback(location!);
	const code = await callbackPromise;
	assert.equal(code, AUTH_CODE);
	await authFlow.completeAuth(name, code);

	assert.equal(authStore.hasStoredTokens(name), true, "tokens must be stored after the exchange");
	assert.equal(seen.registrationAttempts, 0, "dynamic client registration must never be attempted");
	assert.equal(seen.authorizeQuery?.get("client_id"), CLIENT_ID);
	assert.equal(seen.tokenRequestOk, true, "token exchange must validate the static client + PKCE");

	// Authenticated list through the product's test path.
	const { testMcpServer } = await import("../src/mcp-admin.js");
	const test = await testMcpServer(name);
	assert.equal(test.ok, true, `test connection failed: ${test.error}`);
	assert.deepEqual(test.toolNames, ["echo"]);
	assert.equal(seen.listAuthHeader, `Bearer ${ACCESS_TOKEN}`, "tools/list must carry the issued token");

	// Authenticated CALL through the adapter's server manager — the last inch.
	const managerMod = await import("pi-mcp-adapter/server-manager.ts" as string);
	const manager = new managerMod.McpServerManager();
	try {
		const connection = await manager.connect(name, entry);
		const result = await connection.client.callTool({ name: "echo", arguments: { text: "full-chain" } });
		const text = (result.content as Array<{ type: string; text?: string }>)[0]?.text;
		assert.equal(text, "echo:full-chain");
		assert.equal(seen.callAuthHeader, `Bearer ${ACCESS_TOKEN}`, "tools/call must carry the issued token");
	} finally {
		await manager.closeAll().catch(() => {});
	}

	await callbackMod.stopCallbackServer().catch(() => {});
	provider.close();
	fs.rmSync(agentDir, { recursive: true, force: true });
	console.log("mcp oauth end-to-end smoke passed");
	process.exit(0);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
