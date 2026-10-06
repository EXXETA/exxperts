// The home screen's order controller, held to its five rules with a transport
// whose answers the smoke releases by hand: which answer arrives when is the
// whole subject. No server, no file, no browser: the module is plain.
const { createHomeRoomOrderController, lastUsedRefreshFrom } = await import("../../web-ui/src/home-room-order.js");
const { orderRooms, ROOM_ORDER_MODES } = await import("../src/room-order.js");
type RoomOrderMode = "recent" | "name-asc" | "name-desc" | "custom";
type Choice = { mode: RoomOrderMode; customOrder?: string[] };
type Times = ReadonlyMap<string, number>;
export {}; // a module, so the top-level awaits below are allowed

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}

interface Pending {
	kind: "read" | "save" | "refresh";
	choice?: Choice;
	resolve: (value: any) => void;
	reject: (error: unknown) => void;
}

function answer(mode: RoomOrderMode, extra: { unreadable?: string; saveBlocked?: true; customOrder?: string[] } = {}) {
	const { customOrder = [], ...rest } = extra;
	return { order: { mode, customOrder, updatedAt: null, ...rest }, modes: [...ROOM_ORDER_MODES] };
}

function harness() {
	const pending: Pending[] = [];
	let emitted = 0;
	// The rooms' times the home screen has in hand; a block sets it as the app's state would move.
	const hand = { times: new Map<string, number>() as Times };
	const controller = createHomeRoomOrderController({
		read: () => new Promise((resolve, reject) => { pending.push({ kind: "read", resolve, reject }); }),
		save: (choice: Choice) => new Promise((resolve, reject) => { pending.push({ kind: "save", choice, resolve, reject }); }),
		refreshLastUsed: () => new Promise((resolve, reject) => { pending.push({ kind: "refresh", resolve, reject }); }),
		lastUsedInHand: () => hand.times,
	});
	controller.subscribe(() => { emitted += 1; });
	return {
		controller,
		pending,
		hand,
		emitted: () => emitted,
		take(kind: "read" | "save" | "refresh"): Pending {
			const index = pending.findIndex((entry) => entry.kind === kind);
			assert(index >= 0, `expected a ${kind} in flight, found ${pending.map((entry) => entry.kind).join(",") || "none"}`);
			return pending.splice(index, 1)[0];
		},
		inFlight: (kind: "read" | "save" | "refresh") => pending.filter((entry) => entry.kind === kind).length,
	};
}

// Lets every promise callback queued so far run.
const settle = async (): Promise<void> => { for (let i = 0; i < 6; i++) await Promise.resolve(); };

