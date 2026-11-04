import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { CopyButton } from "./CopyButton";
import { CopyImageButton, CopyTextTool, ExpandIcon, FigureStrip, FigureSwitch, FigureTools, IconTool } from "./figure-tools";
import { ZOOM_MAX, ZOOM_MIN, fitZoom, parseNaturalSize, scrollToKeepPoint, stepZoom, wheelZoom, type Size } from "../diagram-zoom";

const MAX_MERMAID_CHARS = 12_000;

/** A drawn diagram: its svg and the source it was drawn from, repaired or as written. */
type Drawing = { svg: string; renderedSource: string };

/** `key`: the theme and source a ready diagram was drawn for. */
type MermaidStatus =
	| { state: "loading" }
	| ({ state: "ready"; key: string } & Drawing)
	| { state: "error"; message: string; detail?: string };

/**
 * The diagram's colours, read from the page's own tokens when it is drawn
 * (Mermaid works its shades out from real colours, so a variable cannot go
 * in): boxes in the card colour with the border colour, text in the text
 * colour, lines in grey, edge labels as small pills, pie slices in the
 * chart colours.
 */
function ourTheme(): { themeVariables: Record<string, string | boolean>; themeCSS: string } {
	const style = getComputedStyle(document.documentElement);
	const token = (name: string) => style.getPropertyValue(name).trim();
	const card = token("--panel");
	const raised = token("--panel-2");
	const canvas = token("--bg");
	const inset = token("--bg-2");
	const text = token("--fg");
	const muted = token("--muted");
	const border = token("--border");
	const soft = token("--border-soft");
	const alarm = token("--error");
	const pies = Object.fromEntries([1, 2, 3, 4, 5, 6].map((n) => [`pie${n}`, token(`--chart-${n}`)]));
	return {
		themeVariables: {
			darkMode: document.documentElement.dataset.theme !== "light",
			background: "transparent",
			fontFamily: "Sen, Arial, Helvetica, sans-serif",
			primaryColor: card, primaryTextColor: text, primaryBorderColor: border,
			secondaryColor: raised, secondaryTextColor: text, secondaryBorderColor: border,
			tertiaryColor: inset, tertiaryTextColor: text, tertiaryBorderColor: soft,
			mainBkg: card, nodeBorder: border, nodeTextColor: text, textColor: text, titleColor: text, lineColor: muted,
			clusterBkg: inset, clusterBorder: soft, edgeLabelBackground: canvas,
			noteBkgColor: raised, noteTextColor: text, noteBorderColor: border,
			actorBkg: card, actorBorder: border, actorTextColor: text, actorLineColor: muted,
			signalColor: muted, signalTextColor: text, labelBoxBkgColor: raised, labelBoxBorderColor: border, labelTextColor: text, loopTextColor: text,
			activationBkgColor: raised, activationBorderColor: border, sequenceNumberColor: canvas,
			taskBkgColor: raised, taskBorderColor: border, activeTaskBkgColor: inset, activeTaskBorderColor: text,
			doneTaskBkgColor: card, doneTaskBorderColor: soft, critBkgColor: raised, critBorderColor: alarm,
			sectionBkgColor: inset, sectionBkgColor2: inset, altSectionBkgColor: card, excludeBkgColor: inset,
			gridColor: soft, todayLineColor: alarm, vertLineColor: muted,
			taskTextColor: text, taskTextDarkColor: text, taskTextLightColor: text, taskTextOutsideColor: text, taskTextClickableColor: text,
			...pies, pieOpacity: "1", pieStrokeColor: card, pieOuterStrokeColor: soft, pieSectionTextColor: canvas, pieTitleTextColor: text, pieLegendTextColor: text,
		},
		themeCSS: [
			// Mermaid 12 draws C4's shapes and the state end as nodes too: they
			// keep their own corners and strokes.
			`.node:not(.c4-shape):not(:has(> .outer-path)) :is(rect, polygon, circle, ellipse, path) { stroke-width: 1.2px; }`,
			`.node:not(.c4-shape) rect, .cluster rect { rx: 8px; ry: 8px; }`,
			`.node:not(.c4-shape) polygon { fill: ${raised}; }`,
			// The state diagram's own half-opaque label rule names .label too.
			`.edgeLabel rect, .edgeLabel .label rect, .labelBkg { fill: ${canvas}; stroke: ${soft}; rx: 9px; ry: 9px; opacity: 1; }`,
			`.edgeLabel text, .edgeLabel tspan { fill: ${muted}; }`,
			`.flowchart-link, .edgePath .path, .messageLine0, .messageLine1 { stroke: ${muted}; }`,
			// The state end's centre is drawn in the node border colour, too
			// faint on the card to read as an end.
			`[id*="_end-"] > .outer-path > g path { fill: ${muted}; stroke: ${muted}; }`,
			`.milestone { stroke: ${muted}; }`,
			// C4 colours its relation labels and lines with attributes, which
			// CSS outranks. Only C4 puts a label beside its arrow's line in one
			// group; a rule scoped by the svg's own attribute never matches,
			// because Mermaid puts the svg's id in front of every rule.
			`g:has(> [marker-end], > [marker-start]) > text { fill: ${muted}; }`,
			`g:has(> text):has(> [marker-end], > [marker-start]) > :is(line, path) { stroke: ${muted}; }`,
		].join("\n"),
	};
}

