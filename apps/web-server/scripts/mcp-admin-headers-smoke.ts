// Smoke: custom headers on a remote connector, as the Custom connector form
// sends them. Some servers expect their key in a header of its own (X-Api-Key)
// instead of a bearer token or a login. The headers are checked before they
// reach the config file, a key in its own header switches off OAuth
// auto-detect (as one written into the file by hand does), and the real
// adapter then sends them to the server, which a local stand-in records.

import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";

async function main(): Promise<void> {
	const agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "exx-mcp-headers-smoke-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const { addMcpServer, McpAdminError, testMcpServer } = await import("../src/mcp-admin.js");
	const { getMcpConnectorsStatus } = await import("../src/mcp-status.js");
	const entryOf = (name: string, file: string) => JSON.parse(fs.readFileSync(file, "utf-8")).mcpServers[name];

	try {
		// A key in its own header: kept, and OAuth auto-detect off.
		const added = await addMcpServer({ name: "keyed", url: "https://example.com/mcp", headers: { " X-Api-Key ": " key-123 " } });
		assert.deepEqual(entryOf("keyed", added.path), { url: "https://example.com/mcp", auth: false, headers: { "X-Api-Key": "key-123" } });

		// A header that is not a credential leaves auto-detect on.
		await addMcpServer({ name: "tenant", url: "https://example.com/mcp", headers: { "X-Tenant": "acme" } });
		assert.deepEqual(entryOf("tenant", added.path), { url: "https://example.com/mcp", headers: { "X-Tenant": "acme" } });

		// Next to the API token and next to an OAuth client.
		await addMcpServer({ name: "token-and-header", url: "https://example.com/mcp", bearerToken: "tok-1", headers: { "X-Workspace": "w1" } });
		assert.deepEqual(entryOf("token-and-header", added.path), { url: "https://example.com/mcp", auth: "bearer", bearerToken: "tok-1", headers: { "X-Workspace": "w1" } });
		await addMcpServer({ name: "client-and-header", url: "https://example.com/mcp", oauth: { clientId: "c1" }, headers: { "X-Workspace": "w1" } });
		assert.deepEqual(entryOf("client-and-header", added.path), { url: "https://example.com/mcp", auth: "oauth", oauth: { clientId: "c1" }, headers: { "X-Workspace": "w1" } });

		// A custom Authorization scheme works on its own.
		await addMcpServer({ name: "scheme", url: "https://example.com/mcp", headers: { Authorization: "Token abc" } });
		assert.equal(entryOf("scheme", added.path).auth, false);

		// Whole words decide what counts as the sign-in.
		const { isCredentialHeaderName } = await import("../src/mcp-status.js");
		for (const name of ["X-Api-Key", "Api-Key", "apikey", "X-Auth-Token", "Authorization", "X-Client-Secret"]) assert.ok(isCredentialHeaderName(name), `${name} is a sign-in`);
		for (const name of ["Idempotency-Key", "X-Tenant", "Notion-Version", "X-Keystone", "Monkey"]) assert.ok(!isCredentialHeaderName(name), `${name} is not a sign-in`);
		await addMcpServer({ name: "idempotent", url: "https://example.com/mcp", headers: { "Idempotency-Key": "abc" } });
		assert.equal(entryOf("idempotent", added.path).auth, undefined, "an ordinary header leaves the login on");

		// No headers, or only empty ones, leave the entry as it always was.
		await addMcpServer({ name: "plain", url: "https://example.com/mcp", headers: {} });
		assert.deepEqual(entryOf("plain", added.path), { url: "https://example.com/mcp" });

		// What is refused, in words, and never written.
		const refusals: Array<[string, Parameters<typeof addMcpServer>[0], RegExp]> = [
			["line break", { name: "r1", url: "https://example.com/mcp", headers: { "X-Api-Key": "key\r\nX-Evil: 1" } }, /line break/],
			["tab", { name: "r2", url: "https://example.com/mcp", headers: { "X-Api-Key": "a\tb" } }, /control character/],
			["host", { name: "r3", url: "https://example.com/mcp", headers: { Host: "evil.example" } }, /set by the connection itself/],
			["content type", { name: "r4", url: "https://example.com/mcp", headers: { "content-type": "text/plain" } }, /set by the connection itself/],
			["session", { name: "r5", url: "https://example.com/mcp", headers: { "Mcp-Session-Id": "x" } }, /set by the connection itself/],
			["authorization twice", { name: "r6", url: "https://example.com/mcp", bearerToken: "tok", headers: { authorization: "Token x" } }, /not both/],
			["authorization with a client", { name: "r7", url: "https://example.com/mcp", oauth: { clientId: "c" }, headers: { Authorization: "Token x" } }, /not both/],
			["same name twice", { name: "r8", url: "https://example.com/mcp", headers: { "X-Key": "a", "x-key": "b" } }, /listed twice/],
			["bad name", { name: "r9", url: "https://example.com/mcp", headers: { "X Key": "a" } }, /not a valid header name/],
			["empty name", { name: "r10", url: "https://example.com/mcp", headers: { "": "a" } }, /not a valid header name/],
			["empty value", { name: "r11", url: "https://example.com/mcp", headers: { "X-Key": "  " } }, /needs a value/],
			["too long", { name: "r12", url: "https://example.com/mcp", headers: { "X-Key": "a".repeat(4097) } }, /too long/],
			["too many", { name: "r13", url: "https://example.com/mcp", headers: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`X-H${i}`, "v"])) }, /at most 20/],
			["a list", { name: "r14", url: "https://example.com/mcp", headers: [["X-Key", "a"]] as unknown as Record<string, string> }, /list of names and values/],
			["a typographic dash", { name: "r16", url: "https://example.com/mcp", headers: { "X-Api-Key": "key\u2014123" } }, /cannot carry/],
			["not text", { name: "r17", url: "https://example.com/mcp", headers: { "X-Api-Key": { nested: true } as unknown as string } }, /must be text/],
			["a long bad name", { name: "r18", url: "https://example.com/mcp", headers: { ["bad name ".repeat(50)]: "a" } }, /^"bad name bad name bad name bad name bad " is not/],
			["a local command", { name: "r15", command: "node", args: ["server.js"], headers: { "X-Key": "a" } }, /only apply to remote/],
		];
		for (const [what, input, expected] of refusals) {
			await assert.rejects(addMcpServer(input), (err: unknown) => err instanceof McpAdminError && expected.test(err.message), `refused: ${what}`);
			assert.equal(entryOf(input.name, added.path), undefined, `nothing written for: ${what}`);
		}

		// The status shows a key in its own header as token sign-in and never
		// carries a header value back to the page.
		const status = await getMcpConnectorsStatus();
		const keyed = status.servers.find((s: { name: string }) => s.name === "keyed");
		assert.equal(keyed?.auth.mode, "bearer");
		assert.ok(!JSON.stringify(status).includes("key-123"), "no header value in the status");

		// The real adapter sends the saved headers to the server.
		const seen: http.IncomingHttpHeaders[] = [];
		const server = http.createServer((req, res) => {
			seen.push(req.headers);
			res.writeHead(401).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
			await addMcpServer({ name: "wire", url, bearerToken: "tok-wire", headers: { "X-Api-Key": "key-wire", "X-Tenant": "acme" } });
			const result = await testMcpServer("wire");
			assert.equal(result.ok, false);
			assert.ok(seen.length > 0, "the server was asked");
			for (const headers of seen) {
				assert.equal(headers["x-api-key"], "key-wire", "every request carries the custom header");
				assert.equal(headers["x-tenant"], "acme");
				assert.equal(headers.authorization, "Bearer tok-wire", "next to the API token");
			}
		} finally {
			server.closeAllConnections();
			server.close();
		}
		console.log("mcp admin headers smoke: ok");
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
}

main().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
