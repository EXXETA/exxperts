import { useLayoutEffect, useRef, type RefObject } from "react";
import type { Rect } from "./home-room-drag";

/** How long a card takes to slide to its new place, and the held card to settle into its slot. */
export const ROOM_ARRANGE_MOTION_MS = 200;
/** The held card is lifted this much. */
const LIFT_SCALE = 1.02;

/**
 * A slot's box at rest in the viewport's coordinates: where the grid puts it,
 * whatever transform it is drawn with (a card sliding aside, the held card
 * carried). The drag maths read these, so the animation never feeds back into
 * the landing place. The grid is the slots' offset parent in arrange mode
 * (`.landing-grid.is-arranging` is positioned).
 */
export function slotRestBox(grid: HTMLElement, slot: HTMLElement, gridBox: DOMRect = grid.getBoundingClientRect()): Rect {
	return { left: gridBox.left + grid.clientLeft + slot.offsetLeft, top: gridBox.top + grid.clientTop + slot.offsetTop, width: slot.offsetWidth, height: slot.offsetHeight };
}

/** The arrange slots in the order drawn, with their ids. */
export function arrangeSlots(grid: HTMLElement | null): HTMLElement[] {
	return grid ? [...grid.querySelectorAll<HTMLElement>("[data-arrange-slot]")] : [];
}

/** The held card: its box on screen when it was pressed, and how far the pointer has carried it since. */
export interface ArrangeCarry { id: string; grab: Rect; dx: number; dy: number }

/**
 * The motion of arrange mode, drawn after every render of the grid (FLIP):
 * a slot whose place in the grid changed is put back where it was seen, by a
 * transform, and slides to its new place; one caught mid-slide starts from
 * where it is. The held card is lifted and follows the pointer, whatever its
 * slot; let go, it settles from where it was into its slot (the preview's, so
 * a drop, or its old one, so a cancel). With reduced motion nothing slides:
 * the cards are simply in their places, and the held card still follows the
 * pointer, which is the gesture itself rather than an animation.
 *
 * The transforms are written straight to the slots, never through React, so
 * a render for a pointer move does not restart a slide in flight: a slot is
 * touched only when its rest place changed or it was just let go.
 */
export function useRoomArrangeMotion(gridRef: RefObject<HTMLElement | null>, active: boolean, carry: ArrangeCarry | null): void {
	const restsRef = useRef(new Map<string, { x: number; y: number }>());
	const heldRef = useRef<string | null>(null);
	useLayoutEffect(() => {
		const grid = gridRef.current;
		const rests = restsRef.current;
		const wasHeld = heldRef.current;
		heldRef.current = carry?.id ?? null;
		if (!active || !grid) { rests.clear(); return; }
		const still = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
		const gridBox = grid.getBoundingClientRect();
		const sliding: HTMLElement[] = [];
		for (const slot of arrangeSlots(grid)) {
			const id = slot.dataset.arrangeSlot ?? "";
			const rest = { x: slot.offsetLeft, y: slot.offsetTop };
			const before = rests.get(id);
			rests.set(id, rest);
			if (carry && id === carry.id) {
				const box = slotRestBox(grid, slot, gridBox);
				slot.style.transition = "none";
				slot.style.transform = `translate(${carry.grab.left + carry.dx - box.left}px, ${carry.grab.top + carry.dy - box.top}px) scale(${LIFT_SCALE})`;
				continue;
			}
			const released = id === wasHeld;
			if (!released && (!before || (before.x === rest.x && before.y === rest.y))) continue;
			if (still) { slot.style.transition = "none"; slot.style.transform = ""; continue; }
			const shown = getComputedStyle(slot).transform;
			const moving = new DOMMatrixReadOnly(shown === "none" ? undefined : shown);
			const from = { x: (before?.x ?? rest.x) + moving.m41 - rest.x, y: (before?.y ?? rest.y) + moving.m42 - rest.y };
			slot.style.transition = "none";
			slot.style.transform = `translate(${from.x}px, ${from.y}px)${released ? ` scale(${LIFT_SCALE})` : ""}`;
			if (released) {
				slot.dataset.settling = "";
				window.setTimeout(() => { delete slot.dataset.settling; }, ROOM_ARRANGE_MOTION_MS);
			}
			sliding.push(slot);
		}
		if (sliding.length === 0) return;
		void grid.offsetWidth; // the start places are laid out before the slide begins
		for (const slot of sliding) {
			slot.style.transition = `transform ${ROOM_ARRANGE_MOTION_MS}ms ease-out`;
			slot.style.transform = "";
		}
	});
}

/** How close to the top or bottom edge a held card starts scrolling the page, and its fastest speed (whatever the frame rate). */
const EDGE_SCROLL_ZONE_PX = 56;
const EDGE_SCROLL_MAX_PX_PER_S = 360;

/** The element that scrolls the grid: its nearest scrolling ancestor, else the document's. */
function scrollerOf(element: HTMLElement): HTMLElement {
	for (let parent = element.parentElement; parent; parent = parent.parentElement) {
		const { overflowY } = getComputedStyle(parent);
		if ((overflowY === "auto" || overflowY === "scroll") && parent.scrollHeight > parent.clientHeight) return parent;
	}
	return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

/**
 * While a card is held, a pointer near the top or bottom edge of what is on
 * screen scrolls the page slowly, faster the closer it gets; the scroll then
 * reads the landing place again as any scroll does. For the mouse and a
 * finger alike, every frame, from the last place the pointer was seen.
 */
export function useArrangeEdgeScroll(gridRef: RefObject<HTMLElement | null>, held: boolean, pointerRef: RefObject<{ x: number; y: number } | null>): void {
	useLayoutEffect(() => {
		const grid = gridRef.current;
		if (!held || !grid) return;
		const scroller = scrollerOf(grid);
		let frame = 0;
		let last: number | null = null;
		let owed = 0; // the part of a pixel not scrolled yet
		const step = (now: number): void => {
			const point = pointerRef.current;
			const seconds = last === null ? 0 : Math.min(0.1, (now - last) / 1000);
			last = now;
			if (point) {
				const box = scroller === document.scrollingElement ? { top: 0, bottom: window.innerHeight } : scroller.getBoundingClientRect();
				const top = Math.max(0, box.top), bottom = Math.min(window.innerHeight, box.bottom);
				const into = (edge: number): number => Math.max(0, Math.min(1, (EDGE_SCROLL_ZONE_PX - edge) / EDGE_SCROLL_ZONE_PX));
				owed += EDGE_SCROLL_MAX_PX_PER_S * seconds * (into(bottom - point.y) - into(point.y - top));
				const delta = Math.trunc(owed);
				if (delta !== 0) { scroller.scrollTop += delta; owed -= delta; }
			}
			frame = window.requestAnimationFrame(step);
		};
		frame = window.requestAnimationFrame(step);
		return () => window.cancelAnimationFrame(frame);
	}, [gridRef, held, pointerRef]);
}
