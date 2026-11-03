import { type PersistentRoomInstructions, readPersistentRoomInstructions, composePersistentRoomInstructions, validatePersistentRoomInstructionsText, writePersistentRoomInstructions } from "./persistent-room-instructions.js";
import { readPersistentRoomGlobalInstructionsSetting, writePersistentRoomGlobalInstructionsEnabled } from "./persistent-room-global-instructions-setting.js";
import type { PersistentAgentModelLock, PersistentAgentStatus, PersistentRoomBackgroundRunClassification } from "./persistent-agent-types.js";
import { activePersistentRoomLock, assertPersistentRoomNotHeldByAnotherProcess, createPersistentAgentInstance, isPersistentAgentArchived, PERSISTENT_AGENTS_ROOT } from "./persistent-agent-store.js";
import { getPersistentAgentThread } from "./persistent-agent-threads.js";
import { getPersistentAgentStatus } from "./persistent-agent-status.js";

export function getPersistentRoomInstructions(agentIdRaw: string): PersistentRoomInstructions {
	const instance = createPersistentAgentInstance(agentIdRaw);
	return readPersistentRoomInstructions(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
}

/** What the room's Instructions pane shows: this room's text, and the global text with this room's switch. */
export interface PersistentRoomInstructionsView {
	instructions: PersistentRoomInstructions;
	global: {
		instructions: PersistentRoomInstructions;
		enabled: boolean;
		/** When this room last flipped its switch; null when it never did (the default, on). */
		updatedAt: string | null;
	};
}

export function getPersistentRoomInstructionsView(agentIdRaw: string): PersistentRoomInstructionsView {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const composed = composePersistentRoomInstructions(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
	const setting = readPersistentRoomGlobalInstructionsSetting(instance.agentId, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT });
	return {
		instructions: composed.room,
		global: { instructions: composed.global, enabled: composed.globalEnabled, updatedAt: setting?.updatedAt || null },
	};
}

/**
 * The room's switch for the global instructions. Written into the
 * room folder, so it is refused while a scheduled run holds the
 * room, like the room's own text; the per-turn section carries the flip to
 * every open web conversation on its next message.
 */
export function savePersistentRoomGlobalInstructionsEnabled(agentIdRaw: string, enabled: unknown, now = new Date()): PersistentRoomInstructionsView {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const meta = instance.readAgentJson();
	if (!meta) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	if (typeof enabled !== "boolean") {
		const error = new Error("enabled must be true or false");
		(error as any).statusCode = 400;
		throw error;
	}
	assertPersistentRoomNotHeldByAnotherProcess(instance.agentId, `switch the global instructions ${enabled ? "on" : "off"} for it`);
	try {
		writePersistentRoomGlobalInstructionsEnabled(instance.agentId, enabled, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT }, now);
	} catch (error) {
		// As for the room's own text below: a failure of the write itself is a
		// server-side failure, so the route answers with its own path-free
		// sentence and never the file system's.
		if (!(error as any).statusCode) (error as any).statusCode = 500;
		throw error;
	}
	return getPersistentRoomInstructionsView(instance.agentId);
}

/**
 * The write behind Room settings → Instructions. Validation (type, control
 * characters, cap) runs first and refuses with a 400 before anything touches
 * disk, so a refused save leaves the previous text in place. Refused while a
 * scheduled run holds the room, allowed while the room is merely
 * open in the web app: the frozen boot snapshot keeps the old text, and the
 * per-turn current-instructions section carries the new one on the very next
 * message.
 */
export function savePersistentRoomInstructions(agentIdRaw: string, raw: unknown, now = new Date()): PersistentRoomInstructions {
	const instance = createPersistentAgentInstance(agentIdRaw);
	const meta = instance.readAgentJson();
	if (!meta) {
		const error = new Error(`persistent agent not found: ${instance.agentId}`);
		(error as any).statusCode = 404;
		throw error;
	}
	// Validation first (a 400 with its own sentence), then the lock guard with
	// the verb the user actually chose, then the write.
	const text = validatePersistentRoomInstructionsText(raw);
	assertPersistentRoomNotHeldByAnotherProcess(instance.agentId, text ? "save its instructions" : "remove its instructions");
	try {
		return writePersistentRoomInstructions(instance.agentId, text, { persistentAgentsRoot: PERSISTENT_AGENTS_ROOT }, now);
	} catch (error) {
		// The write's own refusals carry a 400 and their own sentence; anything
		// else is a server-side failure, reported as such.
		if (!(error as any).statusCode) (error as any).statusCode = 500;
		throw error;
	}
}