// C4 writes every box's text in white, and its lighter fills (containers,
// components and every outside box) leave that text under 4.5:1. These take
// C4's own system blue and outside-person grey, which hold it above 5.5:1;
// C4's colours are the same in both themes, and stay so.
const C4_INSIDE = "#1168BD";
const C4_OUTSIDE = "#686868";
const C4_FILLS = Object.fromEntries(
	["container", "component", "external_system", "external_container", "external_component"].flatMap((kind) =>
		["", "_db", "_queue"].map((variant) => [`${kind}${variant}_bg_color`, kind.startsWith("external") ? C4_OUTSIDE : C4_INSIDE]),
	),
);

function mermaidConfig(source: string) {
	return {
		startOnLoad: false,
		securityLevel: "strict" as const,
		theme: "base" as const,
		// Mermaid 12 lays diagrams out with ELK in its "neo" look and wraps
		// flowchart and state labels at 120px with a 120px floor on node
		// width. These keep the dagre layout, classic look and 200px
		// wrapping the page has always drawn with; a diagram's own
		// directive still wins.
		// Dagre is set per diagram, not at the top: a top-level layout
		// would also replace the mindmap's and the swimlanes' own layouts.
		look: "classic" as const,
		flowchart: { layout: "dagre", wrappingWidth: 200, minNodeWidth: 0 },
		class: { layout: "dagre" },
		state: { layout: "dagre", wrappingWidth: 200, minNodeWidth: 0 },
		er: { layout: "dagre" },
		requirement: { layout: "dagre" },
		c4: C4_FILLS,
		deterministicIds: true,
		maxTextSize: MAX_MERMAID_CHARS,
		fontFamily: "Sen, Arial, Helvetica, sans-serif",
		// Labels are SVG text, so Copy image can draw the diagram on a canvas.
		// Maths ($$...$$) is drawn only into HTML labels, so a diagram with
		// maths keeps them; such a drawing cannot be copied (copyable below).
		htmlLabels: source.includes("$$"),
		...ourTheme(),
	};
}

// mermaid is heavy; load it lazily on first use so it lands in its own chunk
// and never touches the main bundle. Memoized at module scope so a chat with
// many diagrams shares one instance. Its settings are global and carry the
// theme's colours, so each draw sets them and draws before the next starts.
let mermaidLoad: Promise<typeof import("mermaid").default> | null = null;
let drawing: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function loadMermaid() {
	mermaidLoad ??= import("mermaid").then((mod) => mod.default);
	return mermaidLoad;
}

function pageTheme(): string {
	return typeof document === "undefined" ? "dark" : document.documentElement.dataset.theme || "dark";
}

/** A drawn diagram is remembered by the theme it was drawn in and its source as written. */
function diagramKey(theme: string, source: string): string {
	return `${theme}\n${source}`;
}

/**
 * Draws `source` once the draws queued before it are done, in the colours of
 * the theme the page has at that moment, which it returns: the theme may
 * have changed since the draw was asked for.
 */
function renderMermaidSvg(renderIdPrefix: string, source: string): Promise<{ svg: string; theme: string }> {
	const renderId = `${renderIdPrefix}-${++renderSeq}`;
	const drawn = drawing.then(async () => {
		const mermaid = await loadMermaid();
		const theme = pageTheme();
		mermaid.initialize(mermaidConfig(source));
		const { svg } = await mermaid.render(renderId, source);
		return { svg: clearC4RelationLabels(svg, source), theme };
	});
	drawing = drawn.catch(() => {});
	return drawn;
}

/**
 * C4 writes each relation's label at the middle of the straight line between
 * its ends, starting there, so a label runs on into the box an arrow points
 * at, sits on a box a line passes through, or lands on another relation's
 * line: only the first relation is drawn straight, the others bow to one side.
 * Each label, with its technology, is put beside its line as drawn instead:
 * at the line's middle and then further out along it, above it with the
 * technology below, wholly above, below, right or left, at the first place
 * that keeps a gap to every box, title, line, arrowhead and other label,
 * inside the drawing. A wide gap is tried first, then narrower ones; a label
 * with no clear place stays where C4 put it, as do the labels of a diagram
 * that places its own. The drawing is laid out out of sight, at its own size,
 * to measure it.
 */