// --- Rule 1: every arrival withholds the order until its own read settles ---
{
	const h = harness();
	assert(h.controller.getView().order === null && h.inFlight("read") === 0, "before any arrival: nothing drawn, nothing read");
	h.controller.arrive();
	await settle();
	assert(h.controller.getView().order === null && h.inFlight("read") === 1, "an arrival reads, and draws nothing meanwhile");
	assert(await h.controller.choose({ mode: "name-desc" }) === false && h.inFlight("save") === 0, "with nothing drawn there is nothing to choose from: no save can start while a read is in flight");
	h.take("read").resolve(answer("name-desc"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-desc", "the read's answer is drawn");

	h.controller.leave();
	assert(h.controller.getView().order === null, "leaving forgets the drawn order");
	h.controller.arrive();
	await settle();
	assert(h.controller.getView().order === null && h.inFlight("read") === 1, "a later arrival withholds again: the order known from before is not drawn ahead of the read");
	h.take("read").resolve(answer("name-asc"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-asc", "and draws what another door saved meanwhile, once, not as a re-order");
}

// --- A read that fails: the last order known, silently; with none known, A to Z and the reason ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	const first = h.controller.getView().order;
	assert(first?.mode === "name-asc" && first.loadFailed === true, "nothing known and the read fails: A to Z, and the control can say why");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-desc"));
	await settle();
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	const later = h.controller.getView().order;
	assert(later?.mode === "name-desc" && later.loadFailed === false, "a later read that fails shows the last order known, without a complaint");
}

// --- A read answered after the home screen was left, or after a newer arrival, draws nothing ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	const stale = h.take("read");
	h.controller.leave();
	stale.resolve(answer("name-desc"));
	await settle();
	assert(h.controller.getView().order === null, "an answer for a home screen that was left is not drawn");
	h.controller.arrive();
	h.controller.leave();
	h.controller.arrive(); // the double arrival of a strict-mode effect
	await settle();
	assert(h.inFlight("read") === 1, "an arrival superseded before it could read does not read at all");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	assert(h.inFlight("read") === 2, "an arrival superseded while its read is in flight leaves that read behind");
	h.take("read").resolve(answer("name-desc"));
	await settle();
	assert(h.controller.getView().order === null, "the superseded arrival's answer is ignored");
	h.take("read").resolve(answer("name-asc"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-asc", "the current arrival's answer is drawn: the grid cannot get stuck");
}

// --- A save on the same visit: saved first, drawn after; a failure says so and changes nothing ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	assert(h.controller.getView().saving === true && h.controller.getView().order?.mode === "name-asc", "while the save is in flight the rooms stay where they are");
	assert(await h.controller.choose({ mode: "name-asc" }) === false && h.inFlight("save") === 1, "a second choice during a save does not start a second save");
	h.take("save").resolve(answer("name-desc"));
	assert(await chosen === true, "the choice reports it is saved");
	assert(h.controller.getView().order?.mode === "name-desc" && h.controller.getView().saving === false, "and only then is it drawn");

	const failing = h.controller.choose({ mode: "name-asc" });
	h.take("save").reject(new Error("Saving the order failed because of a server error, and the saved order was not changed. Check the server logs for details."));
	assert(await failing === false, "a failed save reports it");
	const afterFailure = h.controller.getView();
	assert(afterFailure.order?.mode === "name-desc" && afterFailure.saving === false, "the rooms stay where they were");
	assert(afterFailure.saveError?.startsWith("Saving the order failed"), "and the server's sentence is kept for the control");

	// A failed save may have landed: while one is remembered, the order on
	// screen is not known to be the one saved, so choosing it is sent too.
	const backOut = h.controller.choose({ mode: "name-desc" });
	assert(h.inFlight("save") === 1 && h.controller.getView().saveError === null, "after a failed save, choosing the order on screen is a save, and a save starting clears the sentence");
	h.take("save").resolve(answer("name-desc"));
	assert(await backOut === true && h.controller.getView().order?.mode === "name-desc", "so the user's last choice is what is saved, whatever became of the failed one");
	assert(await h.controller.choose({ mode: "name-desc" }) === true && h.inFlight("save") === 0, "with nothing failed in memory, choosing the order already saved needs no save");

	const engine = h.controller.choose({ mode: "name-asc" });
	h.take("save").reject("not even an Error");
	await engine;
	assert(h.controller.getView().saveError === "The order was not saved. Try again.", "a rejection without a sentence gets ours, never the engine's");
	const retry = h.controller.choose({ mode: "name-asc" });
	assert(h.controller.getView().saveError === null, "another save starting clears the sentence");
	h.take("save").resolve(answer("name-asc"));
	await retry;
}

// --- With an order that could not be used or loaded, choosing the order on screen is still a save ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc", { unreadable: "its contents are not what the app saved" }));
	await settle();
	const repair = h.controller.choose({ mode: "name-asc" });
	assert(h.inFlight("save") === 1, "the unusable file is replaced by choosing, even the order already shown");
	h.take("save").resolve(answer("name-asc"));
	assert(await repair === true && h.controller.getView().order?.unreadable === null, "and the complaint is gone");

	const unreachable = harness();
	unreachable.controller.arrive();
	await settle();
	unreachable.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	const probe = unreachable.controller.choose({ mode: "name-asc" });
	assert(unreachable.inFlight("save") === 1, "after a first read that failed, choosing the A to Z on screen is a save too: it is what finds out whether the server answers now");
	unreachable.take("save").resolve(answer("name-asc"));
	assert(await probe === true && unreachable.controller.getView().order?.loadFailed === false, "and the complaint is gone");

	const blocked = harness();
	blocked.controller.arrive();
	await settle();
	blocked.take("read").resolve(answer("name-asc", { unreadable: "it is a folder, not a file", saveBlocked: true }));
	await settle();
	assert(blocked.controller.getView().order?.saveBlocked === true && h.controller.getView().order?.saveBlocked === false, "the read's saveBlocked flag reaches the view, and only when the read set it");
}

// --- A superseded arrival whose read FAILS draws nothing either ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	const superseded = h.take("read");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	superseded.reject(new Error("The saved order could not be loaded."));
	await settle();
	assert(h.controller.getView().order === null, "the failed read of an arrival that is no longer current does not draw A to Z under the current one");
	h.take("read").resolve(answer("name-desc"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-desc" && h.controller.getView().order?.loadFailed === false, "the current arrival's read decides");
}

// --- Rules 2 and 3: a save from an earlier visit. The arrival waits for it, reads after, and its answer is never drawn ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	h.controller.leave();
	h.controller.arrive();
	await settle();
	assert(h.inFlight("read") === 0 && h.controller.getView().order === null, "an arrival that finds a save in flight does not read yet, and draws nothing");
	h.take("save").resolve(answer("name-desc"));
	assert(await chosen === true, "the earlier visit's save lands");
	assert(h.controller.getView().order === null, "its answer is remembered, not drawn: no card, no live control before this arrival's own read");
	assert(await h.controller.choose({ mode: "name-asc" }) === false && h.inFlight("save") === 0, "so no newer choice exists that the read could overwrite");
	await settle();
	assert(h.inFlight("read") === 1, "the read starts once the save has settled");
	h.take("read").resolve(answer("name-desc"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-desc", "and tells the state after the save");
}

// --- Rule 3, "remembered": a save that landed while away is the last order known when the next read fails ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	h.controller.leave();
	h.take("save").resolve(answer("name-desc"));
	await chosen;
	h.controller.arrive();
	await settle();
	h.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	assert(h.controller.getView().order?.mode === "name-desc", "the read failed, and the order drawn is the one that save left, not the one from before it");
}

// --- Rule 4: a save that fails after the home screen was left is said on the next arrival ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	h.controller.leave();
	h.take("save").reject(new Error("Saving the order failed because of a server error, and the saved order was not changed. Check the server logs for details."));
	assert(await chosen === false, "the save fails while the user is in a room");
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const back = h.controller.getView();
	assert(back.order?.mode === "name-asc" && back.saveError?.startsWith("Saving the order failed"), "back home, the order is the previous one and the failure is said");
	const retry = h.controller.choose({ mode: "name-desc" });
	h.take("save").resolve(answer("name-desc"));
	await retry;
	assert(h.controller.getView().saveError === null && h.controller.getView().order?.mode === "name-desc", "the retry clears it");
}

// --- Rule 4: the sentence stays until another save starts; the controller never guesses when it was seen ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	h.take("save").reject(new Error("Saving the order failed because of a server error, and the saved order was not changed. Check the server logs for details."));
	await chosen;
	for (let arrival = 1; arrival <= 3; arrival++) {
		h.controller.leave();
		h.controller.arrive();
		assert(h.controller.getView().saveError !== null, `arrival ${arrival}: kept while the order is withheld (nothing is on screen to have shown it)`);
		await settle();
		h.take("read").resolve(answer("name-asc"));
		await settle();
		assert(h.controller.getView().saveError?.startsWith("Saving the order failed"), `arrival ${arrival}: still said, the file still holds the other order`);
	}
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	assert(h.controller.getView().saveError !== null, "an arrival whose read fails learns nothing about what is saved, and forgets nothing");
	const onScreen = h.controller.choose({ mode: "name-asc" });
	assert(h.inFlight("save") === 1, "so choosing the order on screen is still sent as a save");
	h.take("save").resolve(answer("name-asc"));
	assert(await onScreen === true && h.controller.getView().saveError === null, "and that save is what clears the sentence");
}

// --- Rule 4, the lost answer beside an unusable file: 'not saved' is not withdrawn on the strength of a file that cannot be read ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-desc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-asc" });
	h.controller.leave();
	h.take("save").reject(new Error("The order was not saved. Try again."));
	await chosen;
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc", { unreadable: "its contents are not what the app saved" }));
	await settle();
	assert(h.controller.getView().saveError !== null, "an unusable file reads as A to Z by default, which proves nothing about the failed A to Z choice");
}

