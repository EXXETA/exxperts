/**
 * Dragging a card in arrange mode: the gesture, from the press to the drop,
 * and the maths of where a held card would land. Plain, no React, no DOM, no
 * timers: the home screen feeds it pointer events and the slots' boxes and
 * draws what `view()` says, so the smoke executes the whole sequence with
 * numbers. The order itself is the arrangement (home-room-arrange.ts): while
 * a card is held the screen draws the arrangement as it would be after
 * dropping at `position` (a `moveTo` preview, nothing written), and a drop
 * ends in that ONE `moveTo`, so nothing exists only in the drag path.
 *
 * The mouse's primary button makes a candidate that is held once the
 * pointer has moved `ROOM_DRAG_THRESHOLD_PX` (Manhattan); a release before
 * that is a click and moves nothing. A finger or a pen makes a long-press
 * candidate instead: the screen's timer (`ROOM_LONG_PRESS_MS`) calls `hold`,
 * and a move of `ROOM_LONG_PRESS_SLOP_PX` before then forgets the press, so
 * the page scrolls as it does today. Only the pressed pointer is listened
 * to; a second pointer changes nothing, its release and its cancel included.
 * `cancel` is what Escape, `pointercancel`, a lost capture, the room
 * vanishing and arrange mode closing call: the card goes back (a press not
 * yet held is forgotten too), the arrangement is untouched.
 */
export const ROOM_DRAG_THRESHOLD_PX = 6;
/** How long a finger or a pen rests on a card before it is picked up. */
export const ROOM_LONG_PRESS_MS = 400;
/** How far a finger may drift during the long press; further is a scroll, and the press is forgotten. */
export const ROOM_LONG_PRESS_SLOP_PX = 10;

export interface Point { x: number; y: number }
/** A slot's box in the coordinates the points come in (the viewport's). */
export interface Rect { left: number; top: number; width: number; height: number }

/**
 * Every slot's box at rest (transforms ignored), in the order drawn, and
 * which one is held. While a card is held the order drawn is the preview, so
 * the held slot is the gap at the landing place: over the gap the answer
 * stays that place, and it changes only when the pointer crosses into a
 * neighbour's half, so no card moves back and forth under a still pointer.
 */
export interface SlotLayout { slots: readonly Rect[]; held: number }

/**
 * Where a held card lands: a 1-based position among ALL cards, for
 * `moveTo`, given every slot's rectangle at rest (the held slot included, so
 * the rows and columns are those of the grid as laid out) and the pointer.
 * Rows are runs of slots whose tops agree (within half a slot's height);
 * the row is the one whose band holds the point, else the nearest (a tie
 * goes to the earlier). Inside a row the card lands before the first other
 * slot whose horizontal centre is right of the point, else after the row's
 * last other; when every row holds one slot (the one-column grid) the
 * vertical centre decides instead, since there the pointer moves up and
 * down. A row that holds only the held card is where it already is. So: a
 * point above the grid lands in the first row and a point below it in the
 * last, a point beside the grid in its row, and the row's own rule then
 * decides the place; the only position with no others is 1.
 */
export function dropPositionAt(layout: SlotLayout, point: Point): number {
	const { slots, held } = layout;
	if (slots.length <= 1) return 1;
	const rows = rowsOf(slots);
	const distance = (row: Row): number => (point.y < row.top ? row.top - point.y : point.y > row.bottom ? point.y - row.bottom : 0);
	const row = rows.reduce((best, candidate) => (distance(candidate) < distance(best) ? candidate : best));
	const others = row.slots.filter(({ index }) => index !== held);
	if (others.length === 0) return held + 1;
	const before = stackedSlots(slots)
		? others.find(({ rect }) => rect.top + rect.height / 2 > point.y)
		: others.find(({ rect }) => rect.left + rect.width / 2 > point.x);
	// An index among all slots, the held one left out, is an index among the others.
	const amongOthers = (index: number): number => index - (index > held ? 1 : 0);
	return before ? amongOthers(before.index) + 1 : amongOthers(others[others.length - 1].index) + 2;
}

type Row = { top: number; bottom: number; slots: { index: number; rect: Rect }[] };

/** The rows of the grid as laid out: runs of slots whose tops agree within half a slot's height. */
function rowsOf(slots: readonly Rect[]): Row[] {
	const rows: Row[] = [];
	slots.forEach((rect, index) => {
		const last = rows[rows.length - 1];
		if (last && Math.abs(rect.top - last.top) <= Math.max(1, rect.height / 2)) {
			last.slots.push({ index, rect });
			last.bottom = Math.max(last.bottom, rect.top + rect.height);
		} else {
			rows.push({ top: rect.top, bottom: rect.top + rect.height, slots: [{ index, rect }] });
		}
	});
	return rows;
}

/**
 * True when the grid stands in one column (every row holds one slot), read
 * from the boxes themselves: the grid becomes one column by its own
 * auto-fill rule as well as by the narrow-window query, so no query can say
 * it. The maths then decide by the vertical centre.
 */