function clonePersistentAgentModelLock(model: PersistentAgentModelLock): PersistentAgentModelLock {
	return { provider: model.provider, model: model.model, ...(model.label ? { label: model.label } : {}) };
}

export function classifyPersistentRoomBackgroundRunTarget(agentIdRaw: string, options: { expectedSchedulerLockId?: string } = {}): PersistentRoomBackgroundRunClassification {
	let status: PersistentAgentStatus;
	try {
		status = getPersistentAgentStatus(agentIdRaw);
	} catch (error) {
		return {
			status: "blocked",
			reason: "room_error",
			message: `Persistent room cannot be inspected safely: ${(error as Error).message}`,
			warnings: [],
		};
	}
	const roomId = status.id;
	const warnings = [...status.warnings];
	const noneTarget = { kind: "none" as const, roomId };
	if (!status.exists) {
		return { status: "blocked", reason: "room_missing", target: noneTarget, message: `Persistent room not found: ${roomId}`, warnings };
	}
	if (isPersistentAgentArchived(status)) {
		return { status: "blocked", reason: "room_archived", target: noneTarget, message: `Persistent room is archived: ${roomId}`, warnings };
	}
	if (status.status === "error") {
		return {
			status: "blocked",
			reason: "room_error",
			target: noneTarget,
			message: status.errors.length > 0 ? `Persistent room is not ready for background work: ${status.errors.join("; ")}` : "Persistent room is not ready for background work.",
			warnings,
		};
	}
	if (activePersistentRoomLock(roomId, options)) {
		return {
			status: "deferred",
			reason: "room_in_use",
			target: noneTarget,
			message: "Persistent room is currently open or locked by another surface; background work should retry later.",
			warnings,
		};
	}
	const activeThread = status.activeThread;
	if (activeThread?.inFlight) {
		return {
			status: "deferred",
			reason: "active_turn_in_flight",
			target: noneTarget,
			message: activeThread.cancelling ? "Persistent room has a cancelling turn in flight; background work should retry later." : "Persistent room has an active turn in flight; background work should retry later.",
			warnings,
		};
	}
	if (activeThread?.preparedByBoundary) {
		return {
			status: "blocked",
			reason: "prepared_runtime_boundary",
			// The conversation it met: the run may go there, late, once the person has started it (decision 47).
			target: { ...noneTarget, threadId: activeThread.threadId },
			message: `Persistent room is parked at an empty prepared ${activeThread.preparedByBoundary} boundary; background work must not consume or retire it automatically.`,
			warnings,
		};
	}
	if (activeThread?.hasUserVisibleTurns) {
		try {
			const thread = getPersistentAgentThread(roomId, activeThread.threadId);
			if (!thread || thread.state === "closed") throw new Error("active thread is missing or closed");
			return {
				status: "queued",
				reason: "resume_thread",
				target: { kind: "resume-thread", roomId, threadId: thread.threadId, model: clonePersistentAgentModelLock(thread.model) },
				warnings,
			};
		} catch (error) {
			return {
				status: "blocked",
				reason: "room_error",
				target: noneTarget,
				message: `Persistent room active thread cannot be inspected safely: ${(error as Error).message}`,
				warnings,
			};
		}
	}
	if (status.runtime.state !== "idle" && status.runtime.activeThreadId && !activeThread) {
		return {
			status: "blocked",
			reason: "room_error",
			target: noneTarget,
			message: "Persistent room runtime points at an active thread that cannot be inspected safely.",
			warnings,
		};
	}
	return {
		status: "queued",
		reason: "fresh_thread",
		target: { kind: "fresh-thread", roomId, modelPolicyKey: "scheduledRoom" },
		warnings,
	};
}