// --- Rule 4, the lost answer: the save "failed" here but landed there; the next read finds it saved and the sentence is withdrawn ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const chosen = h.controller.choose({ mode: "name-desc" });
	h.take("save").reject(new Error("The order was not saved. Try again."));
	await chosen;
	assert(h.controller.getView().saveError !== null, "the lost answer reads as a failure at first");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-desc"));
	await settle();
	const found = h.controller.getView();
	assert(found.order?.mode === "name-desc" && found.saveError === null, "the read shows the choice saved after all, and 'not saved' is not said beside it");
}

// --- Rule 5: "recently used" is drawn over times held still for the visit ---
const T = (day: number): number => Date.parse(`2026-09-${String(day).padStart(2, "0")}T10:00:00.000Z`);
const times = (entries: Record<string, number>): Times => new Map(Object.entries(entries));
const shown = (view: { lastUsed: Times }): string => [...view.lastUsed].map(([id, time]) => `${id}=${new Date(time).getUTCDate()}`).sort().join(",");
const rooms = [{ id: "a", displayName: "Alpha" }, { id: "b", displayName: "Bravo" }, { id: "c", displayName: "Charlie" }];
const drawn = (view: { order: { mode: RoomOrderMode } | null; lastUsed: Times }): string => view.order ? orderRooms(rooms, view.order, view.lastUsed).map((room: { id: string }) => room.id).join("") : "(withheld)";
{
	// The read answers first: the arrival goes on withholding until its own
	// refresh of the rooms has answered, so the room just left leads at once.
	const h = harness();
	h.hand.times = times({ a: T(10), b: T(5) });
	h.controller.arrive();
	await settle();
	assert(h.inFlight("refresh") === 1 && h.inFlight("read") === 1, "an arrival refreshes the rooms beside its read, once");
	h.take("read").resolve(answer("recent"));
	await settle();
	assert(h.controller.getView().order === null, "recently used is not drawn over the times in hand while the arrival's refresh is in flight");
	assert(await h.controller.choose({ mode: "name-asc" }) === false && h.inFlight("save") === 0, "and nothing can be chosen meanwhile");
	h.take("refresh").resolve(times({ a: T(10), b: T(5), c: T(17) }));
	await settle();
	assert(drawn(h.controller.getView()) === "cab", "drawn once, with the room the refresh found used last in the lead");
	assert(h.controller.getView().saveError === null && h.controller.getView().order?.loadFailed === false, "and nothing is said");

	// The rooms go on being refreshed under the visit; the frozen times do not move.
	const frozen = h.controller.getView();
	h.hand.times = times({ a: T(10), b: T(18), c: T(17) });
	await settle();
	assert(h.controller.getView() === frozen && drawn(h.controller.getView()) === "cab", "a refresh of the rooms during the visit moves no card");

	// Leaving and coming back takes the times again.
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("recent"));
	h.take("refresh").resolve(times({ a: T(10), b: T(18), c: T(17) }));
	await settle();
	assert(drawn(h.controller.getView()) === "bca", "the next arrival draws the order as it is by then");
}
{
	// The refresh answers first, and the app has not caught up with it yet: the
	// times in hand are behind. What the refresh fetched is what is frozen.
	const h = harness();
	h.hand.times = times({ a: T(10), b: T(5) });
	h.controller.arrive();
	await settle();
	h.take("refresh").resolve(times({ a: T(10), b: T(16) }));
	await settle();
	assert(h.controller.getView().order === null, "a refresh alone draws nothing: the order is not known yet");
	h.take("read").resolve(answer("recent"));
	await settle();
	assert(drawn(h.controller.getView()) === "bac" && shown(h.controller.getView()) === "a=10,b=16", "the fetched times win over older ones in hand");
}
{
	// Room by room the newer reading wins, whichever source has it, and a room only one of them knows is kept.
	const h = harness();
	h.hand.times = times({ a: T(12), b: T(5), c: T(3) });
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("recent"));
	h.take("refresh").resolve(times({ a: T(10), b: T(16), d: T(1) }));
	await settle();
	assert(shown(h.controller.getView()) === "a=12,b=16,c=3,d=1", "the frozen times are the newer of fetched and in hand, per room");
}
{
	// A refresh that fails, either way it can: the times in hand, silently.
	for (const fail of [(p: Pending) => p.resolve(null), (p: Pending) => p.reject(new Error("TypeError: Failed to fetch"))]) {
		const h = harness();
		h.hand.times = times({ b: T(5) });
		h.controller.arrive();
		await settle();
		h.take("read").resolve(answer("recent"));
		fail(h.take("refresh"));
		await settle();
		const view = h.controller.getView();
		assert(drawn(view) === "bac" && view.saveError === null && view.order?.loadFailed === false && !view.order?.unreadable, "a failed refresh draws recently used over the times in hand and says nothing");
	}
}
{
	// A refresh from an earlier visit answering late is not this visit's.
	const h = harness();
	h.controller.arrive();
	await settle();
	const staleRefresh = h.take("refresh");
	h.take("read").resolve(answer("recent"));
	await settle();
	h.controller.leave();
	staleRefresh.resolve(times({ a: T(1) }));
	await settle();
	assert(h.controller.getView().order === null, "a refresh answering after the home screen was left draws nothing");
	h.controller.arrive();
	await settle();
	const staleRefresh2 = h.take("refresh");
	h.take("read").resolve(answer("recent"));
	await settle();
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("recent"));
	await settle();
	staleRefresh2.resolve(times({ a: T(2) }));
	await settle();
	assert(h.controller.getView().order === null, "the earlier visit's refresh does not end this arrival's wait");
	h.take("refresh").resolve(times({ c: T(3) }));
	await settle();
	assert(shown(h.controller.getView()) === "c=3" && drawn(h.controller.getView()) === "cab", "and its times are not the ones frozen");
}
{
	// A name order never waits for the refresh: slice 1's arrival, untouched.
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-desc"));
	await settle();
	assert(h.inFlight("refresh") === 1 && drawn(h.controller.getView()) === "cba", "a name order is drawn as soon as the read settles, the refresh still in flight");

	// Choosing recently used while that refresh is still in flight: saved first,
	// then the visit's refresh is waited for, then drawn. One move, not two.
	const emittedBefore = h.emitted();
	const choice = h.controller.choose({ mode: "recent" });
	await settle();
	h.take("save").resolve(answer("recent"));
	await settle();
	assert(h.controller.getView().order?.mode === "name-desc" && h.controller.getView().saving === true, "saved, but not drawn ahead of the visit's refresh; the control stays busy");
	h.take("refresh").resolve(times({ b: T(9) }));
	assert(await choice === true, "the choice resolves once drawn");
	assert(drawn(h.controller.getView()) === "bac" && h.controller.getView().saving === false, "drawn over the refreshed times");
	assert(h.emitted() === emittedBefore + 2, "two changes reach the screen: the save starting, and the new order with the save over");

	// Back to a name order and to recently used again, the refresh long settled:
	// the times in hand by then (the rooms have been refreshed since) are frozen.
	const back = h.controller.choose({ mode: "name-asc" });
	await settle();
	h.take("save").resolve(answer("name-asc"));
	assert(await back === true && drawn(h.controller.getView()) === "abc", "a name order again");
	h.hand.times = times({ b: T(9), c: T(20) });
	const again = h.controller.choose({ mode: "recent" });
	await settle();
	h.take("save").resolve(answer("recent"));
	assert(await again === true && drawn(h.controller.getView()) === "cba" && h.inFlight("refresh") === 0, "a later choice of recently used freezes the times in hand, with no new refresh");
}
{
	// Left while the arrival waited for its refresh: nothing is drawn, then or later.
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("recent"));
	await settle();
	const emittedBefore = h.emitted();
	h.controller.leave();
	h.take("refresh").resolve(times({ a: T(1) }));
	await settle();
	assert(h.controller.getView().order === null && h.emitted() === emittedBefore + 1, "only the leaving reaches the screen");
	assert(await h.controller.choose({ mode: "name-asc" }) === false && h.inFlight("save") === 0, "and the controller holds no order either: nothing can be chosen on a home screen that is not shown");
}
{
	// A read that fails with recently used as the last order known waits the same way.
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("recent"));
	h.take("refresh").resolve(times({ a: T(1) }));
	await settle();
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").reject(new Error("The saved order could not be loaded."));
	await settle();
	assert(h.controller.getView().order === null, "the last order known, recently used, is not drawn ahead of the refresh either");
	h.take("refresh").resolve(times({ c: T(2) }));
	await settle();
	assert(drawn(h.controller.getView()) === "cab" && h.controller.getView().order?.loadFailed === false, "then drawn, silently");
}

