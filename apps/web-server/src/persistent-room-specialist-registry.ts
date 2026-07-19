/**
 * Room-scoped specialist registry (option 4, grill-locked 2026-07-19).
 *
 * The structural heart of "a delegation belongs to the room, not to the tab
 * that asked for it": specialist bookkeeping — the running set, the cap, the
 * abort handle, and the delta tail — moves out of the ws connection closure
 * into this module-level registry keyed by roomId. The worker was always
 * socket-independent (own ephemeral session, headless UI, artifacts-scoped
 * writes); what died with the socket was only this bookkeeping, and with it
 * the task. Now the connection is just the registry's current SINK:
 *
 *   - bind/unbind: a connection binds its `send` on connect and unbinds on
 *     close (identity-checked, so a web→web takeover's newer sink survives
 *     the older connection's teardown). While no sink is bound, frames drop
 *     silently — the ledger's `noticed:false` finalize plus the away-notice
 *     machinery already narrate endings nobody heard.
 *   - replay: binding a sink replays `task_started` + one accumulated-tail
 *     `task_delta` for every running task, through the SAME event family the
 *     client already speaks — a refresh mid-run is invisible (G-3, full tail
 *     re-attach; the tail cap mirrors the client's TASK_TAIL_CAP).
 *   - stop: `task_abort` resolves here, so any later connection of the same
 *     room can stop a task an earlier one started.
 *
 * Pure bookkeeping — no fs, no sockets, no timers — so the smoke suite can
 * pin cap-across-connections, takeover, replay, and stop-after-reconnect in
 * plain node. Process death still kills workers; the boot sweep marks their
 * rows orphaned (unchanged, still honest).
 */

/**
 * A sink may report delivery: an explicit `false` means the frame did not
 * reach the client (the socket was already closed/closing). `void` counts as
 * delivered — the plain fire-and-forget sinks the smokes use stay valid.
 */
export type SpecialistSink = (msg: unknown) => boolean | void;

export interface SpecialistRegistryEntry {
	taskId: string;
	templateId: string;
	templateVersion: number;
	templateLabel: string;
	title: string;
	model: unknown;
	startedAt: string;
	abortController: AbortController;
	stoppedByUser: boolean;
	/** Accumulated delta tail, capped — the reconnect replay's payload. */
	tail: string;
}

export interface SpecialistRegistryEntryInput {
	taskId: string;
	templateId: string;
	templateVersion: number;
	templateLabel: string;
	title: string;
	model: unknown;
	abortController: AbortController;
}

/** Mirrors the client reducer's TASK_TAIL_CAP: replaying more would be dropped there anyway. */
export const SPECIALIST_REGISTRY_TAIL_CAP = 2_000;

interface RoomSpecialists {
	sink: SpecialistSink | null;
	tasks: Map<string, SpecialistRegistryEntry>;
}

const rooms = new Map<string, RoomSpecialists>();

function roomFor(roomId: string): RoomSpecialists {
	let room = rooms.get(roomId);
	if (!room) {
		room = { sink: null, tasks: new Map() };
		rooms.set(roomId, room);
	}
	return room;
}

export function registerSpecialistTask(roomId: string, input: SpecialistRegistryEntryInput, now = new Date()): SpecialistRegistryEntry {
	const entry: SpecialistRegistryEntry = { ...input, stoppedByUser: false, startedAt: now.toISOString(), tail: "" };
	roomFor(roomId).tasks.set(input.taskId, entry);
	return entry;
}

export function removeSpecialistTask(roomId: string, taskId: string): void {
	const room = rooms.get(roomId);
	if (!room) return;
	room.tasks.delete(taskId);
	// Keep empty room slots from accumulating over a long server life.
	if (room.tasks.size === 0 && room.sink === null) rooms.delete(roomId);
}

export function runningSpecialistCount(roomId: string): number {
	return rooms.get(roomId)?.tasks.size ?? 0;
}

export function getSpecialistTask(roomId: string, taskId: string): SpecialistRegistryEntry | null {
	return rooms.get(roomId)?.tasks.get(taskId) ?? null;
}

/**
 * Abort every running task of a room. The archive path's kill switch: option 4
 * lets workers outlive their connection, and an archived room has no surface
 * left to stop them from — so archiving must take them down itself.
 * `stoppedByUser` is honest here: deleting the room is a deliberate stop.
 */
export function abortAllSpecialistTasks(roomId: string): number {
	const room = rooms.get(roomId);
	if (!room || room.tasks.size === 0) return 0;
	let aborted = 0;
	for (const entry of room.tasks.values()) {
		entry.stoppedByUser = true;
		entry.abortController.abort();
		aborted += 1;
	}
	return aborted;
}

/**
 * Stop a running task from ANY connection of its room. Returns false for
 * unknown/stale ids (same discipline the ws handler always applied).
 */
export function abortSpecialistTask(roomId: string, taskId: string): boolean {
	const entry = rooms.get(roomId)?.tasks.get(taskId);
	if (!entry) return false;
	entry.stoppedByUser = true;
	entry.abortController.abort();
	return true;
}

/**
 * Forward a task frame to the room's current sink. Returns the
 * delivery-honesty signal (`noticed`): false when no sink is bound OR the
 * bound sink reports its socket is no longer open — so a frame sent into a
 * dying connection does not count as the user having been told.
 */
export function sendSpecialistFrame(roomId: string, msg: unknown): boolean {
	const room = rooms.get(roomId);
	if (!room?.sink) return false;
	return room.sink(msg) !== false;
}

/** Append a delta to the entry's replay tail (capped) and forward it live. */
export function emitSpecialistDelta(roomId: string, taskId: string, delta: string): void {
	const entry = rooms.get(roomId)?.tasks.get(taskId);
	if (entry) {
		const next = entry.tail + delta;
		entry.tail = next.length > SPECIALIST_REGISTRY_TAIL_CAP ? next.slice(-SPECIALIST_REGISTRY_TAIL_CAP) : next;
	}
	sendSpecialistFrame(roomId, { type: "task_delta", taskId, delta });
}

/**
 * Bind a connection's send as the room's sink and replay every running task
 * into it: `task_started` (same shape the launch announces) followed by the
 * accumulated tail as one `task_delta`. The client's reducer receives exactly
 * the frames it would have received live.
 */
export function bindSpecialistSink(roomId: string, sink: SpecialistSink): void {
	const room = roomFor(roomId);
	room.sink = sink;
	for (const entry of room.tasks.values()) {
		sink({
			type: "task_started",
			taskId: entry.taskId,
			template: entry.templateId,
			templateVersion: entry.templateVersion,
			templateLabel: entry.templateLabel,
			title: entry.title,
			model: entry.model,
		});
		if (entry.tail) sink({ type: "task_delta", taskId: entry.taskId, delta: entry.tail });
	}
}

/**
 * Unbind on connection close — identity-checked: if a newer connection has
 * already taken over (web→web takeover), its sink stays.
 */
export function unbindSpecialistSink(roomId: string, sink: SpecialistSink): void {
	const room = rooms.get(roomId);
	if (!room || room.sink !== sink) return;
	room.sink = null;
	if (room.tasks.size === 0) rooms.delete(roomId);
}

/** Test hook: forget everything (smokes only; never called by the app). */
export function resetSpecialistRegistryForTest(): void {
	rooms.clear();
}
