// Smoke for the diagram viewer's zoom maths (apps/web-ui/src/diagram-zoom.ts):
// the 0.25 grid, the both-axes fit, wheel/pinch zoom and the scroll that keeps
// the point under the cursor in place. Pure numbers, no DOM.
//
// Run: npm run smokes -- diagram-zoom   (or tsx this file)

import {
	ZOOM_MAX,
	ZOOM_MIN,
	clampZoom,
	fitZoom,
	parseNaturalSize,
	scrollToKeepPoint,
	stepZoom,
	wheelZoom,
} from "../../web-ui/src/diagram-zoom.js";

let failures = 0;
function check(name: string, condition: boolean, detail?: unknown): void {
	if (condition) {
		console.log(`  ok  ${name}`);
	} else {
		failures += 1;
		console.error(`FAIL  ${name}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
	}
}
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

console.log("clamp:");
check("the range is 0.25 to 4", ZOOM_MIN === 0.25 && ZOOM_MAX === 4);
check("below the floor clamps to the floor", clampZoom(0.1) === ZOOM_MIN, clampZoom(0.1));
check("above the ceiling clamps to the ceiling", clampZoom(9) === ZOOM_MAX, clampZoom(9));
check("inside the range passes through", clampZoom(1.5) === 1.5);
check("a non-number reads as real size", clampZoom(Number.NaN) === 1);

console.log("step grid:");
check("from 1.1 a step up lands on 1.25", stepZoom(1.1, 1) === 1.25, stepZoom(1.1, 1));
check("from 1.1 a step down lands on 1.0", stepZoom(1.1, -1) === 1, stepZoom(1.1, -1));
check("from a grid line a step up is one full step", stepZoom(1, 1) === 1.25, stepZoom(1, 1));
check("from a grid line a step down is one full step", stepZoom(1, -1) === 0.75, stepZoom(1, -1));
check("float noise on a grid line still moves a full step", stepZoom(1.25 - 1e-9, 1) === 1.5, stepZoom(1.25 - 1e-9, 1));
check("stepping up at the ceiling stays at the ceiling", stepZoom(ZOOM_MAX, 1) === ZOOM_MAX, stepZoom(ZOOM_MAX, 1));
check("stepping down at the floor stays at the floor", stepZoom(ZOOM_MIN, -1) === ZOOM_MIN, stepZoom(ZOOM_MIN, -1));
check("the result carries no float tail", stepZoom(0.3, 1) === 0.5 && stepZoom(0.3, -1) === 0.25, [stepZoom(0.3, 1), stepZoom(0.3, -1)]);

console.log("fit:");
const viewport = { width: 1000, height: 600 };
check("a wide diagram fits by width", near(fitZoom({ width: 2000, height: 400 }, viewport), 0.5), fitZoom({ width: 2000, height: 400 }, viewport));
check("a tall diagram fits by height", near(fitZoom({ width: 500, height: 1200 }, viewport), 0.5), fitZoom({ width: 500, height: 1200 }, viewport));
check("the tighter axis wins when both overflow", near(fitZoom({ width: 2000, height: 2400 }, viewport), 0.25), fitZoom({ width: 2000, height: 2400 }, viewport));
check("a tiny diagram is capped at 4x", fitZoom({ width: 50, height: 30 }, viewport) === ZOOM_MAX, fitZoom({ width: 50, height: 30 }, viewport));
check("a huge diagram is floored at 0.25", fitZoom({ width: 40000, height: 100 }, viewport) === ZOOM_MIN, fitZoom({ width: 40000, height: 100 }, viewport));
check("a diagram that just fits sits at real size", fitZoom({ width: 1000, height: 600 }, viewport) === 1);
check("an unmeasured diagram fits at real size", fitZoom({ width: 0, height: 0 }, viewport) === 1);

console.log("wheel zoom:");
check("wheel up (negative delta) zooms in by 1.1 per 100", near(wheelZoom(1, -100), 1.1), wheelZoom(1, -100));
check("wheel down (positive delta) zooms out by 1.1 per 100", near(wheelZoom(1.1, 100), 1), wheelZoom(1.1, 100));
check("a small trackpad delta moves a little", wheelZoom(1, -10) > 1 && wheelZoom(1, -10) < 1.01, wheelZoom(1, -10));
check("zooming in clamps at the ceiling", wheelZoom(3.9, -1000) === ZOOM_MAX, wheelZoom(3.9, -1000));
check("zooming out clamps at the floor", wheelZoom(0.3, 1000) === ZOOM_MIN, wheelZoom(0.3, 1000));
check("a zero delta changes nothing", wheelZoom(1.5, 0) === 1.5);

console.log("keep the point under the cursor:");
{
	// Cursor 200px into the container, content scrolled 300px: the diagram
	// point under it is at 500. Doubling the zoom puts that point at 1000, and
	// keeping it under the cursor means scrolling to 1000 - 200 = 800.
	const pointer = { x: 200, y: 100 };
	const got = scrollToKeepPoint({ pointer, scrollLeft: 300, scrollTop: 50, oldZoom: 1, newZoom: 2 });
	const want = { scrollLeft: (200 + 300) * 2 - 200, scrollTop: (100 + 50) * 2 - 100 };
	check("zooming in around a point scrolls so the point stays put", near(got.scrollLeft, want.scrollLeft) && near(got.scrollTop, want.scrollTop), { got, want });
	const back = scrollToKeepPoint({ pointer, scrollLeft: got.scrollLeft, scrollTop: got.scrollTop, oldZoom: 2, newZoom: 1 });
	check("zooming back out returns to the original scroll", near(back.scrollLeft, 300) && near(back.scrollTop, 50), back);
	const unchanged = scrollToKeepPoint({ pointer, scrollLeft: 300, scrollTop: 50, oldZoom: 1.5, newZoom: 1.5 });
	check("an unchanged zoom keeps the scroll", unchanged.scrollLeft === 300 && unchanged.scrollTop === 50, unchanged);
	const floor = scrollToKeepPoint({ pointer: { x: 400, y: 300 }, scrollLeft: 0, scrollTop: 0, oldZoom: 1, newZoom: 0.5 });
	check("zooming out never asks for a negative scroll", floor.scrollLeft === 0 && floor.scrollTop === 0, floor);
	// A centred diagram starts 150px into the content box; the cursor 200px
	// in is 50px into the diagram. At 4x that point sits at 200 from the
	// diagram's edge, which is now flush with the content box: scroll 0.
	const centred = scrollToKeepPoint({ pointer: { x: 200, y: 200 }, scrollLeft: 0, scrollTop: 0, oldZoom: 1, newZoom: 4, stageOrigin: { x: 150, y: 150 } });
	check("a centred diagram measures the point from its own edge", near(centred.scrollLeft, 0) && near(centred.scrollTop, 0), centred);
	const centredFar = scrollToKeepPoint({ pointer: { x: 400, y: 200 }, scrollLeft: 0, scrollTop: 0, oldZoom: 1, newZoom: 4, stageOrigin: { x: 150, y: 150 } });
	check("… and scrolls to where that point lands at the new zoom", near(centredFar.scrollLeft, 250 * 4 - 400) && near(centredFar.scrollTop, 50 * 4 - 200), centredFar);
}

console.log("natural size:");
{
	const both = parseNaturalSize({ inlineMaxWidth: "640px", viewBox: "0 0 640 320" });
	check("the inline max-width gives the width, the viewBox the aspect", both !== null && both.width === 640 && both.height === 320, both);
	const scaled = parseNaturalSize({ inlineMaxWidth: "800px", viewBox: "0 0 400 100" });
	check("a max-width that differs from the viewBox keeps the viewBox aspect", scaled !== null && scaled.width === 800 && scaled.height === 200, scaled);
	const boxOnly = parseNaturalSize({ inlineMaxWidth: null, viewBox: "0, 0, 300, 150" });
	check("without a max-width the viewBox gives both (commas allowed)", boxOnly !== null && boxOnly.width === 300 && boxOnly.height === 150, boxOnly);
	check("no usable measurement is null", parseNaturalSize({ inlineMaxWidth: "100%", viewBox: "" }) === null);
	check("a max-width without a viewBox has no height and is null", parseNaturalSize({ inlineMaxWidth: "640px", viewBox: null }) === null);
}

if (failures > 0) {
	console.error(`\n${failures} check(s) failed`);
	process.exit(1);
}
console.log("\ndiagram zoom smoke passed");
