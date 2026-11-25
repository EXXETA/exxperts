// Smoke: adding an MCP connector with a pre-registered OAuth client persists
// an entry the adapter's auth flow consumes directly (auth: "oauth" + oauth
// config), and the input validation rejects the ambiguous combinations.
// Providers without dynamic client registration (HubSpot and most
// enterprise IdPs) only work through this path.
//
// A sign-in the service refuses, through the adapter's real flow against a
// stand-in service, ends by the standard's code, whether the service sent a
// description or not: the person's own No as "declined", a busy service as
// "busy", the rest as "refused". The browser tab's page says in plain words
// that the sign-in didn't finish and to go back to exxperts, with the
// service's description, never its code beside it. The browser is a stand-in
// on the PATH that follows the sign-in's page and keeps the tab's text, so no
// real browser opens (Mac and Linux; skipped on Windows, where the adapter
// starts rundll32.exe by its full path, which no stand-in on the PATH replaces).

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { CONNECTOR_FORM_LINES } from "../src/connector-form.js";

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
		(e: unknown) => e instanceof McpAdminError && (e as Error).message === CONNECTOR_FORM_LINES.keyAndSignInApp,
	);
	await assert.rejects(
		addMcpServer({ name: "secret-only", url: "https://example.com/mcp", oauth: { clientSecret: "shh" } }),
		(e: unknown) => e instanceof McpAdminError && (e as Error).message === CONNECTOR_FORM_LINES.clientIdMissing,
	);
	await assert.rejects(
		addMcpServer({ name: "local-oauth", command: "npx some-server", oauth: { clientId: "x" } }),
		(e: unknown) => e instanceof McpAdminError && /remote \(URL\) connectors/.test((e as Error).message),
	);

	if (process.platform === "win32") console.log("mcp admin oauth smoke: the refused sign-ins skipped on Windows, where the browser opens through rundll32.exe by its full path");
	else await refusedSignIns(agentDir);

	fs.rmSync(agentDir, { recursive: true, force: true });
	console.log("mcp admin oauth smoke passed");
}

/**
 * A service whose sign-in answers every request for a person's yes with the
 * refusal `refusal.next` names, and a browser that follows that page to the
 * app's own and keeps what the tab shows.
 */