function clearC4RelationLabels(svg: string, source: string): string {
	if (!svg.includes('aria-roledescription="c4"') || source.includes("UpdateRelStyle")) return svg;
	const host = document.createElement("div");
	host.style.cssText = "position: absolute; left: -100000px; top: 0; visibility: hidden;";
	host.innerHTML = svg;
	const drawing = host.querySelector("svg");
	if (!drawing) return svg;
	host.style.width = `${drawing.viewBox.baseVal.width}px`;
	document.body.append(host);
	try {
		const toDrawing = drawing.getScreenCTM()?.inverse();
		if (!toDrawing) return svg;
		const area = (rect: DOMRect): Area => {
			const a = new DOMPoint(rect.left, rect.top).matrixTransform(toDrawing);
			const b = new DOMPoint(rect.right, rect.bottom).matrixTransform(toDrawing);
			return { left: Math.min(a.x, b.x), top: Math.min(a.y, b.y), right: Math.max(a.x, b.x), bottom: Math.max(a.y, b.y) };
		};
		const lines = Array.from(drawing.querySelectorAll<SVGGeometryElement>("[marker-end], [marker-start]"));
		// The texts after a line are its label, a line each, then its
		// technology, in italics.
		const relations = lines.map((line) => {
			const texts: SVGTextElement[] = [];
			for (let next = line.nextElementSibling; next instanceof SVGTextElement; next = next.nextElementSibling) texts.push(next);
			return { line, texts };
		});
		const relationTexts = new Set(relations.flatMap((relation) => relation.texts));
		const fixed = [
			...Array.from(drawing.querySelectorAll(".c4-shape .label-container, .c4-shape .label-container *")).filter((part) => ["rect", "circle", "path"].includes(part.tagName)),
			...Array.from(drawing.querySelectorAll("text")).filter((text) => !relationTexts.has(text as SVGTextElement)),
		].map((element) => area(element.getBoundingClientRect())).filter((box) => box.right > box.left);
		const drawn = new Map(lines.map((line) => [line, drawnPoints(line)]));
		const points = [...drawn.values()].flat();
		const bounds = drawing.viewBox.baseVal;
		// Every label's place so far: C4's until it is moved.
		const labelled = new Map(relations.map(({ texts }) => [texts, texts.map((text) => area(text.getBoundingClientRect()))]));
		for (const { line, texts } of relations) {
			if (texts.length === 0) continue;
			const others = [...labelled].filter(([key]) => key !== texts).flatMap(([, boxes]) => boxes);
			const now = texts.map((text, i) => ({ text, x: Number(text.getAttribute("x")), y: Number(text.getAttribute("y")), box: labelled.get(texts)![i]! }));
			const label = now.filter((part) => part.text.getAttribute("font-style") !== "italic");
			const technology = now.filter((part) => part.text.getAttribute("font-style") === "italic");
			const length = line.getTotalLength();
			const spot = placeFor(label, technology, drawn.get(line)!, (t) => line.getPointAtLength(length * t), (boxes, gap) =>
				boxes.every((box) => {
					const near = { left: box.left - gap, top: box.top - gap, right: box.right + gap, bottom: box.bottom + gap };
					return near.left >= bounds.x && near.top >= bounds.y && near.right <= bounds.x + bounds.width && near.bottom <= bounds.y + bounds.height
						&& ![...fixed, ...others].some((other) => overlap(near, other))
						&& !points.some((p) => p.x > near.left && p.x < near.right && p.y > near.top && p.y < near.bottom);
				}));
			if (!spot) continue;
			[...label, ...technology].forEach((part, i) => {
				part.text.setAttribute("x", String(part.x + spot[i]!.dx));
				part.text.setAttribute("y", String(part.y + spot[i]!.dy));
				part.box = shift(part.box, spot[i]!.dx, spot[i]!.dy);
			});
			labelled.set(texts, now.map((part) => part.box));
		}
		return host.innerHTML;
	} catch {
		// A drawing the step cannot measure is shown as C4 drew it.
		return svg;
	} finally {
		host.remove();
	}
}

type Area = { left: number; top: number; right: number; bottom: number };
type Part = { x: number; y: number; box: Area };

function overlap(a: Area, b: Area): boolean {
	return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
}

function shift(box: Area, dx: number, dy: number): Area {
	return { left: box.left + dx, top: box.top + dy, right: box.right + dx, bottom: box.bottom + dy };
}

/**
 * Points along a relation's line as drawn, a few units apart (no more than a
 * thousand on a line, however long), and over its arrowheads: each is wide
 * at its base, five either side of the line about ten units back, and
 * narrows to its tip on the line's end.
 */
