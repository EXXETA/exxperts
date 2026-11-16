/**
 * The arrangement being made in arrange mode: the rooms' ids, in the order
 * the user is putting them, from the moment arrange mode opened until Done,
 * Escape or leaving Home. Plain and immutable (every move returns a new
 * arrangement, or the same one when nothing moved), so the smoke holds it on
 * its own and the home screen keeps it in one piece of state. It knows
 * nothing of the saved order: Done and leaving Home hand `ids()` to the home
 * screen's controller as a choice (home-room-order.ts), and the server
 * merges it (mergeRoomOrderCustomOrder).
 *
 * Its moves are the two ways a card is moved: one place with an arrow key
 * or a card's arrow (`moveEarlier`, `moveLater`) and to a position with a drop or Home and End
 * (`moveTo`, the drop that home-room-drag.ts ends in; `moveByKey` reads the
 * keys); both leave the same kind of arrangement, so nothing downstream
 * knows which way was used.
 *
 * What it holds is exactly the cards on screen when it opened. A room that
 * vanishes meanwhile (archived or purged elsewhere) is taken out with
 * `retain`, from the start point too, so its going does not count as a move
 * of the user's; the server keeps its place, because an id not sent keeps
 * its slot (except at the merge's ceiling, where unsent ids make room from
 * the end). "Dirty" is whether the order differs from the one arrange mode
 * opened with: a move undone by the opposite move leaves nothing to save.
 */
export interface RoomArrangement {
	/** The ids in their current order; a fresh copy every time. */
	ids: () => string[];
	count: () => number;
	/** 1-based, null for an id not here. */
	positionOf: (id: string) => number | null;
	/** True while the order differs from the one arrange mode opened with. */
	dirty: () => boolean;
	/** The room one place earlier; the same arrangement when it is first, or not here. */
	moveEarlier: (id: string) => RoomArrangement;
	/** The room one place later; the same arrangement when it is last, or not here. */
	moveLater: (id: string) => RoomArrangement;
	/** The room to `position` (1-based), the others closing up: a drop. The same arrangement when it is not here, the position is out of range, or it is there already. */
	moveTo: (id: string, position: number) => RoomArrangement;
	/** Only the ids in `present` are kept, in their order; the same arrangement when none is missing. */
	retain: (present: ReadonlySet<string>) => RoomArrangement;
}

function build(entry: readonly string[], current: readonly string[]): RoomArrangement {
	const sameAsEntry = current.length === entry.length && current.every((id, index) => id === entry[index]);
	const swap = (index: number, other: number): RoomArrangement => {
		const next = current.slice();
		[next[index], next[other]] = [next[other], next[index]];
		return build(entry, next);
	};
	const arrangement: RoomArrangement = {
		ids: () => current.slice(),
		count: () => current.length,
		positionOf: (id) => {
			const index = current.indexOf(id);
			return index < 0 ? null : index + 1;
		},
		dirty: () => !sameAsEntry,
		moveEarlier: (id) => {
			const index = current.indexOf(id);
			return index <= 0 ? arrangement : swap(index, index - 1);
		},
		moveLater: (id) => {
			const index = current.indexOf(id);
			return index < 0 || index >= current.length - 1 ? arrangement : swap(index, index + 1);
		},
		moveTo: (id, position) => {
			const index = current.indexOf(id);
			if (index < 0 || position < 1 || position > current.length || position === index + 1) return arrangement;
			const next = current.filter((other) => other !== id);
			next.splice(position - 1, 0, id);
			return build(entry, next);
		},
		retain: (present) => {
			const kept = current.filter((id) => present.has(id));
			if (kept.length === current.length) return arrangement;
			return build(entry.filter((id) => present.has(id)), kept);
		},
	};
	return arrangement;
}

/**
 * The move a key makes on a focused card: Left and Up one place earlier,
 * Right and Down one place later, Home to the first place, End to the last.
 * Null for any other key (the key is not the card's); the same arrangement
 * when the card is already there.
 */
export function moveByKey(arrangement: RoomArrangement, id: string, key: string): RoomArrangement | null {
	switch (key) {
		case "ArrowLeft": case "ArrowUp": return arrangement.moveEarlier(id);
		case "ArrowRight": case "ArrowDown": return arrangement.moveLater(id);
		case "Home": return arrangement.moveTo(id, 1);
		case "End": return arrangement.moveTo(id, arrangement.count());
		default: return null;
	}
}

/** Arrange mode opens on the cards as they stand; an id given twice counts once, in its first place. */
export function createRoomArrangement(onScreen: readonly string[]): RoomArrangement {
	const entry = [...new Set(onScreen)];
	return build(entry, entry);
}

/** Arranging's words, ONE place for the page and the smokes. The hint where a pointer hovers, and on a touch screen, where a finger holds a card or taps its arrows. */
export const ROOM_ARRANGE_HINT_POINTER = "Drag rooms into order, or use Tab and the arrow keys.";
export const ROOM_ARRANGE_HINT_TOUCH = "Hold a room and drag it, or tap its arrows.";
/** Each card's two arrows: their names and their tooltips. */
export const ROOM_ARRANGE_MOVE_EARLIER = "Move earlier";
export const ROOM_ARRANGE_MOVE_LATER = "Move later";
/**
 * A failed save of an arrangement. The app cannot tell whether a save whose
 * answer failed landed, so neither line says it was not saved. On Done, with
 * the moves still on screen; at rest, on this visit or the next one when the
 * save was made on the way out of Home.
 */
export const ROOM_ARRANGE_DONE_FAILED = "Your new order may not have been saved. Press Done to try again.";
export const ROOM_ARRANGE_FAILED_AWAY = "Your new order may not have been saved. If it looks wrong, arrange your rooms again.";
