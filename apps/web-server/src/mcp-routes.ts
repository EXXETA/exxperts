import { startRefusalLookup } from "./connector-start-check.js";
import { getMcpConnectorsStatus } from "./mcp-status.js";
import { McpAdminError, McpRoomsKeepConnectorError, addMcpServer, type AddMcpServerInput, changeMcpServerAddress, type ChangeMcpServerAddressInput, removeMcpServer, resetMcpToolChoices, setMcpServerToolChoices, type SetMcpServerToolChoicesInput, startMcpServerLogin, getMcpServerLoginState, cancelMcpServerLogin, logoutMcpServer, testMcpServer } from "./mcp-admin.js";
import { app } from "./server-app.js";
import { CONNECTOR_REQUEST_LINES } from "./connector-form.js";

app.get("/api/mcp/status", async (_req, reply) => {
	try {
		return await getMcpConnectorsStatus(startRefusalLookup);
	} catch (e) {
		app.log.warn({ err: (e as Error).message }, "failed to read MCP connector status");
		return reply.code(500).send({ error: CONNECTOR_REQUEST_LINES.loadFailed });
	}
});

function sendMcpAdminError(reply: { code: (c: number) => { send: (b: unknown) => unknown } }, e: unknown, fallback: string) {
	if (e instanceof McpAdminError) return reply.code(e.statusCode).send({ error: e.message });
	app.log.warn({ err: (e as Error).message }, fallback);
	return reply.code(500).send({ error: fallback });
}

app.post("/api/mcp/servers", async (req, reply) => {
	try {
		return await addMcpServer((req.body ?? {}) as AddMcpServerInput);
	} catch (e) {
		return sendMcpAdminError(reply, e, "Failed to add the connector.");
	}
});

// Takes the connector out of every room, then out of the app, or changes
// nothing: a refused or failed delete leaves it and every room's grant, and
// the same delete again tries again (removeMcpServer). The one exception: a
// failed write whose file then cannot be read leaves the grants gone, as no
// one can say the connector stayed.
app.delete("/api/mcp/servers/:name", async (req, reply) => {
	try {
		return await removeMcpServer(String((req.params as { name: string }).name));
	} catch (e) {
		if (e instanceof McpRoomsKeepConnectorError) {
			for (const failure of e.revokeFailures) {
				app.log.warn({ agentId: failure.agentId, err: failure.error }, "connector delete: revoking the grant in a room failed");
			}
			return reply.code(500).send({ error: e.message, revokeFailures: e.revokeFailures });
		}
		return sendMcpAdminError(reply, e, "Failed to remove the connector.");
	}
});

// A web connector's new address, and its key where the new address needs it.
// The connector keeps its name, so rooms keep their access.
app.put("/api/mcp/servers/:name/address", async (req, reply) => {
	try {
		return await changeMcpServerAddress(String((req.params as { name: string }).name), (req.body ?? {}) as ChangeMcpServerAddressInput);
	} catch (e) {
		return sendMcpAdminError(reply, e, CONNECTOR_REQUEST_LINES.saveFailed);
	}
});

// Each tool's choice on the connector's page: Always allow, Ask first, Blocked,
// or null to clear it. Always allow names the connector the page showed, and a
// connector that changed since answers 409.
app.put("/api/mcp/servers/:name/tools", async (req, reply) => {
	try {
		return await setMcpServerToolChoices(String((req.params as { name: string }).name), (req.body ?? {}) as SetMcpServerToolChoicesInput);
	} catch (e) {
		return sendMcpAdminError(reply, e, CONNECTOR_REQUEST_LINES.saveFailed);
	}
});

// Reset choices: a choices file that can't be read is set aside, and every
// tool of every connector goes back to its default (resetMcpToolChoices).
app.post("/api/mcp/tool-choices/reset", async (_req, reply) => {
	try {
		return resetMcpToolChoices();
	} catch (e) {
		return sendMcpAdminError(reply, e, CONNECTOR_REQUEST_LINES.choicesResetFailed);
	}
});

app.post("/api/mcp/servers/:name/login", async (req, reply) => {
	try {
		return await startMcpServerLogin(String((req.params as { name: string }).name));
	} catch (e) {
		return sendMcpAdminError(reply, e, CONNECTOR_REQUEST_LINES.signInStartFailed);
	}
});

app.get("/api/mcp/servers/:name/login", async (req) => {
	return getMcpServerLoginState(String((req.params as { name: string }).name));
});

app.delete("/api/mcp/servers/:name/login", async (req, reply) => {
	try {
		return await cancelMcpServerLogin(String((req.params as { name: string }).name));
	} catch (e) {
		return sendMcpAdminError(reply, e, "Failed to cancel the connector login.");
	}
});

app.post("/api/mcp/servers/:name/logout", async (req, reply) => {
	try {
		await logoutMcpServer(String((req.params as { name: string }).name));
		return { ok: true };
	} catch (e) {
		return sendMcpAdminError(reply, e, CONNECTOR_REQUEST_LINES.disconnectFailed);
	}
});

app.post("/api/mcp/servers/:name/test", async (req, reply) => {
	try {
		// The page stops a check by closing its request: the connection closes before the answer is sent.
		const stop = new AbortController();
		reply.raw.on("close", () => {
			if (!reply.raw.writableEnded) stop.abort();
		});
		return await testMcpServer(String((req.params as { name: string }).name), stop.signal);
	} catch (e) {
		return sendMcpAdminError(reply, e, "Failed to test the connector.");
	}
});
