// Dragging a card in arrange mode (home-room-drag.ts), held to its rules on
// its own: what starts a drag and what does not, the threshold at both
// sides, the long press of a finger or a pen, the pointer that is listened
// to, cancel, and the maths of where a
// held card lands on a one-column grid, a wrapping grid and a partial row,
// and over the live preview's gap. Plain module, no browser.
const { createCardDrag, dropPositionAt, stackedSlots, ROOM_DRAG_THRESHOLD_PX, ROOM_LONG_PRESS_MS, ROOM_LONG_PRESS_SLOP_PX } = await import("../../web-ui/src/home-room-drag.js");
export {}; // a module, so the top-level await above is allowed

function assert(condition: unknown, message: string): asserts condition {
	if (!condition) throw new Error(message);
}
type Rect = { left: number; top: number; width: number; height: number };
const rect = (left: number, top: number, width = 300, height = 100): Rect => ({ left, top, width, height });
const at = (x: number, y: number) => ({ x, y });

// --- The maths on a wrapping grid: three per row, five cards (a partial last row), the held one first ---
{
	const slots = [rect(0, 0), rect(320, 0), rect(640, 0), rect(0, 120), rect(320, 120)];
	const p = (held: number, x: number, y: number): number => dropPositionAt({ slots, held }, at(x, y));
	assert(p(0, 10, 50) === 1 && p(0, -50, 50) === 1 && p(0, 330, 50) === 1, "left of the first other's centre: first, where it is (beside the grid too)");
	assert(p(0, 500, 50) === 2, "between the second's centre and the third's: it lands between them (position 2)");
	assert(p(0, 800, 50) === 3 && p(0, 1000, 50) === 3, "past the first row's last other: after it (past the grid too)");
	assert(p(0, 400, -50) === 1 && p(0, 400, 500) === 4, "above everything is the first row, below everything the last: the rows' own maths then apply");
	assert(p(0, 1000, 130) === 5 && p(0, 10, 130) === 3, "the last row: past its last is last of all; left of its first is before it");
	assert(p(0, 400, 105) === 1 && p(0, 400, 118) === 4, "the gap between rows goes to the nearer row");
	assert(p(0, 400, 110) === 1, "a tie between two rows goes to the earlier");
	assert(p(2, 10, 50) === 1 && p(2, 500, 50) === 3 && p(2, 1000, 50) === 3, "held in the middle of a row: left of the first is first; its own side of the last other is where it is");
	assert(p(2, 10, 130) === 3 && p(2, 200, 130) === 4 && p(2, 1000, 130) === 5, "held in the first row, dropped in the second: before its first, between, last");
	assert(p(4, 10, 50) === 1 && p(4, 500, 50) === 3 && p(4, 1000, 50) === 4 && p(4, 10, 130) === 4 && p(4, 1000, 130) === 5, "held last: every landing place in both rows, its own included");
	const alone = [rect(0, 0), rect(320, 0), rect(640, 0), rect(0, 120)];
	assert(dropPositionAt({ slots: alone, held: 3 }, at(400, 150)) === 4 && dropPositionAt({ slots: alone, held: 3 }, at(1000, 150)) === 4, "a row that holds only the held card: where it is");
	assert(dropPositionAt({ slots: alone, held: 3 }, at(400, 50)) === 2, "and from there into the row above");
	assert(dropPositionAt({ slots: [rect(0, 0)], held: 0 }, at(400, 400)) === 1 && dropPositionAt({ slots: [], held: 0 }, at(0, 0)) === 1, "one card, no card: the only position is 1");
	assert(dropPositionAt({ slots: [rect(0, 0), rect(320, 0)], held: 0 }, at(500, 50)) === 2 && dropPositionAt({ slots: [rect(0, 0), rect(320, 0)], held: 0 }, at(100, 50)) === 1, "two cards side by side: the other's horizontal centre decides");
	assert(dropPositionAt({ slots: [rect(0, 0), rect(320, 0)], held: 1 }, at(10, 50)) === 1 && dropPositionAt({ slots: [rect(0, 0), rect(320, 0)], held: 1 }, at(200, 50)) === 2, "and held second: left of the first's centre swaps, right of it stays");
}

