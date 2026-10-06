import { useEffect, useRef, useSyncExternalStore } from "react";
import type { RoomOrderChoice } from "../../web-server/src/room-order";
import { roomLastUsedTimes } from "../../web-server/src/room-order";
import { createHomeRoomOrderController, lastUsedRefreshFrom, type HomeRoomOrderController, type HomeRoomOrderView, type RefreshRooms } from "./home-room-order";
import { fetchRoomOrder, saveRoomOrder } from "./room-order-api";

/**
 * The hook around the home screen's order controller: one controller for the
 * life of the app (a save may outlive the home screen it was started on, and
 * what it answers must still be remembered), told when the home screen is
 * shown and when it is left. Every rule lives in `home-room-order.ts`.
 *
 * `rooms` is how the controller reaches the app's rooms for "recently used":
 * the list in hand and the app's own refresh, always this render's (the
 * refresh closes over the app's state, so only the newest instance is safe
 * to call). The hook only hands them over; when they are asked for, and what
 * is done with them, is the controller's.
 */
export function useHomeRoomOrder(homeShown: boolean, rooms: { statuses: ReadonlyArray<{ id: string; lastUsedAt?: string | null }>; refresh: RefreshRooms }): { view: HomeRoomOrderView; choose: (choice: RoomOrderChoice) => Promise<boolean> } {
	const roomsRef = useRef(rooms);
	roomsRef.current = rooms;
	const controllerRef = useRef<HomeRoomOrderController | null>(null);
	if (!controllerRef.current) {
		controllerRef.current = createHomeRoomOrderController({
			read: fetchRoomOrder,
			save: saveRoomOrder,
			refreshLastUsed: lastUsedRefreshFrom((onFetched) => roomsRef.current.refresh(onFetched)),
			lastUsedInHand: () => roomLastUsedTimes(roomsRef.current.statuses),
		});
	}
	const controller = controllerRef.current;
	const view = useSyncExternalStore(controller.subscribe, controller.getView);
	useEffect(() => {
		if (!homeShown) return;
		controller.arrive();
		return () => controller.leave();
	}, [controller, homeShown]);
	return { view, choose: controller.choose };
}
