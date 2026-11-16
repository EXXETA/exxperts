import { startRefusalLookup } from "./connector-start-check.js";
import { getMcpConnectorsStatus } from "./mcp-status.js";
import { revokeMcpConnectorFromAllRooms } from "./persistent-room-mcp-settings.js";
import { McpAdminError, addMcpServer, type AddMcpServerInput, changeMcpServerAddress, type ChangeMcpServerAddressInput, removeMcpServer, startMcpServerLogin, getMcpServerLoginState, cancelMcpServerLogin, logoutMcpServer, testMcpServer } from "./mcp-admin.js";
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

app.delete("/api/mcp/servers/:name", async (req, reply) => {
	try {
		const name = String((req.params as { name: string }).name);
		// Grant identity rule: deleting a connector revokes it from every room,
		// so a later re-created connector with the same name starts ungranted.
		// The sweep runs BEFORE the config mutation: a crash between the two
		// then leaves the connector configured with its grants gone
		// (fail-closed, user re-deletes), never a deleted connector whose
		// grants linger for a namesake to inherit. Sweep failures are reported,
		// not swallowed.
		const revokeSweep = revokeMcpConnectorFromAllRooms(name);
		for (const failure of revokeSweep.failures) {
			app.log.warn({ agentId: failure.agentId, err: failure.error }, "connector delete: revoking the grant in a room failed");
		}
		const removed = await removeMcpServer(name);
		return { ...removed, revokedFromRooms: revokeSweep.revokedFrom, ...(revokeSweep.failures.length > 0 ? { revokeFailures: revokeSweep.failures } : {}) };
	} catch (e) {
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
		return await testMcpServer(String((req.params as { name: string }).name));
	} catch (e) {
		return sendMcpAdminError(reply, e, "Failed to test the connector.");
	}
});