// --- The maths on one column: the vertical centre decides, not the side ---
{
	const slots = [rect(0, 0), rect(0, 110), rect(0, 220)];
	const p = (held: number, x: number, y: number): number => dropPositionAt({ slots, held }, at(x, y));
	assert(p(1, 290, 10) === 1 && p(1, 10, 10) === 1, "the upper half of the first: before it, whatever the side");
	assert(p(1, 10, 90) === 2 && p(1, 290, 90) === 2, "the lower half of the first: after it, which is where the held one is");
	assert(p(1, 150, 105) === 2 && p(1, 150, 160) === 2 && p(1, 150, 250) === 2, "the gap, its own row, the upper half of the third: where it is");
	assert(p(1, 150, 271) === 3 && p(1, 150, 900) === 3 && p(1, 150, -30) === 1, "the lower half of the third and past it: last; above the first: first");
	assert(p(0, 150, 159) === 1 && p(0, 150, 160) === 2, "the centre itself lands after: the other's centre must be strictly below the point to land before it");
	assert(p(0, 150, 300) === 3 && p(2, 150, 10) === 1 && p(2, 150, 100) === 2, "held first to the end; held last to the start and to the middle");
	assert(dropPositionAt({ slots: [rect(0, 0), rect(0, 110)], held: 0 }, at(290, 150)) === 1 && dropPositionAt({ slots: [rect(0, 0), rect(0, 110)], held: 0 }, at(290, 170)) === 2, "two cards, one under the other: vertical halves (every row holds one slot)");
}

// --- One column is read from the boxes, never from a query ---
{
	assert(stackedSlots([rect(0, 0), rect(320, 0), rect(640, 0), rect(0, 120)]) === false && stackedSlots([rect(0, 0), rect(320, 0)]) === false, "a row with two slots: not stacked");
	assert(stackedSlots([rect(0, 0), rect(0, 110), rect(0, 220)]) === true && stackedSlots([rect(0, 0), rect(0, 110)]) === true, "every row one slot: stacked");
	assert(stackedSlots([rect(0, 0)]) === true && stackedSlots([]) === true, "one slot and none count as stacked (nothing stands beside anything)");
}

// --- The live preview: the layout read is the preview's, the held slot is the gap, and a still pointer never makes a card go back and forth ---
{
	// Four cards in a row, 300 wide with 20 gaps: centres at 150, 470, 790, 1110.
	const row = [rect(0, 0), rect(320, 0), rect(640, 0), rect(960, 0)];
	const preview = (held: number) => ({ slots: row, held });
	assert(dropPositionAt(preview(0), at(400, 50)) === 1, "held first, over the second's left half: it stays first");
	assert(dropPositionAt(preview(0), at(480, 50)) === 2, "past the second's centre: position 2, so the preview puts the gap in the second slot");
	assert(dropPositionAt(preview(1), at(480, 50)) === 2 && dropPositionAt(preview(1), at(320, 50)) === 2 && dropPositionAt(preview(1), at(160, 50)) === 2, "over the gap and back to past the first's centre: still 2, no flip back (half a card of hysteresis)");
	assert(dropPositionAt(preview(1), at(140, 50)) === 1, "only past the card that moved aside does it go back");
	const drag = createCardDrag();
	drag.press("a", at(150, 50), "mouse", 0, 1);
	let layout = preview(0);
	assert(drag.move(at(480, 50), 1, () => layout)?.position === 2, "the gesture: carried past the second's centre, position 2");
	layout = preview(1); // the screen drew the preview: the gap is now in the second slot
	assert(drag.move(at(481, 50), 1, () => layout)?.position === 2 && drag.scrolled(() => layout)?.position === 2, "the next move and a scroll read the preview's layout and stay at 2");
	assert(drag.release(at(481, 50), 1, () => layout)?.position === 2, "and the drop lands where the preview showed it");
}

// --- The gesture: what starts one ---
{
	const drag = createCardDrag();
	const others = () => ({ slots: [rect(0, 0), rect(320, 0), rect(640, 0)], held: 0 });
	assert(drag.press("a", at(10, 10), "mouse", 1, 1) === false && drag.press("a", at(10, 10), "mouse", 2, 1) === false, "a mouse button other than the primary starts nothing");
	assert(drag.release(at(500, 50), 1, others) === null, "a release with nothing pressed lands nothing");
	assert(drag.move(at(500, 50), 1, others) === null, "a move with nothing pressed shows nothing");
	assert(drag.press("a", at(10, 10), "mouse", 0, 1) === true && drag.view() === null, "the primary mouse button presses; a press is not yet a hold");
	assert(drag.press("b", at(10, 10), "mouse", 0, 2) === false, "a second press while one is pressed is refused");
	assert(ROOM_DRAG_THRESHOLD_PX === 6, "the threshold is six pixels");
}