function drawnPoints(line: SVGGeometryElement): { x: number; y: number }[] {
	const length = line.getTotalLength();
	const points: { x: number; y: number }[] = [];
	const step = Math.max(3, length / 1000);
	for (let at = 0; at <= length; at += step) points.push(line.getPointAtLength(at));
	const head = (tip: DOMPoint, back: DOMPoint) => {
		const run = Math.hypot(tip.x - back.x, tip.y - back.y) || 1;
		const [ux, uy] = [(tip.x - back.x) / run, (tip.y - back.y) / run];
		for (let along = 0; along <= 10; along += 2) for (const side of [-1, -0.5, 0, 0.5, 1]) {
			const wide = 5 * ((10 - along) / 10) * side;
			points.push({ x: tip.x - ux * (10 - along) - uy * wide, y: tip.y - uy * (10 - along) + ux * wide });
		}
	};
	if (line.hasAttribute("marker-end")) head(line.getPointAtLength(length), line.getPointAtLength(Math.max(0, length - 1)));
	if (line.hasAttribute("marker-start")) head(line.getPointAtLength(0), line.getPointAtLength(Math.min(length, 1)));
	return points;
}

/**
 * The move for each text (label lines first, then technology lines) to the
 * first place beside the line that `clear` accepts, or null. A place sits
 * `gap` and two more past the line's own points beside it, so a sloping line
 * and its arrowhead stay clear. Each part keeps its own lines' spacing, and
 * every line is centred on the part's middle.
 */
function placeFor(label: Part[], technology: Part[], own: { x: number; y: number }[], at: (t: number) => DOMPoint, clear: (boxes: Area[], gap: number) => boolean): { dx: number; dy: number }[] | null {
	const parts = [...label, ...technology];
	const stack = (group: Part[], top: number, middle: number) => group.map((part) => ({ dx: middle - (part.box.left + part.box.right) / 2, dy: top - group[0]!.box.top }));
	const height = (group: Part[]) => group.length ? Math.max(...group.map((part) => part.box.bottom)) - group[0]!.box.top : 0;
	const width = Math.max(...parts.map((part) => part.box.right - part.box.left));
	const whole = height(label) + (technology.length ? 2 + height(technology) : 0);
	const block = (top: number, middle: number) => [...stack(label, top, middle), ...stack(technology, top + height(label) + 2, middle)];
	for (const gap of [8, 4, 1]) {
		const off = gap + 2;
		for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
			const p = at(t);
			const under = own.filter((q) => Math.abs(q.x - p.x) < width / 2 + gap).map((q) => q.y);
			const beside = own.filter((q) => Math.abs(q.y - p.y) < whole / 2 + gap).map((q) => q.x);
			const [top, bottom] = [Math.min(p.y, ...under), Math.max(p.y, ...under)];
			const [left, right] = [Math.min(p.x, ...beside), Math.max(p.x, ...beside)];
			const places = [
				technology.length ? [...stack(label, top - off - height(label), p.x), ...stack(technology, bottom + off, p.x)] : null,
				block(top - off - whole, p.x),
				block(bottom + off, p.x),
				block(p.y - whole / 2, right + off + width / 2),
				block(p.y - whole / 2, left - off - width / 2),
			];
			for (const moves of places) {
				if (moves && clear(parts.map((part, i) => shift(part.box, moves[i]!.dx, moves[i]!.dy)), gap)) return moves;
			}
		}
	}
	return null;
}

/** The page's theme, followed as it changes: a diagram is drawn again in the other theme's colours. */
function usePageTheme(): string {
	const [theme, setTheme] = useState(pageTheme);
	useEffect(() => {
		if (typeof MutationObserver === "undefined") return;
		const observer = new MutationObserver(() => setTheme(pageTheme()));
		observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
		return () => observer.disconnect();
	}, []);
	return theme;
}

// Drawn diagrams by theme and source, so a remount or coming back to the
// room shows the diagram at once. Each keeps the render id its svg's own ids
// are made from.
const DRAWN_CACHE_SIZE = 50;
const drawnDiagrams = new Map<string, Drawing & { renderId: string }>();

/** A drawn diagram for this key, its ids moved to `renderIdPrefix` so two copies never share an id. */
function cachedDiagram(renderIdPrefix: string, key: string): Drawing | undefined {
	const found = drawnDiagrams.get(key);
	if (!found) return undefined;
	const renderId = `${renderIdPrefix}-${++renderSeq}`;
	return { svg: found.svg.split(found.renderId).join(renderId), renderedSource: found.renderedSource };
}

function rememberDiagram(key: string, result: Drawing): void {
	const renderId = /\bid="([^"]+)"/.exec(result.svg)?.[1];
	if (!renderId) return;
	drawnDiagrams.delete(key);
	drawnDiagrams.set(key, { ...result, renderId });
	if (drawnDiagrams.size > DRAWN_CACHE_SIZE) drawnDiagrams.delete(drawnDiagrams.keys().next().value!);
}

