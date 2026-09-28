import { ROOM_ORDER_DEFAULT_MODE, roomLastUsedTimes, type RoomLastUsedTimes, type RoomOrderChoice, type RoomOrderMode } from "../../web-server/src/room-order";
import { ROOM_ORDER_SAVE_FALLBACK, type RoomOrderResponse } from "./room-order-api";

/**
 * The home screen's order, owned in ONE place: what is drawn, what was last
 * known, whether a save is in flight, what a failed save has to say, and the
 * sequencing between reads and saves. No React in here, so the smoke holds
 * every rule below against this module itself; `use-home-room-order.ts` is
 * the thin hook around it, and the sort control only draws what it is given.
 *
 * The rules:
 *
 * 1. Every arrival at the home screen withholds the order (`order` is null:
 *    no card, no control) until that arrival's own read has settled. Rooms
 *    are never drawn in an order a read still in flight could change.
 * 2. Reads and saves never overlap. While a read is in flight there is no
 *    control, so no save can start; an arrival that finds a save still in
 *    flight (started on an earlier visit) waits for it to settle and reads
 *    after. A read therefore always tells the state after the save, and no
 *    read can overwrite a choice.
 * 3. A save's answer is drawn only on the visit it was started on. An answer
 *    from an earlier visit is remembered, never drawn: the arrival reads for
 *    itself.
 * 4. A failed save is remembered exactly like a successful one. Its sentence
 *    outlives the control that started it and is shown on the next arrival.
 *    A failed save may still have landed (the answer was lost, not the save),
 *    so while one is remembered the controller does not know what is saved:
 *    every choice is then sent as a save, the order on screen included, and
 *    a read that finds the failed choice saved after all withdraws the
 *    sentence. Only a choice of mode can be found saved that way: a failed
 *    arrangement is merged on the server into a list this screen may not
 *    have seen whole, so no read can tell whether it landed, and its
 *    sentence stays until another save starts. It can be kept
 *    that long because of what room-order-api.ts lets through: the route's own
 *    refusals, which speak of the attempt ("was not saved", "failed", "was
 *    not changed") and never of the disk as it is; this client's own
 *    fallbacks, which do the same; and any sentence from elsewhere (the
 *    remote gate, a proxy) only as a quotation of what the server answered
 *    then. None of these turns false while it waits. The controller does not
 *    know what is on screen and must not guess when a sentence was seen.
 * 5. "Recently used" orders by times held still for the visit (`lastUsed`),
 *    never by the rooms as they change: the rooms are refreshed every few
 *    seconds while one is answering, and cards must not move under the eyes.
 *    Every arrival starts its own refresh of the rooms beside its read; when
 *    the order to draw is "recently used", the arrival also waits for that
 *    refresh, so the room just left leads at once instead of jumping there
 *    a moment later. A name order never waits for the refresh. The times
 *    frozen are, room by room, the newer of what the visit's refresh fetched
 *    and what the home screen has in hand: a time of use only ever moves
 *    forward, so the newer one is the true one whichever source is behind.
 *    A refresh that fails leaves the times in hand, silently, like a read
 *    that fails. Choosing "recently used" during a visit freezes the times
 *    the same way when the answer is drawn. A room that is not in the times
 *    (created during the visit) counts as never used until the next arrival.
 *    No wait outlives its visit: leaving the home screen ends the wait for
 *    the refresh, so a choice whose answer was waiting to be drawn settles
 *    (undrawn, `saving` cleared) and the next arrival is not held by it. An
 *    arrival waits for a save in flight only until the server has answered,
 *    never for the drawing of that answer.
 *
 * A read that fails shows the last order known, silently; with none known,
 * A to Z, and `loadFailed` lets the control say why.
 */

/** What the home screen knows about the saved order once a read has settled. */
export interface HomeRoomOrder {
	mode: RoomOrderMode;
	/** The saved arrangement, as the read told it; only "custom" reads it (orderRooms reconciles it against the rooms). */
	customOrder: readonly string[];
	unreadable: string | null;
	saveBlocked: boolean;
	loadFailed: boolean;
}