export function stackedSlots(slots: readonly Rect[]): boolean {
	return rowsOf(slots).every((row) => row.slots.length === 1);
}

/** What the home screen draws while a card is held: the card, how far it has been carried, and where it would land (1-based, the preview's place for it). */
export interface CardDragView {
	id: string;
	dx: number;
	dy: number;
	position: number;
}

export interface CardDrag {
	/** True when a candidate started: the mouse's primary button, a finger or a pen on a card, nothing held or pressed yet. */
	press: (id: string, point: Point, pointerType: string, button: number, pointerId: number) => boolean;
	/** The pointer moved: the view while a card is held (a mouse candidate becomes held past the threshold; a long-press candidate past the slop is forgotten), null otherwise. `layout` is asked for the held card's slots only once a card is held. */
	move: (point: Point, pointerId: number, layout: (heldId: string) => SlotLayout) => CardDragView | null;
	/** The long press ran its time: a finger's or a pen's candidate is held where it was pressed. Null for anything else (a mouse press, another pointer, nothing pressed). */
	hold: (pointerId: number, layout: (heldId: string) => SlotLayout) => CardDragView | null;
	/** The page scrolled under a held card: the landing place is read again at the last point. */
	scrolled: (layout: (heldId: string) => SlotLayout) => CardDragView | null;
	/** The pointer went up: where the held card lands, or null for a click, another pointer, or nothing pressed. Ends the gesture either way (a click too). */
	release: (point: Point, pointerId: number, layout: (heldId: string) => SlotLayout) => { id: string; position: number } | null;
	/** The card goes back and a press not yet held is forgotten; nothing lands. With a pointer id, only that pointer's gesture is cancelled: another pointer's cancel changes nothing. */
	cancel: (pointerId?: number) => void;
	/** The held card, or null while nothing is held (a candidate under the threshold is not held). */
	view: () => CardDragView | null;
	/** The card pressed or held, or null when idle: what the screen must put back when the card or arrange mode goes. */
	activeId: () => string | null;
}

type State =
	| { phase: "idle" }
	| { phase: "pressed"; id: string; pointerId: number; origin: Point; longPress: boolean }
	| { phase: "held"; id: string; pointerId: number; origin: Point; point: Point; position: number };

export function createCardDrag(threshold: number = ROOM_DRAG_THRESHOLD_PX): CardDrag {
	let state: State = { phase: "idle" };
	const viewOf = (held: Extract<State, { phase: "held" }>): CardDragView => ({ id: held.id, dx: held.point.x - held.origin.x, dy: held.point.y - held.origin.y, position: held.position });
	const land = (id: string, pointerId: number, origin: Point, point: Point, layout: (heldId: string) => SlotLayout): Extract<State, { phase: "held" }> => (
		{ phase: "held", id, pointerId, origin, point, position: dropPositionAt(layout(id), point) }
	);
	return {
		press: (id, point, pointerType, button, pointerId) => {
			if (state.phase !== "idle" || button !== 0 || !["mouse", "touch", "pen"].includes(pointerType)) return false;
			state = { phase: "pressed", id, pointerId, origin: point, longPress: pointerType !== "mouse" };
			return true;
		},
		move: (point, pointerId, layout) => {
			if (state.phase === "idle" || state.pointerId !== pointerId) return state.phase === "held" ? viewOf(state) : null;
			if (state.phase === "pressed") {
				const moved = Math.abs(point.x - state.origin.x) + Math.abs(point.y - state.origin.y);
				if (state.longPress) {
					if (moved >= ROOM_LONG_PRESS_SLOP_PX) state = { phase: "idle" };
					return null;
				}
				if (moved < threshold) return null;
				state = land(state.id, state.pointerId, state.origin, point, layout);
				return viewOf(state);
			}
			state = land(state.id, state.pointerId, state.origin, point, layout);
			return viewOf(state);
		},
		hold: (pointerId, layout) => {
			if (state.phase !== "pressed" || !state.longPress || state.pointerId !== pointerId) return null;
			state = land(state.id, state.pointerId, state.origin, state.origin, layout);
			return viewOf(state);
		},
		scrolled: (layout) => {
			if (state.phase !== "held") return null;
			state = land(state.id, state.pointerId, state.origin, state.point, layout);
			return viewOf(state);
		},
		release: (point, pointerId, layout) => {
			if (state.phase === "idle" || state.pointerId !== pointerId) return null;
			const ended = state;
			state = { phase: "idle" };
			if (ended.phase === "pressed") return null;
			return { id: ended.id, position: dropPositionAt(layout(ended.id), point) };
		},
		cancel: (pointerId) => {
			if (state.phase === "idle" || (pointerId !== undefined && state.pointerId !== pointerId)) return;
			state = { phase: "idle" };
		},
		view: () => (state.phase === "held" ? viewOf(state) : null),
		activeId: () => (state.phase === "idle" ? null : state.id),
	};
}