// --- No wait outlives its visit: a choice waiting for a refresh that never answers ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const stuckRefresh = h.take("refresh");
	const choice = h.controller.choose({ mode: "recent" });
	await settle();
	h.take("save").resolve(answer("recent"));
	await settle();
	assert(h.controller.getView().saving === true && h.controller.getView().order?.mode === "name-asc", "fixture: saved, waiting for the visit's refresh to be drawn");
	// Leaving ends the wait: the choice settles (it IS saved), undrawn, and the control is not left busy.
	h.controller.leave();
	assert(await choice === true, "the choice resolves: what was chosen is what is saved");
	await settle();
	assert(h.controller.getView().saving === false && h.controller.getView().order === null, "leaving ends the wait: saving cleared, nothing drawn");
	// The next arrival is held by nothing: its read goes out, its own refresh is waited for, the stuck one is not.
	h.controller.arrive();
	await settle();
	assert(h.inFlight("read") === 1 && h.inFlight("refresh") === 1, "the next arrival reads at once and refreshes for itself");
	h.take("read").resolve(answer("recent"));
	h.take("refresh").resolve(times({ b: T(9) }));
	await settle();
	assert(drawn(h.controller.getView()) === "bac" && h.controller.getView().saving === false, "and draws the saved order over its own times");
	const usable = h.controller.choose({ mode: "name-asc" });
	await settle();
	assert(h.inFlight("save") === 1, "and the control can be used: a choice sends its save");
	h.take("save").resolve(answer("name-asc"));
	assert(await usable === true && drawn(h.controller.getView()) === "abc", "which is drawn as usual");
	stuckRefresh.resolve(times({ c: T(20) }));
	await settle();
	assert(drawn(h.controller.getView()) === "abc", "the old visit's refresh answering at last changes nothing");
}
{
	// A new arrival supersedes a visit the same way as leaving does: a choice
	// waiting on the first visit's refresh settles, and the control is not left busy.
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	h.take("refresh");
	const choice = h.controller.choose({ mode: "recent" });
	await settle();
	h.take("save").resolve(answer("recent"));
	await settle();
	assert(h.controller.getView().saving === true, "fixture: saved, waiting for the first visit's refresh");
	const emittedBefore = h.emitted();
	h.controller.arrive();
	assert(await choice === true, "the choice settles when a new arrival supersedes its visit");
	await settle();
	assert(h.controller.getView().order === null && h.controller.getView().saving === false, "the second arrival withholds, and the first visit's wait ended with saving cleared");
	assert(h.emitted() >= emittedBefore + 1, "fixture: the screen was told");
	h.take("read").resolve(answer("recent"));
	h.take("refresh").resolve(times({ a: T(1) }));
	await settle();
	assert(drawn(h.controller.getView()) === "abc", "and only the second arrival's answers are drawn");
}
{
	// An arrival waits for a save until the SERVER has answered, not until the answer is drawn.
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const choice = h.controller.choose({ mode: "recent" });
	await settle();
	const save = h.take("save");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	assert(h.inFlight("read") === 0, "rule 2: the arrival waits while the server has not answered the save");
	save.resolve(answer("recent"));
	assert(await choice === true, "fixture: the save answered, on a visit that is over");
	await settle();
	assert(h.inFlight("read") === 1, "the server's answer releases the arrival's read");
}

