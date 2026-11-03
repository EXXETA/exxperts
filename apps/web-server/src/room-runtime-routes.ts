import { getPersistentAgentRuntimeState, getPersistentAgentThread, writePersistentAgentRuntimeState, discardEmptyPreparedBoundaryThread } from "./persistent-agents.js";
import { listTaskLedgerRecords, markTaskLedgerRecordViewed, markTaskLedgerRecordRemoved, clearTaskLedgerRecordRemoved, markTaskLedgerRecordDeleted } from "./persistent-room-task-ledger.js";
import { collectProtectedTaskIds, executeTaskStoreGc, assessTaskStoreGc } from "./specialist-task-store-gc.js";
import { listPromptAssemblyManifests } from "./prompt-diagnostics-store.js";
import { app } from "./server-app.js";
import { isLocalPromptDiagnosticsRequest, isPromptDiagnosticsEnabled } from "./request-checks.js";
import { parsePromptDiagnosticsSurface } from "./room-prompt-diagnostics.js";
import { getUsablePersistentAgentStatusForNormalUse, persistentAgentNormalUseErrorReply } from "./room-status.js";

app.get("/api/persistent-agents/:id/prompt-diagnostics", async (req, reply) => {
	if (!isPromptDiagnosticsEnabled() || !isLocalPromptDiagnosticsRequest(req)) return reply.code(404).send({ error: "not found" });
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const query = (req.query ?? {}) as any;
		const conversationId = String(query.conversationId ?? "").trim() || undefined;
		const surface = parsePromptDiagnosticsSurface(query.surface);
		const filters = { ...(conversationId ? { conversationId } : {}), ...(surface ? { surface } : {}) };
		return {
			enabled: true,
			agentId: id,
			filters,
			manifests: listPromptAssemblyManifests({ agentId: id, conversationId, surface }),
		};
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.get("/api/persistent-agents/:id/runtime", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return { runtime: getPersistentAgentRuntimeState(status.id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.patch("/api/persistent-agents/:id/runtime", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		// The runtime model is the active conversation's own lock, whatever the
		// client names: the server decides which model a conversation runs on.
		const activeThreadId = body.state === "idle" ? undefined : String(body.activeThreadId ?? getPersistentAgentRuntimeState(status.id).activeThreadId ?? "").trim() || undefined;
		const lock = activeThreadId ? getPersistentAgentThread(status.id, activeThreadId)?.model : undefined;
		return { runtime: writePersistentAgentRuntimeState(status.id, { state: body.state, activeThreadId: body.activeThreadId, model: lock ?? body.model }) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/runtime/discard-empty-prepared-boundary", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		const threadId = String(body.threadId ?? body.conversationId ?? "").trim();
		return discardEmptyPreparedBoundaryThread(status.id, threadId);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Task-ledger list (assets contract §2, rung 2): the room's specialist-task
// history, newest-first, optionally narrowed to one conversation. Read-only
// projection of the per-task ledger files; the Assets panel consumes it.
app.get("/api/persistent-agents/:id/tasks", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const conversationId = String((req.query as any)?.conversationId ?? "").trim() || undefined;
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		// removedAt hides a row from the PANEL only (user's "Remove from list");
		// other ledger readers keep seeing it so chat items and provenance work.
		return { roomId: status.id, tasks: listTaskLedgerRecords(status.id, conversationId ? { conversationId } : {}).filter((record) => !record.removedAt) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// First-open stamp: the green unread dot decays
// exactly once — the client posts when the user first opens or acts on a row.
// Idempotent; a missing row is a 404, not an error worth surfacing.
app.post("/api/persistent-agents/:id/tasks/:taskId/viewed", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const taskId = String((req.params as any).taskId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const row = markTaskLedgerRecordViewed(status.id, taskId);
		if (!row) return reply.code(404).send({ error: "No such task in this room." });
		return { viewedAt: row.viewedAt };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Panel remove-from-list: a list operation only —
// the row gets a removedAt stamp, the panel listing hides it, files stay. The
// toast's Undo clears the stamp. Running rows must settle first.
app.post("/api/persistent-agents/:id/tasks/:taskId/removed", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const taskId = String((req.params as any).taskId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const row = listTaskLedgerRecords(status.id).find((record) => record.taskId === taskId);
		if (!row) return reply.code(404).send({ error: "No such task in this room." });
		if (row.outcome === "running") return reply.code(409).send({ error: "This task is still running.", code: "running" });
		const marked = markTaskLedgerRecordRemoved(status.id, taskId);
		return { removedAt: marked?.removedAt ?? null };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.delete("/api/persistent-agents/:id/tasks/:taskId/removed", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const taskId = String((req.params as any).taskId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const row = clearTaskLedgerRecordRemoved(status.id, taskId);
		if (!row) return reply.code(404).send({ error: "No such task in this room." });
		return { removedAt: null };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Panel per-task delete (assets contract §4): allowed only for rows this room
// owns that are not running and not referenced anywhere. Files go, the ledger
// row stays with a deletedAt stamp (measurement record).
app.delete("/api/persistent-agents/:id/tasks/:taskId", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const taskId = String((req.params as any).taskId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const row = listTaskLedgerRecords(status.id).find((record) => record.taskId === taskId);
		if (!row) return reply.code(404).send({ error: "No such task in this room." });
		if (row.outcome === "running") return reply.code(409).send({ error: "This task is still running.", code: "running" });
		if (collectProtectedTaskIds().has(taskId)) return reply.code(409).send({ error: "This task is referenced by a conversation and cannot be deleted.", code: "referenced" });
		const result = executeTaskStoreGc([taskId]);
		if (result.deleted.includes(taskId)) return { deleted: true, reclaimedBytes: result.reclaimedBytes };
		// The folder may already be gone (crash between rm and stamp) — stamp anyway.
		markTaskLedgerRecordDeleted(status.id, taskId);
		return { deleted: true, reclaimedBytes: 0 };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Store-wide GC (assets contract §4): assessment is read-only; execution
// deletes exactly the ids the client names, re-verified server-side.
app.get("/api/task-store/gc", async () => {
	return assessTaskStoreGc();
});

app.post("/api/task-store/gc", async (req, reply) => {
	const body = (req.body ?? {}) as { taskIds?: unknown };
	if (!Array.isArray(body.taskIds) || body.taskIds.length === 0) return reply.code(400).send({ error: "taskIds is required." });
	if (body.taskIds.length > 500) return reply.code(400).send({ error: "Too many taskIds in one request." });
	return executeTaskStoreGc(body.taskIds.map((value) => String(value ?? "")));
});

app.get("/api/persistent-agents/:id/threads/:threadId", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	const threadId = String((req.params as any).threadId ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const thread = getPersistentAgentThread(status.id, threadId);
		if (!thread) return reply.code(404).send({ error: "persistent-agent thread not found" });
		return { thread };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});
