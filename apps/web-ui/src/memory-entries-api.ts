// The room's memory, entry by entry. Every action here is one request, and
// every answer carries the budget the server recomputed, so the pane renders
// what the room now holds instead of guessing at it.

import { fetchJson } from "./api";
import type { MemorySaveEvent } from "./memory-surface-copy";
import type { ArchivedEntryCard, EntryKind, MemoryArchiveResponse, MemoryEntriesResponse, MemoryEntryDeleteResponse, MemoryEntryWriteResponse, MemoryUndoResponse, PersistentAgentId } from "./types";

/** The room's own memory history: every save, newest first. Reads never refuse. */
export interface MemoryHistoryResponse {
	agentId: string;
	history: MemorySaveEvent[];
	readOnly?: boolean;
	reason?: string;
}

function memoryBase(agentId: PersistentAgentId): string {
	return `/api/persistent-agents/${encodeURIComponent(agentId)}/memory`;
}

export function fetchMemoryEntries(agentId: PersistentAgentId): Promise<MemoryEntriesResponse> {
	return fetchJson<MemoryEntriesResponse>(`${memoryBase(agentId)}/entries`);
}

export function fetchMemoryArchive(agentId: PersistentAgentId, options?: { limit?: number; before?: string }): Promise<MemoryArchiveResponse> {
	const query = new URLSearchParams();
	query.set("limit", String(options?.limit ?? 50));
	if (options?.before) query.set("before", options.before);
	return fetchJson<MemoryArchiveResponse>(`${memoryBase(agentId)}/archive?${query.toString()}`);
}

export function fetchMemoryHistory(agentId: PersistentAgentId): Promise<MemoryHistoryResponse> {
	return fetchJson<MemoryHistoryResponse>(`${memoryBase(agentId)}/history`);
}

export function createMemoryEntry(agentId: PersistentAgentId, entry: { topic: string; kind: EntryKind; text: string }): Promise<MemoryEntryWriteResponse> {
	return fetchJson<MemoryEntryWriteResponse>(`${memoryBase(agentId)}/entries`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(entry),
	});
}

/** One field at a time, exactly as the route accepts it. */
export function updateMemoryEntry(agentId: PersistentAgentId, entryId: string, change: { text: string } | { pinned: boolean } | { topic: string } | { status: "open" | "done" }): Promise<MemoryEntryWriteResponse> {
	return fetchJson<MemoryEntryWriteResponse>(`${memoryBase(agentId)}/entries/${encodeURIComponent(entryId)}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(change),
	});
}

export function deleteMemoryEntry(agentId: PersistentAgentId, entryId: string): Promise<MemoryEntryDeleteResponse> {
	return fetchJson<MemoryEntryDeleteResponse>(`${memoryBase(agentId)}/entries/${encodeURIComponent(entryId)}`, { method: "DELETE" });
}

export function restoreMemoryEntry(agentId: PersistentAgentId, entryId: string): Promise<MemoryEntryWriteResponse> {
	return fetchJson<MemoryEntryWriteResponse>(`${memoryBase(agentId)}/archive/${encodeURIComponent(entryId)}/restore`, { method: "POST" });
}

/** What the server answers when an archived note is deleted for good: the note as it was, and the archive as it is now. */
export interface MemoryArchiveDeleteResponse {
	agentId: string;
	deleted: ArchivedEntryCard;
	archive: { count: number };
}

/** The one way out of the archive. The server refuses a busy room and a row already gone with its own sentences. */
export function deleteArchivedMemoryEntry(agentId: PersistentAgentId, entryId: string): Promise<MemoryArchiveDeleteResponse> {
	return fetchJson<MemoryArchiveDeleteResponse>(`${memoryBase(agentId)}/archive/${encodeURIComponent(entryId)}`, { method: "DELETE" });
}

/**
 * Takes back the room's latest Memorize or Review save, named by the `saveId`
 * that approval answered with. The server refuses with its own sentence when
 * the memory has moved on since, so the screen shows that refusal rather than
 * deciding for itself whether an undo is still on offer.
 */
export function undoMemorySave(agentId: PersistentAgentId, saveId: string): Promise<MemoryUndoResponse> {
	return fetchJson<MemoryUndoResponse>(`${memoryBase(agentId)}/undo`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ saveId }),
	});
}