// --- The app's refresh as the controller's: told once, and never left waiting ---
{
	const never = new Promise<void>(() => {});
	const list = [{ id: "a", lastUsedAt: "2026-09-17T10:00:00.000Z" }, { id: "b", lastUsedAt: null }, { id: "c", lastUsedAt: "yesterday" }, { id: "d" }];
	const told = await lastUsedRefreshFrom((onFetched: (rooms: typeof list | null) => void) => { onFetched(list); return never; })();
	assert(told instanceof Map && [...told.keys()].join(",") === "a" && told.get("a") === T(17), "the list the refresh tells becomes times at once, without waiting for the refresh to end, by the ONE reading");
	assert(await lastUsedRefreshFrom((onFetched: (rooms: typeof list | null) => void) => { onFetched(null); return never; })() === null, "told null: failed");
	assert(await lastUsedRefreshFrom(async () => {})() === null, "a refresh that ends without telling anything: failed, not waited for");
	assert(await lastUsedRefreshFrom(async () => { throw new Error("boom"); })() === null, "a refresh that rejects: failed");
	assert(await lastUsedRefreshFrom(() => { throw new Error("boom"); })() === null, "a refresh that throws: failed");
	const first = await lastUsedRefreshFrom(async (onFetched: (rooms: typeof list | null) => void) => { onFetched(list); onFetched([]); })();
	assert(first?.size === 1, "the first thing told wins");
}