export interface HomeRoomOrderView {
	/** Null while withheld: draw no card and no control. */
	order: HomeRoomOrder | null;
	saving: boolean;
	saveError: string | null;
	/** The rooms' last-used times as this visit froze them; only "recently used" reads them. The same map until the next arrival or choice. */
	lastUsed: RoomLastUsedTimes;
}

export interface HomeRoomOrderTransport {
	read: () => Promise<RoomOrderResponse>;
	save: (choice: RoomOrderChoice) => Promise<RoomOrderResponse>;
	/** Refreshes the rooms and resolves with the last-used times of the list it fetched, or null when it could not. Never rejects. */
	refreshLastUsed: () => Promise<RoomLastUsedTimes | null>;
	/** The last-used times of the rooms the home screen holds right now. */
	lastUsedInHand: () => RoomLastUsedTimes;
}

/** The rooms' refresh as the app offers it: it tells the list it fetched (null when the fetch failed) as soon as it has it, and may go on working after. */
export type RefreshRooms = (onFetched: (rooms: ReadonlyArray<{ id: string; lastUsedAt?: string | null }> | null) => void) => Promise<unknown>;

/**
 * `refreshLastUsed` over the app's refresh. The first thing told wins; a
 * refresh that ends or fails without having told anything counts as failed,
 * so an arrival waiting on it is never left waiting by a refresh that forgot.
 */
export function lastUsedRefreshFrom(refresh: RefreshRooms): () => Promise<RoomLastUsedTimes | null> {
	return () => new Promise((resolve) => {
		let settled: Promise<unknown>;
		try {
			settled = Promise.resolve(refresh((rooms) => resolve(rooms ? roomLastUsedTimes(rooms) : null)));
		} catch {
			resolve(null);
			return;
		}
		settled.then(() => resolve(null), () => resolve(null));
	});
}

export interface HomeRoomOrderController {
	getView: () => HomeRoomOrderView;
	subscribe: (listener: () => void) => () => void;
	/** The home screen is shown (again). */
	arrive: () => void;
	/** The home screen is left. */
	leave: () => void;
	/**
	 * Resolves true when what was chosen is what is saved (the control closes
	 * its menu; arrange mode closes), false when the save failed or could not
	 * start. A choice of the mode already on screen is not sent while the saved
	 * order is known to be that mode; it IS sent while a failed save is
	 * remembered, or the saved order could not be used or loaded (rule 4). A
	 * choice carrying an arrangement always is: saving is what the user asked.
	 */
	choose: (choice: RoomOrderChoice) => Promise<boolean>;
}

const NO_TIMES: RoomLastUsedTimes = new Map();

/** Room by room, the newer of two readings of the last-used times. */
function newerTimes(fetched: RoomLastUsedTimes | null, inHand: RoomLastUsedTimes): RoomLastUsedTimes {
	const times = new Map(inHand);
	for (const [id, time] of fetched ?? []) if (time > (times.get(id) ?? Number.NEGATIVE_INFINITY)) times.set(id, time);
	return times;
}

function homeRoomOrderFrom(response: RoomOrderResponse): HomeRoomOrder {
	return { mode: response.order.mode, customOrder: response.order.customOrder, unreadable: response.order.unreadable ?? null, saveBlocked: response.order.saveBlocked === true, loadFailed: false };
}