// --- The long press: a finger or a pen picks a card up only when the screen's timer calls hold ---
{
	const others = () => ({ slots: [rect(0, 0), rect(320, 0), rect(640, 0)], held: 0 });
	assert(ROOM_LONG_PRESS_MS === 400 && ROOM_LONG_PRESS_SLOP_PX === 10, "the long press is 400 ms, with ten pixels of drift");
	const finger = createCardDrag();
	assert(finger.press("a", at(10, 10), "touch", 0, 1) === true && finger.view() === null && finger.activeId() === "a", "a finger presses; a press is not yet a hold");
	assert(finger.move(at(500, 50), 2, others) === null && finger.hold(2, others) === null, "another pointer neither moves nor holds it");
	assert(finger.move(at(19, 10), 1, others) === null && finger.view() === null, "nine pixels of drift: not held (no threshold drag for a finger), still pressed");
	const held = finger.hold(1, others);
	assert(held !== null && held.id === "a" && held.dx === 0 && held.dy === 0 && held.position === 1, `the timer: held where it was pressed: ${JSON.stringify(held)}`);
	assert(finger.hold(1, others) === null, "a second hold changes nothing");
	assert(finger.move(at(500, 50), 1, others)?.position === 2 && finger.release(at(500, 50), 1, others)?.position === 2, "then carried and dropped like a mouse's card");
	const scroll = createCardDrag();
	scroll.press("a", at(10, 10), "touch", 0, 1);
	assert(scroll.move(at(10, 20), 1, others) === null && scroll.activeId() === null, "ten pixels before the timer: a scroll, the press is forgotten");
	assert(scroll.hold(1, others) === null && scroll.view() === null, "and a late timer picks nothing up");
	const tap = createCardDrag();
	tap.press("a", at(10, 10), "pen", 0, 1);
	assert(tap.release(at(10, 10), 1, others) === null && tap.activeId() === null && tap.hold(1, others) === null, "a pen's tap: nothing lands, and the timer after it holds nothing");
	const mouse = createCardDrag();
	mouse.press("a", at(10, 10), "mouse", 0, 1);
	assert(mouse.hold(1, others) === null && mouse.view() === null, "a mouse press is never held by the timer, only by moving");
	const cancelled = createCardDrag();
	cancelled.press("a", at(10, 10), "touch", 0, 1);
	cancelled.cancel(1);
	assert(cancelled.hold(1, others) === null, "the browser's pointercancel (it began to scroll) forgets the press");
}

// --- The gesture: the threshold at both sides, a click, a drag ---
{
	const others = () => ({ slots: [rect(0, 0), rect(320, 0), rect(640, 0)], held: 0 });
	const drag = createCardDrag();
	drag.press("a", at(10, 10), "mouse", 0, 1);
	assert(drag.move(at(15, 10), 1, others) === null && drag.view() === null, "five pixels: still a click");
	assert(drag.move(at(13, 12), 1, others) === null, "three and two: still a click (Manhattan)");
	assert(drag.release(at(15, 10), 1, others) === null && drag.view() === null, "a release under the threshold is a click: nothing lands");
	assert(drag.move(at(500, 50), 1, others) === null, "and the gesture is over: a later move shows nothing");
	drag.press("a", at(10, 10), "mouse", 0, 1);
	const held = drag.move(at(16, 10), 1, others);
	assert(held !== null && held.id === "a" && held.dx === 6 && held.dy === 0 && held.position === 1, `six pixels: held, at position 1: ${JSON.stringify(held)}`);
	const carried = drag.move(at(500, 50), 1, others);
	assert(carried !== null && carried.dx === 490 && carried.dy === 40 && carried.position === 2 && drag.view()?.position === 2, "carried past the first other: position 2");
	assert(drag.move(at(1000, 50), 1, others)?.position === 3 && drag.view()?.position === 3, "past the last other: last");
	const landed = drag.release(at(500, 50), 1, others);
	assert(landed !== null && landed.id === "a" && landed.position === 2, "the release lands where the pointer went up, not where it last moved");
	assert(drag.view() === null && drag.release(at(500, 50), 1, others) === null, "and the gesture is over");
	const d2 = createCardDrag();
	d2.press("a", at(10, 10), "mouse", 0, 1);
	assert(d2.move(at(13, 13), 1, others) !== null, "three and three: six, held (Manhattan)");
}

