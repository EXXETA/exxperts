// The arrangement made in arrange mode (home-room-arrange.ts), held to its
// rules on its own: moves at both ends, what counts as a move, a room gone
// meanwhile, and the leave question. Plain module, no browser.
const { createRoomArrangement, confirmLeavingArrangement, moveByKey, ROOM_ARRANGE_LEAVE_QUESTION } = await import("../../web-ui/src/home-room-arrange.js");
export {}; // a module, so the top-level await above is allowed

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
const ids = (a: { ids: () => string[] }): string => a.ids().join(",");

// --- Opening: the cards as they stand, an id twice counts once, nothing dirty ---
{
	const a = createRoomArrangement(["b", "a", "c"]);
	assert(ids(a) === "b,a,c" && a.count() === 3 && !a.dirty(), "opens on the order given, with nothing to save");
	assert(a.positionOf("b") === 1 && a.positionOf("c") === 3 && a.positionOf("zz") === null, "positions are 1-based; an id not here has none");
	assert(ids(createRoomArrangement(["a", "b", "a"])) === "a,b" && ids(createRoomArrangement([])) === "" && ids(createRoomArrangement(["only"])) === "only", "both ends: a duplicate counts once in its first place, no rooms, one room");
	const copy = a.ids(); copy.push("x");
	assert(ids(a) === "b,a,c", "ids() is a copy: nothing outside can change the arrangement");
}

// --- Moves: one place at a time, both ends are no-ops that return the same arrangement ---
{
	const a = createRoomArrangement(["a", "b", "c"]);
	const later = a.moveLater("a");
	assert(ids(later) === "b,a,c" && later !== a && ids(a) === "a,b,c", "a move returns a new arrangement and leaves the old one as it was");
	assert(later.dirty() && later.positionOf("a") === 2, "and it is something to save");
	assert(ids(later.moveLater("a").moveLater("a")) === ids(later.moveLater("a").moveLater("a")) && later.moveLater("a") !== later.moveLater("a"), "nothing here is shared state: each call computes afresh, the same order from the same moves");
	const end = later.moveLater("a");
	assert(ids(end) === "b,c,a" && end.moveLater("a") === end, "the last room cannot move later: the same arrangement comes back");
	assert(a.moveEarlier("a") === a, "the first room cannot move earlier");
	assert(a.moveEarlier("nope") === a && a.moveLater("nope") === a, "an id not here moves nothing");
	assert(ids(end.moveEarlier("a")) === "b,a,c" && ids(end.moveEarlier("a").moveEarlier("a")) === "a,b,c", "and back, one place at a time");
	const one = createRoomArrangement(["only"]);
	assert(one.moveEarlier("only") === one && one.moveLater("only") === one, "one room: both ends at once");
}

// --- Dirty is the difference from the opening order, not the number of clicks ---
{
	const a = createRoomArrangement(["a", "b", "c"]);
	const back = a.moveLater("a").moveEarlier("a");
	assert(!back.dirty() && ids(back) === "a,b,c", "a move undone by the opposite move leaves nothing to save");
	assert(ids(a.moveLater("a").moveLater("b")) === "a,b,c" && !a.moveLater("a").moveLater("b").dirty(), "a later then b later brings a,b,c back: nothing to save, whatever the click count");
	assert(ids(a.moveLater("a").moveEarlier("c")) === "b,c,a" && a.moveLater("a").moveEarlier("c").dirty(), "two moves that do not cancel are something to save");
	assert(!a.moveLater("c").dirty(), "a move that could not happen is not one");
}

// --- A drop: the room to a position, the others closing up; both ends, out of range, where it already is ---
{
	const a = createRoomArrangement(["a", "b", "c", "d"]);
	const dropped = a.moveTo("a", 3);
	assert(ids(dropped) === "b,c,a,d" && dropped.dirty() && dropped.positionOf("a") === 3 && ids(a) === "a,b,c,d", "a to 3: b and c close up, a takes the third place, the old arrangement is untouched");
	assert(ids(a.moveTo("d", 1)) === "d,a,b,c" && ids(a.moveTo("a", 4)) === "b,c,d,a", "both ends: to the first place, to the last");
	assert(a.moveTo("a", 1) === a && a.moveTo("c", 3) === a && a.moveTo("d", 4) === a, "where it already is: the same arrangement, nothing to save");
	assert(a.moveTo("a", 0) === a && a.moveTo("a", 5) === a && a.moveTo("a", -1) === a, "a position out of range moves nothing (both ends)");
	assert(a.moveTo("nope", 2) === a, "an id not here moves nothing");
	assert(ids(a.moveTo("a", 3).moveTo("a", 1)) === "a,b,c,d" && !a.moveTo("a", 3).moveTo("a", 1).dirty(), "dropped away and back: nothing to save");
	assert(ids(a.moveTo("a", 2)) === ids(a.moveLater("a")) && ids(a.moveTo("c", 2)) === ids(a.moveEarlier("c")), "a drop one place is the same order as the arrow key's move");
	const one = createRoomArrangement(["only"]);
	assert(one.moveTo("only", 1) === one && one.moveTo("only", 2) === one, "one room: the only position is where it is");
	assert(ids(a.moveTo("a", 3).retain(new Set(["a", "b", "d"]))) === "b,a,d" && a.moveTo("a", 3).retain(new Set(["a", "b", "d"])).dirty(), "a room gone after a drop: what remains is still the drop's order, still something to save");
}

