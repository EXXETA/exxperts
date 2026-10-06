import { apiFetch } from "./api";
import { isRoomOrderMode, type RoomOrderChoice, type RoomOrderMode } from "../../web-server/src/room-order";

export interface RoomOrderResponse {
	order: {
		mode: RoomOrderMode;
		/** The saved arrangement, as room ids: never total, reconciled on read (orderRooms). A remote device gets it without its hidden rooms. */
		customOrder: string[];
		updatedAt: string | null;
		/** Set when something sits where the saved order belongs and cannot be used: what is wrong with it, in words. */
		unreadable?: string;
		/** Set when a save would be refused for what sits there (a folder): choosing an order is not the way out. */
		saveBlocked?: true;
	};
	modes: RoomOrderMode[];
}

/**
 * The server's own sentence when it sent one; otherwise the fallback. A
 * request that never got an answer (the browser's "Load failed", "Failed to
 * fetch") is reported with the fallback too: the engine's words are not ours
 * to show. The same goes for an answer that says OK and is not the payload:
 * it is refused here, in our words, before anything downstream can trip on it.
 *
 * A failed save's sentence is kept by the home screen until the next save, so
 * it has to stay true while it waits. The route's own refusals (its 400 and
 * its 500) are written to: they speak of the attempt. Any other status comes
 * from somewhere this feature does not write (the remote gate's 403, a proxy,
 * the framework, a server too old for the route: "Not Found"), in words that
 * are not the product's and may describe a state that changes, so the face
 * gets our sentence and the server's words go to the console. Told apart by
 * status, never by wording.
 */
const ROOM_ORDER_ROUTE_STATUSES: ReadonlySet<number> = new Set([400, 500]);

async function roomOrderRequest(init: RequestInit | undefined, fallback: string): Promise<RoomOrderResponse> {
	let response: Response;
	try {
		response = await apiFetch("/api/settings/room-order", init);
	} catch {
		throw new Error(fallback);
	}
	let payload: unknown = null;
	try { payload = await response.json(); } catch { payload = null; }
	if (!response.ok) {
		const raw = payload && typeof payload === "object" ? (payload as { error?: unknown }).error : null;
		const sentence = typeof raw === "string" ? raw.trim() : "";
		if (sentence && ROOM_ORDER_ROUTE_STATUSES.has(response.status)) throw new Error(sentence);
		console.warn(`Room order: the server answered ${response.status}${sentence ? `: ${sentence}` : ""}`);
		throw new Error(fallback);
	}
	const order = (payload as RoomOrderResponse | null)?.order;
	if (!isRoomOrderMode(order?.mode) || !Array.isArray(order?.customOrder)) throw new Error(fallback);
	return payload as RoomOrderResponse;
}

export function fetchRoomOrder(): Promise<RoomOrderResponse> {
	return roomOrderRequest(undefined, "The saved order could not be loaded.");
}

/**
 * The ONE sentence for a save that got no usable answer. It names no
 * control: the home screen keeps it until the next save starts (rule 4 of
 * home-room-order.ts) and draws it wherever the user then is, in the menu,
 * under the control, or in the arrange line, and "try again" is true in
 * every one of those places.
 */
export const ROOM_ORDER_SAVE_FALLBACK = "The order was not saved. Try again.";

/** Save a choice: a mode from the menu, or an arrangement from arrange mode (mode custom and the ids). */
export function saveRoomOrder(choice: RoomOrderChoice): Promise<RoomOrderResponse> {
	return roomOrderRequest(
		{ method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(choice) },
		ROOM_ORDER_SAVE_FALLBACK,
	);
}