/**
 * Whether Copy image can make a PNG of this drawing: a browser refuses to
 * export a canvas that drew HTML inside an SVG (a foreignObject), and an SVG
 * decoded on its own loads no picture a node points to (an image), so the
 * copy would silently leave it out.
 */
function copyable(svg: string): boolean {
	return !/<foreignObject|<image\b/.test(svg);
}

// Models often emit flowchart labels with raw <br/> or double quotes that
// mermaid rejects unless the label is quoted. Wrap such labels in quotes and
// normalize the markup so a well-intentioned-but-malformed diagram still renders.
function repairFlowchartLabels(source: string): string {
	if (!/^\s*(flowchart|graph)\s+/m.test(source)) return source;
	return source.replace(/(^|\s)([A-Za-z][\w-]*)\[([^\]\n]*(?:<br\s*\/?>|"|'|&quot;)[^\]\n]*)\]/g, (match, prefix: string, id: string, label: string) => {
		const trimmed = label.trim();
		if ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) return match;
		const normalized = trimmed
			.replace(/<br\s*\/?>/gi, "<br/>")
			.replace(/&quot;/g, "'")
			.replace(/"/g, "'");
		return `${prefix}${id}["${normalized}"]`;
	});
}

async function renderMermaidWithRepair(renderIdPrefix: string, source: string): Promise<Drawing & { theme: string }> {
	try {
		return { ...(await renderMermaidSvg(renderIdPrefix, source)), renderedSource: source };
	} catch (error) {
		const repairedSource = repairFlowchartLabels(source);
		if (repairedSource === source) throw error;
		try {
			return { ...(await renderMermaidSvg(`${renderIdPrefix}-repaired`, repairedSource)), renderedSource: repairedSource };
		} catch {
			throw error;
		}
	}
}

function errorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim()) return error.message.trim();
	if (typeof error === "string" && error.trim()) return error.trim();
	return "Could not render this Mermaid diagram.";
}

// Mermaid sizes its svg with `width="100%"` plus an inline `max-width: Npx`
// that is the width it measured for the drawing; the viewBox carries the
// aspect. Read once after the svg mounts, so both the in-chat toggle and the
// viewer scale from real pixels rather than from the column or the window.
function measureSvg(container: HTMLElement | null): Size | null {
	const svg = container?.querySelector("svg");
	if (!svg) return null;
	return parseNaturalSize({ inlineMaxWidth: svg.style.maxWidth, viewBox: svg.getAttribute("viewBox") });
}

// The viewer fits the diagram into the body's content box: its client size
// minus the padding, which is the area the diagram can occupy without scrolling.
function contentBox(element: HTMLElement): { left: number; top: number; width: number; height: number } {
	const style = getComputedStyle(element);
	const paddingLeft = parseFloat(style.paddingLeft) || 0;
	const paddingTop = parseFloat(style.paddingTop) || 0;
	const rect = element.getBoundingClientRect();
	return {
		left: rect.left + element.clientLeft + paddingLeft,
		top: rect.top + element.clientTop + paddingTop,
		width: element.clientWidth - paddingLeft - (parseFloat(style.paddingRight) || 0),
		height: element.clientHeight - paddingTop - (parseFloat(style.paddingBottom) || 0),
	};
}

function isTypingTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT";
}

// A wheel gesture's anchor: captured when the zoom changes, applied once the
// diagram has re-laid out at the new size (a scroll set before that would be
// clamped to the old scroll range).
type WheelAnchor = {
	pointer: { x: number; y: number };
	stageOrigin: { x: number; y: number };
	scrollLeft: number;
	scrollTop: number;
	oldZoom: number;
	newZoom: number;
};

const DIAGRAM_VIEWS = [{ value: "picture", word: "Picture" }, { value: "code", word: "Code" }] as const;

/** The diagram's source in place of the picture, numbered by line. On the card Copy stands in the strip; the expanded window has no strip, so `ownCopy` puts one on the code. */
function DiagramCode({ source, ownCopy = false }: { source: string; ownCopy?: boolean }) {
	return (
		<div className="figure-code">
			{ownCopy && <CopyButton text={source} className="figure-code-copy" what="code" />}
			<pre><code>{source.split("\n").map((line, i) => <span key={i}>{line}{"\n"}</span>)}</code></pre>
		</div>
	);
}