// --- An arrangement is a choice: always sent (it is the user's Save), drawn with its ids once the server answers ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("custom", { customOrder: ["a", "b"] }));
	await settle();
	assert(h.controller.getView().order?.mode === "custom" && h.controller.getView().order?.customOrder.join(",") === "a,b", "the read's arrangement is drawn with its mode");
	assert(await h.controller.choose({ mode: "custom" }) === true && h.inFlight("save") === 0, "the mode on screen chosen again: nothing to save");
	const save = h.controller.choose({ mode: "custom", customOrder: ["a", "b"] });
	await settle();
	assert(h.inFlight("save") === 1 && h.controller.getView().saving === true, "the same arrangement chosen again IS sent: Save is a save");
	const inFlight = h.take("save");
	assert(JSON.stringify(inFlight.choice) === JSON.stringify({ mode: "custom", customOrder: ["a", "b"] }), "as the choice it is");
	assert(h.controller.getView().order?.customOrder.join(",") === "a,b", "and nothing moves until the server answers");
	inFlight.resolve(answer("custom", { customOrder: ["b", "a", "c"] }));
	assert(await save === true, "true: what was chosen is what is saved (arrange mode closes)");
	assert(h.controller.getView().order?.customOrder.join(",") === "b,a,c" && h.controller.getView().saving === false, "what the server holds after the merge is what is drawn, not what was sent");
	const drawn = h.controller.getView().order;
	h.take("refresh").resolve(null);
	await settle();
	assert(h.controller.getView().order === drawn, "a custom order does not wait for the rooms' refresh (only recently used does)");
}