async function refusedSignIns(agentDir: string): Promise<void> {
	const refusal = { next: "" };
	const service = http.createServer((req, res) => {
		req.resume().on("end", () => {
			const url = new URL(req.url ?? "/", base());
			if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ resource: `${base()}/mcp`, authorization_servers: [base()] }));
			if (url.pathname === "/.well-known/oauth-authorization-server") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ issuer: base(), authorization_endpoint: `${base()}/authorize`, token_endpoint: `${base()}/token`, registration_endpoint: `${base()}/register`, response_types_supported: ["code"], code_challenge_methods_supported: ["S256"] }));
			if (url.pathname === "/register") return void res.writeHead(201, { "content-type": "application/json" }).end(JSON.stringify({ client_id: "row-client", redirect_uris: ["http://localhost/callback"] }));
			if (url.pathname === "/token") return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ access_token: "row-access", token_type: "Bearer", expires_in: 3600 }));
			if (url.pathname === "/authorize") {
				const back = new URL(url.searchParams.get("redirect_uri") ?? "");
				// No refusal set: the person said yes.
				if (!refusal.next) {
					back.searchParams.set("code", "row-code");
					back.searchParams.set("state", url.searchParams.get("state") ?? "");
					return void res.writeHead(302, { location: back.toString() }).end();
				}
				const [code, description] = refusal.next.split(": ");
				back.searchParams.set("error", code);
				if (description) back.searchParams.set("error_description", description);
				back.searchParams.set("state", url.searchParams.get("state") ?? "");
				return void res.writeHead(302, { location: back.toString() }).end();
			}
			res.writeHead(401, { "content-type": "text/plain", "www-authenticate": `Bearer resource_metadata="${base()}/.well-known/oauth-protected-resource/mcp"` }).end("sign in first");
		});
	});
	await new Promise<void>((resolve) => service.listen(0, "127.0.0.1", resolve));
	function base(): string {
		return `http://127.0.0.1:${(service.address() as AddressInfo).port}`;
	}
	// The browser: `open` on a Mac and `xdg-open` elsewhere, each first on the PATH. It tries every address a name has, as a browser does.
	const browserBin = path.join(agentDir, "row-browser");
	const tabs = path.join(agentDir, "row-tabs");
	fs.mkdirSync(browserBin);
	fs.mkdirSync(tabs);
	const browser = `#!${process.execPath}
const dns = require("node:dns");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
// fetch leaves out ::1 on a computer with no IPv6 beyond loopback.
const everyAddress = (host, options, done) => dns.lookup(host, { all: true }, done);
const open = (url) => http.get(url, { autoSelectFamily: true, lookup: everyAddress }, (answer) => {
	if (answer.headers.location) return answer.resume() && open(answer.headers.location);
	let text = "";
	answer.setEncoding("utf8").on("data", (chunk) => { text += chunk; }).on("end", () => fs.writeFileSync(path.join(${JSON.stringify(tabs)}, Date.now() + ".html"), text));
});
open(process.argv[process.argv.length - 1]);
`;
	for (const name of ["open", "xdg-open"]) fs.writeFileSync(path.join(browserBin, name), browser, { mode: 0o755 });
	const shownPath = process.env.PATH;
	process.env.PATH = `${browserBin}${path.delimiter}${shownPath ?? ""}`;
	const { addMcpServer, getMcpServerLoginState, startMcpServerLogin } = await import("../src/mcp-admin.js");
	try {
		/** Starts a sign-in to a new connector of the stand-in and waits for its end and for the tab the browser kept. */
		const signInWith = async (name: string, sent: string) => {
			await addMcpServer({ name, url: `${base()}/mcp` });
			refusal.next = sent;
			const before = new Set(fs.readdirSync(tabs));
			await startMcpServerLogin(name);
			const deadline = Date.now() + 20_000;
			let state = getMcpServerLoginState(name);
			while (state.pending && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 100));
				state = getMcpServerLoginState(name);
			}
			let tab = "";
			while (!tab && Date.now() < deadline) {
				const shown = fs.readdirSync(tabs).find((file) => !before.has(file));
				if (shown) tab = fs.readFileSync(path.join(tabs, shown), "utf-8");
				else await new Promise((resolve) => setTimeout(resolve, 100));
			}
			return { state, tab };
		};
		const signedIn = await signInWith("accepting", "");
		assert.ok(!signedIn.state.pending && signedIn.state.cause === undefined, `a sign-in the person accepts ends with no failure, got ${JSON.stringify(signedIn.state)}`);
		assert.ok(signedIn.tab.includes("<h1>Signed in</h1>") && signedIn.tab.includes("You can close this tab and go back to exxperts."), `the tab says it signed in and to go back to exxperts, got ${signedIn.tab.slice(-600)}`);
		const cases: Array<[string, string]> = [
			["access_denied", "declined"],
			["access_denied: The user said no", "declined"],
			["server_error", "busy"],
			["temporarily_unavailable: Back in a minute", "busy"],
			["invalid_target", "refused"],
			["invalid_target: That resource is not allowed", "refused"],
		];
		for (const [index, [sent, cause]] of cases.entries()) {
			const { state, tab } = await signInWith(`refusing-${index}`, sent);
			assert.equal(state.cause, cause, `the refusal ${JSON.stringify(sent)} ends as ${cause}, got ${JSON.stringify(state)}`);
			// The tab: plain words, then the service's description, or its code where it sent nothing else; never both.
			assert.ok(tab.includes("<h1>Sign-in didn't finish</h1>") && tab.includes("Go back to exxperts to see why."), `the tab says the sign-in didn't finish and to go back to exxperts (${JSON.stringify(sent)}), got ${tab.slice(-600)}`);
			assert.ok(!/Authorization failed|An error occurred during authorization/.test(tab), `the tab's old words are gone (${JSON.stringify(sent)})`);
			const [code, description] = sent.split(": ");
			const box = /<div class="details">([^<]*)<\/div>/.exec(tab)?.[1] ?? null;
			assert.equal(box, description ?? code, `the tab's small box shows the service's description, else its code, never both (${JSON.stringify(sent)})`);
			// The code rides on the error beside its words: the page's Technical details read as the tab's box does.
			assert.equal(state.detail, description ?? code, `the refusal's details are the service's description, else its code (${JSON.stringify(sent)})`);
		}
	} finally {
		process.env.PATH = shownPath;
		service.closeAllConnections();
		service.close();
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