export function MermaidDiagram({ chart }: { chart: string }) {
	const reactId = useId();
	const source = useMemo(() => chart.trim(), [chart]);
	const baseId = useMemo(() => `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`, [reactId]);
	const theme = usePageTheme();
	const key = diagramKey(theme, source);
	const [status, setStatus] = useState<MermaidStatus>(() => {
		const cached = cachedDiagram(baseId, key);
		return cached ? { state: "ready", key, ...cached } : { state: "loading" };
	});
	const [codeShown, setCodeShown] = useState(false);
	const [viewerCode, setViewerCode] = useState(false);
	const [enlarged, setEnlarged] = useState(false);
	const [naturalWidth, setNaturalWidth] = useState<number | null>(null);
	const canvasRef = useRef<HTMLDivElement | null>(null);
	const [viewerOpen, setViewerOpen] = useState(false);
	const [viewerZoom, setViewerZoom] = useState(1);
	const [viewerNatural, setViewerNatural] = useState<Size | null>(null);
	const [viewerStatus, setViewerStatus] = useState<MermaidStatus>({ state: "loading" });
	const viewerBodyRef = useRef<HTMLDivElement | null>(null);
	const viewerStageRef = useRef<HTMLDivElement | null>(null);
	const viewerZoomRef = useRef(viewerZoom);
	const wheelAnchorRef = useRef<WheelAnchor | null>(null);
	viewerZoomRef.current = viewerZoom;

	useEffect(() => {
		let cancelled = false;
		async function render() {
			if (!source) {
				setStatus({ state: "error", message: "Mermaid diagram is empty." });
				return;
			}
			if (source.length > MAX_MERMAID_CHARS) {
				setStatus({ state: "error", message: `Mermaid diagram is too large (${source.length} chars).` });
				return;
			}
			const cached = cachedDiagram(baseId, key);
			if (cached) {
				setStatus((current) => (current.state === "ready" && current.key === key ? current : { state: "ready", key, ...cached }));
				return;
			}
			// A diagram already drawn keeps its picture until the new one is ready.
			setStatus((current) => (current.state === "ready" ? current : { state: "loading" }));
			try {
				const { theme: drawnIn, ...result } = await renderMermaidWithRepair(baseId, source);
				// Remembered under the theme it was really drawn in: a theme
				// change while it waited cancels this draw but not the drawing.
				rememberDiagram(diagramKey(drawnIn, source), result);
				if (!cancelled) setStatus({ state: "ready", key, ...result });
			} catch (error) {
				if (!cancelled) setStatus({ state: "error", message: "The assistant generated invalid Mermaid syntax.", detail: errorMessage(error) });
			}
		}
		void render();
		return () => {
			cancelled = true;
		};
	}, [baseId, source, key]);

	// The in-chat canvas learns the drawing's real width so "enlarged" can mean
	// real pixels for a wide diagram, not just "fill the column".
	// Measured whenever the drawing is in view: the code shown in its place
	// has no svg to measure.
	useLayoutEffect(() => {
		if (status.state !== "ready" || codeShown) return;
		setNaturalWidth(measureSvg(canvasRef.current)?.width ?? null);
	}, [status, codeShown]);

	// The viewer draws the source of the drawing that is ready: a new one replacing it while the viewer is open draws again.
	const readySource = status.state === "ready" ? status.renderedSource : null;
	useEffect(() => {
		if (!viewerOpen || readySource === null) return;
		let cancelled = false;
		const renderedSource = readySource;
		setViewerStatus({ state: "loading" });
		async function renderViewer() {
			try {
				const { svg } = await renderMermaidSvg(`${baseId}-viewer`, renderedSource);
				if (!cancelled) setViewerStatus({ state: "ready", key, svg, renderedSource });
			} catch (error) {
				if (!cancelled) setViewerStatus({ state: "error", message: "Could not render the expanded diagram.", detail: errorMessage(error) });
			}
		}
		void renderViewer();
		return () => {
			cancelled = true;
		};
	}, [baseId, key, readySource, viewerOpen]);

	const fitViewer = useCallback((natural: Size | null) => {
		const body = viewerBodyRef.current;
		if (!natural || !body) return;
		const box = contentBox(body);
		setViewerZoom(fitZoom(natural, { width: box.width, height: box.height }));
	}, []);

	// Measure the viewer's own svg the moment it mounts and open at fit: the
	// largest zoom that shows the whole drawing on both axes. Until then the
	// stage is as wide as the body (the pre-measure fallback in CSS), so the
	// first paint already lands close to where fit puts it. The code shown in
	// its place has no svg, so the drawing is measured again when it is back;
	// only a new drawing goes to fit, the same one keeps the zoom it had and
	// the place it was scrolled to (the short code in between scrolls the body back to its start).
	const fittedDrawingRef = useRef<MermaidStatus | null>(null);
	const drawingScrollRef = useRef<{ left: number; top: number } | null>(null);
	useLayoutEffect(() => {
		if (viewerStatus.state !== "ready" || viewerCode) return;
		const natural = measureSvg(viewerStageRef.current);
		setViewerNatural(natural);
		const scrolled = drawingScrollRef.current;
		drawingScrollRef.current = null;
		if (fittedDrawingRef.current === viewerStatus) {
			const body = viewerBodyRef.current;
			if (scrolled && body) {
				body.scrollLeft = scrolled.left;
				body.scrollTop = scrolled.top;
			}
			return;
		}
		fittedDrawingRef.current = viewerStatus;
		fitViewer(natural);
	}, [fitViewer, viewerStatus, viewerCode]);

	const toggleViewerCode = useCallback(() => {
		const body = viewerBodyRef.current;
		if (!viewerCode && body) drawingScrollRef.current = { left: body.scrollLeft, top: body.scrollTop };
		setViewerCode(!viewerCode);
	}, [viewerCode]);

	// After a wheel zoom has re-laid out the stage, scroll so the diagram point
	// that was under the pointer is still under it.
	useLayoutEffect(() => {
		const anchor = wheelAnchorRef.current;
		const body = viewerBodyRef.current;
		if (!anchor || !body) return;
		wheelAnchorRef.current = null;
		const next = scrollToKeepPoint(anchor);
		body.scrollLeft = next.scrollLeft;
		body.scrollTop = next.scrollTop;
	}, [viewerZoom]);

	// Cmd/Ctrl + wheel and trackpad pinch (delivered as a wheel with ctrlKey)
	// zoom around the pointer; a plain wheel scrolls. The listener is added by
	// hand because React's onWheel is passive and could not preventDefault the
	// browser's own page zoom.
	useEffect(() => {
		const body = viewerBodyRef.current;
		if (!viewerOpen || !body) return;
		const onWheel = (event: WheelEvent) => {
			if (!(event.ctrlKey || event.metaKey)) return;
			event.preventDefault();
			const stage = viewerStageRef.current;
			if (!stage || !viewerNatural) return;
			// Line-mode deltas (a few units per notch) would barely move the zoom.
			const deltaY = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
			const oldZoom = viewerZoomRef.current;
			const newZoom = wheelZoom(oldZoom, deltaY);
			if (newZoom === oldZoom) return;
			const box = contentBox(body);
			const stageRect = stage.getBoundingClientRect();
			wheelAnchorRef.current = {
				pointer: { x: event.clientX - box.left, y: event.clientY - box.top },
				stageOrigin: { x: stageRect.left - box.left + body.scrollLeft, y: stageRect.top - box.top + body.scrollTop },
				scrollLeft: body.scrollLeft,
				scrollTop: body.scrollTop,
				oldZoom,
				newZoom,
			};
			setViewerZoom(newZoom);
		};
		body.addEventListener("wheel", onWheel, { passive: false });
		return () => body.removeEventListener("wheel", onWheel);
	}, [viewerOpen, viewerNatural]);

	useEffect(() => {
		if (!viewerOpen) return;
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") {
				setViewerOpen(false);
				return;
			}
			// Modified keys stay the browser's (Cmd+0, Cmd+-), and a key typed
			// into a field is text, not a zoom command.
			if (event.metaKey || event.ctrlKey || event.altKey || isTypingTarget(event.target)) return;
			if (event.key === "+" || event.key === "=") setViewerZoom((value) => stepZoom(value, 1));
			else if (event.key === "-") setViewerZoom((value) => stepZoom(value, -1));
			else if (event.key === "0") setViewerZoom(1);
			else if (event.key === "f" || event.key === "F") fitViewer(viewerNatural);
			else return;
			event.preventDefault();
		};
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [fitViewer, viewerNatural, viewerOpen]);

	const openViewer = useCallback(() => {
		setViewerCode(false);
		setViewerZoom(1);
		setViewerNatural(null);
		setViewerStatus({ state: "loading" });
		setViewerOpen(true);
	}, []);

	const toggleEnlarged = useCallback(() => setEnlarged((value) => !value), []);
	const onCanvasKeyDown = useCallback((event: ReactKeyboardEvent<HTMLDivElement>) => {
		if (event.target !== event.currentTarget) return;
		if (event.key === "Enter" || event.key === " ") {
			// Space would otherwise scroll the page; Enter is harmless but symmetric.
			event.preventDefault();
			toggleEnlarged();
		}
	}, [toggleEnlarged]);

	if (status.state === "ready") {
		const zoomPercent = Math.round(viewerZoom * 100);
		const canvasStyle = naturalWidth ? ({ "--diagram-natural-width": `${naturalWidth}px` } as CSSProperties) : undefined;
		// Before the viewer has measured its svg the stage takes the body's
		// width (CSS fallback); after, it is the drawing's real pixels times the zoom.
		const stageStyle = viewerNatural ? { width: `${Math.round(viewerNatural.width * viewerZoom)}px` } : undefined;
		return (
			<figure className="mermaid-diagram figure-card" aria-label="Rendered Mermaid diagram">
				{/* The strip sits beside the canvas, so a click on a tool never reaches the size toggle. */}
				<FigureStrip label="Diagram">
					<FigureTools copy={codeShown ? <CopyTextTool text={status.renderedSource} what="code" /> : copyable(status.svg) && <CopyImageButton svg={() => canvasRef.current?.querySelector("svg")} />}>
						<FigureSwitch options={DIAGRAM_VIEWS} value={codeShown ? "code" : "picture"} onChange={(view) => setCodeShown(view === "code")} />
						<IconTool name="Open expanded diagram" onClick={openViewer}><ExpandIcon /></IconTool>
					</FigureTools>
				</FigureStrip>
				{codeShown ? (
					<DiagramCode source={status.renderedSource} />
				) : (
					// The canvas toggles the diagram in place: a narrow drawing
					// grows to the column, a wide one goes to its real pixels and scrolls.
					<div
						ref={canvasRef}
						className={`mermaid-diagram-canvas${enlarged ? " enlarged" : ""}`}
						style={canvasStyle}
						role="button"
						tabIndex={0}
						aria-pressed={enlarged}
						aria-label={enlarged ? "Shrink diagram" : "Enlarge diagram"}
						title={enlarged ? "Shrink diagram" : "Enlarge diagram"}
						onClick={toggleEnlarged}
						onKeyDown={onCanvasKeyDown}
					>
						<span className="mermaid-diagram-svg" dangerouslySetInnerHTML={{ __html: status.svg }} />
					</div>
				)}
				{viewerOpen && (
					<div className="mermaid-viewer-overlay" role="dialog" aria-modal="true" aria-label="Expanded Mermaid diagram" onClick={() => setViewerOpen(false)}>
						<div className="mermaid-viewer-modal" onClick={(event) => event.stopPropagation()}>
							<div className="mermaid-viewer-head">
								<h2>Diagram</h2>
								<div className="mermaid-viewer-actions">
									<button className="icon-btn" type="button" aria-pressed={viewerCode} onClick={toggleViewerCode} title="The diagram's code">Code</button>
									<button className="icon-btn" type="button" onClick={() => setViewerZoom((value) => stepZoom(value, -1))} disabled={viewerCode || viewerZoom <= ZOOM_MIN} aria-label="Zoom out" title="Zoom out (−)">−</button>
									<button className="icon-btn mermaid-viewer-zoom-value" type="button" onClick={() => setViewerZoom(1)} disabled={viewerCode} aria-label="Actual size" title="Actual size (0)">{zoomPercent}%</button>
									<button className="icon-btn" type="button" onClick={() => setViewerZoom((value) => stepZoom(value, 1))} disabled={viewerCode || viewerZoom >= ZOOM_MAX} aria-label="Zoom in" title="Zoom in (+)">+</button>
									<button className="icon-btn" type="button" onClick={() => fitViewer(viewerNatural)} disabled={viewerCode || !viewerNatural} aria-label="Fit to window" title="Fit to window (f)">Fit</button>
									<button className="icon-btn" type="button" onClick={() => setViewerOpen(false)} aria-label="Close" title="Close (Esc)">✕</button>
								</div>
							</div>
							<div className="mermaid-viewer-body" ref={viewerBodyRef}>
								{viewerCode ? (
									<DiagramCode source={status.renderedSource} ownCopy />
								) : (
									<div className="mermaid-viewer-stage" ref={viewerStageRef} style={stageStyle}>
										{viewerStatus.state === "ready" && <div className="mermaid-viewer-svg" dangerouslySetInnerHTML={{ __html: viewerStatus.svg }} />}
										{viewerStatus.state === "loading" && <div className="mermaid-viewer-loading">Rendering expanded diagram...</div>}
										{viewerStatus.state === "error" && (
											<div className="mermaid-viewer-error">
												<div className="mermaid-diagram-error-title">Could not render expanded diagram</div>
												<p>{viewerStatus.message}</p>
											</div>
										)}
									</div>
								)}
							</div>
						</div>
					</div>
				)}
			</figure>
		);
	}

	if (status.state === "error") {
		// Render failure degrades to the plain code block the fence would have
		// produced anyway — never a broken or blank box. The source stays
		// visible and conversationally editable.
		return (
			<pre className="mermaid-fallback">
				<code className="language-mermaid">{source}</code>
			</pre>
		);
	}

	return (
		<figure className="mermaid-diagram mermaid-diagram-loading figure-card" aria-label="Rendering Mermaid diagram">
			<div className="mermaid-diagram-loading-text figure-sweep">Drawing diagram…</div>
		</figure>
	);
}
