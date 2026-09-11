/**
 * Zoom maths for the expanded diagram viewer. Zoom is a scale over the
 * diagram's natural pixel size (1 = real size), never a share of the window:
 * a small sketch at 100% is small, a wide flowchart at 100% scrolls. Pure
 * over numbers so the grid, the fit and the keep-the-point-under-the-cursor
 * scroll can be checked without a DOM.
 */

export const ZOOM_MIN = 0.25;
export const ZOOM_MAX = 4;
export const ZOOM_STEP = 0.25;

/** Natural pixel size of a rendered diagram. */
export type Size = { width: number; height: number };

// The grid arithmetic runs through floats (1.1 / 0.25 = 4.4000000000000004);
// snapping the result to two decimals keeps 1.25 as 1.25, not 1.2500000000000002.
function tidy(value: number): number {
	return Math.round(value * 100) / 100;
}

export function clampZoom(zoom: number): number {
	if (!Number.isFinite(zoom)) return 1;
	return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

/**
 * The next zoom on the 0.25 grid in `direction`. A zoom that sits between
 * grid lines (after a wheel gesture) moves to the nearest line in that
 * direction: from 1.1, up is 1.25 and down is 1.0.
 */
export function stepZoom(zoom: number, direction: 1 | -1): number {
	// A hair of tolerance so a zoom that is already on a line (1.25 stored as
	// 1.2499999) counts as on it and moves one full step rather than none.
	const epsilon = 1e-6;
	const line = direction > 0 ? Math.floor(zoom / ZOOM_STEP + epsilon) + 1 : Math.ceil(zoom / ZOOM_STEP - epsilon) - 1;
	return clampZoom(tidy(line * ZOOM_STEP));
}

/**
 * The largest zoom (within the range) at which the whole diagram fits the
 * viewport on both axes. A degenerate size (unmeasured, zero) fits at 1.
 */
export function fitZoom(natural: Size, viewport: Size): number {
	if (!(natural.width > 0) || !(natural.height > 0) || !(viewport.width > 0) || !(viewport.height > 0)) return 1;
	return clampZoom(Math.min(viewport.width / natural.width, viewport.height / natural.height));
}

/**
 * Zoom after a modifier-wheel or pinch gesture: a factor of 1.1 per 100 units
 * of deltaY, so a mouse notch is one clear step and a trackpad's stream of
 * small deltas glides. Wheel up (negative deltaY) zooms in, as in every
 * map and image viewer.
 */
export function wheelZoom(zoom: number, deltaY: number): number {
	if (!Number.isFinite(deltaY) || deltaY === 0) return clampZoom(zoom);
	return clampZoom(zoom * Math.pow(1.1, -deltaY / 100));
}

export type KeepPointInput = {
	/** Pointer position relative to the scroll container's content box. */
	pointer: { x: number; y: number };
	scrollLeft: number;
	scrollTop: number;
	oldZoom: number;
	newZoom: number;
	/**
	 * Where the diagram's top-left sits in the scroll content, relative to the
	 * content box origin. Zero when the diagram fills the container; positive
	 * when it is smaller and centred, so the point under the cursor is still
	 * measured from the diagram, not from the empty margin around it.
	 */
	stageOrigin?: { x: number; y: number };
};

/**
 * Scroll offsets that keep the diagram point under the cursor where it is
 * after a zoom change: the point's content coordinate scales with the zoom,
 * the pointer stays put, and the difference is the new scroll. The browser
 * clamps the result to what is scrollable, so a diagram that is still smaller
 * than the container simply stays centred.
 */
export function scrollToKeepPoint({ pointer, scrollLeft, scrollTop, oldZoom, newZoom, stageOrigin = { x: 0, y: 0 } }: KeepPointInput): { scrollLeft: number; scrollTop: number } {
	if (!(oldZoom > 0) || !(newZoom > 0)) return { scrollLeft, scrollTop };
	const ratio = newZoom / oldZoom;
	const pointX = pointer.x + scrollLeft - stageOrigin.x;
	const pointY = pointer.y + scrollTop - stageOrigin.y;
	return {
		scrollLeft: Math.max(0, pointX * ratio - pointer.x),
		scrollTop: Math.max(0, pointY * ratio - pointer.y),
	};
}

/**
 * The natural pixel size of a mermaid svg from what it carries: the inline
 * `max-width: Npx` mermaid writes for its own width, and the viewBox for the
 * aspect ratio (or for both when there is no max-width). Null when neither
 * says anything usable.
 */
export function parseNaturalSize(input: { inlineMaxWidth?: string | null; viewBox?: string | null }): Size | null {
	const box = (input.viewBox ?? "").trim().split(/[\s,]+/).map(Number);
	const boxWidth = box.length === 4 && box[2] > 0 ? box[2] : 0;
	const boxHeight = box.length === 4 && box[3] > 0 ? box[3] : 0;
	const maxWidth = /^\s*([\d.]+)px\s*$/.exec(input.inlineMaxWidth ?? "");
	const width = maxWidth ? Number(maxWidth[1]) : boxWidth;
	if (!(width > 0)) return null;
	// The viewBox gives the aspect; the max-width is the width mermaid measured
	// for the same drawing, so the height follows it in proportion.
	const height = boxWidth > 0 && boxHeight > 0 ? (width * boxHeight) / boxWidth : 0;
	if (!(height > 0)) return null;
	return { width, height };
}
