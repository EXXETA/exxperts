import type { FastifyRequest } from "fastify";
import { MAINTENANCE_DIAGNOSTICS_KEEP, MAINTENANCE_DIAGNOSTICS_DEFAULT_LIMIT, listMaintenanceDiagnostics, exportMaintenanceDiagnostics } from "./maintenance-diagnostics.js";
import { createPersistentAgentInstance, saveWithOpenConversationCheck, getPersistentRoomInstructionsView, savePersistentRoomGlobalInstructionsEnabled, savePersistentRoomInstructions } from "./persistent-agents.js";
import { normalizePersistentRoomWorkspaceToolSelectionInput } from "./persistent-room-tool-policy.js";
import { PersistentRoomWorkspacePolicyError, assertPersistentRoomWorkspaceDefaultMutable, type PersistentRoomCapabilityPolicy, persistentRoomCapabilityPolicyView, readPersistentRoomCapabilityPolicy, PERSISTENT_ROOM_WORKSPACE_POLICY_STORAGE_SOURCE, deletePersistentRoomCapabilityPolicy, readPersistentRoomDefaultCapabilityPolicy, PERSISTENT_ROOM_WORKSPACE_DEFAULT_STORAGE_SOURCE, missingPersistentRoomWorkspaceRootWarnings, normalizePersistentRoomWorkspaceAccessModeInput, createPersistentRoomDefaultCapabilityPolicy, updatePersistentRoomCapabilityPolicyWorkspaceSettings, writePersistentRoomDefaultCapabilityPolicy, deletePersistentRoomDefaultCapabilityPolicy, createPersistentRoomCapabilityPolicy, writePersistentRoomCapabilityPolicy, persistentRoomCommandsStartOn, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID, resolvePersistentRoomEffectiveWorkspacePolicy } from "./persistent-room-workspace-policy.js";
import { readPersistentRoomMaintenanceSettings, writePersistentRoomMaintenanceSettings } from "./persistent-room-maintenance-settings.js";
import { settleMemoryBudget } from "./memory-entries-store.js";
import { readPersistentRoomBashSettings, unprotectedRoomOnAuto, writePersistentRoomBashSettings } from "./persistent-room-bash-settings.js";
import { type PersistentRoomProtection, type PersistentRoomProtectionCause, persistentRoomProtection, persistentRoomWindowsBoxed, writePersistentRoomProtection } from "./persistent-room-protection.js";
import { isRoomEffortLevel, readPersistentRoomEffortChoice, writePersistentRoomEffortChoice } from "./persistent-room-effort-settings.js";
import { persistentRoomShellFound, PERSISTENT_ROOM_SHELL_MISSING_SENTENCE } from "./persistent-room-shell-missing.js";
import { createRoomModelCatalog, resolveAiDefault, memoryModelTooSmallSentence, writeRoomModels } from "./room-models.js";
import { ROOM_INSTRUCTIONS_MAX_CHARS } from "./persistent-room-instructions.js";
import { readPersistentRoomSkillSettings, computeSkillStatuses, enablePersistentRoomSkill, disablePersistentRoomSkill } from "./persistent-room-skill-settings.js";
import { listConfiguredMcpConnectorDisplayNames, listConfiguredMcpConnectorNames } from "./mcp-status.js";
import { allowedToolsOf, readPersistentRoomMcpSettings, computeGrantedConnectorStatuses, forgetPersistentRoomMcpTool, grantPersistentRoomMcpConnector, type PersistentRoomMcpSettings, revokePersistentRoomMcpConnector, roomUsableMcpConnectors } from "./persistent-room-mcp-settings.js";
import { connectorToolWords } from "../../../pi-package/extensions/mcp/room-scope.js";
import { readConnectorToolChoices, toolChoiceIn } from "./connector-tool-choices.js";
import { buildRoomMemoryHistory } from "./memory-api.js";
import { registerMemoryEntryRoutes } from "./memory-entries-api.js";
import { undoMemorySave } from "./memory-undo.js";
import { withRoomSaveLock } from "./memory-commit.js";
import { isSharedServer } from "./server-hooks.js";
import { skillFilesReach } from "./persistent-room-skill-tool.js";
import { activeRoomLock, REPO_ROOT, roomLockBusyStatus } from "./server-install-root.js";
import { app } from "./server-app.js";
import { getUsablePersistentAgentStatusForNormalUse, persistentAgentNormalUseErrorReply } from "./room-status.js";
import { parseRoomModelPatch, roomModelsPayload } from "./ai-models.js";
import { memoryBudgetRaiseRefusal, refuseMemoryBudgetRaise, refuseMemoryModelTooSmall } from "./ai-profile-models.js";
import { resolveLibrarySkillManifest, skillLibraryFingerprint, withSkillDisplayNames } from "./skills-library.js";
import { addAlsoAllowedFolder, type AlsoAllowedEntry, readAlsoAllowed, removeAlsoAllowedEntry, removedAlsoAllowedEntry, restoreAlsoAllowedEntry } from "./room-box/also-allowed.js";
import { CHANGE_SAVE_FAILED, FOLDER_ALREADY_USED, FOLDER_PICK_REFUSED, folderRefusedLine, NO_FOLDER_WINDOW, pathHoldsHidden, PROTECTION_UNAVAILABLE, PROTECTION_UNAVAILABLE_COMPUTER, PROTECTION_UNAVAILABLE_FOLDER } from "./room-box/card-text.js";
import { folderGrantable, roomFolderRefusal, soundFolders, writeEntries } from "./room-box/folder-offer.js";
import { chooseFolderForRoom, undoAllowChanges } from "./room-box/folder-question.js";
import { isInside } from "./room-box/box-closed.js";
import { chooseLocalFolder, folderPickerPrompt, type LocalFolderPickerResult } from "./local-folder-picker.js";
import { roomFence } from "./room-files.js";
import { isLocalSystemChooseFolderRequest } from "./request-checks.js";
import path from "node:path";