export function createHomeRoomOrderController(transport: HomeRoomOrderTransport): HomeRoomOrderController {
	let visit = 0;
	let shown = false;
	let order: HomeRoomOrder | null = null;
	let lastKnown: HomeRoomOrder | null = null;
	let saving = false;
	let saveError: string | null = null;
	let failedChoice: RoomOrderChoice | null = null;
	/** Settles when the server has answered the save in flight; never rejects. */
	let saveSettled: Promise<void> = Promise.resolve();
	let lastUsed: RoomLastUsedTimes = NO_TIMES;
	/** This visit's refresh of the rooms; never rejects. */
	let visitRefresh: Promise<RoomLastUsedTimes | null> = Promise.resolve(null);
	/** Resolves when the visit ends (the home screen is left, or a new arrival supersedes it): the end of every wait made for it. */
	let visitEnded: Promise<void> = Promise.resolve();
	let endVisit: () => void = () => {};
	let view: HomeRoomOrderView = { order, saving, saveError, lastUsed };
	const listeners = new Set<() => void>();

	function forgetFailedSave(): void {
		saveError = null;
		failedChoice = null;
	}

	/** Rule 4: a read can only find a MODE saved after all; an arrangement's fate no read can tell. */
	function readFindsFailedChoiceSaved(read: HomeRoomOrder): boolean {
		return failedChoice !== null && failedChoice.customOrder === undefined && !read.unreadable && read.mode === failedChoice.mode;
	}

	function emit(): void {
		view = { order, saving, saveError, lastUsed };
		for (const listener of listeners) listener();
	}

	/**
	 * Draw `next` on the visit `mine`, if it is still the one shown. "Recently
	 * used" first waits for this visit's refresh (it may be bringing the room
	 * just left) and freezes the times.
	 */
	async function draw(next: HomeRoomOrder, mine: number): Promise<void> {
		const current = (): boolean => shown && mine === visit;
		if (!current()) return;
		if (next.mode === "recent") {
			const fetched = await Promise.race([visitRefresh, visitEnded.then(() => null)]);
			if (!current()) return;
			lastUsed = newerTimes(fetched, transport.lastUsedInHand());
		}
		order = next;
	}

	function arrive(): void {
		endVisit();
		visit += 1;
		shown = true;
		order = null;
		emit();
		const mine = visit;
		const current = (): boolean => shown && mine === visit;
		visitEnded = new Promise((resolve) => { endVisit = resolve; });
		visitRefresh = transport.refreshLastUsed().then((times) => times, () => null);
		void saveSettled.then(() => {
			if (!current()) return;
			return transport.read().then(
				async (response) => {
					if (!current()) return;
					lastKnown = homeRoomOrderFrom(response);
					if (readFindsFailedChoiceSaved(lastKnown)) forgetFailedSave();
					await draw(lastKnown, mine);
					if (current()) emit();
				},
				async () => {
					if (!current()) return;
					await draw(lastKnown ?? { mode: ROOM_ORDER_DEFAULT_MODE, customOrder: [], unreadable: null, saveBlocked: false, loadFailed: true }, mine);
					if (current()) emit();
				},
			);
		});
	}

	function leave(): void {
		shown = false;
		order = null;
		endVisit();
		emit();
	}

	function choose(choice: RoomOrderChoice): Promise<boolean> {
		// No order drawn means no control to choose from; `saving` also guards
		// the rapid-double-click race: the second click returns before a second
		// PUT can leave.
		if (!order || saving) return Promise.resolve(false);
		// With a saved order that could not be used or loaded, choosing the
		// order already on screen is still a save: it is what replaces the
		// unusable file, and what finds out whether the server answers now.
		// The same goes while a failed save is remembered: it may have landed,
		// so the order on screen is not known to be the one saved, and choosing
		// it has to be sent like any other choice. An arrangement is always
		// sent: it is the user's Save.
		if (choice.customOrder === undefined && choice.mode === order.mode && !order.unreadable && !order.loadFailed && failedChoice === null) return Promise.resolve(true);
		saving = true;
		forgetFailedSave();
		emit();
		const mine = visit;
		const answered = transport.save(choice);
		saveSettled = answered.then(() => undefined, () => undefined);
		const outcome = answered.then(
			async (response) => {
				lastKnown = homeRoomOrderFrom(response);
				await draw(lastKnown, mine);
				return true;
			},
			(error: unknown) => {
				saveError = error instanceof Error && error.message.trim() ? error.message : ROOM_ORDER_SAVE_FALLBACK;
				failedChoice = choice;
				return false;
			},
		).then((saved) => {
			saving = false;
			emit();
			return saved;
		});
		return outcome;
	}

	return {
		getView: () => view,
		subscribe: (listener) => {
			listeners.add(listener);
			return () => { listeners.delete(listener); };
		},
		arrive,
		leave,
		choose,
	};
}