// --- The keys: the arrows one place, Home and End to the ends, any other key not the card's ---
{
	const a = createRoomArrangement(["a", "b", "c", "d"]);
	const key = (id: string, k: string): string | null => { const next = moveByKey(a, id, k); return next === null ? null : ids(next); };
	assert(key("b", "ArrowLeft") === "b,a,c,d" && key("b", "ArrowUp") === "b,a,c,d", "Left and Up: one place earlier");
	assert(key("b", "ArrowRight") === "a,c,b,d" && key("b", "ArrowDown") === "a,c,b,d", "Right and Down: one place later");
	assert(key("c", "Home") === "c,a,b,d" && key("b", "End") === "a,c,d,b", "Home: first place; End: last place");
	assert(moveByKey(a, "a", "ArrowLeft") === a && moveByKey(a, "a", "Home") === a && moveByKey(a, "d", "ArrowDown") === a && moveByKey(a, "d", "End") === a, "at an end, the same arrangement: nothing moved, nothing to announce");
	assert(moveByKey(a, "b", "Enter") === null && moveByKey(a, "b", " ") === null && moveByKey(a, "b", "Tab") === null, "any other key is not the card's");
	assert(moveByKey(a, "zz", "ArrowDown") === a, "an id not here moves nothing");
}

// --- A room gone meanwhile: taken out, from the opening order too, so its going is not a move ---
{
	const a = createRoomArrangement(["a", "b", "c", "d"]);
	assert(a.retain(new Set(["a", "b", "c", "d"])) === a && a.retain(new Set(["a", "b", "c", "d", "e"])) === a, "nothing missing: the same arrangement (an extra id present is not this arrangement's business)");
	const without = a.retain(new Set(["a", "c", "d"]));
	assert(ids(without) === "a,c,d" && without.count() === 3 && !without.dirty(), "the missing room is out, positions close up, nothing to save");
	assert(without.positionOf("b") === null && without.positionOf("c") === 2, "and it has no position any more");
	const moved = a.moveLater("a"); // b,a,c,d
	const movedWithout = moved.retain(new Set(["a", "c", "d"]));
	assert(ids(movedWithout) === "a,c,d" && !movedWithout.dirty(), "a move that the vanished room undid is nothing to save either (a,c,d is the opening order without b)");
	const stillMoved = a.moveLater("c").retain(new Set(["a", "b", "c"])); // a,b,d,c -> a,b,c
	assert(ids(stillMoved) === "a,b,c" && !stillMoved.dirty(), "what remains equals the opening order without d: nothing to save");
	const reallyMoved = a.moveLater("a").retain(new Set(["a", "b", "d"])); // b,a,c,d -> b,a,d vs entry a,b,d
	assert(ids(reallyMoved) === "b,a,d" && reallyMoved.dirty(), "a move among the rooms that remain is still something to save");
	assert(ids(a.retain(new Set())) === "" && a.retain(new Set()).count() === 0, "every room gone: empty, and still an arrangement");
	assert(ids(a) === "a,b,c,d", "retain never changes the arrangement it was asked on");
}

// --- The leave question: asked once, only with something to save, and its answer decides ---
{
	const asked: string[] = [];
	const times = (): number => asked.length;
	const yes = (q: string): boolean => { asked.push(q); return true; };
	const no = (q: string): boolean => { asked.push(q); return false; };
	assert(confirmLeavingArrangement(false, yes) === true && confirmLeavingArrangement(false, no) === true && times() === 0, "with nothing to save, leaving just leaves: no question");
	assert(confirmLeavingArrangement(true, yes) === true && times() === 1 && asked[0] === ROOM_ARRANGE_LEAVE_QUESTION, "with moves, the question is asked once");
	assert(confirmLeavingArrangement(true, no) === false && times() === 2, "and a no keeps the user where they are");
	assert(/not saved/.test(ROOM_ARRANGE_LEAVE_QUESTION) && /\?$/.test(ROOM_ARRANGE_LEAVE_QUESTION) && !/\b(there is|remains|still)\b/i.test(ROOM_ARRANGE_LEAVE_QUESTION), "the question says what is at stake and asks");
}

console.log("room-order-arrange smoke: ok");
