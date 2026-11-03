import { listPersistentAgents, PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID, PERSISTENT_AGENT_L1A_MODES, createPersistentAgentFromScaffoldInput, renamePersistentAgent, archivePersistentAgent, listArchivedPersistentAgents, getPersistentAgentLifecycleCounts, restorePersistentAgent, purgePersistentAgent } from "./persistent-agents.js";
import { createRoomModelCatalog } from "./room-models.js";
import { chooseLocalFolder, folderPickerPrompt } from "./local-folder-picker.js";
import { activeRoomLock } from "./server-install-root.js";
import { detachedCookingRooms, reattachBufferProbe, TEST_INTROSPECTION_ENABLED } from "./room-live-sessions.js";
import { app } from "./server-app.js";
import { isLocalSystemChooseFolderRequest, remoteRoomExposure } from "./request-checks.js";
import { roomModelsPayload } from "./ai-models.js";

app.post("/api/system/choose-folder", async (req, reply) => {
	if (!isLocalSystemChooseFolderRequest(req)) {
		return reply.code(403).send({ error: "Folder chooser is only available from the local Exxperts app.", code: "local_request_required", supported: false, cancelled: false });
	}
	// The client says what the folder is for, not what the dialog should say:
	// an unknown purpose is not an error, it just gets the workspace prompt.
	const purpose = (req.body as { purpose?: unknown } | null | undefined)?.purpose;
	const result = await chooseLocalFolder({ prompt: folderPickerPrompt(purpose) });
	if (result.ok) return { supported: result.supported, cancelled: result.cancelled, path: result.path };
	const statusCode = result.code === "unsupported_platform" ? 501 : result.code === "folder_chooser_unavailable" ? 503 : 500;
	return reply.code(statusCode).send({ error: result.error, code: result.code, supported: result.supported, cancelled: result.cancelled });
});

// `answeringDetached`: the web lock is held by a detached cooking
// turn with NO client attached, so the launcher card can offer stepping back
// in; a room genuinely open in another window keeps its lock-and-stay-out.
app.get("/api/persistent-agents", async (req) => {
	// Remote devices never see hidden rooms, in listings or anywhere else.
	const rows = (req as any).exxRemoteDevice ? listPersistentAgents().filter((agent) => !remoteRoomExposure.isHidden(agent.id)) : listPersistentAgents();
	// One read of the profiles and sign-ins for every room's model rows.
	const catalog = createRoomModelCatalog();
	return rows.map((agent) => ({ ...agent, models: roomModelsPayload(agent.id, catalog), activeLock: activeRoomLock(agent.id), answeringDetached: detachedCookingRooms.has(agent.id) }));
});

// Test-only (EXXPERTS_TEST_INTROSPECTION=1): the replay-buffer probe, so the
// smoke can assert the buffer's lifecycle (released at settle, overflow
// marked) from outside the process. Not registered in normal operation.
if (TEST_INTROSPECTION_ENABLED) {
	app.get("/api/persistent-agents/:id/reattach-buffer-stats", async (req) => {
		const id = String((req.params as { id: string }).id ?? "");
		return reattachBufferProbe.get(id) ?? { frames: 0, bytes: 0, overflowed: false };
	});
}

app.get("/api/persistent-agent-modes", async () => ({
	defaultModeId: PERSISTENT_AGENT_L1A_DEFAULT_MODE_ID,
	modes: PERSISTENT_AGENT_L1A_MODES.map((mode) => ({ id: mode.id, label: mode.label, description: mode.description })),
}));

app.post("/api/persistent-agents", async (req, reply) => {
	try {
		const result = createPersistentAgentFromScaffoldInput((req.body ?? {}) as any);
		// The status carries the model rows the way GET .../status does, so
		// Home can enter the new room on its conversation model at once.
		return reply.code(201).send({ ...result, status: { ...result.status, models: roomModelsPayload(result.agent.id) } });
	} catch (e) {
		const message = (e as Error).message;
		const explicitStatus = (e as any)?.statusCode;
		if (typeof explicitStatus === "number") return reply.code(explicitStatus).send({ error: message });
		const isClientError = /required|must be|invalid persistent agent id|could not allocate unique persistent agent id/i.test(message);
		return reply.code(isClientError ? 400 : 500).send({ error: message });
	}
});

