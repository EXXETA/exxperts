// What the Connectors pages last read, so one opened again shows it at once
// and brings it up to date behind. In this page's memory alone: nothing is
// written to the computer or the browser's storage, and a reload, which is
// also what another person's sign-in brings, starts with nothing.
import { fetchMcpConnectorsStatus, type McpConnectorsStatusResponse } from "./mcp-api";
import type { PersistentRoomMcpConnectorsResponse } from "./persistent-room-management-api";
import { mayBeOnSharedServer } from "./remote-client-context";

let list: McpConnectorsStatusResponse | null = null;
let started = 0;
let listFrom = 0;
const rooms = new Map<string, PersistentRoomMcpConnectorsResponse>();

/** Settings' list of connectors, read and kept. An answer to an older read, such as one a page closed since was waiting for, never replaces a newer one. */
export async function readConnectorList(): Promise<McpConnectorsStatusResponse> {
	const mine = ++started;
	const read = await fetchMcpConnectorsStatus();
	if (mine > listFrom) {
		listFrom = mine;
		list = read;
	}
	return read;
}

/** The list as last read; null before the first. */
export function keptConnectorList(): McpConnectorsStatusResponse | null {
	return list;
}

/** A room's connectors as last read; null before the first, and always where the page may be on a shared server, where who may see a room can change. */
export function keptRoomConnectors(roomId: string): PersistentRoomMcpConnectorsResponse | null {
	return rooms.get(roomId) ?? null;
}

/** Keeps a room's connectors as the server just answered; null forgets them (an archived room). */
export function keepRoomConnectors(roomId: string, read: PersistentRoomMcpConnectorsResponse | null): void {
	if (read && !mayBeOnSharedServer()) rooms.set(roomId, read);
	else rooms.delete(roomId);
}