// --- A failed arrangement is remembered like a failed mode, and no read can withdraw it: only the next save starting ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const save = h.controller.choose({ mode: "custom", customOrder: ["b", "a"] });
	await settle();
	h.take("save").reject(new Error("The order was not saved. Try again."));
	assert(await save === false, "false: arrange mode stays open");
	let view = h.controller.getView();
	assert(view.saveError === "The order was not saved. Try again." && view.order?.mode === "name-asc", "the sentence is said and the rooms stay where they were");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("custom", { customOrder: ["b", "a"] }));
	await settle();
	view = h.controller.getView();
	assert(view.order?.mode === "custom" && view.order?.customOrder.join(",") === "b,a" && view.saveError !== null, "a read that finds mode custom, even with the very ids, does not withdraw it: the server merges, so the read cannot tell whether THIS save landed");
	const again = h.controller.choose({ mode: "custom" });
	await settle();
	assert(h.inFlight("save") === 1, "while it is remembered, choosing the mode on screen is sent like any choice (rule 4)");
	assert(h.controller.getView().saveError === null, "and a save starting is what clears the sentence");
	h.take("save").resolve(answer("custom", { customOrder: ["b", "a"] }));
	assert(await again === true && h.controller.getView().saveError === null && h.controller.getView().saving === false, "settled");
}

// --- A failed MODE is still withdrawn by a read that finds it saved (rule 4, unchanged by slice 3) ---
{
	const h = harness();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("name-asc"));
	await settle();
	const save = h.controller.choose({ mode: "custom" });
	await settle();
	h.take("save").reject(new Error("The order was not saved. Try again."));
	assert(await save === false && h.controller.getView().saveError !== null, "a failed mode is remembered");
	h.controller.leave();
	h.controller.arrive();
	await settle();
	h.take("read").resolve(answer("custom", { customOrder: ["x"] }));
	await settle();
	assert(h.controller.getView().saveError === null && h.controller.getView().order?.mode === "custom", "and withdrawn when the read finds that mode saved after all");
}

// --- The view object changes only when something did (what useSyncExternalStore needs) ---
{
	const h = harness();
	const before = h.controller.getView();
	assert(h.controller.getView() === before, "reading the view twice gives the same object");
	h.controller.arrive();
	assert(h.controller.getView() !== before && h.emitted() === 1, "a change gives a new one and tells the listeners");
}

