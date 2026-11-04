import { parseNaturalSize } from "./diagram-zoom";

/**
 * Pictures made into PNG for the clipboard: Chromium takes only PNG there.
 * Used by the picture actions (ImageActions.tsx) and by a figure's Copy
 * image (components/figure-tools.tsx).
 */

/** Decodes the picture at `url` through an <img> and encodes it as PNG, at `scale` times `size` (its own size by default) on `background`. */
export async function encodePng(url: string, { size, scale = 1, background }: { size?: { width: number; height: number }; scale?: number; background?: string } = {}): Promise<Blob> {
	const image = new Image();
	image.src = url;
	await image.decode();
	const width = size?.width ?? image.naturalWidth;
	const height = size?.height ?? image.naturalHeight;
	const canvas = document.createElement("canvas");
	canvas.width = Math.round(width * scale);
	canvas.height = Math.round(height * scale);
	const context = canvas.getContext("2d");
	if (!context) throw new Error("no canvas");
	if (background) {
		context.fillStyle = background;
		context.fillRect(0, 0, canvas.width, canvas.height);
	}
	context.drawImage(image, 0, 0, canvas.width, canvas.height);
	// An SVG with no intrinsic size decodes to 0×0 and toBlob then yields
	// null, which rejects like any other failure.
	return await new Promise<Blob>((resolve, reject) => canvas.toBlob((png) => (png ? resolve(png) : reject(new Error("encode"))), "image/png"));
}

// What a drawn SVG takes from the page's stylesheet: the picture is decoded
// on its own, where neither our classes nor our colour variables reach.
const PAINT = ["fill", "fill-opacity", "stroke", "stroke-width", "stroke-dasharray", "stroke-linecap", "stroke-linejoin", "opacity", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "color", "visibility", "display"];

// The most a copy asks of a canvas: past its limits a browser gives no picture
// at all, and iOS Safari stops at 4096 × 4096 in area, the tightest of them.
const MAX_SIDE = 16384;
const MAX_PIXELS = 16_000_000;

/**
 * A drawn SVG as PNG, twice its own size (a column may show it smaller) or
 * as near as a canvas allows, every colour it takes from the page written
 * into it.
 */
export async function svgPng(svg: SVGSVGElement, background: string): Promise<Blob> {
	const { width, height } = parseNaturalSize({ inlineMaxWidth: svg.style.maxWidth, viewBox: svg.getAttribute("viewBox") }) ?? svg.getBoundingClientRect();
	const copy = svg.cloneNode(true) as SVGSVGElement;
	const from = [svg, ...svg.querySelectorAll("*")];
	const to = [copy, ...copy.querySelectorAll("*")];
	from.forEach((element, i) => {
		const style = getComputedStyle(element);
		const target = to[i] as SVGElement;
		for (const name of PAINT) target.style.setProperty(name, style.getPropertyValue(name));
	});
	copy.setAttribute("xmlns", "http://www.w3.org/2000/svg");
	copy.setAttribute("width", String(width));
	copy.setAttribute("height", String(height));
	copy.style.removeProperty("max-width");
	const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml" }));
	try {
		const scale = Math.min(2, MAX_SIDE / Math.max(width, height), Math.sqrt(MAX_PIXELS / (width * height)));
		return await encodePng(url, { size: { width, height }, scale, background });
	} finally {
		URL.revokeObjectURL(url);
	}
}

/**
 * Puts the PNG that `make` makes on the clipboard. It goes in as a promise so
 * the write itself runs inside the click: Safari refuses one that comes after
 * an await. ClipboardItem is undefined over plain http on a LAN IP (not
 * localhost): then nothing is made and this rejects, as a denied write does.
 */
export function copyPng(make: () => Promise<Blob>): Promise<void> {
	if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return Promise.reject(new Error("no clipboard"));
	return navigator.clipboard.write([new ClipboardItem({ "image/png": make() })]);
}