// --- The gesture: only the pressed pointer, the scroll, cancel ---
{
	const others = () => ({ slots: [rect(0, 0), rect(320, 0), rect(640, 0)], held: 0 });
	const drag = createCardDrag();
	drag.press("a", at(10, 10), "mouse", 0, 7);
	assert(drag.move(at(500, 50), 8, others) === null && drag.view() === null, "another pointer's move does not hold the card");
	assert(drag.release(at(500, 50), 8, others) === null && drag.move(at(500, 50), 7, others)?.position === 2, "another pointer's release does not end the press: the pressed pointer still holds");
	assert(drag.move(at(1000, 50), 8, others)?.position === 2 && drag.release(at(1000, 50), 8, others) === null && drag.view()?.position === 2, "while held, another pointer changes nothing and the view stays");
	let scrolledRects = { slots: [rect(0, -60), rect(320, -60), rect(640, -60)], held: 0 };
	const afterScroll = drag.scrolled(() => scrolledRects);
	assert(afterScroll !== null && afterScroll.position === 2 && afterScroll.dx === 490 && afterScroll.dy === 40, "a scroll reads the landing place again at the last point; the card is carried as before");
	scrolledRects = { slots: [rect(0, 0), rect(0, 110), rect(0, 220)], held: 0 };
	assert(drag.scrolled(() => scrolledRects)?.position === 1, "the rectangles are read afresh each time: a new layout gives a new place");
	drag.cancel();
	assert(drag.view() === null && drag.release(at(500, 50), 7, others) === null, "cancel: nothing held, nothing lands");
	assert(drag.scrolled(others) === null, "a scroll with nothing held shows nothing");
	// what is active: a press counts, and only the pressed pointer can cancel by id
	const active = createCardDrag();
	assert(active.activeId() === null, "idle: nothing active");
	active.press("a", at(10, 10), "mouse", 0, 3);
	assert(active.activeId() === "a" && active.view() === null, "pressed: active, though not held");
	active.cancel(4);
	assert(active.activeId() === "a", "another pointer's cancel changes nothing while pressed");
	active.move(at(500, 50), 3, others);
	assert(active.activeId() === "a" && active.view() !== null, "held: active");
	active.cancel(4);
	assert(active.view()?.id === "a", "another pointer's cancel changes nothing while held");
	active.cancel(3);
	assert(active.activeId() === null && active.view() === null, "the pressed pointer's cancel puts the card back");
	active.press("a", at(10, 10), "mouse", 0, 3);
	active.cancel();
	assert(active.activeId() === null && active.press("b", at(10, 10), "mouse", 0, 5) === true, "a cancel with no pointer (Escape, the room gone, arrange mode closing) forgets the press; a new press can start");
	active.move(at(500, 50), 5, others);
	assert(active.release(at(500, 50), 6, others) === null && active.activeId() === "b" && active.view()?.id === "b", "another pointer's release leaves the hold and its view as they were");
	const pressed = createCardDrag();
	pressed.press("a", at(10, 10), "mouse", 0, 1);
	pressed.cancel();
	assert(pressed.move(at(500, 50), 1, others) === null && pressed.press("a", at(10, 10), "mouse", 0, 1) === true, "cancel while merely pressed ends the press; a new press can start");
	const lazy = createCardDrag();
	let read = 0;
	const reads = (): number => read; // through a call: an assertion on the variable itself would narrow it to the literal it was compared with
	lazy.press("a", at(10, 10), "mouse", 0, 1);
	lazy.move(at(12, 10), 1, () => { read += 1; return { slots: [rect(0, 0)], held: 0 }; });
	assert(reads() === 0, "under the threshold the rectangles are not read");
	lazy.move(at(20, 10), 1, () => { read += 1; return { slots: [rect(0, 0)], held: 0 }; });
	assert(reads() === 1 && lazy.view()?.position === 1, "held with no others: position 1");
}

console.log("room-order-drag smoke: ok");
