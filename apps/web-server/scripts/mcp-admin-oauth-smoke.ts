// Smoke: adding an MCP connector with a pre-registered OAuth client persists
// an entry the adapter's auth flow consumes directly (auth: "oauth" + oauth
// config), and the input validation rejects the ambiguous combinations.
// Providers without dynamic client registration (HubSpot and most
// enterprise IdPs) only work through this path.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exx-mcp-oauth-smoke-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { addMcpServer, McpAdminError } = await import("../src/mcp-admin.js");

	// Static OAuth client persists with auth: "oauth" and only the set fields.
	const added = await addMcpServer({
		name: "hubspot",
		url: "https://mcp.hubspot.com/anthropic",
		oauth: { clientId: "abc-123", clientSecret: "shh", scope: "crm.objects.contacts.read" },
	});
	const config = JSON.parse(fs.readFileSync(added.path, "utf-8"));
	const entry = config.mcpServers.hubspot;
	assert.equal(entry.auth, "oauth");
	assert.deepEqual(entry.oauth, { clientId: "abc-123", clientSecret: "shh", scope: "crm.objects.contacts.read" });
	assert.equal(entry.bearerToken, undefined);

	// Client ID alone is enough; empty optional fields are not persisted.
	await addMcpServer({ name: "id-only", url: "https://example.com/mcp", oauth: { clientId: "public-client", clientSecret: "  ", scope: "" } });
	const idOnly = JSON.parse(fs.readFileSync(added.path, "utf-8")).mcpServers["id-only"];
	assert.deepEqual(idOnly.oauth, { clientId: "public-client" });

	// Without a client ID the entry stays a plain URL connector (auto OAuth).
	await addMcpServer({ name: "plain", url: "https://example.com/mcp", oauth: {} });
	const plain = JSON.parse(fs.readFileSync(added.path, "utf-8")).mcpServers.plain;
	assert.equal(plain.auth, undefined);
	assert.equal(plain.oauth, undefined);

	// A token is standard bearer auth.
	await addMcpServer({ name: "generic-token", url: "https://example.com/mcp", bearerToken: "tok-123" });
	const generic = JSON.parse(fs.readFileSync(added.path, "utf-8")).mcpServers["generic-token"];
	assert.equal(generic.auth, "bearer");
	assert.equal(generic.bearerToken, "tok-123");
	assert.equal(generic.headers, undefined);

	// A key in its own header, written into the config file by hand, comes
	// with auth: false to switch off OAuth auto-detect.
	const withHeader = JSON.parse(fs.readFileSync(added.path, "utf-8"));
	withHeader.mcpServers["header-key"] = { url: "https://example.com/mcp", auth: false, headers: { "X-Api-Key": "key-123" } };
	fs.writeFileSync(added.path, JSON.stringify(withHeader, null, 2));

	// Status marks the custom client as explicit OAuth (drives "Login
	// required" + the login button even when tools list unauthenticated);
	// auto-detect entries stay non-explicit.
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const status = await getMcpConnectorsStatus();
	const hubspotStatus = status.servers.find((s: { name: string }) => s.name === "hubspot");
	const plainStatus = status.servers.find((s: { name: string }) => s.name === "plain");
	assert.equal(hubspotStatus?.auth.explicit, true);
	assert.equal(hubspotStatus?.auth.hasStoredTokens, false);
	assert.equal(plainStatus?.auth.explicit, false);
	// The header-token entry reads as token auth, not "no login needed" and
	// not a loginable OAuth server.
	const headerStatus = status.servers.find((s: { name: string }) => s.name === "header-key");
	assert.equal(headerStatus?.auth.mode, "bearer");

	// Rejected combinations.
	await assert.rejects(
		addMcpServer({ name: "both", url: "https://example.com/mcp", bearerToken: "tok", oauth: { clientId: "x" } }),
		(e: unknown) => e instanceof McpAdminError && /not both/.test((e as Error).message),
	);
	await assert.rejects(
		addMcpServer({ name: "secret-only", url: "https://example.com/mcp", oauth: { clientSecret: "shh" } }),
		(e: unknown) => e instanceof McpAdminError && /client ID/.test((e as Error).message),
	);
	await assert.rejects(
		addMcpServer({ name: "local-oauth", command: "npx some-server", oauth: { clientId: "x" } }),
		(e: unknown) => e instanceof McpAdminError && /remote \(URL\) connectors/.test((e as Error).message),
	);

	fs.rmSync(agentDir, { recursive: true, force: true });
	console.log("mcp admin oauth smoke passed");
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