// --- The client (the REAL room-order-api.ts over a stubbed fetch): which sentences are kept verbatim, which are replaced by ours ---
{
	const { saveRoomOrder, fetchRoomOrder } = await import("../../web-ui/src/room-order-api.js");
	const saveRoomOrderMode = (mode: RoomOrderMode) => saveRoomOrder({ mode });
	const realFetch = globalThis.fetch;
	const respond = (status: number, body: unknown, json = true) => { globalThis.fetch = (async () => new Response(json ? JSON.stringify(body) : String(body), { status })) as typeof fetch; };
	const failure = async (run: () => Promise<unknown>): Promise<string> => { try { await run(); } catch (error) { return (error as Error).message; } throw new Error("expected the request to fail"); };
	const realWarn = console.warn;
	const warned: string[] = []; // what the client logs instead of putting on the face
	console.warn = (...args: unknown[]) => { warned.push(args.map(String).join(" ")); };
	try {
		const folder = "The order was not saved: a folder was found where the saved order (room-order.json) belongs. Remove that folder, then choose the order again.";
		respond(400, { error: folder });
		assert(await failure(() => saveRoomOrderMode("name-desc")) === folder, "the route's own 400 is kept as written");
		respond(500, { error: "Saving the order failed because of a server error, and the saved order was not changed. Check the server logs for details." });
		assert((await failure(() => saveRoomOrderMode("name-desc"))).startsWith("Saving the order failed"), "and its own 500");
		const viewingOnly = "This device is set to viewing only. Change it on the computer to interact remotely.";
		respond(403, { error: viewingOnly, code: "remote_read_only" });
		assert(await failure(() => saveRoomOrderMode("name-desc")) === "The order was not saved. Try again.", "a sentence this feature did not write is not put on the face: ours instead, never a fact that may stop being true");
		assert(warned.length === 1 && warned[0].includes("403") && warned[0].includes(viewingOnly), `and the server's words go to the console: ${warned.join(" | ")}`);
		assert(await failure(() => fetchRoomOrder()) === "The saved order could not be loaded.", "on the read too");
		respond(404, { message: "Route PUT:/api/settings/room-order not found", error: "Not Found", statusCode: 404 });
		assert(await failure(() => saveRoomOrderMode("name-desc")) === "The order was not saved. Try again." && warned.at(-1)?.includes("Not Found"), "a server too old for the route: our sentence, its \"Not Found\" in the console only");
		respond(502, "<html>Bad Gateway</html>", false);
		assert(await failure(() => saveRoomOrderMode("name-desc")) === "The order was not saved. Try again.", "no sentence at all: ours");
		globalThis.fetch = (async () => { throw new TypeError("Load failed"); }) as typeof fetch;
		assert(await failure(() => saveRoomOrderMode("name-desc")) === "The order was not saved. Try again.", "no answer at all: ours, never the engine's");
		respond(200, { nothing: "like the payload" });
		assert(await failure(() => saveRoomOrderMode("name-desc")) === "The order was not saved. Try again.", "an OK answer that is not the payload: ours");
		respond(200, answer("name-desc"));
		assert((await saveRoomOrderMode("name-desc") as any).order.mode === "name-desc", "and the payload passes through");
		respond(200, { order: { mode: "custom", updatedAt: null }, modes: [...ROOM_ORDER_MODES] });
		assert(await failure(() => fetchRoomOrder()) === "The saved order could not be loaded.", "an OK answer without the arrangement is not the payload (an older server): ours");
		// ONE fallback for a mode and an arrangement alike: it names no control, because the sentence is kept and drawn wherever the user is next.
		respond(502, "<html>Bad Gateway</html>", false);
		const arrangementFallback = await failure(() => saveRoomOrder({ mode: "custom", customOrder: ["b", "a"] }));
		assert(arrangementFallback === "The order was not saved. Try again.", `the one fallback: ${arrangementFallback}`);
		assert(!/\b(there is|is unchanged|are unchanged|remains|still)\b/i.test(arrangementFallback) && /\b(was|were|failed)\b/i.test(arrangementFallback), "and it speaks of the attempt");
		let sent: unknown = null;
		globalThis.fetch = (async (_url: string, init?: RequestInit) => { sent = JSON.parse(String(init?.body)); return new Response(JSON.stringify(answer("custom", { customOrder: ["b", "a", "c"] })), { status: 200 }); }) as typeof fetch;
		const saved = await saveRoomOrder({ mode: "custom", customOrder: ["b", "a"] });
		assert(JSON.stringify(sent) === JSON.stringify({ mode: "custom", customOrder: ["b", "a"] }) && saved.order.customOrder.join(",") === "b,a,c", "the choice goes out as it is, and the merged arrangement comes back");
	} finally {
		globalThis.fetch = realFetch;
		console.warn = realWarn;
	}
}

console.log("room-order-home smoke: ok");