function parsePersistentRoomWorkspaceMode(value: unknown): "read" | "write" {
	if (value == null || value === "") return "read";
	const mode = String(value).trim();
	if (mode === "read" || mode === "read-only") return "read";
	if (mode === "write") return mode;
	throw new Error("workspace mode must be read, read-only, or write");
}

function parsePersistentRoomWorkspaceSource(value: unknown): "manual" | "query-param" | "runtime-state" | "admin-dev" {
	if (value == null || value === "") return "manual";
	const source = String(value).trim();
	if (source === "manual" || source === "query-param" || source === "runtime-state" || source === "admin-dev") return source;
	throw new Error("workspace source must be manual, query-param, runtime-state, or admin-dev");
}

function persistentRoomWorkspaceErrorPayload(error: unknown): { statusCode: number; body: Record<string, unknown> } {
	if (error instanceof PersistentRoomWorkspacePolicyError) {
		return {
			statusCode: 400,
			body: {
				error: error.message,
				code: error.code,
				...(error.forbiddenRoot ? { forbiddenRoot: error.forbiddenRoot } : {}),
			},
		};
	}
	const statusCode = (error as any)?.statusCode ?? 400;
	return { statusCode, body: { error: error instanceof Error ? error.message : String(error), ...((error as any)?.code ? { code: (error as any).code } : {}) } };
}

// Whether this request may carry a full path from this computer: only a page
// on this computer, decided here per request, so a remote device or a shared
// server never receives one.
function requestGetsLocalPaths(req: FastifyRequest): boolean {
	return !(req as any).exxRemoteDevice && !isSharedServer();
}

function workspacePolicyViewFor(req: FastifyRequest, policy: PersistentRoomCapabilityPolicy) {
	return persistentRoomCapabilityPolicyView(policy, { withPaths: requestGetsLocalPaths(req) });
}

