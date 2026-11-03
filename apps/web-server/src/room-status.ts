import { validatePersistentAgentId, getPersistentAgentStatus, isPersistentAgentArchived, assertPersistentAgentAcceptsCheckpoint, type writeApprovedCheckpoint, type writePersistentAgentMementoBoundary } from "./persistent-agents.js";
import type { AbsorbRunApprovalResponse } from "./absorb-run.js";

function getUsablePersistentAgentStatusForNormalUse(idRaw: string) {
	const id = validatePersistentAgentId(idRaw);
	const status = getPersistentAgentStatus(id);
	if (!status.exists) {
		const error = new Error(`persistent agent not found: ${id}`);
		(error as any).statusCode = 404;
		throw error;
	}
	if (isPersistentAgentArchived(status)) {
		const error = new Error(`persistent agent is archived: ${id}`);
		(error as any).statusCode = 410;
		throw error;
	}
	if (status.status === "error") {
		const error = new Error(status.errors[0] ?? `persistent agent is not usable: ${id}`);
		(error as any).statusCode = 409;
		throw error;
	}
	return status;
}

// Remember's route gate: the engine's own check, which never refuses on count.
function getPersistentAgentStatusForCheckpoint(idRaw: string) {
	const status = getUsablePersistentAgentStatusForNormalUse(idRaw);
	assertPersistentAgentAcceptsCheckpoint(status);
	return status;
}

function getPersistentAgentStatusForMaintenance(idRaw: string) {
	const id = validatePersistentAgentId(idRaw);
	const status = getPersistentAgentStatus(id);
	if (!status.exists) {
		const error = new Error(`persistent agent not found: ${id}`);
		(error as any).statusCode = 404;
		throw error;
	}
	if (isPersistentAgentArchived(status)) {
		const error = new Error(`persistent agent is archived: ${id}`);
		(error as any).statusCode = 410;
		throw error;
	}
	if (status.status === "error") {
		const error = new Error(status.errors[0] ?? `persistent agent scaffold is not ready: ${status.status}`);
		(error as any).statusCode = 409;
		throw error;
	}
	if (status.status !== "ready" && status.status !== "needs_absorb") {
		const error = new Error(`persistent agent is not ready for maintenance: ${status.status}`);
		(error as any).statusCode = 409;
		throw error;
	}
	return status;
}

function persistentAgentNormalUseErrorReply(reply: any, error: unknown) {
	const message = (error as Error).message;
	const statusCode = (error as any).statusCode ?? (/invalid persistent agent id/i.test(message) ? 400 : 400);
	// A machine-readable code rides along when the error carries one (e.g.
	// memory_overflow), so HTTP callers can branch like the ws client does.
	const code = typeof (error as any).code === "string" ? (error as any).code : undefined;
	// Structured detail (e.g. the refused operations' reasons) rides beside the
	// sentence for benches and logs; the UI reads only the sentence.
	const details = (error as any).details !== undefined ? (error as any).details : undefined;
	return reply.code(statusCode).send({ error: message, ...(code ? { code } : {}), ...(details !== undefined ? { details } : {}) });
}

function browserSafeCheckpointApprovalResponse(result: ReturnType<typeof writeApprovedCheckpoint>) {
	return {
		agentId: result.agentId,
		conversationId: result.conversationId,
		sessionId: result.sessionId,
		checkpointId: result.checkpointId,
		writesMemory: result.writesMemory,
		eventRelPath: result.eventRelPath,
		recentContextEntryCount: result.recentContextEntryCount,
		runtimeBoundary: result.runtimeBoundary,
		postCheckpoint: result.postCheckpoint,
		warnings: result.warnings,
		...(result.alreadySaved ? { alreadySaved: true as const } : {}),
	};
}

function browserSafeMementoBoundaryResponse(result: ReturnType<typeof writePersistentAgentMementoBoundary>) {
	return {
		agentId: result.agentId,
		conversationId: result.conversationId,
		mementoId: result.mementoId,
		writesMemory: result.writesMemory,
		eventRelPath: result.eventRelPath,
		runtimeBoundary: result.runtimeBoundary,
		postMemento: result.postMemento,
		memory: result.memory,
		warnings: result.warnings,
	};
}

function browserSafeAbsorbApprovalResponse(result: AbsorbRunApprovalResponse & { openConversationKeepsMemory?: true }) {
	return {
		agentId: result.agentId,
		writesMemory: result.writesMemory,
		absorbId: result.absorbId,
		// The id the undo route takes, under the one name both approvals use.
		saveId: result.saveId,
		eventRelPath: result.eventRelPath,
		recentContextEntryCount: result.recentContextEntryCount,
		memoryBudget: result.memoryBudget,
		postAbsorb: result.postAbsorb,
		warnings: result.warnings,
		// What the saved screen says: what went into memory, what is waiting for
		// the next update, and how much moved to the archive.
		foldedSessions: result.foldedSessions,
		notedSessions: result.notedSessions,
		nothingToKeep: result.nothingToKeep,
		newTopics: result.newTopics,
		remainingSessions: result.remainingSessions,
		archivedEntries: result.archivedEntries,
		archivedForBudget: result.archivedForBudget,
		...(result.replacedEntries > 0 ? { replacedEntries: result.replacedEntries } : {}),
		...(result.historyKept > 0 ? { historyKept: result.historyKept } : {}),
		...(result.sortedNotes > 0 ? { sortedNotes: result.sortedNotes } : {}),
		// The limit the card raised, now the room's own; absent when it was not raised.
		...(result.budgetRaisedTo === undefined ? {} : { budgetRaisedTo: result.budgetRaisedTo }),
		// Conversations remembered while the run was open, which the save kept waiting.
		rebasedOnto: result.rebasedOnto,
		// The open conversation has started and keeps the memory it started with.
		...(result.openConversationKeepsMemory ? { openConversationKeepsMemory: true } : {}),
		// A Save sent again for a run that already saved: nothing was written this time.
		...(result.alreadySaved ? { alreadySaved: true } : {}),
	};
}

export { browserSafeAbsorbApprovalResponse, browserSafeCheckpointApprovalResponse, browserSafeMementoBoundaryResponse, getPersistentAgentStatusForCheckpoint, getPersistentAgentStatusForMaintenance, getUsablePersistentAgentStatusForNormalUse, persistentAgentNormalUseErrorReply };