app.post("/api/persistent-agents/:id/rename", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const body = (req.body ?? {}) as any;
		return renamePersistentAgent(idRaw, body.displayName, { dryRun: body.dryRun === true });
	} catch (e) {
		const message = (e as Error).message;
		// Only errors that carry a statusCode (renamePersistentAgent's own
		// validation) or fail id validation are the client's fault; anything
		// else is a server-side failure and must not echo raw fs errors (which
		// include absolute paths) to the browser.
		const statusCode = (e as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 500);
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-agent rename failed");
			return reply.code(statusCode).send({ error: "Renaming failed because of a server error. Check the server logs for details." });
		}
		return reply.code(statusCode).send({ error: message });
	}
});

app.post("/api/persistent-agents/:id/archive", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const body = (req.body ?? {}) as any;
		return archivePersistentAgent(idRaw, {
			confirmation: String(body.confirmation ?? ""),
			reason: typeof body.reason === "string" ? body.reason : undefined,
			// The detached-cooking set lives in this process; the archive guard has
			// to see it or a background answer could land into an archived room.
			detachedCooking: detachedCookingRooms.has(idRaw),
		});
	} catch (e) {
		const message = (e as Error).message;
		const statusCode = (e as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 500);
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-agent archive failed");
			return reply.code(statusCode).send({ error: "Archiving failed because of a server error. Check the server logs for details." });
		}
		// The machine-readable busy reason lets the client distinguish its own
		// just-released lock (worth a short retry) from a genuinely busy room.
		const reason = (e as any).purgeBusyReason;
		return reply.code(statusCode).send({ error: message, ...(reason ? { reason } : {}) });
	}
});

// The archived shadow of the room list: everything GET /api/persistent-agents
// hides. Counts only, no filesystem paths — the browser never learns roots.
app.get("/api/persistent-agents/archived", async (req) => {
	const rows = listArchivedPersistentAgents();
	return (req as any).exxRemoteDevice ? rows.filter((agent: { id: string }) => !remoteRoomExposure.isHidden(agent.id)) : rows;
});

app.get("/api/persistent-agents/:id/lifecycle-counts", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		// Null when a part could not be read: the page then says everything is deleted rather than a wrong 0.
		const { counts, complete } = getPersistentAgentLifecycleCounts(idRaw);
		return { agentId: idRaw, counts: complete ? counts : null };
	} catch (e) {
		const message = (e as Error).message;
		const statusCode = (e as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 500);
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-agent lifecycle-counts failed");
			return reply.code(statusCode).send({ error: "Counting the room's contents failed because of a server error. Check the server logs for details." });
		}
		return reply.code(statusCode).send({ error: message });
	}
});

app.post("/api/persistent-agents/:id/restore", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		return restorePersistentAgent(idRaw);
	} catch (e) {
		const message = (e as Error).message;
		const statusCode = (e as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 500);
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-agent restore failed");
			return reply.code(statusCode).send({ error: "Restoring failed because of a server error. Check the server logs for details." });
		}
		return reply.code(statusCode).send({ error: message });
	}
});

app.post("/api/persistent-agents/:id/purge", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const body = (req.body ?? {}) as any;
		return purgePersistentAgent(idRaw, {
			confirmation: String(body.confirmation ?? ""),
			// The detached-cooking set lives in this process; the purge guard has
			// to see it or a background answer could land into a deleted room.
			detachedCooking: detachedCookingRooms.has(idRaw),
		});
	} catch (e) {
		const message = (e as Error).message;
		const statusCode = (e as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 500);
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-agent purge failed");
			return reply.code(statusCode).send({ error: "Deleting failed because of a server error. Check the server logs for details." });
		}
		// The machine-readable busy reason lets the client distinguish its own
		// just-released lock (worth a short retry) from a genuinely busy room.
		const reason = (e as any).purgeBusyReason;
		return reply.code(statusCode).send({ error: message, ...(reason ? { reason } : {}) });
	}
});