app.get("/api/persistent-agents/:id/workspace-policy", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const query = (req.query ?? {}) as any;
		const conversationId = String(query.conversationId ?? "").trim();
		if (!conversationId) throw new Error("conversationId is required");
		const policy = readPersistentRoomCapabilityPolicy(id, conversationId);
		return {
			agentId: id,
			conversationId,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_POLICY_STORAGE_SOURCE },
			policy: policy ? workspacePolicyViewFor(req, policy) : null,
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

app.delete("/api/persistent-agents/:id/workspace-policy", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const query = (req.query ?? {}) as any;
		const conversationId = String(query.conversationId ?? "").trim();
		if (!conversationId) throw new Error("conversationId is required");
		const result = deletePersistentRoomCapabilityPolicy(id, conversationId);
		return {
			agentId: id,
			conversationId,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_POLICY_STORAGE_SOURCE },
			policy: null,
			deleted: result.deleted,
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

// The numbers behind this room's maintenance runs: sizes, timings, stop
// reasons, which expected markers each reply carried, how the validator judged
// it. Never a prompt, a reply, or a line of the room's memory — so a user can
// send a failing run to be looked at without sending their memory with it.
app.get("/api/persistent-agents/:id/maintenance-diagnostics", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const query = (req.query ?? {}) as any;
		const requested = Number(query.limit);
		const limit = Number.isFinite(requested) && requested > 0 ? Math.min(Math.floor(requested), MAINTENANCE_DIAGNOSTICS_KEEP) : MAINTENANCE_DIAGNOSTICS_DEFAULT_LIMIT;
		const records = listMaintenanceDiagnostics(createPersistentAgentInstance(status.id).rootDir, limit);
		return { agentId: status.id, limit, recordCount: records.length, records };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The same records as one document, for attaching to a report.
app.get("/api/persistent-agents/:id/maintenance-diagnostics/export", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return exportMaintenanceDiagnostics(createPersistentAgentInstance(status.id).rootDir, status.id);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.get("/api/persistent-agents/:id/maintenance-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		settleMemoryBudget(status.id);
		const settings = readPersistentRoomMaintenanceSettings(status.id);
		return { agentId: status.id, settings };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/maintenance-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		// A dry run saves nothing: it answers with the refusal a save of that budget would get, or none, so Memory can ask again after the Memory model changes.
		if (body.dryRun === true) return { agentId: status.id, settings: readPersistentRoomMaintenanceSettings(status.id), budgetRefusal: memoryBudgetRaiseRefusal(status.id, body.memoryBudgetTokens) };
		refuseMemoryBudgetRaise(status.id, body.memoryBudgetTokens);
		const settings = writePersistentRoomMaintenanceSettings(status.id, { fastPathSecondApproval: body.fastPathSecondApproval, quickCheckpointAutoApply: body.quickCheckpointAutoApply, memoryBudgetTokens: body.memoryBudgetTokens });
		return { agentId: status.id, settings };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The room's memory, entry by entry: list, add, edit, pin, move, close,
// delete to the archive, restore, and the room's own memory history.
registerMemoryEntryRoutes(app, {
	usableRoom: (idRaw) => getUsablePersistentAgentStatusForNormalUse(idRaw),
	errorReply: (reply, error) => persistentAgentNormalUseErrorReply(reply, error),
	history: (idRaw) => buildRoomMemoryHistory(idRaw),
});

// Taking back the room's latest memory save: the file from before it, put back
// byte for byte. Every other refusal lives in the undo itself; the room lock is
// checked here, where it is read, exactly as Memento checks it.
app.post("/api/persistent-agents/:id/memory/undo", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		// A scheduled background run is working this room now; putting an
		// earlier memory back underneath it is the one thing undo
		// must never do. The room's own web session is not in the way: undo is
		// offered from that session.
		const roomLockState = activeRoomLock(status.id);
		if (roomLockState?.surface === "scheduler") {
			const error = new Error(`This room is ${roomLockBusyStatus(roomLockState)}. Wait for that to finish, then undo.`);
			(error as any).statusCode = 409;
			(error as any).code = "memory_undo_room_busy";
			throw error;
		}
		return await withRoomSaveLock(status.id, () => saveWithOpenConversationCheck(status.id, () => undoMemorySave(status.id, (req.body as any)?.saveId)));
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Per-room bash approval preference (workspace reshape slice e). The PUT is
// loopback-only at the remote route policy: a phone must never flip a room
// to run commands without asking.
app.get("/api/persistent-agents/:id/bash-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const settings = readPersistentRoomBashSettings(status.id);
		return { agentId: status.id, settings, ...protectionView(status.id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/bash-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		// The protection the chip last read: a yes is kept for the state the person saw, or refused. `free`: the chip's Auto in a protected room, beside its yes.
		const settings = writePersistentRoomBashSettings(status.id, { autoApprove: body.autoApprove, free: body.free, protection: body.protection });
		return { agentId: status.id, settings, ...protectionView(status.id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The model per room: what the room talks with and what does its memory work.
// GET answers both rows (stored, effective, and why they differ); PUT sets a
// row (a lock), clears it back to the default (null), or leaves it (absent).
// A lock that cannot run now is refused: the picker only offers what can.
// `effort` is the room's default reasoning effort for new conversations
// (null when it never chose); PUT sets it with a level, or leaves it (absent).
app.get("/api/persistent-agents/:id/models", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return { agentId: status.id, models: roomModelsPayload(status.id), effort: readPersistentRoomEffortChoice(status.id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/models", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const catalog = createRoomModelCatalog();
		const patch = parseRoomModelPatch(req.body ?? {}, catalog, { allowClear: true });
		const effort = (req.body as any)?.effort;
		if (effort !== undefined && !isRoomEffortLevel(effort)) return reply.code(400).send({ error: "effort must be a known reasoning effort level" });
		// The Memory pick, or the default it goes back to, must hold this room's memory.
		const memory = "memory" in patch ? patch.memory ?? resolveAiDefault("memory", catalog).chosen : null;
		if (memory) refuseMemoryModelTooSmall(memory, readPersistentRoomMaintenanceSettings(status.id).memoryBudgetTokens, catalog, 400, (model) => memoryModelTooSmallSentence(model, patch.memory === null ? "default" : "room"));
		if (Object.keys(patch).length > 0) writeRoomModels(status.id, patch);
		if (effort !== undefined) writePersistentRoomEffortChoice(status.id, effort);
		return { agentId: status.id, models: roomModelsPayload(status.id, catalog), effort: readPersistentRoomEffortChoice(status.id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// Room settings → Instructions: the user's standing text for how the room
// works. GET reads it back with the cap the pane counts against; PUT stores
// the text (empty = none) and answers with what was stored. The write refuses
// a room held by a scheduled run (409) and text over the cap (400),
// each with the remedy in the sentence; a refusal leaves the previous text.
app.get("/api/persistent-agents/:id/instructions", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return { agentId: status.id, ...getPersistentRoomInstructionsView(status.id), maxChars: ROOM_INSTRUCTIONS_MAX_CHARS };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

// The room's switch for the global instructions; the reply is the
// same view the GET returns, so the pane re-renders from one shape.
app.put("/api/persistent-agents/:id/instructions/global", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		return { agentId: status.id, ...savePersistentRoomGlobalInstructionsEnabled(status.id, body.enabled), maxChars: ROOM_INSTRUCTIONS_MAX_CHARS };
	} catch (e) {
		const statusCode = (e as any).statusCode;
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-room global-instructions switch failed");
			return reply.code(statusCode).send({ error: "Changing the switch failed because of a server error. The room's setting is unchanged. Check the server logs for details." });
		}
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/instructions", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		savePersistentRoomInstructions(status.id, body.text);
		return { agentId: status.id, ...getPersistentRoomInstructionsView(status.id), maxChars: ROOM_INSTRUCTIONS_MAX_CHARS };
	} catch (e) {
		const statusCode = (e as any).statusCode;
		if (statusCode >= 500) {
			app.log.error({ err: e }, "persistent-room instructions save failed");
			const removing = typeof (req.body as any)?.text === "string" && !(req.body as any).text.trim();
			return reply.code(statusCode).send({ error: `${removing ? "Removing" : "Saving"} the instructions failed because of a server error. The previous instructions are unchanged. Check the server logs for details.` });
		}
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.get("/api/persistent-agents/:id/skill-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const settings = readPersistentRoomSkillSettings(status.id);
		// `skills` is the view the settings panel renders: ok | unreadable per
		// enabled skill still in the room (a deleted one has no row), and whether
		// its author marked it for picking by hand only.
		const skills = withSkillDisplayNames(computeSkillStatuses(settings.enabledSkills, skillLibraryFingerprint));
		return {
			agentId: status.id,
			settings,
			skills: skills.map((skill) => ({ ...skill, manualOnly: resolveLibrarySkillManifest(skill.name)?.disableModelInvocation === true })),
			// What the room's skills can do with their files, as the model is told; the room's own policy, which every conversation runs on.
			skillFiles: skillFilesReach(resolvePersistentRoomEffectiveWorkspacePolicy(status.id, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID), isSharedServer()),
		};
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/skill-settings", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		const action = String(body.action ?? "");
		const name = String(body.name ?? "");
		if (action !== "enable" && action !== "disable") {
			return reply.code(400).send({ error: "action must be 'enable' or 'disable'" });
		}
		// Enable reads the skill's identity server-side through the resolver; the
		// client never supplies it. An unknown skill is a 4xx.
		const result = action === "enable" ? enablePersistentRoomSkill(status.id, name, skillLibraryFingerprint) : disablePersistentRoomSkill(status.id, name);
		if (!result.ok) {
			return reply.code(400).send({ error: result.reason === "unknown-skill" ? `unknown skill: ${name}` : "invalid skill name" });
		}
		return { agentId: status.id, settings: result.settings, skills: withSkillDisplayNames(computeSkillStatuses(result.settings.enabledSkills, skillLibraryFingerprint)) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

/**
 * A room's connectors as the settings pane reads them. `granted` is the
 * per-grant configured/missing view the pane renders next to the configured
 * list; `allowedTools`, the old room yeses that still let a tool of an enabled
 * connector run without asking, by their own name and as people read it: a
 * tool the person has picked a choice for is left out, as the gate ignores its
 * yes. Never on a shared server, where no yes is kept. What a yes is pinned to stays on the server. A
 * configured connector the room may not use is in none of them, its stored
 * grant included, which stays on disk unused. `asksNothing`: the room is on
 * Auto without protection now, so no tool asks first; an unreadable setting
 * reads as no.
 */
function asksNothingNow(agentId: string): boolean {
	try {
		return unprotectedRoomOnAuto(agentId, PERSISTENT_ROOM_WORKSPACE_DEFAULT_CONVERSATION_ID);
	} catch {
		return false;
	}
}

async function roomConnectorsAnswer(agentId: string, { allowedTools, ...stored }: PersistentRoomMcpSettings, configuredNames: string[]) {
	const usable = roomUsableMcpConnectors(agentId, configuredNames);
	const settings = { ...stored, grantedConnectors: stored.grantedConnectors.filter((name) => usable.includes(name) || !configuredNames.includes(name)) };
	const choices = isSharedServer() ? null : readConnectorToolChoices();
	const left = (name: string) => allowedToolsOf(allowedTools, name).filter(({ tool }) => !choices?.readable || toolChoiceIn(choices, name, tool) === null);
	const allowed = isSharedServer() ? {} : { allowedTools: Object.fromEntries(settings.grantedConnectors.filter((name) => left(name).length > 0).map((name) => [name, left(name).map(({ tool }) => ({ tool, shown: connectorToolWords(tool) }))])) };
	const displayNames = Object.fromEntries(Object.entries(await listConfiguredMcpConnectorDisplayNames()).filter(([name]) => usable.includes(name)));
	return { agentId, settings, configuredConnectors: usable, displayNames, granted: computeGrantedConnectorStatuses(settings.grantedConnectors, configuredNames), ...allowed, ...(asksNothingNow(agentId) ? { asksNothing: true } : {}) };
}

app.get("/api/persistent-agents/:id/mcp-connectors", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		return await roomConnectorsAnswer(status.id, readPersistentRoomMcpSettings(status.id), await listConfiguredMcpConnectorNames());
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.put("/api/persistent-agents/:id/mcp-connectors", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const body = (req.body ?? {}) as any;
		const action = String(body.action ?? "");
		const name = String(body.name ?? "");
		// forget-tool takes back a tool's yes; a shared server keeps none, so there it is no action at all.
		const forget = action === "forget-tool" && !isSharedServer();
		if (action !== "grant" && action !== "revoke" && !forget) return reply.code(400).send({ error: "action must be 'grant' or 'revoke'" });
		const configuredNames = await listConfiguredMcpConnectorNames();
		// Grant validates against the CURRENT configured list server-side, so a
		// grant can never name a connector that does not exist; revoke and
		// forget-tool stay permissive so dangling entries can always be cleaned up.
		const result = forget
			? forgetPersistentRoomMcpTool(status.id, name, String(body.tool ?? ""))
			: action === "grant"
				? grantPersistentRoomMcpConnector(status.id, name, configuredNames)
				: revokePersistentRoomMcpConnector(status.id, name);
		if (!result.ok) {
			return reply.code(400).send({ error: result.reason === "unknown-connector" ? `unknown connector: ${name}` : "invalid connector name" });
		}
		return await roomConnectorsAnswer(status.id, result.settings, configuredNames);
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

/** The room's own folder by its real path, and whether it can change files: what the list is judged against. */
function roomReachOf(roomId: string): { folder: string; canChangeFiles: boolean } | null {
	const policy = readPersistentRoomDefaultCapabilityPolicy(roomId);
	const room = policy ? roomFence(policy, () => []).room : null;
	return room ? { folder: room.path, canChangeFiles: room.access === "write" } : null;
}

const folderName = (folder: string): string => path.basename(folder) || folder;

/**
 * The list as the pane draws it. A phone gets names, never a path. A Can read
 * folder says whether Allow changes can widen it, by the same check a pick has.
 * A folder the room's own folder makes unusable isn't drawn: the room's list
 * keeps it for a conversation, or a Location, that can use it.
 */
function alsoAllowedView(req: FastifyRequest, roomId: string) {
	const withPaths = requestGetsLocalPaths(req);
	const room = roomReachOf(roomId);
	const listed = readAlsoAllowed(roomId);
	const folders = room ? soundFolders(listed.folders, room.folder) : listed.folders;
	const sites = listed.sites;
	const writable = room ? [room.folder, ...writeEntries(folders)] : [];
	return {
		folders: folders.map((entry) => ({
			name: folderName(entry.path),
			access: entry.access,
			...(withPaths ? { path: entry.path } : {}),
			canAllowChanges: entry.access === "read" && room !== null && room.canChangeFiles && folderGrantable(entry.path, "write", writable, room.folder),
		})),
		sites: sites.map((site) => ({ host: site.host, port: site.port })),
	};
}

/** A list change that widens what the room can do waits while it answers, as a Save does. */
function refuseWhileAnswering(roomId: string): void {
	assertPersistentRoomWorkspaceDefaultMutable(getUsablePersistentAgentStatusForNormalUse(roomId).activeThread, "Save");
}

function listError(statusCode: number, code: string, error: string): Error {
	return Object.assign(new Error(error), { statusCode, code });
}

/** Names one entry of the list from a request body: a folder by its path, or a site by host and port. */
function namedEntry(body: unknown): { path: string } | { host: string; port: number } {
	const { path: folder, host, port } = (body ?? {}) as { path?: unknown; host?: unknown; port?: unknown };
	if (typeof folder === "string" && folder !== "") return { path: folder };
	if (typeof host === "string" && host !== "" && Number.isInteger(port)) return { host, port: port as number };
	throw listError(400, "entry_required", "Name a folder by its path, or a site by its host and port.");
}

app.get("/api/persistent-agents/:id/also-allowed", async (req, reply) => {
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(String((req.params as { id: string }).id ?? ""));
		return alsoAllowedView(req, status.id);
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

// Add a folder…: the computer's own window, and the one way a pick goes on the
// list. A path in the body is never read. A new folder starts at Can read.
app.post("/api/persistent-agents/:id/also-allowed/folders", async (req, reply) => {
	// The window opens only for the app's own page, as the room's folder's does.
	if (!isLocalSystemChooseFolderRequest(req)) return reply.code(403).send({ error: "Folder chooser is only available from the local Exxperts app.", code: "local_request_required" });
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(String((req.params as { id: string }).id ?? ""));
		const roomId = status.id;
		refuseWhileAnswering(roomId);
		const room = roomReachOf(roomId);
		if (!room) throw listError(400, "missing_root", "Choose a folder for this room.");
		// The window closes when the page goes before it answers.
		const window = new AbortController();
		reply.raw.on("close", () => {
			if (!reply.raw.writableFinished) window.abort();
		});
		let windowFailed: LocalFolderPickerResult | null = null;
		const outcome = await chooseFolderForRoom({
			roomId,
			room: { folder: room.folder, canChangeFiles: room.canChangeFiles, commands: "unavailable", boxed: false },
			access: "read",
			pickFolder: async (signal) => {
				const picked = await chooseLocalFolder({ prompt: folderPickerPrompt("room-asks"), timeoutMs: null, signal });
				if (!picked.ok) windowFailed = picked;
				// The room may have started answering while the window was open.
				else if (!picked.cancelled) refuseWhileAnswering(roomId);
				return picked;
			},
			signal: window.signal,
			// Again in the same run as the write: the room may have started answering during the look.
			beforeGive: () => refuseWhileAnswering(roomId),
		});
		const failed = windowFailed as LocalFolderPickerResult | null;
		if (failed && !failed.ok && failed.code !== "folder_chooser_stopped") return { state: "refused", line: failed.supported ? CHANGE_SAVE_FAILED : NO_FOLDER_WINDOW, list: alsoAllowedView(req, roomId) };
		if ("line" in outcome) return { state: "refused", line: outcome.line, list: alsoAllowedView(req, roomId) };
		if ("done" in outcome && outcome.done.state === "already") return { state: "already", line: FOLDER_ALREADY_USED, list: alsoAllowedView(req, roomId) };
		if ("done" in outcome && outcome.done.state === "picked") return { state: "added", name: outcome.done.name, list: alsoAllowedView(req, roomId) };
		return { state: "unchanged", list: alsoAllowedView(req, roomId) };
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

// Allow changes, and the button back to Can read. Only a listed folder moves.
// Back to Can read only narrows, so it works while the room answers, from the next command and the next file call.
app.post("/api/persistent-agents/:id/also-allowed/access", async (req, reply) => {
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(String((req.params as { id: string }).id ?? ""));
		const roomId = status.id;
		const { path: folder, access } = (req.body ?? {}) as { path?: unknown; access?: unknown };
		if (typeof folder !== "string" || (access !== "read" && access !== "write")) throw listError(400, "entry_required", "Name a listed folder and read or write.");
		const listed = readAlsoAllowed(roomId).folders;
		const entry = listed.find((each) => each.path === folder);
		if (!entry) throw listError(404, "not_listed", "That folder isn't on this room's list.");
		if (access === "read") {
			undoAllowChanges(roomId, folder);
			return { list: alsoAllowedView(req, roomId) };
		}
		refuseWhileAnswering(roomId);
		const room = roomReachOf(roomId);
		if (!room?.canChangeFiles || !folderGrantable(folder, "write", [room.folder, ...writeEntries(listed)], room.folder)) throw listError(400, "folder_refused", "This room can't change files in that folder.");
		addAlsoAllowedFolder(roomId, folder, "write");
		return { list: alsoAllowedView(req, roomId) };
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

// The cross: a folder or a site leaves the list and is kept for Undo. It only
// narrows, so it works while the room answers, from the next command and the next file call.
app.post("/api/persistent-agents/:id/also-allowed/remove", async (req, reply) => {
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(String((req.params as { id: string }).id ?? ""));
		const roomId = status.id;
		const removed = removeAlsoAllowedEntry(roomId, namedEntry(req.body));
		if (!removed) throw listError(404, "not_listed", "That isn't on this room's list.");
		// A folder another row still lets the room read: the pane says which.
		const room = roomReachOf(roomId);
		const through = removed.kind === "folder" && room ? soundFolders(readAlsoAllowed(roomId).folders, room.folder).find((entry) => isInside(removed.path, entry.path)) : undefined;
		return { removed: entryView(removed), ...(through ? { stillReadThrough: folderName(through.path) } : {}), list: alsoAllowedView(req, roomId) };
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

// Undo after the cross: puts back only what Remove kept, with the access it had.
app.post("/api/persistent-agents/:id/also-allowed/restore", async (req, reply) => {
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(String((req.params as { id: string }).id ?? ""));
		const roomId = status.id;
		refuseWhileAnswering(roomId);
		const kept = removedAlsoAllowedEntry(roomId, namedEntry(req.body));
		if (!kept) throw listError(404, "not_removed", "There's nothing to put back.");
		restoreAlsoAllowedEntry(roomId, kept);
		return { list: alsoAllowedView(req, roomId) };
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

/** A room's own folder is judged as a folder on its list is: one no room may use is refused before it is saved. */
function refuseUnusableRoomFolder(policy: PersistentRoomCapabilityPolicy): void {
	const root = policy.roots[0];
	const refusal = root ? roomFolderRefusal(root.realpath) : null;
	if (!root || !refusal) return;
	// A name with a hidden character isn't drawn: the plain line names none.
	const line = pathHoldsHidden(root.realpath) ? FOLDER_PICK_REFUSED : folderRefusedLine(refusal, path.basename(root.realpath) || root.realpath, FOLDER_PICK_REFUSED);
	throw Object.assign(new Error(line), { statusCode: 400, code: "folder_refused" });
}

function entryView(entry: AlsoAllowedEntry) {
	return entry.kind === "folder" ? { kind: "folder", name: folderName(entry.path), path: entry.path, access: entry.access } : { kind: "site", host: entry.host, port: entry.port };
}

app.get("/api/persistent-agents/:id/workspace-default", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const policy = readPersistentRoomDefaultCapabilityPolicy(id);
		return {
			agentId: id,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_DEFAULT_STORAGE_SOURCE },
			policy: policy ? workspacePolicyViewFor(req, policy) : null,
			warnings: missingPersistentRoomWorkspaceRootWarnings(policy),
			// Looked up afresh on every read: the pane asks again when it opens.
			// The note is the Windows line, so a shared server never looks; nor does a room whose commands run in Windows' box, where Git isn't used.
			shellMissingNote: isSharedServer() || persistentRoomWindowsBoxed(id) || persistentRoomShellFound() ? null : PERSISTENT_ROOM_SHELL_MISSING_SENTENCE,
			commandsStartOn: persistentRoomCommandsStartOn(id),
			// Judged afresh too: a folder saved before the rule, or one that became a closed place since.
			folderRefused: policy ? roomFence(policy, () => []).refused : false,
			...protectionView(id),
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

app.put("/api/persistent-agents/:id/workspace-default", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const body = (req.body ?? {}) as any;
		// Legacy field: older clients still send a workspace mode. Garbage keeps
		// failing loudly, but the value itself no longer means anything — write
		// capability is derived from the tool selection.
		parsePersistentRoomWorkspaceMode(body.mode);
		const root = String(body.root ?? "").trim();
		// Left out, the room keeps whether it can change files: its folder's, or for its next folder what Clear kept.
		const toolSelectionSent = Object.prototype.hasOwnProperty.call(body, "toolSelection");
		let policy;
		if (root) {
			const workspaceAccessMode = normalizePersistentRoomWorkspaceAccessModeInput(body.workspaceAccessMode);
			const toolSelection = toolSelectionSent ? normalizePersistentRoomWorkspaceToolSelectionInput(body.toolSelection, { defaultToStandard: true, workspaceAccessMode }) : undefined;
			policy = createPersistentRoomDefaultCapabilityPolicy({
				agentId: id,
				repoRoot: REPO_ROOT,
				root,
				workspaceAccessMode,
				source: "manual",
				displayLabel: typeof body.displayLabel === "string" ? body.displayLabel : undefined,
				toolSelection,
				// Left out, the switch was never touched: a new room's first folder takes the start-on default.
				bashEnabled: typeof body.bashEnabled === "boolean" ? body.bashEnabled : undefined,
			});
			refuseUnusableRoomFolder(policy);
		} else {
			const existingDefault = readPersistentRoomDefaultCapabilityPolicy(id);
			if (!existingDefault) throw new Error("Choose a folder for this room.");
			const workspaceAccessMode = normalizePersistentRoomWorkspaceAccessModeInput(body.workspaceAccessMode, { defaultMode: existingDefault.workspaceAccessMode });
			const toolSelection = toolSelectionSent
				? normalizePersistentRoomWorkspaceToolSelectionInput(body.toolSelection, { defaultToStandard: true, workspaceAccessMode })
				: undefined;
			policy = updatePersistentRoomCapabilityPolicyWorkspaceSettings(existingDefault, { workspaceAccessMode, ...(toolSelection ? { toolSelection } : {}), ...(Object.prototype.hasOwnProperty.call(body, "bashEnabled") ? { bashEnabled: body.bashEnabled === true } : {}) });
		}
		assertPersistentRoomWorkspaceDefaultMutable(status.activeThread, "Save");
		writePersistentRoomDefaultCapabilityPolicy(policy);
		// The answer is the room as the next read gives it: folded, and with its commands as they now stand.
		const saved = readPersistentRoomDefaultCapabilityPolicy(id);
		return {
			agentId: id,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_DEFAULT_STORAGE_SOURCE },
			policy: saved ? workspacePolicyViewFor(req, saved) : null,
			warnings: [],
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

app.delete("/api/persistent-agents/:id/workspace-default", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		assertPersistentRoomWorkspaceDefaultMutable(status.activeThread, "Clear");
		const result = deletePersistentRoomDefaultCapabilityPolicy(id);
		return {
			agentId: id,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_DEFAULT_STORAGE_SOURCE },
			policy: null,
			deleted: result.deleted,
			warnings: [],
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

/** A room's protection as the reads carry it. None on a shared server, where no room's commands are boxed. */
function protectionView(roomId: string): { protection?: PersistentRoomProtection } {
	return isSharedServer() ? {} : { protection: persistentRoomProtection(roomId) };
}

const PROTECTION_UNAVAILABLE_LINES: Record<PersistentRoomProtectionCause, string> = {
	computer: PROTECTION_UNAVAILABLE_COMPUTER,
	folder: PROTECTION_UNAVAILABLE_FOLDER,
	unknown: PROTECTION_UNAVAILABLE,
};

/** The protection route's request: the room from the path, the state from the body, checked below. */
type ProtectionRequest = { idRaw: string; state: unknown };

// A room's protection, turned off or on by the person at the computer: the
// app's own control is the one way. Refused while the room answers, and where
// a cause stands, since then nothing she chooses would change what runs.
app.put("/api/persistent-agents/:id/protection", async (req, reply) => {
	const { idRaw, state }: ProtectionRequest = {
		idRaw: String((req.params as { id?: string }).id ?? "").trim(),
		state: ((req.body ?? {}) as { state?: unknown }).state,
	};
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		if (isSharedServer()) throw listError(403, "protection_unavailable", PROTECTION_UNAVAILABLE);
		if (state !== "on" && state !== "off") throw listError(400, "invalid_protection", "state must be \"on\" or \"off\"");
		refuseWhileAnswering(id);
		const now = persistentRoomProtection(id);
		if (now.state === "off" && now.cause !== undefined) throw listError(409, "protection_unavailable", PROTECTION_UNAVAILABLE_LINES[now.cause]);
		writePersistentRoomProtection(id, state);
		// Seen in its new state at once: a yes of the other state is no longer honoured, and one given without protection is dropped.
		readPersistentRoomBashSettings(id);
		return { agentId: id, ...protectionView(id) };
	} catch (e) {
		return persistentAgentNormalUseErrorReply(reply, e);
	}
});

app.post("/api/persistent-agents/:id/workspace/validate", async (req, reply) => {
	const idRaw = String((req.params as any).id ?? "").trim();
	try {
		const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
		const id = status.id;
		const body = (req.body ?? {}) as any;
		const conversationId = String(body.conversationId ?? "").trim();
		if (!conversationId) throw new Error("conversationId is required");
		const workspaceAccessMode = normalizePersistentRoomWorkspaceAccessModeInput(body.workspaceAccessMode);
		// Legacy field: validated for compat with older clients, then discarded.
		parsePersistentRoomWorkspaceMode(body.mode);
		const source = parsePersistentRoomWorkspaceSource(body.source);
		const toolSelection = normalizePersistentRoomWorkspaceToolSelectionInput(body.toolSelection, { defaultToStandard: true, workspaceAccessMode });
		const warnings: string[] = [];
		const policy = createPersistentRoomCapabilityPolicy({
			agentId: id,
			conversationId,
			repoRoot: REPO_ROOT,
			root: String(body.root ?? ""),
			workspaceAccessMode,
			source,
			displayLabel: typeof body.displayLabel === "string" ? body.displayLabel : undefined,
			toolSelection,
			bashEnabled: body.bashEnabled === true,
		});
		refuseUnusableRoomFolder(policy);
		writePersistentRoomCapabilityPolicy(policy);
		return {
			agentId: id,
			conversationId,
			storage: { kind: PERSISTENT_ROOM_WORKSPACE_POLICY_STORAGE_SOURCE },
			policy: workspacePolicyViewFor(req, policy),
			warnings,
		};
	} catch (e) {
		const payload = persistentRoomWorkspaceErrorPayload(e);
		return reply.code(payload.statusCode).send(payload.body);
	}
});

export { requestGetsLocalPaths };
